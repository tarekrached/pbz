// Hermetic test for the power-budget solver (PBZ-PLAN.md Chunk 11) — pure
// arithmetic on power.json, no device, no LAN.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { budgetChain, solveCapPercent } from '../lib/power.mjs';

const here = import.meta.dirname;
const power = JSON.parse(await readFile(path.join(here, '../power.json'), 'utf8'));

test('the PSU is the binding link (9.17A, below breaker/wire/connector and even all-four-max)', () => {
  const { binding } = budgetChain(power);
  assert.match(binding.name, /PSU/);
  assert.equal(binding.amps, power.psu.rated_amps);
});

test('raw ratio before margin: 9.17A / 11.4A -> 80%', () => {
  const { rawPct } = solveCapPercent(power);
  assert.equal(Math.floor(rawPct), 80);
});

test('solved cap applies margin on top of the raw ratio and stays in [0,100]', () => {
  const { pct, rawPct, margin } = solveCapPercent(power);
  assert.equal(pct, Math.floor(rawPct * margin));
  assert.ok(pct > 0 && pct <= 100);
});

test('a wider PSU margin never overruns 100%', () => {
  const fat = { ...power, psu: { ...power.psu, rated_amps: 999 }, margin: 1 };
  const { pct } = solveCapPercent(fat);
  assert.equal(pct, 100);
});

test('binding link switches when the PSU is no longer weakest', () => {
  const bigPsu = { ...power, psu: { ...power.psu, rated_amps: 40 } };
  const { binding } = budgetChain(bigPsu);
  assert.equal(binding.name, 'breaker');
  assert.equal(binding.amps, 15);
});
