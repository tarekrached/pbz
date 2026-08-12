// Power budget -> brightness-cap solver (Chunk 11), plus a live per-frame
// power estimator (Chunk 12). Pure arithmetic on a parsed power.json (see
// ../power.example.json) and, for the estimator, sampled preview frames — no
// device I/O itself, hermetically testable. Chunk 11's solver derives the
// static maxBrightness that keeps the install's worst-case draw (every channel,
// full brightness) under whichever link in the supply/breaker/wire/connector
// chain is weakest. Chunk 12's estimator scores an actual running/candidate
// pattern's real draw, which is normally well under that worst case — it
// advises, it isn't the safety backstop (the cap above and the physical
// fuse/breaker are).

/**
 * The protection-chain links, each expressed as an amp ceiling, plus the
 * PSU's own rating. Returns every link and which one is weakest (binds).
 *
 * Links are read straight out of `protection_chain` rather than hardcoded, so
 * the chain describes YOUR build: add, drop, or rename links in power.json and
 * they show up in `pbz power budget` as written. Keys are printed with the
 * `_amps` suffix and underscores stripped; `_`-prefixed keys are treated as
 * commentary and skipped.
 */
export function budgetChain(power) {
  const psuAmps = power?.psu?.rated_amps;
  requirePositive(psuAmps, 'psu.rated_amps');
  const links = [{ name: `PSU (${power.psu.model || 'supply'})`, amps: psuAmps }];
  for (const [key, amps] of Object.entries(power.protection_chain ?? {})) {
    if (key.startsWith('_')) continue; // commentary
    // A non-number here used to be skipped silently, so a quoted "12" would
    // DELETE a link from the chain — and if it was the binding one, raise the
    // derived cap with nothing to show for it. Loud is the only safe option
    // when the output is a hardware power limit.
    if (typeof amps !== 'number' || !Number.isFinite(amps) || amps <= 0) {
      throw new Error(`power.json: protection_chain.${key} must be a positive number, got ${JSON.stringify(amps)}. Prefix a key with "_" if it is meant as a comment.`);
    }
    links.push({ name: key.replace(/_amps$/, '').replace(/_/g, ' '), amps });
  }
  const binding = links.reduce((min, l) => (l.amps < min.amps ? l : min));
  return { links, binding };
}

// Every number here feeds a hardware brightness cap, so a missing or nonsense
// value must stop the calculation rather than propagate. Left unchecked these
// produced a NaN cap (sent to the device as {"maxBrightness":null}) or an
// Infinity one clamped to 100 — presented as "derived" with no warning, which
// is worse than the hand-picked value it replaced.
function requirePositive(v, path) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
    throw new Error(`power.json: ${path} must be a positive number, got ${JSON.stringify(v)}`);
  }
}

/**
 * Derive the maxBrightness percent that keeps all-four-max draw under the
 * binding link, with `power.margin` headroom on top. No preview frames, no
 * gamma model — the measured all_four_max_amps endpoint already folds in
 * gamma/efficiency (PBZ-PLAN.md Chunk 11).
 */
export function solveCapPercent(power) {
  const { links, binding } = budgetChain(power);
  requirePositive(power?.measured?.all_four_max_amps, 'measured.all_four_max_amps');
  requirePositive(power?.margin, 'margin');
  const rawPct = (binding.amps / power.measured.all_four_max_amps) * 100;
  const pct = Math.max(0, Math.min(100, Math.floor(rawPct * power.margin)));
  return { pct, rawPct, links, binding, budgetAmps: binding.amps, allFourMaxAmps: power.measured.all_four_max_amps, margin: power.margin };
}

/**
 * --- Chunk 12: live power analysis ---
 *
 * Per-channel full-strip current at true 100% (byte value 255), derived from
 * the README bench table (channel_bench_w_per_100px) scaled to the installed
 * pixel count. Divided by pixel_count this is the per-pixel-per-channel amp
 * coefficient estimateFrameAmps() sums over a sampled frame.
 */
export function channelFullAmps(power) {
  const w100 = power?.measured?.channel_bench_w_per_100px;
  if (!w100) {
    throw new Error('power.json: measured.channel_bench_w_per_100px is required by `pbz power` (the live per-pattern estimate). Measure each channel alone at full and record watts per 100 pixels. On a plain RGB strip, include r/g/b and omit w.');
  }
  for (const ch of ['r', 'g', 'b']) requirePositive(w100[ch], `measured.channel_bench_w_per_100px.${ch}`);
  requirePositive(power?.pixel_count, 'pixel_count');
  requirePositive(power?.supply_voltage_v, 'supply_voltage_v');
  requirePositive(power?.measured?.idle_amps ?? 0.000001, 'measured.idle_amps');
  const scale = power.pixel_count / 100 / power.supply_voltage_v;
  // `w` absent means a plain RGB strip: there is no dedicated white element, so
  // there is nothing to extract into. Zero here is the signal, not a value.
  return { r: w100.r * scale, g: w100.g * scale, b: w100.b * scale, w: (w100.w ?? 0) * scale };
}

/**
 * Estimate instantaneous current for one raw preview frame (binary type-5:
 * 1-byte header + pixelCount x [r,g,b], 0..255). Verified live (PBZ-PLAN.md
 * Chunk 12, 2026-07-18) that this stream is PRE-brightness (the global
 * brightness slider and the maxBrightness cap do not scale it) and
 * PRE-W-extraction (rgb(1,1,1) reads back as (255,255,255), not reduced) — so
 * both must be applied here, not assumed already baked in:
 *   - `brightnessFactor` is the caller-supplied effective scale actually
 *     driven to the LEDs (brightness x maxBrightness/100); default 1 assumes
 *     the frame values ARE final (e.g. a caller that already scaled them).
 *   - W-extraction: firmware routes min(r,g,b) through the dedicated W
 *     element rather than driving R+G+B independently (README "Why W-only is
 *     the basis" — rgb(1,1,1) measures as ONE channel, not three). Modeling
 *     this is the whole point of Chunk 12: naive R+G+B summing on a white
 *     pixel overestimates its draw ~3x.
 */
export function estimateFrameAmps(frame, power, brightnessFactor = 1) {
  const { r: R, g: G, b: B, w: W } = channelFullAmps(power);
  const pixelCount = (frame.length - 1) / 3;
  const px = frame.subarray(1);
  let amps = power.measured.idle_amps;
  for (let i = 0; i < pixelCount; i++) {
    const r = px[i * 3] * brightnessFactor, g = px[i * 3 + 1] * brightnessFactor, b = px[i * 3 + 2] * brightnessFactor;
    if (W === 0) {
      // Plain RGB: every channel is driven independently and white costs all
      // three. Applying the W-extraction model here with a zero-amp white
      // channel would route min(r,g,b) into nothing and estimate a white frame
      // at close to zero draw — an underestimate, in the one direction that
      // matters on a tool people size supplies with.
      amps += (r * R + g * G + b * B) / 255 / power.pixel_count;
      continue;
    }
    const w = Math.min(r, g, b);
    amps += ((r - w) * R + (g - w) * G + (b - w) * B + w * W) / 255 / power.pixel_count;
  }
  return amps;
}

/**
 * Peak + mean draw across sampled frames, plus how that compares to the
 * protection chain's binding link (budgetChain — the raw link amps, no
 * margin: margin is for sizing the static worst-case cap in solveCapPercent,
 * not for reporting an actual measured/estimated draw).
 */
export function estimateDraw(frames, power, brightnessFactor = 1) {
  // Math.max of an empty list is -Infinity, which printed as "-Infinity A" and
  // "NaN% of budget" rather than saying the sampling had failed.
  if (!frames?.length) {
    throw new Error('estimateDraw: no preview frames were sampled — nothing to estimate from. Is a pattern running?');
  }
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
