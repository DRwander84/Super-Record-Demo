// Shared by the recorder (main process and renderer) and the Live Preview so
// the webcam picture is placed, sized and shaped identically everywhere.

export type CameraSizeOption = 'small' | 'medium' | 'large' | 'xlarge'

export const CAMERA_SIZE_LABELS: Array<{ label: string; value: CameraSizeOption }> = [
  { label: 'Small', value: 'small' },
  { label: 'Medium', value: 'medium' },
  { label: 'Large', value: 'large' },
  { label: 'Extra Large', value: 'xlarge' },
]

export type CameraPosition =
  | 'bottom-right'
  | 'bottom-left'
  | 'top-right'
  | 'top-left'
  | 'middle-right'
  | 'middle-left'
  | 'top-center'
  | 'bottom-center'

export const CAMERA_POSITIONS: Array<{ label: string; value: CameraPosition }> = [
  { label: 'Bottom Right', value: 'bottom-right' },
  { label: 'Bottom Left', value: 'bottom-left' },
  { label: 'Top Right', value: 'top-right' },
  { label: 'Top Left', value: 'top-left' },
  { label: 'Middle Right', value: 'middle-right' },
  { label: 'Middle Left', value: 'middle-left' },
  { label: 'Top Center', value: 'top-center' },
  { label: 'Bottom Center', value: 'bottom-center' },
]

const SIZE_FACTORS: Record<CameraSizeOption, number> = {
  small: 0.14,
  medium: 0.2,
  large: 0.28,
  xlarge: 0.36,
}

const MAX_MARGIN = 24
export const CAMERA_CORNER_RADIUS = 16

export type CameraBox = { x: number; y: number; width: number; height: number }

/**
 * Camera rectangle in the same unit as the region (device independent pixels),
 * relative to the top-left corner of the recorded region.
 */
export function cameraBox(
  regionWidth: number,
  regionHeight: number,
  size: string,
  shape: string,
  position: string = 'bottom-right',
): CameraBox {
  const factor = SIZE_FACTORS[size as CameraSizeOption] ?? SIZE_FACTORS.medium
  let width = Math.max(120, Math.round(regionWidth * factor))
  let height = Math.round((width * 9) / 16)

  if (shape === 'circle') {
    width = Math.round(width * 0.6)
    height = width
  }

  const maxHeight = regionHeight * 0.6
  if (height > maxHeight) {
    const ratio = maxHeight / height
    width = Math.max(2, Math.round(width * ratio))
    height = Math.max(2, Math.round(maxHeight))
  }

  const margin = Math.min(MAX_MARGIN, Math.round(regionWidth * 0.03))
  const [vertical, horizontal] = position.split('-') as [string, string]

  const x = horizontal === 'left'
    ? margin
    : horizontal === 'center'
      ? (regionWidth - width) / 2
      : regionWidth - width - margin
  const y = vertical === 'top'
    ? margin
    : vertical === 'middle'
      ? (regionHeight - height) / 2
      : regionHeight - height - margin

  return { width, height, x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)) }
}

/** Draws the camera picture (cover-fit, shaped, mirrored, translucent). */
export function drawCameraFrame(
  context: CanvasRenderingContext2D,
  camera: HTMLVideoElement,
  box: CameraBox,
  options: { shape: string; mirror: boolean; opacity: number; cornerRadius: number },
): void {
  if (camera.readyState < 2 || !camera.videoWidth) return

  const boxRatio = box.width / box.height
  const cameraRatio = camera.videoWidth / camera.videoHeight
  let sx = 0
  let sy = 0
  let sw = camera.videoWidth
  let sh = camera.videoHeight
  if (cameraRatio > boxRatio) {
    sw = sh * boxRatio
    sx = (camera.videoWidth - sw) / 2
  } else {
    sh = sw / boxRatio
    sy = (camera.videoHeight - sh) / 2
  }

  context.save()
  context.globalAlpha = Math.max(0.2, Math.min(1, options.opacity / 100))
  context.beginPath()
  if (options.shape === 'circle') {
    context.ellipse(
      box.x + box.width / 2, box.y + box.height / 2,
      box.width / 2, box.height / 2, 0, 0, Math.PI * 2,
    )
  } else if (options.shape === 'rectangle') {
    context.rect(box.x, box.y, box.width, box.height)
  } else {
    context.roundRect(box.x, box.y, box.width, box.height, options.cornerRadius)
  }
  context.clip()
  if (options.mirror) {
    context.translate(box.x + box.width, box.y)
    context.scale(-1, 1)
    context.drawImage(camera, sx, sy, sw, sh, 0, 0, box.width, box.height)
  } else {
    context.drawImage(camera, sx, sy, sw, sh, box.x, box.y, box.width, box.height)
  }
  context.restore()
}
