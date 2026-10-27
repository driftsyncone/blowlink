// Start BlowLink (hidden in the tray) when the user logs in.
// Windows/macOS: the OS login items. Linux: an XDG autostart entry.
import { app } from 'electron'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const desktopFile = () =>
  join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'autostart', 'blowlink.desktop')

// An Exec= argument in quotes, as the Desktop Entry spec wants it: " ` $ and \ get a backslash in front (a
// literal backslash needs four, because the file's own string escapes are applied first), and % is doubled.
function execQuote(arg: string): string {
  return '"' + arg.replace(/\\/g, '\\\\\\\\').replace(/["`$]/g, '\\$&').replace(/%/g, '%%') + '"'
}

// The portable exe runs from a temp copy; the login item has to point at the file the user has.
const loginPath = () => (process.env.PORTABLE_EXECUTABLE_FILE ? { path: process.env.PORTABLE_EXECUTABLE_FILE } : {})

export function getAutostart(): boolean {
  if (process.platform === 'linux') return existsSync(desktopFile())
  return app.getLoginItemSettings({ args: ['--hidden'], ...loginPath() }).openAtLogin
}

export function setAutostart(on: boolean): void {
  if (process.platform !== 'linux') {
    app.setLoginItemSettings({ openAtLogin: on, args: ['--hidden'], ...loginPath() })
    return
  }
  const file = desktopFile()
  if (!on) {
    rmSync(file, { force: true })
    return
  }
  // An AppImage runs from a temporary mount; $APPIMAGE is the file to start again.
  const exe = process.env.APPIMAGE ?? process.execPath
  if (/[\r\n]/.test(exe)) throw new Error('the program path contains a line break')
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(
    file,
    [
      '[Desktop Entry]',
      'Type=Application',
      'Name=BlowLink',
      'Comment=Connect Intiface/Buttplug games to Autoblow devices',
      `Exec=${execQuote(exe)} --hidden`,
      'Icon=blowlink',
      'X-GNOME-Autostart-enabled=true',
      ''
    ].join('\n')
  )
}
