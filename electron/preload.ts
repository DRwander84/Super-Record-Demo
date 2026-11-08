
import { contextBridge, ipcRenderer } from 'electron'

import type {
  ElectronAPI,
  RecordingStatusEvent,
  DisplayInfo,
  RecordingFileInfo,
  RecordingMode,
  RecordingMetadata,
  NativeStartOptions,
  ShortcutAction,
  ShortcutMap,
  TimerSnapshot,
  MonitorSnapshot,
} from '../src/types/electron'

const electronAPI: ElectronAPI = {
  platform: process.platform,

  // Window controls
  minimize: () => ipcRenderer.invoke('window:minimize'),

  toggleMaximize: () =>
    ipcRenderer.invoke('window:toggle-maximize'),

  close: () => ipcRenderer.invoke('window:close'),

  isMaximized: () => ipcRenderer.invoke('window:is-maximized'),

  setRecordingOverlay: (state) =>
    ipcRenderer.invoke('window:set-recording-overlay', state),

  onMaximizedChange: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      maximized: boolean,
    ) => {
      callback(maximized)
    }

    ipcRenderer.on('window:maximized-changed', listener)

    return () => {
      ipcRenderer.removeListener('window:maximized-changed', listener)
    }
  },

  // Recording controls
  startRecording: (mode: RecordingMode = 'screen', format: 'webm' | 'mp4' = 'webm', metadata?: RecordingMetadata) =>
    ipcRenderer.invoke('recording:start', mode, format, metadata),

  pauseRecording: () =>
    ipcRenderer.invoke('recording:pause'),

  resumeRecording: () =>
    ipcRenderer.invoke('recording:resume'),

  stopRecording: () =>
    ipcRenderer.invoke('recording:stop'),

  writeRecordingChunk: (sessionId, chunk) =>
    ipcRenderer.invoke(
      'recording:write-chunk',
      sessionId,
      chunk,
    ),

  // System information
  getSystemInfo: () =>
    ipcRenderer.invoke('system:get-info'),

  getDisplays: () =>
    ipcRenderer.invoke('system:get-displays'),

  getCaptureSources: () => ipcRenderer.invoke('capture:get-sources'),
  getCursorPosition: (sourceId) => ipcRenderer.invoke('capture:get-cursor-position', sourceId),
  startFocusKey: () => ipcRenderer.invoke('focus-key:start'),
  stopFocusKey: () => ipcRenderer.invoke('focus-key:stop'),
  setCaptureSource: (sourceId) => ipcRenderer.invoke('capture:set-source', sourceId),
  listGames: () => ipcRenderer.invoke('games:list'),
  resolveGameTarget: (gameId) => ipcRenderer.invoke('games:resolve-target', gameId),
  startGameAudio: (processId) => ipcRenderer.invoke('game-audio:start', processId),
  stopGameAudio: () => ipcRenderer.invoke('game-audio:stop'),
  onGameAudio: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, chunk: Uint8Array) => {
      callback(chunk)
    }
    ipcRenderer.on('game-audio:data', listener)
    return () => {
      ipcRenderer.removeListener('game-audio:data', listener)
    }
  },
  setNotificationsBlocked: (blocked) => ipcRenderer.invoke('notifications:set-blocked', blocked),
  selectCaptureArea: (sourceId) => ipcRenderer.invoke('area:select', sourceId),

  // Native capture engine
  nativeCapabilities: () => ipcRenderer.invoke('native:capabilities'),
  nativeStart: (options: NativeStartOptions) => ipcRenderer.invoke('native:start', options),
  nativePause: () => ipcRenderer.invoke('native:pause'),
  nativeResume: () => ipcRenderer.invoke('native:resume'),
  nativeStopCapture: () => ipcRenderer.invoke('native:stop-capture'),
  nativeFinalize: () => ipcRenderer.invoke('native:finalize'),
  nativeAbort: () => ipcRenderer.invoke('native:abort'),
  nativeWriteAudio: (sessionId, chunk) =>
    ipcRenderer.invoke('native:write-audio', sessionId, chunk),
  nativeWriteCamera: (sessionId, chunk) =>
    ipcRenderer.invoke('native:write-camera', sessionId, chunk),
  nativeCameraStarted: (sessionId, timestampMs) =>
    ipcRenderer.invoke('native:camera-started', sessionId, timestampMs),
  nativeAudioStarted: (sessionId, timestampMs) =>
    ipcRenderer.invoke('native:audio-started', sessionId, timestampMs),
  onNativeError: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, message: string) => {
      callback(message)
    }

    ipcRenderer.on('native:error', listener)

    return () => {
      ipcRenderer.removeListener('native:error', listener)
    }
  },

  // Mouse Click Effects
  startClickEffects: (sourceId) => ipcRenderer.invoke('click-effects:start', sourceId),
  stopClickEffects: () => ipcRenderer.invoke('click-effects:stop'),
  onClickEffect: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      click: { x: number; y: number },
    ) => {
      callback(click)
    }

    ipcRenderer.on('click-effects:click', listener)

    return () => {
      ipcRenderer.removeListener('click-effects:click', listener)
    }
  },

  // Application settings
  getSettings: () =>
    ipcRenderer.invoke('settings:get'),

  saveSettings: (settings) =>
    ipcRenderer.invoke('settings:save', settings),

  selectOutputDirectory: () =>
    ipcRenderer.invoke('settings:select-output-directory'),

  listRecordings: () =>
    ipcRenderer.invoke('recordings:list') as Promise<RecordingFileInfo[]>,

  openRecording: (filePath) =>
    ipcRenderer.invoke('recordings:open', filePath),

  showRecordingInFolder: (filePath) =>
    ipcRenderer.invoke('recordings:show-in-folder', filePath),

  deleteRecording: (filePath) =>
    ipcRenderer.invoke('recordings:delete', filePath),

  // Keyboard shortcuts
  applyShortcuts: (shortcuts: ShortcutMap) =>
    ipcRenderer.invoke('shortcuts:apply', shortcuts),

  setShortcutsSuspended: (suspended: boolean) =>
    ipcRenderer.invoke('shortcuts:set-suspended', suspended),

  onShortcut: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      action: ShortcutAction,
    ) => {
      callback(action)
    }

    ipcRenderer.on('shortcut:triggered', listener)

    return () => {
      ipcRenderer.removeListener('shortcut:triggered', listener)
    }
  },

  // Speedrun Timer
  configureTimer: (config) => ipcRenderer.invoke('timer:configure', config),

  getTimerState: () => ipcRenderer.invoke('timer:get'),

  onTimerState: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      snapshot: TimerSnapshot,
    ) => {
      callback(snapshot)
    }

    ipcRenderer.on('timer:state', listener)

    return () => {
      ipcRenderer.removeListener('timer:state', listener)
    }
  },

  // Monitoring
  configureMonitor: (config) => ipcRenderer.invoke('monitor:configure', config),

  getMonitorState: () => ipcRenderer.invoke('monitor:get'),

  onMonitorState: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      snapshot: MonitorSnapshot,
    ) => {
      callback(snapshot)
    }

    ipcRenderer.on('monitor:state', listener)

    return () => {
      ipcRenderer.removeListener('monitor:state', listener)
    }
  },

  // Recording status subscription
  onRecordingStatus: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      status: RecordingStatusEvent,
    ) => {
      callback(status)
    }

    ipcRenderer.on('recording:status', listener)

    return () => {
      ipcRenderer.removeListener('recording:status', listener)
    }
  },

  // Display change subscription
  onDevicesChanged: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      displays: DisplayInfo[],
    ) => {
      callback(displays)
    }

    ipcRenderer.on('devices:changed', listener)

    return () => {
      ipcRenderer.removeListener('devices:changed', listener)
    }
  },
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)

// Used by the dark area-selection overlay window.
contextBridge.exposeInMainWorld('areaApi', {
  confirm: (rect: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.send('area:confirm', rect),
  cancel: () => ipcRenderer.send('area:cancel'),
})
