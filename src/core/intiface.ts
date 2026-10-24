// Intiface mode: BlowLink connects INTO Intiface Central's Device Websocket Server
// as a `tcode-v03` device, so the Autoblow device shows up in Intiface next to the
// user's other toys. One-time setup in Intiface Central: Settings → turn on
// "Device Websocket Server"; Devices → add a websocket device, protocol tcode-v03,
// name = `name` below.
//
// Intiface sends no stop command to TCode devices: the device's idle timeout ends
// a stroke run, and a closed connection stops it at once.
import WebSocket from 'ws'
import type { Clock } from './clock.ts'
import type { Device } from './device.ts'
import { parseTCode } from './tcode.ts'

export interface IntifaceLinkOptions {
  url: string // default ws://127.0.0.1:54817
  name: string // websocket device name registered in Intiface Central
  address: string // unique per device, e.g. the BlowLink device id
  verbose?: boolean
}

export class IntifaceLink {
  connected = false
  private ws?: WebSocket
  private retry: unknown
  private retryMs = 1000
  private closed = false
  private loggedDown = false

  constructor(
    private device: Device,
    private opts: IntifaceLinkOptions,
    private clock: Clock,
    private log: (msg: string) => void,
    private onState: (connected: boolean) => void = () => {}
  ) {}

  start(): void {
    this.closed = false
    this.connect()
  }

  private connect(): void {
    const ws = new WebSocket(this.opts.url)
    this.ws = ws
    ws.on('open', () => {
      ws.send(JSON.stringify({ identifier: this.opts.name, address: this.opts.address, version: 0 }))
      this.connected = true
      this.retryMs = 1000
      this.loggedDown = false
      this.log(`${this.device.name}: linked to Intiface as "${this.opts.name}"`)
      this.onState(true)
    })
    ws.on('message', (data) => {
      const text = data.toString()
      if (this.opts.verbose) this.log(`${this.device.name} <- ${JSON.stringify(text)}`)
      for (const m of parseTCode(text)) {
        if (m.axis !== 'L0') continue
        this.device.stroke(m.pos, m.intervalMs ?? 0)
      }
    })
    ws.on('error', (e) => {
      if (!this.loggedDown) this.log(`${this.device.name}: Intiface not reachable at ${this.opts.url} (${e.message}); retrying`)
      this.loggedDown = true
    })
    ws.on('close', () => {
      if (this.connected) {
        this.log(`${this.device.name}: Intiface link closed, device stopped`)
        this.device.stop()
      }
      this.connected = false
      this.onState(false)
      if (this.closed) return
      this.retry = this.clock.setTimeout(() => this.connect(), this.retryMs)
      this.retryMs = Math.min(this.retryMs * 2, 10_000)
    })
  }

  setVerbose(on: boolean): void {
    this.opts.verbose = on
  }

  close(): void {
    this.closed = true
    this.clock.clearTimeout(this.retry)
    this.ws?.terminate()
  }
}
