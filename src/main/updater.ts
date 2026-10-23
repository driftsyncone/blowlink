// Notify-only update check: once a day, ask GitHub for the latest release and,
// if it's newer, tell the window and the tray. Nothing is downloaded or run.
import { app, net } from 'electron'
import { newer } from '../shared/version.ts'

export const releasesPage = 'https://github.com/driftsyncone/blowlink/releases'
const latestApi = 'https://api.github.com/repos/driftsyncone/blowlink/releases/latest'

export interface UpdateInfo {
  version: string
  url: string
}


export async function checkForUpdate(): Promise<UpdateInfo | null> {
  const resp = await net.fetch(latestApi, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'BlowLink' } })
  if (!resp.ok) throw new Error(`GitHub answered ${resp.status}`)
  const r = (await resp.json()) as { tag_name?: string; html_url?: string; prerelease?: boolean; draft?: boolean }
  if (!r.tag_name || r.draft || r.prerelease || !newer(r.tag_name, app.getVersion())) return null
  // Only ever link to this project's own release pages.
  const url = r.html_url?.startsWith(releasesPage + '/') ? r.html_url : releasesPage
  return { version: r.tag_name.replace(/^v/, ''), url }
}
