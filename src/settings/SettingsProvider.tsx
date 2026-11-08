import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { DEFAULT_SHORTCUTS, normalizeShortcuts, type ShortcutMap } from '../shared/shortcutDefaults'

export type SettingsData = {
  outputDirectory: string
  screenRecord: Record<string, unknown>
  gamingMode: Record<string, unknown>
  shortcuts: ShortcutMap
  [key: string]: unknown
}

type SettingsContextValue = {
  settings: SettingsData
  isLoading: boolean
  isSaving: boolean
  error: string | null
  updateSettings: (updates: Partial<SettingsData>) => void
  updateScreenRecord: (updates: Record<string, unknown>) => void
  updateGamingMode: (updates: Record<string, unknown>) => void
  replaceScreenRecord: (settings: Record<string, unknown>) => void
  replaceGamingMode: (settings: Record<string, unknown>) => void
  reloadSettings: () => Promise<void>
  saveSettingsNow: () => Promise<void>
}

const SettingsContext = createContext<SettingsContextValue | null>(null)

const defaultSettings: SettingsData = {
  outputDirectory: '',
  screenRecord: {},
  gamingMode: {},
  shortcuts: { ...DEFAULT_SHORTCUTS },
}

const SAVE_DEBOUNCE_MS = 300

function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  )
}

function normalizeSettings(value: unknown): SettingsData {
  if (!isPlainObject(value)) {
    return structuredClone(defaultSettings)
  }

  return {
    ...defaultSettings,
    ...value,

    screenRecord: isPlainObject(value.screenRecord)
      ? value.screenRecord
      : {},

    gamingMode: isPlainObject(value.gamingMode)
      ? value.gamingMode
      : {},

    shortcuts: normalizeShortcuts(value.shortcuts),
  }
}

export function SettingsProvider({
  children,
}: {
  children: ReactNode
}) {
  const [settings, setSettings] = useState<SettingsData>(
    structuredClone(defaultSettings),
  )

  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const settingsRef = useRef<SettingsData>(
    structuredClone(defaultSettings),
  )

  const initializedRef = useRef(false)
  const mountedRef = useRef(false)

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  )

  const loadPromiseRef = useRef<Promise<void> | null>(null)

  const saveQueueRef = useRef<Promise<void>>(Promise.resolve())

  const pendingSaveCountRef = useRef(0)

  const updateLocalSettings = useCallback(
    (nextSettings: SettingsData) => {
      settingsRef.current = nextSettings
      setSettings(nextSettings)
      setError(null)
    },
    [],
  )

  const persistSnapshot = useCallback(
    (snapshot: SettingsData): Promise<void> => {
      pendingSaveCountRef.current += 1

      if (mountedRef.current) {
        setIsSaving(true)
      }

      const saveTask = saveQueueRef.current
        .catch(() => undefined)
        .then(async () => {
          await window.electronAPI.saveSettings(snapshot)
        })

      saveQueueRef.current = saveTask

      void saveTask
        .then(() => {
          if (mountedRef.current) {
            setError(null)
          }
        })
        .catch((err: unknown) => {
          const message =
            err instanceof Error
              ? err.message
              : 'Could not save application settings.'

          if (mountedRef.current) {
            setError(message)
          }
        })
        .finally(() => {
          pendingSaveCountRef.current = Math.max(
            0,
            pendingSaveCountRef.current - 1,
          )

          if (
            mountedRef.current &&
            pendingSaveCountRef.current === 0
          ) {
            setIsSaving(false)
          }
        })

      return saveTask
    },
    [],
  )

  const saveSettingsNow = useCallback(async () => {
    if (!initializedRef.current) return

    if (saveTimerRef.current !== null) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }

    const snapshot = structuredClone(settingsRef.current)

    await persistSnapshot(snapshot)
  }, [persistSnapshot])

  const scheduleSave = useCallback(() => {
    if (!initializedRef.current) return

    if (saveTimerRef.current !== null) {
      clearTimeout(saveTimerRef.current)
    }

    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null

      const snapshot = structuredClone(settingsRef.current)

      void persistSnapshot(snapshot)
    }, SAVE_DEBOUNCE_MS)
  }, [persistSnapshot])

  const updateSettings = useCallback(
    (updates: Partial<SettingsData>) => {
      const nextSettings: SettingsData = {
        ...settingsRef.current,
        ...updates,
      }

      updateLocalSettings(nextSettings)
      scheduleSave()
    },
    [scheduleSave, updateLocalSettings],
  )

  const updateScreenRecord = useCallback(
    (updates: Record<string, unknown>) => {
      const nextSettings: SettingsData = {
        ...settingsRef.current,
        screenRecord: {
          ...settingsRef.current.screenRecord,
          ...updates,
        },
      }

      updateLocalSettings(nextSettings)
      scheduleSave()
    },
    [scheduleSave, updateLocalSettings],
  )

  const updateGamingMode = useCallback(
    (updates: Record<string, unknown>) => {
      const nextSettings: SettingsData = {
        ...settingsRef.current,
        gamingMode: {
          ...settingsRef.current.gamingMode,
          ...updates,
        },
      }

      updateLocalSettings(nextSettings)
      scheduleSave()
    },
    [scheduleSave, updateLocalSettings],
  )

  const replaceScreenRecord = useCallback(
    (screenRecord: Record<string, unknown>) => {
      const nextSettings: SettingsData = {
        ...settingsRef.current,
        screenRecord: { ...screenRecord },
      }
      updateLocalSettings(nextSettings)
      scheduleSave()
    },
    [scheduleSave, updateLocalSettings],
  )

  const replaceGamingMode = useCallback(
    (gamingMode: Record<string, unknown>) => {
      const nextSettings: SettingsData = {
        ...settingsRef.current,
        gamingMode: { ...gamingMode },
      }
      updateLocalSettings(nextSettings)
      scheduleSave()
    },
    [scheduleSave, updateLocalSettings],
  )

  const reloadSettings = useCallback(async () => {
    if (loadPromiseRef.current) {
      return loadPromiseRef.current
    }

    const loadTask = (async () => {
      setIsLoading(true)
      setError(null)

      try {
        const storedSettings =
          await window.electronAPI.getSettings()

        const normalizedSettings =
          normalizeSettings(storedSettings)

        updateLocalSettings(normalizedSettings)
        initializedRef.current = true
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : 'Could not load application settings.'

        setError(message)
        throw err
      } finally {
        if (mountedRef.current) {
          setIsLoading(false)
        }

        loadPromiseRef.current = null
      }
    })()

    loadPromiseRef.current = loadTask

    return loadTask
  }, [updateLocalSettings])

  useEffect(() => {
    mountedRef.current = true

    if (!initializedRef.current) {
      void reloadSettings().catch(() => undefined)
    } else {
      setIsLoading(false)
    }

    return () => {
      mountedRef.current = false

      if (saveTimerRef.current !== null) {
        clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
    }
  }, [reloadSettings])

  const contextValue = useMemo<SettingsContextValue>(
    () => ({
      settings,
      isLoading,
      isSaving,
      error,
      updateSettings,
      updateScreenRecord,
      updateGamingMode,
      replaceScreenRecord,
      replaceGamingMode,
      reloadSettings,
      saveSettingsNow,
    }),
    [
      settings,
      isLoading,
      isSaving,
      error,
      updateSettings,
      updateScreenRecord,
      updateGamingMode,
      replaceScreenRecord,
      replaceGamingMode,
      reloadSettings,
      saveSettingsNow,
    ],
  )

  return (
    <SettingsContext.Provider value={contextValue}>
      {children}
    </SettingsContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function useSettings(): SettingsContextValue {
  const context = useContext(SettingsContext)

  if (context === null) {
    throw new Error(
      'useSettings must be used inside SettingsProvider.',
    )
  }

  return context
}