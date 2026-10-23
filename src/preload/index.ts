import { contextBridge, ipcRenderer } from 'electron'
import type { Channel } from '../shared/api.ts'

const channels: Channel[] = ['state', 'log', 'config', 'update']

contextBridge.exposeInMainWorld('blowlink', {
  call: (method: string, ...args: unknown[]) => ipcRenderer.invoke('blowlink', method, ...args),
  on: (channel: Channel, cb: (payload: unknown) => void) => {
    if (!channels.includes(channel)) throw new Error(`bad channel ${channel}`)
    const h = (_: unknown, payload: unknown): void => cb(payload)
    ipcRenderer.on(channel, h)
    return () => ipcRenderer.removeListener(channel, h)
  },
  platform: process.platform
})
