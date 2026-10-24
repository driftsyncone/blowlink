// BlowLink settings, stored as JSON in the app's user-data folder.
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import type { DeviceType } from './autoblow.ts'
import { defaultMotorOptions } from './motor.ts'

export interface DeviceConfig {
  id: string // stable, also the Intiface websocket address
  name: string // shown to apps
  type: DeviceType
  token: string
  buttplug: boolean // list it in Buttplug mode
  intiface: { enabled: boolean; name: string } // Intiface mode: websocket device name
  maxSpeed: number
  minSpeed: number
  mapping: 'velocity' | 'tempo'
  spmLow: number
  spmHigh: number
  motion: 'oscillate' | 'goto' // AI Ultra
  maxVacuumKpa: number // VacuPump, 5-60
}

export interface Config {
  buttplug: { enabled: boolean; host: string; port: number }
  intiface: { url: string }
  apiUrl: string // Autoblow API for discovery; '' = the real one. Set to the Autoblow emulator for testing.
  intervalMs: number // minimum time between API calls per device
  idleMs: number // stop this long after the last stroke
  dry: boolean // log instead of calling the API
  verbose: boolean // log every protocol message
  checkUpdates: boolean // app: look for a newer release once a day (notify only)
  devices: DeviceConfig[]
}

export const defaultConfig = (): Config => ({
  buttplug: { enabled: true, host: '127.0.0.1', port: 12345 },
  intiface: { url: 'ws://127.0.0.1:54817' },
  apiUrl: '',
  intervalMs: 200,
  idleMs: defaultMotorOptions.idleMs,
  dry: false,
  verbose: false,
  checkUpdates: true,
  devices: []
})

export const defaultDeviceNames: Record<DeviceType, string> = {
  vacuglide: 'Autoblow VacuGlide',
  'autoblow-ultra': 'Autoblow AI Ultra',
  vacupump: 'Autoblow VacuPump'
}

export function newDevice(type: DeviceType, token: string, taken: string[] = []): DeviceConfig {
  const base = type === 'autoblow-ultra' ? 'ultra' : type
  let id = base
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`
  return {
    id,
    name: defaultDeviceNames[type],
    type,
    token,
    buttplug: true,
    intiface: { enabled: false, name: id },
    maxSpeed: defaultMotorOptions.maxSpeed,
    minSpeed: defaultMotorOptions.minSpeed,
    mapping: defaultMotorOptions.mapping,
    spmLow: defaultMotorOptions.spmLow,
    spmHigh: defaultMotorOptions.spmHigh,
    motion: 'oscillate',
    maxVacuumKpa: 20
  }
}

// loadConfig reads the file, filling in anything missing with defaults.
export function loadConfig(path: string): Config {
  const def = defaultConfig()
  let raw: Partial<Config> = {}
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  return {
    ...def,
    ...raw,
    buttplug: { ...def.buttplug, ...raw.buttplug },
    intiface: { ...def.intiface, ...raw.intiface },
    devices: (raw.devices ?? []).map((d) => ({
      ...newDevice(d.type, d.token),
      ...d,
      intiface: { enabled: d.intiface?.enabled ?? false, name: d.intiface?.name ?? d.id }
    }))
  }
}

// saveConfig writes atomically and readable by the user only (it holds device tokens).
export function saveConfig(path: string, cfg: Config): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, path)
}
