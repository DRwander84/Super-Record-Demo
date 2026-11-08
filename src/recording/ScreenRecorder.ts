
import { cameraBox, drawCameraFrame, CAMERA_CORNER_RADIUS } from './cameraLayout'
import { drawTimerBadge, formatTimer, timerBox, timerElapsed, type TimerSnapshot } from './timerLayout'
import {
  buildMonitorRows,
  drawMonitorPanel,
  monitorPanelBox,
  type MonitorMetric,
  type MonitorPanel,
  type MonitorRow,
  type MonitorSnapshot,
} from './monitorLayout'
import type {
  RecordingSessionInfo,
  RecordingMode,
  AreaSelection,
  AudioOutputSettings,
} from '../types/electron'

export type RecorderState =
  | 'idle'
  | 'recording'
  | 'paused'
  | 'stopping'
  | 'error'

export type CameraOptions = {
  deviceId: string
  size: string
  shape: string
  mirror: boolean
  opacity: number
  position: string
}

export type MonitorOptions = {
  position: string
  metrics: MonitorMetric[]
}

type ScreenRecorderOptions = {
  frameRate?: number
  videoBitsPerSecond?: number
  microphoneEnabled?: boolean
  systemAudioEnabled?: boolean
  microphoneDeviceId?: string
  /** Webcam picture recorded in the corner of the screen. */
  camera?: CameraOptions
  showCursor?: boolean
  clickEffects?: boolean
  audio?: AudioOutputSettings
  mouseFocus?: boolean
  mouseZoomLevel?: number
  mouseZoomSpeed?: 'slow' | 'normal' | 'fast'
  resolution?: string
  captureMode?: 'full' | 'custom' | 'area'
  monitorId?: string
  encoder?: 'av1' | 'h264' | 'hevc'
  outputFormat?: 'webm' | 'mp4' | 'mkv' | 'mov'
  mode?: RecordingMode
  area?: AreaSelection | null
  /** Gaming Mode video options. */
  frameRateMode?: 'cfr' | 'vfr'
  lowLatency?: boolean
  hdr?: boolean
  /** Gaming Mode: the selected program (window id and process id). */
  gameId?: string
  gameProcessId?: number
  /** Gaming Mode Speedrun Timer position; empty or missing when it is off. */
  timerPosition?: string
  /** Gaming Mode Monitoring panel drawn into the video; missing when it is off. */
  monitor?: MonitorOptions
  onStateChange?: (state: RecorderState) => void
  onError?: (message: string) => void
}

type RecorderResult =
  | {
      success: true
      message: string
      filePath?: string
      session?: RecordingSessionInfo
    }
  | {
      success: false
      message: string
    }

export class ScreenRecorder {
  private mediaStream: MediaStream | null = null
  private microphoneStream: MediaStream | null = null
  private captureStream: MediaStream | null = null
  private mediaRecorder: MediaRecorder | null = null
  private renderVideo: HTMLVideoElement | null = null
  private animationFrame = 0
  private session: RecordingSessionInfo | null = null

  private state: RecorderState = 'idle'
  private frameRate: number
  private videoBitsPerSecond: number
  private microphoneEnabled: boolean
  private systemAudioEnabled: boolean
  private microphoneDeviceId?: string
  private camera: CameraOptions | undefined
  private cameraStream: MediaStream | null = null
  private cameraRecorder: MediaRecorder | null = null
  private cameraWriteQueue: Promise<void> = Promise.resolve()
  private cameraWriteError: string | null = null
  private audioContext: AudioContext | null = null
  private showCursor: boolean
  private clickEffects: boolean
  private audio: AudioOutputSettings | undefined
  private mouseFocus: boolean
  private mouseZoomLevel: number
  private mouseZoomSpeed: 'slow' | 'normal' | 'fast'
  private cursorPollTimer: ReturnType<typeof setInterval> | null = null
  private drawTimer: ReturnType<typeof setInterval> | null = null
  private latestCursor: { x: number; y: number; displayWidth: number; displayHeight: number } | null = null
  private resolution: NonNullable<ScreenRecorderOptions['resolution']>
  private captureMode: NonNullable<ScreenRecorderOptions['captureMode']>
  private monitorId?: string
  private encoder: 'av1' | 'h264' | 'hevc'
  private outputFormat: 'webm' | 'mp4' | 'mkv' | 'mov'
  private mode: RecordingMode
  private gameId: string
  private gameProcessId: number
  private timerPosition: string
  private timerUnsubscribe: (() => void) | null = null
  private monitor: MonitorOptions | undefined
  private monitorUnsubscribe: (() => void) | null = null
  // Monitor chosen for the native engine when a game runs full screen.
  private nativeMonitorId: string | null = null
  private gameAudioUnsubscribe: (() => void) | null = null
  private gameAudioNode: ScriptProcessorNode | null = null
  private gameAudioActive = false
  private frameRateMode: 'cfr' | 'vfr'
  private lowLatency: boolean
  private hdr: boolean
  private area: AreaSelection | null

  // Native (FFmpeg) screen capture: video is captured and encoded by the
  // main process, the renderer only supplies the microphone / system audio.
  private nativeSessionId: string | null = null
  private audioRecorder: MediaRecorder | null = null
  private audioWriteQueue: Promise<void> = Promise.resolve()
  private audioWriteError: string | null = null
  private nativeErrorUnsubscribe: (() => void) | null = null
  private clickUnsubscribe: (() => void) | null = null

  private onStateChange?: (state: RecorderState) => void
  private onError?: (message: string) => void

  private writeQueue: Promise<void> = Promise.resolve()
  private writeError: string | null = null
  private stoppingPromise: Promise<RecorderResult> | null = null

  constructor(options: ScreenRecorderOptions = {}) {
    this.frameRate = options.frameRate ?? 30
    this.videoBitsPerSecond =
      options.videoBitsPerSecond ?? 20_000_000
    this.microphoneEnabled = options.microphoneEnabled ?? false
    this.systemAudioEnabled = options.systemAudioEnabled ?? false
    this.microphoneDeviceId = options.microphoneDeviceId
    this.camera = options.camera
    this.showCursor = options.showCursor ?? true
    // Click bubbles only make sense while the cursor itself is recorded.
    this.clickEffects = (options.clickEffects ?? false) && this.showCursor
    this.audio = options.audio
    this.mouseFocus = options.mouseFocus ?? false
    this.mouseZoomLevel = Math.max(1.5, Math.min(3, options.mouseZoomLevel ?? 2))
    this.mouseZoomSpeed = options.mouseZoomSpeed ?? 'normal'
    this.resolution = options.resolution ?? 'original'
    this.captureMode = options.captureMode ?? 'full'
    this.monitorId = options.monitorId
    this.encoder = options.encoder ?? 'h264'
    this.outputFormat = options.outputFormat ?? 'webm'
    this.mode = options.mode ?? 'screen'
    this.frameRateMode = options.frameRateMode ?? 'cfr'
    this.gameId = options.gameId ?? ''
    this.gameProcessId = options.gameProcessId ?? 0
    this.timerPosition = options.timerPosition ?? ''
    this.monitor = options.monitor
    this.lowLatency = options.lowLatency ?? false
    this.hdr = options.hdr ?? false
    this.area = options.area ?? null

    this.onStateChange = options.onStateChange
    this.onError = options.onError
  }

  getState(): RecorderState {
    return this.state
  }

  private setState(state: RecorderState): void {
    this.state = state
    this.onStateChange?.(state)
  }

  private reportError(error: unknown): string {
    const message =
      error instanceof Error
        ? error.message
        : 'An unexpected recording error occurred.'

    this.onError?.(message)
    return message
  }

  /** True when only the selected program's sound (not the whole PC) is recorded. */
  private usesGameAudio(): boolean {
    return this.mode === 'gaming' && this.systemAudioEnabled && this.gameProcessId > 0
  }

  /**
   * Feeds the selected program's own audio (captured per process by the main
   * process) into the recording mix. Nothing else that plays is recorded.
   */
  private async attachGameAudio(
    context: AudioContext,
    destination: MediaStreamAudioDestinationNode,
  ): Promise<void> {
    const queue: Int16Array[] = []
    let queuedFrames = 0
    let offset = 0
    let carry = new Uint8Array(0)
    let playing = false

    this.gameAudioUnsubscribe?.()
    this.gameAudioUnsubscribe = window.electronAPI.onGameAudio((chunk) => {
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as ArrayBufferLike)
      const merged = new Uint8Array(carry.length + bytes.length)
      merged.set(carry)
      merged.set(bytes, carry.length)
      const usable = merged.length - (merged.length % 4)
      carry = merged.slice(usable)
      if (usable === 0) return
      queue.push(new Int16Array(merged.buffer.slice(0, usable)))
      queuedFrames += usable / 4
      // Never let the queue grow beyond one second.
      while (queuedFrames > 48000 && queue.length > 1) {
        queuedFrames -= (queue.shift()?.length ?? 0) / 2
        offset = 0
      }
    })

    const started = await window.electronAPI.startGameAudio(this.gameProcessId)
    if (!started.success) {
      this.gameAudioUnsubscribe?.()
      this.gameAudioUnsubscribe = null
      throw new Error(`Game Audio could not start: ${started.message}`)
    }
    this.gameAudioActive = true

    const node = context.createScriptProcessor(2048, 0, 2)
    node.onaudioprocess = (event) => {
      const left = event.outputBuffer.getChannelData(0)
      const right = event.outputBuffer.getChannelData(1)
      // A short pre-buffer keeps the sound smooth when data arrives in bursts.
      if (!playing && queuedFrames >= 4800) playing = true
      for (let index = 0; index < left.length; index++) {
        if (!playing || queue.length === 0) {
          left[index] = 0
          right[index] = 0
          if (queue.length === 0) playing = false
          continue
        }
        const current = queue[0]
        left[index] = current[offset] / 32768
        right[index] = current[offset + 1] / 32768
        offset += 2
        queuedFrames -= 1
        if (offset >= current.length) {
          queue.shift()
          offset = 0
        }
      }
    }
    node.connect(destination)
    this.gameAudioNode = node
  }

  /**
   * Mouse Focus is rendered into a canvas in Chromium. Always capture that
   * canvas using a broadly supported intermediate format; the main process
   * transcodes it to the user's selected codec/container with FFmpeg.
   */
  private getSupportedMimeType(): string {
    // Mouse Focus records a live canvas, so the encoder must keep up in real
    // time: H.264 (GPU accelerated, also lets Stop finish instantly through a
    // stream copy) first, then VP8 (fast), and heavy software VP9 last.
    const candidates = (this.mouseFocus && this.mode === 'screen') || this.mode === 'gaming'
      ? [
          'video/webm;codecs=h264,opus',
          'video/webm;codecs=avc1,opus',
          'video/webm;codecs=h264',
          'video/webm;codecs=avc1',
          'video/webm;codecs=vp8,opus',
          'video/webm;codecs=vp8',
          'video/webm;codecs=vp9,opus',
          'video/webm;codecs=vp9',
          'video/webm',
        ]
      : [
          'video/webm;codecs=vp9,opus',
          'video/webm;codecs=vp9',
          'video/webm;codecs=vp8,opus',
          'video/webm;codecs=vp8',
          'video/webm',
        ]
    return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? ''
  }

  private async createOutputStream(source: MediaStream): Promise<MediaStream> {
    const track = source.getVideoTracks()[0]
    if (!track) throw new Error('No screen video track was provided.')

    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    video.srcObject = new MediaStream([track])
    await video.play()

    // The selected display's capture track reports the actual captured pixel
    // dimensions. Full Screen must preserve these values exactly and must not
    // inherit a previously saved Custom Resolution setting.
    const trackSettings = track.getSettings()
    const sourceWidth = trackSettings.width || video.videoWidth
    const sourceHeight = trackSettings.height || video.videoHeight

    if (!sourceWidth || !sourceHeight) {
      throw new Error('Could not determine the selected display capture resolution.')
    }

    const targetResolutions: Record<string, { width: number; height: number }> = {
      '4k': { width: 3840, height: 2160 },
      '1440p': { width: 2560, height: 1440 },
      '1080p': { width: 1920, height: 1080 },
      '720p': { width: 1280, height: 720 },
      '540p': { width: 960, height: 540 },
      '480p': { width: 854, height: 480 },
      '360p': { width: 640, height: 360 },
      '240p': { width: 426, height: 240 },
      '144p': { width: 256, height: 144 },
    }

    const customTarget =
      this.captureMode === 'custom' && this.resolution !== 'original'
        ? targetResolutions[this.resolution]
        : undefined

    // Native Full Screen capture needs no canvas conversion. Keeping the original
    // display track avoids renderer animation-frame throttling and reduces CPU use.
    // Gaming Mode with the webcam on also needs the canvas, which composes the
    // camera picture into the recorded video.
    // The Speedrun Timer is drawn into the picture only when a game window is
    // captured. A captured monitor already contains the timer overlay window.
    const drawsTimer = this.mode === 'gaming' &&
      this.timerPosition !== '' &&
      (track.getSettings() as MediaTrackSettings & { displaySurface?: string }).displaySurface !== 'monitor'
    // The Monitoring panel follows the same rule as the timer.
    const drawsMonitor = this.mode === 'gaming' &&
      Boolean(this.monitor) &&
      (track.getSettings() as MediaTrackSettings & { displaySurface?: string }).displaySurface !== 'monitor'
    if (!customTarget && !this.mouseFocus && !(this.mode === 'gaming' && (this.camera || drawsTimer || drawsMonitor))) {
      this.renderVideo = video
      return new MediaStream([track, ...source.getAudioTracks()])
    }

    if (this.mouseFocus) {
      // Mouse Focus zooms only while the user holds the hold key chosen in Settings.
      const focusKey = await window.electronAPI.startFocusKey()
      if (!focusKey.success) {
        throw new Error(focusKey.message ?? 'The Mouse Focus key could not start.')
      }
      try {
        this.latestCursor = await window.electronAPI.getCursorPosition(this.monitorId || null)
      } catch {
        this.latestCursor = null
      }
    }

    if (this.mouseFocus && this.captureMode === 'area' && !this.area) {
      throw new Error('Select the recording area before starting Mouse Focus.')
    }

    const canvasArea = this.mouseFocus && this.captureMode === 'area' && this.area
      ? (() => {
          const displayWidth = this.latestCursor?.displayWidth || sourceWidth
          const displayHeight = this.latestCursor?.displayHeight || sourceHeight
          const x = Math.max(0, Math.min(sourceWidth - 2, (this.area!.rect.x / displayWidth) * sourceWidth))
          const y = Math.max(0, Math.min(sourceHeight - 2, (this.area!.rect.y / displayHeight) * sourceHeight))
          return {
            x,
            y,
            width: Math.max(2, Math.min(sourceWidth - x, (this.area!.rect.width / displayWidth) * sourceWidth)),
            height: Math.max(2, Math.min(sourceHeight - y, (this.area!.rect.height / displayHeight) * sourceHeight)),
          }
        })()
      : { x: 0, y: 0, width: sourceWidth, height: sourceHeight }

    // Custom output resolution scales the selected source region while keeping
    // its aspect ratio. Area capture uses the exact selected region dimensions.
    const scale = customTarget
      ? Math.min(
          customTarget.width / canvasArea.width,
          customTarget.height / canvasArea.height,
        )
      : 1
    const width = Math.max(2, Math.floor((canvasArea.width * scale) / 2) * 2)
    const height = Math.max(2, Math.floor((canvasArea.height * scale) / 2) * 2)

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height

    // Webcam picture, drawn after the zoom so it keeps its place and size.
    let cameraVideo: HTMLVideoElement | null = null
    let cameraRect: ReturnType<typeof cameraBox> | null = null
    let cameraScale = 1
    if (this.camera) {
      const cameraStream = await this.openCameraStream()
      cameraVideo = document.createElement('video')
      cameraVideo.muted = true
      cameraVideo.playsInline = true
      cameraVideo.srcObject = cameraStream
      await cameraVideo.play()

      const regionDipWidth = this.captureMode === 'area' && this.area
        ? this.area.rect.width
        : (this.latestCursor?.displayWidth || sourceWidth)
      const regionDipHeight = this.captureMode === 'area' && this.area
        ? this.area.rect.height
        : (this.latestCursor?.displayHeight || sourceHeight)
      cameraRect = cameraBox(
        regionDipWidth, regionDipHeight,
        this.camera.size, this.camera.shape, this.camera.position,
      )
      cameraScale = width / Math.max(1, regionDipWidth)
    }

    // Speedrun Timer: the clock runs in the main process; the latest state is
    // kept here and the time is worked out for every drawn frame.
    let timerState: TimerSnapshot | null = null
    const timerRect = drawsTimer ? timerBox(width, height, this.timerPosition) : null
    if (drawsTimer) {
      this.timerUnsubscribe?.()
      this.timerUnsubscribe = window.electronAPI.onTimerState((snapshot) => { timerState = snapshot })
      try {
        timerState = await window.electronAPI.getTimerState()
      } catch {
        timerState = null
      }
    }

    // Monitoring: readings come from the main process once per second; the
    // text rows and the panel layout are rebuilt only when new readings arrive.
    let monitorRows: MonitorRow[] = []
    let monitorPanel: MonitorPanel | null = null
    if (drawsMonitor && this.monitor) {
      const monitorOptions = this.monitor
      const applyMonitor = (state: MonitorSnapshot) => {
        const rows = buildMonitorRows(state, monitorOptions.metrics)
        monitorRows = rows
        monitorPanel = rows.length > 0
          ? monitorPanelBox(rows, width, height, monitorOptions.position)
          : null
      }
      this.monitorUnsubscribe?.()
      this.monitorUnsubscribe = window.electronAPI.onMonitorState(applyMonitor)
      try {
        applyMonitor(await window.electronAPI.getMonitorState())
      } catch {
        // The panel appears with the first reading.
      }
    }

    const context = canvas.getContext('2d', { alpha: false, desynchronized: true })
    if (!context) throw new Error('Could not initialize the video processing canvas.')

    // Mouse Click Effects: bubbles are drawn straight into the recorded canvas,
    // so they appear in the video only and never on the user's screen.
    const ripples: Array<{ x: number; y: number; startedAt: number }> = []
    if (this.clickEffects) {
      this.clickUnsubscribe = window.electronAPI.onClickEffect((click) => {
        ripples.push({ x: click.x, y: click.y, startedAt: performance.now() })
        if (ripples.length > 40) ripples.shift()
      })
    }
    const bubbleRadius = Math.max(12, Math.min(32, height * 0.02))
    const bubbleMs = 550

    let zoom = 1
    let focusX = 0.5
    let focusY = 0.5
    let lastDrawAt = performance.now()
    let targetZoom = 1

    if (this.mouseFocus) {
      let polling = false
      const pollCursor = async () => {
        // Never queue a second request while the previous one is still running.
        if (polling) return
        polling = true
        try {
          const position = await window.electronAPI.getCursorPosition(this.monitorId || null)
          if (!position) return
          const normalizedX = position.x
          const normalizedY = position.y
          this.latestCursor = position

          const insideArea =
            normalizedX >= canvasArea.x / sourceWidth &&
            normalizedX <= (canvasArea.x + canvasArea.width) / sourceWidth &&
            normalizedY >= canvasArea.y / sourceHeight &&
            normalizedY <= (canvasArea.y + canvasArea.height) / sourceHeight

          // Zoom in only while the hold key is down; releasing it zooms back out
          // with the same smoothing (Zoom Level and Zoom Speed still apply).
          targetZoom = insideArea && position.focusKeyHeld === true
            ? this.mouseZoomLevel
            : 1
        } catch {
          // Cursor tracking is an optional enhancement; capture continues normally.
        } finally {
          polling = false
        }
      }
      void pollCursor()
      this.cursorPollTimer = setInterval(() => { void pollCursor() }, 40)
    }

    const responseMs = this.mouseZoomSpeed === 'slow'
      ? 900
      : this.mouseZoomSpeed === 'fast'
        ? 300
        : 520

    const draw = (timestamp: number) => {
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && !video.ended) {
        const delta = Math.min(0.1, Math.max(0.001, (timestamp - lastDrawAt) / 1000))
        lastDrawAt = timestamp

        if (this.mouseFocus) {
          const smoothing = 1 - Math.exp(-delta / (responseMs / 1000))
          zoom += (targetZoom - zoom) * smoothing

          const cursor = this.latestCursor
          if (cursor) {
            const pointerX = cursor.x * sourceWidth
            const pointerY = cursor.y * sourceHeight
            const nextX = Math.max(0, Math.min(1, (pointerX - canvasArea.x) / canvasArea.width))
            const nextY = Math.max(0, Math.min(1, (pointerY - canvasArea.y) / canvasArea.height))
            focusX += (nextX - focusX) * smoothing
            focusY += (nextY - focusY) * smoothing
          }
        }

        const cropWidth = canvasArea.width / zoom
        const cropHeight = canvasArea.height / zoom
        const cropX = Math.max(
          canvasArea.x,
          Math.min(canvasArea.x + canvasArea.width - cropWidth,
            canvasArea.x + focusX * canvasArea.width - cropWidth / 2),
        )
        const cropY = Math.max(
          canvasArea.y,
          Math.min(canvasArea.y + canvasArea.height - cropHeight,
            canvasArea.y + focusY * canvasArea.height - cropHeight / 2),
        )

        context.drawImage(
          video,
          cropX, cropY, cropWidth, cropHeight,
          0, 0, width, height,
        )

        if (cameraVideo && cameraRect && this.camera) {
          drawCameraFrame(context, cameraVideo, {
            x: cameraRect.x * cameraScale,
            y: cameraRect.y * cameraScale,
            width: cameraRect.width * cameraScale,
            height: cameraRect.height * cameraScale,
          }, {
            shape: this.camera.shape,
            mirror: this.camera.mirror,
            opacity: this.camera.opacity,
            cornerRadius: CAMERA_CORNER_RADIUS * cameraScale,
          })
        }

        if (timerRect && timerState) {
          drawTimerBadge(context, timerRect, formatTimer(timerElapsed(timerState)), timerState.status)
        }

        if (monitorPanel) drawMonitorPanel(context, monitorPanel, monitorRows)

        if (ripples.length > 0) {
          const scaleX = width / cropWidth
          const scaleY = height / cropHeight
          for (let index = ripples.length - 1; index >= 0; index--) {
            const ripple = ripples[index]
            const progress = (performance.now() - ripple.startedAt) / bubbleMs
            if (progress >= 1) {
              ripples.splice(index, 1)
              continue
            }

            const eased = 1 - Math.pow(1 - progress, 3)
            const radius = bubbleRadius * (0.45 + 0.55 * eased)
            const fade = Math.pow(1 - progress, 1.3)
            const phaseA = 0.9 + progress * 1.4
            const phaseB = 2.1 - progress * 1.1
            const x = (ripple.x * sourceWidth - cropX) * scaleX
            const y = (ripple.y * sourceHeight - cropY) * scaleY

            // Soft, irregular smudge instead of a crisp circle. A radial gradient
            // gives the soft edge without the very expensive canvas blur filter.
            const gradient = context.createRadialGradient(x, y, radius * 0.1, x, y, radius * 1.05)
            gradient.addColorStop(0, `rgba(205, 228, 255, ${0.3 * fade})`)
            gradient.addColorStop(0.75, `rgba(205, 228, 255, ${0.24 * fade})`)
            gradient.addColorStop(1, 'rgba(205, 228, 255, 0)')
            context.beginPath()
            for (let step = 0; step <= 48; step++) {
              const angle = (step / 48) * Math.PI * 2
              const wobble = 1 + 0.14 * Math.sin(2 * angle + phaseA) + 0.09 * Math.sin(3 * angle + phaseB)
              const edge = radius * 0.8 * wobble
              const px = x + Math.cos(angle) * edge
              const py = y + Math.sin(angle) * edge
              if (step === 0) context.moveTo(px, py)
              else context.lineTo(px, py)
            }
            context.closePath()
            context.fillStyle = gradient
            context.fill()
          }
        }
      }
    }

    // Frames are pushed to the recorder explicitly after every draw
    // (captureStream(0) + requestFrame), so the video runs at the exact chosen
    // frame rate and never depends on the compositor.
    const videoOutput = canvas.captureStream(0)
    const outputTrack = videoOutput.getVideoTracks()[0] as
      (MediaStreamTrack & { requestFrame?: () => void }) | undefined
    const frameInterval = 1000 / this.frameRate
    let nextDueAt = performance.now()

    const drawIfDue = () => {
      const now = performance.now()
      if (now < nextDueAt - 3) return
      nextDueAt += frameInterval
      // After a long stall do not rush to catch up; resume from now.
      if (now - nextDueAt > frameInterval * 3) nextDueAt = now + frameInterval
      draw(now)
      outputTrack?.requestFrame?.()
    }

    // Draw immediately so the stream does not begin with an empty canvas.
    drawIfDue()

    // A smooth animation-frame loop while the window is rendered, plus a timer
    // that keeps drawing when Windows hides, minimizes or covers the window
    // (animation frames pause there, which made recordings freeze and stutter).
    const onFrame = () => {
      drawIfDue()
      this.animationFrame = requestAnimationFrame(onFrame)
    }
    this.animationFrame = requestAnimationFrame(onFrame)
    this.drawTimer = setInterval(drawIfDue, Math.max(4, Math.floor(frameInterval / 3)))
    this.renderVideo = video

    return new MediaStream([
      ...videoOutput.getVideoTracks(),
      ...source.getAudioTracks(),
    ])
  }

  async start(): Promise<RecorderResult> {
    if (
      this.state === 'recording' ||
      this.state === 'paused' ||
      this.state === 'stopping'
    ) {
      return {
        success: false,
        message: 'A recording session is already active.',
      }
    }

    this.writeQueue = Promise.resolve()
    this.writeError = null
    this.stoppingPromise = null
    this.session = null

    if (this.mode === 'screen' && this.clickEffects) {
      const effects = await window.electronAPI.startClickEffects(this.monitorId || null)
      if (!effects.success) {
        const message = this.reportError(
          new Error(effects.message || 'Mouse Click Effects could not start.'),
        )
        this.cleanup()
        this.setState('error')
        return { success: false, message }
      }
    }

    if (this.mode === 'screen' && !this.mouseFocus) {
      return this.startNative()
    }

    // Gaming Mode: a game that fills a whole monitor is recorded by the native
    // FFmpeg engine (Desktop Duplication + hardware encoder, true constant
    // frame rate, no quality loss). Windowed games, VFR and HDR use the
    // window capture below.
    this.nativeMonitorId = null
    if (this.mode === 'gaming' && this.gameId && this.frameRateMode === 'cfr' && !this.hdr) {
      try {
        const target = await window.electronAPI.resolveGameTarget(this.gameId)
        if (target.fullscreen && target.monitorSourceId) {
          this.nativeMonitorId = target.monitorSourceId
          return this.startNative()
        }
      } catch {
        // Falls back to the window capture.
      }
    }

    try {
      if (!navigator.mediaDevices?.getDisplayMedia) {
        throw new Error(
          'Screen capture API is unavailable. Run the app through the Electron desktop window, not the browser preview.',
        )
      }

      // Always set the source explicitly. Passing null clears a previous
      // monitor selection and restores the system-default display.
      const source = await window.electronAPI.setCaptureSource(this.monitorId || null)
      if (!source.success) throw new Error('Could not select the requested monitor.')

      const mimeType = this.getSupportedMimeType()

      if (!mimeType) {
        throw new Error('This Electron/Chromium build does not provide a supported WebM capture format for Mouse Focus.')
      }

      const dimensions: Record<string, { ideal: number }> = {
        '4k': { ideal: 3840 },
        '1440p': { ideal: 2560 },
        '1080p': { ideal: 1920 },
        '720p': { ideal: 1280 },
        '540p': { ideal: 960 },
        '480p': { ideal: 854 },
        '360p': { ideal: 640 },
        '240p': { ideal: 426 },
        '144p': { ideal: 256 },
      }
      const videoConstraints = {
        frameRate: { ideal: this.frameRate, max: this.frameRate },
        cursor: this.showCursor ? 'always' : 'never',
        ...(this.captureMode !== 'custom' || this.resolution === 'original'
          ? {}
          : { width: dimensions[this.resolution] }),
        // Never let Chromium shrink a game's picture below its real size.
        ...(this.mode === 'gaming' ? { width: { max: 3840 }, height: { max: 2160 } } : {}),
      } as MediaTrackConstraints

      this.mediaStream = await navigator.mediaDevices.getDisplayMedia({
        video: videoConstraints,
        audio: this.systemAudioEnabled && !this.usesGameAudio()
        ?{
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        }
        : false,
      })

      if (
        this.systemAudioEnabled &&
        !this.usesGameAudio() &&
        this.mediaStream.getAudioTracks().length === 0
      ) {
        throw new Error(
          'Windows did not provide system audio. Try selecting a screen or window that supports audio sharing.',
        )
      }

      if (this.microphoneEnabled) {
        this.microphoneStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: this.microphoneDeviceId
              ? { exact: this.microphoneDeviceId }
              : undefined,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: false,
        })
      }

      const audioTracks = [
        ...this.mediaStream.getAudioTracks(),
        ...(this.microphoneStream?.getAudioTracks() ?? []),
      ]

      let mixedAudioTracks: MediaStreamTrack[] = []
      if (audioTracks.length > 0 || this.usesGameAudio()) {
        const AudioContextConstructor =
          window.AudioContext ||
          (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext

        if (!AudioContextConstructor) {
          throw new Error('Audio mixing is not supported by this version of Chromium.')
        }

        // 'playback' uses larger buffers: recording does not need low latency and
        // this prevents crackling/lag when the CPU is busy.
        this.audioContext = new AudioContextConstructor({
          latencyHint: 'playback',
          ...(this.usesGameAudio() ? { sampleRate: 48000 } : {}),
        })
        await this.audioContext.resume()
        const destination = this.audioContext.createMediaStreamDestination()

        if (this.usesGameAudio()) await this.attachGameAudio(this.audioContext, destination)

        if (this.mediaStream.getAudioTracks().length > 0) {
          const systemStream = new MediaStream(this.mediaStream.getAudioTracks())
          this.audioContext.createMediaStreamSource(systemStream).connect(destination)
        }

        if (this.microphoneStream?.getAudioTracks().length) {
          this.audioContext
            .createMediaStreamSource(this.microphoneStream)
            .connect(destination)
        }

        mixedAudioTracks = destination.stream.getAudioTracks()
      }

      const mixedSource = new MediaStream([
        ...this.mediaStream.getVideoTracks(),
        ...mixedAudioTracks,
      ])
      this.captureStream = await this.createOutputStream(mixedSource)

      const videoTrack = this.mediaStream.getVideoTracks()[0]

      if (!videoTrack) {
        throw new Error('No screen video track was provided.')
      }

      // Gameplay is fast motion: favor smooth frames over sharp still detail.
      if (this.mode === 'gaming') {
        videoTrack.contentHint = 'motion'
        const composedTrack = this.captureStream.getVideoTracks()[0]
        if (composedTrack) composedTrack.contentHint = 'motion'
      }

      const outputVideoTrack = this.captureStream.getVideoTracks()[0]
      const outputSettings = outputVideoTrack?.getSettings()
      const startResult =
        await window.electronAPI.startRecording(
          this.mode,
          'webm',
          {
            mode: this.mode,
            format: this.outputFormat,
            codec: this.encoder,
            resolution: this.captureMode === 'custom' ? this.resolution : 'original',
            width: outputSettings?.width ?? null,
            height: outputSettings?.height ?? null,
            frameRate: this.frameRate,
            bitrate: this.videoBitsPerSecond,
            captureMode: this.captureMode,
            // Tells the main process what the temporary capture contains so a
            // matching H.264 recording can be saved by a fast stream copy.
            captureCodec: /h264|avc1/i.test(mimeType) ? 'h264' : 'other',
            ...(this.mode === 'gaming'
              ? { frameRateMode: this.frameRateMode, lowLatency: this.lowLatency, hdr: this.hdr }
              : {}),
            ...(this.audio ? { audio: this.audio } : {}),
          },
        )

      if (!startResult.success) {
        throw new Error(startResult.message)
      }

      if (!startResult.session) {
        throw new Error(
          'The recording engine did not return a session.',
        )
      }

      this.session = startResult.session

      const captureStream = this.captureStream
      if (!captureStream) throw new Error('Capture stream could not be initialized.')

      const recorder = new MediaRecorder(captureStream, {
        mimeType,
        // Gaming Mode re-encodes the capture when it is stopped, so the temporary
        // capture gets extra headroom to lose as little detail as possible.
        videoBitsPerSecond: this.mode === 'gaming' && (this.frameRateMode === 'cfr' || this.hdr || this.encoder !== 'h264')
          ? Math.min(250_000_000, Math.round(this.videoBitsPerSecond * 1.5))
          : this.videoBitsPerSecond,
        // Keep the intermediate audio close to transparent so the selected
        // output codec is encoded from a high quality source.
        ...(this.audio ? { audioBitsPerSecond: 256_000 } : {}),
      })

      this.mediaRecorder = recorder

      recorder.addEventListener('dataavailable', (event) => {
        if (event.data.size > 0) {
          this.queueChunk(event.data)
        }
      })

      recorder.addEventListener('error', (event) => {
        const mediaError = event as Event & {
          error?: DOMException
        }

        const message = this.reportError(
          mediaError.error ??
            new Error('The media recording engine failed.'),
        )

        this.writeError = message
        this.setState('error')
        void this.stop()
      })

      videoTrack.addEventListener(
        'ended',
        () => {
          if (
            this.state === 'recording' ||
            this.state === 'paused'
          ) {
            void this.stop()
          }
        },
        { once: true },
      )

      // Low Latency Capture hands every picture to the writer 10x sooner.
      recorder.start(this.mode === 'gaming' && this.lowLatency ? 100 : 1000)
      this.setState('recording')

      return {
        success: true,
        message: 'Screen recording started.',
        session: this.session,
      }
    } catch (error) {
      const message = this.reportError(error)

      if (this.session) {
        try {
          await window.electronAPI.stopRecording()
        } catch {
          // Preserve the original startup error.
        }
      }

      this.cleanup()
      this.setState('error')

      return {
        success: false,
        message,
      }
    }
  }

  private queueChunk(blob: Blob): void {
    const sessionId = this.session?.id

    if (!sessionId || this.writeError) return

    this.writeQueue = this.writeQueue.then(async () => {
      if (this.writeError) return

      const buffer = await blob.arrayBuffer()
      const chunk = new Uint8Array(buffer)

      if (chunk.byteLength === 0) return

      const result =
        await window.electronAPI.writeRecordingChunk(
          sessionId,
          chunk,
        )

      if (!result.success) {
        throw new Error('The recording chunk could not be saved.')
      }
    }).catch((error: unknown) => {
      this.writeError = this.reportError(error)
      if (this.state === 'recording' || this.state === 'paused') {
        void this.stop()
      }
    })
  }

  async pause(): Promise<RecorderResult> {
    if (this.nativeSessionId) return this.pauseNative()

    if (
      this.state !== 'recording' ||
      !this.mediaRecorder ||
      !this.session
    ) {
      return {
        success: false,
        message: 'There is no active recording to pause.',
      }
    }

    try {
      await new Promise<void>((resolve) => {
        const recorder = this.mediaRecorder
        if (!recorder) return resolve()
        recorder.addEventListener('pause', () => resolve(), { once: true })
        recorder.pause()
      })
      await this.writeQueue
      if (this.writeError) throw new Error(this.writeError)

      const result = await window.electronAPI.pauseRecording()
      if (!result.success) {
        this.mediaRecorder.resume()
        return { success: false, message: result.message }
      }

      this.setState('paused')

      return {
        success: true,
        message: 'Recording paused.',
      }
    } catch (error) {
      return {
        success: false,
        message: this.reportError(error),
      }
    }
  }

  async resume(): Promise<RecorderResult> {
    if (this.nativeSessionId) return this.resumeNative()

    if (
      this.state !== 'paused' ||
      !this.mediaRecorder ||
      !this.session
    ) {
      return {
        success: false,
        message: 'There is no paused recording to resume.',
      }
    }

    try {
      const result =
        await window.electronAPI.resumeRecording()

      if (!result.success) {
        return {
          success: false,
          message: result.message,
        }
      }

      this.mediaRecorder.resume()
      this.setState('recording')

      return {
        success: true,
        message: 'Recording resumed.',
      }
    } catch (error) {
      return {
        success: false,
        message: this.reportError(error),
      }
    }
  }

  async stop(): Promise<RecorderResult> {
    if (this.stoppingPromise) {
      return this.stoppingPromise
    }

    if (this.nativeSessionId) {
      this.stoppingPromise = this.stopNative()
      return this.stoppingPromise
    }

    if (!this.mediaRecorder || !this.session) {
      this.cleanup()
      this.setState('idle')

      return {
        success: false,
        message: 'There is no recording to stop.',
      }
    }

    this.stoppingPromise = this.stopInternal()
    return this.stoppingPromise
  }

  private async stopInternal(): Promise<RecorderResult> {
    const recorder = this.mediaRecorder

    if (!recorder || !this.session) {
      this.cleanup()
      this.setState('idle')

      return {
        success: false,
        message: 'Recording session is unavailable.',
      }
    }

    this.setState('stopping')

    try {
      if (recorder.state === 'paused') {
        const resumeResult =
          await window.electronAPI.resumeRecording()

        if (!resumeResult.success) {
          throw new Error(resumeResult.message)
        }

        recorder.resume()
      }

      if (recorder.state !== 'inactive') {
        await new Promise<void>((resolve, reject) => {
          const handleStop = () => {
            cleanupListeners()
            resolve()
          }

          const handleError = () => {
            cleanupListeners()
            reject(new Error('The media recorder failed to stop.'))
          }

          const cleanupListeners = () => {
            recorder.removeEventListener('stop', handleStop)
            recorder.removeEventListener('error', handleError)
          }

          recorder.addEventListener('stop', handleStop, {
            once: true,
          })

          recorder.addEventListener('error', handleError, {
            once: true,
          })

          try {
            recorder.stop()
          } catch (error) {
            cleanupListeners()
            reject(error)
          }
        })
      }

      await this.writeQueue

      if (this.writeError) {
        throw new Error(this.writeError)
      }

      const result =
        await window.electronAPI.stopRecording()

      if (!result.success) {
        throw new Error(result.message)
      }

      const filePath = result.filePath

      this.cleanup()
      this.setState('idle')

      return {
        success: true,
        message: 'Recording saved successfully.',
        filePath,
      }
    } catch (error) {
      const message = this.reportError(error)

      try {
        await window.electronAPI.stopRecording()
      } catch {
        // Keep the original recording error.
      }

      this.cleanup()
      this.setState('error')

      return {
        success: false,
        message,
      }
    }
  }

  // -------------------------------------------------------------------------
  // Native (FFmpeg) screen capture
  // -------------------------------------------------------------------------

  private async createAudioOnlyStream(): Promise<MediaStream> {
    if (this.systemAudioEnabled && !this.usesGameAudio()) {
      // The display-media handler needs the monitor selection. Only the
      // loopback audio is used; the video track is released immediately
      // because the picture is captured natively.
      const source = await window.electronAPI.setCaptureSource(this.nativeMonitorId ?? (this.monitorId || null))
      if (!source.success) throw new Error('Could not select the requested monitor.')

      const display = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 1, max: 1 } },
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      })

      const audioTracks = display.getAudioTracks()
      for (const track of display.getVideoTracks()) track.stop()

      if (audioTracks.length === 0) {
        for (const track of display.getTracks()) track.stop()
        throw new Error(
          'Windows did not provide system audio. Try selecting a screen or window that supports audio sharing.',
        )
      }

      this.mediaStream = new MediaStream(audioTracks)
    }

    if (this.microphoneEnabled) {
      this.microphoneStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: this.microphoneDeviceId
            ? { exact: this.microphoneDeviceId }
            : undefined,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      })
    }

    const AudioContextConstructor =
      window.AudioContext ||
      (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext

    if (!AudioContextConstructor) {
      throw new Error('Audio mixing is not supported by this version of Chromium.')
    }

    this.audioContext = new AudioContextConstructor(this.usesGameAudio() ? { sampleRate: 48000 } : undefined)
    await this.audioContext.resume()
    const destination = this.audioContext.createMediaStreamDestination()

    if (this.usesGameAudio()) await this.attachGameAudio(this.audioContext, destination)

    if (this.mediaStream?.getAudioTracks().length) {
      this.audioContext
        .createMediaStreamSource(new MediaStream(this.mediaStream.getAudioTracks()))
        .connect(destination)
    }

    if (this.microphoneStream?.getAudioTracks().length) {
      this.audioContext
        .createMediaStreamSource(this.microphoneStream)
        .connect(destination)
    }

    return destination.stream
  }

  private queueAudioChunk(blob: Blob): void {
    const sessionId = this.nativeSessionId
    if (!sessionId || this.audioWriteError) return

    this.audioWriteQueue = this.audioWriteQueue.then(async () => {
      if (this.audioWriteError) return

      const chunk = new Uint8Array(await blob.arrayBuffer())
      if (chunk.byteLength === 0) return

      const result = await window.electronAPI.nativeWriteAudio(sessionId, chunk)
      if (!result.success) throw new Error('The audio chunk could not be saved.')
    }).catch((error: unknown) => {
      this.audioWriteError = this.reportError(error)
      if (this.state === 'recording' || this.state === 'paused') {
        void this.stop()
      }
    })
  }

  private async startAudioRecorder(stream: MediaStream, sessionId: string): Promise<void> {
    const mimeType = ['audio/webm;codecs=opus', 'audio/webm']
      .find((type) => MediaRecorder.isTypeSupported(type))

    if (!mimeType) {
      throw new Error('This Chromium build cannot record audio.')
    }

    const recorder = new MediaRecorder(stream, {
      mimeType,
      audioBitsPerSecond: 256_000,
    })
    this.audioRecorder = recorder

    recorder.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) this.queueAudioChunk(event.data)
    })

    recorder.addEventListener('error', () => {
      this.audioWriteError = this.reportError(
        new Error('The audio recording engine failed.'),
      )
      if (this.state === 'recording' || this.state === 'paused') {
        void this.stop()
      }
    })

    const started = new Promise<void>((resolve) => {
      recorder.addEventListener('start', () => resolve(), { once: true })
    })

    recorder.start(500)
    await started

    // Lets the main process line the audio up with the first video frame.
    await window.electronAPI.nativeAudioStarted(sessionId, Date.now())
  }

  /** Opens the selected webcam. Throws when it cannot be used. */
  private async openCameraStream(): Promise<MediaStream> {
    const camera = this.camera
    if (!camera) throw new Error('No camera is selected.')

    // The picture is never larger than a third of the video, so a modest
    // capture size keeps CPU and disk use low.
    const width = camera.size === 'small' ? 640 : camera.size === 'medium' ? 960 : 1280
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: camera.deviceId ? { exact: camera.deviceId } : undefined,
          width: { ideal: width },
          height: { ideal: Math.round((width * 9) / 16) },
          frameRate: { ideal: Math.min(30, this.frameRate), max: 30 },
        },
        audio: false,
      })
      this.cameraStream = stream
      return stream
    } catch {
      throw new Error('The selected camera could not be opened. Check that it is connected and not used by another app.')
    }
  }

  private queueCameraChunk(blob: Blob): void {
    const sessionId = this.nativeSessionId
    if (!sessionId || this.cameraWriteError) return

    this.cameraWriteQueue = this.cameraWriteQueue.then(async () => {
      if (this.cameraWriteError) return
      const chunk = new Uint8Array(await blob.arrayBuffer())
      if (chunk.byteLength === 0) return
      const result = await window.electronAPI.nativeWriteCamera(sessionId, chunk)
      if (!result.success) throw new Error('The camera data could not be saved.')
    }).catch((error: unknown) => {
      this.cameraWriteError = error instanceof Error ? error.message : 'The camera data could not be saved.'
    })
  }

  private async startCameraRecorder(stream: MediaStream, sessionId: string): Promise<void> {
    const mimeType = ['video/webm;codecs=vp8', 'video/webm']
      .find((type) => MediaRecorder.isTypeSupported(type))
    if (!mimeType) throw new Error('This Chromium build cannot record the camera.')

    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 4_000_000 })
    this.cameraRecorder = recorder

    recorder.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) this.queueCameraChunk(event.data)
    })
    // A camera failure never stops the screen recording; the video is simply
    // saved without the camera picture.
    recorder.addEventListener('error', () => {
      this.cameraWriteError = 'The camera recording failed.'
    })

    const started = new Promise<void>((resolve) => {
      recorder.addEventListener('start', () => resolve(), { once: true })
    })
    recorder.start(1000)
    await started
    await window.electronAPI.nativeCameraStarted(sessionId, Date.now())
  }

  private async startNative(): Promise<RecorderResult> {
    try {
      const capabilities = await window.electronAPI.nativeCapabilities()
      if (!capabilities.available) throw new Error(capabilities.reason)

      const hasAudio = this.microphoneEnabled || this.systemAudioEnabled
      const audioStream = hasAudio ? await this.createAudioOnlyStream() : null
      const cameraStream = this.camera ? await this.openCameraStream() : null

      const result = await window.electronAPI.nativeStart({
        monitorSourceId: this.nativeMonitorId ?? (this.monitorId || null),
        captureMode: this.captureMode,
        resolution: this.resolution,
        area: this.area,
        frameRate: this.frameRate,
        bitrate: this.videoBitsPerSecond,
        showCursor: this.showCursor,
        encoder: this.encoder,
        format: this.outputFormat,
        hasAudio,
        clickEffects: this.clickEffects,
        ...(this.mode === 'gaming' ? { lowLatency: this.lowLatency } : {}),
        ...(this.camera
          ? {
              camera: {
                size: this.camera.size,
                shape: this.camera.shape,
                mirror: this.camera.mirror,
                opacity: this.camera.opacity,
                position: this.camera.position,
              },
            }
          : {}),
        ...(this.audio ? { audio: this.audio } : {}),
      })

      if (!result.success) throw new Error((result as { message: string }).message)

      this.nativeSessionId = result.session.id

      this.nativeErrorUnsubscribe = window.electronAPI.onNativeError((message) => {
        this.reportError(new Error(message))
        if (this.state === 'recording' || this.state === 'paused') {
          void this.stop()
        }
      })

      if (audioStream) {
        await this.startAudioRecorder(audioStream, result.session.id)
      }

      if (cameraStream) {
        await this.startCameraRecorder(cameraStream, result.session.id)
      }

      this.setState('recording')

      return {
        success: true,
        message: 'Screen recording started.',
      }
    } catch (error) {
      const message = this.reportError(error)

      try {
        await window.electronAPI.nativeAbort()
      } catch {
        // Preserve the original startup error.
      }

      this.cleanup()
      this.setState('error')

      return { success: false, message }
    }
  }

  private async pauseNative(): Promise<RecorderResult> {
    if (this.state !== 'recording') {
      return { success: false, message: 'There is no active recording to pause.' }
    }

    try {
      const recorder = this.audioRecorder
      const audioPaused = recorder
        ? new Promise<void>((resolve) => {
            recorder.addEventListener('pause', () => resolve(), { once: true })
            recorder.pause()
          })
        : Promise.resolve()

      const cameraRecorder = this.cameraRecorder
      const cameraPaused = cameraRecorder && cameraRecorder.state === 'recording'
        ? new Promise<void>((resolve) => {
            cameraRecorder.addEventListener('pause', () => resolve(), { once: true })
            cameraRecorder.pause()
          })
        : Promise.resolve()

      const [videoResult] = await Promise.all([
        window.electronAPI.nativePause(),
        audioPaused,
        cameraPaused,
      ])

      if (!videoResult.success) {
        recorder?.resume()
        if (cameraRecorder?.state === 'paused') cameraRecorder.resume()
        return { success: false, message: videoResult.message }
      }

      await this.audioWriteQueue
      if (this.audioWriteError) throw new Error(this.audioWriteError)

      this.setState('paused')
      return { success: true, message: 'Recording paused.' }
    } catch (error) {
      return { success: false, message: this.reportError(error) }
    }
  }

  private async resumeNative(): Promise<RecorderResult> {
    if (this.state !== 'paused') {
      return { success: false, message: 'There is no paused recording to resume.' }
    }

    try {
      // The audio resumes only after the new video segment delivered its
      // first frame, which keeps picture and sound aligned.
      const result = await window.electronAPI.nativeResume()
      if (!result.success) {
        return { success: false, message: result.message }
      }

      this.audioRecorder?.resume()
      if (this.cameraRecorder?.state === 'paused') this.cameraRecorder.resume()
      this.setState('recording')

      return { success: true, message: 'Recording resumed.' }
    } catch (error) {
      return { success: false, message: this.reportError(error) }
    }
  }

  private async stopNative(): Promise<RecorderResult> {
    this.setState('stopping')

    try {
      // Video and audio stop at the same moment.
      const captureStopped = window.electronAPI.nativeStopCapture()

      const recorder = this.audioRecorder
      if (recorder && recorder.state !== 'inactive') {
        await new Promise<void>((resolve) => {
          recorder.addEventListener('stop', () => resolve(), { once: true })
          try {
            recorder.stop()
          } catch {
            resolve()
          }
        })
      }

      const cameraRecorder = this.cameraRecorder
      if (cameraRecorder && cameraRecorder.state !== 'inactive') {
        await new Promise<void>((resolve) => {
          cameraRecorder.addEventListener('stop', () => resolve(), { once: true })
          try {
            cameraRecorder.stop()
          } catch {
            resolve()
          }
        })
      }

      await this.audioWriteQueue
      await this.cameraWriteQueue

      const captureResult = await captureStopped
      if (!captureResult.success) throw new Error(captureResult.message)
      if (this.audioWriteError) throw new Error(this.audioWriteError)

      const result = await window.electronAPI.nativeFinalize()
      if (!result.success) throw new Error((result as { message: string }).message)

      const filePath = result.filePath

      this.cleanup()
      this.setState('idle')

      return {
        success: true,
        message: 'Recording saved successfully.',
        filePath,
      }
    } catch (error) {
      const message = this.reportError(error)

      try {
        await window.electronAPI.nativeAbort()
      } catch {
        // Keep the original recording error.
      }

      this.cleanup()
      this.setState('error')

      return { success: false, message }
    }
  }

  private cleanup(): void {
    if (this.clickEffects) {
      void window.electronAPI.stopClickEffects().catch(() => undefined)
    }
    const tracks = [
      ...(this.mediaStream?.getTracks() ?? []),
      ...(this.microphoneStream?.getTracks() ?? []),
      ...(this.captureStream?.getTracks() ?? []),
      ...(this.cameraStream?.getTracks() ?? []),
    ]
    for (const track of new Set(tracks)) track.stop()

    if (this.animationFrame) cancelAnimationFrame(this.animationFrame)
    if (this.drawTimer !== null) {
      clearInterval(this.drawTimer)
      this.drawTimer = null
    }
    if (this.cursorPollTimer !== null) {
      clearInterval(this.cursorPollTimer)
      this.cursorPollTimer = null
    }
    if (this.mouseFocus) {
      void window.electronAPI.stopFocusKey().catch(() => undefined)
    }
    this.latestCursor = null
    this.animationFrame = 0
    if (this.renderVideo) {
      this.renderVideo.pause()
      this.renderVideo.srcObject = null
    }
    this.renderVideo = null
    this.mediaStream = null
    this.microphoneStream = null
    this.captureStream = null
    this.cameraStream = null
    this.cameraRecorder = null
    this.cameraWriteQueue = Promise.resolve()
    this.cameraWriteError = null
    this.mediaRecorder = null
    this.session = null
    this.nativeSessionId = null
    this.audioRecorder = null
    this.audioWriteQueue = Promise.resolve()
    this.audioWriteError = null
    this.nativeErrorUnsubscribe?.()
    this.nativeErrorUnsubscribe = null
    this.clickUnsubscribe?.()
    this.clickUnsubscribe = null
    this.timerUnsubscribe?.()
    this.timerUnsubscribe = null
    this.monitorUnsubscribe?.()
    this.monitorUnsubscribe = null
    this.gameAudioUnsubscribe?.()
    this.gameAudioUnsubscribe = null
    this.gameAudioNode?.disconnect()
    this.gameAudioNode = null
    if (this.gameAudioActive) {
      this.gameAudioActive = false
      void window.electronAPI.stopGameAudio().catch(() => undefined)
    }
    this.nativeMonitorId = null
    if (this.audioContext) {
      void this.audioContext.close().catch(() => undefined)
      this.audioContext = null
    }
    this.writeQueue = Promise.resolve()
    this.stoppingPromise = null
  }
}
