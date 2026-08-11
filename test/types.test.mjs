// Drift guard for lib/pixelblaze.d.mts.
//
// A hand-written .d.ts rots silently: add a method and the types simply don't
// mention it, and nothing complains. Worse, rename one and consumers get told a
// method exists that doesn't. This asserts the declared member set matches the
// real one, with no toolchain (zero deps is the point) — it checks the SHAPE of
// the surface, not the signatures. Signature accuracy is on the author.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Pixelblaze } from '../lib/pixelblaze.mjs';

const dts = readFileSync(path.join(import.meta.dirname, '../lib/pixelblaze.d.mts'), 'utf8');

// The class body, brace-matched from the declaration.
function classBody(src) {
  const start = src.indexOf('export declare class Pixelblaze {');
  assert.notEqual(start, -1, 'pixelblaze.d.mts must declare `export declare class Pixelblaze`');
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open + 1, i);
  }
  throw new Error('unbalanced braces in the Pixelblaze class declaration');
}

// Members declared at the class-body's own indent level. Nested object types
// inside a signature are indented further, so they don't match.
function declaredMembers(body) {
  const names = new Set();
  for (const line of body.split('\n')) {
    const m = /^ {2}(?:static\s+|readonly\s+)?([A-Za-z_$][\w$]*)\s*[(:<]/.exec(line);
    if (m) names.add(m[1]);
  }
  return names;
}

// Everything the class actually exposes, minus the _-prefixed internals.
function actualMembers() {
  const names = new Set(['constructor', 'host']); // host is assigned in the constructor, not on the prototype
  for (const k of Object.getOwnPropertyNames(Pixelblaze.prototype)) {
    if (!k.startsWith('_')) names.add(k);
  }
  for (const k of Object.getOwnPropertyNames(Pixelblaze)) {
    if (['length', 'name', 'prototype'].includes(k) || k.startsWith('_')) continue;
    names.add(k);
  }
  return names;
}

test('pixelblaze.d.mts declares every public member the class actually has', () => {
  const declared = declaredMembers(classBody(dts));
  const actual = actualMembers();

  const undeclared = [...actual].filter(n => !declared.has(n)).sort();
  assert.deepEqual(undeclared, [],
    `public members missing from pixelblaze.d.mts: ${undeclared.join(', ')}`);

  const phantom = [...declared].filter(n => !actual.has(n)).sort();
  assert.deepEqual(phantom, [],
    `pixelblaze.d.mts declares members the class does not have: ${phantom.join(', ')}`);
});

test('pixelblaze.d.mts does not leak the _-prefixed internals', () => {
  const declared = declaredMembers(classBody(dts));
  const leaked = [...declared].filter(n => n.startsWith('_'));
  assert.deepEqual(leaked, [], `internal members should not be declared: ${leaked.join(', ')}`);
});

test('the guard would actually catch a new method (self-check)', () => {
  // Guards that silently pass are worse than no guard. Prove the matcher works
  // on a body with a member the real class lacks.
  const fake = declaredMembers('  someNewMethod(a: string): Promise<void>;\n  readonly thing: number;\n');
  assert.ok(fake.has('someNewMethod'));
  assert.ok(fake.has('thing'));
  assert.ok(!actualMembers().has('someNewMethod'));
});
