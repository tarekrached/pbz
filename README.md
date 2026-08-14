# pbz

An unofficial command-line tool and JS library for [Pixelblaze](https://electromage.com)
LED controllers. Node 22+, **zero dependencies**, no browser, no Python.

```sh
pbz run patterns/sweep.js        # compile + push it live, watch the wall
pbz set sliderSpeed=0.8          # tune it while it runs
pbz save patterns/sweep.js       # persist it, with a real preview thumbnail
```

I built this for a 170-pixel WRGB ring on some LED strips at home, because I
wanted to keep patterns in git and iterate from a text editor instead of a
browser tab. It grew a lot of edges. It is not affiliated with ElectroMage.

<!-- TODO(demo): drop the wall GIF here. `pbz run` on a pattern, then a `pbz set` tweak. -->

## How it works (the interesting part)

**Pixelblaze compiles patterns in the browser, not on the device.** The ESP32
only ever receives bytecode. That's why every headless tool for it has had to
either reimplement the compiler or give up on compiling.

pbz does neither. It downloads the web UI off your device
(`GET /index.html.gz`), pulls Ben Hencke's own `window.compile` and `LZString`
out of it, and runs them in `node:vm`. The compiler comes from the device, so
the bytecode always matches the firmware that device is running, including
firmware pbz has never heard of. Nothing is redistributed; it borrows the code
at runtime, from your own hardware.

The same trick handles the pixel map. The device can't evaluate map JS either,
so `map set` extracts the web UI's `normalizeMap`, runs it headless, and sends
the packed binary frame, rather than reimplementing the normalization math and
hoping it matches.

## Install

```sh
git clone https://github.com/tarekrached/pbz.git
cd pbz
cp pb.config.example.json pb.config.json    # your device's address goes here
./pbz.mjs ping
```

There is nothing to build and nothing to `npm install`. If you'd rather not keep
a config file, every command takes `--host=192.168.1.50` or reads `$PB_HOST`.
`npm link` (or a symlink into your `PATH`) gets you a bare `pbz`.

Config files are looked up **from the current directory upwards**, then from
pbz's own directory. That's so a project can keep its own `pb.config.json` and
`power.json` next to its patterns and have a globally installed `pbz` use them.

## Commands

```sh
# --- patterns ---
pbz compile patterns/foo.js         # validate + list exported controls; sends nothing
pbz run patterns/foo.js             # push live, NOT saved. The iteration loop
pbz save patterns/foo.js [Name]     # persist + activate, renders a preview thumbnail
pbz list                            # saved patterns, id + name
pbz activate "Rainbow Worms"        # switch the active pattern
pbz delete "Old Thing"
pbz export "Rainbow Worms"          # -> .epe, same shape the web UI's Export writes
pbz import "Rainbow Worms.epe"      # recompiles locally, reuses the original id

# --- live control ---
pbz get                             # the active pattern's current control values
pbz set sliderSpeed=0.4 toggleSync=1
pbz set rgbPickerHours=1,0,0        # picker controls take 3 components, each 0..1
pbz setvars myVar=3 phase=0.25      # exported `export var`s, not UI controls
pbz brightness 0.5 [--save]         # ordinary dimmer

# --- sequencer ---
pbz seq off|shuffle|playlist
pbz seq pause|resume|next
pbz seq time 20                     # advance interval, in SECONDS
pbz playlist
pbz playlist set "Rainbow Worms":5000 "Cool Aura":3000

# --- device ---
pbz info                            # firmware, FPS, memory, uptime, storage, sync group
                                    #   storage warns at 60% full, CRITICAL at 75%
pbz config [--check]                # LED settings; --check asserts your `expect` block
                                    #   expect.maxStoragePct fails --check if storage exceeds it
pbz set-config colorOrder=WRGB pixelCount=170
pbz ping
pbz reboot
pbz discover [--ms=3000]            # find Pixelblazes by LAN beacon, no address needed

# --- pixel map ---
pbz map get > map.js                # the committable source form
pbz map get --coords                # the normalized coords the device actually renders with
pbz map set map.js                  # compute + push the geometry AND persist the source

# --- backup ---
pbz backup [file.pbb]               # every device file into one JSON; prints the storage line after
pbz restore file.pbb [--prune] --yes
pbz backup --fs-image [file.bin]    # device-side full-flash image (heavier, opt-in)

# --- power ---
pbz power budget                    # the supply chain, and which link is weakest
pbz limit --for-budget [--set]      # derive the brightness cap from that chain
pbz limit 40                        # or just pin one by hand
pbz power [patterns/foo.js]         # estimate what a pattern REALLY draws
```

`pbz` on its own prints the command list; the header of `pbz.mjs` has a longer
note on each one.

## As a library

The CLI is a thin shell over a class you can import. This is the part that
doesn't exist elsewhere in JS: a Pixelblaze client that also compiles.

```js
import { Pixelblaze } from 'pbz';

const pb = new Pixelblaze('192.168.1.50');
await pb.save(source, 'Sweep');     // compiles against THAT device's firmware
console.log(await pb.getInfo());
pb.close();
```

Because each device hands over its own compiler, fanning one pattern out across
a group works even with mixed firmware versions. See
[`examples/fan-out.mjs`](examples/fan-out.mjs). That makes the library a usable
backend for a Firestorm-style multi-device controller.

The class takes a host and nothing else: no argv, no config files, no globals.
It holds one reused websocket per instance and closes on idle. Read methods that
map 1:1 to a wire response return it parsed and unrenamed; composites like
`getInfo()` build on those and only add fields that bake in a decode.

## Device etiquette & recovery

**Read this before you script anything against a Pixelblaze.** The ESP32's
network stack is small and easy to choke. During development a burst of
connections plus one client killed mid-transfer wedged a device twice in one
session, and the second time it needed a power cycle. pbz now fails fast (5 s
connect timeout) and holds one reused connection per process, but nothing
coordinates *across* processes. That part is on you, and scripted or
agent-driven bursts are exactly the risky shape:

- **Batch, don't loop.** A multi-step sequence should be one script that
  `import`s `Pixelblaze` and reuses one connection, never a shell loop of
  separate `pbz` invocations. If separate commands are unavoidable, leave a beat
  between them.
- **Never SIGKILL a pbz mid-command**, especially during a binary transfer
  (`list`, `save`, `export`, `map`, `backup`). Clients killed mid-transfer are
  what actually wedge the ws server. Hangs now fail on their own within seconds;
  let them.
- **Know your client budget before you start, not after.** The device serves
  only a few concurrent websocket clients, and an open web UI tab counts as one.
  Run at most one long-lived consumer at a time (a Home Assistant poller, a
  monitor script, …). A quiet-looking terminal is **not** evidence of a quiet
  device: one wedge here was caused by a home-automation integration polling
  throughout a session that was only counting its own traffic.
- **Recovery playbook.** The failure is asymmetric. HTTP sometimes heals on its
  own as TCP orphans time out; the websocket server never does, and its slots
  leak until restart.
  0. **Stop the other consumers first.** With something reconnecting on a loop,
     the steps below either don't stick or don't happen at all, and the device
     comes straight back up into the same storm after a power cycle.
  1. ws dead, HTTP alive → `pbz reboot`. It's an HTTP POST, so it works while
     the websocket server is wedged. This is the lifeline; it has never needed
     more than this when step 0 was done first.
  2. HTTP dead too → wait a few minutes and retry. It may come back. It may not.
  3. Power-cycle, having done step 0 first.
- **A wedged device can take down its clients.** An unreachable Pixelblaze
  starved a Home Assistant instance's executor pool (sync client, blocking
  connects, no timeout) until the whole thing stopped serving HTTP: process
  alive, event loop blocked. If something that talks to your Pixelblaze goes
  unresponsive, suspect the device first, and cut its power so the blocked
  connects fail fast.

## What pbz trusts

Worth being explicit, because the central trick is unusual: **pbz fetches HTML
from your device over plain HTTP and executes code extracted from it in
`node:vm`.**

`node:vm` is not a security sandbox. It isolates globals, not capability. Code
running in it should be assumed able to affect the process. That is an accepted
trade here, because the alternative is reimplementing a compiler and getting it
subtly wrong, but it means pbz **trusts the device it talks to** and the network
path to it. There is no TLS, no signature check, and no pinning: anything that
can answer on that address, or sit between you and it, can hand pbz code to run.

On a home LAN with your own Pixelblaze this is fine. Don't point pbz at a device
you don't control, or reach one across an untrusted network.

## Power

`limit` sets the firmware's hardware brightness ceiling (`maxBrightness`), which
clamps output regardless of what the pattern or the sliders ask for. Left alone
it's 100%, i.e. no cap at all.

Rather than picking a number, describe your supply and wiring in `power.json`
(start from [`power.example.json`](power.example.json)) and let pbz solve it:

```
$ pbz power budget
protection chain:
  > PSU (Mean Well GST160A24): 6.67 A
    din4 socket: 7.5 A
    breaker: 15 A
    ring wire: 22 A
    connector: 32 A
  binding link: PSU (Mean Well GST160A24) (6.67 A)
measured all-four-max: 11.4 A (273 W)
raw budget/all-four-max: 58.5%  ->  cap × 0.95 margin: 55%
```

The chain is whatever you write in the file. Add, drop, or rename links and
they print as written. The budget is the weakest one. **Measure
`all_four_max_amps` on your own run; don't take it off the strip's nameplate.**
The one here draws about 112% of its rated figure.

Bare `pbz power` is a different question: it samples the live preview stream and
estimates what the *running* pattern actually draws, which is usually far below
worst case. Two corrections in there are load-bearing and were both verified
against a real device: the preview stream is **pre-brightness** (neither the
dimmer nor the cap scales it) and **pre-W-extraction** (`rgb(1,1,1)` reads back
as `(255,255,255)`). On an RGBW strip the firmware routes `min(r,g,b)` through
the dedicated white element, so summing R+G+B on a white pixel overestimates it
by roughly 3×.

All of this **advises**. The enforced cap and your physical fuse or breaker are
the actual backstop; a JS power estimate is about not browning out mid-demo, not
about preventing a melt.

## Tests

```sh
npm test              # hermetic, offline
npm run typecheck     # verify the TypeScript declarations (needs your own tsc)
npm run smoke         # read-only live sweep against a real device (~2s)
npm run fixture       # capture your device's web UI so the offline tests can run
```

`npm test` needs no device. The tests that exercise the real compiler need a
captured copy of the web UI, which is **not committed**. It's the vendor's
copyrighted application. `npm run fixture` pulls one off your own device into a
gitignored path; without it those tests skip with a message rather than fail.

The golden-bytes test is a byte-for-byte characterization of the compile path,
pinned to firmware v3.67. A fixture from any other version skips it, because
compiler output legitimately differs between firmware versions.

`npm run typecheck` checks `lib/pixelblaze.d.mts` against `test/types/`: a
consumer file that must compile, and a negative file whose every line must NOT,
asserted with `@ts-expect-error` so a loosened signature fails the check instead
of quietly passing. TypeScript is not a devDependency, so `npm install` stays a
no-op; supply your own compiler or skip it.

## Known gaps

Honest list, not a roadmap I'm promising to finish.

- **Sensor board support is unfinished.** There's no dedicated wire frame for it.
  Sensor values reach clients only as pattern-exported vars the firmware fills
  each frame. A `pbz sensors` live monitor and a record/replay probe are
  designed but not built, because the board wasn't in hand.
- **No cross-process locking.** One process holds one connection, but two
  terminals running `pbz` at once are two clients. See Device etiquette.
- **Wire formats verified against firmware v3.67**, on two different boards, with
  the sequencer and config paths also confirmed on v3.51. The compiler is pulled
  off your device so compiling tracks whatever you run, but the message formats
  were not checked past those versions.
- **No CI, not on npm.** TypeScript declarations do ship
  (`lib/pixelblaze.d.mts`), hand-written and drift-guarded by `npm test`, but
  the `.mjs` sources carry no JSDoc.
- `restore` is overwrite-only unless you pass `--prune`. The web UI's own
  restore wipes first; this is deliberately gentler.
- WiFi credentials are never in a `.pbb`, in either direction. That's the
  firmware's behavior, not a choice pbz makes.

## Credit

Pixelblaze is [Ben Hencke's](https://electromage.com) work, and this tool is
built directly on it. The compiler, the LZString packer, and the map
normalization are all his code, fetched from your device at runtime. pbz is
unofficial and unaffiliated. If anything here steps on toes I'm happy to change
it.

Prior art worth knowing:

- The Python [`pixelblaze-client`](https://github.com/zranger1/pixelblaze-client),
  which is more mature in places. It can't compile patterns, and a few wire
  formats differ from what this firmware actually does (`reboot` is an HTTP POST,
  the brightness cap key is `maxBrightness`).
- [`pbbeacon`](https://github.com/erkyrath/pbbeacon), which compiles a
  declarative pattern language down to Pixelblaze JS, and ships a small CLI for
  listing and switching patterns. It solves a genuinely different problem:
  pbbeacon generates *source* you then load, while pbz takes source you already
  have and produces the *bytecode* the device runs. Heads up that it also uses
  the `.pbb` extension, for its own script files rather than for backups.
- [Firestorm](https://github.com/simap/Firestorm), the official multi-device
  console. It forwards already-compiled patterns; the library half of pbz could
  serve as a backend for something similar.

MIT licensed. See [LICENSE](LICENSE), which also covers the one vendored file
(`lib/jpeg-encoder.cjs`, Adobe BSD).
