// Typed access to the preload bridge.
import type { Api, Channel } from '../../shared/api.ts'

interface Exposed {
  call(method: string, ...args: unknown[]): Promise<unknown>
  on(channel: Channel, cb: (payload: unknown) => void): () => void
  platform: string
}

const exposed = (window as unknown as { blowlink: Exposed }).blowlink

export const api = new Proxy({} as Api, {
  get: (_, method: string) => (...args: unknown[]) => exposed.call(method, ...args)
})

export const on = exposed.on
