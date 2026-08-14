// Narrow hermetic coverage for Pixelblaze#_waitForReboot (PBZ-PLAN.md Chunk
// 28's defrag). Full-sequence defrag() orchestration is deliberately NOT
// hermetically covered — there is no fetch-mocking infra in this repo (the
// HTTP steps in saveBackup/restoreBackup/the delete loop would all need it),
// so that acceptance is classification tests (test/backup.test.mjs,
// test/latency.test.mjs) plus a live run, per the chunk's own spec.
//
// _waitForReboot itself needs neither fetch nor a real websocket to test
// meaningfully: it is just "sleep, then poll ping() until two-in-a-row
// succeed or a deadline passes." Rather than reaching for the fake-WebSocket
// infra in test/latency-timeout.test.mjs (built for ack/quarantine timing,
// which isn't what's under test here), this stubs `ping()` directly on the
// instance — a plain injected fake, and a much smaller surface to keep
// hermetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Pixelblaze } from '../lib/pixelblaze.mjs';

test('_waitForReboot: closes the connection before the first attempt', async () => {
  const pb = new Pixelblaze('fake-host');
  let closed = false;
  const origClose = pb.close.bind(pb);
  pb.close = () => { closed = true; origClose(); };

  pb.ping = async () => {
    assert.equal(closed, true, 'close() must have already run before the first ping() attempt');
    return 12; // ms
  };

  await pb._waitForReboot(5000, 5); // tiny pollMs so the settle/retries don't slow the suite
});

test('_waitForReboot: sleeps (settles) before the VERY FIRST ping attempt, not just between retries', async () => {
  const pb = new Pixelblaze('fake-host');
  pb.close = () => {};
  const start = Date.now();
  let firstCallAt = null;
  pb.ping = async () => {
    if (firstCallAt === null) firstCallAt = Date.now() - start;
    return 5; // always succeeds -> two calls total satisfy the two-in-a-row rule
  };

  await pb._waitForReboot(5000, 40);
  assert.ok(firstCallAt >= 35, `first ping() must be delayed by roughly pollMs (settle); was ${firstCallAt}ms`);
});

test('_waitForReboot: two consecutive successful pings resolve it', async () => {
  const pb = new Pixelblaze('fake-host');
  pb.close = () => {};
  let calls = 0;
  pb.ping = async () => { calls++; return 5; };

  await pb._waitForReboot(5000, 10);
  assert.equal(calls, 2, 'must not resolve on the first success alone');
});

test('_waitForReboot: a single transient success followed by a failure does NOT count — only back-to-back successes resolve it', async () => {
  const pb = new Pixelblaze('fake-host');
  pb.close = () => {};
  // fail, SUCCEED (lone — must not resolve here), fail (resets the count),
  // succeed, succeed (this pair is what finally resolves it).
  const script = ['fail', 'ok', 'fail', 'ok', 'ok'];
  let calls = 0;
  pb.ping = async () => {
    const step = script[calls];
    calls++;
    if (step === 'fail') throw new Error(`attempt ${calls} failed`);
    return 5;
  };

  await pb._waitForReboot(5000, 10);
  assert.equal(calls, script.length, 'must consume the whole script — the lone success at index 1 must not have resolved it early');
});

test('_waitForReboot: throws with the last ping error once the deadline passes (never achieves two-in-a-row)', async () => {
  const pb = new Pixelblaze('fake-host');
  pb.close = () => {};
  let calls = 0;
  pb.ping = async () => {
    calls++;
    throw new Error(`attempt ${calls} failed`);
  };

  await assert.rejects(pb._waitForReboot(60, 10), (err) => {
    assert.match(err.message, /device did not respond to ping twice in a row within 60ms/);
    assert.match(err.message, /attempt \d+ failed/);
    return true;
  });
  assert.ok(calls >= 1);
});

test('_waitForReboot: a single success right before the deadline still throws — one success is not enough', async () => {
  const pb = new Pixelblaze('fake-host');
  pb.close = () => {};
  let calls = 0;
  pb.ping = async () => {
    calls++;
    if (calls === 1) return 5; // one lone success, then the device goes quiet for good
    throw new Error(`attempt ${calls} failed`);
  };

  await assert.rejects(pb._waitForReboot(60, 10), /device did not respond to ping twice in a row/);
  assert.ok(calls >= 2, 'must have attempted at least once more after the lone success');
});

test('_waitForReboot: default timeoutMs/pollMs are accepted when omitted (provisional constants, not exercised for timing here)', async () => {
  const pb = new Pixelblaze('fake-host');
  pb.close = () => {};
  pb.ping = async () => 1;
  await pb._waitForReboot(); // must not throw synchronously on missing args; two successes at the default 1000ms pollMs (~2s here)
});
