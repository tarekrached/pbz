// Hermetic tests for the write-latency watchdog (PBZ-PLAN.md Chunk 26):
// lib/latency.mjs's pure arithmetic and makeWatchdog factory, plus the
// ping-chase protocol (setConfig/delete) and the onWriteLatency timing seam
// (setConfig/delete/setControls/activate) that replaced the original blind
// sleep(150)s.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WARN_FLOOR_MS, WARN_MULTIPLIER, EMA_ALPHA,
  updateBaseline, warnThresholdMs, recordSample, parseLatencyState, applySample, timeOp, makeWatchdog,
  defragHealthGate, buildDefragHealthGate,
} from '../lib/latency.mjs';
import { Pixelblaze } from '../lib/pixelblaze.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- updateBaseline ----------

test('updateBaseline: cold start seeds the baseline at the sample', () => {
  assert.equal(updateBaseline(null, 200), 200);
});

test('updateBaseline: warm EMA, hand-computed (prev=100, sample=200, alpha=0.2 -> 120)', () => {
  assert.equal(updateBaseline(100, 200, 0.2), 120);
});

test('updateBaseline: default alpha matches EMA_ALPHA', () => {
  assert.equal(EMA_ALPHA, 0.2);
  assert.equal(updateBaseline(100, 200), 0.2 * 200 + 0.8 * 100);
});

test('updateBaseline: custom alpha overrides the default', () => {
  assert.equal(updateBaseline(100, 200, 0.5), 150);
});

// ---------- warnThresholdMs ----------

test('warnThresholdMs: null baseline -> the floor', () => {
  assert.equal(warnThresholdMs(null), WARN_FLOOR_MS);
  assert.equal(warnThresholdMs(undefined), WARN_FLOOR_MS);
});

test('warnThresholdMs: small baseline -> the floor wins', () => {
  // 3 * 100 = 300, well under the 2000ms floor
  assert.equal(warnThresholdMs(100), WARN_FLOOR_MS);
});

test('warnThresholdMs: large baseline -> the multiplier wins', () => {
  assert.equal(warnThresholdMs(1000), 3000);
  assert.equal(WARN_MULTIPLIER, 3);
});

// ---------- recordSample ----------

test('recordSample: cold start never warns, even for a huge sample', () => {
  const { warn, baselineMs, thresholdMs } = recordSample(null, 999999);
  assert.equal(warn, false);
  assert.equal(baselineMs, 999999); // still seeds the baseline
  assert.equal(thresholdMs, WARN_FLOOR_MS);
});

test('recordSample: under threshold stays silent', () => {
  const { warn } = recordSample(100, 500); // threshold = floor 2000ms
  assert.equal(warn, false);
});

test('recordSample: floor-governed boundary — 2000 does not warn, 2001 does', () => {
  // baseline low enough that 3x baseline < floor, so the floor governs
  assert.equal(recordSample(10, 2000).warn, false);
  assert.equal(recordSample(10, 2001).warn, true);
});

test('recordSample: multiplier-governed boundary — 3x baseline does not warn, +1 does', () => {
  // baseline 1000 -> threshold = max(3000, 2000) = 3000
  assert.equal(recordSample(1000, 3000).warn, false);
  assert.equal(recordSample(1000, 3001).warn, true);
});

test('recordSample: threshold is computed from the PRIOR baseline, not the updated one', () => {
  // prev baseline 1000 -> threshold 3000, regardless of what this sample does to the baseline
  const { thresholdMs, baselineMs } = recordSample(1000, 3001);
  assert.equal(thresholdMs, 3000);
  assert.notEqual(baselineMs, thresholdMs / WARN_MULTIPLIER); // baseline moved, threshold didn't recompute from it
});

// ---------- defragHealthGate (PBZ-PLAN.md Chunk 28) ----------

test('defragHealthGate: sample under the floor, no baseline -> ok', () => {
  assert.deepEqual(defragHealthGate(500, null), { ok: true, thresholdMs: WARN_FLOOR_MS });
});

test('defragHealthGate: EXPLICIT cold-start-over-floor refusal — diverges from recordSample on purpose', () => {
  // recordSample(null, 999999).warn is FALSE (cold start never warns — see
  // its own test above). defragHealthGate must NOT inherit that: a one-shot
  // gate with no "next sample" to fall back on can't stay silent just
  // because this happens to be a host with no history yet.
  assert.equal(recordSample(null, 999999).warn, false);
  const gate = defragHealthGate(999999, null);
  assert.equal(gate.ok, false);
  assert.equal(gate.thresholdMs, WARN_FLOOR_MS);
});

test('defragHealthGate: sample exactly at the floor threshold is ok (<=, not <)', () => {
  assert.deepEqual(defragHealthGate(WARN_FLOOR_MS, null), { ok: true, thresholdMs: WARN_FLOOR_MS });
});

test('defragHealthGate: one ms over the floor threshold refuses', () => {
  const gate = defragHealthGate(WARN_FLOOR_MS + 1, null);
  assert.equal(gate.ok, false);
  assert.equal(gate.thresholdMs, WARN_FLOOR_MS);
});

test('defragHealthGate: large baseline -> the multiplier governs, not the floor', () => {
  // baseline 1000 -> threshold = max(3000, 2000) = 3000
  assert.deepEqual(defragHealthGate(3000, 1000), { ok: true, thresholdMs: 3000 });
  assert.equal(defragHealthGate(3001, 1000).ok, false);
});

test('defragHealthGate: does not reuse recordSample\'s warn flag — same inputs, different shape/semantics', () => {
  const sample = recordSample(1000, 3001);
  const gate = defragHealthGate(3001, 1000);
  // recordSample's warn means "the sample IS bad" (true here); the gate's ok
  // means "the sample IS fine" — same underlying comparison, inverted sense,
  // and the gate is its own function, not recordSample's return value reused.
  assert.equal(sample.warn, true);
  assert.equal(gate.ok, false);
  assert.equal(gate.thresholdMs, sample.thresholdMs);
});

// ---------- buildDefragHealthGate (composed with makeWatchdog) ----------
//
// REGRESSION COVERAGE for a real bug: buildDefragHealthGate and makeWatchdog
// each passed their own isolated unit tests while still composing into a
// broken CLI — exactly the "the two unit suites passing in isolation is
// exactly why this escaped" failure mode. In the real call sequence,
// `pb.defrag(undefined, { healthGate: buildDefragHealthGate(host, {...}) })`
// builds the gate (as part of that argument list) BEFORE defrag()'s own
// health-check write runs, and that write reports through the SAME
// onWriteLatency -> makeWatchdog -> writeState path that updates the
// persisted baseline. These tests wire both functions together against a
// shared in-memory store and reproduce that exact ordering, so a future
// change that moves the baseline read back inside the closure (reintroducing
// the bug) fails here even if each function's own isolated tests stay green.

function makeFakeStateStore(initial = { hosts: {} }) {
  let state = initial;
  return { readState: () => state, writeState: (s) => { state = s; } };
}

test('buildDefragHealthGate + makeWatchdog: cold host, 6000ms health-check sample -> refused', () => {
  const host = 'fake-host';
  const store = makeFakeStateStore(); // no prior baseline for this host
  const onWriteLatency = makeWatchdog({ host, readState: store.readState, writeState: store.writeState, warn: () => {} });

  // Build the gate FIRST, exactly like pbz.mjs's argument-list ordering —
  // this is the synchronous snapshot the fix depends on.
  const gate = buildDefragHealthGate(host, { readState: store.readState });

  // Then simulate defrag()'s own timed setConfig reporting its sample —
  // this is the write that, pre-fix, would have poisoned a LAZY read.
  onWriteLatency('setConfig', 6000);

  const result = gate(6000);
  assert.equal(result.ok, false, 'a cold host must still be able to refuse — a lazy read would have made this unrefusable');
  assert.match(result.message, /no baseline yet, 2s floor/);
});

test('buildDefragHealthGate + makeWatchdog: warm 1000ms baseline, 5000ms sample -> refused', () => {
  const host = 'fake-host';
  const store = makeFakeStateStore({ hosts: { [host]: { baselineMs: 1000 } } });
  const onWriteLatency = makeWatchdog({ host, readState: store.readState, writeState: store.writeState, warn: () => {} });

  const gate = buildDefragHealthGate(host, { readState: store.readState }); // captures baselineMs=1000, pre-write

  onWriteLatency('setConfig', 5000); // EMA-updates the STORED baseline toward 5000 — must not affect the gate's already-captured snapshot

  const result = gate(5000);
  assert.equal(result.ok, false, 'threshold from the PRE-write baseline (1000 -> 3000) must govern, not the post-write one');
  assert.match(result.message, /baseline 1000ms/);
});

// ---------- parseLatencyState ----------

test('parseLatencyState: valid state round-trips', () => {
  const state = parseLatencyState('{"hosts":{"1.2.3.4":{"baselineMs":150}}}');
  assert.deepEqual(state, { hosts: { '1.2.3.4': { baselineMs: 150 } } });
});

test('parseLatencyState: four corrupt shapes all fall back to {hosts:{}}, none throw', () => {
  const cases = [
    'not json at all {{{',           // invalid JSON
    '[1,2,3]',                       // valid JSON, not an object
    '{"nope":"no hosts key"}',       // object, missing `hosts`
    '{"hosts":"not an object"}',     // object, wrong-typed `hosts`
  ];
  for (const raw of cases) {
    assert.doesNotThrow(() => parseLatencyState(raw), `should not throw on: ${raw}`);
    assert.deepEqual(parseLatencyState(raw), { hosts: {} }, `should fall back on: ${raw}`);
  }
});

test('parseLatencyState: never throws even on non-string/undefined input', () => {
  assert.doesNotThrow(() => parseLatencyState(undefined));
  assert.deepEqual(parseLatencyState(undefined), { hosts: {} });
});

// ---------- applySample ----------

test('applySample: two hosts are scored independently', () => {
  let state = { hosts: {} };
  ({ state } = applySample(state, 'a', 100));
  ({ state } = applySample(state, 'b', 5000));
  assert.equal(state.hosts.a.baselineMs, 100);
  assert.equal(state.hosts.b.baselineMs, 5000);
});

test('applySample: a new host does not disturb an existing one', () => {
  const before = { hosts: { a: { baselineMs: 100 } } };
  const { state } = applySample(before, 'b', 300);
  assert.equal(state.hosts.a.baselineMs, 100);
  assert.equal(state.hosts.b.baselineMs, 300);
});

test('applySample: input state is not mutated', () => {
  const before = { hosts: { a: { baselineMs: 100 } } };
  const snapshot = JSON.parse(JSON.stringify(before));
  applySample(before, 'a', 500);
  assert.deepEqual(before, snapshot, 'applySample must return a new state, not mutate the old one');
});

test('applySample: returns prevBaselineMs alongside the new baseline', () => {
  const before = { hosts: { a: { baselineMs: 100 } } };
  const { prevBaselineMs, baselineMs } = applySample(before, 'a', 300);
  assert.equal(prevBaselineMs, 100);
  assert.equal(baselineMs, updateBaseline(100, 300));
});

test('applySample: a non-finite stored baselineMs (poisoned/hand-edited) is treated as cold start', () => {
  const before = { hosts: { a: { baselineMs: 'abc' } } };
  const { prevBaselineMs, baselineMs, warn } = applySample(before, 'a', 999999);
  assert.equal(prevBaselineMs, null, 'a non-finite stored value must not be trusted as a real baseline');
  assert.equal(baselineMs, 999999, 'cold start seeds the baseline at the sample, same as an absent host');
  assert.equal(warn, false, 'cold start never warns, no matter how large the sample');
});

test('applySample: NaN and Infinity stored baselines are also treated as cold start', () => {
  assert.equal(applySample({ hosts: { a: { baselineMs: NaN } } }, 'a', 500).prevBaselineMs, null);
  assert.equal(applySample({ hosts: { a: { baselineMs: Infinity } } }, 'a', 500).prevBaselineMs, null);
});

// ---------- timeOp ----------

test('timeOp: exact ms from a fake now() sequence, result passthrough', async () => {
  const times = [1000, 1075];
  const now = () => times.shift();
  const { result, ms } = await timeOp(async () => 'ok', { now });
  assert.equal(ms, 75);
  assert.equal(result, 'ok');
});

test('timeOp: a rejection from fn passes through untouched, not caught', async () => {
  const boom = new Error('write failed');
  await assert.rejects(timeOp(async () => { throw boom; }), (e) => e === boom);
});

// ---------- makeWatchdog ----------
//
// The CLI-facing glue (PBZ-PLAN.md Chunk 26, reworked after local review):
// pbz.mjs supplies only readState/writeState/warn; the scoring, persistence
// ordering, and exact warning wording live here so they're covered without a
// filesystem or a device.

test('makeWatchdog: a normal sample is recorded and persisted', () => {
  let saved = null;
  const wd = makeWatchdog({
    host: 'h1',
    readState: () => ({ hosts: {} }),
    writeState: (s) => { saved = s; },
    warn: () => { throw new Error('should not warn on a cold-start sample'); },
  });
  wd('setConfig', 120);
  assert.deepEqual(saved, { hosts: { h1: { baselineMs: 120 } } });
});

test('makeWatchdog: warn fires with the PRIOR baseline in the message, not the post-sample one', () => {
  const warnings = [];
  const wd = makeWatchdog({
    host: '192.168.1.50',
    readState: () => ({ hosts: { '192.168.1.50': { baselineMs: 100 } } }), // threshold = floor 2000ms
    writeState: () => {},
    warn: (msg) => warnings.push(msg),
  });
  wd('setConfig', 2500); // over the 2000ms floor
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /setConfig took 2500ms on 192\.168\.1\.50/);
  assert.match(warnings[0], /baseline 100ms/); // the PRIOR baseline (100), not the EMA-updated one
  assert.match(warnings[0], /warns past 2000ms/);
  assert.match(warnings[0], /pbz info/);
});

test('makeWatchdog: the sample is persisted BEFORE the threshold-warn decision is made', () => {
  const order = [];
  const wd = makeWatchdog({
    host: 'h1',
    readState: () => ({ hosts: { h1: { baselineMs: 100 } } }), // threshold = floor 2000ms
    writeState: () => { order.push('persist'); },
    warn: () => { order.push('warn'); },
  });
  wd('setConfig', 5000); // over threshold -> also warns
  assert.deepEqual(order, ['persist', 'warn']);
});

test('makeWatchdog: a writeState failure warns once and does not throw or block the latency warn', () => {
  const warnings = [];
  const wd = makeWatchdog({
    host: 'h1',
    readState: () => ({ hosts: { h1: { baselineMs: 100 } } }), // threshold = floor 2000ms
    writeState: () => { throw new Error('disk full'); },
    warn: (msg) => warnings.push(msg),
  });
  assert.doesNotThrow(() => wd('setConfig', 5000)); // also over threshold
  assert.equal(warnings.length, 2, 'one line for the persist failure, one for the latency warn');
  assert.match(warnings[0], /couldn't save write-latency state \(disk full\)/);
  assert.match(warnings[1], /setConfig took 5000ms/);
});

test('makeWatchdog: an under-threshold sample never calls warn', () => {
  const wd = makeWatchdog({
    host: 'h1',
    readState: () => ({ hosts: { h1: { baselineMs: 1000 } } }), // threshold = 3000ms
    writeState: () => {},
    warn: () => { throw new Error('should not warn'); },
  });
  assert.doesNotThrow(() => wd('setConfig', 500));
});

// ---------- ping-chase protocol + onWriteLatency timing seam ----------
//
// setConfig/deleteProgram get no ack of their own (verified live 2026-08-14,
// v3.67). setConfig/delete/setControls/activate now mark(), send, and await
// an ack — replacing the old blind sleep(150)s — and report their
// post-connect write->ack span through the onWriteLatency constructor
// option. On a timeout, the connection is quarantined (closed + dropped)
// before the error is thrown, so a late reply from the abandoned write dies
// with the old socket instead of risking a later call's wait (see
// lib/pixelblaze.mjs's `_awaitAckOrQuarantine` — an earlier `purgeText`-based
// attempt at this was removed after a second verification round found it
// didn't work and could steal a live ack from a concurrent waiter; see
// test/queue.test.mjs's note on the primitive that used to live there).
// These tests drive the real Pixelblaze methods against a fake WebSocket,
// following the same fake-socket approach as test/protocol.test.mjs (which
// exercises `connect()` directly); here the injection point is the
// `WebSocket` global that `connect()`'s default parameter resolves at call
// time, since onWriteLatency is a constructor option, not a new seam on the
// connection.

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

test('setConfig: sends the write frame then a ping frame, resolves once the ping acks, and reports onWriteLatency', async () => {
  await withFakeSocket(async (getSock) => {
    const reports = [];
    const pb = new Pixelblaze('fake-host', { onWriteLatency: (op, ms) => reports.push({ op, ms }) });
    const p = pb.setConfig({ sequenceTimer: 20 });
    await sleep(20); // let the fake connection open and both sends flush
    const ws = getSock();
    assert.equal(ws.sent.length, 2, 'expected exactly two frames: the write, then the ping');
    assert.deepEqual(JSON.parse(ws.sent[0]), { sequenceTimer: 20 });
    assert.deepEqual(JSON.parse(ws.sent[1]), { ping: true });
    // setConfig must still be pending — no ack delivered yet.
    let settled = false;
    p.then(() => { settled = true; });
    await sleep(20);
    assert.equal(settled, false, 'must not resolve before the chased ping acks');

    ws.deliver('{"ack":1}');
    const result = await p;
    assert.deepEqual(result, { sequenceTimer: 20 });
    assert.equal(reports.length, 1);
    assert.equal(reports[0].op, 'setConfig');
    assert.ok(reports[0].ms >= 0 && reports[0].ms < 200, `expected a small measured span, got ${reports[0].ms}ms`);
    pb.close();
  });
});

test('delete: sends the deleteProgram frame then a ping frame, resolves once the ping acks, and reports onWriteLatency', async () => {
  await withFakeSocket(async (getSock) => {
    const reports = [];
    const pb = new Pixelblaze('fake-host', { onWriteLatency: (op, ms) => reports.push({ op, ms }) });
    // delete() resolves the target via list() first — answer that on the
    // same fake connection before the delete's own frames appear.
    const p = pb.delete('abc123');
    await sleep(20);
    const ws = getSock();
    const listSent = ws.sent.map((s) => { try { return JSON.parse(s); } catch { return null; } });
    assert.ok(listSent.some((m) => m && m.listPrograms === true), 'delete() must resolve the target via list() first');
    ws.deliver(listChunk('abc123', 'Some Pattern'));
    await sleep(20);

    assert.equal(ws.sent.length, 3, 'listPrograms, then the delete write, then the ping');
    assert.deepEqual(JSON.parse(ws.sent[1]), { deleteProgram: 'abc123' });
    assert.deepEqual(JSON.parse(ws.sent[2]), { ping: true });

    ws.deliver('{"ack":1}');
    const hit = await p;
    assert.equal(hit.id, 'abc123');
    assert.equal(reports.length, 1);
    assert.equal(reports[0].op, 'delete');
    assert.ok(reports[0].ms >= 0 && reports[0].ms < 200, `expected a small measured span, got ${reports[0].ms}ms`);
    pb.close();
  });
});

test('delete: onWriteLatency excludes list()\'s own time — only the post-connect write->ack span counts', async () => {
  await withFakeSocket(async (getSock) => {
    const reports = [];
    const pb = new Pixelblaze('fake-host', { onWriteLatency: (op, ms) => reports.push({ op, ms }) });
    const p = pb.delete('abc123');
    await sleep(10);
    const ws = getSock();
    // A deliberately SLOW list() — the bug this rework fixes folded exactly
    // this into the reported latency, because the old measurement wrapped
    // the whole CLI-level call (target resolution included) instead of just
    // the write itself.
    await sleep(150);
    ws.deliver(listChunk('abc123', 'Some Pattern'));
    await sleep(10);
    // Now the delete write + chased ping have gone out; ack immediately.
    ws.deliver('{"ack":1}');
    const hit = await p;
    assert.equal(hit.id, 'abc123');
    assert.equal(reports.length, 1);
    assert.equal(reports[0].op, 'delete');
    assert.ok(reports[0].ms < 100, `expected the ~150ms list() delay to be excluded from the measured span, got ${reports[0].ms}ms`);
    pb.close();
  });
});

test('activate: onWriteLatency excludes list()\'s own time — only the post-connect write->ack span counts', async () => {
  await withFakeSocket(async (getSock) => {
    const reports = [];
    const pb = new Pixelblaze('fake-host', { onWriteLatency: (op, ms) => reports.push({ op, ms }) });
    const p = pb.activate('abc123');
    await sleep(10);
    const ws = getSock();
    await sleep(150); // deliberately slow list(), same as delete's test above
    ws.deliver(listChunk('abc123', 'Some Pattern'));
    await sleep(10);
    assert.deepEqual(JSON.parse(ws.sent[1]), { activeProgramId: 'abc123' });
    ws.deliver('{"activeProgram":{"id":"abc123"}}');
    const hit = await p;
    assert.equal(hit.id, 'abc123');
    assert.equal(reports.length, 1);
    assert.equal(reports[0].op, 'activate');
    assert.ok(reports[0].ms < 100, `expected the ~150ms list() delay to be excluded, got ${reports[0].ms}ms`);
    pb.close();
  });
});

test('setControls: sends the write frame, resolves on ack, and reports onWriteLatency', async () => {
  await withFakeSocket(async (getSock) => {
    const reports = [];
    const pb = new Pixelblaze('fake-host', { onWriteLatency: (op, ms) => reports.push({ op, ms }) });
    const p = pb.setControls({ sliderSpeed: 0.4 });
    await sleep(10);
    const ws = getSock();
    assert.deepEqual(JSON.parse(ws.sent[0]), { setControls: { sliderSpeed: 0.4 }, save: false });
    ws.deliver('{"ack":1}');
    await p;
    assert.equal(reports.length, 1);
    assert.equal(reports[0].op, 'setControls');
    assert.ok(reports[0].ms >= 0 && reports[0].ms < 100, `expected a small measured span, got ${reports[0].ms}ms`);
    pb.close();
  });
});

test('onWriteLatency exceptions never break the write they are reporting on', async () => {
  await withFakeSocket(async (getSock) => {
    const pb = new Pixelblaze('fake-host', { onWriteLatency: () => { throw new Error('watchdog boom'); } });
    const p = pb.setConfig({ sequenceTimer: 20 });
    await sleep(10);
    const ws = getSock();
    ws.deliver('{"ack":1}');
    const result = await p; // must NOT reject even though the hook threw
    assert.deepEqual(result, { sequenceTimer: 20 });
    pb.close();
  });
});

// The test below pays a real ~8s wait (WRITE_ACK_TIMEOUT_MS) to prove the
// end-to-end fail-loud + connection-quarantine behavior against the ACTUAL
// production timeout and message wording, rather than a shortened
// stand-in. Its sibling (the same proof for `delete`) lives in
// test/latency-timeout.test.mjs — split into its own file, not merely its
// own test, so `node --test`'s default per-file concurrency runs both ~8s
// waits in parallel worker processes instead of back-to-back in this one;
// running them concurrently IN this file/process was considered and
// rejected, because both tests swap the shared `globalThis.WebSocket`
// global, and a fake-socket test that runs on a shared global cannot safely
// overlap with a sibling doing the same thing in the same process.

test('setConfig: ack timeout is fail-loud, quarantines the connection, and A\'s late ack (delivered on the OLD socket) cannot leak into B', { timeout: 12000 }, async () => {
  await withFakeSocket(async (getSock) => {
    const reports = [];
    const pb = new Pixelblaze('fake-host', { onWriteLatency: (op, ms) => reports.push({ op, ms }) });

    // Call A: no ack ever delivered. Must reject after WRITE_ACK_TIMEOUT_MS
    // (8s) with a message naming the disease, not expectText's generic
    // "no response" wording — and must NOT have reported any latency.
    const pA = pb.setConfig({ sequenceTimer: 1 });
    await sleep(20); // let the fake connection open (getSock() has nothing to return before this)
    const oldWs = getSock(); // the connection call A is (and will remain) bound to
    await assert.rejects(pA, (err) => {
      assert.match(err.message, /no ack within 8s after setConfig/);
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

    // Call B: a fresh call. _getConn() must reconnect (this._conn was
    // nulled by the quarantine), landing on a NEW fake socket instance.
    const pB = pb.setConfig({ sequenceTimer: 2 });
    await sleep(20);
    const newWs = getSock();
    assert.notEqual(newWs, oldWs, 'call B must reconnect onto a new connection, not reuse the quarantined one');

    // It must NOT resolve off A's stale ack (which was delivered on oldWs,
    // not newWs) — it must wait for and use its OWN ack.
    let settled = false;
    pB.then(() => { settled = true; });
    await sleep(30);
    assert.equal(settled, false, 'must not have resolved off the stale ack A left on the old socket');

    newWs.deliver('{"ack":1}'); // B's own real ack, on the NEW socket
    const result = await pB;
    assert.deepEqual(result, { sequenceTimer: 2 });
    assert.equal(reports.length, 1);
    assert.equal(reports[0].op, 'setConfig');
    pb.close();
  });
});
