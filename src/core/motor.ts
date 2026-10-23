// Turns stroke and level commands into one speed (0-100 %), for devices that only
// take a speed (the VacuGlide). Ported from the Go bridge (vacuglide-bridge main.go),
// same behaviour and numbers.
import type { Clock } from './clock.ts'

export interface MotorOptions {
  maxSpeed: number // speed cap in percent
  minSpeed: number // lowest non-zero speed (Autoblow's own app starts at 5)
  mapping: 'velocity' | 'tempo'
  spmLow: number // tempo: device strokes/min at 1 % (VacuGlide 2: 15, VacuGlide 1: 25)
  spmHigh: number // tempo: device strokes/min at 100 % (VacuGlide 2: 225, VacuGlide 1: 200)
  idleMs: number // stop this long after the last stroke run ends
}

export const defaultMotorOptions: MotorOptions = {
  maxSpeed: 100,
  minSpeed: 5,
  mapping: 'velocity',
  spmLow: 15,
  spmHigh: 225,
  idleMs: 1500
}

const clamp01 = (f: number) => Math.max(0, Math.min(1, f))
const rangeWindowMs = 3000

export class Motor {
  private want = 0 // desired speed 0-100
  private lastPos = 0 // last linear target position
  private lastMove: number | undefined // when the last moving stroke arrived
  private rate = 0 // smoothed speed (or stroke rate, tempo) from strokes
  private linear = false // current speed comes from strokes
  private deadline = 0 // linear mode: drop to 0 after this
  private recent: { t: number; pos: number }[] = [] // stroke targets of the last few seconds

  constructor(
    public opts: MotorOptions,
    private clock: Clock,
    private onChange: () => void = () => {}
  ) {}

  // set stores a speed in percent, clamped to min..max (0 stays 0).
  private set(pct: number, linear: boolean, holdMs: number): void {
    let v = 0
    if (pct > 0) {
      v = Math.round(pct)
      v = Math.max(v, this.opts.minSpeed, 1)
      v = Math.min(v, this.opts.maxSpeed)
    }
    this.want = v
    this.linear = linear
    if (linear) this.deadline = this.clock.now() + holdMs
    else {
      this.rate = 0
      this.lastMove = undefined
    }
    this.onChange()
  }

  // level handles vibrate-style levels (0-1), scaled to the cap. Games that drive
  // strokers often send vibrate pulses alongside strokes; while strokes are active
  // those are ignored.
  level(level: number): void {
    if (this.linear && this.clock.now() < this.deadline) return
    this.set(clamp01(level) * this.opts.maxSpeed, false, 0)
  }

  // stroke turns a move (position 0-1 over durMs) into a device speed: from the
  // move's velocity (default) or, with tempo, from the stroke rate. A full stroke
  // is down and back up, i.e. two moves. Example: Cock Hero sends 0 then 1, each
  // lasting half a beat, so 120 BPM = 120 strokes/min (tempo) = 400 units/s = 67 %.
  stroke(pos: number, durMs: number): void {
    pos = clamp01(pos)
    const dist = Math.abs(pos - this.lastPos)
    this.lastPos = pos
    const now = this.clock.now()
    this.recent = this.recent.filter((r) => now - r.t < rangeWindowMs)
    this.recent.push({ t: now, pos })
    if (dist < 0.05) {
      // hold or tiny move: keep the current rate going
      this.linear = true // still blocks vibrate pulses, e.g. on the very first stroke
      this.deadline = now + durMs + this.opts.idleMs
      return
    }
    // Time the move really takes: the stated duration, or the gap since the last
    // move if longer (a quick move followed by a hold until the next beat).
    let secs = Math.max(durMs, 50) / 1000
    const gap = this.lastMove === undefined ? Infinity : (now - this.lastMove) / 1000
    this.lastMove = now
    if (!this.linear || now > this.deadline || gap > 10) {
      // First move of a run: the real pace is unknown until the next move
      // arrives, so just start tracking (avoids a speed spike on quick moves).
      this.linear = true
      this.rate = 0
      this.deadline = now + secs * 1000 + this.opts.idleMs
      return
    }
    if (gap > secs) secs = gap
    let rate: number
    if (this.opts.mapping === 'tempo') {
      // Count strokes, not depth: a shallow stroke on the beat is still a stroke.
      rate = 60 / secs / 2
    } else {
      // Same curve as Autoblow's own funscript player (measured on a VacuGlide 2):
      // speed % = funscript units per second ÷ 6, so 600 units/s and up is 100 %.
      rate = (dist * 100) / secs / 6
    }
    if (this.rate > 0) rate = 0.6 * rate + 0.4 * this.rate // light smoothing
    this.rate = rate

    let pct = rate
    if (this.opts.mapping === 'tempo') {
      pct = 1 + ((rate - this.opts.spmLow) / (this.opts.spmHigh - this.opts.spmLow)) * 99
    }
    this.set(Math.max(pct, 1), true, secs * 1000 + this.opts.idleMs)
  }

  stop(): void {
    this.set(0, false, 0)
  }

  // fromStrokes: the current speed comes from stroke commands (not a level).
  get fromStrokes(): boolean {
    return this.linear
  }

  // target is the position of the latest stroke (0-1).
  get target(): number {
    return this.lastPos
  }

  // range is the lowest and highest stroke target of the last few seconds (0-1).
  range(): [number, number] {
    if (!this.recent.length) return [0, 1]
    const p = this.recent.map((r) => r.pos)
    return [Math.min(...p), Math.max(...p)]
  }

  // current returns the speed to send now, applying the stroke idle timeout.
  current(): number {
    if (this.linear && this.want > 0 && this.clock.now() > this.deadline) this.want = 0
    return this.want
  }
}
