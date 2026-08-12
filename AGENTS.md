# AGENTS.md

Instructions for coding agents working in this repo (Codex, Cursor, and anything
else that reads this convention; Claude Code reads `CLAUDE.md`).

**Read [README.md § Device etiquette & recovery](README.md#device-etiquette--recovery)
before running anything that talks to a Pixelblaze.** That section is the single
source of truth and this file deliberately does not restate it — the short
version is that the device's network stack is small, scripted bursts of separate
CLI invocations are what actually wedge it, and a killed-mid-transfer client is
the worst thing you can do to it. Batch into one script over one connection.

Everything else:

- No runtime dependencies. Node ≥ 22 built-ins only. The one vendored file is
  `lib/jpeg-encoder.cjs` and it stays the only one.
- Tests are `node:test` + `node:assert`, run with `npm test`. Files must be named
  `*.test.mjs`. `npm run smoke` is a read-only live sweep against a real device.
- The tests that need the device's web UI skip unless you have captured one with
  `npm run fixture`. That capture is gitignored on purpose — it is the device
  vendor's copyrighted application and must never be committed.
- The `Pixelblaze` class takes a host in its constructor and knows nothing about
  argv or config files. Host resolution belongs to the CLI.
- **Add a public method, declare it in `lib/pixelblaze.d.mts`**, and exercise
  it in `test/types/consumer.ts`. Two guards cover this, and they cover
  different things: `npm test` compares the declared member SET against the real
  one, and `npm run typecheck` checks the SIGNATURES. Run both.
- **`npm run typecheck` needs a compiler you supply yourself.** TypeScript is
  deliberately not a devDependency, so `npm install` stays a no-op; the script
  prints an install hint and exits 0 when it can't find one. Nothing in it is
  needed to *use* pbz.
- **`test/types/negative.ts` asserts things that must NOT compile**, via
  `@ts-expect-error`. If you loosen a signature, the matching directive becomes
  unused and typecheck fails with "Unused '@ts-expect-error' directive". That is
  the guard working, not a spurious error: decide whether the looser signature
  is intended, then update the assertion.
- Declare only what the device was actually observed to send. The read methods
  use optional fields plus an index signature for the rest, deliberately: a
  declaration that invents fields is worse than none.
- Doc comments on public members are `/** */` so editors surface them on hover;
  `//` is for internals. Types live in the `.d.mts`, not in JSDoc tags, so
  there is exactly one place to update a signature.
- Read methods that map 1:1 to a wire response return it parsed and unrenamed.
  Composites build on those accessors and only add fields that bake in a decode.
  Cosmetic labeling is the CLI's job.
