import { useEffect, useRef, useState } from 'react'
import { Activity, Camera, Gamepad2, MousePointer2, Mic, Timer, Volume2 } from 'lucide-react'
import { cameraBox, drawCameraFrame, CAMERA_CORNER_RADIUS } from './cameraLayout'
import { drawTimerBadge, formatTimer, timerBox, timerElapsed, type TimerSnapshot } from './timerLayout'
import {
  buildMonitorRows,
  drawMonitorPanel,
  monitorPanelBox,
  type MonitorMetric,
  type MonitorRow,
  type MonitorSnapshot,
} from './monitorLayout'

type GameLivePreviewProps = {
  /** Capture source id of the selected game, or null when none is chosen. */
  sourceId: string | null
  showCursor: boolean
  /** Shown as indicators so the preview lists everything that will be recorded. */
  gameAudio?: boolean
  microphone?: boolean
  /** Speedrun Timer: drawn exactly where the recording will show it. */
  timerEnabled?: boolean
  timerPosition?: string
  /** Monitoring panel: drawn exactly where the recording will show it. Missing when it is off. */
  monitor?: { position: string; metrics: MonitorMetric[] }
  /** The preview only captures while it is switched on. */
  enabled: boolean
  cameraEnabled: boolean
  cameraDeviceId: string
  cameraSize: string
  cameraShape: string
  cameraPosition: string
  cameraMirror: boolean
  cameraOpacity: number
}

const PREVIEW_FPS = 30
const MAX_PREVIEW_WIDTH = 1280

function stopStream(stream: MediaStream | null) {
  stream?.getTracks().forEach((track) => track.stop())
}

/**
 * Live view of the selected game only (never the desktop), including the
 * webcam overlay exactly as it will be recorded. It stops capturing when
 * switched off, while the window is hidden and while recording.
 */
export default function GameLivePreview(props: GameLivePreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const gameVideoRef = useRef<HTMLVideoElement | null>(null)
  const cameraVideoRef = useRef<HTMLVideoElement | null>(null)
  const propsRef = useRef(props)
  const [hasFrame, setHasFrame] = useState(false)
  const [failed, setFailed] = useState(false)
  const [visible, setVisible] = useState(() => !document.hidden)

  useEffect(() => {
    propsRef.current = props
  })

  useEffect(() => {
    const onVisibility = () => setVisible(!document.hidden)
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  const { sourceId, showCursor, enabled } = props
  const active = enabled && visible && Boolean(sourceId)

  // Switching the preview off clears it.
  useEffect(() => {
    if (enabled) return
    setHasFrame(false)
    setFailed(false)
    const canvas = canvasRef.current
    canvas?.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height)
  }, [enabled])

  // Stream of the selected game.
  useEffect(() => {
    if (!active || !sourceId) return
    let cancelled = false
    let stream: MediaStream | null = null
    const video = gameVideoRef.current

    void (async () => {
      try {
        // The game window can need a moment (for example right after switching
        // to full screen), so opening the capture is retried a few times.
        for (let attempt = 0; attempt < 4 && !stream && !cancelled; attempt++) {
          try {
            await window.electronAPI.setCaptureSource(sourceId)
            stream = await navigator.mediaDevices.getDisplayMedia({
              video: {
                frameRate: { ideal: PREVIEW_FPS, max: PREVIEW_FPS },
                width: { max: MAX_PREVIEW_WIDTH },
                height: { max: 720 },
                cursor: showCursor ? 'always' : 'never',
              } as MediaTrackConstraints,
              audio: false,
            })
          } catch (error) {
            if (attempt === 3) throw error
            await new Promise((resolve) => setTimeout(resolve, 800))
          }
        }
        if (!stream) return
        if (cancelled) {
          stopStream(stream)
          return
        }
        if (!video) return
        video.srcObject = stream
        await video.play()
        setFailed(false)
      } catch {
        if (!cancelled) setFailed(true)
      }
    })()

    return () => {
      cancelled = true
      stopStream(stream)
      if (video) video.srcObject = null
      setHasFrame(false)
    }
  }, [active, sourceId, showCursor])

  // Webcam stream, only while the camera is switched on.
  useEffect(() => {
    if (!active || !props.cameraEnabled) return
    let cancelled = false
    let stream: MediaStream | null = null
    const video = cameraVideoRef.current

    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            deviceId: props.cameraDeviceId ? { exact: props.cameraDeviceId } : undefined,
            width: { ideal: 640 },
            height: { ideal: 360 },
            frameRate: { ideal: PREVIEW_FPS },
          },
          audio: false,
        })
        if (cancelled) {
          stopStream(stream)
          return
        }
        if (!video) return
        video.srcObject = stream
        await video.play()
      } catch {
        // The preview simply shows no camera picture.
      }
    })()

    return () => {
      cancelled = true
      stopStream(stream)
      if (video) video.srcObject = null
    }
  }, [active, props.cameraEnabled, props.cameraDeviceId])

  // Speedrun Timer state (the clock itself runs in the main process).
  const timerStateRef = useRef<TimerSnapshot | null>(null)
  const timerOn = Boolean(props.timerEnabled)
  useEffect(() => {
    if (!timerOn) {
      timerStateRef.current = null
      return
    }
    let cancelled = false
    window.electronAPI.getTimerState()
      .then((snapshot) => { if (!cancelled) timerStateRef.current = snapshot })
      .catch(() => undefined)
    const unsubscribe = window.electronAPI.onTimerState((snapshot) => { timerStateRef.current = snapshot })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [timerOn])

  // Monitoring readings (collected by the main process once per second).
  const monitorStateRef = useRef<MonitorSnapshot | null>(null)
  const monitorRowsRef = useRef<{ state: MonitorSnapshot; metrics: MonitorMetric[]; rows: MonitorRow[] } | null>(null)
  const monitorOn = Boolean(props.monitor)
  useEffect(() => {
    if (!monitorOn) {
      monitorStateRef.current = null
      monitorRowsRef.current = null
      return
    }
    let cancelled = false
    window.electronAPI.getMonitorState()
      .then((state) => { if (!cancelled) monitorStateRef.current = state })
      .catch(() => undefined)
    const unsubscribe = window.electronAPI.onMonitorState((state) => { monitorStateRef.current = state })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [monitorOn])

  // Draw loop: game picture plus camera overlay.
  useEffect(() => {
    if (!active) return
    const draw = () => {
      const canvas = canvasRef.current
      const video = gameVideoRef.current
      if (!canvas || !video || video.readyState < 2 || !video.videoWidth) return
      const context = canvas.getContext('2d')
      if (!context) return
      const current = propsRef.current

      const outWidth = Math.max(2, Math.min(MAX_PREVIEW_WIDTH, video.videoWidth))
      const outHeight = Math.max(2, Math.round((outWidth * video.videoHeight) / video.videoWidth))
      if (canvas.width !== outWidth || canvas.height !== outHeight) {
        canvas.width = outWidth
        canvas.height = outHeight
      }
      context.drawImage(video, 0, 0, outWidth, outHeight)

      const camera = cameraVideoRef.current
      if (current.cameraEnabled && camera && camera.readyState >= 2) {
        // The recorder places the camera relative to the game picture, so the
        // preview does the same with the picture's own pixel size.
        const box = cameraBox(
          video.videoWidth, video.videoHeight,
          current.cameraSize, current.cameraShape, current.cameraPosition,
        )
        const scale = outWidth / video.videoWidth
        drawCameraFrame(context, camera, {
          x: box.x * scale,
          y: box.y * scale,
          width: box.width * scale,
          height: box.height * scale,
        }, {
          shape: current.cameraShape,
          mirror: current.cameraMirror,
          opacity: current.cameraOpacity,
          cornerRadius: CAMERA_CORNER_RADIUS * scale,
        })
      }
      const timerState = timerStateRef.current
      if (current.timerEnabled && timerState) {
        // Same rule as the recorder: placed inside the game picture.
        drawTimerBadge(
          context,
          timerBox(outWidth, outHeight, current.timerPosition ?? 'top-left'),
          formatTimer(timerElapsed(timerState)),
          timerState.status,
        )
      }
      const monitorState = monitorStateRef.current
      if (current.monitor && monitorState) {
        // Rows are rebuilt only when new readings (or other metrics) arrive.
        let cached = monitorRowsRef.current
        if (!cached || cached.state !== monitorState || cached.metrics !== current.monitor.metrics) {
          cached = {
            state: monitorState,
            metrics: current.monitor.metrics,
            rows: buildMonitorRows(monitorState, current.monitor.metrics),
          }
          monitorRowsRef.current = cached
        }
        if (cached.rows.length > 0) {
          drawMonitorPanel(
            context,
            monitorPanelBox(cached.rows, outWidth, outHeight, current.monitor.position),
            cached.rows,
          )
        }
      }
      setHasFrame(true)
    }
    const timer = setInterval(draw, Math.round(1000 / PREVIEW_FPS))
    return () => clearInterval(timer)
  }, [active])

  return (
    <div className="relative mt-4 flex aspect-video items-center justify-center overflow-hidden rounded-xl border border-white/[0.07] bg-black/40">
      <canvas
        ref={canvasRef}
        className={`h-full w-full object-contain ${hasFrame ? '' : 'hidden'}`}
      />
      <video
        ref={gameVideoRef}
        muted
        playsInline
        className="pointer-events-none absolute h-px w-px opacity-0"
      />
      <video
        ref={cameraVideoRef}
        muted
        playsInline
        className="pointer-events-none absolute h-px w-px opacity-0"
      />
      {hasFrame && (
        <div className="pointer-events-none absolute left-2 top-2 flex flex-wrap gap-1.5">
          {[
            { on: true, label: showCursor ? 'Cursor' : 'No cursor', icon: MousePointer2, dim: !showCursor },
            { on: props.cameraEnabled, label: 'Camera', icon: Camera, dim: false },
            { on: Boolean(props.timerEnabled), label: 'Speedrun timer', icon: Timer, dim: false },
            { on: Boolean(props.monitor), label: 'Monitoring', icon: Activity, dim: false },
            { on: Boolean(props.gameAudio), label: 'Game audio', icon: Volume2, dim: false },
            { on: Boolean(props.microphone), label: 'Microphone', icon: Mic, dim: false },
          ].filter((item) => item.on).map((item) => (
            <span
              key={item.label}
              className={`flex items-center gap-1 rounded-full bg-black/60 px-2 py-0.5 text-[9px] backdrop-blur ${item.dim ? 'text-zinc-500' : 'text-zinc-200'}`}
            >
              <item.icon size={10} />
              {item.label}
            </span>
          ))}
        </div>
      )}
      {!hasFrame && (
        <div className="text-center">
          <Gamepad2 size={32} className="mx-auto text-zinc-700" />
          <p className="mt-3 text-[10px] text-zinc-600">
            {!sourceId
              ? 'Select a game to preview it'
              : failed
                ? 'Preview unavailable'
                : enabled
                  ? 'Starting preview...'
                  : 'Live Game Preview is off'}
          </p>
        </div>
      )}
    </div>
  )
}
