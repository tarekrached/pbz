// Guards for the socket half (lib/protocol.mjs), using an injected fake
// WebSocket so no device or network is involved.
//
// Every test here is a regression for a defect introduced BY a fix, which is
// the reason they live here rather than at the queue level: the bugs were in
// the wiring between the queue and the socket, not in either one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { connect } from '../lib/protocol.mjs';

// Minimal stand-in for the parts of WebSocket this module touches.
class FakeWS {
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.closed = false;
    this.readyState = 0 /* CONNECTING */;
    queueMicrotask(() => { this.readyState = 1 /* OPEN */; this.onopen?.(); });
  }
  send(data) { this.sent.push(data); }
  close() { this.readyState = 3 /* CLOSED */; this.closed = true; this.onclose?.(); }
  /** Simulate an inbound frame from the device. */
  deliver(data) { this.onmessage?.({ data }); }
}

// Never auto-opens (unlike FakeWS) — lets a test drive onerror/timeout
// itself to exercise the failed-open cleanup path.
class NeverOpensWS {
  constructor(url) { this.url = url; this.sent = []; this.closed = false; this.readyState = 0; }
  send(data) { this.sent.push(data); }
  close() { this.readyState = 3; this.closed = true; this.onclose?.(); }
}

function fakeConnect(idleMs) {
  let sock;
  const c = connect('fake', { idleMs, WebSocketImpl: class extends FakeWS {
    constructor(url) { super(url); sock = this; }
  } });
  return { c, get ws() { return sock; } };
}

function fakeConnectFailing(idleMs) {
  let sock;
  const c = connect('fake', { idleMs, WebSocketImpl: class extends NeverOpensWS {
    constructor(url) { super(url); sock = this; }
  } });
  return { c, get ws() { return sock; } };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

test('a send-free poller keeps the connection alive (idle close must not manufacture churn)', async () => {
  // The shape that matters: getStatus() SENDS NOTHING, it only marks and waits
  // for the next unsolicited status frame. Re-arming the idle timer on sends
  // alone closed the socket under exactly this caller, turning a 1 Hz monitor
  // into a reconnect every 10s — connection churn being this project's single
  // documented device hazard.
  const { c, ws } = fakeConnect(60);
  await c.opened;

  for (let i = 0; i < 6; i++) {
    await sleep(25); // 150ms total, well past the 60ms idle window
    const m = c.mark();
    ws.deliver(`{"fps":${i}}`);
    const msg = await c.waitText('{"fps"', 200, m);
    assert.ok(msg, `poll ${i} should have read a status frame`);
    assert.equal(ws.closed, false, `socket closed during poll ${i} — the poller would reconnect here`);
  }
  c.close();
});

test('a genuinely idle connection still auto-closes (the backstop must stay alive)', async () => {
  const { c, ws } = fakeConnect(50);
  await c.opened;
  // Inbound traffic alone must NOT hold it open: the device sends ~1/s
  // unsolicited status frames forever, and treating those as activity is what
  // made this backstop dead code in the first place.
  ws.deliver('{"fps":1}');
  await sleep(40);
  ws.deliver('{"fps":2}');
  await sleep(120);
  assert.equal(ws.closed, true, 'a connection nobody is using should have closed');
});

test('close() cancels the idle timer (no close on an already-closed socket)', async () => {
  const { c, ws } = fakeConnect(40);
  await c.opened;
  c.close();
  ws.closed = false; // if the pending idle timer still fires, it flips this back
  await sleep(90);
  assert.equal(ws.closed, false, 'idle timer fired after close()');
});

test('ping-shaped wait ignores an ack orphaned by an earlier command', async () => {
  // run()/save() send two commands and used to claim only one ack. ping() took
  // no mark, so it matched the leftover and reported a fabricated near-zero
  // latency — on the one call the recovery playbook uses to judge device health.
  const { c, ws } = fakeConnect(5000);
  await c.opened;

  ws.deliver('{"ack":1}'); // orphan from an earlier call

  const m = c.mark();      // ping marks, then sends
  c.json({ ping: true });
  const stale = await c.waitText('{"ack"', 60, m);
  assert.equal(stale, null, 'must not match the orphaned ack');

  ws.deliver('{"ack":1}'); // the real reply
  const real = await c.waitText('{"ack"', 200, m);
  assert.ok(real, 'must match the genuine reply');
  c.close();
});

test('without a mark, the orphaned ack WOULD have matched (proves the test bites)', async () => {
  const { c, ws } = fakeConnect(5000);
  await c.opened;
  ws.deliver('{"ack":1}');
  const matched = await c.waitText('{"ack"', 60); // the old, uncorrelated call
  assert.ok(matched, 'sanity: an uncorrelated wait does match the orphan');
  c.close();
});

test('a failed open closes the socket and disarms the idle timer, instead of leaking both', async () => {
  // Before the fix: on a rejected `opened` (timeout or onerror), the caller
  // (Pixelblaze._getConn) never gets a `c` to hold onto, so nothing could
  // reach in and close() this ws or clear its already-armed idle timer —
  // both kept the event loop alive for up to idleMs after a connect that
  // never even opened. `pbz backup` against a wedged ws server showed this:
  // it prints success, then the process sits for the idle window before
  // exiting. The timeout and onerror rejection paths share one cleanup
  // handler in connect(), so exercising onerror here covers both.
  const { c, ws } = fakeConnectFailing(50);
  const rejection = assert.rejects(c.opened, /connection failed/);
  ws.onerror?.({ message: 'connection failed' });
  await rejection;
  assert.equal(ws.closed, true, 'a failed open must close its own socket');
  // If the idle timer were still armed, ws.close() would fire again ~50ms
  // later — reset the flag and prove nothing touches it a second time.
  ws.closed = false;
  await sleep(90);
  assert.equal(ws.closed, false, 'the idle timer must have been cleared, not just outrun');
});

// --- Chunk 29: transport death ---------------------------------------------
// A post-open error was dropped on the floor: `ws.onerror` only ever rejected
// the `opened` promise, which is already settled by the time the connection is
// in use, so rejecting it again is a no-op. Nothing told a parked waiter the
// socket was gone, so it ran out its full timeout and reported a timeout — and
// then the next send SILENTLY SUCCEEDED, because send() on a closed WHATWG
// WebSocket is a no-op, not a throw (measured on Node 26.5.0; the older note
// claiming InvalidStateError was wrong, and the truth is worse). save() is the
// case that hurt: it can push bytecode, unpause the pattern, and then lose the
// socket before the activate.

test('a post-open error reaches a parked waiter instead of being swallowed', async () => {
  const { c, ws } = fakeConnect(5000);
  await c.opened;
  const m = c.mark();
  const waiting = c.waitText('{"ack"', 3000, m);
  // The real shape: undici's ErrorEvent has an EMPTY `message` and carries the
  // cause on `.error`. An earlier cut of this test passed `{message:'…'}`, a
  // shape Node never produces, so it was validating a fiction.
  ws.onerror?.({ message: '', error: new TypeError('read ECONNRESET') });
  await assert.rejects(waiting, /read ECONNRESET/, 'the error that killed the socket must reach the caller');
});

test('a device that hangs up mid-exchange fails the wait fast, and says so', async () => {
  const { c, ws } = fakeConnect(5000);
  await c.opened;
  const m = c.mark();
  const t0 = Date.now();
  const waiting = c.waitText('{"ack"', 3000, m);
  ws.onclose?.({ code: 1006 }); // remote hangup: not our close(), so `closed` stays false
  await assert.rejects(waiting, /closed the connection mid-exchange \(code 1006\)/);
  assert.ok(Date.now() - t0 < 500, 'must fail on the close, not run out the 3s wait');
});

test('sending on a dead connection throws the reason it died of', async () => {
  // The old failure was `InvalidStateError` straight out of the ws
  // implementation — true, and useless.
  const { c, ws } = fakeConnect(5000);
  await c.opened;
  ws.onclose?.({ code: 1006 });
  assert.throws(() => c.json({ ping: true }), /closed the connection mid-exchange/);
  assert.throws(() => c.sendBytecode(Buffer.from([1, 2, 3])), /closed the connection mid-exchange/);
});

test('the first cause wins: the close event cannot overwrite the error behind it', async () => {
  const { c, ws } = fakeConnect(5000);
  await c.opened;
  ws.onerror?.({ message: 'ECONNRESET' });
  ws.onclose?.({ code: 1006 }); // always follows, and is always the vaguer of the two
  assert.throws(() => c.json({ ping: true }), /ECONNRESET/);
});

test('our own two closes name themselves, so they read differently from a hangup', async () => {
  const a = fakeConnect(5000);
  await a.c.opened;
  a.c.close();
  assert.throws(() => a.c.json({ ping: true }), /closed by pbz/);

  const b = fakeConnect(40);
  await b.c.opened;
  await sleep(90); // let the idle backstop fire
  assert.throws(() => b.c.json({ ping: true }), /no request used it for 40ms/);
});

test('collectFrames abandons a dead socket instead of polling out its window', async () => {
  // save() spends up to 6s here collecting preview frames. On a dropped
  // connection every one of those seconds is spent waiting for frames that
  // cannot arrive.
  const { c, ws } = fakeConnect(5000);
  await c.opened;
  const t0 = Date.now();
  const frames = c.collectFrames(2, 4000);
  ws.onclose?.({ code: 1006 });
  await assert.rejects(frames, /closed the connection mid-exchange/);
  assert.ok(Date.now() - t0 < 1000, 'must not poll the full 4s window against a dead socket');
});

// --- Chunk 29 review follow-ups --------------------------------------------
// Three defects the review of the first cut found. Each is a way the new
// fail-fast path was too eager and destroyed something that was still good.

test('collectFrames keeps a complete set that arrived before the drop', async () => {
  // The first cut checked liveness BEFORE peeking, so a device that streamed
  // every frame and then hung up in the same tick lost the lot — and save()
  // would report failure for a thumbnail it already had.
  const { c, ws } = fakeConnect(5000);
  await c.opened;
  const pending = c.collectFrames(2, 4000);
  ws.deliver(new Uint8Array([5, 1, 2, 3]).buffer);
  ws.deliver(new Uint8Array([5, 4, 5, 6]).buffer);
  ws.onclose?.({ code: 1006 });
  const frames = await pending;
  assert.equal(frames.length, 2, 'frames already in hand must survive the death that follows them');
});

test('a wait on a dead connection does not arm a fresh idle timer', async () => {
  // using() re-armed unconditionally, so every post-death call left a live
  // timer behind — the same event-loop-keeper the failed-open cleanup above
  // exists to prevent, back again on the error path.
  const { c, ws } = fakeConnect(50);
  await c.opened;
  ws.onclose?.({ code: 1006 });
  ws.closed = false; // a leaked timer would flip this back
  await assert.rejects(c.waitText('{"ack"', 500, c.mark()), /mid-exchange/);
  await sleep(120); // well past idleMs
  assert.equal(ws.closed, false, 'a dead connection must not arm a fresh timer');
});

test('a chunked transfer outliving the idle window is not killed as idle', async () => {
  // collectChunks re-armed once, at call time. A transfer slower than idleMs
  // but healthy chunk-to-chunk tripped our own backstop, which then reported
  // "no request used it" about a connection a request was actively using.
  // This device is documented stalling for 107s, so the case is real.
  const { c, ws } = fakeConnect(60);
  await c.opened;
  const m = c.mark();
  const reading = c.collectChunks(7, { ms: 500, after: m });
  for (let i = 0; i < 5; i++) {
    await sleep(40); // 200ms total, far past the 60ms idle window
    ws.deliver(new Uint8Array([7, i === 4 ? 4 : 2, 65 + i]).buffer);
  }
  assert.equal((await reading).toString(), 'ABCDE');
  assert.equal(ws.closed, false, 'the backstop must not close a connection mid-transfer');
});

// A close() that only takes effect a turn later. This is what Node actually
// does — ws.close() returns with readyState CLOSING and dispatches `close`
// later — and the synchronous FakeWS above hides it. Two of the tests here
// passed against FakeWS for the wrong reason until this existed.
class AsyncCloseWS extends FakeWS {
  close() {
    this.readyState = 2 /* CLOSING */;
    queueMicrotask(() => { this.readyState = 3; this.closed = true; this.onclose?.({ code: 1000 }); });
  }
}
function fakeConnectAsyncClose(idleMs) {
  let sock;
  const c = connect('fake', { idleMs, WebSocketImpl: class extends AsyncCloseWS {
    constructor(url) { super(url); sock = this; }
  } });
  return { c, get ws() { return sock; } };
}

test('an answer that arrived before the drop is still delivered, not discarded', async () => {
  // THE one that matters. Waiters poll on an interval, and the ws stack
  // dispatches buffered message events and the close event in the same batch,
  // so "device answered, then hung up" reliably leaves the answer sitting in
  // the queue unclaimed. Rejecting without one last look turns a write the
  // device genuinely completed into a reported failure.
  const { c, ws } = fakeConnect(5000);
  await c.opened;
  const m = c.mark();
  const waiting = c.waitText('{"activeProgram"', 8000, m);
  ws.deliver('{"activeProgram":{"name":"X"}}'); // the device answers...
  ws.onclose?.({ code: 1006 });                 // ...and hangs up in the same batch
  assert.match(await waiting, /"name":"X"/, 'a completed write must not be reported as a failure');
});

test('a contentless ErrorEvent still names the device and the playbook', async () => {
  // undici gives ErrorEvent an empty `.message`, so reading only that degraded
  // every real death to the literal string "connection error" — and since the
  // error event beats the close event, that vaguer message won.
  const { c, ws } = fakeConnect(5000);
  await c.opened;
  ws.onerror?.({});
  assert.match(c.dead().message, /connection to fake:81 failed mid-exchange/);
  assert.match(c.dead().message, /no detail reported by the socket/);
  assert.match(c.dead().message, /Device etiquette/, 'must still point at the recovery playbook');
});

test('our own close marks the connection dead at once, not a turn later', async () => {
  // Against a real socket, close() leaves readyState CLOSING and `close` fires
  // later. In that window a send SILENTLY no-ops — reporting success for a
  // write that went nowhere, which is the exact failure this chunk exists to
  // end. Recording the death at the moment we initiate it closes the window.
  const { c } = fakeConnectAsyncClose(5000);
  await c.opened;
  c.close();
  assert.throws(() => c.json({ ping: true }), /closed by pbz/, 'a send in the CLOSING window must not silently succeed');
});

test('the idle backstop marks the connection dead at once too', async () => {
  const { c } = fakeConnectAsyncClose(40);
  await c.opened;
  await sleep(90);
  assert.throws(() => c.json({ ping: true }), /no request used it for 40ms/);
});

test('an Error with an empty message still kills the connection for good', async () => {
  // The death is tracked by a flag, not by the truthiness of the stored
  // message. Guarding on the string let an empty-message Error leave the
  // connection alive-but-broken, and let a SECOND cause overwrite the first —
  // which the queue's factory closes over, so even already-parked waiters would
  // have started receiving the later, vaguer reason.
  const { c, ws } = fakeConnect(5000);
  await c.opened;
  ws.onerror?.({ message: '', error: { message: '' } }); // nothing usable at all
  assert.ok(c.dead(), 'a contentless error must still mark the connection dead');
  const first = c.dead().message;
  ws.onclose?.({ code: 1006 }); // a second, later cause
  assert.equal(c.dead().message, first, 'first cause must still win');
  assert.throws(() => c.json({ ping: true }), /./, 'and sends must still refuse');
});

test('a send refuses on a socket that closed but has not fired its event yet', async () => {
  // A real socket flips readyState when it processes the peer's close frame and
  // dispatches `close` a task later. In that window nothing has told us the
  // connection died, and send() on a closed socket DISCARDS SILENTLY rather
  // than throwing — so a caller treating "the send returned" as proof the bytes
  // left the machine (pixelblaze.mjs's state cursor does exactly that) would be
  // told a write may have landed when nothing was transmitted.
  const { c, ws } = fakeConnect(5000);
  await c.opened;
  ws.readyState = 3; // closed underneath us, no event yet
  assert.throws(() => c.json({ ping: true }), /no longer open \(readyState 3\)/);
  assert.throws(() => c.sendBytecode(Buffer.from([1, 2, 3])), /no longer open/);
  assert.equal(ws.sent.length, 0, 'and nothing was handed to a socket that would have dropped it');
});
