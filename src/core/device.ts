// What every Autoblow device offers to the inputs (Buttplug server, Intiface link).
// Inputs translate their protocol into these three calls.
import { EventEmitter } from 'node:events'
import type { DeviceType } from './autoblow.ts'

export interface DeviceStatus {
  online: boolean
  connecting?: boolean // a connect attempt is running
  error?: string // last error, cleared once a command goes through
  output: number // current output level 0-100 (speed, or vacuum share for the pump)
}

export interface DeviceEvents {
  status: [DeviceStatus]
  log: [string]
}

export abstract class Device extends EventEmitter<DeviceEvents> {
  abstract readonly type: DeviceType
  status: DeviceStatus = { online: false, output: 0 }
  verbose = false // log every command sent to the device

  constructor(
    public readonly id: string,
    public name: string
  ) {
    super()
  }

  // A move to position 0-1 over durMs (Buttplug LinearCmd, TCode L0).
  abstract stroke(pos: number, durMs: number): void
  // A level 0-1 (Buttplug Vibrate/Scalar/Rotate/Oscillate).
  abstract level(level: number): void
  abstract stop(): void
  // Buttplug DeviceMessages block for a protocol version (fake server).
  abstract buttplugMessages(ver: number): unknown
  abstract start(): void
  // One attempt to reach the device (also what the Connect button does).
  abstract connect(): Promise<void>
  // Stop the device and wait until the stop reached it.
  abstract close(): Promise<void>

  protected setStatus(patch: Partial<DeviceStatus>): void {
    const next = { ...this.status, ...patch }
    if (JSON.stringify(next) === JSON.stringify(this.status)) return
    this.status = next
    this.emit('status', next)
  }

  protected log(msg: string): void {
    this.emit('log', `${this.name}: ${msg}`)
  }
}
