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
