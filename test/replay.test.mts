// Replays the recorded Cock Hero session (Alternating mode) through the Buttplug
// session into a dry VacuGlide, like the Go bridge's replay.py did.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Session } from '../src/core/buttplug.ts'
import { defaultMotorOptions } from '../src/core/motor.ts'
import { VacuGlide } from '../src/core/vacuglide.ts'
import { FakeClock } from './helpers.mts'

type Msg = Record<string, Record<string, unknown>>

function recorded(): Msg[] {
  const text = readFileSync(new URL('../testdata/cockhero-alternating.log', import.meta.url), 'utf8')
  const out: Msg[] = []
  for (const m of text.matchAll(/^(\d\d:\d\d:\d\d) <- (\[[\s\S]*?^\])/gm))
    for (const msg of JSON.parse(m[2]) as Msg[]) if ('LinearCmd' in msg || 'ScalarCmd' in msg) out.push(msg)
  return out
}

async function replay(mapping: 'velocity' | 'tempo'): Promise<number[]> {
  const clock = new FakeClock()
  const dev = new VacuGlide('vacuglide', 'Autoblow VacuGlide', null, { ...defaultMotorOptions, mapping, intervalMs: 200 }, clock)
  const speeds: number[] = []
  dev.on('log', (l) => {
    const m = /speed (\d+)%/.exec(l)
    if (m) speeds.push(Number(m[1]))
  })
  dev.start()
  const s = new Session(() => [dev], () => {})
  for (const msg of recorded()) {
    const [type, body] = Object.entries(msg)[0]
    const r = s.handle(type, { ...body, DeviceIndex: 0 })
    assert.ok('Ok' in r, JSON.stringify(r))
    const lin = (body.Vectors as { Duration: number }[] | undefined)?.[0]
    // +1 ms per message: the Go numbers came from a real websocket replay, which
    // adds about that much per round trip (0 ms gives 29 instead of 28 33).
    await clock.advance(1 + (type === 'LinearCmd' && lin ? lin.Duration : 0))
  }
  await clock.advance(15_000) // slow moves hold for up to 10 s + idle
  await dev.close()
  return speeds
}

test('replay (Alternating), velocity mapping', async () => {
  const speeds = await replay('velocity')
  // Pace averaged over two full strokes / at least 0.5 s (0.2.0). The Go bridge gave 5 21 28 33 19 11.
  assert.deepEqual(
    speeds.filter((v) => v > 0),
    [10, 23, 29, 16]
  )
  assert.equal(speeds.at(-1), 0, 'stops after the last stroke')
})

test('replay (Alternating), tempo mapping', async () => {
  const speeds = await replay('tempo')
  // The Go bridge gave 5 30 42 47 26 10 5.
  assert.deepEqual(
    speeds.filter((v) => v > 0),
    [5, 33, 42, 48, 37, 19]
  )
})

// Full Cycle capture: the game's strokes arrive with tens of ms of jitter. Speed
// must not flip with every stroke (it did with per-move speeds: 86/95/100…).
async function replayCapture(mapping: 'velocity' | 'tempo') {
  const { messages } = JSON.parse(readFileSync(new URL('../testdata/cockhero-fullcycle.json', import.meta.url), 'utf8'))
  const clock = new FakeClock()
  const dev = new VacuGlide('vacuglide', 'VG', null, { ...defaultMotorOptions, mapping, intervalMs: 200 }, clock)
  const sent: [number, number][] = []
  dev.on('log', (l) => {
    const m = /speed (\d+)%/.exec(l)
    if (m) sent.push([clock.t, Number(m[1])])
  })
  dev.start()
  const s = new Session(() => [dev], () => {})
  for (const [at, type, body] of messages) {
    await clock.advance(Math.max(0, at - clock.t))
    s.handle(type, { ...body, DeviceIndex: 0 })
  }
  await clock.advance(5000)
  await dev.close()
  return sent
}

for (const mapping of ['velocity', 'tempo'] as const) {
  test(`capture (Full Cycle), ${mapping}: steady in the fast part, few calls`, async () => {
    const sent = await replayCapture(mapping)
    assert.ok(sent.length <= 24, `${sent.length} calls`)
    // fast section: full strokes every ~130 ms from 82.9 s to 88.4 s (after a short ramp-up)
    const fast = sent.filter(([t]) => t > 83_700 && t < 88_400).map(([, v]) => v)
    assert.ok(fast.every((v) => v >= 95), `fast part: ${fast.join(' ')}`)
    assert.ok(fast.length <= 1, `fast part flips: ${fast.join(' ')}`)
    assert.equal(sent.at(-1)?.[1], 0, 'ends stopped')
  })
}
