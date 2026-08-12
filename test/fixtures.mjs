// Shared loader for the captured web UI, used by the hermetic tests.
//
// The web UI is Ben Hencke's copyrighted application, so it is NOT committed —
// `npm run fixture` pulls it off YOUR OWN device into this gitignored path.
// Tests that need it skip (with a reason) rather than fail when it's absent, so
// a fresh clone still runs the pure tests without a Pixelblaze on the LAN.
import zlib from 'node:zlib';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const dir = path.join(import.meta.dirname, 'fixtures');

// The firmware the golden bytecode/.pbp snapshots in golden.json were captured
// against. Compiler output legitimately differs between firmware versions (the
// compiler ships inside the web UI), so those snapshots only mean anything
// against this exact version — a fixture from any other one skips instead of
// producing a false failure.
export const PINNED_FIRMWARE = 'v3.67';

// The device reports `ver` WITHOUT a leading v ("3.67"), so a captured file is
// named ui-3.67.html.gz while the original hand-vendored one was ui-v3.67.html.gz.
// Compare on the normalized form or a capture from the correct firmware would
// still be treated as a mismatch and skip — which is exactly what happened.
export const normalizeVersion = (v) => String(v).replace(/^v/, '');

// Newest captured ui-<ver>.html.gz, or null if none has been captured yet.
export function loadWebUI() {
  let names;
  try { names = readdirSync(dir); } catch { return null; }
  const hits = names.filter(n => /^ui-.+\.html\.gz$/.test(n))
    .sort((a, b) => normalizeVersion(a).localeCompare(normalizeVersion(b), undefined, { numeric: true }));
  if (!hits.length) return null;
  const file = hits[hits.length - 1];
  const html = zlib.gunzipSync(readFileSync(path.join(dir, file))).toString('utf8').replace(/^﻿/, '');
  return { html, version: file.slice(3, -'.html.gz'.length), file };
}

export const CAPTURE_HINT =
  'no web UI fixture — run `npm run fixture` with a Pixelblaze on the LAN to capture one ' +
  '(it is not committed: the web UI is the device vendor\'s copyrighted code)';

export function readFixture(name) {
  return readFileSync(path.join(dir, name), 'utf8');
}
