import { screen, type Display } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'

// ---------------------------------------------------------------------------
// Mouse Click Effects: click detection
//
// Global left-clicks are read by a tiny hidden PowerShell helper that polls the
// physical left-button state with GetAsyncKeyState (no native Node module is
// needed). Every click is stored with its wall-clock time and its position
// normalised to the recorded display (0..1). Nothing is drawn on the desktop,
// so the user never sees the bubbles while recording: they are rendered into
// the video afterwards (native capture, see clickOverlay.ts) or drawn on the
// canvas (Mouse Focus capture, which receives the live click events).
// ---------------------------------------------------------------------------

export type ClickPoint = {
  /** Wall-clock time of the click (ms since epoch). */
  at: number
  /** Position relative to the recorded display, 0..1. */
  x: number
  y: number
}

const HELPER_SCRIPT = (parentPid: number) => `
$ErrorActionPreference = 'Stop'
Add-Type -Namespace SuperRecord -Name Mouse -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);
'@
# GetAsyncKeyState reports PHYSICAL buttons. With swapped buttons the logical
# left button is the physical right one.
$vk = 1
if ([SuperRecord.Mouse]::GetSystemMetrics(23) -ne 0) { $vk = 2 }
$parent = ${Math.trunc(parentPid)}
[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()
$down = $false
$tick = 0
while ($true) {
  $pressed = (([SuperRecord.Mouse]::GetAsyncKeyState($vk) -band 0x8000) -ne 0)
  if ($pressed -and -not $down) {
    [Console]::Out.WriteLine('D')
    [Console]::Out.Flush()
  }
  $down = $pressed
  $tick++
  if (($tick % 200) -eq 0) {
    if (-not (Get-Process -Id $parent -ErrorAction SilentlyContinue)) { exit }
  }
  Start-Sleep -Milliseconds 5
}
`

let helper: ChildProcess | null = null
let activeDisplay: Display | null = null
let clicks: ClickPoint[] = []
let clickListener: ((click: ClickPoint) => void) | null = null
let starting: Promise<{ success: true } | { success: false; message: string }> | null = null

/** Receives every click live (used by the canvas based Mouse Focus capture). */
export function setClickListener(listener: ((click: ClickPoint) => void) | null): void {
  clickListener = listener
}

/** Clicks recorded since the last start. They stay available after stop. */
export function getRecordedClicks(): ClickPoint[] {
  return clicks.slice()
}

function killHelper(): void {
  const child = helper
  helper = null
  if (child && !child.killed) {
    try { child.kill() } catch { /* already gone */ }
  }
}

function registerClick(): void {
  const display = activeDisplay
  if (!display) return

  const point = screen.getCursorScreenPoint()
  const x = (point.x - display.bounds.x) / display.bounds.width
  const y = (point.y - display.bounds.y) / display.bounds.height
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 1 || y > 1) return

  const click: ClickPoint = { at: Date.now(), x, y }
  clicks.push(click)
  clickListener?.(click)
}

function startHelper(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const encoded = Buffer.from(HELPER_SCRIPT(process.pid), 'utf16le').toString('base64')
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
      reject(new Error('The click detector did not start in time.'))
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
        } else if (line === 'D' && helper === child) {
          registerClick()
        }
      }
    })

    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      errorText = (errorText + chunk).slice(-400)
    })

    child.on('error', (error) => fail(error.message))
    child.on('exit', (code) => {
      if (helper === child) helper = null
      fail(`The click detector stopped (code ${code ?? 'unknown'}). ${errorText.trim()}`)
    })
  })
}

/** Starts click detection for the given display. Safe to call repeatedly. */
export function startClickEffects(
  display: Display,
): Promise<{ success: true } | { success: false; message: string }> {
  if (process.platform !== 'win32') {
    return Promise.resolve({
      success: false,
      message: 'Mouse Click Effects are only available on Windows.',
    })
  }

  if (starting) return starting

  killHelper()
  clicks = []
  activeDisplay = display

  starting = (async () => {
    try {
      await startHelper()
      return { success: true as const }
    } catch (error) {
      killHelper()
      activeDisplay = null
      return {
        success: false as const,
        message: `Mouse Click Effects could not start: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      }
    } finally {
      starting = null
    }
  })()

  return starting
}

/** Stops detecting clicks. The recorded clicks remain readable. */
export function stopClickEffects(): void {
  killHelper()
  activeDisplay = null
}
