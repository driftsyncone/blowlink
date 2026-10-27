// Shared plumbing for the Autoblow devices: a Motor turns strokes/levels into a
// level, the subclass turns that into a device command, and a Pacer sends it
// through the cloud API.
//
// Connecting is deliberate, not automatic: one attempt when the device starts and
// one each time the user presses Connect. A device that is offline or drops off
// (HTTP 502) stays offline until then, so an offline device doesn't run into
// Autoblow's rate limit.
import { ApiError, type AutoblowApi, type DeviceType } from './autoblow.ts'
import type { Clock } from './clock.ts'
import { Device } from './device.ts'
import { Motor, type MotorOptions } from './motor.ts'
import { Pacer } from './pacer.ts'

export const defaultStopGraceMs = 120

export interface CloudOptions extends MotorOptions {
  intervalMs: number // minimum time between API calls
  // How long a stop the game sent may wait for the command that follows it (0 = send it at once;
  // default 120 ms). See Device.stopSoon.
  stopGraceMs?: number
}

export abstract class CloudDevice<Cmd> extends Device {
  protected motor: Motor
  protected pacer: Pacer<Cmd>
  private lastErrLog = 0
  private connecting = false
  private closed = false
  private failures = 0 // consecutive failed commands (not counting 429)
  protected stopGraceMs: number

  // api null = dry run: log commands instead of calling the API.
  constructor(
    id: string,
    name: string,
    protected api: AutoblowApi | null,
    opts: CloudOptions,
    protected clock: Clock
  ) {
    super(id, name)
    this.stopGraceMs = opts.stopGraceMs ?? defaultStopGraceMs
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
    void this.connect()
  }

  // connect makes one discovery attempt. No automatic retries.
  async connect(): Promise<void> {
    if (!this.api) {
      this.setStatus({ online: true, connecting: false })
      return
    }
    if (this.connecting || this.closed) return
    this.connecting = true
    this.setStatus({ connecting: true, error: undefined })
    try {
      await this.api.discover(this.type)
      if (this.closed) return // closed meanwhile (settings change restarted the bridge)
      this.failures = 0
      this.log(`connected via ${this.api.host}`)
      this.setStatus({ online: true, connecting: false, error: undefined })
      this.pacer.reset() // send whatever is wanted now
      this.pacer.wake()
    } catch (e) {
      this.api.host = ''
      const msg = e instanceof Error ? e.message : String(e)
      this.log(`not connected (${msg}); press Connect to try again`)
      this.setStatus({ online: false, connecting: false, error: msg })
    } finally {
      this.connecting = false
    }
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

  // With a grace period (the default), the state goes to zero now but the device is only told once
  // the grace is over, so a move that follows straight away replaces the stop. Without one, this
  // is stop().
  stopSoon(): void {
    if (this.stopGraceMs <= 0) return this.stop()
    this.motor.stop(false)
    this.pacer.hold(this.stopGraceMs)
  }

  async close(): Promise<void> {
    this.closed = true
    this.pacer.stop()
    this.motor.stop()
    await this.pacer.settled() // a speed request still in flight must not land after the stop
    if (!this.api?.host) return
    // The stop is the one command that must arrive: try again through rate limits and blips.
    let lastErr = ''
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await this.dispatch(this.stopCommand())
        return
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e)
        const s = /retry in (\d+) second/i.exec(lastErr)
        const waitMs = s ? Math.min(Number(s[1]), 5) * 1000 : 500 * (attempt + 1)
        await new Promise((r) => this.clock.setTimeout(() => r(undefined), waitMs))
      }
    }
    this.log(`could not confirm that the device stopped (${lastErr}); check the device`)
  }

  private async dispatch(c: Cmd): Promise<void> {
    if (!this.api) {
      this.log(this.describe(c))
      this.setStatus({ online: true, output: this.output(c) })
      return
    }
    if (!this.api.host) return // offline: nothing is sent until the user connects
    if (this.verbose) this.log(`-> ${this.describe(c)}`)
    await this.send(this.api, c)
    this.failures = 0
    this.setStatus({ online: true, error: undefined, output: this.output(c) })
  }

  private failed(err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err)
    if (err instanceof ApiError && err.status === 429) {
      // Autoblow says how long to wait: "Rate limit exceeded, retry in 4 seconds".
      const s = /retry in (\d+) second/i.exec(msg)
      this.pacer.delay(s ? Number(s[1]) * 1000 : 5000)
    } else if (err instanceof ApiError && (err.status === 401 || err.status === 403) && this.api) {
      this.api.host = '' // the token is wrong: retrying only hammers the API
    } else if (this.api?.host && ++this.failures >= 3) {
      this.api.host = '' // keeps failing (network?): give up until the user connects
    } else if (this.api?.host) {
      this.pacer.delay(2000 * this.failures)
    }
    if (this.api && !this.api.host) {
      // 502 (device dropped off) clears host too
      this.log(`went offline (${msg}); press Connect to try again`)
      this.setStatus({ online: false, error: msg })
      return
    }
    this.setStatus({ error: msg })
    const now = this.clock.now()
    if (now - this.lastErrLog > 10_000) {
      this.log(msg)
      this.lastErrLog = now
    }
  }
}
