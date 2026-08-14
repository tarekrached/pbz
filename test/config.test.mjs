// Hermetic test for `config --check`'s comparison logic (PBZ-PLAN.md Chunk
// 25) — pure, no device, no LAN.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkExpectations, validateMaxStoragePct } from '../lib/config.mjs';
import { storagePct } from '../lib/storage.mjs';

const cfg = { colorOrder: 'WRGB', pixelCount: 170 };
const status = { storageUsed: 60, storageSize: 100 }; // 60%

test('no drift -> empty array', () => {
  assert.deepEqual(checkExpectations(cfg, status, { colorOrder: 'WRGB', pixelCount: 170 }), []);
});

test('plain-key drift -> exact existing wording', () => {
  const problems = checkExpectations(cfg, status, { colorOrder: 'GRB' });
  assert.deepEqual(problems, ['colorOrder is WRGB, expected GRB']);
});

test('maxStoragePct: usage under the cap passes', () => {
  assert.deepEqual(checkExpectations(cfg, status, { maxStoragePct: 75 }), []);
});

test('maxStoragePct: usage equal to the cap passes ("exceeding" is strict)', () => {
  assert.deepEqual(checkExpectations(cfg, status, { maxStoragePct: 60 }), []);
});

test('maxStoragePct: usage over the cap fails', () => {
  const problems = checkExpectations(cfg, status, { maxStoragePct: 50 });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /storage is 60% used, expected ≤50%/);
});

// storagePct floors, so 60.4% raw usage reads as 60 — equal to, not over, a
// 60 cap. Before the fix this could flip the other way (a raw comparison
// failing against a cap the printed message claimed was satisfied).
test('maxStoragePct: 60.4% raw usage against a 60 cap passes, and the pct involved is 60', () => {
  const raw = { storageUsed: 604, storageSize: 1000 };
  assert.equal(storagePct(raw.storageUsed, raw.storageSize), 60);
  assert.deepEqual(checkExpectations(cfg, raw, { maxStoragePct: 60 }), []);
});

test('maxStoragePct: present in expect but status missing storage fields -> failure, not a silent pass', () => {
  const problems = checkExpectations(cfg, {}, { maxStoragePct: 75 });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /could not be verified/);
});

test('maxStoragePct: present in expect but status is null -> failure, not a silent pass', () => {
  const problems = checkExpectations(cfg, null, { maxStoragePct: 75 });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /could not be verified/);
});

test('maxStoragePct absent from expect -> status never consulted, may be null with no throw', () => {
  assert.deepEqual(checkExpectations(cfg, null, { colorOrder: 'WRGB' }), []);
  // undefined works too — nothing about maxStoragePct is touched.
  assert.deepEqual(checkExpectations(cfg, undefined, { colorOrder: 'WRGB' }), []);
});

test('maxStoragePct: garbage value throws rather than silently never firing', () => {
  assert.throws(() => checkExpectations(cfg, status, { maxStoragePct: 'a lot' }), /maxStoragePct must be a positive number/);
  assert.throws(() => checkExpectations(cfg, status, { maxStoragePct: 0 }), /maxStoragePct must be a positive number/);
  assert.throws(() => checkExpectations(cfg, status, { maxStoragePct: -10 }), /maxStoragePct must be a positive number/);
  assert.throws(() => checkExpectations(cfg, status, { maxStoragePct: NaN }), /maxStoragePct must be a positive number/);
});

test('validateMaxStoragePct: exported so the CLI can validate BEFORE a status fetch', () => {
  assert.doesNotThrow(() => validateMaxStoragePct({ maxStoragePct: 60 }));
  assert.doesNotThrow(() => validateMaxStoragePct({ colorOrder: 'WRGB' })); // absent -> no-op
  assert.throws(() => validateMaxStoragePct({ maxStoragePct: 0 }), /maxStoragePct must be a positive number/);
});

test('combined: a plain-key drift and a storage breach both report', () => {
  const problems = checkExpectations(cfg, { storageUsed: 90, storageSize: 100 }, { colorOrder: 'GRB', maxStoragePct: 75 });
  assert.equal(problems.length, 2);
  assert.match(problems[0], /colorOrder is WRGB, expected GRB/);
  assert.match(problems[1], /storage is 90% used, expected ≤75%/);
});
