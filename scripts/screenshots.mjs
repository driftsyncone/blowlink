// Takes the README screenshots: runs the built app (npm run build first) in a dry
// run with demo devices, drives it from a fake game client so the speed bars
// move, and saves docs/screenshots/*.png. Needs a desktop or Chromium's headless
// mode (always used on Linux, so it also runs over SSH). No real device or Autoblow API is used.
//   node scripts/screenshots.mjs
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import electron from 'electron'

const root = fileURLToPath(new URL('..', import.meta.url))
const out = join(root, 'docs', 'screenshots')
const port = 12399

const device = (id, name, type, extra = {}) => ({
  id,
  name,
  type,
  token: 'demo-token-' + id,
  buttplug: true,
  intiface: { enabled: false, name: id },
  maxSpeed: 80,
  ...extra
})

const shots = [
  {
    file: 'main.png',
    config: {
      buttplug: { enabled: true, port },
      devices: [device('vacuglide', 'Autoblow VacuGlide', 'vacuglide'), device('ultra', 'Autoblow AI Ultra', 'autoblow-ultra')]
    },
    game: true
  },
  {
    file: 'intiface.png',
    config: {
      buttplug: { enabled: false, port },
      devices: [device('vacuglide', 'Autoblow VacuGlide', 'vacuglide', { buttplug: false, intiface: { enabled: true, name: 'vacuglide' } })]
    }
  }
]

// A fake game: strokes on the VacuGlide (index 0), a vibrate level on the Ultra (1).
function playGame() {
  let ws
  const connect = () => {
    ws = new WebSocket(`ws://127.0.0.1:${port}`)
    ws.on('error', () => setTimeout(connect, 200))
    ws.on('open', () => {
      let id = 1
      const send = (m) => ws.send(JSON.stringify([m]))
      send({ RequestServerInfo: { Id: id++, ClientName: 'Demo game', MessageVersion: 3 } })
      send({ ScalarCmd: { Id: id++, DeviceIndex: 1, Scalars: [{ Index: 0, Scalar: 0.45, ActuatorType: 'Oscillate' }] } })
      let pos = 1
      setInterval(() => {
        send({ LinearCmd: { Id: id++, DeviceIndex: 0, Vectors: [{ Index: 0, Duration: 300, Position: pos }] } })
        pos = 1 - pos
      }, 300)
    })
  }
  connect()
  return () => ws?.terminate()
}

for (const shot of shots) {
  const data = mkdtempSync(join(tmpdir(), 'blowlink-shot-'))
  writeFileSync(join(data, 'config.json'), JSON.stringify({ dry: true, ...shot.config }))
  const args = process.platform === 'linux' ? ['.', '--ozone-platform=headless'] : ['.']
  const app = spawn(electron, args, {
    cwd: root,
    stdio: 'ignore',
    env: { ...process.env, BLOWLINK_DATA: data, BLOWLINK_SHOT: join(out, shot.file), BLOWLINK_SHOT_DELAY: '5000', BLOWLINK_SHOT_H: '820' }
  })
  const stopGame = shot.game ? playGame() : () => {}
  await new Promise((r) => app.on('exit', r))
  stopGame()
  console.log('saved', join('docs', 'screenshots', shot.file))
}
process.exit(0)
