
import { app } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import { DEFAULT_SHORTCUTS, normalizeShortcuts, type ShortcutMap } from '../src/shared/shortcutDefaults'

export type AppSettings = {
  outputDirectory: string
  screenRecord: Record<string, unknown>
  gamingMode: Record<string, unknown>
  shortcuts: ShortcutMap
  [key: string]: unknown
}

const getDefaultOutputDirectory = () =>
  path.join(app.getPath('videos'), 'SUPER RECORD')

const getSettingsFile = () =>
  path.join(app.getPath('userData'), 'settings.json')

let saveQueue: Promise<void> = Promise.resolve()
let temporaryFileCounter = 0

export function createDefaultSettings(): AppSettings {
  return {
    outputDirectory: getDefaultOutputDirectory(),
    screenRecord: {},
    gamingMode: {},
    shortcuts: { ...DEFAULT_SHORTCUTS },
  }
}

function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value)
  ) {
    return false
  }

  const prototype = Object.getPrototypeOf(value)

  return (
    prototype === Object.prototype ||
    prototype === null
  )
}

function getValidObject(
  value: unknown,
): Record<string, unknown> {
  return isPlainObject(value) ? value : {}
}

async function ensureOutputDirectory(
  directory: string,
): Promise<string> {
  try {
    await fs.mkdir(directory, { recursive: true })

    const stats = await fs.stat(directory)

    if (!stats.isDirectory()) {
      throw new Error('Output path is not a directory.')
    }

    return directory
  } catch {
    const fallback = getDefaultOutputDirectory()

    await fs.mkdir(fallback, { recursive: true })

    return fallback
  }
}

function normalizeSettings(
  saved: unknown,
  defaults: AppSettings,
): AppSettings {
  if (!isPlainObject(saved)) {
    return defaults
  }

  const data = saved

  return {
    ...defaults,
    ...data,

    outputDirectory:
      typeof data.outputDirectory === 'string' &&
      data.outputDirectory.trim().length > 0
        ? data.outputDirectory
        : defaults.outputDirectory,

    screenRecord: getValidObject(data.screenRecord),

    gamingMode: getValidObject(data.gamingMode),

    shortcuts: normalizeShortcuts(data.shortcuts),
  }
}

export async function getAppSettings(): Promise<AppSettings> {
  const defaults = createDefaultSettings()

  try {
    const content = await fs.readFile(
      getSettingsFile(),
      'utf-8',
    )

    const saved: unknown = JSON.parse(content)

    const normalized = normalizeSettings(
      saved,
      defaults,
    )

    const outputDirectory = await ensureOutputDirectory(
      normalized.outputDirectory,
    )

    return {
      ...normalized,
      outputDirectory,
    }
  } catch {
    await ensureOutputDirectory(defaults.outputDirectory)

    return defaults
  }
}

async function writeSettingsFile(
  settings: AppSettings,
): Promise<void> {
  const file = getSettingsFile()
  const directory = path.dirname(file)

  const temporaryFile = path.join(
    directory,
    `settings.${process.pid}.${++temporaryFileCounter}.tmp`,
  )

  const safeSettings: AppSettings = {
    ...settings,
    outputDirectory: await ensureOutputDirectory(
      settings.outputDirectory,
    ),
    screenRecord: getValidObject(settings.screenRecord),
    gamingMode: getValidObject(settings.gamingMode),
    shortcuts: normalizeShortcuts(settings.shortcuts),
  }

  try {
    await fs.mkdir(directory, { recursive: true })

    await fs.writeFile(
      temporaryFile,
      JSON.stringify(safeSettings, null, 2),
      'utf-8',
    )

    await fs.rename(temporaryFile, file)
  } catch (error) {
    await fs.rm(temporaryFile, { force: true }).catch(() => {
      // Preserve the original error.
    })

    throw error
  }
}

export function saveAppSettings(
  settings: AppSettings,
): Promise<void> {
  const operation = saveQueue.then(() =>
    writeSettingsFile(settings),
  )

  // A failed save must not block subsequent save operations.
  saveQueue = operation.catch(() => undefined)

  return operation
}
