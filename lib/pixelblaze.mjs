// class Pixelblaze — the importable API. Headless, browser-free, Python-free:
// it compiles patterns using the device's own extracted compiler (see
// lib/compiler.mjs) and speaks its WebSocket protocol (lib/protocol.mjs)
// directly. Takes a host; knows nothing about argv, --flags, or env vars —
// that resolution lives in pbz.mjs. Throws on error; callers (the CLI) decide
// how to report it.
import zlib from 'node:zlib';
import { fetchWebUI, makeCompiler, makeLZ } from './compiler.mjs';
import { buildBytecode, buildPBP, stableId } from './pbp.mjs';
import { connect, sleep, makeWsId } from './protocol.mjs';
import { PREVIEW_H, buildPreviewJPEG } from './preview.mjs';

export class Pixelblaze {
  constructor(host) {
    if (!host) throw new Error('Pixelblaze: host required');
    this.host = host;
    this._tooling = null; // lazy+cached: {compile, lz}
  }

  // Fetch + build the compiler/LZString pair from this device's web UI, once.
  async loadTooling() {
    if (this._tooling) return this._tooling;
    const html = await fetchWebUI(this.host);
    this._tooling = { compile: makeCompiler(html), lz: makeLZ(html) };
    return this._tooling;
  }

  // Compile source locally (nothing sent to the device) -> {program, bytecode}.
  async compile(source) {
    const { compile } = await this.loadTooling();
    const program = compile(source);
    const bytecode = buildBytecode(program);
    return { program, bytecode };
  }

  // Compile + push live — replaces the running program instantly, NOT saved.
  async run(source) {
    const { program, bytecode } = await this.compile(source);
    const c = connect(this.host); await c.opened;
    const crc = zlib.crc32(bytecode) >>> 0;
    c.json({ pause: true, setCode: { size: bytecode.length, crc, name: '', id: makeWsId() } });
    await c.waitText('{"ack"');
    c.sendBytecode(bytecode, 3);
    await sleep(300);
    c.json({ setControls: {} });
    c.json({ pause: false });
    await c.waitText('{"ack"');
    await sleep(150); c.close();
    return { program, bytecode };
  }

  // Compile + save to the device's pattern list AND activate it. `opts.id`
  // should be a stableId() derived from the source's identity (e.g. the file
  // basename) so re-saving updates the same entry instead of piling up
  // duplicates; falls back to deriving one from `name` if omitted.
  async save(source, name, opts = {}) {
    const id = opts.id || stableId(name);
    const { lz } = await this.loadTooling();
    const { program, bytecode } = await this.compile(source);
    const c = connect(this.host); await c.opened;
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
    return { id, program, bytecode, frames: frames.length, previewBytes: jpeg.length };
  }

  // List saved patterns -> [{id, name}].
  async list() {
    const c = connect(this.host); await c.opened;
    c.json({ listPrograms: true });
    // program list arrives as chunked binary (type 7); collect until a lone frame or timeout
    let buf = Buffer.alloc(0), frame;
    while ((frame = await c.waitBinary(1500))) buf = Buffer.concat([buf, frame.subarray(2)]);
    c.close();
    return buf.toString('utf8').split('\n').filter(Boolean).map(l => { const [id, ...n] = l.split('\t'); return { id, name: n.join('\t') }; });
  }

  // Switch the active pattern. `target` may be an id or a name (case-insensitive).
  async activate(target) {
    const rows = await this.list();
    const hit = rows.find(r => r.id === target) || rows.find(r => r.name.toLowerCase() === target.toLowerCase());
    if (!hit) throw new Error(`no pattern matching "${target}" (try: list)`);
    const c = connect(this.host); await c.opened;
    c.json({ activeProgramId: hit.id });
    await c.waitText('{"activeProgram"');
    await sleep(120); c.close();
    return hit;
  }

  // Active pattern's current vars + controls.
  async getState() {
    const c = connect(this.host); await c.opened;
    c.json({ getVars: true });
    c.json({ getConfig: true });
    const varsMsg = await c.waitText('{"vars"');
    const apMsg = await c.waitText('{"activeProgram"');
    c.close();
    const vars = varsMsg ? JSON.parse(varsMsg).vars : {};
    const ap = apMsg ? JSON.parse(apMsg).activeProgram : {};
    return { vars, name: ap.name, id: ap.activeProgramId, controls: ap.controls || {} };
  }

  // Tune the active pattern's controls live (slider values 0..1, toggles 0/1).
  async setControls(controls) {
    const c = connect(this.host); await c.opened;
    c.json({ setControls: controls, save: false });
    await c.waitText('{"ack"');
    await sleep(120); c.close();
  }
}
