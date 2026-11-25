import { test } from 'node:test';
import assert from 'node:assert/strict';
import { httpFetch, describeFetchError } from '../lib/http.mjs';

// What Node's fetch actually throws on a network failure: a bare TypeError
// whose system code lives on .cause.
const netFail = (code) => { const e = new TypeError('fetch failed'); e.cause = Object.assign(new Error(`connect ${code}`), { code }); return e; };
const failingFetch = (err) => async () => { throw err; };

test('EHOSTUNREACH: keeps the "fetch failed" prefix, names URL and code, sets err.code, hints at Local Network', async () => {
  const original = netFail('EHOSTUNREACH');
  await assert.rejects(httpFetch('http://192.168.1.79/reboot', { method: 'POST' }, failingFetch(original)), (err) => {
    assert.match(err.message, /^fetch failed: http:\/\/192\.168\.1\.79\/reboot \(EHOSTUNREACH\)/);
    assert.match(err.message, /Local Network privacy/);
    assert.match(err.message, /curl http:\/\/192\.168\.1\.79\//);
    assert.equal(err.code, 'EHOSTUNREACH');
    assert.equal(err.cause, original);
    return true;
  });
});

test('ENETUNREACH gets the same hint', () => {
  const err = describeFetchError('http://10.0.0.9/list', netFail('ENETUNREACH'));
  assert.equal(err.code, 'ENETUNREACH');
  assert.match(err.message, /Local Network privacy/);
});

test('other codes: code named, no Local Network hint', () => {
  const err = describeFetchError('http://h/list', netFail('ECONNREFUSED'));
  assert.equal(err.message, 'fetch failed: http://h/list (ECONNREFUSED)');
  assert.equal(err.code, 'ECONNREFUSED');
});

test('no code at all: still "fetch failed: <url>", no err.code', () => {
  const err = describeFetchError('http://h/x', new TypeError('fetch failed'));
  assert.equal(err.message, 'fetch failed: http://h/x');
  assert.equal(err.code, undefined);
});

test('aborts pass through untouched', async () => {
  const abort = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  await assert.rejects(httpFetch('http://h/', {}, failingFetch(abort)), (err) => err === abort);
});

test('success returns the response as-is', async () => {
  const res = { ok: true };
  assert.equal(await httpFetch('http://h/', {}, async () => res), res);
});

test('probeRoute: a port nobody listens on is reachable-but-refused, so null (not a can\'t-route code)', async () => {
  const { probeRoute } = await import('../lib/http.mjs');
  assert.equal(await probeRoute('127.0.0.1', { port: 1, timeoutMs: 2000 }), null);
});
