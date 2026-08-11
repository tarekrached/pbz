// Merge gate for the pbz.mjs -> lib/ refactor (PBZ-PLAN.md Chunk 1): the compile
// path must produce byte-for-byte identical output before and after moving code
// into lib/. Hermetic — runs offline against a captured web UI (`npm run
// fixture`), no LAN. Golden values in fixtures/golden.json were captured from
// the pre-refactor single-file CLI; see the capture harness this test's output
// was diffed against (not committed — a throwaway script run once, verbatim
// copy of the pre-refactor functions).
//
// The compiler ships INSIDE the web UI, so its output is firmware-specific:
// these snapshots only mean anything against PINNED_FIRMWARE. A fixture from
// any other version skips rather than reporting a drift that isn't one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCompiler, makeLZ } from '../lib/compiler.mjs';
import { buildBytecode, buildPBP, stableId, prettyName } from '../lib/pbp.mjs';
import { loadWebUI, readFixture, PINNED_FIRMWARE, CAPTURE_HINT } from './fixtures.mjs';

const golden = JSON.parse(readFixture('golden.json'));
const source = readFixture('_fixture.js');
const ui = loadWebUI();
const skip = !ui ? CAPTURE_HINT
  : ui.version !== PINNED_FIRMWARE
    ? `golden bytes are pinned to firmware ${PINNED_FIRMWARE}; captured fixture is ${ui.version}`
    : false;
const html = ui?.html;

test('compile + buildBytecode + buildPBP produce golden bytes (byte-for-byte)', { skip }, () => {
  const compile = makeCompiler(html);
  const lz = makeLZ(html);
  const program = compile(source);
  // program.exports objects come from inside a vm.createContext() sandbox (a
  // different realm than golden.json's JSON.parse output), so deepEqual would
  // fail on prototype identity alone even with identical data — flatten first.
  assert.deepEqual(JSON.parse(JSON.stringify(program.exports)), golden.exports);

  const bytecode = buildBytecode(program);
  assert.equal(bytecode.toString('hex'), golden.bytecodeHex, 'bytecode drifted from golden snapshot');

  const name = prettyName('_fixture.js');
  assert.equal(name, golden.name);
  const pbp = buildPBP(name, source, bytecode, lz, Buffer.alloc(0));
  assert.equal(pbp.toString('hex'), golden.pbpHex, '.pbp wire format drifted from golden snapshot');
});

test('stableId is deterministic and never drifts (re-saves must update in place)', () => {
  assert.equal(stableId('_fixture.js'), golden.stableId_fixture);
  assert.equal(stableId('foo'), golden.stableId_foo);
});
