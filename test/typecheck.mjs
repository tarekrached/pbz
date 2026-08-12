#!/usr/bin/env node
// `npm run typecheck` — verify lib/pixelblaze.d.mts against test/types/.
//
// TypeScript is NOT a devDependency, deliberately. `npm install` in a fresh
// clone stays a no-op, which is the property this project trades on. You supply
// the compiler if you want to run this; everything else here works without it.
//
// `npm test` checks that the declarations cover the right member SET (see
// test/types.test.mjs). This checks that the SIGNATURES are right, in both
// directions: consumer.ts must compile, and every @ts-expect-error in
// negative.ts must still be suppressing a real error.
//
// Two things count as "no toolchain" rather than "your types are broken", and
// telling them apart is the whole job of this script. A missing compiler is the
// obvious one. The other is a compiler present but no @types/node: the
// declarations return Buffer, so the check cannot run without Node's types, and
// tsc's complaint there looks like a type error if you don't classify it.
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const projectDir = path.join(import.meta.dirname, 'types');
const rel = path.relative(process.cwd(), projectDir) || 'test/types';

const HINT = `
typecheck needs a TypeScript compiler AND Node's type definitions, neither of
which this project installs for you:

    npm i -g typescript && npm i --no-save @types/node

or run it against your own toolchain directly:

    tsc -p ${rel}

Skipping is fine — \`npm test\` still guards the declared member set, and
nothing here is needed to USE pbz.`;

// tsc emits these when @types/node is absent. They are a toolchain gap, not a
// disagreement between the declarations and the test files.
const MISSING_NODE_TYPES = /TS2688|Cannot find type definition file for 'node'|Entry point of type library 'node'/;

function run(cmd, args) {
  return spawnSync(cmd, args, { encoding: 'utf8' });
}

let res = run('npx', ['--no-install', 'tsc', '-p', projectDir]);
if (res.error || res.status === 127) res = run('tsc', ['-p', projectDir]);

const output = `${res.stdout || ''}${res.stderr || ''}`;

if (res.error?.code === 'ENOENT' || res.status === 127) {
  console.error(HINT.trim());
  process.exit(0); // absent toolchain is not a failure
}

if (MISSING_NODE_TYPES.test(output)) {
  console.error("tsc is installed but @types/node isn't, so the check can't run:");
  console.error(output.trim().split('\n').map(l => '  ' + l).join('\n'));
  console.error(HINT.trim());
  process.exit(0); // still a toolchain gap, not a type error
}

if (output.trim()) console.error(output.trimEnd());

if (res.status !== 0) {
  console.error('\ntypecheck FAILED — lib/pixelblaze.d.mts disagrees with test/types/.');
  console.error('An error in negative.ts reading "Unused \'@ts-expect-error\' directive"');
  console.error('means a signature got LOOSER and that assertion no longer holds.');
  process.exit(1);
}

console.log('typecheck ok — declarations match test/types/consumer.ts, and every');
console.log('@ts-expect-error in test/types/negative.ts is still suppressing a real error.');
