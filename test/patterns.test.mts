// Patterns other games are known to send (read from Plug2in's docs, Heat Control and
// Fap Hero Journey), played into a dry VacuGlide. Checks that each reaches the device
// as something sensible and cheap: few calls, no stutter, stops when the game does.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Session } from '../src/core/buttplug.ts'
import { defaultMotorOptions } from '../src/core/motor.ts'
import { VacuGlide } from '../src/core/vacuglide.ts'
import { FakeClock } from './helpers.mts'

function rig(extra: { stopGraceMs?: number } = {}) {
  const clock = new FakeClock()
  const dev = new VacuGlide('vacuglide', 'VG', null, { ...defaultMotorOptions, intervalMs: 200, ...extra }, clock)
  const sent: [number, number][] = []
  dev.on('log', (l) => {
    const m = /speed (\d+)%/.exec(l)
    if (m) sent.push([clock.t, Number(m[1])])
  })
  dev.start()
  const s = new Session(() => [dev], () => {})
  const scalar = (v: number) => s.handle('ScalarCmd', { DeviceIndex: 0, Scalars: [{ Index: 0, Scalar: v, ActuatorType: 'Vibrate' }] })
  const linear = (pos: number, dur: number) => s.handle('LinearCmd', { DeviceIndex: 0, Vectors: [{ Index: 0, Duration: dur, Position: pos }] })
  const stopAll = () => s.handle('StopAllDevices', {})
  const stopDevice = () => s.handle('StopDeviceCmd', { DeviceIndex: 0 })
  return { clock, sent, scalar, linear, stopAll, stopDevice }
}

// Plug2in letters: A is the lowest step, Z is 1.0, '.' is off (spread evenly over `secs`).
const letters = (p: string, secs: number) =>
  [...p.toLowerCase()].map((c) => ({ v: c === '.' ? 0 : (c.charCodeAt(0) - 96) / 26, ms: (secs * 1000) / p.length }))

async function play(r: ReturnType<typeof rig>, p: string, secs: number) {
  for (const { v, ms } of letters(p, secs)) {
    r.scalar(v)
    await r.clock.advance(ms)
  }
}

test('Plug2in alternating strong/weak (Vbvbvbvb..) plays as one steady high level', async () => {
  const r = rig()
  await r.clock.advance(300)
  const n = r.sent.length
  for (let i = 0; i < 4; i++) await play(r, 'Vbvbvbvbvb..', 5)
  await r.clock.advance(1500)
  const speeds = r.sent.slice(n).map(([, v]) => v)
  assert.ok(Math.max(...speeds) >= 80, `peak ${speeds}`)
  // 4 repeats, each ends in a real 0.8 s pause: at most high, a weak tail, off per repeat
  assert.ok(speeds.length <= 12, `${speeds.length} calls: ${speeds}`)
  assert.ok(speeds.filter((v) => v > 0 && v < 80).length <= 4, `no extra wobble: ${speeds}`)
  assert.equal(speeds.at(-1), 0)
})

test('Plug2in ramp (abfjmpsvyz) climbs, then stops after the pause', async () => {
  const r = rig()
  await r.clock.advance(300)
  const n = r.sent.length
  await play(r, 'abfjmpsvyz', 1)
  r.scalar(0)
  await r.clock.advance(2000)
  const speeds = r.sent.slice(n).map(([, v]) => v)
  assert.ok(speeds.every((v, i) => i === 0 || v >= speeds[i - 1] || v === 0), `rises only: ${speeds}`)
  assert.equal(speeds.at(-1), 0)
})

test('Heat Control: 190 ms strokes at 0.07-0.93 settle at one speed; idle StopAllDevices costs no calls', async () => {
  const r = rig()
  await r.clock.advance(300)
  const n = r.sent.length
  for (let i = 0; i < 40; i++) {
    r.linear(i % 2 ? 0.07 : 0.93, 190)
    await r.clock.advance(190)
  }
  const moving = r.sent.slice(n).map(([, v]) => v)
  const settled = moving.slice(-3)
  assert.ok(settled.every((v) => v >= 60 && v <= 85), `settled ${settled}`)
  r.stopAll()
  await r.clock.advance(200)
  const afterStop = r.sent.length
  for (let i = 0; i < 10; i++) {
    r.stopAll() // the game repeats this about once a second while idle
    await r.clock.advance(1000)
  }
  assert.equal(r.sent.length, afterStop, 'repeated stops send nothing')
})

test('Fap Hero Journey-style funscript stream: slow sweep is slow, a held position stops', async () => {
  const r = rig()
  await r.clock.advance(300)
  const n = r.sent.length
  // 30 position updates a second: 0 -> 1 -> 0 over 2 s each way, for ten seconds
  for (let i = 0; i < 300; i++) {
    const phase = (i / 30 / 2) % 2
    r.linear(phase < 1 ? phase : 2 - phase, 33)
    await r.clock.advance(33)
  }
  const sweep = r.sent.slice(n).map(([, v]) => v).filter((v) => v > 0)
  assert.ok(sweep.length > 0 && Math.max(...sweep) <= 30, `slow sweep stays slow: ${sweep}`)
  // "block" effect: the script is ignored and the device holds a fixed position
  const m = r.sent.length
  for (let i = 0; i < 150; i++) {
    r.linear(0.5, 33)
    await r.clock.advance(33)
  }
  assert.equal(r.sent.at(-1)?.[1], 0, `a held position ends at 0: ${r.sent.slice(m)}`)
})

test('Treasure of Nadia-style scene (four steps: 1, 2, 3, 0) climbs and ends', async () => {
  const r = rig()
  await r.clock.advance(300)
  const n = r.sent.length
  // lovenseCommand(1|2|3) = Vibrate 7|13|20 of 20, held until the next step; 0 stops
  for (const [step, ms] of [[7, 3600], [13, 400], [20, 8000], [0, 1500]] as const) {
    r.scalar(step / 20)
    await r.clock.advance(ms)
  }
  const speeds = r.sent.slice(n).map(([, v]) => v)
  assert.deepEqual(speeds.filter((v) => v > 0).slice(0, 1), [35])
  assert.ok(speeds.includes(100), `reaches the top: ${speeds}`)
  assert.equal(speeds.at(-1), 0)
  assert.ok(speeds.every((v, i) => i === 0 || v >= speeds[i - 1] || v === 0), `climbs only: ${speeds}`)
})

test('TVS-style live depth (20 moves a second, 1.5 thrusts a second) settles near 50 % with few calls', async () => {
  const r = rig()
  await r.clock.advance(300)
  const n = r.sent.length
  for (let i = 0; i < 200; i++) {
    r.linear((1 - Math.cos(2 * Math.PI * ((i / 20) * 1.5))) / 2, 50)
    await r.clock.advance(50)
  }
  const speeds = r.sent.slice(n).map(([, v]) => v)
  assert.ok(speeds.at(-2)! >= 40 && speeds.at(-2)! <= 60, `settled ${speeds}`) // last entry is the stop
  assert.ok(speeds.length <= 8, `${speeds.length} calls in 10 s: ${speeds}`)
})

test('LoveMachine-style strokes (two moves per stroke) keep the stroke tempo', async () => {
  for (const [period, want] of [[1.0, 33], [0.4, 83]] as const) {
    const r = rig()
    await r.clock.advance(300)
    const n = r.sent.length
    for (let i = 0; i < 20; i++) {
      r.linear(i % 2 ? 0 : 1, (period * 1000) / 2)
      await r.clock.advance((period * 1000) / 2)
    }
    const speeds = r.sent.slice(n).map(([, v]) => v)
    assert.ok(Math.abs(speeds.at(-1)! - want) <= 3 || Math.abs(speeds.at(-2)! - want) <= 3, `${period}s stroke: ${speeds}`)
  }
})

// Mousegun sends a vibrate pulse AND one lone Linear move per event.
for (const order of ['vibrate first', 'linear first'] as const) {
  test(`event pulse with a lone Linear (${order}): 0.5 s pulse runs about 0.5-1 s`, async () => {
    const r = rig()
    await r.clock.advance(300)
    const n = r.sent.length
    if (order === 'vibrate first') {
      r.scalar(0.5)
      r.linear(0.5, 500)
    } else {
      r.linear(0.5, 500)
      r.scalar(0.5)
    }
    await r.clock.advance(500)
    r.scalar(0)
    await r.clock.advance(4000)
    const sent = r.sent.slice(n)
    assert.ok(sent.length >= 2, `pulse reached the device: ${sent}`)
    assert.ok(sent.at(-1)![0] - 300 <= 1100, `stopped in time: ${sent}`)
  })
}

test('Hunted on Eclipse-9 idle: a StopDeviceCmd right before every stroke does not drop the device to zero', async () => {
  const r = rig()
  await r.clock.advance(300)
  const n = r.sent.length
  for (let i = 0; i < 6; i++) {
    r.stopDevice()
    r.linear(i % 2 ? 0 : 1, 3000)
    await r.clock.advance(3000)
  }
  const speeds = r.sent.slice(n).map(([, v]) => v)
  assert.ok(!speeds.slice(0, -1).includes(0), `no zero in between: ${speeds}`)
  assert.ok(speeds.length <= 3, `${speeds.length} calls for six strokes: ${speeds}`)
})

test('with the grace set to 0 a game stop goes out at once', async () => {
  const r = rig({ stopGraceMs: 0 })
  await r.clock.advance(300)
  r.scalar(0.6)
  await r.clock.advance(600)
  r.stopDevice()
  await r.clock.advance(1)
  assert.equal(r.sent.at(-1)?.[1], 0, 'zero sent in the same instant')
})

test('a lone game stop still reaches the device within 150 ms', async () => {
  for (const how of ['StopDeviceCmd', 'StopAllDevices'] as const) {
    const r = rig()
    await r.clock.advance(300)
    r.scalar(0.6)
    await r.clock.advance(600)
    assert.equal(r.sent.at(-1)?.[1], 60)
    const t0 = r.clock.t
    if (how === 'StopDeviceCmd') r.stopDevice()
    else r.stopAll()
    await r.clock.advance(150)
    assert.equal(r.sent.at(-1)?.[1], 0, `${how}: ${r.sent.map((x) => x.join(':'))}`)
    assert.ok(r.sent.at(-1)![0] - t0 <= 150)
  }
})
