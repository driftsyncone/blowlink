# vacuglide-bridge notes

Status as of 2026-10-06: works against Cock Hero in test mode. **Never run on the real VacuGlide yet** (it was offline the whole session).

## What it is

A single Go binary that pretends to be Intiface Central (Buttplug protocol v1–v3) on `ws://127.0.0.1:12345`, offers one device ("Autoblow VacuGlide"), and turns the game's commands into speed calls on Autoblow's cloud API.

- Close Intiface Central first: both use port 12345.
- Device token: `~/.config/vacuglide-bridge/token` (copied from the Stash vacuglideSync plugin setting). Also accepts `-token` or `$VACUGLIDE_TOKEN`.

```
./vacuglide-bridge -max 40          # normal use, speed capped at 40 %
./vacuglide-bridge -v -max 40       # also log every Buttplug message
./vacuglide-bridge -dry             # no API calls, print speeds instead
```

Build: `CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o vacuglide-bridge .`

## Key constraint

Autoblow's VacuGlide API has **no position control**, only a target speed (0–100 %) and valve open/close. So the device can match the game's **tempo** but not land each stroke on the beat. Cloud latency is about 100–300 ms.

## How commands become speed

- **Stroke commands (LinearCmd)**: the bridge counts strokes per minute (two moves = one stroke) and maps that onto the device's assumed 25–200 strokes/min range (`-spm-low`, `-spm-high`).
  - Depth is ignored: a shallow stroke on the beat still counts as a stroke.
  - Uses the real gap between commands when it's longer than the stated duration (quick move, then hold).
  - Waits for the second move of a run before setting a speed (avoids spikes).
  - Light smoothing; changes under 5 % are not sent (saves API calls).
- **Vibrate commands (ScalarCmd/VibrateCmd)**: the level sets the speed, scaled to `-max`. Ignored while strokes are active, because Cock Hero sends a vibrate pulse on every beat.
- **Stops**: the device stops when the game disconnects, on Ctrl+C, and about 1.5 s after the last stroke run ends.
- **API pacing**: at most one call per 200 ms (`-interval`), only on change; backs off 1 s on HTTP 429.

## What Cock Hero sends (seen in logs)

- Connects as "Cock Hero Game", protocol v3. Rescans now and then; the bridge announces the device only once per connection.
- **Full cycle mode**: one complete stroke per beat (0 → 1, each half lasting half a beat), plus vibrate 1 then 0 on each beat.
- **Alternating mode**: one move per beat. Slow sections: 1.6–4 s moves (about 8–19 strokes/min). Max: shallow 0.5 ↔ 1 moves every 250 ms (120 strokes/min → about 51 % speed).
- Recorded Alternating session: `testdata/cockhero-alternating.log`. Replay it with `replay.py` (see the file header).

## Bugs fixed during the session

1. Device re-announced on every rescan.
2. Vibrate pulses overrode strokes (speed would jump 0 ↔ 100 % per beat).
3. First beat spiked to 100 %, twice (missing linear flag, then a duration overflow).
4. Shallow strokes counted as half strokes.
5. Slow beats (4 s moves) were treated as the strokes stopping.
6. Speed jitter at max caused an API call every 200 ms.

## Next steps

1. **First real run**: hold the VacuGlide's mode button 2.5 s, run `./vacuglide-bridge -v -max 40`, and check the log shows "VacuGlide connected".
2. **Check the speed scale**: set 50 % and count strokes for 15 s. The spec suggests about 112/min at 50 %. If it's off, adjust `-spm-low` / `-spm-high` (the spec said "suction pulses", so the range may not be strokes at all).
3. **Measure latency**: whether 200 ms pacing is fine or Autoblow rate-limits it (watch for HTTP 429 in the log).
4. **Remove the 40 % cap** once it behaves, so max sections reach their real speed.
5. **Slow sections** run at the device's lowest speed (25 strokes/min) and are faster than the beat. Possible later fix: pulse the motor on/off to fake slower rates.

Later ideas, not needed now:
- Buttplug protocol v4 support (only matters if an app requires it).
- Run as a background user service (systemd) so it starts with the PC.
