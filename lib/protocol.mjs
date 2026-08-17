// WebSocket transport (port 81): frames, chunked binary sends, and text/binary
// waiters. This is the same message shape the web UI's own client speaks.
//
// The queueing and matching rules live in ./queue.mjs, which is where the
// correctness lives and where the tests are. This file is the socket half.
import { ID_CHARS } from './pbp.mjs';
import { makeQueues } from './queue.mjs';

/**
 * Payload bytes per binary frame. Exported because the device acks EVERY frame
 * of a chunked send, so a caller that needs to know when a transfer actually
 * COMPLETED (rather than when its first chunk landed) has to know how many
 * frames it just sent. Duplicating the number at that call site would drift.
 */
export const CHUNK_BYTES = 1280;

// How long a refused send waits for the socket's own close/error event before
// declaring the connection dead itself. `readyState !== OPEN` is THREE
// situations and they resolve differently: from CLOSED the event has already
// landed or is a tick away, from CONNECTING the socket may still open normally,
// and from CLOSING undici can park INDEFINITELY when a peer sends a close frame
// without a FIN — measured, no event ever arrives. Recording the cause
// immediately gets CONNECTING wrong; waiting forever gets CLOSING wrong. So:
// wait a beat, and let a real event win if there is one.
const DEATH_GRACE_MS = 250;

// How often to check that a socket nobody is sending on is still OPEN. undici
// parks in CLOSING indefinitely when a peer sends a close frame without a FIN —
// measured, no event ever arrives, and ws.close() does not help because it is
// the TCP connection ending that releases it, not us asking. A caller parked in
// waitText has sent nothing, so the send-side grace timer never arms, and the
// wait would resolve null and be reported as "the device may be slow". Polling
// readyState is the only signal available.
const LIVENESS_POLL_MS = 250;

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
  // path. `death` is assigned further down but only read at call time.
  const using = (fn) => (...args) => { if (!death) touch(); return fn(...args); };

  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') q.pushText(ev.data);
    else q.pushBinary(Buffer.from(ev.data));
  };

  // The connection is gone. Record it once, stop the idle timer, and hand the
  // reason to the queue so every parked waiter rejects NOW instead of running
  // out its own timeout and then reporting a timeout — see queue.mjs `fail`.
  // Both messages below are written to stand on their own, because either can
  // be the one a caller sees: an error event lands first and undici's
  // ErrorEvent usually carries nothing at all, so each must name the device and
  // point at the recovery playbook without help from the other.
  //
  // The REASON is stored, not one Error object, so every throw and every
  // rejection can get its OWN instance: handing one instance to every caller
  // means anything that annotates a caught error (pixelblaze.mjs's device-state
  // note) writes on an object other callers also hold, and a concurrent read
  // picks up a save's annotation.
  //
  // ONE record for one fact. `death !== null` is deadness, so an Error with an
  // empty message cannot leave the connection un-dead by accident — that is
  // structural here, where an earlier cut defended it with a separate boolean
  // that turned out to be unobservable.
  let death = null; // { reason: string, detailed: boolean }
  const deadError = () => new Error(death.reason);
  // First cause wins, EXCEPT that a detailed cause may upgrade a contentless
  // one. Measured on real hardware: a device that reboots mid-command fires
  // `error` with an EMPTY message and then `close` carrying `code 1006`, 0.2ms
  // apart. Plain first-cause-wins therefore locked in the less informative of
  // the two — "no detail reported by the socket" — while the code that
  // distinguishes a device that dropped from a clean hangup arrived immediately
  // after and was discarded. Anything asking after that instant now gets the
  // better text; the caller whose wait already rejected does not, which is
  // recorded as a known gap rather than fixed by delaying every death.
  const die = (err, detailed = true) => {
    if (death && (death.detailed || !detailed)) return;
    death = { reason: err.message || String(err), detailed };
    clearTimeout(idleTimer);
    clearTimeout(graceTimer);
    clearInterval(watchdog);
    q.fail(deadError);
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
  ws.onclose = (ev) => {
    // A peer that closes politely (1000/1001) did the correct thing; saying it
    // "may have wedged its ws server" is alarming about good behaviour and
    // dilutes that pointer for the rows that need it. And if firmware ever
    // explains itself in the close frame, print the explanation rather than
    // throwing it away for the number.
    const clean = ev?.code === 1000 || ev?.code === 1001;
    const why = [ev?.code ? `code ${ev.code}` : null, ev?.reason ? `"${ev.reason}"` : null].filter(Boolean).join(', ');
    die(new Error(
      `websocket: device at ${host}:81 closed the connection${clean ? '' : ' mid-exchange'}${why ? ` (${why})` : ''}` +
      `${clean ? '' : RECOVERY}`
    ), Boolean(ev?.code));
  };
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
  const failOpen = (err) => { clearTimeout(idleTimer); die(err, false); ws.close(); throw err; };
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
      if (isOpen) {
        const detail = e?.error?.message || e?.message;
        if (detail) { die(midExchangeError(e), true); return; }
        // Nothing usable in the event — which is EVERY case measured, across 20
        // peer behaviours. The close event carrying the code lands in the SAME
        // tick (0-1ms), so yield to it: otherwise every parked waiter rejects
        // with "no detail reported by the socket" while `dead()` a moment later
        // holds "(code 1006)". That was 100% of the reboot and dropout rows,
        // not an edge case.
        setTimeout(() => { if (!death) die(midExchangeError(e), false); }, 0).unref?.();
        return;
      }
      clearTimeout(timer);
      rej(new Error(`websocket: could not connect to ${host}:81${e?.message ? ` (${e.message})` : ''}${RECOVERY}`));
    };
  }).catch(failOpen);

  // `send()` is useless in both directions once the socket is not OPEN: it
  // throws a bare `InvalidStateError` while CONNECTING, and silently DISCARDS
  // while CLOSING or CLOSED (measured, Node 26.5.0). The silent half is the
  // dangerous one — a write that goes nowhere and reports success — so check
  // first and give the caller the reason the connection went away.
  // Two checks, because a recorded death alone is not enough. A real socket flips
  // readyState the moment it processes the peer's close frame but dispatches
  // the `close` EVENT a task later, so there is a window where nothing has told
  // us the connection died and `send()` — which discards silently on a closed
  // socket rather than throwing — would return as if it had worked. Callers
  // treat "the send returned" as proof the bytes left the machine (see
  // pixelblaze.mjs's state cursor), so that proof has to actually hold.
  // Unref'd: this must never be a reason for the process to stay alive, only a
  // reason for a doomed wait to stop waiting.
  const watchdog = setInterval(() => {
    if (!death && isOpen && ws.readyState !== 1 /* OPEN */) {
      die(new Error(`websocket: connection to ${host}:81 went away without closing cleanly${RECOVERY}`), false);
    }
  }, LIVENESS_POLL_MS);
  watchdog.unref?.();

  let graceTimer = null;
  const alive = () => {
    if (death) throw deadError();
    if (ws.readyState !== 1 /* OPEN */) {
      // Do not record the cause NOW — a real close event carries a code this
      // cannot know, and it usually lands within a tick. But do not wait for
      // one forever either: from CLOSING it may never come, and then parked
      // waiters run out their own timeouts and resolve null, which callers
      // report as "the device may be slow" about a device that is gone.
      // Marked undetailed, so a close code arriving later still upgrades it.
      if (!graceTimer) {
        graceTimer = setTimeout(() => {
          graceTimer = null;
          if (!death) die(new Error(`websocket: connection to ${host}:81 went away without closing cleanly${RECOVERY}`), false);
        }, DEATH_GRACE_MS);
        graceTimer.unref?.(); // never a reason for the process to stay alive
      }
      // Throw, but deliberately do NOT die() here. This branch fires in exactly
      // one window — readyState already flipped, the `close` event not yet
      // dispatched — which means the REAL close event, carrying the close code,
      // is queued and about to land a task later. die() is first-cause-wins, so
      // claiming the cause here permanently replaces `(code 1006)` with this
      // generic sentence, for the thrower AND for every parked waiter. 1006
      // versus 1000 is the one bit that separates a device that dropped from a
      // clean hangup, and losing it is precisely what this file's own comment
      // above says must not happen. Let the close event speak; it is one task
      // away, and the waiters it fails are the same ones die() would have.
      throw new Error(ws.readyState === 0
        ? `websocket: the connection to ${host}:81 is still opening`
        : `websocket: the connection to ${host}:81 is no longer open (readyState ${ws.readyState})${RECOVERY}`);
    }
  };

  const json = (obj) => { alive(); touch(); ws.send(JSON.stringify(obj)); };
  const sendBytecode = (blob, type = 3) => { // chunked binary frames: [type][flag] + <=1280 bytes
    alive();
    touch();
    // Per chunk, not once: forward-defence for the day anything in this loop
    // awaits backpressure, since callers read "sendBytecode returned" as "every
    // chunk is on the socket" and save()'s putSourceCode is multi-chunk.
    const MAX = CHUNK_BYTES;
    for (let i = 0; i < blob.length; i += MAX) {
      alive();
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
    // Best-effort, and it must STAY best-effort. This runs AFTER the frames are
    // in hand, and `alive()` now refuses on a closed-but-not-yet-announced
    // socket, so guarding only on the recorded death let this teardown throw a complete
    // set away — the exact outcome the ordering above exists to prevent. It
    // reached `samplePreview()` (and so `pbz power`) as a pure read, and it made
    // save() report a frozen wall on a device that had just delivered every
    // frame it asked for.
    try { json({ sendUpdates: false }); } catch { /* nothing to tear down on a socket already gone */ }
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
    collectChunks: (type, opts = {}) => { if (!death) touch(); return q.collectChunks(type, { ...opts, onProgress: () => { if (!death) touch(); } }); },
    json, sendBytecode, collectFrames,
    /** A fresh Error describing why the connection died, or null while healthy. */
    dead: () => (death ? deadError() : null),
    close: () => { clearTimeout(idleTimer); closeWith('closed by pbz'); },
  };
}
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
export const makeWsId = () => Array.from({ length: 17 }, () => ID_CHARS[(Math.random() * ID_CHARS.length) | 0]).join('');
