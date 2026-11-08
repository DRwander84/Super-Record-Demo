import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { deflateSync } from 'node:zlib'
import type { ClickPoint } from './clickEffects'
import type { PixelRect } from './ffmpeg'

// ---------------------------------------------------------------------------
// Renders the Mouse Click Effects into the recorded video.
//
// A short bubble animation is generated as a PNG sequence (pure JS, no extra
// dependency). FFmpeg then overlays one copy of it at every recorded click,
// delayed to the click time and placed at the pointer position.
// ---------------------------------------------------------------------------

const BUBBLE_SECONDS = 0.55
const MAX_CLICKS = 600

export type BubbleSprite = {
  /** Printf style pattern accepted by FFmpeg's image2 demuxer. */
  pattern: string
  frameRate: number
  /** Width and height of every sprite frame in pixels. */
  size: number
  frames: number
}

export type OverlayClick = {
  /** Seconds from the start of the video. */
  time: number
  x: number
  y: number
}

// -- PNG encoding -----------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (let i = 0; i < buffer.length; i++) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // RGBA
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride)
      .copy(raw, y * (stride + 1) + 1)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

// -- Sprite drawing ---------------------------------------------------------

const clamp01 = (value: number) => Math.max(0, Math.min(1, value))

/** Bubble radius (pixels) for a video of the given height. */
export function bubbleRadius(outputHeight: number): number {
  return Math.round(Math.max(12, Math.min(32, outputHeight * 0.02)))
}

export async function createBubbleSprite(
  directory: string,
  outputHeight: number,
  frameRate: number,
): Promise<BubbleSprite> {
  const maxRadius = bubbleRadius(outputHeight)
  const size = maxRadius * 2 + 6
  const center = size / 2
  const frames = Math.max(8, Math.round(BUBBLE_SECONDS * Math.max(1, frameRate)))

  for (let index = 0; index < frames; index++) {
    const progress = index / (frames - 1)
    const eased = 1 - Math.pow(1 - progress, 3)
    const radius = maxRadius * (0.45 + 0.55 * eased)
    const fade = Math.pow(1 - progress, 1.3)
    const softness = radius * 0.12
    // The outline slowly drifts so it reads as a soft smudge, not a circle.
    const phaseA = 0.9 + progress * 1.4
    const phaseB = 2.1 - progress * 1.1
    const pixels = new Uint8Array(size * size * 4)

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = x + 0.5 - center
        const dy = y + 0.5 - center
        const distance = Math.hypot(dx, dy)
        const angle = Math.atan2(dy, dx)

        const wobble = 1 + 0.14 * Math.sin(2 * angle + phaseA) + 0.09 * Math.sin(3 * angle + phaseB)
        const edge = radius * 0.8 * wobble

        // Feathered edge: fully soft, no outline.
        const t = clamp01((edge + softness - distance) / (2 * softness))
        const alpha = t * t * (3 - 2 * t) * 0.3 * fade

        const offset = (y * size + x) * 4
        pixels[offset] = 205
        pixels[offset + 1] = 228
        pixels[offset + 2] = 255
        pixels[offset + 3] = Math.round(clamp01(alpha) * 255)
      }
    }

    await writeFile(
      path.join(directory, `click_${String(index).padStart(3, '0')}.png`),
      encodePng(size, size, pixels),
    )
  }

  return {
    pattern: path.join(directory, 'click_%03d.png'),
    frameRate: Math.max(1, frameRate),
    size,
    frames,
  }
}

// -- Mapping clicks onto the video ------------------------------------------

export type ClickGeometry = {
  /** Size of the recorded display in real pixels. */
  displayWidth: number
  displayHeight: number
  /** Captured region inside the display, in real pixels. */
  region: PixelRect
  /** Size of the final video. */
  outputWidth: number
  outputHeight: number
}

export type TimedSegment = {
  /** Wall-clock time (ms) of the segment's first frame. */
  startedAt: number
  /** Duration of the segment's video in seconds. */
  duration: number
}

/**
 * Converts wall-clock clicks into video time and video pixel coordinates.
 * Clicks made while paused or outside the captured region are dropped.
 * `shift` is added to every time (used when the video input is delayed).
 */
export function mapClicksToVideo(
  clicks: ClickPoint[],
  segments: TimedSegment[],
  geometry: ClickGeometry,
  sprite: BubbleSprite,
  shift: number,
): OverlayClick[] {
  const scaleX = geometry.outputWidth / geometry.region.width
  const scaleY = geometry.outputHeight / geometry.region.height
  const result: OverlayClick[] = []

  for (const click of clicks) {
    let index = -1
    for (let i = 0; i < segments.length; i++) {
      if (segments[i].startedAt <= click.at) index = i
    }
    if (index < 0) continue

    const relative = (click.at - segments[index].startedAt) / 1000
    if (relative < 0 || relative > segments[index].duration) continue

    const pixelX = (click.x * geometry.displayWidth - geometry.region.x) * scaleX
    const pixelY = (click.y * geometry.displayHeight - geometry.region.y) * scaleY
    if (pixelX < 0 || pixelY < 0 || pixelX > geometry.outputWidth || pixelY > geometry.outputHeight) {
      continue
    }

    let offset = 0
    for (let i = 0; i < index; i++) offset += segments[i].duration

    result.push({
      time: offset + relative + shift,
      x: Math.round(pixelX - sprite.size / 2),
      y: Math.round(pixelY - sprite.size / 2),
    })
    if (result.length >= MAX_CLICKS) break
  }

  return result
}

/**
 * FFmpeg filter graph that overlays one bubble animation per click.
 * `videoInput` / `spriteInput` are input indexes of the final command.
 */
export function buildClickFilterGraph(
  clicks: OverlayClick[],
  sprite: BubbleSprite,
  videoInput: number,
  spriteInput: number,
): string {
  const seconds = sprite.frames / sprite.frameRate
  const lines: string[] = []
  const labels = clicks.map((_, index) => `[c${index}]`)

  lines.push(
    clicks.length === 1
      ? `[${spriteInput}:v]format=rgba[c0]`
      : `[${spriteInput}:v]format=rgba,split=${clicks.length}${labels.join('')}`,
  )

  clicks.forEach((click, index) => {
    lines.push(
      `[c${index}]setpts=PTS-STARTPTS+${click.time.toFixed(3)}/TB[b${index}]`,
    )
  })

  let current = `[${videoInput}:v]`
  clicks.forEach((click, index) => {
    const output = index === clicks.length - 1 ? '[vout]' : `[v${index}]`
    const start = click.time.toFixed(3)
    const end = (click.time + seconds + 0.05).toFixed(3)
    lines.push(
      `${current}[b${index}]overlay=x=${click.x}:y=${click.y}:eof_action=pass:` +
      `enable='between(t,${start},${end})'${output}`,
    )
    current = output
  })

  return lines.join(';\n')
}
