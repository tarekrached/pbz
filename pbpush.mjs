#!/usr/bin/env node
/*
  pbpush — compile, run, save, and tune Pixelblaze patterns from the command line.

  No npm install (needs Node >=22 for global fetch/WebSocket + zlib.crc32; the one
  vendored file, lib/jpeg-encoder.cjs, is committed pure JS for the preview thumbnail).
  The pattern COMPILER and the LZString source-packer are Ben Hencke's own code,
  pulled live off the device's web UI (so they always match its firmware) and run
  headless in node:vm. No browser, no Python. This is the same approach the Python
  `pixelblaze-client` uses, ported to native JS.

  `save` also renders a preview thumbnail: it runs the pattern, collects the device's
  live preview frames, and encodes them as the JPEG "waterfall" (x = LEDs, y = render
  iterations) the firmware expects. Without a valid preview the web UI throws "trouble
  loading preview images" and drops to /?min.

  Commands (host comes from --host=…, $PB_HOST, or tools/pb.config.json):
    node tools/pbpush.mjs run     patterns/foo.js            compile + run live (NOT saved)
    node tools/pbpush.mjs save    patterns/foo.js [Name]     compile + save to device + activate
    node tools/pbpush.mjs compile patterns/foo.js            compile only (validate, show exports)
    node tools/pbpush.mjs set     sliderSpeed=0.4 toggleRhythmSync=1   set controls on the active pattern
    node tools/pbpush.mjs list                               list saved patterns (id + name)
    node tools/pbpush.mjs activate <Name or id>              switch the active pattern

  Notes:
    - `run` replaces the running program in place — great for fast iteration. It
      vanishes when you navigate the web UI or reboot; use `save` to persist.
    - `save` derives a STABLE pattern id from the file's basename, so re-saving the
      same file updates the same entry instead of piling up duplicates.
    - Control names are the exported UI-function names (sliderSpeed, toggleTagHandoff, …),
      slider values are 0..1 and toggles are 0/1.
*/

import zlib from 'node:zlib';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const encodeJPEG = createRequire(import.meta.url)('./lib/jpeg-encoder.cjs'); // vendored, pure-JS

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

// ---------- pull compiler + LZString out of the device web UI ----------
async function fetchWebUI(host) {
  const res = await fetch(`http://${host}/index.html.gz`);
  if (!res.ok) throw new Error(`GET /index.html.gz -> ${res.status}`);
  return zlib.gunzipSync(Buffer.from(await res.arrayBuffer())).toString('utf8').replace(/^﻿/, '');
}
function sub(text, startValue, endValue) {
  const start = text.indexOf(startValue);
  if (start < 0) throw new Error(`web UI marker not found: ${startValue}`);
  const finish = text.indexOf(endValue, start);
  if (finish < 0) throw new Error(`web UI end marker not found: ${endValue}`);
  return text.slice(start, finish);
}
// brace-match a `{...}` object literal starting at `openBraceIdx`, skipping string contents
function matchBraces(text, openBraceIdx) {
  let depth = 0, quote = null;
  for (let i = openBraceIdx; i < text.length; i++) {
    const ch = text[i];
    if (quote) { if (ch === '\\') { i++; continue; } if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i;
  }
  throw new Error('unbalanced braces while extracting from web UI');
}

// Build a compile(src)->{compiled,exports} function using the device's own compiler (v3.5+ web UI).
function makeCompiler(html) {
  const hardwareVariant = 'var ' + sub(html, 'hardwareVariant=', ',varWatcherPoller') + ';';
  const extendedOperators = sub(html, 'extendedOperators={', ',lastErrorMarkers=') + ';';
  const constants = 'var constants;' + sub(html, '"ESP8266"===hardwareVariant&&', ',[])') + ';';
  let compilerScript = '';
  { // the <script> block that defines window.compile
    let rest = html;
    while (rest.length) {
      const a = rest.indexOf('<script>'); if (a < 0) break;
      const after = rest.slice(a + 8); const b = after.indexOf('</script>');
      const s = b < 0 ? after : after.slice(0, b);
      if (s.includes('window.compile')) { compilerScript = s; break; }
      rest = b < 0 ? '' : after.slice(b + 9);
    }
    if (!compilerScript) throw new Error('compiler (window.compile) not found in web UI');
  }
  const ctx = vm.createContext({ window: {}, console });
  vm.runInContext(
    'var predefinedGlobals=["pixelCount"];\n' + hardwareVariant + '\n' + constants + '\n' +
    extendedOperators + '\n' + compilerScript + ';\n' +
    `function __compile(src){
       var p = window.compile(src, {predefinedGlobals:predefinedGlobals, extendedOperators:extendedOperators, constants:constants});
       function surface(l){ return Object.keys(l).reduce(function(r,k){return r.concat(l[k]);}, []); }
       return { compiled: p.compiled, exports: surface(p.exports).map(function(s){return {address:s.address,name:s.name};}) };
     }`, ctx, { filename: 'pb-compiler.js' });
  return (src) => {
    ctx.__src = src;
    try { return vm.runInContext('__compile(__src)', ctx); }
    catch (ex) {
      const where = ex.lineNumber != null ? ` at line ${ex.lineNumber} col ${ex.column}` : '';
      throw new Error(`Pixelblaze compile error: ${ex.description || ex.message}${where}`);
    }
  };
}

// Build lzCompress(str)->Uint8Array using the device's own LZString.compressToUint8Array.
function makeLZ(html) {
  const vAnchor = html.indexOf('var v=String.fromCharCode,');
  const start = html.lastIndexOf('function n(t,e){', vAnchor);
  const sObj = html.indexOf('s={', vAnchor);
  if (vAnchor < 0 || start < 0 || sObj < 0) throw new Error('LZString not found in web UI');
  const snippet = html.slice(start, matchBraces(html, sObj + 2) + 1) + ';';
  const ctx = vm.createContext({});
  vm.runInContext(snippet, ctx, { filename: 'lzstring.js' });
  vm.runInContext('globalThis.__lz = (x)=>Array.from(s.compressToUint8Array(x));', ctx);
  return (str) => Buffer.from(vm.runInContext('__lz', ctx)(str));
}

// ---------- bytecode + PBP serialization ----------
function buildBytecode({ compiled, exports }) {
  let exportSize = 0;
  for (const s of exports) exportSize += 4 + Buffer.byteLength(s.name, 'ascii') + 1;
  const dword = (v, signed = false) => {
    const b = Buffer.allocUnsafe(4);
    if (signed) b.writeInt32LE(v | 0, 0); else b.writeUInt32LE(v >>> 0, 0);
    return b;
  };
  const parts = [dword(4 * compiled.length), dword(exportSize)];
  for (const op of compiled) parts.push(dword(op, true));
  for (const s of exports) parts.push(dword(s.address), Buffer.concat([Buffer.from(s.name, 'ascii'), Buffer.from([0])]));
  return Buffer.concat(parts);
}
// Pixelblaze Binary Pattern: 36-byte header (9 LE u32) + name + jpeg + bytecode + lz(source)
function buildPBP(name, sourceCode, bytecode, lzCompress, previewJpeg = Buffer.alloc(0)) {
  const nameB = Buffer.from(name, 'utf8');
  const srcB = lzCompress(JSON.stringify({ main: sourceCode }));
  const header = Buffer.allocUnsafe(36);
  let nameOff = 36, jpegOff = nameOff + nameB.length, byteOff = jpegOff + previewJpeg.length, srcOff = byteOff + bytecode.length;
  const u = [2, nameOff, nameB.length, jpegOff, previewJpeg.length, byteOff, bytecode.length, srcOff, srcB.length];
  u.forEach((v, i) => header.writeUInt32LE(v >>> 0, i * 4));
  return Buffer.concat([header, nameB, previewJpeg, bytecode, srcB]);
}

const ID_CHARS = '23456789ABCDEFGHJKLMNPQRSTWXYZabcdefghijkmnopqrstuvwxyz';
function stableId(seed) { // deterministic 17-char id so re-saving a file updates in place
  const h = crypto.createHash('sha1').update(seed).digest();
  let out = '';
  for (let i = 0; i < 17; i++) out += ID_CHARS[h[i] % ID_CHARS.length];
  return out;
}
function prettyName(file) {
  return path.basename(file).replace(/\.js$/, '').replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// ---------- websocket ----------
function connect(host) {
  const ws = new WebSocket(`ws://${host}:81`);
  ws.binaryType = 'arraybuffer';
  const texts = [];
  const binaries = [];
  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') texts.push(ev.data);
    else binaries.push(Buffer.from(ev.data));
  };
  const opened = new Promise((res, rej) => { ws.onopen = res; ws.onerror = (e) => rej(new Error('websocket: ' + (e.message || 'connection failed'))); });
  const waitText = (prefix, ms = 3000) => new Promise((res) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const hit = texts.find(m => m.startsWith(prefix));
      if (hit) { clearInterval(iv); res(hit); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); res(null); }
    }, 10);
  });
  const waitBinary = (ms = 3000) => new Promise((res) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (binaries.length) { clearInterval(iv); res(binaries.shift()); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); res(null); }
    }, 10);
  });
  const json = (obj) => ws.send(JSON.stringify(obj));
  const sendBytecode = (blob, type = 3) => { // chunked binary frames: [type][flag] + <=1280 bytes
    const MAX = 1280;
    for (let i = 0; i < blob.length; i += MAX) {
      let flag = 0;
      if (i === 0) flag |= 1;                              // first
      flag |= (blob.length - i) <= MAX ? 4 : 2;            // last : middle
      ws.send(Buffer.concat([Buffer.from([type, flag]), blob.subarray(i, i + MAX)]));
    }
  };
  // Collect `need` live preview frames (binary type 5: 1-byte header + pixelCount×RGB).
  const collectFrames = async (need, ms = 6000) => {
    const start = binaries.length;
    json({ sendUpdates: true });
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const frames = binaries.slice(start).filter(b => b[0] === 5);
      if (frames.length >= need) { json({ sendUpdates: false }); return frames.slice(0, need); }
      await sleep(20);
    }
    json({ sendUpdates: false });
    return binaries.slice(start).filter(b => b[0] === 5);
  };
  return { ws, opened, waitText, waitBinary, json, sendBytecode, collectFrames, close: () => ws.close() };
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const makeWsId = () => Array.from({ length: 17 }, () => ID_CHARS[(Math.random() * ID_CHARS.length) | 0]).join('');

// ---------- high-level ops ----------
async function loadTooling(host) {
  const html = await fetchWebUI(host);
  return { compile: makeCompiler(html), lz: makeLZ(html) };
}
function compileFile(compile, source) {
  const program = compile(source);
  const bytecode = buildBytecode(program);
  return { program, bytecode };
}
async function runLive(host, bytecode) {
  const c = connect(host); await c.opened;
  const crc = zlib.crc32(bytecode) >>> 0;
  c.json({ pause: true, setCode: { size: bytecode.length, crc, name: '', id: makeWsId() } });
  await c.waitText('{"ack"');
  c.sendBytecode(bytecode, 3);
  await sleep(300);
  c.json({ setControls: {} });
  c.json({ pause: false });
  await c.waitText('{"ack"');
  await sleep(150); c.close();
}
// build the saved thumbnail: a JPEG "waterfall" — x = LEDs, y = successive render
// iterations (time). Firmware requires a valid JPEG here; an empty one makes the web UI
// throw "trouble loading preview images" and drop to /?min.
var PREVIEW_W = 170, PREVIEW_H = 150;
function buildPreviewJPEG(frames) {
  const H = Math.min(PREVIEW_H, frames.length);
  if (H === 0) return Buffer.alloc(0);
  const W = PREVIEW_W;
  const rgba = Buffer.alloc(W * H * 4);
  for (let r = 0; r < H; r++) {
    const px = frames[r].subarray(1);                      // drop the 1-byte type header
    for (let c = 0; c < W; c++) {
      const o = (r * W + c) * 4, s = c * 3;
      rgba[o] = px[s]; rgba[o + 1] = px[s + 1]; rgba[o + 2] = px[s + 2]; rgba[o + 3] = 255;
    }
  }
  return encodeJPEG({ data: rgba, width: W, height: H }, 82).data;
}
async function savePattern(host, name, source, bytecode, lz) {
  const id = stableId(path.basename(saveFileArg || name));
  const c = connect(host); await c.opened;
  // Run it live first so the device renders it, then grab preview frames for the thumbnail.
  const crc = zlib.crc32(bytecode) >>> 0;
  c.json({ pause: true, setCode: { size: bytecode.length, crc, name: '', id: makeWsId() } });
  await c.waitText('{"ack"');
  c.sendBytecode(bytecode, 3);
  await sleep(300);
  c.json({ setControls: {} });
  c.json({ pause: false });
  await c.waitText('{"ack"');
  await sleep(200);
  const frames = await c.collectFrames(PREVIEW_H);
  const jpeg = buildPreviewJPEG(frames);
  // Save the PBP (with preview) and activate it.
  const pbp = buildPBP(name, source, bytecode, lz, jpeg);
  c.sendBytecode(Buffer.concat([Buffer.from(id, 'ascii'), pbp]), 1); // putSourceCode
  await c.waitText('{"ack"');
  await sleep(200);
  c.json({ activeProgramId: id });                                   // activate it
  await c.waitText('{"activeProgram"');
  await sleep(150); c.close();
  return { id, frames: frames.length, previewBytes: jpeg.length };
}
async function listPatterns(host) {
  const c = connect(host); await c.opened;
  c.json({ listPrograms: true });
  // program list arrives as chunked binary (type 7); collect until a lone frame or timeout
  let buf = Buffer.alloc(0), frame;
  while ((frame = await c.waitBinary(1500))) buf = Buffer.concat([buf, frame.subarray(2)]);
  c.close();
  return buf.toString('utf8').split('\n').filter(Boolean).map(l => { const [id, ...n] = l.split('\t'); return { id, name: n.join('\t') }; });
}
async function setControls(host, controls) {
  const c = connect(host); await c.opened;
  c.json({ setControls: controls, save: false });
  await c.waitText('{"ack"');
  await sleep(120); c.close();
}
async function getState(host) {
  const c = connect(host); await c.opened;
  c.json({ getVars: true });
  c.json({ getConfig: true });
  const varsMsg = await c.waitText('{"vars"');
  const apMsg = await c.waitText('{"activeProgram"');
  c.close();
  const vars = varsMsg ? JSON.parse(varsMsg).vars : {};
  const ap = apMsg ? JSON.parse(apMsg).activeProgram : {};
  return { vars, name: ap.name, id: ap.activeProgramId, controls: ap.controls || {} };
}

// ---------- CLI ----------
let saveFileArg = null;
try {
  if (cmd === 'list') {
    const host = resolveHost();
    const rows = await listPatterns(host);
    for (const r of rows) console.log(`${r.id}  ${r.name}`);
    console.log(`(${rows.length} patterns on ${host})`);
  } else if (cmd === 'get') {
    const host = resolveHost();
    const st = await getState(host);
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
    await setControls(host, controls);
    console.log('set:', JSON.stringify(controls));
  } else if (cmd === 'activate') {
    const host = resolveHost();
    const target = pos[1]; if (!target) die('usage: activate <Name or id>');
    const rows = await listPatterns(host);
    const hit = rows.find(r => r.id === target) || rows.find(r => r.name.toLowerCase() === target.toLowerCase());
    if (!hit) die(`no pattern matching "${target}" (try: list)`);
    const c = connect(host); await c.opened; c.json({ activeProgramId: hit.id }); await c.waitText('{"activeProgram"'); await sleep(120); c.close();
    console.log(`activated: ${hit.name} (${hit.id})`);
  } else if (cmd === 'compile' || cmd === 'run' || cmd === 'save') {
    const file = pos[1]; if (!file) die(`usage: ${cmd} <pattern.js> ${cmd === 'save' ? '[Name]' : ''}`);
    saveFileArg = file;
    const host = resolveHost();
    const source = await readFile(file, 'utf8');
    process.stdout.write(`Fetching compiler from ${host} … `);
    const { compile, lz } = await loadTooling(host);
    console.log('ok');
    process.stdout.write('Compiling … ');
    const { program, bytecode } = compileFile(compile, source);
    console.log(`ok — ${program.compiled.length} opcodes, ${program.exports.length} exports, ${bytecode.length} bytes`);
    console.log('  controls: ' + program.exports.filter(e => /^(slider|toggle|hsvPicker|rgbPicker|showNumber)/.test(e.name)).map(e => e.name).join(', '));
    if (cmd === 'run') { process.stdout.write(`Running live on ${host} … `); await runLive(host, bytecode); console.log('ok (live, not saved).'); }
    if (cmd === 'save') {
      const name = pos[2] || prettyName(file);
      process.stdout.write(`Saving "${name}" to ${host} … `);
      const res = await savePattern(host, name, source, bytecode, lz);
      console.log(`ok — saved & activated (id ${res.id}; preview ${res.frames} frames, ${res.previewBytes} B).`);
    }
  } else {
    console.log('commands: run | save | compile | set | list | activate  (see header of this file)');
    process.exit(cmd ? 1 : 0);
  }
} catch (e) {
  die(e.message);
}
