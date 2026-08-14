// Hermetic test for storage-pressure thresholds (PBZ-PLAN.md Chunk 25) — pure
// arithmetic, no device, no LAN.
import test from 'node:test';
import assert from 'node:assert/strict';
import { storagePct, storageLevel, STORAGE_WARN_PCT, STORAGE_CRITICAL_PCT } from '../lib/storage.mjs';

test('storagePct: normal case, floored to an integer', () => {
  assert.equal(storagePct(74, 100), 74);
  assert.equal(storagePct(1440000, 1472000), Math.floor((100 * 1440000) / 1472000));
});

// storagePct floors (never rounds up) so display, storageLevel, and
// checkExpectations' comparison + message all read the SAME integer and can
// never disagree with each other the way toFixed(0)-vs-raw-comparison used
// to: 74.6% raw used to print "(75%)" while only soft-warning at the
// 74%-raw threshold; 59.6% raw used to print "(60%)" while staying silent.
test('storagePct: 74.6% raw floors to 74, and that 74 is what storageLevel sees (still warn, not critical)', () => {
  const pct = storagePct(746, 1000);
  assert.equal(pct, 74);
  assert.equal(storageLevel(pct), 'warn');
});

test('storagePct: 59.6% raw floors to 59, and that 59 is what storageLevel sees (silent, below warn)', () => {
  const pct = storagePct(596, 1000);
  assert.equal(pct, 59);
  assert.equal(storageLevel(pct), null);
});

test('storagePct: null-safe on a bad size', () => {
  assert.equal(storagePct(50, 0), null);
  assert.equal(storagePct(50, undefined), null);
  assert.equal(storagePct(50, -100), null);
  assert.equal(storagePct(50, NaN), null);
  assert.equal(storagePct(50, Infinity), null);
});

test('storagePct: null-safe on a bad used', () => {
  assert.equal(storagePct(undefined, 100), null);
  assert.equal(storagePct(NaN, 100), null);
});

test('storageLevel: below 60 is null', () => {
  assert.equal(storageLevel(0), null);
  assert.equal(storageLevel(59.9), null);
});

test('storageLevel: 60 is warn', () => {
  assert.equal(storageLevel(60), 'warn');
});

// The incident board (INCIDENT-2026-07-20) died at 74% — that number must
// land as 'warn', not 'critical'. 75 is deliberately a hair past the
// observed failure point.
test('storageLevel: 74 (the incident board) is warn, not critical', () => {
  assert.equal(storageLevel(74), 'warn');
});

test('storageLevel: 75 is critical', () => {
  assert.equal(storageLevel(75), 'critical');
});

test('storageLevel: above 75 is critical', () => {
  assert.equal(storageLevel(90), 'critical');
});

test('storageLevel: null pct is null', () => {
  assert.equal(storageLevel(null), null);
});

test('thresholds are the documented constants', () => {
  assert.equal(STORAGE_WARN_PCT, 60);
  assert.equal(STORAGE_CRITICAL_PCT, 75);
});
