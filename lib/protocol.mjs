// WebSocket transport (port 81): frames, chunked binary sends, and text/binary
// waiters. This is the same message shape the web UI's own client speaks.
import { ID_CHARS } from './pbp.mjs';

const OPEN_TIMEOUT_MS = 5000; // device gone (unplugged/dead ws server): fail loud, not hang forever
const IDLE_CLOSE_MS = 10000; // safety net for callers that reuse a connection (Chunk 20) but never call close()

export function connect(host) {
  const ws = new WebSocket(`ws://${host}:81`);
  ws.binaryType = 'arraybuffer';
  const texts = [];
  const binaries = [];
  // An open ws keeps the event loop alive, so a caller that forgets to close()
  // a reused connection (e.g. a one-off script) would otherwise hang forever.
  // Any traffic — send or receive — resets the clock; true idle auto-closes.
  let idleTimer = setTimeout(() => ws.close(), IDLE_CLOSE_MS);
  const touch = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => ws.close(), IDLE_CLOSE_MS); };
  ws.onmessage = (ev) => {
    touch();
    if (typeof ev.data === 'string') texts.push(ev.data);
    else binaries.push(Buffer.from(ev.data));
  };
  ws.onclose = () => clearTimeout(idleTimer);
  const opened = new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`websocket: timed out connecting to ${host}:81 (device not accepting connections)`)), OPEN_TIMEOUT_MS);
    ws.onopen = () => { clearTimeout(timer); res(); };
    ws.onerror = (e) => { clearTimeout(timer); rej(new Error('websocket: ' + (e.message || 'connection failed'))); };
  });
  // Consuming waiters (splice on match): required once a connection is reused
  // across many method calls (PBZ-PLAN.md Chunk 20) — a non-consuming `find`
  // would let a later call re-match a message an earlier call already claimed.
  const waitText = (prefix, ms = 3000) => new Promise((res) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const idx = texts.findIndex(m => m.startsWith(prefix));
      if (idx >= 0) { clearInterval(iv); res(texts.splice(idx, 1)[0]); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); res(null); }
    }, 10);
  });
  // `type` filters by frame-type byte — required on a shared connection so a
  // stale frame of a different type (e.g. a leftover preview frame) can't be
  // mistaken for the one this call is waiting on.
  const waitBinary = (ms = 3000, type) => new Promise((res) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const idx = type == null ? (binaries.length ? 0 : -1) : binaries.findIndex(b => b[0] === type);
      if (idx >= 0) { clearInterval(iv); res(binaries.splice(idx, 1)[0]); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); res(null); }
    }, 10);
  });
  const json = (obj) => { touch(); ws.send(JSON.stringify(obj)); };
  const sendBytecode = (blob, type = 3) => { // chunked binary frames: [type][flag] + <=1280 bytes
    touch();
    const MAX = 1280;
    for (let i = 0; i < blob.length; i += MAX) {
      let flag = 0;
      if (i === 0) flag |= 1;                              // first
      flag |= (blob.length - i) <= MAX ? 4 : 2;            // last : middle
      ws.send(Buffer.concat([Buffer.from([type, flag]), blob.subarray(i, i + MAX)]));
    }
  };
  // Collect `need` live preview frames (binary type 5: 1-byte header + pixelCount×RGB).
  // Purges every type-5 frame from the shared queue when done (not just the ones
  // returned) — on a long-lived reused connection (Chunk 20) nothing else ever
  // wants type-5, so leaving strays behind would just grow the queue forever.
  const collectFrames = async (need, ms = 6000) => {
    const start = binaries.length;
    json({ sendUpdates: true });
    const t0 = Date.now();
    let frames = [];
    while (Date.now() - t0 < ms) {
      frames = binaries.slice(start).filter(b => b[0] === 5);
      if (frames.length >= need) break;
      await sleep(20);
    }
    json({ sendUpdates: false });
    const result = frames.slice(0, need);
    for (let i = binaries.length - 1; i >= 0; i--) if (binaries[i][0] === 5) binaries.splice(i, 1);
    return result;
  };
  return { ws, opened, waitText, waitBinary, json, sendBytecode, collectFrames, close: () => ws.close() };
}
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
export const makeWsId = () => Array.from({ length: 17 }, () => ID_CHARS[(Math.random() * ID_CHARS.length) | 0]).join('');
