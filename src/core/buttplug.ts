// Buttplug mode: BlowLink pretends to be an Intiface server (protocol v0-v3) and
// lists the Autoblow devices. Apps connect to ws://127.0.0.1:12345 as usual.
import { WebSocketServer, type WebSocket } from 'ws'
import type { Device } from './device.ts'

type Msg = Record<string, unknown>

const num = (v: unknown) => (typeof v === 'number' ? v : 0)

function reply(type: string, id: unknown, body: Msg = {}): Msg {
  return { [type]: { ...body, Id: id } }
}

function errMsg(id: unknown, code: number, text: string): Msg {
  return reply('Error', id, { ErrorMessage: text, ErrorCode: code })
}

// Session is one app connection. handle() is plain logic so tests can drive it
// without a websocket.
export class Session {
  ver = 3
  clientName = ''
  private announced = false // DeviceAdded already sent; real Intiface doesn't re-announce on rescans

  constructor(
    private devices: () => Device[],
    private sendEvents: (msgs: Msg[]) => void,
    private log: (msg: string) => void = () => {}
  ) {}

  private info(d: Device, index: number): Msg {
    return { DeviceName: d.name, DeviceIndex: index, DeviceMessages: d.buttplugMessages(this.ver) }
  }

  handle(type: string, b: Msg): Msg {
    const id = b.Id
    const ok = reply('Ok', id)
    const list = this.devices()
    let dev: Device | undefined
    if ('DeviceIndex' in b) {
      dev = list[num(b.DeviceIndex)]
      if (!dev) return errMsg(id, 4, 'unknown device index')
    }
    switch (type) {
      case 'RequestServerInfo': {
        this.ver = 3
        if ('MessageVersion' in b && num(b.MessageVersion) < 3) this.ver = num(b.MessageVersion)
        this.clientName = String(b.ClientName ?? '')
        this.log(`app "${this.clientName}" connected (protocol v${this.ver})`)
        return reply('ServerInfo', id, { ServerName: 'BlowLink', MessageVersion: this.ver, MaxPingTime: 0 })
      }
      case 'Ping':
      case 'StopScanning':
        return ok
      case 'StartScanning': {
        const events: Msg[] = []
        if (!this.announced) {
          this.announced = true
          list.forEach((d, i) => events.push(reply('DeviceAdded', 0, this.info(d, i))))
        }
        events.push(reply('ScanningFinished', 0))
        setTimeout(() => this.sendEvents(events), 50)
        return ok
      }
      case 'RequestDeviceList':
        this.announced = true
        return reply('DeviceList', id, { Devices: list.map((d, i) => this.info(d, i)) })
      case 'StopAllDevices':
        list.forEach((d) => d.stop())
        return ok
    }
    if (!dev) return errMsg(id, 3, `unsupported message ${type}`)
    switch (type) {
      case 'StopDeviceCmd':
        dev.stop()
        return ok
      case 'SingleMotorVibrateCmd':
        dev.level(num(b.Speed))
        return ok
      case 'VibrateCmd':
      case 'RotateCmd':
      case 'ScalarCmd': {
        const [key, field] =
          type === 'RotateCmd' ? ['Rotations', 'Speed'] : type === 'ScalarCmd' ? ['Scalars', 'Scalar'] : ['Speeds', 'Speed']
        const first = (b[key] as Msg[] | undefined)?.[0]
        if (first) dev.level(num(first[field]))
        return ok
      }
      case 'LinearCmd': {
        const first = (b.Vectors as Msg[] | undefined)?.[0]
        if (first) dev.stroke(num(first.Position), num(first.Duration))
        return ok
      }
      case 'FleshlightLaunchFW12Cmd': // v0 stroker message: Position/Speed 0-99
        dev.level(num(b.Speed) / 99)
        return ok
    }
    return errMsg(id, 3, `unsupported message ${type}`)
  }

  handleText(data: string): Msg[] {
    let input: Record<string, Msg>[]
    try {
      input = JSON.parse(data)
      if (!Array.isArray(input)) throw new Error('not an array')
    } catch (e) {
      return [errMsg(0, 3, `bad JSON: ${(e as Error).message}`)]
    }
    const out: Msg[] = []
    for (const item of input) for (const [type, body] of Object.entries(item ?? {})) out.push(this.handle(type, body ?? {}))
    return out
  }
}

export interface ButtplugServerOptions {
  host: string
  port: number
  verbose?: boolean
}

export class ButtplugServer {
  private wss?: WebSocketServer
  private sockets = new Set<WebSocket>()

  constructor(
    private devices: () => Device[],
    private opts: ButtplugServerOptions,
    private log: (msg: string) => void
  ) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ host: this.opts.host, port: this.opts.port, maxPayload: 1 << 20 })
      wss.once('error', reject)
      wss.once('listening', () => {
        wss.off('error', reject)
        wss.on('error', (e) => this.log(`Buttplug server: ${e.message}`))
        this.log(`Buttplug server listening on ws://${this.opts.host}:${this.port}`)
        resolve()
      })
      wss.on('connection', (ws) => this.accept(ws))
      this.wss = wss
    })
  }

  get port(): number {
    const a = this.wss?.address()
    return typeof a === 'object' && a ? a.port : this.opts.port
  }

  setVerbose(on: boolean): void {
    this.opts.verbose = on
  }

  get clients(): number {
    return this.sockets.size
  }

  private accept(ws: WebSocket): void {
    this.sockets.add(ws)
    const send = (msgs: Msg[]) => {
      const text = JSON.stringify(msgs)
      if (this.opts.verbose) this.log(`-> ${text}`)
      if (ws.readyState === ws.OPEN) ws.send(text)
    }
    const s = new Session(this.devices, send, this.log)
    ws.on('message', (data) => {
      const text = data.toString()
      if (this.opts.verbose) this.log(`<- ${text}`)
      send(s.handleText(text))
    })
    ws.on('close', () => {
      this.sockets.delete(ws)
      for (const d of this.devices()) d.stop()
      this.log(`app "${s.clientName}" disconnected, devices stopped`)
    })
  }

  async close(): Promise<void> {
    for (const ws of this.sockets) ws.terminate()
    await new Promise<void>((r) => (this.wss ? this.wss.close(() => r()) : r()))
  }
}
