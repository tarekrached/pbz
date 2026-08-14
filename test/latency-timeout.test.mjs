// Sibling of the `setConfig` ack-timeout/quarantine proof in
// test/latency.test.mjs, split into its own FILE (not just its own test) so
// `node --test`'s default per-file concurrency runs this ~8s wait in a
// parallel worker process alongside that one, instead of the two summing
// serially. See test/latency.test.mjs's comment just above its own timeout
// test for why they aren't simply run concurrently within one file (both
// swap the shared `globalThis.WebSocket` global, which isn't safe to share
// across two truly-concurrent fake-socket tests in the same process).
//
// This is the `delete` half of PBZ-PLAN.md Chunk 26's write-timeout
// quarantine: on an ack timeout, the connection is closed and dropped
// (lib/pixelblaze.mjs's `_awaitAckOrQuarantine`) so a late reply from the
// abandoned write dies with the old socket instead of risking a later
// call's wait. An earlier `purgeText`-based attempt at this same problem
// was removed after a second verification round found it didn't work
// (mark() already excludes anything queued before it — a purge can't reach
// an ack that arrives after) and could steal a live ack from a genuinely
// concurrent waiter; see test/queue.test.mjs's note on the primitive that
// used to live there.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Pixelblaze } from '../lib/pixelblaze.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class FakeWS {
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.closed = false;
    this.readyState = 0; // CONNECTING — Pixelblaze._getConn()'s reuse check reads this
    queueMicrotask(() => { this.readyState = 1 /* OPEN */; this.onopen?.(); });
  }
  send(data) { this.sent.push(data); }
  close() { this.readyState = 3 /* CLOSED */; this.closed = true; this.onclose?.(); }
  /** Simulate an inbound frame from the device. */
  deliver(data) { this.onmessage?.({ data }); }
}

// Swap the global WebSocket for the duration of `fn`, always restoring it
// afterward (even on failure) so no other test can observe the fake.
async function withFakeSocket(fn) {
  const orig = globalThis.WebSocket;
  let sock;
  class Tracking extends FakeWS {
    constructor(url) { super(url); sock = this; }
  }
  globalThis.WebSocket = Tracking;
  try {
    return await fn(() => sock);
  } finally {
    globalThis.WebSocket = orig;
  }
}

const listChunk = (id, name) => Buffer.concat([Buffer.from([7, 4]), Buffer.from(`${id}\t${name}\n`)]);

test('delete: ack timeout is fail-loud, quarantines the connection, and A\'s late ack (delivered on the OLD socket) cannot leak into B', { timeout: 12000 }, async () => {
  await withFakeSocket(async (getSock) => {
    const reports = [];
    const pb = new Pixelblaze('fake-host', { onWriteLatency: (op, ms) => reports.push({ op, ms }) });

    // Call A: list() resolves, but the deleteProgram+ping's ack never comes.
    const pA = pb.delete('abc123');
    await sleep(20); // let the fake connection open (getSock() has nothing to return before this)
    const oldWs = getSock(); // the connection call A is (and will remain) bound to
    oldWs.deliver(listChunk('abc123', 'Some Pattern'));

    await assert.rejects(pA, (err) => {
      assert.match(err.message, /no ack within 8s after delete/);
      assert.match(err.message, /device writes may be stalling \(storage pressure\?\)/);
      assert.match(err.message, /pbz info/);
      return true;
    });
    assert.equal(reports.length, 0, 'a timed-out chase must not report a latency sample');

    // Quarantine: the connection A used must already be closed by the time
    // the rejection is observed (_awaitAckOrQuarantine closes it BEFORE
    // rethrowing).
    assert.equal(oldWs.readyState, 3 /* CLOSED */, 'the connection must be quarantined (closed) after a write timeout');

    // A's real ack finally shows up, late — deliver it on the OLD socket.
    // Because call B (below) reconnects onto a brand-new socket/queue, this
    // has nowhere left to leak into: it dies with oldWs.
    oldWs.deliver('{"ack":1}');

    // Call B: a fresh delete(), including its own fresh list(). _getConn()
    // must reconnect (this._conn was nulled by the quarantine), landing on
    // a NEW fake socket instance.
    const pB = pb.delete('abc123');
    await sleep(20);
    const newWs = getSock();
    assert.notEqual(newWs, oldWs, 'call B must reconnect onto a new connection, not reuse the quarantined one');
    newWs.deliver(listChunk('abc123', 'Some Pattern'));
    await sleep(20);

    // It must NOT resolve off A's stale ack (which was delivered on oldWs,
    // not newWs) — it must wait for and use its OWN ack.
    let settled = false;
    pB.then(() => { settled = true; });
    await sleep(30);
    assert.equal(settled, false, 'must not have resolved off the stale ack A left on the old socket');

    newWs.deliver('{"ack":1}'); // B's own real ack, on the NEW socket
    const hit = await pB;
    assert.equal(hit.id, 'abc123');
    assert.equal(reports.length, 1);
    assert.equal(reports[0].op, 'delete');
    pb.close();
  });
});
