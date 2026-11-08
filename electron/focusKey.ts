import { spawn, type ChildProcess } from 'node:child_process'

// ---------------------------------------------------------------------------
// Mouse Focus hold key
//
// Mouse Focus zooms only while the user HOLDS a chosen key (default NumLock).
// Electron's globalShortcut cannot report key release, so the physical key
// state is read by a tiny hidden PowerShell helper that polls GetAsyncKeyState
// (same approach as the click detector, no native Node module required).
// The key is stored as text such as "NumLock" or "Ctrl+Shift+Z".
// ---------------------------------------------------------------------------

export const DEFAULT_FOCUS_KEY = 'NumLock'

const MODIFIERS: Record<string, number> = {
  ctrl: 0x11,
  control: 0x11,
  alt: 0x12,
  shift: 0x10,
  super: 0x5b,
}

const NAMED_KEYS: Record<string, number> = {
  numlock: 0x90,
  scrolllock: 0x91,
  capslock: 0x14,
  pause: 0x13,
  printscreen: 0x2c,
  space: 0x20,
  tab: 0x09,
  backspace: 0x08,
  return: 0x0d,
  enter: 0x0d,
  insert: 0x2d,
  delete: 0x2e,
  home: 0x24,
  end: 0x23,
  pageup: 0x21,
  pagedown: 0x22,
  left: 0x25,
  up: 0x26,
  right: 0x27,
  down: 0x28,
  numadd: 0x6b,
  numsub: 0x6d,
  nummult: 0x6a,
  numdiv: 0x6f,
  numdec: 0x6e,
}

function keyToVirtualCode(name: string): number | null {
  const key = name.trim().toLowerCase()
  if (!key) return null
  if (key in MODIFIERS) return MODIFIERS[key]
  if (key in NAMED_KEYS) return NAMED_KEYS[key]
  if (/^[a-z]$/.test(key)) return key.toUpperCase().charCodeAt(0)
  if (/^\d$/.test(key)) return key.charCodeAt(0)
  const numpad = /^num(\d)$/.exec(key)
  if (numpad) return 0x60 + Number(numpad[1])
  const fn = /^f(\d{1,2})$/.exec(key)
  if (fn) {
    const index = Number(fn[1])
    if (index >= 1 && index <= 24) return 0x6f + index
  }
  return null
}

/** Converts "Ctrl+NumLock" into Windows virtual-key codes, or null if invalid. */
export function parseFocusKey(value: unknown): number[] | null {
  if (typeof value !== 'string') return null
  const parts = value.split('+').map((part) => part.trim()).filter(Boolean)
  if (parts.length === 0 || parts.length > 4) return null
  const codes: number[] = []
  for (const part of parts) {
    const code = keyToVirtualCode(part)
    if (code === null) return null
    if (!codes.includes(code)) codes.push(code)
  }
  return codes
}

const HELPER_SCRIPT = (parentPid: number, codes: number[]) => `
$ErrorActionPreference = 'Stop'
Add-Type -Namespace SuperRecord -Name Keys -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
'@
$codes = @(${codes.map((code) => Math.trunc(code)).join(',')})
$parent = ${Math.trunc(parentPid)}
[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()
$held = $false
$tick = 0
while ($true) {
  $all = $true
  foreach ($code in $codes) {
    if (([SuperRecord.Keys]::GetAsyncKeyState($code) -band 0x8000) -eq 0) { $all = $false; break }
  }
  if ($all -ne $held) {
    $held = $all
    if ($held) { [Console]::Out.WriteLine('D') } else { [Console]::Out.WriteLine('U') }
    [Console]::Out.Flush()
  }
  $tick++
  if (($tick % 100) -eq 0) {
    if (-not (Get-Process -Id $parent -ErrorAction SilentlyContinue)) { exit }
  }
  Start-Sleep -Milliseconds 10
}
`

let helper: ChildProcess | null = null
let held = false
let starting: Promise<{ success: true } | { success: false; message: string }> | null = null

/** True while the configured key (combination) is physically held down. */
export function isFocusKeyHeld(): boolean {
  return held
}

function killHelper(): void {
  const child = helper
  helper = null
  held = false
  if (child && !child.killed) {
    try { child.kill() } catch { /* already gone */ }
  }
}

function startHelper(codes: number[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const encoded = Buffer.from(HELPER_SCRIPT(process.pid, codes), 'utf16le').toString('base64')
    const child = spawn(
      'powershell.exe',
      [
        '-NoLogo', '-NoProfile', '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-EncodedCommand', encoded,
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    )

    helper = child
    let settled = false
    let buffer = ''
    let errorText = ''

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      killHelper()
      reject(new Error('The key detector did not start in time.'))
    }, 15_000)

    const fail = (message: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      killHelper()
      reject(new Error(message))
    }

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')

        if (line === 'READY') {
          if (!settled) {
            settled = true
            clearTimeout(timer)
            resolve()
          }
        } else if (helper === child) {
          if (line === 'D') held = true
          else if (line === 'U') held = false
        }
      }
    })

    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      errorText = (errorText + chunk).slice(-400)
    })

    child.on('error', (error) => fail(error.message))
    child.on('exit', (code) => {
      if (helper === child) {
        helper = null
        held = false
      }
      fail(`The key detector stopped (code ${code ?? 'unknown'}). ${errorText.trim()}`)
    })
  })
}

/** Starts watching the Mouse Focus hold key. Safe to call repeatedly. */
export function startFocusKey(
  keyText: unknown,
): Promise<{ success: true } | { success: false; message: string }> {
  if (process.platform !== 'win32') {
    return Promise.resolve({
      success: false,
      message: 'The Mouse Focus hold key is only available on Windows.',
    })
  }

  const codes = parseFocusKey(keyText) ?? parseFocusKey(DEFAULT_FOCUS_KEY)
  if (!codes) return Promise.resolve({ success: false, message: 'Invalid Mouse Focus key.' })

  if (starting) return starting

  killHelper()

  starting = (async () => {
    try {
      await startHelper(codes)
      return { success: true as const }
    } catch (error) {
      killHelper()
      return {
        success: false as const,
        message: `Mouse Focus key could not start: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      }
    } finally {
      starting = null
    }
  })()

  return starting
}

export function stopFocusKey(): void {
  killHelper()
}
