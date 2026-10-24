// Print the CHANGELOG.md section for one version (the release notes). Exits 1 if there isn't one.
// Usage: node scripts/changelog.mjs 0.3.3
import { readFileSync } from 'node:fs'

const version = (process.argv[2] ?? '').replace(/^v/, '')
const text = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
const lines = text.split(/\r?\n/)
// Dev builds (x.y.z-dev.n) use the x.y.z section, else "## Unreleased".
const heads = [version, ...(version.includes('-') ? [version.split('-')[0], 'Unreleased'] : [])]
let start = -1
for (const h of heads) if (start < 0) start = lines.findIndex((l) => l.trim() === `## ${h}`)
if (!version || start < 0) {
  console.error(`CHANGELOG.md has no "## ${version}" section`)
  process.exit(1)
}
const rest = lines.slice(start + 1)
const end = rest.findIndex((l) => /^## /.test(l))
const body = (end < 0 ? rest : rest.slice(0, end)).join('\n').trim()
if (!body) {
  console.error(`CHANGELOG.md section "## ${version}" is empty`)
  process.exit(1)
}
console.log(body)
