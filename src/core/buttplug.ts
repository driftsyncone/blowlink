// Buttplug mode: BlowLink pretends to be an Intiface server (protocol v0-v3) and
// lists the Autoblow devices. Apps connect to ws://127.0.0.1:12345 as usual.
import type { IncomingMessage } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import type { Device } from './device.ts'

type Msg = Record<string, unknown>

const isObj = (v: unknown): v is Msg => typeof v === 'object' && v !== null && !Array.isArray(v)

// A problem with one message: becomes a Buttplug Error reply instead of a crash.
class ProtocolError extends Error {
  constructor(
    public code: number, // 1 init, 3 message, 4 device (Buttplug error codes)
    message: string
  ) {
    super(message)
  }
}

// A number field: absent counts as 0; present but not a number (or a numeric string) is an error.
function val(v: unknown, what: string): number {
  if (v === undefined) return 0
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  if (!Number.isFinite(n)) throw new ProtocolError(3, `${what} must be a number`)
  return n
}

// Our devices have one motor per kind of command. The entry for it is the one with Index 0 (or no
// Index); an entry list that has none is addressing a motor that is not there.
function motor(list: unknown, what: string): Msg | undefined {
  if (!Array.isArray(list) || list.length === 0) return undefined
  for (const e of list) if (isObj(e) && (e.Index === undefined || e.Index === 0)) return e
  throw new ProtocolError(4, `${what}: this device has one motor (Index 0)`)
}

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
    private log: (msg: string) => void = () => {},
    // called when this app gives a device a command (the server stops only those on disconnect)
    private driven: (d: Device) => void = () => {}
  ) {}

  private info(d: Device, index: number): Msg {
    return { DeviceName: d.name, DeviceIndex: index, DeviceMessages: d.buttplugMessages(this.ver) }
  }

  handle(type: string, b: Msg): Msg {
    try {
      return this.dispatch(type, b)
    } catch (e) {
      if (e instanceof ProtocolError) return errMsg(b.Id, e.code, e.message)
      return errMsg(b.Id, 0, `internal error: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  private dispatch(type: string, b: Msg): Msg {
    const id = b.Id
    const ok = reply('Ok', id)
    const list = this.devices()
    let dev: Device | undefined
    if ('DeviceIndex' in b) {
      if (!Number.isInteger(b.DeviceIndex)) throw new ProtocolError(4, 'DeviceIndex must be a whole number')
      dev = list[b.DeviceIndex as number]
      if (!dev) return errMsg(id, 4, 'unknown device index')
    }
    switch (type) {
      case 'RequestServerInfo': {
        // Protocol v4 (buttplug-rs 10+) uses ProtocolVersionMajor and a different message shape. Say so,
        // instead of answering in a format the client can't read.
        if (b.ProtocolVersionMajor !== undefined && val(b.ProtocolVersionMajor, 'ProtocolVersionMajor') > 3) {
          const msg = `BlowLink speaks Buttplug protocol v3 and older, but this app needs v${String(b.ProtocolVersionMajor)}. Use an app or library that supports v3.`
          this.log(`app "${String(b.ClientName ?? '')}" needs protocol v${String(b.ProtocolVersionMajor)}, which BlowLink doesn't speak`)
          return errMsg(id, 1, msg)
        }
        this.ver = 3
        if ('MessageVersion' in b) {
          const v = val(b.MessageVersion, 'MessageVersion')
          if (!Number.isInteger(v) || v < 0) throw new ProtocolError(1, 'MessageVersion must be a whole number from 0 to 3')
          this.ver = Math.min(v, 3)
        }
        this.clientName = String(b.ClientName ?? '').slice(0, 100)
        this.log(`app "${this.clientName}" connected (protocol v${this.ver})`)
        return reply('ServerInfo', id, { ServerName: 'BlowLink', MessageVersion: this.ver, MaxPingTime: 0 })
      }
      case 'Ping':
      case 'StopScanning':
        return ok
      case 'StartScanning': {
        // The events are built when they are sent, so a RequestDeviceList in between isn't followed by
        // the same devices announced again.
        setTimeout(() => {
          const events: Msg[] = []
          if (!this.announced) {
            this.announced = true
            this.devices().forEach((d, i) => events.push(reply('DeviceAdded', 0, this.info(d, i))))
          }
          events.push(reply('ScanningFinished', 0))
          this.sendEvents(events)
        }, 50)
        return ok
      }
      case 'RequestDeviceList':
        this.announced = true
        return reply('DeviceList', id, { Devices: list.map((d, i) => this.info(d, i)) })
      case 'StopAllDevices':
        list.forEach((d) => d.stopSoon())
        return ok
    }
    if (!dev) return errMsg(id, 3, `unsupported message ${type}`)
    switch (type) {
      case 'StopDeviceCmd':
        dev.stopSoon()
        return ok
      case 'SingleMotorVibrateCmd':
        this.driven(dev)
        dev.level(val(b.Speed, 'Speed'))
        return ok
      case 'VibrateCmd':
      case 'RotateCmd':
      case 'ScalarCmd': {
        const [key, field] =
          type === 'RotateCmd' ? ['Rotations', 'Speed'] : type === 'ScalarCmd' ? ['Scalars', 'Scalar'] : ['Speeds', 'Speed']
        const one = motor(b[key], type)
        if (one) {
          const level = val(one[field], field)
          this.driven(dev)
          dev.level(level)
        }
        return ok
      }
      case 'LinearCmd': {
        const one = motor(b.Vectors, type)
        if (one) {
          const pos = val(one.Position, 'Position')
          const dur = val(one.Duration, 'Duration')
          this.driven(dev)
          dev.stroke(pos, dur)
        }
        return ok
      }
      case 'FleshlightLaunchFW12Cmd': // v0 stroker message: Position/Speed 0-99
        this.driven(dev)
        dev.level(val(b.Speed, 'Speed') / 99)
        return ok
    }
    return errMsg(id, 3, `unsupported message ${type}`)
  }

  handleText(data: string): Msg[] {
    let input: unknown
    try {
      input = JSON.parse(data)
      if (!Array.isArray(input)) throw new Error('not an array')
    } catch (e) {
      return [errMsg(0, 3, `bad JSON: ${(e as Error).message}`)]
    }
    const out: Msg[] = []
    for (const item of input as unknown[]) {
      if (!isObj(item)) {
        out.push(errMsg(0, 3, 'each message must be an object like {"Ping": {"Id": 1}}'))
        continue
      }
      for (const [type, body] of Object.entries(item)) {
        if (body !== null && !isObj(body)) {
          out.push(errMsg(0, 3, `${type}: the message body must be an object`))
          continue
        }
        out.push(this.handle(type, body ?? {}))
      }
    }
    return out
  }
}

export interface ButtplugServerOptions {
  host: string
  port: number
  verbose?: boolean
  // Web pages allowed to connect besides localhost ones, e.g. "https://example.itch.zone" or
  // "https://*.itch.zone". Apps that are not web pages send no Origin and are always allowed.
  allowedOrigins?: string[]
}

const isLoopbackHost = (h: string) => /^(localhost|127(\.\d{1,3}){3}|\[::1\]|::1)$/i.test(h)

// Host header: an IP address or localhost. A name that points at 127.0.0.1 only through the attacker's
// DNS (DNS rebinding) is turned away.
function hostHeaderOk(host: string | undefined): boolean {
  if (!host) return true // HTTP/1.0 or a raw client
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.replace(/:\d+$/, '')
  return /^(\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:.]+\]|localhost)$/i.test(name)
}

export function originAllowed(origin: string | undefined, allowed: string[] = []): boolean {
  if (origin === undefined) return true // not a web page
  let host: string
  try {
    host = new URL(origin).hostname
  } catch {
    return false // "null" (sandboxed pages, file://) and anything unparseable
  }
  if (isLoopbackHost(host) || isLoopbackHost(`[${host}]`)) return true
  const o = origin.toLowerCase()
  return allowed.some((a) => {
    const re = new RegExp('^' + a.toLowerCase().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[a-z0-9-]+(?:\\.[a-z0-9-]+)*') + '$')
    return re.test(o)
  })
}

export class ButtplugServer {
  private wss?: WebSocketServer
  private sockets = new Set<WebSocket>()
  private lastDriver = new Map<Device, Session>() // who gave each device its latest command
  private blocked = new Set<string>()

  constructor(
    private devices: () => Device[],
    private opts: ButtplugServerOptions,
    private log: (msg: string) => void
  ) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({
        host: this.opts.host,
        port: this.opts.port,
        maxPayload: 1 << 20,
        // Any web page the user has open can reach ws://127.0.0.1, and a device is a physical thing:
        // pages are only let in if they are local or on the allow list.
        verifyClient: ({ origin, req }: { origin: string; req: IncomingMessage }) => {
          const hostOk = hostHeaderOk(req.headers.host)
          if (hostOk && originAllowed(origin || undefined, this.opts.allowedOrigins)) return true
          const who = !hostOk ? `host ${String(req.headers.host)}` : `web page ${origin || '(no name)'}`
          if (!this.blocked.has(who)) {
            this.blocked.add(who)
            this.log(`refused a connection from ${who}. To let a browser game connect, add its address to "allowedOrigins" under "buttplug" in the settings file.`)
          }
          return false
        }
      })
      wss.once('error', reject)
      wss.once('listening', () => {
        wss.off('error', reject)
        wss.on('error', (e) => this.log(`Buttplug server: ${e.message}`))
        if (!isLoopbackHost(this.opts.host)) {
          this.log(`WARNING: listening on ${this.opts.host}: anyone on your network can drive your devices`)
        }
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
      if (msgs.length === 0) return
      const text = JSON.stringify(msgs)
      if (this.opts.verbose) this.log(`-> ${text}`)
      if (ws.readyState === ws.OPEN) ws.send(text)
    }
    const s: Session = new Session(this.devices, send, this.log, (d) => this.lastDriver.set(d, s))
    ws.on('error', (e) => this.log(`app "${s.clientName}": connection error (${e.message})`))
    ws.on('message', (data) => {
      try {
        const text = data.toString()
        if (this.opts.verbose) this.log(`<- ${text}`)
        send(s.handleText(text))
      } catch (e) {
        this.log(`app "${s.clientName}": could not handle a message (${e instanceof Error ? e.message : String(e)})`)
      }
    })
    ws.on('close', () => {
      this.sockets.delete(ws)
      // Only the devices this app was last driving: another app (or the Intiface link) that is
      // using a device must not be cut off because a different client came and went.
      for (const [d, driver] of this.lastDriver) {
        if (driver === s) {
          d.stop()
          this.lastDriver.delete(d)
        }
      }
      this.log(`app "${s.clientName}" disconnected${s.clientName ? ', devices it was driving stopped' : ''}`)
    })
  }

  async close(): Promise<void> {
    for (const ws of this.sockets) ws.terminate()
    await new Promise<void>((r) => (this.wss ? this.wss.close(() => r()) : r()))
  }
}
