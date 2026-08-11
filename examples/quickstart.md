# Quickstart

Node 22 or newer, a Pixelblaze on the same LAN, and nothing to install.

```sh
git clone https://github.com/tarekrached/pbz.git
cd pbz
cp pb.config.example.json pb.config.json     # put your device's address in it
./pbz.mjs ping
```

Every command also takes `--host=192.168.1.50`, or reads `$PB_HOST`, if you'd
rather not keep a config file.

## Write a pattern, watch it on the wall

```sh
cat > sweep.js <<'EOF'
export var sliderSpeed = 0.3

export function beforeRender(delta) {
  t1 = time(0.1 * (1.1 - sliderSpeed))
}

export function render(index) {
  h = index / pixelCount + t1
  hsv(h, 1, 1)
}
EOF

./pbz.mjs compile sweep.js     # validate + list the controls it exports; sends nothing
./pbz.mjs run sweep.js         # live on the LEDs, NOT saved — the iteration loop
./pbz.mjs set sliderSpeed=0.8  # tune it while it runs
./pbz.mjs save sweep.js "Sweep" # persist + activate, with a real preview thumbnail
```

`run` is the one to keep hitting while you edit. It replaces the running program
in place and vanishes on reboot. `save` derives the pattern id from the
filename, so re-saving the same file updates the same entry instead of piling up
duplicates.

## Look at the device

```sh
./pbz.mjs list        # saved patterns, id + name
./pbz.mjs info        # firmware, FPS, memory, uptime, storage, sync group
./pbz.mjs config      # LED settings: pixelCount, colorOrder, dataSpeed, …
./pbz.mjs get         # the active pattern's current control values
./pbz.mjs discover    # find Pixelblazes by their LAN beacon, no address needed
```

## Keep the settings in git

`config --check` asserts the LED settings you care about and exits non-zero when
they drift, which is a much faster answer than debugging a pattern that looks
wrong for no reason:

```sh
./pbz.mjs set-config colorOrder=WRGB pixelCount=170
./pbz.mjs config --check
```

## Back it up

Patterns written in the web UI exist nowhere but the device. `backup` snapshots
every file on it — patterns, settings, playlist, pixel map — into one JSON file.

```sh
./pbz.mjs backup                       # -> "<devicename>-<date>.pbb"
./pbz.mjs restore mydevice-2026-08-11.pbb --yes
```

## Don't melt anything

`limit` sets the firmware's hardware brightness ceiling. Describe your supply
and wiring in `power.json` (start from `power.example.json`, and **replace every
number with your own**) and let it derive the cap instead of guessing:

```sh
./pbz.mjs power budget          # the chain, and which link is weakest
./pbz.mjs limit --for-budget    # what cap that implies, and the arithmetic
./pbz.mjs limit --for-budget --set
./pbz.mjs power                 # what the RUNNING pattern actually draws
```

`power budget` is worst case: every pixel, every channel, full. Bare `power`
samples the live preview stream to estimate what a real pattern draws, which is
usually far less. The first is a safety bound; the second is advisory.
