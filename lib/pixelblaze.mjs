// class Pixelblaze — the importable API. Headless, browser-free, Python-free:
// it compiles patterns using the device's own extracted compiler (see
// lib/compiler.mjs) and speaks its WebSocket protocol (lib/protocol.mjs)
// directly. Takes a host; knows nothing about argv, --flags, or env vars —
// that resolution lives in pbz.mjs. Throws on error; callers (the CLI) decide
// how to report it.
//
// Concurrent WRITES on one instance are unsupported: acks carry no request
// id, so two in-flight writes on the shared connection can't be told apart —
// a reply meant for one can satisfy the other's wait. Serialize writes
// against a given instance yourself if you need more than one. Concurrent
// READS are fine (see getInfo()'s own Promise.all, which relies on this).
import zlib from 'node:zlib';
import dgram from 'node:dgram';
import { readFile, writeFile } from 'node:fs/promises';
import { fetchWebUI, makeCompiler, makeLZ, makeLZDecompress, makeNormalizeMap } from './compiler.mjs';
import { buildBytecode, buildPBP, stableId } from './pbp.mjs';
import { connect, sleep, makeWsId } from './protocol.mjs';
import { PREVIEW_H, buildPreviewJPEG } from './preview.mjs';
import { evalMapSource, buildPixelMapFrame } from './map.mjs';
import { parseFileList, parseBackup, buildBackup, defaultBackupName, classifyForDefrag } from './backup.mjs';

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
const expectAck = (c, after, what, ms) => expectText(c, '{"ack"', after, what, ms);

// PBZ-PLAN.md Chunk 26: the four small-write paths timed for the write-
// latency watchdog (setConfig, delete, setControls, activate) get a LONGER
// ack timeout than expectText's 3s default. That default would mask the
// watchdog's own 3x-baseline warn arm once a baseline legitimately climbs
// past ~1s — a hard 3s throw would fire before the multiplier ever got room
// to react. 8s is a deliberate point on the incident's own scale: far past
// a healthy round trip, and far short of the degradation actually observed
// (small writes taking MINUTES as SPIFFS GC ground the board down) — and
// deliberately NOT protocol.mjs's own IDLE_CLOSE_MS (10s): the two timers
// racing at the same instant is exactly the coincidence a local review
// caught (the socket idling itself out right as the ack wait was about to
// time out on its own, for no reason tied to this constant). The floor/
// multiplier warn band effectively governs roughly a 2-8s range of real
// degradation; past 8s a hard throw here is the correct late-stage signal,
// not a false negative silently swallowed by an over-eager timeout.
const WRITE_ACK_TIMEOUT_MS = 8000;

// setConfig/deleteProgram themselves never ack (verified live 2026-08-14,
// v3.67 — see PBZ-PLAN.md's Appendix). The ping-chase's ack IS the write's
// completion signal, so a timeout here means the device took the write but
// the follow-on ping never came back — a stalled device, not a dropped
// request — so the message names the disease this chunk exists to catch,
// rather than expectText's generic "no response" wording.
async function expectChaseAck(c, after, what) {
  const msg = await c.waitText('{"ack"', WRITE_ACK_TIMEOUT_MS, after);
  if (!msg) {
    throw new Error(`no ack within ${WRITE_ACK_TIMEOUT_MS / 1000}s after ${what} — device writes may be stalling (storage pressure?); check \`pbz info\`'s storage line`);
  }
  return msg;
}

export class Pixelblaze {
  /**
   * @param host Address or hostname.
   * @param opts.onWriteLatency Optional `(op, ms) => void` hook, invoked
   *   after each small write (setConfig, delete, setControls, activate)
   *   with the operation name and its post-connect write->ack time. This is
   *   a constructor option, not a class member — see lib/pixelblaze.d.mts's
   *   `PixelblazeOptions` and lib/latency.mjs's `makeWatchdog`, which is
   *   what the CLI wires here. A library caller with no interest in write
   *   latency can simply omit it. Exceptions thrown by it are swallowed
   *   (see _reportWriteLatency) — it can never fail the write it reports on.
   */
  constructor(host, opts = {}) {
    if (!host) throw new Error('Pixelblaze: host required');
    this.host = host;
    this._tooling = null; // lazy+cached: {compile, lz, lzDecompress, normalizeMap}
    this._conn = null; // lazy-opened, reused across method calls (see _getConn)
    this._connecting = null; // in-flight open, so concurrent calls (e.g. getInfo's Promise.all) share one socket
    this._onWriteLatency = typeof opts.onWriteLatency === 'function' ? opts.onWriteLatency : null;
  }

  // Report one small-write op's timing to the onWriteLatency hook, if any.
  // Never lets a callback exception reach the caller — this is observability
  // riding along on a write, not part of the write's own success/failure.
  _reportWriteLatency(op, ms) {
    if (!this._onWriteLatency) return;
    try { this._onWriteLatency(op, ms); } catch { /* observability must never break a write */ }
  }

  // Await an ack-wait promise (setConfig/delete/setControls/activate all use
  // this); on timeout, quarantine the connection BEFORE rethrowing.
  //
  // Acks carry no request id (PBZ-PLAN.md Chunk 26 — this replaced an
  // earlier purgeText() attempt that turned out not to work: mark() already
  // excludes anything queued before it, a purge taken before mark() can't
  // reach an ack that arrives AFTER it, and worse, purging on every call
  // could steal a still-live ack out from under a genuinely concurrent
  // waiter). So a late ack from THIS abandoned write is otherwise fair game
  // to satisfy the NEXT call's wait on the same connection. Closing the
  // connection here means that late ack dies with the old socket instead of
  // lingering for anyone to (mis)claim — the next call reconnects fresh.
  // The device was already suspect (that's why we're here), so dropping the
  // connection costs nothing beyond a reconnect — same ethos as Chunk 20's
  // fail-fast. close() is wrapped so it can never mask the ORIGINAL timeout,
  // which is the error that actually matters to the caller.
  async _awaitAckOrQuarantine(promise) {
    try {
      return await promise;
    } catch (e) {
      try { this.close(); } catch { /* the timeout above is the real error; this is best-effort cleanup */ }
      throw e;
    }
  }

  // Poll until the device answers a ping again — used by defrag() after
  // restoreBackup()'s own POST /reboot, which only sends the request and
  // does not wait for the device to come back.
  //
  // close() FIRST: whatever this._conn was pointing at is untrustworthy the
  // instant a reboot has been requested against it — a reboot always drops
  // the connection, and even in some edge case where the socket's own
  // readyState still looked reusable to _getConn(), a fresh reconnect is the
  // only accurate signal for "has the device actually come back", which is
  // the entire point of this method. Every ping() failure reconnects fresh
  // (ping() -> _getConn()), so a device that never even starts accepting
  // connections again surfaces here as a timeout, not a hang.
  //
  // SLEEPS BEFORE EVERY ATTEMPT, INCLUDING THE VERY FIRST, AND REQUIRES TWO
  // CONSECUTIVE SUCCESSFUL PINGS before returning — found in review, not
  // hypothetical: reboot()'s own `POST /reboot` returns as soon as the ESP32
  // ACKs the HTTP request, well before the device has actually restarted, so
  // pinging immediately can land in that pre-restart window and falsely
  // succeed against the OLD, not-yet-rebooted device — which would make
  // defrag()'s own post-restore list()/getStatus() verify silently check
  // pre-reboot state instead of post-restore state. A single success isn't
  // proof either: the device could answer once in that same window and then
  // actually drop a moment later for the real restart. So this sleeps pollMs
  // before the first attempt (not just between retries) and requires the
  // ping to succeed twice IN A ROW — any failure in between resets the count
  // to zero, a lone success does not return.
  //
  // CADENCE MATH, so live tuning of timeoutMs/pollMs reads this correctly: a
  // FAILED ping can cost up to protocol.mjs's own ~5s open timeout, plus (if
  // the socket opens but the write never acks) ping()'s own ~3s wait — call
  // it up to ~8s for one failed attempt, NOT pollMs. pollMs only governs the
  // gaps between successes (the settle before the first attempt, and the
  // wait before the confirming second ping) — it does not govern the failure
  // retry interval, which rides on protocol.mjs's own timeouts instead. At
  // the defaults (timeoutMs=45000, pollMs=1000) that's roughly 5-6 real
  // attempts before the deadline, not 45 — and because the deadline is only
  // checked BETWEEN attempts (after each sleep), a run can overshoot it by
  // up to one attempt's own cost (~53s here), not stop exactly at 45000ms.
  //
  // `_`-prefixed: internal, exempt from the pixelblaze.d.mts member-set
  // guard (test/types.test.mjs walks only the non-`_` prototype members).
  // Timeout/poll constants are provisional — this session verified them only
  // hermetically with injected fakes; tuning them against the real device's
  // actual post-reboot recovery time is the orchestrator's live-acceptance
  // job, not this one's.
  async _waitForReboot(timeoutMs = 45000, pollMs = 1000) {
    this.close();
    const deadline = Date.now() + timeoutMs;
    let lastErr;
    let consecutive = 0;
    while (true) {
      await sleep(pollMs);
      if (Date.now() >= deadline) break;
      try {
        await this.ping();
        consecutive++;
        if (consecutive >= 2) return;
      } catch (e) {
        lastErr = e;
        consecutive = 0;
      }
    }
    throw new Error(`device did not respond to ping twice in a row within ${timeoutMs}ms (last error: ${lastErr?.message ?? 'none'})`);
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
   *
   * Timed for the write-latency watchdog (PBZ-PLAN.md Chunk 26): the clock
   * starts AFTER the target is resolved (list()'s own binary read is
   * payload-scaling, not a small write, and is excluded on purpose) and the
   * connection is open — right before the write is sent — and stops at the
   * device's ack. A slow list() or a cold connection open never counts
   * against the baseline; only the actual post-connect write round trip does.
   *
   * On a timeout, the connection is quarantined before the error is thrown
   * — see `_awaitAckOrQuarantine`'s comment for why.
   */
  async activate(target) {
    const hit = await this._resolveTarget(target);
    const c = await this._getConn();
    const t0 = Date.now();
    const m = c.mark();
    c.json({ activeProgramId: hit.id });
    await this._awaitAckOrQuarantine(expectText(c, '{"activeProgram"', m, 'activate', WRITE_ACK_TIMEOUT_MS));
    this._reportWriteLatency('activate', Date.now() - t0);
    await sleep(120);
    return hit;
  }

  /**
   * Delete a saved pattern. `deleteProgram` itself is fire-and-forget — the
   * device never acks it (matches the web UI's own handler, and verified
   * live 2026-08-14 on v3.67: no ack within 1.5s). PBZ-PLAN.md Chunk 26
   * ping-chases it instead of the old blind sleep(150): a `{"ping":true}`
   * sent right after, on the same connection, only acks once the device has
   * FIFO-processed the delete ahead of it (153ms observed, vs 13-84ms for a
   * bare ping) — a real completion signal, not a guessed delay. This is a
   * deliberate behavior change: delete() previously could not fail after
   * send; a dead or GC-grinding board now makes this throw instead of
   * silently "succeeding" (after WRITE_ACK_TIMEOUT_MS — see expectChaseAck).
   * On a timeout the connection is also quarantined before the error is
   * thrown — see `_awaitAckOrQuarantine`'s comment for why.
   *
   * Timed for the write-latency watchdog: the clock starts right before the
   * deleteProgram send (target already resolved, connection already open —
   * list()'s own binary read is excluded, it's payload-scaling, not a small
   * write) and stops when the chased ping's ack arrives, so the reported
   * span is exactly this write's own post-connect round trip.
   */
  async delete(target) {
    const hit = await this._resolveTarget(target);
    const c = await this._getConn();
    const t0 = Date.now();
    const m = c.mark();
    c.json({ deleteProgram: hit.id });
    c.json({ ping: true });
    await this._awaitAckOrQuarantine(expectChaseAck(c, m, 'delete'));
    this._reportWriteLatency('delete', Date.now() - t0);
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
   *
   * Timed for the write-latency watchdog: the clock starts right before the
   * send (connection already open) and stops at the device's ack. On a
   * timeout the connection is quarantined before the error is thrown — see
   * `_awaitAckOrQuarantine`'s comment for why.
   */
  async setControls(controls) {
    const c = await this._getConn();
    const t0 = Date.now();
    const m = c.mark();
    c.json({ setControls: controls, save: false });
    await this._awaitAckOrQuarantine(expectAck(c, m, 'setControls', WRITE_ACK_TIMEOUT_MS));
    this._reportWriteLatency('setControls', Date.now() - t0);
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
   *
   * setConfig itself is fire-and-forget on the wire — the device never acks
   * it (verified live 2026-08-14 on v3.67: no ack within 1.5s). PBZ-PLAN.md
   * Chunk 26 ping-chases it instead of the old blind sleep(150): a
   * `{"ping":true}` sent right after, on the same connection, only acks once
   * the device has FIFO-processed this write ahead of it (110-189ms
   * observed, vs 13-84ms for a bare ping) — a real completion signal, not a
   * guessed delay. This is a deliberate behavior change: setConfig()
   * previously could not fail after send; a dead or GC-grinding board now
   * makes this throw instead of silently "succeeding" (after
   * WRITE_ACK_TIMEOUT_MS — see expectChaseAck). On a timeout the connection
   * is also quarantined before the error is thrown — see
   * `_awaitAckOrQuarantine`'s comment for why.
   *
   * Timed for the write-latency watchdog: the clock starts right before the
   * write is sent (connection already open) and stops when the chased
   * ping's ack arrives, so the reported span is exactly this write's own
   * post-connect round trip.
   */
  async setConfig(obj) {
    const c = await this._getConn();
    const t0 = Date.now();
    const m = c.mark();
    c.json(obj);
    c.json({ ping: true });
    await this._awaitAckOrQuarantine(expectChaseAck(c, m, 'setConfig'));
    this._reportWriteLatency('setConfig', Date.now() - t0);
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
   * OTA deep clean (PBZ-PLAN.md Chunk 28). The firmware exposes no GC/format
   * endpoint, but GC runs as a side effect of writes, and deletes give it
   * something reclaimable — so a full reclamation is composable over the
   * existing API on a still-healthy board: backup -> delete every pattern +
   * the playlist -> restore from that same backup -> reboot -> verify. After
   * the mass delete most blocks hold little live data, GC's copy step is
   * nearly free, blocks get erased wholesale, and the restore lands in
   * freshly-erased space — the serial-erase recovery this project's own
   * incident needed, minus the web-app region, minus the bench.
   *
   * `file` is optional and exists for programmatic callers who want to pin a
   * location; the CLI never passes one (`saveBackup()`'s own default naming
   * is used). Fails loud mid-sequence, one connection throughout (this
   * instance's shared ws connection covers every ws-based step; the HTTP
   * steps — saveBackup/restoreBackup/the delete loop — need none), and every
   * thrown message says exactly how far it got plus the verified backup to
   * recover from — a half-defragged board with a verified `.pbb` in hand is
   * inconvenient, not lost.
   */
  async defrag(file, opts = {}) {
    // (1) Fresh backup FIRST, and re-read + decode the bytes actually
    // written to disk — not the in-memory object saveBackup() already
    // assembled — because this is the step that proves the backup a future
    // `pbz restore` would read is real, not just that saveBackup() ran
    // without throwing.
    const backup = await this.saveBackup(file);
    const backupFile = backup.file;
    let files;
    try {
      files = parseBackup(await readFile(backupFile, 'utf8'));
    } catch (e) {
      throw new Error(`defrag: fresh backup ${backupFile} does not decode (${e.message}) — aborting before mutating the device. Nothing was deleted.`);
    }

    // Steps (2)-(3) below only READ from the device (plus the gate's own
    // single idempotent write) — nothing has been deleted yet at any point
    // in this block. Wrap every one of them the same way step (1) is
    // wrapped: name what was being attempted, and that a fresh, decode-
    // verified backup already exists with nothing deleted. This matters
    // most for the LAST of these — the gate's own setConfig() — because the
    // single likeliest failure of the whole bunch is exactly that write
    // hitting its own 8s ack timeout (Chunk 26) on a board that's already
    // struggling, which is precisely the disease this health gate exists to
    // catch before deleting anything.
    const preDelete = async (label, fn) => {
      try {
        return await fn();
      } catch (e) {
        throw new Error(
          `defrag: ${label} failed (${e.message}) — a fresh, decode-verified backup is at ${backupFile}; nothing was deleted.`
        );
      }
    };

    // (2) Before-figures + pre-delete pattern inventory, for the verify step
    // and for the refusal message below.
    const before = await preDelete('reading storage status', () => this.getStatus());
    const beforePatterns = await preDelete('listing patterns', () => this.list());

    // (3) Health gate: getConfig() first warms the connection (so its open
    // time doesn't pollute the sample), then one idempotent write is timed —
    // setConfig({name: cfg.name}) round-trips through the real ping-chased,
    // watchdog-instrumented write path on purpose: the sample updating the
    // per-host baseline via onWriteLatency is desired (the health gate and
    // the ordinary watchdog should agree on what "normal" looks like), and a
    // possible duplicate stderr warning here — the watchdog's own hook firing
    // on this same sample, on top of the refusal thrown below — is an
    // accepted redundancy, not a bug.
    const cfg = await preDelete('reading device config', () => this.getConfig());
    const gateT0 = Date.now();
    await preDelete('the health-check write (setConfig)', () => this.setConfig({ name: cfg.name }));
    const gateMs = Date.now() - gateT0;
    if (opts.healthGate) {
      const gate = opts.healthGate(gateMs);
      if (!gate.ok) {
        // gate.message is optional in the d.mts (a caller-supplied gate may
        // omit it) — guard the interpolation rather than printing "undefined".
        const reason = gate.message ?? `health-check write took ${Math.round(gateMs)}ms.`;
        throw new Error(
          `defrag: refusing — ${reason} A board already grinding may not survive the delete phase ` +
          `(the incident board's own deletes never completed) — this is a triage situation, not a defrag one. ` +
          `Storage before: ${before.storageUsed}/${before.storageSize} bytes. ` +
          `A fresh, decode-verified backup is at ${backupFile} — the only write since was the health check itself ` +
          `(setConfig({name}), already sent and persisted); nothing was deleted.`
        );
      }
    }

    // (4) Delete loop. Classifies the BACKUP's own key set, not a fresh
    // /list() — the structural invariant this whole command leans on:
    // nothing is ever deleted unless it was already captured and
    // decode-verified in the backup taken in step (1).
    const { deletable, kept } = classifyForDefrag(Object.keys(files));
    for (let i = 0; i < deletable.length; i++) {
      const p = deletable[i];
      const res = await fetch(`http://${this.host}/delete?path=${encodeURIComponent(p)}`);
      if (!res.ok) {
        throw new Error(
          `defrag: failed to delete ${p} (${i + 1}/${deletable.length}) — GET /delete -> ${res.status}. ` +
          `A verified backup is at ${backupFile}; recover with: pbz restore ${backupFile} --yes`
        );
      }
    }

    // (5) Restore from the SAME backup just taken. No opts.prune — moot
    // here, not merely omitted: prune deletes on-device files absent from
    // the backup, and the delete loop above already removed exactly the
    // files a prune pass would otherwise go looking for, so it would find
    // nothing to do.
    let restoreRes;
    try {
      restoreRes = await this.restoreBackup(backupFile);
    } catch (e) {
      throw new Error(
        `defrag: deleted ${deletable.length}/${deletable.length} files, but restore failed (${e.message}) — ` +
        `a verified backup is at ${backupFile}; retry with: pbz restore ${backupFile} --yes`
      );
    }

    // restoreBackup() already POSTed /reboot; that only sends the request —
    // it does not wait for the device to actually come back. Verifying
    // against a stale pre-reboot connection would silently check the wrong
    // state, so wait first.
    try {
      await this._waitForReboot(opts.rebootTimeoutMs, opts.rebootPollMs);
    } catch (e) {
      throw new Error(
        `defrag: restore posted ${restoreRes.restored} files and rebooted, but the device did not come back to verify (${e.message}) — ` +
        `the .pbb at ${backupFile} matches what was sent; check manually: pbz list --host=${this.host}`
      );
    }

    // (6) Verify both directions: nothing missing, nothing extra.
    const afterPatterns = await this.list();
    const beforeIds = new Set(beforePatterns.map(r => r.id));
    const afterIds = new Set(afterPatterns.map(r => r.id));
    const missing = [...beforeIds].filter(id => !afterIds.has(id));
    const extra = [...afterIds].filter(id => !beforeIds.has(id));
    if (missing.length || extra.length) {
      throw new Error(
        `defrag: pattern inventory mismatch after restore` +
        (missing.length ? ` — missing: ${missing.join(', ')}` : '') +
        (extra.length ? ` — extra: ${extra.join(', ')}` : '') +
        `. A verified backup is at ${backupFile}; investigate before trusting the device.`
      );
    }
    const after = await this.getStatus();

    return {
      file: backupFile,
      count: Object.keys(files).length,
      deleted: deletable.length,
      kept: kept.length,
      restored: restoreRes.restored,
      before: { storageUsed: before.storageUsed, storageSize: before.storageSize },
      after: { storageUsed: after.storageUsed, storageSize: after.storageSize },
      patterns: afterPatterns,
    };
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
