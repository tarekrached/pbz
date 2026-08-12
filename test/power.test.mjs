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

// --- validation guards (review findings 7 and 8) ---
// Every number here feeds a hardware brightness cap, so a bad one must stop the
// calculation. Unchecked, these produced a NaN cap sent to the device as
// {"maxBrightness":null}, or an Infinity one clamped to 100 (no cap at all)
// presented as "derived" with no warning.

test('a missing all_four_max_amps throws instead of deriving a NaN cap', () => {
  const bad = { ...power, measured: { ...power.measured, all_four_max_amps: undefined } };
  assert.throws(() => solveCapPercent(bad), /all_four_max_amps must be a positive number/);
});

test('all_four_max_amps of 0 throws instead of silently becoming a 100% no-op cap', () => {
  const bad = { ...power, measured: { ...power.measured, all_four_max_amps: 0 } };
  assert.throws(() => solveCapPercent(bad), /all_four_max_amps must be a positive number/);
});

test('a missing psu.rated_amps throws', () => {
  assert.throws(() => budgetChain({ ...power, psu: { model: 'x' } }), /psu\.rated_amps/);
});

test('a QUOTED chain value throws rather than silently deleting the link', () => {
  // The dangerous case: if the quoted link was the binding one, skipping it
  // raises the derived cap with nothing on screen to say so.
  const bad = { ...power, protection_chain: { ...power.protection_chain, din4_socket_amps: '7.5' } };
  assert.throws(() => budgetChain(bad), /din4_socket_amps must be a positive number/);
});

test('_-prefixed chain keys are still treated as commentary, not as bad values', () => {
  const ok = { ...power, protection_chain: { _note: 'free text', inline_fuse_amps: 3 } };
  assert.equal(budgetChain(ok).binding.amps, 3);
});

test('a negative margin throws', () => {
  assert.throws(() => solveCapPercent({ ...power, margin: -1 }), /margin must be a positive number/);
});

test('estimateDraw on zero sampled frames throws instead of reporting -Infinity', () => {
  assert.throws(() => estimateDraw([], power), /no preview frames were sampled/);
});

// --- plain RGB strips (post-publish item 6) ---
// power.example.json used to say "drop this block on a plain RGB strip", and
// doing so crashed with "Cannot read properties of undefined (reading 'r')".
// The documented action now works, and works CORRECTLY: an RGB strip has no
// white element, so the W-extraction model must not apply to it.

const rgbPower = (() => {
  const p = structuredClone(power);
  delete p.measured.channel_bench_w_per_100px.w; // what an RGB owner is told to do
  return p;
})();

test('omitting w yields a zero W coefficient (the RGB signal)', () => {
  assert.equal(channelFullAmps(rgbPower).w, 0);
  assert.ok(channelFullAmps(rgbPower).r > 0);
});

test('on RGB, a white frame costs ALL THREE channels, not a near-zero W channel', () => {
  const amps = estimateFrameAmps(solid(255, 255, 255), rgbPower);
  const { r, g, b } = channelFullAmps(rgbPower);
  const expected = rgbPower.measured.idle_amps + r + g + b;
  assert.ok(Math.abs(amps - expected) < 1e-9, `got ${amps}, expected ~${expected}`);
  // The failure this guards: applying W-extraction with a 0 A white channel
  // would route min(r,g,b) into nothing and estimate white at ~idle, i.e. a
  // 3x UNDERestimate, in the one direction that matters when sizing a supply.
  assert.ok(amps > rgbPower.measured.idle_amps * 10, 'white must not estimate as near-idle');
});

test('on RGB, a single-channel frame is unchanged (extraction never applied anyway)', () => {
  const amps = estimateFrameAmps(solid(255, 0, 0), rgbPower);
  assert.ok(Math.abs(amps - (rgbPower.measured.idle_amps + channelFullAmps(rgbPower).r)) < 1e-9);
});

test('RGBW still extracts: the same white frame costs far less than on RGB', () => {
  const rgbw = estimateFrameAmps(solid(255, 255, 255), power);
  const rgb = estimateFrameAmps(solid(255, 255, 255), rgbPower);
  assert.ok(rgbw < rgb / 2, 'RGBW white should route through the single W element');
});

test('deleting the whole bench block throws with an actionable message, not a TypeError', () => {
  const p = structuredClone(power);
  delete p.measured.channel_bench_w_per_100px;
  assert.throws(() => channelFullAmps(p), /channel_bench_w_per_100px is required/);
  assert.throws(() => channelFullAmps(p), /omit w/); // tells an RGB owner what to do instead
});

test('a missing supply_voltage_v or pixel_count throws instead of printing NaN', () => {
  assert.throws(() => channelFullAmps({ ...power, supply_voltage_v: undefined }), /supply_voltage_v/);
  assert.throws(() => channelFullAmps({ ...power, pixel_count: 0 }), /pixel_count/);
});
