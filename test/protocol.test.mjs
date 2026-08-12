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

function fakeConnect(idleMs) {
  let sock;
  const c = connect('fake', { idleMs, WebSocketImpl: class extends FakeWS {
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
