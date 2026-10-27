// The app edits its config in place; the bridge must still notice what changed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Bridge } from '../src/core/bridge.ts'
import { defaultConfig, newDevice } from '../src/core/config.ts'

test('applyOptions: in-place edits are seen; speed and logging apply live, structure restarts', async () => {
  const cfg = { ...defaultConfig(), dry: true, buttplug: { enabled: false, host: '127.0.0.1', port: 0, allowedOrigins: [] } }
  cfg.devices.push(newDevice('vacuglide', 'tok'))
  const bridge = new Bridge(cfg)
  await bridge.start()

  cfg.devices[0].maxSpeed = 40
  assert.equal(bridge.applyOptions(structuredClone(cfg)), true, 'speed cap applies live')

  cfg.verbose = true
  const logs: string[] = []
  bridge.on('log', (l) => logs.push(l))
  assert.equal(bridge.applyOptions(structuredClone(cfg)), true, 'logging applies live')
  assert.ok(logs.includes('logging game messages'))

  cfg.devices.push(newDevice('vacuglide', 'tok2', ['vacuglide']))
  assert.equal(bridge.applyOptions(structuredClone(cfg)), false, 'a new device needs a restart')
  await bridge.close()
})

test('applyOptions: switching Intiface mode on/off is live (apps stay connected)', async () => {
  const cfg = { ...defaultConfig(), dry: true, buttplug: { enabled: false, host: '127.0.0.1', port: 0, allowedOrigins: [] }, intiface: { url: 'ws://127.0.0.1:1' } }
  cfg.devices.push(newDevice('vacuglide', 'tok'))
  const bridge = new Bridge(cfg)
  await bridge.start()
  assert.equal(bridge.state().devices[0].intiface, undefined)

  cfg.devices[0].intiface = { enabled: true, name: 'vacuglide' }
  assert.equal(bridge.applyOptions(structuredClone(cfg)), true, 'turning it on needs no restart')
  assert.equal(bridge.state().devices[0].intiface, false, 'link exists (not connected: nothing listens)')

  cfg.devices[0].intiface = { enabled: true, name: 'other' }
  assert.equal(bridge.applyOptions(structuredClone(cfg)), true, 'renaming needs no restart')

  cfg.devices[0].intiface = { enabled: false, name: 'other' }
  assert.equal(bridge.applyOptions(structuredClone(cfg)), true, 'turning it off needs no restart')
  assert.equal(bridge.state().devices[0].intiface, undefined)

  cfg.buttplug = { ...cfg.buttplug, port: 1 }
  assert.equal(bridge.applyOptions(structuredClone(cfg)), false, 'the Buttplug port still restarts')
  await bridge.close()
})
