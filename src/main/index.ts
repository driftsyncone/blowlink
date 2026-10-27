// BlowLink desktop app: runs the bridge in the main process, with a window for
// settings/status and a tray icon (Stop all) so it can keep running in the background.
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, powerMonitor, screen, shell, Tray } from 'electron'
import { createWriteStream, existsSync, readFileSync, renameSync, statSync, writeFileSync, type WriteStream } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { detectDeviceType, type DeviceType } from '../core/autoblow.ts'
import { Bridge, type BridgeState } from '../core/bridge.ts'
import { isValidToken, loadConfig, newDevice, normalizeDevice, saveConfig, type Config } from '../core/config.ts'
import type { Api, Channel, ConfigPatch, ConfigView, DevicePatch, Snapshot, UpdateView } from '../shared/api.ts'
import { getAutostart, setAutostart } from './autostart.ts'
import { checkForUpdate, download, install, type UpdateInfo } from './updater.ts'

// Dev/test hooks: a separate settings folder (set first: the single-instance lock
// lives there, so a test copy can run next to the real one), and a screenshot run.
if (process.env.BLOWLINK_DATA) app.setPath('userData', process.env.BLOWLINK_DATA)
// The Windows portable exe unpacks itself to a temp folder each run; its settings (and the single-instance
// lock) live in a folder next to the exe instead, so the file can be moved around with its settings.
else if (process.env.PORTABLE_EXECUTABLE_DIR) app.setPath('userData', join(process.env.PORTABLE_EXECUTABLE_DIR, 'BlowLink-data'))
const shotPath = process.env.BLOWLINK_SHOT

if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}
app.setAppUserModelId('com.driftsyncone.blowlink')

const cfgPath = () => join(app.getPath('userData'), 'config.json')
const res = (name: string) => (app.isPackaged ? join(process.resourcesPath, name) : join(import.meta.dirname, '../../build', name))

let cfg: Config
let bridge: Bridge
let win: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
let exited = false
let shuttingDown: Promise<void> | undefined
const logs: string[] = []
let update: UpdateInfo | null = null
let updateBusy: string | undefined
let updateError: string | undefined

function push(channel: Channel, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

// The log also goes to a file in the settings folder (blowlink.log, then
// blowlink.log.1 once it passes 5 MB), so it can be read after a session.
const logPath = () => join(app.getPath('userData'), 'blowlink.log')
const logMax = 5 << 20
let logStream: WriteStream | null = null
let logSize = 0

function openLog(): void {
  try {
    logSize = existsSync(logPath()) ? statSync(logPath()).size : 0
    if (logSize > logMax) {
      renameSync(logPath(), logPath() + '.1')
      logSize = 0
    }
    logStream = createWriteStream(logPath(), { flags: 'a' })
    logStream.on('error', () => (logStream = null))
  } catch {
    logStream = null
  }
}

function log(line: string): void {
  const d = new Date()
  const stamped = `${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds()).padStart(3, '0')} ${line}`
  logs.push(stamped)
  if (logs.length > 500) logs.shift()
  push('log', stamped)
  if (logStream) {
    const text = `${d.toISOString().slice(0, 10)} ${stamped}\n`
    logStream.write(text)
    logSize += Buffer.byteLength(text)
    if (logSize > logMax) {
      logStream.end()
      openLog()
    }
  }
}

function configView(): ConfigView {
  return { ...cfg, devices: cfg.devices.map(({ token, ...d }) => ({ ...d, tokenSet: token !== '' })) }
}

// First run: bring over the token the old vacuglide-bridge used.
function importLegacyToken(): void {
  if (cfg.devices.length) return
  try {
    const token = readFileSync(join(homedir(), '.config', 'vacuglide-bridge', 'token'), 'utf8').trim()
    if (!token) return
    cfg.devices.push(newDevice('vacuglide', token))
    saveConfig(cfgPath(), cfg)
    log('imported the VacuGlide token from vacuglide-bridge')
  } catch {
    // no old install
  }
}

async function startBridge(): Promise<void> {
  bridge = new Bridge(cfg)
  bridge.on('log', log)
  bridge.on('change', (s) => {
    push('state', s)
    updateTray(s)
  })
  await bridge.start()
}

// The way out for every exit path (Quit, signals, the OS shutting down): the devices are told to
// stop before the process goes. Safe to call more than once.
function shutdown(): Promise<void> {
  quitting = true
  return (shuttingDown ??= (bridge ? bridge.close() : Promise.resolve()).catch(() => {}))
}

let restarting: Promise<void> = Promise.resolve()
function restartBridge(): Promise<void> {
  // One failed restart must not poison the chain: later settings changes still restart the bridge.
  const run = restarting.catch(() => {}).then(async () => {
    await bridge.close()
    await startBridge()
  })
  restarting = run
  return run
}

async function saveAndApply(): Promise<void> {
  saveConfig(cfgPath(), cfg)
  push('config', configView())
  if (!bridge.applyOptions(structuredClone(cfg))) await restartBridge()
}

// ---------- tray ----------

function updateTray(s: BridgeState): void {
  if (!tray) return
  const active = s.devices.filter((d) => d.status.output > 0).length
  const online = s.devices.filter((d) => d.status.online).length
  tray.setToolTip(
    `BlowLink: ${online}/${s.devices.length} device(s) online` +
      (s.buttplug.listening ? `, ${s.buttplug.clients} app(s) on :${s.buttplug.port}` : '') +
      (active ? `, ${active} running` : '')
  )
}

function trayMenu(): Menu {
  return Menu.buildFromTemplate([
    { label: 'Open BlowLink', click: showWindow },
    { label: 'Stop all devices', click: () => bridge.stopAll() },
    update
      ? update.asset
        ? { label: `Install BlowLink ${update.version} and restart`, enabled: !updateBusy, click: () => void installUpdate() }
        : { label: `Update available: ${update.version}`, click: () => shell.openExternal(update!.url) }
      : { label: 'Check for updates', click: () => void checkUpdates(true) },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ])
}

function createTray(): void {
  const icon = nativeImage.createFromPath(res('tray.png'))
  const icon2x = res('tray@2x.png')
  if (existsSync(icon2x)) icon.addRepresentation({ scaleFactor: 2, buffer: readFileSync(icon2x) })
  tray = new Tray(icon)
  tray.setContextMenu(trayMenu())
  tray.on('click', showWindow)
  updateTray(bridge.state())
}

// ---------- updates ----------

function updateView(): UpdateView | null {
  return update && { version: update.version, url: update.url, installable: !!update.asset, busy: updateBusy, error: updateError }
}

function pushUpdate(): void {
  push('update', updateView())
  tray?.setContextMenu(trayMenu())
}

// checkUpdates: the daily check (skipped when turned off or in dev), or a manual one.
async function checkUpdates(manual = false): Promise<{ found: boolean; error?: string }> {
  if (!manual && (!cfg.checkUpdates || !app.isPackaged)) return { found: false }
  if (updateBusy) return { found: true }
  try {
    const found = await checkForUpdate()
    if (found && found.version !== update?.version) {
      update = found
      updateError = undefined
      log(`BlowLink ${found.version} is available: ${found.url}`)
      pushUpdate()
    } else if (!found && manual) log(`BlowLink ${app.getVersion()} is up to date`)
    return { found: !!update }
  } catch (e) {
    log(`update check failed: ${(e as Error).message}`)
    return { found: !!update, error: (e as Error).message }
  }
}

async function installUpdate(): Promise<void> {
  if (!update?.asset || updateBusy) return
  const u = update
  let stopped = false
  updateError = undefined
  updateBusy = 'Downloading…'
  pushUpdate()
  try {
    log(`downloading ${u.asset!.name}`)
    const file = await download(u, (pct) => {
      updateBusy = `Downloading ${pct} %`
      push('update', updateView())
    })
    log(`${u.asset!.name} matches SHA256SUMS.txt; installing and restarting`)
    updateBusy = 'Installing…'
    pushUpdate()
    // Stop every device before handing over to the new version.
    quitting = true
    stopped = true
    await bridge.close().catch(() => {})
    await install(file)
    app.quit()
  } catch (e) {
    quitting = false
    updateBusy = undefined
    updateError = (e as Error).message
    log(`update failed: ${updateError}`)
    pushUpdate()
    if (stopped) await startBridge().catch((err) => log(`bridge restart failed: ${(err as Error).message}`))
  }
}

// ---------- window ----------

function showWindow(): void {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    return
  }
  // Fixed-size utility window (content scrolls), shorter on small screens.
  const height = Math.min(820, screen.getPrimaryDisplay().workAreaSize.height - 40)
  win = new BrowserWindow({
    width: 600,
    height,
    useContentSize: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'BlowLink',
    icon: res('icon.png'),
    autoHideMenuBar: true,
    backgroundColor: '#1a1326',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })
  // Nothing in the window navigates or opens windows; links go through openDocs.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.on('close', (e) => {
    if (quitting || !tray) return
    e.preventDefault() // keep running in the tray
    win?.hide()
  })
  if (shotPath)
    win.webContents.once('did-finish-load', () =>
      setTimeout(async () => {
        if (process.env.BLOWLINK_SHOT_H) {
          win!.setResizable(true)
          win!.setContentSize(600, Number(process.env.BLOWLINK_SHOT_H))
          await new Promise((r) => setTimeout(r, 500))
        }
        const img = await win!.webContents.capturePage()
        writeFileSync(shotPath, img.toPNG())
        quitting = true
        app.quit()
      }, Number(process.env.BLOWLINK_SHOT_DELAY ?? 1500))
    )
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
}

// ---------- IPC ----------

const docs = {
  intiface: 'https://intiface.com/central/',
  'autoblow-token': 'https://developers.autoblow.com/'
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const api: Api = {
  async snapshot(): Promise<Snapshot> {
    return { version: app.getVersion(), config: configView(), state: bridge.state(), logs, autostart: getAutostart(), logFile: logPath(), update: updateView() }
  },
  async addDevice(token: string, type?: DeviceType) {
    token = token.trim()
    if (!isValidToken(token)) return { ok: false, error: "That doesn't look like a device token." }
    if (cfg.devices.some((d) => d.token === token)) return { ok: false, error: 'That device is already added.' }
    if (!type) {
      try {
        const found = await detectDeviceType(token, cfg.apiUrl ? { discoveryUrl: cfg.apiUrl } : {})
        if (!found.type)
          return { ok: false, needType: true, error: "The device is offline, so Autoblow couldn't say which one it is. Pick it below." }
        type = found.type
      } catch (e) {
        return { ok: false, needType: true, error: `Couldn't check the token (${(e as Error).message}). Pick the device type to add it anyway.` }
      }
    }
    cfg.devices.push(newDevice(type, token, cfg.devices.map((d) => d.id)))
    await saveAndApply()
    return { ok: true }
  },
  async updateDevice(id: string, patch: DevicePatch) {
    const d = cfg.devices.find((x) => x.id === id)
    if (!d || !isObj(patch)) return
    // Only known fields are taken from the window, and the result goes through the same checks as a
    // settings file: types, ranges, token format.
    const p = patch as Record<string, unknown>
    const merged: Record<string, unknown> = { ...d }
    for (const k of ['name', 'buttplug', 'maxSpeed', 'minSpeed', 'mapping', 'spmLow', 'spmHigh', 'motion', 'maxVacuumKpa'])
      if (k in p) merged[k] = p[k]
    if (typeof p.token === 'string' && p.token.trim()) merged.token = p.token // empty = keep
    if (isObj(p.intiface)) merged.intiface = { ...d.intiface, ...(typeof p.intiface.enabled === 'boolean' ? { enabled: p.intiface.enabled } : {}), ...(typeof p.intiface.name === 'string' ? { name: p.intiface.name } : {}) }
    const n = normalizeDevice(merged, cfg.devices.filter((x) => x !== d).map((x) => x.id), log)
    if (!n) return
    Object.assign(d, n, { id: d.id, type: d.type })
    await saveAndApply()
  },
  async removeDevice(id: string) {
    cfg.devices = cfg.devices.filter((d) => d.id !== id)
    await saveAndApply()
  },
  async updateConfig(patch: ConfigPatch) {
    if (!isObj(patch)) return
    const p = patch as Record<string, unknown>
    if (isObj(p.buttplug)) {
      // The address and allowed web pages are only changed in the settings file.
      if (typeof p.buttplug.enabled === 'boolean') cfg.buttplug.enabled = p.buttplug.enabled
      const port = p.buttplug.port
      if (typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535) cfg.buttplug.port = port
    }
    if (isObj(p.intiface) && typeof p.intiface.url === 'string' && /^wss?:\/\/\S+$/.test(p.intiface.url.trim())) cfg.intiface.url = p.intiface.url.trim()
    if (typeof p.verbose === 'boolean') cfg.verbose = p.verbose
    if (typeof p.apiUrl === 'string') {
      const v = p.apiUrl.trim().replace(/\/+$/, '')
      if (v === '' || /^https?:\/\/\S+$/.test(v)) cfg.apiUrl = v
    }
    await saveAndApply()
  },
  async stopAll() {
    bridge.stopAll()
  },
  async openLogFolder() {
    shell.showItemInFolder(logPath())
  },
  async connectDevice(id: string) {
    await bridge.connect(id)
  },
  async setAutostart(on: boolean) {
    setAutostart(on)
  },
  async openDocs(which) {
    if (Object.hasOwn(docs, which)) await shell.openExternal(docs[which])
  },
  async openUpdate() {
    if (update) await shell.openExternal(update.url)
  },
  async setCheckUpdates(on: boolean) {
    cfg.checkUpdates = on
    saveConfig(cfgPath(), cfg)
    push('config', configView())
    if (on) void checkUpdates()
  },
  checkUpdatesNow: () => checkUpdates(true),
  installUpdate
}

ipcMain.handle('blowlink', (e, method: unknown, ...args: unknown[]) => {
  // Only our own window may call: the packaged page (file://) or the dev server.
  const url = e.senderFrame?.url ?? ''
  const dev = process.env.ELECTRON_RENDERER_URL
  if (!(url.startsWith('file://') || (dev && url.startsWith(dev)))) throw new Error('not allowed')
  if (typeof method !== 'string' || !Object.hasOwn(api, method)) throw new Error('unknown method')
  const fn = (api as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[method]
  return fn(...args)
})

// ---------- lifecycle ----------

app.on('second-instance', showWindow)

// Every way the process can end tells the devices to stop first. A device left running by a closed
// program is the worst thing this app can do.
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(sig, () => void shutdown().then(() => app.exit(0)))
process.on('uncaughtException', (err) => {
  log(`unexpected error: ${err.stack ?? err.message}`)
  try {
    bridge?.stopAll()
  } catch {
    // nothing more to do
  }
})
process.on('unhandledRejection', (reason) => log(`unexpected error: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`))

app
  .whenReady()
  .then(async () => {
    openLog()
    log(`BlowLink ${app.getVersion()} starting`)
    const notes: string[] = []
    cfg = loadConfig(cfgPath(), (m) => {
      log(m)
      notes.push(m)
    })
    importLegacyToken()
    try {
      await startBridge()
    } catch (e) {
      log(`couldn't start: ${(e as Error).message}`)
      dialog.showErrorBox('BlowLink', `BlowLink couldn't start its bridge: ${(e as Error).message}`)
    }
    try {
      createTray()
    } catch (e) {
      log(`no tray icon: ${(e as Error).message}`) // e.g. a desktop without a system tray
    }
    // Windows sends no before-quit when it shuts down or logs off; a window that is never shown receives
    // session-end. Linux and macOS have powerMonitor's shutdown event.
    if (process.platform === 'win32') {
      const sessionWin = new BrowserWindow({ show: false, width: 1, height: 1, webPreferences: { sandbox: true, contextIsolation: true } })
      sessionWin.on('session-end', () => void shutdown())
    } else {
      // (missing from the typings of some Electron versions)
      ;(powerMonitor as unknown as NodeJS.EventEmitter).on('shutdown', (e: { preventDefault(): void }) => {
        e.preventDefault()
        void shutdown().then(() => app.exit(0))
      })
    }
    if (!process.argv.includes('--hidden') || !cfg.devices.length || notes.length) showWindow()
    const moved = notes.find((n) => n.includes('.bad'))
    if (moved) void dialog.showMessageBox({ type: 'warning', message: 'BlowLink could not read its settings file', detail: moved })
    setTimeout(() => void checkUpdates(), 10_000)
    setInterval(() => void checkUpdates(), 24 * 60 * 60 * 1000)
  })
  .catch((e) => {
    log(`startup failed: ${(e as Error).message}`)
    dialog.showErrorBox('BlowLink', `BlowLink hit an error while starting: ${(e as Error).message}`)
    showWindow()
  })

// Stays alive in the tray when the window closes (without a tray, it quits instead).
app.on('window-all-closed', () => {
  if (!tray) app.quit() // nothing to bring the window back from: don't leave an invisible process
})

app.on('before-quit', (e) => {
  quitting = true
  if (exited) return
  e.preventDefault()
  // Stop every device before exiting.
  void shutdown().then(() => {
    exited = true
    app.quit()
  })
})
