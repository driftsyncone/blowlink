// Time source for everything that schedules. Tests swap in a fake clock so the
// recorded game sessions replay instantly and deterministically.
export interface Clock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

// Monotonic: Date.now() jumps back when the system clock is corrected (NTP, resume from sleep, a
// manual change), and every deadline and backoff here is an absolute time, so a step back of N
// seconds would freeze them for N seconds with a device still running. The values look like Date.now().
const origin = Date.now() - performance.now()

export const realClock: Clock = {
  now: () => origin + performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>)
}
