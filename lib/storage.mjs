// Storage-pressure thresholds (PBZ-PLAN.md Chunk 25) — pure, no I/O. The
// incident board (felix-led-project INCIDENT-2026-07-20, resolved 2026-08-14)
// died at 74% storage used: SPIFFS fragmented to zero fully-erased blocks, so
// every write needed garbage collection, GC itself wrote, and the flash-cache
// stall dragged the whole firmware loop down with it — including the network,
// which is how the remedy (deleting files) lost its window.
//
// 75% is a hair past that observed failure point, not a rounding of it —
// CRITICAL should fire before a board gets as far as the one that died, not
// exactly when it would have. Thresholds are constants, not config: this is a
// smoke alarm, not a preference.
export const STORAGE_WARN_PCT = 60;
export const STORAGE_CRITICAL_PCT = 75;

/**
 * Integer percent full (Math.floor, never rounds UP into a threshold it
 * hasn't actually reached), or null if used/size aren't usable numbers.
 * size<=0 or non-finite (0, undefined, negative, NaN, Infinity) is null, not
 * a divide-by-zero artifact; used undefined/NaN is null too.
 *
 * Returning an integer (not the raw ratio) is load-bearing: every consumer —
 * display, storageLevel, checkExpectations' comparison and its message — reads
 * this SAME rounded value, so they can never disagree with each other (74.6%
 * used to print "(75%)" while still only soft-warning at the 74%-raw level,
 * and 60.4% could fail --check with a message that read "60% used, expected
 * ≤60%"). Floor, not round, so display never overstates fill either.
 */
export function storagePct(used, size) {
  if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) return null;
  if (typeof used !== 'number' || !Number.isFinite(used)) return null;
  return Math.floor((100 * used) / size);
}

/**
 * null | 'warn' | 'critical'. pct === STORAGE_CRITICAL_PCT counts as critical
 * (>= both boundaries, not >), so the incident's own 74% still lands as
 * 'warn' — deliberate: it's below the loud threshold, which is the point.
 */
export function storageLevel(pct) {
  if (pct == null) return null;
  if (pct >= STORAGE_CRITICAL_PCT) return 'critical';
  if (pct >= STORAGE_WARN_PCT) return 'warn';
  return null;
}
