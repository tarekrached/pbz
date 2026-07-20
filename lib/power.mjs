// Power budget -> brightness-cap solver (Chunk 11), plus a live per-frame
// power estimator (Chunk 12). Pure arithmetic on a parsed power.json (see
// ../power.json) and, for the estimator, sampled preview frames — no device
// I/O itself, hermetically testable. Chunk 11's solver derives the static
// maxBrightness that keeps the install's worst-case draw (all-four-channel,
// full brightness) under whichever link in the PSU/breaker/wire/connector
// chain is weakest (CLAUDE.md invariant #3). Chunk 12's estimator scores an
// actual running/candidate pattern's real draw, which is normally well under
// that worst case — it advises, it isn't the safety backstop (the cap above
// and the physical fuse/breaker are).

// The protection-chain links, each expressed as an amp ceiling, plus the
// PSU's own rating. Returns every link and which one is weakest (binds).
export function budgetChain(power) {
  const links = [
    { name: 'PSU (Mean Well ' + power.psu.model.replace(/^Mean Well /, '') + ')', amps: power.psu.rated_amps },
    { name: 'DIN-4 output socket (Kycon KPJX-CM-4S)', amps: power.protection_chain.din4_socket_amps },
    { name: 'breaker', amps: power.protection_chain.breaker_amps },
    { name: '16 AWG ring bus', amps: power.protection_chain.ring_wire_amps },
    { name: 'feed leg', amps: power.protection_chain.feed_leg_amps },
    { name: 'connector (Wago 221-415)', amps: power.protection_chain.connector_amps },
  ];
  const binding = links.reduce((min, l) => (l.amps < min.amps ? l : min));
  return { links, binding };
}

// Derive the maxBrightness percent that keeps all-four-max draw under the
// binding link, with `power.margin` headroom on top. No preview frames, no
// gamma model — the measured all_four_max_amps endpoint already folds in
// gamma/efficiency (CLAUDE.md invariant #3 / PBZ-PLAN Chunk 11).
export function solveCapPercent(power) {
  const { links, binding } = budgetChain(power);
  const rawPct = (binding.amps / power.measured.all_four_max_amps) * 100;
  const pct = Math.max(0, Math.min(100, Math.floor(rawPct * power.margin)));
  return { pct, rawPct, links, binding, budgetAmps: binding.amps, allFourMaxAmps: power.measured.all_four_max_amps, margin: power.margin };
}

// --- Chunk 12: live power analysis ---
//
// Per-channel full-strip current at true 100% (byte value 255), derived from
// the README bench table (channel_bench_w_per_100px) scaled to the installed
// pixel count. Divided by pixel_count this is the per-pixel-per-channel amp
// coefficient estimateFrameAmps() sums over a sampled frame.
export function channelFullAmps(power) {
  const w100 = power.measured.channel_bench_w_per_100px;
  const scale = power.pixel_count / 100 / power.supply_voltage_v;
  return { r: w100.r * scale, g: w100.g * scale, b: w100.b * scale, w: w100.w * scale };
}

// Estimate instantaneous current for one raw preview frame (binary type-5:
// 1-byte header + pixelCount x [r,g,b], 0..255). Verified live (PBZ-PLAN.md
// Chunk 12, 2026-07-18) that this stream is PRE-brightness (the global
// brightness slider and the maxBrightness cap do not scale it) and
// PRE-W-extraction (rgb(1,1,1) reads back as (255,255,255), not reduced) — so
// both must be applied here, not assumed already baked in:
//   - `brightnessFactor` is the caller-supplied effective scale actually
//     driven to the LEDs (brightness x maxBrightness/100); default 1 assumes
//     the frame values ARE final (e.g. a caller that already scaled them).
//   - W-extraction: firmware routes min(r,g,b) through the dedicated W
//     element rather than driving R+G+B independently (README "Why W-only is
//     the basis" — rgb(1,1,1) measures as ONE channel, not three). Modeling
//     this is the whole point of Chunk 12: naive R+G+B summing on a white
//     pixel overestimates its draw ~3x.
export function estimateFrameAmps(frame, power, brightnessFactor = 1) {
  const { r: R, g: G, b: B, w: W } = channelFullAmps(power);
  const pixelCount = (frame.length - 1) / 3;
  const px = frame.subarray(1);
  let amps = power.measured.idle_amps;
  for (let i = 0; i < pixelCount; i++) {
    const r = px[i * 3] * brightnessFactor, g = px[i * 3 + 1] * brightnessFactor, b = px[i * 3 + 2] * brightnessFactor;
    const w = Math.min(r, g, b);
    amps += ((r - w) * R + (g - w) * G + (b - w) * B + w * W) / 255 / power.pixel_count;
  }
  return amps;
}

// Peak + mean draw across sampled frames, plus how that compares to the
// protection chain's binding link (budgetChain — the raw link amps, no
// margin: margin is for sizing the static worst-case cap in solveCapPercent,
// not for reporting an actual measured/estimated draw).
export function estimateDraw(frames, power, brightnessFactor = 1) {
  const amps = frames.map(f => estimateFrameAmps(f, power, brightnessFactor));
  const peakAmps = Math.max(...amps), meanAmps = amps.reduce((a, b) => a + b, 0) / amps.length;
  const { binding } = budgetChain(power);
  return {
    peakAmps, meanAmps,
    peakWatts: peakAmps * power.supply_voltage_v, meanWatts: meanAmps * power.supply_voltage_v,
    budgetAmps: binding.amps, bindingLink: binding.name,
    peakPctOfBudget: (peakAmps / binding.amps) * 100, meanPctOfBudget: (meanAmps / binding.amps) * 100,
  };
}
