// Autoblow VacuPump (API v1: /vacupump/...). UNTESTED on a device: built from the
// docs at developers.autoblow.com/reference/http-api-v1-vacupump/.
//
// The pump controls vacuum (-60..0 kPa), so:
// - levels (Vibrate/Scalar) hold a vacuum: level × the user's max vacuum (manual mode);
// - strokes run the pump's stroke mode between the max vacuum and 0 kPa, with the
//   stroke speed (10-100 %) from the stroke rate.
// Safety: the default max vacuum is low (20 of 60 kPa), positive pressure is never
// used, and every stop releases the vacuum. Per the docs, manual/stop alone KEEPS
// the vacuum ("closes its valves"), so a stop first holds 0 kPa for a few seconds,
// then turns the pump off.
import type { AutoblowApi } from './autoblow.ts'
import type { Clock } from './clock.ts'
import { CloudDevice, type CloudOptions } from './cloud-device.ts'

export interface VacuPumpOptions extends CloudOptions {
  maxVacuumKpa: number // 5-60, as a positive number
  releaseMs?: number // hold 0 kPa this long before turning the pump off (default 3 s)
}

type Cmd = { kind: 'release' } | { kind: 'off' } | { kind: 'hold'; kpa: number } | { kind: 'stroke'; speedPct: number; vacuumKpa: number }
type Mode = 'unknown' | 'idle' | 'manual' | 'stroke'


export class VacuPump extends CloudDevice<Cmd> {
  readonly type = 'vacupump' as const
  private maxKpa: number
  private mode: Mode = 'unknown'
  private offTimer: unknown
  private offDue = false // the release hold is over: the pump can be turned off (sent through the pacer)
  private driven = false // the pump may have been told to hold or stroke since it was last turned off
  private releaseMs: number

  constructor(id: string, name: string, api: AutoblowApi | null, opts: VacuPumpOptions, clock: Clock) {
    // Levels scale to 100 here; the vacuum cap is applied below.
    super(id, name, api, { ...opts, maxSpeed: 100 }, clock)
    this.maxKpa = clampKpa(opts.maxVacuumKpa)
    this.releaseMs = opts.releaseMs ?? 3000
  }

  override setOptions(opts: Partial<VacuPumpOptions>): void {
    super.setOptions({ ...opts, maxSpeed: 100 })
    if (opts.maxVacuumKpa !== undefined) this.maxKpa = clampKpa(opts.maxVacuumKpa)
  }

  protected command(): Cmd {
    const v = this.motor.current()
    if (v === 0) return this.offDue ? { kind: 'off' } : { kind: 'release' }
    if (this.motor.fromStrokes) return { kind: 'stroke', speedPct: Math.max(10, v), vacuumKpa: this.maxKpa }
    return { kind: 'hold', kpa: Math.round((v / 100) * this.maxKpa * 10) / 10 }
  }

  protected skip(a: Cmd, b: Cmd): boolean {
    if (a.kind !== b.kind) return false
    if (a.kind === 'hold' && b.kind === 'hold') return Math.abs(a.kpa - b.kpa) < 1
    if (a.kind === 'stroke' && b.kind === 'stroke') return Math.abs(a.speedPct - b.speedPct) < 5 && a.vacuumKpa === b.vacuumKpa
    return true
  }

  protected async send(api: AutoblowApi, c: Cmd): Promise<void> {
    this.clock.clearTimeout(this.offTimer)
    if (c.kind === 'off') {
      // The release hold is over. This goes through the pacer like every other command, so it
      // can't overlap a newer one, and a failed attempt is simply tried again.
      await api.put('vacupump', 'manual/stop')
      this.mode = 'idle'
      this.driven = false
      this.offDue = false
      return
    }
    this.offDue = false
    if (c.kind === 'release') {
      if (!this.driven && (this.mode === 'unknown' || this.mode === 'idle')) {
        this.mode = 'idle' // just connected, or nothing was ever sent: don't touch the pump
        return
      }
      // Even a half-finished hold (target sent, start not confirmed) counts as driven.
      if (this.mode === 'stroke') await api.put('vacupump', 'stroke/pause').catch(() => {}) // best effort
      await api.put('vacupump', 'manual/target', { targetVacuumKpa: 0 })
      if (this.mode !== 'manual') await api.put('vacupump', 'manual/start')
      this.mode = 'manual'
      this.offTimer = this.clock.setTimeout(() => {
        this.offDue = true
        this.pacer.wake()
      }, this.releaseMs)
      return
    }
    this.driven = true
    if (c.kind === 'hold') {
      if (this.mode === 'stroke') await api.put('vacupump', 'stroke/pause')
      await api.put('vacupump', 'manual/target', { targetVacuumKpa: -c.kpa })
      if (this.mode !== 'manual') await api.put('vacupump', 'manual/start')
      this.mode = 'manual'
      return
    }
    await api.put('vacupump', 'stroke/config', { vacuumTargetKpa: -c.vacuumKpa, pressureTargetKpa: 0, speedPct: c.speedPct })
    if (this.mode !== 'stroke') await api.put('vacupump', 'stroke/start')
    this.mode = 'stroke'
  }

  protected describe(c: Cmd): string {
    if (c.kind === 'release') return 'release vacuum'
    if (c.kind === 'off') return 'turn the pump off'
    if (c.kind === 'hold') return `hold -${c.kpa} kPa`
    return `stroke ${c.speedPct}% between -${c.vacuumKpa} and 0 kPa`
  }

  protected output(c: Cmd): number {
    if (c.kind === 'release' || c.kind === 'off') return 0
    if (c.kind === 'hold') return Math.round((c.kpa / this.maxKpa) * 100)
    return c.speedPct
  }

  protected stopCommand(): Cmd {
    return { kind: 'release' }
  }

  // close waits for the release, then turns the pump off.
  override async close(): Promise<void> {
    await super.close()
    if (this.api?.host && (this.mode === 'manual' || this.driven)) {
      this.clock.clearTimeout(this.offTimer)
      await new Promise((r) => this.clock.setTimeout(() => r(undefined), this.releaseMs))
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await this.api.put('vacupump', 'manual/stop')
          return
        } catch {
          await new Promise((r) => this.clock.setTimeout(() => r(undefined), 1000))
        }
      }
      this.log('could not turn the pump off after releasing the vacuum; check the device')
    }
  }

  // Every stop releases the vacuum at once, whatever the stop grace setting says.
  stopSoon(): void {
    this.stop()
  }

  buttplugMessages(ver: number): unknown {
    if (ver >= 3)
      return {
        ScalarCmd: [{ FeatureDescriptor: 'Vacuum', StepCount: 100, ActuatorType: 'Constrict' }],
        LinearCmd: [{ FeatureDescriptor: 'Pump strokes', StepCount: 100, ActuatorType: 'Position' }],
        StopDeviceCmd: {}
      }
    if (ver === 2)
      return {
        VibrateCmd: { FeatureCount: 1, StepCount: [100] },
        LinearCmd: { FeatureCount: 1, StepCount: [100] },
        StopDeviceCmd: {}
      }
    if (ver === 1) return { VibrateCmd: { FeatureCount: 1 }, LinearCmd: { FeatureCount: 1 }, StopDeviceCmd: {} }
    return ['SingleMotorVibrateCmd', 'StopDeviceCmd']
  }
}

function clampKpa(k: number): number {
  if (typeof k !== 'number' || !Number.isFinite(k)) return 20 // the default cap
  return Math.min(60, Math.max(5, Math.round(k)))
}
