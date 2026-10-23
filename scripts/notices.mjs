// Writes out/THIRD_PARTY_NOTICES.txt: the license text of every library shipped in the app.
// Electron and Chromium ship their own (LICENSE.electron.txt, LICENSES.chromium.html).
// Run as part of `npm run build`; fails if a shipped package has no license file.
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// react/react-dom/scheduler are bundled into the window; ws ships as a dependency.
const SHIPPED = ['react', 'react-dom', 'scheduler', 'ws']

const root = fileURLToPath(new URL('..', import.meta.url))
const parts = [
  'BlowLink includes the following third-party software.',
  'BlowLink itself is licensed under CC BY-NC-SA 4.0 (see LICENSE).',
  "It talks to Autoblow's public device API (https://developers.autoblow.com/); no Autoblow code is included.",
  ''
]

for (const name of SHIPPED) {
  const dir = join(root, 'node_modules', name)
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f))
  if (!file) throw new Error(`no license file for ${name}`)
  parts.push('='.repeat(78), `${name} ${pkg.version}  (${pkg.license})`, pkg.homepage ?? '', '-'.repeat(78), readFileSync(join(dir, file), 'utf8').trim(), '')
}

mkdirSync(join(root, 'out'), { recursive: true })
writeFileSync(join(root, 'out', 'THIRD_PARTY_NOTICES.txt'), parts.join('\n'))
console.log(`notices: ${SHIPPED.length} packages → out/THIRD_PARTY_NOTICES.txt`)
