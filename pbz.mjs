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
  also `import` directly as a library — see README.md.

  `save` also renders a preview thumbnail: it runs the pattern, collects the device's
  live preview frames, and encodes them as the JPEG "waterfall" (x = LEDs, y = render
  iterations) the firmware expects. Without a valid preview the web UI throws "trouble
  loading preview images" and drops to /?min.

  Commands (host comes from --host=…, $PB_HOST, or pb.config.json):
    pbz run patterns/foo.js                  compile + run live (NOT saved)
    pbz save patterns/foo.js [Name]          compile + save to device + activate
    pbz compile patterns/foo.js              compile only (validate, show exports)
    pbz set sliderSpeed=0.4 toggleFoo=1      set controls on the active pattern
    pbz set hsvPickerColor=0.33,1,1          picker controls take 3 comma-separated components, 0..1
    pbz setvars myVar=3 phase=0.25           set exported pattern variables (not UI controls)
    pbz seq off|shuffle|playlist             set the sequencer mode
    pbz seq pause|resume|next                pause/resume auto-advance, or jump to the next pattern now
    pbz seq time <seconds>                   set the shuffle/playlist advance interval
    pbz playlist                             show the shared playlist (position + items)
    pbz playlist set <Name or id>:<ms> […]   replace the playlist's items
    pbz list                                 list saved patterns (id + name)
    pbz activate <Name or id>                switch the active pattern
    pbz brightness <0..1> [--save]           set global brightness (ephemeral unless --save)
    pbz limit <0..100>                       set the firmware brightness CAP (persisted; the power-safety limit)
    pbz limit --for-budget [--set]           derive the cap from power.json (dry-run by default; --set persists)
    pbz power budget                         print the supply/breaker/wire/connector chain and which link binds
    pbz power                                estimate the ACTIVE pattern's real draw (peak/mean, W-extraction modeled)
    pbz power patterns/foo.js                same, for a candidate pattern (runs it live first, like `run`)
    pbz config [--check]                     print device/LED settings; --check asserts pb.config.json's `expect` block (colorOrder, pixelCount, maxStoragePct, …)
    pbz set-config key=value […]             update device/LED settings (colorOrder, pixelCount, name, …)
    pbz delete <Name or id>                  delete a saved pattern
    pbz export <Name or id> [file.epe]       fetch source + preview, write a .epe (defaults to "<Name>.epe")
    pbz import <file.epe>                    recompile a .epe's source locally and save + activate it
    pbz info                                 firmware/hardware, FPS, memory, uptime, storage (warns ≥60%, CRITICAL ≥75%), group/peers
    pbz map get [--coords] > map.js          fetch the pixel-map source (or --coords for the normalized render coords)
    pbz map set map.js                       compute + push the live render geometry AND persist the source
    pbz reboot                               restart the device (drops off the network for several seconds)
    pbz ping                                 round-trip latency to the device
    pbz discover [--ms=3000]                 listen for Pixelblaze UDP beacons on the LAN, print host(s) found
    pbz backup [file.pbb]                    snapshot every device file (patterns, config, playlist, map) to one JSON .pbb; prints the storage line after
    pbz backup --fs-image [file.bin]         device-side full-flash image (POST /backupFsImage); restore by holding the button at power-up
    pbz restore <file.pbb> [--prune] --yes   destructive: POST each file back + reboot; --prune also deletes device files absent from the backup
    pbz defrag --yes                         destructive: fresh backup, health-check, delete every pattern + the playlist, restore, reboot, verify — an OTA deep clean for SPIFFS fragmentation
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
    - `limit` is the power-safety cap — it clamps hardware output regardless of what the
      pattern or the sliders ask for. `brightness` is the ordinary dimmer.
    - `limit --for-budget` derives that cap from power.json (PSU/breaker/wire/connector
      chain vs. measured all-four-max draw) instead of a hand-picked number — prints the
      derivation and which link binds; add --set to actually write it.
    - `power` (no arg / a candidate file) estimates REAL draw from sampled preview frames —
      advisory, not the safety backstop (that's `limit` + the physical fuse/breaker). Preview
      frames are pre-brightness and pre-W-extraction (verified live), so pbz applies the
      device's actual brightness x maxBrightness scale and models min(r,g,b) routing to the W
      element itself — a naive R+G+B sum on a white pixel would overestimate its draw ~3x.
      `save` prints the same peak estimate automatically using the thumbnail-capture frames.
    - `config --check` asserts the LED settings declared in pb.config.json's `expect` block
      (colorOrder, pixelCount, …) — run it if the rig's behavior looks off before touching wiring.
      `expect.maxStoragePct` asserts storage usage instead of a config key — the same 60%/75%
      warn/CRITICAL thresholds `info` prints, just enforced as a --check failure.
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
    - Small writes (`set`, `activate`, `set-config`, `delete`, `seq time`) are timed
      against a tiny per-host baseline in ~/.pbz/latency.json, warning on stderr past
      3x baseline or 2s (whichever is bigger) — the same SPIFFS-pressure signal as
      `info`'s storage line, just visible earlier.
    - Those same interactive write commands now fail after 8s against an unresponsive-
      but-connected board (was 3s) — deliberate, a late-stage disease signal, not a
      regression; `run`/`save`'s own internal acks keep the 3s default. Warnings name
      the underlying library operation, not the CLI verb: `set` -> setControls,
      `set-config`/`seq time` -> setConfig.
    - `defrag` is the remedy for SPIFFS fragmentation itself, not just its symptoms:
      the firmware has no GC/format endpoint, but GC runs as a side effect of writes
      and deletes give it something reclaimable, so backup -> delete -> restore gives
      GC a clean reclaim window on a still-healthy board. It NEVER touches `.gz` web-app
      files, `config*.json`, `pixelmap.*`, or `obconf.dat` — only `/p/*` (patterns) and
      `/l/*` (the playlist), and only paths already present in the fresh backup it just
      took and decode-verified. It refuses (without deleting anything) if a one-shot
      health-check write is already slow — a board that grinding may not survive the
      delete phase, and that's triage, not defrag. Side effect: it leaves the freshest
      possible `.pbb` on disk, which silences `restore --prune`'s freshness nudge for
      the next 7 days.
*/

import { readFile, readdir, stat } from 'node:fs/promises';
import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Pixelblaze } from './lib/pixelblaze.mjs';
import { stableId, prettyName } from './lib/pbp.mjs';
import { budgetChain, solveCapPercent, estimateDraw } from './lib/power.mjs';
import { readConfig, resolveHost as hostFromConfig, checkExpectations, validateMaxStoragePct, findConfig } from './lib/config.mjs';
import { storagePct, storageLevel } from './lib/storage.mjs';
import { scanBackupFreshness } from './lib/backup.mjs';
import { parseLatencyState, makeWatchdog, buildDefragHealthGate } from './lib/latency.mjs';

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
  const h = hostFromConfig();
  if (h) return h;
  die('No host: pass --host=IP, set $PB_HOST, or add pb.config.json {"host":"…"}');
}
// True while a progress line is open (written without a trailing newline).
// die() closes it first, or the error text glues onto "Saving \"X\" … " and the
// word "error:" ends up buried mid-line in a paragraph that wraps over several
// terminal rows. Observed while reading real failure output.
let progressOpen = false;
function progress(text) { process.stdout.write(text); progressOpen = !text.endsWith('\n'); }
function die(msg) {
  if (progressOpen) { process.stdout.write('\n'); progressOpen = false; }
  console.error('error: ' + msg);
  for (const pb of instances) pb.close();
  process.exit(1);
}
function loadPowerConfig() {
  const cfg = readConfig('power.json');
  if (!cfg) die('power.json not found (searched up from the current directory) — copy power.example.json to power.json and replace every number with your own install\'s. Someone else\'s power figures are worse than none: this derives a hardware brightness cap.');
  return cfg.data;
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
// Storage-pressure line (PBZ-PLAN.md Chunk 25) — shared by info/config
// --check/backup so the warning reads the same everywhere. pct is null-safe
// (storagePct already handles missing/zero size); print nothing when null,
// same as the old inline `if (info.storageSize)` guard.
function printStorageLine(used, size) {
  const pct = storagePct(used, size); // integer — see storagePct's comment
  if (pct == null) return;
  console.log(`storage: ${used} / ${size} bytes (${pct}%)`);
  const level = storageLevel(pct);
  if (level === 'warn') {
    console.log(`warning: storage at ${pct}% — free space before it climbs (pbz backup, delete unused patterns)`);
  } else if (level === 'critical') {
    console.log(`CRITICAL: storage at ${pct}% — a board in this project died at 74% used (SPIFFS with zero free blocks); back up now and free space`);
  }
}
// Write-latency watchdog (PBZ-PLAN.md Chunk 26) — per-host rolling baseline
// for small-write round-trip time, the same SPIFFS-pressure signal as
// info's storage line but visible earlier (the incident audit found
// anomalously slow small writes weeks before the board that died at 74%
// storage actually wedged). The scoring/warning logic itself lives in
// lib/latency.mjs's makeWatchdog (pure, testable); this file supplies only
// the filesystem half makeWatchdog is injected with.
const LATENCY_STATE_FILE = path.join(os.homedir(), '.pbz', 'latency.json');
// Missing/corrupt is a fresh start, never an error — parseLatencyState()
// already guarantees that; the try/catch here only covers the file not
// existing at all (readFileSync throwing ENOENT), which parseLatencyState
// never sees. Must never throw and never print — a first run is not a
// warning-worthy event.
function readLatencyState() {
  try {
    return parseLatencyState(readFileSync(LATENCY_STATE_FILE, 'utf8'));
  } catch {
    return { hosts: {} };
  }
}
// Concurrent `pbz` invocations racing on this file are last-writer-wins BY
// DESIGN: it's advisory telemetry (a rolling baseline), not a record anything
// downstream depends on being exact, so it doesn't earn a lock. Atomic
// (write a temp file, then rename over the target) so a concurrent reader
// never sees a torn write — a half-written JSON blob would otherwise wipe
// every host's baseline, not just the one being updated. MAY throw (a full
// disk, a permissions problem, …) — makeWatchdog is what catches that and
// turns it into one warning line; this function's job is only the write.
function writeLatencyState(state) {
  mkdirSync(path.dirname(LATENCY_STATE_FILE), { recursive: true });
  const tmp = `${LATENCY_STATE_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  try {
    renameSync(tmp, LATENCY_STATE_FILE);
  } catch (e) {
    // Don't leave latency.json.<pid>.tmp behind on a failed rename (a full
    // disk, a permissions problem crossing a mount, …) — best-effort, and
    // the rename's own error is what actually matters to the caller.
    try { unlinkSync(tmp); } catch { /* nothing more we can do here */ }
    throw e;
  }
}
// Track every Pixelblaze instance the command creates so its (now shared,
// reused-across-calls — PBZ-PLAN.md Chunk 20) connection can be closed once
// the command is done; otherwise the open socket would keep the process alive.
const instances = [];
function mkPixelblaze(host) {
  // Wired unconditionally (harmless for the many commands that never call a
  // watched method — the hook only fires from setConfig/delete/setControls/
  // activate) rather than per-command, so `seq time` (which goes through
  // setConfig under the hood) inherits coverage automatically instead of
  // needing its own CLI-side wiring to remember.
  const onWriteLatency = makeWatchdog({
    host,
    readState: readLatencyState,
    writeState: writeLatencyState,
    warn: (msg) => console.error(msg),
  });
  const pb = new Pixelblaze(host, { onWriteLatency });
  instances.push(pb);
  return pb;
}
// PBZ-PLAN.md Chunk 27: candidate .pbb files for the freshness nudge — cwd plus
// wherever pb.config.json actually lives, deduped. Missing/unreadable dirs and
// files that vanish mid-stat are skipped, never thrown — this is a nudge, not
// a gate, and shouldn't be able to abort a restore on its own.
async function listPbbEntries(dirs) {
  const seen = new Set();
  const entries = [];
  for (const d of dirs) {
    const resolved = path.resolve(d);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    let names;
    try { names = await readdir(resolved); } catch { continue; }
    for (const name of names) {
      if (!/\.pbb$/i.test(name)) continue;
      const p = path.join(resolved, name);
      try { entries.push({ path: p, mtimeMs: (await stat(p)).mtimeMs }); } catch { /* vanished mid-scan */ }
    }
  }
  return entries;
}
// Nudge, not gate: NEVER throws — prints at most one stderr line and always
// returns, even on a dead ws (restoreBackup is pure HTTP and "ws dead, HTTP
// alive" is the documented recovery scenario this command serves; a nudge
// that can abort the restore it's meant to protect would defeat the point).
async function nudgeIfBackupStale(pb, host) {
  try {
    const cfg = await pb.getConfig();
    if (cfg.chipId == null) return; // can't check freshness for a device we can't identify
    const dirs = [process.cwd()];
    const cfgPath = findConfig('pb.config.json');
    if (cfgPath) dirs.push(path.dirname(cfgPath));
    const entries = await listPbbEntries(dirs);
    const { fresh, file, ageMs } = scanBackupFreshness(entries, cfg.chipId);
    if (fresh) return;
    if (!file) {
      console.error(`warning: no local .pbb backup found for this device (chipId ${cfg.chipId}) — run \`pbz backup --host=${host}\` first`);
    } else {
      const days = Math.round(ageMs / 86400000);
      console.error(`warning: newest matching backup is ${days}d old (${file}) — run \`pbz backup --host=${host}\` first`);
    }
  } catch (e) {
    console.error(`warning: couldn't check backup freshness (${e.message}) — continuing`);
  }
}
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
        progress(`Compiling + running ${sub} live … `);
        await pb.run(source);
        console.log('ok (live, not saved).');
      }
      const factor = await effectiveBrightnessFactor(pb);
      progress('Sampling preview frames … ');
      const frames = await pb.samplePreview(30);
      console.log(`ok (${frames.length}).`);
      printPowerEstimate(estimateDraw(frames, power, factor), power, sub ? `candidate ${sub}` : 'active pattern');
    }
  } else if (cmd === 'config') {
    const host = resolveHost();
    const pb = mkPixelblaze(host);
    const cfg = await pb.getConfig();
    if (flags.check) {
      // What "correct" means is per-install, so it's declared in pb.config.json's
      // `expect` block rather than hardcoded here. Getting colorOrder or
      // pixelCount wrong makes patterns render subtly wrong for no visible
      // reason, so this is the cheap thing to run before suspecting wiring.
      const expect = readConfig('pb.config.json')?.data?.expect;
      if (!expect || !Object.keys(expect).length) {
        die('config --check needs an "expect" block in pb.config.json, e.g. {"expect": {"colorOrder": "WRGB", "pixelCount": 170}} — see pb.config.example.json');
      }
      // Validate the cap BEFORE spending a round-trip on it — a typo'd
      // maxStoragePct should read as a config error, not a spurious "device
      // unreachable" from the status fetch it triggered.
      validateMaxStoragePct(expect);
      // storageUsed/storageSize live on the STATUS frame, not config — only
      // pay for it when maxStoragePct is actually being asserted, and reuse
      // this same connection (pb, not a fresh mkPixelblaze()) to fetch it.
      const status = 'maxStoragePct' in expect ? await pb.getStatus() : null;
      if (status) printStorageLine(status.storageUsed, status.storageSize);
      const problems = checkExpectations(cfg, status, expect);
      if (problems.length) { for (const p of problems) console.error('drift: ' + p); die('config --check failed'); }
      const summary = Object.entries(expect).map(([k, v]) => k === 'maxStoragePct' ? `${k}≤${v}` : `${k}=${v}`).join(', ');
      console.log(`config check: ok (${summary})`);
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
      // sequenceTimer is a plain config key, so this goes through setConfig()
      // exactly like `set-config` does — and inherits its write-latency
      // watchdog coverage for free, since the watchdog hook lives on setConfig
      // itself (op-labeled 'setConfig' there), not on this CLI command.
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
    printStorageLine(info.storageUsed, info.storageSize);
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
      progress(`Requesting device-side flash image (LEDs go dark while it writes) … `);
      const res = await pb.backupFsImage(file);
      console.log(`ok — ${res.bytes} bytes -> ${res.file} (restore by holding the button at power-up, not \`pbz restore\`)`);
    } else {
      progress('Fetching file list … ');
      const res = await pb.saveBackup(pos[1]);
      console.log(`ok — ${res.count} files -> ${res.file}`);
      // The backup itself already succeeded — this is a bonus status read on
      // the moment someone's looking at device state, never a reason to fail
      // the command. "ws dead, HTTP alive" is a real recovery scenario
      // (README "Device etiquette & recovery"), so a status fetch that can't
      // complete here is expected, not exceptional.
      try {
        const status = await pb.getStatus();
        printStorageLine(status.storageUsed, status.storageSize);
      } catch (e) {
        console.error(`note: backup saved, but storage status could not be read (${e.message})`);
      }
    }
  } else if (cmd === 'restore') {
    const host = resolveHost();
    const file = pos[1]; if (!file) die('usage: restore <file.pbb> [--prune] --yes');
    const pb = mkPixelblaze(host);
    if (flags.prune) await nudgeIfBackupStale(pb, host);
    if (!flags.yes) die('restore is destructive (overwrites device files + reboots) — pass --yes to confirm. WiFi config is never included in a backup.');
    const res = await pb.restoreBackup(file, { prune: !!flags.prune });
    console.log(`restored ${res.restored} files${res.pruned.length ? `, pruned ${res.pruned.length}` : ''} — rebooting`);
  } else if (cmd === 'defrag') {
    // Checked before ANY I/O — not even host resolution (which can read
    // pb.config.json) — mirroring restore's --yes gate but earlier, since
    // this command's very first step is destructive-adjacent enough
    // (deleting every pattern) that it shouldn't get to prove a host even
    // resolves before confirming intent.
    if (!flags.yes) {
      die('defrag is destructive (deletes every pattern + the playlist, then restores from a fresh backup, then reboots) — pass --yes to confirm. A fresh, decode-verified .pbb is taken as the very first step regardless.');
    }
    const host = resolveHost();
    const pb = mkPixelblaze(host);
    console.log(`defrag: taking a fresh backup of ${host}, health-checking, then deep-cleaning …`);
    // buildDefragHealthGate(host, …) runs HERE, as part of building this
    // argument list — synchronously, before pb.defrag()'s own body (and its
    // health-check write, which updates this same host's stored baseline)
    // ever runs. That ordering is load-bearing: see the function's own
    // comment in lib/latency.mjs for the bug this fixes.
    const res = await pb.defrag(undefined, { healthGate: buildDefragHealthGate(host, { readState: readLatencyState }) });
    console.log(`backup verified: ${res.file} (${res.count} files)`);
    printStorageLine(res.before.storageUsed, res.before.storageSize);
    console.log(`deleted ${res.deleted} pattern/playlist file(s), kept ${res.kept} non-pattern file(s), restored ${res.restored} file(s) — inventory verified (${res.patterns.length} patterns)`);
    printStorageLine(res.after.storageUsed, res.after.storageSize);
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
    progress(`Fetching compiler from ${host} … `);
    await pb.loadTooling();
    console.log('ok');
    progress('Compiling … ');
    const { program, bytecode } = await pb.compile(source);
    console.log(`ok — ${program.compiled.length} opcodes, ${program.exports.length} exports, ${bytecode.length} bytes`);
    console.log('  controls: ' + program.exports.filter(e => /^(slider|toggle|hsvPicker|rgbPicker|showNumber)/.test(e.name)).map(e => e.name).join(', '));
    if (cmd === 'run') { progress(`Running live on ${host} … `); await pb.run(source); console.log('ok (live, not saved).'); }
    if (cmd === 'save') {
      const name = pos[2] || prettyName(file);
      const id = stableId(path.basename(file));
      progress(`Saving "${name}" to ${host} … `);
      const res = await pb.save(source, name, { id });
      console.log(`ok — saved & activated (id ${res.id}; preview ${res.frames} frames, ${res.previewBytes} B).`);
      const powerCfg = readConfig('power.json');
      if (powerCfg && res.rawFrames.length) {
        const est = estimateDraw(res.rawFrames, powerCfg.data, await effectiveBrightnessFactor(pb));
        console.log(`  peak est. ${est.peakAmps.toFixed(1)} A / ${est.peakWatts.toFixed(0)} W = ${est.peakPctOfBudget.toFixed(0)}% of budget (${est.bindingLink}, ${est.budgetAmps} A)`);
      }
    }
  } else {
    console.log('commands: run | save | compile | set | setvars | seq | playlist | list | activate | brightness | limit | power | config | set-config | delete | export | import | info | map | reboot | ping | discover | backup | restore | defrag  (see header of this file)');
    process.exit(cmd ? 1 : 0);
  }
  // Each command's Pixelblaze instance(s) now share one reused connection
  // (PBZ-PLAN.md Chunk 20) instead of closing per method call — close it here
  // so the process exits promptly instead of hanging on an open socket.
  for (const pb of instances) pb.close();
} catch (e) {
  die(e.message);
}
