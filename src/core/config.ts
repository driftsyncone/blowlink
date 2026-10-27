// BlowLink settings, stored as JSON in the app's user-data folder.
import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import type { DeviceType } from './autoblow.ts'
import { defaultStopGraceMs } from './cloud-device.ts'
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
  // allowedOrigins: web pages (browser-based games) that may connect, e.g. "https://example.itch.zone" or
  // "https://*.itch.zone". Apps that are not web pages, and pages on localhost, are always allowed.
  buttplug: { enabled: boolean; host: string; port: number; allowedOrigins: string[] }
  intiface: { url: string }
  apiUrl: string // Autoblow API for discovery; '' = the real one. Set to the Autoblow emulator for testing.
  intervalMs: number // minimum time between API calls per device
  idleMs: number // stop this long after the last stroke
  stopGraceMs: number // hold a game's stop this long in case a move follows it (0 = send at once, default 120)
  dry: boolean // log instead of calling the API
  verbose: boolean // log every protocol message
  checkUpdates: boolean // app: look for a newer release once a day (notify only)
  devices: DeviceConfig[]
}

export const defaultConfig = (): Config => ({
  buttplug: { enabled: true, host: '127.0.0.1', port: 12345, allowedOrigins: [] },
  intiface: { url: 'ws://127.0.0.1:54817' },
  apiUrl: '',
  intervalMs: 200,
  idleMs: defaultMotorOptions.idleMs,
  stopGraceMs: defaultStopGraceMs,
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

// A device token is letters, digits, dot, dash and underscore. Anything else (a newline, a space) would
// end up in an HTTP header, so it is refused everywhere a token comes in.
export const isValidToken = (t: unknown): t is string => typeof t === 'string' && /^[\w.-]{8,}$/.test(t)

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown, def: number, min: number, max: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def
const bool = (v: unknown, def: boolean): boolean => (typeof v === 'boolean' ? v : def)
const str = (v: unknown, def: string, max = 200): string => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : def)
const oneOf = <T extends string>(v: unknown, list: readonly T[], def: T): T => (list.includes(v as T) ? (v as T) : def)

export function normalizeDevice(raw: unknown, taken: string[], warn: (m: string) => void): DeviceConfig | undefined {
  if (!isObj(raw)) return void warn('ignored a device entry that is not an object')
  if (typeof raw.type !== 'string' || !(raw.type in defaultDeviceNames)) return void warn(`ignored a device of unknown type ${JSON.stringify(String(raw.type))}`)
  const token = typeof raw.token === 'string' ? raw.token.trim() : ''
  if (!isValidToken(token)) return void warn(`ignored the ${raw.type} entry: its token is missing or not a valid device token`)
  const d = newDevice(raw.type as DeviceType, token, taken)
  const id = typeof raw.id === 'string' && /^[\w.-]{1,40}$/.test(raw.id) && !taken.includes(raw.id) ? raw.id : d.id
  const intiface = isObj(raw.intiface) ? raw.intiface : {}
  const maxSpeed = num(raw.maxSpeed, d.maxSpeed, 1, 100)
  const spmLow = num(raw.spmLow, d.spmLow, 1, 400)
  return {
    id,
    name: str(raw.name, d.name, 60),
    type: d.type,
    token,
    buttplug: bool(raw.buttplug, true),
    intiface: { enabled: bool(intiface.enabled, false), name: str(intiface.name, id, 60) },
    maxSpeed,
    minSpeed: Math.min(num(raw.minSpeed, d.minSpeed, 1, 100), maxSpeed),
    mapping: oneOf(raw.mapping, ['velocity', 'tempo'] as const, d.mapping),
    spmLow,
    spmHigh: Math.max(num(raw.spmHigh, d.spmHigh, 2, 1000), spmLow + 1),
    motion: oneOf(raw.motion, ['oscillate', 'goto'] as const, 'oscillate'),
    maxVacuumKpa: Math.round(num(raw.maxVacuumKpa, d.maxVacuumKpa, 5, 60))
  }
}

// normalizeConfig turns whatever was in the file into a valid Config: wrong types and out-of-range
// numbers fall back to defaults, bad device entries are dropped, ids are made unique.
export function normalizeConfig(raw: unknown, warn: (m: string) => void = () => {}): Config {
  const def = defaultConfig()
  const r = isObj(raw) ? raw : {}
  const bp = isObj(r.buttplug) ? r.buttplug : {}
  const inf = isObj(r.intiface) ? r.intiface : {}
  const wsUrl = typeof inf.url === 'string' && /^wss?:\/\/[^\s]+$/.test(inf.url) ? inf.url : def.intiface.url
  const apiUrl = typeof r.apiUrl === 'string' && /^https?:\/\/[^\s]+$/.test(r.apiUrl) ? r.apiUrl : ''
  const devices: DeviceConfig[] = []
  for (const entry of Array.isArray(r.devices) ? r.devices : []) {
    const d = normalizeDevice(entry, devices.map((x) => x.id), warn)
    if (d) devices.push(d)
  }
  return {
    buttplug: {
      enabled: bool(bp.enabled, def.buttplug.enabled),
      host: str(bp.host, def.buttplug.host, 100),
      port: Math.round(num(bp.port, def.buttplug.port, 1, 65535)),
      allowedOrigins: (Array.isArray(bp.allowedOrigins) ? bp.allowedOrigins : []).filter(
        (o): o is string => typeof o === 'string' && /^https?:\/\/[^\s/]+$/i.test(o.trim())
      ).map((o) => o.trim().toLowerCase())
    },
    intiface: { url: wsUrl },
    apiUrl,
    intervalMs: num(r.intervalMs, def.intervalMs, 50, 5000),
    idleMs: num(r.idleMs, def.idleMs, 100, 30_000),
    stopGraceMs: num(r.stopGraceMs, def.stopGraceMs, 0, 1000),
    dry: bool(r.dry, false),
    verbose: bool(r.verbose, false),
    checkUpdates: bool(r.checkUpdates, true),
    devices
  }
}

// loadConfig reads the file and normalises it. A file that can't be parsed is moved aside to
// <path>.bad and the app starts with defaults, so one corrupt file never stops BlowLink from starting.
export function loadConfig(path: string, warn: (m: string) => void = () => {}): Config {
  let raw: unknown = {}
  let text: string | undefined
  try {
    text = readFileSync(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') warn(`couldn't read ${path}: ${(e as Error).message}; starting with defaults`)
  }
  if (text !== undefined) {
    let ok = false
    try {
      raw = JSON.parse(text)
      ok = isObj(raw)
    } catch {
      // handled below
    }
    if (!ok) {
      raw = {}
      try {
        renameSync(path, `${path}.bad`)
        warn(`the settings file was not valid; moved it to ${path}.bad and started with defaults`)
      } catch {
        warn('the settings file was not valid; started with defaults')
      }
    }
  }
  return normalizeConfig(raw, warn)
}

// saveConfig writes atomically and readable by the user only (it holds device tokens).
export function saveConfig(path: string, cfg: Config): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  rmSync(tmp, { force: true }) // a leftover file from a crash would keep its old permissions
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, path)
}
