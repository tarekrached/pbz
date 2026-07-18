// Build the saved-pattern thumbnail: a JPEG "waterfall" — x = LEDs, y = successive
// render iterations (time). Firmware requires a valid JPEG here; an empty one makes
// the web UI throw "trouble loading preview images" and drop to /?min.
import { createRequire } from 'node:module';
const encodeJPEG = createRequire(import.meta.url)('./jpeg-encoder.cjs'); // vendored, pure-JS

export const PREVIEW_W = 170, PREVIEW_H = 150;
export function buildPreviewJPEG(frames) {
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
