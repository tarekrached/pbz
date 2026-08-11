// Hermetic guards for the pixel-map path (PBZ-PLAN.md Chunk 8): source
// evaluation and type-8 frame packing are pure (test-first, no device);
// normalizeMap runs offline against the same captured web UI golden-bytes.test.mjs
// uses (`npm run fixture`), mirroring Chunk 1's approach — no LAN needed since
// the extraction is deterministic given the same html. Unlike the golden bytes,
// these assert normalization BEHAVIOR rather than a byte snapshot, so any
// captured firmware will do.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeNormalizeMap } from '../lib/compiler.mjs';
import { evalMapSource, buildPixelMapFrame } from '../lib/map.mjs';
import { loadWebUI, CAPTURE_HINT } from './fixtures.mjs';

const ui = loadWebUI();
const skip = ui ? false : CAPTURE_HINT;
const html = ui?.html;

test('evalMapSource: raw JSON coordinate array', () => {
  const raw = evalMapSource('[[0,0],[1,0],[1,1]]', 3);
  assert.deepEqual(raw, [[0, 0], [1, 0], [1, 1]]);
});

test('evalMapSource: JS function(pixelCount) source, mirrors updateMapper()', () => {
  const src = 'function (pixelCount) { var map = []; for (var i = 0; i < pixelCount; i++) map.push([i, 0]); return map; }';
  const raw = evalMapSource(src, 4);
  // vm.createContext runs in a different realm, so plain arrays here aren't
  // Array.prototype-identical to this file's — flatten before comparing
  // (same workaround as golden-bytes.test.mjs).
  assert.deepEqual(JSON.parse(JSON.stringify(raw)), [[0, 0], [1, 0], [2, 0], [3, 0]]);
});

test('evalMapSource: JS array-literal expression (not wrapped in a function)', () => {
  const raw = evalMapSource('[[5,5],[6,6]]', 2);
  assert.deepEqual(JSON.parse(JSON.stringify(raw)), [[5, 5], [6, 6]]);
});

test('buildPixelMapFrame: byte-for-byte type-8 frame (header + row-major Uint16LE)', () => {
  // 3 pixels, 2 dimensions -> header [2, 2, 12] + 6 uint16s
  const frame = buildPixelMapFrame([[0, 0], [65535, 0], [65535, 65535]], 2);
  assert.equal(frame.toString('hex'), '02000000' + '02000000' + '0c000000' + '0000' + '0000' + 'ffff' + '0000' + 'ffff' + 'ffff');
});

test('makeNormalizeMap: Fill (fit=0) stretches each dimension independently to 0..65535', { skip }, () => {
  const normalizeMap = makeNormalizeMap(html);
  const { pixelMap, dimensions } = normalizeMap([[0, 0], [10, 0], [10, 20], [0, 20]], 0);
  assert.equal(dimensions, 2);
  // vm-realm arrays -> flatten before deepEqual (see evalMapSource tests above)
  assert.deepEqual(JSON.parse(JSON.stringify(pixelMap)), [[0, 0], [65535, 0], [65535, 65535], [0, 65535]]);
});

test('makeNormalizeMap: Contain (fit=1) preserves aspect ratio, centering the shorter axis', { skip }, () => {
  const normalizeMap = makeNormalizeMap(html);
  // x range 10, y range 20 (y is the larger span) -> x should be centered around 0.5 instead of hitting 0/1
  const { pixelMap } = normalizeMap([[0, 0], [10, 0], [10, 20], [0, 20]], 1);
  const flat = JSON.parse(JSON.stringify(pixelMap));
  const xs = flat.map(p => p[0]);
  const ys = flat.map(p => p[1]);
  assert.deepEqual(ys, [0, 0, 65535, 65535]); // dominant axis: untouched, still hits the extremes
  assert.ok(Math.min(...xs) > 0 && Math.max(...xs) < 65535, 'shorter axis should be centered, not touching 0/65535');
  assert.equal(xs[0], xs[3]); // x=0 column stays symmetric around the same center
});

test('makeNormalizeMap: repeated calls do not trigger the extracted code\'s own sendMap() side effect', { skip }, () => {
  const normalizeMap = makeNormalizeMap(html);
  // Would throw (sendMap/sendBlob/PacketType undefined in our headless context)
  // on the 2nd+ call if mapperSourceLoaded weren't reset each run.
  assert.doesNotThrow(() => {
    normalizeMap([[0, 0], [1, 1]], 0);
    normalizeMap([[0, 0], [1, 1]], 0);
    normalizeMap([[0, 0], [1, 1]], 1);
  });
});
