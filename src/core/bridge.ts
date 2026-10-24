// Bridge wires the configured devices to the inputs: the Buttplug server (apps
// connect to BlowLink) and the Intiface links (BlowLink connects into Intiface).
import { EventEmitter } from 'node:events'
import { AutoblowApi, type ApiOptions } from './autoblow.ts'
import { ButtplugServer } from './buttplug.ts'
import { realClock, type Clock } from './clock.ts'
import type { Config, DeviceConfig } from './config.ts'
import type { Device, DeviceStatus } from './device.ts'
import { IntifaceLink } from './intiface.ts'
import { CloudDevice } from './cloud-device.ts'
import { Ultra } from './ultra.ts'
import { VacuGlide } from './vacuglide.ts'
import { VacuPump } from './vacupump.ts'

export interface BridgeState {
  buttplug: { listening: boolean; port: number; clients: number; error?: string }
  devices: { id: string; name: string; type: string; status: DeviceStatus; intiface?: boolean }[]
}

export interface BridgeEvents {
  log: [string]
  change: [BridgeState]
}

export class Bridge extends EventEmitter<BridgeEvents> {
  private devices: Device[] = []
  private links = new Map<string, IntifaceLink>()
  private server?: ButtplugServer
  private serverError?: string
  // Own copy: the app edits its config object in place, and applyOptions compares
  // the new settings against these to decide what changed.
  private cfg: Config

  constructor(
    cfg: Config,
    private clock: Clock = realClock,
    private apiOpts: ApiOptions = {}
  ) {
    super()
    this.cfg = structuredClone(cfg)
  }

  private log = (msg: string) => this.emit('log', msg)

  private makeDevice(d: DeviceConfig): Device {
    const api = this.cfg.dry ? null : new AutoblowApi(d.token, { ...this.apiOpts, ...(this.cfg.apiUrl ? { discoveryUrl: this.cfg.apiUrl } : {}) })
    const opts = { ...d, idleMs: this.cfg.idleMs, intervalMs: this.cfg.intervalMs }
    switch (d.type) {
      case 'vacuglide':
        return new VacuGlide(d.id, d.name, api, opts, this.clock)
      case 'autoblow-ultra':
        return new Ultra(d.id, d.name, api, opts, this.clock)
      case 'vacupump':
        return new VacuPump(d.id, d.name, api, opts, this.clock)
      default:
        throw new Error(`unknown device type ${String(d.type)}`)
    }
  }

  async start(): Promise<void> {
    for (const dc of this.cfg.devices) {
      let dev: Device
      try {
        dev = this.makeDevice(dc)
      } catch (e) {
        this.log(`${dc.name}: ${(e as Error).message}`)
        continue
      }
      dev.verbose = this.cfg.verbose
      dev.on('log', this.log)
      dev.on('status', () => this.changed())
      dev.start()
      this.devices.push(dev)
      if (dc.intiface.enabled) this.startLink(dev, dc)
    }
    if (this.cfg.buttplug.enabled) {
      const listed = () => this.devices.filter((d) => this.cfg.devices.find((c) => c.id === d.id)?.buttplug)
      this.server = new ButtplugServer(listed, { ...this.cfg.buttplug, verbose: this.cfg.verbose }, (m) => {
        this.log(m)
        this.changed()
      })
      try {
        await this.server.start()
      } catch (e) {
        // Usually: Intiface Central (or another bridge) already uses the port.
        this.serverError = `port ${this.cfg.buttplug.port} unavailable: ${(e as Error).message}`
        this.log(`Buttplug server: ${this.serverError}`)
        this.server = undefined
      }
    }
    this.changed()
  }

  private startLink(dev: Device, dc: DeviceConfig, cfg: Config = this.cfg): void {
    const link = new IntifaceLink(
      dev,
      { url: cfg.intiface.url, name: dc.intiface.name, address: dc.id, verbose: cfg.verbose },
      this.clock,
      this.log,
      () => this.changed()
    )
    link.start()
    this.links.set(dc.id, link)
  }

  // applyOptions applies what it can without restarting, so connected apps stay
  // connected: speed settings, logging, and the Intiface links (on/off, name,
  // address). Returns false if the change needs a restart (devices added or
  // removed, tokens, names, Buttplug server settings).
  applyOptions(next: Config): boolean {
    const structure = (c: Config) =>
      JSON.stringify({
        ...c,
        verbose: undefined, // applied live below
        intiface: undefined, // links are reconciled below
        devices: c.devices.map(({ id, type, token, name, buttplug }) => ({ id, type, token, name, buttplug }))
      })
    if (structure(next) !== structure(this.cfg)) return false
    const prev = this.cfg
    for (const dc of next.devices) {
      const dev = this.devices.find((d) => d.id === dc.id)
      if (!dev) continue
      const was = prev.devices.find((d) => d.id === dc.id)?.intiface
      const link = this.links.get(dc.id)
      const same = was && was.enabled === dc.intiface.enabled && was.name === dc.intiface.name && prev.intiface.url === next.intiface.url
      if (same && (link !== undefined) === dc.intiface.enabled) continue
      if (link) {
        link.close() // stops the device if it was linked
        this.links.delete(dc.id)
      }
      if (dc.intiface.enabled) this.startLink(dev, dc, next)
      this.changed()
    }
    if (next.verbose !== this.cfg.verbose) {
      this.server?.setVerbose(next.verbose)
      for (const l of this.links.values()) l.setVerbose(next.verbose)
      for (const d of this.devices) d.verbose = next.verbose
      this.log(next.verbose ? 'logging game messages' : 'stopped logging game messages')
    }
    for (const dc of next.devices) {
      const dev = this.devices.find((d) => d.id === dc.id)
      if (dev instanceof CloudDevice) dev.setOptions(dc)
    }
    this.cfg = next
    return true
  }

  connect(id: string): Promise<void> {
    return this.devices.find((d) => d.id === id)?.connect() ?? Promise.resolve()
  }

  stopAll(): void {
    for (const d of this.devices) d.stop()
    this.log('all devices stopped')
  }

  state(): BridgeState {
    return {
      buttplug: {
        listening: !!this.server,
        port: this.server?.port ?? this.cfg.buttplug.port,
        clients: this.server?.clients ?? 0,
        error: this.serverError
      },
      devices: this.devices.map((d) => ({
        id: d.id,
        name: d.name,
        type: d.type,
        status: d.status,
        intiface: this.links.has(d.id) ? this.links.get(d.id)!.connected : undefined
      }))
    }
  }

  private changed(): void {
    this.emit('change', this.state())
  }

  async close(): Promise<void> {
    for (const l of this.links.values()) l.close()
    await this.server?.close()
    await Promise.all(this.devices.map((d) => d.close()))
    this.devices = []
    this.links.clear()
  }
}
