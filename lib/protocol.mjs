// WebSocket transport (port 81): frames, chunked binary sends, and text/binary
// waiters. This is the same message shape the web UI's own client speaks.
//
// The queueing and matching rules live in ./queue.mjs, which is where the
// correctness lives and where the tests are. This file is the socket half.
import { ID_CHARS } from './pbp.mjs';
import { makeQueues } from './queue.mjs';

const OPEN_TIMEOUT_MS = 5000; // device gone (unplugged/dead ws server): fail loud, not hang forever
const IDLE_CLOSE_MS = 10000; // safety net for callers that reuse a connection (Chunk 20) but never call close()

export function connect(host) {
  const ws = new WebSocket(`ws://${host}:81`);
  ws.binaryType = 'arraybuffer';
  const q = makeQueues();

  // An open ws keeps the event loop alive, so a caller that forgets to close()
  // a reused connection (e.g. a one-off script) would otherwise hang forever.
  //
  // Only OUR sends re-arm this. It used to be re-armed by every inbound
  // message, which meant the ~1/s unsolicited status frames kept it alive
  // indefinitely: the backstop was dead code against exactly the healthy device
  // it was meant to protect.
  let idleTimer = setTimeout(() => ws.close(), IDLE_CLOSE_MS);
  const touch = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => ws.close(), IDLE_CLOSE_MS); };

  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') q.pushText(ev.data);
    else q.pushBinary(Buffer.from(ev.data));
  };
  ws.onclose = () => clearTimeout(idleTimer);
  const opened = new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`websocket: timed out connecting to ${host}:81 (device not accepting connections)`)), OPEN_TIMEOUT_MS);
    ws.onopen = () => { clearTimeout(timer); res(); };
    ws.onerror = (e) => { clearTimeout(timer); rej(new Error('websocket: ' + (e.message || 'connection failed'))); };
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
  // Purges every type-5 frame when done (not just the ones returned) — on a
  // long-lived reused connection nothing else ever wants type-5, so strays would
  // just grow the queue.
  const collectFrames = async (need, ms = 6000) => {
    const startSeq = q.mark();
    json({ sendUpdates: true });
    const t0 = Date.now();
    let frames = [];
    while (Date.now() - t0 < ms) {
      frames = q.peekBinary(5, startSeq);
      if (frames.length >= need) break;
      await sleep(20);
    }
    json({ sendUpdates: false });
    const result = frames.slice(0, need);
    q.purgeBinary(5);
    return result;
  };

  return {
    ws, opened,
    mark: q.mark,
    waitText: q.waitText,
    waitBinary: q.waitBinary,
    collectChunks: q.collectChunks,
    json, sendBytecode, collectFrames,
    close: () => ws.close(),
  };
}
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
export const makeWsId = () => Array.from({ length: 17 }, () => ID_CHARS[(Math.random() * ID_CHARS.length) | 0]).join('');
