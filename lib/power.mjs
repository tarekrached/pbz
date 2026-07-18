// Power budget -> brightness-cap solver. Pure arithmetic on a parsed
// power.json (see ../power.json) — no device I/O, hermetically testable.
// This derives the maxBrightness that keeps the install's worst-case draw
// (all-four-channel, full brightness) under whichever link in the
// PSU/breaker/wire/connector chain is weakest (CLAUDE.md invariant #3).

// The protection-chain links, each expressed as an amp ceiling, plus the
// PSU's own rating. Returns every link and which one is weakest (binds).
export function budgetChain(power) {
  const links = [
    { name: 'PSU (Mean Well ' + power.psu.model.replace(/^Mean Well /, '') + ')', amps: power.psu.rated_amps },
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
