// Hermetic guards for the .pbb format (PBZ-PLAN.md Chunk 14): parsing and
// assembly are pure text/JSON, no device needed — mirrors golden-bytes.test.mjs
// and map.test.mjs's "no LAN, fast, repeatable" approach for the fiddly bits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFileList, parseBackup, buildBackup, scanBackupFreshness, BACKUP_FRESHNESS_MS, defaultBackupName } from '../lib/backup.mjs';

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

// PBZ-PLAN.md Chunk 27 — scanBackupFreshness is pure (entries pre-collected by the
// caller, no fs here), so every case below is a plain now/maxAgeMs/entries table.
const NOW = Date.parse('2026-08-14T00:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

test('scanBackupFreshness: match within the window is fresh', () => {
  const entries = [{ path: 'wall-42-2026-08-10.pbb', mtimeMs: NOW - 2 * DAY }];
  const res = scanBackupFreshness(entries, 42, { now: NOW });
  assert.deepEqual(res, { fresh: true, file: 'wall-42-2026-08-10.pbb', ageMs: 2 * DAY });
});

test('scanBackupFreshness: match older than 7 days is stale', () => {
  const entries = [{ path: 'wall-42-2026-07-01.pbb', mtimeMs: NOW - 10 * DAY }];
  const res = scanBackupFreshness(entries, 42, { now: NOW });
  assert.equal(res.fresh, false);
  assert.equal(res.file, 'wall-42-2026-07-01.pbb');
  assert.equal(res.ageMs, 10 * DAY);
});

test('scanBackupFreshness: no candidates -> fresh:false, file:null, ageMs:null', () => {
  const res = scanBackupFreshness([], 42, { now: NOW });
  assert.deepEqual(res, { fresh: false, file: null, ageMs: null });
});

test('scanBackupFreshness: non-matching chipId is ignored', () => {
  const entries = [{ path: 'wall-99-2026-08-13.pbb', mtimeMs: NOW - DAY }];
  const res = scanBackupFreshness(entries, 42, { now: NOW });
  assert.deepEqual(res, { fresh: false, file: null, ageMs: null });
});

test('scanBackupFreshness: non-.pbb file with matching digits is ignored', () => {
  const entries = [{ path: 'wall-42-2026-08-13.pbb.bak', mtimeMs: NOW - DAY }];
  const res = scanBackupFreshness(entries, 42, { now: NOW });
  assert.deepEqual(res, { fresh: false, file: null, ageMs: null });
});

test('scanBackupFreshness: chipId matched on a digit boundary, not a substring', () => {
  const entries = [
    { path: 'wall-41235-2026-08-13.pbb', mtimeMs: NOW - DAY }, // 123 embedded in a longer run of digits
    { path: 'wall-1234-2026-08-13.pbb', mtimeMs: NOW - DAY },  // 123 as a prefix of a longer number
  ];
  assert.deepEqual(scanBackupFreshness(entries, 123, { now: NOW }), { fresh: false, file: null, ageMs: null });

  const clean = [{ path: 'wall-123-2026-08-13.pbb', mtimeMs: NOW - DAY }];
  const res = scanBackupFreshness(clean, 123, { now: NOW });
  assert.equal(res.file, 'wall-123-2026-08-13.pbb');
  assert.equal(res.fresh, true);
});

test('scanBackupFreshness: picks the newest mtimeMs, not the lexicographically last name', () => {
  const entries = [
    { path: 'wall-42-zzz.pbb', mtimeMs: NOW - 5 * DAY },
    { path: 'wall-42-aaa.pbb', mtimeMs: NOW - DAY }, // sorts first by name, newest by mtime
  ];
  const res = scanBackupFreshness(entries, 42, { now: NOW });
  assert.equal(res.file, 'wall-42-aaa.pbb');
  assert.equal(res.ageMs, DAY);
});

test('scanBackupFreshness: exactly maxAgeMs is fresh, one ms over is stale', () => {
  const atLimit = [{ path: 'wall-42-x.pbb', mtimeMs: NOW - BACKUP_FRESHNESS_MS }];
  assert.equal(scanBackupFreshness(atLimit, 42, { now: NOW }).fresh, true);

  const overLimit = [{ path: 'wall-42-x.pbb', mtimeMs: NOW - BACKUP_FRESHNESS_MS - 1 }];
  assert.equal(scanBackupFreshness(overLimit, 42, { now: NOW }).fresh, false);
});

test('scanBackupFreshness: custom now/maxAgeMs overrides are honored', () => {
  const entries = [{ path: 'wall-42-x.pbb', mtimeMs: 1000 }];
  assert.equal(scanBackupFreshness(entries, 42, { now: 1000 + 5000, maxAgeMs: 10000 }).fresh, true);
  assert.equal(scanBackupFreshness(entries, 42, { now: 1000 + 5000, maxAgeMs: 4000 }).fresh, false);
});

test('scanBackupFreshness: chipId digits in a parent DIRECTORY do not match (basename only)', () => {
  const entries = [{ path: '/backups/4735000123/old-wall-2026-01-01.pbb', mtimeMs: NOW - DAY }];
  assert.deepEqual(scanBackupFreshness(entries, 4735000123, { now: NOW }), { fresh: false, file: null, ageMs: null });
});

test('scanBackupFreshness: underscore is not a valid boundary ("wall_42-..." != chipId 42)', () => {
  const entries = [{ path: 'wall_42-2026-08-13.pbb', mtimeMs: NOW - DAY }];
  assert.deepEqual(scanBackupFreshness(entries, 42, { now: NOW }), { fresh: false, file: null, ageMs: null });
});

test('scanBackupFreshness: hand-named basenames "backup-<id>.pbb" and "foo-<id>-bar.pbb" do match', () => {
  const trailing = [{ path: 'backup-42.pbb', mtimeMs: NOW - DAY }];
  assert.equal(scanBackupFreshness(trailing, 42, { now: NOW }).file, 'backup-42.pbb');

  const middle = [{ path: 'foo-42-bar.pbb', mtimeMs: NOW - DAY }];
  assert.equal(scanBackupFreshness(middle, 42, { now: NOW }).file, 'foo-42-bar.pbb');
});

test('defaultBackupName output feeds straight into scanBackupFreshness as a fresh match', () => {
  const name = defaultBackupName('Wall Ring', 4735000123, NOW);
  assert.equal(name, 'Wall_Ring-4735000123-2026-08-14-000000Z.pbb');
  const entries = [{ path: name, mtimeMs: NOW }];
  const res = scanBackupFreshness(entries, 4735000123, { now: NOW });
  assert.equal(res.fresh, true);
  assert.equal(res.file, name);
});

test('defaultBackupName falls back to "unknown" when chipId is nullish', () => {
  assert.equal(defaultBackupName('wall', null, NOW), 'wall-unknown-2026-08-14-000000Z.pbb');
  assert.equal(defaultBackupName('wall', undefined, NOW), 'wall-unknown-2026-08-14-000000Z.pbb');
});
