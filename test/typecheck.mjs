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
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const projectDir = path.join(import.meta.dirname, 'types');

const HINT = `
typecheck needs a TypeScript compiler and Node's type definitions, neither of
which this project installs for you:

    npm i -g typescript && npm i --no-save @types/node

or run it against your own toolchain directly:

    tsc -p ${path.relative(process.cwd(), projectDir) || 'test/types'}

Skipping is fine — \`npm test\` still guards the declared member set, and
nothing here is needed to USE pbz.`;

function run(cmd, args) {
  return spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });
}

// Prefer a locally-installed tsc, fall back to one on PATH.
let res = run('npx', ['--no-install', 'tsc', '-p', projectDir]);
if (res.error || res.status === 127 || (res.status !== 0 && res.status !== 1 && res.status !== 2)) {
  res = run('tsc', ['-p', projectDir]);
}

if (res.error?.code === 'ENOENT' || res.status === 127) {
  console.error(HINT.trim());
  process.exit(0); // absent toolchain is not a failure
}

if (res.status !== 0) {
  console.error('\ntypecheck FAILED — lib/pixelblaze.d.mts disagrees with test/types/.');
  console.error('An error in negative.ts reading "Unused \'@ts-expect-error\' directive"');
  console.error('means a signature got LOOSER and that assertion no longer holds.');
  process.exit(1);
}

console.log('typecheck ok — declarations match test/types/consumer.ts, and every');
console.log('@ts-expect-error in test/types/negative.ts is still suppressing a real error.');
