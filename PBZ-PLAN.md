# pbz — refactor & expansion plan

Turning `pbpush` (a pattern pusher) into **`pbz`**: a reusable JS **library + CLI** for
Pixelblaze, ready to open-source. This doc is the execution plan — **discrete chunks, each
landable and testable on its own**, sized for a single focused session. Wire formats in the
Appendix are verified against **this device's own firmware (v3.67)** — trust them over the
Python `pixelblaze-client`, which differs in several places (noted inline).

## Progress tracker

**This file is the build's task tracker.** Check a chunk's box **in the same commit that
implements it** — the box is just staged alongside the code, so it's one commit, not two.
Use commit subject **`pbz: Chunk N — <title>`**; then `git log --oneline -- PBZ-PLAN.md`
is the authoritative SHA-per-chunk record. Don't write SHAs into this file (that would need a
second commit to capture a commit's own hash — the clunk we're avoiding). Chunks 0→1 are
sequential; 2–9 and 11–13 are independent (pick by value; do 13 before 8); 10 is last (packaging,
right before publish). Chunk 12 depends on 11 (shared `power.json`) and on resolving its W-channel prereq.
Chunks 14–21 (added 2026-07-19) are independent of the rest and each other, except 18 builds on
17 and **20 should land before 14 and 17** (they're the multi-call shapes its connection reuse
protects — done); all are buildable before the sensor board lands (~week of 2026-07-20) — only
17/18's live acceptance and 19's presence check need it physically attached. **21 is contingent**
(see its trigger condition; skip unless met).

- [x] **0 — Rename & scaffold** (S)
- [x] **1 — Extract the library** (M, keystone)
- [x] **2 — Brightness & safety cap** ⭐ (S)
- [x] **3 — delete / export / import** (M)
- [x] **4 — config / set-config (+ `--check`)** (M)
- [x] **5 — setvars** (S)
- [x] **6 — sequencer / playlist** (M)
- [x] **7 — info / stats** (S–M)
- [x] **8 — mapper get/set** (L — device can't eval the JS map; pbz must, like the compiler)
- [x] **9 — reboot / ping / discover** (M)
- [x] **10 — open-source polish** (M, last)
- [x] **11 — power budget → brightness-cap solver** ⭐ (M — fixes the wide-open safety cap)
- [x] **12 — live power analysis** (M–L — unlocks color headroom; needs 11 + W-channel prereq)
- [x] **13 — read-method layering retrofit** (S — `getStatus()` + `getInfo` rebuild; do before 8)
- [x] **14 — backup / restore (.pbb)** (M)
- [x] **15 — color-picker controls in `set`** (S)
- [x] **16 — sequencer transport: pause / next / interval** (S)
- [ ] **17 — sensor board: live monitor** (M — SB needed for acceptance only)
- [ ] **18 — sensor record / replay probe** (S–M, builds on 17)
- [ ] **19 — power sampling window + SB presence check** (S)
- [x] **20 — connection hygiene** (M — open-timeout + shared connection; born of a live wedge 2026-07-19)
- [ ] **21 — per-host CLI lock** (S–M — **contingent**: only if parallel-invocation churn recurs)
- [x] **22 — TypeScript declarations** (S — added 2026-08-11, post-Chunk-10)
- [x] **23 — signature guard + JSDoc doc blocks** (S — added 2026-08-11)
- [x] **24 — response-correlation & fail-loud pass** (M — added 2026-08-11, from an independent review)
- [x] **25 — storage-pressure surfacing** (S — added 2026-08-14, from the SPIFFS death-spiral post-mortem)
- [x] **26 — write-latency watchdog** (S–M — same origin; the signal that would have caught it weeks early)
- [x] **27 — backup-freshness nudge** (S — the `.pbb` is what made the incident survivable)
- [x] **28 — `defrag`: OTA deep clean** (M — do after 25+26; they are its go/no-go gate)

Suggested order by value: **0, 1, 2, 11, 4, 3, 7, 5, 6, 12, 13, 8, 9, 10.**
Remaining, by value: **20, 14, 15 done**; **16 implemented but unverified** (`seq time` still
untested — device incident 2026-07-20, see Chunk 20's second-wedge note); next **17, 18, 19, then
10 last** — but 17 jumps the queue the day the sensor board arrives (it *is* the bring-up tool).
21 sits outside the queue: don't build it until its trigger condition is met (**still unmet** after
the 2026-07-20 incident — see its note before assuming otherwise).
**25–28 (added 2026-08-14)** come from the incident's completed post-mortem: order 25 → 26 → 27 → 28
(28 hard-depends on 26's threshold for its health gate; 25 and 27 are independent quick wins).

**Re-scoped 2026-07-20 for open-sourcing:** the
pre-publish gate is **15, 16, then 10** (both S and useful, so they land before the repo goes
public). **17–19 ship as documented known gaps** until the sensor board lands (17 still jumps
the queue the day it arrives). **14 landed 2026-07-20** — ahead of its original post-publish
slot, no longer a documented gap. **15 landed 2026-07-20; 16's acceptance completed 2026-08-11**
against the replacement board, so **the publish gate is CLEAR** (15, 16, 10 all done). 21 unchanged: contingent, trigger unmet. Home Assistant work
is out of scope for pbz entirely (the community `ha-pixelblaze` integration is the right
place for it, not a fourth one).

## How to run this (kickoff prompt)

Drive it one or two chunks per session. Paste to a fresh Sonnet:

> Read `PBZ-PLAN.md` — it's the task tracker for evolving pbpush into `pbz` (a JS
> library + CLI for Pixelblaze). Do **Chunk 0, then Chunk 1**, and stop. (Later sessions:
> name the next single chunk, e.g. "do Chunk 2".)
>
> Rules:
> - **Only start a chunk from a clean, pushed tree** (`git status -sb`: no dirty files, not
>   ahead of origin). If either fails, stop and surface it — don't build on unpushed work.
> - Follow `README.md` **"Device etiquette & recovery"**: batch device calls into one
>   script/connection, never kill a pbz mid-transfer, and use its recovery playbook if the
>   ws server stops accepting.
> - Follow the plan exactly — names, structure, and scope are settled; don't re-litigate.
> - Use the Appendix wire formats (verified against firmware v3.67) over the Python
>   `pixelblaze-client`, which is wrong in the noted places.
> - Obey **Testing & conventions** below: run the read-only smoke sweep first; for Chunk 1,
>   the golden-bytes characterization test is a merge gate; restore device state after any
>   mutating test; `node:test` only, no new deps.
> - Test each chunk against the live device at `192.168.1.50` using its acceptance criteria.
> - When a chunk passes, **check its box in this file and commit it together with the code**,
>   subject `pbz: Chunk N — <title>`.
>
> You must be on the same LAN as the Pixelblaze for the device tests to run.

## Testing & conventions

TDD is worth it for the **pure, deterministic** code (bytes in → bytes out, no device):
`buildBytecode`, `buildPBP`, `stableId`, the `makeCompiler`/`makeLZ` extraction, epe assembly,
playlist encoding, arg parsing. It is a poor fit for **device I/O** (run/save/activate/limit/
reboot) — those need the live device and *mutate* it; use characterization + a restore harness
there, not test-first.

Use the built-in **`node:test` + `node:assert`** only (keeps the zero-deps invariant). No jest/
vitest, no coverage targets, no WebSocket mocking framework.

Run tests with the package scripts (from the repo root): **`npm test`** runs the hermetic suite
(`node --test test/*.test.mjs`); **`npm run smoke`** runs the live read-only sweep. Name every
test file `*.test.mjs` so `npm test` picks it up. Note: `node --test <dir>` (a bare directory)
errors on some Node versions — always go through `npm test` or a `*.test.mjs` path, never the
directory form.

1. **Golden-bytes characterization test — a merge gate for Chunk 1.** Chunk 1's whole promise
   is "identical bytes on the wire before and after the refactor," and drift would be *silent*
   (the device may still accept subtly-wrong bytecode). Before refactoring: compile a fixture
   `patterns/_fixture.js` and snapshot the exact bytecode + `.pbp` hex; after, assert byte-for-
   byte identical. **Make it hermetic:** vendor a captured `index.html.gz` as
   `test/fixtures/ui-v3.67.html.gz` and point `makeCompiler`/`makeLZ` at it in tests, so
   the compile path tests run offline against a pinned firmware — no LAN, fast, repeatable.
   *(Superseded by Chunk 10: the capture is no longer committed. `npm run fixture` pulls one
   off your own device into a gitignored path, and the tests skip when it's absent.)*
   Also snapshot `stableId('foo')` — it must never change (re-saves would stop updating in place).
2. **State-restore harness for device tests.** Snapshot active pattern + brightness at start,
   restore at end. Use a dedicated throwaway pattern name `__pbz_test` for save/delete so real
   patterns are never clobbered. **Never** exercise `reboot`, `limit`/`maxBrightness`, or
   `set-config` in a loop without restoring — they touch the power-safety cap.
3. **Read-only smoke sweep.** `npm run smoke` (`test/smoke.mjs`) runs the read-only
   commands that exist so far (`list · get`, extended to `config · info · ping` as Chunks
   4/7/9 land) — no mutation, ~2s. Run it at the start of every session; it catches
   connection/parse breakage instantly.

**House rules (keep every session consistent):**
- No new runtime deps — Node ≥22 built-ins only; the sole vendored file stays `jpeg-encoder.cjs`.
- Match the surrounding terse voice; comments justify a choice, not narrate the code.
- Host resolution (`--host`/`$PB_HOST`/`pb.config.json`) lives in the **CLI**, not the class;
  the `Pixelblaze` class takes a host in its constructor and knows nothing about argv.
- Errors surface via the existing `die()` path in the CLI; the class throws.
- **Read-method layering:** a method that maps 1:1 to a wire response returns it parsed and
  *unrenamed* (`getConfig`, `getStatus`, `getMap`) — pass-through fields keep their wire names.
  Composites (`getInfo`, `getState`) build **on** those accessors and may add derived fields,
  but rename a wire field only to bake in a decode the caller shouldn't repeat (`exp`→
  `expansion`, computed `groupRole`), never cosmetically (`ver`→`version`). Any genuine upstream
  shape a method computes or consumes gets its own read path — never swallowed inside a composite.
  Cosmetic labeling/formatting is the **CLI's** job, not the class's.
- One commit per chunk (code + ticked box together), subject `pbz: Chunk N — <title>`.

## Decisions already made (don't re-litigate)

- **Name: `pbz`** (bin + npm package). `pbz` is **free on npm** (checked). `pixelblaze` is
  deliberately left unclaimed: it isn't this project's name to take. `pb` is taken on npm (an
  OSX-pasteboard tool) and clashes with a Pushbullet CLI, so avoid it.
- **Two deliverables from one codebase:** a `Pixelblaze` **class** you can `import` (the
  valuable part — a headless, browser-free, Python-free API that *also compiles patterns*),
  and a thin **CLI** on top. Neither Firestorm nor the Python client can compile without a
  browser, which is what makes the library usable as a backend for a Firestorm-like
  multi-device controller.
- **Zero runtime deps stays a hard requirement** (Node ≥ 22 built-ins: `fetch`,
  `WebSocket`, `zlib`, `dgram`; the one vendored file is `lib/jpeg-encoder.cjs`).
- Keep the escape-hatch philosophy (the brain must stay swappable): **no raw filesystem CLI verbs**
  (`fs ls/get/put/rm`) and no Output-Expander ops. *Amended 2026-07-19:* the HTTP file
  endpoints themselves are no longer out of scope — they're the web UI's own backup mechanism,
  and Chunk 14 uses them **internally** for `backup`/`restore`. The footgun was handing users
  blind `putFile`/`deleteFile` verbs, not the endpoints.

## Target structure

*Historical: this is the layout as planned while the code still lived in a `tools/`
subdirectory of another repo. That directory is this repository's root now, so read the
paths below as `tools/` → `./`. Left as written rather than restated, because it records
what Chunks 0 and 1 actually did.*

```
tools/
  package.json         # NEW: name "pbz", type module, bin, exports, engines >=22
  pbz.mjs              # CLI dispatcher only (renamed from pbpush.mjs)
  pb.config.json
  power.json           # NEW (Chunk 11): PSU/breaker/wire/connector chain + measured draw
  README.md            # rewrite for pbz
  PBZ-PLAN.md          # this file
  lib/
    pixelblaze.mjs     # NEW: class Pixelblaze — the importable API
    compiler.mjs       # NEW: fetchWebUI, makeCompiler, makeLZ, makeLZDecompress, makeNormalizeMap
    pbp.mjs            # NEW: buildBytecode, buildPBP, stableId, prettyName
    protocol.mjs       # NEW: connect() ws helper — frames, chunking, waiters
    preview.mjs        # NEW: buildPreviewJPEG
    power.mjs          # NEW (Chunk 11): budgetChain, solveCapPercent — pure arithmetic
    map.mjs            # NEW (Chunk 8): evalMapSource, buildPixelMapFrame — pure
    backup.mjs         # NEW (Chunk 14): parseFileList, parseBackup, buildBackup — pure
    jpeg-encoder.cjs   # unchanged (vendored)
```

Everything the class needs lives under `tools/` so the whole dir lifts out into its own repo
later with no edits.

## Command surface (target)

Existing (keep, must not regress): `compile · run · save · list · activate · get · set`
New: `delete · export · import · brightness · limit · config · set-config · setvars ·
seq · playlist · info · map · reboot · ping · discover · power` (`limit --for-budget`,
`power budget`, `power [pattern]`)
Added 2026-07-19: `backup · restore · sensors` (Chunks 14, 17, 18); extends `set` (picker
arrays, 15), `seq` (`pause|resume|next|time`, 16), `power` (`--seconds`, 19), `config --check`
(SB presence, 19).

---

## Chunks

Dependency order: **0 → 1** first (mechanical, do together or back-to-back). After that,
**2–9 are independent** of each other — cherry-pick by value. **10 is last** (packaging).
Each chunk: land it, run its acceptance check against `192.168.1.50`, commit.

### Chunk 0 — Rename & scaffold (mechanical, no behavior change)
- `git mv tools/pbpush.mjs tools/pbz.mjs`; update its header/usage text to `pbz`.
- Add `tools/package.json`: `{ name, version 0.1.0, type "module", engines.node ">=22",
  bin { pbz: "./pbz.mjs" }, exports: { ".": "./lib/pixelblaze.mjs" } }`.
- **Fix cross-links** — every reference to `pbpush` in the surrounding docs.
- **Acceptance:** `node tools/pbz.mjs list` works; grep repo for `pbpush` returns nothing.
- **Size:** S.

### Chunk 1 — Extract the library (pure refactor, no new features)
- Split `pbz.mjs` into the `lib/` modules above. Move the proven code verbatim:
  `fetchWebUI/makeCompiler/makeLZ` → `compiler.mjs`; `buildBytecode/buildPBP/stableId/
  prettyName` → `pbp.mjs`; `connect()` + `sleep`/`makeWsId` → `protocol.mjs`;
  `buildPreviewJPEG` → `preview.mjs`.
- Create `class Pixelblaze { constructor(host) }` in `pixelblaze.mjs` wrapping the current
  ops as methods: `loadTooling()` (lazy+cached), `compile(src)`, `run(src)`, `save(src,name,
  {id})`, `list()`, `activate(target)`, `getState()`, `setControls(obj)`.
- `pbz.mjs` becomes argv parsing + a dispatch table calling class methods. Host resolution
  (`--host` / `$PB_HOST` / `pb.config.json`) stays in the CLI, passed to the constructor.
- **Acceptance:** the golden-bytes characterization test (see Testing & conventions #1) passes
  byte-for-byte — this is the merge gate. All 7 existing commands behave identically (diff
  output against pre-refactor for `compile`/`list`/`get`). A 3-line script `import {Pixelblaze}`
  + `list()` prints patterns.
- **Note:** capture the golden bytes + vendor `ui-v3.67.html.gz` *before* moving any code, so
  the snapshot reflects the pre-refactor output.
- **Size:** M. **This is the keystone** — every feature chunk adds one class method + one CLI case.

### Chunk 2 — Brightness & the safety cap ⭐
- `Pixelblaze.setBrightness(v)` → `{brightness: clamp(v,0,1), save:false}` (ephemeral) /
  `save:true` with a `--save` flag.
- `Pixelblaze.setMaxBrightness(pct)` → `{maxBrightness: clamp(pct,0,100), save:true}`.
- CLI: `pbz brightness 0.5`, `pbz limit 40`.
- **Why first among features:** the "load-bearing" power cap is currently the global
  slider, and the firmware **Limit Brightness reads 100%** — no real cap. `pbz limit` lets you
  pin the firmware cap and keep it in version control. Consider having `save` also print a
  reminder if `maxBrightness` is 100.
- **Acceptance:** `pbz limit 40` then `pbz config` (Chunk 4) or the web UI shows 40%.
- **Size:** S.

### Chunk 3 — Pattern lifecycle: delete / export / import
- `delete(target)`: resolve name→id via `list()`, then `{deleteProgram: id}`.
- `export(target, [file])`: fetch source with `{getSources: id}` and preview jpeg, assemble the
  `.epe` JSON (`{name, id, sources:{...}, preview:<base64>}`), write `<name>.epe`.
- `import(file)`: parse `.epe`, extract source, hand to `save()` (recompiles locally — our
  compiler, so it always matches firmware).
- CLI: `pbz delete "Old Thing"`, `pbz export "Rainbow Worms"`, `pbz import foo.epe`.
- **Acceptance:** export→delete→import round-trips a pattern back onto the device.
- **Size:** M (epe assembly is the fiddly bit — confirm exact epe shape from a real Export in
  the web UI first).

### Chunk 4 — Config as code: config / set-config
- `getConfig()` → `{getConfig:true}`, parse the `{"config"...}`/settings response.
- `setConfig(obj)`: send `{...obj}` — **no `save` key** (keys: `name, pixelCount, colorOrder,
  ledType, dataSpeed, cpuSpeed, discoveryEnable, timezone, autoOffEnable, autoOffStart,
  autoOffEnd, networkPowerSave, sequenceTimer`). Corrected during implementation: the web UI's
  own settings-panel handlers never send `save` for these fields (only `brightness`/
  `maxBrightness` do, per Chunk 2) — confirmed live, a field set without `save` survives a
  fresh `getConfig` read. The Appendix below is updated to match.
- CLI: `pbz config` (pretty-print), `pbz set-config colorOrder=WRGB pixelCount=170`.
- **Bonus (high value for this rig):** `pbz config --check` that asserts `colorOrder===WRGB`
  and `pixelCount===170` and exits non-zero on drift. (Landed generalized: the expected
  values live in `pb.config.json`'s `expect` block rather than hardcoded.)
- **Acceptance:** `pbz config` matches the Settings page; `--check` passes on the live device.
- **Size:** M.

### Chunk 5 — Live variables: setvars
- `getVars()` → `{getVars:true}` → `{vars}` (already surfaced in `get`; expose standalone).
- `setVars(obj)` → `{setVars: obj}`.
- CLI: `pbz setvars myVar=3 phase=0.25`. Distinct from `set` (which is exported UI *controls*);
  this pokes exported pattern *variables* — handy for watching a value move live without
  wiring up a slider for it.
- **Acceptance:** set a var, read it back with `get`.
- **Size:** S.

### Chunk 6 — Sequencer & playlist
- `setSequencerMode(mode)` → `{sequencerMode: 0|1|2}` (0 off, 1 shuffle-all, 2 playlist).
- `getPlaylist()` → `{getPlaylist:"_defaultplaylist_"}`; `setPlaylist(items)` → send the
  playlist object with `items:[{id, ms}]`.
- CLI: `pbz seq off|shuffle|playlist`, `pbz playlist` (show), `pbz playlist set a.js:5000 b.js:3000`.
- **Acceptance:** `pbz seq shuffle` starts cycling; `pbz playlist` reflects a set order.
- **Size:** M.

### Chunk 7 — info / stats (the status popup)
- `getInfo()`: combine `getConfig` + a status/`sendUpdates` text frame + `{getPeers:1}`.
  Surface: firmware version, FPS, free memory (`patternMem`), expansion board (SB / 6-axis),
  group role (`syncGroup`/`leaderId`), `nodeId`, peer list, uptime, storage.
- CLI: `pbz info`.
- **Acceptance:** `pbz info` matches the web UI status dropdown (FPS ~79, Memory, Group Solo,
  Node ID 0).
- **Size:** S–M.

### Chunk 8 — Mapper: map get / set
**Key insight (verified in firmware v3.67): the device cannot evaluate the JS map function —
just like it can't compile patterns, the *browser* does it.** So a map "set" is TWO things,
and doing only the text upload leaves the render geometry unchanged:
- `getMap()`: HTTP `GET /pixelmap.txt` → the map **source** (a JS `var map = …` expression or a
  raw JSON coordinate array). This is the human-readable, committable form.
- **Two upstream shapes, both get a read path** (Read-method layering house rule): the source
  text above *and* the normalized coordinate array the renderer actually uses — which can silently
  diverge from the source (the plan below warns of exactly this). Surface the coords too, e.g.
  `getMap({ coords: true })` → the normalized `[[x,y],…]` array, via the same headless
  `normalizeMap` step `setMap` runs. Without it there's no way to answer "does the device's live
  geometry match `map.js`?" — the question that makes a committed map trustworthy, and the thing
  the acceptance criterion below actually asserts. `setMap` builds its type-8 frame from that same
  shared normalize path rather than being the only place the coords exist.
- `setMap(text)`:
  1. **Compute + send the coordinate array (the part the renderer uses).** Evaluate the map
     source headless in `node:vm` and normalize it, then send the binary **PIXELMAP frame
     (type 8)**: a `Uint32[2, dimensions, byteLen]` header followed by `Uint16` coordinates.
     **Reuse `lib/compiler.mjs`'s web-UI-extraction approach** — pull Ben's own `normalizeMap`
     + `sendMap` (and the map-eval Web Worker body) out of the device HTML and run them headless
     rather than reimplementing the normalization math. This is the exact same trick as the
     pattern compiler, and shares the `node:vm` + `fetchWebUI` infra already in `lib/`.
  2. **Persist the source.** POST the text as a Blob to `/edit` (filename `/pixelmap.txt`),
     then ws `{savePixelMap:true}` so it survives reboot and reloads into the Mapper editor.
- CLI: `pbz map get > map.js`, `pbz map set map.js`.
- **Bonus:** the firmware ships a `ring` map example, and a ring is the geometry this was
  built against, so a committed `map.js` + `pbz map set` makes the layout reproducible.
- **Acceptance:** `pbz map get` returns the current source; after `pbz map set map.js`, the
  Mapper tab shows the new source **and** a mapped pattern actually renders against the new
  geometry (not merely that the text persisted). A golden-bytes-style test on the packed type-8
  frame for a fixture map is a good hermetic guard, mirroring Chunk 1.
- **Size:** L (the headless map-eval + type-8 packing is the real work; the text POST is trivial).

### Chunk 9 — System & discovery: reboot / ping / discover
- `reboot()`: HTTP **POST `/reboot`** (not a ws message — Python client differs).
- `ping()` → `{ping:true}`, await `{ack:true}`; report round-trip ms.
- `discover()`: UDP listener on **port 1889** (`node:dgram`) for Pixelblaze beacons — lets the
  CLI find devices instead of hardcoding the IP. Lower priority; nice for the library's
  Firestorm-backend story.
- CLI: `pbz reboot`, `pbz ping`, `pbz discover`.
- **Acceptance:** `pbz ping` prints latency; `pbz discover` lists `192.168.1.50`.
- **Size:** M (discover is the effort; reboot/ping are trivial).

### Chunk 10 — Open-source polish (do last, right before publishing)
- JSDoc every public method; ship `types` via JSDoc or a hand-written `.d.ts`.
- `examples/`: (a) CLI quickstart; (b) **library-as-backend** — fan a pattern out to N devices
  (`await Promise.all(hosts.map(h => new Pixelblaze(h).save(src)))`), the Firestorm angle.
- LICENSE (credit Ben Hencke for the extracted `compile`/`LZString`), package README, keywords.
- **`AGENTS.md`** at the repo root — the cross-tool agent-instructions convention. Keep it a
  **stub pointing into the README's "Device etiquette & recovery"** section — one source of
  truth, no duplicated content to drift.
- Decide repo home (extract `tools/` → standalone `pbz` repo) and `npm publish` dry-run.
- **Size:** M.
- **Amended 2026-07-20 (open-sourcing agreed — this is now the publish gate):**
  - **Don't ship `test/fixtures/ui-v3.67.html.gz`** — it's Ben Hencke's copyrighted web app
    verbatim. Replace with a capture script (`npm run fixture` fetches `index.html.gz` off your
    own device into a gitignored path); hermetic tests skip with a clear message when it's
    absent. Runtime behavior is already clean (fetch from the user's device, redistribute
    nothing).
  - **Config hygiene:** gitignore `pb.config.json` (LAN IP), ship `pb.config.example.json`.
    `power.json` likewise ships as `power.example.json` with one install's real measured
    numbers (honest hobbyist content) rather than as a live default — someone else's power
    figures drive a hardware brightness cap and are worse than none. Verify the CLI resolves
    both from **cwd**, so a project keeps its own copies after extraction.
  - **Extraction:** new repo `pbz`, carrying the `pbz: Chunk N` commit trail across (the
    per-chunk history is part of the point of publishing). README provenance one-liner:
    "built for some LED strips at home."
  - **LICENSE: MIT.** Keep the Adobe BSD header in `jpeg-encoder.cjs`; attribution note that
    the compiler/LZString are Ben Hencke's code fetched from your own device at runtime.
  - **README:** rewrite of `tools/README.md` in the same hobbyist voice — lead with the demo
    GIF and the "how it works" paragraph (the borrowed-compiler trick is the hook); keep
    "Device etiquette & recovery" near-verbatim; move the 170-px specifics into examples
    rather than baking them into the tool; honest known-gaps section (17–19).
  - **Demo GIF:** phone video of the wall (`pbz run` on a pattern, then a `pbz set` tweak, a
    few seconds each); ffmpeg conversion + paired terminal cast at extraction time.
  - **Deferred post-publish:** `npm publish`, CI, docs site, full JSDoc/`.d.ts` pass.
    `AGENTS.md` stub stays (cheap, useful).
- **Landed 2026-08-11.** `npm test` 27/27 green, and 22/27 + 5 skipped with the captured web UI
  removed — the skip path is exercised, not assumed. What the plan didn't spell out, found while
  doing it:
  - **The install's identity was baked into the code, not just the docs.** `budgetChain` hardcoded
    this rig's part names (Kycon socket, Wago lever-nut, "16 AWG ring bus") and `config --check`
    hardcoded `WRGB`/`170`. Both are now data: the chain is read straight out of
    `protection_chain`'s keys (so a user's links print as they wrote them, and adding one needs no
    code change), and `--check` asserts an `expect` block in `pb.config.json`. Generalizing away
    from one installation turned out to mean an API improvement, not a search-and-replace.
  - **`power.json` ships as `power.example.json`, not as a working default** — a deviation from
    the amendment above, made deliberately. A shipped `power.json` means a fresh clone can run
    `limit --for-budget --set` and get a cap derived from *someone else's* brick. The CLI now says
    so in the not-found error.
  - **Golden bytes are firmware-pinned, and the skip has to know that.** With the fixture
    un-vendored, a user capturing their own web UI on any firmware but v3.67 would have seen the
    characterization test *fail* on a drift that isn't one. `test/fixtures.mjs` skips on a version
    mismatch separately from skipping on absence, with different messages.
  - **`test/golden-bytes.test.mjs` reached outside `tools/`** for `patterns/_fixture.js` — the one
    thing that would have broken extraction. Moved into `test/fixtures/`.
  - Config lookup now walks up from **cwd** before falling back to pbz's own directory, which is
    what lets a project keep its own `pb.config.json`/`power.json` under a global install.

### Chunk 11 — Power budget → brightness-cap solver ⭐ (tier-2 baseline)
**The one that fixes the actual safety gap.** The "load-bearing" power cap
(`maxBrightness`) is currently **100% — wide open**; this derives and sets the
correct value from the install's real electrical budget. `maxBrightness`/`brightness` are
color-blind proxies for power: the cap only bounds the *worst case* (every pixel, every channel,
full). This chunk makes that bound principled and enforced. It does **not** exploit color
headroom (that's Chunk 12) — by definition a static cap must assume worst-case color.
- New **`tools/power.json`** — a machine-readable mirror of the README's measured/spec numbers:
  supply voltage + PSU amps (GST160A24 → 6.67 A), each protection-chain limit (7.5 A DIN-4 socket,
  15 A breaker, 16 AWG ring-segment ampacity, feed-leg limit, Wago connector), measured worst-case draw
  (`all_four_max_amps: 11.4`), idle-per-pixel, pixel count, and a safety `margin`. The effective
  budget is **`min(PSU_derated, DIN-4 socket, breaker, wire, connector)`** — surface *which link binds*
  (here: the brick at 6.67 A, below the 7.5 A socket and even all-four's 11.4 A).
- `Pixelblaze.setMaxBrightness(pct)` already lands in Chunk 2; this adds the **solver**:
  `cap% = floor(budget_amps / all_four_max_amps × 100 × margin)`. Uses only trusted measured
  numbers — **no preview frames, no gamma model** (the measured 11.4 A endpoint already folds in
  gamma/efficiency), no dependency on the W-channel question. Idle draw (~0.17 A) is negligible.
- CLI: `pbz limit --for-budget` (compute + show the derivation + which link binds; set with a
  `--set` flag). `pbz power budget` prints the chain and the binding limit.
- **Hermetic-testable:** the solver is pure arithmetic on `power.json` — unit-test it with
  `node:test` (no device), asserting e.g. 6.67 A / 11.4 A → 58% (before margin).
- **Acceptance:** `pbz limit --for-budget` yields ~55% for the current profile and explains why;
  `--set` writes it (verify in Settings). Cross-check the number against README §Power sizing.
- **Size:** M. Independent of 2–10; high value — do it early.

### Chunk 12 — Live power analysis (tier-1; unlocks color headroom)
**The "bright red is fine" enabler.** Estimates the *actual* draw of a running/candidate pattern
from its real pixel values, so a pattern that never lights all channels can be proven safe and
granted a higher per-pattern cap (feeding Chunk 11's solver). Reports; combined with a per-pattern
`maxBrightness` it also optimizes.
- pbz **already collects live preview frames** (type-5, RGB per pixel) to build the save
  thumbnail — reuse that capture. Sum `Σ value/255 × channel_full_current` across a frame against
  `power.json`; report peak-frame and mean draw vs budget.
- CLI: `pbz power` (analyze the running pattern), `pbz power patterns/foo.js` (compile+run+sample
  a candidate), and a **save-time annotation** in the existing render pass ("saved; peak est.
  5.1 A / 122 W = 55% of budget").
- **Prerequisite — resolved live 2026-07-18:** confirmed by direct probe (`rgb(1,1,1)`,
  `rgb(0.5,0.5,0.5)`, and varying the live `brightness` value while sampling type-5 frames) that
  the preview stream is **pre-W-extraction** (`rgb(1,1,1)` reads back `(255,255,255)`, not the
  single dedicated W element the hardware actually drives) **and pre-brightness** (frame values
  don't change with `brightness` or the `limit` cap — confirmed by sending `brightness:0.5` live
  and seeing the sampled pixel stay at the pattern's raw value). So `estimateFrameAmps`
  (`lib/power.mjs`) does two corrections the naive approach would miss: it scales every sampled
  frame by the caller-supplied `brightness × maxBrightness/100`, and it models W-extraction as
  `min(r,g,b)` routed through the W channel (`channelFullAmps`, calibrated from the README's
  per-channel bench table in `power.json`'s new `measured.channel_bench_w_per_100px`, cross-
  checked: `r+g+b+w` sums to the measured 11.4 A all-four-max to within 0.05 A, and the derived
  `w` alone agrees with the independently measured `w_only_white_amps` to ~1%) with only the
  remainder on R/G/B. Skipping either correction overestimates a white-ish scene by roughly 3x —
  see `test/power.test.mjs`'s W-extraction test, which asserts a full-white frame estimates near
  W-only draw, not a naive R+G+B sum.
- **Honesty rail:** this *advises*; it is not the safety backstop. The fuse/breaker protect the
  wire and the brick current-limits itself — software power analysis is about reliability
  (don't brown out mid-demo) and unlocking headroom, not preventing a melt.
- **Acceptance:** `pbz power` on a known mostly-off pattern reports a small draw; on an all-white
  test pattern it approaches the measured ceiling (within tolerance after the W-channel fix).
- **Size:** M–L (the estimator is small; the W-channel investigation is the real work).

### Chunk 13 — Read-method layering retrofit (getInfo)
Applies the **Read-method layering** house rule to the one composite that shipped before the rule
existed. `getInfo` (Chunk 7) parses three frames inline and renames pass-through fields; split the
unsolicited status frame into a raw **`getStatus()`** — the parsed `{"fps",mem,uptime,storageUsed,
storageSize,…}` frame, wire field names intact — and rebuild `getInfo` on `getConfig` +
`getStatus` + `getPeers`. Keep only the derived fields that bake in a decode (`expansion` from
`exp`, computed `groupRole`); drop the cosmetic renames (`ver`→`version`, `uptime`→`uptimeMs`),
moving the unit labeling into the CLI's `info` printer where formatting belongs.
- CLI: no new command required; `pbz info` output stays identical (the renames become CLI-side
  labels). Optionally add `pbz status` if it earns its keep — not required.
- **Acceptance:** `pbz info` output byte-identical to pre-change; smoke sweep green; `getStatus()`
  returns the raw status frame with wire field names (add a small parse test).
- **Size:** S. Independent; do it before Chunk 8 or any new composite so the pattern is settled.

### Chunk 14 — backup / restore (.pbb)
**One command snapshots every pattern (including web-UI-authored ones that exist nowhere but
the device), settings, playlist, and map.** The web UI's Settings→Backup is pure
client-side logic pbz can replicate, and a `.pbb` is **not a zip — it's JSON** (see Appendix),
so zero-deps holds with no archive code.
- `saveBackup(file)`: `GET /list`, fetch each listed file (skip the `*.gz` web-app files —
  both the web UI and the Python client exclude `fileSystem`), verify each byte size against
  the listing, assemble `{"files": {"<path>": "<base64>"}}`, write `<devicename>-<date>.pbb`
  by default.
- `restoreBackup(file)` (optional half — land second or not at all; backup alone is most of the
  value): `POST /edit` each entry (multipart, field `data` — the same upload the map source
  uses), then `POST /reboot`. Overwrite-only by default; `--prune` deletes device files absent
  from the backup (the web UI's restore is a full wipe — ours is gentler unless asked).
  **Destructive → require `--yes`.** Print that WiFi config is not in backups (the UI says so).
- Bonus one-liner: `pbz backup --fs-image` → `POST /backupFsImage` — the v3.67 device-side
  full-flash image, restored by holding the button at power-up. LEDs go dark while it writes
  flash; deliberate-use only.
- CLI: `pbz backup [file.pbb] [--fs-image]`, `pbz restore <file.pbb> [--prune] --yes`.
- **Hermetic:** fixture `.pbb` round-trip (parse → per-file bytes → reassemble byte-identical);
  read must tolerate a BOM (the Python client decodes `utf-8-sig`, so expect one in the wild).
- **Acceptance:** `pbz backup` contains the same files as a web-UI backup of this device with
  matching per-file bytes; save `__pbz_test` → backup → delete → restore → `list` shows it again.
- **Size:** M (format confirmed; this is plumbing).
- **Landed 2026-07-20.** Live end-to-end run against `192.168.1.50`: `pbz backup` (via
  `saveBackup`) fetched **36 files** (skipping the two `.gz` web-app blobs), each verified
  against `/list`'s byte size; saved `__pbz_test` (the golden-bytes `_fixture.js`), confirmed it
  in the backup as `/p/<id>`, deleted it, `restore` (via `restoreBackup`) POSTed all 36 files
  back through `/edit` and rebooted; after the device came back, `list` showed `__pbz_test`
  again. Cleaned up (deleted `__pbz_test`, re-activated the original active pattern) and
  confirmed with `npm run smoke` + `npm test` green (26/26). One process-hygiene lesson from the
  run, not a code defect: after a `restore`-triggered reboot, verify with the **same**
  `Pixelblaze` instance/connection rather than opening a fresh one immediately after — opening
  a second websocket right after the first's post-reboot reconnect hit exactly the client-budget
  contention `README.md` "Device etiquette" already warns about (transient `websocket:
  connection failed`; resolved by reusing one connection, no code change needed).

*Amended by Chunk 27: `saveBackup()`'s default filename gained a chipId segment and a
sub-day UTC timestamp, trailing `Z` (`<name>-<chipId>-<date>-<time>Z.pbb`, e.g.
`wall-42-2026-08-14-183012Z.pbb`) so the freshness scan can match a `.pbb` to the device
that made it by filename alone, and same-day scripted backups (Chunk 28's defrag included)
don't overwrite each other and silently replace the only good backup with a post-damage
one — `.pbb`s written before this change won't match and should be re-taken.*

### Chunk 15 — color-picker controls in `set`
- `hsvPicker*`/`rgbPicker*` controls take a 3-element array, components 0..1 — the web UI sends
  them through `setControls` like any other control. The class needs no change; the CLI is the
  only gap (`set` currently does `Number(v)`). **Verified live 2026-07-19:** `setControls({
  hsvPickerColor: [0.33, 1, 1]})` on a saved probe pattern read back exactly via `getState`.
- CLI: comma values parse to arrays — `pbz set hsvPickerColor=0.33,1,1`; validate exactly 3
  components in 0..1 when the name starts with `hsvPicker`/`rgbPicker`.
- **Acceptance:** on a pattern exporting a picker, `set` → `get` reads the array back and the
  strip visibly changes color.
- **Size:** S.
- **Landed 2026-07-20.** Verified live against `192.168.1.50` using `patterns/perimeter-clock.js`
  (exports `rgbPickerHours/Minutes/Seconds`), run ephemerally so nothing was clobbered:
  `set rgbPickerHours=1,0,0` → `get` read the array back as `1,0,0`, and the validator rejected
  both `1,2,0` (component outside 0..1) and `1,0` (wrong component count) with a non-zero exit.
  The class needed no change, exactly as the chunk predicted — the CLI's blanket `Number(v)` was
  the entire gap. Note the readback formatting: `get` prints arrays comma-joined (`1,0,0`), and
  untouched picker controls show up as denormal-ish noise (`1.4e-45,0,0`) rather than clean zeros
  — that's the device's own float state, not a parse artifact.

### Chunk 16 — sequencer transport: pause / next / interval
- `setSequencerState(run)` → `{runSequencer: <bool>}` (play/pause of auto-advance);
  `nextPattern()` → `{nextProgram: true}`; the shuffle interval is a plain config key the CLI
  already reaches via `set-config` — the UI sends `{sequenceTimer: n}` and refuses `n < 1`.
  **Verified live 2026-07-19:** units are **seconds** (device reads `sequenceTimer = 15`, the
  UI's stock 15 s default — ms would read 15000); `getConfig` also exposes live **`runSequencer`**
  (pause state is *readable*, so acceptance below and any HA surface can assert it), and
  `{sequencerMode: 2}` observably flips it to `true`.
- CLI: `pbz seq pause|resume|next`, `pbz seq time <n>`; existing `seq off|shuffle|playlist`
  unchanged.
- **Acceptance:** `seq pause` freezes the playlist countdown (web UI play button reflects it),
  `resume` continues, `next` advances immediately.
- **Size:** S.
- **Implemented 2026-07-20; acceptance INCOMPLETE — box deliberately left unchecked.**
  `setSequencerState` / `nextPattern` are in `lib/pixelblaze.mjs`, `seq pause|resume|next|time`
  in the CLI. Verified live before the device wedged (Chunk 20's second-wedge note): `seq playlist`
  → `sequencerMode 2`; `pause` → `getConfig().runSequencer === false`; `resume` → `true` — **both**
  transitions, so the plan's "pause state is readable" claim holds and any HA surface can assert
  on it; `next` advanced the active pattern. **Still unverified: `seq time <n>`** — both attempts
  died before reaching it. Two findings worth keeping:
  - **`getPlaylist().position` lags `nextProgram`.** It read `0` → `0` across a `next` that
    demonstrably changed the pattern (`getState().id` *did* change). Assert on `getState()`, not
    `position`; if `seq next` should ever report what it advanced *to*, that's the read to use.
  - **`setSequencerState`'s internal `sleep(150)` is too short for an immediate readback.** A
    `getConfig()` fired straight after a pause returned the *stale* `true`; ~400 ms settles it.
    Harmless for the CLI (fire-and-forget — it prints without reading back) but a real race for
    library callers, and the first thing that made this chunk look broken when it wasn't. Left
    as-is rather than re-timing code that couldn't be re-verified live mid-incident: bump to
    ~300–400 ms and confirm once the device is back.
- **ACCEPTANCE COMPLETE 2026-08-11**, against a replacement board on **firmware v3.51** — note that is OLDER than the v3.67 this plan's Appendix was verified
  against, so treat any disagreement here as version-specific until re-checked.
  - **`seq time` verified, and the seconds-vs-ms question is now settled by the firmware
    itself.** Writing `{sequenceTimer: 20}` over ws leaves **`20000` in `config2.json`**, and 25
    leaves 25000. So the **ws API is SECONDS and the persisted file is MILLISECONDS**; the
    firmware converts at the boundary. `maxBrightness` splits the same way: **`0.55` in the file,
    `55` over ws.** Anything reading the device's files directly must not assume the wire units.
  - **`pause` / `resume` / `next` all verified.** `next` needs a longer observation window than
    it looks: a `getState()` 1.2 s later still showed the old pattern, while the device had in
    fact advanced. Measured by polling on v3.67: **~1360 ms**. Don't assert on `next` inside ~2 s.
  - **RE-VERIFIED 2026-08-11 on v3.67**, after the board was updated from v3.51. Same results
    on every item, including the seconds/ms split. The two firmwares agree.
  - **`lastProgramPath` in `config2.json` is NOT the live active pattern.** It lagged by a full
    pattern for at least 8 s after an `activate()`, while `getState()` reported correctly. It is
    a boot pointer persisted on a cadence; use `getState()` for the live answer. This produced a
    false "restore failed" alarm before it was understood.
  - **The compiler is byte-identical across v3.51 and v3.67, and the v3.67 web UI is
    byte-identical between the dead board and the replacement.** Captured the web UI off the
    board before and after the firmware update (sha256 `b56656a9…` for 3.51, `a6f8424e…` for
    3.67) and compiled the fixture against each: bytecode, `.pbp` and exports all match, and all
    still match the committed `golden.json` — which was captured from the PRE-refactor CLI. The
    fresh 3.67 capture also hashes identically to the one vendored from the dead board. So
    `golden.json` is **left untouched**: its tie back to pre-refactor bytes is intact and now
    confirmed against a live current-firmware device, and re-capturing it would have traded that
    for nothing. **Settled, don't re-litigate:** its `bytecodeHex`/`pbpHex` stay in the repo —
    adjudicated not vendor IP, being the compiled output of this project's own fixture source.
  - **The 150 ms readback race did not reproduce on v3.51.** Bumped to 350 ms anyway (see the
    method's comment): with no ack there is nothing to synchronise on, and the failure mode is a
    silently-wrong read rather than an error.
  - **The ws server wedged during the first attempt.** That run made ~30 messages over ONE
    connection in ~15 s and closed cleanly; a fresh connect a minute later timed out while HTTP
    stayed healthy. Recovery was `POST /reboot` over the surviving HTTP, per the README
    playbook, first time.
  - ⚠️ **CORRECTION (2026-08-11, later the same evening).** That run's `getConfig()` reads were
    returning stale values, and this note originally concluded "a symptom of a degrading ws
    server, not a library defect." **That was wrong.** It was Chunk 24's queue bug: the first
    script called `getState()` early, which orphaned a settings frame that every later
    `getConfig()` then spliced; the second script never called `getState()`, so nothing was
    orphaned and the bug "didn't reproduce". Two runs differing in a way that looked like device
    health were actually differing in call order. Recorded because the reasoning was seductive
    and wrong: an independent oracle (`GET /config2.json`) correctly showed the CLIENT was
    lying, and the conclusion drawn from it — that the client was fine — inverted that.

### Chunk 17 — sensor board: live monitor
**The bring-up tool for the sensor board (arriving ~week of 2026-07-20) — build it first.
No dedicated wire frame exists:** sensor values reach clients only as pattern-exported vars the
firmware fills each frame, read back via `getVars` (the Vars-Watch mechanism). The Python client
has **no sensor support at all** — Chunks 17–18 are pbz-original ground.
- Ship `patterns/_sensors_probe.js` exporting all seven vars (see Appendix); render near-black —
  don't light the room just to read a mic.
- `pbz sensors`: remember the active pattern, `run` the probe (ephemeral, like `run`), poll
  `getVars` at ~10 Hz, draw a terminal dashboard — 32-bar FFT meter, accel xyz, light, analog
  inputs — and on exit/Ctrl-C re-`activate` the prior pattern. Warn (don't fail) when
  `getConfig().exp` bit 1 is clear: vars will sit at zero.
- Vars are sampled once per frame at end of render (firmware doc), so ~10 Hz polling is honest —
  don't promise audio-rate.
- **Acceptance:** board attached → clap moves the bins, tilt moves accel, covering the board
  moves `light`; exit restores the previously active pattern (verify with `get`).
- **Size:** M. Dashboard rendering and probe compile are buildable/testable before the board lands.

### Chunk 18 — sensor record / replay probe (builds on 17)
- `pbz sensors --record out.jsonl [--seconds n]`: same poll loop, one timestamped JSON line per
  sample. Deterministic fixtures for sound-reactive pattern dev — code against the same drum
  loop every time.
- **Replay probe — test, then decide:** with the board attached the firmware rewrites sensor
  vars every frame, so `setVars` injection probably loses the race. Bench-test once and record
  the verdict here; if it loses, replay is still useful with the board unplugged.
- **Acceptance:** a 10 s recording spanning a clap shows the transient in `frequencyData`/
  `energyAverage`; output is valid JSONL.
- **Size:** S–M.

### Chunk 19 — power sampling window + SB presence check
- `pbz power` samples ~30 frames of *whatever is happening right now* — a sound-reactive pattern
  in a quiet room reads misleadingly cheap, then spikes at a party. Add `--seconds n` (longer
  window) and, when `exp` shows a sensor board, a one-line advisory to sample during
  representative audio. Advisory only — the enforced cap (Chunk 11) is what actually guards the
  pathological case.
- `config --check` grows one assertion once the board is installed: SB present (`exp` bit 1).
  Its failure mode is silent — sound patterns freeze at zero ("the wall stopped dancing") — and
  the check makes that a one-command diagnosis.
- **Acceptance:** `power --seconds 10` on a sound-reactive pattern reports a higher peak with
  music playing than silent; `config --check` fails with the board unplugged (bench-verify once)
  and passes installed.
- **Size:** S.

### Chunk 20 — connection hygiene (added after a live incident, 2026-07-19)
**A validation script wedged the device.** A ~12-step library-driven sequence (each method opens
and closes its own websocket) hung mid-run, was killed, and left the Pixelblaze with its ws
server *and* HTTP dead and ICMP at ~600 ms (normal: single-digit) — the ESP32's network task
alive, the app starved by orphaned sockets. **Resolution (observed):** HTTP self-recovered in
~3 min as TCP orphans timed out; the ws server (port 81) **never** recovered — its slots leak
until restart — and needed `POST /reboot` (over the recovered HTTP) ~8 min in. So the failure
is asymmetric: HTTP heals, ws doesn't. Worse: the *freshly rebooted* ws server re-wedged after
just ~3 rapid CLI calls plus one client killed mid-`listPrograms` binary transfer — killed
clients mid-transfer are especially toxic. `POST /reboot` over the surviving HTTP cleared it
both times; no hardware power-cycle was ever required, so HTTP staying alive is the recovery
lifeline. (Silver lining, confirmed live: HTTP `GET /delete?path=…` works while ws is dead — a
truncated-save orphan `/p/<id>` file, present on flash but skipped by `listPrograms`, was
cleaned up over HTTP alone.) Two library defects made this worse than it needed to be:
- **`connect()`'s `opened` promise has no timeout** (`protocol.mjs`) — when the device stops
  accepting, every CLI command and library call hangs *forever* instead of failing. `waitText`
  already does this right (3 s, resolves null). Fix: reject `opened` after ~5 s with a clear
  "device not accepting connections" error; `die()` surfaces it.
- **One socket per method call multiplies exposure.** The per-method connect/close pattern is
  fine for single CLI invocations (its original design point) but a script calling 12 methods
  opens 12 sockets in seconds — the device (small lwIP socket table) chokes on the churn.
  Fix: let the class hold **one reusable connection** (lazy-open on first use, `pb.close()` or
  auto-idle-close ends it) so a multi-step script is one socket, matching how the web UI behaves.
  CLI behavior unchanged.
- **Acceptance:** with the device unplugged from the network, any `pbz` command fails within
  ~5 s with the clear error (not a hang); a 20-step library script completes over a single
  connection (verify with one `getStatus` interleaved — status frames arrive on the shared
  socket); smoke sweep green.
- **Size:** M. **Do this before 14/17** — backup fetches ~30 files and `sensors` polls at
  10 Hz; both are exactly the multi-call shapes that need it.
- **Landed 2026-07-19.** Two things the plan above didn't spell out, found live:
  - A **reused connection's waiters must consume, not peek.** The old `waitText`/`waitBinary`
    used non-consuming `find`/`shift`-any-type; fine when each method got a fresh socket with an
    empty queue, but once messages accumulate across calls (a `{"fps"...}` status frame every
    ~1 s regardless of what else is happening) a later call could re-match a message an earlier
    call already claimed, or `waitBinary`'s untyped `shift()` could hand a `list()` call a stray
    leftover preview frame from an earlier `samplePreview()`. Fixed: both now `splice()` out
    their match, and `waitBinary` takes a frame-type filter.
  - **`smoke.mjs` hung after printing "sweep passed"** — an open ws keeps the event loop alive,
    and nothing in that script ever called the new `close()`. `pb.close()`/`die()` closing at
    the end covers `pbz.mjs`, but any other caller (present or future) that forgets to close
    would hang forever. Added the **auto-idle-close** half of the fix explicitly (the plan named
    it as an alternative, not just a nice-to-have): `protocol.mjs` resets a 10 s timer on every
    send/receive and closes itself on true idle. `smoke.mjs` also now calls `pb.close()` for a
    fast, deterministic exit rather than relying on the 10 s backstop.
  - Verified live: a 20-call script (list/getState/getVars/getConfig/getStatus/getPeers/
    getInfo/getPlaylist/getMap ×2/ping, twice over, with `getInfo`'s internal `Promise.all`
    exercising concurrent callers sharing one in-flight `_getConn()` open) used exactly **one**
    underlying connection; `node pbz.mjs ping --host=<dead IP>` failed in ~5 s with the timeout
    error; `npm run smoke` and `npm test` both green.

**Second wedge, 2026-07-20 — the missing variable was a *foreign* ws client.**
> ⚠️ **Partly superseded by a later audit.** The device did not recover from this and was
> eventually replaced; the filesystem, not the churn described below, turned out to be at
> fault. Re-reading the session transcripts also corrected this note's specifics: the ~8-invocation chain ran *after*
> the wedge (all calls failed fast — the trigger was ~10 rapid one-shot invocations plus a
> 107 s stall just before); HTTP **never self-healed** (the "~20 min" below is wrong —
> recovery followed a power cycle ~46–48 min in); and the re-wedge took ~6 min under ~8
> connections, one exiting with its ws socket unclosed (not "~10 min under a single batched
> script"). Figures below are left as written; the corrections in this note supersede them.
 Chunk 16's live
acceptance wedged this device twice in one session. First trigger was ours and textbook: a single
shell line chaining ~8 separate `pbz` invocations back-to-back — rapid *sequential* connect/close
churn, exactly what `README.md`'s "Batch, don't loop" forbids. But the compounding factor,
not spotted until hours in, was that **a home-automation integration was polling the device
throughout**. A second long-lived ws consumer was on the device for the entire
session, so the "at most one long-lived consumer" rule was being violated the whole time while
only *pbz's* traffic was being counted. Symptoms ran worse than 2026-07-19: ICMP went to **100%
loss** (not merely degraded to ~600 ms) and HTTP took **~20 min** to self-heal, not ~3. After a
power-cycle the device came back genuinely clean (`smoke` green, `ping` 22 ms) — then **re-wedged
within ~10 min under a single batched library script**, i.e. careful behavior on pbz's side was
*not sufficient* while another client kept reconnecting into it. What this changes:
- **Chunk 20's fail-fast earned its keep.** Every hung call surfaced the 5 s `device not accepting
  connections` error instead of hanging, which is *why* the failure was diagnosable at all. No
  change needed here.
- **The client budget needs a pre-flight, not just prose.** The real rule is "know every consumer
  before device work" — HA pollers and stray web-UI tabs are consumers that never appear in your
  own terminal, so a quiet-looking shell is not evidence of a quiet device. The recovery playbook
  gains a **step 0: stop the other ws consumers first**; with a second client storming it, the
  "HTTP self-heals in ~3 min" assumption is optimistic at best and false at worst.
- **Don't diagnose from your own traffic alone.** The session's working conclusion — "a single
  well-behaved connection wedged it, so the device is more fragile than documented" — was simply
  wrong, and stayed wrong until the HA detail surfaced. Prefer "what else is talking to it?" over
  revising the device's fragility model.
- **It cascaded into the poller.** The unreachable device starved the home-automation
  instance's executor pool and took the whole thing down (TCP still accepting in 6 ms, no HTTP
  response in 8 s — event loop blocked, process alive). That blast-radius direction —
  device wedge → home-automation outage → everything else on that host affected — was not on
  the risk list before, and is the reason the etiquette section leads with the client budget.

### Chunk 22 — TypeScript declarations
Chunk 10 deferred types post-publish; this un-defers them, because the library half is
the valuable half and a consumer currently gets no completion on ~30 methods.
- Hand-written `lib/pixelblaze.d.mts`, wired through `package.json`'s `types` + `exports`.
- **Hand-written, not generated.** Generating from JSDoc would need a `tsc` build step and a
  checked-in generated artifact; "clone it and run it, nothing to install" is the pitch and
  it wins here.
- **Acceptance:** `tsc --strict --noEmit --module nodenext` passes on a consumer file
  exercising every method, *and* fails on a file that misuses them.
- **Size:** S.
- **Landed 2026-08-11.** Three things worth keeping:
  - **`.d.ts` next to a `.mjs` is invisible.** Under `moduleResolution: nodenext`, TypeScript
    wants `pixelblaze.d.mts`. The first type-check failed with "implicitly has an 'any' type"
    against a `.d.ts` that looked perfectly correct — the declarations were simply never
    loaded. Would have shipped silently; nothing in `npm test` could have caught it.
  - **The drift guard is shape-only, and says so.** `test/types.test.mjs` reflects over the
    prototype and compares against the members parsed out of the declaration file, so adding a
    method without declaring it fails the suite. It cannot check signatures. It carries a
    self-check test, and was verified by adding a real method and watching it fail.
  - **Read methods are declared honestly.** Wire-response shapes get the fields observed on
    v3.67 plus `[key: string]: unknown`, and every field is optional, because the set varies
    with firmware and hardware. A declaration that invents fields is worse than none: the
    editor will autocomplete something the device never sends.

### Chunk 23 — signature guard + JSDoc doc blocks
Chunk 22's declarations were verified once, by hand, in a throwaway directory. This makes that
verification a repeatable part of the repo, and closes the hover-docs gap in the sources.
- `test/types/{consumer,negative}.ts` + tsconfig; `npm run typecheck` runs them.
- **Zero devDependencies, deliberately.** TypeScript is caller-supplied; the script prints an
  install hint and exits 0 when absent. `npm install` in a fresh clone stays a no-op, which is
  the property the whole no-build design trades on.
- `//` -> `/** */` on public members in `lib/*.mjs`. Prose unchanged, no type tags.
- **Acceptance:** typecheck passes; loosening any declared signature makes it fail; it degrades
  cleanly with no compiler installed.
- **Size:** S.
- **Landed 2026-08-11.** Decisions and findings:
  - **The negative file uses `@ts-expect-error`, not an inverted exit code.** A guard that only
    ever passes is not a guard: with the directive, a signature that gets LOOSER makes the
    assertion stale and TypeScript reports "Unused '@ts-expect-error' directive". Verified by
    widening `setSequencerMode(0|1|2)` to `number` and watching typecheck fail on exactly that
    line, then reverting. Nine assertions, including that `_`-prefixed internals stay unreachable.
  - **`@types/node` is required too, not just `tsc`.** The declarations return `Buffer`, so with
    `skipLibCheck: false` the check cannot run without Node's types. The hint names both.
  - **Comments inside `compilerOptions` must be real JSONC comments.** A `_comment` KEY there is
    rejected as an unknown compiler option (it is tolerated at the top level, which is what made
    this look like it would work).
  - **The JSDoc pass is prose-only and stays that way.** Type tags in the `.mjs` would compete
    with the `.d.mts` for the same job with nothing checking they agree. If this ever moves to
    JSDoc-as-source (generating the `.d.mts`, the Preact/Svelte pattern), the tags get written
    then, as one atomic change, and the hand-written declarations are deleted in the same step.
  - Private methods and file headers keep `//`. Only public members got blocks: 53 across
    `lib/`, 37 of them in `pixelblaze.mjs`.

### Chunk 24 — response-correlation & fail-loud pass
From an independent fresh-context review of `lib/` before publishing. The findings were one
layer, not scattered: a prefix-matched queue nothing drained, plus timeouts treated as success.
On a tool that writes to hardware and produces files called "backups", the failure mode is
**confident wrong answers**, which is the worst kind for this project to ship with.

- **The queue moved to `lib/queue.mjs` and is now correlated.** Every message carries a sequence
  number; a caller takes `mark()` BEFORE sending and waits only for messages after it, so a
  frame already queued can never satisfy a later request. Queues are bounded (256) — the
  unclaimed ~1/s status frames grew forever otherwise. Split out from the socket specifically so
  it could be tested without one: `test/queue.test.mjs`, 12 hermetic tests.
- **Confirmed live which frames a request emits**, since the review flagged it as unverifiable
  from the code: `{getConfig:true}` produces **both `activeProgram` and `name`**. So `getState()`
  (which consumes `vars` + `activeProgram`) orphaned the settings frame, and `getConfig()` (which
  consumes `name`) orphaned the active-program frame. Each now claims both.
- **`getStatus()` waits for the NEXT status frame** rather than taking the oldest queued one,
  which on a long-lived connection was as stale as the connection was old.
- **Writes fail loudly.** `waitText` resolves null on timeout and `run`/`save`/`activate`/
  `setControls` discarded it, printing "saved & activated" after the device dropped mid-command.
  Reads already threw; writes now agree with them.
- **Chunked reads end on the framing's own last-chunk flag** (bit 4), not on a receive timeout.
  A gap longer than the timeout silently truncated: a short `list()` misread as "no pattern
  matching", a partial `getSources()` threw an opaque decompress error, a truncated jpeg was
  written without complaint. This device is documented stalling for 107 s.
- **`power.json` is validated.** A missing `all_four_max_amps` derived a NaN cap and sent
  `{"maxBrightness":null}`; a zero derived Infinity, clamped to 100, i.e. *no cap*, presented as
  "derived". A quoted `"7.5"` silently deleted a chain link — raising the cap if it was the
  binding one. All now throw.
- **`estimateDraw([])` and `save()` with zero preview frames throw** instead of reporting
  `-Infinity A` and writing a pattern whose empty thumbnail breaks the web UI.
- **`exp` is on BOTH the config and status frames** (verified live, `exp=0` on this rig), so
  `getInfo()`'s expansion decode was never broken. No change needed; recorded so it isn't
  re-investigated.
- **Acceptance:** 49 hermetic tests green; live regression check confirms `getState()` → write →
  read now returns the written value where it previously returned the pre-write one.
- **Size:** M.

**Known, recorded, NOT fixed** — deliberately deferred as post-publish work rather than widening
the fix surface before a first release:
1. ~~**Post-open ws errors are swallowed.**~~ — **DONE 2026-08-16, Chunk 29.** `onerror` only
   rejected the already-settled `opened` promise, and waiters got no close notification, so a
   mid-exchange drop spun out full timeouts. **This entry's own claim that `c.json()` then threw
   a raw `InvalidStateError` was wrong** — measured on Node 26.5.0, `send()` on a `CLOSING`/
   `CLOSED` socket throws nothing and discards the data, so the fire-and-forget writes silently
   reported success instead. A post-open error or close now calls `die()`, which records the
   cause and fails the queue, so parked waiters reject immediately with the real reason and sends
   throw rather than vanishing. A slow device still resolves null, so death and slowness stay
   distinguishable, and a waiter takes one last look before giving up so an answer that already
   arrived is never discarded. The half of the original entry that is NOT fixed is item 8's:
   `save()` still doesn't say it left a pattern loaded but unsaved.
2. **`import()` trusts the `.epe`.** A foreign-length `id` corrupts the fixed 17-byte
   putSourceCode header; a missing `name` crashes inside `stableId(undefined)`.
3. **`pbz set` has no validation on the non-picker branch** — `pbz set sliderSpeed` sends
   `{"sliderSpeed":null}`. Every sibling branch validates.
4. **`discover --ms` is unvalidated** — `--ms=abc` becomes `setTimeout(NaN)` (fires immediately),
   bare `--ms` becomes 1 ms; both print "(0 devices found)".
5. **`matchBraces` doesn't understand regex literals** (`compiler.mjs`). Latent: verified not
   biting on any current fixture, but a web UI containing `/}/ ` in a regex would break
   extraction.
6. ~~**The power ESTIMATOR path is unvalidated**~~ — **DONE 2026-08-12**, first thing after
   publication, because it was a documented instruction in a public repo that crashed the tool.
   `power.example.json` told RGB-strip owners to delete `measured.channel_bench_w_per_100px`,
   which crashed with "Cannot read properties of undefined (reading 'r')".
   The fix went further than not-crashing, because the obvious repair was worse than the bug:
   keeping the W-extraction model with a zero-amp white channel would route `min(r,g,b)` into
   nothing and estimate a white frame at roughly idle — a **3x underestimate**, in the one
   direction that matters when someone is sizing a supply. **RGB is now a real mode:** omit `w`
   and the estimator skips extraction entirely and counts all three channels, which is what an
   RGB strip actually draws. Deleting the whole block throws with a message naming the fix.
   `supply_voltage_v`, `pixel_count` and the r/g/b coefficients are validated. Six tests,
   including one asserting an RGB white frame costs far more than an RGBW one.
7. **`getState()` still tolerates null on both of its reads** and returns
   `{vars:{}, name:undefined, …}`, so `pbz get` prints "active: undefined (undefined)" against a
   silent device. The one silent-null path Chunk 24 left uncovered.
8. **Zero-frame `save()` throws, but only after the pattern is already running on the device**,
   and the message doesn't say so. A user who hits it is left with an unsaved pattern live on the
   wall and no indication that happened.
9. **Cap eviction can still produce a silent short read in `collectChunks`** — reproduced at
   `maxQueued` 3; needs >256 mid-transfer binary frames in practice. The surviving frame's flag
   bits would catch it (first-chunk bit clear on a frame that should start a transfer).
10. **`samplePreview(n)` for n > `maxQueued`** burns the whole 6 s window and returns 256 frames
    with no error. Nothing ties the public `n` to the queue cap.
11. **`getInfo()` now fails as a whole** (`Promise.all`) if the status cadence gaps past 3 s, on a
    device documented to stall for 107 s. Intended trade — a composite that silently returns
    partial data is worse — but recorded because it is a behavior change.

**Explicitly UNTESTED, don't assume otherwise:** `list()` against a device with **zero saved
patterns**. Chunk 24 moved it from a timeout-terminated read to a flag-terminated one, and the
empty case would be the one where no frame carries the last-chunk bit. No zero-pattern device was
available on this rig to check it. Types 4, 6 and 7 were all confirmed live to set the flag on a
NON-empty response (`pbz export` round-tripped a complete jpeg, `ffd8`…`ffd9`).

### Chunk 21 — per-host CLI lock (contingent — build only on observed need)
**The technical fix for cross-process bursts.** Chunk 20's shared connection is per-process;
separate sessions, parallel agents, and shell loops of `pbz` invocations still each open their
own socket, and only *guidance* (README.md "Device etiquette & recovery") restrains them.
Guidance mitigates but doesn't enforce. **Contingent:** land this only when parallel-invocation
churn is actually observed to recur — not speculatively; it's process machinery the single-user
CLI may never need.
- Zero-deps per-host mutex in `os.tmpdir()` keyed by host (e.g. `pbz-<host>.lock`): `mkdir`
  atomicity, holder pid + mtime inside; steal locks whose pid is dead or older than ~30 s.
- Acquire in the **CLI dispatch only** — library callers already hold one connection and
  compose into single processes; don't lock the class. Wait a few seconds with small jitter,
  then fail loud naming the holding pid.
- **Acceptance:** two concurrent `pbz list` invocations serialize (observable via timestamps);
  a SIGKILLed holder's stale lock is stolen on the next run; hermetic `node:test` for the
  acquire/steal logic (no device).
- **Size:** S–M.
- **Trigger still UNMET after the 2026-07-20 double wedge** — checked deliberately, because that
  incident reads at a glance like the trigger and isn't. Its churn was (a) rapid *sequential* `pbz`
  invocations, which are already serialized, so a mutex would have changed nothing, and (b) a
  foreign non-`pbz` client (the HA integration), which a `pbz`-only lock cannot restrain at all.
  Neither is the parallel-invocation shape this chunk addresses. The mitigation that incident
  actually argues for is Chunk 20's pre-flight consumer check — a cross-process lock would have
  bought exactly zero. Keep this chunk unbuilt.

### Chunks 25–28 — SPIFFS death-spiral defenses (added 2026-08-14, from a completed post-mortem)

Shared context, so each chunk below stays terse. The 2026-07-20 incident board
(felix-led-project, `INCIDENT-2026-07-20.md`, resolved 2026-08-14 and confirmed by Ben Hencke
in forum t/4738) died of SPIFFS fragmentation: 74% full, 26% free, but the free space smeared
across all 368 blocks with **zero fully-erased blocks**. On SPIFFS every write then needs
garbage collection, GC itself writes and chain-reacts, and — because ESP32 flash ops suspend
the flash cache the firmware executes from — the *whole* firmware loop degrades, network
included. End state: tiny writes take minutes or never complete, and the remedy (deleting
files) needs writes too, so **the remedy has a window that closes**. The board recovered only
via serial `erase_region` of the FS + `.stfu` reinstall + `.pbb` restore.

What's observable remotely: **storage fill** (`storageUsed`/`storageSize`, already on the
config frame — the fill is the leading indicator, since GC headroom is what runs out) and
**small-write latency** (the disease itself, visible early: seconds-long tiny writes precede
the cliff by weeks — the incident audit found flash anomalies *before* the first wedge). The
true variable, fully-erased block count, is invisible to any API; only a flash dump shows it.
These chunks turn the two proxies into warnings, and the remedy into a command that refuses to
run outside its window. Fleet calibration at time of writing: wall board (XL storage variant,
2.88MB FS) 36%; recovered spare (S variant, 1.4MB FS) already 40% with an ordinary pattern
load; the incident board died at 74% after months of churn.

### Chunk 25 — storage-pressure surfacing

- `info` already prints `storage: used / size (N%)`. Add a warning line at **≥60%** and a loud
  one at **≥75%** (cite the incident: a board died at 74%). Thresholds are constants, not
  config — this is a smoke alarm, not a preference.
- `pb.config.json`'s `expect` block (asserted by `config --check`) learns **`maxStoragePct`**.
  Exceeding it makes `--check` exit nonzero like any other expectation failure, so existing
  cron/pre-flight wiring inherits the alarm for free.
- `backup` prints the storage line after writing the `.pbb` — the moment someone is already
  thinking about device state.
- **Acceptance:** hermetic tests for the threshold math and `--check` wiring; live check that
  both house boards print the line and neither warns.
- **Size:** S.

### Chunk 26 — write-latency watchdog

- pbz already awaits acks on writes (Chunk 24 made them fail loud); it just never looked at the
  clock. Time every small-write round trip (`setConfig`, `delete`, control writes — not binary
  transfers, whose duration scales with payload) and keep a tiny rolling per-host baseline in a
  state file (`~/.pbz/latency.json`, host-keyed; a missing/corrupt file is a fresh start, never
  an error).
- Warn on stderr when a small write exceeds **max(3× baseline, 2 s)**: name the number, name
  the disease, point at `info`'s storage line. Never block or retry — this is telemetry with an
  opinion, not flow control.
- No active canary probe (save+delete of a test file was considered and rejected: it *adds* the
  churn it measures; passive timing gets the same signal free).
- **Acceptance:** hermetic tests with a fake clock (baseline update, cold start, threshold
  crossing); live check that normal operations on a healthy board stay silent.
- **Size:** S–M.

- **Implemented 2026-08-14 — the spec's premise didn't hold, and the design changed
  before code did.** "pbz already awaits acks on writes" is true for `setControls`/
  `activate`/`save`/`run` (Chunk 24), but **`setConfig` and `delete` are fire-and-forget**:
  the ack machinery was never wired to them, and both just sent + `sleep(150)` blind. That
  meant this chunk's clock had nothing to time on its own two most relevant methods. The
  orchestrator live-verified the wire assumptions against the real device (v3.67,
  2026-08-14) before deciding how to fix it:
  - A bare `setConfig` alone produces **no ack within 1.5s**.
  - A bare `deleteProgram` alone produces **no ack within 1.5s**.
  - A bare `{"ping":true}` acks in **13–84ms**.
  - `setConfig` then `{"ping":true}` on the same connection: the ping's ack arrives in
    **110–189ms** — consistently later than a bare ping, and consistently arriving at all.
  - `deleteProgram` then `{"ping":true}`: ack in **153ms**, same pattern.
  - **Zero stray acks** observed across the runs — nothing else on the connection was
    answering these pings.
  The device processes messages on one connection strictly FIFO, so a ping's ack is a real
  completion signal for whatever was queued ahead of it. **Decision: ping-chase.** Both
  methods now `mark()`, send the write, send `{"ping":true}` right behind it on the same
  connection, and await THAT ping's ack via the existing Chunk-24 `expectAck` helper —
  replacing the blind `sleep(150)` with a real wait for the device to have actually finished,
  not a guess at how long that might take.
  - **This is strictly better completion semantics, and it makes fail-loud apply to two
    methods that never had it.** `setConfig()`/`delete()` previously could not fail after
    the message was sent — the sleep always "succeeded". Now an ack timeout throws, same as
    every other write since Chunk 24. A dead or GC-stalling board makes these throw instead
    of silently reporting success, which is exactly the failure mode Chunk 24 closed
    everywhere else and this chunk's own motivating incident (SPIFFS death-spiral) argues
    for closing here too.
  - **The spec's "no active canary probe" rejection is still correct, and ping-chase doesn't
    reopen it.** The rejected idea was a save+delete cycle that *adds* write churn purely to
    measure it. A chased ping adds one small, ack-only message, immediately after a write the
    user already initiated — it never fires on its own, and it's not creating the disease it
    measures.
  - ~~Latency timing wraps the WHOLE ping-chased call~~ — **superseded by the local-review
    rework below.** The bracket now excludes target resolution/`list()` and the connection
    open; it covers only the write→ack span. See the 2026-08-14 (local review) note.
  - **`setVars`, `brightness`, and `limit` remain uncovered** — still fire-and-forget, no ack
    on the wire at all (confirmed in the existing code, not re-verified live this round).
    Extending the same internal ping-chase helper to them is the obvious follow-up if their
    write latency ever becomes suspect; not done here to avoid claiming timing coverage this
    chunk didn't actually verify for them.

- **Reworked 2026-08-14 (same day, local review) — the timing seam moved into the library,
  and three correctness gaps closed.** A local review of the first pass found the design above
  workable but the *measurement* wrong in a way that mattered, plus a real leak the "strictly
  better" framing missed. Applied, in order of how much they change the shape:
  1. **The measurement bracket moved from the CLI into `lib/pixelblaze.mjs` itself, and now
     covers only the write→ack span.** The first pass's `timedWrite()` CLI wrapper (since
     removed) timed the WHOLE awaited call, which for `activate`/`delete` meant
     `_resolveTarget()`'s own `list()` — a chunked BINARY read whose duration scales with
     pattern count — got folded into a baseline meant for small, fixed-size writes. Worse,
     because the baseline is host-keyed, a slow `list()` on an unrelated command could mask a
     genuinely slow `set-config` on the same host. Fix: the `Pixelblaze` constructor now takes
     an optional `opts.onWriteLatency(op, ms)` — a **constructor option, not a prototype
     member**, so `test/types.test.mjs`'s member-set guard is untouched; it's declared instead
     on a new `PixelblazeOptions` interface in `lib/pixelblaze.d.mts`, and exercised in
     `test/types/consumer.ts`. `setConfig`, `delete`, `setControls`, and `activate` each start
     their own clock right before their write is sent (after `_getConn()`/`_resolveTarget()`,
     before `mark()`) and stop it at ack receipt, then report through this hook — never letting
     a hook exception escape (`_reportWriteLatency` wraps the call in try/catch). The CLI no
     longer measures anything itself: `mkPixelblaze()` builds one `onWriteLatency` per instance
     and passes it to the constructor, so `seq time` (which calls `setConfig` under the hood)
     inherits coverage automatically instead of needing its own CLI-side label.
  2. **Stale-ack leakage, reproduced live: a retry right after a timeout "succeeded" in 11ms
     against the PREVIOUS call's own late ack.** Root cause: acks carry no request id — a
     device reply to an abandoned, timed-out write is indistinguishable on the wire from a
     reply to whatever runs next on the same connection, so it's fair game to satisfy either
     one's wait. This is a **protocol limitation**, not a queueing bug, and it is only closed
     here for the timeout case specifically (see the CORRECTION below for the attempt that
     didn't close it, and why): on an ack-wait timeout, `setConfig`/`delete`/`setControls`/
     `activate` now **quarantine the connection** (`_awaitAckOrQuarantine` in
     `lib/pixelblaze.mjs`: close it and drop `this._conn` to null, BEFORE rethrowing the
     original timeout, with the `close()` itself wrapped so it can never mask that error) —
     the device was already suspect, so a late reply now dies with the old socket, and the
     next call reconnects fresh (same ethos as Chunk 20's fail-fast). This is NOT a general
     fix for anonymous acks: it closes the specific "my own write just timed out" case, not
     every conceivable ordering. Consequence, now documented on the class and in
     `lib/pixelblaze.d.mts`: **concurrent writes on one `Pixelblaze` instance are
     unsupported** — two in-flight writes sharing a connection can't be told apart either,
     with no timeout involved to trigger a quarantine. Concurrent READS remain fine
     (`getInfo()`'s own `Promise.all` depends on this). `run`/`save` have the same class of
     stray-ack potential (noted by the reviewer) but are out of this chunk's scope
     (payload-scaling, not small writes) and were left alone.
     > ⚠️ **CORRECTION.** The first attempt at this fix added `lib/queue.mjs`'s `purgeText`
     > (the text analogue of `purgeBinary`), called immediately before `mark()` in all four
     > write paths, reasoning that a stale reply already sitting in the queue could be swept
     > out before a fresh wait began. A second verification round found this **did not work
     > and made things worse**: `mark()` already excludes anything queued strictly before it
     > (that's Chunk 24's own guarantee — the exact bug purgeText's own committed tests
     > confirmed, once read honestly: they passed with the "leak" scenario constructed so the
     > stale message arrived BEFORE the purge, which mark() alone already handles), so a purge
     > taken before mark() can never reach an ack that arrives AFTER it — precisely the timing
     > of the real 11ms repro. Worse, purging unconditionally on every call could steal a
     > **genuinely live** ack out from under a second, truly concurrent waiter on the same
     > connection: reproduced by delivering an ack, which sits claimable for up to
     > `waitEntry`'s ~10ms poll window, and having a second call's purge land in that window —
     > the first call then hung to its own timeout, worse than the bug being fixed. `purgeText`
     > was removed entirely (primitive, call sites, and its tests) and replaced with the
     > quarantine approach above. Recorded per this project's own convention (see Chunk 16's
     > correction) because the reasoning was plausible and wrong, not because the bug was
     > exotic.
  2b. **The floor/multiplier warn band has a real ceiling now, and the comments say so.** With
     `expectAck`'s old 3s default, a baseline past ~1s would hit a hard timeout before the
     3x-baseline warn arm ever got room to fire — a false negative disguised as "it just
     didn't warn yet." Both the ping-chase (`expectChaseAck`) and, by judgment call (noted
     here since the brief left it open), the other two timed writes now use a dedicated
     `WRITE_ACK_TIMEOUT_MS = 8_000` — a point on the incident's own scale: far past a healthy
     round trip, far short of the observed degradation (small writes taking MINUTES), and
     deliberately NOT `protocol.mjs`'s own `IDLE_CLOSE_MS` (10s): the original 10s pick
     exactly matched it, so the idle-close timer and the ack-wait timeout could race and fire
     at the same instant for reasons that had nothing to do with either constant — a
     coincidence a verification round's own tests had to route around instead of avoiding. 8s
     sidesteps the coincidence outright and still sits comfortably inside the incident's
     minutes-scale disease band. The ping-chase's timeout message now names the disease
     directly: `` no ack within 8s after <what> — device writes may be stalling (storage
     pressure?); check `pbz info`'s storage line ``. `lib/latency.mjs`'s `warnThresholdMs`
     comment now says explicitly that the floor/multiplier scheme only ever gets to warn
     across roughly a 2-8s band in practice — past 8s the write throws first, and that throw
     IS the late-stage signal, not a gap in the warn scheme.
  3. **The watchdog glue moved out of `pbz.mjs` into `lib/latency.mjs`'s `makeWatchdog`, a
     pure factory over injected `{host, readState, writeState, warn}`.** It was previously
     untested CLI code; now its exact behavior — reads state, scores the sample, persists
     (catching a `writeState` failure into one `warn()` line, never letting persistence
     failure suppress a latency warning or vice versa), and builds the warning message with
     the PRIOR baseline — is covered by `test/latency.test.mjs` directly, without a device or
     even a real filesystem. `pbz.mjs` now supplies only `readLatencyState`/`writeLatencyState`
     (the fs half) and wires `makeWatchdog`'s output into the constructor. (An accepted-but-
     unused `now` parameter from the first pass was dropped in review — `ms` already arrives
     pre-measured, so there was nothing for a clock to do.)
  4. **Micro fixes, applied:** `applySample` now treats a non-finite stored `baselineMs` (a
     hand-edited `"abc"`, a `NaN` that somehow round-tripped) as no-baseline via
     `Number.isFinite`, rather than trusting a bare nullish check — a poisoned entry used to
     stay poisoned forever, silently un-warnable. `writeLatencyState` writes a temp file in the
     same directory and `renameSync`s it over the target, so a concurrent reader can never
     observe a torn write that wipes every host's baseline, not just the one being updated —
     and now `unlinkSync`s that temp file if the rename itself fails, so a filesystem error
     doesn't also leak a stray `latency.json.<pid>.tmp`. `test/types/negative.ts` gained a
     `@ts-expect-error` for `onWriteLatency` being given a non-function value.

### Chunk 27 — backup-freshness nudge

- Before destructive multi-file operations (`restore --prune`; extend if others appear), look
  for the newest local `*.pbb` whose contents match the target device (chipId in the filename
  per the `backup` naming convention, cwd + the config-walk directory). Older than **7 days**
  or absent → print a one-line nudge with the exact `backup` command. Nudge, not gate: no
  prompt, no flag, no refusal — the incident lesson is that the backup you want is the one
  taken *before* you needed it.
- **Acceptance:** hermetic test of the freshness scan; live run showing the nudge and its
  silence after a fresh `backup`.
- **Size:** S.

### Chunk 28 — `defrag`: OTA deep clean

The firmware exposes no GC/format endpoint (`SPIFFS_gc()` exists in the library but isn't
surfaced — worth a feature request to Ben someday, though FASTFFS may obsolete it). But GC runs
as a side effect of writes, and deletes give it something reclaimable, so a full reclamation is
composable over the API **on a still-healthy board**: backup → delete all pattern/playlist
files → restore. After the mass delete most blocks hold little live data, GC's copy step is
nearly free, blocks get erased wholesale, and the restore lands in freshly-erased space —
the serial-erase recovery, minus the web-app region, minus the bench.

- `pbz defrag`: (1) take a fresh `.pbb` this run and **verify it decodes** (Chunk 14 parser)
  before anything else; (2) **health gate**: time one small write; if it exceeds Chunk 26's
  threshold, refuse with an explanation — a board already grinding may not survive the delete
  phase (measured on the incident board: deletes never completed), and the right move there is
  triage, not defrag; (3) delete `/p/*` and `/l/*` **only** — never `.gz` (the web app lives on
  the same FS and losing it is the incident's recovery-mode dance), never `config*.json`,
  never `pixelmap.*`, never `obconf.dat`; (4) restore from the just-taken `.pbb`, skipping
  byte-identical files is moot here (everything was deleted) but the restore path must confirm
  each file; (5) verify: `list` matches the pre-delete inventory, and print storage before/after.
- One connection throughout (Chunk 20's shape), fail loud mid-sequence and say exactly how far
  it got — a half-defragged board with a verified `.pbb` in hand is inconvenient, not lost.
- `--yes` required, like `restore`.
- **Acceptance:** hermetic tests for the file-classification rules (the never-delete list is
  the safety property); live run on the S-variant spare (the board that exists to absorb this
  kind of test), showing inventory identical and storage-used unchanged or lower.
- **Size:** M.

- **Landed 2026-08-14 (hermetic half only — see below).** `classifyForDefrag`
  (`lib/backup.mjs`) is default-deny by construction (`/p/*` or `/l/*`, minus a
  case-insensitive `.gz` exclusion), never an enumerated blocklist — covered by
  23 tests in `test/backup.test.mjs`, including a golden test partitioning the
  Appendix's exact 2026-07-19 device inventory (24 patterns + playlist deletable,
  7 protected files kept). `defragHealthGate` (`lib/latency.mjs`) is a **deliberate
  divergence from `recordSample`**: a one-shot go/no-go gate can't inherit
  `recordSample`'s cold-start-never-warns rule, because there's no "next sample"
  for a fresh host to fall back on — the 2s floor governs cold and warm hosts
  alike here, proven by an explicit test that shows the same inputs disagree
  between the two functions. `Pixelblaze#defrag` composes `saveBackup` →
  decode-verify → `getStatus`/`list` (before-figures) → warmed `getConfig` +
  timed `setConfig` health gate → a `GET /delete` loop over the backup's own
  key set (never a fresh `/list` — nothing is deleted unless already
  decode-verified in the backup) → `restoreBackup` (no `--prune`, moot: the
  delete loop already removed exactly what a prune pass would look for) → a
  new private `_waitForReboot` (polls `ping()` after `close()`, since
  `restoreBackup()`'s own `/reboot` POST doesn't wait for the device to come
  back) → a two-way pattern-id-set verify → after-figures. Every failure mode
  names how far it got and the verified backup to recover from, per the spec.
  `pbz defrag --yes` checks `--yes` before any I/O (stricter than `restore`,
  which resolves the host first) and wires the health gate from
  `readLatencyState` + `defragHealthGate`. **Live acceptance COMPLETE 2026-08-14**
  on the S-variant spare (192.168.1.187, v3.67): full run clean end-to-end —
  36-file backup decode-verified, health gate passed against the real ~137ms
  baseline, 31 `/p/*`+`/l/*` files deleted, 5 non-pattern files kept, 36
  restored, reboot survived, two-way inventory verify passed (27 patterns),
  storage before/after identical at 551196/1378241 (39%) — "unchanged or
  lower" holds; a healthy FS has nothing to reclaim, the run proves the
  composition safe. `_waitForReboot`'s `45000`/`1000` defaults worked
  first try (the spare answers pings again well inside the window); no
  tuning needed. One non-pbz observation from the run: the round-tripped
  `config.json` surfaced that the spare's `discoveryEnable` had drifted to
  `true` at some earlier point (pre-defrag backup proves defrag innocent);
  reset to `false` per the installation's documented spare config.

- **Reviewed and amended same day — one blocker, four should-fixes.** A
  hermetic-only review (no device contact, same constraint as the session
  above) found:
  1. **BLOCKER — the CLI's health gate read its own baseline AFTER the
     gate's own write had already updated it.** `setConfig`'s ping-chased
     ack fires `_reportWriteLatency` -> `onWriteLatency` -> `makeWatchdog` ->
     `writeState` SYNCHRONOUSLY, before `setConfig()`'s promise resolves back
     to `defrag()` — so a gate closure that read state lazily was always
     grading a sample against the baseline that sample itself had just
     produced. Measured effect: a cold host could never refuse (a cold
     sample seeds the baseline at itself, so `threshold >= sample` always);
     a warm host's effective multiplier silently loosened toward the EMA of
     the very sample under test. Fix: `buildDefragHealthGate` moved into
     `lib/latency.mjs` and takes its baseline snapshot SYNCHRONOUSLY at
     build time (`readState` injected), not lazily inside the closure it
     returns — and building the closure is itself part of `pb.defrag(...)`'s
     own argument list, so the snapshot is guaranteed to land before
     `defrag()`'s first write. New composed regression tests in
     `test/latency.test.mjs` wire `makeWatchdog` + `buildDefragHealthGate`
     together against a shared in-memory store and pin the exact two cases
     that escaped isolated unit testing: cold host + 6000ms sample ->
     refused; warm 1000ms baseline + 5000ms sample -> refused.
  2. `classifyForDefrag` hardened against traversal- and whitespace-shaped
     input ahead of the prefix check: any path with leading/trailing
     whitespace, a doubled `//`, or a literal `.`/`..` path segment is now
     always `kept`. SPIFFS is flat, so these almost certainly never occur as
     real `/list` keys — this is belt-and-braces on the "default-deny by
     construction" claim for arbitrary input, not a response to an observed
     device behavior. 6 new tests.
  3. `_waitForReboot` could vacuously succeed against the NOT-YET-rebooted
     device: `reboot()`'s `POST /reboot` returns as soon as the ESP32 ACKs
     the HTTP request, well before it actually restarts, so an immediate
     ping could land in that window and falsely confirm — making the verify
     step read pre-reboot state as post-restore. Fixed: sleeps `pollMs`
     before the FIRST attempt too (not just between retries), and now
     requires TWO CONSECUTIVE successful pings before returning (any
     failure in between resets the count). Real cadence, now documented in
     the method's own comment: a failed ping costs up to protocol.mjs's
     ~5s open timeout plus ping()'s own ~3s ack wait (~8s worst case), so
     `pollMs` governs only the gaps between successes, not the failure
     retry interval — at the defaults that's roughly 5-6 real attempts in
     45s, with possible overshoot to ~53s, not a precise 45s cutoff.
  4. Steps (2)-(3) (`getStatus`, `list`, `getConfig`, the gate's own timed
     `setConfig`) now wrap their errors the same way step (1) does — naming
     what was attempted and that a fresh, decode-verified backup already
     exists with nothing deleted. The likeliest single failure of the group
     is the gate's own `setConfig` hitting its Chunk-26 8s ack timeout on a
     board that's already struggling, which is exactly the disease the gate
     exists to catch before anything is deleted.
  5. The gate-refusal message now guards `gate.message` being omitted (legal
     per the d.mts — `test/types/consumer.ts` now models a gate that returns
     `{ok:false}` with no message) instead of interpolating `undefined`, and
     no longer claims "nothing else was touched" — the gate's own
     `setConfig({name})` is itself a flash write that already happened by
     the time the refusal is thrown; reworded to name that write explicitly
     as the one thing that was sent.
  Nits also applied: the classification-test count above is now the real,
  recounted 23 (was miscounted as 16, then 17); the decode-failure message
  reads "aborting before mutating the device" (saveBackup already reads
  everything, so "touching" overclaimed); the CLI's kept-count line reads
  "kept N non-pattern file(s)" (the prior wording undersold what's
  protected — the `.gz` web-app blobs aren't even in the backup to count).

### Chunk 29 — connection death is an event, not a timeout

Post-publish item 1, and the last of Chunk 24's fail-loud family: that pass made *timeouts*
honest, and this one makes *drops* honest. `ws.onerror` was wired inside the `opened` promise,
so it could only ever reject the open. Once open, `opened` is settled and rejecting it again is
a no-op, so every post-open error went on the floor. Nothing told the queue either, so a parked
waiter sat out its full timeout and then reported a timeout. The device got blamed for ignoring
a command that nothing was listening to.

**Correction to item 1's own wording, measured on Node 26.5.0 while building this:** the old
entry said the next send "throws a raw `InvalidStateError`". It does not. `send()` on a WHATWG
`WebSocket` in `CLOSING` **or** `CLOSED` throws nothing and discards the data — only `CONNECTING`
throws. So the real prior behaviour was **worse** than recorded: every fire-and-forget write
(`setVars`, `setBrightness`, `setMaxBrightness`, `setSequencerMode`, `setSequencerState`,
`nextPattern`, `setPlaylist`) *silently reported success* against a dead socket. Those methods
can now throw where they previously could not; their JSDoc says so.

- **One `onerror`, two eras.** Before open it rejects `opened` as before. After open it calls a
  new `die()`, which records the cause once, disarms the idle timer, and hands the error to the
  queue. `ws.onclose` routes there too, so a device that simply hangs up is caught even though
  it never fires an error.
- **`queue.fail(err)` rejects every parked waiter now, and every later one on arrival.**
  Waiters reject rather than resolving null, so callers get the transport's real reason instead
  of `expectText`'s generic "timed out … the command may not have taken effect". A slow device
  still resolves null: **death and slowness stay distinguishable**, which is the property the
  tests pin. Frames that arrived before the drop are deliberately kept — `peekBinary`/
  `purgeBinary` never block and their data is still real.
- **First cause wins, so both messages stand alone.** A close event always follows an error
  event, so `die()` and `fail()` are idempotent in favour of the first. The first cut assumed the
  error was always the more specific of the two; it is the opposite. undici's `ErrorEvent` has an
  **empty `.message`** and carries the real cause on `.error`, so reading `.message` degraded
  every real death to the literal string "connection error" — which then beat the close event's
  richer text. Both paths now name the device and point at the recovery playbook, and the error
  path reads `.error` first.
- **A dying waiter takes one last look.** The most serious defect the review of the first cut
  found: `fail()` aborted parked waiters without a final poll. Waiters run on a 10ms interval and
  the ws stack dispatches buffered message events and the close event in the *same batch*, so
  "device answers, then hangs up" reliably left the answer sitting unclaimed. That turned a write
  the device genuinely completed into a reported failure — Chunk 24's own failure class, reached
  from the other direction. `abort` now ticks once before rejecting, and the same applies to
  `collectFrames` (peek before checking liveness) and to a wait that starts already-dead.
- **Our own closes are recorded at the moment we initiate them**, not when the close event
  comes back. A real `ws.close()` returns with `readyState` `CLOSING` and dispatches `close` a
  turn later, and a send in that window silently no-ops — reporting success for a write that went
  nowhere, which is the whole disease. Stashing a cause for the later event also mislabelled a
  device hangup that raced our idle timer as our own timeout, losing the close code.
- **Sends check first.** `json`/`sendBytecode` throw the recorded cause instead of letting
  `InvalidStateError` out. `collectFrames` checks inside its poll loop, so `save()` no longer
  spends its full 6s preview window waiting for frames a dead socket cannot deliver.
- **Our own closes are labelled.** `close()` reports "closed by pbz" and the idle backstop
  reports "no request used it for Nms", so neither reads like a device fault. A real hangup
  names the device, the close code, and points at the README's recovery section.
- **The idle backstop no longer kills a slow chunked read.** `collectChunks` was wrapped in
  `using()`, which re-arms once at call time, so a transfer healthy chunk-to-chunk but slower
  overall than `IDLE_CLOSE_MS` tripped our own backstop — which then reported "no request used
  it" about a connection a request was actively using. It now re-arms per **claimed** chunk,
  which is the honest usage signal (re-arming on every inbound message is the version that
  failed before: the ~1/s unsolicited status frames made the backstop dead code).
- **Acceptance:** 19 new hermetic tests (6 in `queue.test.mjs`, 13 in `protocol.test.mjs`),
  192 total, typecheck green. Several assert *timing* — a drop must fail the wait in well
  under the wait's own window — because "fails eventually" was never the bug. Verified
  load-bearing by reverting the library and re-running: all of the first 12 fail against the old
  code, and four targeted mutations of the new code are each caught.
- **Live-verified 2026-08-16 on the spare (192.168.1.187), and it corrected the story.** Killing
  the board with `POST /reboot` under a parked 12s wait rejected it at **10014ms** — which is
  `IDLE_CLOSE_MS`, not the device. A rebooting ESP32 sends no FIN, so a socket that is only
  *listening* learns nothing; our own idle backstop was what forced the issue. Re-run with a
  send after the reboot: the stale send itself returns no error (the OS hasn't noticed at
  +1ms), the RST comes back, and the parked wait rejects at **1945ms** with
  `websocket: connection error (mid-exchange, 192.168.1.187:81)`. So the honest characterisation
  is **detection needs traffic**: every request/response method sends before it waits, so those
  see ~2s; a pure listener (`getStatus()` marks and waits without sending) waits out the idle
  backstop. Both are improvements on the old full-timeout-then-`InvalidStateError`, but only the
  first is fast, and the chunk should not be read as claiming otherwise. Note also that the
  idle backstop's own label never surfaced in run 1: `onerror` fires before `onclose` on a dead
  peer, and first-cause-wins correctly prefers "the peer is gone" over "we idled out".
- **Size:** S. No API change; `_getConn`'s `readyState` check already reconnects, so a death
  mid-method costs the caller one reconnect on the next call.
- **Deliberately NOT in scope:** `save()` still doesn't tell you it left a pattern loaded on the
  device but unsaved. That is post-publish item 8, whose complaint is exactly that, and it is
  cheap on top of this now that the errors reaching it are coherent.

---

## Appendix — verified wire formats (firmware v3.67)

WebSocket at `ws://<host>:81`. `save:true` persists to flash; `save:false` is live-only.

| Op | Message |
|----|---------|
| Global brightness | `{"brightness": <0..1, step .005>, "save": <bool>}` |
| Brightness limit | `{"maxBrightness": <0..100 clamped>, "save": true}`  ← **percent**, not 0..1; key is `maxBrightness` not `brightnessLimit` |
| Get config | `{"getConfig": true}` (UI sends it with `{"sendUpdates":false,"getConfig":true,"listPrograms":true,"getUpgradeState":true,"getPeers":1}`) |
| Set config | `{"<key>": <val>}` — **no `save` key**, persists immediately (verified live) — keys: `name, pixelCount, ledType, dataSpeed, colorOrder, cpuSpeed, discoveryEnable, timezone, autoOffEnable, autoOffStart("HH:MM"), autoOffEnd, networkPowerSave, sequenceTimer, brandName, simpleUiMode`. **Produces no ack of its own** (verified live 2026-08-14, v3.67: none within 1.5s). Chunk 26 ping-chases it: a `{"ping":true}` sent right after, same connection, acks only once this write is processed (FIFO ordering) — 110-189ms observed, vs 13-84ms for a bare ping. |
| Get vars | `{"getVars": true}` → `{"vars": {...}}` |
| Set vars | `{"setVars": { name: value, ... }}` |
| Set controls | `{"setControls": {...}, "save": <bool>}` (existing) |
| Sequencer mode | `{"sequencerMode": 0\|1\|2}` (0 Off, 1 ShuffleAll, 2 Playlist) |
| Sequencer run/pause | `{"runSequencer": <bool>}` (the UI play/pause button) |
| Sequencer next | `{"nextProgram": true}` |
| Shuffle interval | `{"sequenceTimer": <n ≥ 1>}` — plain config key, **SECONDS** on the wire (UI refuses < 1). Verified live 2026-08-11 on **v3.51 and again on v3.67**: the persisted `config2.json` holds the same value in **milliseconds** (ws 20 → file 20000), and `maxBrightness` splits the same way (ws `55` → file `0.55`). Don't assume wire units when reading the device's own files. |
| Picker controls | `setControls` values may be 3-arrays: `{"hsvPicker<Name>": [h,s,v]}` / `rgbPicker` `[r,g,b]`, components 0..1 |
| Get playlist | `{"getPlaylist": "_defaultplaylist_"}` |
| Set playlist | playlist object, `items:[{"id","ms"}]` |
| Get source (for export) | `{"getSources": "<id>"}` → binary **SOURCESDATA frame, type 6** (`[type][flag]` + payload), payload chunks concatenated then run through the device's own `LZString.decompressFromUint8Array` → `JSON.parse` → `{main: "<source>", blockly?: ...}`. Reuses `lib/compiler.mjs`'s LZString extraction (`makeLZDecompress`, the inverse of `makeLZ`). |
| Get thumbnail (for export) | `{"getPreviewImg": "<id>"}` → binary **THUMBNAILJPG frame, type 4** — `[type][flag]` + 17-byte id (ASCII) + jpeg chunk; concatenate the post-id payload across frames for the full jpeg. |
| Delete pattern | `{"deleteProgram": "<id>"}` — fire-and-forget on its own, no ack (matches web UI; verified live 2026-08-14, v3.67: none within 1.5s). Chunk 26 ping-chases it: a `{"ping":true}` sent right after, same connection, acks only once this write is processed (FIFO ordering) — 153ms observed, vs 13-84ms for a bare ping. |
| List patterns | `{"listPrograms": true}` → chunked binary type 7 (existing) |
| Activate | `{"activeProgramId": "<id>"}` (existing) |
| Ping | `{"ping": true}` → `{"ack": 1}` (verified live — not the boolean `true` this table originally guessed) |
| Get peers | `{"getPeers": 1}` |
| Preview frames | `{"sendUpdates": true}` → binary type 5 frames (existing); `false` to stop |

**Pixel map (two parts — see Chunk 8):**
- Render map (what the LEDs use): binary **PIXELMAP frame, type 8** — `Uint32[2, dimensions,
  byteLen]` header + `Uint16` coordinate array, produced by the web UI's `sendMap()` after
  `normalizeMap()` evaluates the source. The device does **not** run the JS map; pbz must
  compute this headless (reuse `lib/compiler.mjs`'s `node:vm`/extraction infra).
- Source text (persistence/editor): `POST /edit` filename `/pixelmap.txt`, then ws
  `{"savePixelMap": true}`. `GET /pixelmap.txt` reads it back.

**HTTP endpoints (not websocket):**
- `GET  http://<host>/index.html.gz` — web UI (source of the compiler + LZString + map fns).
- `GET  http://<host>/pixelmap.txt` — current pixel-map source text.
- `POST http://<host>/edit` — multipart upload, field `data` (map source; Chunk 14 restore).
- `POST http://<host>/reboot` — restart the device.
- `GET  http://<host>/list` — flash file listing, one `filename<TAB>size` per line, trailing
  blank line. **Verified live 2026-07-19** — this device's inventory: 24× `/p/<id>` patterns,
  `/l/_defaultplaylist_`, `config.json` **and** `config2.json`, `pixelmap.txt` **and**
  `pixelmap.dat` (the computed binary map), `obconf.dat` (1 B stub), `recovery.html.gz` +
  `index.html.gz` (the `.gz` skips). No `/p/<id>.c` control-state files exist here — the
  firmware creates them only once a pattern's controls are saved; backup must not assume them.
  Downloaded byte size matches the listing.
- `GET  http://<host>/<path>` — download any listed file.
- `GET  http://<host>/delete?path=<path>` — delete a file (restore `--prune` internals only;
  never a raw CLI verb).
- `POST http://<host>/backupFsImage` — device-side full-flash image; restore by holding the
  button at power-up. LEDs off while it writes.

**Backup format (`.pbb` — verified against web UI v3.67 + Python client):** JSON text, *not* a
zip: `{"files": {"<path>": "<base64>", …}}`, possibly BOM-prefixed (tolerate `utf-8-sig` on
read). Both the web UI and the Python client exclude the `*.gz` web-app files; WiFi config is
never included. The web UI assembles it fully client-side (`/list` → fetch each → base64) —
there is no device-side backup endpoint except the separate `backupFsImage`.

**Sensor board (SB 1.0):** no dedicated ws frame. Sensor values exist only as pattern-exported
vars the firmware fills each frame — `frequencyData[32]` (12.5 Hz–10 kHz bins), `energyAverage`,
`maxFrequency`, `maxFrequencyMagnitude`, `accelerometer[3]` (±16 G xyz), `light`,
`analogInputs[5]` (A0–A4) — sampled at end-of-render, read via `{"getVars": true}`. Presence:
`getConfig().exp` bitmask, bit 1 = SB, bit 2 = six-axis (already decoded by `getInfo`).

**Discovery:** UDP beacons on port **1889** (`node:dgram`); also the cloud service at
`discover.electromage.com` if `discoveryEnable` is on. Beacon packet (**verified live**
against this device, firmware v3.67): 12 bytes, three little-endian `uint32`s —
`[packetType (42 = beacon), chipId, timestamp (ms since boot)]`. `chipId` matches
`getConfig().chipId` exactly, confirming the field. `Pixelblaze.discover()` is `static`
(no host — that's the point) and only listens; it never sends.

**Binary frames (existing, in current save/run path):** `[type][flag] + ≤1280B` chunks;
flag bit1=first, bit2=middle, bit4=last. type 1 = putSourceCode (`.pbp`), type 3 = setCode
(live bytecode), type 5 = preview, type 7 = program list, type 8 = pixel map.

## Notes carried from exploration
- Web UI structure: **Patterns** (Sequencer Off/Shuffle/Playlist + Saved list with
  Edit/Clone/Share/Export/Delete + global brightness slider) · **Edit** · **Mapper** ·
  **Settings** (all config above) · **WiFi**. Status dropdown = the `info` command's contents.
- **Skip from the Python client:** raw `getFile/putFile/deleteFile` CLI verbs (footgun — though
  Chunk 14's backup/restore uses the same HTTP endpoints internally; see the amended decision
  above), `setBrandName`/reseller, follower-management (single controller here). It has **no
  sensor-board support at all** (Chunks 17–18 are pbz-original). Its `reboot` and
  `brightnessLimit` formats are **wrong for this firmware** (use `POST /reboot` and
  `maxBrightness`); and its map handling is **incomplete for our purpose** — setting a map
  requires computing the coordinate array from the JS source (type-8 frame), which the device
  can't do itself. Use this Appendix + Chunk 8.
