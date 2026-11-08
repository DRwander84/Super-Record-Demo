import { app, desktopCapturer, screen, type Display } from 'electron'
import {
  mkdir, open, rm, stat, writeFile, type FileHandle,
} from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { getAppSettings } from './settings'
import {
  CaptureSegment,
  buildEncoderArgs,
  buildMuxArgs,
  buildVideoInputPlan,
  concatListLine,
  execFfmpeg,
  getAvailableAudioCodecs,
  getEncoderChain,
  getFfmpegPath,
  isCodecAllowedInContainer,
  isHardwareEncoder,
  markEncoderFailed,
  markEncoderWorking,
  orderEncoderChain,
  probeDdagrabOutputs,
  type CaptureBackend,
  type GrabberOutput,
  type OutputContainer,
  type PixelRect,
  type VideoCodec,
} from './ffmpeg'
import type { AreaRect } from './areaSelector'
import { getRecordedClicks } from './clickEffects'
import {
  buildClickFilterGraph,
  createBubbleSprite,
  mapClicksToVideo,
  type ClickGeometry,
} from './clickOverlay'
import {
  buildCameraFilterGraph,
  normalizeCameraPlan,
  writeCameraMask,
  type CameraPlan,
} from './cameraComposite'
import { cameraBox, CAMERA_CORNER_RADIUS } from '../src/recording/cameraLayout'
import type { AudioCodec, AudioSettings } from '../src/recording/audioSettings'

export type NativeStartOptions = {
  monitorSourceId: string | null
  captureMode: 'full' | 'custom' | 'area'
  resolution: string
  area: { displayId: number; rect: AreaRect } | null
  frameRate: number
  bitrate: number
  showCursor: boolean
  encoder: VideoCodec
  format: OutputContainer
  hasAudio: boolean
  audio?: AudioSettings
  /** Render a bubble at every left click into the video. */
  clickEffects?: boolean
  /** Fastest encoder settings (Gaming Mode: Low Latency Capture). */
  lowLatency?: boolean
  /** Webcam picture added to the video (recorded by the renderer). */
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
        backend: CaptureBackend
        width: number
        height: number
        firstFrameAt: number
      }
    }
  | { success: false; error: string; message: string }

type NativeSession = {
  id: string
  options: NativeStartOptions
  tempDir: string
  finalPath: string
  encoderName: string
  backend: CaptureBackend
  outputIndex: number
  plan: ReturnType<typeof buildVideoInputPlan>
  width: number
  height: number
  segments: CaptureSegment[]
  current: CaptureSegment | null
  paused: boolean
  audioPath: string
  audioHandle: FileHandle | null
  audioQueue: Promise<void>
  audioError: Error | null
  audioStartedAt: number
  videoStartedAt: number
  startedAt: number
  env: NodeJS.ProcessEnv
  captureStopped: boolean
  clickGeometry: ClickGeometry
  cameraPath: string
  cameraHandle: FileHandle | null
  cameraQueue: Promise<void>
  cameraError: Error | null
  cameraStartedAt: number
  cameraPlan: CameraPlan | null
}

const RESOLUTION_TARGETS: Record<string, { width: number; height: number }> = {
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

let session: NativeSession | null = null
let busy = false
let errorListener: ((message: string) => void) | null = null
let ddagrabCache: Promise<GrabberOutput[]> | null = null

export function onNativeCaptureError(listener: (message: string) => void): void {
  errorListener = listener
}

export function isNativeRecordingActive(): boolean {
  return session !== null
}

export function invalidateCaptureProbe(): void {
  ddagrabCache = null
}

/**
 * Runs the Desktop Duplication probe once in the background after start-up so
 * the first recording does not wait for it. Never called while recording.
 */
export async function warmCaptureProbe(): Promise<void> {
  const ffmpegPath = getFfmpegPath()
  if (!ffmpegPath || session || busy) return
  await getDdagrabOutputs(ffmpegPath)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fail(error: string, message: string): NativeStartResult {
  return { success: false, error, message }
}

function timestamp(): string {
  const date = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
}

const even = (value: number) => Math.max(2, Math.floor(value / 2) * 2)

export async function resolveDisplay(sourceId: string | null): Promise<Display | null> {
  if (!sourceId) return screen.getPrimaryDisplay()

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 1, height: 1 },
    fetchWindowIcons: false,
  })
  const source = sources.find((item) => item.id === sourceId)
  if (!source) return null

  return screen.getAllDisplays().find(
    (display) => String(display.id) === source.display_id,
  ) ?? null
}

/** Physical (pixel) rectangle of a rectangle given in DIPs. */
function dipToPixels(rect: AreaRect): PixelRect {
  if (process.platform === 'win32') {
    const converted = screen.dipToScreenRect(null, rect)
    return {
      x: converted.x,
      y: converted.y,
      width: converted.width,
      height: converted.height,
    }
  }

  const scale = screen.getDisplayMatching(rect).scaleFactor
  return {
    x: Math.round(rect.x * scale),
    y: Math.round(rect.y * scale),
    width: Math.round(rect.width * scale),
    height: Math.round(rect.height * scale),
  }
}

async function getDdagrabOutputs(ffmpegPath: string): Promise<GrabberOutput[]> {
  if (process.platform !== 'win32') return []
  if (!ddagrabCache) ddagrabCache = probeDdagrabOutputs(ffmpegPath)
  return ddagrabCache
}

/** Finds the Desktop Duplication output that belongs to an Electron display. */
function matchOutputIndex(
  outputs: GrabberOutput[],
  display: Display,
  displayPixels: PixelRect,
): number | null {
  const sameSize = outputs.filter(
    (output) =>
      output.width === displayPixels.width &&
      output.height === displayPixels.height,
  )
  if (sameSize.length === 0) return null
  if (sameSize.length === 1) return sameSize[0].index

  // Several identical monitors: keep their relative order.
  const peers = screen.getAllDisplays().filter((candidate) => {
    const pixels = dipToPixels(candidate.bounds)
    return (
      pixels.width === displayPixels.width &&
      pixels.height === displayPixels.height
    )
  })
  const position = peers.findIndex((candidate) => candidate.id === display.id)
  return sameSize[Math.min(Math.max(position, 0), sameSize.length - 1)].index
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

export async function getNativeCapabilities() {
  const ffmpegPath = getFfmpegPath()

  if (!ffmpegPath) {
    return {
      available: false,
      reason:
        'The FFmpeg recording backend was not found. Run "npm install" so the ffmpeg-static package can download it.',
      encoders: { h264: [], hevc: [], av1: [] } as Record<VideoCodec, string[]>,
      audioCodecs: [] as AudioCodec[],
    }
  }

  const [h264, hevc, av1, audioCodecs] = await Promise.all([
    getEncoderChain(ffmpegPath, 'h264'),
    getEncoderChain(ffmpegPath, 'hevc'),
    getEncoderChain(ffmpegPath, 'av1'),
    getAvailableAudioCodecs(ffmpegPath),
  ])

  return {
    available: true,
    reason: '',
    encoders: { h264, hevc, av1 } as Record<VideoCodec, string[]>,
    audioCodecs,
  }
}

// ---------------------------------------------------------------------------
// Segments
// ---------------------------------------------------------------------------

function segmentEnv(): NodeJS.ProcessEnv {
  // Without DPI awareness gdigrab would capture a scaled-down desktop.
  return { ...process.env, __COMPAT_LAYER: 'HighDpiAware' }
}

async function launchSegment(
  ffmpegPath: string,
  active: NativeSession,
  encoderName: string,
): Promise<CaptureSegment> {
  const index = active.segments.length
  const segment = new CaptureSegment({
    ffmpegPath,
    inputArgs: active.plan.inputArgs,
    videoFilter: active.plan.videoFilter,
    encoderArgs: buildEncoderArgs(
      encoderName,
      active.options.bitrate,
      active.options.frameRate,
      { lowLatency: active.options.lowLatency },
    ),
    outputPath: path.join(active.tempDir, `video_${String(index).padStart(3, '0')}.mkv`),
    env: active.env,
  })

  segment.onUnexpectedExit = (message) => {
    if (session?.id !== active.id || active.paused || active.captureStopped) return
    errorListener?.(`Screen capture stopped: ${message}`)
  }

  await segment.start()
  return segment
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

export async function startNativeRecording(
  options: NativeStartOptions,
): Promise<NativeStartResult> {
  if (session || busy) {
    return fail('RECORDING_ALREADY_ACTIVE', 'A recording session is already active.')
  }

  busy = true
  let tempDir: string | null = null
  let startedSegment: CaptureSegment | null = null

  try {
    const ffmpegPath = getFfmpegPath()
    if (!ffmpegPath) {
      return fail(
        'FFMPEG_MISSING',
        'The FFmpeg recording backend was not found. Run "npm install" so the ffmpeg-static package can download it.',
      )
    }

    if (!isCodecAllowedInContainer(options.encoder, options.format)) {
      return fail(
        'CODEC_CONTAINER_MISMATCH',
        `${options.format.toUpperCase()} can only hold AV1 video. Choose AV1, or pick MP4, MKV or MOV for ${options.encoder === 'hevc' ? 'H.265' : 'H.264'}.`,
      )
    }

    if (options.hasAudio && options.audio) {
      const audioCodecs = await getAvailableAudioCodecs(ffmpegPath)
      if (!audioCodecs.includes(options.audio.codec)) {
        return fail(
          'AUDIO_CODEC_UNAVAILABLE',
          `This FFmpeg build cannot encode ${options.audio.codec.toUpperCase()} audio. Choose another Audio Codec.`,
        )
      }
    }

    const display = await resolveDisplay(options.monitorSourceId)
    if (!display) {
      return fail(
        'DISPLAY_NOT_FOUND',
        'The selected monitor is no longer available. Choose another monitor.',
      )
    }

    const displayPixels = dipToPixels(display.bounds)

    // Region to record, relative to the top-left corner of the display.
    let region: PixelRect = {
      x: 0,
      y: 0,
      width: displayPixels.width,
      height: displayPixels.height,
    }
    let fullDisplay = true

    if (options.captureMode === 'area') {
      if (!options.area) {
        return fail('AREA_MISSING', 'Select the area you want to record first.')
      }
      if (options.area.displayId !== display.id) {
        return fail(
          'AREA_INVALID',
          'The selected area belongs to another monitor. Select the area again.',
        )
      }

      const rect = options.area.rect
      if (
        rect.x < 0 || rect.y < 0 ||
        rect.x + rect.width > display.bounds.width + 1 ||
        rect.y + rect.height > display.bounds.height + 1
      ) {
        return fail('AREA_INVALID', 'The selected area no longer fits the monitor. Select the area again.')
      }

      const absolute = dipToPixels({
        x: display.bounds.x + rect.x,
        y: display.bounds.y + rect.y,
        width: rect.width,
        height: rect.height,
      })

      const x = Math.max(0, Math.min(absolute.x - displayPixels.x, displayPixels.width - 2))
      const y = Math.max(0, Math.min(absolute.y - displayPixels.y, displayPixels.height - 2))
      const evenX = Math.floor(x / 2) * 2
      const evenY = Math.floor(y / 2) * 2

      region = {
        x: evenX,
        y: evenY,
        width: even(Math.min(absolute.width, displayPixels.width - evenX)),
        height: even(Math.min(absolute.height, displayPixels.height - evenY)),
      }
      fullDisplay = false
    } else {
      region = {
        x: 0,
        y: 0,
        width: even(displayPixels.width),
        height: even(displayPixels.height),
      }
      fullDisplay = region.width === displayPixels.width && region.height === displayPixels.height
    }

    // Optional output scaling (Custom Resolution keeps the aspect ratio).
    const target = options.captureMode === 'custom'
      ? RESOLUTION_TARGETS[options.resolution]
      : undefined
    let outputSize: { width: number; height: number } | null = null
    if (target) {
      const scale = Math.min(target.width / region.width, target.height / region.height)
      outputSize = {
        width: even(region.width * scale),
        height: even(region.height * scale),
      }
    }
    const finalSize = outputSize ?? { width: region.width, height: region.height }

    // Choose the screen grabber: Desktop Duplication when it can be matched
    // to this monitor, GDI as a safe fallback.
    const ddagrabOutputs = await getDdagrabOutputs(ffmpegPath)
    const outputIndex = matchOutputIndex(ddagrabOutputs, display, displayPixels)
    const backend: CaptureBackend = outputIndex !== null ? 'ddagrab' : 'gdigrab'

    const plan = buildVideoInputPlan({
      backend,
      outputIndex: outputIndex ?? 0,
      frameRate: options.frameRate,
      drawMouse: options.showCursor,
      region,
      displayOrigin: { x: displayPixels.x, y: displayPixels.y },
      fullDisplay,
      outputSize,
    })

    const settings = await getAppSettings()
    await mkdir(settings.outputDirectory, { recursive: true })

    const id = randomUUID()
    tempDir = path.join(app.getPath('temp'), `super-record-${id}`)
    await mkdir(tempDir, { recursive: true })

    const finalPath = path.join(
      settings.outputDirectory,
      `Screen_${timestamp()}_${id.slice(0, 8)}.${options.format}`,
    )

    const active: NativeSession = {
      id,
      options,
      tempDir,
      finalPath,
      encoderName: '',
      backend,
      outputIndex: outputIndex ?? 0,
      plan,
      width: finalSize.width,
      height: finalSize.height,
      segments: [],
      current: null,
      paused: false,
      audioPath: path.join(tempDir, 'audio.webm'),
      audioHandle: null,
      audioQueue: Promise.resolve(),
      audioError: null,
      audioStartedAt: 0,
      videoStartedAt: 0,
      startedAt: Date.now(),
      env: segmentEnv(),
      captureStopped: false,
      cameraPath: path.join(tempDir, 'camera.webm'),
      cameraHandle: null,
      cameraQueue: Promise.resolve(),
      cameraError: null,
      cameraStartedAt: 0,
      cameraPlan: options.camera
        ? (() => {
            // The camera is laid out in screen DIPs (like the Live Preview)
            // and then scaled to the pixels of the final video.
            const dipWidth = options.captureMode === 'area' && options.area
              ? options.area.rect.width
              : display.bounds.width
            const dipHeight = options.captureMode === 'area' && options.area
              ? options.area.rect.height
              : display.bounds.height
            const box = cameraBox(
              dipWidth, dipHeight,
              options.camera.size, options.camera.shape, options.camera.position,
            )
            const scale = finalSize.width / Math.max(1, dipWidth)
            return normalizeCameraPlan({
              x: box.x * scale,
              y: box.y * scale,
              width: box.width * scale,
              height: box.height * scale,
              shape: options.camera.shape,
              mirror: options.camera.mirror,
              opacity: options.camera.opacity,
              cornerRadius: CAMERA_CORNER_RADIUS * scale,
            }, finalSize.width, finalSize.height)
          })()
        : null,
      clickGeometry: {
        displayWidth: displayPixels.width,
        displayHeight: displayPixels.height,
        region,
        outputWidth: finalSize.width,
        outputHeight: finalSize.height,
      },
    }

    // Try the preferred encoders in order (hardware first, software last).
    const chain = orderEncoderChain(
      options.encoder,
      await getEncoderChain(ffmpegPath, options.encoder),
    )
    if (chain.length === 0) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
      return fail(
        'ENCODER_UNAVAILABLE',
        `This FFmpeg build has no ${options.encoder === 'hevc' ? 'H.265' : options.encoder === 'av1' ? 'AV1' : 'H.264'} encoder.`,
      )
    }

    let lastError = ''
    let started: CaptureSegment | null = null

    for (const encoderName of chain) {
      try {
        started = await launchSegment(ffmpegPath, active, encoderName)
        active.encoderName = encoderName
        markEncoderWorking(options.encoder, encoderName)
        break
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
        if (isHardwareEncoder(encoderName)) markEncoderFailed(encoderName)
      }
    }

    if (!started) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
      return fail(
        'CAPTURE_START_FAILED',
        `Could not start screen capture${backend === 'ddagrab' ? ' (Desktop Duplication)' : ''}: ${lastError || 'unknown error'}`,
      )
    }

    startedSegment = started
    active.segments.push(started)
    active.current = started
    active.videoStartedAt = started.firstFrameAt

    if (options.hasAudio) {
      active.audioHandle = await open(active.audioPath, 'wx')
    }
    if (active.cameraPlan) {
      active.cameraHandle = await open(active.cameraPath, 'wx')
    }

    session = active

    return {
      success: true,
      session: {
        id,
        filePath: finalPath,
        encoderName: active.encoderName,
        backend,
        width: active.width,
        height: active.height,
        firstFrameAt: started.firstFrameAt,
      },
    }
  } catch (error) {
    await startedSegment?.stop().catch(() => undefined)
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    return fail(
      'NATIVE_START_FAILED',
      error instanceof Error ? error.message : 'Could not start the recording.',
    )
  } finally {
    busy = false
  }
}

// ---------------------------------------------------------------------------
// Pause / resume
// ---------------------------------------------------------------------------

export async function pauseNativeRecording(): Promise<{ success: boolean; message: string }> {
  if (!session || session.paused || !session.current) {
    return { success: false, message: 'There is no active recording to pause.' }
  }

  const active = session
  active.paused = true
  const segment = active.current
  active.current = null

  try {
    await segment!.stop()
    return { success: true, message: 'Recording paused.' }
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : 'Could not pause the recording.',
    }
  }
}

export async function resumeNativeRecording(): Promise<{
  success: boolean
  message: string
  firstFrameAt?: number
}> {
  if (!session || !session.paused) {
    return { success: false, message: 'There is no paused recording to resume.' }
  }

  const ffmpegPath = getFfmpegPath()
  if (!ffmpegPath) {
    return { success: false, message: 'FFmpeg was not found.' }
  }

  const active = session

  try {
    const segment = await launchSegment(ffmpegPath, active, active.encoderName)
    active.segments.push(segment)
    active.current = segment
    active.paused = false
    return { success: true, message: 'Recording resumed.', firstFrameAt: segment.firstFrameAt }
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : 'Could not resume the recording.',
    }
  }
}

// ---------------------------------------------------------------------------
// Audio chunks (captured by the renderer)
// ---------------------------------------------------------------------------

export function writeNativeAudioChunk(sessionId: string, chunk: Uint8Array): Promise<void> {
  if (!session || session.id !== sessionId || !session.audioHandle) {
    return Promise.reject(new Error('Invalid recording session.'))
  }
  if (session.audioError) return Promise.reject(session.audioError)

  const active = session
  const handle = session.audioHandle
  const data = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)

  const write = active.audioQueue.then(async () => {
    if (active.audioError) throw active.audioError
    await handle.writeFile(data)
  })

  active.audioQueue = write.catch((error: unknown) => {
    active.audioError = error instanceof Error ? error : new Error(String(error))
  })

  return write
}

export function setNativeAudioStarted(sessionId: string, timestampMs: number): boolean {
  if (!session || session.id !== sessionId) return false
  session.audioStartedAt = timestampMs
  return true
}

export function writeNativeCameraChunk(sessionId: string, chunk: Uint8Array): Promise<void> {
  if (!session || session.id !== sessionId || !session.cameraHandle) {
    return Promise.reject(new Error('Invalid recording session.'))
  }
  if (session.cameraError) return Promise.reject(session.cameraError)

  const active = session
  const handle = session.cameraHandle
  const data = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)

  const write = active.cameraQueue.then(async () => {
    if (active.cameraError) throw active.cameraError
    await handle.writeFile(data)
  })

  active.cameraQueue = write.catch((error: unknown) => {
    active.cameraError = error instanceof Error ? error : new Error(String(error))
  })

  return write
}

export function setNativeCameraStarted(sessionId: string, timestampMs: number): boolean {
  if (!session || session.id !== sessionId) return false
  session.cameraStartedAt = timestampMs
  return true
}

// ---------------------------------------------------------------------------
// Stop / finalize
// ---------------------------------------------------------------------------

/** Stops capturing video. Audio chunks may still be flushed afterwards. */
export async function stopNativeCapture(): Promise<{ success: boolean; message: string }> {
  if (!session) {
    return { success: false, message: 'There is no active recording.' }
  }

  session.captureStopped = true
  const segment = session.current
  session.current = null
  session.paused = false

  try {
    await segment?.stop()
    return { success: true, message: 'Capture stopped.' }
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : 'Could not stop the capture.',
    }
  }
}

async function cleanupSession(active: NativeSession): Promise<void> {
  if (active.audioHandle) {
    await active.audioHandle.close().catch(() => undefined)
    active.audioHandle = null
  }
  if (active.cameraHandle) {
    await active.cameraHandle.close().catch(() => undefined)
    active.cameraHandle = null
  }
  await rm(active.tempDir, { recursive: true, force: true }).catch(() => undefined)
  if (session?.id === active.id) session = null
}

/** Reads the duration (seconds) of a media file from FFmpeg's banner. */
async function probeDuration(ffmpegPath: string, filePath: string): Promise<number> {
  const probe = await execFfmpeg(ffmpegPath, ['-hide_banner', '-i', filePath], 30_000)
  const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(probe.stderr)
  if (!match) return 0
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
}

/**
 * Builds the click-bubble inputs for the final mux, one entry per encoder to
 * try (the encoder that recorded the video first). Empty when there is
 * nothing to draw.
 */
async function prepareClickOverlay(
  ffmpegPath: string,
  active: NativeSession,
  usable: CaptureSegment[],
  audioPath: string | null,
  audioDelaySeconds: number,
  cameraPath: string | null,
): Promise<NonNullable<Parameters<typeof buildMuxArgs>[0]['clickOverlay']>[]> {
  const clicks = active.options.clickEffects ? getRecordedClicks() : []
  const cameraPlan = cameraPath ? active.cameraPlan : null
  if (clicks.length === 0 && !cameraPlan) return []

  // The video input is delayed when the audio started before the video.
  const videoShift = audioPath && audioDelaySeconds < -0.03 ? -audioDelaySeconds : 0

  let sprite: Awaited<ReturnType<typeof createBubbleSprite>> | null = null
  let mapped: ReturnType<typeof mapClicksToVideo> = []
  if (clicks.length > 0) {
    // Segments are independent files, so their durations are probed together.
    const timed = await Promise.all(usable.map(async (segment) => ({
      startedAt: segment.firstFrameAt,
      duration: await probeDuration(ffmpegPath, segment.outputPath),
    })))

    sprite = await createBubbleSprite(
      active.tempDir,
      active.clickGeometry.outputHeight,
      active.options.frameRate,
    )
    mapped = mapClicksToVideo(clicks, timed, active.clickGeometry, sprite, videoShift)
    if (mapped.length === 0) sprite = null
  }
  if (!sprite && !cameraPlan) return []

  // Input order of the final command: video, audio, click sprite, camera, mask.
  let nextInput = audioPath ? 2 : 1
  const spriteInput = sprite ? nextInput++ : -1
  const cameraInput = cameraPlan ? nextInput++ : -1

  let maskPath: string | null = null
  if (cameraPlan && cameraPlan.shape !== 'rectangle') {
    maskPath = path.join(active.tempDir, 'camera_mask.png')
    await writeCameraMask(maskPath, cameraPlan)
  }
  const maskInput = maskPath ? nextInput++ : null

  const parts: string[] = []
  let baseLabel = '[0:v]'
  if (sprite) {
    const clickGraph = buildClickFilterGraph(mapped, sprite, 0, spriteInput)
    if (cameraPlan) {
      parts.push(clickGraph.replace(/\[vout\]$/, '[vclicks]'))
      baseLabel = '[vclicks]'
    } else {
      parts.push(clickGraph)
    }
  }
  if (cameraPlan) {
    // Camera offset on the final timeline (video may itself be delayed).
    const cameraOffset = active.cameraStartedAt && active.videoStartedAt
      ? (active.cameraStartedAt - active.videoStartedAt) / 1000 + videoShift
      : videoShift
    parts.push(buildCameraFilterGraph({
      plan: cameraPlan,
      cameraInput,
      maskInput,
      baseLabel,
      outputLabel: '[vout]',
      frameRate: active.options.frameRate,
      offsetSeconds: cameraOffset,
    }))
  }

  const filterScriptPath = path.join(active.tempDir, 'overlay.filter')
  await writeFile(filterScriptPath, parts.join(';\n'), 'utf8')

  const chain = orderEncoderChain(
    active.options.encoder,
    await getEncoderChain(ffmpegPath, active.options.encoder),
  )
  const encoders = [active.encoderName, ...chain.filter((name) => name !== active.encoderName)]

  return encoders.map((name) => ({
    ...(sprite
      ? { spritePattern: sprite.pattern, spriteFrameRate: sprite.frameRate }
      : {}),
    ...(cameraPlan && cameraPath
      ? {
          camera: {
            inputPath: cameraPath,
            maskPath,
            frameRate: active.options.frameRate,
          },
        }
      : {}),
    filterScriptPath,
    encoderArgs: buildEncoderArgs(name, active.options.bitrate, active.options.frameRate, { lowLatency: active.options.lowLatency }),
  }))
}

/** Combines all segments (and the audio) into the final file. */
export async function finalizeNativeRecording(): Promise<
  | { success: true; filePath: string; bytesWritten: number }
  | { success: false; message: string }
> {
  if (!session) {
    return { success: false, message: 'There is no active recording.' }
  }

  const active = session
  const ffmpegPath = getFfmpegPath()

  try {
    if (!ffmpegPath) throw new Error('FFmpeg was not found.')

    // Make sure nothing is still capturing.
    if (active.current) {
      await active.current.stop()
      active.current = null
    }

    await active.audioQueue
    if (active.audioError) throw active.audioError

    let audioPath: string | null = null
    if (active.audioHandle) {
      await active.audioHandle.close()
      active.audioHandle = null

      const audioStats = await stat(active.audioPath).catch(() => null)
      if (audioStats && audioStats.size > 0) audioPath = active.audioPath
    }

    // A camera problem never costs the recording itself: without a usable
    // camera file the video is saved as it is.
    await active.cameraQueue
    let cameraPath: string | null = null
    if (active.cameraHandle) {
      await active.cameraHandle.close().catch(() => undefined)
      active.cameraHandle = null

      const cameraStats = await stat(active.cameraPath).catch(() => null)
      if (!active.cameraError && cameraStats && cameraStats.size > 0) cameraPath = active.cameraPath
    }

    const segmentInfos = await Promise.all(
      active.segments.map((segment) => stat(segment.outputPath).catch(() => null)),
    )
    const usable: CaptureSegment[] = active.segments.filter(
      (_segment, index) => (segmentInfos[index]?.size ?? 0) > 0,
    )
    if (usable.length === 0) {
      throw new Error('No video was captured.')
    }

    const listPath = path.join(active.tempDir, 'segments.txt')
    await writeFile(
      listPath,
      usable.map((segment) => concatListLine(segment.outputPath)).join('\n'),
      'utf8',
    )

    const audioDelaySeconds = audioPath && active.audioStartedAt && active.videoStartedAt
      ? (active.audioStartedAt - active.videoStartedAt) / 1000
      : 0

    // Mouse Click Effects: render the recorded clicks into the video. If that
    // is impossible the recording is still saved, just without the bubbles.
    const overlayAttempts = active.options.clickEffects || cameraPath
      ? await prepareClickOverlay(
          ffmpegPath, active, usable, audioPath, audioDelaySeconds, cameraPath,
        ).catch(() => [])
      : []

    let result: Awaited<ReturnType<typeof execFfmpeg>> | null = null
    for (const clickOverlay of [...overlayAttempts, undefined]) {
      result = await execFfmpeg(
        ffmpegPath,
        buildMuxArgs({
          concatListPath: listPath,
          audioPath,
          audioDelaySeconds,
          container: active.options.format,
          codec: active.options.encoder,
          outputPath: active.finalPath,
          audio: active.options.audio,
          clickOverlay,
        }),
        30 * 60_000,
      )
      if (result.code === 0) break
    }
    if (!result) throw new Error('Could not write the video file.')

    if (result.code !== 0) {
      throw new Error(
        `Could not write the ${active.options.format.toUpperCase()} file: ${result.stderr.trim().split(/\r?\n/).slice(-3).join(' ')}`,
      )
    }

    const info = await stat(active.finalPath)

    await cleanupSession(active)

    return { success: true, filePath: active.finalPath, bytesWritten: info.size }
  } catch (error) {
    await rm(active.finalPath, { force: true }).catch(() => undefined)
    await cleanupSession(active)
    return {
      success: false,
      message: error instanceof Error ? error.message : 'Could not finish the recording.',
    }
  }
}

/** Aborts a recording and removes every temporary file. */
export async function abortNativeRecording(): Promise<void> {
  const active = session
  if (!active) return

  active.captureStopped = true
  await active.current?.stop().catch(() => undefined)
  active.current = null
  await cleanupSession(active)
}
