// Write-latency watchdog (PBZ-PLAN.md Chunk 26) — pure, no fs/device/clock.
// Companion to Chunk 25's storage-pressure surfacing: same disease (SPIFFS
// garbage collection stalling under flash fragmentation), a different proxy.
// Storage fill is the leading indicator; small-write latency is the disease
// itself, and visible earlier — the incident post-mortem found anomalously
// slow small writes weeks before the board that eventually died at 74% fill
// actually wedged. This module only does the arithmetic: baseline tracking,
// threshold math, and state (de)serialization. No I/O, no timers, no device —
// see pbz.mjs for the CLI wiring that supplies those.

export const WARN_FLOOR_MS = 2000;
export const WARN_MULTIPLIER = 3;
// ~5 samples for the EMA to mostly converge (0.8^5 ≈ 0.33 residual weight on
// the seed value) — the floor above is what covers that cold-start window.
export const EMA_ALPHA = 0.2;

/**
 * Exponential moving average of a per-host write-latency baseline. A null
 * `prevBaselineMs` (no history yet) seeds the baseline AT the sample, so the
 * very first write is never scored as an outlier against a baseline it also
 * defines.
 */
export function updateBaseline(prevBaselineMs, sampleMs, alpha = EMA_ALPHA) {
  if (prevBaselineMs == null) return sampleMs;
  return alpha * sampleMs + (1 - alpha) * prevBaselineMs;
}

/**
 * The stderr-warning line fires once a sample exceeds max(3x baseline, 2s) —
 * whichever is bigger governs at both ends. A near-zero baseline still needs
 * a real 2s stall to warn (the floor), and an already-elevated baseline (a
 * board genuinely near its flash ceiling) still warns at a meaningful
 * multiple of its OWN slowness rather than being swallowed by a fixed floor.
 *
 * This band has a real ceiling, not just a floor: the write paths this feeds
 * (pixelblaze.mjs's setConfig/delete/setControls/activate) hard-timeout their
 * own ack wait at WRITE_ACK_TIMEOUT_MS (8s) and throw past it. So in
 * practice the floor/multiplier scheme only ever gets to warn across a
 * roughly 2-8s band of real degradation — a sample that would need a
 * larger baseline than that to cross the multiplier arm can never actually
 * be observed warning, because the write itself throws first. A thrown
 * timeout past 8s IS the late-stage signal this warn scheme hands off to,
 * not a gap in it.
 */
export function warnThresholdMs(baselineMs) {
  return Math.max(WARN_MULTIPLIER * (baselineMs ?? 0), WARN_FLOOR_MS);
}

/**
 * Score one sample against the PRIOR baseline -> {baselineMs, warn, thresholdMs}.
 * `thresholdMs` is derived from `prevBaselineMs`, not the baseline this call
 * just computed — a sample is judged against where the baseline WAS, not
 * dragged toward what it just became. Cold start (`prevBaselineMs == null`)
 * never warns, no matter how large `sampleMs` is: there is no prior baseline
 * for it to be anomalous against yet, and the whole point of the floor/
 * multiplier scheme is a baseline-relative comparison, not an absolute cap.
 * `warn` is strict `>` — a sample landing exactly on the threshold is not
 * itself a warning.
 */
export function recordSample(prevBaselineMs, sampleMs) {
  const thresholdMs = warnThresholdMs(prevBaselineMs);
  const warn = prevBaselineMs != null && sampleMs > thresholdMs;
  const baselineMs = updateBaseline(prevBaselineMs, sampleMs);
  return { baselineMs, warn, thresholdMs };
}

/**
 * PBZ-PLAN.md Chunk 28's go/no-go gate for `defrag`: one timed write, judged
 * directly against `warnThresholdMs` -> `{ok, thresholdMs}`.
 *
 * DELIBERATE DIVERGENCE FROM `recordSample`: this does NOT reuse
 * `recordSample`'s `warn` flag, and that is on purpose, not an oversight.
 * `recordSample` is a rolling per-host WATCHDOG — its cold-start rule
 * (`prevBaselineMs == null` -> never warns) is right there, because a fresh
 * host with no history yet shouldn't cry wolf on its very first sample; there
 * will be another sample, and another, and the baseline will fill in. But
 * `defrag`'s health gate is a ONE-SHOT go/no-go check with no "next sample"
 * to fall back on — it cannot afford to stay silent just because this
 * happens to be a cold host. A board slow enough on its very first observed
 * write to blow the 2s floor is exactly the board that should not be
 * mid-defragged next, baseline or no baseline. So here the floor governs
 * COLD and WARM hosts alike: `ok = sampleMs <= warnThresholdMs(baselineMs)`,
 * full stop, with no cold-start exemption. A null `baselineMs` still yields
 * a real threshold (the 2s floor via `warnThresholdMs`'s own `?? 0`), not an
 * automatic pass.
 */
export function defragHealthGate(sampleMs, baselineMs) {
  const thresholdMs = warnThresholdMs(baselineMs);
  return { ok: sampleMs <= thresholdMs, thresholdMs };
}

/**
 * Parse the persisted state file's contents -> {hosts:{...}}. NEVER throws:
 * invalid JSON, a non-object top level, or a missing/wrong-typed `hosts` all
 * fall back to an empty, fresh-start state. A missing or corrupt state file
 * is explicitly not an error for this feature (it's advisory telemetry that
 * has to survive a first run, a hand-edited file, or a future format change
 * just as gracefully as it survives not existing at all).
 */
export function parseLatencyState(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
        parsed.hosts && typeof parsed.hosts === 'object' && !Array.isArray(parsed.hosts)) {
      return { hosts: parsed.hosts };
    }
  } catch {
    // fall through to the fresh-start default below
  }
  return { hosts: {} };
}

/**
 * Apply one timed sample for `host` against `state`, returning a NEW state
 * (input is never mutated — concurrent CLI invocations each read, compute,
 * and write independently; see pbz.mjs's writeLatencyState for the
 * last-writer-wins tradeoff that follows from that).
 *
 * A stored `baselineMs` that isn't a finite number (a hand-edited state
 * file, a future format change, plain corruption — `"abc"`, `NaN`, `null`
 * surviving a round-trip some other way) is treated as no baseline at all,
 * via `Number.isFinite` rather than a bare nullish check. Without this a
 * poisoned entry stays poisoned forever: every future sample for that host
 * would compute against garbage, recordSample's cold-start-never-warns rule
 * would never re-engage (prevBaselineMs reads as "present" even though it's
 * useless), and the corrupted value would keep persisting right back out.
 */
export function applySample(state, host, sampleMs) {
  const stored = state.hosts[host]?.baselineMs;
  const prevBaselineMs = Number.isFinite(stored) ? stored : null;
  const { baselineMs, warn, thresholdMs } = recordSample(prevBaselineMs, sampleMs);
  const newState = { hosts: { ...state.hosts, [host]: { baselineMs } } };
  return { state: newState, warn, thresholdMs, baselineMs, prevBaselineMs };
}

/**
 * Time an async op -> {result, ms}. Deliberately does NOT catch `fn`'s
 * rejection — a real write failure must still reach the caller's normal
 * error path (die()) unchanged; this only measures, it never masks.
 */
export async function timeOp(fn, { now = () => Date.now() } = {}) {
  const t0 = now();
  const result = await fn();
  const ms = now() - t0;
  return { result, ms };
}

/**
 * Build the `(op, ms)` callback that becomes `Pixelblaze`'s `onWriteLatency`
 * option — the CLI's write-latency watchdog, factored out here (rather than
 * living inline in pbz.mjs) so its behavior — including the exact warning
 * wording — is covered by this module's own hermetic tests instead of only
 * being reachable through a live device.
 *
 * All I/O is injected, so this function itself touches no filesystem:
 *   - `readState()` -> the current `{hosts:{...}}` (never throws by
 *     contract — see pbz.mjs's readLatencyState, which guarantees that).
 *   - `writeState(state)` -> persist it; MAY throw (pbz.mjs's
 *     writeLatencyState does, on a real filesystem failure).
 *   - `warn(message)` -> print one line somewhere (pbz.mjs wires this to
 *     `console.error`).
 * No clock is needed here: `ms` already arrives pre-measured from the
 * caller (see pixelblaze.mjs, which brackets exactly the write's own
 * post-connect send->ack span), so there's nothing for a `now` to time.
 *
 * Order matters and is deliberate: the sample is always scored and
 * persisted FIRST — a write-latency warning must never be skipped just
 * because the state file happened to fail to save, and a persistence
 * failure must never be skipped just because the sample didn't warn.
 * `writeState`'s own exception is caught here and turned into exactly one
 * `warn()` line — this hook can never throw, so it can never break the
 * write it's reporting on (the double-guard: pixelblaze.mjs's
 * `_reportWriteLatency` also wraps the whole call in try/catch).
 */
export function makeWatchdog({ host, readState, writeState, warn }) {
  return (op, ms) => {
    const before = readState();
    const { state, warn: overThreshold, thresholdMs, prevBaselineMs } = applySample(before, host, ms);
    try {
      writeState(state);
    } catch (e) {
      warn(`warning: couldn't save write-latency state (${e.message}) — continuing`);
    }
    if (overThreshold) {
      warn(`warning: ${op} took ${Math.round(ms)}ms on ${host} (baseline ${Math.round(prevBaselineMs)}ms, warns past ${Math.round(thresholdMs)}ms) — likely SPIFFS storage pressure (GC stalling small writes); check \`pbz info\`'s storage line`);
    }
  };
}

/**
 * Builds `defrag()`'s `opts.healthGate` closure (PBZ-PLAN.md Chunk 28).
 *
 * THE BASELINE SNAPSHOT IS TAKEN HERE, SYNCHRONOUSLY, AT BUILD TIME — NOT
 * LAZILY INSIDE THE RETURNED CLOSURE. This is a fix for a real bug, not a
 * style choice: `defrag()`'s own health-check write (a ping-chased,
 * watchdog-instrumented `setConfig`) reports its sample through the SAME
 * `onWriteLatency` -> `makeWatchdog` -> `writeState` path that updates this
 * host's persisted baseline, and that report happens SYNCHRONOUSLY, before
 * `setConfig()`'s promise even resolves back to `defrag()`. So if this
 * function read state lazily inside the closure it returns, by the time
 * `defrag()` calls that closure with the sample, `readState()` would
 * already return the baseline the sample ITSELF just produced — the gate
 * would always be grading a sample against a baseline derived from that
 * exact sample. Two concrete failure modes that produced, both closed by
 * hoisting the read here: a COLD host could never refuse (a cold sample
 * seeds the baseline AT the sample, so `threshold = max(2000, 3xsample) >=
 * sample` always); a WARM host's effective multiplier silently loosened
 * (the EMA pulls the "prior" baseline toward the very sample being judged,
 * shrinking the gap the multiplier is supposed to guard). Calling this
 * function happens before `pb.defrag(...)` is even invoked — it's built as
 * part of that call's own argument list — so a synchronous read here is
 * guaranteed to land before defrag's first write.
 *
 * `readState` is injected (not `pbz.mjs`'s `readLatencyState` hardcoded)
 * so this composition — this function's own baseline snapshot PLUS
 * `makeWatchdog`'s write path racing against it — can be exercised
 * hermetically against an in-memory fake store instead of only being
 * checked in isolation, which is exactly how the bug this fixes escaped
 * review the first time.
 */
export function buildDefragHealthGate(host, { readState }) {
  const stored = readState().hosts[host]?.baselineMs;
  const baselineMs = Number.isFinite(stored) ? stored : null;
  return (sampleMs) => {
    const { ok, thresholdMs } = defragHealthGate(sampleMs, baselineMs);
    if (ok) return { ok: true };
    const baselineDesc = baselineMs == null ? 'no baseline yet, 2s floor' : `baseline ${Math.round(baselineMs)}ms`;
    return { ok: false, message: `health-check write took ${Math.round(sampleMs)}ms on ${host} (${baselineDesc}, threshold ${Math.round(thresholdMs)}ms).` };
  };
}
