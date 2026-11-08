import { app } from 'electron'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

// Windows 11 "Do not disturb": while this value is 0 toast banners and sounds
// are suppressed, and the notifications are kept in the notification center.
// Setting it back to its previous value shows everything that arrived.
const REGISTRY_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings'
const REGISTRY_VALUE = 'NOC_GLOBAL_SETTING_TOASTS_ENABLED'

type BlockState = { previous: number | null }

const stateFile = () => path.join(app.getPath('userData'), 'notification-block.json')

function readRegistryValue(): number | null {
  try {
    const output = execFileSync('reg.exe', ['query', REGISTRY_KEY, '/v', REGISTRY_VALUE], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const match = /REG_DWORD\s+0x([0-9a-f]+)/i.exec(output)
    return match ? parseInt(match[1], 16) : null
  } catch {
    return null
  }
}

function writeRegistryValue(value: number | null): void {
  if (value === null) {
    try {
      execFileSync('reg.exe', ['delete', REGISTRY_KEY, '/v', REGISTRY_VALUE, '/f'], {
        windowsHide: true,
        stdio: 'ignore',
      })
    } catch {
      // The value did not exist, which already means "notifications on".
    }
    return
  }
  execFileSync(
    'reg.exe',
    ['add', REGISTRY_KEY, '/v', REGISTRY_VALUE, '/t', 'REG_DWORD', '/d', String(value), '/f'],
    { windowsHide: true, stdio: 'ignore' },
  )
}

function readState(): BlockState | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(stateFile(), 'utf8'))
    if (parsed && typeof parsed === 'object' && 'previous' in parsed) {
      const previous = (parsed as BlockState).previous
      return { previous: typeof previous === 'number' ? previous : null }
    }
  } catch {
    // No saved state.
  }
  return null
}

export function areNotificationsBlocked(): boolean {
  return readState() !== null
}

export function blockNotifications(): { success: boolean; message: string } {
  if (process.platform !== 'win32') return { success: false, message: 'Block Notification is only available on Windows.' }
  try {
    // Remember the user's own setting once, so it can be restored exactly.
    if (!readState()) {
      fs.writeFileSync(stateFile(), JSON.stringify({ previous: readRegistryValue() } satisfies BlockState))
    }
    writeRegistryValue(0)
    return { success: true, message: 'Notifications are blocked.' }
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : 'Could not block notifications.' }
  }
}

export function restoreNotifications(): { success: boolean; message: string } {
  if (process.platform !== 'win32') return { success: true, message: 'Nothing to restore.' }
  const state = readState()
  if (!state) return { success: true, message: 'Notifications were not blocked.' }
  try {
    writeRegistryValue(state.previous)
    fs.rmSync(stateFile(), { force: true })
    return { success: true, message: 'Notifications are back on.' }
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : 'Could not restore notifications.' }
  }
}
