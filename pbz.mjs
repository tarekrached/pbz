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
    node tools/pbz.mjs set     hsvPickerColor=0.33,1,1    picker controls take 3 comma-separated components, 0..1
    node tools/pbz.mjs setvars myVar=3 phase=0.25         set exported pattern variables (not UI controls) on the active pattern
    node tools/pbz.mjs seq off|shuffle|playlist           set the sequencer mode
    node tools/pbz.mjs seq pause|resume|next              pause/resume auto-advance, or jump to the next pattern now
    node tools/pbz.mjs seq time <seconds>                 set the shuffle/playlist advance interval
    node tools/pbz.mjs playlist                           show the shared playlist (position + items)
    node tools/pbz.mjs playlist set <Name or id>:<ms> […] replace the playlist's items
    node tools/pbz.mjs list                               list saved patterns (id + name)
    node tools/pbz.mjs activate <Name or id>              switch the active pattern
    node tools/pbz.mjs brightness <0..1> [--save]         set global brightness (ephemeral unless --save)
    node tools/pbz.mjs limit <0..100>                     set the firmware brightness CAP (persisted; the power-safety limit)
    node tools/pbz.mjs limit --for-budget [--set]         derive the cap from tools/power.json (dry-run by default; --set persists)
    node tools/pbz.mjs power budget                       print the PSU/breaker/wire/connector chain and which link binds
    node tools/pbz.mjs power                              estimate the ACTIVE pattern's real draw (peak/mean, W-extraction modeled)
    node tools/pbz.mjs power patterns/foo.js               same, for a candidate pattern (runs it live first, like `run`)
    node tools/pbz.mjs config [--check]                   print device/LED settings; --check asserts colorOrder=WRGB, pixelCount=170
    node tools/pbz.mjs set-config key=value […]           update device/LED settings (colorOrder, pixelCount, name, …)
    node tools/pbz.mjs delete <Name or id>                delete a saved pattern
    node tools/pbz.mjs export <Name or id> [file.epe]      fetch source + preview, write a .epe (defaults to "<Name>.epe")
    node tools/pbz.mjs import <file.epe>                  recompile a .epe's source locally and save + activate it
    node tools/pbz.mjs info                               firmware/hardware, FPS, memory, uptime, storage, group/peers
    node tools/pbz.mjs map get [--coords] > map.js        fetch the pixel-map source (or --coords for the normalized render coords)
    node tools/pbz.mjs map set map.js                     compute + push the live render geometry AND persist the source
    node tools/pbz.mjs reboot                             restart the device (drops off the network for several seconds)
    node tools/pbz.mjs ping                                round-trip latency to the device
    node tools/pbz.mjs discover [--ms=3000]                listen for Pixelblaze UDP beacons on the LAN, print host(s) found
    node tools/pbz.mjs backup [file.pbb]                  snapshot every device file (patterns, config, playlist, map) to one JSON .pbb
    node tools/pbz.mjs backup --fs-image [file.bin]       device-side full-flash image (POST /backupFsImage); restore by holding the button at power-up
    node tools/pbz.mjs restore <file.pbb> [--prune] --yes destructive: POST each file back + reboot; --prune also deletes device files absent from the backup

  Notes:
    - `run` replaces the running program in place — great for fast iteration. It
      vanishes when you navigate the web UI or reboot; use `save` to persist.
    - `save` derives a STABLE pattern id from the file's basename, so re-saving the
      same file updates the same entry instead of piling up duplicates.
    - Control names are the exported UI-function names (sliderSpeed, toggleTagHandoff, …),
      slider values are 0..1 and toggles are 0/1.
    - `setvars` pokes exported pattern *variables* directly (whatever the running pattern
      declares with `export var`) — distinct from `set`, which drives UI controls.
    - `seq`/`playlist` drive the device's single shared playlist (`_defaultplaylist_`); items
      are `<Name or id>:<ms>` — the same name/id resolution `activate`/`delete` use. `seq pause`/
      `resume` toggle `runSequencer` (the web UI's play/pause button) without leaving Playlist
      mode; `seq next` jumps immediately; `seq time <n>` sets `sequenceTimer` in SECONDS (not ms).
    - `limit` is the load-bearing power-safety cap (see ../CLAUDE.md) — it clamps hardware
      output regardless of pattern/slider. `brightness` is the ordinary dimmer.
    - `limit --for-budget` derives that cap from tools/power.json (PSU/breaker/wire/connector
      chain vs. measured all-four-max draw) instead of a hand-picked number — prints the
      derivation and which link binds; add --set to actually write it.
    - `power` (no arg / a candidate file) estimates REAL draw from sampled preview frames —
      advisory, not the safety backstop (that's `limit` + the physical fuse/breaker). Preview
      frames are pre-brightness and pre-W-extraction (verified live), so pbz applies the
      device's actual brightness x maxBrightness scale and models min(r,g,b) routing to the W
      element itself — a naive R+G+B sum on a white pixel would overestimate its draw ~3x.
      `save` prints the same peak estimate automatically using the thumbnail-capture frames.
    - `config --check` guards CLAUDE.md invariant #2 (WRGB color order) and the installed
      170-pixel ring — run it if the rig's behavior looks off before touching wiring.
    - `export`/`import` round-trip a pattern through a .epe file (same shape the web UI's
      Export button writes) — a backup/portability path independent of the device's flash.
    - The device can't evaluate the map JS itself (same reason it can't compile patterns) —
      `map set` computes the render geometry headless and pushes it live, THEN persists the
      source, so the Mapper tab and the actual rendering never drift apart. `map get --coords`
      shows the live normalized geometry (via the same compute path) — the way to check the
      device matches a committed map.js.
    - `reboot` is HTTP POST /reboot, not a websocket message (the Python client gets this
      wrong). `discover` doesn't need --host — it listens for LAN beacon broadcasts
      (requires discoveryEnable, on by default) instead of hardcoding an IP.
    - `backup` protects work the web UI never told this repo about (patterns authored
      straight in the browser). It's plain JSON, not a zip — GET /list, fetch every file
      except the `*.gz` web-app blobs, verify each byte size, base64 it. `restore` is
      overwrite-only unless you pass --prune (the web UI's own restore wipes first; this
      is gentler) and always reboots after — it's destructive enough to require --yes.
      WiFi config is never included in either direction.
*/

import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Pixelblaze } from './lib/pixelblaze.mjs';
import { stableId, prettyName } from './lib/pbp.mjs';
import { budgetChain, solveCapPercent, estimateDraw } from './lib/power.mjs';

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
function die(msg) { console.error('error: ' + msg); for (const pb of instances) pb.close(); process.exit(1); }
function loadPowerConfig() {
  const p = path.join(import.meta.dirname, 'power.json');
  if (!existsSync(p)) die('tools/power.json missing — needed for --for-budget / power budget');
  return JSON.parse(readFileSync(p, 'utf8'));
}
function printBudgetChain(links, binding) {
  for (const l of links) console.log(`  ${l === binding ? '>' : ' '} ${l.name}: ${l.amps} A`);
  console.log(`  binding link: ${binding.name} (${binding.amps} A)`);
}
// Preview frames are pre-brightness (verified live, Chunk 12) — the actual
// scale driven to the LEDs is the ordinary dimmer times the firmware cap.
async function effectiveBrightnessFactor(pb) {
  const cfg = await pb.getConfig();
  return cfg.brightness * (cfg.maxBrightness / 100);
}
function printPowerEstimate(est, power, label) {
  console.log(`estimated draw (${label}): peak ${est.peakAmps.toFixed(2)} A / ${est.peakWatts.toFixed(0)} W, mean ${est.meanAmps.toFixed(2)} A / ${est.meanWatts.toFixed(0)} W`);
  console.log(`  vs binding link (${est.bindingLink}, ${est.budgetAmps} A): peak ${est.peakPctOfBudget.toFixed(0)}%, mean ${est.meanPctOfBudget.toFixed(0)}%`);
  console.log('  (advisory — the brightness cap and physical fuse/breaker are the real safety backstop, not this estimate)');
}
function formatUptime(ms) {
  if (ms == null) return 'unknown';
  const h = Math.floor(ms / 3.6e6), m = Math.floor(ms / 6e4) % 60, s = Math.floor(ms / 1e3) % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
// Track every Pixelblaze instance the command creates so its (now shared,
// reused-across-calls — PBZ-PLAN.md Chunk 20) connection can be closed once
// the command is done; otherwise the open socket would keep the process alive.
const instances = [];
function mkPixelblaze(host) { const pb = new Pixelblaze(host); instances.push(pb); return pb; }
function parseConfigValue(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v !== '' && !Number.isNaN(Number(v))) return Number(v);
  return v;
}

// ---------- CLI ----------
try {
  if (cmd === 'list') {
    const host = resolveHost();
    const rows = await mkPixelblaze(host).list();
    for (const r of rows) console.log(`${r.id}  ${r.name}`);
    console.log(`(${rows.length} patterns on ${host})`);
  } else if (cmd === 'get') {
    const host = resolveHost();
    const st = await mkPixelblaze(host).getState();
    console.log(`active: ${st.name} (${st.id})`);
    console.log('vars (current values):');
    for (const [k, v] of Object.entries(st.vars)) console.log(`  ${k} = ${v}`);
    console.log('controls (slider/toggle positions):');
    for (const [k, v] of Object.entries(st.controls)) console.log(`  ${k} = ${v}`);
  } else if (cmd === 'set') {
    const host = resolveHost();
    const controls = {};
    for (const kv of pos.slice(1)) {
      const [k, v] = kv.split('=');
      if (/^(hsvPicker|rgbPicker)/.test(k)) {
        const parts = v.split(',').map(Number);
        if (parts.length !== 3 || parts.some(n => Number.isNaN(n) || n < 0 || n > 1)) {
          die(`usage: ${k}=h,s,v (or r,g,b) — exactly 3 components in 0..1 (got "${v}")`);
        }
        controls[k] = parts;
      } else {
        controls[k] = Number(v);
      }
    }
    if (!Object.keys(controls).length) die('usage: set name=value [name=value …]');
    await mkPixelblaze(host).setControls(controls);
    console.log('set:', JSON.stringify(controls));
  } else if (cmd === 'activate') {
    const host = resolveHost();
    const target = pos[1]; if (!target) die('usage: activate <Name or id>');
    const hit = await mkPixelblaze(host).activate(target);
    console.log(`activated: ${hit.name} (${hit.id})`);
  } else if (cmd === 'brightness') {
    const host = resolveHost();
    const v = Number(pos[1]); if (Number.isNaN(v)) die('usage: brightness <0..1> [--save]');
    const save = !!flags.save;
    const brightness = await mkPixelblaze(host).setBrightness(v, { save });
    console.log(`brightness: ${brightness}${save ? ' (saved)' : ' (live, not saved)'}`);
  } else if (cmd === 'limit') {
    if (flags['for-budget']) {
      const power = loadPowerConfig();
      const { pct, rawPct, links, binding, budgetAmps, allFourMaxAmps, margin } = solveCapPercent(power);
      console.log('protection chain:');
      printBudgetChain(links, binding);
      console.log(`raw: ${budgetAmps} A / ${allFourMaxAmps} A (all-four-max) = ${rawPct.toFixed(1)}%`);
      console.log(`cap (× ${margin} margin): ${pct}%`);
      if (flags.set) {
        const host = resolveHost();
        const maxBrightness = await mkPixelblaze(host).setMaxBrightness(pct);
        console.log(`brightness limit: ${maxBrightness}% (saved — for-budget derived, power-safety cap)`);
      } else {
        console.log('(dry run — pass --set to write this to the device)');
      }
    } else {
      const host = resolveHost();
      const pct = Number(pos[1]); if (Number.isNaN(pct)) die('usage: limit <0..100> | limit --for-budget [--set]');
      const maxBrightness = await mkPixelblaze(host).setMaxBrightness(pct);
      console.log(`brightness limit: ${maxBrightness}% (saved — this is the power-safety cap)`);
      if (maxBrightness === 100) console.log('warning: limit is 100% — the cap is not guarding anything at this setting.');
    }
  } else if (cmd === 'power') {
    const sub = pos[1];
    if (sub === 'budget') {
      const power = loadPowerConfig();
      const { pct, rawPct, links, binding, budgetAmps, allFourMaxAmps, margin } = solveCapPercent(power);
      console.log('protection chain:');
      printBudgetChain(links, binding);
      console.log(`measured all-four-max: ${allFourMaxAmps} A (${power.measured.all_four_max_watts} W)`);
      console.log(`measured W-only white: ${power.measured.w_only_white_amps} A (${power.measured.w_only_white_watts} W)`);
      console.log(`raw budget/all-four-max: ${rawPct.toFixed(1)}%  ->  cap × ${margin} margin: ${pct}%  (pbz limit --for-budget --set to apply)`);
    } else {
      const host = resolveHost();
      const power = loadPowerConfig();
      const pb = mkPixelblaze(host);
      if (sub) {
        // Candidate pattern: compile + run live (ephemeral, like `run`), then sample it.
        const source = await readFile(sub, 'utf8');
        process.stdout.write(`Compiling + running ${sub} live … `);
        await pb.run(source);
        console.log('ok (live, not saved).');
      }
      const factor = await effectiveBrightnessFactor(pb);
      process.stdout.write('Sampling preview frames … ');
      const frames = await pb.samplePreview(30);
      console.log(`ok (${frames.length}).`);
      printPowerEstimate(estimateDraw(frames, power, factor), power, sub ? `candidate ${sub}` : 'active pattern');
    }
  } else if (cmd === 'config') {
    const host = resolveHost();
    const cfg = await mkPixelblaze(host).getConfig();
    if (flags.check) {
      const problems = [];
      if (cfg.colorOrder !== 'WRGB') problems.push(`colorOrder is ${cfg.colorOrder}, expected WRGB`);
      if (cfg.pixelCount !== 170) problems.push(`pixelCount is ${cfg.pixelCount}, expected 170`);
      if (problems.length) { for (const p of problems) console.error('drift: ' + p); die('config --check failed'); }
      console.log('config check: ok (colorOrder=WRGB, pixelCount=170)');
    } else {
      for (const [k, v] of Object.entries(cfg)) console.log(`  ${k} = ${v}`);
    }
  } else if (cmd === 'seq') {
    const host = resolveHost();
    const sub = pos[1];
    const modes = { off: 0, shuffle: 1, playlist: 2 };
    if (sub === 'pause' || sub === 'resume') {
      await mkPixelblaze(host).setSequencerState(sub === 'resume');
      console.log(`sequencer: ${sub}d`);
    } else if (sub === 'next') {
      await mkPixelblaze(host).nextPattern();
      console.log('sequencer: advanced to next pattern');
    } else if (sub === 'time') {
      const n = Number(pos[2]);
      if (Number.isNaN(n) || n < 1) die('usage: seq time <seconds ≥ 1>');
      await mkPixelblaze(host).setConfig({ sequenceTimer: n });
      console.log(`sequencer interval: ${n}s`);
    } else if (modes[sub] !== undefined) {
      await mkPixelblaze(host).setSequencerMode(modes[sub]);
      console.log(`sequencer mode: ${sub} (${modes[sub]})`);
    } else {
      die('usage: seq off|shuffle|playlist|pause|resume|next|time <seconds>');
    }
  } else if (cmd === 'playlist') {
    const host = resolveHost();
    const pb = mkPixelblaze(host);
    if (pos[1] === 'set') {
      const tokens = pos.slice(2);
      if (!tokens.length) die('usage: playlist set <Name or id>:<ms> […]');
      const items = [];
      for (const tok of tokens) {
        const i = tok.lastIndexOf(':');
        if (i < 0) die(`usage: playlist set <Name or id>:<ms> […] (bad token "${tok}")`);
        const target = tok.slice(0, i), ms = Number(tok.slice(i + 1));
        if (Number.isNaN(ms)) die(`bad ms in "${tok}"`);
        const hit = await pb._resolveTarget(target);
        items.push({ id: hit.id, ms });
      }
      await pb.setPlaylist(items);
      console.log(`playlist set: ${items.length} items (saved)`);
    } else {
      const [{ items, position }, rows] = await Promise.all([pb.getPlaylist(), pb.list()]);
      const nameOf = (id) => rows.find(r => r.id === id)?.name || 'Unknown';
      items.forEach((it, i) => console.log(`${i === position ? '>' : ' '} ${nameOf(it.id)} (${it.id}) — ${it.ms} ms`));
      console.log(`(${items.length} items)`);
    }
  } else if (cmd === 'setvars') {
    const host = resolveHost();
    const vars = {};
    for (const kv of pos.slice(1)) { const [k, v] = kv.split('='); if (!k || v === undefined) die('usage: setvars name=value [name=value …]'); vars[k] = parseConfigValue(v); }
    if (!Object.keys(vars).length) die('usage: setvars name=value [name=value …]');
    await mkPixelblaze(host).setVars(vars);
    console.log('setvars:', JSON.stringify(vars));
  } else if (cmd === 'set-config') {
    const host = resolveHost();
    const updates = {};
    for (const kv of pos.slice(1)) {
      const [k, v] = kv.split('=');
      if (!k || v === undefined) die('usage: set-config key=value [key=value …]');
      updates[k] = parseConfigValue(v);
    }
    if (!Object.keys(updates).length) die('usage: set-config key=value [key=value …]');
    await mkPixelblaze(host).setConfig(updates);
    console.log('set-config:', JSON.stringify(updates));
  } else if (cmd === 'info') {
    const host = resolveHost();
    const info = await mkPixelblaze(host).getInfo();
    console.log(`firmware: v${info.ver} (${info.boardType}, chipId ${info.chipId})`);
    console.log(`fps: ${info.fps?.toFixed(2) ?? 'unknown'}`);
    console.log(`memory: ${info.mem ?? 'unknown'} free`);
    console.log(`uptime: ${formatUptime(info.uptime)}`);
    if (info.storageSize) console.log(`storage: ${info.storageUsed} / ${info.storageSize} bytes (${(100 * info.storageUsed / info.storageSize).toFixed(0)}%)`);
    const exp = [info.expansion.sensorBoard && 'SB 1.0', info.expansion.sixAxis && '6 Axis'].filter(Boolean);
    console.log(`expansion: ${exp.length ? exp.join(' + ') : 'none'}`);
    console.log(`group: ${info.groupRole} (node ${info.nodeId}${info.leaderId ? `, leader ${info.leaderId}` : ''})`);
    console.log(`peers: ${info.peers.length}`);
  } else if (cmd === 'map') {
    const host = resolveHost();
    const sub = pos[1];
    if (sub === 'get') {
      const pb = mkPixelblaze(host);
      if (flags.coords) {
        const coords = await pb.getMap({ coords: true });
        console.log(JSON.stringify(coords));
      } else {
        process.stdout.write(await pb.getMap());
      }
    } else if (sub === 'set') {
      const file = pos[2]; if (!file) die('usage: map set <file>');
      const text = await readFile(file, 'utf8');
      const res = await mkPixelblaze(host).setMap(text);
      console.log(`map set: ${res.pixelCount} pixels, ${res.dimensions}D (live geometry updated; source saved to Mapper tab)`);
    } else {
      die('usage: map get [--coords] | map set <file>');
    }
  } else if (cmd === 'reboot') {
    const host = resolveHost();
    await mkPixelblaze(host).reboot();
    console.log(`reboot: sent to ${host}`);
  } else if (cmd === 'ping') {
    const host = resolveHost();
    const ms = await mkPixelblaze(host).ping();
    console.log(`ping: ${ms} ms`);
  } else if (cmd === 'discover') {
    const ms = flags.ms ? Number(flags.ms) : 3000;
    console.log(`listening for beacons on UDP 1889 for ${ms} ms …`);
    const found = await Pixelblaze.discover(ms);
    for (const d of found) console.log(`  ${d.address}  chipId ${d.chipId}`);
    console.log(`(${found.length} device${found.length === 1 ? '' : 's'} found)`);
  } else if (cmd === 'backup') {
    const host = resolveHost();
    const pb = mkPixelblaze(host);
    if (flags['fs-image']) {
      const file = pos[1] || `${host}-fsimage-${new Date().toISOString().slice(0, 10)}.bin`;
      process.stdout.write(`Requesting device-side flash image (LEDs go dark while it writes) … `);
      const res = await pb.backupFsImage(file);
      console.log(`ok — ${res.bytes} bytes -> ${res.file} (restore by holding the button at power-up, not \`pbz restore\`)`);
    } else {
      process.stdout.write('Fetching file list … ');
      const res = await pb.saveBackup(pos[1]);
      console.log(`ok — ${res.count} files -> ${res.file}`);
    }
  } else if (cmd === 'restore') {
    const host = resolveHost();
    const file = pos[1]; if (!file) die('usage: restore <file.pbb> [--prune] --yes');
    if (!flags.yes) die('restore is destructive (overwrites device files + reboots) — pass --yes to confirm. WiFi config is never included in a backup.');
    const res = await mkPixelblaze(host).restoreBackup(file, { prune: !!flags.prune });
    console.log(`restored ${res.restored} files${res.pruned.length ? `, pruned ${res.pruned.length}` : ''} — rebooting`);
  } else if (cmd === 'delete') {
    const host = resolveHost();
    const target = pos[1]; if (!target) die('usage: delete <Name or id>');
    const hit = await mkPixelblaze(host).delete(target);
    console.log(`deleted: ${hit.name} (${hit.id})`);
  } else if (cmd === 'export') {
    const host = resolveHost();
    const target = pos[1]; if (!target) die('usage: export <Name or id> [file.epe]');
    const res = await mkPixelblaze(host).export(target, pos[2]);
    console.log(`exported: ${res.file}`);
  } else if (cmd === 'import') {
    const host = resolveHost();
    const file = pos[1]; if (!file) die('usage: import <file.epe>');
    const res = await mkPixelblaze(host).import(file);
    console.log(`imported: ${res.id} (saved & activated)`);
  } else if (cmd === 'compile' || cmd === 'run' || cmd === 'save') {
    const file = pos[1]; if (!file) die(`usage: ${cmd} <pattern.js> ${cmd === 'save' ? '[Name]' : ''}`);
    const host = resolveHost();
    const source = await readFile(file, 'utf8');
    const pb = mkPixelblaze(host);
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
      const powerPath = path.join(import.meta.dirname, 'power.json');
      if (existsSync(powerPath) && res.rawFrames.length) {
        const power = JSON.parse(readFileSync(powerPath, 'utf8'));
        const est = estimateDraw(res.rawFrames, power, await effectiveBrightnessFactor(pb));
        console.log(`  peak est. ${est.peakAmps.toFixed(1)} A / ${est.peakWatts.toFixed(0)} W = ${est.peakPctOfBudget.toFixed(0)}% of budget (${est.bindingLink}, ${est.budgetAmps} A)`);
      }
    }
  } else {
    console.log('commands: run | save | compile | set | setvars | seq | playlist | list | activate | brightness | limit | power | config | set-config | delete | export | import | info | map | reboot | ping | discover | backup | restore  (see header of this file)');
    process.exit(cmd ? 1 : 0);
  }
  // Each command's Pixelblaze instance(s) now share one reused connection
  // (PBZ-PLAN.md Chunk 20) instead of closing per method call — close it here
  // so the process exits promptly instead of hanging on an open socket.
  for (const pb of instances) pb.close();
} catch (e) {
  die(e.message);
}
