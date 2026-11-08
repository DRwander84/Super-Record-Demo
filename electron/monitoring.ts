import { app, BrowserWindow, screen } from 'electron'
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { Readable } from 'node:stream'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { hwndFromGameId } from './games'
import {
  FPS_HOST_SCRIPT,
  NVIDIA_QUERY,
  SENSOR_HOST_SCRIPT,
  parseNvidiaLine,
  pickAdapter,
  pickNvidiaCard,
  type DisplayAdapter,
  type NvidiaSample,
} from './monitorSources'
import {
  EMPTY_MONITOR_INFO,
  EMPTY_MONITOR_SNAPSHOT,
  EMPTY_MONITOR_STATS,
  buildMonitorRows,
  cleanHardwareName,
  cpuVendorOf,
  drawMonitorPanel,
  gpuVendorOf,
  monitorPanelBox,
  normalizeMonitorMetrics,
  type MonitorInfo,
  type MonitorMetric,
  type MonitorSnapshot,
  type MonitorStats,
} from '../src/recording/monitorLayout'

// ---------------------------------------------------------------------------
// Gaming Mode Monitoring.
//
// Everything runs only while Monitoring is switched on, and each reader only
// runs when one of its values is selected:
//   * processor load and RAM   - Node (cheap counters, no extra process)
//   * NVIDIA graphics          - one long running nvidia-smi (1 sample / s)
//   * other graphics, CPU temp - one resident PowerShell (performance counters
//                                and, when present, LibreHardwareMonitor)
//   * frame rate               - one resident PowerShell with an ETW session
// A small transparent click-through window shows the panel over the game; it
// is part of the desktop, so the native full-screen capture records it. The
// window based capture (Chromium) only sees the game itself, so the recorder
// draws the very same panel into its canvas.
// ---------------------------------------------------------------------------

export type MonitorConfig = {
  enabled: boolean
  gameId: string
  gameProcessId: number
  position: string
  metrics: MonitorMetric[]
}

const DISABLED: MonitorConfig = {
  enabled: false,
  gameId: '',
  gameProcessId: 0,
  position: 'top-left',
  metrics: [],
}

const IS_WINDOWS = process.platform === 'win32'
const TICK_MS = 1000
const WINDOW_POLL_MS = 500
const NVIDIA_STALE_MS = 4000
const SENSOR_STALE_MS = 5000
const FPS_STALE_MS = 4000

let config: MonitorConfig = DISABLED
let snapshot: MonitorSnapshot = EMPTY_MONITOR_SNAPSHOT
let listener: ((snapshot: MonitorSnapshot) => void) | null = null

const cpuName = cleanHardwareName(os.cpus()[0]?.model ?? '')
const baseInfo: MonitorInfo = {
  ...EMPTY_MONITOR_INFO,
  cpuName,
  cpuVendor: cpuVendorOf(cpuName),
}
let info: MonitorInfo = baseInfo

export function getMonitorSnapshot(): MonitorSnapshot {
  return snapshot
}

export function setMonitorListener(callback: (snapshot: MonitorSnapshot) => void): void {
  listener = callback
}

function readLines(stream: Readable, onLine: (line: string) => void): void {
  let buffer = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk: string) => {
    buffer += chunk
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index).replace(/^\uFEFF/, '').trim()
      buffer = buffer.slice(index + 1)
      if (line) onLine(line)
      index = buffer.indexOf('\n')
    }
  })
}

function killLater(child: ChildProcessWithoutNullStreams): void {
  try { child.stdin.end() } catch { /* already closed */ }
  setTimeout(() => { try { child.kill() } catch { /* already gone */ } }, 1500)
}

// ---------------------------------------------------------------------------
// Processor load and RAM (Node)
// ---------------------------------------------------------------------------

type CpuTimes = { idle: number; total: number }

function readCpuTimes(): CpuTimes {
  let idle = 0
  let total = 0
  for (const cpu of os.cpus()) {
    const times = cpu.times
    idle += times.idle
    total += times.user + times.nice + times.sys + times.idle + times.irq
  }
  return { idle, total }
}

let lastCpuTimes: CpuTimes | null = null

function sampleCpuUsage(): number | null {
  const now = readCpuTimes()
  const previous = lastCpuTimes
  lastCpuTimes = now
  if (!previous) return null
  const total = now.total - previous.total
  if (total <= 0) return null
  return Math.max(0, Math.min(100, (1 - (now.idle - previous.idle) / total) * 100))
}

// ---------------------------------------------------------------------------
// NVIDIA (nvidia-smi)
// ---------------------------------------------------------------------------

type NvidiaState = 'unknown' | 'yes' | 'no'
let nvidiaState: NvidiaState = 'unknown'
let nvidiaPath = 'nvidia-smi'
let nvidiaIndex = 0
let nvidiaChild: ChildProcessWithoutNullStreams | null = null
let nvidiaSample: { at: number; sample: NvidiaSample } | null = null

function nvidiaCandidates(): string[] {
  const root = process.env.SystemRoot ?? 'C:\\Windows'
  const programs = process.env.ProgramFiles ?? 'C:\\Program Files'
  return [
    'nvidia-smi',
    path.join(root, 'System32', 'nvidia-smi.exe'),
    path.join(programs, 'NVIDIA Corporation', 'NVSMI', 'nvidia-smi.exe'),
  ]
}

function runNvidiaOnce(command: string): Promise<NvidiaSample[]> {
  return new Promise((resolve) => {
    execFile(
      command,
      [`--query-gpu=${NVIDIA_QUERY}`, '--format=csv,noheader,nounits'],
      { windowsHide: true, timeout: 5000 },
      (error, stdout) => {
        if (error) {
          resolve([])
          return
        }
        const samples: NvidiaSample[] = []
        for (const line of String(stdout).split(/\r?\n/)) {
          const sample = parseNvidiaLine(line)
          if (sample) samples.push(sample)
        }
        resolve(samples)
      },
    )
  })
}

async function detectNvidia(): Promise<NvidiaState> {
  if (!IS_WINDOWS) return 'no'
  for (const command of nvidiaCandidates()) {
    const card = pickNvidiaCard(await runNvidiaOnce(command))
    if (!card) continue
    nvidiaPath = command
    nvidiaIndex = card.index
    const name = cleanHardwareName(card.name)
    info = {
      ...info,
      gpuName: name,
      gpuVendor: 'nvidia',
      gpuMemoryMb: card.memTotalMb,
    }
    return 'yes'
  }
  return 'no'
}

function startNvidiaLoop(): void {
  if (nvidiaChild) return
  const child = spawn(
    nvidiaPath,
    [`--query-gpu=${NVIDIA_QUERY}`, '--format=csv,noheader,nounits', '-lms', String(TICK_MS)],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
  )
  nvidiaChild = child
  readLines(child.stdout, (line) => {
    const sample = parseNvidiaLine(line)
    if (sample && sample.index === nvidiaIndex) nvidiaSample = { at: Date.now(), sample }
  })
  child.stderr.on('data', () => undefined)
  child.stdin.on('error', () => undefined)
  child.on('error', () => { if (nvidiaChild === child) { nvidiaChild = null; nvidiaSample = null } })
  child.on('exit', () => { if (nvidiaChild === child) { nvidiaChild = null; nvidiaSample = null } })
}

function stopNvidiaLoop(): void {
  const child = nvidiaChild
  nvidiaChild = null
  nvidiaSample = null
  // nvidia-smi does not watch its input, so it is ended directly.
  if (child) { try { child.kill() } catch { /* already gone */ } }
}

// ---------------------------------------------------------------------------
// Sensor host (PowerShell): adapters, game window rectangle, sensors
// ---------------------------------------------------------------------------

type PixelRect = { left: number; top: number; right: number; bottom: number }
type HostFlags = { gpu: boolean; cpu: boolean }

let host: ChildProcessWithoutNullStreams | null = null
let hostReady = false
let hostFlags: HostFlags = { gpu: false, cpu: false }
let hostSensors: { at: number; data: Record<string, unknown> } | null = null
let sensorPendingSince = 0
let windowPending = false
let adaptersRequested = false
let gameRect: PixelRect | null = null

function monitoringDirectory(): string {
  const candidates = [
    path.join(process.resourcesPath ?? '', 'monitoring'),
    path.join(app.getAppPath(), 'monitoring'),
    path.join(process.cwd(), 'monitoring'),
    path.join(app.getPath('userData'), 'monitoring'),
  ]
  for (const directory of candidates) {
    try {
      if (fs.existsSync(path.join(directory, 'LibreHardwareMonitorLib.dll'))) return directory
    } catch {
      // Try the next place.
    }
  }
  return ''
}

function encodeScript(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

function sendHost(command: string): void {
  if (!host || !hostReady || !host.stdin.writable) return
  try { host.stdin.write(`${command}\n`) } catch { /* the host is closing */ }
}

function applyAdapters(adapters: DisplayAdapter[]): void {
  const adapter = pickAdapter(adapters)
  if (!adapter || nvidiaState === 'yes') return
  const name = cleanHardwareName(adapter.name)
  info = {
    ...info,
    gpuName: name,
    gpuVendor: gpuVendorOf(name),
    gpuMemoryMb: adapter.memoryMb > 0 ? adapter.memoryMb : null,
  }
}

function handleHostLine(line: string): void {
  if (line === 'READY') {
    hostReady = true
    if (adaptersRequested) sendHost('I')
    return
  }
  const comma = line.indexOf(',')
  if (comma < 0) return
  const kind = line.slice(0, comma)
  const body = line.slice(comma + 1)

  if (kind === 'I') {
    try {
      const parsed = JSON.parse(body) as Array<{ name?: unknown; memoryMb?: unknown }>
      applyAdapters(
        (Array.isArray(parsed) ? parsed : []).map((item) => ({
          name: typeof item.name === 'string' ? item.name : '',
          memoryMb: typeof item.memoryMb === 'number' ? item.memoryMb : 0,
        })),
      )
    } catch { /* keep the generic title */ }
  } else if (kind === 'S') {
    sensorPendingSince = 0
    try {
      const data = JSON.parse(body) as Record<string, unknown>
      if (typeof data === 'object' && data !== null) hostSensors = { at: Date.now(), data }
    } catch { /* ignore a damaged line */ }
  } else if (kind === 'W') {
    windowPending = false
    if (body === 'GONE') {
      gameRect = null
    } else {
      const [left, top, right, bottom, iconic] = body.split(',').map(Number)
      if ([left, top, right, bottom].some((value) => !Number.isFinite(value))) return
      gameRect = iconic === 0 && right - left >= 100 && bottom - top >= 80
        ? { left, top, right, bottom }
        : null
    }
    refreshOverlay()
  }
}

function startHost(flags: HostFlags): void {
  stopHost()
  if (!IS_WINDOWS) return
  const script = SENSOR_HOST_SCRIPT.replace('__LHM_DIR__', () => monitoringDirectory().replace(/'/g, "''"))
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodeScript(script)],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
  )
  host = child
  hostReady = false
  hostFlags = flags
  readLines(child.stdout, (line) => { if (host === child) handleHostLine(line) })
  child.stderr.on('data', () => undefined)
  child.stdin.on('error', () => undefined)
  child.on('error', () => { if (host === child) stopHost() })
  child.on('exit', () => { if (host === child) { host = null; hostReady = false } })
}

function stopHost(): void {
  const child = host
  host = null
  hostReady = false
  hostSensors = null
  sensorPendingSince = 0
  windowPending = false
  if (child) killLater(child)
}

// ---------------------------------------------------------------------------
// Frame rate host (PowerShell + ETW)
// ---------------------------------------------------------------------------

let fpsHost: ChildProcessWithoutNullStreams | null = null
let fpsReady = false
let fpsStarted = false
let fpsTarget = 0
let fpsSample: { at: number; value: number | null } | null = null
let fpsPending = false
// Set when Windows refused the session (no administrator rights): the readers
// are not started again until Monitoring is switched off and on.
let fpsFailed = false

function sendFps(command: string): void {
  if (!fpsHost || !fpsReady || !fpsHost.stdin.writable) return
  try { fpsHost.stdin.write(`${command}\n`) } catch { /* the host is closing */ }
}

function startFpsHost(pid: number): void {
  stopFpsHost()
  if (!IS_WINDOWS) return
  fpsTarget = pid
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodeScript(FPS_HOST_SCRIPT)],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
  )
  fpsHost = child
  readLines(child.stdout, (line) => {
    if (fpsHost !== child) return
    if (line === 'READY') {
      fpsReady = true
      sendFps(`START ${fpsTarget}`)
    } else if (line.startsWith('READY,ERR')) {
      // The helper could not be prepared; the frame rate stays at "N/A".
      fpsFailed = true
      stopFpsHost()
    } else if (line.startsWith('START,')) {
      // Anything but OK (for example access denied without administrator
      // rights) leaves the frame rate at "N/A".
      fpsStarted = line === 'START,OK'
      if (!fpsStarted) {
        fpsFailed = true
        stopFpsHost()
      }
    } else if (line.startsWith('F,')) {
      fpsPending = false
      const text = line.slice(2)
      const value = text === 'NA' ? null : Number(text)
      fpsSample = { at: Date.now(), value: value !== null && Number.isFinite(value) ? value : null }
    }
  })
  child.stderr.on('data', () => undefined)
  child.stdin.on('error', () => undefined)
  child.on('error', () => { if (fpsHost === child) stopFpsHost() })
  child.on('exit', () => { if (fpsHost === child) { fpsHost = null; fpsReady = false; fpsStarted = false } })
}

function stopFpsHost(): void {
  const child = fpsHost
  fpsHost = null
  fpsReady = false
  fpsStarted = false
  fpsSample = null
  fpsPending = false
  if (child) {
    try { child.stdin.write('QUIT\n') } catch { /* already closed */ }
    killLater(child)
  }
}

// ---------------------------------------------------------------------------
// Overlay window
// ---------------------------------------------------------------------------

// The drawing code is the very function the recorder uses, so the on-screen
// panel and the recorded panel can never differ.
const OVERLAY_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;overflow:hidden;background:transparent}
canvas{display:block}
</style></head><body><canvas id="c"></canvas><script>
var draw=(${drawMonitorPanel.toString()});
var canvas=document.getElementById('c');
var context=canvas.getContext('2d');
window.__setPanel=function(panel,rows){
  var ratio=window.devicePixelRatio||1;
  canvas.width=Math.ceil(panel.width*ratio);
  canvas.height=Math.ceil(panel.height*ratio);
  canvas.style.width=panel.width+'px';
  canvas.style.height=panel.height+'px';
  context.setTransform(ratio,0,0,ratio,0,0);
  context.clearRect(0,0,panel.width,panel.height);
  var local={};
  for(var key in panel){local[key]=panel[key];}
  local.x=0;local.y=0;
  draw(context,local,rows);
};
</script></body></html>`

let overlay: BrowserWindow | null = null
let overlayReady = false
let overlayKey = ''
let lastTopAt = 0

function ensureOverlay(): BrowserWindow {
  if (overlay && !overlay.isDestroyed()) return overlay
  overlayReady = false
  overlayKey = ''
  const window = new BrowserWindow({
    width: 200,
    height: 200,
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
      overlayKey = ''
      refreshOverlay()
    })
    .catch(() => undefined)
  return window
}

function hideOverlay(): void {
  if (overlay && !overlay.isDestroyed() && overlay.isVisible()) overlay.hide()
}

function destroyOverlay(): void {
  const current = overlay
  overlay = null
  overlayReady = false
  overlayKey = ''
  if (current && !current.isDestroyed()) current.destroy()
}

/** Windows can push a topmost window down when another one takes the focus. */
function keepOverlayOnTop(window: BrowserWindow): void {
  const now = Date.now()
  if (now - lastTopAt < 1000) return
  lastTopAt = now
  window.setAlwaysOnTop(true, 'screen-saver')
  window.moveTop()
}

function refreshOverlay(): void {
  if (!config.enabled || !IS_WINDOWS || !gameRect || hwndFromGameId(config.gameId) === null) {
    hideOverlay()
    return
  }
  const rows = buildMonitorRows(snapshot, config.metrics)
  if (rows.length === 0) {
    hideOverlay()
    return
  }

  const region = screen.screenToDipRect(null, {
    x: gameRect.left,
    y: gameRect.top,
    width: gameRect.right - gameRect.left,
    height: gameRect.bottom - gameRect.top,
  })
  const panel = monitorPanelBox(rows, region.width, region.height, config.position)
  const bounds = {
    x: Math.round(region.x + panel.x),
    y: Math.round(region.y + panel.y),
    width: panel.width,
    height: panel.height,
  }

  const window = ensureOverlay()
  const current = window.getBounds()
  if (
    current.x !== bounds.x || current.y !== bounds.y ||
    current.width !== bounds.width || current.height !== bounds.height
  ) {
    window.setBounds(bounds)
  }
  if (!overlayReady) return

  const key = JSON.stringify([panel, rows])
  if (key !== overlayKey) {
    overlayKey = key
    void window.webContents
      .executeJavaScript(`window.__setPanel(${JSON.stringify(panel)},${JSON.stringify(rows)})`)
      .catch(() => undefined)
  }
  if (!window.isVisible()) window.showInactive()
  keepOverlayOnTop(window)
}

// ---------------------------------------------------------------------------
// Sampling loop
// ---------------------------------------------------------------------------

let tickTimer: ReturnType<typeof setInterval> | null = null
let windowTimer: ReturnType<typeof setInterval> | null = null

const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

function assembleStats(): MonitorStats {
  const wants = new Set<MonitorMetric>(config.metrics)
  const stats: MonitorStats = { ...EMPTY_MONITOR_STATS }
  const now = Date.now()

  if (wants.has('cpuUsage')) stats.cpuUsage = sampleCpuUsage()
  else lastCpuTimes = null
  if (wants.has('ram')) {
    const total = os.totalmem()
    stats.ramTotalMb = total / (1024 * 1024)
    stats.ramUsedMb = (total - os.freemem()) / (1024 * 1024)
  }

  const nvidia = nvidiaSample && now - nvidiaSample.at <= NVIDIA_STALE_MS ? nvidiaSample.sample : null
  const sensors = hostSensors && now - hostSensors.at <= SENSOR_STALE_MS ? hostSensors.data : null
  if (nvidia) {
    stats.gpuUsage = nvidia.usage
    stats.gpuTemp = nvidia.temp
    stats.vramUsedMb = nvidia.memUsedMb
    stats.gpuClock = nvidia.clock
    stats.gpuMemClock = nvidia.memClock
  } else if (sensors) {
    stats.gpuUsage = finite(sensors.gpuUsage)
    stats.gpuTemp = finite(sensors.gpuTemp)
    stats.vramUsedMb = finite(sensors.vramUsedMb)
    stats.gpuClock = finite(sensors.gpuClock)
    stats.gpuMemClock = finite(sensors.gpuMemClock)
  }
  if (sensors) stats.cpuTemp = finite(sensors.cpuTemp)

  if (fpsStarted && fpsSample && now - fpsSample.at <= FPS_STALE_MS) stats.fps = fpsSample.value
  return stats
}

function tick(): void {
  if (!config.enabled) return
  const now = Date.now()
  const needGpuFromHost = hostFlags.gpu
  if (host && hostReady && (needGpuFromHost || hostFlags.cpu)) {
    // Never queue a second request while the previous one is still running.
    if (sensorPendingSince === 0 || now - sensorPendingSince > 5000) {
      sensorPendingSince = now
      sendHost(`S ${hostFlags.gpu ? 1 : 0} ${hostFlags.cpu ? 1 : 0}`)
    }
  }
  if (fpsHost && fpsReady && fpsStarted && !fpsPending) {
    fpsPending = true
    sendFps('TAKE')
    // A lost reply must not stop the readings for good.
    setTimeout(() => { fpsPending = false }, 2500)
  }

  snapshot = { info, stats: assembleStats() }
  listener?.(snapshot)
  refreshOverlay()
}

function pollWindow(): void {
  if (!host || !hostReady || windowPending) return
  const hwnd = hwndFromGameId(config.gameId)
  if (hwnd === null) return
  windowPending = true
  sendHost(`W ${hwnd}`)
  setTimeout(() => { windowPending = false }, 2000)
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function stopAll(): void {
  if (tickTimer !== null) clearInterval(tickTimer)
  if (windowTimer !== null) clearInterval(windowTimer)
  tickTimer = null
  windowTimer = null
  stopNvidiaLoop()
  stopHost()
  stopFpsHost()
  destroyOverlay()
  nvidiaState = 'unknown'
  fpsFailed = false
  adaptersRequested = false
  gameRect = null
  lastCpuTimes = null
  info = baseInfo
  snapshot = { info, stats: EMPTY_MONITOR_STATS }
}

let generation = 0
let applyChain: Promise<void> = Promise.resolve()

async function applyConfig(token: number): Promise<void> {
  if (token !== generation || !config.enabled) return
  const wants = new Set<MonitorMetric>(config.metrics)
  const needGpu = ['gpuUsage', 'gpuTemp', 'vram', 'gpuClock', 'gpuMemClock'].some(
    (metric) => wants.has(metric as MonitorMetric),
  )
  const needCpuTemp = wants.has('cpuTemp')
  const wantOverlay = IS_WINDOWS && hwndFromGameId(config.gameId) !== null
  const wantFps = IS_WINDOWS && !fpsFailed && wants.has('fps') && config.gameProcessId > 0

  if (tickTimer === null) {
    lastCpuTimes = readCpuTimes()
    tickTimer = setInterval(tick, TICK_MS)
  }

  // Graphics: NVIDIA through nvidia-smi, everything else through the host.
  if (needGpu && nvidiaState === 'unknown') {
    const detected = await detectNvidia()
    if (token !== generation || !config.enabled) return
    nvidiaState = detected
  }
  if (needGpu && nvidiaState === 'yes') startNvidiaLoop()
  else stopNvidiaLoop()

  const flags: HostFlags = { gpu: needGpu && nvidiaState === 'no', cpu: needCpuTemp }
  const needHost = IS_WINDOWS && (wantOverlay || flags.gpu || flags.cpu)
  if (needHost) {
    adaptersRequested = flags.gpu
    if (!host || hostFlags.gpu !== flags.gpu || hostFlags.cpu !== flags.cpu) startHost(flags)
    else if (flags.gpu && info.gpuName === '') sendHost('I')
  } else {
    stopHost()
    gameRect = null
  }

  if (wantOverlay) {
    if (windowTimer === null) windowTimer = setInterval(pollWindow, WINDOW_POLL_MS)
  } else {
    if (windowTimer !== null) clearInterval(windowTimer)
    windowTimer = null
    gameRect = null
    destroyOverlay()
  }

  if (wantFps) {
    if (!fpsHost) startFpsHost(config.gameProcessId)
    else if (fpsTarget !== config.gameProcessId) {
      fpsTarget = config.gameProcessId
      sendFps(`TARGET ${fpsTarget}`)
    }
  } else {
    stopFpsHost()
  }

  tick()
}

function normalizeConfig(raw: unknown): MonitorConfig {
  const value = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const pid = typeof value.gameProcessId === 'number' && Number.isInteger(value.gameProcessId)
    ? Math.max(0, value.gameProcessId)
    : 0
  return {
    enabled: value.enabled === true,
    gameId: typeof value.gameId === 'string' ? value.gameId : '',
    gameProcessId: pid,
    position: typeof value.position === 'string' ? value.position : 'top-left',
    metrics: normalizeMonitorMetrics(value.metrics),
  }
}

/**
 * Applies the Gaming Mode settings: whether Monitoring is on, which game it
 * belongs to, where the panel sits and which values it shows.
 */
export function configureMonitoring(raw: unknown): MonitorSnapshot {
  config = normalizeConfig(raw)
  const token = ++generation
  if (!config.enabled) {
    stopAll()
    config = DISABLED
    return snapshot
  }
  applyChain = applyChain
    .then(() => applyConfig(token))
    .catch(() => undefined)
  return snapshot
}

export function disposeMonitoring(): void {
  generation += 1
  config = DISABLED
  stopAll()
}
