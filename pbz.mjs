#!/usr/bin/env node
/*
  pbz — compile, run, save, and tune Pixelblaze patterns from the command line.

  No npm install (needs Node >=22 for global fetch/WebSocket + zlib.crc32; the one
  vendored file, lib/jpeg-encoder.cjs, is committed pure JS for the preview thumbnail).
  The pattern COMPILER and the LZString source-packer are Ben Hencke's own code,
  pulled live off the device's web UI (so they always match its firmware) and run
  headless in node:vm. No browser, no Python. This is the same approach the Python
  `pixelblaze-client` uses, ported to native JS.

  This file is CLI plumbing only (argv parsing, host resolution, dispatch, printing);
  the actual work happens in the `Pixelblaze` class (lib/pixelblaze.mjs), which you can
  also `import` directly as a library — see tools/README.md.

  `save` also renders a preview thumbnail: it runs the pattern, collects the device's
  live preview frames, and encodes them as the JPEG "waterfall" (x = LEDs, y = render
  iterations) the firmware expects. Without a valid preview the web UI throws "trouble
  loading preview images" and drops to /?min.

  Commands (host comes from --host=…, $PB_HOST, or tools/pb.config.json):
    node tools/pbz.mjs run     patterns/foo.js            compile + run live (NOT saved)
    node tools/pbz.mjs save    patterns/foo.js [Name]     compile + save to device + activate
    node tools/pbz.mjs compile patterns/foo.js            compile only (validate, show exports)
    node tools/pbz.mjs set     sliderSpeed=0.4 toggleRhythmSync=1   set controls on the active pattern
    node tools/pbz.mjs list                               list saved patterns (id + name)
    node tools/pbz.mjs activate <Name or id>              switch the active pattern
    node tools/pbz.mjs brightness <0..1> [--save]         set global brightness (ephemeral unless --save)
    node tools/pbz.mjs limit <0..100>                     set the firmware brightness CAP (persisted; the power-safety limit)

  Notes:
    - `run` replaces the running program in place — great for fast iteration. It
      vanishes when you navigate the web UI or reboot; use `save` to persist.
    - `save` derives a STABLE pattern id from the file's basename, so re-saving the
      same file updates the same entry instead of piling up duplicates.
    - Control names are the exported UI-function names (sliderSpeed, toggleTagHandoff, …),
      slider values are 0..1 and toggles are 0/1.
    - `limit` is the load-bearing power-safety cap (see ../CLAUDE.md) — it clamps hardware
      output regardless of pattern/slider. `brightness` is the ordinary dimmer.
*/

import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Pixelblaze } from './lib/pixelblaze.mjs';
import { stableId, prettyName } from './lib/pbp.mjs';

// ---------- args & host resolution ----------
const argv = process.argv.slice(2);
const flags = Object.fromEntries(argv.filter(a => a.startsWith('--')).map(a => {
  const [k, v] = a.slice(2).split('='); return [k, v ?? true];
}));
const pos = argv.filter(a => !a.startsWith('--'));
const cmd = pos[0];

function resolveHost() {
  if (flags.host) return flags.host;
  if (process.env.PB_HOST) return process.env.PB_HOST;
  const cfg = path.join(import.meta.dirname, 'pb.config.json');
  if (existsSync(cfg)) {
    const h = JSON.parse(readFileSync(cfg, 'utf8')).host;
    if (h) return h;
  }
  die('No host: pass --host=IP, set $PB_HOST, or add tools/pb.config.json {"host":"…"}');
}
function die(msg) { console.error('error: ' + msg); process.exit(1); }

// ---------- CLI ----------
try {
  if (cmd === 'list') {
    const host = resolveHost();
    const rows = await new Pixelblaze(host).list();
    for (const r of rows) console.log(`${r.id}  ${r.name}`);
    console.log(`(${rows.length} patterns on ${host})`);
  } else if (cmd === 'get') {
    const host = resolveHost();
    const st = await new Pixelblaze(host).getState();
    console.log(`active: ${st.name} (${st.id})`);
    console.log('vars (current values):');
    for (const [k, v] of Object.entries(st.vars)) console.log(`  ${k} = ${v}`);
    console.log('controls (slider/toggle positions):');
    for (const [k, v] of Object.entries(st.controls)) console.log(`  ${k} = ${v}`);
  } else if (cmd === 'set') {
    const host = resolveHost();
    const controls = {};
    for (const kv of pos.slice(1)) { const [k, v] = kv.split('='); controls[k] = Number(v); }
    if (!Object.keys(controls).length) die('usage: set name=value [name=value …]');
    await new Pixelblaze(host).setControls(controls);
    console.log('set:', JSON.stringify(controls));
  } else if (cmd === 'activate') {
    const host = resolveHost();
    const target = pos[1]; if (!target) die('usage: activate <Name or id>');
    const hit = await new Pixelblaze(host).activate(target);
    console.log(`activated: ${hit.name} (${hit.id})`);
  } else if (cmd === 'brightness') {
    const host = resolveHost();
    const v = Number(pos[1]); if (Number.isNaN(v)) die('usage: brightness <0..1> [--save]');
    const save = !!flags.save;
    const brightness = await new Pixelblaze(host).setBrightness(v, { save });
    console.log(`brightness: ${brightness}${save ? ' (saved)' : ' (live, not saved)'}`);
  } else if (cmd === 'limit') {
    const host = resolveHost();
    const pct = Number(pos[1]); if (Number.isNaN(pct)) die('usage: limit <0..100>');
    const maxBrightness = await new Pixelblaze(host).setMaxBrightness(pct);
    console.log(`brightness limit: ${maxBrightness}% (saved — this is the power-safety cap)`);
    if (maxBrightness === 100) console.log('warning: limit is 100% — the cap is not guarding anything at this setting.');
  } else if (cmd === 'compile' || cmd === 'run' || cmd === 'save') {
    const file = pos[1]; if (!file) die(`usage: ${cmd} <pattern.js> ${cmd === 'save' ? '[Name]' : ''}`);
    const host = resolveHost();
    const source = await readFile(file, 'utf8');
    const pb = new Pixelblaze(host);
    process.stdout.write(`Fetching compiler from ${host} … `);
    await pb.loadTooling();
    console.log('ok');
    process.stdout.write('Compiling … ');
    const { program, bytecode } = await pb.compile(source);
    console.log(`ok — ${program.compiled.length} opcodes, ${program.exports.length} exports, ${bytecode.length} bytes`);
    console.log('  controls: ' + program.exports.filter(e => /^(slider|toggle|hsvPicker|rgbPicker|showNumber)/.test(e.name)).map(e => e.name).join(', '));
    if (cmd === 'run') { process.stdout.write(`Running live on ${host} … `); await pb.run(source); console.log('ok (live, not saved).'); }
    if (cmd === 'save') {
      const name = pos[2] || prettyName(file);
      const id = stableId(path.basename(file));
      process.stdout.write(`Saving "${name}" to ${host} … `);
      const res = await pb.save(source, name, { id });
      console.log(`ok — saved & activated (id ${res.id}; preview ${res.frames} frames, ${res.previewBytes} B).`);
    }
  } else {
    console.log('commands: run | save | compile | set | list | activate | brightness | limit  (see header of this file)');
    process.exit(cmd ? 1 : 0);
  }
} catch (e) {
  die(e.message);
}
