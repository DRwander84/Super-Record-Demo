import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import {
  AUDIO_ENCODER_NAMES,
  buildAudioEncodeArgs,
  normalizeAudioSettings,
  type AudioCodec,
  type AudioSettings,
} from '../src/recording/audioSettings'

// ffmpeg-static is loaded at runtime (not bundled): it computes the path of
// the downloaded binary from its own location in node_modules.
const nodeRequire = createRequire(import.meta.url)

function loadFfmpegStaticPath(): string | null {
  try {
    const value: unknown = nodeRequire('ffmpeg-static')
    if (typeof value === 'string') return value
    const fallback = (value as { default?: unknown } | null)?.default
    return typeof fallback === 'string' ? fallback : null
  } catch {
    return null
  }
}

export type VideoCodec = 'h264' | 'hevc' | 'av1'
export type OutputContainer = 'mp4' | 'mkv' | 'mov' | 'webm'
export type CaptureBackend = 'ddagrab' | 'gdigrab'

export type PixelRect = {
  x: number
  y: number
  width: number
  height: number
}

// ---------------------------------------------------------------------------
// Binary lookup
// ---------------------------------------------------------------------------

export function getFfmpegPath(): string | null {
  const candidates = [
    process.env.SUPER_RECORD_FFMPEG,
    loadFfmpegStaticPath(),
  ]

  for (const candidate of candidates) {
    if (!candidate) continue

    // In a packaged app the binary lives outside the asar archive.
    const unpacked = candidate.replace('app.asar', 'app.asar.unpacked')
    if (unpacked !== candidate && existsSync(unpacked)) return unpacked
    if (existsSync(candidate)) return candidate
  }

  return null
}

// ---------------------------------------------------------------------------
// One-shot execution (probing, muxing)
// ---------------------------------------------------------------------------

export type ExecResult = {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export function execFfmpeg(
  ffmpegPath: string,
  args: string[],
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const child = spawn(ffmpegPath, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: env ?? process.env,
    })

    const finish = (code: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut })
    }

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)

    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString('utf8')
      if (stdout.length > 200_000) stdout = stdout.slice(-100_000)
    })
    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString('utf8')
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000)
    })
    child.on('error', (error) => {
      stderr += `\n${error.message}`
      finish(null)
    })
    child.on('close', (code) => finish(code))
  })
}

// ---------------------------------------------------------------------------
// Encoder selection
// ---------------------------------------------------------------------------

type EncoderCandidate = {
  name: string
  hardware: boolean
}

const ENCODER_CANDIDATES: Record<VideoCodec, EncoderCandidate[]> = {
  h264: [
    { name: 'h264_nvenc', hardware: true },
    { name: 'h264_amf', hardware: true },
    { name: 'h264_qsv', hardware: true },
    { name: 'libx264', hardware: false },
  ],
  hevc: [
    { name: 'hevc_nvenc', hardware: true },
    { name: 'hevc_amf', hardware: true },
    { name: 'hevc_qsv', hardware: true },
    { name: 'libx265', hardware: false },
  ],
  av1: [
    { name: 'av1_nvenc', hardware: true },
    { name: 'av1_amf', hardware: true },
    { name: 'av1_qsv', hardware: true },
    { name: 'libsvtav1', hardware: false },
    { name: 'libaom-av1', hardware: false },
  ],
}

type EncoderLists = { video: Set<string>; audio: Set<string> }

// One `ffmpeg -encoders` run serves both the video and the audio lookup, so
// the process is started once instead of twice.
let encoderListCache: Promise<EncoderLists> | null = null

function listAvailableEncoderSets(ffmpegPath: string): Promise<EncoderLists> {
  if (!encoderListCache) {
    encoderListCache = execFfmpeg(
      ffmpegPath,
      ['-hide_banner', '-encoders'],
      15_000,
    ).then((result) => {
      const video = new Set<string>()
      const audio = new Set<string>()
      for (const line of result.stdout.split(/\r?\n/)) {
        const match = /^\s*([VA])[.\w]{5}\s+(\S+)/.exec(line)
        if (!match) continue
        if (match[1] === 'V') video.add(match[2])
        else audio.add(match[2])
      }
      return { video, audio }
    })
  }
  return encoderListCache
}

async function listAvailableEncoders(ffmpegPath: string): Promise<Set<string>> {
  return (await listAvailableEncoderSets(ffmpegPath)).video
}

async function listAvailableAudioEncoders(ffmpegPath: string): Promise<Set<string>> {
  return (await listAvailableEncoderSets(ffmpegPath)).audio
}

/** Audio codecs whose FFmpeg encoder exists in this FFmpeg build. */
export async function getAvailableAudioCodecs(
  ffmpegPath: string,
): Promise<AudioCodec[]> {
  const available = await listAvailableAudioEncoders(ffmpegPath)
  return (Object.keys(AUDIO_ENCODER_NAMES) as AudioCodec[])
    .filter((codec) => available.has(AUDIO_ENCODER_NAMES[codec]))
}

/**
 * Starts FFmpeg's encoder discovery during application startup instead of
 * making the user wait for it when a recording is being finalized.
 * The same promise is shared by getEncoderChain(), so this is safe to call
 * concurrently with a recording start.
 */
export async function warmEncoderAvailability(): Promise<void> {
  const ffmpegPath = getFfmpegPath()
  if (!ffmpegPath) return
  await listAvailableEncoders(ffmpegPath)
}

/**
 * Returns the encoders compiled into this FFmpeg build for a codec, ordered by
 * preference (hardware first, software last).
 */
export async function getEncoderChain(
  ffmpegPath: string,
  codec: VideoCodec,
): Promise<string[]> {
  const available = await listAvailableEncoders(ffmpegPath)
  return ENCODER_CANDIDATES[codec]
    .filter((candidate) => available.has(candidate.name))
    .map((candidate) => candidate.name)
}

export function isHardwareEncoder(name: string): boolean {
  return /_(nvenc|amf|qsv)$/.test(name)
}

/** Encoders that are known to fail on this machine are skipped next time. */
const failedEncoders = new Set<string>()
const workingEncoders = new Map<VideoCodec, string>()

export function markEncoderFailed(name: string): void {
  failedEncoders.add(name)
}

export function markEncoderWorking(codec: VideoCodec, name: string): void {
  workingEncoders.set(codec, name)
}

export function orderEncoderChain(
  codec: VideoCodec,
  chain: string[],
): string[] {
  const usable = chain.filter((name) => !failedEncoders.has(name))
  const working = workingEncoders.get(codec)
  if (working && usable.includes(working)) {
    return [working, ...usable.filter((name) => name !== working)]
  }
  return usable
}

function kbps(bitsPerSecond: number): string {
  return `${Math.max(100, Math.round(bitsPerSecond / 1000))}k`
}

export type EncoderTuning = {
  /** Fastest, lowest-delay encoder settings (Gaming Mode: Low Latency Capture). */
  lowLatency?: boolean
  /** 10-bit output (Gaming Mode: HDR Recording). */
  tenBit?: boolean
  /** Slower, better looking settings for offline (non real-time) encodes. */
  highQuality?: boolean
}

export function buildEncoderArgs(
  encoder: string,
  bitsPerSecond: number,
  frameRate: number,
  tuning: EncoderTuning = {},
): string[] {
  const target = kbps(bitsPerSecond)
  const peak = kbps(bitsPerSecond * 1.5)
  const buffer = kbps(bitsPerSecond * 2)
  const gop = String(Math.max(1, Math.round(frameRate * 2)))
  const rate = ['-b:v', target, '-maxrate', peak, '-bufsize', buffer]
  const fast = Boolean(tuning.lowLatency)
  const tenBit = Boolean(tuning.tenBit)
  const best = Boolean(tuning.highQuality) && !fast
  const softwarePixelFormat = tenBit ? 'yuv420p10le' : 'yuv420p'
  const hardwarePixelFormat = tenBit ? 'p010le' : 'yuv420p'

  switch (encoder) {
    case 'libx264':
      return [
        '-c:v', 'libx264', '-preset', fast ? 'ultrafast' : best ? 'fast' : 'veryfast',
        ...(fast ? ['-tune', 'zerolatency'] : []),
        '-profile:v', 'high',
        ...rate, '-g', gop, '-pix_fmt', 'yuv420p',
      ]
    case 'libx265':
      return [
        '-c:v', 'libx265', '-preset', fast ? 'ultrafast' : best ? 'fast' : 'veryfast',
        ...(fast ? ['-tune', 'zerolatency'] : []),
        '-x265-params', 'log-level=error',
        ...rate, '-g', gop, '-pix_fmt', softwarePixelFormat,
      ]
    case 'libsvtav1':
      return [
        '-c:v', 'libsvtav1', '-preset', fast ? '12' : best ? '8' : '10',
        ...rate, '-g', gop, '-pix_fmt', softwarePixelFormat,
      ]
    case 'libaom-av1':
      return [
        '-c:v', 'libaom-av1', '-usage', 'realtime', '-cpu-used', '8',
        '-row-mt', '1', ...rate, '-g', gop, '-pix_fmt', softwarePixelFormat,
      ]
    case 'h264_nvenc':
    case 'hevc_nvenc':
    case 'av1_nvenc':
      return [
        '-c:v', encoder,
        ...(fast
          ? ['-preset', 'p2', '-tune', 'll']
          : best
            ? ['-preset', 'p5', '-tune', 'hq', ...(encoder === 'av1_nvenc' ? [] : ['-spatial_aq', '1'])]
            : ['-preset', 'p4']),
        '-rc', 'vbr',
        ...(tenBit && encoder === 'hevc_nvenc' ? ['-profile:v', 'main10'] : []),
        ...rate, '-g', gop, '-pix_fmt', hardwarePixelFormat,
      ]
    case 'h264_amf':
    case 'hevc_amf':
    case 'av1_amf':
      return [
        '-c:v', encoder,
        ...(fast ? ['-usage', 'lowlatency', '-quality', 'speed'] : best ? ['-quality', 'quality'] : ['-quality', 'balanced']),
        '-rc', 'vbr_peak',
        ...rate, '-g', gop, '-pix_fmt', hardwarePixelFormat,
      ]
    case 'h264_qsv':
    case 'hevc_qsv':
    case 'av1_qsv':
      return [
        '-c:v', encoder, '-preset', best ? 'medium' : 'veryfast',
        ...(fast ? ['-async_depth', '1'] : []),
        ...(tenBit && encoder === 'hevc_qsv' ? ['-profile:v', 'main10'] : []),
        ...rate, '-g', gop, '-pix_fmt', tenBit ? 'p010le' : 'nv12',
      ]
    default:
      throw new Error(`Unsupported video encoder: ${encoder}`)
  }
}

const filterSupport = new Map<string, boolean>()

/** True when this FFmpeg build contains the named filter (result is cached). */
export async function hasFfmpegFilter(ffmpegPath: string, name: string): Promise<boolean> {
  const cached = filterSupport.get(name)
  if (cached !== undefined) return cached
  const result = await execFfmpeg(ffmpegPath, ['-hide_banner', '-filters'], 10_000)
  const found = result.code === 0 && new RegExp(`\\s${name}\\s`).test(result.stdout)
  filterSupport.set(name, found)
  return found
}

/** WebM can only hold VP8/VP9/AV1 video. */
export function isCodecAllowedInContainer(
  codec: VideoCodec,
  container: OutputContainer,
): boolean {
  return container !== 'webm' || codec === 'av1'
}

// ---------------------------------------------------------------------------
// Screen grabber probing and input arguments
// ---------------------------------------------------------------------------

export type GrabberOutput = {
  index: number
  width: number
  height: number
}

/**
 * Lists the Desktop Duplication outputs that FFmpeg's ddagrab source can
 * open together with their pixel size, so a specific monitor can be matched.
 */
export async function probeDdagrabOutputs(
  ffmpegPath: string,
): Promise<GrabberOutput[]> {
  const outputs: GrabberOutput[] = []

  for (let index = 0; index < 8; index += 1) {
    const result = await execFfmpeg(
      ffmpegPath,
      [
        '-hide_banner', '-loglevel', 'info',
        '-f', 'lavfi',
        '-i', `ddagrab=output_idx=${index}:framerate=1`,
        '-frames:v', '1',
        '-f', 'null', '-',
      ],
      6_000,
    )

    if (result.code !== 0) break

    const match = /Video:[^\n]*?[ ,](\d{3,5})x(\d{3,5})/.exec(result.stderr)
    if (!match) break

    outputs.push({
      index,
      width: Number(match[1]),
      height: Number(match[2]),
    })
  }

  return outputs
}

export type VideoInputPlan = {
  backend: CaptureBackend
  /** Input related arguments, placed before the output options. */
  inputArgs: string[]
  /** Filter chain that ends in yuv420p frames. */
  videoFilter: string
}

export function buildVideoInputPlan(options: {
  backend: CaptureBackend
  outputIndex: number
  frameRate: number
  drawMouse: boolean
  /** Pixel region relative to the top-left corner of the captured display. */
  region: PixelRect
  /** Absolute pixel position of the display on the virtual desktop. */
  displayOrigin: { x: number; y: number }
  fullDisplay: boolean
  outputSize: { width: number; height: number } | null
}): VideoInputPlan {
  const { backend, frameRate, drawMouse, region, outputSize } = options
  const mouse = drawMouse ? '1' : '0'

  const scale = outputSize
    ? `,scale=${outputSize.width}:${outputSize.height}:flags=lanczos`
    : ''

  if (backend === 'ddagrab') {
    const crop = options.fullDisplay
      ? ''
      : `:video_size=${region.width}x${region.height}:offset_x=${region.x}:offset_y=${region.y}`

    return {
      backend,
      inputArgs: [
        '-f', 'lavfi',
        '-i',
        `ddagrab=output_idx=${options.outputIndex}:framerate=${frameRate}:draw_mouse=${mouse}${crop}`,
      ],
      videoFilter: `hwdownload,format=bgra${scale},format=yuv420p`,
    }
  }

  return {
    backend,
    inputArgs: [
      '-f', 'gdigrab',
      '-framerate', String(frameRate),
      '-draw_mouse', mouse,
      '-offset_x', String(options.displayOrigin.x + region.x),
      '-offset_y', String(options.displayOrigin.y + region.y),
      '-video_size', `${region.width}x${region.height}`,
      '-i', 'desktop',
    ],
    videoFilter: `format=bgra${scale},format=yuv420p`,
  }
}

// ---------------------------------------------------------------------------
// Capture segment (one continuous FFmpeg capture process)
// ---------------------------------------------------------------------------

export type SegmentOptions = {
  ffmpegPath: string
  inputArgs: string[]
  videoFilter: string
  encoderArgs: string[]
  outputPath: string
  env?: NodeJS.ProcessEnv
  startTimeoutMs?: number
}

export class CaptureSegment {
  readonly outputPath: string

  private child: ChildProcess | null = null
  private stderrTail = ''
  private exited = false
  private exitCode: number | null = null
  private stopRequested = false
  private exitWaiters: Array<() => void> = []

  /** Wall-clock time (ms) at which the first frame was encoded. */
  firstFrameAt = 0

  /** Invoked when FFmpeg ends without having been asked to stop. */
  onUnexpectedExit?: (message: string) => void

  private readonly options: SegmentOptions

  constructor(options: SegmentOptions) {
    this.options = options
    this.outputPath = options.outputPath
  }

  get errorTail(): string {
    return this.stderrTail.trim().split(/\r?\n/).slice(-6).join('\n')
  }

  start(): Promise<void> {
    const {
      ffmpegPath, inputArgs, videoFilter, encoderArgs, outputPath,
    } = this.options

    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-progress', 'pipe:1',
      '-stats_period', '0.1',
      ...inputArgs,
      '-vf', videoFilter,
      '-fps_mode', 'cfr',
      '-an',
      ...encoderArgs,
      '-f', 'matroska',
      outputPath,
    ]

    return new Promise<void>((resolve, reject) => {
      let settled = false
      let progressBuffer = ''

      const fail = (message: string) => {
        if (settled) return
        settled = true
        clearTimeout(startTimer)
        void this.stop().finally(() => reject(new Error(message)))
      }

      const child = spawn(ffmpegPath, args, {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: this.options.env ?? process.env,
      })
      this.child = child

      // A closed stdin pipe must never crash the main process.
      child.stdin?.on('error', () => undefined)

      const startTimer = setTimeout(() => {
        fail('Timed out while waiting for the first video frame.')
      }, this.options.startTimeoutMs ?? 15_000)

      child.stdout?.on('data', (data: Buffer) => {
        // Progress output is only needed to detect the first frame. Afterwards
        // the pipe is still drained, but nothing is parsed or concatenated.
        if (this.firstFrameAt) return
        progressBuffer += data.toString('utf8')
        const lines = progressBuffer.split(/\r?\n/)
        progressBuffer = lines.pop() ?? ''

        for (const line of lines) {
          const match = /^frame=(\d+)/.exec(line)
          if (match && Number(match[1]) >= 1 && !this.firstFrameAt) {
            this.firstFrameAt = Date.now()
            if (!settled) {
              settled = true
              clearTimeout(startTimer)
              resolve()
            }
          }
        }
      })

      child.stderr?.on('data', (data: Buffer) => {
        this.stderrTail = (this.stderrTail + data.toString('utf8')).slice(-4000)
      })

      child.on('error', (error) => {
        fail(`Could not start FFmpeg: ${error.message}`)
      })

      child.on('close', (code) => {
        this.exited = true
        this.exitCode = code
        for (const waiter of this.exitWaiters.splice(0)) waiter()

        if (!settled) {
          fail(this.errorTail || `FFmpeg exited with code ${code}.`)
          return
        }

        if (!this.stopRequested) {
          this.onUnexpectedExit?.(
            this.errorTail || `FFmpeg stopped unexpectedly (code ${code}).`,
          )
        }
      })
    })
  }

  private waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.exited) return Promise.resolve(true)

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        const index = this.exitWaiters.indexOf(waiter)
        if (index >= 0) this.exitWaiters.splice(index, 1)
        resolve(false)
      }, timeoutMs)

      const waiter = () => {
        clearTimeout(timer)
        resolve(true)
      }

      this.exitWaiters.push(waiter)
    })
  }

  /** Asks FFmpeg to finish the file cleanly and waits for it to exit. */
  async stop(): Promise<void> {
    const child = this.child
    if (!child) return

    this.stopRequested = true

    if (!this.exited) {
      try {
        child.stdin?.write('q')
        child.stdin?.end()
      } catch {
        // The process may already be gone.
      }

      const exitedCleanly = await this.waitForExit(10_000)

      if (!exitedCleanly) {
        child.kill('SIGKILL')
        await this.waitForExit(3_000)
      }
    }
  }

  get ended(): boolean {
    return this.exited
  }

  get code(): number | null {
    return this.exitCode
  }
}

// ---------------------------------------------------------------------------
// Final mux: concatenates the segments and adds the audio track
// ---------------------------------------------------------------------------

export function buildMuxArgs(options: {
  concatListPath: string
  audioPath: string | null
  /** Positive when the audio started after the video, in seconds. */
  audioDelaySeconds: number
  container: OutputContainer
  codec: VideoCodec
  outputPath: string
  /** Audio output settings; defaults are used when omitted. */
  audio?: AudioSettings
  /** Renders the Mouse Click Effects into the video (re-encodes the video). */
  clickOverlay?: {
    /** Click bubble animation; absent when only the camera is added. */
    spritePattern?: string
    spriteFrameRate?: number
    /** Camera recording (and optional shape mask) to place on the video. */
    camera?: {
      inputPath: string
      maskPath: string | null
      frameRate: number
    }
    filterScriptPath: string
    encoderArgs: string[]
  }
}): string[] {
  const {
    concatListPath, audioPath, audioDelaySeconds, container, codec, outputPath,
  } = options
  const audio = normalizeAudioSettings(options.audio, container)

  const args = ['-hide_banner', '-loglevel', 'error', '-y']

  // Delay whichever input started first so both timelines line up.
  const videoOffset = audioPath && audioDelaySeconds < -0.03
    ? ['-itsoffset', (-audioDelaySeconds).toFixed(3)]
    : []
  const audioOffset = audioPath && audioDelaySeconds > 0.03
    ? ['-itsoffset', audioDelaySeconds.toFixed(3)]
    : []

  args.push(
    ...videoOffset,
    '-f', 'concat', '-safe', '0', '-i', concatListPath,
  )

  if (audioPath) {
    args.push(...audioOffset, '-i', audioPath)
  }

  const overlay = options.clickOverlay
  if (overlay) {
    if (overlay.spritePattern) {
      args.push(
        '-framerate', String(overlay.spriteFrameRate ?? 30),
        '-i', overlay.spritePattern,
      )
    }
    if (overlay.camera) {
      args.push('-i', overlay.camera.inputPath)
      if (overlay.camera.maskPath) {
        args.push(
          '-loop', '1',
          '-framerate', String(Math.max(1, Math.round(overlay.camera.frameRate))),
          '-i', overlay.camera.maskPath,
        )
      }
    }
    args.push('-filter_complex_script', overlay.filterScriptPath)
  }

  args.push('-map', overlay ? '[vout]' : '0:v:0')

  if (audioPath) {
    args.push('-map', '1:a:0')
    args.push(...buildAudioEncodeArgs(audio))
    args.push('-af', 'aresample=async=1:first_pts=0', '-shortest')
  }

  if (overlay) {
    args.push(...overlay.encoderArgs)
  } else {
    args.push('-c:v', 'copy')
  }

  if (codec === 'hevc' && (container === 'mp4' || container === 'mov')) {
    args.push('-tag:v', 'hvc1')
  } else if (codec === 'av1' && (container === 'mp4' || container === 'mov')) {
    args.push('-tag:v', 'av01')
  }

  if (container === 'mp4' || container === 'mov') {
    args.push('-movflags', '+faststart')
  }

  // FFmpeg's "mov" muxer refuses AV1 ("av1 only supported in MP4 and AVIF").
  // A .mov file is the same ISO base media format, so it is written with the
  // MP4 muxer; the file keeps its .mov name.
  const format = container === 'mkv' ? 'matroska' : container === 'mov' && codec === 'av1' ? 'mp4' : container
  args.push('-f', format, outputPath)

  return args
}

export function concatListLine(filePath: string): string {
  // The concat demuxer expects single quoted, forward-slash paths.
  const normalized = filePath.replace(/\\/g, '/').replace(/'/g, "'\\''")
  return `file '${normalized}'`
}
