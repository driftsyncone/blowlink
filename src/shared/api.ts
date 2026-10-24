// What the window can see and ask for. Tokens never go to the window: it only
// learns whether one is set, and can replace it.
import type { DeviceType } from '../core/autoblow.ts'
import type { BridgeState } from '../core/bridge.ts'
import type { Config, DeviceConfig } from '../core/config.ts'

export type DeviceView = Omit<DeviceConfig, 'token'> & { tokenSet: boolean }
export type ConfigView = Omit<Config, 'devices'> & { devices: DeviceView[] }

export interface Snapshot {
  version: string
  config: ConfigView
  state: BridgeState
  logs: string[]
  autostart: boolean
  logFile: string
  update: UpdateView | null
}

// installable: this copy can download and install it itself; busy/error: how
// that is going (e.g. "Downloading 40 %").
export interface UpdateView {
  version: string
  url: string
  installable: boolean
  busy?: string
  error?: string
}

export type DevicePatch = Partial<Omit<DeviceConfig, 'id' | 'type'>>
export type ConfigPatch = Partial<Pick<Config, 'buttplug' | 'intiface' | 'apiUrl' | 'verbose'>>

export interface Api {
  snapshot(): Promise<Snapshot>
  addDevice(token: string, type?: DeviceType): Promise<{ ok: true } | { ok: false; error: string; needType?: boolean }>
  updateDevice(id: string, patch: DevicePatch): Promise<void>
  removeDevice(id: string): Promise<void>
  updateConfig(patch: ConfigPatch): Promise<void>
  stopAll(): Promise<void>
  openLogFolder(): Promise<void>
  connectDevice(id: string): Promise<void>
  setAutostart(on: boolean): Promise<void>
  openDocs(which: 'intiface' | 'autoblow-token'): Promise<void>
  openUpdate(): Promise<void>
  setCheckUpdates(on: boolean): Promise<void>
  checkUpdatesNow(): Promise<{ found: boolean; error?: string }>
  installUpdate(): Promise<void>
}

export type Channel = 'state' | 'log' | 'config' | 'update'
