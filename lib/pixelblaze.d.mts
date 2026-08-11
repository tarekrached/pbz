// Type declarations for the Pixelblaze class.
//
// Honesty rules these follow, because a declaration that lies is worse than no
// declaration at all (your editor will confidently autocomplete a field the
// device never sends):
//
//   1. Read methods that pass a wire response through are declared with the
//      fields actually observed on firmware v3.67, plus an index signature.
//      The device may send more than is listed; it will not send less.
//   2. Fields whose types were never verified are not invented. Where a shape
//      is genuinely opaque (compiled bytecode operands, .epe `sources`) it is
//      declared opaque rather than guessed at.
//   3. `test/types.test.mjs` asserts this file declares exactly the methods the
//      class actually has, so adding a method without declaring it fails the
//      suite instead of silently rotting.

/** One row from `list()`. */
export interface PatternRow {
  id: string;
  name: string;
}

/** A control or variable exported by a pattern. Picker controls are 3-element arrays. */
export type ControlValue = number | [number, number, number];

/**
 * Compiler output for one pattern. `compiled` is the raw opcode array produced
 * by the device's own compiler; treat it as opaque and hand it back rather than
 * interpreting it.
 */
export interface Program {
  compiled: number[];
  exports: Array<{ address: number; name: string }>;
}

/**
 * Flat device + LED settings, as returned by `getConfig()`. There is no wrapper
 * key on the wire and field names are passed through unrenamed.
 *
 * Every field is optional because the set genuinely varies with firmware and
 * hardware: `exp` only means something with an expansion board, `leaderId` only
 * appears in a sync group, and newer firmware adds keys this was never tested
 * against. Check before you use.
 */
export interface DeviceConfig {
  name?: string;
  brandName?: string;
  /** Firmware version, e.g. "3.67". */
  ver?: string;
  chipId?: number;
  pixelCount?: number;
  /** e.g. "GRB", "WRGB". Getting this wrong makes patterns render subtly wrong. */
  colorOrder?: string;
  ledType?: number;
  dataSpeed?: number;
  cpuSpeed?: number;
  /** 0..1. */
  brightness?: number;
  /** 0..100 percent, not 0..1. The firmware's hardware ceiling. */
  maxBrightness?: number;
  /** 0 Off, 1 ShuffleAll, 2 Playlist. */
  sequencerMode?: number;
  /** Auto-advance running/paused. Readable, which is what makes `seq pause` assertable. */
  runSequencer?: boolean;
  /** Advance interval in SECONDS, not milliseconds. The firmware refuses values below 1. */
  sequenceTimer?: number;
  /** Expansion-board bitmask: bit 1 = Sensor Board 1.0, bit 2 = six-axis. */
  exp?: number;
  /** Pixel-map fit mode, consumed by `getMap({coords:true})` and `setMap()`. */
  mapperFit?: number;
  discoveryEnable?: boolean;
  networkPowerSave?: boolean;
  timezone?: string;
  autoOffEnable?: boolean;
  /** "HH:MM". */
  autoOffStart?: string;
  /** "HH:MM". */
  autoOffEnd?: string;
  simpleUiMode?: boolean;
  /** Set only when this device follows another in a sync group. */
  leaderId?: number;
  [key: string]: unknown;
}

/**
 * The unsolicited status frame every connection receives roughly once a second.
 * Fields are the v3.67 wire names, pinned by `test/status.test.mjs`.
 */
export interface DeviceStatus {
  fps?: number;
  /** Free pattern memory. */
  mem?: number;
  /** Milliseconds since boot. */
  uptime?: number;
  storageUsed?: number;
  storageSize?: number;
  /** Pattern VM error code; 0 is healthy. */
  vmerr?: number;
  vmerrpc?: number;
  exp?: number;
  renderType?: number;
  rr0?: number;
  rr1?: number;
  rebootCounter?: number;
  [key: string]: unknown;
}

/** One entry in the sync-group peer list. */
export interface Peer {
  isFollowing?: boolean;
  [key: string]: unknown;
}

/**
 * `getInfo()` output: config and status merged, plus the two derived fields.
 * Only decodes the caller shouldn't have to repeat are added here; cosmetic
 * formatting (uptime as H:MM:SS, and so on) is the caller's job.
 */
export interface DeviceInfo extends DeviceConfig, DeviceStatus {
  /** Decoded from the `exp` bitmask. */
  expansion: { sensorBoard: boolean; sixAxis: boolean };
  groupRole: 'Leader' | 'Follower' | 'Solo';
  peers: Peer[];
}

/** The device's single shared playlist, `_defaultplaylist_`. Wire names intact. */
export interface Playlist {
  /** Index of the currently running item. Known to lag `nextPattern()`; assert on `getState()` instead. */
  position?: number;
  id?: string;
  ms?: number;
  remainingMs?: number;
  items: PlaylistItem[];
  [key: string]: unknown;
}

export interface PlaylistItem {
  id: string;
  /** Duration in MILLISECONDS, unlike `sequenceTimer`. */
  ms: number;
}

/** A device found by `Pixelblaze.discover()`. */
export interface DiscoveredDevice {
  address: string;
  /** Hex, matching `getConfig().chipId`. */
  chipId: string;
  /** The beacon's own uptime-ms field. */
  lastSeen: number;
}

/**
 * A pattern's source, as stored on the device. `main` is the JS; `blockly` is
 * present only for Blockly-authored patterns and is not interpreted here.
 */
export interface PatternSources {
  main: string;
  blockly?: unknown;
  [key: string]: unknown;
}

/** The `.epe` export shape, byte-identical to what the web UI's Export writes. */
export interface EpeFile {
  name: string;
  id: string;
  sources: PatternSources;
  /** JPEG thumbnail, base64. */
  preview: string;
}

export interface SaveResult {
  id: string;
  program: Program;
  bytecode: Buffer;
  /** Number of preview frames captured for the thumbnail. */
  frames: number;
  /** Those frames as raw wire bytes, for feeding a power estimate. */
  rawFrames: Buffer[];
  previewBytes: number;
}

export declare class Pixelblaze {
  /**
   * @param host Address or hostname. This class takes a host and nothing else:
   *   no argv, no config files, no environment. Resolution is the caller's job.
   */
  constructor(host: string);

  readonly host: string;

  /**
   * Close the shared websocket. Safe to call if it was never opened, and safe
   * to call twice. An instance holds ONE connection and reuses it across calls;
   * not closing leaves the event loop alive until a 10 s idle timer fires.
   */
  close(): void;

  /** Fetch and build this device's compiler, LZString packer and map normalizer. Cached per instance. */
  loadTooling(): Promise<{
    compile: (source: string) => Program;
    lz: (text: string) => Buffer;
    lzDecompress: (buf: Buffer) => string;
    normalizeMap: (raw: number[][], fit?: number) => { pixelMap: number[][]; dimensions: number };
  }>;

  /** Compile locally. Sends nothing to the device. */
  compile(source: string): Promise<{ program: Program; bytecode: Buffer }>;

  /** Compile and push live, replacing the running program. NOT saved; gone on reboot. */
  run(source: string): Promise<{ program: Program; bytecode: Buffer }>;

  /**
   * Sample `n` live preview frames off whatever is currently running, without
   * disturbing it. Raw wire bytes: a 1-byte header then pixelCount x [r,g,b].
   * PRE-brightness and PRE-W-extraction, so a caller estimating power must
   * apply both itself.
   */
  samplePreview(n?: number): Promise<Buffer[]>;

  /**
   * Compile, save to the pattern list, and activate.
   * @param opts.id Pass a stable id derived from the source's identity (its
   *   filename, say) so re-saving updates the same entry instead of piling up
   *   duplicates. Derived from `name` if omitted.
   */
  save(source: string, name: string, opts?: { id?: string }): Promise<SaveResult>;

  /** Saved patterns, id and name. */
  list(): Promise<PatternRow[]>;

  /** Switch the active pattern. `target` may be an id or a name (case-insensitive). */
  activate(target: string): Promise<PatternRow>;

  /** Delete a saved pattern. Fire-and-forget; the device sends no acknowledgement. */
  delete(target: string): Promise<PatternRow>;

  getSources(id: string): Promise<PatternSources>;

  /** The saved thumbnail as JPEG bytes. */
  getPreviewImg(id: string): Promise<Buffer>;

  /** Write a `.epe`. Defaults to `<name>.epe` in the working directory. */
  export(target: string, file?: string): Promise<{ file: string; epe: EpeFile }>;

  /** Recompile a `.epe`'s source locally and save it, reusing its original id. */
  import(file: string): Promise<SaveResult>;

  /** The active pattern's current variables and controls. */
  getState(): Promise<{
    vars: Record<string, unknown>;
    name?: string;
    id?: string;
    controls: Record<string, ControlValue>;
  }>;

  /** The active pattern's exported `export var` values. */
  getVars(): Promise<Record<string, unknown>>;

  /** Set exported pattern variables. Distinct from `setControls`, which drives the UI sliders. */
  setVars(obj: Record<string, unknown>): Promise<Record<string, unknown>>;

  /** Tune the active pattern's UI controls. Sliders are 0..1, toggles 0/1, pickers 3-element arrays. */
  setControls(controls: Record<string, ControlValue>): Promise<void>;

  /**
   * The ordinary dimmer, 0..1. Ephemeral unless `opts.save`, matching the web
   * UI slider. Returns the clamped value actually sent.
   */
  setBrightness(value: number, opts?: { save?: boolean }): Promise<number>;

  /**
   * The firmware brightness ceiling, 0..100 PERCENT (not 0..1). Always
   * persisted. This is the power-safety cap: it clamps hardware output
   * regardless of what the pattern or the dimmer asks for.
   */
  setMaxBrightness(pct: number): Promise<number>;

  getConfig(): Promise<DeviceConfig>;

  /** Plain config fields persist on receipt; there is no separate save step. */
  setConfig(obj: Partial<DeviceConfig>): Promise<Partial<DeviceConfig>>;

  /** 0 Off, 1 ShuffleAll, 2 Playlist. */
  setSequencerMode(mode: 0 | 1 | 2): Promise<number>;

  /**
   * Pause or resume auto-advance without leaving the current mode. Readable
   * back via `getConfig().runSequencer`, but not immediately: allow around
   * 400 ms before reading, or you will get the stale value.
   */
  setSequencerState(run: boolean): Promise<boolean>;

  /** Advance immediately. No acknowledgement; check `getState()` for what it landed on. */
  nextPattern(): Promise<void>;

  getPlaylist(): Promise<Playlist>;

  /** Replace the playlist's items wholesale and persist. */
  setPlaylist(items: PlaylistItem[]): Promise<PlaylistItem[]>;

  /** The unsolicited status frame. Waits for the next one; no request is sent. */
  getStatus(): Promise<DeviceStatus>;

  getPeers(): Promise<Peer[]>;

  /** Config, status and peers combined, plus `expansion` and `groupRole`. */
  getInfo(): Promise<DeviceInfo>;

  /** The pixel-map source text: the human-readable, committable form. */
  getMap(opts?: { coords?: false }): Promise<string>;
  /**
   * The normalized `[x, y]` render coordinates the device actually draws with,
   * computed through the same headless path `setMap()` uses. This is how you
   * check that live geometry matches a committed map source.
   */
  getMap(opts: { coords: true }): Promise<number[][]>;

  /**
   * Push the render geometry live AND persist the source text. Both halves
   * matter: a text-only upload leaves the actual rendering stale until someone
   * opens the Mapper tab and re-saves by hand.
   */
  setMap(text: string): Promise<{ pixelCount: number; dimensions: number }>;

  /**
   * Snapshot every file on the device into one JSON `.pbb`. Skips the `*.gz`
   * web-app blobs and verifies each fetched file against the size the device
   * reported. Defaults to `<devicename>-<date>.pbb`. WiFi config is never
   * included, by the firmware's design.
   */
  saveBackup(file?: string): Promise<{ file: string; count: number }>;

  /**
   * POST every file in a `.pbb` back, then reboot. Overwrite-only by default,
   * which is gentler than the web UI's own restore; `opts.prune` also deletes
   * on-device files the backup doesn't contain.
   */
  restoreBackup(file: string, opts?: { prune?: boolean }): Promise<{ restored: number; pruned: string[] }>;

  /**
   * The separate, heavier device-side full-flash image. LEDs go dark while it
   * writes, and restoring it means holding the button at power-up, not
   * `restoreBackup`. Deliberate use only.
   */
  backupFsImage(file: string): Promise<{ file: string; bytes: number }>;

  /** Restart. HTTP POST, not a websocket message. Drops off the network for several seconds. */
  reboot(): Promise<void>;

  /** Round-trip latency in milliseconds. */
  ping(): Promise<number>;

  /**
   * Listen for UDP beacons on port 1889 for `ms` and return the distinct
   * devices heard. Static, because finding a host is the point. Listen-only:
   * it broadcasts nothing. Requires `discoveryEnable` on the devices.
   */
  static discover(ms?: number): Promise<DiscoveredDevice[]>;
}
