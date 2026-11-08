
import { useEffect, useRef, useState } from 'react'
import {
  CircleDot,
  Pause,
  Play,
  Square,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
} from 'lucide-react'
import { ScreenRecorder, type CameraOptions, type MonitorOptions } from './ScreenRecorder'
import type { AreaSelection, AudioOutputSettings, RecordingMode } from '../types/electron'

export type RecorderState =
  | 'idle'
  | 'recording'
  | 'paused'
  | 'stopping'
  | 'error'

type RecordingControlsProps = {
  onStateChange?: (state: RecorderState) => void
  frameRate?: number
  videoBitsPerSecond?: number
  microphoneEnabled?: boolean
  microphoneDeviceId?: string
  camera?: CameraOptions
  systemAudioEnabled?: boolean
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
  frameRateMode?: 'cfr' | 'vfr'
  lowLatency?: boolean
  hdr?: boolean
  gameId?: string
  gameProcessId?: number
  /** Speedrun Timer position; empty while the timer is switched off. */
  timerPosition?: string
  /** Gaming Mode Monitoring panel in the video; missing when it is off. */
  monitor?: MonitorOptions
}

function formatTime(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remainingSeconds = seconds % 60

  return [hours, minutes, remainingSeconds]
    .map((value) => String(value).padStart(2, '0'))
    .join(':')
}

export default function RecordingControls({
  onStateChange,
  frameRate = 30,
  videoBitsPerSecond = 20_000_000,
  microphoneEnabled = false,
  microphoneDeviceId,
  camera,
  systemAudioEnabled = false,
  showCursor = true,
  clickEffects = false,
  audio,
  mouseFocus = false,
  mouseZoomLevel = 2,
  mouseZoomSpeed = 'normal',
  resolution = 'original',
  captureMode = 'full',
  monitorId = '',
  encoder = 'h264',
  outputFormat = 'webm',
  mode = 'screen',
  area = null,
  frameRateMode = 'cfr',
  lowLatency = false,
  hdr = false,
  gameId = '',
  gameProcessId = 0,
  timerPosition = '',
  monitor,
}: RecordingControlsProps) {
  const recorderRef = useRef<ScreenRecorder | null>(null)

  const [status, setStatus] = useState<RecorderState>('idle')
  const [elapsed, setElapsed] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [savedPath, setSavedPath] = useState('')

  const onStateChangeRef = useRef(onStateChange)

  useEffect(() => {
    onStateChangeRef.current = onStateChange
  }, [onStateChange])

  useEffect(() => {
    const recorder = new ScreenRecorder({
      frameRate,
      videoBitsPerSecond,
      microphoneEnabled,
      microphoneDeviceId,
      camera,
      systemAudioEnabled,
      showCursor,
      clickEffects,
      audio,
      mouseFocus,
      mouseZoomLevel,
      mouseZoomSpeed,
      resolution,
      captureMode,
      monitorId,
      encoder,
      outputFormat,
      mode,
      area,
      frameRateMode,
      lowLatency,
      hdr,
      gameId,
      gameProcessId,
      timerPosition,
      monitor,
      onStateChange: (nextState) => {
        setStatus(nextState)
        onStateChangeRef.current?.(nextState)
      },
      onError: (message) => {
        setError(message)
      },
    })

    recorderRef.current = recorder

    return () => {
      if (recorderRef.current === recorder) {
        recorderRef.current = null
      }
    }
  }, [frameRate, videoBitsPerSecond, microphoneEnabled, microphoneDeviceId, camera, systemAudioEnabled, showCursor, clickEffects, audio, mouseFocus, mouseZoomLevel, mouseZoomSpeed, resolution, captureMode, monitorId, encoder, outputFormat, mode, area, frameRateMode, lowLatency, hdr, gameId, gameProcessId, timerPosition, monitor])

  useEffect(() => {
    if (status !== 'recording') return

    const interval = window.setInterval(() => {
      setElapsed((previous) => previous + 1)
    }, 1000)

    return () => window.clearInterval(interval)
  }, [status])

  const handleStart = async () => {
    const recorder = recorderRef.current

    if (!recorder || busy) return

    setBusy(true)
    setError('')
    setSavedPath('')
    setElapsed(0)

    try {
      const result = await recorder.start()

      if (!result.success) {
        setError(result.message)
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Could not start recording.',
      )
    } finally {
      setBusy(false)
    }
  }

  const handlePause = async () => {
    const recorder = recorderRef.current

    if (!recorder || busy) return

    setBusy(true)
    setError('')

    try {
      const result =
        status === 'paused'
          ? await recorder.resume()
          : await recorder.pause()

      if (!result.success) {
        setError(result.message)
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Could not change recording state.',
      )
    } finally {
      setBusy(false)
    }
  }

  const handleStop = async () => {
    const recorder = recorderRef.current

    if (!recorder || busy) return

    setBusy(true)
    setError('')

    try {
      const result = await recorder.stop()

      if (result.success) {
        setSavedPath(result.filePath ?? '')
        setElapsed(0)
      } else {
        setError(result.message)
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Could not save recording.',
      )
    } finally {
      setBusy(false)
    }
  }

  // Global keyboard shortcuts (Start / Pause / Stop). The latest handlers are
  // kept in a ref so the subscription is created only once.
  const shortcutHandlersRef = useRef({
    status,
    busy,
    start: handleStart,
    pause: handlePause,
    stop: handleStop,
  })

  useEffect(() => {
    shortcutHandlersRef.current = {
      status,
      busy,
      start: handleStart,
      pause: handlePause,
      stop: handleStop,
    }
  })

  useEffect(() => {
    return window.electronAPI.onShortcut((action) => {
      const current = shortcutHandlersRef.current
      const active =
        current.status === 'recording' || current.status === 'paused'

      if (current.busy) return

      if (action === 'pause' && active) {
        void current.pause()
      } else if (action === 'toggle') {
        // One key: starts when idle, stops while recording or paused.
        if (active) {
          void current.stop()
        } else if (current.status !== 'stopping') {
          void current.start()
        }
      }
    })
  }, [])

  const isActive =
    status === 'recording' ||
    status === 'paused' ||
    status === 'stopping'

  return (
    <section className="glass-panel mb-5 rounded-2xl p-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span
              className={`h-2 w-2 rounded-full ${
                status === 'recording'
                  ? 'animate-pulse bg-red-500'
                  : status === 'paused'
                    ? 'bg-amber-400'
                    : status === 'error'
                      ? 'bg-red-500'
                      : 'bg-zinc-600'
              }`}
            />

            <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-400">
              {status === 'recording'
                ? 'Recording'
                : status === 'paused'
                  ? 'Paused'
                  : status === 'stopping'
                    ? 'Saving'
                    : status === 'error'
                      ? 'Error'
                      : 'Ready'}
            </span>
          </div>

          <p className="mt-2 font-mono text-2xl font-bold tabular-nums">
            {formatTime(elapsed)}
          </p>

          <p className="mt-1 text-[10px] text-zinc-500">
            {mode === 'gaming' ? 'Game capture' : 'Screen capture'} · {outputFormat.toUpperCase()} · {frameRate} FPS
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {!isActive && (
            <button
              type="button"
              onClick={() => void handleStart()}
              disabled={busy}
              className="flex items-center gap-2 rounded-xl bg-red-500 px-5 py-3 text-xs font-bold text-white transition-colors hover:bg-red-400 disabled:opacity-50"
            >
              {busy ? (
                <RefreshCw size={15} className="animate-spin" />
              ) : (
                <CircleDot size={15} />
              )}
              Start Recording
            </button>
          )}

          {isActive && (
            <>
              <button
                type="button"
                onClick={() => void handlePause()}
                disabled={busy || status === 'stopping'}
                className={`flex items-center gap-2 rounded-xl px-4 py-3 text-xs font-bold transition-colors disabled:opacity-50 ${
                  status === 'paused'
                    ? 'bg-green-500/15 text-green-300 hover:bg-green-500/25'
                    : 'bg-amber-400/15 text-amber-300 hover:bg-amber-400/25'
                }`}
              >
                {busy ? (
                  <RefreshCw size={14} className="animate-spin" />
                ) : status === 'paused' ? (
                  <Play size={14} />
                ) : (
                  <Pause size={14} />
                )}

                {status === 'paused' ? 'Resume' : 'Pause'}
              </button>

              <button
                type="button"
                onClick={() => void handleStop()}
                disabled={busy}
                className="flex items-center gap-2 rounded-xl border border-red-400/20 bg-red-500/10 px-4 py-3 text-xs font-bold text-red-300 transition-colors hover:bg-red-500/20 disabled:opacity-50"
              >
                {busy ? (
                  <RefreshCw size={14} className="animate-spin" />
                ) : (
                  <Square size={13} fill="currentColor" />
                )}
                Stop
              </button>
            </>
          )}
        </div>
      </div>

      {error && (
        <div className="mt-4 flex items-start gap-2 rounded-xl border border-red-400/20 bg-red-500/[0.07] p-3 text-[10px] leading-5 text-red-300">
          <AlertCircle size={15} className="mt-0.5 shrink-0" />
          <span className="break-words">{error}</span>
        </div>
      )}

      {savedPath && (
        <div className="mt-4 flex items-start gap-2 rounded-xl border border-green-400/20 bg-green-500/[0.06] p-3 text-[10px] leading-5 text-green-300">
          <CheckCircle2 size={15} className="mt-0.5 shrink-0" />
          <div className="min-w-0">
            <p className="font-bold">Recording saved successfully.</p>
            <p className="mt-1 break-all text-green-300/70">
              {savedPath}
            </p>
          </div>
        </div>
      )}
    </section>
  )
}
