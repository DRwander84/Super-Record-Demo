import type { ReactNode } from 'react'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSettings } from './settings/SettingsProvider'

import RecordingControls, { type RecorderState } from './recording/RecordingControls'
import type { CameraOptions } from './recording/ScreenRecorder'
import LivePreview from './recording/LivePreview'
import GameLivePreview from './recording/GameLivePreview'
import { CAMERA_POSITIONS, CAMERA_SIZE_LABELS } from './recording/cameraLayout'
import { ALL_MONITOR_METRICS, MONITOR_METRICS, normalizeMonitorMetrics, type MonitorMetric } from './recording/monitorLayout'

import {
  AUDIO_BITRATES_KBPS,
  AUDIO_CODEC_LABELS,
  CONTAINER_AUDIO_CODECS,
  allowedSampleRates,
  isAudioContainer,
  isLosslessAudioCodec,
  normalizeAudioSettings,
  type AudioCodec,
} from './recording/audioSettings'

import {

  Monitor,

  Gamepad2,

  Video,

  Settings,

  FolderOpen,

  Search,



  CirclePlay,

  Minus,

  Square,

  Copy,

  X,

  Mic,

  Camera,

  Volume2,

  MonitorPlay,


  Film,

  Info,

  RefreshCw,

  CheckCircle2,

  Trash2,

  ExternalLink,

  Keyboard,

  Timer,

  Activity,

  ChevronDown,
} from 'lucide-react'

import { motion } from 'framer-motion'

import type { AreaRect, AreaSelection, DetectedGame, RecordingFileInfo, ShortcutAction, ShortcutMap } from './types/electron'
import appIconData from './assets/appIconData'
import GlassSelect from './components/GlassSelect'



type Page =

  | 'Screen Capture'

  | 'Game Capture'

  | 'My Recordings'

  | 'Settings'



type SelectOption = {

  label: string

  value: string

}




const resolutions: SelectOption[] = [

  { label: 'Original Resolution', value: 'original' },

  { label: '3840 × 2160 (4K)', value: '4k' },

  { label: '2560 × 1440 (1440p)', value: '1440p' },

  { label: '1920 × 1080 (1080p)', value: '1080p' },

  { label: '1280 × 720 (720p)', value: '720p' },
  { label: '960 × 540 (540p)', value: '540p' },
  { label: '854 × 480 (480p)', value: '480p' },
  { label: '640 × 360 (360p)', value: '360p' },
  { label: '426 × 240 (240p)', value: '240p' },
  { label: '256 × 144 (144p)', value: '144p' },

]



const fpsOptions: SelectOption[] = [
  { label: '12 FPS', value: '12' },
  { label: '15 FPS', value: '15' },
  { label: '20 FPS', value: '20' },
  { label: '24 FPS', value: '24' },
  { label: '25 FPS', value: '25' },
  { label: '30 FPS', value: '30' },
  { label: '48 FPS', value: '48' },
  { label: '50 FPS', value: '50' },
  { label: '60 FPS', value: '60' },
]



// Gaming Mode offers higher frame rates than Screen Record, up to 100 FPS.
const gamingFpsOptions: SelectOption[] = [
  { label: '24 FPS', value: '24' },
  { label: '30 FPS', value: '30' },
  { label: '48 FPS', value: '48' },
  { label: '50 FPS', value: '50' },
  { label: '60 FPS', value: '60' },
  { label: '75 FPS', value: '75' },
  { label: '90 FPS', value: '90' },
  { label: '100 FPS', value: '100' },
]



// Texts that use the Poppins label font.
const HEADING_FONT_TITLES = new Set([
  'Video Save Location',
  'Keyboard Shortcuts',
])

type MicrophoneDevice = { id: string; label: string }

// Lists the connected devices of one kind (microphones or cameras) and keeps
// the list live when devices are plugged in or removed.
function useMediaDevices(kind: 'audioinput' | 'videoinput') {
  const [devices, setDevices] = useState<MicrophoneDevice[]>([])

  useEffect(() => {
    let cancelled = false
    let probed = false
    const fallbackName = kind === 'audioinput' ? 'Microphone' : 'Camera'

    const toList = (all: MediaDeviceInfo[]): MicrophoneDevice[] => {
      const inputs = all.filter(
        (item) => item.kind === kind && item.deviceId !== 'communications',
      )
      return inputs.map((item, index) => ({
        id: item.deviceId,
        label: item.label || `${fallbackName} ${index + 1}`,
      }))
    }

    const refresh = async () => {
      try {
        let all = await navigator.mediaDevices.enumerateDevices()
        // Device names stay hidden until access has been granted once.
        if (!probed && all.some((item) => item.kind === kind && !item.label)) {
          probed = true
          try {
            const probe = await navigator.mediaDevices.getUserMedia(
              kind === 'audioinput' ? { audio: true, video: false } : { video: true, audio: false },
            )
            probe.getTracks().forEach((track) => track.stop())
            all = await navigator.mediaDevices.enumerateDevices()
          } catch {
            // No device, or access denied: keep what enumeration returned.
          }
        }
        if (!cancelled) setDevices(toList(all))
      } catch {
        if (!cancelled) setDevices([])
      }
    }

    void refresh()
    navigator.mediaDevices.addEventListener('devicechange', refresh)
    return () => {
      cancelled = true
      navigator.mediaDevices.removeEventListener('devicechange', refresh)
    }
  }, [kind])

  return devices
}

const useMicrophones = () => useMediaDevices('audioinput')
const useCameras = () => useMediaDevices('videoinput')

// Drives a live level bar from the selected microphone while it is enabled.
function useMicrophoneLevel(
  enabled: boolean,
  deviceId: string | undefined,
  barRef: { current: HTMLDivElement | null },
) {
  useEffect(() => {
    if (barRef.current) barRef.current.style.width = '0%'
    if (!enabled) return

    let cancelled = false
    let frame = 0
    let stream: MediaStream | null = null
    let context: AudioContext | null = null

    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: deviceId ? { exact: deviceId } : undefined,
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
          video: false,
        })
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop())
          return
        }
        context = new AudioContext()
        const analyser = context.createAnalyser()
        analyser.fftSize = 1024
        context.createMediaStreamSource(stream).connect(analyser)
        const samples = new Float32Array(analyser.fftSize)
        let smoothed = 0

        const tick = () => {
          analyser.getFloatTimeDomainData(samples)
          let sum = 0
          for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i]
          const rms = Math.sqrt(sum / samples.length)
          const db = 20 * Math.log10(Math.max(rms, 1e-5))
          const target = Math.min(1, Math.max(0, (db + 60) / 60))
          smoothed = target > smoothed ? target : smoothed * 0.85 + target * 0.15
          if (barRef.current) barRef.current.style.width = `${Math.round(smoothed * 100)}%`
          frame = requestAnimationFrame(tick)
        }
        tick()
      } catch {
        if (barRef.current) barRef.current.style.width = '0%'
      }
    })()

    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
      stream?.getTracks().forEach((track) => track.stop())
      void context?.close()
      if (barRef.current) barRef.current.style.width = '0%'
    }
  }, [enabled, deviceId, barRef])
}

function Section({
  title,
  description,
  icon: Icon,
  children,
  collapsible = false,
  headerAction,
}: {
  title: string
  description?: string
  icon: typeof Monitor
  children: ReactNode
  collapsible?: boolean
  headerAction?: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [animating, setAnimating] = useState(false)
  const hasBody = Array.isArray(children) ? children.some(Boolean) : Boolean(children)

  return (
    <section className="glass-panel mb-4 rounded-2xl p-5 sm:p-6">
      <div className={`flex items-center gap-3 ${(collapsible && !open) || (headerAction && !hasBody) ? '' : 'mb-5'}`}>
        <div className="action-icon flex h-10 w-10 shrink-0 items-center justify-center rounded-xl">
          <Icon size={19} />
        </div>
        <div>
          <h3 className={`text-sm ${HEADING_FONT_TITLES.has(title) ? 'heading-font' : 'font-bold'}`}>{title}</h3>
          {description && (
            <p className="mt-1 text-[10px] text-zinc-500">{description}</p>
          )}
        </div>
        {collapsible && (
          <button
            type="button"
            aria-label={open ? `Collapse ${title}` : `Expand ${title}`}
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
            className="ml-auto flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-white"
          >
            <motion.span
              animate={{ rotate: open ? 180 : 0 }}
              transition={{ duration: 0.25, ease: 'easeInOut' }}
              className="flex"
            >
              <ChevronDown size={18} />
            </motion.span>
          </button>
        )}
        {headerAction}
      </div>
      {collapsible ? (
        <motion.div
          initial={false}
          animate={{ height: open ? 'auto' : 0, opacity: open ? 1 : 0 }}
          transition={{ duration: 0.25, ease: 'easeInOut' }}
          onAnimationStart={() => setAnimating(true)}
          onAnimationComplete={() => setAnimating(false)}
          style={{ overflow: open && !animating ? 'visible' : 'hidden' }}
          inert={!open}
        >
          <div className="space-y-4">{children}</div>
        </motion.div>
      ) : (
        <div className="space-y-4">{children}</div>
      )}
    </section>
  )
}

function SettingRow({

  label,

  description,

  children,

}: {

  label: string

  description?: string

  children: ReactNode

}) {

  return (

    <div className="flex flex-col justify-between gap-3 border-b border-white/[0.055] pb-4 last:border-0 last:pb-0 sm:flex-row sm:items-center">

      <div className="min-w-0 sm:self-center">

        <p className="label-font text-xs text-zinc-200">{label}</p>

        {description && (

          <p className="mt-1 text-[10px] leading-5 text-zinc-500">

            {description}

          </p>

        )}

      </div>

      <div className="w-full sm:w-[230px] sm:shrink-0">{children}</div>

    </div>

  )

}



function SelectField({
  value,
  onChange,
  options,
  disabled = false,
}: {
  value: string
  onChange: (value: string) => void
  options: SelectOption[]
  disabled?: boolean
}) {
  return (
    <GlassSelect
      value={value}
      onChange={onChange}
      options={options}
      disabled={disabled}
    />
  )
}

function Toggle({

  checked,

  onChange,

  disabled = false,

}: {

  checked: boolean

  onChange: (value: boolean) => void

  disabled?: boolean

}) {

  return (

    <button

      type="button"

      disabled={disabled}

      onClick={() => onChange(!checked)}

      aria-pressed={checked}

      className={`relative ml-auto block h-6 w-11 shrink-0 rounded-full transition-colors ${

        checked ? 'bg-red-500' : 'bg-zinc-700'

      } ${disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer'}`}

    >

      <span

        className={`absolute top-[3px] h-[18px] w-[18px] rounded-full bg-white shadow transition-all ${

          checked ? 'left-[22px]' : 'left-[3px]'

        }`}

      />

    </button>

  )

}



export function Notice({ children }: { children: ReactNode }) {

  return (

    <div className="flex items-start gap-2 rounded-xl border border-amber-400/15 bg-amber-400/[0.055] p-3 text-[10px] leading-5 text-amber-200/75">

      <Info size={14} className="mt-0.5 shrink-0" />

      <span>{children}</span>

    </div>

  )

}



const SHORTCUT_LABELS: Record<ShortcutAction, string> = {
  pause: 'Pause / Resume',
  toggle: 'Start / Stop',
  timerToggle: 'Speedrun Timer Start / Stop',
  timerPause: 'Speedrun Timer Pause / Resume',
  timerReset: 'Speedrun Timer Reset',
}

const SHORTCUT_ORDER: ShortcutAction[] = ['pause', 'toggle', 'timerToggle', 'timerPause', 'timerReset']

function shortcutKeyName(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code)
  if (letter) return letter[1]

  const digit = /^Digit(\d)$/.exec(code)
  if (digit) return digit[1]

  const numpad = /^Numpad(\d)$/.exec(code)
  if (numpad) return `num${numpad[1]}`

  if (/^F([1-9]|1\d|2[0-4])$/.test(code)) return code

  const named: Record<string, string> = {
    Space: 'Space',
    Enter: 'Return',
    Tab: 'Tab',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Insert: 'Insert',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
  }

  return named[code] ?? null
}

// Converts a key press into an Electron accelerator such as "Ctrl+Shift+R".
function acceleratorFromEvent(
  event: KeyboardEvent,
): { accelerator: string } | { error: string } | null {
  if (/^(Control|Shift|Alt|Meta)(Left|Right)$/.test(event.code)) return null

  const key = shortcutKeyName(event.code)
  if (!key) return { error: 'This key cannot be used as a shortcut.' }

  const modifiers: string[] = []
  if (event.ctrlKey) modifiers.push('Ctrl')
  if (event.altKey) modifiers.push('Alt')
  if (event.shiftKey) modifiers.push('Shift')
  if (event.metaKey) modifiers.push('Super')

  const isFunctionKey = /^F([1-9]|1\d|2[0-4])$/.test(key)

  if (modifiers.length === 0 && !isFunctionKey) {
    return { error: 'Use a function key (F1-F24) or add Ctrl, Alt or Shift.' }
  }

  return { accelerator: [...modifiers, key].join('+') }
}

function ShortcutField({
  value,
  others,
  onChange,
}: {
  value: string
  others: string[]
  onChange: (value: string) => void
}) {
  const [capturing, setCapturing] = useState(false)
  const [message, setMessage] = useState('')

  // Latest props for the key listener, so it is not re-created on each render.
  const latestRef = useRef({ others, onChange })

  useEffect(() => {
    latestRef.current = { others, onChange }
  })

  useEffect(() => {
    if (!capturing) return

    // The registered hotkeys are paused so the pressed key reaches this page.
    void window.electronAPI.setShortcutsSuspended(true)

    const handleKeyDown = (event: KeyboardEvent) => {
      event.preventDefault()
      event.stopPropagation()

      if (event.key === 'Escape') {
        setMessage('')
        setCapturing(false)
        return
      }

      const result = acceleratorFromEvent(event)
      if (result === null) return

      if ('error' in result) {
        setMessage(result.error)
        return
      }

      const latest = latestRef.current

      if (latest.others.some((other) => other.toLowerCase() === result.accelerator.toLowerCase())) {
        setMessage('This shortcut is already used by another action.')
        return
      }

      setMessage('')
      latest.onChange(result.accelerator)
      setCapturing(false)
    }

    window.addEventListener('keydown', handleKeyDown, true)

    return () => {
      window.removeEventListener('keydown', handleKeyDown, true)
      void window.electronAPI.setShortcutsSuspended(false)
    }
  }, [capturing])

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          setMessage('')
          setCapturing(true)
        }}
        onBlur={() => setCapturing(false)}
        className={`glass-field w-full rounded-xl px-3 py-3 text-left text-xs font-semibold ${
          capturing ? 'is-capturing' : ''
        }`}
      >
        {capturing ? 'Press a key... (Esc to cancel)' : value.split('+').join(' + ')}
      </button>
      {message && (
        <p className="mt-2 text-[10px] leading-5 text-red-300">{message}</p>
      )}
    </div>
  )
}

const DEFAULT_FOCUS_KEY = 'NumLock'

function readFocusKey(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value : DEFAULT_FOCUS_KEY
}

// Key name for the Mouse Focus hold key. Unlike global shortcuts it may be a
// single key such as NumLock, because it is read while held (not registered).
function focusKeyName(code: string): string | null {
  const special: Record<string, string> = {
    NumLock: 'NumLock',
    ScrollLock: 'ScrollLock',
    CapsLock: 'CapsLock',
    Pause: 'Pause',
    PrintScreen: 'PrintScreen',
    NumpadAdd: 'NumAdd',
    NumpadSubtract: 'NumSub',
    NumpadMultiply: 'NumMult',
    NumpadDivide: 'NumDiv',
    NumpadDecimal: 'NumDec',
  }
  return special[code] ?? shortcutKeyName(code)
}

function focusModifierName(code: string): string | null {
  const match = /^(Control|Shift|Alt|Meta)(Left|Right)$/.exec(code)
  if (!match) return null
  return { Control: 'Ctrl', Shift: 'Shift', Alt: 'Alt', Meta: 'Super' }[match[1]] ?? null
}

function FocusKeyField({
  value,
  others,
  onChange,
}: {
  value: string
  others: string[]
  onChange: (value: string) => void
}) {
  const [capturing, setCapturing] = useState(false)
  const [message, setMessage] = useState('')
  const latestRef = useRef({ others, onChange })

  useEffect(() => {
    latestRef.current = { others, onChange }
  })

  useEffect(() => {
    if (!capturing) return

    // Registered hotkeys are paused so the pressed key reaches this page.
    void window.electronAPI.setShortcutsSuspended(true)

    let pendingModifier: string | null = null
    let sawOther = false

    const accept = (combo: string) => {
      const latest = latestRef.current
      if (latest.others.some((other) => other.toLowerCase() === combo.toLowerCase())) {
        setMessage('This key is already used by a recording shortcut.')
        return
      }
      setMessage('')
      latest.onChange(combo)
      setCapturing(false)
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      event.preventDefault()
      event.stopPropagation()

      if (event.key === 'Escape') {
        setMessage('')
        setCapturing(false)
        return
      }

      const modifier = focusModifierName(event.code)
      if (modifier) {
        if (event.repeat) return
        // A lone modifier is accepted on release; a second one starts a combo.
        pendingModifier = sawOther ? null : modifier
        sawOther = true
        return
      }

      const key = focusKeyName(event.code)
      if (!key) {
        setMessage('This key cannot be used. Choose another one.')
        return
      }

      const modifiers: string[] = []
      if (event.ctrlKey) modifiers.push('Ctrl')
      if (event.altKey) modifiers.push('Alt')
      if (event.shiftKey) modifiers.push('Shift')
      if (event.metaKey) modifiers.push('Super')

      pendingModifier = null
      accept([...modifiers, key].join('+'))
    }

    const handleKeyUp = (event: KeyboardEvent) => {
      event.preventDefault()
      event.stopPropagation()
      if (pendingModifier && focusModifierName(event.code) === pendingModifier) {
        accept(pendingModifier)
      }
    }

    window.addEventListener('keydown', handleKeyDown, true)
    window.addEventListener('keyup', handleKeyUp, true)

    return () => {
      window.removeEventListener('keydown', handleKeyDown, true)
      window.removeEventListener('keyup', handleKeyUp, true)
      void window.electronAPI.setShortcutsSuspended(false)
    }
  }, [capturing])

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          setMessage('')
          setCapturing(true)
        }}
        onBlur={() => setCapturing(false)}
        className={`glass-field w-full rounded-xl px-3 py-3 text-left text-xs font-semibold ${
          capturing ? 'is-capturing' : ''
        }`}
      >
        {capturing ? 'Press the key to hold... (Esc to cancel)' : value.split('+').join(' + ')}
      </button>
      {message && (
        <p className="mt-2 text-[10px] leading-5 text-red-300">{message}</p>
      )}
    </div>
  )
}

function SettingsPage() {
  const {
    settings,
    isLoading,
    error: providerError,
    updateSettings,
    saveSettingsNow,
  } = useSettings()

  const [selecting, setSelecting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [shortcutDraft, setShortcutDraft] = useState<ShortcutMap | null>(null)
  const [focusKeyDraft, setFocusKeyDraft] = useState<string | null>(null)

  const savedShortcuts: ShortcutMap = {
    pause: settings.shortcuts.pause,
    toggle: settings.shortcuts.toggle,
    timerToggle: settings.shortcuts.timerToggle,
    timerPause: settings.shortcuts.timerPause,
    timerReset: settings.shortcuts.timerReset,
  }
  const shortcuts = shortcutDraft ?? savedShortcuts
  const focusKey = focusKeyDraft ?? readFocusKey(settings.mouseFocusKey)

  const handleBrowse = async () => {
    setError('')
    setSuccess('')
    setSelecting(true)

    try {
      const selectedPath =
        await window.electronAPI.selectOutputDirectory()

      if (!selectedPath) return

      updateSettings({
        outputDirectory: selectedPath,
      })

      await saveSettingsNow()

      setSuccess('Recording folder saved successfully.')
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Could not select or save the recording folder.',
      )
    } finally {
      setSelecting(false)
    }
  }

  const handleSave = async () => {
    setError('')
    setSuccess('')
    setSaving(true)

    try {
      if (shortcutDraft) {
        // The new hotkeys are registered first; nothing is saved when one of
        // them cannot be used.
        const applied = await window.electronAPI.applyShortcuts(shortcutDraft)

        if (!applied.success) {
          setError((applied as { success: false; message: string }).message)
          return
        }

        updateSettings({ shortcuts: shortcutDraft })
      }

      if (focusKeyDraft) {
        updateSettings({ mouseFocusKey: focusKeyDraft })
      }

      await saveSettingsNow()
      setShortcutDraft(null)
      setFocusKeyDraft(null)
      setSuccess('Settings saved successfully.')
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Could not save settings.',
      )
    } finally {
      setSaving(false)
    }
  }

  if (isLoading) {
    return (
      <div className="glass-panel flex min-h-[300px] items-center justify-center rounded-2xl">
        <div className="text-center">
          <RefreshCw
            size={23}
            className="mx-auto animate-spin text-red-400"
          />
          <p className="mt-3 text-xs text-zinc-400">
            Loading settings...
          </p>
        </div>
      </div>
    )
  }

  return (
    <>
      <Section
        title="Video Save Location"
        description="Choose a location to save recorded videos"
        icon={FolderOpen}
      >
        <div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="glass-field flex min-w-0 flex-1 items-center gap-3 rounded-xl px-3 py-3">
              <FolderOpen
                size={17}
                className="shrink-0 text-red-400"
              />

              <span className="min-w-0 break-all text-[11px] leading-5 text-zinc-300">
                {settings.outputDirectory || 'No folder selected'}
              </span>
            </div>

            <button
              type="button"
              onClick={() => void handleBrowse()}
              disabled={selecting || saving}
              className="flex shrink-0 items-center justify-center gap-2 rounded-xl border border-red-400/20 bg-red-500/10 px-5 py-3 text-xs font-bold text-red-300 transition-colors hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {selecting ? (
                <RefreshCw
                  size={15}
                  className="animate-spin"
                />
              ) : (
                <FolderOpen size={15} />
              )}

              {selecting ? 'Selecting...' : 'Browse'}
            </button>
          </div>
        </div>
      </Section>

      <Section
        title="Keyboard Shortcuts"
        description="Define shortcut keys for different operations to speed up your work"
        icon={Keyboard}
      >
        {(['toggle', 'pause', 'timerToggle', 'timerPause', 'timerReset'] as ShortcutAction[]).map((action) => (
          <SettingRow
            key={action}
            label={SHORTCUT_LABELS[action]}
          >
            <ShortcutField
              value={shortcuts[action]}
              others={SHORTCUT_ORDER
                .filter((other) => other !== action)
                .map((other) => shortcuts[other])}
              onChange={(value) => setShortcutDraft({ ...shortcuts, [action]: value })}
            />
          </SettingRow>
        ))}

        <SettingRow
          label="Mouse Focus (hold key)"
        >
          <FocusKeyField
            value={focusKey}
            others={SHORTCUT_ORDER.map((other) => shortcuts[other])}
            onChange={setFocusKeyDraft}
          />
        </SettingRow>

        <p className="text-[10px] leading-5 text-zinc-500">
          Press Save Settings to apply the new shortcuts permanently.
        </p>
      </Section>


      {(error || providerError) && (
        <div className="mb-4 rounded-xl border border-red-400/20 bg-red-500/[0.07] p-3 text-[11px] leading-5 text-red-300">
          {error || providerError}
        </div>
      )}

      {success && (
        <div className="mb-4 flex items-center gap-2 rounded-xl border border-green-400/20 bg-green-500/[0.07] p-3 text-[11px] text-green-300">
          <CheckCircle2 size={15} />
          {success}
        </div>
      )}

      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={saving || selecting}
          className="flex items-center gap-2 rounded-xl bg-red-500 px-5 py-3 text-xs font-bold text-white shadow-lg shadow-red-950/30 transition-colors hover:bg-red-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving && (
            <RefreshCw
              size={14}
              className="animate-spin"
            />
          )}

          {saving ? 'Saving...' : 'Save Settings'}
        </button>
      </div>
    </>
  )
}



function parseAreaRect(value: unknown): AreaRect | null {
  if (typeof value !== 'object' || value === null) return null

  const rect = value as Record<string, unknown>
  const parts = [rect.x, rect.y, rect.width, rect.height]

  if (!parts.every((part) => typeof part === 'number' && Number.isFinite(part))) {
    return null
  }

  return value as AreaRect
}

const DEFAULT_SCREEN_RECORD_SETTINGS: Record<string, unknown> = {
  captureMode: 'full',
  resolution: 'original',
  fps: '30',
  encoder: 'h264',
  format: 'mp4',
  bitrate: '20',
  showCursor: true,
  mouseFocus: false,
  mouseZoomLevel: '2',
  mouseZoomSpeed: 'normal',
  clickEffects: false,
  audioCodec: 'aac',
  audioBitrate: '192',
  audioChannels: 'stereo',
  audioSampleRate: '48000',
  systemAudio: false,
  microphone: false,
  camera: false,
  cameraMirror: false,
  cameraShape: 'rounded',
  cameraOpacity: 100,
  cameraSize: 'medium',
  cameraPosition: 'bottom-right',
}

const DEFAULT_GAMING_MODE_SETTINGS: Record<string, unknown> = {
  showCursor: true,
  gameAudio: true,
  microphone: false,
  blockNotifications: false,
  audioCodec: 'aac',
  audioBitrate: '192',
  audioChannels: 'stereo',
  audioSampleRate: '48000',
  encoder: 'h264',
  camera: false,
  cameraMirror: false,
  cameraShape: 'rounded',
  cameraOpacity: 100,
  cameraSize: 'medium',
  cameraPosition: 'bottom-right',
  speedrunTimer: false,
  timerPosition: 'top-left',
  monitoring: false,
  monitorPosition: 'top-left',
  monitorMetrics: [...ALL_MONITOR_METRICS],
  lowLatency: false,
  vfr: false,
  hdr: false,
  fps: '60',
  format: 'mkv',
  bitrate: '40',
}

function ScreenRecordPage({

  onRecordingStateChange,

  isRecording,

}: {

  onRecordingStateChange: (state: RecorderState) => void

  isRecording: boolean

}) {

const { settings, updateScreenRecord, replaceScreenRecord } = useSettings()

const saved = settings.screenRecord

const readString = (key: string, fallback: string): string => {
  const value = saved[key]
  return typeof value === 'string' ? value : fallback
}

const readBoolean = (key: string, fallback: boolean): boolean => {
  const value = saved[key]
  return typeof value === 'boolean' ? value : fallback
}

const readNumber = (key: string, fallback: number): number => {
  const value = saved[key]
  return typeof value === 'number' ? value : fallback
}

const setScreen = (key: string, value: unknown) => {
  updateScreenRecord({ [key]: value })
}

const captureMode = readString('captureMode', 'full')
const resolution = readString('resolution', 'original')
const fps = readString('fps', '30')
const encoder = readString('encoder', 'h264')
const format = readString('format', 'mp4')
const bitrate = readString('bitrate', '20')

const showCursor = readBoolean('showCursor', true)
const mouseFocus = showCursor && readBoolean('mouseFocus', false)
const mouseZoomLevel = readString('mouseZoomLevel', '2')
const mouseZoomSpeed = readString('mouseZoomSpeed', 'normal')
// Click bubbles are only available (and only recorded) while the cursor is shown.
const clickEffects = showCursor && readBoolean('clickEffects', false)
const systemAudio = readBoolean('systemAudio', false)
const micDevices = useMicrophones()
const hasMicrophone = micDevices.length > 0
const savedMicId = readString('microphoneDeviceId', '')
const microphoneDeviceId = micDevices.some((item) => item.id === savedMicId)
  ? savedMicId
  : (micDevices[0]?.id ?? '')
// The microphone can only be on while a real microphone is connected.
const microphone = hasMicrophone && readBoolean('microphone', false)
const micLevelBar = useRef<HTMLDivElement | null>(null)
useMicrophoneLevel(microphone, microphoneDeviceId || undefined, micLevelBar)
const cameraDevices = useCameras()
const hasCamera = cameraDevices.length > 0
const savedCameraId = readString('cameraDeviceId', '')
const cameraDeviceId = cameraDevices.some((item) => item.id === savedCameraId)
  ? savedCameraId
  : (cameraDevices[0]?.id ?? '')
// The camera can only be on while a real camera is connected.
const camera = hasCamera && readBoolean('camera', false)
const cameraSize = readString('cameraSize', 'medium')
const cameraPositionSaved = readString('cameraPosition', 'bottom-right')
const cameraPosition = CAMERA_POSITIONS.some((item) => item.value === cameraPositionSaved)
  ? cameraPositionSaved
  : 'bottom-right'
const cameraMirror = readBoolean('cameraMirror', false)

const cameraShape = readString('cameraShape', 'rounded')
const cameraOpacity = readNumber('cameraOpacity', 100)
// Live Preview runs only when switched on, and switches itself off when a
// recording starts. The position map is a purely visual picker.
const [livePreview, setLivePreview] = useState(false)
const [showPositionMap, setShowPositionMap] = useState(false)
useEffect(() => {
  if (isRecording) setLivePreview(false)
}, [isRecording])
const cameraOptions = useMemo<CameraOptions | undefined>(
  () => (camera
    ? { deviceId: cameraDeviceId, size: cameraSize, shape: cameraShape, mirror: cameraMirror, opacity: cameraOpacity, position: cameraPosition }
    : undefined),
  [camera, cameraDeviceId, cameraSize, cameraShape, cameraMirror, cameraOpacity, cameraPosition],
)

const setCaptureMode = (value: string) => {
  setScreen('captureMode', value)

  // Choosing "Select Area" immediately opens the dark selection overlay
  // on the monitor that is currently selected.
  if (value === 'area') void chooseArea(monitorId)
}
const setResolution = (value: string) => setScreen('resolution', value)
const setFps = (value: string) => setScreen('fps', value)
// WebM can only hold AV1, so the two settings always stay compatible.
const setEncoder = (value: string) => {
  if (value !== 'av1' && format === 'webm') {
    updateScreenRecord({ encoder: value, format: 'mp4' })
  } else {
    setScreen('encoder', value)
  }
}
const setFormat = (value: string) => {
  if (value === 'webm' && encoder !== 'av1') {
    updateScreenRecord({ format: 'webm', encoder: 'av1' })
  } else {
    setScreen('format', value)
  }
}
const setBitrate = (value: string) => setScreen('bitrate', value)

const monitorId = readString('monitorId', '')
const setMonitorId = (value: string) => {
  const nextMonitorId = value === 'default' ? '' : value
  setScreen('monitorId', nextMonitorId)

  // The selection overlay always appears on the monitor the user picked.
  if (captureMode === 'area') void chooseArea(nextMonitorId)
}
const [captureSources, setCaptureSources] = useState<Array<{ id: string; name: string; displayId: string }>>([])
useEffect(() => {
  let mounted = true
  const refresh = () => window.electronAPI.getCaptureSources()
    .then((items) => { if (mounted) setCaptureSources(items) })
    .catch(() => { if (mounted) setCaptureSources([]) })
  void refresh()
  const unsubscribe = window.electronAPI.onDevicesChanged(() => { void refresh() })
  return () => { mounted = false; unsubscribe() }
}, [])


const areaDisplayId = readNumber('areaDisplayId', -1)
const areaPixelWidth = readNumber('areaPixelWidth', 0)
const areaPixelHeight = readNumber('areaPixelHeight', 0)
const areaRect = parseAreaRect(saved.areaRect)
const area = useMemo<AreaSelection | null>(
  () => (areaRect && areaDisplayId >= 0 ? { displayId: areaDisplayId, rect: areaRect } : null),
  [areaRect, areaDisplayId],
)
const [selectingArea, setSelectingArea] = useState(false)
const [areaError, setAreaError] = useState('')

const chooseArea = async (sourceId: string) => {
  if (selectingArea || isRecording) return

  setSelectingArea(true)
  setAreaError('')

  try {
    const selection = await window.electronAPI.selectCaptureArea(sourceId || null)

    if (selection) {
      updateScreenRecord({
        areaRect: selection.rect,
        areaDisplayId: selection.displayId,
        areaPixelWidth: selection.pixelWidth ?? 0,
        areaPixelHeight: selection.pixelHeight ?? 0,
      })
    }
  } catch (error) {
    setAreaError(error instanceof Error ? error.message : 'Could not open the area selector.')
  } finally {
    setSelectingArea(false)
  }
}

// Mouse Click Effects can be chosen manually while the cursor is shown. Hiding
// the cursor switches the effect off and makes it unselectable.
const setShowCursor = (value: boolean) => (
  value
    ? setScreen('showCursor', true)
    : updateScreenRecord({ showCursor: false, clickEffects: false, mouseFocus: false })
)
const setMouseFocus = (value: boolean) => setScreen('mouseFocus', value)
const setClickEffects = (value: boolean) => setScreen('clickEffects', value)
const setSystemAudio = (value: boolean) => setScreen('systemAudio', value)
const setMicrophone = (value: boolean) => setScreen('microphone', value)
const setMicrophoneDevice = (value: string) => setScreen('microphoneDeviceId', value)
const setCamera = (value: boolean) => setScreen('camera', value)
const setCameraMirror = (value: boolean) => setScreen('cameraMirror', value)

const setCameraDevice = (value: string) => setScreen('cameraDeviceId', value)
const setCameraSize = (value: string) => setScreen('cameraSize', value)
const setCameraPosition = (value: string) => setScreen('cameraPosition', value)
const setCameraShape = (value: string) => setScreen('cameraShape', value)
const setCameraOpacity = (value: number) => setScreen('cameraOpacity', value)

// Audio output settings. Only combinations the selected container supports
// (and that the bundled FFmpeg can encode) are ever offered or used.
const [availableAudioCodecs, setAvailableAudioCodecs] = useState<AudioCodec[] | null>(null)
useEffect(() => {
  let mounted = true
  window.electronAPI.nativeCapabilities()
    .then((capabilities) => {
      if (mounted && capabilities.available) setAvailableAudioCodecs(capabilities.audioCodecs)
    })
    .catch(() => undefined)
  return () => { mounted = false }
}, [])

const audioContainer = isAudioContainer(format) ? format : 'mp4'
const audioCodecChoices = CONTAINER_AUDIO_CODECS[audioContainer].filter(
  (item) => !availableAudioCodecs || availableAudioCodecs.includes(item),
)
const savedAudioCodec = readString('audioCodec', 'aac')
const savedAudioBitrate = readString('audioBitrate', '192')
const savedAudioChannels = readString('audioChannels', 'stereo')
const savedAudioSampleRate = readString('audioSampleRate', '48000')
const preferredAudioCodec =
  audioCodecChoices.length > 0 && !audioCodecChoices.includes(savedAudioCodec as AudioCodec)
    ? audioCodecChoices.includes('aac') ? 'aac' : audioCodecChoices[0]
    : savedAudioCodec
const audioSettings = useMemo(
  () => normalizeAudioSettings(
    {
      codec: preferredAudioCodec,
      bitrateKbps: Number(savedAudioBitrate),
      channels: savedAudioChannels,
      sampleRate: Number(savedAudioSampleRate),
    },
    audioContainer,
  ),
  [preferredAudioCodec, savedAudioBitrate, savedAudioChannels, savedAudioSampleRate, audioContainer],
)
const setAudioCodec = (value: string) => setScreen('audioCodec', value)
const setAudioBitrate = (value: string) => setScreen('audioBitrate', value)
const setAudioChannels = (value: string) => setScreen('audioChannels', value)
const setAudioSampleRate = (value: string) => setScreen('audioSampleRate', value)

const [resetAnimation, setResetAnimation] = useState(false)

const resetScreenSettings = () => {
  replaceScreenRecord(DEFAULT_SCREEN_RECORD_SETTINGS)
  setResetAnimation(true)
}

const finishResetAnimation = () => setResetAnimation(false)



  return (

    <>



      <RecordingControls

        onStateChange={onRecordingStateChange}

        frameRate={Number(fps)}

        videoBitsPerSecond={Number(bitrate) * 1_000_000}

        microphoneEnabled={microphone}
        microphoneDeviceId={microphoneDeviceId || undefined}
        camera={cameraOptions}

        systemAudioEnabled={systemAudio}

        showCursor={showCursor}
        clickEffects={clickEffects}
        audio={audioSettings}
        mouseFocus={mouseFocus}
        mouseZoomLevel={Number(mouseZoomLevel)}
        mouseZoomSpeed={mouseZoomSpeed as 'slow' | 'normal' | 'fast'}

        resolution={resolution}
        captureMode={captureMode as 'full' | 'custom' | 'area'}
        monitorId={monitorId}
        encoder={encoder as 'av1' | 'h264' | 'hevc'}
        outputFormat={format as 'webm' | 'mp4' | 'mkv' | 'mov'}
        area={area}

      />
      <div
        inert={isRecording}
        aria-disabled={isRecording}
        className={isRecording ? 'pointer-events-none select-none opacity-60 transition-opacity' : 'transition-opacity'}
      >



      <div className="mt-4">

        <Section collapsible

          title="Video"

          icon={Monitor}

        >

          <SettingRow label="Capture Mode">

            <SelectField

              value={captureMode}

              onChange={setCaptureMode}
              disabled={isRecording}

              options={[

                { label: 'Full Screen', value: 'full' },

                { label: 'Custom Resolution', value: 'custom' },

                { label: 'Select Area', value: 'area' },

              ]}

            />

          </SettingRow>



          {captureMode === 'custom' && (

            <SettingRow label="Output Resolution" description="Aspect ratio will be preserved">

              <SelectField

                value={resolution}

                onChange={setResolution}

                options={resolutions}

                disabled={isRecording}

              />

            </SettingRow>

          )}



          <SettingRow label="Monitor Selection">

            <SelectField

              value={monitorId && captureSources.some((source) => source.id === monitorId) ? monitorId : 'default'}

              onChange={setMonitorId}

              disabled={isRecording}

              options={[
                { label: 'System Default Display', value: 'default' },
                ...captureSources.map((source, index) => ({
                  label: `${source.name || `Display ${index + 1}`} (${source.displayId})`,
                  value: source.id,
                })),
              ]}

            />

          </SettingRow>



          {captureMode === 'area' && (
            <SettingRow
              label="Selected Area"
              description={
                area
                  ? `${areaPixelWidth && areaPixelHeight ? `${areaPixelWidth} × ${areaPixelHeight} px` : 'Area selected'} on the chosen monitor`
                  : 'Drag on the dark overlay to choose what to record'
              }
            >
              <button
                type="button"
                onClick={() => void chooseArea(monitorId)}
                disabled={isRecording || selectingArea}
                className="w-full rounded-xl border border-white/10 bg-white/[0.04] px-3 py-3 text-xs font-semibold text-zinc-200 transition-colors hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-45"
              >
                {selectingArea ? 'Selecting...' : area ? 'Reselect Area' : 'Select Area'}
              </button>
              {areaError && (
                <p className="mt-2 text-[10px] leading-5 text-red-300">{areaError}</p>
              )}
            </SettingRow>
          )}



          <SettingRow label="Video Encoder">

            <SelectField

              value={encoder}

              onChange={setEncoder}
              disabled={isRecording}

              options={[

                { label: 'H.264 / AVC', value: 'h264' },

                { label: 'H.265 / HEVC', value: 'hevc' },

                { label: 'AV1', value: 'av1' },

              ]}

            />

          </SettingRow>



          <SettingRow label="Output Format">

            <SelectField

              value={format}

              onChange={setFormat}
              disabled={isRecording}

              options={[

                { label: 'WebM', value: 'webm' },

                { label: 'MKV', value: 'mkv' },

                { label: 'MP4', value: 'mp4' },

                { label: 'MOV', value: 'mov' },

              ]}

            />

          </SettingRow>



          <SettingRow label="Video FPS">

            <SelectField

              value={fps}

              onChange={setFps}

              options={fpsOptions}

              disabled={isRecording}

            />

          </SettingRow>



          <SettingRow label="Video Bitrate">

            <SelectField

              value={bitrate}

              onChange={setBitrate}

              disabled={isRecording}

              options={['5', '8', '12', '16', '20', '30', '40', '50', '80', '100'].map((v) => ({

                label: `${v} Mbps`,

                value: v,

              }))}

            />

          </SettingRow>



          <SettingRow label="Show Cursor">

            <Toggle checked={showCursor} onChange={setShowCursor} disabled={isRecording} />

          </SettingRow>

        </Section>







        <Section collapsible

          title="Audio"


          icon={Volume2}

        >

          <SettingRow label="Audio Codec">

            <SelectField

              value={audioSettings.codec}

              onChange={setAudioCodec}

              disabled={isRecording}

              options={(audioCodecChoices.length > 0 ? audioCodecChoices : [audioSettings.codec]).map((item) => ({

                label: AUDIO_CODEC_LABELS[item],

                value: item,

              }))}

            />

          </SettingRow>



          <SettingRow
            label="Audio Bitrate"
            description={isLosslessAudioCodec(audioSettings.codec) ? 'Not used by lossless codecs' : undefined}
          >

            <SelectField

              value={String(audioSettings.bitrateKbps)}

              onChange={setAudioBitrate}

              disabled={isRecording || isLosslessAudioCodec(audioSettings.codec)}

              options={AUDIO_BITRATES_KBPS.map((v) => ({

                label: `${v} kbps`,

                value: String(v),

              }))}

            />

          </SettingRow>



          <SettingRow label="Channels">

            <SelectField

              value={audioSettings.channels}

              onChange={setAudioChannels}

              disabled={isRecording}

              options={[

                { label: 'Stereo', value: 'stereo' },

                { label: 'Mono', value: 'mono' },

              ]}

            />

          </SettingRow>



          <SettingRow
            label="Sample Rate"
            description={audioSettings.codec === 'opus' ? 'Opus always uses 48,000 Hz' : undefined}
          >

            <SelectField

              value={String(audioSettings.sampleRate)}

              onChange={setAudioSampleRate}

              disabled={isRecording}

              options={allowedSampleRates(audioSettings.codec).map((rate) => ({

                label: `${rate.toLocaleString('en-US')} Hz`,

                value: String(rate),

              }))}

            />

          </SettingRow>



          <SettingRow label="System Audio">

            <Toggle checked={systemAudio} onChange={setSystemAudio} disabled={isRecording} />

          </SettingRow>

        </Section>



        <Section

          title="Microphone"


          icon={Mic}

          headerAction={<Toggle checked={microphone} onChange={setMicrophone} disabled={isRecording || !hasMicrophone} />}

        >



          {microphone && (
<>
<SettingRow label="Mic Devices">

            <SelectField

              value={microphoneDeviceId}

              onChange={setMicrophoneDevice}

              disabled={isRecording || !hasMicrophone}

              options={hasMicrophone
                ? micDevices.map((item) => ({ label: item.label, value: item.id }))
                : [{ label: 'No microphone detected', value: '' }]}

            />

          </SettingRow>



          <div className="rounded-xl bg-white/[0.035] p-3">

            <div className="mb-2 flex items-center justify-between text-[10px]">

              <span className="text-zinc-400">Microphone Level</span>

              <span className="text-zinc-600">{!hasMicrophone ? 'No microphone detected' : microphone ? 'Live' : 'Enable microphone to see level'}</span>

            </div>

            <div className="h-2 overflow-hidden rounded-full bg-white/[0.07]">

              <div ref={micLevelBar} className="h-full w-0 rounded-full bg-green-400" />

            </div>

          </div>
</>
)}

        </Section>



        <Section

          title="Camera"


          icon={Camera}

          headerAction={<Toggle checked={camera} onChange={setCamera} disabled={isRecording || !hasCamera} />}

        >



          {camera && (

            <>

              <SettingRow label="Devices">

                <SelectField

                  value={cameraDeviceId}

                  onChange={setCameraDevice}

                  disabled={isRecording}

                  options={cameraDevices.map((item) => ({ label: item.label, value: item.id }))}

                />

              </SettingRow>

              <SettingRow label="Position">

                <Toggle checked={showPositionMap} onChange={setShowPositionMap} />

              </SettingRow>

              {showPositionMap && (
                <div className="rounded-xl bg-white/[0.035] p-3">
                  <div className="relative mx-auto aspect-video w-full max-w-[320px] overflow-hidden rounded-lg border border-white/[0.12] bg-black/40">
                    {CAMERA_POSITIONS.map((item) => {
                      const [vertical, horizontal] = item.value.split('-')
                      const selected = cameraPosition === item.value
                      return (
                        <button
                          key={item.value}
                          type="button"
                          title={item.label}
                          aria-label={item.label}
                          aria-pressed={selected}
                          disabled={isRecording}
                          onClick={() => setCameraPosition(item.value)}
                          style={{
                            top: vertical === 'top' ? '6%' : vertical === 'middle' ? '50%' : 'auto',
                            bottom: vertical === 'bottom' ? '6%' : 'auto',
                            left: horizontal === 'left' ? '4%' : horizontal === 'center' ? '50%' : 'auto',
                            right: horizontal === 'right' ? '4%' : 'auto',
                            transform: `translate(${horizontal === 'center' ? '-50%' : '0'}, ${vertical === 'middle' ? '-50%' : '0'})`,
                          }}
                          className={`absolute flex h-[22%] w-[24%] items-center justify-center rounded-md border transition-colors disabled:cursor-not-allowed ${
                            selected
                              ? 'border-red-400 bg-red-500/70 text-white'
                              : 'border-white/20 bg-white/[0.08] text-zinc-400 hover:bg-white/[0.16]'
                          }`}
                        >
                          <Camera size={12} />
                        </button>
                      )
                    })}
                  </div>
                  <p className="mt-2 text-center text-[10px] text-zinc-400">
                    {CAMERA_POSITIONS.find((item) => item.value === cameraPosition)?.label}
                  </p>
                </div>
              )}

              <SettingRow label="Size">

                <SelectField

                  value={cameraSize}

                  onChange={setCameraSize}

                  disabled={isRecording}

                  options={CAMERA_SIZE_LABELS}

                />

              </SettingRow>



              <SettingRow label="Shapes">

                <SelectField

                  value={cameraShape}

                  onChange={setCameraShape}

                  options={[

                    { label: 'Rectangle', value: 'rectangle' },

                    { label: 'Rounded Rectangle', value: 'rounded' },

                    { label: 'Circle', value: 'circle' },

                  ]}

                />

              </SettingRow>



              <SettingRow label="Mirror">

                <Toggle checked={cameraMirror} onChange={setCameraMirror} />

              </SettingRow>



              <div>

                <div className="mb-2 flex justify-between text-xs">

                  <span className="label-font text-xs text-zinc-200">Opacity</span>

                  <span className="label-font text-xs text-zinc-400">{cameraOpacity}%</span>

                </div>

                <input

                  type="range"

                  min="20"

                  max="100"

                  value={cameraOpacity}

                  onChange={(event) => setCameraOpacity(Number(event.target.value))}

                  className="w-full accent-red-500"

                />

              </div>

            </>

          )}

        </Section>



        <Section collapsible

          title="Optional"

          icon={Monitor}

        >

          <SettingRow label="Mouse Focus" description={`Mouse Focus only works while you hold the ${readFocusKey(settings.mouseFocusKey).split('+').join(' + ')} key. Release it to zoom out. You can change this key in Settings.`}>

            <Toggle checked={mouseFocus} onChange={setMouseFocus} disabled={isRecording || !showCursor} />

          </SettingRow>




          {mouseFocus && (

            <>

              <SettingRow label="Zoom Level">

                <SelectField

                  value={mouseZoomLevel}

                  onChange={(value) => setScreen('mouseZoomLevel', value)}

                  options={[

                    { label: '1.5×', value: '1.5' },

                    { label: '2×', value: '2' },

                    { label: '3×', value: '3' },

                  ]}

                  disabled={isRecording}

                />

              </SettingRow>

              <SettingRow label="Zoom Speed">

                <SelectField

                  value={mouseZoomSpeed}

                  onChange={(value) => setScreen('mouseZoomSpeed', value)}

                  options={[

                    { label: 'Slow', value: 'slow' },

                    { label: 'Normal', value: 'normal' },

                    { label: 'Fast', value: 'fast' },

                  ]}

                  disabled={isRecording}

                />

              </SettingRow>

            </>

          )}



          <SettingRow
            label="Mouse Click Effects"
          >

            <Toggle checked={clickEffects} onChange={setClickEffects} disabled={isRecording || !showCursor} />

          </SettingRow>

        </Section>



        <div className="glass-panel rounded-2xl p-5">

          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <MonitorPlay size={19} className="text-red-400" />
              <div>
                <h3 className="heading-font text-xs">Live Preview</h3>
              </div>
            </div>
            <Toggle checked={livePreview} onChange={setLivePreview} disabled={isRecording} />
          </div>



          <LivePreview
            monitorId={monitorId}
            captureMode={captureMode as 'full' | 'custom' | 'area'}
            area={area}
            showCursor={showCursor}
            enabled={livePreview && !isRecording}
            cameraEnabled={camera}
            cameraDeviceId={cameraDeviceId}
            cameraSize={cameraSize}
            cameraShape={cameraShape}
            cameraPosition={cameraPosition}
            cameraMirror={cameraMirror}
            cameraOpacity={cameraOpacity}
          />

        </div>

      </div>

      <div className="mt-6 flex justify-end">
        <motion.button
          type="button"
          onClick={resetScreenSettings}
          disabled={isRecording}
          animate={resetAnimation ? {
            scale: [1, 0.92, 1.08, 1],
            boxShadow: [
              '0 0 0 rgba(34,197,94,0)',
              '0 0 28px rgba(34,197,94,0.85)',
              '0 0 18px rgba(34,197,94,0.55)',
              '0 0 0 rgba(34,197,94,0)',
            ],
            backgroundColor: ['#22c55e', '#86efac', '#22c55e'],
          } : { scale: 1 }}
          transition={{ duration: 0.55, ease: 'easeOut' }}
          onAnimationComplete={finishResetAnimation}
          whileHover={{ scale: 1.04, y: -2 }}
          whileTap={{ scale: 0.93 }}
          className="rounded-xl border border-green-300/50 bg-green-500 px-5 py-3 text-xs font-bold text-white shadow-lg shadow-green-950/25 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Default Setting
        </motion.button>
      </div>
      </div>

    </>

  )

}



function GamingModePage({

  onRecordingStateChange,

  isRecording,

}: {

  onRecordingStateChange: (state: RecorderState) => void

  isRecording: boolean

}) {

const { settings, updateGamingMode, replaceGamingMode } = useSettings()

const saved = settings.gamingMode

const readString = (key: string, fallback: string): string => {
  const value = saved[key]
  return typeof value === 'string' ? value : fallback
}

const readBoolean = (key: string, fallback: boolean): boolean => {
  const value = saved[key]
  return typeof value === 'boolean' ? value : fallback
}

const setGame = (key: string, value: unknown) => {
  updateGamingMode({ [key]: value })
}

const showCursor = readBoolean('showCursor', true)
const gameAudio = readBoolean('gameAudio', true)
const blockNotifications = readBoolean('blockNotifications', false)
const micDevices = useMicrophones()
const hasMicrophone = micDevices.length > 0
const savedMicId = readString('microphoneDeviceId', '')
const microphoneDeviceId = micDevices.some((item) => item.id === savedMicId)
  ? savedMicId
  : (micDevices[0]?.id ?? '')
// The microphone can only be on while a real microphone is connected.
const microphone = hasMicrophone && readBoolean('microphone', false)
const micLevelBar = useRef<HTMLDivElement | null>(null)
useMicrophoneLevel(microphone, microphoneDeviceId || undefined, micLevelBar)

const readNumber = (key: string, fallback: number): number => {
  const value = saved[key]
  return typeof value === 'number' ? value : fallback
}

const cameraDevices = useCameras()
const hasCamera = cameraDevices.length > 0
const savedCameraId = readString('cameraDeviceId', '')
const cameraDeviceId = cameraDevices.some((item) => item.id === savedCameraId)
  ? savedCameraId
  : (cameraDevices[0]?.id ?? '')
// The camera can only be on while a real camera is connected.
const camera = hasCamera && readBoolean('camera', false)
const cameraSize = readString('cameraSize', 'medium')
const cameraPositionSaved = readString('cameraPosition', 'bottom-right')
const cameraPosition = CAMERA_POSITIONS.some((item) => item.value === cameraPositionSaved)
  ? cameraPositionSaved
  : 'bottom-right'
const cameraMirror = readBoolean('cameraMirror', false)
const cameraShape = readString('cameraShape', 'rounded')
const cameraOpacity = readNumber('cameraOpacity', 100)
const [showPositionMap, setShowPositionMap] = useState(false)

// Speedrun Timer (Optional): where it sits uses the same spots as the camera.
const speedrunTimer = readBoolean('speedrunTimer', false)
const timerPositionSaved = readString('timerPosition', 'top-left')
const timerPosition = CAMERA_POSITIONS.some((item) => item.value === timerPositionSaved)
  ? timerPositionSaved
  : 'top-left'
const setSpeedrunTimer = (value: boolean) => setGame('speedrunTimer', value)
const setTimerPosition = (value: string) => setGame('timerPosition', value)

// Monitoring: hardware readings over the game; the position uses the same spots as the camera.
const monitoring = readBoolean('monitoring', false)
const monitorPositionSaved = readString('monitorPosition', 'top-left')
const monitorPosition = CAMERA_POSITIONS.some((item) => item.value === monitorPositionSaved)
  ? monitorPositionSaved
  : 'top-left'
const savedMonitorMetrics = saved.monitorMetrics
const monitorMetrics = useMemo(() => normalizeMonitorMetrics(savedMonitorMetrics), [savedMonitorMetrics])
const setMonitoring = (value: boolean) => setGame('monitoring', value)
const setMonitorPosition = (value: string) => setGame('monitorPosition', value)
const setMonitorMetric = (metric: MonitorMetric, value: boolean) => {
  setGame('monitorMetrics', ALL_MONITOR_METRICS.filter((key) => (key === metric ? value : monitorMetrics.includes(key))))
}

const lowLatency = readBoolean('lowLatency', false)
const vfr = readBoolean('vfr', false)
const hdr = readBoolean('hdr', false)

const fps = readString('fps', '60')
const format = readString('format', 'mkv')
const bitrate = readString('bitrate', '40')
// HDR10 needs 10-bit HEVC, so HDR Recording always uses H.265 / HEVC.
const encoder = hdr ? 'hevc' : readString('encoder', 'h264') === 'hevc' ? 'hevc' : 'h264'

const setShowCursor = (value: boolean) => setGame('showCursor', value)
const setGameAudio = (value: boolean) => setGame('gameAudio', value)
const setBlockNotifications = (value: boolean) => setGame('blockNotifications', value)
const setMicrophone = (value: boolean) => setGame('microphone', value)
const setMicrophoneDevice = (value: string) => setGame('microphoneDeviceId', value)
const setCamera = (value: boolean) => setGame('camera', value)
const setCameraMirror = (value: boolean) => setGame('cameraMirror', value)
const setCameraDevice = (value: string) => setGame('cameraDeviceId', value)
const setCameraSize = (value: string) => setGame('cameraSize', value)
const setCameraPosition = (value: string) => setGame('cameraPosition', value)
const setCameraShape = (value: string) => setGame('cameraShape', value)
const setCameraOpacity = (value: number) => setGame('cameraOpacity', value)

const setLowLatency = (value: boolean) => setGame('lowLatency', value)
const setVfr = (value: boolean) => setGame('vfr', value)
const setHdr = (value: boolean) => setGame('hdr', value)

const setFps = (value: string) => setGame('fps', value)
const setFormat = (value: string) => setGame('format', value)
const setBitrate = (value: string) => setGame('bitrate', value)
const setEncoder = (value: string) => setGame('encoder', value)

// Audio output settings, identical to Screen Record: only combinations the
// selected container supports (and the bundled FFmpeg can encode) are offered.
const [availableAudioCodecs, setAvailableAudioCodecs] = useState<AudioCodec[] | null>(null)
const [hevcAvailable, setHevcAvailable] = useState(true)
useEffect(() => {
  let mounted = true
  window.electronAPI.nativeCapabilities()
    .then((capabilities) => {
      if (mounted && capabilities.available) {
        setAvailableAudioCodecs(capabilities.audioCodecs)
        setHevcAvailable(capabilities.encoders.hevc.length > 0)
      }
    })
    .catch(() => undefined)
  return () => { mounted = false }
}, [])
const audioContainer = isAudioContainer(format) ? format : 'mkv'
const audioCodecChoices = CONTAINER_AUDIO_CODECS[audioContainer].filter(
  (item) => !availableAudioCodecs || availableAudioCodecs.includes(item),
)
const savedAudioCodec = readString('audioCodec', 'aac')
const savedAudioBitrate = readString('audioBitrate', '192')
const savedAudioChannels = readString('audioChannels', 'stereo')
const savedAudioSampleRate = readString('audioSampleRate', '48000')
const preferredAudioCodec =
  audioCodecChoices.length > 0 && !audioCodecChoices.includes(savedAudioCodec as AudioCodec)
    ? audioCodecChoices.includes('aac') ? 'aac' : audioCodecChoices[0]
    : savedAudioCodec
const audioSettings = useMemo(
  () => normalizeAudioSettings(
    {
      codec: preferredAudioCodec,
      bitrateKbps: Number(savedAudioBitrate),
      channels: savedAudioChannels,
      sampleRate: Number(savedAudioSampleRate),
    },
    audioContainer,
  ),
  [preferredAudioCodec, savedAudioBitrate, savedAudioChannels, savedAudioSampleRate, audioContainer],
)
const setAudioCodec = (value: string) => setGame('audioCodec', value)
const setAudioBitrate = (value: string) => setGame('audioBitrate', value)
const setAudioChannels = (value: string) => setGame('audioChannels', value)
const setAudioSampleRate = (value: string) => setGame('audioSampleRate', value)

const cameraOptions = useMemo<CameraOptions | undefined>(
  () => (camera
    ? { deviceId: cameraDeviceId, size: cameraSize, shape: cameraShape, mirror: cameraMirror, opacity: cameraOpacity, position: cameraPosition }
    : undefined),
  [camera, cameraDeviceId, cameraSize, cameraShape, cameraMirror, cameraOpacity, cameraPosition],
)

// Running games, detected automatically and refreshed while idle.
const [games, setGames] = useState<DetectedGame[]>([])
const [gamesLoaded, setGamesLoaded] = useState(false)
const [selectedGameId, setSelectedGameId] = useState('')
const [gamesRefreshing, setGamesRefreshing] = useState(false)
const [showAllApps, setShowAllApps] = useState(false)
const [gamesError, setGamesError] = useState('')
const [livePreview, setLivePreview] = useState(false)
const refreshGames = useCallback(async () => {
  setGamesRefreshing(true)
  try {
    const result = await window.electronAPI.listGames()
    setGames(result.games)
    setGamesError(result.error ?? '')
    // A game that was closed can no longer stay selected.
    setSelectedGameId((current) => (result.games.some((item) => item.id === current) ? current : ''))
  } catch (error) {
    setGames([])
    setGamesError(error instanceof Error ? error.message : 'The game scan failed.')
  } finally {
    setGamesLoaded(true)
    setGamesRefreshing(false)
  }
}, [])
// Games are scanned when the page opens and whenever Refresh is pressed.
useEffect(() => {
  if (isRecording) return
  void refreshGames()
}, [isRecording, refreshGames])
// Choosing a game replaces the previous choice, so only one is ever selected.
const selectGame = (id: string) => setSelectedGameId((current) => (current === id ? '' : id))
const selectedGame = games.find((item) => item.id === selectedGameId) ?? null

// The timer clock and its hotkeys live in the main process; this keeps them in
// step with the switch, the chosen game and the chosen position.
useEffect(() => {
  void window.electronAPI
    .configureTimer({ enabled: speedrunTimer, gameId: selectedGame?.id ?? '', position: timerPosition })
    .catch(() => undefined)
}, [speedrunTimer, selectedGame?.id, timerPosition])
useEffect(() => () => {
  void window.electronAPI
    .configureTimer({ enabled: false, gameId: '', position: 'top-left' })
    .catch(() => undefined)
}, [])

// Monitoring readers and the on-screen panel live in the main process; this
// keeps them in step with the switches, the chosen game, position and values.
const monitorGameId = selectedGame?.id ?? ''
const selectedGamePid = selectedGame?.pid ?? 0
useEffect(() => {
  void window.electronAPI
    .configureMonitor({
      enabled: monitoring,
      gameId: monitorGameId,
      gameProcessId: selectedGamePid,
      position: monitorPosition,
      metrics: monitorMetrics,
    })
    .catch(() => undefined)
}, [monitoring, monitorGameId, selectedGamePid, monitorPosition, monitorMetrics])
useEffect(() => () => {
  void window.electronAPI
    .configureMonitor({ enabled: false, gameId: '', gameProcessId: 0, position: 'top-left', metrics: [] })
    .catch(() => undefined)
}, [])
// What the video (and the Live Game Preview) contains.
const monitorOptions = useMemo(
  () => (monitoring && monitorMetrics.length > 0
    ? { position: monitorPosition, metrics: monitorMetrics }
    : undefined),
  [monitoring, monitorPosition, monitorMetrics],
)
const visibleGames = showAllApps ? games : games.filter((item) => item.isGame)
useEffect(() => {
  if (isRecording) setLivePreview(false)
}, [isRecording])

// Block Notification: active only while a recording is running (or paused).
// Everything that arrived is delivered again as soon as the recording ends.
useEffect(() => {
  if (!blockNotifications || !isRecording) return
  void window.electronAPI.setNotificationsBlocked(true).catch(() => undefined)
  return () => {
    void window.electronAPI.setNotificationsBlocked(false).catch(() => undefined)
  }
}, [blockNotifications, isRecording])

const [resetAnimation, setResetAnimation] = useState(false)

const resetGamingSettings = () => {
  replaceGamingMode(DEFAULT_GAMING_MODE_SETTINGS)
  setResetAnimation(true)
}

const finishResetAnimation = () => setResetAnimation(false)



  return (

    <>

      <RecordingControls

        mode="gaming"

        frameRate={Number(fps)}

        videoBitsPerSecond={Number(bitrate) * 1_000_000}

        systemAudioEnabled={gameAudio}

        showCursor={showCursor}

        microphoneEnabled={microphone}

        microphoneDeviceId={microphoneDeviceId || undefined}

        monitorId={selectedGame?.id ?? ''}

        gameId={selectedGame?.id ?? ''}

        gameProcessId={selectedGame?.pid ?? 0}

        timerPosition={speedrunTimer ? timerPosition : ''}

        monitor={monitorOptions}

        encoder={encoder as 'h264' | 'hevc'}

        camera={cameraOptions}

        frameRateMode={vfr ? 'vfr' : 'cfr'}

        lowLatency={lowLatency}

        hdr={hdr}

        outputFormat={format as 'mkv' | 'mp4' | 'mov'}

        audio={audioSettings}

        onStateChange={onRecordingStateChange}

      />
      <div
        inert={isRecording}
        aria-disabled={isRecording}
        className={isRecording ? 'pointer-events-none select-none opacity-60 transition-opacity' : 'transition-opacity'}
      >



      <div className="mt-4">

        <Section title="Game Selection" description="Running games are detected automatically. Choose one to capture" icon={Gamepad2}>

          <div className="mb-3 flex items-center justify-end gap-3">

            <label className="flex items-center gap-2 text-[10px] font-bold text-zinc-300">
              All Apps
              <Toggle checked={showAllApps} onChange={setShowAllApps} disabled={isRecording} />
            </label>

            <button
              type="button"
              onClick={() => void refreshGames()}
              disabled={gamesRefreshing || isRecording}
              className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.05] px-3 py-1.5 text-[10px] font-bold text-zinc-200 transition-colors hover:bg-white/[0.1] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RefreshCw size={12} className={gamesRefreshing ? 'animate-spin' : ''} />
              Refresh
            </button>

          </div>

          {visibleGames.length === 0 ? (

            <div className="rounded-xl border border-dashed border-white/10 bg-black/20 px-4 py-8 text-center">

              <Gamepad2 size={30} className="mx-auto text-zinc-600" />

              <p className="mt-3 text-xs font-semibold text-zinc-300">
                {gamesLoaded ? 'No games detected' : 'Looking for running games...'}
              </p>

              {gamesError && (
                <p className="mt-2 break-words text-[10px] text-red-300/80">{gamesError}</p>
              )}

            </div>

          ) : (

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">

              {visibleGames.map((game) => {
                const selected = game.id === selectedGameId
                return (
                  <button
                    key={game.id}
                    type="button"
                    onClick={() => selectGame(game.id)}
                    aria-pressed={selected}
                    title={`${game.name} (${game.exeName})`}
                    className={`flex flex-col items-center gap-2 rounded-xl border p-3 text-center transition-colors ${
                      selected
                        ? 'border-red-400/60 bg-red-500/10'
                        : 'border-white/[0.07] bg-white/[0.035] hover:bg-white/[0.07]'
                    }`}
                  >
                    {game.icon ? (
                      <img src={game.icon} alt="" className="h-12 w-12 object-contain" draggable={false} />
                    ) : (
                      <Gamepad2 size={34} className="text-zinc-600" />
                    )}
                    <span className="line-clamp-2 w-full break-words text-[10px] font-semibold text-zinc-200">
                      {game.name}
                    </span>
                  </button>
                )
              })}

            </div>

          )}

        </Section>

      </div>



      <Section collapsible title="Video" icon={Film}>

        <SettingRow label="Output Format">

          <SelectField

            value={format}

            onChange={setFormat}

            disabled={isRecording}

            options={[

              { label: 'MKV', value: 'mkv' },

              { label: 'MP4', value: 'mp4' },

              { label: 'MOV', value: 'mov' },

            ]}

          />

        </SettingRow>

        <SettingRow
          label="Video Encoder"
          description={hdr ? 'HDR Recording requires H.265 / HEVC' : undefined}
        >
          <SelectField
            value={encoder}
            onChange={setEncoder}
            disabled={isRecording || hdr}
            options={[
              { label: 'H.264 / AVC', value: 'h264' },
              ...(hevcAvailable || encoder === 'hevc' ? [{ label: 'H.265 / HEVC', value: 'hevc' }] : []),
            ]}
          />
        </SettingRow>

        <SettingRow label="Output FPS">

          <SelectField value={fps} onChange={setFps} options={gamingFpsOptions} disabled={isRecording} />

        </SettingRow>

        <SettingRow label="Video Bitrate">

          <SelectField

            value={bitrate}

            onChange={setBitrate}

            disabled={isRecording}

            options={['12', '20', '30', '40', '50', '80', '100'].map((v) => ({

              label: `${v} Mbps`,

              value: v,

            }))}

          />

        </SettingRow>

        <SettingRow label="Frame Rate Mode">

          <SelectField

            value={vfr ? 'vfr' : 'cfr'}

            onChange={(v) => setVfr(v === 'vfr')}

            disabled={isRecording}

            options={[

              { label: 'Constant Frame Rate (CFR)', value: 'cfr' },

              { label: 'Variable Frame Rate (VFR)', value: 'vfr' },

            ]}

          />

        </SettingRow>

        <SettingRow label="Show Cursor">

          <Toggle checked={showCursor} onChange={setShowCursor} disabled={isRecording} />

        </SettingRow>

      </Section>



      <Section collapsible
        title="Audio"
        icon={Volume2}
      >

        <SettingRow label="Audio Codec">
          <SelectField
            value={audioSettings.codec}
            onChange={setAudioCodec}
            disabled={isRecording}
            options={(audioCodecChoices.length > 0 ? audioCodecChoices : [audioSettings.codec]).map((item) => ({
              label: AUDIO_CODEC_LABELS[item],
              value: item,
            }))}
          />
        </SettingRow>

        <SettingRow
          label="Audio Bitrate"
          description={isLosslessAudioCodec(audioSettings.codec) ? 'Not used by lossless codecs' : undefined}
        >
          <SelectField
            value={String(audioSettings.bitrateKbps)}
            onChange={setAudioBitrate}
            disabled={isRecording || isLosslessAudioCodec(audioSettings.codec)}
            options={AUDIO_BITRATES_KBPS.map((v) => ({
              label: `${v} kbps`,
              value: String(v),
            }))}
          />
        </SettingRow>

        <SettingRow label="Channels">
          <SelectField
            value={audioSettings.channels}
            onChange={setAudioChannels}
            disabled={isRecording}
            options={[
              { label: 'Stereo', value: 'stereo' },
              { label: 'Mono', value: 'mono' },
            ]}
          />
        </SettingRow>

        <SettingRow
          label="Sample Rate"
          description={audioSettings.codec === 'opus' ? 'Opus always uses 48,000 Hz' : undefined}
        >
          <SelectField
            value={String(audioSettings.sampleRate)}
            onChange={setAudioSampleRate}
            disabled={isRecording}
            options={allowedSampleRates(audioSettings.codec).map((rate) => ({
              label: `${rate.toLocaleString('en-US')} Hz`,
              value: String(rate),
            }))}
          />
        </SettingRow>

        <SettingRow label="Game Audio">
          <Toggle checked={gameAudio} onChange={setGameAudio} disabled={isRecording} />
        </SettingRow>

      </Section>



      <Section
        title="Microphone"
        icon={Mic}
        headerAction={<Toggle checked={microphone} onChange={setMicrophone} disabled={isRecording || !hasMicrophone} />}
      >
        {microphone && (
<>
<SettingRow label="Mic Devices">
          <SelectField
            value={microphoneDeviceId}
            onChange={setMicrophoneDevice}
            disabled={isRecording || !hasMicrophone}
            options={hasMicrophone
              ? micDevices.map((item) => ({ label: item.label, value: item.id }))
              : [{ label: 'No microphone detected', value: '' }]}
          />
        </SettingRow>
        <div className="rounded-xl bg-white/[0.035] p-3">
          <div className="mb-2 flex items-center justify-between text-[10px]">
            <span className="text-zinc-400">Microphone Level</span>
            <span className="text-zinc-600">{!hasMicrophone ? 'No microphone detected' : microphone ? 'Live' : 'Enable microphone to see level'}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-white/[0.07]">
            <div ref={micLevelBar} className="h-full w-0 rounded-full bg-green-400" />
          </div>
        </div>
</>
)}
      </Section>



      <Section
        title="Camera"
        icon={Camera}
        headerAction={<Toggle checked={camera} onChange={setCamera} disabled={isRecording || !hasCamera} />}
      >
        {camera && (
          <>
            <SettingRow label="Devices">
              <SelectField
                value={cameraDeviceId}
                onChange={setCameraDevice}
                disabled={isRecording}
                options={cameraDevices.map((item) => ({ label: item.label, value: item.id }))}
              />
            </SettingRow>
            <SettingRow label="Position">
              <Toggle checked={showPositionMap} onChange={setShowPositionMap} />
            </SettingRow>
            {showPositionMap && (
              <div className="rounded-xl bg-white/[0.035] p-3">
                <div className="relative mx-auto aspect-video w-full max-w-[320px] overflow-hidden rounded-lg border border-white/[0.12] bg-black/40">
                  {CAMERA_POSITIONS.map((item) => {
                    const [vertical, horizontal] = item.value.split('-')
                    const selected = cameraPosition === item.value
                    return (
                      <button
                        key={item.value}
                        type="button"
                        title={item.label}
                        aria-label={item.label}
                        aria-pressed={selected}
                        disabled={isRecording}
                        onClick={() => setCameraPosition(item.value)}
                        style={{
                          top: vertical === 'top' ? '6%' : vertical === 'middle' ? '50%' : 'auto',
                          bottom: vertical === 'bottom' ? '6%' : 'auto',
                          left: horizontal === 'left' ? '4%' : horizontal === 'center' ? '50%' : 'auto',
                          right: horizontal === 'right' ? '4%' : 'auto',
                          transform: `translate(${horizontal === 'center' ? '-50%' : '0'}, ${vertical === 'middle' ? '-50%' : '0'})`,
                        }}
                        className={`absolute flex h-[22%] w-[24%] items-center justify-center rounded-md border transition-colors disabled:cursor-not-allowed ${
                          selected
                            ? 'border-red-400 bg-red-500/70 text-white'
                            : 'border-white/20 bg-white/[0.08] text-zinc-400 hover:bg-white/[0.16]'
                        }`}
                      >
                        <Camera size={12} />
                      </button>
                    )
                  })}
                </div>
                <p className="mt-2 text-center text-[10px] text-zinc-400">
                  {CAMERA_POSITIONS.find((item) => item.value === cameraPosition)?.label}
                </p>
              </div>
            )}
            <SettingRow label="Size">
              <SelectField
                value={cameraSize}
                onChange={setCameraSize}
                disabled={isRecording}
                options={CAMERA_SIZE_LABELS}
              />
            </SettingRow>
            <SettingRow label="Shapes">
              <SelectField
                value={cameraShape}
                onChange={setCameraShape}
                options={[
                  { label: 'Rectangle', value: 'rectangle' },
                  { label: 'Rounded Rectangle', value: 'rounded' },
                  { label: 'Circle', value: 'circle' },
                ]}
              />
            </SettingRow>
            <SettingRow label="Mirror">
              <Toggle checked={cameraMirror} onChange={setCameraMirror} />
            </SettingRow>
            <div>
              <div className="mb-2 flex justify-between text-xs">
                <span className="label-font text-xs text-zinc-200">Opacity</span>
                <span className="label-font text-xs text-zinc-400">{cameraOpacity}%</span>
              </div>
              <input
                type="range"
                min="20"
                max="100"
                value={cameraOpacity}
                onChange={(event) => setCameraOpacity(Number(event.target.value))}
                className="w-full accent-red-500"
              />
            </div>
          </>
        )}
      </Section>



      <Section
        title="Monitoring"
        icon={Activity}
        headerAction={<Toggle checked={monitoring} onChange={setMonitoring} disabled={isRecording} />}
      >
        {monitoring && (
          <>
            <div className="rounded-xl bg-white/[0.035] p-3">
              <div className="relative mx-auto aspect-video w-full max-w-[320px] overflow-hidden rounded-lg border border-white/[0.12] bg-black/40">
                {CAMERA_POSITIONS.map((item) => {
                  const [vertical, horizontal] = item.value.split('-')
                  const selected = monitorPosition === item.value
                  return (
                    <button
                      key={item.value}
                      type="button"
                      title={item.label}
                      aria-label={item.label}
                      aria-pressed={selected}
                      disabled={isRecording}
                      onClick={() => setMonitorPosition(item.value)}
                      style={{
                        top: vertical === 'top' ? '6%' : vertical === 'middle' ? '50%' : 'auto',
                        bottom: vertical === 'bottom' ? '6%' : 'auto',
                        left: horizontal === 'left' ? '4%' : horizontal === 'center' ? '50%' : 'auto',
                        right: horizontal === 'right' ? '4%' : 'auto',
                        transform: `translate(${horizontal === 'center' ? '-50%' : '0'}, ${vertical === 'middle' ? '-50%' : '0'})`,
                      }}
                      className={`absolute flex h-[22%] w-[24%] items-center justify-center rounded-md border transition-colors disabled:cursor-not-allowed ${
                        selected
                          ? 'border-red-400 bg-red-500/70 text-white'
                          : 'border-white/20 bg-white/[0.08] text-zinc-400 hover:bg-white/[0.16]'
                      }`}
                    >
                      <Activity size={12} />
                    </button>
                  )
                })}
              </div>
              <p className="mt-2 text-center text-[10px] text-zinc-400">
                {CAMERA_POSITIONS.find((item) => item.value === monitorPosition)?.label}
              </p>
            </div>
            {MONITOR_METRICS.map((item) => (
              <SettingRow key={item.key} label={item.label}>
                <Toggle
                  checked={monitorMetrics.includes(item.key)}
                  onChange={(value) => setMonitorMetric(item.key, value)}
                  disabled={isRecording}
                />
              </SettingRow>
            ))}
          </>
        )}
      </Section>



      <Section collapsible
        title="Optional"
        icon={Timer}
      >
        <SettingRow label="Block Notification">
          <Toggle checked={blockNotifications} onChange={setBlockNotifications} disabled={isRecording} />
        </SettingRow>

        <SettingRow
          label="HDR Recording"
          description="Records 10-bit HEVC in HDR10 (BT.2020 / PQ)"
        >

          <Toggle checked={hdr} onChange={setHdr} disabled={isRecording} />

        </SettingRow>

        <SettingRow
          label="Low Latency Capture"
          description="Faster capture hand-off and the fastest encoder settings"
        >

          <Toggle checked={lowLatency} onChange={setLowLatency} disabled={isRecording} />

        </SettingRow>

        <div className="-mt-1">
          <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
            <div className="min-w-0 sm:self-center">
              <p className="label-font text-xs text-zinc-200">Speedrun Timer</p>
            </div>
            <div className="w-full sm:w-[230px] sm:shrink-0">
              <Toggle checked={speedrunTimer} onChange={setSpeedrunTimer} disabled={isRecording} />
            </div>
          </div>
          <div className="mt-2 space-y-1 rounded-xl bg-white/[0.035] p-3 text-[11px] text-zinc-400">
            <p>
              <span className="font-semibold text-zinc-200">{settings.shortcuts.timerToggle.split('+').join(' + ')}</span>
              {' : Start / stop the timer'}
            </p>
            <p>
              <span className="font-semibold text-zinc-200">{settings.shortcuts.timerPause.split('+').join(' + ')}</span>
              {' : Pause / resume the timer'}
            </p>
            <p>
              <span className="font-semibold text-zinc-200">{settings.shortcuts.timerReset.split('+').join(' + ')}</span>
              {' : Reset the timer'}
            </p>
          </div>
        </div>
        {speedrunTimer && (
          <>
            {(
              <div className="rounded-xl bg-white/[0.035] p-3">
                <div className="relative mx-auto aspect-video w-full max-w-[320px] overflow-hidden rounded-lg border border-white/[0.12] bg-black/40">
                  {CAMERA_POSITIONS.map((item) => {
                    const [vertical, horizontal] = item.value.split('-')
                    const selected = timerPosition === item.value
                    return (
                      <button
                        key={item.value}
                        type="button"
                        title={item.label}
                        aria-label={item.label}
                        aria-pressed={selected}
                        disabled={isRecording}
                        onClick={() => setTimerPosition(item.value)}
                        style={{
                          top: vertical === 'top' ? '6%' : vertical === 'middle' ? '50%' : 'auto',
                          bottom: vertical === 'bottom' ? '6%' : 'auto',
                          left: horizontal === 'left' ? '4%' : horizontal === 'center' ? '50%' : 'auto',
                          right: horizontal === 'right' ? '4%' : 'auto',
                          transform: `translate(${horizontal === 'center' ? '-50%' : '0'}, ${vertical === 'middle' ? '-50%' : '0'})`,
                        }}
                        className={`absolute flex h-[22%] w-[24%] items-center justify-center rounded-md border transition-colors disabled:cursor-not-allowed ${
                          selected
                            ? 'border-red-400 bg-red-500/70 text-white'
                            : 'border-white/20 bg-white/[0.08] text-zinc-400 hover:bg-white/[0.16]'
                        }`}
                      >
                        <Timer size={12} />
                      </button>
                    )
                  })}
                </div>
                <p className="mt-2 text-center text-[10px] text-zinc-400">
                  {CAMERA_POSITIONS.find((item) => item.value === timerPosition)?.label}
                </p>
              </div>
            )}
          </>
        )}
      </Section>

      <div className="glass-panel rounded-2xl p-5">

        <div className="flex items-center justify-between gap-3">

          <div className="flex items-center gap-3">

            <MonitorPlay size={19} className="text-red-400" />

            <div>

              <h3 className="heading-font text-xs">Live Game Preview</h3>

            </div>

          </div>

          <Toggle checked={livePreview} onChange={setLivePreview} disabled={isRecording} />

        </div>

        <GameLivePreview
          sourceId={selectedGame?.id ?? null}
          showCursor={showCursor}
          gameAudio={gameAudio}
          microphone={microphone}
          timerEnabled={speedrunTimer}
          timerPosition={timerPosition}
          monitor={monitorOptions}
          enabled={livePreview && !isRecording}
          cameraEnabled={camera}
          cameraDeviceId={cameraDeviceId}
          cameraSize={cameraSize}
          cameraShape={cameraShape}
          cameraPosition={cameraPosition}
          cameraMirror={cameraMirror}
          cameraOpacity={cameraOpacity}
        />

      </div>

      <div className="mt-6 flex justify-end">
        <motion.button
          type="button"
          onClick={resetGamingSettings}
          disabled={isRecording}
          animate={resetAnimation ? {
            scale: [1, 0.92, 1.08, 1],
            boxShadow: [
              '0 0 0 rgba(34,197,94,0)',
              '0 0 28px rgba(34,197,94,0.85)',
              '0 0 18px rgba(34,197,94,0.55)',
              '0 0 0 rgba(34,197,94,0)',
            ],
            backgroundColor: ['#22c55e', '#86efac', '#22c55e'],
          } : { scale: 1 }}
          transition={{ duration: 0.55, ease: 'easeOut' }}
          onAnimationComplete={finishResetAnimation}
          whileHover={{ scale: 1.04, y: -2 }}
          whileTap={{ scale: 0.93 }}
          className="rounded-xl border border-green-300/50 bg-green-500 px-5 py-3 text-xs font-bold text-white shadow-lg shadow-green-950/25 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Default Setting
        </motion.button>
      </div>
      </div>

    </>

  )

}





function formatFileSize(bytes: number): string {

  if (bytes < 1024) return `${bytes} B`

  const units = ['KB', 'MB', 'GB', 'TB']

  let value = bytes / 1024

  let unit = 0

  while (value >= 1024 && unit < units.length - 1) {

    value /= 1024

    unit += 1

  }

  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`

}



function MyRecordingsPage() {

  const [files, setFiles] = useState<RecordingFileInfo[]>([])

  const [loading, setLoading] = useState(true)

  const [error, setError] = useState('')

  const [busyPath, setBusyPath] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)



  const refresh = useCallback(async () => {

    setLoading(true)

    setError('')

    try {

      setFiles(await window.electronAPI.listRecordings())

    } catch (err) {

      setError(err instanceof Error ? err.message : 'Could not load recordings.')

    } finally {

      setLoading(false)

    }

  }, [])



useEffect(() => {

  let cancelled = false



  window.electronAPI.listRecordings()

    .then((items) => {

      if (!cancelled) setFiles(items)

    })

    .catch((err: unknown) => {

      if (!cancelled) {

        setError(err instanceof Error ? err.message : 'Could not load recordings.')

      }

    })

    .finally(() => {

      if (!cancelled) setLoading(false)

    })



  return () => {

    cancelled = true

  }

}, [])



  const handleOpen = async (file: RecordingFileInfo) => {

    setBusyPath(file.filePath)

    setError('')

    try {

      await window.electronAPI.openRecording(file.filePath)

    } catch (err) {

      setError(err instanceof Error ? err.message : 'Could not open recording.')

    } finally {

      setBusyPath('')

    }

  }



  const handleReveal = async (file: RecordingFileInfo) => {

    setBusyPath(file.filePath)

    setError('')

    try {

      await window.electronAPI.showRecordingInFolder(file.filePath)

    } catch (err) {

      setError(err instanceof Error ? err.message : 'Could not reveal recording.')

    } finally {

      setBusyPath('')

    }

  }



  const handleDelete = async (file: RecordingFileInfo) => {

    if (!window.confirm(`Delete "${file.name}" permanently?`)) return

    setBusyPath(file.filePath)

    setError('')

    try {

      await window.electronAPI.deleteRecording(file.filePath)

      setFiles((current) => current.filter((item) => item.filePath !== file.filePath))

    } catch (err) {

      setError(err instanceof Error ? err.message : 'Could not delete recording.')

    } finally {

      setBusyPath('')

    }

  }



  const totalBytes = files.reduce((sum, file) => sum + file.size, 0)
  const normalizedQuery = searchQuery.trim().toLocaleLowerCase()
  const filteredFiles = normalizedQuery
    ? files.filter((file) => file.name.toLocaleLowerCase().includes(normalizedQuery))
    : files



  return (

    <section className="glass-panel rounded-2xl p-5 sm:p-6">

      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">

        <div>

          <h3 className="heading-font text-sm">Recording Path</h3>

        </div>

        <button

          type="button"

          onClick={() => void refresh()}

          disabled={loading}

          className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-[10px] font-semibold text-zinc-300 hover:bg-white/[0.08] disabled:opacity-50"

        >

          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />

          Refresh

        </button>

      </div>



      <form
        className="mb-5 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          searchInputRef.current?.blur()
        }}
      >
        <div className="relative min-w-0 flex-1">
          <input
            ref={searchInputRef}
            type="search"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search videos by filename..."
            aria-label="Search recordings by filename"
            className="glass-field w-full rounded-xl py-3 pl-4 pr-4 text-xs placeholder:text-zinc-500"
          />
        </div>
        <button
          type="submit"
          onClick={() => searchInputRef.current?.focus()}
          title="Search recordings"
          aria-label="Search recordings"
          className="flex shrink-0 items-center justify-center rounded-xl border border-green-400/25 bg-green-500/10 px-4 text-green-300 transition-colors hover:bg-green-500/20"
        >
          <Search size={17} />
        </button>
      </form>

      <div className="mb-5 grid grid-cols-2 gap-3">

        <div className="rounded-xl border border-white/[0.06] bg-black/20 p-4">

          <p className="text-[10px] text-zinc-500">Total recordings</p>

          <p className="mt-2 text-2xl font-bold tabular-nums">{filteredFiles.length}</p>

        </div>

        <div className="rounded-xl border border-white/[0.06] bg-black/20 p-4">

          <p className="text-[10px] text-zinc-500">Total file size</p>

          <p className="mt-2 text-2xl font-bold tabular-nums">{formatFileSize(totalBytes)}</p>

        </div>

      </div>



      {error && (

        <div className="mb-4 rounded-xl border border-red-400/20 bg-red-500/[0.06] p-3 text-[10px] text-red-300">

          {error}

        </div>

      )}



      {loading ? (

        <div className="flex min-h-[180px] items-center justify-center text-xs text-zinc-500">

          <RefreshCw size={16} className="mr-2 animate-spin" /> Loading recordings...

        </div>

      ) : filteredFiles.length === 0 ? (

        <div className="flex min-h-[220px] flex-col items-center justify-center rounded-xl border border-dashed border-white/10 bg-black/10 p-6 text-center">

          <Video size={30} className="text-zinc-600" />

          <p className="mt-3 text-xs font-semibold text-zinc-300">{normalizedQuery ? 'No matching videos found' : 'No recordings found'}</p>

          {normalizedQuery && (
            <p className="mt-2 max-w-xs text-[10px] leading-5 text-zinc-500">
              Try another filename or remove some search terms.
            </p>
          )}

        </div>

      ) : (

        <div className="space-y-2">

          {filteredFiles.map((file) => (

            <article

              key={file.filePath}

              className="flex flex-col gap-3 rounded-xl border border-white/[0.06] bg-black/20 p-4 sm:flex-row sm:items-center"

            >

              <div className="flex min-w-0 flex-1 items-center gap-3">

                <div className="action-icon flex h-10 w-10 shrink-0 items-center justify-center rounded-xl">

                  <Film size={18} />

                </div>

                <div className="min-w-0">

                  <p className="truncate text-xs font-semibold text-zinc-200">{file.name}</p>

                  <p className="mt-1 text-[10px] text-zinc-500">

                    {formatFileSize(file.size)} · {new Date(file.createdAt).toLocaleString()} · {file.format.toUpperCase()}{file.metadata ? ` · ${file.metadata.mode === 'gaming' ? 'GAME' : 'SCREEN'} · ${file.metadata.width && file.metadata.height ? `${file.metadata.width}×${file.metadata.height} · ` : ''}${file.metadata.frameRate} FPS · ${file.metadata.codec.toUpperCase()} · ${(file.metadata.bitrate / 1_000_000).toFixed(1)} Mbps` : ''}

                  </p>

                </div>

              </div>

              <div className="flex items-center gap-2">

                <button

                  type="button"

                  onClick={() => void handleOpen(file)}

                  disabled={busyPath === file.filePath}

                  title="Play recording"

                  className="rounded-lg border border-red-400/20 bg-red-500/10 p-2.5 text-red-300 hover:bg-red-500/20 disabled:opacity-40"

                >

                  <CirclePlay size={15} />

                </button>

                <button

                  type="button"

                  onClick={() => void handleReveal(file)}

                  disabled={busyPath === file.filePath}

                  title="Show in folder"

                  className="rounded-lg border border-white/10 bg-white/[0.04] p-2.5 text-zinc-300 hover:bg-white/[0.08] disabled:opacity-40"

                >

                  <ExternalLink size={15} />

                </button>

                <button

                  type="button"

                  onClick={() => void handleDelete(file)}

                  disabled={busyPath === file.filePath}

                  title="Delete recording"

                  className="rounded-lg border border-red-400/15 bg-red-500/[0.06] p-2.5 text-red-300 hover:bg-red-500/15 disabled:opacity-40"

                >

                  <Trash2 size={15} />

                </button>

              </div>

            </article>

          ))}

        </div>

      )}

    </section>

  )

}



function App() {

  const [activePage, setActivePage] = useState<Page>('Screen Capture')

  const [isMaximized, setIsMaximized] = useState(false)

  const [navigationError, setNavigationError] = useState('')

  const [recordingState, setRecordingState] =

    useState<RecorderState>('idle')



  const recordingIsActive =

    recordingState === 'recording' ||

    recordingState === 'paused' ||

    recordingState === 'stopping'



  const navigation = [

    { label: 'Screen Capture' as Page, icon: Monitor },

    { label: 'Game Capture' as Page, icon: Gamepad2 },

    { label: 'My Recordings' as Page, icon: FolderOpen },

  ]



  const navigateTo = (page: Page) => {

    if (recordingIsActive && page !== activePage) {

      setNavigationError(

        'Stop the active recording before navigating to another page.',

      )

      return

    }



    setNavigationError('')

    setActivePage(page)

  }



  const handleRecordingStateChange = (state: RecorderState) => {

    setRecordingState(state)

    // Taskbar icon: green dot while recording, yellow while paused, none otherwise.
    void window.electronAPI.setRecordingOverlay(state).catch(() => undefined)



    if (state === 'idle' || state === 'error') {

      setNavigationError('')

    }

  }



  // Keep the maximized state in sync with the real window (maximize button,
  // double-click, Windows shortcuts and the restored state at startup).
  useEffect(() => {
    let mounted = true

    void window.electronAPI.isMaximized().then((value) => {
      if (mounted) setIsMaximized(value)
    }).catch(() => undefined)

    const unsubscribe = window.electronAPI.onMaximizedChange((value) => {
      setIsMaximized(value)
    })

    // Visual safety net: a window that fills the work area is drawn square,
    // even if the native maximize event arrives late or not at all.
    const syncWithWindowSize = () => {
      setIsMaximized(
        window.outerWidth >= window.screen.availWidth - 1 &&
          window.outerHeight >= window.screen.availHeight - 1,
      )
    }

    window.addEventListener('resize', syncWithWindowSize)

    return () => {
      mounted = false
      unsubscribe()
      window.removeEventListener('resize', syncWithWindowSize)
    }
  }, [])

  const handleMaximize = async () => {

    const result = await window.electronAPI.toggleMaximize()

    setIsMaximized(result)

  }



  return (

    <div className={`app-shell flex h-screen w-full overflow-hidden text-white ${isMaximized ? 'is-maximized rounded-none' : 'rounded-[22px]'}`}>

      <aside className="sidebar flex w-[92px] shrink-0 flex-col items-center overflow-hidden">

        <div className="brand-area flex shrink-0 items-center justify-center">

          <img src={appIconData} alt="SUPER RECORD" draggable={false} className="brand-icon" />

        </div>

        <div className="sidebar-content flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-3 pt-5">

          <nav className="flex flex-col items-center gap-3">

            {navigation.map(({ label, icon: Icon }) => (

              <button
                key={label}
                type="button"
                aria-label={label}
                onClick={() => navigateTo(label)}
                disabled={recordingIsActive && label !== activePage}
                className={`nav-item transition-all ${
                  activePage === label ? 'nav-active' : ''
                } ${
                  recordingIsActive && label !== activePage
                    ? 'cursor-not-allowed opacity-40'
                    : ''
                }`}
              >
                <Icon size={23} strokeWidth={1.8} />
              </button>

            ))}

            <button
              type="button"
              aria-label="Settings"
              onClick={() => navigateTo('Settings')}
              disabled={recordingIsActive}
              className={`nav-item transition-all ${
                activePage === 'Settings' ? 'nav-active' : ''
              } ${recordingIsActive ? 'cursor-not-allowed opacity-40' : ''}`}
            >
              <Settings size={23} strokeWidth={1.8} />
            </button>

          </nav>

        </div>

        <div className="sidebar-divider shrink-0" />

        <div className="flex shrink-0 justify-center pb-4 pt-1">

          <a
            href="https://t.me/DRwander84"
            target="_blank"
            rel="noopener noreferrer"
            className="about-link text-[15px] font-semibold tracking-wide"
          >
            About
          </a>

        </div>
      </aside>



      <main className="main-area flex min-w-0 flex-1 flex-col overflow-hidden">

        <header className="titlebar flex h-[68px] shrink-0 items-center justify-between px-5">

          <div className="flex min-w-0 items-center gap-2">

            <span
              className="h-2 w-2 rounded-full transition-colors duration-300"
              style={{
                backgroundColor:
                  recordingState === 'recording'
                    ? '#22c55e'
                    : recordingState === 'paused'
                      ? '#facc15'
                      : '#ef4444',
                boxShadow: `0 0 10px ${
                  recordingState === 'recording'
                    ? '#22c55e'
                    : recordingState === 'paused'
                      ? '#facc15'
                      : '#ff3030'
                }`,
              }}
            />

            <span className="truncate text-[9px] font-bold tracking-[0.18em] text-zinc-400">

              SUPER RECORD

            </span>

          </div>

          <div className="window-controls flex items-center">

            <button

              type="button"

              onClick={() => void window.electronAPI.minimize()}

              className="window-control"

              title="Minimize"

            >

              <Minus size={14} strokeWidth={1.8} />

            </button>

            <button

              type="button"

              onClick={() => void handleMaximize()}

              className="window-control"

              title={isMaximized ? 'Restore' : 'Maximize'}

            >

              {isMaximized ? <Copy size={12} /> : <Square size={12} />}

            </button>

            <button

              type="button"

              onClick={() => void window.electronAPI.close()}

              disabled={recordingIsActive}

              className="window-control window-close disabled:cursor-not-allowed disabled:opacity-30"

              title="Close"

            >

              <X size={15} />

            </button>

          </div>

        </header>



        <div className="main-scroll min-h-0 flex-1 overflow-y-auto">

          <div className="mx-auto w-full max-w-[1200px] p-5 sm:p-6">

            <header className="mb-7 flex items-center justify-between gap-3">

              <div className="min-w-0">


                <h2 className="truncate text-xl font-bold sm:text-2xl">

                  {activePage}

                </h2>

              </div>



            </header>



            {navigationError && (

              <div className="mb-4 flex items-start gap-2 rounded-xl border border-amber-400/20 bg-amber-400/[0.06] p-3 text-[10px] leading-5 text-amber-200">

                <Info size={14} className="mt-0.5 shrink-0" />

                {navigationError}

              </div>

            )}



            <section key={activePage}>
              {activePage === 'Screen Capture' ? (
                <ScreenRecordPage
                  onRecordingStateChange={handleRecordingStateChange}
                  isRecording={recordingIsActive}
                />
              ) : activePage === 'Game Capture' ? (
                <GamingModePage
                  onRecordingStateChange={handleRecordingStateChange}
                  isRecording={recordingIsActive}
                />
              ) : activePage === 'Settings' ? (
                <SettingsPage />
              ) : (
                <MyRecordingsPage />
              )}
            </section>


          </div>

        </div>

      </main>

    </div>

  )

}



export default App
