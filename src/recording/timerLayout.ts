// Speedrun Timer: layout and drawing shared by the recorder, the Live Game
// Preview and the on-screen overlay window, so the timer looks and sits the
// same everywhere. Positions are the same eight spots as the camera.

export type TimerStatus = 'idle' | 'running' | 'paused' | 'stopped'

export type TimerSnapshot = {
  status: TimerStatus
  /** Elapsed time at the moment `at` (Date.now()). */
  elapsedMs: number
  at: number
}

export const TIMER_FONT = '"Cascadia Mono", Consolas, "Courier New", monospace'

const MAX_MARGIN = 24

export type TimerBox = { x: number; y: number; width: number; height: number; fontSize: number }

export function timerElapsed(snapshot: TimerSnapshot, now: number = Date.now()): number {
  return snapshot.status === 'running'
    ? Math.max(0, snapshot.elapsedMs + (now - snapshot.at))
    : snapshot.elapsedMs
}

/** HH:MM:SS (hours grow past two digits only after 99 hours). */
export function formatTimer(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':')
}

export function timerColor(status: TimerStatus): string {
  return status === 'paused' ? '#fbbf24' : status === 'stopped' ? '#4ade80' : '#ffffff'
}

/** Timer rectangle inside a region of the given size (same unit as the region). */
export function timerBox(regionWidth: number, regionHeight: number, position: string = 'top-left'): TimerBox {
  const fontSize = Math.max(18, Math.min(96, Math.round(regionHeight * 0.05)))
  const width = Math.round(fontSize * 5.9)
  const height = Math.round(fontSize * 1.7)
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

  return { x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)), width, height, fontSize }
}

/** Draws the timer badge (rounded dark plate with the time) into a canvas. */
export function drawTimerBadge(
  context: CanvasRenderingContext2D,
  box: TimerBox,
  text: string,
  status: TimerStatus,
): void {
  context.save()
  context.fillStyle = 'rgba(0, 0, 0, 0.6)'
  context.beginPath()
  context.roundRect(box.x, box.y, box.width, box.height, box.fontSize * 0.3)
  context.fill()
  context.fillStyle = timerColor(status)
  context.font = `700 ${box.fontSize}px ${TIMER_FONT}`
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.fillText(text, box.x + box.width / 2, box.y + box.height / 2 + box.fontSize * 0.04)
  context.restore()
}
