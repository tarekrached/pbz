#!/usr/bin/env node
// Push one pattern to several Pixelblazes at once.
//
// This is the part the CLI can't show you: `Pixelblaze` is an ordinary class you
// can import, and it compiles. Nothing here needs a browser, a Python runtime,
// or a Firestorm instance — each device hands over its own compiler, so each one
// gets bytecode built for the firmware it is actually running. Mixed firmware
// versions across the group are fine.
//
//   node examples/fan-out.mjs sweep.js "Sweep" 192.168.1.50 192.168.1.51
import { readFile } from 'node:fs/promises';
import { Pixelblaze } from '../lib/pixelblaze.mjs';

const [file, name, ...hosts] = process.argv.slice(2);
if (!file || !name || !hosts.length) {
  console.error('usage: node examples/fan-out.mjs <pattern.js> <Name> <host> [host …]');
  process.exit(1);
}

const source = await readFile(file, 'utf8');

// One Pixelblaze per host, and each one holds a single reused websocket for the
// whole exchange. That matters: these devices choke on connection churn, so the
// thing you must NOT do is loop a separate CLI invocation per device.
const results = await Promise.all(hosts.map(async (host) => {
  const pb = new Pixelblaze(host);
  try {
    const { id } = await pb.save(source, name);
    return { host, ok: true, id };
  } catch (err) {
    // `err.device` is what a fan-out actually needs: with N devices you cannot
    // read N error messages and work out which walls need attention. Its
    // ABSENCE means that device was never touched. See DeviceLeftState.
    return { host, ok: false, error: err.message, left: err.device?.state ?? null };
  } finally {
    pb.close();
  }
}));

for (const r of results) {
  console.log(r.ok ? `${r.host}  saved & activated (id ${r.id})` : `${r.host}  FAILED: ${r.error}`);
}

// The devices left mid-change, which is the list you act on. A frozen wall is
// the urgent one; `null` means that host was never touched at all.
const touched = results.filter(r => r.left);
if (touched.length) {
  console.log('\nleft mid-change:');
  for (const r of touched) console.log(`  ${r.host}  ${r.left}`);
  const frozen = touched.filter(r => r.left === 'maybe-paused').map(r => r.host);
  if (frozen.length) console.log(`  ^ possibly FROZEN (fps 0): ${frozen.join(', ')}`);
}
process.exit(results.every(r => r.ok) ? 0 : 1);
