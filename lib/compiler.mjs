// Pulls the pattern COMPILER and LZString source-packer out of the device's own
// web UI (Ben Hencke's code) and runs them headless in node:vm. Because the
// compiler comes from the device, it always matches the installed firmware.
// No browser, no Python — this is what makes the class able to compile at all.
import zlib from 'node:zlib';
import vm from 'node:vm';

export async function fetchWebUI(host) {
  const res = await fetch(`http://${host}/index.html.gz`);
  if (!res.ok) throw new Error(`GET /index.html.gz -> ${res.status}`);
  return zlib.gunzipSync(Buffer.from(await res.arrayBuffer())).toString('utf8').replace(/^﻿/, '');
}
function sub(text, startValue, endValue) {
  const start = text.indexOf(startValue);
  if (start < 0) throw new Error(`web UI marker not found: ${startValue}`);
  const finish = text.indexOf(endValue, start);
  if (finish < 0) throw new Error(`web UI end marker not found: ${endValue}`);
  return text.slice(start, finish);
}
// brace-match a `{...}` object literal starting at `openBraceIdx`, skipping string contents
function matchBraces(text, openBraceIdx) {
  let depth = 0, quote = null;
  for (let i = openBraceIdx; i < text.length; i++) {
    const ch = text[i];
    if (quote) { if (ch === '\\') { i++; continue; } if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i;
  }
  throw new Error('unbalanced braces while extracting from web UI');
}

// Build a compile(src)->{compiled,exports} function using the device's own compiler (v3.5+ web UI).
export function makeCompiler(html) {
  const hardwareVariant = 'var ' + sub(html, 'hardwareVariant=', ',varWatcherPoller') + ';';
  const extendedOperators = sub(html, 'extendedOperators={', ',lastErrorMarkers=') + ';';
  const constants = 'var constants;' + sub(html, '"ESP8266"===hardwareVariant&&', ',[])') + ';';
  let compilerScript = '';
  { // the <script> block that defines window.compile
    let rest = html;
    while (rest.length) {
      const a = rest.indexOf('<script>'); if (a < 0) break;
      const after = rest.slice(a + 8); const b = after.indexOf('</script>');
      const s = b < 0 ? after : after.slice(0, b);
      if (s.includes('window.compile')) { compilerScript = s; break; }
      rest = b < 0 ? '' : after.slice(b + 9);
    }
    if (!compilerScript) throw new Error('compiler (window.compile) not found in web UI');
  }
  const ctx = vm.createContext({ window: {}, console });
  vm.runInContext(
    'var predefinedGlobals=["pixelCount"];\n' + hardwareVariant + '\n' + constants + '\n' +
    extendedOperators + '\n' + compilerScript + ';\n' +
    `function __compile(src){
       var p = window.compile(src, {predefinedGlobals:predefinedGlobals, extendedOperators:extendedOperators, constants:constants});
       function surface(l){ return Object.keys(l).reduce(function(r,k){return r.concat(l[k]);}, []); }
       return { compiled: p.compiled, exports: surface(p.exports).map(function(s){return {address:s.address,name:s.name};}) };
     }`, ctx, { filename: 'pb-compiler.js' });
  return (src) => {
    ctx.__src = src;
    try { return vm.runInContext('__compile(__src)', ctx); }
    catch (ex) {
      const where = ex.lineNumber != null ? ` at line ${ex.lineNumber} col ${ex.column}` : '';
      throw new Error(`Pixelblaze compile error: ${ex.description || ex.message}${where}`);
    }
  };
}

// Load the device's own LZString object into a fresh vm context (shared by
// makeLZ and makeLZDecompress below).
function loadLZString(html) {
  const vAnchor = html.indexOf('var v=String.fromCharCode,');
  const start = html.lastIndexOf('function n(t,e){', vAnchor);
  const sObj = html.indexOf('s={', vAnchor);
  if (vAnchor < 0 || start < 0 || sObj < 0) throw new Error('LZString not found in web UI');
  const snippet = html.slice(start, matchBraces(html, sObj + 2) + 1) + ';';
  const ctx = vm.createContext({});
  vm.runInContext(snippet, ctx, { filename: 'lzstring.js' });
  return ctx;
}

// Build lzCompress(str)->Uint8Array using the device's own LZString.compressToUint8Array.
export function makeLZ(html) {
  const ctx = loadLZString(html);
  vm.runInContext('globalThis.__lz = (x)=>Array.from(s.compressToUint8Array(x));', ctx);
  return (str) => Buffer.from(vm.runInContext('__lz', ctx)(str));
}

// Build lzDecompress(bytes)->str, the inverse of makeLZ (LZString.decompressFromUint8Array) —
// needed to read a saved pattern's source back off the device (export).
export function makeLZDecompress(html) {
  const ctx = loadLZString(html);
  vm.runInContext('globalThis.__lzd = (arr)=>s.decompressFromUint8Array(Uint8Array.from(arr));', ctx);
  return (bytes) => vm.runInContext('__lzd', ctx)(Array.from(bytes));
}
