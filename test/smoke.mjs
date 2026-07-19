#!/usr/bin/env node
// Read-only smoke sweep against the live device — run at the start of every
// session, catches connection/parse breakage instantly (~2s, no mutation).
// discover isn't included: it's a multi-second UDP listen, a poor fit for a
// fast sweep, and doesn't touch the target host at all.
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

process.stdout.write(`smoke: getVars … `);
const vars = await pb.getVars();
console.log(`ok (${Object.keys(vars).length} vars)`);

process.stdout.write(`smoke: config … `);
const cfg = await pb.getConfig();
console.log(`ok (colorOrder ${cfg.colorOrder}, pixelCount ${cfg.pixelCount})`);

process.stdout.write(`smoke: status … `);
const status = await pb.getStatus();
console.log(`ok (fps ${status.fps?.toFixed(1)}, mem ${status.mem})`);

process.stdout.write(`smoke: peers … `);
const peers = await pb.getPeers();
console.log(`ok (${peers.length} peers)`);

process.stdout.write(`smoke: info … `);
const info = await pb.getInfo();
console.log(`ok (v${info.ver}, fps ${info.fps?.toFixed(1)}, group ${info.groupRole})`);

process.stdout.write(`smoke: playlist … `);
const pl = await pb.getPlaylist();
console.log(`ok (${pl.items.length} items, position ${pl.position})`);

process.stdout.write(`smoke: map get … `);
const mapSource = await pb.getMap();
const coords = await pb.getMap({ coords: true });
console.log(`ok (${mapSource.length} chars source, ${coords.length} coords)`);

process.stdout.write(`smoke: ping … `);
const ms = await pb.ping();
console.log(`ok (${ms} ms)`);

console.log(`smoke sweep passed against ${host}`);
