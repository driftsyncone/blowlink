# Changelog

Each release's notes come from its section here (the release workflow fails without one).

## 0.1.0

First release of BlowLink, the successor of vacuglide-bridge.

- **Desktop app** for Windows, Linux and macOS: device list with live output, Stop all button, tray icon, start at login.
- **Two ways to connect games:**
  - *Buttplug mode*: games connect to BlowLink at `ws://127.0.0.1:12345` as if it were Intiface Central.
  - *Intiface mode*: BlowLink joins Intiface Central as a device, next to your other toys (needs Central's Device Websocket Server, see the app for the 2 setup steps).
- **Autoblow VacuGlide 1/2**: same stroke-to-speed mapping as vacuglide-bridge (measured on a VacuGlide 2).
- **Autoblow AI Ultra and VacuPump: untested.** Built from Autoblow's documentation and never run on a real device. Start with low limits. Reports welcome.
- Add a device by pasting its token; BlowLink works out which device it is.
- Your old vacuglide-bridge token is imported on first start.
