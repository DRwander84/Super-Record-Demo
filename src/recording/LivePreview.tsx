import { useEffect, useRef, useState } from 'react'
import { Monitor } from 'lucide-react'
import type { AreaSelection } from '../types/electron'
import { cameraBox, drawCameraFrame, CAMERA_CORNER_RADIUS } from './cameraLayout'

type LivePreviewProps = {
  monitorId: string
  captureMode: 'full' | 'custom' | 'area'
  area: AreaSelection | null
  showCursor: boolean
  /** The preview only captures and draws while it is switched on. */
  enabled: boolean
  cameraEnabled: boolean
  cameraDeviceId: string
  cameraSize: string
  cameraShape: string
  cameraPosition: string
  cameraMirror: boolean
  cameraOpacity: number
}

type DisplayGeometry = { displayId: number; width: number; height: number }

const PREVIEW_FPS = 15
const MAX_PREVIEW_WIDTH = 960

function stopStream(stream: MediaStream | null) {
  stream?.getTracks().forEach((track) => track.stop())
}

/**
 * Low-cost live view of what will be recorded: the chosen monitor, the
 * selected area or full screen, the cursor setting and the webcam overlay. It
 * runs at a reduced size and frame rate, pauses while the window is hidden and
 * freezes while recording.
 */
export default function LivePreview(props: LivePreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const screenVideoRef = useRef<HTMLVideoElement | null>(null)
  const cameraVideoRef = useRef<HTMLVideoElement | null>(null)
  const geometryRef = useRef<DisplayGeometry | null>(null)
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

  const active = visible && props.enabled
  const areaPixelsKey = props.captureMode === 'area' && props.area ? 'area' : 'full'

  // Switching the preview off clears it; it does nothing until switched on.
  useEffect(() => {
    if (props.enabled) return
    setHasFrame(false)
    setFailed(false)
    const canvas = canvasRef.current
    canvas?.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height)
  }, [props.enabled])

  // Screen stream of the selected monitor.
  useEffect(() => {
    if (!active) return
    let cancelled = false
    let stream: MediaStream | null = null

    void (async () => {
      try {
        await window.electronAPI.setCaptureSource(props.monitorId || null)
        const [sources, displays] = await Promise.all([
          window.electronAPI.getCaptureSources(),
          window.electronAPI.getDisplays(),
        ])
        const source = sources.find((item) => item.id === props.monitorId)
        const display = source
          ? displays.find((item) => String(item.id) === source.displayId)
          : displays.find((item) => item.isPrimary)
        geometryRef.current = display
          ? { displayId: display.id, width: display.bounds.width, height: display.bounds.height }
          : null

        const wide = areaPixelsKey === 'area'
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            frameRate: { ideal: PREVIEW_FPS, max: PREVIEW_FPS },
            width: { max: wide ? 1920 : 1280 },
            height: { max: wide ? 1080 : 720 },
            cursor: props.showCursor ? 'always' : 'never',
          } as MediaTrackConstraints,
          audio: false,
        })
        if (cancelled) {
          stopStream(stream)
          return
        }
        const video = screenVideoRef.current
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
      if (screenVideoRef.current) screenVideoRef.current.srcObject = null
    }
  }, [active, props.monitorId, props.showCursor, areaPixelsKey])

  // Webcam stream, only while the camera is switched on.
  useEffect(() => {
    if (!active || !props.cameraEnabled) return
    let cancelled = false
    let stream: MediaStream | null = null

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
        const video = cameraVideoRef.current
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
      if (cameraVideoRef.current) cameraVideoRef.current.srcObject = null
    }
  }, [active, props.cameraEnabled, props.cameraDeviceId])

  // Draw loop at a low, fixed rate.
  useEffect(() => {
    if (!active) return

    const draw = () => {
      const canvas = canvasRef.current
      const video = screenVideoRef.current
      if (!canvas || !video || video.readyState < 2 || !video.videoWidth) return
      const context = canvas.getContext('2d')
      if (!context) return

      const current = propsRef.current
      const videoWidth = video.videoWidth
      const videoHeight = video.videoHeight
      const geometry = geometryRef.current
      const kx = geometry ? videoWidth / geometry.width : 1
      const ky = geometry ? videoHeight / geometry.height : 1

      // Region that will be recorded, in video pixels and in screen DIPs.
      let sx = 0
      let sy = 0
      let sw = videoWidth
      let sh = videoHeight
      let regionDipWidth = geometry?.width ?? videoWidth
      let regionDipHeight = geometry?.height ?? videoHeight

      if (
        current.captureMode === 'area' &&
        current.area &&
        geometry &&
        current.area.displayId === geometry.displayId
      ) {
        const rect = current.area.rect
        sx = Math.max(0, Math.min(videoWidth - 2, rect.x * kx))
        sy = Math.max(0, Math.min(videoHeight - 2, rect.y * ky))
        sw = Math.max(2, Math.min(videoWidth - sx, rect.width * kx))
        sh = Math.max(2, Math.min(videoHeight - sy, rect.height * ky))
        regionDipWidth = rect.width
        regionDipHeight = rect.height
      }

      const outWidth = Math.max(2, Math.min(MAX_PREVIEW_WIDTH, Math.round(sw)))
      const outHeight = Math.max(2, Math.round((outWidth * sh) / sw))
      if (canvas.width !== outWidth || canvas.height !== outHeight) {
        canvas.width = outWidth
        canvas.height = outHeight
      }

      context.drawImage(video, sx, sy, sw, sh, 0, 0, outWidth, outHeight)

      const camera = cameraVideoRef.current
      if (current.cameraEnabled && camera) {
        const box = cameraBox(
          regionDipWidth, regionDipHeight,
          current.cameraSize, current.cameraShape, current.cameraPosition,
        )
        const scale = outWidth / regionDipWidth
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
        ref={screenVideoRef}
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
      {!hasFrame && (
        <div className="text-center">
          <Monitor size={30} className="mx-auto text-zinc-700" />
          <p className="mt-3 text-[10px] text-zinc-600">
            {failed ? 'Preview unavailable' : props.enabled ? 'Preview' : 'Live Preview is off'}
          </p>
        </div>
      )}
    </div>
  )
}
