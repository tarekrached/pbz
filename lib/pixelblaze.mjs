// class Pixelblaze — the importable API. Headless, browser-free, Python-free:
// it compiles patterns using the device's own extracted compiler (see
// lib/compiler.mjs) and speaks its WebSocket protocol (lib/protocol.mjs)
// directly. Takes a host; knows nothing about argv, --flags, or env vars —
// that resolution lives in pbz.mjs. Throws on error; callers (the CLI) decide
// how to report it.
import zlib from 'node:zlib';
import { readFile, writeFile } from 'node:fs/promises';
import { fetchWebUI, makeCompiler, makeLZ, makeLZDecompress, makeNormalizeMap } from './compiler.mjs';
import { buildBytecode, buildPBP, stableId } from './pbp.mjs';
import { connect, sleep, makeWsId } from './protocol.mjs';
import { PREVIEW_H, buildPreviewJPEG } from './preview.mjs';
import { evalMapSource, buildPixelMapFrame } from './map.mjs';

export class Pixelblaze {
  constructor(host) {
    if (!host) throw new Error('Pixelblaze: host required');
    this.host = host;
    this._tooling = null; // lazy+cached: {compile, lz, lzDecompress, normalizeMap}
  }

  // Fetch + build the compiler/LZString/mapper trio from this device's web UI, once.
  async loadTooling() {
    if (this._tooling) return this._tooling;
    const html = await fetchWebUI(this.host);
    this._tooling = { compile: makeCompiler(html), lz: makeLZ(html), lzDecompress: makeLZDecompress(html), normalizeMap: makeNormalizeMap(html) };
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

  // Resolve `target` (an id or a name, case-insensitive) to a {id, name} row.
  async _resolveTarget(target) {
    const rows = await this.list();
    const hit = rows.find(r => r.id === target) || rows.find(r => r.name.toLowerCase() === target.toLowerCase());
    if (!hit) throw new Error(`no pattern matching "${target}" (try: list)`);
    return hit;
  }

  // Switch the active pattern. `target` may be an id or a name (case-insensitive).
  async activate(target) {
    const hit = await this._resolveTarget(target);
    const c = connect(this.host); await c.opened;
    c.json({ activeProgramId: hit.id });
    await c.waitText('{"activeProgram"');
    await sleep(120); c.close();
    return hit;
  }

  // Delete a saved pattern. Fire-and-forget (no ack — matches the web UI's own handler).
  async delete(target) {
    const hit = await this._resolveTarget(target);
    const c = connect(this.host); await c.opened;
    c.json({ deleteProgram: hit.id });
    await sleep(150); c.close();
    return hit;
  }

  // Fetch a saved pattern's source -> {main: "<source>", blockly?: ...}. Binary
  // SOURCESDATA frames (type 6), LZString-compressed JSON — the same two-step
  // fetch the web UI's Export button makes.
  async getSources(id) {
    const { lzDecompress } = await this.loadTooling();
    const c = connect(this.host); await c.opened;
    c.json({ getSources: id });
    let buf = Buffer.alloc(0), frame;
    while ((frame = await c.waitBinary(1500))) buf = Buffer.concat([buf, frame.subarray(2)]);
    c.close();
    return JSON.parse(lzDecompress(buf));
  }

  // Fetch a saved pattern's thumbnail jpeg. Binary THUMBNAILJPG frames (type 4):
  // 2-byte frame header + 17-byte id + jpeg chunk.
  async getPreviewImg(id) {
    const c = connect(this.host); await c.opened;
    c.json({ getPreviewImg: id });
    let buf = Buffer.alloc(0), frame;
    while ((frame = await c.waitBinary(1500))) buf = Buffer.concat([buf, frame.subarray(19)]);
    c.close();
    return buf;
  }

  // Export a saved pattern to a .epe file: {name, id, sources, preview(base64)} —
  // byte-for-byte the same shape the web UI's Export/Download button writes.
  async export(target, file) {
    const hit = await this._resolveTarget(target);
    const [sources, jpeg] = await Promise.all([this.getSources(hit.id), this.getPreviewImg(hit.id)]);
    const epe = { name: hit.name, id: hit.id, sources, preview: jpeg.toString('base64') };
    const outFile = file || `${hit.name}.epe`;
    await writeFile(outFile, JSON.stringify(epe, null, 2));
    return { file: outFile, epe };
  }

  // Import a .epe file: recompile its source locally (our compiler, so it always
  // matches firmware) and save it, reusing the original id so it lands back in
  // the same slot rather than piling up a duplicate.
  async import(file) {
    const epe = JSON.parse(await readFile(file, 'utf8'));
    const source = epe.sources?.main;
    if (!source) throw new Error(`${file}: missing sources.main`);
    return this.save(source, epe.name, { id: epe.id });
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

  // Active pattern's exported `export var` values (distinct from setControls,
  // which drives UI sliders/toggles — this pokes the underlying pattern
  // variables directly). Wire field name intact (read-method layering).
  async getVars() {
    const c = connect(this.host); await c.opened;
    c.json({ getVars: true });
    const msg = await c.waitText('{"vars"');
    c.close();
    if (!msg) throw new Error('getVars: no response from device');
    return JSON.parse(msg).vars;
  }

  // Set one or more exported pattern variables live. No ack for this message
  // (matches the web UI's own client); fires and settles.
  async setVars(obj) {
    const c = connect(this.host); await c.opened;
    c.json({ setVars: obj });
    await sleep(120); c.close();
    return obj;
  }

  // Tune the active pattern's controls live (slider values 0..1, toggles 0/1).
  async setControls(controls) {
    const c = connect(this.host); await c.opened;
    c.json({ setControls: controls, save: false });
    await c.waitText('{"ack"');
    await sleep(120); c.close();
  }

  // Global brightness (0..1, firmware step .005). Ephemeral unless opts.save —
  // matches the web UI slider, which only persists on release. No ack is sent
  // for this message (confirmed against the web UI's own client), so this
  // just fires and settles.
  async setBrightness(value, opts = {}) {
    const brightness = Math.max(0, Math.min(1, value));
    const c = connect(this.host); await c.opened;
    c.json({ brightness, save: !!opts.save });
    await sleep(120); c.close();
    return brightness;
  }

  // Firmware brightness ceiling, 0..100 (percent, not 0..1 — key is
  // maxBrightness). Always persisted: this is the power-safety cap
  // (CLAUDE.md invariant #3) — it clamps hardware output regardless of
  // pattern/slider, the actual guard against the ~273W all-four ceiling.
  async setMaxBrightness(pct) {
    const maxBrightness = Math.max(0, Math.min(100, pct));
    const c = connect(this.host); await c.opened;
    c.json({ maxBrightness, save: true });
    await sleep(120); c.close();
    return maxBrightness;
  }

  // Device + LED settings (name, pixelCount, colorOrder, ledType, dataSpeed,
  // cpuSpeed, sequenceTimer, autoOff*, timezone, discoveryEnable, …), plus
  // brightness/maxBrightness. The response has no wrapper key — it's a flat
  // settings object; '{"name"' is its distinctive lead field (device name is
  // always first), used the same way other messages are matched by prefix.
  async getConfig() {
    const c = connect(this.host); await c.opened;
    c.json({ getConfig: true });
    const msg = await c.waitText('{"name"');
    c.close();
    if (!msg) throw new Error('getConfig: no response from device');
    return JSON.parse(msg);
  }

  // Update device/LED settings. Unlike brightness/maxBrightness, plain
  // config fields persist immediately on receipt — no `save` flag (confirmed
  // against the web UI's own settings-panel handlers, none of which send
  // one, and against the live device: a field set without `save` survives a
  // fresh getConfig read).
  async setConfig(obj) {
    const c = connect(this.host); await c.opened;
    c.json(obj);
    await sleep(150); c.close();
    return obj;
  }

  // Live status frame: fps, mem, uptime, storage, vm error state — every
  // connection receives it unsolicited ~1/s (no request needed, confirmed
  // live). Wire field names intact (read-method layering house rule).
  async getStatus() {
    const c = connect(this.host); await c.opened;
    const msg = await c.waitText('{"fps"');
    c.close();
    if (!msg) throw new Error('getStatus: no status frame received from device');
    return JSON.parse(msg);
  }

  // Sync-group peers (wire field names intact).
  async getPeers() {
    const c = connect(this.host); await c.opened;
    c.json({ getPeers: 1 });
    const msg = await c.waitText('{"peers"');
    c.close();
    if (!msg) throw new Error('getPeers: no response from device');
    return JSON.parse(msg).peers;
  }

  // Status-popup contents, built on getConfig + getStatus + getPeers (never
  // parses their frames inline — read-method layering house rule). Pass-
  // through fields keep wire names (ver, uptime, storageUsed, …); only fields
  // that bake in a decode get added: `expansion` from the `exp` bitmask
  // (verified in the web UI's own status-popup handler: bit1 = Sensor Board
  // 1.0, bit2 = 6-axis) and computed `groupRole` (Leader if peers report
  // following us, Follower if we have a leaderId, else Solo — this rig is
  // always Solo, CLAUDE.md invariant #5, single controller by design).
  // Cosmetic labeling (ver -> "firmware version", uptime -> H:MM:SS, …) is
  // the CLI's job, not this method's.
  async getInfo() {
    const [cfg, status, peers] = await Promise.all([this.getConfig(), this.getStatus(), this.getPeers()]);
    const followers = peers.filter(p => p.isFollowing);
    return {
      ...cfg, ...status,
      expansion: { sensorBoard: !!(cfg.exp & 1), sixAxis: !!(cfg.exp & 2) },
      groupRole: followers.length ? 'Leader' : (cfg.leaderId ? 'Follower' : 'Solo'),
      peers,
    };
  }

  // Pixel-map source text (HTTP GET) — the human-readable, committable form,
  // returned as-is (read-method layering house rule: no interpretation here).
  // `opts.coords`: also compute the normalized `[[x,y],…]` render coordinates
  // — the SAME headless evaluate-then-normalize path setMap() uses to build
  // the wire frame, via getConfig() for pixelCount/mapperFit (a composite
  // built on accessors, not a second wire shape folded in here). This is the
  // only way to answer "does the device's live geometry match this source?"
  // — the device can't eval the map JS itself (same reason it can't compile
  // patterns; see lib/compiler.mjs).
  async getMap(opts = {}) {
    const res = await fetch(`http://${this.host}/pixelmap.txt`);
    if (!res.ok) throw new Error(`GET /pixelmap.txt -> ${res.status}`);
    const source = await res.text();
    if (!opts.coords) return source;
    const [cfg, { normalizeMap }] = await Promise.all([this.getConfig(), this.loadTooling()]);
    const raw = evalMapSource(source, cfg.pixelCount);
    return normalizeMap(raw, cfg.mapperFit).pixelMap;
  }

  // Set the pixel map: source text -> raw coords (evalMapSource) -> normalized
  // coords (the extracted normalizeMap, using this device's live pixelCount/
  // mapperFit) -> packed type-8 frame, sent live over the wire (updates the
  // render geometry immediately) — THEN the source text is persisted via
  // `POST /edit` + `{savePixelMap:true}` (survives reboot, reloads into the
  // Mapper editor). Both steps are required: a text-only upload leaves the
  // live geometry stale until the Mapper tab is opened and re-saved by hand.
  async setMap(text) {
    const [cfg, { normalizeMap }] = await Promise.all([this.getConfig(), this.loadTooling()]);
    const raw = evalMapSource(text, cfg.pixelCount);
    const { pixelMap, dimensions } = normalizeMap(raw, cfg.mapperFit);
    const frame = buildPixelMapFrame(pixelMap, dimensions);

    const c = connect(this.host); await c.opened;
    c.sendBytecode(frame, 8); // PacketType.PIXELMAP
    await sleep(200);

    const body = new FormData();
    body.append('data', new Blob([text || ' ']), '/pixelmap.txt');
    const res = await fetch(`http://${this.host}/edit`, { method: 'POST', body });
    if (!res.ok) { c.close(); throw new Error(`POST /edit -> ${res.status}`); }

    c.json({ savePixelMap: true });
    await sleep(150); c.close();
    return { pixelCount: pixelMap.length, dimensions };
  }
}
