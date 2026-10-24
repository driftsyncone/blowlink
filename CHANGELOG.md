# Changelog

Each release's notes come from its section here (the release workflow fails without one).

## 0.2.0

**Smoother, calmer device control**
- **Steadier speed from strokes:** the pace is measured from when moves actually arrive and averaged over the last two full strokes (at least half a second). Games send moves with some timing jitter, which used to make the speed flip with every stroke in fast sections. Fast sections still reach full speed within about half a second.
- **Vibrate-style levels no longer stutter:** a level going up is sent at once; a level going down only after it has stayed lower for half a second. Games pulse vibrators faster than a cloud-controlled device can follow, so a pattern like 50 % on / off every half second now plays as a steady 50 %. Stop commands, *Stop all* and a game disconnecting still stop at once.
- **Live position streaming works** (e.g. Intiface Central's position slider, or apps that stream positions without a duration): small steps add up into a move instead of being dropped.
- Together these cut API calls to Autoblow by a quarter to two thirds in recorded game sessions.

**No more API spam, rate limits respected**
- BlowLink tries to reach each device once when it starts. If that fails, or the device drops off, the card shows *Offline* with a **Connect** button, and nothing is sent until you press it. Before, an offline device was retried every 2 seconds and ran into Autoblow's rate limit.
- After HTTP 429 BlowLink waits as long as Autoblow asks ("retry in N seconds").

**Updates from the app**
- When a new version is out, the Windows installer and Linux AppImage versions show an *Install and restart* button (also in the tray). BlowLink downloads it, checks it against the release's `SHA256SUMS.txt`, stops all devices and restarts into it. The deb, tar.gz, Windows zip and macOS versions link to the release page.
- *Check for updates now* in Settings and the tray, even with the daily check off.
- Coming from 0.1.0: download this version by hand once; in-app installs work from here on.

**Window and settings**
- Fixed-size window (600 px wide, shorter on small screens); each device's Buttplug/Intiface switches share a line.
- *Settings → Advanced* holds the Buttplug port, game-message logging, the Intiface address and the Autoblow API URL (for testing against a stand-in API; a banner shows while it's set).
- Settings changes apply right away. Before, adding a device, switching modes, changing the port or the logging switch only took effect after restarting BlowLink. Switching *Show in Intiface Central* or changing the Intiface address no longer drops games connected in Buttplug mode.
- **Log file:** `blowlink.log` in the settings folder (Settings shows where). With *Log game messages* on, every game message and every device command is logged, for troubleshooting.

Tested against Cock Hero, Cycle of Corruption, Heat Control and Intiface Central (Intiface mode), with a stand-in for Autoblow's API. AI Ultra and VacuPump support is still untested on real devices.

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
