
export type DisplayInfo = {
  id: number
  index: number
  label: string
  width: number
  height: number
  scaleFactor: number
  bounds: {
    x: number
    y: number
    width: number
    height: number
  }
  isPrimary: boolean
  rotation: number
}

export type SystemInfo = {
  platform: string
  architecture: string
  operatingSystem: string
  electronVersion: string
  chromeVersion: string
  nodeVersion: string
  appVersion: string
}

export type AppSettings = Record<string, unknown>

export type RecordingMode = 'screen' | 'gaming'

export type RecordingStatus =
  | 'idle'
  | 'preparing'
  | 'countdown'
  | 'recording'
  | 'paused'
  | 'stopping'
  | 'error'

export type RecordingSessionInfo = {
  id: string
  mode: RecordingMode
  filePath: string
  startedAt: number
  bytesWritten: number
  status: 'recording' | 'paused' | 'stopped' | 'error'
}

export type RecordingStatusEvent = {
  status: RecordingStatus
  elapsedSeconds?: number
  message?: string
}

export type RecordingCommandResult =
  | {
      success: true
      message?: string
      session?: RecordingSessionInfo
      filePath?: string
      bytesWritten?: number
    }
  | {
      success: false
      error: string
      message: string
    }

export type RecordingMetadata = {
  mode: RecordingMode
  format: string
  codec: string
  resolution: string
  width: number | null
  height: number | null
  frameRate: number
  bitrate: number
  captureMode: 'full' | 'custom' | 'area'
  /** Video codec inside the temporary capture (lets matching H.264 be stream-copied). */
  captureCodec?: 'h264' | 'other'
  /** Audio output settings used when the recording is finalized. */
  audio?: AudioOutputSettings
  /** Gaming Mode: constant or variable frame rate in the final file. */
  frameRateMode?: 'cfr' | 'vfr'
  /** Gaming Mode: low latency capture and encoding. */
  lowLatency?: boolean
  /** Gaming Mode: 10-bit HDR10 (BT.2020 / PQ) output. */
  hdr?: boolean
}

export type RecordingFileInfo = {
  name: string
  filePath: string
  size: number
  createdAt: number
  modifiedAt: number
  duration: number | null
  format: string
  metadata?: RecordingMetadata
}

export type SettingsSaveResult = {
  success: true
}

export type AreaRect = {
  x: number
  y: number
  width: number
  height: number
}

export type AreaSelection = {
  displayId: number
  rect: AreaRect
  /** Size of the selection in real screen pixels (informational). */
  pixelWidth?: number
  pixelHeight?: number
}

export type NativeCapabilities = {
  available: boolean
  reason: string
  encoders: Record<'h264' | 'hevc' | 'av1', string[]>
  /** Audio codecs the bundled FFmpeg can encode. */
  audioCodecs: Array<'aac' | 'opus' | 'mp3' | 'flac' | 'pcm'>
}

export type AudioOutputSettings = {
  codec: 'aac' | 'opus' | 'mp3' | 'flac' | 'pcm'
  bitrateKbps: number
  channels: 'stereo' | 'mono'
  sampleRate: number
}

export type NativeStartOptions = {
  monitorSourceId: string | null
  captureMode: 'full' | 'custom' | 'area'
  resolution: string
  area: AreaSelection | null
  frameRate: number
  bitrate: number
  showCursor: boolean
  encoder: 'h264' | 'hevc' | 'av1'
  format: 'mp4' | 'mkv' | 'mov' | 'webm'
  hasAudio: boolean
  audio?: AudioOutputSettings
  clickEffects?: boolean
  /** Fastest encoder settings (Gaming Mode: Low Latency Capture). */
  lowLatency?: boolean
  camera?: {
    size: string
    shape: string
    mirror: boolean
    opacity: number
    position: string
  }
}

export type NativeStartResult =
  | {
      success: true
      session: {
        id: string
        filePath: string
        encoderName: string
        backend: 'ddagrab' | 'gdigrab'
        width: number
        height: number
        firstFrameAt: number
      }
    }
  | { success: false; error: string; message: string }

export type NativeFinalizeResult =
  | { success: true; filePath: string; bytesWritten: number }
  | { success: false; message: string }

export type { ShortcutAction, ShortcutMap } from '../shared/shortcutDefaults'
import type { ShortcutAction, ShortcutMap } from '../shared/shortcutDefaults'
import type { TimerSnapshot } from '../recording/timerLayout'

export type { TimerSnapshot }

/** Speedrun Timer settings of Gaming Mode. */
export type TimerConfig = {
  enabled: boolean
  gameId: string
  position: string
}

import type { MonitorMetric, MonitorSnapshot } from '../recording/monitorLayout'

export type { MonitorSnapshot }

/** Monitoring settings of Gaming Mode. */
export type MonitorConfig = {
  enabled: boolean
  gameId: string
  gameProcessId: number
  position: string
  metrics: MonitorMetric[]
}

export type Unsubscribe = () => void

export type DetectedGame = {
  /** Window capture source id of the running game. */
  id: string
  name: string
  exeName: string
  pid: number
  /** Executable icon as a data URL (empty when unavailable). */
  icon: string
  /** True when the program was recognized as a game. */
  isGame: boolean
}

export interface ElectronAPI {
  readonly platform: string

  minimize: () => Promise<void>
  toggleMaximize: () => Promise<boolean>
  close: () => Promise<void>
  isMaximized: () => Promise<boolean>
  setRecordingOverlay: (state: RecordingStatus) => Promise<void>
  onMaximizedChange: (callback: (maximized: boolean) => void) => Unsubscribe

  startRecording: (mode?: RecordingMode, format?: 'webm' | 'mp4', metadata?: RecordingMetadata) => Promise<RecordingCommandResult>
  pauseRecording: () => Promise<RecordingCommandResult>
  resumeRecording: () => Promise<RecordingCommandResult>
  stopRecording: () => Promise<RecordingCommandResult>

  writeRecordingChunk: (
    sessionId: string,
    chunk: Uint8Array,
  ) => Promise<{ success: true }>

  getSystemInfo: () => Promise<SystemInfo>
  getDisplays: () => Promise<DisplayInfo[]>
  getCaptureSources: () => Promise<Array<{ id: string; name: string; displayId: string }>>
  getCursorPosition: (sourceId: string | null) => Promise<{ x: number; y: number; displayWidth: number; displayHeight: number; focusKeyHeld?: boolean } | null>
  startFocusKey: () => Promise<{ success: boolean; message?: string }>
  stopFocusKey: () => Promise<{ success: true }>
  selectCaptureArea: (sourceId: string | null) => Promise<AreaSelection | null>

  applyShortcuts: (
    shortcuts: ShortcutMap,
  ) => Promise<{ success: true } | { success: false; message: string }>
  setShortcutsSuspended: (suspended: boolean) => Promise<{ success: true }>
  onShortcut: (callback: (action: ShortcutAction) => void) => Unsubscribe

  // Speedrun Timer (clock and hotkeys live in the main process)
  configureTimer: (config: TimerConfig) => Promise<TimerSnapshot>
  getTimerState: () => Promise<TimerSnapshot>
  onTimerState: (callback: (snapshot: TimerSnapshot) => void) => Unsubscribe

  // Monitoring (readers and the on-screen panel live in the main process)
  configureMonitor: (config: MonitorConfig) => Promise<MonitorSnapshot>
  getMonitorState: () => Promise<MonitorSnapshot>
  onMonitorState: (callback: (snapshot: MonitorSnapshot) => void) => Unsubscribe

  nativeCapabilities: () => Promise<NativeCapabilities>
  nativeStart: (options: NativeStartOptions) => Promise<NativeStartResult>
  nativePause: () => Promise<{ success: boolean; message: string }>
  nativeResume: () => Promise<{ success: boolean; message: string; firstFrameAt?: number }>
  nativeStopCapture: () => Promise<{ success: boolean; message: string }>
  nativeFinalize: () => Promise<NativeFinalizeResult>
  nativeAbort: () => Promise<{ success: true }>
  nativeWriteAudio: (sessionId: string, chunk: Uint8Array) => Promise<{ success: true }>
  nativeAudioStarted: (sessionId: string, timestampMs: number) => Promise<{ success: boolean }>
  nativeWriteCamera: (sessionId: string, chunk: Uint8Array) => Promise<{ success: true }>
  nativeCameraStarted: (sessionId: string, timestampMs: number) => Promise<{ success: boolean }>
  onNativeError: (callback: (message: string) => void) => Unsubscribe
  setCaptureSource: (sourceId: string | null) => Promise<{ success: boolean }>
  listGames: () => Promise<{ games: DetectedGame[]; error?: string }>
  resolveGameTarget: (gameId: string) => Promise<{ fullscreen: boolean; monitorSourceId: string | null }>
  startGameAudio: (processId: number) => Promise<{ success: boolean; message: string }>
  stopGameAudio: () => Promise<{ success: true }>
  onGameAudio: (callback: (chunk: Uint8Array) => void) => Unsubscribe
  setNotificationsBlocked: (blocked: boolean) => Promise<{ success: boolean; message: string }>

  startClickEffects: (sourceId: string | null) => Promise<{ success: boolean; message?: string }>
  stopClickEffects: () => Promise<{ success: true }>
  onClickEffect: (callback: (click: { x: number; y: number }) => void) => Unsubscribe

  getSettings: () => Promise<AppSettings>
  saveSettings: (settings: AppSettings) => Promise<SettingsSaveResult>
  selectOutputDirectory: () => Promise<string | null>

  listRecordings: () => Promise<RecordingFileInfo[]>
  openRecording: (filePath: string) => Promise<{ success: true }>
  showRecordingInFolder: (filePath: string) => Promise<{ success: true }>
  deleteRecording: (filePath: string) => Promise<{ success: true }>

  onRecordingStatus: (
    callback: (status: RecordingStatusEvent) => void,
  ) => Unsubscribe

  onDevicesChanged: (
    callback: (displays: DisplayInfo[]) => void,
  ) => Unsubscribe
}
