// class Pixelblaze — the importable API. Headless, browser-free, Python-free:
// it compiles patterns using the device's own extracted compiler (see
// lib/compiler.mjs) and speaks its WebSocket protocol (lib/protocol.mjs)
// directly. Takes a host; knows nothing about argv, --flags, or env vars —
// that resolution lives in pbz.mjs. Throws on error; callers (the CLI) decide
// how to report it.
import zlib from 'node:zlib';
import dgram from 'node:dgram';
import { readFile, writeFile } from 'node:fs/promises';
import { fetchWebUI, makeCompiler, makeLZ, makeLZDecompress, makeNormalizeMap } from './compiler.mjs';
import { buildBytecode, buildPBP, stableId } from './pbp.mjs';
import { connect, sleep, makeWsId } from './protocol.mjs';
import { PREVIEW_H, buildPreviewJPEG } from './preview.mjs';
import { evalMapSource, buildPixelMapFrame } from './map.mjs';
import { parseFileList, parseBackup, buildBackup, defaultBackupName } from './backup.mjs';

// A write that goes unacknowledged is a FAILED write, not a quiet success.
// waitText resolves null on timeout, and discarding that made run/save/activate/
// setControls print "ok" after the device had dropped mid-command — the worst
// possible outcome for a tool that writes to hardware. Read methods already
// threw on null; these make writes agree with them.
async function expectText(c, prefix, after, what, ms = 3000) {
  const msg = await c.waitText(prefix, ms, after);
  if (!msg) throw new Error(`${what}: no ${prefix}…} response from device (timed out after ${ms}ms) — the command may not have taken effect`);
  return msg;
}
const expectAck = (c, after, what) => expectText(c, '{"ack"', after, what);

export class Pixelblaze {
  constructor(host) {
    if (!host) throw new Error('Pixelblaze: host required');
    this.host = host;
    this._tooling = null; // lazy+cached: {compile, lz, lzDecompress, normalizeMap}
    this._conn = null; // lazy-opened, reused across method calls (see _getConn)
    this._connecting = null; // in-flight open, so concurrent calls (e.g. getInfo's Promise.all) share one socket
  }

  // One reusable connection per instance instead of one-per-method-call
  // (PBZ-PLAN.md Chunk 20 — a multi-step script opening a socket per call
  // choked the device's small lwIP socket table). Lazy-open on first use;
  // concurrent callers await the same in-flight open rather than racing to
  // each open their own. Call close() when done with the instance.
  async _getConn() {
    if (this._conn && this._conn.ws.readyState === 1 /* OPEN */) return this._conn;
    if (!this._connecting) {
      this._connecting = (async () => {
        const c = connect(this.host);
        await c.opened;
        this._conn = c;
        return c;
      })().finally(() => { this._connecting = null; });
    }
    return this._connecting;
  }

  /**
   * Close the shared connection, if open. Safe to call even if never opened.
   */
  close() {
    if (this._conn) { this._conn.close(); this._conn = null; }
  }

  /**
   * Fetch + build the compiler/LZString/mapper trio from this device's web UI, once.
   */
  async loadTooling() {
    if (this._tooling) return this._tooling;
    const html = await fetchWebUI(this.host);
    this._tooling = { compile: makeCompiler(html), lz: makeLZ(html), lzDecompress: makeLZDecompress(html), normalizeMap: makeNormalizeMap(html) };
    return this._tooling;
  }

  /**
   * Compile source locally (nothing sent to the device) -> {program, bytecode}.
   */
  async compile(source) {
    const { compile } = await this.loadTooling();
    const program = compile(source);
    const bytecode = buildBytecode(program);
    return { program, bytecode };
  }

  /**
   * Compile + push live — replaces the running program instantly, NOT saved.
   */
  async run(source) {
    const { program, bytecode } = await this.compile(source);
    const c = await this._getConn();
    const crc = zlib.crc32(bytecode) >>> 0;
    let m = c.mark();
    c.json({ pause: true, setCode: { size: bytecode.length, crc, name: '', id: makeWsId() } });
    await expectAck(c, m, 'run: setCode');
    c.sendBytecode(bytecode, 3);
    await sleep(300);
    m = c.mark();
    c.json({ setControls: {} });
    c.json({ pause: false });
    await expectAck(c, m, 'run: resume');
    // two commands were sent, so two acks come back; claim the second or it is
    // left to be matched by whatever asks for an ack next (ping, notably).
    await c.waitText('{"ack"', 1000, m);
    await sleep(150);
    return { program, bytecode };
  }

  /**
   * Sample `n` live preview frames off whatever pattern is currently
   * running — the same binary type-5 stream save() captures for thumbnails —
   * without touching it. Frames are raw wire bytes: 1-byte header +
   * pixelCount x [r,g,b], PRE-brightness and PRE-W-extraction (verified live,
   * PBZ-PLAN.md Chunk 12) — callers apply both (see lib/power.mjs estimateDraw).
   */
  async samplePreview(n = 30) {
    const c = await this._getConn();
    const frames = await c.collectFrames(n);
    return frames;
  }

  /**
   * Compile + save to the device's pattern list AND activate it. `opts.id`
   * should be a stableId() derived from the source's identity (e.g. the file
   * basename) so re-saving updates the same entry instead of piling up
   * duplicates; falls back to deriving one from `name` if omitted.
   */
  async save(source, name, opts = {}) {
    const id = opts.id || stableId(name);
    const { lz } = await this.loadTooling();
    const { program, bytecode } = await this.compile(source);
    const c = await this._getConn();
    // Run it live first so the device renders it, then grab preview frames for the thumbnail.
    const crc = zlib.crc32(bytecode) >>> 0;
    let m = c.mark();
    c.json({ pause: true, setCode: { size: bytecode.length, crc, name: '', id: makeWsId() } });
    await expectAck(c, m, 'save: setCode');
    c.sendBytecode(bytecode, 3);
    await sleep(300);
    m = c.mark();
    c.json({ setControls: {} });
    c.json({ pause: false });
    await expectAck(c, m, 'save: resume');
    // two commands were sent, so two acks come back; claim the second or it is
    // left to be matched by whatever asks for an ack next (ping, notably).
    await c.waitText('{"ack"', 1000, m);
    await sleep(200);
    const frames = await c.collectFrames(PREVIEW_H);
    // preview.mjs's own header: the web UI errors out and drops to /?min on a
    // pattern whose preview is missing. Saving one anyway would produce exactly
    // the broken entry this code path exists to avoid.
    if (!frames.length) {
      throw new Error('save: device sent no preview frames, so the thumbnail would be empty — the web UI rejects patterns saved that way. Is the pattern rendering?');
    }
    const jpeg = buildPreviewJPEG(frames);
    // Save the PBP (with preview) and activate it.
    const pbp = buildPBP(name, source, bytecode, lz, jpeg);
    m = c.mark();
    c.sendBytecode(Buffer.concat([Buffer.from(id, 'ascii'), pbp]), 1); // putSourceCode
    await expectAck(c, m, 'save: putSourceCode');
    await sleep(200);
    m = c.mark();
    c.json({ activeProgramId: id });                                   // activate it
    await expectText(c, '{"activeProgram"', m, 'save: activate');
    await sleep(150);
    return { id, program, bytecode, frames: frames.length, rawFrames: frames, previewBytes: jpeg.length };
  }

  /**
   * List saved patterns -> [{id, name}].
   */
  async list() {
    const c = await this._getConn();
    const m = c.mark();
    c.json({ listPrograms: true });
    // Chunked binary (type 7), terminated by the framing's own last-chunk flag.
    const buf = await c.collectChunks(7, { after: m });
    return buf.toString('utf8').split('\n').filter(Boolean).map(l => { const [id, ...n] = l.split('\t'); return { id, name: n.join('\t') }; });
  }

  // Resolve `target` (an id or a name, case-insensitive) to a {id, name} row.
  async _resolveTarget(target) {
    const rows = await this.list();
    const hit = rows.find(r => r.id === target) || rows.find(r => r.name.toLowerCase() === target.toLowerCase());
    if (!hit) throw new Error(`no pattern matching "${target}" (try: list)`);
    return hit;
  }

  /**
   * Switch the active pattern. `target` may be an id or a name (case-insensitive).
   */
  async activate(target) {
    const hit = await this._resolveTarget(target);
    const c = await this._getConn();
    const m = c.mark();
    c.json({ activeProgramId: hit.id });
    await expectText(c, '{"activeProgram"', m, 'activate');
    await sleep(120);
    return hit;
  }

  /**
   * Delete a saved pattern. Fire-and-forget (no ack — matches the web UI's own handler).
   */
  async delete(target) {
    const hit = await this._resolveTarget(target);
    const c = await this._getConn();
    c.json({ deleteProgram: hit.id });
    await sleep(150);
    return hit;
  }

  /**
   * Fetch a saved pattern's source -> {main: "<source>", blockly?: ...}. Binary
   * SOURCESDATA frames (type 6), LZString-compressed JSON — the same two-step
   * fetch the web UI's Export button makes.
   */
  async getSources(id) {
    const { lzDecompress } = await this.loadTooling();
    const c = await this._getConn();
    const m = c.mark();
    c.json({ getSources: id });
    const buf = await c.collectChunks(6, { after: m });
    if (!buf.length) throw new Error(`getSources: device returned no source for ${id}`);
    const json = lzDecompress(buf);
    if (!json) throw new Error(`getSources: could not decompress the source blob for ${id} (${buf.length} bytes)`);
    return JSON.parse(json);
  }

  /**
   * Fetch a saved pattern's thumbnail jpeg. Binary THUMBNAILJPG frames (type 4):
   * 2-byte frame header + 17-byte id + jpeg chunk.
   */
  async getPreviewImg(id) {
    const c = await this._getConn();
    const m = c.mark();
    c.json({ getPreviewImg: id });
    // type-4 frames carry a 17-byte ascii id after the 2-byte frame header
    return c.collectChunks(4, { after: m, headerBytes: 19 });
  }

  /**
   * Export a saved pattern to a .epe file: {name, id, sources, preview(base64)} —
   * byte-for-byte the same shape the web UI's Export/Download button writes.
   */
  async export(target, file) {
    const hit = await this._resolveTarget(target);
    const [sources, jpeg] = await Promise.all([this.getSources(hit.id), this.getPreviewImg(hit.id)]);
    const epe = { name: hit.name, id: hit.id, sources, preview: jpeg.toString('base64') };
    const outFile = file || `${hit.name}.epe`;
    await writeFile(outFile, JSON.stringify(epe, null, 2));
    return { file: outFile, epe };
  }

  /**
   * Import a .epe file: recompile its source locally (our compiler, so it always
   * matches firmware) and save it, reusing the original id so it lands back in
   * the same slot rather than piling up a duplicate.
   */
  async import(file) {
    const epe = JSON.parse(await readFile(file, 'utf8'));
    const source = epe.sources?.main;
    if (!source) throw new Error(`${file}: missing sources.main`);
    return this.save(source, epe.name, { id: epe.id });
  }

  /**
   * Active pattern's current vars + controls.
   */
  async getState() {
    const c = await this._getConn();
    const m = c.mark();
    c.json({ getVars: true });
    c.json({ getConfig: true });
    const varsMsg = await c.waitText('{"vars"', 3000, m);
    const apMsg = await c.waitText('{"activeProgram"', 3000, m);
    // {getConfig:true} also produces the flat settings frame. Leaving it queued
    // is what made a LATER getConfig() splice this stale one and report
    // pre-change values — claim it here so it can never answer a future call.
    await c.waitText('{"name"', 1000, m);
    const vars = varsMsg ? JSON.parse(varsMsg).vars : {};
    const ap = apMsg ? JSON.parse(apMsg).activeProgram : {};
    return { vars, name: ap.name, id: ap.activeProgramId, controls: ap.controls || {} };
  }

  /**
   * Active pattern's exported `export var` values (distinct from setControls,
   * which drives UI sliders/toggles — this pokes the underlying pattern
   * variables directly). Wire field name intact (read-method layering).
   */
  async getVars() {
    const c = await this._getConn();
    const m = c.mark();
    c.json({ getVars: true });
    const msg = await c.waitText('{"vars"', 3000, m);
    if (!msg) throw new Error('getVars: no response from device');
    return JSON.parse(msg).vars;
  }

  /**
   * Set one or more exported pattern variables live. No ack for this message
   * (matches the web UI's own client); fires and settles.
   */
  async setVars(obj) {
    const c = await this._getConn();
    c.json({ setVars: obj });
    await sleep(120);
    return obj;
  }

  /**
   * Tune the active pattern's controls live (slider values 0..1, toggles 0/1).
   */
  async setControls(controls) {
    const c = await this._getConn();
    const m = c.mark();
    c.json({ setControls: controls, save: false });
    await expectAck(c, m, 'setControls');
    await sleep(120);
  }

  /**
   * Global brightness (0..1, firmware step .005). Ephemeral unless opts.save —
   * matches the web UI slider, which only persists on release. No ack is sent
   * for this message (confirmed against the web UI's own client), so this
   * just fires and settles.
   */
  async setBrightness(value, opts = {}) {
    const brightness = Math.max(0, Math.min(1, value));
    const c = await this._getConn();
    c.json({ brightness, save: !!opts.save });
    await sleep(120);
    return brightness;
  }

  /**
   * Firmware brightness ceiling, 0..100 (percent, not 0..1 — key is
   * maxBrightness). Always persisted: this is the power-safety cap
   * (see README "Power") — it clamps hardware output regardless of
   * pattern/slider, the actual guard against the ~273W all-four ceiling.
   */
  async setMaxBrightness(pct) {
    const maxBrightness = Math.max(0, Math.min(100, pct));
    const c = await this._getConn();
    c.json({ maxBrightness, save: true });
    await sleep(120);
    return maxBrightness;
  }

  /**
   * Device + LED settings (name, pixelCount, colorOrder, ledType, dataSpeed,
   * cpuSpeed, sequenceTimer, autoOff*, timezone, discoveryEnable, …), plus
   * brightness/maxBrightness. The response has no wrapper key — it's a flat
   * settings object; '{"name"' is its distinctive lead field (device name is
   * always first), used the same way other messages are matched by prefix.
   */
  async getConfig() {
    const c = await this._getConn();
    const m = c.mark();
    c.json({ getConfig: true });
    const msg = await c.waitText('{"name"', 3000, m);
    if (!msg) throw new Error('getConfig: no response from device');
    // The same request also emits the active-program frame. Claim it, or a
    // later activate() would match this stale one and report success without
    // the device having done anything.
    await c.waitText('{"activeProgram"', 1000, m);
    return JSON.parse(msg);
  }

  /**
   * Sequencer mode: 0 Off, 1 ShuffleAll, 2 Playlist. Persists immediately —
   * no `save` key (matches the web UI's own settings-panel send, same as
   * setConfig).
   */
  async setSequencerMode(mode) {
    const sequencerMode = mode;
    const c = await this._getConn();
    c.json({ sequencerMode });
    await sleep(150);
    return sequencerMode;
  }

  /**
   * Pause/resume the playlist auto-advance timer without leaving Playlist
   * mode (independent of sequencerMode) — the web UI play/pause button.
   * No ack for this message (matches the web UI's own client); fires and
   * settles. Readable back via getConfig().runSequencer.
   *
   * The settle is 350ms rather than the 150ms the other fire-and-forget
   * senders use: with no ack there is nothing to synchronise on, and a caller
   * reading the state straight back was observed getting the STALE value on
   * firmware v3.67. It did not reproduce on v3.51, but the failure is a
   * silently-wrong read rather than an error, and 200ms on a method nobody
   * calls in a loop is the cheaper side of that trade.
   */
  async setSequencerState(run) {
    const c = await this._getConn();
    c.json({ runSequencer: !!run });
    await sleep(350);
    return !!run;
  }

  /**
   * Advance the sequencer to the next pattern immediately. No ack.
   */
  async nextPattern() {
    const c = await this._getConn();
    c.json({ nextProgram: true });
    await sleep(150);
  }

  /**
   * The shared `_defaultplaylist_`. Wire field names intact (read-method
   * layering): {position, id, ms, remainingMs, items:[{id, ms}]}.
   */
  async getPlaylist() {
    const c = await this._getConn();
    const m = c.mark();
    c.json({ getPlaylist: '_defaultplaylist_' });
    const msg = await c.waitText('{"playlist"', 3000, m);
    if (!msg) throw new Error('getPlaylist: no response from device');
    return JSON.parse(msg).playlist;
  }

  /**
   * Replace the playlist's items ([{id, ms}, …]) and persist — mirrors the
   * web UI's own savePlaylist, which always follows a live update with a
   * save:true send.
   */
  async setPlaylist(items) {
    const c = await this._getConn();
    c.json({ playlist: { id: '_defaultplaylist_', items }, save: true });
    await sleep(150);
    return items;
  }

  /**
   * Update device/LED settings. Unlike brightness/maxBrightness, plain
   * config fields persist immediately on receipt — no `save` flag (confirmed
   * against the web UI's own settings-panel handlers, none of which send
   * one, and against the live device: a field set without `save` survives a
   * fresh getConfig read).
   */
  async setConfig(obj) {
    const c = await this._getConn();
    c.json(obj);
    await sleep(150);
    return obj;
  }

  /**
   * Live status frame: fps, mem, uptime, storage, vm error state — every
   * connection receives it unsolicited ~1/s (no request needed, confirmed
   * live). Wire field names intact (read-method layering house rule).
   */
  async getStatus() {
    const c = await this._getConn();
    // Wait for the NEXT frame rather than taking the oldest queued one. Status
    // frames arrive unsolicited about once a second, so on a long-lived
    // connection the oldest is as stale as the connection is old. Allow a
    // little over one interval.
    const m = c.mark();
    const msg = await c.waitText('{"fps"', 3000, m);
    if (!msg) throw new Error('getStatus: no status frame received from device');
    return JSON.parse(msg);
  }

  /**
   * Sync-group peers (wire field names intact).
   */
  async getPeers() {
    const c = await this._getConn();
    const m = c.mark();
    c.json({ getPeers: 1 });
    const msg = await c.waitText('{"peers"', 3000, m);
    if (!msg) throw new Error('getPeers: no response from device');
    return JSON.parse(msg).peers;
  }

  /**
   * Status-popup contents, built on getConfig + getStatus + getPeers (never
   * parses their frames inline — read-method layering house rule). Pass-
   * through fields keep wire names (ver, uptime, storageUsed, …); only fields
   * that bake in a decode get added: `expansion` from the `exp` bitmask
   * (verified in the web UI's own status-popup handler: bit1 = Sensor Board
   * 1.0, bit2 = 6-axis) and computed `groupRole` (Leader if peers report
   * following us, Follower if we have a leaderId, else Solo — this rig is
   * Solo unless you have actually set up a sync group).
   * Cosmetic labeling (ver -> "firmware version", uptime -> H:MM:SS, …) is
   * the CLI's job, not this method's.
   */
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

  /**
   * Pixel-map source text (HTTP GET) — the human-readable, committable form,
   * returned as-is (read-method layering house rule: no interpretation here).
   * `opts.coords`: also compute the normalized `[[x,y],…]` render coordinates
   * — the SAME headless evaluate-then-normalize path setMap() uses to build
   * the wire frame, via getConfig() for pixelCount/mapperFit (a composite
   * built on accessors, not a second wire shape folded in here). This is the
   * only way to answer "does the device's live geometry match this source?"
   * — the device can't eval the map JS itself (same reason it can't compile
   * patterns; see lib/compiler.mjs).
   */
  async getMap(opts = {}) {
    const res = await fetch(`http://${this.host}/pixelmap.txt`);
    if (!res.ok) throw new Error(`GET /pixelmap.txt -> ${res.status}`);
    const source = await res.text();
    if (!opts.coords) return source;
    const [cfg, { normalizeMap }] = await Promise.all([this.getConfig(), this.loadTooling()]);
    const raw = evalMapSource(source, cfg.pixelCount);
    return normalizeMap(raw, cfg.mapperFit).pixelMap;
  }

  /**
   * Set the pixel map: source text -> raw coords (evalMapSource) -> normalized
   * coords (the extracted normalizeMap, using this device's live pixelCount/
   * mapperFit) -> packed type-8 frame, sent live over the wire (updates the
   * render geometry immediately) — THEN the source text is persisted via
   * `POST /edit` + `{savePixelMap:true}` (survives reboot, reloads into the
   * Mapper editor). Both steps are required: a text-only upload leaves the
   * live geometry stale until the Mapper tab is opened and re-saved by hand.
   */
  async setMap(text) {
    const [cfg, { normalizeMap }] = await Promise.all([this.getConfig(), this.loadTooling()]);
    const raw = evalMapSource(text, cfg.pixelCount);
    const { pixelMap, dimensions } = normalizeMap(raw, cfg.mapperFit);
    const frame = buildPixelMapFrame(pixelMap, dimensions);

    const c = await this._getConn();
    c.sendBytecode(frame, 8); // PacketType.PIXELMAP
    await sleep(200);

    const body = new FormData();
    body.append('data', new Blob([text || ' ']), '/pixelmap.txt');
    const res = await fetch(`http://${this.host}/edit`, { method: 'POST', body });
    if (!res.ok) throw new Error(`POST /edit -> ${res.status}`);

    c.json({ savePixelMap: true });
    await sleep(150);
    return { pixelCount: pixelMap.length, dimensions };
  }

  /**
   * Snapshot every file on the device (patterns, config, playlist, map) into
   * one JSON `.pbb` — the same shape the web UI's own Settings->Backup button
   * assembles client-side over HTTP; there is no dedicated device-side backup
   * endpoint (that's the separate, opt-in backupFsImage below). Skips the
   * `*.gz` web-app files (both the web UI and the Python client exclude
   * them) and verifies each fetched file's size against the /list listing —
   * catches a truncated transfer instead of silently backing up garbage.
   */
  async saveBackup(file) {
    const listRes = await fetch(`http://${this.host}/list`);
    if (!listRes.ok) throw new Error(`GET /list -> ${listRes.status}`);
    const entries = parseFileList(await listRes.text()).filter(e => !e.path.endsWith('.gz'));
    const files = {};
    for (const e of entries) {
      const p = e.path.startsWith('/') ? e.path : `/${e.path}`;
      const res = await fetch(`http://${this.host}${p}`);
      if (!res.ok) throw new Error(`GET ${p} -> ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length !== e.size) throw new Error(`${e.path}: fetched ${buf.length} bytes, /list says ${e.size}`);
      files[e.path] = buf;
    }
    let outFile = file;
    if (!outFile) {
      const cfg = await this.getConfig();
      outFile = defaultBackupName(cfg.name, cfg.chipId, Date.now());
    }
    await writeFile(outFile, buildBackup(files));
    return { file: outFile, count: Object.keys(files).length };
  }

  /**
   * Restore a .pbb onto the device: POST each file back through the same
   * multipart /edit endpoint the pixel-map source upload uses (setMap), then
   * reboot so config/playlist/map changes take effect. Overwrite-only by
   * default — gentler than the web UI's own restore, which wipes first —
   * pass opts.prune to also delete on-device files absent from the backup.
   * WiFi config is never included (the web UI says so at export time, and
   * nothing in /list's inventory is a WiFi credential file).
   */
  async restoreBackup(file, opts = {}) {
    const files = parseBackup(await readFile(file, 'utf8'));
    for (const [path, buf] of Object.entries(files)) {
      const body = new FormData();
      body.append('data', new Blob([buf]), path);
      const res = await fetch(`http://${this.host}/edit`, { method: 'POST', body });
      if (!res.ok) throw new Error(`POST /edit ${path} -> ${res.status}`);
    }
    const pruned = [];
    if (opts.prune) {
      const listRes = await fetch(`http://${this.host}/list`);
      if (!listRes.ok) throw new Error(`GET /list -> ${listRes.status}`);
      const onDevice = parseFileList(await listRes.text()).filter(e => !e.path.endsWith('.gz'));
      const kept = new Set(Object.keys(files).map(p => p.startsWith('/') ? p : `/${p}`));
      for (const e of onDevice) {
        const p = e.path.startsWith('/') ? e.path : `/${e.path}`;
        if (kept.has(p)) continue;
        const res = await fetch(`http://${this.host}/delete?path=${encodeURIComponent(p)}`);
        if (res.ok) pruned.push(p);
      }
    }
    await this.reboot();
    return { restored: Object.keys(files).length, pruned };
  }

  /**
   * Device-side full-flash image (v3.67+) — the other half of "backup",
   * opt-in and heavier: LEDs go dark while it writes flash, and restoring it
   * means holding the button at power-up, not `pbz restore`. Deliberate-use
   * only, not part of the default `pbz backup` flow.
   */
  async backupFsImage(file) {
    const res = await fetch(`http://${this.host}/backupFsImage`, { method: 'POST' });
    if (!res.ok) throw new Error(`POST /backupFsImage -> ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(file, buf);
    return { file, bytes: buf.length };
  }

  /**
   * Restart the device. HTTP POST, not a websocket message (the Python client
   * gets this wrong — verified against the web UI's own reboot button, which
   * hits this endpoint). No response body to parse; the device drops off the
   * network for several seconds.
   */
  async reboot() {
    const res = await fetch(`http://${this.host}/reboot`, { method: 'POST' });
    if (!res.ok) throw new Error(`POST /reboot -> ${res.status}`);
  }

  /**
   * Round-trip latency to the device over the websocket. `{"ack":1}` comes
   * back (not `{"ack":true}` — the Appendix's schematic form; verified live).
   */
  async ping() {
    const c = await this._getConn();
    const m = c.mark();
    const t0 = Date.now();
    c.json({ ping: true });
    const msg = await c.waitText('{"ack"', 3000, m);
    if (!msg) throw new Error('ping: no response from device');
    return Date.now() - t0;
  }

  /**
   * Listen for Pixelblaze UDP beacons on port 1889 (LAN broadcast, sent when
   * discoveryEnable is on) for `ms`, returning the distinct devices heard.
   * Static: discovery is how you find a host, so it doesn't need one. Beacon
   * packet (verified live against this device): 12 bytes, three little-endian
   * uint32s — [packetType (42 = beacon), chipId, timestamp (ms since boot)].
   * Listen-only — doesn't send anything (the cloud-discovery path at
   * discover.electromage.com is a separate, out-of-scope mechanism).
   */
  static discover(ms = 3000) {
    return new Promise((resolve, reject) => {
      const seen = new Map(); // chipId (hex) -> {address, chipId, lastSeen}
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      sock.on('error', reject);
      sock.on('message', (msg, rinfo) => {
        if (msg.length !== 12 || msg.readUInt32LE(0) !== 42) return;
        const chipId = msg.readUInt32LE(4).toString(16);
        seen.set(chipId, { address: rinfo.address, chipId, lastSeen: msg.readUInt32LE(8) });
      });
      sock.bind(1889, () => {
        setTimeout(() => { sock.close(); resolve([...seen.values()]); }, ms);
      });
    });
  }
}
