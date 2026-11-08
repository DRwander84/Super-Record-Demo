import { globalShortcut } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { parseFocusKey } from './focusKey'
import {
  normalizeShortcuts,
  SHORTCUT_ACTIONS,
  type ShortcutAction,
  type ShortcutMap,
} from '../src/shared/shortcutDefaults'

export type { ShortcutAction, ShortcutMap }

const ACTIONS: ShortcutAction[] = ['pause', 'toggle']
// The Speedrun Timer keys are only taken from other programs while the timer
// is switched on, so F1 / F2 keep working in games the rest of the time.
const TIMER_ACTIONS: ShortcutAction[] = ['timerToggle', 'timerPause', 'timerReset']
let timerActive = false
const REPEAT_GUARD_MS = 400

let applied: ShortcutMap | null = null
let suspended = false
let dispatch: ((action: ShortcutAction) => void) | null = null
const lastFired = new Map<ShortcutAction, number>()

export function setShortcutDispatcher(
  handler: (action: ShortcutAction) => void,
): void {
  dispatch = handler
}

/**
 * Runs one shortcut action. Both the system hotkey and the key watcher below
 * call this, and the guard makes sure one key press triggers it only once.
 */
function fire(action: ShortcutAction): void {
  if (suspended) return
  const allowed = ACTIONS.includes(action) || (timerActive && TIMER_ACTIONS.includes(action))
  if (!allowed) return
  const now = Date.now()
  // Holding a key repeats the hotkey; one press must trigger one action.
  if (now - (lastFired.get(action) ?? 0) < REPEAT_GUARD_MS) return
  lastFired.set(action, now)
  dispatch?.(action)
}

function registerAll(map: ShortcutMap, lenient = false): string | null {
  for (const action of timerActive ? [...ACTIONS, ...TIMER_ACTIONS] : ACTIONS) {
    const accelerator = map[action]

    try {
      const ok = globalShortcut.register(accelerator, () => fire(action))

      if (!ok && !lenient) {
        return `${accelerator} is already used by another application. Choose a different shortcut.`
      }
    } catch {
      if (!lenient) return `${accelerator} is not a valid shortcut.`
    }
  }

  return null
}


// ---------------------------------------------------------------------------
// Key watcher.
//
// System hotkeys alone are not enough: another program (or a game that reads
// the keyboard exclusively) can take a key, and a hotkey that failed to register
// is silent. A tiny hidden helper therefore also watches the physical keys and
// reports every press, whichever window has the focus. Duplicate reports of the
// same press are removed by fire().
// ---------------------------------------------------------------------------

const WATCHER_SCRIPT = (parentPid: number, spec: string) => `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class SRKeys {
  delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] struct KBDLL { public uint vkCode; public uint scanCode; public uint flags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int x; public int y; }
  [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public POINT pt; }
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vKey);
  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetWindowsHookEx(int id, HookProc proc, IntPtr mod, uint thread);
  [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern int GetMessage(out MSG msg, IntPtr hwnd, uint min, uint max);
  [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG msg);
  [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG msg);
  [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string name);

  static List<int[]> combos = new List<int[]>();
  static List<int> mainKeys = new List<int>();
  static List<int> modMasks = new List<int>();
  static volatile bool[] enabled = new bool[0];
  static bool[] pollHeld = new bool[0];
  static bool[] hookHeld = new bool[0];
  static bool[] keyDown = new bool[256];
  static bool[] swallowing = new bool[256];
  static HookProc proc = HookCallback;
  static IntPtr hook = IntPtr.Zero;
  static object gate = new object();

  static int ModBit(int vk) {
    if (vk == 0x10 || vk == 0xA0 || vk == 0xA1) return 1;
    if (vk == 0x11 || vk == 0xA2 || vk == 0xA3) return 2;
    if (vk == 0x12 || vk == 0xA4 || vk == 0xA5) return 4;
    if (vk == 0x5B || vk == 0x5C) return 8;
    return 0;
  }
  static int CurMods() {
    int m = 0;
    if (keyDown[0x10] || keyDown[0xA0] || keyDown[0xA1]) m |= 1;
    if (keyDown[0x11] || keyDown[0xA2] || keyDown[0xA3]) m |= 2;
    if (keyDown[0x12] || keyDown[0xA4] || keyDown[0xA5]) m |= 4;
    if (keyDown[0x5B] || keyDown[0x5C]) m |= 8;
    return m;
  }
  static void Report(int i) {
    lock (gate) { Console.Out.WriteLine("P" + i); Console.Out.Flush(); }
  }
  static bool Down(int vk) { return (GetAsyncKeyState(vk) & 0x8000) != 0; }

  static IntPtr HookCallback(int code, IntPtr w, IntPtr l) {
    try {
      if (code >= 0) {
        int msg = w.ToInt32();
        bool down = msg == 0x100 || msg == 0x104;
        bool up = msg == 0x101 || msg == 0x105;
        if (down || up) {
          KBDLL k = (KBDLL)Marshal.PtrToStructure(l, typeof(KBDLL));
          int vk = (int)k.vkCode;
          bool injected = (k.flags & 0x10) != 0;
          if (vk >= 0 && vk < 256) {
            keyDown[vk] = down;
            if (!injected && ModBit(vk) == 0) {
              if (up) {
                for (int i = 0; i < mainKeys.Count; i++) { if (mainKeys[i] == vk) hookHeld[i] = false; }
                if (swallowing[vk]) { swallowing[vk] = false; return (IntPtr)1; }
              } else {
                if (swallowing[vk]) return (IntPtr)1;
                int mods = CurMods();
                bool[] on = enabled;
                for (int i = 0; i < mainKeys.Count; i++) {
                  if (mainKeys[i] != vk || modMasks[i] != mods || i >= on.Length || !on[i]) continue;
                  if (!hookHeld[i]) { hookHeld[i] = true; Report(i); }
                  swallowing[vk] = true;
                  return (IntPtr)1;
                }
              }
            }
          }
        }
      }
    } catch (Exception) { }
    return CallNextHookEx(IntPtr.Zero, code, w, l);
  }

  // Fallback: reads the physical key state, in case the hook cannot be used.
  static void PollLoop(object parent) {
    int parentPid = (int)parent;
    int tick = 0;
    while (true) {
      bool[] on = enabled;
      for (int i = 0; i < combos.Count; i++) {
        int[] codes = combos[i];
        bool all = codes.Length > 0 && i < on.Length && on[i];
        if (all) {
          foreach (int c in codes) {
            bool d = c == 0x5B ? (Down(0x5B) || Down(0x5C)) : Down(c);
            if (!d) { all = false; break; }
          }
        }
        if (all) {
          int mods = (Down(0x10) ? 1 : 0) | (Down(0x11) ? 2 : 0) | (Down(0x12) ? 4 : 0) | ((Down(0x5B) || Down(0x5C)) ? 8 : 0);
          if (mods != modMasks[i]) all = false;
        }
        if (all && !pollHeld[i]) Report(i);
        pollHeld[i] = all;
      }
      tick++;
      if (tick % 200 == 0) {
        try { Process.GetProcessById(parentPid); } catch (Exception) { Environment.Exit(0); }
      }
      Thread.Sleep(12);
    }
  }

  // The app tells the helper which shortcuts are currently allowed: "E0,1,2".
  static void InputLoop() {
    while (true) {
      string line = Console.In.ReadLine();
      if (line == null) Environment.Exit(0);
      if (line.Length > 0 && line[0] == 'E') {
        bool[] next = new bool[combos.Count];
        foreach (string part in line.Substring(1).Split(',')) {
          int idx;
          if (int.TryParse(part, out idx) && idx >= 0 && idx < next.Length) next[idx] = true;
        }
        enabled = next;
      }
    }
  }

  public static void Run(string spec, int parentPid) {
    foreach (string part in spec.Split(';')) {
      List<int> codes = new List<int>();
      int mask = 0; int main = -1;
      foreach (string c in part.Split(',')) {
        if (c.Length == 0) continue;
        int code = int.Parse(c);
        codes.Add(code);
        int bit = ModBit(code);
        if (bit != 0) mask |= bit; else main = code;
      }
      combos.Add(codes.ToArray());
      mainKeys.Add(main);
      modMasks.Add(mask);
    }
    enabled = new bool[combos.Count];
    pollHeld = new bool[combos.Count];
    hookHeld = new bool[combos.Count];

    Thread input = new Thread(InputLoop); input.IsBackground = true; input.Start();
    Thread poll = new Thread(PollLoop); poll.IsBackground = true; poll.Start(parentPid);

    hook = SetWindowsHookEx(13, proc, GetModuleHandle(null), 0);
    lock (gate) { Console.Out.WriteLine("READY"); Console.Out.WriteLine(hook == IntPtr.Zero ? "H0" : "H1"); Console.Out.Flush(); }
    if (hook == IntPtr.Zero) { Thread.Sleep(Timeout.Infinite); return; }
    MSG m;
    while (GetMessage(out m, IntPtr.Zero, 0, 0) > 0) { TranslateMessage(ref m); DispatchMessage(ref m); }
  }
}
'@
try { (Get-Process -Id $PID).PriorityClass = 'High' } catch { }
[SRKeys]::Run('${spec}', ${Math.trunc(parentPid)})
`

let watcher: ChildProcessWithoutNullStreams | null = null
let watcherSpec = ''
let watcherActions: ShortcutAction[] = []

/**
 * Tells the helper which shortcuts may be taken from other programs right now.
 * Only those keys are swallowed before a game or app can see them; everything
 * else (and every key while a new shortcut is being chosen) passes through.
 */
function pushEnabled(): void {
  const child = watcher
  if (!child || !child.stdin.writable) return
  const indexes: number[] = []
  watcherActions.forEach((action, index) => {
    const allowed = !suspended && (ACTIONS.includes(action) || (timerActive && TIMER_ACTIONS.includes(action)))
    if (allowed) indexes.push(index)
  })
  child.stdin.write(`E${indexes.join(',')}\n`)
}

function stopKeyWatcher(): void {
  const child = watcher
  watcher = null
  watcherSpec = ''
  if (child && !child.killed) {
    try { child.kill() } catch { /* already gone */ }
  }
}

function startKeyWatcher(map: ShortcutMap): void {
  if (process.platform !== 'win32') return
  const entries = SHORTCUT_ACTIONS
    .map((action) => ({ action, codes: parseFocusKey(map[action]) }))
    .filter((entry): entry is { action: ShortcutAction; codes: number[] } => entry.codes !== null)
  if (entries.length === 0) return
  const spec = entries.map((entry) => entry.codes.join(',')).join(';')
  if (watcher && spec === watcherSpec) return

  stopKeyWatcher()
  const encoded = Buffer.from(WATCHER_SCRIPT(process.pid, spec), 'utf16le').toString('base64')
  const child = spawn(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
  )
  watcher = child
  watcherSpec = spec
  watcherActions = entries.map((entry) => entry.action)
  pushEnabled()

  let buffer = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')
      if (watcher !== child || !line.startsWith('P')) continue
      for (const index of line.slice(1).split(',')) {
        const entry = entries[Number(index)]
        if (entry) fire(entry.action)
      }
    }
  })
  child.stderr.on('data', () => undefined)
  child.stdin.on('error', () => undefined)
  child.on('error', () => { if (watcher === child) { watcher = null; watcherSpec = '' } })
  // If the helper ever dies, bring it back so the shortcuts keep working in
  // games without the user having to reopen the app.
  child.on('exit', () => {
    if (watcher !== child) return
    watcher = null
    watcherSpec = ''
    setTimeout(() => {
      if (!watcher && applied) startKeyWatcher(applied)
    }, 1000)
  })
}

export function parseShortcutMap(value: unknown): ShortcutMap | null {
  if (typeof value !== 'object' || value === null) return null
  return normalizeShortcuts(value)
}

/**
 * Registers the three recording hotkeys system-wide so they also work while
 * another application (or the game being recorded) has the focus.
 */
export function applyShortcuts(
  map: ShortcutMap,
  lenient = false,
): { success: true } | { success: false; message: string } {
  const unique = new Set(SHORTCUT_ACTIONS.map((action) => map[action].toLowerCase()))
  if (unique.size !== SHORTCUT_ACTIONS.length) {
    return {
      success: false,
      message: 'Every shortcut must use a different key.',
    }
  }

  const previous = applied
  globalShortcut.unregisterAll()

  if (suspended) {
    // Registration is postponed until capturing a new key has finished.
    applied = map
    startKeyWatcher(map)
    return { success: true }
  }

  const problem = registerAll(map, lenient)

  if (problem) {
    globalShortcut.unregisterAll()
    if (previous) registerAll(previous)
    return { success: false, message: problem }
  }

  applied = map
  startKeyWatcher(map)
  return { success: true }
}

/** While the user is choosing a new key, the old hotkeys must not fire. */
export function setShortcutsSuspended(value: boolean): void {
  suspended = value
  pushEnabled()
  globalShortcut.unregisterAll()

  if (!value && applied) registerAll(applied)
}

/** Registers (or releases) the Speedrun Timer hotkeys. */
export function setTimerShortcutsActive(value: boolean): void {
  if (timerActive === value) return
  timerActive = value
  pushEnabled()
  if (suspended || !applied) return
  globalShortcut.unregisterAll()
  registerAll(applied, true)
}

export function releaseShortcuts(): void {
  stopKeyWatcher()
  globalShortcut.unregisterAll()
}
