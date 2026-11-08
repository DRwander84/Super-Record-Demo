import { BrowserWindow, screen } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { hwndFromGameId } from './games'
import {
  TIMER_FONT,
  timerBox,
  type TimerSnapshot,
  type TimerStatus,
} from '../src/recording/timerLayout'

// ---------------------------------------------------------------------------
// Speedrun Timer.
//
// The clock lives here, in the main process, so the global hotkeys work while a
// game has the focus and every consumer (overlay, Live Game Preview, recorder)
// reads the very same time. The overlay is a small transparent click-through
// window placed over the selected game; it is part of the desktop, so the
// native full-screen capture records it. The window based capture (Chromium)
// only sees the game itself, so the recorder draws the timer into its canvas.
// ---------------------------------------------------------------------------

export type TimerConfig = {
  enabled: boolean
  gameId: string
  position: string
}

let status: TimerStatus = 'idle'
let accumulated = 0
let startedAt = 0
let config: TimerConfig = { enabled: false, gameId: '', position: 'top-left' }
let listener: ((snapshot: TimerSnapshot) => void) | null = null

function currentMs(): number {
  return status === 'running' ? accumulated + (Date.now() - startedAt) : accumulated
}

export function getTimerSnapshot(): TimerSnapshot {
  return { status, elapsedMs: currentMs(), at: Date.now() }
}

export function setTimerListener(callback: (snapshot: TimerSnapshot) => void): void {
  listener = callback
}

function publish(): void {
  const snapshot = getTimerSnapshot()
  listener?.(snapshot)
  pushToOverlay(snapshot)
}

/** F1: start, or stop (the final time stays on screen). F2: pause / resume. F7: reset. */
export function runTimerAction(action: 'timerToggle' | 'timerPause' | 'timerReset'): void {
  if (!config.enabled) return
  if (action === 'timerReset') {
    // F7: back to 00:00:00, ready for a new run.
    status = 'idle'
    accumulated = 0
    startedAt = 0
  } else if (action === 'timerToggle') {
    if (status === 'running' || status === 'paused') {
      accumulated = currentMs()
      status = 'stopped'
    } else {
      accumulated = 0
      startedAt = Date.now()
      status = 'running'
    }
  } else if (status === 'running') {
    accumulated = currentMs()
    status = 'paused'
  } else if (status === 'paused') {
    startedAt = Date.now()
    status = 'running'
  } else {
    return
  }
  publish()
}

// ---------------------------------------------------------------------------
// Overlay window
// ---------------------------------------------------------------------------

const OVERLAY_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;overflow:hidden;background:transparent}
#t{box-sizing:border-box;width:100vw;height:100vh;display:flex;align-items:center;justify-content:center;
background:rgba(0,0,0,.6);border-radius:calc(var(--fs,24px)*.3);color:#fff;
font:700 var(--fs,24px)/1 ${TIMER_FONT.replace(/"/g, "'")};white-space:nowrap;user-select:none}
</style></head><body><div id="t">00:00:00</div><script>
var s={e:0,a:Date.now(),st:'idle'};
var el=document.getElementById('t');
function p(n){return (n<10?'0':'')+n}
function render(){
  var ms=s.st==='running'?s.e+(Date.now()-s.a):s.e;
  var t=Math.max(0,Math.floor(ms/1000));
  el.textContent=p(Math.floor(t/3600))+':'+p(Math.floor(t%3600/60))+':'+p(t%60);
  el.style.color=s.st==='paused'?'#fbbf24':s.st==='stopped'?'#4ade80':'#fff';
}
window.__setTimer=function(e,a,st){s={e:e,a:a,st:st};render()};
window.__setFont=function(px){document.documentElement.style.setProperty('--fs',px+'px')};
setInterval(render,100);render();
</script></body></html>`

let overlay: BrowserWindow | null = null
let overlayFont = 0
let overlayReady = false

function pushToOverlay(snapshot: TimerSnapshot): void {
  if (!overlay || overlay.isDestroyed() || !overlayReady) return
  void overlay.webContents
    .executeJavaScript(`window.__setTimer(${snapshot.elapsedMs},${snapshot.at},'${snapshot.status}')`)
    .catch(() => undefined)
}

function createOverlay(): void {
  if (overlay && !overlay.isDestroyed()) return
  overlayReady = false
  overlayFont = 0
  const window = new BrowserWindow({
    width: 160,
    height: 48,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })
  overlay = window
  window.setAlwaysOnTop(true, 'screen-saver')
  window.setIgnoreMouseEvents(true)
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.on('closed', () => {
    if (overlay === window) {
      overlay = null
      overlayReady = false
    }
  })
  void window
    .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(OVERLAY_HTML)}`)
    .then(() => {
      overlayReady = true
      pushToOverlay(getTimerSnapshot())
    })
    .catch(() => undefined)
}

function destroyOverlay(): void {
  const current = overlay
  overlay = null
  overlayReady = false
  if (current && !current.isDestroyed()) current.destroy()
}

type PixelRect = { left: number; top: number; right: number; bottom: number }
let lastRect: (PixelRect & { visible: boolean }) | null = null

let lastTopAt = 0

/**
 * Puts the overlay over the game. It is never hidden because the game lost the
 * focus, was minimized or closed: it keeps its last place until the timer is
 * switched off in the app.
 */
function placeOverlay(rect: PixelRect, visible: boolean): void {
  if (!overlay || overlay.isDestroyed()) return
  // Too small or off-screen rectangles (a minimized window reports one) are
  // ignored, so the overlay simply stays where it was.
  if (!visible || rect.right - rect.left < 100 || rect.bottom - rect.top < 80) {
    keepOverlayOnTop()
    return
  }
  lastRect = { ...rect, visible: true }
  const region = screen.screenToDipRect(null, {
    x: rect.left,
    y: rect.top,
    width: rect.right - rect.left,
    height: rect.bottom - rect.top,
  })
  const box = timerBox(region.width, region.height, config.position)
  const bounds = {
    x: Math.round(region.x + box.x),
    y: Math.round(region.y + box.y),
    width: box.width,
    height: box.height,
  }
  const current = overlay.getBounds()
  if (current.x !== bounds.x || current.y !== bounds.y || current.width !== bounds.width || current.height !== bounds.height) {
    overlay.setBounds(bounds)
  }
  if (overlayFont !== box.fontSize && overlayReady) {
    overlayFont = box.fontSize
    void overlay.webContents.executeJavaScript(`window.__setFont(${box.fontSize})`).catch(() => undefined)
  }
  if (!overlay.isVisible()) overlay.showInactive()
  keepOverlayOnTop()
}

/** Windows can push a topmost window down when another one takes the focus. */
function keepOverlayOnTop(): void {
  if (!overlay || overlay.isDestroyed() || !overlay.isVisible()) return
  const now = Date.now()
  if (now - lastTopAt < 1000) return
  lastTopAt = now
  overlay.setAlwaysOnTop(true, 'screen-saver')
  overlay.moveTop()
}

// ---------------------------------------------------------------------------
// Game window watcher: one PowerShell process, compiled once, answers a window
// handle with the window's rectangle, minimized and foreground state.
// ---------------------------------------------------------------------------

const WATCHER_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SRW {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr c);
  public static void Init() { try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch (Exception) { } }
  public static string Query(long hwnd) {
    IntPtr h = new IntPtr(hwnd);
    RECT r;
    if (!IsWindow(h) || !GetWindowRect(h, out r)) return "GONE";
    return r.Left + "," + r.Top + "," + r.Right + "," + r.Bottom + "," + (IsIconic(h) ? 1 : 0) + "," + (GetForegroundWindow() == h ? 1 : 0);
  }
}
'@
[SRW]::Init()
[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $value = 0L
  if ([long]::TryParse($line.Trim(), [ref]$value)) { [Console]::Out.WriteLine('R,' + [SRW]::Query($value)) }
  [Console]::Out.Flush()
}
`

const POLL_MS = 500
let watcher: ChildProcessWithoutNullStreams | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
let pending = false

function stopWatcher(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  const child = watcher
  watcher = null
  pending = false
  lastRect = null
  if (child) {
    try { child.stdin.end() } catch { /* already closed */ }
    setTimeout(() => { try { child.kill() } catch { /* already gone */ } }, 500)
  }
}

function handleWatcherLine(line: string): void {
  if (!line.startsWith('R,')) return
  pending = false
  // A closed game keeps the overlay where it was; only turning the timer off
  // in the app removes it.
  if (line === 'R,GONE') {
    keepOverlayOnTop()
    return
  }
  const [left, top, right, bottom, iconic] = line.slice(2).split(',').map(Number)
  if ([left, top, right, bottom].some((value) => !Number.isFinite(value))) return
  placeOverlay({ left, top, right, bottom }, iconic === 0)
}

function startWatcher(hwnd: number): void {
  stopWatcher()
  const encoded = Buffer.from(WATCHER_SCRIPT, 'utf16le').toString('base64')
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
  )
  watcher = child
  let buffer = ''
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (watcher === child) handleWatcherLine(line)
      index = buffer.indexOf('\n')
    }
  })
  child.stderr.on('data', () => undefined)
  child.stdin.on('error', () => undefined)
  child.on('error', () => { if (watcher === child) stopWatcher() })
  child.on('exit', () => { if (watcher === child) stopWatcher() })
  pollTimer = setInterval(() => {
    if (watcher !== child || pending || !child.stdin.writable) return
    pending = true
    child.stdin.write(`${hwnd}\n`)
  }, POLL_MS)
}

// ---------------------------------------------------------------------------

/**
 * Applies the Gaming Mode settings: whether the timer is on, which game it
 * belongs to and where it sits. Switching it off clears the clock.
 */
export function configureTimer(next: TimerConfig): TimerSnapshot {
  const previous = config
  config = next

  if (!next.enabled) {
    stopWatcher()
    destroyOverlay()
    status = 'idle'
    accumulated = 0
    publish()
    return getTimerSnapshot()
  }

  const hwnd = hwndFromGameId(next.gameId)
  if (hwnd === null || process.platform !== 'win32') {
    stopWatcher()
    destroyOverlay()
  } else {
    createOverlay()
    if (previous.gameId !== next.gameId || !watcher) {
      startWatcher(hwnd)
    } else if (lastRect) {
      // Same game, new position: place it again right away.
      placeOverlay(lastRect, true)
    }
  }
  return getTimerSnapshot()
}

export function disposeTimer(): void {
  stopWatcher()
  destroyOverlay()
}
