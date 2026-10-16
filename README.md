# vacuglide-bridge

> **Experimental. Not yet tested on a real VacuGlide.** It has only run against
> Cock Hero with the device simulated (`-dry`). Reports from real hardware are
> very welcome. Start with a speed cap (`-max 40`) and keep the device's own
> controls within reach.

Lets games and apps that talk to **Intiface Central** (the Buttplug protocol)
drive an **Autoblow VacuGlide**. It's a single Go binary that pretends to be
Intiface on `ws://127.0.0.1:12345`, offers one device ("Autoblow VacuGlide"),
and turns stroke and vibrate commands into speed calls on Autoblow's cloud API.

Inspired by and written for [Cock Hero](https://cockherogame.itch.io/cock-hero),
which strokes on every beat. The Cock Hero developers are already adding native
VacuGlide support, planned for January; this bridge is just a way to play with a
VacuGlide until then. Once their support lands, use that instead.

> Unofficial community project. Not made, endorsed or supported by Autoblow,
> the Cock Hero developers, or the Buttplug/Intiface project.

## The catch: tempo, not position

The VacuGlide API has **no position control**, only a target speed (0–100 %)
and the suction valves. So the bridge can match the game's **tempo** but can't
land each stroke exactly on the beat. Cloud latency is about 100–300 ms.

- **Stroke commands** (LinearCmd), two ways (`-map`):
  - `tempo` (default): counts strokes per minute and maps them onto the
    VacuGlide 2's 15–225 strokes/min range (`-spm-low` / `-spm-high`; use
    25 / 200 for a VacuGlide 1). Depth is ignored, so a shallow stroke on the
    beat still counts as a stroke. The range is from the spec, not measured.
  - `velocity`: the same curve Autoblow's own funscript player uses, measured
    on a VacuGlide 2: speed % = stroke velocity in funscript units per second
    ÷ 6, so 600 units/s and up is 100 %. Depth counts: half-depth strokes in
    the same time run at half speed. A game's strokes then feel the same as
    the equivalent funscript played by Autoblow's app or Stash.
- **Vibrate commands** (ScalarCmd / VibrateCmd): the level sets the speed,
  scaled to `-max`. Ignored while strokes are active.
- **Stops** when the app disconnects, on Ctrl+C, and about 1.5 s after the
  last strokes.
- At most one API call per 200 ms, only when the speed changes by 5 % or more;
  backs off on HTTP 429 and reconnects when the device drops off the cloud.

**If your PC loses its internet connection, the bridge can't stop the
device.** Expect the VacuGlide to keep its last speed until the connection is
back (the bridge then sends the current speed or stop). Use the device's own
controls.

## Use

1. Close Intiface Central (both use port 12345).
2. Put the VacuGlide online and hold its mode button for 2.5 s.
3. Give it your device token: `-token`, `$VACUGLIDE_TOKEN`, or the file
   `~/.config/vacuglide-bridge/token`.
4. Run it, then connect from the game as you would to Intiface:

```
./vacuglide-bridge -max 40          # normal use, speed capped at 40 %
./vacuglide-bridge -v -max 40       # also log every Buttplug message
./vacuglide-bridge -dry             # no API calls, print speeds instead
```

| Flag | Default | Meaning |
|---|---|---|
| `-addr` | `127.0.0.1:12345` | WebSocket listen address |
| `-max` | `100` | Speed cap in % |
| `-min` | `5` | Lowest non-zero speed in % (Autoblow's own app starts at 5) |
| `-map` | `tempo` | `tempo` (strokes/min) or `velocity` (Autoblow's funscript curve) |
| `-spm-low` / `-spm-high` | `15` / `225` | `-map tempo`: strokes/min at 1 % / 100 % (VacuGlide 1: 25 / 200) |
| `-interval` | `200ms` | Minimum time between API calls |
| `-idle` | `1.5s` | Stop after this long with no strokes |
| `-dry` | off | Log speeds instead of calling the API |
| `-v` | off | Log every Buttplug message |

Speaks Buttplug protocol v1–v3 (not v4).

## Build

Go 1.27 or newer:

```
CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o vacuglide-bridge .
```

`testdata/cockhero-alternating.log` is a recorded Cock Hero session;
`replay.py` replays it into a `-dry` bridge (see its header). Design notes,
what Cock Hero sends, and open questions are in [NOTES.md](NOTES.md).

## License

[CC BY-NC-SA 4.0](LICENSE): use, change and share for **non-commercial**
purposes, with credit; anything you build from it must be shared under the same
license. Uses [coder/websocket](https://github.com/coder/websocket) (ISC), see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
