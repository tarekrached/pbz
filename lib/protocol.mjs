// WebSocket transport (port 81): frames, chunked binary sends, and text/binary
// waiters. This is the same message shape the web UI's own client speaks.
//
// The queueing and matching rules live in ./queue.mjs, which is where the
// correctness lives and where the tests are. This file is the socket half.
import { ID_CHARS } from './pbp.mjs';
import { makeQueues } from './queue.mjs';

const OPEN_TIMEOUT_MS = 5000; // device gone (unplugged/dead ws server): fail loud, not hang forever
const IDLE_CLOSE_MS = 10000; // safety net for callers that reuse a connection (Chunk 20) but never call close()

export function connect(host, { WebSocketImpl = WebSocket, idleMs = IDLE_CLOSE_MS } = {}) {
  const ws = new WebSocketImpl(`ws://${host}:81`);
  ws.binaryType = 'arraybuffer';
  const q = makeQueues();

  // An open ws keeps the event loop alive, so a caller that forgets to close()
  // a reused connection (e.g. a one-off script) would otherwise hang forever.
  //
  // Re-armed by any USE of the connection, which is not the same as any send.
  // Two wrong versions of this shipped before: re-arming on every inbound
  // message let the ~1/s unsolicited status frames keep it alive forever (dead
  // backstop), and re-arming only on sends closed the socket under a send-free
  // caller like a getStatus() poller — turning a 1 Hz monitor into a reconnect
  // every 10 s, which is this project's single documented device hazard.
  // mark() is the honest signal: every request/response method takes one, and
  // taking it means "I am using this connection".
  let idleTimer = setTimeout(() => ws.close(), idleMs);
  const touch = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => ws.close(), idleMs); };
  const using = (fn) => (...args) => { touch(); return fn(...args); };

  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') q.pushText(ev.data);
    else q.pushBinary(Buffer.from(ev.data));
  };
  ws.onclose = () => clearTimeout(idleTimer);
  // A failed open must not outlive its own promise: on either rejection path
  // below, `this._conn` in the caller (Pixelblaze._getConn) never gets set,
  // so nothing else holds a reference to close() this `ws` or clear its
  // already-armed idle timer — both would otherwise keep the event loop
  // alive for up to IDLE_CLOSE_MS after a connect that never even opened
  // (observed: `pbz backup` against a wedged ws server prints success, then
  // hangs ~idleMs before the process exits). Clear + close HERE, at the one
  // place that still has `ws` in scope, before rethrowing. Verified against a
  // local TCP-reachable-but-silent server (a real wedged-ws-server stand-in):
  // the socket handle now drops within ~1s of the open timeout instead of
  // riding the full ~10s idle window. Against a genuinely unroutable address
  // (no TCP response at all, e.g. RFC5737 TEST-NET), Node's own WebSocket
  // impl holds its OWN ~10.5s internal connect timeout regardless of this
  // close() — a separate, pre-existing platform limit close() can't shortcut
  // (the underlying TCP handshake never resolves for us to abort).
  const failOpen = (err) => { clearTimeout(idleTimer); ws.close(); throw err; };
  const opened = new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`websocket: timed out connecting to ${host}:81 (device not accepting connections)`)), OPEN_TIMEOUT_MS);
    ws.onopen = () => { clearTimeout(timer); res(); };
    ws.onerror = (e) => { clearTimeout(timer); rej(new Error('websocket: ' + (e.message || 'connection failed'))); };
  }).catch(failOpen);

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
    // every one of these counts as using the connection, so every one re-arms
    mark: using(q.mark),
    waitText: using(q.waitText),
    waitBinary: using(q.waitBinary),
    collectChunks: using(q.collectChunks),
    json, sendBytecode, collectFrames,
    close: () => { clearTimeout(idleTimer); ws.close(); },
  };
}
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
export const makeWsId = () => Array.from({ length: 17 }, () => ID_CHARS[(Math.random() * ID_CHARS.length) | 0]).join('');
