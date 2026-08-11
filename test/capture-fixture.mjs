#!/usr/bin/env node
// `npm run fixture` — capture this device's web UI into test/fixtures/ so the
// hermetic tests can run offline.
//
// The web UI is the device vendor's copyrighted application; pbz never
// redistributes it. At runtime it is fetched from the device you point pbz at,
// and for tests you capture your own copy here (gitignored). Without it, the
// tests that need the real compiler skip with a reason instead of failing.
//
// Usage: npm run fixture -- [--host=192.168.1.50]
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { Pixelblaze } from '../lib/pixelblaze.mjs';
import { resolveHost } from '../lib/config.mjs';

const flags = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith('--')).map(a => {
  const [k, v] = a.slice(2).split('='); return [k, v ?? true];
}));

const host = flags.host || process.env.PB_HOST || resolveHost();
if (!host) {
  console.error('error: no host — pass --host=IP, set $PB_HOST, or add pb.config.json {"host":"…"}');
  process.exit(1);
}

// One connection for the version read, then a plain HTTP GET for the payload —
// the device's ws server is small and easy to choke (see README "Device
// etiquette & recovery"), so this asks for exactly what it needs and closes.
const pb = new Pixelblaze(host);
let ver;
try {
  ver = (await pb.getConfig()).ver;
} finally {
  pb.close();
}
if (!ver) { console.error('error: device did not report a firmware version'); process.exit(1); }

const res = await fetch(`http://${host}/index.html.gz`);
if (!res.ok) { console.error(`error: GET /index.html.gz -> ${res.status}`); process.exit(1); }
const gz = Buffer.from(await res.arrayBuffer());

const out = path.join(import.meta.dirname, 'fixtures', `ui-${ver}.html.gz`);
writeFileSync(out, gz);
console.log(`captured ${gz.length} bytes -> test/fixtures/ui-${ver}.html.gz (firmware ${ver})`);
console.log('this file is gitignored on purpose — do not commit or redistribute it');
