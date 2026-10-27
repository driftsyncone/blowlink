# Changelog

Each release's notes come from its section here (the release workflow fails without one).

## Unreleased

## 0.2.1

A review-and-hardening release: web pages can no longer drive your device, a stop is much harder to lose, and games that send odd command patterns behave better. Please report anything strange (turn on *Settings → Advanced → Log game messages* and attach `blowlink.log`).

- **Safety and robustness (full review):**
  - **Web pages can no longer drive your device.** The Buttplug server only lets in programs on your computer and `localhost` pages; browser games on a website need their address under `buttplug.allowedOrigins` in the settings file (BlowLink's log says which address it refused).
  - A bad or oversized message from an app no longer crashes BlowLink, and one app disconnecting only stops the devices it was driving (it used to stop everything, including a game still running).
  - Apps that need Buttplug protocol v4 now get a clear message that BlowLink speaks v3; wrong device numbers, motor numbers and non-numeric values are rejected instead of guessed.
  - The stop is the one command that must arrive: if a speed request was still in flight, or Autoblow was rate limiting, quitting BlowLink now waits and retries the stop. A failed request can no longer make a later stop look unnecessary.
  - All timers use a monotonic clock, so a system clock correction (NTP, resume from sleep) can't freeze a running device.
  - VacuPump: quitting while a command was half sent still releases the vacuum, the "turn the pump off" step can no longer overlap and swallow the next stop, and a non-numeric vacuum cap falls back to 20 kPa.
  - A settings file that is damaged is moved aside (`config.json.bad`) and BlowLink starts with defaults instead of not starting; wrong types and out-of-range numbers in it are fixed, and bad tokens or duplicate devices are dropped. A rejected token (401/403) takes the device offline at once, and the token never appears in an error message or follows a redirect.
  - Intiface mode now passes vibrate axes (V0, V1) and `DSTOP` through. BlowLink retries the Buttplug port every 10 s when it is taken, and a VacuGlide/Ultra stroke with a position hold no longer freezes a vibrate level that arrived meanwhile.
  - App: quitting waits for devices to stop on every path (Quit, SIGTERM/SIGHUP, Windows and Linux/macOS shutdown, an unexpected error); a failed settings restart no longer blocks later ones; without a tray icon, closing the window quits; the AppImage update relaunch gets past the single-instance lock; update checks and downloads time out and have a size limit; the Linux autostart entry quotes odd paths correctly; headless mode (`blowlink`) stops devices on hang-up too and checks its flags.
  - Pre-release builds are offered the final release of their own version.
- **Game stop commands now wait up to 0.12 s** for the command that follows. Some games send a stop right before every move (Hunted on Eclipse-9 does); the device used to halt and restart on each one, with two API calls. A stop that nothing follows still reaches the device within 0.12 s. *Stop all* (window and tray), a game disconnecting, quitting BlowLink and every VacuPump stop are unchanged and immediate. Set `stopGraceMs` to 0 in the settings file for the old behaviour.
- A game that sends one move per event, usually together with a vibrate pulse (Mousegun and other engines that treat every feature alike), now gives a short pulse on the device. Before, such a pulse did nothing or ran for 2 seconds. The first move of any stroke run now starts the device at that move's own speed instead of waiting for the second move.
- Games that stream the stroke position many times a second (live thrust depth, smooth-stroke mods) no longer make the speed flip up and down every few hundred milliseconds: speed smoothing now works by time, so these streams send a handful of commands instead of one every few hundred milliseconds. Discrete strokes behave as before.
- A game that keeps sending the same stroke position (a "hold", like Fap Hero Journey's block effect or an idle position slider) no longer keeps the device running at its last speed. The device now stops about 1.5 seconds after the last real move.
- The Intiface setup steps in the app now match Intiface Central 3 (the Device Websocket Server switch is under App Modes, with advanced settings shown and the server stopped).

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
