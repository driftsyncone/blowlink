// Pure helpers for the updater: which release file this install can update
// itself from, and the expected hash from SHA256SUMS.txt. No Electron here, so
// the tests can import it.

export const releasesPage = 'https://github.com/driftsyncone/blowlink/releases'
export const downloadPrefix = releasesPage + '/download/'

export interface Asset {
  name: string
  url: string
}

// How this copy was installed. Only the Windows installer and the AppImage can
// replace themselves; deb, tar.gz, the Windows zip and macOS stay notify-only.
export type InstallKind = 'nsis' | 'appimage' | null

// pickAsset: the release file for this kind of install, or null.
export function pickAsset(assets: Asset[], kind: InstallKind, version: string): Asset | null {
  const v = version.replace(/^v/, '')
  const ok = (a: Asset) => a.url.startsWith(downloadPrefix)
  if (kind === 'nsis') return assets.find((a) => ok(a) && a.name === `BlowLink-Setup-${v}.exe`) ?? null
  if (kind === 'appimage') {
    // electron-builder names the x64 AppImage x86_64.
    const arch = process.arch === 'arm64' ? /-(arm64|aarch64)\.AppImage$/ : /-(x64|x86_64)\.AppImage$/
    return assets.find((a) => ok(a) && a.name.startsWith(`BlowLink-${v}-linux-`) && arch.test(a.name)) ?? null
  }
  return null
}

// expectedHash: the sha256 listed for name in a `sha256sum` output, lowercased.
export function expectedHash(sums: string, name: string): string | null {
  for (const line of sums.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64}) [ *]?(.+)$/.exec(line.trim())
    if (m && m[2] === name) return m[1].toLowerCase()
  }
  return null
}
