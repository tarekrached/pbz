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
  // Why the connection went away, when WE are the ones taking it away. The
  // close event alone can't tell an idle-timeout from a deliberate close from
  // the device hanging up, and those three want very different messages.
  let closeCause = null;
  const closeWith = (cause) => { closeCause = cause; ws.close(); };

  let idleTimer = setTimeout(() => closeWith(`no request used it for ${idleMs}ms`), idleMs);
  const touch = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => closeWith(`no request used it for ${idleMs}ms`), idleMs); };
  const using = (fn) => (...args) => { touch(); return fn(...args); };

  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') q.pushText(ev.data);
    else q.pushBinary(Buffer.from(ev.data));
  };

  // The connection is gone. Record it once, stop the idle timer, and hand the
  // reason to the queue so every parked waiter rejects NOW instead of running
  // out its own timeout and then reporting a timeout — see queue.mjs `fail`.
  // First cause wins: a close event follows an error event, and the error is
  // always the more specific of the two.
  let dead = null;
  const die = (err) => {
    if (dead) return;
    dead = err;
    clearTimeout(idleTimer);
    q.fail(err);
  };
  const closeError = (ev) => {
    if (closeCause) return new Error(`websocket: connection to ${host}:81 closed (${closeCause})`);
    const code = ev?.code;
    return new Error(
      `websocket: device at ${host}:81 closed the connection mid-exchange${code ? ` (code ${code})` : ''}` +
      ` — it may have rebooted, dropped off wifi, or wedged its ws server (see "Device etiquette & recovery")`
    );
  };
  ws.onclose = (ev) => die(closeError(ev));
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
  // die() before close() so the recorded cause is the real open failure rather
  // than the generic close event our own close() is about to fire.
  const failOpen = (err) => { clearTimeout(idleTimer); die(err); ws.close(); throw err; };
  let isOpen = false;
  const opened = new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`websocket: timed out connecting to ${host}:81 (device not accepting connections)`)), OPEN_TIMEOUT_MS);
    ws.onopen = () => { isOpen = true; clearTimeout(timer); res(); };
    // ONE handler, two eras. Before open, an error rejects `opened` and the
    // caller never gets a connection. After open, `opened` is already settled
    // and rejecting it is a no-op that drops the error on the floor — the bug
    // this chunk exists to fix — so a post-open error goes to die() instead,
    // which is the path that actually reaches a waiting caller.
    ws.onerror = (e) => {
      if (isOpen) { die(new Error(`websocket: ${e?.message || 'connection error'} (mid-exchange, ${host}:81)`)); return; }
      clearTimeout(timer);
      rej(new Error('websocket: ' + (e.message || 'connection failed')));
    };
  }).catch(failOpen);

  // Sending on a closed socket throws a bare `InvalidStateError` from the ws
  // implementation, which names neither the device nor the connection. Check
  // first so the caller gets the reason the connection went away instead.
  const alive = () => { if (dead) throw dead; };

  const json = (obj) => { alive(); touch(); ws.send(JSON.stringify(obj)); };
  const sendBytecode = (blob, type = 3) => { // chunked binary frames: [type][flag] + <=1280 bytes
    alive();
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
      alive(); // a dead socket will never deliver frame `need`; don't poll out the full window
      frames = q.peekBinary(5, startSeq);
      if (frames.length >= need) break;
      await sleep(20);
    }
    alive();
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
    /** The error the connection died of, or null while it is healthy. */
    dead: () => dead,
    close: () => { clearTimeout(idleTimer); closeWith('closed by pbz'); },
  };
}
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
export const makeWsId = () => Array.from({ length: 17 }, () => ID_CHARS[(Math.random() * ID_CHARS.length) | 0]).join('');
