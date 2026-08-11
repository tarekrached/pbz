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
- **Add a public method, declare it in `lib/pixelblaze.d.mts`.** `npm test`
  compares the declared member set against the real one and fails if they
  diverge, but it cannot check that a *signature* is right. If you change one,
  verify with a TypeScript compiler you supply yourself (there is no devDep):
  point `tsc --strict --noEmit --module nodenext` at a file that imports the
  class and uses the method. Declare only what the device was actually observed
  to send; the read methods use an index signature for the rest, deliberately.
- Read methods that map 1:1 to a wire response return it parsed and unrenamed.
  Composites build on those accessors and only add fields that bake in a decode.
  Cosmetic labeling is the CLI's job.
