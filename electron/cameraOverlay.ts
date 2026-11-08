import { BrowserWindow, type Display } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { cameraBox } from '../src/recording/cameraLayout'

// ---------------------------------------------------------------------------
// Webcam overlay.
//
// A small transparent, click-through window shows the camera picture in the
// bottom-right corner of the recorded region. It sits on the desktop, so both
// capture engines (FFmpeg Desktop Duplication and Chromium display capture)
// record it together with the screen. The window is created only while a
// recording runs, so it costs nothing the rest of the time.
// ---------------------------------------------------------------------------

const currentDir = path.dirname(fileURLToPath(import.meta.url))

export type CameraOverlayOptions = {
  deviceId: string
  size: string
  shape: string
  mirror: boolean
  opacity: number
}

export type CameraRegion = { x: number; y: number; width: number; height: number }

let overlay: BrowserWindow | null = null

export function stopCameraOverlay(): void {
  const current = overlay
  overlay = null
  if (current && !current.isDestroyed()) current.destroy()
}

export async function startCameraOverlay(
  display: Display,
  region: CameraRegion,
  options: CameraOverlayOptions,
): Promise<{ success: boolean; message?: string }> {
  stopCameraOverlay()

  const box = cameraBox(region.width, region.height, options.size, options.shape)
  const bounds = {
    x: Math.round(display.bounds.x + region.x + box.x),
    y: Math.round(display.bounds.y + region.y + box.y),
    width: box.width,
    height: box.height,
  }

  const window = new BrowserWindow({
    ...bounds,
    useContentSize: true,
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
    show: false,
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
  window.setBounds(bounds)
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.on('closed', () => {
    if (overlay === window) overlay = null
  })

  const params = new URLSearchParams({
    device: options.deviceId,
    shape: options.shape,
    mirror: options.mirror ? '1' : '0',
    opacity: String(Math.max(20, Math.min(100, Math.round(options.opacity)))),
  })
  const hash = `camera-overlay?${params.toString()}`

  // The overlay page reports through its title: camera-ready / camera-error.
  const ready = new Promise<{ success: boolean; message?: string }>((resolve) => {
    const timer = setTimeout(
      () => resolve({ success: false, message: 'The camera did not start in time.' }),
      6000,
    )
    window.webContents.on('page-title-updated', (event, title) => {
      event.preventDefault()
      if (title === 'camera-ready') {
        clearTimeout(timer)
        resolve({ success: true })
      } else if (title === 'camera-error') {
        clearTimeout(timer)
        resolve({ success: false, message: 'The selected camera could not be opened.' })
      }
    })
    window.webContents.once('did-fail-load', () => {
      clearTimeout(timer)
      resolve({ success: false, message: 'The camera overlay could not be loaded.' })
    })
  })

  try {
    if (process.env.VITE_DEV_SERVER_URL) {
      await window.loadURL(`${process.env.VITE_DEV_SERVER_URL}#${hash}`)
    } else {
      await window.loadFile(path.join(currentDir, '../dist/index.html'), { hash })
    }
  } catch {
    stopCameraOverlay()
    return { success: false, message: 'The camera overlay could not be loaded.' }
  }

  const result = await ready
  if (!result.success || window.isDestroyed()) {
    stopCameraOverlay()
    return result.success ? { success: false, message: 'The camera overlay was closed.' } : result
  }

  window.showInactive()
  return { success: true }
}
