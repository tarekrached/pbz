// WebSocket transport (port 81): frames, chunked binary sends, and text/binary
// waiters. This is the same message shape the web UI's own client speaks.
import { ID_CHARS } from './pbp.mjs';

export function connect(host) {
  const ws = new WebSocket(`ws://${host}:81`);
  ws.binaryType = 'arraybuffer';
  const texts = [];
  const binaries = [];
  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') texts.push(ev.data);
    else binaries.push(Buffer.from(ev.data));
  };
  const opened = new Promise((res, rej) => { ws.onopen = res; ws.onerror = (e) => rej(new Error('websocket: ' + (e.message || 'connection failed'))); });
  const waitText = (prefix, ms = 3000) => new Promise((res) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const hit = texts.find(m => m.startsWith(prefix));
      if (hit) { clearInterval(iv); res(hit); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); res(null); }
    }, 10);
  });
  const waitBinary = (ms = 3000) => new Promise((res) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (binaries.length) { clearInterval(iv); res(binaries.shift()); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); res(null); }
    }, 10);
  });
  const json = (obj) => ws.send(JSON.stringify(obj));
  const sendBytecode = (blob, type = 3) => { // chunked binary frames: [type][flag] + <=1280 bytes
    const MAX = 1280;
    for (let i = 0; i < blob.length; i += MAX) {
      let flag = 0;
      if (i === 0) flag |= 1;                              // first
      flag |= (blob.length - i) <= MAX ? 4 : 2;            // last : middle
      ws.send(Buffer.concat([Buffer.from([type, flag]), blob.subarray(i, i + MAX)]));
    }
  };
  // Collect `need` live preview frames (binary type 5: 1-byte header + pixelCount×RGB).
  const collectFrames = async (need, ms = 6000) => {
    const start = binaries.length;
    json({ sendUpdates: true });
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const frames = binaries.slice(start).filter(b => b[0] === 5);
      if (frames.length >= need) { json({ sendUpdates: false }); return frames.slice(0, need); }
      await sleep(20);
    }
    json({ sendUpdates: false });
    return binaries.slice(start).filter(b => b[0] === 5);
  };
  return { ws, opened, waitText, waitBinary, json, sendBytecode, collectFrames, close: () => ws.close() };
}
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
export const makeWsId = () => Array.from({ length: 17 }, () => ID_CHARS[(Math.random() * ID_CHARS.length) | 0]).join('');
