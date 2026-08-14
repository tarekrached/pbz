// Config-file lookup for the CLI and its scripts.
//
// NOT part of the library surface: the `Pixelblaze` class takes a host in its
// constructor and knows nothing about files or argv (house rule — host
// resolution belongs to the caller). This module exists only so the CLI and
// `npm run fixture` resolve config the same way.
//
// Lookup walks UP FROM THE CURRENT WORKING DIRECTORY first, then falls back to
// the directory pbz itself is installed in. That order is what lets a project
// keep its own pb.config.json / power.json and have a globally-installed pbz
// pick them up, instead of silently reading pbz's own shipped examples.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { storagePct } from './storage.mjs';

const toolDir = path.join(import.meta.dirname, '..');

export function findConfig(filename) {
  let dir = process.cwd();
  for (;;) {
    const p = path.join(dir, filename);
    if (existsSync(p)) return p;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  const fallback = path.join(toolDir, filename);
  return existsSync(fallback) ? fallback : null;
}

export function readConfig(filename) {
  const p = findConfig(filename);
  if (!p) return null;
  return { path: p, data: JSON.parse(readFileSync(p, 'utf8')) };
}

/**
 * --host / $PB_HOST are the caller's job; this is just the file half.
 */
export function resolveHost() {
  const cfg = readConfig('pb.config.json');
  return cfg?.data?.host ?? null;
}

/**
 * Throws if `expect.maxStoragePct` is present and not a positive number.
 * Exported so the CLI can call it BEFORE fetching status over the network —
 * a typo'd cap should surface as a config error, not a spurious "device
 * unreachable" from the status fetch it triggered. checkExpectations() below
 * calls it too, so there is exactly one place this rule lives.
 */
export function validateMaxStoragePct(expect) {
  if (!('maxStoragePct' in expect)) return;
  const cap = expect.maxStoragePct;
  // A bad cap here would otherwise never fire (NaN/undefined comparisons
  // are always false), silently passing "as expected" — loud beats quiet
  // for a value that gates cron/pre-flight exit codes.
  if (typeof cap !== 'number' || !Number.isFinite(cap) || cap <= 0) {
    throw new Error(`pb.config.json: expect.maxStoragePct must be a positive number, got ${JSON.stringify(cap)}`);
  }
}

/**
 * `config --check`'s comparison logic (Chunk 25), pure so it's testable
 * without a device: plain keys compare against getConfig()'s `cfg`;
 * `maxStoragePct` is special-cased against `status` (storageUsed/
 * storageSize live on the STATUS frame, not config) via storagePct().
 * `status` may be null/omitted when expect has no `maxStoragePct` — it's
 * never consulted in that case, so callers don't need to fetch it speculatively.
 * Returns an array of problem strings; empty means no drift.
 */
export function checkExpectations(cfg, status, expect) {
  const problems = Object.entries(expect)
    .filter(([k]) => k !== 'maxStoragePct')
    .filter(([k, want]) => cfg[k] !== want)
    .map(([k, want]) => `${k} is ${cfg[k]}, expected ${want}`);

  if ('maxStoragePct' in expect) {
    validateMaxStoragePct(expect);
    const cap = expect.maxStoragePct;
    // storagePct() floors to an integer, and that SAME integer is what's
    // compared and printed here — pct and cap can never disagree with the
    // message the way pct.toFixed(0) vs. a raw comparison used to (60.4%
    // used to fail against a cap of 60 while printing "60% used, expected
    // ≤60%").
    const pct = storagePct(status?.storageUsed, status?.storageSize);
    if (pct == null) {
      // Fail loud, not silently pass: an unverifiable cap is a check that
      // didn't run, not a check that succeeded (Chunk 24's philosophy).
      problems.push(`maxStoragePct is set (${cap}%) but storage usage could not be verified (status missing storageUsed/storageSize)`);
    } else if (pct > cap) {
      problems.push(`storage is ${pct}% used, expected ≤${cap}% (maxStoragePct)`);
    }
  }
  return problems;
}
