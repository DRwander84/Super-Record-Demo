import { useEffect, useRef } from 'react'

// Content of the transparent camera window that is recorded together with the
// screen. It runs in its own window without the preload bridge and reports its
// state to the main process through the document title.
export default function CameraOverlay() {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const params = new URLSearchParams(window.location.hash.split('?')[1] ?? '')
  const deviceId = params.get('device') ?? ''
  const shape = params.get('shape') ?? 'rounded'
  const mirror = params.get('mirror') === '1'
  const opacity = Math.max(20, Math.min(100, Number(params.get('opacity')) || 100))

  useEffect(() => {
    document.documentElement.style.setProperty('background', 'transparent', 'important')
    document.body.style.setProperty('background', 'transparent', 'important')

    let cancelled = false
    let stream: MediaStream | null = null

    const open = async () => {
      // Another window may still be releasing the camera; retry briefly.
      for (let attempt = 0; attempt < 5 && !cancelled; attempt += 1) {
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: {
              deviceId: deviceId ? { exact: deviceId } : undefined,
              width: { ideal: 1280 },
              height: { ideal: 720 },
              frameRate: { ideal: 30 },
            },
            audio: false,
          })
          break
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 400))
        }
      }

      if (cancelled) {
        stream?.getTracks().forEach((track) => track.stop())
        return
      }
      const video = videoRef.current
      if (!stream || !video) {
        document.title = 'camera-error'
        return
      }
      video.srcObject = stream
      try {
        await video.play()
      } catch {
        document.title = 'camera-error'
        return
      }
      const announce = () => { document.title = 'camera-ready' }
      if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(announce)
      else announce()
    }

    void open()
    return () => {
      cancelled = true
      stream?.getTracks().forEach((track) => track.stop())
    }
  }, [deviceId])

  const radius = shape === 'circle' ? '50%' : shape === 'rectangle' ? '0' : '16px'

  return (
    <video
      ref={videoRef}
      muted
      playsInline
      style={{
        width: '100vw',
        height: '100vh',
        objectFit: 'cover',
        display: 'block',
        borderRadius: radius,
        opacity: opacity / 100,
        transform: mirror ? 'scaleX(-1)' : undefined,
      }}
    />
  )
}
