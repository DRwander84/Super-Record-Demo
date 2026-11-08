
import {
  app,
  BrowserWindow,
  ipcMain,
  screen,
  dialog,
  shell,
  desktopCapturer,
  session,
  nativeImage,
} from 'electron'

import type { NativeImage, OpenDialogOptions } from 'electron'

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  getAppSettings,
  saveAppSettings,
  type AppSettings,
} from './settings'

import { warmEncoderAvailability } from './ffmpeg'

import {
  startRecordingSession,
  getActiveRecording,
  writeRecordingChunk,
  setRecordingPaused,
  stopRecordingSession,
  listRecordingFiles,
  removeRecordingFile,
} from './recording'

import { selectCaptureArea } from './areaSelector'

import { setClickListener, startClickEffects, stopClickEffects } from './clickEffects'
import { isFocusKeyHeld, startFocusKey, stopFocusKey } from './focusKey'
import { detectRunningGames, pickCaptureSource, resolveGameTarget } from './games'
import { startGameAudio, stopGameAudio } from './gameAudio'
import { blockNotifications, restoreNotifications } from './notifications'

import { normalizeAudioSettings } from '../src/recording/audioSettings'

import {
  applyShortcuts,
  parseShortcutMap,
  releaseShortcuts,
  setShortcutDispatcher,
  setShortcutsSuspended,
  setTimerShortcutsActive,
} from './shortcuts'
import {
  configureTimer,
  disposeTimer,
  getTimerSnapshot,
  runTimerAction,
  setTimerListener,
} from './speedrunTimer'
import {
  configureMonitoring,
  disposeMonitoring,
  getMonitorSnapshot,
  setMonitorListener,
} from './monitoring'

import {
  startNativeRecording,
  pauseNativeRecording,
  resumeNativeRecording,
  writeNativeAudioChunk,
  setNativeAudioStarted,
  writeNativeCameraChunk,
  setNativeCameraStarted,
  stopNativeCapture,
  finalizeNativeRecording,
  abortNativeRecording,
  getNativeCapabilities,
  isNativeRecordingActive,
  onNativeCaptureError,
  invalidateCaptureProbe,
  warmCaptureProbe,
  resolveDisplay,
  type NativeStartOptions,
} from './nativeRecorder'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

let mainWindow: BrowserWindow | null = null
type SavedWindowState = {
  x: number
  y: number
  width: number
  height: number
  isMaximized: boolean
}

const DEFAULT_WINDOW_STATE: SavedWindowState = {
  x: 0,
  y: 0,
  width: 1100,
  height: 760,
  isMaximized: false,
}

let windowSaveTimer: ReturnType<typeof setTimeout> | null = null
let windowSaveQueue: Promise<void> = Promise.resolve()

function getRestoredWindowState(
  saved: unknown,
): SavedWindowState {
  if (
    typeof saved !== 'object' ||
    saved === null
  ) {
    return { ...DEFAULT_WINDOW_STATE }
  }

  const value = saved as Record<string, unknown>

  const width =
    typeof value.width === 'number' &&
    Number.isFinite(value.width)
      ? Math.max(900, Math.round(value.width))
      : DEFAULT_WINDOW_STATE.width

  const height =
    typeof value.height === 'number' &&
    Number.isFinite(value.height)
      ? Math.max(600, Math.round(value.height))
      : DEFAULT_WINDOW_STATE.height

  const x =
    typeof value.x === 'number' &&
    Number.isFinite(value.x)
      ? Math.round(value.x)
      : DEFAULT_WINDOW_STATE.x

  const y =
    typeof value.y === 'number' &&
    Number.isFinite(value.y)
      ? Math.round(value.y)
      : DEFAULT_WINDOW_STATE.y

  const isMaximized = value.isMaximized === true

  const displays = screen.getAllDisplays()

  const isVisibleOnDisplay = displays.some((display) => {
    const area = display.workArea

    return (
      x < area.x + area.width &&
      x + width > area.x &&
      y < area.y + area.height &&
      y + height > area.y
    )
  })

  if (!isVisibleOnDisplay) {
    return { ...DEFAULT_WINDOW_STATE }
  }

  return {
    x,
    y,
    width,
    height,
    isMaximized,
  }
}

function saveWindowState(
  window: BrowserWindow,
): Promise<void> {
  if (window.isDestroyed()) {
    return Promise.resolve()
  }

  const bounds = window.getNormalBounds()

  const state: SavedWindowState = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    isMaximized: window.isMaximized(),
  }

  const operation = windowSaveQueue.then(async () => {
    const settings = await getAppSettings()

    await saveAppSettings({
      ...settings,
      windowState: state,
    })
  })

  windowSaveQueue = operation.catch((error) => {
    console.error('Could not save window state:', error)
  })

  return operation
}

function scheduleWindowStateSave(
  window: BrowserWindow,
) {
  if (windowSaveTimer) {
    clearTimeout(windowSaveTimer)
  }

  windowSaveTimer = setTimeout(() => {
    windowSaveTimer = null
    void saveWindowState(window)
  }, 500)
}

function getSystemInfo() {
  return {
    platform: process.platform,
    architecture: process.arch,
    operatingSystem: process.getSystemVersion(),
    electronVersion: process.versions.electron,
    chromeVersion: process.versions.chrome,
    nodeVersion: process.versions.node,
    appVersion: app.getVersion(),
  }
}

function getDisplays() {
  const primaryDisplay = screen.getPrimaryDisplay()

  return screen.getAllDisplays().map((display, index) => ({
    id: display.id,
    index: index + 1,
    // Electron exposes the platform-provided friendly display name here.
    label: display.label?.trim() || `Display ${index + 1}`,
    width: display.size.width,
    height: display.size.height,
    scaleFactor: display.scaleFactor,
    bounds: display.bounds,
    isPrimary: display.id === primaryDisplay.id,
    rotation: display.rotation,
  }))
}

async function createWindow() {
  const settings = await getAppSettings()

  const savedState = getRestoredWindowState(
    settings.windowState,
  )

  const window = new BrowserWindow({
    x: savedState.x,
    y: savedState.y,
    width: savedState.width,
    height: savedState.height,

    minWidth: 900,
    minHeight: 600,

    center: false,

    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    // The glass shell draws its own edge: no OS shadow / DWM rounding behind it.
    hasShadow: false,
    roundedCorners: false,
    autoHideMenuBar: true,
    show: false,
    title: 'SUPER RECORD',
    icon: path.join(
      __dirname,
      process.env.VITE_DEV_SERVER_URL
        ? '../public/icon.ico'
        : '../dist/icon.ico',
    ),

    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Keep renderer capture/encoding work alive while the app is minimized.
      backgroundThrottling: false,
      // Audio mixing must start even when the app was never clicked, for example
      // when a recording is started with a keyboard shortcut from inside a game.
      autoplayPolicy: 'no-user-gesture-required',
    },
  })

  mainWindow = window

  // Exclude the Super Record window from OS-level screen capture.
  // The window remains interactive and can still be minimized/restored.
  window.setContentProtection(true)

  window.on('close', (event) => {
    if (getActiveRecording() || isNativeRecordingActive()) {
      event.preventDefault()
      return
    }

    if (windowSaveTimer) {
      clearTimeout(windowSaveTimer)
      windowSaveTimer = null
    }

    void saveWindowState(window)
  })

  window.on('resize', () => {
    if (!window.isMaximized() && !window.isMinimized()) {
      scheduleWindowStateSave(window)
    }
  })

  window.on('move', () => {
    if (!window.isMaximized() && !window.isMinimized()) {
      scheduleWindowStateSave(window)
    }
  })

  window.on('maximize', () => {
    scheduleWindowStateSave(window)
    window.webContents.send('window:maximized-changed', true)
  })

  window.on('unmaximize', () => {
    scheduleWindowStateSave(window)
    window.webContents.send('window:maximized-changed', false)
  })

  window.once('ready-to-show', () => {
    if (savedState.isMaximized) {
      window.maximize()
    }

    window.show()
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    // Only the About link may leave the app, and it opens in the default browser.
    if (url === 'https://t.me/DRwander84') {
      void shell.openExternal(url)
    }

    return { action: 'deny' }
  })

  window.webContents.on('will-navigate', (event, navigationUrl) => {
    const devUrl = process.env.VITE_DEV_SERVER_URL

    if (devUrl && navigationUrl.startsWith(devUrl)) {
      return
    }

    if (!devUrl && navigationUrl.startsWith('file://')) {
      return
    }

    event.preventDefault()
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    void window.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    void window.loadFile(
      path.join(__dirname, '../dist/index.html'),
    )
  }

  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = null
    }
    // The Speedrun Timer, camera and click overlays are windows of their own,
    // so Electron never sees "all windows closed" while one is still on screen.
    // Closing the main window therefore closes the timer and quits the app.
    disposeTimer()
    disposeMonitoring()
    if (process.platform !== 'darwin') app.quit()
  })

  return window
}

// Taskbar status dot (Windows): green while recording, yellow while paused,
// nothing otherwise.

function createStatusDot(red: number, green: number, blue: number): NativeImage {
  const size = 32
  const coreRadius = 7.5
  const glowRadius = 15
  const center = (size - 1) / 2
  const bitmap = Buffer.alloc(size * size * 4)

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const distance = Math.hypot(x - center, y - center)

      // Small solid core with an anti-aliased edge.
      const core = Math.min(1, Math.max(0, coreRadius + 0.5 - distance))

      // Soft neon glow fading out around the core.
      const fade = Math.min(1, Math.max(0, (glowRadius - distance) / (glowRadius - coreRadius)))
      const glow = 0.6 * fade * fade

      // The middle of the core is lighter, like a lit neon tube.
      const shine = Math.max(0, 1 - distance / coreRadius) * 0.45
      const coreRed = red + (255 - red) * shine
      const coreGreen = green + (255 - green) * shine
      const coreBlue = blue + (255 - blue) * shine

      const glowWeight = glow * (1 - core)
      const offset = (y * size + x) * 4

      // BGRA with premultiplied alpha.
      bitmap[offset] = Math.round(coreBlue * core + blue * glowWeight)
      bitmap[offset + 1] = Math.round(coreGreen * core + green * glowWeight)
      bitmap[offset + 2] = Math.round(coreRed * core + red * glowWeight)
      bitmap[offset + 3] = Math.round(255 * (core + glowWeight))
    }
  }

  return nativeImage.createFromBitmap(bitmap, { width: size, height: size })
}

let recordingDot: NativeImage | null = null
let pausedDot: NativeImage | null = null

ipcMain.handle('window:set-recording-overlay', (event, state: unknown) => {
  if (process.platform !== 'win32') return

  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window || window.isDestroyed()) return

  if (state === 'recording') {
    recordingDot ??= createStatusDot(34, 197, 94)
    window.setOverlayIcon(recordingDot, 'Recording')
  } else if (state === 'paused') {
    pausedDot ??= createStatusDot(250, 204, 21)
    window.setOverlayIcon(pausedDot, 'Paused')
  } else {
    window.setOverlayIcon(null, '')
  }
})

// Window controls

ipcMain.handle('window:minimize', (event) => {
  BrowserWindow.fromWebContents(event.sender)?.minimize()
})

ipcMain.handle('window:toggle-maximize', (event) => {
  const window = BrowserWindow.fromWebContents(event.sender)

  if (!window) return false

  if (window.isMaximized()) {
    window.unmaximize()
  } else {
    window.maximize()
  }

  return window.isMaximized()
})

ipcMain.handle('window:is-maximized', (event) => {
  return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false
})

ipcMain.handle('window:close', (event) => {
  BrowserWindow.fromWebContents(event.sender)?.close()
})

// System information

ipcMain.handle('system:get-info', () => getSystemInfo())

ipcMain.handle('system:get-displays', () => getDisplays())

// Persistent settings

ipcMain.handle('settings:get', async () => {
  return getAppSettings()
})

ipcMain.handle(
  'settings:save',
  async (_event, settings: unknown) => {
    if (
      typeof settings !== 'object' ||
      settings === null ||
      Array.isArray(settings)
    ) {
      throw new Error('Invalid settings data.')
    }

    const serialized = JSON.stringify(settings)

    if (serialized.length > 1_000_000) {
      throw new Error('Settings data is too large.')
    }

    await saveAppSettings(settings as AppSettings)

    return { success: true }
  },
)

// Select output directory

ipcMain.handle(
  'settings:select-output-directory',
  async (event) => {
    const parentWindow = BrowserWindow.fromWebContents(
      event.sender,
    )

    const currentSettings = await getAppSettings()

    const options: OpenDialogOptions = {
      title: 'Choose Recording Folder',
      defaultPath: currentSettings.outputDirectory,
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Select Folder',
    }

    const result = parentWindow
      ? await dialog.showOpenDialog(parentWindow, options)
      : await dialog.showOpenDialog(options)

    if (result.canceled || result.filePaths.length === 0) {
      return null
    }

    return result.filePaths[0]
  },
)


let selectedCaptureSourceId: string | null = null
const captureDisplayIds = new Map<string, string>()

ipcMain.handle('capture:get-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: false,
  })
  const displays = screen.getAllDisplays()
  captureDisplayIds.clear()
  const displaysById = new Map<string, (typeof displays)[number]>()
  for (const display of displays) {
    displaysById.set(String(display.id), display)
  }

  return sources.map((source) => {
    captureDisplayIds.set(source.id, source.display_id)
    const display = displaysById.get(source.display_id)
    const systemLabel = display?.label?.trim()

    return {
      id: source.id,
      // Prefer the OS-provided monitor name. desktopCapturer's generic
      // "Screen 1" label is only used when the OS provides no friendly name.
      name: systemLabel || source.name || `Display ${source.display_id}`,
      displayId: source.display_id,
    }
  })
})

// Gaming Mode: running games (with icon and name) and notification blocking.
ipcMain.handle('games:list', async () => {
  try {
    return await detectRunningGames()
  } catch (error) {
    console.warn('Could not detect running games:', error)
    return { games: [], error: error instanceof Error ? error.message : 'The game scan failed.' }
  }
})

ipcMain.handle('games:resolve-target', (_event, gameId: unknown) => (
  typeof gameId === 'string' ? resolveGameTarget(gameId) : { fullscreen: false, monitorSourceId: null }
))

ipcMain.handle('game-audio:start', (_event, processId: unknown) => (
  startGameAudio(Number(processId), (chunk) => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.webContents.send('game-audio:data', chunk)
  })
))

ipcMain.handle('game-audio:stop', () => {
  stopGameAudio()
  return { success: true }
})

ipcMain.handle('notifications:set-blocked', (_event, blocked: unknown) => (
  blocked === true ? blockNotifications() : restoreNotifications()
))

ipcMain.handle('capture:set-source', (_event, sourceId: unknown) => {
  if (sourceId !== null && typeof sourceId !== 'string') {
    throw new Error('Invalid capture source.')
  }
  selectedCaptureSourceId = sourceId
  return { success: true }
})

// Cursor coordinates are normalized to the selected display so the renderer can
// apply smooth focus framing without exposing unrestricted desktop APIs.
ipcMain.handle('capture:get-cursor-position', async (_event, sourceId: unknown) => {
  if (sourceId !== null && typeof sourceId !== 'string') return null

  let display = screen.getPrimaryDisplay()
  if (sourceId) {
    let displayId = captureDisplayIds.get(sourceId)
    if (!displayId) {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1, height: 1 },
        fetchWindowIcons: false,
      })
      for (const source of sources) captureDisplayIds.set(source.id, source.display_id)
      displayId = captureDisplayIds.get(sourceId)
    }
    if (!displayId) return null
    display = screen.getAllDisplays().find(
      (item) => String(item.id) === displayId,
    ) ?? display
  }

  const point = screen.getCursorScreenPoint()
  return {
    x: (point.x - display.bounds.x) / display.bounds.width,
    y: (point.y - display.bounds.y) / display.bounds.height,
    displayWidth: display.bounds.width,
    displayHeight: display.bounds.height,
    // True only while the user holds the Mouse Focus key (see Settings).
    focusKeyHeld: isFocusKeyHeld(),
  }
})

// Mouse Focus hold key: the saved key is read from the settings file each time
// a recording starts, so a key changed and saved in Settings applies at once.
ipcMain.handle('focus-key:start', async () => {
  const settings = await getAppSettings()
  return startFocusKey(settings.mouseFocusKey)
})

ipcMain.handle('focus-key:stop', () => {
  stopFocusKey()
  return { success: true }
})

// Recording engine

ipcMain.handle('recording:start', async (_event, mode: unknown, format: unknown, metadata: unknown) => {
  const recordingMode = mode === 'gaming' ? 'gaming' : 'screen'
  const recordingFormat = format === 'mp4' ? 'mp4' : 'webm'
  const safeMetadata = metadata && typeof metadata === 'object' ? metadata as Record<string, unknown> : {}
  const result = await startRecordingSession(recordingMode, undefined, recordingFormat, safeMetadata)

  if (!result.success) {
    return result
  }

  return {
    success: true,
    message: 'Recording session created.',
    session: result.session,
  }
})

ipcMain.handle('recording:pause', async () => {
  const session = getActiveRecording()

  if (!session) {
    return {
      success: false,
      error: 'NO_ACTIVE_RECORDING',
      message: 'There is no active recording.',
    }
  }

  const success = await setRecordingPaused(session.id, true)

  return success
    ? { success: true, message: 'Recording paused.' }
    : {
        success: false,
        error: 'PAUSE_FAILED',
        message: 'Could not pause the recording.',
      }
})

ipcMain.handle('recording:resume', async () => {
  const session = getActiveRecording()

  if (!session) {
    return {
      success: false,
      error: 'NO_ACTIVE_RECORDING',
      message: 'There is no active recording.',
    }
  }

  const success = await setRecordingPaused(session.id, false)

  return success
    ? { success: true, message: 'Recording resumed.' }
    : {
        success: false,
        error: 'RESUME_FAILED',
        message: 'Could not resume the recording.',
      }
})

ipcMain.handle('recording:stop', async () => {
  stopClickEffects()
  const session = getActiveRecording()

  if (!session) {
    return {
      success: false,
      error: 'NO_ACTIVE_RECORDING',
      message: 'There is no active recording.',
    }
  }

  try {
    const completed = await stopRecordingSession(session.id)

    if (!completed) {
      return {
        success: false,
        error: 'STOP_FAILED',
        message: 'Could not finish the recording.',
      }
    }

    return {
      success: true,
      message: 'Recording saved successfully.',
      filePath: completed.filePath,
      bytesWritten: completed.bytesWritten,
    }
  } catch (error) {
    return {
      success: false,
      error: 'RECORDING_FINALIZE_FAILED',
      message: error instanceof Error
        ? error.message
        : 'Could not finalize the recording.',
    }
  }
})

// Receive video data from the renderer

ipcMain.handle(
  'recording:write-chunk',
  async (_event, sessionId: unknown, chunk: unknown) => {
    if (
      typeof sessionId !== 'string' ||
      !(chunk instanceof Uint8Array)
    ) {
      throw new Error('Invalid recording data.')
    }

    if (chunk.byteLength === 0 || chunk.byteLength > 64 * 1024 * 1024) {
      throw new Error('Recording data chunk has an invalid size.')
    }

    await writeRecordingChunk(sessionId, chunk)

    return { success: true }
  },
)



// Keyboard shortcuts

ipcMain.handle('shortcuts:apply', (_event, shortcuts: unknown) => {
  const map = parseShortcutMap(shortcuts)

  if (!map) {
    return { success: false, message: 'Invalid shortcut settings.' }
  }

  return applyShortcuts(map)
})

ipcMain.handle('shortcuts:set-suspended', (_event, value: unknown) => {
  setShortcutsSuspended(value === true)
  return { success: true }
})

// Speedrun Timer (Gaming Mode): the hotkeys are only registered while it is on.
ipcMain.handle('timer:configure', (_event, value: unknown) => {
  const raw = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  const enabled = raw.enabled === true
  setTimerShortcutsActive(enabled)
  return configureTimer({
    enabled,
    gameId: typeof raw.gameId === 'string' ? raw.gameId : '',
    position: typeof raw.position === 'string' ? raw.position : 'top-left',
  })
})

ipcMain.handle('timer:get', () => getTimerSnapshot())

// Monitoring (Gaming Mode): readers only run while it is switched on.
ipcMain.handle('monitor:configure', (_event, value: unknown) => configureMonitoring(value))

ipcMain.handle('monitor:get', () => getMonitorSnapshot())

// Area selection overlay

ipcMain.handle('area:select', async (_event, sourceId: unknown) => {
  if (sourceId !== null && typeof sourceId !== 'string') {
    throw new Error('Invalid monitor selection.')
  }

  const display = await resolveDisplay(sourceId || null)
  if (!display) return null

  // Keep the app window out of the way while the area is being chosen.
  const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
  const shouldRestore = window !== null && !window.isMinimized()
  if (shouldRestore) {
    window.minimize()
    await new Promise((resolve) => setTimeout(resolve, 250))
  }

  try {
    const rect = await selectCaptureArea(display)
    if (!rect) return null

    const pixels = process.platform === 'win32'
      ? screen.dipToScreenRect(null, {
          x: display.bounds.x + rect.x,
          y: display.bounds.y + rect.y,
          width: rect.width,
          height: rect.height,
        })
      : {
          width: Math.round(rect.width * display.scaleFactor),
          height: Math.round(rect.height * display.scaleFactor),
        }

    return {
      displayId: display.id,
      rect,
      pixelWidth: Math.floor(pixels.width / 2) * 2,
      pixelHeight: Math.floor(pixels.height / 2) * 2,
    }
  } finally {
    if (window && !window.isDestroyed() && shouldRestore) {
      window.restore()
      window.focus()
    }
  }
})

// Native screen capture engine (FFmpeg)

ipcMain.handle('native:capabilities', () => getNativeCapabilities())

ipcMain.handle('native:start', async (_event, options: unknown) => {
  if (typeof options !== 'object' || options === null) {
    return { success: false, error: 'INVALID_OPTIONS', message: 'Invalid recording options.' }
  }

  const value = options as Record<string, unknown>
  const encoder = value.encoder === 'hevc' || value.encoder === 'av1' ? value.encoder : 'h264'
  const format =
    value.format === 'mkv' || value.format === 'mov' || value.format === 'webm'
      ? value.format
      : 'mp4'
  const captureMode =
    value.captureMode === 'custom' || value.captureMode === 'area' ? value.captureMode : 'full'
  const frameRate = Math.min(120, Math.max(1, Math.round(Number(value.frameRate) || 30)))
  const bitrate = Math.min(500_000_000, Math.max(100_000, Math.round(Number(value.bitrate) || 20_000_000)))

  let area: NativeStartOptions['area'] = null
  if (typeof value.area === 'object' && value.area !== null) {
    const raw = value.area as Record<string, unknown>
    const rect = raw.rect as Record<string, unknown> | undefined
    if (
      typeof raw.displayId === 'number' &&
      rect &&
      [rect.x, rect.y, rect.width, rect.height].every(
        (part) => typeof part === 'number' && Number.isFinite(part),
      )
    ) {
      area = {
        displayId: raw.displayId,
        rect: {
          x: rect.x as number,
          y: rect.y as number,
          width: rect.width as number,
          height: rect.height as number,
        },
      }
    }
  }

  return startNativeRecording({
    monitorSourceId:
      typeof value.monitorSourceId === 'string' && value.monitorSourceId
        ? value.monitorSourceId
        : null,
    captureMode,
    resolution: typeof value.resolution === 'string' ? value.resolution : 'original',
    area,
    frameRate,
    bitrate,
    showCursor: value.showCursor !== false,
    encoder,
    format,
    hasAudio: value.hasAudio === true,
    audio:
      typeof value.audio === 'object' && value.audio !== null
        ? normalizeAudioSettings(value.audio as Record<string, unknown>, format)
        : undefined,
    clickEffects: value.clickEffects === true,
    lowLatency: value.lowLatency === true,
    camera: (() => {
      if (typeof value.camera !== 'object' || value.camera === null) return undefined
      const raw = value.camera as Record<string, unknown>
      return {
        size: typeof raw.size === 'string' ? raw.size : 'medium',
        shape: typeof raw.shape === 'string' ? raw.shape : 'rounded',
        mirror: raw.mirror === true,
        opacity: Math.min(100, Math.max(20, Number(raw.opacity) || 100)),
        position: typeof raw.position === 'string' ? raw.position : 'bottom-right',
      }
    })(),
  })
})

ipcMain.handle('native:pause', () => pauseNativeRecording())
ipcMain.handle('native:resume', () => resumeNativeRecording())
ipcMain.handle('native:stop-capture', async () => {
  const result = await stopNativeCapture()
  stopClickEffects()
  return result
})
ipcMain.handle('native:finalize', async () => {
  stopClickEffects()
  return finalizeNativeRecording()
})
ipcMain.handle('native:abort', async () => {
  stopClickEffects()
  await abortNativeRecording()
  return { success: true }
})

// Mouse Click Effects: left clicks are tracked while recording and the bubbles
// are rendered into the video only (they are never drawn on the desktop).
ipcMain.handle('click-effects:start', async (_event, sourceId: unknown) => {
  const display = await resolveDisplay(
    typeof sourceId === 'string' && sourceId ? sourceId : null,
  )
  if (!display) {
    return { success: false, message: 'The selected monitor is no longer available.' }
  }
  return startClickEffects(display)
})

ipcMain.handle('click-effects:stop', () => {
  stopClickEffects()
  return { success: true }
})

ipcMain.handle(
  'native:write-audio',
  async (_event, sessionId: unknown, chunk: unknown) => {
    if (typeof sessionId !== 'string' || !(chunk instanceof Uint8Array)) {
      throw new Error('Invalid audio data.')
    }
    if (chunk.byteLength === 0 || chunk.byteLength > 64 * 1024 * 1024) {
      throw new Error('Audio data chunk has an invalid size.')
    }
    await writeNativeAudioChunk(sessionId, chunk)
    return { success: true }
  },
)

ipcMain.handle(
  'native:write-camera',
  async (_event, sessionId: unknown, chunk: unknown) => {
    if (typeof sessionId !== 'string' || !(chunk instanceof Uint8Array)) {
      throw new Error('Invalid camera data.')
    }
    if (chunk.byteLength === 0 || chunk.byteLength > 128 * 1024 * 1024) {
      throw new Error('Camera data chunk has an invalid size.')
    }
    await writeNativeCameraChunk(sessionId, chunk)
    return { success: true }
  },
)

ipcMain.handle(
  'native:camera-started',
  (_event, sessionId: unknown, timestampMs: unknown) => {
    if (typeof sessionId !== 'string' || typeof timestampMs !== 'number') {
      throw new Error('Invalid camera timing data.')
    }
    return { success: setNativeCameraStarted(sessionId, timestampMs) }
  },
)

ipcMain.handle(
  'native:audio-started',
  (_event, sessionId: unknown, timestampMs: unknown) => {
    if (typeof sessionId !== 'string' || typeof timestampMs !== 'number') {
      throw new Error('Invalid audio timing data.')
    }
    return { success: setNativeAudioStarted(sessionId, timestampMs) }
  },
)

// Recording library
ipcMain.handle('recordings:list', async () => listRecordingFiles())

ipcMain.handle('recordings:open', async (_event, filePath: unknown) => {
  if (typeof filePath !== 'string') throw new Error('Invalid recording path.')
  const files = await listRecordingFiles()
  const file = files.find((item) => item.filePath === filePath)
  if (!file) throw new Error('Recording file was not found in the output folder.')
  const result = await shell.openPath(file.filePath)
  if (result) throw new Error(result)
  return { success: true }
})

ipcMain.handle('recordings:show-in-folder', async (_event, filePath: unknown) => {
  if (typeof filePath !== 'string') throw new Error('Invalid recording path.')
  const files = await listRecordingFiles()
  const file = files.find((item) => item.filePath === filePath)
  if (!file) throw new Error('Recording file was not found in the output folder.')
  shell.showItemInFolder(file.filePath)
  return { success: true }
})

ipcMain.handle('recordings:delete', async (_event, filePath: unknown) => {
  if (typeof filePath !== 'string') throw new Error('Invalid recording path.')
  await removeRecordingFile(filePath)
  return { success: true }
})
// Display change notifications

function registerDisplayListeners() {
  const notifyRenderer = () => {
    invalidateCaptureProbe()

    if (!mainWindow || mainWindow.isDestroyed()) return

    mainWindow.webContents.send(
      'devices:changed',
      getDisplays(),
    )
  }

  screen.on('display-added', notifyRenderer)
  screen.on('display-removed', notifyRenderer)
  screen.on('display-metrics-changed', notifyRenderer)
}

// Application lifecycle

// Keep rendering and timers running at full speed while the window is covered,
// minimized or in the background (for example while another app or a game is
// being recorded). Without this Windows throttles the recorder and the video
// stutters or freezes.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')

// Only one copy may run. A second copy (for example one that is still alive in
// the background) would fight the first one for the same global shortcuts.
const hasInstanceLock = app.requestSingleInstanceLock()
if (!hasInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })
}

app.whenReady().then(() => {
  if (!hasInstanceLock) return
  // If the app was closed unexpectedly while notifications were blocked.
  restoreNotifications()

  // Warm FFmpeg's encoder list in the background. The first recording after
  // launch should not pay this process-startup cost when the user presses Stop.
  void warmEncoderAvailability().catch((error: unknown) => {
    console.warn('Could not pre-load FFmpeg encoder information:', error)
  })

  // Probe the screen grabber outputs shortly after start-up (not during the
  // first paint) so the first recording starts without that delay.
  setTimeout(() => {
    void warmCaptureProbe().catch(() => undefined)
  }, 2_500)

  // Electron requires an explicit display-media request handler for
  // navigator.mediaDevices.getDisplayMedia() in desktop applications.
  // Prefer the native Windows picker where available; use the first screen
  // as a safe fallback on systems without the native picker.
  session.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({
          types: ['screen', 'window'],
          thumbnailSize: { width: 320, height: 180 },
          fetchWindowIcons: false,
        })
        const source = selectedCaptureSourceId?.startsWith('game:')
          ? pickCaptureSource(selectedCaptureSourceId, sources)
          : selectedCaptureSourceId
          ? sources.find((item) => item.id === selectedCaptureSourceId)
          : sources.find((item) =>
              item.id.startsWith('screen:') &&
              item.display_id === String(screen.getPrimaryDisplay().id),
            ) ??
            sources.find((item) => item.id.startsWith('screen:'))

        // Do not silently capture a different monitor if the selected display
        // was disconnected between selection and recording start.
        if (!source) {
          callback({})
          return
        }
        callback({ video: source , audio: 'loopback',})
      } catch {
        callback({})
      }
    },
    { useSystemPicker: false },
  )

  registerDisplayListeners()

  setTimerListener((snapshot) => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.webContents.send('timer:state', snapshot)
  })

  setMonitorListener((snapshot) => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.webContents.send('monitor:state', snapshot)
  })

  setShortcutDispatcher((action) => {
    if (action === 'timerToggle' || action === 'timerPause' || action === 'timerReset') {
      runTimerAction(action)
      return
    }
    if (!mainWindow || mainWindow.isDestroyed()) return
    const target = mainWindow.webContents
    // Starting a screen capture needs a user gesture in the page. A shortcut
    // pressed in another program is not one, so the page is given a gesture
    // first; this is what lets the shortcuts work without clicking the app.
    void target.executeJavaScript('void 0', true)
      .catch(() => undefined)
      .then(() => {
        if (!target.isDestroyed()) target.send('shortcut:triggered', action)
      })
  })

  void getAppSettings().then((settings) => {
    const map = parseShortcutMap(settings.shortcuts)
    if (!map) return

    // Start-up registration never gives up on all keys because one is taken.
    const result = applyShortcuts(map, true)
    if (!result.success) console.warn(result.message)
  })

  // Live clicks are forwarded to the renderer for the canvas based capture.
  setClickListener((click) => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.webContents.send('click-effects:click', { x: click.x, y: click.y })
  })

  onNativeCaptureError((message) => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.webContents.send('native:error', message)
  })

  void createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow()
    }
  })
})

app.on('will-quit', () => {
  restoreNotifications()
  stopGameAudio()
  stopClickEffects()
  stopFocusKey()
  disposeTimer()
  disposeMonitoring()
  releaseShortcuts()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
