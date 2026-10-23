// Autoblow AI Ultra (API v1: /autoblow/...). UNTESTED on a device: built from the
// docs at developers.autoblow.com/reference/http-api-v1-autoblow/.
//
// Two motion styles:
// - oscillate (default): the stroke tempo becomes the oscillation speed and the
//   recent stroke range becomes minY..maxY; one call per change, so cloud lag
//   doesn't matter. Follows rhythm, not each individual move.
// - goto: every move becomes a go-to (position + speed). Follows varied motion
//   more closely, but each move is a cloud round trip (~100-300 ms late).
// Speed uses the same curve as the VacuGlide (units/s ÷ 6); the Ultra's real
// scale is unknown until someone measures it.
import type { AutoblowApi } from './autoblow.ts'
import type { Clock } from './clock.ts'
import { CloudDevice, type CloudOptions } from './cloud-device.ts'

export type UltraMotion = 'oscillate' | 'goto'

export interface UltraOptions extends CloudOptions {
  motion: UltraMotion
}

type Cmd =
  | { kind: 'stop' }
  | { kind: 'oscillate'; speed: number; minY: number; maxY: number }
  | { kind: 'goto'; position: number; speed: number }

const minSpan = 10 // the API wants maxY - minY >= 10

export class Ultra extends CloudDevice<Cmd> {
  readonly type = 'autoblow-ultra' as const
  private motion: UltraMotion

  constructor(id: string, name: string, api: AutoblowApi | null, opts: UltraOptions, clock: Clock) {
    super(id, name, api, opts, clock)
    this.motion = opts.motion
  }

  override setOptions(opts: Partial<UltraOptions>): void {
    super.setOptions(opts)
    if (opts.motion) this.motion = opts.motion
  }

  protected command(): Cmd {
    const speed = this.motor.current()
    if (speed === 0) return { kind: 'stop' }
    if (!this.motor.fromStrokes) return { kind: 'oscillate', speed, minY: 0, maxY: 100 }
    if (this.motion === 'goto') return { kind: 'goto', position: Math.round(this.motor.target * 100), speed }
    let [lo, hi] = this.motor.range().map((p) => Math.round(p * 100))
    if (hi - lo < minSpan) {
      const mid = Math.min(Math.max((lo + hi) / 2, minSpan / 2), 100 - minSpan / 2)
      lo = Math.round(mid - minSpan / 2)
      hi = lo + minSpan
    }
    return { kind: 'oscillate', speed, minY: lo, maxY: hi }
  }

  protected skip(a: Cmd, b: Cmd): boolean {
    if (a.kind !== b.kind) return false
    if (a.kind === 'oscillate' && b.kind === 'oscillate')
      return Math.abs(a.speed - b.speed) < 5 && Math.abs(a.minY - b.minY) < 5 && Math.abs(a.maxY - b.maxY) < 5
    if (a.kind === 'goto' && b.kind === 'goto') return a.position === b.position && Math.abs(a.speed - b.speed) < 5
    return true // stop after stop
  }

  protected async send(api: AutoblowApi, c: Cmd): Promise<void> {
    if (c.kind === 'stop') await api.put('autoblow-ultra', 'oscillate/stop')
    else if (c.kind === 'oscillate') await api.put('autoblow-ultra', 'oscillate', { speed: c.speed, minY: c.minY, maxY: c.maxY })
    else await api.put('autoblow-ultra', 'goto', { position: c.position, speed: c.speed })
  }

  protected describe(c: Cmd): string {
    if (c.kind === 'stop') return 'stop'
    if (c.kind === 'oscillate') return `oscillate ${c.speed}% between ${c.minY} and ${c.maxY}`
    return `go to ${c.position} at ${c.speed}%`
  }

  protected output(c: Cmd): number {
    return c.kind === 'stop' ? 0 : c.speed
  }

  protected stopCommand(): Cmd {
    return { kind: 'stop' }
  }

  buttplugMessages(ver: number): unknown {
    if (ver >= 3)
      return {
        ScalarCmd: [{ FeatureDescriptor: 'Speed', StepCount: 100, ActuatorType: 'Oscillate' }],
        LinearCmd: [{ FeatureDescriptor: 'Stroke', StepCount: 100, ActuatorType: 'Position' }],
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
