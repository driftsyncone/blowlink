// AI Ultra and VacuPump against a fake Autoblow API. Neither has been tried on a
// real device; these tests pin down the calls BlowLink makes, per Autoblow's docs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { AutoblowApi } from '../src/core/autoblow.ts'
import { realClock } from '../src/core/clock.ts'
import { defaultMotorOptions } from '../src/core/motor.ts'
import { Ultra } from '../src/core/ultra.ts'
import { VacuPump } from '../src/core/vacupump.ts'
import { waitFor } from './helpers.mts'

async function fakeApi(prefix: string, deviceType: string) {
  const calls: string[] = []
  const srv = createServer(async (req, res) => {
    let body = ''
    for await (const c of req) body += c
    if (req.url === `/${prefix}/connected`)
      return res.end(JSON.stringify({ connected: true, cluster: url, deviceType }))
    calls.push(`${req.url} ${body}`.trim())
    res.end('{"success":true}')
  })
  srv.listen(0, '127.0.0.1')
  await once(srv, 'listening')
  const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`
  return {
    api: new AutoblowApi('tok', { discoveryUrl: url }),
    calls,
    close: () => {
      srv.closeAllConnections()
      srv.close()
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const fast = { ...defaultMotorOptions, intervalMs: 20, idleMs: 300 }

// Full strokes 0 ↔ 1, 250 ms each way (120 BPM), as Cock Hero sends them.
async function strokes(dev: { stroke(p: number, d: number): void }, n: number) {
  for (let i = 0; i < n; i++) {
    dev.stroke(i % 2 ? 0 : 1, 250)
    await sleep(250)
  }
}

test('Ultra, oscillate: rhythm becomes one oscillate call over the stroke range, then stop', async () => {
  const f = await fakeApi('autoblow', 'autoblow-ultra')
  const dev = new Ultra('ultra', 'Ultra', f.api, { ...fast, motion: 'oscillate' }, realClock)
  dev.start()
  await strokes(dev, 6)
  await waitFor(() => f.calls.at(-1) === '/autoblow/oscillate/stop', 3000)
  const osc = f.calls.filter((c) => c.startsWith('/autoblow/oscillate '))
  assert.ok(osc.length >= 1 && osc.length <= 2, osc.join('\n'))
  const first = JSON.parse(osc[0].slice(osc[0].indexOf(' ') + 1))
  assert.equal(first.minY, 0)
  assert.equal(first.maxY, 100)
  assert.ok(first.speed >= 60 && first.speed <= 70, `speed ${first.speed}`) // 400 units/s ÷ 6 ≈ 67
  assert.ok(!f.calls.some((c) => c.startsWith('/autoblow/goto')))
  await dev.close()
  f.close()
})

test('Ultra, goto: each move becomes a go-to; a level oscillates over the full range', async () => {
  const f = await fakeApi('autoblow', 'autoblow-ultra')
  const dev = new Ultra('ultra', 'Ultra', f.api, { ...fast, motion: 'goto' }, realClock)
  dev.start()
  await strokes(dev, 5)
  const gotos = f.calls.filter((c) => c.startsWith('/autoblow/goto'))
  assert.ok(gotos.length >= 3, f.calls.join('\n'))
  assert.ok(gotos.every((c) => /"position":(0|100)/.test(c)))
  await waitFor(() => f.calls.at(-1) === '/autoblow/oscillate/stop', 3000)
  dev.level(0.5)
  await waitFor(() => f.calls.at(-1) === '/autoblow/oscillate {"speed":50,"minY":0,"maxY":100}')
  await dev.close()
  assert.equal(f.calls.at(-1), '/autoblow/oscillate/stop')
  f.close()
})

test('VacuPump: startup only checks it is online; a level holds vacuum under the cap; stop releases it', async () => {
  const f = await fakeApi('vacupump', 'vacupump')
  const dev = new VacuPump('pump', 'Pump', f.api, { ...fast, maxVacuumKpa: 20, releaseMs: 100 }, realClock)
  dev.start()
  await waitFor(() => dev.status.online)
  assert.deepEqual(f.calls, [], 'no pump commands at startup')

  dev.level(0.5)
  await waitFor(() => f.calls.length >= 2)
  assert.deepEqual(f.calls.slice(0, 2), ['/vacupump/manual/target {"targetVacuumKpa":-10}', '/vacupump/manual/start'])

  dev.level(1)
  await waitFor(() => f.calls.includes('/vacupump/manual/target {"targetVacuumKpa":-20}'))
  assert.equal(f.calls.filter((c) => c === '/vacupump/manual/start').length, 1, 'already in manual mode')

  dev.stop()
  await waitFor(() => f.calls.at(-1) === '/vacupump/manual/stop')
  assert.deepEqual(f.calls.slice(-2), ['/vacupump/manual/target {"targetVacuumKpa":0}', '/vacupump/manual/stop'])
  await dev.close()
  f.close()
})

test('VacuPump: strokes run stroke mode between the cap and 0 kPa (never positive pressure), then release', async () => {
  const f = await fakeApi('vacupump', 'vacupump')
  const dev = new VacuPump('pump', 'Pump', f.api, { ...fast, maxVacuumKpa: 99, releaseMs: 100 }, realClock)
  dev.start()
  await strokes(dev, 5)
  const cfg = f.calls.find((c) => c.startsWith('/vacupump/stroke/config'))!
  const body = JSON.parse(cfg.slice(cfg.indexOf(' ') + 1))
  assert.equal(body.vacuumTargetKpa, -60, 'cap clamped to the API limit')
  assert.equal(body.pressureTargetKpa, 0)
  assert.ok(body.speedPct >= 10 && body.speedPct <= 100)
  assert.ok(f.calls.includes('/vacupump/stroke/start'))
  await waitFor(() => f.calls.at(-1) === '/vacupump/manual/stop', 3000)
  const tail = f.calls.slice(f.calls.indexOf('/vacupump/stroke/pause'))
  assert.deepEqual(tail, [
    '/vacupump/stroke/pause',
    '/vacupump/manual/target {"targetVacuumKpa":0}',
    '/vacupump/manual/start',
    '/vacupump/manual/stop'
  ])
  await dev.close()
  f.close()
})
