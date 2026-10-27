import { test } from 'node:test'
import assert from 'node:assert/strict'
import { downloadPrefix, expectedHash, pickAsset } from '../src/shared/release.ts'

const assets = [
  'BlowLink-Portable-0.2.0.exe',
  'BlowLink-Setup-0.2.0.exe',
  'BlowLink-0.2.0-win-x64.zip',
  'BlowLink-0.2.0-linux-x86_64.AppImage',
  'blowlink_0.2.0_amd64.deb',
  'SHA256SUMS.txt'
].map((name) => ({ name, url: `${downloadPrefix}v0.2.0/${name}` }))

test('update file: installer on Windows, AppImage on Linux, nothing elsewhere', () => {
  assert.equal(pickAsset(assets, 'nsis', 'v0.2.0')?.name, 'BlowLink-Setup-0.2.0.exe')
  if (process.arch === 'x64') assert.equal(pickAsset(assets, 'appimage', 'v0.2.0')?.name, 'BlowLink-0.2.0-linux-x86_64.AppImage')
  assert.equal(pickAsset(assets, null, 'v0.2.0'), null)
  assert.ok(!['nsis', 'appimage'].some((k) => pickAsset(assets, k as 'nsis', 'v0.2.0')?.name.includes('Portable')), 'the portable exe is never the update file')
  assert.equal(pickAsset(assets, 'nsis', 'v0.3.0'), null) // tag and file must agree
})

test('update file must come from our own release downloads', () => {
  const evil = [{ name: 'BlowLink-Setup-0.2.0.exe', url: 'https://example.com/BlowLink-Setup-0.2.0.exe' }]
  assert.equal(pickAsset(evil, 'nsis', '0.2.0'), null)
})

test('SHA256SUMS.txt lookup', () => {
  const h = 'a'.repeat(64)
  const sums = `${'b'.repeat(64)}  BlowLink-0.2.0-win-x64.zip\n${h.toUpperCase()} *BlowLink-Setup-0.2.0.exe\r\n`
  assert.equal(expectedHash(sums, 'BlowLink-Setup-0.2.0.exe'), h)
  assert.equal(expectedHash(sums, 'BlowLink-Setup-0.2.exe'), null)
})
