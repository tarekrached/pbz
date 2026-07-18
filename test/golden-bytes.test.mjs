// Merge gate for the pbz.mjs -> lib/ refactor (PBZ-PLAN.md Chunk 1): the compile
// path must produce byte-for-byte identical output before and after moving code
// into lib/. Hermetic — runs offline against the vendored fixture
// tools/test/fixtures/ui-v3.67.html.gz (a real capture of the device's web UI,
// firmware v3.67), no LAN. Golden values in fixtures/golden.json were captured
// from the pre-refactor single-file CLI; see the capture harness this test's
// output was diffed against (not committed — a throwaway script run once,
// verbatim copy of the pre-refactor functions).
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { makeCompiler, makeLZ } from '../lib/compiler.mjs';
import { buildBytecode, buildPBP, stableId, prettyName } from '../lib/pbp.mjs';

const here = import.meta.dirname;
const golden = JSON.parse(await readFile(path.join(here, 'fixtures/golden.json'), 'utf8'));
const gz = await readFile(path.join(here, 'fixtures/ui-v3.67.html.gz'));
const html = zlib.gunzipSync(gz).toString('utf8').replace(/^﻿/, '');
const source = await readFile(path.join(here, '../../patterns/_fixture.js'), 'utf8');

test('compile + buildBytecode + buildPBP produce golden bytes (byte-for-byte)', () => {
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
