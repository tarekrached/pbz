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
  // When WE take the connection away, record it AT THAT MOMENT rather than
  // waiting for the close event to come back and tell us. Two reasons, both
  // measured: a real ws.close() returns with readyState CLOSING and dispatches
  // `close` a turn later, so anything sent in between silently no-ops and gets
  // reported as success; and a cause stashed for the later event is applied to
  // whichever close arrives first, so a device hangup racing our idle timer is
  // mislabelled as our own timeout, losing the close code and the recovery
  // pointer that matter most on a wedged ws server.
  const closeWith = (cause) => die(new Error(`websocket: connection to ${host}:81 closed (${cause})`));

  const idleCause = () => `no request used it for ${idleMs}ms`;
  let idleTimer = setTimeout(() => closeWith(idleCause()), idleMs);
  const touch = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => closeWith(idleCause()), idleMs); };
  // Re-arming on a dead connection would leave a live 10s timer behind holding
  // the event loop open — the exact "prints success, then hangs ~idleMs" symptom
  // the failed-open cleanup below exists to prevent, resurrected on the error
  // path. `dead` is assigned further down but only ever read at call time.
  const using = (fn) => (...args) => { if (!dead) touch(); return fn(...args); };

  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') q.pushText(ev.data);
    else q.pushBinary(Buffer.from(ev.data));
  };

  // The connection is gone. Record it once, stop the idle timer, and hand the
  // reason to the queue so every parked waiter rejects NOW instead of running
  // out its own timeout and then reporting a timeout — see queue.mjs `fail`.
  // First cause wins, so both messages below are written to stand on their own:
  // an error event beats the close event that follows it, and undici's
  // ErrorEvent carries nothing in `.message`, so whichever lands first must
  // still name the device and point at the recovery playbook.
  let dead = null;
  const die = (err) => {
    if (dead) return;
    dead = err;
    clearTimeout(idleTimer);
    q.fail(err);
    // Close even when the death came from an error rather than a close event.
    // An errored socket can sit at readyState OPEN, and Pixelblaze._getConn
    // reuses a cached connection on readyState alone — so without this, a dead
    // connection would be handed back to every later call and each one would
    // throw this same error forever. Closing forces readyState past OPEN, which
    // is what makes _getConn reconnect. Re-entrant via onclose, hence the guard
    // above being set before we get here.
    try { ws.close(); } catch { /* already closing or closed: nothing to do */ }
  };
  const RECOVERY = ' — it may have rebooted, dropped off wifi, or wedged its ws server (see "Device etiquette & recovery")';
  ws.onclose = (ev) => die(new Error(
    `websocket: device at ${host}:81 closed the connection mid-exchange${ev?.code ? ` (code ${ev.code})` : ''}${RECOVERY}`
  ));
  // undici's ErrorEvent has an EMPTY `.message` and puts the real cause on
  // `.error` (measured on a live post-open RST: keys [], message "", error a
  // TypeError). Reading `.message` alone degraded every real death to the
  // literal string "connection error" — and since the error event beats the
  // close event, that vaguer message won. Read both, and carry the same
  // guidance the close path does so neither ordering loses information.
  const midExchangeError = (e) => new Error(
    `websocket: connection to ${host}:81 failed mid-exchange` +
    ` (${e?.error?.message || e?.message || 'no detail reported by the socket'})${RECOVERY}`
  );
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
      if (isOpen) { die(midExchangeError(e)); return; }
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
      frames = q.peekBinary(5, startSeq);
      if (frames.length >= need) break; // satisfied — a death after this point is irrelevant
      alive();                          // nothing more can arrive on a dead socket
      await sleep(20);
    }
    const result = frames.slice(0, need);
    // Order matters: a COMPLETE set that arrived before the drop is still a real
    // set (queue.fail deliberately keeps the frames it already has), so the death
    // is only worth reporting when we actually came up short. Checking liveness
    // first would throw away a perfectly good thumbnail because the socket
    // happened to close in the same tick as the last frame.
    if (result.length < need) alive();
    if (!dead) json({ sendUpdates: false }); // teardown is pointless once the socket is gone
    q.purgeBinary(5);
    return result;
  };

  return {
    ws, opened,
    // every one of these counts as using the connection, so every one re-arms
    mark: using(q.mark),
    waitText: using(q.waitText),
    waitBinary: using(q.waitBinary),
    // Not plain `using()`: a chunked read can legitimately outlive idleMs on a
    // device documented to stall for 107s, and re-arming only at call time let
    // our OWN backstop close the socket mid-transfer and then report it as an
    // idle connection — false, since a request was actively using it.
    collectChunks: (type, opts = {}) => { if (!dead) touch(); return q.collectChunks(type, { ...opts, onProgress: () => { if (!dead) touch(); } }); },
    json, sendBytecode, collectFrames,
    /** The error the connection died of, or null while it is healthy. */
    dead: () => dead,
    close: () => { clearTimeout(idleTimer); closeWith('closed by pbz'); },
  };
}
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
export const makeWsId = () => Array.from({ length: 17 }, () => ID_CHARS[(Math.random() * ID_CHARS.length) | 0]).join('');
