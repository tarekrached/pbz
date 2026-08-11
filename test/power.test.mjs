// Hermetic test for the power-budget solver (PBZ-PLAN.md Chunk 11) — pure
// arithmetic on power.json, no device, no LAN.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { budgetChain, solveCapPercent, channelFullAmps, estimateFrameAmps, estimateDraw } from '../lib/power.mjs';

// Runs against the SHIPPED example (a real 170-px WRGB ring on a 160 W brick),
// not against whatever power.json the machine happens to have — so the numbers
// asserted below stay meaningful in a fresh clone.
const power = JSON.parse(readFileSync(path.join(import.meta.dirname, '../power.example.json'), 'utf8'));

test('the PSU is the binding link (6.67A, below the 7.5A DIN-4 socket / breaker / wire and even all-four-max)', () => {
  const { binding } = budgetChain(power);
  assert.match(binding.name, /PSU/);
  assert.equal(binding.amps, power.psu.rated_amps);
});

test('raw ratio before margin: 6.67A / 11.4A -> 58%', () => {
  const { rawPct } = solveCapPercent(power);
  assert.equal(Math.floor(rawPct), 58);
});

test('solved cap applies margin on top of the raw ratio and stays in [0,100]', () => {
  const { pct, rawPct, margin } = solveCapPercent(power);
  assert.equal(pct, Math.floor(rawPct * margin));
  assert.ok(pct > 0 && pct <= 100);
});

test('a chain wider than all-four-max never overruns 100%', () => {
  const fat = {
    ...power,
    psu: { ...power.psu, rated_amps: 999 },
    protection_chain: { ...power.protection_chain, din4_socket_amps: 999 },
    margin: 1,
  };
  const { pct } = solveCapPercent(fat);
  assert.equal(pct, 100);
});

test('links are read from the chain as written, not hardcoded (commentary keys skipped)', () => {
  const { links } = budgetChain(power);
  assert.deepEqual(links.map(l => l.name).slice(1), ['din4 socket', 'breaker', 'ring wire', 'feed leg', 'connector']);
  const custom = { ...power, protection_chain: { _comment: 'ignored', inline_fuse_amps: 3 } };
  assert.deepEqual(budgetChain(custom).links.map(l => l.name).slice(1), ['inline fuse']);
  assert.equal(budgetChain(custom).binding.amps, 3);
});

test('binding link switches to the DIN-4 socket when the PSU is no longer weakest', () => {
  const bigPsu = { ...power, psu: { ...power.psu, rated_amps: 40 } };
  const { binding } = budgetChain(bigPsu);
  assert.match(binding.name, /din4 socket/);
  assert.equal(binding.amps, 7.5);
});

// --- Chunk 12: live power estimator ---
// Build a raw type-5 preview frame: 1-byte header + pixelCount x [r,g,b].
function frame(pixels) {
  return Buffer.concat([Buffer.from([5]), Buffer.from(pixels.flat())]);
}
const N = power.pixel_count;
const solid = (r, g, b) => frame(Array.from({ length: N }, () => [r, g, b]));

test('channelFullAmps: r/g/b/w sum to the measured all-four-max (README bench table cross-check)', () => {
  const { r, g, b, w } = channelFullAmps(power);
  assert.ok(Math.abs((r + g + b + w) - power.measured.all_four_max_amps) < 0.05);
  // the w channel alone should agree with the independently measured w-only figure to ~1%
  assert.ok(Math.abs(w - power.measured.w_only_white_amps) / power.measured.w_only_white_amps < 0.01);
});

test('an all-black frame estimates just the idle baseline', () => {
  assert.equal(estimateFrameAmps(solid(0, 0, 0), power), power.measured.idle_amps);
});

test('W-extraction: a full-white frame (r=g=b=255) estimates near w-only draw, NOT a naive 3x R+G+B sum', () => {
  const amps = estimateFrameAmps(solid(255, 255, 255), power);
  const naiveSum = power.measured.idle_amps + channelFullAmps(power).r + channelFullAmps(power).g + channelFullAmps(power).b;
  assert.ok(Math.abs(amps - (power.measured.idle_amps + power.measured.w_only_white_amps)) < 0.05);
  assert.ok(amps < naiveSum / 2, 'must not overestimate white as if R+G+B fired independently');
});

test('a full-red frame estimates the red channel alone (no W routed — min(r,g,b)=0)', () => {
  const amps = estimateFrameAmps(solid(255, 0, 0), power);
  assert.ok(Math.abs(amps - (power.measured.idle_amps + channelFullAmps(power).r)) < 1e-9);
});

test('brightnessFactor scales the non-idle contribution (frames are pre-brightness, verified live)', () => {
  const full = estimateFrameAmps(solid(255, 255, 255), power, 1);
  const half = estimateFrameAmps(solid(255, 255, 255), power, 0.5);
  assert.ok(Math.abs((half - power.measured.idle_amps) - (full - power.measured.idle_amps) / 2) < 1e-9);
});

test('estimateDraw reports peak/mean across frames and % of the binding link', () => {
  const frames = [solid(0, 0, 0), solid(255, 255, 255), solid(255, 0, 0)];
  const est = estimateDraw(frames, power);
  assert.ok(est.peakAmps > est.meanAmps);
  assert.ok(Math.abs(est.peakAmps - estimateFrameAmps(solid(255, 255, 255), power)) < 1e-9);
  const { binding } = budgetChain(power);
  assert.equal(est.bindingLink, binding.name);
  assert.ok(Math.abs(est.peakPctOfBudget - (est.peakAmps / binding.amps) * 100) < 1e-9);
});
