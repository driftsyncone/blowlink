// Update check against GitHub releases (once a day, or on "Check now"). Where
// this install can replace itself (Windows installer, AppImage), the new
// version is downloaded only when the user asks, checked against the release's
// SHA256SUMS.txt, and installed with a restart. Everything else links to the
// release page.
import { app, net } from 'electron'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { chmod, mkdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import type { ReadableStream } from 'node:stream/web'
import { newer } from '../shared/version.ts'
import { downloadPrefix, expectedHash, pickAsset, releasesPage, type Asset, type InstallKind } from '../shared/release.ts'

const latestApi = 'https://api.github.com/repos/driftsyncone/blowlink/releases/latest'
const headers = { 'User-Agent': 'BlowLink' }

export interface UpdateInfo {
  version: string
  url: string // release page
  asset: Asset | null // set when this install can update itself
  sums: Asset | null
}

export function installKind(): InstallKind {
  if (!app.isPackaged) return null
  if (process.platform === 'linux' && process.env.APPIMAGE) return 'appimage'
  // The per-user installer leaves its uninstaller next to the exe; the zip doesn't.
  if (process.platform === 'win32' && existsSync(join(dirname(process.execPath), 'Uninstall BlowLink.exe'))) return 'nsis'
  return null
}

export async function checkForUpdate(): Promise<UpdateInfo | null> {
  const resp = await net.fetch(latestApi, { headers: { ...headers, Accept: 'application/vnd.github+json' } })
  if (!resp.ok) throw new Error(`GitHub answered ${resp.status}`)
  const r = (await resp.json()) as {
    tag_name?: string
    html_url?: string
    prerelease?: boolean
    draft?: boolean
    assets?: { name: string; browser_download_url: string }[]
  }
  if (!r.tag_name || r.draft || r.prerelease || !newer(r.tag_name, app.getVersion())) return null
  // Only ever link to this project's own release pages.
  const url = r.html_url?.startsWith(releasesPage + '/') ? r.html_url : releasesPage
  const assets = (r.assets ?? []).map((a) => ({ name: a.name, url: a.browser_download_url }))
  const sums = assets.find((a) => a.name === 'SHA256SUMS.txt' && a.url.startsWith(downloadPrefix)) ?? null
  const asset = sums ? pickAsset(assets, installKind(), r.tag_name) : null
  return { version: r.tag_name.replace(/^v/, ''), url, asset, sums }
}

// download: fetch the update into the updates folder (the AppImage's own folder
// for an AppImage, so the final rename stays on one disk) and check its hash.
export async function download(u: UpdateInfo, progress: (pct: number) => void): Promise<string> {
  if (!u.asset || !u.sums) throw new Error('no installable file in this release')
  const sumsResp = await net.fetch(u.sums.url, { headers })
  if (!sumsResp.ok) throw new Error(`SHA256SUMS.txt: GitHub answered ${sumsResp.status}`)
  const want = expectedHash(await sumsResp.text(), u.asset.name)
  if (!want) throw new Error(`${u.asset.name} is not listed in SHA256SUMS.txt`)

  const dir = installKind() === 'appimage' ? dirname(process.env.APPIMAGE!) : join(app.getPath('userData'), 'updates')
  await mkdir(dir, { recursive: true })
  const file = join(dir, installKind() === 'appimage' ? `.${u.asset.name}.download` : u.asset.name)
  const resp = await net.fetch(u.asset.url, { headers })
  if (!resp.ok || !resp.body) throw new Error(`download: GitHub answered ${resp.status}`)
  const total = Number(resp.headers.get('content-length')) || 0
  const hash = createHash('sha256')
  const out = createWriteStream(file)
  let got = 0
  let shown = -1
  try {
    for await (const chunk of Readable.fromWeb(resp.body as ReadableStream<Uint8Array>)) {
      hash.update(chunk)
      got += chunk.length
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r))
      const pct = total ? Math.floor((got / total) * 100) : 0
      if (pct !== shown) progress((shown = pct))
    }
    await new Promise<void>((res, rej) => out.end((e?: Error | null) => (e ? rej(e) : res())))
  } catch (e) {
    out.destroy()
    await rm(file, { force: true })
    throw e
  }
  if (hash.digest('hex') !== want) {
    await rm(file, { force: true })
    throw new Error('the download does not match SHA256SUMS.txt; nothing was installed')
  }
  return file
}

// install: hand over to the new version. The caller has already stopped the
// devices and quits right after this returns.
export async function install(file: string): Promise<void> {
  if (installKind() === 'appimage') {
    const target = process.env.APPIMAGE!
    await chmod(file, 0o755)
    await rename(file, target) // the running copy keeps its open inode
    app.relaunch({ execPath: target, args: [] })
    return
  }
  // Silent per-user install; --force-run starts BlowLink again when it's done.
  spawn(file, ['--updated', '/S', '--force-run'], { detached: true, stdio: 'ignore' }).unref()
}
