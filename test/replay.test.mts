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

test('replay, velocity mapping matches the Go bridge', async () => {
  const speeds = await replay('velocity')
  // Go bridge on the same recording (NOTES, 2026-10-16): 5 21 28 33 19 11, then stop.
  assert.deepEqual(
    speeds.filter((v) => v > 0),
    [5, 21, 28, 33, 19, 11]
  )
  assert.equal(speeds.at(-1), 0, 'stops after the last stroke')
})

test('replay, tempo mapping matches the Go bridge', async () => {
  const speeds = await replay('tempo')
  // Go bridge: 5 30 42 47 26 10 5, then stop.
  assert.deepEqual(
    speeds.filter((v) => v > 0),
    [5, 30, 42, 47, 26, 10, 5]
  )
})
