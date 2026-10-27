// Buttplug server hardening from the full review: who may connect, what a bad frame can do, who a
// disconnect stops, and the protocol edge cases.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import WebSocket, { WebSocketServer } from 'ws'
import { ButtplugServer, Session, originAllowed } from '../src/core/buttplug.ts'
import { realClock } from '../src/core/clock.ts'
import { Device } from '../src/core/device.ts'
import { IntifaceLink } from '../src/core/intiface.ts'
import { hasTCodeStop } from '../src/core/tcode.ts'
import { waitFor } from './helpers.mts'

class SpyDevice extends Device {
  readonly type = 'vacuglide' as const
  calls: string[] = []
  stroke(pos: number, durMs: number) {
    this.calls.push(`stroke ${pos} ${durMs}`)
  }
  level(l: number) {
    this.calls.push(`level ${l}`)
  }
  stop() {
    this.calls.push('stop')
  }
  buttplugMessages() {
    return { LinearCmd: [{ FeatureDescriptor: 'Stroke', StepCount: 100, ActuatorType: 'Position' }], StopDeviceCmd: {} }
  }
  start() {}
  async connect() {}
  async close() {}
}

async function server(opts: { allowedOrigins?: string[] } = {}) {
  const dev = new SpyDevice('vacuglide', 'Autoblow VacuGlide')
  const logs: string[] = []
  const srv = new ButtplugServer(() => [dev], { host: '127.0.0.1', port: 0, ...opts }, (m) => logs.push(m))
  await srv.start()
  return { dev, srv, logs, url: `ws://127.0.0.1:${srv.port}` }
}

// Connects and reports whether the server let it in.
function tryConnect(url: string, headers: Record<string, string> = {}): Promise<WebSocket | undefined> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers })
    ws.once('open', () => resolve(ws))
    ws.once('error', () => resolve(undefined))
    ws.once('unexpected-response', () => resolve(undefined))
  })
}

async function ask(ws: WebSocket, items: unknown): Promise<any[]> {
  ws.send(JSON.stringify(items))
  const [data] = await once(ws, 'message')
  return JSON.parse(String(data))
}

test('a web page on another site cannot connect; local pages, plain apps and allowed origins can', async () => {
  const { srv, logs, url } = await server({ allowedOrigins: ['https://*.itch.zone', 'https://mygame.example'] })
  const evil = await tryConnect(url, { Origin: 'https://evil.example' })
  assert.equal(evil, undefined, 'refused')
  assert.ok(logs.some((l) => l.includes('refused') && l.includes('evil.example')))
  assert.equal(await tryConnect(url, { Origin: 'null' }), undefined, 'sandboxed pages are refused')
  assert.equal(await tryConnect(url, { Host: 'rebind.evil.example:12345' }), undefined, 'a name in the Host header is refused')
  const okHeaders: Record<string, string>[] = [{}, { Origin: 'http://localhost:3000' }, { Origin: 'http://127.0.0.1:8080' }, { Origin: 'https://abc123.itch.zone' }, { Origin: 'https://mygame.example' }]
  for (const headers of okHeaders) {
    const ws = await tryConnect(url, headers)
    assert.ok(ws, JSON.stringify(headers))
    ws.close()
  }
  assert.equal(await tryConnect(url, { Origin: 'https://itch.zone.evil.example' }), undefined, 'a wildcard is not a suffix match')
  await srv.close()
})

test('originAllowed: the rules in one place', () => {
  assert.equal(originAllowed(undefined), true)
  assert.equal(originAllowed('http://localhost'), true)
  assert.equal(originAllowed('http://[::1]:5173'), true)
  assert.equal(originAllowed('https://evil.example'), false)
  assert.equal(originAllowed('not a url'), false)
  assert.equal(originAllowed('https://a.b.itch.zone', ['https://*.itch.zone']), true)
  assert.equal(originAllowed('http://a.itch.zone', ['https://*.itch.zone']), false, 'scheme must match')
})

test('malformed frames get an error reply and do not crash the app', async () => {
  const crashes: unknown[] = []
  const onCrash = (e: unknown) => crashes.push(e)
  process.on('uncaughtException', onCrash)
  const { srv, url } = await server()
  const ws = (await tryConnect(url))!
  try {
    for (const bad of [[{ Ping: 5 }], ['ab'], [1], [null], [{ Ping: null }], [{ LinearCmd: { Id: 1, DeviceIndex: 0, Vectors: 5 } }]]) {
      const r = await ask(ws, bad)
      assert.ok(Array.isArray(r) && r.length >= 1, JSON.stringify(bad))
    }
    ws.send('x'.repeat(2 << 20)) // over the payload limit
    await once(ws, 'close')
    await new Promise((r) => setTimeout(r, 50))
    assert.deepEqual(crashes, [])
    const again = (await tryConnect(url))!
    assert.ok((await ask(again, [{ Ping: { Id: 1 } }]))[0].Ok)
    again.close()
  } finally {
    process.off('uncaughtException', onCrash)
    await srv.close()
  }
})

test('a client that connects and leaves does not stop a device another client is driving', async () => {
  const { dev, srv, url } = await server()
  const a = (await tryConnect(url))!
  assert.ok((await ask(a, [{ VibrateCmd: { Id: 1, DeviceIndex: 0, Speeds: [{ Index: 0, Speed: 0.6 }] } }]))[0].Ok)
  const probe = (await tryConnect(url))!
  assert.ok((await ask(probe, [{ Ping: { Id: 1 } }]))[0].Ok)
  probe.close()
  await new Promise((r) => setTimeout(r, 100))
  assert.deepEqual(dev.calls, ['level 0.6'], 'still running')
  a.close()
  await waitFor(() => dev.calls.at(-1) === 'stop')
  await srv.close()
})

test('protocol v4 clients are told plainly that BlowLink speaks v3', () => {
  const s = new Session(() => [], () => {})
  const r = s.handle('RequestServerInfo', { Id: 1, ClientName: 'x', ProtocolVersionMajor: 4, ProtocolVersionMinor: 0 }) as any
  assert.equal(r.Error.ErrorCode, 1)
  assert.match(r.Error.ErrorMessage, /v3/)
})

test('indexes, device numbers and values are checked', () => {
  const dev = new SpyDevice('v', 'V')
  const s = new Session(() => [dev], () => {})
  const h = (t: string, b: Record<string, unknown>) => s.handle(t, b) as any
  assert.equal(h('ScalarCmd', { Id: 1, DeviceIndex: 0, Scalars: [{ Index: 7, Scalar: 0.4 }] }).Error.ErrorCode, 4)
  assert.equal(h('ScalarCmd', { Id: 2, DeviceIndex: 'abc', Scalars: [] }).Error.ErrorCode, 4)
  assert.equal(h('ScalarCmd', { Id: 3, DeviceIndex: 0, Scalars: [{ Index: 0, Scalar: 'loud' }] }).Error.ErrorCode, 3)
  assert.deepEqual(dev.calls, [], 'none of those moved the device')
  assert.ok(h('ScalarCmd', { Id: 4, DeviceIndex: 0, Scalars: [{ Index: 1, Scalar: 0.9 }, { Index: 0, Scalar: 0.2 }] }).Ok, 'picks the entry for motor 0')
  assert.ok(h('ScalarCmd', { Id: 5, DeviceIndex: 0, Scalars: [{ Index: 0, Scalar: '0.8' }] }).Ok, 'numeric strings are accepted')
  assert.deepEqual(dev.calls, ['level 0.2', 'level 0.8'])
  assert.equal(h('RequestServerInfo', { Id: 6, MessageVersion: -1 }).Error.ErrorCode, 1)
  assert.equal(h('RequestServerInfo', { Id: 7, MessageVersion: 'x' }).Error.ErrorCode, 3)
})

test('StartScanning followed by RequestDeviceList does not announce the same device twice', async () => {
  const events: any[][] = []
  const s = new Session(() => [new SpyDevice('v', 'V')], (m) => events.push(m))
  s.handle('StartScanning', { Id: 1 })
  s.handle('RequestDeviceList', { Id: 2 })
  await new Promise((r) => setTimeout(r, 120))
  assert.equal(events.flat().filter((m) => 'DeviceAdded' in m).length, 0)
  assert.equal(events.flat().filter((m) => 'ScanningFinished' in m).length, 1)
})

test('Intiface link: vibrate axes become a level, DSTOP stops', async () => {
  const wsdm = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(wsdm, 'listening')
  const port = (wsdm.address() as { port: number }).port
  const dev = new SpyDevice('vacuglide', 'Autoblow VacuGlide')
  const link = new IntifaceLink(dev, { url: `ws://127.0.0.1:${port}`, name: 'v', address: 'v' }, realClock, () => {})
  link.start()
  const [conn] = await once(wsdm, 'connection')
  await once(conn, 'message')
  conn.send(Buffer.from('V0500 V1250\n'))
  await waitFor(() => dev.calls.length === 1)
  assert.deepEqual(dev.calls, ['level 0.5'], 'the strongest channel')
  conn.send(Buffer.from('DSTOP\n'))
  await waitFor(() => dev.calls.at(-1) === 'stop')
  assert.equal(hasTCodeStop('L0500 DSTOP'), true)
  assert.equal(hasTCodeStop('L0500'), false)
  link.close()
  wsdm.close()
})
