import { writeFile } from 'node:fs/promises'
import { encodePng } from './clickOverlay'

// ---------------------------------------------------------------------------
// Webcam picture in the recorded video.
//
// The renderer records the camera into a small temporary WebM file. When the
// recording is finished, FFmpeg places that picture on the video in the final
// mux (shape mask, mirror, opacity and position included). Nothing is shown on
// the user's desktop while recording.
// ---------------------------------------------------------------------------

export type CameraPlan = {
  /** Position and size inside the final video, in pixels. */
  x: number
  y: number
  width: number
  height: number
  shape: string
  mirror: boolean
  /** 20 - 100 */
  opacity: number
  /** Corner radius of the rounded shape, in pixels. */
  cornerRadius: number
}

const even = (value: number) => Math.max(2, Math.round(value / 2) * 2)

/** Normalises a plan so every dimension is valid for the video encoder. */
export function normalizeCameraPlan(plan: CameraPlan, videoWidth: number, videoHeight: number): CameraPlan {
  const width = Math.min(even(plan.width), even(videoWidth))
  const height = Math.min(even(plan.height), even(videoHeight))
  return {
    ...plan,
    width,
    height,
    x: Math.max(0, Math.min(Math.round(plan.x), videoWidth - width)),
    y: Math.max(0, Math.min(Math.round(plan.y), videoHeight - height)),
    opacity: Math.max(20, Math.min(100, Math.round(plan.opacity))),
  }
}

/** Anti-aliased alpha mask for the rounded and circle shapes. */
export async function writeCameraMask(filePath: string, plan: CameraPlan): Promise<void> {
  const { width, height } = plan
  const pixels = new Uint8Array(width * height * 4)
  const radius = Math.min(plan.cornerRadius, width / 2, height / 2)
  const halfW = width / 2
  const halfH = height / 2

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const px = x + 0.5 - halfW
      const py = y + 0.5 - halfH
      let distance: number
      if (plan.shape === 'circle') {
        // Signed distance to the ellipse edge (approximate, in pixels).
        const k = Math.hypot(px / halfW, py / halfH)
        distance = (k - 1) * Math.min(halfW, halfH)
      } else {
        const qx = Math.abs(px) - (halfW - radius)
        const qy = Math.abs(py) - (halfH - radius)
        distance = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius
      }
      const coverage = Math.max(0, Math.min(1, 0.5 - distance))
      const offset = (y * width + x) * 4
      pixels[offset] = 255
      pixels[offset + 1] = 255
      pixels[offset + 2] = 255
      pixels[offset + 3] = Math.round(coverage * 255)
    }
  }

  await writeFile(filePath, encodePng(width, height, pixels))
}

/**
 * Filter graph part that places the camera on `baseLabel` and outputs
 * `outputLabel`. Input indexes refer to the final mux command.
 */
export function buildCameraFilterGraph(options: {
  plan: CameraPlan
  cameraInput: number
  maskInput: number | null
  baseLabel: string
  outputLabel: string
  frameRate: number
  /** Seconds the camera starts after the video (negative: before it). */
  offsetSeconds: number
}): string {
  const { plan, cameraInput, maskInput, baseLabel, outputLabel, frameRate } = options
  const offset = options.offsetSeconds
  const lines: string[] = []

  const chain = [
    `fps=${Math.max(1, Math.round(frameRate))}`,
    ...(offset < -0.02 ? [`trim=start=${(-offset).toFixed(3)}`] : []),
    'setpts=PTS-STARTPTS',
    ...(plan.mirror ? ['hflip'] : []),
    `scale=${plan.width}:${plan.height}:force_original_aspect_ratio=increase`,
    `crop=${plan.width}:${plan.height}`,
    'format=rgba',
  ]
  lines.push(`[${cameraInput}:v]${chain.join(',')}[camraw]`)

  let current = '[camraw]'
  if (maskInput !== null) {
    lines.push(`[${maskInput}:v]format=rgba,alphaextract[camshape]`)
    lines.push('[camraw][camshape]alphamerge[camshaped]')
    current = '[camshaped]'
  }

  const finish = [
    ...(plan.opacity < 100 ? [`colorchannelmixer=aa=${(plan.opacity / 100).toFixed(2)}`] : []),
    `setpts=PTS+${Math.max(0, offset).toFixed(3)}/TB`,
  ]
  lines.push(`${current}${finish.join(',')}[camfinal]`)

  lines.push(
    `${baseLabel}[camfinal]overlay=x=${plan.x}:y=${plan.y}:eof_action=pass${outputLabel}`,
  )
  return lines.join(';\n')
}
