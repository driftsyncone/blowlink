import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import WebSocket, { WebSocketServer } from 'ws'
import { ButtplugServer } from '../src/core/buttplug.ts'
import { realClock } from '../src/core/clock.ts'
import { Device } from '../src/core/device.ts'
import { IntifaceLink } from '../src/core/intiface.ts'
import { parseTCode } from '../src/core/tcode.ts'
import { waitFor } from './helpers.mts'

// Records what the inputs ask of a device.
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
  async close() {}
}

test('TCode as Intiface sends it', () => {
  // Captured from Intiface Engine 5.0.4: LinearCmd(0.8, 250 ms) and (0.1, 1500 ms).
  assert.deepEqual(parseTCode('L0799I250\n'), [{ axis: 'L0', pos: 0.799, intervalMs: 250 }])
  assert.deepEqual(parseTCode('L0099I1500\n'), [{ axis: 'L0', pos: 0.099, intervalMs: 1500 }])
  assert.deepEqual(parseTCode('L05 R1999S20 DSTOP'), [
    { axis: 'L0', pos: 0.5 },
    { axis: 'R1', pos: 0.999, speed: 20 }
  ])
  assert.deepEqual(parseTCode('garbage\n'), [])
})

test('Buttplug server: handshake, device list, commands, stop on disconnect', async () => {
  const dev = new SpyDevice('vacuglide', 'Autoblow VacuGlide')
  const srv = new ButtplugServer(() => [dev], { host: '127.0.0.1', port: 0 }, () => {})
  await srv.start()
  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}`)
  await once(ws, 'open')
  const call = async (m: object) => {
    ws.send(JSON.stringify([m]))
    const [data] = await once(ws, 'message')
    return JSON.parse(String(data))[0]
  }
  const info = await call({ RequestServerInfo: { Id: 1, ClientName: 'test', MessageVersion: 1 } })
  assert.equal(info.ServerInfo.MessageVersion, 1, 'never answers above the client version')
  const list = await call({ RequestDeviceList: { Id: 2 } })
  assert.equal(list.DeviceList.Devices[0].DeviceName, 'Autoblow VacuGlide')
  assert.ok((await call({ LinearCmd: { Id: 3, DeviceIndex: 0, Vectors: [{ Index: 0, Duration: 250, Position: 0.8 }] } })).Ok)
  assert.ok((await call({ VibrateCmd: { Id: 4, DeviceIndex: 0, Speeds: [{ Index: 0, Speed: 0.5 }] } })).Ok)
  assert.equal((await call({ StopDeviceCmd: { Id: 5, DeviceIndex: 7 } })).Error.ErrorCode, 4)
  ws.close()
  await waitFor(() => dev.calls.at(-1) === 'stop')
  assert.deepEqual(dev.calls, ['stroke 0.8 250', 'level 0.5', 'stop'])
  await srv.close()
})

test('Intiface link: handshake, TCode to strokes, stop when Intiface goes away', async () => {
  const wsdm = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(wsdm, 'listening')
  const port = (wsdm.address() as { port: number }).port
  const dev = new SpyDevice('vacuglide', 'Autoblow VacuGlide')
  const link = new IntifaceLink(dev, { url: `ws://127.0.0.1:${port}`, name: 'vacuglide', address: 'vacuglide' }, realClock, () => {})
  link.start()
  const [conn] = await once(wsdm, 'connection')
  const [hello] = await once(conn, 'message')
  assert.deepEqual(JSON.parse(String(hello)), { identifier: 'vacuglide', address: 'vacuglide', version: 0 })
  conn.send(Buffer.from('L0799I250\n')) // Intiface sends binary frames
  await waitFor(() => dev.calls.length === 1)
  assert.deepEqual(dev.calls, ['stroke 0.799 250'])
  conn.terminate()
  await waitFor(() => dev.calls.at(-1) === 'stop')
  link.close()
  wsdm.close()
})
