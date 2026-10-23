// Autoblow VacuGlide 1/2. The API has no position control, only a target speed
// (0-100 %), so strokes and levels both become a speed (see motor.ts).
import type { AutoblowApi } from './autoblow.ts'
import { CloudDevice } from './cloud-device.ts'
import { numberSkip } from './pacer.ts'

export class VacuGlide extends CloudDevice<number> {
  readonly type = 'vacuglide' as const

  protected command(): number {
    return this.motor.current()
  }

  protected skip = numberSkip(5) // stroke timing jitters a little; save API calls

  protected async send(api: AutoblowApi, v: number): Promise<void> {
    if (v === 0) await api.put('vacuglide', 'target-speed/stop')
    else await api.put('vacuglide', 'target-speed', { targetSpeed: v })
  }

  protected describe(v: number): string {
    return `speed ${v}%`
  }

  protected output(v: number): number {
    return v
  }

  protected stopCommand(): number {
    return 0
  }

  buttplugMessages(ver: number): unknown {
    if (ver >= 3)
      return {
        ScalarCmd: [{ FeatureDescriptor: 'Speed', StepCount: 100, ActuatorType: 'Vibrate' }],
        LinearCmd: [{ FeatureDescriptor: 'Stroke', StepCount: 100, ActuatorType: 'Position' }],
        StopDeviceCmd: {}
      }
    if (ver === 2)
      return {
        VibrateCmd: { FeatureCount: 1, StepCount: [100] },
        LinearCmd: { FeatureCount: 1, StepCount: [100] },
        StopDeviceCmd: {}
      }
    if (ver === 1)
      return {
        VibrateCmd: { FeatureCount: 1 },
        LinearCmd: { FeatureCount: 1 },
        SingleMotorVibrateCmd: {},
        StopDeviceCmd: {}
      }
    return ['SingleMotorVibrateCmd', 'StopDeviceCmd']
  }
}
