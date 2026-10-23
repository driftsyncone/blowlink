// Start BlowLink (hidden in the tray) when the user logs in.
// Windows/macOS: the OS login items. Linux: an XDG autostart entry.
import { app } from 'electron'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const desktopFile = () =>
  join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'autostart', 'blowlink.desktop')

export function getAutostart(): boolean {
  if (process.platform === 'linux') return existsSync(desktopFile())
  return app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin
}

export function setAutostart(on: boolean): void {
  if (process.platform !== 'linux') {
    app.setLoginItemSettings({ openAtLogin: on, args: ['--hidden'] })
    return
  }
  const file = desktopFile()
  if (!on) {
    rmSync(file, { force: true })
    return
  }
  // An AppImage runs from a temporary mount; $APPIMAGE is the file to start again.
  const exe = process.env.APPIMAGE ?? process.execPath
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(
    file,
    [
      '[Desktop Entry]',
      'Type=Application',
      'Name=BlowLink',
      'Comment=Connect Intiface/Buttplug games to Autoblow devices',
      `Exec="${exe.replace(/"/g, '\\"')}" --hidden`,
      'Icon=blowlink',
      'X-GNOME-Autostart-enabled=true',
      ''
    ].join('\n')
  )
}
