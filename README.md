# BlowLink

Connect Intiface/Buttplug games to Autoblow devices (VacuGlide, AI Ultra, VacuPump)
through Autoblow's cloud API. Not affiliated with Autoblow.

**Work in progress.** Desktop app (window + tray) and a headless CLI (`npm run cli -- --help`).
The VacuGlide mapping comes from the earlier vacuglide-bridge (measured on a VacuGlide 2).
**AI Ultra and VacuPump support is untested**: it follows Autoblow's documentation and has
never run on a real device. See `docs/PLAN.md`.

Two ways in, usable together:

- **Buttplug mode**: apps connect to BlowLink on `ws://127.0.0.1:12345` as if it were
  Intiface Central (close Central first, or move it to another port).
- **Intiface mode** (`--intiface`): BlowLink joins Intiface Central as a device, next to
  your other toys. One-time setup in Central: Settings → turn on *Device Websocket
  Server*; Devices → add a websocket device, protocol `tcode-v03`, name `vacuglide`.

```
npm install
npm test
npm run cli -- --dry            # log speeds instead of calling the API
npm run cli -- --intiface --no-buttplug
```

Licensed CC BY-NC-SA 4.0 (see `LICENSE`).
