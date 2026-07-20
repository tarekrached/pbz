// Hermetic guards for the .pbb format (PBZ-PLAN.md Chunk 14): parsing and
// assembly are pure text/JSON, no device needed — mirrors golden-bytes.test.mjs
// and map.test.mjs's "no LAN, fast, repeatable" approach for the fiddly bits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFileList, parseBackup, buildBackup } from '../lib/backup.mjs';

test('buildBackup -> parseBackup round-trips every file byte-for-byte', () => {
  const files = {
    'config.json': Buffer.from('{"a":1}'),
    '/p/abc123': Buffer.from([0, 1, 2, 254, 255]),
    'pixelmap.txt': Buffer.from('[[0,0],[1,0]]'),
  };
  const parsed = parseBackup(buildBackup(files));
  assert.deepEqual(Object.keys(parsed).sort(), Object.keys(files).sort());
  for (const [path, buf] of Object.entries(files)) {
    assert.equal(Buffer.compare(parsed[path], buf), 0, `${path} bytes mismatch`);
  }
});

test('parseBackup tolerates a leading BOM (the Python client writes utf-8-sig)', () => {
  const text = '﻿' + buildBackup({ 'a.txt': Buffer.from('hi') });
  assert.equal(parseBackup(text)['a.txt'].toString(), 'hi');
});

test('parseBackup rejects JSON missing a "files" key', () => {
  assert.throws(() => parseBackup('{"oops":true}'), /missing "files"/);
});

test('parseFileList: tab-separated "path<TAB>size", trailing blank line ignored', () => {
  const rows = parseFileList('config.json\t42\n/p/abc123\t1200\n\n');
  assert.deepEqual(rows, [{ path: 'config.json', size: 42 }, { path: '/p/abc123', size: 1200 }]);
});

test('parseFileList: does not itself filter .gz entries (caller\'s job, per saveBackup)', () => {
  const rows = parseFileList('index.html.gz\t9999\n');
  assert.deepEqual(rows, [{ path: 'index.html.gz', size: 9999 }]);
});
