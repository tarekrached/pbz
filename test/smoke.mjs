#!/usr/bin/env node
// Read-only smoke sweep against the live device — run at the start of every
// session, catches connection/parse breakage instantly (~2s, no mutation).
// Only exercises commands that exist as of the current chunk; extend this
// list as later chunks land (config/info/ping are Chunks 4/7/9).
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Pixelblaze } from '../lib/pixelblaze.mjs';

function resolveHost() {
  if (process.env.PB_HOST) return process.env.PB_HOST;
  const cfg = path.join(import.meta.dirname, '../pb.config.json');
  if (existsSync(cfg)) {
    const h = JSON.parse(readFileSync(cfg, 'utf8')).host;
    if (h) return h;
  }
  throw new Error('No host: set $PB_HOST or tools/pb.config.json {"host":"…"}');
}

const host = resolveHost();
const pb = new Pixelblaze(host);

process.stdout.write(`smoke: list … `);
const rows = await pb.list();
console.log(`ok (${rows.length} patterns)`);

process.stdout.write(`smoke: get … `);
const st = await pb.getState();
console.log(`ok (active: ${st.name})`);

console.log(`smoke sweep passed against ${host}`);
