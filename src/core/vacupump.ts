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

type Cmd = { kind: 'release' } | { kind: 'hold'; kpa: number } | { kind: 'stroke'; speedPct: number; vacuumKpa: number }
type Mode = 'unknown' | 'idle' | 'manual' | 'stroke'


export class VacuPump extends CloudDevice<Cmd> {
  readonly type = 'vacupump' as const
  private maxKpa: number
  private mode: Mode = 'unknown'
  private offTimer: unknown
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
    if (v === 0) return { kind: 'release' }
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
    if (c.kind === 'release') {
      if (this.mode === 'unknown') {
        await api.discover('vacupump') // startup: just check it's online, don't touch the pump
        this.mode = 'idle'
        return
      }
      if (this.mode === 'idle') return
      if (this.mode === 'stroke') await api.put('vacupump', 'stroke/pause')
      await api.put('vacupump', 'manual/target', { targetVacuumKpa: 0 })
      if (this.mode !== 'manual') await api.put('vacupump', 'manual/start')
      this.mode = 'manual'
      this.offTimer = this.clock.setTimeout(() => {
        api.put('vacupump', 'manual/stop').then(
          () => (this.mode = 'idle'),
          () => {} // stays at 0 kPa; the next command takes over
        )
      }, this.releaseMs)
      return
    }
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
    if (c.kind === 'hold') return `hold -${c.kpa} kPa`
    return `stroke ${c.speedPct}% between -${c.vacuumKpa} and 0 kPa`
  }

  protected output(c: Cmd): number {
    if (c.kind === 'release') return 0
    if (c.kind === 'hold') return Math.round((c.kpa / this.maxKpa) * 100)
    return c.speedPct
  }

  protected stopCommand(): Cmd {
    return { kind: 'release' }
  }

  // close waits for the release, then turns the pump off.
  override async close(): Promise<void> {
    await super.close()
    if (this.api?.host && this.mode === 'manual') {
      this.clock.clearTimeout(this.offTimer)
      await new Promise((r) => this.clock.setTimeout(() => r(undefined), this.releaseMs))
      await this.api.put('vacupump', 'manual/stop').catch(() => {})
    }
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
  return Math.min(60, Math.max(5, Math.round(k)))
}
