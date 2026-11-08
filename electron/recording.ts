import { app } from 'electron'
import {
  open, mkdir, readdir, stat, rm, unlink,
  type FileHandle,
  readFile,
} from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { getAppSettings } from './settings'
import {
  buildEncoderArgs, execFfmpeg, getEncoderChain, getFfmpegPath, hasFfmpegFilter,
  getAvailableAudioCodecs,
  isHardwareEncoder, markEncoderFailed, markEncoderWorking, orderEncoderChain,
} from './ffmpeg'
import {
  buildAudioEncodeArgs, normalizeAudioSettings, type AudioSettings,
} from '../src/recording/audioSettings'
import type { RecordingMetadata } from '../src/types/electron'

export type RecordingMode = 'screen' | 'gaming'

export type RecordingSession = {
  id: string
  mode: RecordingMode
  filePath: string
  startedAt: number
  bytesWritten: number
  status: 'recording' | 'paused' | 'stopped' | 'error'
  metadata: RecordingMetadata
}

export type RecordingStartResult =
  | { success: true; session: RecordingSession }
  | { success: false; error: string; message: string }

export type RecordingFile = {
  name: string
  filePath: string
  size: number
  createdAt: number
  modifiedAt: number
  duration: null
  format: string
  metadata?: RecordingMetadata
}

let activeSession: RecordingSession | null = null
let outputStream: FileHandle | null = null
let writeQueue: Promise<void> = Promise.resolve()
let streamError: Error | null = null
let captureTempPath: string | null = null
// Resolve FFmpeg and the codec's encoder chain before recording begins. This
// keeps process startup and encoder discovery out of the Stop/finalize path.
let activeFfmpegPath: string | null = null
let activeEncoderChain: string[] = []
// User-selected audio output settings (Screen Record). Null keeps the
// original defaults used by Gaming Mode.
let activeAudioSettings: AudioSettings | null = null
// Video codec inside the temporary capture file. When it already is H.264 and
// the user wants H.264, Stop only repackages it instead of re-encoding.
let captureIsH264 = false
// Gaming Mode video options (null / false for Screen Record, which keeps its
// original behavior): frame rate mode, low latency encoding and HDR10 output.
let activeFrameRateMode: 'cfr' | 'vfr' | null = null
let activeLowLatency = false
let activeHdr = false

function timestamp(): string {
  const date = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
}

function safeFilename(value: string): string {
  const cleaned = value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, 80)
  return cleaned || 'Recording'
}

export function getActiveRecording(): RecordingSession | null {
  return activeSession ? { ...activeSession } : null
}

export async function startRecordingSession(
  mode: RecordingMode,
  title?: string,
  format: 'webm' | 'mp4' = 'webm',
  metadata?: Record<string, unknown>,
): Promise<RecordingStartResult> {
  if (activeSession) {
    return {
      success: false,
      error: 'RECORDING_ALREADY_ACTIVE',
      message: 'A recording session is already active.',
    }
  }

  let createdPath: string | null = null

  try {
    const settings = await getAppSettings()
    await mkdir(settings.outputDirectory, { recursive: true })

    const requestedFormat: 'webm' | 'mp4' | 'mkv' | 'mov' =
      metadata?.format === 'webm' || metadata?.format === 'mp4' || metadata?.format === 'mkv' || metadata?.format === 'mov'
        ? metadata.format
        : format
    const requestedCodec: 'h264' | 'hevc' | 'av1' =
      metadata?.codec === 'hevc' || metadata?.codec === 'av1' ? metadata.codec : 'h264'

    // Encoder discovery starts during app startup and is awaited here as a
    // safety net. Never run `ffmpeg -encoders` for the first time on Stop.
    const ffmpegPath = getFfmpegPath()
    if (!ffmpegPath) {
      throw new Error('FFmpeg was not found. Install the project dependencies again and retry.')
    }
    const encoderChain = orderEncoderChain(
      requestedCodec,
      await getEncoderChain(ffmpegPath, requestedCodec),
    )
    if (encoderChain.length === 0) {
      throw new Error(`This FFmpeg build has no ${requestedCodec.toUpperCase()} encoder.`)
    }

    captureIsH264 = metadata?.captureCodec === 'h264'
    activeFrameRateMode = metadata?.frameRateMode === 'cfr' || metadata?.frameRateMode === 'vfr' ? metadata.frameRateMode : null
    activeLowLatency = metadata?.lowLatency === true
    // HDR10 needs a 10-bit capable codec and a container that can carry it.
    activeHdr = metadata?.hdr === true && requestedCodec !== 'h264' && requestedFormat !== 'webm'
    activeAudioSettings = null
    if (typeof metadata?.audio === 'object' && metadata.audio !== null) {
      const audio = normalizeAudioSettings(
        metadata.audio as Record<string, unknown>,
        requestedFormat,
      )
      const audioCodecs = await getAvailableAudioCodecs(ffmpegPath)
      if (!audioCodecs.includes(audio.codec)) {
        throw new Error(`This FFmpeg build cannot encode ${audio.codec.toUpperCase()} audio. Choose another Audio Codec.`)
      }
      activeAudioSettings = audio
    }

    const filenameBase = `${safeFilename(title || (mode === 'gaming' ? 'Game' : 'Screen'))}_${timestamp()}_${randomUUID().slice(0, 8)}`
    createdPath = path.join(settings.outputDirectory, `${filenameBase}.${requestedFormat}`)
    // MediaRecorder writes a temporary WebM stream. FFmpeg creates the actual
    // user-selected output file and codec when the recording is finalized.
    captureTempPath = path.join(settings.outputDirectory, `${filenameBase}.capture.webm`)

    const handle = await open(captureTempPath, 'wx')
    outputStream = handle
    writeQueue = Promise.resolve()
    streamError = null

    activeFfmpegPath = ffmpegPath
    activeEncoderChain = encoderChain

    activeSession = {
      id: randomUUID(),
      mode,
      filePath: createdPath,
      startedAt: Date.now(),
      bytesWritten: 0,
      status: 'recording',
      metadata: {
        mode, format: requestedFormat, codec: requestedCodec,
        resolution: String(metadata?.resolution ?? 'unknown'),
        width: Number.isFinite(metadata?.width) ? Number(metadata?.width) : null,
        height: Number.isFinite(metadata?.height) ? Number(metadata?.height) : null,
        frameRate: Number(metadata?.frameRate ?? 0),
        bitrate: Number(metadata?.bitrate ?? 0),
        captureMode: metadata?.captureMode === 'custom' || metadata?.captureMode === 'area' ? metadata.captureMode : 'full',
      },
    }

    return { success: true, session: { ...activeSession } }
  } catch (error) {
    outputStream = null
    activeSession = null
    activeFfmpegPath = null
    activeEncoderChain = []
    activeAudioSettings = null
    if (createdPath) await rm(createdPath, { force: true }).catch(() => undefined)
    if (captureTempPath) await rm(captureTempPath, { force: true }).catch(() => undefined)
    captureTempPath = null
    return {
      success: false,
      error: 'RECORDING_FILE_CREATE_FAILED',
      message: error instanceof Error ? error.message : 'Could not create the recording file.',
    }
  }
}

export function writeRecordingChunk(sessionId: string, chunk: Uint8Array): Promise<void> {
  if (!activeSession || activeSession.id !== sessionId) {
    return Promise.reject(new Error('Invalid recording session.'))
  }
  if (activeSession.status !== 'recording') {
    return Promise.reject(new Error('Recording is not active.'))
  }
  if (!outputStream || streamError) {
    return Promise.reject(streamError ?? new Error('Recording output is unavailable.'))
  }

  // Zero-copy view of the IPC buffer (the chunk is not touched afterwards).
  const data = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
  const handle = outputStream

  const currentWrite = writeQueue.then(async () => {
    if (streamError) throw streamError
    await handle.writeFile(data)
    if (activeSession?.id === sessionId) {
      activeSession.bytesWritten += data.length
    }
  })

  // Keep the internal queue settled after failure so finalization can still close
  // the file handle; return the failing operation to the caller.
  writeQueue = currentWrite.catch((error: unknown) => {
    streamError = error instanceof Error ? error : new Error(String(error))
  })

  return currentWrite
}

export async function setRecordingPaused(sessionId: string, paused: boolean): Promise<boolean> {
  if (!activeSession || activeSession.id !== sessionId) return false
  if (paused && activeSession.status === 'recording') {
    await writeQueue
    if (streamError) return false
    activeSession.status = 'paused'
    return true
  }
  if (!paused && activeSession.status === 'paused') {
    activeSession.status = 'recording'
    return true
  }
  return false
}

export async function stopRecordingSession(sessionId: string): Promise<RecordingSession | null> {
  if (!activeSession) return null
  if (activeSession.id !== sessionId) return null

  const session = activeSession
  const tempPath = captureTempPath
  let finalizationError: Error | null = null

  try {
    await writeQueue
    if (streamError) finalizationError = streamError
  } catch (error) {
    finalizationError = error instanceof Error ? error : new Error(String(error))
  }

  const handle = outputStream
  outputStream = null

  if (handle) {
    // No fsync: the temporary capture is read straight back by FFmpeg on this
    // machine (served from the OS cache), so forcing it to disk only delays Stop.
    try { await handle.close() } catch (error) {
      finalizationError ??= error instanceof Error ? error : new Error(String(error))
    }
  }

  try {
    if (finalizationError) throw finalizationError
    if (!tempPath) throw new Error('The temporary capture file is unavailable.')

    const ffmpegPath = activeFfmpegPath
    if (!ffmpegPath) throw new Error('The FFmpeg recording session is not initialized.')

    const format = session.metadata.format as 'webm' | 'mp4' | 'mkv' | 'mov'
    const codec = session.metadata.codec as 'h264' | 'hevc' | 'av1'
    const bitrate = Math.max(100_000, Number(session.metadata.bitrate) || 20_000_000)
    const frameRate = Math.max(1, Number(session.metadata.frameRate) || 30)
    const chain = [...activeEncoderChain]
    if (chain.length === 0) throw new Error(`No prepared ${codec.toUpperCase()} encoder is available.`)

    let encoded = false
    let lastError = ''

    const audioArgs = activeAudioSettings
      ? buildAudioEncodeArgs(normalizeAudioSettings(activeAudioSettings, format))
      : format === 'webm'
        ? ['-c:a', 'libopus', '-b:a', '160k']
        : ['-c:a', 'aac', '-b:a', '192k']

    // Fast path: the capture is already H.264, so the picture is copied without
    // re-encoding (finishes in seconds, no quality loss). Only the audio is
    // converted to the chosen audio codec. Falls back to full encoding on error.
    if (captureIsH264 && codec === 'h264' && format !== 'webm' && activeFrameRateMode !== 'cfr') {
      const copyArgs = [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-i', tempPath,
        '-map', '0:v:0', '-map', '0:a?',
        '-c:v', 'copy',
        ...audioArgs,
        ...(format === 'mp4' || format === 'mov' ? ['-movflags', '+faststart'] : []),
        '-f', format === 'mkv' ? 'matroska' : format, session.filePath,
      ]
      const copied = await execFfmpeg(ffmpegPath, copyArgs, 10 * 60_000)
      if (copied.code === 0) {
        encoded = true
      } else {
        await rm(session.filePath, { force: true }).catch(() => undefined)
      }
    }

    // Gaming Mode: window captures can have odd sizes, which 4:2:0 encoders
    // reject, so the picture is cropped by at most one pixel to an even size.
    const videoFilters: string[] = []
    // AV1 encoders also refuse odd picture sizes, which a Mouse Focus canvas can have.
    if (activeFrameRateMode !== null || codec === 'av1') videoFilters.push('crop=trunc(iw/2)*2:trunc(ih/2)*2')
    // HDR10: map the captured picture into BT.2020 / PQ with 10-bit samples.
    const hdrTagged = activeHdr && await hasFfmpegFilter(ffmpegPath, 'zscale')
    if (hdrTagged) {
      videoFilters.push(
        'zscale=tin=bt709:min=bt709:pin=bt709:rin=tv:t=linear:npl=203',
        'format=gbrpf32le',
        'zscale=p=bt2020:t=smpte2084:m=bt2020nc:r=tv',
        'format=yuv420p10le',
      )
    } else if (activeHdr) {
      videoFilters.push('format=yuv420p10le')
    }
    const frameRateArgs = activeFrameRateMode === 'cfr'
      ? ['-fps_mode', 'cfr', '-r', String(frameRate)]
      : activeFrameRateMode === 'vfr'
        ? ['-fps_mode', 'vfr']
        // A Mouse Focus capture has irregular timestamps; AV1 encoders need a steady rate.
        : codec === 'av1'
          ? ['-fps_mode', 'cfr', '-r', String(frameRate)]
          : []

    // Filter plans, from the preferred one to the most forgiving one. A game
    // window can change size while it is recorded (loading screens, switching
    // between window and full screen), a decoder can hand over damaged frames
    // and zimg (zscale) can refuse a picture. Any of these makes FFmpeg stop
    // with "Failed to inject frame into filter network". Since that is a
    // problem of the picture and not of the encoder, the next plan is tried
    // instead of declaring the (working) encoder broken.
    type FilterPlan = { filters: string[]; hdrTagged: boolean; inputArgs: string[] }
    const plans: FilterPlan[] = [{ filters: videoFilters, hdrTagged, inputArgs: [] }]
    const pixelFormat = activeHdr ? 'yuv420p10le' : 'yuv420p'
    const evenWidth = Math.floor(Number(session.metadata.width) / 2) * 2
    const evenHeight = Math.floor(Number(session.metadata.height) / 2) * 2
    if (activeFrameRateMode !== null && evenWidth >= 16 && evenHeight >= 16) {
      // Every frame is fitted into the size the recording started with, so a
      // mid-recording size change can no longer break the filter graph.
      plans.push({
        filters: [
          `scale=${evenWidth}:${evenHeight}:force_original_aspect_ratio=decrease:flags=bicubic`,
          `pad=${evenWidth}:${evenHeight}:(ow-iw)/2:(oh-ih)/2:black`,
          'setsar=1',
          `format=${pixelFormat}`,
        ],
        hdrTagged: false,
        inputArgs: ['-fflags', '+genpts+discardcorrupt'],
      })
    }
    plans.push({
      filters: ['scale=trunc(iw/2)*2:trunc(ih/2)*2:flags=bicubic', `format=${pixelFormat}`],
      hdrTagged: false,
      inputArgs: ['-fflags', '+genpts+discardcorrupt', '-err_detect', 'ignore_err'],
    })

    // "Error while filtering" is also what FFmpeg prints when an encoder cannot be
    // opened (no NVIDIA driver, no AV1 GPU...). That is an encoder problem, so
    // the next encoder must be tried instead of changing the filter plan.
    const isEncoderOpenFailure = (text: string) =>
      /Error while opening encoder|Cannot load nvcuda|Cannot load|No capable devices|OpenEncodeSessionEx|Failed loading|Could not open encoder|Device creation failed|No device available|not supported by|Unknown encoder|Encoder .* not found/i.test(text)
    const isFilterFailure = (text: string) =>
      !isEncoderOpenFailure(text) &&
      /Failed to inject frame|Error while filtering|Error reinitializing filters|Impossible to convert between|\[(?:Parsed_)?(?:zscale|scale|crop|pad|format)[^\]]*\]/i.test(text)

    for (const plan of encoded ? [] : plans) {
      let filterFailed = false
      for (const encoderName of chain) {
        const args = [
          '-hide_banner', '-loglevel', 'error', '-y',
          ...plan.inputArgs,
          '-i', tempPath,
          '-map', '0:v:0', '-map', '0:a?',
          ...(plan.filters.length > 0 ? ['-vf', plan.filters.join(',')] : []),
          ...frameRateArgs,
          ...buildEncoderArgs(encoderName, bitrate, frameRate, { lowLatency: activeLowLatency, tenBit: activeHdr, highQuality: activeFrameRateMode !== null }),
          ...(plan.hdrTagged
            ? ['-colorspace', 'bt2020nc', '-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-color_range', 'tv']
            : []),
          ...audioArgs,
        ]
        if (codec === 'hevc' && (format === 'mp4' || format === 'mov')) {
          args.push('-tag:v', 'hvc1')
        } else if (codec === 'av1' && (format === 'mp4' || format === 'mov')) {
          // Explicit ISO-BMFF AV1 sample entry avoids ambiguous MOV codec tags.
          args.push('-tag:v', 'av01')
        }
        if (format === 'mp4' || format === 'mov') args.push('-movflags', '+faststart')
        // The "mov" muxer cannot hold AV1; the MP4 muxer writes a valid .mov for it.
        args.push('-f', format === 'mkv' ? 'matroska' : format === 'mov' && codec === 'av1' ? 'mp4' : format, session.filePath)

        // Software AV1 is slow, so a long recording gets far more time.
        const result = await execFfmpeg(ffmpegPath, args, (codec === 'av1' ? 120 : 10) * 60_000)
        if (result.code === 0) {
          markEncoderWorking(codec, encoderName)
          encoded = true
          break
        }
        lastError = result.stderr.trim().split(/\r?\n/).slice(-8).join(' ')
        await rm(session.filePath, { force: true }).catch(() => undefined)
        if (isFilterFailure(result.stderr)) {
          // The same picture would fail with every encoder: change the plan.
          filterFailed = true
          break
        }
        if (isHardwareEncoder(encoderName)) markEncoderFailed(encoderName)
      }
      if (encoded || !filterFailed) break
    }
    if (!encoded) throw new Error(`Could not encode the ${format.toUpperCase()} recording: ${lastError || 'all available encoders failed.'}`)

    const info = await stat(session.filePath)
    session.bytesWritten = info.size
    session.status = 'stopped'

    const completed = { ...session }
    activeSession = null
    outputStream = null
    captureTempPath = null
    activeFfmpegPath = null
    activeEncoderChain = []
    activeAudioSettings = null
    writeQueue = Promise.resolve()
    streamError = null
    await rm(tempPath, { force: true }).catch(() => undefined)
    return completed
  } catch (error) {
    session.status = 'error'
    activeSession = null
    outputStream = null
    captureTempPath = null
    activeFfmpegPath = null
    activeEncoderChain = []
    activeAudioSettings = null
    writeQueue = Promise.resolve()
    streamError = null
    await rm(session.filePath, { force: true }).catch(() => undefined)
    await rm(`${session.filePath}.json`, { force: true }).catch(() => undefined)
    if (tempPath) await rm(tempPath, { force: true }).catch(() => undefined)
    throw error instanceof Error ? error : new Error(String(error))
  }
}

export async function listRecordingFiles(): Promise<RecordingFile[]> {
  const settings = await getAppSettings()
  const directory = settings.outputDirectory
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(entries
    .filter((entry) => entry.isFile() && !entry.name.endsWith('.capture.webm') && /\.(webm|mp4|mkv|mov|avi|m4v|wmv)$/i.test(entry.name))
    .map(async (entry): Promise<RecordingFile | null> => {
      const filePath = path.join(directory, entry.name)
      try {
        const stats = await stat(filePath)
        return {
          name: entry.name,
          filePath,
          size: stats.size,
          createdAt: stats.birthtimeMs,
          modifiedAt: stats.mtimeMs,
          duration: null,
          format: path.extname(entry.name).slice(1).toLowerCase() as RecordingFile['format'],
          metadata: await readFile(`${filePath}.json`, 'utf8').then((raw) => JSON.parse(raw) as RecordingMetadata).catch(() => undefined),
        }
      } catch {
        return null
      }
    }))
  return files.filter((file): file is RecordingFile => file !== null)
    .sort((a, b) => b.createdAt - a.createdAt)
}

export async function removeRecordingFile(filePath: string): Promise<void> {
  const settings = await getAppSettings()
  const root = path.resolve(settings.outputDirectory)
  const target = path.resolve(filePath)
  if (path.dirname(target) !== root || !/\.(webm|mp4|mkv|mov|avi|m4v|wmv)$/i.test(target)) {
    throw new Error('The selected file is outside the recording folder.')
  }
  if (activeSession?.filePath === target) {
    throw new Error('Stop the active recording before deleting it.')
  }
  await unlink(target)
  await unlink(`${target}.json`).catch(() => undefined)
}

export function getRecordingEngineInfo() {
  return {
    platform: process.platform,
    architecture: process.arch,
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    appVersion: app.getVersion(),
    outputFormat: 'webm',
    engineReady: true,
  }
}
