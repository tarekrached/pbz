// Pure .pbb parsing/assembly (PBZ-PLAN.md Chunk 14). Not a zip — a JSON text
// file, `{"files": {"<path>": "<base64>", …}}`, same shape the web UI's
// Settings->Backup assembles client-side. No device I/O here; see
// Pixelblaze#saveBackup/restoreBackup for the fetch/verify/POST side.

/**
 * GET /list's body: one "<path>\tsize" per line, trailing blank line.
 */
export function parseFileList(text) {
  return text.split('\n').filter(Boolean).map(line => {
    const i = line.lastIndexOf('\t');
    return { path: line.slice(0, i), size: Number(line.slice(i + 1)) };
  });
}

/**
 * Tolerates a leading BOM (the Python client decodes utf-8-sig, so one shows
 * up in the wild). Returns {path: Buffer}.
 */
export function parseBackup(text) {
  const obj = JSON.parse(text.replace(/^﻿/, ''));
  if (!obj.files) throw new Error('not a pbz backup: missing "files"');
  const files = {};
  for (const [path, b64] of Object.entries(obj.files)) files[path] = Buffer.from(b64, 'base64');
  return files;
}

/**
 * files: {path: Buffer}. No BOM on write — only tolerated on read.
 */
export function buildBackup(files) {
  const out = { files: {} };
  for (const [path, buf] of Object.entries(files)) out.files[path] = Buffer.from(buf).toString('base64');
  return JSON.stringify(out);
}

/** 7 days — PBZ-PLAN.md Chunk 27's freshness window. */
export const BACKUP_FRESHNESS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Chunk 28 (`defrag`)'s delete-set selector, over a backup's own key set
 * (see `Pixelblaze#defrag` — it classifies `Object.keys(files)` from the
 * fresh, decode-verified backup, never a fresh `/list`). Normalizes every
 * path to a leading slash first (a bare `p/<id>`, however it got there,
 * classifies the same as `/p/<id>`), then:
 *
 *   eligible = (starts with "/p/" or "/l/") AND NOT (case-insensitively ends ".gz")
 *
 * DEFAULT-DENY BY CONSTRUCTION, NOT BY BLOCKLIST. `config.json`/`config2.json`,
 * `pixelmap.txt`/`pixelmap.dat`, `obconf.dat`, the root `.gz` web-app blobs
 * (`index.html.gz`, `recovery.html.gz`), and any path this project has never
 * even observed are all protected for the same reason: none of them start
 * with `/p/` or `/l/`. There is no enumerated list of names to keep in sync
 * with firmware updates or a device this project has never seen — a future
 * file only becomes deletable by living under one of the two allow-prefixes,
 * never by someone forgetting to add it to an exclusion list. The `.gz`
 * exclusion is defense-in-depth on top of that: nothing in this project's own
 * naming convention puts a `.gz` file under `/p/` or `/l/`, but the web app
 * lives on the SAME filesystem as patterns, and losing it is the incident's
 * whole recovery-mode dance — worth guarding even against a hypothetical.
 *
 * Prefix matching is case-SENSITIVE (`/P/foo` is not `/p/foo`) — the firmware's
 * own paths are lowercase, so an uppercase collision is foreign by definition
 * and default-deny (kept) is the safe read of "unrecognized".
 *
 * Returns the NORMALIZED (leading-slash) form in both lists, not the raw
 * input — `defrag`'s delete loop needs a clean absolute path for `GET
 * /delete?path=…` regardless of how the backup happened to spell it.
 *
 * BELT-AND-BRACES beyond the prefix/`.gz` rule above, applied before either
 * is even checked: any path with leading/trailing whitespace, a doubled `//`
 * separator, or a `.`/`..` path segment is always `kept`, never `deletable`
 * — regardless of what prefix it appears to have. SPIFFS is a flat
 * filesystem, so these shapes almost certainly never occur as literal keys
 * in a real `/list` response or backup; this exists because the "default-
 * deny by construction" claim above is a promise about ANY input this
 * function is handed, not just the well-formed paths this project has
 * actually observed. A `/p/../config.json`-shaped key should read as
 * "reject, don't try to be clever about it" — not as an invitation to
 * resolve `..` and then re-decide.
 */
export function classifyForDefrag(paths) {
  const deletable = [];
  const kept = [];
  for (const raw of paths) {
    const p = raw.startsWith('/') ? raw : `/${raw}`;
    const eligible = isEligibleForDefrag(p);
    (eligible ? deletable : kept).push(p);
  }
  return { deletable, kept };
}

function isEligibleForDefrag(p) {
  if (p !== p.trim()) return false; // leading/trailing whitespace — refuse to interpret
  if (p.includes('//')) return false; // doubled separator
  if (p.split('/').some(seg => seg === '.' || seg === '..')) return false; // traversal-shaped segment
  return (p.startsWith('/p/') || p.startsWith('/l/')) && !/\.gz$/i.test(p);
}

/**
 * `saveBackup()`'s default filename (PBZ-PLAN.md Chunk 27): `<name>-<chipId>-
 * <date>-<time>Z.pbb`, e.g. `wall-42-2026-08-14-183012Z.pbb`. The stamp is
 * already UTC; the trailing `Z` just labels it so the filename is
 * self-describing without a lookup. Pure and clock-free (`date` is a Date or
 * ms, supplied by the caller) so it can be fed straight into
 * `scanBackupFreshness` in a test. `name` is sanitized the same way the old
 * inline version was; `chipId` falls back to `'unknown'`.
 */
export function defaultBackupName(name, chipId, date) {
  const safeName = (name || 'pixelblaze').replace(/[^\w.-]+/g, '_');
  const iso = new Date(date).toISOString();
  const stamp = `${iso.slice(0, 10)}-${iso.slice(11, 19).replace(/:/g, '')}Z`;
  return `${safeName}-${chipId ?? 'unknown'}-${stamp}.pbb`;
}

/**
 * Filename-only freshness scan (PBZ-PLAN.md Chunk 27): does the newest local
 * `.pbb` whose *name* carries this device's chipId look recent enough? Cheap
 * by design — no fetch, no parsing a candidate's contents, just the naming
 * convention `saveBackup()` writes (`<name>-<chipId>-<date>-<time>Z.pbb`). A
 * nudge this cheap can run before every destructive op without adding I/O
 * latency or false confidence from a backup that merely *claims* to match.
 *
 * Matches on the BASENAME only (a chipId digit sitting in a parent directory
 * must never count) and only at the convention's own delimiters — left
 * boundary start-of-name or `-`, right boundary `-` or the `.pbb` extension
 * — so `wall_42-...` (underscore, not hyphen) does not false-match chipId 42
 * the way a bare non-digit boundary would. (The trailing `Z` in the
 * timestamp sits between the time digits and `.pbb`, so it never touches the
 * chipId boundary logic above.)
 *
 * entries: [{path, mtimeMs}], pre-collected by the caller (no fs here).
 */
export function scanBackupFreshness(entries, chipId, { now = Date.now(), maxAgeMs = BACKUP_FRESHNESS_MS } = {}) {
  const escapedId = String(chipId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const idRe = new RegExp(`(^|-)${escapedId}(-|\\.pbb$)`, 'i');
  let best = null;
  for (const e of entries) {
    const base = e.path.split(/[\\/]/).pop();
    if (!/\.pbb$/i.test(base)) continue; // extension check stays separate: idRe's own ".pbb$" alternative only anchors the chipId, it does not require the file end in .pbb
    if (!idRe.test(base)) continue;
    if (!best || e.mtimeMs > best.mtimeMs) best = e;
  }
  if (!best) return { fresh: false, file: null, ageMs: null };
  const ageMs = now - best.mtimeMs;
  return { fresh: ageMs <= maxAgeMs, file: best.path, ageMs };
}
