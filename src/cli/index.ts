// Headless BlowLink: same bridge as the app, configured by flags and/or the
// app's config file. `blowlink --help` lists the flags.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { Bridge } from '../core/bridge.ts'
import { loadConfig, newDevice } from '../core/config.ts'

const help = `Usage: blowlink [flags]

Connects Intiface/Buttplug games to Autoblow devices.

  --config FILE      settings file (default: the app's ${configPath()})
  --token TOKEN      VacuGlide device token (or $VACUGLIDE_TOKEN, or ~/.config/vacuglide-bridge/token)
  --addr HOST:PORT   Buttplug server address (default 127.0.0.1:12345)
  --no-buttplug      don't run the Buttplug server
  --intiface         also link the device into Intiface Central (websocket device "vacuglide")
  --intiface-url URL Intiface device websocket server (default ws://127.0.0.1:54817)
  --max N            speed cap in percent (default 100)
  --min N            lowest non-zero speed in percent (default 5)
  --map MODE         velocity (default) or tempo
  --api-url URL      Autoblow API to use instead of the real one (e.g. the Autoblow emulator)
  --dry              log speeds instead of calling the API
  -v                 log every protocol message
`

// Same folder Electron uses for the app's settings.
function configPath(): string {
  const base =
    process.platform === 'win32'
      ? (process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'))
      : process.platform === 'darwin'
        ? join(homedir(), 'Library', 'Application Support')
        : (process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'))
  return join(base, 'BlowLink', 'config.json')
}

function legacyToken(): string {
  if (process.env.VACUGLIDE_TOKEN) return process.env.VACUGLIDE_TOKEN
  try {
    return readFileSync(join(homedir(), '.config', 'vacuglide-bridge', 'token'), 'utf8').trim()
  } catch {
    return ''
  }
}

const { values: a } = parseArgs({
  options: {
    config: { type: 'string' },
    token: { type: 'string' },
    addr: { type: 'string' },
    'no-buttplug': { type: 'boolean' },
    intiface: { type: 'boolean' },
    'intiface-url': { type: 'string' },
    max: { type: 'string' },
    min: { type: 'string' },
    map: { type: 'string' },
    'api-url': { type: 'string' },
    dry: { type: 'boolean' },
    v: { type: 'boolean', short: 'v' },
    help: { type: 'boolean', short: 'h' }
  }
})
if (a.help) {
  process.stdout.write(help)
  process.exit(0)
}

const cfg = loadConfig(a.config ?? configPath())
if (a.addr) {
  const i = a.addr.lastIndexOf(':')
  cfg.buttplug.host = a.addr.slice(0, i)
  cfg.buttplug.port = Number(a.addr.slice(i + 1))
}
if (a['no-buttplug']) cfg.buttplug.enabled = false
if (a['intiface-url']) cfg.intiface.url = a['intiface-url']
if (a.dry) cfg.dry = true
if (a['api-url']) cfg.apiUrl = a['api-url']
if (a.v) cfg.verbose = true

// Flags describe one VacuGlide, like the old vacuglide-bridge.
const token = a.token ?? (cfg.devices.length ? '' : legacyToken())
if (token || (cfg.dry && !cfg.devices.length)) {
  cfg.devices = cfg.devices.filter((d) => d.type !== 'vacuglide')
  cfg.devices.unshift(newDevice('vacuglide', token))
}
for (const d of cfg.devices) {
  if (a.max) d.maxSpeed = Number(a.max)
  if (a.min) d.minSpeed = Number(a.min)
  if (a.map) {
    if (a.map !== 'velocity' && a.map !== 'tempo') {
      console.error(`--map must be "velocity" or "tempo", not "${a.map}"`)
      process.exit(2)
    }
    d.mapping = a.map
  }
  if (a.intiface) d.intiface.enabled = true
}
if (!cfg.devices.length) {
  console.error('no device: use --token, $VACUGLIDE_TOKEN, ~/.config/vacuglide-bridge/token, or add one in the app')
  process.exit(2)
}

const stamp = () => new Date().toTimeString().slice(0, 8)
const bridge = new Bridge(cfg)
bridge.on('log', (m) => console.log(stamp(), m))
await bridge.start()

let stopping = false
const shutdown = async () => {
  if (stopping) return
  stopping = true
  await bridge.close()
  console.log(stamp(), 'stopped')
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
