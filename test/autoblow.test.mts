// The VacuGlide against a fake Autoblow API (discovery, cluster, speeds, 502).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage } from 'node:http'
import { once } from 'node:events'
import { AutoblowApi, clusterUrl, detectDeviceType } from '../src/core/autoblow.ts'
import { realClock } from '../src/core/clock.ts'
import { defaultMotorOptions } from '../src/core/motor.ts'
import { VacuGlide } from '../src/core/vacuglide.ts'
import { waitFor } from './helpers.mts'

async function fakeApi(handler: (req: IncomingMessage, body: string) => [number, object]) {
  const seen: string[] = []
  const srv = createServer(async (req, res) => {
    let body = ''
    for await (const c of req) body += c
    seen.push(`${req.method} ${req.url} ${body}`.trim())
    const [code, out] = handler(req, body)
    res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(out))
  })
  srv.listen(0, '127.0.0.1')
  await once(srv, 'listening')
  const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`
  return {
    url,
    seen,
    close: () => {
      srv.closeAllConnections()
      srv.close()
    }
  }
}

test('cluster names only resolve to autoblowapi.com', () => {
  assert.equal(clusterUrl('eu-central-1'), 'https://eu-central-1.autoblowapi.com')
  assert.equal(clusterUrl('https://us-east-1.autoblowapi.com/'), 'https://us-east-1.autoblowapi.com')
  assert.throws(() => clusterUrl('evil.example.com'))
})

test('VacuGlide: discovers, sends speeds with the token, stops, rediscovers after 502', async () => {
  let online = true
  const api = await fakeApi((req) => {
    assert.equal(req.headers['x-device-token'], 'tok')
    if (req.url === '/vacuglide/connected') return [200, { connected: true, cluster: fake.url, deviceType: 'vacuglide' }]
    if (!online) return [502, { error: 'DeviceNotConnectedError' }]
    return [200, { success: true }]
  })
  const fake = api
  const dev = new VacuGlide(
    'vacuglide',
    'VG',
    new AutoblowApi('tok', { discoveryUrl: api.url }),
    { ...defaultMotorOptions, intervalMs: 20 },
    realClock
  )
  dev.start()
  dev.level(0.5)
  await waitFor(() => api.seen.includes('PUT /vacuglide/target-speed {"targetSpeed":50}'))
  assert.equal(api.seen[0], 'GET /vacuglide/connected')
  assert.equal(dev.status.online, true)

  online = false
  dev.level(0.8)
  await waitFor(() => dev.status.error?.includes('502') ?? false)
  online = true
  await waitFor(() => dev.status.error === undefined && dev.status.output === 80, 5000)
  assert.ok(api.seen.filter((s) => s === 'GET /vacuglide/connected').length >= 2, 'rediscovered after 502')

  await dev.close()
  assert.equal(api.seen.at(-1), 'PUT /vacuglide/target-speed/stop')
  api.close()
})

test('discovery rejects a token for another device type', async () => {
  const api = await fakeApi(() => [200, { connected: true, cluster: 'x', deviceType: 'vacupump' }])
  await assert.rejects(new AutoblowApi('tok', { discoveryUrl: api.url }).discover('vacuglide'), /vacupump/)
  api.close()
})

test('detectDeviceType: by deviceType, or unknown when offline', async () => {
  const pump = await fakeApi((req) =>
    req.url === '/vacupump/connected' ? [200, { connected: true, cluster: 'x', deviceType: 'vacupump' }] : [200, { connected: false }]
  )
  assert.deepEqual(await detectDeviceType('tok', { discoveryUrl: pump.url }), { type: 'vacupump', online: true })
  pump.close()
  const off = await fakeApi(() => [200, { connected: false }])
  assert.deepEqual(await detectDeviceType('tok', { discoveryUrl: off.url }), { online: false })
  off.close()
  const bad = await fakeApi(() => [401, { error: 'bad token' }])
  await assert.rejects(detectDeviceType('tok', { discoveryUrl: bad.url }), /401/)
  bad.close()
})
