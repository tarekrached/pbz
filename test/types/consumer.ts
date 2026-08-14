// Signature guard, positive half: exercises every declared method with
// realistic arguments. Anything that fails to compile here is a bug in
// lib/pixelblaze.d.mts, not in this file.
//
// `npm test` checks that the declarations cover the right member SET. It cannot
// check that a signature is right, which is what this file is for. Run both
// with `npm run typecheck`.
import { Pixelblaze } from '../../lib/pixelblaze.mjs';
import type { DeviceInfo, PlaylistItem, DiscoveredDevice, ControlValue, PixelblazeOptions, DefragResult } from '../../lib/pixelblaze.mjs';

export async function exerciseEveryMethod() {
  const pb = new Pixelblaze('192.168.1.50');

  // The onWriteLatency constructor option (PBZ-PLAN.md Chunk 26) — a
  // constructor option, not a class member, so it's exercised here rather
  // than against `pb` itself.
  const opts: PixelblazeOptions = {
    onWriteLatency: (op: string, ms: number) => { void op; void ms; },
  };
  const pbWithWatchdog = new Pixelblaze('192.168.1.51', opts);
  pbWithWatchdog.close();

  const host: string = pb.host;

  const { program, bytecode } = await pb.compile('export function render(i){hsv(0,1,1)}');
  const opcodes: number[] = program.compiled;
  const firstExport: string = program.exports[0].name;
  const bytecodeLen: number = bytecode.length;

  await pb.run('src');
  const saved = await pb.save('src', 'Name', { id: 'abc' });
  const savedId: string = saved.id;
  const rawFrames: Buffer[] = saved.rawFrames;

  const rows = await pb.list();
  const rowName: string = rows[0].name;
  await pb.activate('Name');
  await pb.delete('Name');

  const sources = await pb.getSources('id');
  const mainSrc: string = sources.main;
  const thumb: Buffer = await pb.getPreviewImg('id');
  const exported = await pb.export('Name');
  const epeName: string = exported.epe.name;
  await pb.import('foo.epe');

  const state = await pb.getState();
  const controls: Record<string, ControlValue> = state.controls;
  await pb.setControls({ sliderSpeed: 0.4, rgbPickerHours: [1, 0, 0] });
  await pb.setVars({ phase: 0.25 });
  const vars: Record<string, unknown> = await pb.getVars();

  const brightness: number = await pb.setBrightness(0.5, { save: true });
  const cap: number = await pb.setMaxBrightness(55);

  const cfg = await pb.getConfig();
  const pixelCount: number | undefined = cfg.pixelCount;
  const colorOrder: string | undefined = cfg.colorOrder;
  await pb.setConfig({ colorOrder: 'WRGB', pixelCount: 170 });

  await pb.setSequencerMode(2);
  const running: boolean = await pb.setSequencerState(false);
  await pb.nextPattern();
  const playlist = await pb.getPlaylist();
  const items: PlaylistItem[] = playlist.items;
  await pb.setPlaylist([{ id: 'x', ms: 5000 }]);

  const status = await pb.getStatus();
  const fps: number | undefined = status.fps;
  const peers = await pb.getPeers();
  const info: DeviceInfo = await pb.getInfo();
  const sensorBoard: boolean = info.expansion.sensorBoard;
  const role: 'Leader' | 'Follower' | 'Solo' = info.groupRole;
  const infoFps: number | undefined = info.fps;
  const infoName: string | undefined = info.name;

  // The overload is the interesting part: `coords` changes the return type.
  const mapSource: string = await pb.getMap();
  const mapSourceEmptyOpts: string = await pb.getMap({});
  const coords: number[][] = await pb.getMap({ coords: true });
  const firstX: number = coords[0][0];
  await pb.setMap('[[0,0],[1,1]]');

  const backup = await pb.saveBackup();
  const backupCount: number = backup.count;
  const restored = await pb.restoreBackup('f.pbb', { prune: true });
  const pruned: string[] = restored.pruned;
  await pb.backupFsImage('img.bin');

  const defragResult: DefragResult = await pb.defrag('f.pbb', {
    // message is optional on the {ok:false} shape — the omitted-message
    // branch below is what defrag()'s own `gate.message ?? …` guard exists
    // to handle; a gate that always supplies one would never exercise it.
    healthGate: (sampleMs: number) => {
      if (sampleMs < 2000) return { ok: true };
      if (sampleMs > 10000) return { ok: false };
      return { ok: false, message: 'too slow' };
    },
    rebootTimeoutMs: 45000,
    rebootPollMs: 1000,
  });
  const defragNoArgs: DefragResult = await pb.defrag();
  const defragDeleted: number = defragResult.deleted;
  const defragKept: number = defragResult.kept;
  const defragPatterns = defragResult.patterns;
  const defragPatternName: string = defragPatterns[0].name;

  await pb.reboot();
  const latency: number = await pb.ping();

  const found: DiscoveredDevice[] = await Pixelblaze.discover(3000);
  const address: string = found[0].address;

  const frames: Buffer[] = await pb.samplePreview(30);
  const tooling = await pb.loadTooling();
  const compiled = tooling.compile('src');
  const compiledOps: number[] = compiled.compiled;

  pb.close();

  return {
    host, opcodes, firstExport, bytecodeLen, savedId, rawFrames, rowName, mainSrc,
    thumb, epeName, controls, vars, brightness, cap, pixelCount, colorOrder,
    running, items, fps, peers, sensorBoard, role, infoFps, infoName, mapSource,
    mapSourceEmptyOpts, firstX, backupCount, pruned, latency, address, frames,
    compiledOps, state, cfg, status, playlist, info, saved, exported, sources,
    defragResult, defragNoArgs, defragDeleted, defragKept, defragPatterns, defragPatternName,
  };
}
