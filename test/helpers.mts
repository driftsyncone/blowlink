import type { Clock } from '../src/core/clock.ts'

// FakeClock runs timers in virtual time; advance() fires them in order and lets
// promise callbacks settle between timers.
export class FakeClock implements Clock {
  t = 0
  private timers: { at: number; fn: () => void; id: number }[] = []
  private nextId = 1

  now(): number {
    return this.t
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++
    this.timers.push({ at: this.t + Math.max(0, ms), fn, id })
    return id
  }

  clearTimeout(id: unknown): void {
    this.timers = this.timers.filter((x) => x.id !== id)
  }

  async advance(ms: number): Promise<void> {
    const end = this.t + ms
    for (;;) {
      await flush()
      const due = this.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0]
      if (!due) break
      this.timers = this.timers.filter((x) => x !== due)
      this.t = due.at
      due.fn()
    }
    this.t = end
    await flush()
  }
}

export const flush = () => new Promise<void>((r) => setImmediate(r))

export const waitFor = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}
