// Shared plumbing for the Autoblow devices: a Motor turns strokes/levels into a
// level, the subclass turns that into a device command, and a Pacer sends it
// through the cloud API with backoff and rediscovery.
import { ApiError, type AutoblowApi, type DeviceType } from './autoblow.ts'
import type { Clock } from './clock.ts'
import { Device } from './device.ts'
import { Motor, type MotorOptions } from './motor.ts'
import { Pacer } from './pacer.ts'

export interface CloudOptions extends MotorOptions {
  intervalMs: number // minimum time between API calls
}

export abstract class CloudDevice<Cmd> extends Device {
  protected motor: Motor
  protected pacer: Pacer<Cmd>
  private lastErrLog = 0

  // api null = dry run: log commands instead of calling the API.
  constructor(
    id: string,
    name: string,
    protected api: AutoblowApi | null,
    opts: CloudOptions,
    protected clock: Clock
  ) {
    super(id, name)
    this.motor = new Motor(opts, clock, () => this.pacer?.wake())
    this.pacer = new Pacer<Cmd>(
      () => this.command(),
      (c) => this.dispatch(c),
      { intervalMs: opts.intervalMs, skip: (a, b) => this.skip(a, b) },
      clock,
      (err) => this.failed(err)
    )
  }

  abstract readonly type: DeviceType
  // command is what the device should be doing right now.
  protected abstract command(): Cmd
  // skip: true if `next` needn't be sent after `sent`.
  protected abstract skip(sent: Cmd, next: Cmd): boolean
  // send performs a command on the device (api is set).
  protected abstract send(api: AutoblowApi, c: Cmd): Promise<void>
  protected abstract describe(c: Cmd): string
  // output level 0-100 for the UI
  protected abstract output(c: Cmd): number
  // stopCommand is sent on close.
  protected abstract stopCommand(): Cmd

  setOptions(opts: Partial<CloudOptions>): void {
    this.motor.opts = { ...this.motor.opts, ...opts }
  }

  start(): void {
    this.pacer.start()
  }

  stroke(pos: number, durMs: number): void {
    this.motor.stroke(pos, durMs)
  }

  level(level: number): void {
    this.motor.level(level)
  }

  stop(): void {
    this.motor.stop()
  }

  async close(): Promise<void> {
    this.pacer.stop()
    this.motor.stop()
    if (this.api?.host) await this.dispatch(this.stopCommand()).catch(() => {})
  }

  private async dispatch(c: Cmd): Promise<void> {
    if (!this.api) {
      this.log(this.describe(c))
      this.setStatus({ online: true, output: this.output(c) })
      return
    }
    const wasOnline = this.api.host !== ''
    await this.send(this.api, c)
    if (!wasOnline) this.log(`connected via ${this.api.host}`)
    this.setStatus({ online: true, error: undefined, output: this.output(c) })
  }

  private failed(err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err)
    if (err instanceof ApiError && err.status === 429) this.pacer.delay(1000)
    else if (!this.api?.host) this.pacer.delay(2000) // offline: retry discovery every 2 s
    this.setStatus({ online: !!this.api?.host, error: msg })
    const now = this.clock.now()
    if (now - this.lastErrLog > 10_000) {
      this.log(msg)
      this.lastErrLog = now
    }
  }
}
