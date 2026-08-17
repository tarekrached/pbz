// Guards for the socket half (lib/protocol.mjs), using an injected fake
// WebSocket so no device or network is involved.
//
// Both tests here are regressions for defects introduced BY a fix, which is the
// reason they exist rather than being covered at the queue level: the bugs were
// in the wiring between the queue and the socket, not in either one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { connect } from '../lib/protocol.mjs';

// Minimal stand-in for the parts of WebSocket this module touches.
class FakeWS {
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.closed = false;
    queueMicrotask(() => this.onopen?.());
  }
  send(data) { this.sent.push(data); }
  close() { this.closed = true; this.onclose?.(); }
  /** Simulate an inbound frame from the device. */
  deliver(data) { this.onmessage?.({ data }); }
}

// Never auto-opens (unlike FakeWS) — lets a test drive onerror/timeout
// itself to exercise the failed-open cleanup path.
class NeverOpensWS {
  constructor(url) { this.url = url; this.sent = []; this.closed = false; }
  send(data) { this.sent.push(data); }
  close() { this.closed = true; this.onclose?.(); }
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
// socket was gone, so it ran out its full timeout and reported a timeout, and
// the next send threw a bare InvalidStateError naming neither the device nor
// the connection. save() is the case that hurt: it can push bytecode, unpause
// the pattern, and then lose the socket before the activate.

test('a post-open error reaches a parked waiter instead of being swallowed', async () => {
  const { c, ws } = fakeConnect(5000);
  await c.opened;
  const m = c.mark();
  const waiting = c.waitText('{"ack"', 3000, m);
  ws.onerror?.({ message: 'ECONNRESET' });
  await assert.rejects(waiting, /ECONNRESET/, 'the error that killed the socket must reach the caller');
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
