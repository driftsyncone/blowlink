// Edge cases from the full review (2026-10-27): each of these was reproduced as a bug before the fix.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { realClock } from '../src/core/clock.ts'
import { defaultMotorOptions } from '../src/core/motor.ts'
import { VacuGlide } from '../src/core/vacuglide.ts'
import { FakeClock } from './helpers.mts'

function dry(extra: Record<string, unknown> = {}) {
  const clock = new FakeClock()
  const dev = new VacuGlide('v', 'VG', null, { ...defaultMotorOptions, intervalMs: 200, ...extra }, clock)
  const sent: [number, number][] = []
  dev.on('log', (l) => {
    const m = /speed (\d+)%/.exec(l)
    if (m) sent.push([clock.t, Number(m[1])])
  })
  dev.start()
  return { clock, dev, sent }
}

// A fake Autoblow API object: records calls, can fail on demand.
function fakeApi(onPut: (n: number, path: string) => void | Promise<void> = () => {}) {
  const calls: string[] = []
  const api = {
    host: 'http://fake',
    discover: async () => {},
    put: async (_dev: string, path: string, body?: unknown) => {
      calls.push(path + (body ? ' ' + JSON.stringify(body) : ''))
      await onPut(calls.length, path)
    }
  }
  return { api: api as unknown as AutoblowApi, calls }
}

test('the real clock never goes backwards when the system clock is set back', () => {
  const a = realClock.now()
  const spy = mock.method(Date, 'now', () => 1000)
  try {
    assert.ok(realClock.now() >= a, 'monotonic')
  } finally {
    spy.mock.restore()
  }
})

test('a send that failed after reaching the device does not hide the later stop', async () => {
  const clock = new FakeClock()
  let armed = false
  const f = fakeApi((_n, path) => {
    if (armed && path === 'target-speed') throw new Error('timeout') // reached the server, response lost
  })
  const dev = new VacuGlide('v', 'VG', f.api, { ...defaultMotorOptions, intervalMs: 200 }, clock)
  dev.start()
  await clock.advance(1000)
  armed = true
  dev.level(0.6)
  await clock.advance(500)
  armed = false
  dev.stop()
  await clock.advance(10_000)
  assert.equal(f.calls.at(-1), 'target-speed/stop', f.calls.join(' | '))
})

test('closing retries the stop through a rate limit and waits for a send in flight', async () => {
  const clock = new FakeClock()
  let failStops = 0
  const f = fakeApi((_n, path) => {
    if (path === 'target-speed/stop' && failStops > 0) {
      failStops--
      throw new Error('HTTP 429: Rate limit exceeded, retry in 1 seconds')
    }
  })
  const dev = new VacuGlide('v', 'VG', f.api, { ...defaultMotorOptions, intervalMs: 200 }, clock)
  dev.start()
  await clock.advance(1000)
  dev.level(0.6)
  await clock.advance(500)
  failStops = 2
  const closing = dev.close()
  await clock.advance(10_000)
  await closing
  assert.equal(f.calls.at(-1), 'target-speed/stop')
  assert.equal(failStops, 0, 'the stop went through after retries')
})

test('a game stop is held for the grace period at every pacer tick phase', async () => {
  for (let phase = 0; phase < 300; phase += 20) {
    const { clock, dev, sent } = dry({ intervalMs: 300 })
    await clock.advance(600 + phase)
    dev.level(0.6)
    await clock.advance(700)
    const t0 = clock.t
    dev.stopSoon()
    await clock.advance(80)
    dev.stroke(1, 300)
    await clock.advance(2000)
    const zeros = sent.filter(([t, v]) => t >= t0 && t < t0 + 600 && v === 0)
    assert.equal(zeros.length, 0, `phase ${phase}: stop leaked at ${zeros.map(([t]) => t - t0)}`)
  }
})

test('a position hold after a vibrate level does not freeze the level', async () => {
  const { clock, dev, sent } = dry()
  await clock.advance(400)
  dev.level(1)
  await clock.advance(50)
  dev.stroke(0, 5) // Rumble Party / Mousegun style hold at the position it already has
  await clock.advance(50)
  dev.level(0)
  await clock.advance(1000)
  const last = sent.at(-1)!
  assert.equal(last[1], 0, `level 0 reached the device: ${sent.map((x) => x.join(':'))}`)
  assert.ok(last[0] - 500 < 1000)
})

test('an old hold does not cut a level short later', async () => {
  const { clock, dev, sent } = dry()
  await clock.advance(400)
  dev.stroke(0, 50) // a hold at t=0
  await clock.advance(10_000)
  dev.level(0.8)
  await clock.advance(50)
  dev.stroke(0.01, 50)
  await clock.advance(2000)
  const zeros = sent.filter(([t, v]) => t > 10_400 && v === 0)
  assert.equal(zeros.length, 0, `level stayed: ${sent.map((x) => x.join(':'))}`)
})

test('a move with a non-finite duration or position is ignored', async () => {
  const { clock, dev, sent } = dry()
  await clock.advance(400)
  dev.stroke(1, 300)
  await clock.advance(300)
  dev.stroke(0, 300)
  await clock.advance(300)
  dev.stroke(1, Infinity)
  dev.stroke(Number.NaN, 300)
  dev.stroke(0, Number.NaN)
  await clock.advance(30_000)
  assert.equal(sent.at(-1)?.[1], 0, `ended stopped: ${sent.map((x) => x.join(':'))}`)
})

test('tempo mapping: a lone slow move still gives a pulse', async () => {
  const { clock, dev, sent } = dry({ mapping: 'tempo' })
  await clock.advance(400)
  dev.stroke(1, 3000)
  await clock.advance(500)
  assert.ok(sent.some(([, v]) => v >= 1), `speed sent: ${sent.map((x) => x.join(':'))}`)
})

// ---- VacuPump: the release sequence has to survive a quit mid-sequence and a stop timer race ----
import { VacuPump } from '../src/core/vacupump.ts'

test('VacuPump: closing while a hold is half sent still releases the vacuum and turns the pump off', async () => {
  const clock = new FakeClock()
  const f = fakeApi((_n, path) => (path === 'manual/start' ? new Promise((r) => clock.setTimeout(() => r(undefined), 1000)) : undefined))
  const dev = new VacuPump('p', 'Pump', f.api, { ...defaultMotorOptions, intervalMs: 200, maxVacuumKpa: 20, releaseMs: 500 }, clock)
  dev.start()
  await clock.advance(500)
  dev.level(0.5)
  await clock.advance(300) // target sent, start still in flight
  const closing = dev.close()
  await clock.advance(20_000)
  await closing
  assert.ok(f.calls.includes('manual/target {"targetVacuumKpa":0}'), f.calls.join(' | '))
  assert.equal(f.calls.at(-1), 'manual/stop', f.calls.join(' | '))
})

test('VacuPump: a stop timer that is still in flight cannot swallow the next stop', async () => {
  const clock = new FakeClock()
  let stops = 0
  const f = fakeApi((_n, path) => {
    if (path === 'manual/stop' && stops++ === 0) return new Promise((r) => clock.setTimeout(() => r(undefined), 1500))
  })
  const dev = new VacuPump('p', 'Pump', f.api, { ...defaultMotorOptions, intervalMs: 200, maxVacuumKpa: 20, releaseMs: 300, stopGraceMs: 0 }, clock)
  dev.start()
  await clock.advance(500)
  dev.level(0.5)
  await clock.advance(500)
  dev.stop() // release: target 0, then after 300 ms the pump is turned off (slow response)
  await clock.advance(700)
  dev.level(0.5) // arrives while the manual/stop is still in flight
  await clock.advance(3000)
  dev.stop()
  await clock.advance(5000)
  assert.equal(f.calls.at(-1), 'manual/stop', f.calls.join(' | '))
  assert.equal(f.calls.filter((c) => c === 'manual/stop').length, 2, f.calls.join(' | '))
  const i = f.calls.indexOf('manual/stop')
  assert.ok(f.calls.slice(i + 1).some((c) => c.startsWith('manual/target {"targetVacuumKpa":-10')), 'the hold happened after the first stop finished')
  assert.ok(f.calls.slice(i + 1).includes('manual/start'), 'and restarted the pump')
})

test('VacuPump: a non-numeric vacuum cap falls back to the default', async () => {
  const clock = new FakeClock()
  const f = fakeApi()
  const dev = new VacuPump('p', 'Pump', f.api, { ...defaultMotorOptions, intervalMs: 200, maxVacuumKpa: 'abc' as unknown as number }, clock)
  dev.start()
  await clock.advance(500)
  dev.level(1)
  await clock.advance(500)
  assert.ok(f.calls.includes('manual/target {"targetVacuumKpa":-20}'), f.calls.join(' | '))
})

// ---- config loading and the API client ----
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { loadConfig } from '../src/core/config.ts'
import { AutoblowApi, ApiError } from '../src/core/autoblow.ts'

test('config: a truncated file is moved aside and the app starts with defaults', () => {
  const dir = mkdtempSync(join(tmpdir(), 'blowlink-'))
  const path = join(dir, 'config.json')
  writeFileSync(path, '{"buttplug": {"port": 12')
  const warns: string[] = []
  const cfg = loadConfig(path, (m) => warns.push(m))
  assert.equal(cfg.buttplug.port, 12345)
  assert.deepEqual(cfg.devices, [])
  assert.ok(existsSync(path + '.bad'))
  assert.equal(warns.length, 1)
})

test('config: wrong types are fixed, bad devices dropped, ids made unique', () => {
  const dir = mkdtempSync(join(tmpdir(), 'blowlink-'))
  const path = join(dir, 'config.json')
  writeFileSync(
    path,
    JSON.stringify({
      buttplug: { port: 'x', host: 5 },
      apiUrl: 'ftp://nope',
      idleMs: -4,
      devices: [
        { type: 'vacuglide', token: 'abcdefgh12', maxSpeed: 'abc', mapping: 7, maxVacuumKpa: 'big' },
        { type: 'vacuglide', token: 'abcdefgh34', id: 'vacuglide' },
        { type: 'nope', token: 'abcdefgh12' },
        null,
        { type: 'vacuglide', token: 'short' },
        { type: 'vacuglide', token: 'abcdefgh56\nSECRET' },
        { type: 'vacupump', token: 'abcdefgh78', maxVacuumKpa: 500 }
      ]
    })
  )
  const warns: string[] = []
  const cfg = loadConfig(path, (m) => warns.push(m))
  assert.equal(cfg.buttplug.port, 12345)
  assert.equal(cfg.buttplug.host, '127.0.0.1')
  assert.equal(cfg.apiUrl, '')
  assert.equal(cfg.idleMs, 100)
  assert.deepEqual(cfg.devices.map((d) => d.id), ['vacuglide', 'vacuglide-2', 'vacupump'])
  assert.equal(cfg.devices[0].maxSpeed, 100)
  assert.equal(cfg.devices[0].mapping, 'velocity')
  assert.equal(cfg.devices[2].maxVacuumKpa, 60)
  assert.equal(warns.length, 4)
  assert.ok(!warns.join(' ').includes('SECRET'), 'no token text in warnings')
})

test('config: a valid file passes through unchanged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'blowlink-'))
  const path = join(dir, 'config.json')
  writeFileSync(path, JSON.stringify({ buttplug: { enabled: true, host: '127.0.0.1', port: 12346 }, stopGraceMs: 0, devices: [{ type: 'autoblow-ultra', token: 'abcdefgh12', name: 'My Ultra', motion: 'goto', mapping: 'tempo', maxSpeed: 70 }] }))
  const cfg = loadConfig(path)
  assert.equal(cfg.buttplug.port, 12346)
  assert.equal(cfg.stopGraceMs, 0)
  assert.equal(cfg.devices[0].name, 'My Ultra')
  assert.equal(cfg.devices[0].motion, 'goto')
  assert.equal(cfg.devices[0].mapping, 'tempo')
  assert.equal(cfg.devices[0].maxSpeed, 70)
})

test('API: a redirect is refused and never carries the token to another origin', async () => {
  const seen: (string | undefined)[] = []
  const b = createServer((req, res) => {
    seen.push(req.headers['x-device-token'] as string | undefined)
    res.end('{}')
  })
  b.listen(0, '127.0.0.1')
  await once(b, 'listening')
  const bUrl = `http://127.0.0.1:${(b.address() as { port: number }).port}/x`
  const a = createServer((_req, res) => {
    res.writeHead(307, { Location: bUrl })
    res.end()
  })
  a.listen(0, '127.0.0.1')
  await once(a, 'listening')
  const aUrl = `http://127.0.0.1:${(a.address() as { port: number }).port}/y`
  const api = new AutoblowApi('SECRET-TOKEN-123')
  await assert.rejects(api.request('GET', aUrl))
  assert.deepEqual(seen, [], 'the second origin saw no request')
  for (const s of [a, b]) {
    s.closeAllConnections()
    s.close()
  }
})

test('API: errors never contain the token, even when the token is not a valid header value', async () => {
  const api = new AutoblowApi('abc\ndef-SECRET')
  const err = await api.request('GET', 'http://127.0.0.1:9/z').catch((e) => e as Error)
  assert.ok(err instanceof Error)
  assert.ok(!err.message.includes('SECRET'), err.message)
})

test('a rejected token (401) takes the device offline at once instead of retrying', async () => {
  const clock = new FakeClock()
  const f = fakeApi((_n, path) => {
    if (path === 'target-speed') throw new ApiError(401, 'HTTP 401: x')
  })
  const dev = new VacuGlide('v', 'VG', f.api, { ...defaultMotorOptions, intervalMs: 200 }, clock)
  dev.start()
  await clock.advance(500)
  dev.level(0.6)
  await clock.advance(30_000)
  assert.equal(dev.status.online, false)
  assert.equal(f.calls.filter((c) => c.startsWith('target-speed {')).length, 1, f.calls.join(' | '))
})
