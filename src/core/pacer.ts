// Pacer pushes the latest wanted command to a device: only on change, at most
// once per interval, skipping changes too small to matter. Also re-checks on a
// steady tick so idle timeouts fire. Intermediate values are dropped: only the
// newest one is sent once the interval allows.
import type { Clock } from './clock.ts'

export interface PacerOptions<T> {
  intervalMs: number // minimum time between sends
  // skip(sent, next): true if `next` needn't be sent (unchanged or too small a change)
  skip: (sent: T, next: T) => boolean
}

// Numbers 0-100: skip unchanged values and wobbles under `deadband` (0 → non-zero always sends).
export const numberSkip =
  (deadband: number) =>
  (sent: number, next: number): boolean =>
    next === sent || (next > 0 && sent > 0 && Math.abs(next - sent) < deadband)

export class Pacer<T> {
  private sent: { v: T } | undefined
  private inFlight = false
  private nextAt = 0 // earliest time for the next send
  private pending: unknown // scheduled re-check
  private ticker: unknown
  private stopped = false
  private holdUntil = 0 // a stop the game sent is held back until then (see hold)
  private current: Promise<void> = Promise.resolve() // the send in flight, if any
  private gen = 0 // bumped by reset(), so a send that finishes after it does not overwrite it

  constructor(
    private get: () => T,
    private send: (v: T) => Promise<void>,
    private opts: PacerOptions<T>,
    private clock: Clock,
    private onError: (err: unknown) => void = () => {}
  ) {}

  start(): void {
    const tick = () => {
      if (this.stopped) return
      this.check()
      this.ticker = this.clock.setTimeout(tick, this.opts.intervalMs)
    }
    this.ticker = this.clock.setTimeout(tick, this.opts.intervalMs)
  }

  stop(): void {
    this.stopped = true
    this.clock.clearTimeout(this.ticker)
    this.clock.clearTimeout(this.pending)
  }

  // Forget what was sent, e.g. after the device reconnected.
  reset(): void {
    this.sent = undefined
    this.gen++
  }

  // Hold every send back for ms, so a command that follows a stop right away replaces it
  // instead of the device being told to stop and then to start again.
  hold(ms: number): void {
    this.holdUntil = Math.max(this.holdUntil, this.clock.now() + ms)
    this.check()
  }

  // Resolves when the send in flight (if any) has finished, successfully or not.
  settled(): Promise<void> {
    return this.current
  }

  // Back off before the next send, e.g. after HTTP 429.
  delay(ms: number): void {
    this.nextAt = Math.max(this.nextAt, this.clock.now() + ms)
  }

  wake(): void {
    this.check()
  }

  private check(): void {
    if (this.stopped || this.inFlight) return
    const now = this.clock.now()
    if (now < this.nextAt) {
      this.clock.clearTimeout(this.pending)
      this.pending = this.clock.setTimeout(() => this.check(), this.nextAt - now)
      return
    }
    if (now < this.holdUntil) {
      this.clock.clearTimeout(this.pending)
      this.pending = this.clock.setTimeout(() => this.check(), this.holdUntil - now)
      return
    }
    const v = this.get()
    if (this.sent && this.opts.skip(this.sent.v, v)) return
    this.inFlight = true
    const gen = this.gen
    this.current = this.send(v)
      .then(() => {
        if (gen === this.gen) this.sent = { v }
      })
      .catch((err) => {
        // The request may have reached the device even though it failed here (a timeout after
        // the server acted), so what the device is doing is unknown: the next check must send
        // whatever is wanted, even if that equals the last value that was confirmed.
        this.sent = undefined
        this.onError(err)
      })
      .finally(() => {
        this.inFlight = false
        // keep a longer backoff set by onError (e.g. after HTTP 429)
        this.nextAt = Math.max(this.nextAt, this.clock.now() + this.opts.intervalMs)
        this.clock.clearTimeout(this.pending)
        this.pending = this.clock.setTimeout(() => this.check(), this.nextAt - this.clock.now())
      })
  }
}
