// Pixelblaze bytecode + .pbp (Pixelblaze Binary Pattern) wire-format serialization.
// Byte-for-byte identical to what the web UI's Save button sends — see
// tools/test/golden-bytes.test.mjs, the merge gate for this refactor.
import crypto from 'node:crypto';
import path from 'node:path';

export function buildBytecode({ compiled, exports }) {
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
/**
 * Pixelblaze Binary Pattern: 36-byte header (9 LE u32) + name + jpeg + bytecode + lz(source)
 */
export function buildPBP(name, sourceCode, bytecode, lzCompress, previewJpeg = Buffer.alloc(0)) {
  const nameB = Buffer.from(name, 'utf8');
  const srcB = lzCompress(JSON.stringify({ main: sourceCode }));
  const header = Buffer.allocUnsafe(36);
  let nameOff = 36, jpegOff = nameOff + nameB.length, byteOff = jpegOff + previewJpeg.length, srcOff = byteOff + bytecode.length;
  const u = [2, nameOff, nameB.length, jpegOff, previewJpeg.length, byteOff, bytecode.length, srcOff, srcB.length];
  u.forEach((v, i) => header.writeUInt32LE(v >>> 0, i * 4));
  return Buffer.concat([header, nameB, previewJpeg, bytecode, srcB]);
}

export const ID_CHARS = '23456789ABCDEFGHJKLMNPQRSTWXYZabcdefghijkmnopqrstuvwxyz';
export function stableId(seed) { // deterministic 17-char id so re-saving a file updates in place
  const h = crypto.createHash('sha1').update(seed).digest();
  let out = '';
  for (let i = 0; i < 17; i++) out += ID_CHARS[h[i] % ID_CHARS.length];
  return out;
}
export function prettyName(file) {
  return path.basename(file).replace(/\.js$/, '').replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
