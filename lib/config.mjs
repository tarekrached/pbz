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

// --host / $PB_HOST are the caller's job; this is just the file half.
export function resolveHost() {
  const cfg = readConfig('pb.config.json');
  return cfg?.data?.host ?? null;
}
