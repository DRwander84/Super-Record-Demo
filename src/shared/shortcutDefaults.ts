// Shortcut actions, defaults and normalization, shared by the main process
// (settings file, global hotkeys) and the window (settings page) so both always
// agree on the same, collision free set of keys.

export type ShortcutAction =
  | 'pause'
  | 'toggle'
  | 'timerToggle'
  | 'timerPause'
  | 'timerReset'

export type ShortcutMap = Record<ShortcutAction, string>

export const SHORTCUT_ACTIONS: ShortcutAction[] = [
  'pause', 'toggle', 'timerToggle', 'timerPause', 'timerReset',
]

/** Defaults: F1 Start / Stop, F2 Pause / Resume, F3-F5 Speedrun Timer. */
export const DEFAULT_SHORTCUTS: ShortcutMap = {
  toggle: 'F1',
  pause: 'F2',
  timerToggle: 'F3',
  timerPause: 'F4',
  timerReset: 'F5',
}

// When two actions want the same key the first one in this list keeps it.
const PRIORITY: ShortcutAction[] = ['timerToggle', 'timerPause', 'timerReset', 'toggle', 'pause']
const FALLBACK_KEYS = Array.from({ length: 12 }, (_, index) => `F${index + 1}`)

/**
 * Returns a complete shortcut map. Missing entries get their default, and a key
 * that is wanted twice (for example F1 saved for "start" before the Speedrun
 * Timer existed) stays with the higher priority action while the other one
 * moves to the first free function key. Running it again changes nothing.
 */
export function normalizeShortcuts(raw: unknown): ShortcutMap {
  const source = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const wanted = {} as ShortcutMap
  for (const action of SHORTCUT_ACTIONS) {
    const value = source[action]
    wanted[action] = typeof value === 'string' && value.trim() !== '' ? value.trim() : DEFAULT_SHORTCUTS[action]
  }

  const result = {} as ShortcutMap
  const used = new Set<string>()
  const pending: ShortcutAction[] = []
  for (const action of PRIORITY) {
    const key = wanted[action].toLowerCase()
    if (used.has(key)) {
      pending.push(action)
    } else {
      used.add(key)
      result[action] = wanted[action]
    }
  }
  for (const action of pending) {
    const free = FALLBACK_KEYS.find((key) => !used.has(key.toLowerCase())) ?? wanted[action]
    used.add(free.toLowerCase())
    result[action] = free
  }
  return result
}
