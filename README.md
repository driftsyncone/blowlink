# vacuglide-bridge

> **Experimental. Not yet tested on a real VacuGlide.** It has only run against
> Cock Hero with the device simulated (`-dry`). Reports from real hardware are
> very welcome. Start with a speed cap (`-max 40`) and keep the device's own
> controls within reach.

Lets games and apps that talk to **Intiface Central** (the Buttplug protocol)
drive an **Autoblow VacuGlide**. It's a single Go binary that pretends to be
Intiface on `ws://127.0.0.1:12345`, offers one device ("Autoblow VacuGlide"),
and turns stroke and vibrate commands into speed calls on Autoblow's cloud API.

Written for Cock Hero, which strokes on every beat.

> Unofficial community project. Not made, endorsed or supported by Autoblow or
> the Buttplug/Intiface project.

## The catch: tempo, not position

The VacuGlide API has **no position control**, only a target speed (0–100 %)
and the suction valves. So the bridge can match the game's **tempo** but can't
land each stroke exactly on the beat. Cloud latency is about 100–300 ms.

- **Stroke commands** (LinearCmd): it counts strokes per minute and maps them
  onto the device's speed range (`-spm-low` / `-spm-high`, from the spec's
  25–200 strokes/min, not yet calibrated). Depth is ignored.
- **Vibrate commands** (ScalarCmd / VibrateCmd): the level sets the speed,
  scaled to `-max`. Ignored while strokes are active.
- **Stops** when the app disconnects, on Ctrl+C, and about 1.5 s after the
  last strokes.
- At most one API call per 200 ms, only when the speed changes; backs off on
  HTTP 429.

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
| `-min` | `1` | Lowest non-zero speed in % |
| `-spm-low` / `-spm-high` | `25` / `200` | Device strokes/min at 1 % / 100 % |
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
