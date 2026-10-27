// Vibrate-style levels on a cloud device: rise at once, fall only after 0.5 s.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Session } from '../src/core/buttplug.ts'
import { defaultMotorOptions } from '../src/core/motor.ts'
import { VacuGlide } from '../src/core/vacuglide.ts'
import { FakeClock } from './helpers.mts'

function rig() {
  const clock = new FakeClock()
  const dev = new VacuGlide('vacuglide', 'VG', null, { ...defaultMotorOptions, intervalMs: 200 }, clock)
  const sent: [number, number][] = []
  dev.on('log', (l) => {
    const m = /speed (\d+)%/.exec(l)
    if (m) sent.push([clock.t, Number(m[1])])
  })
  dev.start()
  return { clock, dev, sent }
}

test('fast on/off pulses play as a steady level, then stop 0.5 s after the last pulse', async () => {
  const { clock, dev, sent } = rig()
  await clock.advance(300)
  for (let i = 0; i < 15; i++) {
    dev.level(0.5)
    await clock.advance(500)
    dev.level(0)
    await clock.advance(200)
  }
  await clock.advance(1000)
  const after = sent.filter(([t]) => t >= 300).map(([, v]) => v)
  assert.deepEqual(after, [50, 0])
  const stopAt = sent.at(-1)![0] - (300 + 15 * 700 - 200)
  assert.ok(stopAt >= 500 && stopAt <= 800, `stopped ${stopAt} ms after the last pulse ended`)
})

test('rises go out at once; a drop to a lower level waits 0.5 s', async () => {
  const { clock, dev, sent } = rig()
  await clock.advance(600) // past the startup stop and the 200 ms call spacing
  dev.level(0.3)
  await clock.advance(1)
  assert.equal(sent.at(-1)?.[1], 30)
  await clock.advance(300) // pacer interval passed
  dev.level(0.9)
  await clock.advance(1)
  assert.equal(sent.at(-1)?.[1], 90, 'increase is immediate')
  const t = clock.t
  dev.level(0.4)
  await clock.advance(400)
  assert.equal(sent.at(-1)?.[1], 90, 'still holding')
  await clock.advance(400)
  assert.equal(sent.at(-1)?.[1], 40)
  assert.ok(sent.at(-1)![0] - t >= 500)
})

test('an explicit stop is never delayed', async () => {
  const { clock, dev, sent } = rig()
  await clock.advance(300)
  dev.level(1)
  await clock.advance(300)
  dev.stop()
  await clock.advance(1)
  assert.equal(sent.at(-1)?.[1], 0)
})

test('Cycle of Corruption capture: far fewer calls, same shape', async () => {
  const { messages } = JSON.parse(readFileSync(new URL('../testdata/cycle-of-corruption.json', import.meta.url), 'utf8'))
  const { clock, dev, sent } = rig()
  const s = new Session(() => [dev], () => {})
  for (const [at, type, body] of messages) {
    await clock.advance(Math.max(0, at - clock.t))
    s.handle(type, { ...body, ...(type === 'StopAllDevices' ? {} : { DeviceIndex: 0 }) })
  }
  await clock.advance(2000)
  // dev.5 sent 42 commands here (the 50 % pulse section alone ~30).
  assert.ok(sent.length <= 16, `${sent.length} calls: ${sent.map(([, v]) => v).join(' ')}`)
  const pulses = sent.filter(([t]) => t > 418_900 && t < 429_000).map(([, v]) => v)
  assert.deepEqual(pulses.slice(0, 1), [50], `pulse section: ${pulses.join(' ')}`)
  assert.ok(pulses.length <= 3, `pulse section: ${pulses.join(' ')}`)
  assert.equal(sent.at(-1)?.[1], 0)
})

test('Cycle of Corruption, 6.5 min: each pulse section is one command, game stops go out within the stop grace', async () => {
  const { messages } = JSON.parse(readFileSync(new URL('../testdata/cycle-of-corruption-2.json', import.meta.url), 'utf8'))
  const { clock, dev, sent } = rig()
  const s = new Session(() => [dev], () => {})
  const stops: number[] = []
  for (const [at, type, body] of messages) {
    await clock.advance(Math.max(0, at - clock.t))
    if (type === 'StopAllDevices') stops.push(clock.t)
    s.handle(type, { ...body, ...(type === 'StopAllDevices' ? {} : { DeviceIndex: 0 }) })
  }
  await clock.advance(2000)
  // 111 game messages; live dev.6 sent 20 commands.
  assert.ok(sent.length <= 24, `${sent.length} calls`)
  for (const t of stops) {
    const next = sent.find(([at]) => at >= t)
    if (next && next[1] === 0) assert.ok(next[0] - t <= 150, `stop at ${t} went out after ${next[0] - t} ms`)
  }
})

test('Heat Control: very regular strokes give a steady speed and almost no calls', async () => {
  const { messages } = JSON.parse(readFileSync(new URL('../testdata/heat-control.json', import.meta.url), 'utf8'))
  const { clock, dev, sent } = rig()
  const s = new Session(() => [dev], () => {})
  for (const [at, type, body] of messages) {
    await clock.advance(Math.max(0, at - clock.t))
    s.handle(type, { ...body, ...(type === 'StopAllDevices' ? {} : { DeviceIndex: 0 }) })
  }
  await clock.advance(5000)
  // 176 strokes; live dev.6 sent 7 commands (100 0 65 0 55 73 0).
  assert.ok(sent.length <= 10, `${sent.length} calls: ${sent.map(([, v]) => v).join(' ')}`)
  const long = sent.filter(([, v]) => v >= 65 && v <= 80)
  assert.ok(long.length >= 1, 'the long run plays at about 73 %')
  assert.equal(sent.at(-1)?.[1], 0)
})
