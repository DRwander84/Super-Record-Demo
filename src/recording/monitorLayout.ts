// Gaming Mode Monitoring: data model, text rows, layout and drawing shared by
// the recorder (canvas), the Live Game Preview and the on-screen overlay window,
// so the panel looks and sits identically everywhere. Positions are the same
// eight spots as the camera.

export type MonitorMetric =
  | 'gpuUsage'
  | 'gpuTemp'
  | 'vram'
  | 'gpuClock'
  | 'gpuMemClock'
  | 'ram'
  | 'cpuUsage'
  | 'cpuTemp'
  | 'fps'

export const MONITOR_METRICS: Array<{ key: MonitorMetric; label: string }> = [
  { key: 'gpuUsage', label: 'GPU Usage' },
  { key: 'gpuTemp', label: 'GPU TEMP' },
  { key: 'vram', label: 'VRAM' },
  { key: 'gpuClock', label: 'GPU Core Clock' },
  { key: 'gpuMemClock', label: 'GPU Memory Clock' },
  { key: 'ram', label: 'RAM Usage' },
  { key: 'cpuUsage', label: 'CPU Usage' },
  { key: 'cpuTemp', label: 'CPU TEMP' },
  { key: 'fps', label: 'FPS' },
]

export const ALL_MONITOR_METRICS: MonitorMetric[] = MONITOR_METRICS.map((item) => item.key)

/** Keeps only known metrics, in display order, without duplicates. */
export function normalizeMonitorMetrics(value: unknown): MonitorMetric[] {
  if (!Array.isArray(value)) return [...ALL_MONITOR_METRICS]
  return ALL_MONITOR_METRICS.filter((key) => value.includes(key))
}

export type GpuVendor = 'nvidia' | 'amd' | 'intel' | 'unknown'
export type CpuVendor = 'intel' | 'amd' | 'unknown'

export type MonitorInfo = {
  gpuName: string
  gpuVendor: GpuVendor
  /** Total video memory in MB, or null while unknown. */
  gpuMemoryMb: number | null
  cpuName: string
  cpuVendor: CpuVendor
}

export type MonitorStats = {
  gpuUsage: number | null
  gpuTemp: number | null
  vramUsedMb: number | null
  gpuClock: number | null
  gpuMemClock: number | null
  ramUsedMb: number | null
  ramTotalMb: number | null
  cpuUsage: number | null
  cpuTemp: number | null
  fps: number | null
}

export type MonitorSnapshot = {
  info: MonitorInfo
  stats: MonitorStats
}

export const EMPTY_MONITOR_INFO: MonitorInfo = {
  gpuName: '',
  gpuVendor: 'unknown',
  gpuMemoryMb: null,
  cpuName: '',
  cpuVendor: 'unknown',
}

export const EMPTY_MONITOR_STATS: MonitorStats = {
  gpuUsage: null,
  gpuTemp: null,
  vramUsedMb: null,
  gpuClock: null,
  gpuMemClock: null,
  ramUsedMb: null,
  ramTotalMb: null,
  cpuUsage: null,
  cpuTemp: null,
  fps: null,
}

export const EMPTY_MONITOR_SNAPSHOT: MonitorSnapshot = {
  info: EMPTY_MONITOR_INFO,
  stats: EMPTY_MONITOR_STATS,
}

// Colors: titles by vendor, labels white, measured values mustard yellow.
export const MONITOR_COLORS = {
  nvidia: '#76B900',
  amd: '#ED1C24',
  intel: '#2F8CFF',
  fps: '#22C55E',
  neutral: '#FFFFFF',
  label: '#FFFFFF',
  value: '#E1AD01',
  rule: 'rgba(255, 255, 255, 0.28)',
  plate: 'rgba(0, 0, 0, 0.55)',
} as const

export const MONITOR_FONT = 'Consolas, "Cascadia Mono", "Courier New", monospace'

export function gpuVendorOf(name: string): GpuVendor {
  const text = name.toLowerCase()
  if (/nvidia|geforce|\brtx\b|\bgtx\b|quadro|\btitan\b/.test(text)) return 'nvidia'
  if (/\bamd\b|radeon|\bats\b|\brx\s?\d|\bvega\b|firepro/.test(text)) return 'amd'
  if (/intel|\barc\b|\biris\b|\buhd\b/.test(text)) return 'intel'
  return 'unknown'
}

export function cpuVendorOf(name: string): CpuVendor {
  const text = name.toLowerCase()
  if (/intel|\bcore\b|xeon|pentium|celeron/.test(text)) return 'intel'
  if (/\bamd\b|ryzen|athlon|threadripper|epyc/.test(text)) return 'amd'
  return 'unknown'
}

/** Removes trademark marks and the clock suffix some processors add. */
export function cleanHardwareName(name: string): string {
  return name
    .replace(/\((R|TM|tm|r)\)/g, '')
    .replace(/\s+CPU\s*@\s*[\d.]+\s*[GM]Hz/i, '')
    .replace(/\s*@\s*[\d.]+\s*[GM]Hz/i, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function memoryLabel(memoryMb: number | null): string {
  if (!memoryMb || memoryMb <= 0) return ''
  if (memoryMb < 1024) return `${Math.round(memoryMb)} MB`
  return `${Math.round(memoryMb / 1024)} GB`
}

/** GPU title: exact name followed by its video memory. */
export function gpuTitle(info: MonitorInfo): string {
  const name = info.gpuName || 'GPU'
  const memory = memoryLabel(info.gpuMemoryMb)
  return memory ? `${name} ${memory}` : name
}

function titleColor(vendor: GpuVendor | CpuVendor): string {
  if (vendor === 'nvidia') return MONITOR_COLORS.nvidia
  if (vendor === 'amd') return MONITOR_COLORS.amd
  if (vendor === 'intel') return MONITOR_COLORS.intel
  return MONITOR_COLORS.neutral
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export type MonitorRow =
  | { kind: 'title'; text: string; color: string }
  | { kind: 'row'; label: string; value: string; labelColor: string; labelBold: boolean; valueColor: string; valueCols: number }
  | { kind: 'rule' }

const NOT_AVAILABLE = 'N/A'

const whole = (value: number | null, suffix: string): string =>
  value === null || !Number.isFinite(value) ? NOT_AVAILABLE : `${Math.round(value)} ${suffix}`

const gigabytes = (megabytes: number): string => (megabytes / 1024).toFixed(1)

function usedOfTotal(usedMb: number | null, totalMb: number | null): string {
  if (usedMb === null || !Number.isFinite(usedMb)) return NOT_AVAILABLE
  if (!totalMb || totalMb <= 0) return `${gigabytes(usedMb)} GB`
  return `${gigabytes(usedMb)} / ${Math.round(totalMb / 1024)} GB`
}

const LABELS: Record<MonitorMetric, string> = Object.fromEntries(
  MONITOR_METRICS.map((item) => [item.key, item.label]),
) as Record<MonitorMetric, string>

// Widest text each value can take, so the panel keeps one stable width.
const VALUE_COLS: Record<MonitorMetric, number> = {
  gpuUsage: 5,
  gpuTemp: 6,
  vram: 14,
  gpuClock: 8,
  gpuMemClock: 8,
  ram: 14,
  cpuUsage: 5,
  cpuTemp: 6,
  fps: 4,
}

function valueOf(metric: MonitorMetric, info: MonitorInfo, stats: MonitorStats): string {
  switch (metric) {
    case 'gpuUsage': return whole(stats.gpuUsage, '%')
    case 'gpuTemp': return whole(stats.gpuTemp, '\u00B0C')
    case 'vram': return usedOfTotal(stats.vramUsedMb, info.gpuMemoryMb)
    case 'gpuClock': return whole(stats.gpuClock, 'MHz')
    case 'gpuMemClock': return whole(stats.gpuMemClock, 'MHz')
    case 'ram': return usedOfTotal(stats.ramUsedMb, stats.ramTotalMb)
    case 'cpuUsage': return whole(stats.cpuUsage, '%')
    case 'cpuTemp': return whole(stats.cpuTemp, '\u00B0C')
    case 'fps':
      return stats.fps === null || !Number.isFinite(stats.fps) ? NOT_AVAILABLE : String(Math.round(stats.fps))
  }
}

function metricRow(metric: MonitorMetric, info: MonitorInfo, stats: MonitorStats): MonitorRow {
  const isFps = metric === 'fps'
  return {
    kind: 'row',
    label: LABELS[metric],
    value: valueOf(metric, info, stats),
    labelColor: isFps ? MONITOR_COLORS.fps : MONITOR_COLORS.label,
    labelBold: isFps,
    valueColor: MONITOR_COLORS.value,
    valueCols: VALUE_COLS[metric],
  }
}

/**
 * GPU block (with RAM), then CPU block, then FPS; a rule separates blocks.
 * A block with nothing selected disappears completely.
 */
export function buildMonitorRows(
  snapshot: MonitorSnapshot,
  selected: readonly MonitorMetric[],
): MonitorRow[] {
  const { info, stats } = snapshot
  const on = (metric: MonitorMetric) => selected.includes(metric)
  const rows: MonitorRow[] = []
  const startBlock = () => { if (rows.length > 0) rows.push({ kind: 'rule' }) }

  const gpuMetrics = (['gpuUsage', 'gpuTemp', 'vram', 'gpuClock', 'gpuMemClock'] as const).filter(on)
  const firstBlock = [...gpuMetrics, ...(on('ram') ? (['ram'] as const) : [])]
  if (firstBlock.length > 0) {
    startBlock()
    if (gpuMetrics.length > 0) {
      rows.push({ kind: 'title', text: gpuTitle(info), color: titleColor(info.gpuVendor) })
    }
    for (const metric of firstBlock) rows.push(metricRow(metric, info, stats))
  }

  const cpuMetrics = (['cpuUsage', 'cpuTemp'] as const).filter(on)
  if (cpuMetrics.length > 0) {
    startBlock()
    rows.push({ kind: 'title', text: info.cpuName || 'CPU', color: titleColor(info.cpuVendor) })
    for (const metric of cpuMetrics) rows.push(metricRow(metric, info, stats))
  }

  if (on('fps')) {
    startBlock()
    rows.push(metricRow('fps', info, stats))
  }
  return rows
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

const MAX_MARGIN = 24
const CHAR_WIDTH = 0.6
const MAX_TITLE_CHARS = 46

export type MonitorPanel = {
  x: number
  y: number
  width: number
  height: number
  fontSize: number
  lineHeight: number
  paddingX: number
  paddingY: number
  ruleHeight: number
  fontFamily: string
  plateColor: string
  ruleColor: string
}

type Dimensions = { columns: number; rows: number; rules: number }

function measure(rows: readonly MonitorRow[]): Dimensions {
  let labelCols = 0
  let valueCols = 0
  let titleCols = 0
  let lines = 0
  let rules = 0
  for (const row of rows) {
    if (row.kind === 'rule') { rules += 1; continue }
    lines += 1
    if (row.kind === 'title') {
      titleCols = Math.max(titleCols, Math.min(row.text.length, MAX_TITLE_CHARS))
    } else {
      labelCols = Math.max(labelCols, row.label.length)
      valueCols = Math.max(valueCols, row.valueCols, row.value.length)
    }
  }
  // Two columns of space always separate a label from its value.
  return { columns: Math.max(titleCols, labelCols + valueCols + 2), rows: lines, rules }
}

/** Panel rectangle inside a region of the given size (same unit as the region). */
export function monitorPanelBox(
  rows: readonly MonitorRow[],
  regionWidth: number,
  regionHeight: number,
  position: string = 'top-left',
): MonitorPanel {
  const dimensions = measure(rows)
  let fontSize = Math.max(11, Math.min(30, Math.round(regionHeight * 0.017)))
  // Never wider than 40 % of the picture.
  const widest = Math.floor((regionWidth * 0.4) / (dimensions.columns * CHAR_WIDTH + 1.4))
  fontSize = Math.max(8, Math.min(fontSize, widest))

  const lineHeight = Math.round(fontSize * 1.4)
  const paddingX = Math.round(fontSize * 0.7)
  const paddingY = Math.round(fontSize * 0.5)
  const ruleHeight = Math.round(fontSize * 0.7)
  const width = Math.max(
    2,
    Math.ceil(dimensions.columns * fontSize * CHAR_WIDTH) + paddingX * 2,
  )
  const height = Math.max(
    2,
    dimensions.rows * lineHeight + dimensions.rules * ruleHeight + paddingY * 2,
  )

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

  return {
    x: Math.max(0, Math.round(x)),
    y: Math.max(0, Math.round(y)),
    width,
    height,
    fontSize,
    lineHeight,
    paddingX,
    paddingY,
    ruleHeight,
    fontFamily: MONITOR_FONT,
    plateColor: MONITOR_COLORS.plate,
    ruleColor: MONITOR_COLORS.rule,
  }
}

/**
 * Draws the panel at panel.x / panel.y. This function must stay completely
 * self-contained (no outside names): the overlay window receives its source
 * text and runs it on its own.
 */
export function drawMonitorPanel(
  context: CanvasRenderingContext2D,
  panel: MonitorPanel,
  rows: readonly MonitorRow[],
): void {
  context.save()
  context.translate(panel.x, panel.y)
  context.fillStyle = panel.plateColor
  context.beginPath()
  context.roundRect(0, 0, panel.width, panel.height, panel.fontSize * 0.35)
  context.fill()

  context.textBaseline = 'middle'
  const regular = `400 ${panel.fontSize}px ${panel.fontFamily}`
  const bold = `700 ${panel.fontSize}px ${panel.fontFamily}`
  const maxTitle = 46
  let y = panel.paddingY

  for (const row of rows) {
    if (row.kind === 'rule') {
      context.fillStyle = panel.ruleColor
      const thickness = Math.max(1, Math.round(panel.fontSize / 14))
      context.fillRect(
        panel.paddingX,
        y + Math.round((panel.ruleHeight - thickness) / 2),
        panel.width - panel.paddingX * 2,
        thickness,
      )
      y += panel.ruleHeight
      continue
    }

    const middle = y + panel.lineHeight / 2 + panel.fontSize * 0.04
    if (row.kind === 'title') {
      context.font = bold
      context.fillStyle = row.color
      context.textAlign = 'left'
      const text = row.text.length > maxTitle ? `${row.text.slice(0, maxTitle - 1)}\u2026` : row.text
      context.fillText(text, panel.paddingX, middle)
    } else {
      context.font = row.labelBold ? bold : regular
      context.fillStyle = row.labelColor
      context.textAlign = 'left'
      context.fillText(row.label, panel.paddingX, middle)
      context.font = regular
      context.fillStyle = row.valueColor
      context.textAlign = 'right'
      context.fillText(row.value, panel.width - panel.paddingX, middle)
    }
    y += panel.lineHeight
  }
  context.restore()
}
