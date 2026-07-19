// Pixel-map source evaluation + binary PIXELMAP (type 8) frame packing —
// pure, deterministic (no device I/O), so it's TDD'd directly with fixtures
// (see test/map.test.mjs), mirroring lib/pbp.mjs's buildBytecode/buildPBP.
// The min/max-normalization math itself lives in lib/compiler.mjs's
// makeNormalizeMap (extracted from the web UI, not reimplemented here — see
// its own comment for why).
import vm from 'node:vm';

// Mirrors the web UI's updateMapper(): try JSON first (a raw coordinate
// array, e.g. `[[0,0],[1,0],…]`); otherwise the text is a JS expression
// assigned to `map` — a function(pixelCount) or an array literal — run
// headless exactly like the web UI's map-eval Worker.
export function evalMapSource(source, pixelCount) {
  try { return JSON.parse(source); } catch { /* not JSON — a JS expression */ }
  const ctx = vm.createContext({ pixelCount });
  return vm.runInContext(
    `(function(){ var map = ${source}\n; return typeof map === 'function' ? map(pixelCount) : map; })()`,
    ctx, { filename: 'pixelmap-source.js' });
}

// Binary PIXELMAP frame body (chunked over the wire by protocol.mjs's
// sendBytecode(frame, 8), same [type][flag] framing as every other binary
// send): Uint32LE[2, dimensions, byteLength] header + Uint16LE coordinates,
// row-major (pixel 0's dims, then pixel 1's, …). Byte-for-byte what the web
// UI's own sendMap() builds (PBZ-PLAN.md Appendix; the leading `2` is a
// fixed format marker in Ben Hencke's own code, not something pbz chose).
export function buildPixelMapFrame(pixelMap, dimensions) {
  const flatLen = pixelMap.length * dimensions;
  const data = Buffer.allocUnsafe(flatLen * 2);
  let o = 0;
  for (const p of pixelMap) for (let d = 0; d < dimensions; d++) data.writeUInt16LE(p[d] || 0, (o++) * 2);
  const header = Buffer.allocUnsafe(12);
  header.writeUInt32LE(2, 0);
  header.writeUInt32LE(dimensions, 4);
  header.writeUInt32LE(data.length, 8);
  return Buffer.concat([header, data]);
}
