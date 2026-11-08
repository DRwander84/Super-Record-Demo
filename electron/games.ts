import { app, desktopCapturer, nativeImage, screen, type DesktopCapturerSource } from 'electron'
import { execFile } from 'node:child_process'
import path from 'node:path'

export type DetectedGame = {
  /** Stable id of the program's window (game:<window handle>). */
  id: string
  name: string
  exeName: string
  pid: number
  icon: string
  /** True when the program was recognized as a game. */
  isGame: boolean
}

export type GameScanResult = {
  games: DetectedGame[]
  /** Set when the scan itself failed, so the UI can say why nothing was found. */
  error?: string
}

type WindowInfo = {
  hwnd: number
  pid: number
  left: number
  top: number
  right: number
  bottom: number
  path: string
  title: string
  minimized: boolean
  modules: Set<string>
  modulesReadable: boolean
}

const IS_WINDOWS = process.platform === 'win32'
const POWERSHELL_TIMEOUT_MS = 30_000

// Typical install locations of game stores and launchers.
const GAME_PATH_PATTERN =
  /[\\/](steamapps|steamlibrary|epic games|gog galaxy[\\/]games|gog games|riot games|battle\.net|blizzard|ubisoft game launcher[\\/]games|origin games|ea games|ea app|xboxgames|rockstar games|wargaming|hoyoverse|amazon games|itch|games|\.minecraft)[\\/]/i

// Launchers, stores, browsers, chat, media and developer tools are never games.
const NOT_GAMES = new Set([
  'steam', 'steamwebhelper', 'epicgameslauncher', 'epicwebhelper', 'galaxyclient', 'battle.net',
  'riotclientservices', 'riotclientux', 'eadesktop', 'origin', 'ubisoftconnect', 'upc',
  'rockstarlauncher', 'launcher', 'chrome', 'msedge', 'firefox', 'opera', 'brave', 'vivaldi',
  'iexplore', 'discord', 'telegram', 'whatsapp', 'slack', 'teams', 'spotify', 'obs64', 'obs32',
  'obs', 'streamlabs obs', 'vlc', 'mpc-hc64', 'mpc-be64', 'potplayer64', 'code', 'devenv',
  'explorer', 'applicationframehost', 'systemsettings', 'searchhost', 'startmenuexperiencehost',
  'textinputhost', 'shellexperiencehost', 'winword', 'excel', 'powerpnt', 'outlook', 'onenote',
  'notepad', 'taskmgr', 'mmc', 'powershell', 'cmd', 'windowsterminal', 'wt', 'electron',
  'photoshop', 'illustrator', 'premiere pro', 'blender', 'unity', 'unrealeditor', 'godot',
  'msiafterburner', 'rtss', 'nvidia share', 'nvcontainer', 'super record',
  'calculatorapp', 'microsoft.photos', 'video.ui', 'snippingtool', 'mspaint', 'widgets', 'zoom',
  'skype', 'anydesk', 'teamviewer', 'figma', 'notion', 'postman', 'docker desktop', 'filezilla',
  '7zfm', 'winrar', 'sumatrapdf', 'acrobat', 'acrord32', 'foxitreader', 'lightroom', 'davinciresolve',
  'resolve', 'vegas', 'audacity', 'fl64', 'ableton live', 'wallpaper32', 'wallpaper64', 'rainmeter',
  'nvidia app', 'nvidia overlay', 'radeonsoftware', 'amdow', 'gamebar', 'gamebarftserver', 'xboxpcapp',
  'xbox', 'gamingservices', 'medal', 'overwolf', 'ds4windows', 'icue', 'lghub', 'razer synapse',
])

// Modules whose presence says something about what kind of program this is.
const STRONG_GFX = ['d3d11.dll', 'd3d12.dll', 'vulkan-1.dll']
const WEAK_GFX = ['d3d9.dll', 'd3d10.dll', 'd3d10_1.dll', 'd3d8.dll', 'opengl32.dll', 'ddraw.dll']
const GAME_LIBS = [
  'steam_api.dll', 'steam_api64.dll', 'unityplayer.dll', 'gameassembly.dll', 'xinput1_3.dll',
  'xinput1_4.dll', 'xinput9_1_0.dll', 'dinput8.dll', 'dinput.dll', 'openvr_api.dll',
  'eossdk-win64-shipping.dll', 'eossdk-win32-shipping.dll', 'galaxy64.dll', 'galaxy.dll',
  'lwjgl.dll', 'lwjgl64.dll', 'glfw.dll', 'glfw3.dll', 'fmod.dll', 'fmod64.dll', 'fmodstudio.dll', 'fmodstudio64.dll', 'openal32.dll', 'physx3_x64.dll',
  'amd_ags_x64.dll', 'nvapi64.dll', 'nvngx_dlss.dll', 'sl.interposer.dll',
]
const WEB_LIBS = ['chrome_elf.dll', 'libcef.dll', 'cef_sandbox.dll', 'qt5webenginecore.dll', 'qt6webenginecore.dll']
const DESKTOP_UI_LIBS = [
  'presentationcore.ni.dll', 'presentationcore.dll', 'wpfgfx_cor3.dll', 'wpfgfx_v0400.dll',
  'system.windows.forms.ni.dll', 'qt5core.dll', 'qt6core.dll', 'gtk-3-0.dll',
]
const WATCHED = [...STRONG_GFX, ...WEAK_GFX, ...GAME_LIBS, ...WEB_LIBS, ...DESKTOP_UI_LIBS]

// The scanner is compiled by PowerShell on the fly. It lists real top-level
// windows with their owning process, image path (also for protected games) and
// loaded modules (read with LIST_MODULES_ALL so 32-bit games work too).
const CSHARP = `
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class SRScan {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int v, int size);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr h, uint flags, StringBuilder s, ref uint n);
  [DllImport("psapi.dll", SetLastError = true)] static extern bool EnumProcessModulesEx(IntPtr h, IntPtr[] mods, uint cb, out uint needed, uint filter);
  [DllImport("psapi.dll", CharSet = CharSet.Unicode)] static extern uint GetModuleBaseName(IntPtr h, IntPtr mod, StringBuilder s, uint n);

  static string Clean(string v) {
    return v.Replace((char)9, ' ').Replace((char)10, ' ').Replace((char)13, ' ');
  }

  static string ImagePath(uint pid) {
    IntPtr h = OpenProcess(0x1000, false, pid);
    if (h == IntPtr.Zero) return "";
    try {
      StringBuilder sb = new StringBuilder(1024);
      uint n = 1024;
      return QueryFullProcessImageName(h, 0, sb, ref n) ? sb.ToString() : "";
    } finally { CloseHandle(h); }
  }

  static bool Modules(uint pid, HashSet<string> watched, List<string> found) {
    IntPtr h = OpenProcess(0x0410, false, pid);
    if (h == IntPtr.Zero) return false;
    try {
      IntPtr[] mods = new IntPtr[1024];
      uint needed;
      if (!EnumProcessModulesEx(h, mods, (uint)(mods.Length * IntPtr.Size), out needed, 3)) return false;
      int count = (int)(needed / (uint)IntPtr.Size);
      if (count > mods.Length) {
        mods = new IntPtr[count];
        if (!EnumProcessModulesEx(h, mods, (uint)(mods.Length * IntPtr.Size), out needed, 3)) return false;
      }
      StringBuilder sb = new StringBuilder(260);
      for (int i = 0; i < count && i < mods.Length; i++) {
        sb.Length = 0;
        if (GetModuleBaseName(h, mods[i], sb, 260) == 0) continue;
        string name = sb.ToString().ToLowerInvariant();
        if (watched.Contains(name) && !found.Contains(name)) found.Add(name);
      }
      return count > 0;
    } finally { CloseHandle(h); }
  }

  public static List<string> Scan(string[] watchedList) {
    HashSet<string> watched = new HashSet<string>(watchedList);
    List<string> lines = new List<string>();
    Dictionary<uint, string> paths = new Dictionary<uint, string>();
    Dictionary<uint, string> mods = new Dictionary<uint, string>();
    uint self = (uint)System.Diagnostics.Process.GetCurrentProcess().Id;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      if ((GetWindowLong(h, -20) & 0x80) != 0) return true;
      int cloaked;
      if (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
      RECT r;
      if (!GetWindowRect(h, out r)) return true;
      bool minimized = IsIconic(h);
      if (!minimized && (r.Right - r.Left < 320 || r.Bottom - r.Top < 200)) return true;
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      if (pid == 0 || pid == self) return true;
      string path;
      if (!paths.TryGetValue(pid, out path)) { path = ImagePath(pid); paths[pid] = path; }
      if (path.Length == 0) return true;
      string m;
      if (!mods.TryGetValue(pid, out m)) {
        List<string> found = new List<string>();
        bool ok = Modules(pid, watched, found);
        m = (ok ? "1" : "0") + "|" + string.Join(",", found.ToArray());
        mods[pid] = m;
      }
      StringBuilder t = new StringBuilder(512);
      GetWindowText(h, t, 512);
      lines.Add(string.Join(((char)9).ToString(), new string[] {
        "W", h.ToInt64().ToString(), pid.ToString(), r.Left.ToString(), r.Top.ToString(),
        r.Right.ToString(), r.Bottom.ToString(), minimized ? "1" : "0", m, Clean(path), Clean(t.ToString())
      }));
      return true;
    }, IntPtr.Zero);
    return lines;
  }
}
`

function runPowerShell(script: string): Promise<string> {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: POWERSHELL_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) reject(new Error(String(stderr || error.message).trim().split(/\r?\n/)[0] || error.message))
        else resolve(stdout)
      },
    )
  })
}

type ScanData = {
  windows: WindowInfo[]
  gpu: Map<number, number>
  recognized: Set<string>
  preferred: Set<string>
}

async function scanSystem(): Promise<ScanData> {
  const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
${CSHARP}
'@
$watched = [string[]]@(${WATCHED.map((item) => `'${item}'`).join(',')})
[SRScan]::Scan($watched) | ForEach-Object { Write-Output $_ }
$tab = [char]9
try {
  $gpu = @{}
  $samples = (Get-Counter '\\GPU Engine(*engtype_3D)\\Utilization Percentage' -ErrorAction Stop).CounterSamples
  foreach ($sample in $samples) {
    if ($sample.InstanceName -match 'pid_(\\d+)_') {
      $id = [int]$Matches[1]
      if (-not $gpu.ContainsKey($id)) { $gpu[$id] = 0 }
      $gpu[$id] += $sample.CookedValue
    }
  }
  foreach ($key in $gpu.Keys) { Write-Output ('GPU' + $tab + $key + $tab + [math]::Round($gpu[$key], 1)) }
} catch {}
try {
  Get-ChildItem 'HKCU:\\System\\GameConfigStore\\Children' -ErrorAction Stop | ForEach-Object {
    $value = (Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue).MatchedExeFullPath
    if ($value) { Write-Output ('GCS' + $tab + $value) }
  }
} catch {}
try {
  $key = Get-Item 'HKCU:\\Software\\Microsoft\\DirectX\\UserGpuPreferences' -ErrorAction Stop
  foreach ($name in $key.GetValueNames()) { if ($name) { Write-Output ('PREF' + $tab + $name) } }
} catch {}
`
  const output = await runPowerShell(script)
  const data: ScanData = { windows: [], gpu: new Map(), recognized: new Set(), preferred: new Set() }
  for (const line of output.split(/\r?\n/)) {
    const parts = line.split('\t')
    if (parts[0] === 'GPU' && parts.length >= 3) {
      data.gpu.set(Number(parts[1]), Number(parts[2]))
    } else if (parts[0] === 'GCS' && parts[1]) {
      data.recognized.add(parts[1].toLowerCase())
    } else if (parts[0] === 'PREF' && parts[1]) {
      data.preferred.add(parts[1].toLowerCase())
    } else if (parts[0] === 'W' && parts.length >= 11) {
      const [, hwnd, pid, left, top, right, bottom, minimized, mods, exePath] = parts
      const separator = mods.indexOf('|')
      data.windows.push({
        hwnd: Number(hwnd),
        pid: Number(pid),
        left: Number(left),
        top: Number(top),
        right: Number(right),
        bottom: Number(bottom),
        minimized: minimized === '1',
        modulesReadable: mods.slice(0, separator) === '1',
        modules: new Set(mods.slice(separator + 1).split(',').filter(Boolean)),
        path: exePath,
        title: parts.slice(10).join(' ').trim(),
      })
    }
  }
  return data
}

const iconCache = new Map<string, string>()

async function getIcon(exePath: string): Promise<string> {
  const cached = iconCache.get(exePath)
  if (cached !== undefined) return cached
  let icon = ''
  try {
    icon = (await app.getFileIcon(exePath, { size: 'large' })).toDataURL()
  } catch {
    icon = ''
  }
  iconCache.set(exePath, icon)
  return icon
}

const hasAny = (modules: Set<string>, list: string[]) => list.some((item) => modules.has(item))

/** True when the window covers (almost) a whole monitor. */
function coversMonitor(windowInfo: WindowInfo): boolean {
  try {
    const dip = screen.screenToDipRect(null, {
      x: windowInfo.left,
      y: windowInfo.top,
      width: windowInfo.right - windowInfo.left,
      height: windowInfo.bottom - windowInfo.top,
    })
    const display = screen.getDisplayMatching(dip)
    return dip.width >= display.bounds.width - 4 && dip.height >= display.bounds.height - 4
  } catch {
    return false
  }
}

function isSystemOrSelf(windowInfo: WindowInfo): boolean {
  const lowerPath = windowInfo.path.toLowerCase()
  const windowsDir = (process.env.SystemRoot || 'C:\\Windows').toLowerCase()
  return lowerPath.startsWith(windowsDir) || lowerPath === process.execPath.toLowerCase()
}

/**
 * Scores how likely a program is a game from several independent signals:
 * install location, Windows' own game recognition, Direct3D/Vulkan use, game
 * libraries, full-screen windows and real 3D GPU load. One weak hint is never
 * enough, so normal desktop applications are not listed as games.
 */
function isGame(windowInfo: WindowInfo, data: ScanData): boolean {
  const exeName = path.parse(windowInfo.path).name.toLowerCase()
  if (NOT_GAMES.has(exeName)) return false

  const lowerPath = windowInfo.path.toLowerCase()
  const inLibrary = GAME_PATH_PATTERN.test(windowInfo.path)
  const recognized = data.recognized.has(lowerPath)
  const preferred = data.preferred.has(lowerPath)
  const modules = windowInfo.modules
  const gpu = data.gpu.get(windowInfo.pid) ?? 0

  if (!inLibrary && !recognized && (hasAny(modules, WEB_LIBS) || hasAny(modules, DESKTOP_UI_LIBS))) return false

  const fullscreen = coversMonitor(windowInfo)
  const gameLibs = hasAny(modules, GAME_LIBS)
  const strongGfx = hasAny(modules, STRONG_GFX)
  const weakGfx = hasAny(modules, WEAK_GFX)
  // Protected games refuse module access; heavy 3D load on such a process is
  // a strong sign of a game with an anti-cheat driver.
  const protectedGame = !windowInfo.modulesReadable && gpu >= 5

  let score = 0
  if (inLibrary) score += 3
  if (recognized) score += 3
  if (preferred) score += 1
  if (gameLibs) score += 2
  if (strongGfx) score += 2
  else if (weakGfx) score += 1
  if (fullscreen) score += 2
  if (gpu >= 3) score += 2
  if (gpu >= 25) score += 1
  if (protectedGame) score += 3

  const gameSpecific = inLibrary || recognized || gameLibs || fullscreen || protectedGame || (strongGfx && gpu >= 10)
  return score >= 4 && gameSpecific
}

/** Windows seen by the latest scan, so a capture source can be resolved later. */
const knownWindows = new Map<number, WindowInfo>()

const gameIdOf = (hwnd: number) => `game:${hwnd}`

export function hwndFromGameId(id: string): number | null {
  const match = /^game:(\d+)$/.exec(id)
  return match ? Number(match[1]) : null
}

function displayOf(rect: { left: number; top: number; right: number; bottom: number }) {
  const dip = screen.screenToDipRect(null, {
    x: rect.left,
    y: rect.top,
    width: Math.max(1, rect.right - rect.left),
    height: Math.max(1, rect.bottom - rect.top),
  })
  return { dip, display: screen.getDisplayMatching(dip) }
}

function screenSourceFor(
  sources: DesktopCapturerSource[],
  display: Electron.Display,
): DesktopCapturerSource | null {
  const screens = sources.filter((item) => item.id.startsWith('screen:'))
  const byDisplay = screens.find((item) => item.display_id === String(display.id))
  if (byDisplay) return byDisplay
  // Some systems report no display id: fall back to the display's position.
  const index = screen.getAllDisplays().findIndex((item) => item.id === display.id)
  return screens[index] ?? screens[0] ?? null
}

/** Window handle inside a Chromium capture id (window:<handle>:<n>). */
const windowHandleOf = (sourceId: string): string | null => /^window:(\d+)(?::|$)/.exec(sourceId)?.[1] ?? null

/**
 * Chooses what Chromium captures for a game. The picture is always the game's
 * own window; the monitor is used only for a program that really fills a whole
 * monitor and is not offered as a window (exclusive full screen). A windowed
 * game is never replaced by the desktop: if Windows does not list its window,
 * Chromium is asked to open that window handle directly.
 */
export function pickCaptureSource(
  gameId: string,
  sources: DesktopCapturerSource[],
): DesktopCapturerSource | null {
  const hwnd = hwndFromGameId(gameId)
  if (hwnd === null) return null
  const windows = sources.filter((item) => item.id.startsWith('window:'))

  // 1. The game's own window, matched by its handle whatever the id suffix is.
  const byHandle = windows.find((item) => windowHandleOf(item.id) === String(hwnd))
  if (byHandle) return byHandle

  const known = knownWindows.get(hwnd)

  // 2. The same window listed under its exact title (only when unambiguous).
  if (known?.title) {
    const sameTitle = windows.filter((item) => item.name === known.title)
    if (sameTitle.length === 1) return sameTitle[0]
  }

  // 3. A game in exclusive full screen has no capturable window: use its monitor.
  if (known && !known.minimized && coversMonitor(known)) {
    try {
      const fromMonitor = screenSourceFor(sources, displayOf(known).display)
      if (fromMonitor) return fromMonitor
    } catch {
      // Falls through to the direct window request.
    }
  }

  // 4. Ask Chromium for the window handle directly, so the game is still
  // captured when the window list left it out.
  if (known) {
    return {
      id: `window:${hwnd}:0`,
      name: known.title || known.path,
      thumbnail: nativeImage.createEmpty(),
      display_id: '',
      appIcon: null,
    } as unknown as DesktopCapturerSource
  }
  return null
}

export type GameTarget = {
  /** The game covers a whole monitor (full screen or borderless). */
  fullscreen: boolean
  /** desktopCapturer screen id of that monitor. */
  monitorSourceId: string | null
}

const RECT_SCRIPT = (hwnd: number) => `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SRRect {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
}
'@
$h = [IntPtr]${hwnd}
if ([SRRect]::IsWindow($h)) {
  $r = New-Object SRRect+RECT
  [void][SRRect]::GetWindowRect($h, [ref]$r)
  Write-Output ($r.Left.ToString() + ',' + $r.Top + ',' + $r.Right + ',' + $r.Bottom + ',' + [SRRect]::IsIconic($h))
}
`

/**
 * Looks at the game window right now (it may have switched to full screen
 * since the list was built) and reports whether a whole monitor can be
 * recorded natively.
 */
export async function resolveGameTarget(gameId: string): Promise<GameTarget> {
  const none: GameTarget = { fullscreen: false, monitorSourceId: null }
  const hwnd = hwndFromGameId(gameId)
  if (hwnd === null || !IS_WINDOWS) return none
  try {
    const output = (await runPowerShell(RECT_SCRIPT(hwnd))).trim()
    const [left, top, right, bottom, iconic] = output.split(',')
    if (!output || iconic === 'True') return none
    const rect = { left: Number(left), top: Number(top), right: Number(right), bottom: Number(bottom) }
    const { dip, display } = displayOf(rect)
    const fullscreen = dip.width >= display.bounds.width - 4 && dip.height >= display.bounds.height - 4
    if (!fullscreen) return none
    const screens = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1, height: 1 },
      fetchWindowIcons: false,
    })
    return { fullscreen: true, monitorSourceId: screenSourceFor(screens, display)?.id ?? null }
  } catch {
    return none
  }
}

/**
 * Finds the games that are currently running. A process counts as a game when
 * it owns a real window and either lives in a known game library folder, loads
 * Direct3D 11/12 or Vulkan (without being a browser, launcher or desktop
 * application), uses typical game libraries, or runs as a full-screen window.
 */
export async function detectRunningGames(): Promise<GameScanResult> {
  if (!IS_WINDOWS) return { games: [] }

  let data: ScanData
  try {
    data = await scanSystem()
  } catch (error) {
    return { games: [], error: error instanceof Error ? error.message : 'The game scan failed.' }
  }

  // One entry per process: its largest window.
  const byPid = new Map<number, WindowInfo>()
  for (const item of data.windows) {
    if (isSystemOrSelf(item)) continue
    const area = (item.right - item.left) * (item.bottom - item.top)
    const current = byPid.get(item.pid)
    if (!current || area > (current.right - current.left) * (current.bottom - current.top)) {
      byPid.set(item.pid, item)
    }
  }

  knownWindows.clear()
  for (const item of byPid.values()) knownWindows.set(item.hwnd, item)

  const programs: DetectedGame[] = []
  for (const item of byPid.values()) {
    programs.push({
      id: gameIdOf(item.hwnd),
      name: item.title || path.parse(item.path).name,
      exeName: path.basename(item.path),
      pid: item.pid,
      icon: await getIcon(item.path),
      isGame: isGame(item, data),
    })
  }

  // Games first, then every other open program, each group sorted by name.
  return {
    games: programs.sort((a, b) => Number(b.isGame) - Number(a.isGame) || a.name.localeCompare(b.name)),
  }
}
