// Guards for the message-queue rules (lib/queue.mjs). Every test here is a
// regression test for a real defect found in review: the queue took the OLDEST
// prefix match and nothing ever drained it, so unclaimed frames answered later
// requests. On a tool that writes to hardware and produces "backups", the
// failure mode was confident wrong answers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeQueues } from '../lib/queue.mjs';

const chunk = (type, flag, body) => Buffer.concat([Buffer.from([type, flag]), Buffer.from(body)]);

test('a frame queued BEFORE the mark can never satisfy a later request', async () => {
  const q = makeQueues();
  // stale settings frame, e.g. left behind by getState()'s {getConfig:true}
  q.pushText('{"name":"old","sequenceTimer":15}');

  const m = q.mark();            // ... then a caller sends {getConfig:true}
  q.pushText('{"name":"new","sequenceTimer":20}');

  const got = await q.waitText('{"name"', 500, m);
  assert.equal(JSON.parse(got).sequenceTimer, 20, 'must return the fresh response, not the stale one');
});

test('without a mark, the oldest match wins — the old behavior, kept honest', async () => {
  const q = makeQueues();
  q.pushText('{"name":"old"}');
  q.pushText('{"name":"new"}');
  assert.equal(JSON.parse(await q.waitText('{"name"', 500)).name, 'old');
});

test('a matched message is consumed, so two waiters cannot both claim it', async () => {
  const q = makeQueues();
  const m = q.mark();
  q.pushText('{"ack":1}');
  assert.ok(await q.waitText('{"ack"', 300, m));
  assert.equal(await q.waitText('{"ack"', 60, m), null, 'second waiter must not re-match a claimed message');
});

test('unclaimed frames are bounded — a long-lived connection must not leak', async () => {
  const q = makeQueues({ maxQueued: 10 });
  for (let i = 0; i < 500; i++) q.pushText(`{"fps":${i}}`); // ~1/s status frames, nobody consuming
  assert.equal(q._sizes().texts, 10);
  // and the newest survives, which is what a status reader actually wants
  const newest = JSON.parse(await q.waitText('{"fps"', 300));
  assert.equal(newest.fps, 490);
});

test('getStatus-shaped read: waiting after a mark yields the NEXT frame, not the oldest', async () => {
  const q = makeQueues();
  for (let i = 0; i < 30; i++) q.pushText(`{"fps":${i}}`); // 30s of accumulated status
  const m = q.mark();
  q.pushText('{"fps":99}');
  assert.equal(JSON.parse(await q.waitText('{"fps"', 300, m)).fps, 99);
});

test('waitText resolves null on timeout (callers must treat that as failure)', async () => {
  const q = makeQueues();
  assert.equal(await q.waitText('{"nope"', 40), null);
});

test('waitBinary filters on the frame-type byte', async () => {
  const q = makeQueues();
  const m = q.mark();
  q.pushBinary(chunk(5, 5, [1, 2, 3]));   // stray preview frame
  q.pushBinary(chunk(7, 5, [9, 9]));      // the program list we asked for
  const got = await q.waitBinary(300, 7, m);
  assert.equal(got[0], 7);
});

test('collectChunks ends on the last-chunk FLAG, not on a receive timeout', async () => {
  const q = makeQueues();
  const m = q.mark();
  q.pushBinary(chunk(7, 1, 'aaa'));  // first
  q.pushBinary(chunk(7, 2, 'bbb'));  // middle
  q.pushBinary(chunk(7, 4, 'ccc'));  // last
  const payload = await q.collectChunks(7, { after: m, ms: 300 });
  assert.equal(payload.toString(), 'aaabbbccc');
});

test('collectChunks keeps waiting across a gap longer than a naive per-frame timeout', async () => {
  const q = makeQueues();
  const m = q.mark();
  q.pushBinary(chunk(7, 1, 'aa'));
  // the device stalls, then resumes — the old code ended the collect here and
  // returned a silently truncated result
  setTimeout(() => q.pushBinary(chunk(7, 4, 'bb')), 120);
  const payload = await q.collectChunks(7, { after: m, ms: 1000 });
  assert.equal(payload.toString(), 'aabb');
});

test('collectChunks THROWS on a truncated transfer instead of returning a short read', async () => {
  const q = makeQueues();
  const m = q.mark();
  q.pushBinary(chunk(7, 1, 'aa')); // first chunk, last never arrives
  await assert.rejects(
    () => q.collectChunks(7, { after: m, ms: 60 }),
    /stopped sending mid-transfer.*1 chunk/s,
  );
});

test('collectChunks honours headerBytes (type-4 thumbnails carry a 17-byte id)', async () => {
  const q = makeQueues();
  const m = q.mark();
  const id = 'x'.repeat(17);
  q.pushBinary(Buffer.concat([Buffer.from([4, 5]), Buffer.from(id), Buffer.from('JPEG')]));
  const payload = await q.collectChunks(4, { after: m, ms: 300, headerBytes: 19 });
  assert.equal(payload.toString(), 'JPEG');
});

test('purgeBinary drops every frame of a type, including unclaimed strays', () => {
  const q = makeQueues();
  q.pushBinary(chunk(5, 5, [1]));
  q.pushBinary(chunk(5, 5, [2]));
  q.pushBinary(chunk(7, 5, [3]));
  q.purgeBinary(5);
  assert.equal(q._sizes().binaries, 1);
});

// A `purgeText` (the text analogue of purgeBinary above) was tried for
// PBZ-PLAN.md Chunk 26's stale-ack problem and REMOVED after a second
// verification round found it didn't work and made things worse: mark()
// already excludes anything queued before it (that's Chunk 24's own
// guarantee, exercised by "a frame queued BEFORE the mark can never satisfy
// a later request" above), so a purge taken right before mark() could never
// reach a stray ack that arrives AFTER — which is exactly when the real
// leak happens. Worse, a purge running on every call could steal a
// genuinely live ack out from under a second, concurrent waiter on the same
// connection (reproduced: a delivered ack sits claimable for up to
// waitEntry's ~10ms poll window, and a second call's purge landing in that
// window left the first call hanging to its own timeout). The actual fix —
// closing the connection on a write timeout so a late ack dies with the old
// socket — lives in lib/pixelblaze.mjs's `_awaitAckOrQuarantine`.

// --- Chunk 29: transport death ---------------------------------------------
// The queue's own half of "post-open ws errors are swallowed". A dropped
// connection used to be indistinguishable from a slow device: every parked
// waiter ran out its own full timeout and then reported a timeout, so the
// caller blamed the device for ignoring a command nothing was listening to.

test('fail() rejects a parked waiter immediately, rather than letting it time out', async () => {
  const q = makeQueues();
  const t0 = Date.now();
  const waiting = q.waitText('{"ack"', 3000, q.mark());
  q.fail(() => new Error('websocket: closed mid-exchange'));
  await assert.rejects(waiting, /closed mid-exchange/);
  assert.ok(Date.now() - t0 < 500, 'must reject on the failure, not run out the 3s wait');
});

test('fail() rejects waiters that arrive after the failure, too', async () => {
  const q = makeQueues();
  q.fail(() => new Error('websocket: closed mid-exchange'));
  await assert.rejects(q.waitText('{"ack"', 3000, q.mark()), /closed mid-exchange/);
  await assert.rejects(q.waitBinary(3000, 5, q.mark()), /closed mid-exchange/);
});

test('fail() is idempotent and the FIRST cause wins', async () => {
  // A close event always follows an error event. The error is the specific one
  // ("ECONNRESET"), the close is the generic one, and the generic must not
  // overwrite it on the way past.
  const q = makeQueues();
  q.fail(() => new Error('ECONNRESET'));
  q.fail(() => new Error('generic close'));
  await assert.rejects(q.waitText('{"ack"', 100, q.mark()), /ECONNRESET/);
});

test('fail() does not discard frames that already arrived', async () => {
  // Messages received before the drop are still real answers. Only the WAITING
  // is hopeless, and peek/purge callers never wait.
  const q = makeQueues();
  const m = q.mark();
  q.pushBinary(chunk(5, 1, [9, 9, 9]));
  q.fail(() => new Error('websocket: closed mid-exchange'));
  assert.equal(q.peekBinary(5, m).length, 1, 'a frame that arrived before the drop is still a frame');
});

test('collectChunks reports the transport failure, not its own "stopped sending"', async () => {
  // A half-read transfer on a dead socket is not the device stalling
  // mid-transfer, and saying so sends the reader after the wrong problem.
  const q = makeQueues();
  const m = q.mark();
  q.pushBinary(chunk(7, 1, [1, 2]));           // first chunk, no last flag
  const reading = q.collectChunks(7, { ms: 3000, after: m });
  q.fail(() => new Error('websocket: closed mid-exchange'));
  await assert.rejects(reading, /closed mid-exchange/);
});

test('a slow device still resolves null: death and slowness stay distinguishable', async () => {
  const q = makeQueues();
  assert.equal(await q.waitText('{"ack"', 30, q.mark()), null);
  assert.equal(q.failure(), null, 'a timeout must not mark the transport dead');
});
