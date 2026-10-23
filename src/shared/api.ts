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
  update: { version: string; url: string } | null
}

export type DevicePatch = Partial<Omit<DeviceConfig, 'id' | 'type'>>
export type ConfigPatch = Partial<Pick<Config, 'buttplug' | 'intiface'>>

export interface Api {
  snapshot(): Promise<Snapshot>
  addDevice(token: string, type?: DeviceType): Promise<{ ok: true } | { ok: false; error: string; needType?: boolean }>
  updateDevice(id: string, patch: DevicePatch): Promise<void>
  removeDevice(id: string): Promise<void>
  updateConfig(patch: ConfigPatch): Promise<void>
  stopAll(): Promise<void>
  setAutostart(on: boolean): Promise<void>
  openDocs(which: 'intiface' | 'autoblow-token'): Promise<void>
  openUpdate(): Promise<void>
  setCheckUpdates(on: boolean): Promise<void>
}

export type Channel = 'state' | 'log' | 'config' | 'update'
