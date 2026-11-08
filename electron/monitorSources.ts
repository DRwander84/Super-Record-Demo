// Gaming Mode Monitoring: the pure parts of the hardware readers (parsers and
// the PowerShell programs). Nothing here touches Electron, so it can be tested
// on its own.

export type NvidiaSample = {
  index: number
  name: string
  memTotalMb: number | null
  memUsedMb: number | null
  usage: number | null
  temp: number | null
  clock: number | null
  memClock: number | null
}

/** Field order of the nvidia-smi query; the name is last because it may hold commas. */
export const NVIDIA_QUERY =
  'index,memory.total,memory.used,utilization.gpu,temperature.gpu,clocks.gr,clocks.mem,name'

const toNumber = (text: string | undefined): number | null => {
  if (text === undefined || text.trim() === '') return null
  const value = Number(text.trim())
  // "[N/A]" and "[Not Supported]" are not numbers.
  return Number.isFinite(value) ? value : null
}

export function parseNvidiaLine(line: string): NvidiaSample | null {
  const parts = line.replace(/^\uFEFF/, '').split(',')
  if (parts.length < 8) return null
  const index = toNumber(parts[0])
  if (index === null) return null
  return {
    index,
    memTotalMb: toNumber(parts[1]),
    memUsedMb: toNumber(parts[2]),
    usage: toNumber(parts[3]),
    temp: toNumber(parts[4]),
    clock: toNumber(parts[5]),
    memClock: toNumber(parts[6]),
    name: parts.slice(7).join(',').trim(),
  }
}

/** The card with the most video memory is the one the game runs on. */
export function pickNvidiaCard(samples: NvidiaSample[]): NvidiaSample | null {
  let best: NvidiaSample | null = null
  for (const sample of samples) {
    if (!best || (sample.memTotalMb ?? 0) > (best.memTotalMb ?? 0)) best = sample
  }
  return best
}

export type DisplayAdapter = { name: string; memoryMb: number }

const VIRTUAL_ADAPTER = /basic (render|display)|remote display|virtual|parsec|indirect|citrix|vmware|hyper-v|displaylink|spacedesk|meta |oculus/i

/** Largest real adapter by video memory (discrete cards beat integrated ones). */
export function pickAdapter(adapters: DisplayAdapter[]): DisplayAdapter | null {
  let best: DisplayAdapter | null = null
  for (const adapter of adapters) {
    if (!adapter.name || VIRTUAL_ADAPTER.test(adapter.name)) continue
    if (!best || adapter.memoryMb > best.memoryMb) best = adapter
  }
  return best
}

// ---------------------------------------------------------------------------
// Sensor host: one resident PowerShell process.
//
//   I            -> I,<json>   display adapters (name and video memory)
//   W <hwnd>     -> W,l,t,r,b,iconic | W,GONE   game window rectangle
//   S <gpu> <cpu>-> S,<json>   sensors (gpu 1/0, cpu temperature 1/0)
//
// Sensors come from LibreHardwareMonitor when its DLLs are present (needed for
// processor temperature and for AMD / Intel graphics clocks and temperature).
// Without it graphics load and video memory still come from the Windows
// performance counters, which work for every vendor.
// ---------------------------------------------------------------------------

export const SENSOR_HOST_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch {}
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SRM {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr c);
  public static void Init() { try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch (Exception) { } }
  public static string Query(long hwnd) {
    IntPtr h = new IntPtr(hwnd);
    RECT r;
    if (!IsWindow(h) || !GetWindowRect(h, out r)) return "GONE";
    return r.Left + "," + r.Top + "," + r.Right + "," + r.Bottom + "," + (IsIconic(h) ? 1 : 0);
  }
}
'@
[SRM]::Init()
$sw = [System.Diagnostics.Stopwatch]::StartNew()

function Send([string]$text) { [Console]::Out.WriteLine($text); [Console]::Out.Flush() }

# ---- display adapters -------------------------------------------------------
function Get-Adapters {
  $list = @()
  $base = 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}'
  foreach ($key in Get-ChildItem $base) {
    if ($key.PSChildName -notmatch '^\d{4}$') { continue }
    $p = Get-ItemProperty -LiteralPath $key.PSPath
    $name = $p.DriverDesc
    if (-not $name) { continue }
    $raw = $p.'HardwareInformation.qwMemorySize'
    if ($null -eq $raw) { $raw = $p.'HardwareInformation.MemorySize' }
    $bytes = 0
    if ($raw -is [byte[]]) {
      if ($raw.Length -ge 8) { $bytes = [BitConverter]::ToUInt64($raw, 0) }
      elseif ($raw.Length -ge 4) { $bytes = [BitConverter]::ToUInt32($raw, 0) }
    } elseif ($null -ne $raw) { $bytes = [double]$raw }
    $list += @{ name = [string]$name; memoryMb = [math]::Round($bytes / 1MB) }
  }
  return ,$list
}

# ---- LibreHardwareMonitor (optional) ---------------------------------------
$lhm = $null
$lhmTried = $false
function Init-Lhm([bool]$gpu, [bool]$cpu) {
  $script:lhmTried = $true
  $dir = '__LHM_DIR__'
  if (-not $dir) { return }
  $dll = Join-Path $dir 'LibreHardwareMonitorLib.dll'
  if (-not (Test-Path -LiteralPath $dll)) { return }
  try {
    foreach ($f in Get-ChildItem -LiteralPath $dir -Filter *.dll) {
      if ($f.Name -ne 'LibreHardwareMonitorLib.dll') { try { [void][Reflection.Assembly]::LoadFrom($f.FullName) } catch {} }
    }
    [void][Reflection.Assembly]::LoadFrom($dll)
    $c = New-Object LibreHardwareMonitor.Hardware.Computer
    $c.IsCpuEnabled = $cpu
    $c.IsGpuEnabled = $gpu
    $c.Open()
    $script:lhm = $c
  } catch { $script:lhm = $null }
}

function Find-Sensor($hw, [string]$type, [string[]]$names) {
  foreach ($n in $names) {
    foreach ($s in $hw.Sensors) {
      if ($s.SensorType.ToString() -eq $type -and $s.Name -eq $n -and $null -ne $s.Value) { return [double]$s.Value }
    }
  }
  return $null
}

function Read-Lhm([bool]$gpu, [bool]$cpu) {
  $r = @{}
  $bestGpu = $null
  $bestMem = -1
  foreach ($hw in $script:lhm.Hardware) {
    $t = $hw.HardwareType.ToString()
    if ($cpu -and $t -eq 'Cpu') {
      $hw.Update()
      $value = Find-Sensor $hw 'Temperature' @('CPU Package','Core (Tctl/Tdie)','Core (Tdie)','Core (Tctl)','Core Max','Core Average','CPU Core #1')
      if ($null -eq $value) {
        foreach ($s in $hw.Sensors) {
          if ($s.SensorType.ToString() -eq 'Temperature' -and $null -ne $s.Value -and ($null -eq $value -or $s.Value -gt $value)) { $value = [double]$s.Value }
        }
      }
      if ($null -ne $value -and $value -gt 0 -and $value -lt 125) { $r.cpuTemp = $value }
    } elseif ($gpu -and $t -like 'Gpu*') {
      $hw.Update()
      $mem = Find-Sensor $hw 'SmallData' @('GPU Memory Total')
      $score = if ($null -ne $mem) { $mem } elseif ($t -eq 'GpuIntel') { 0 } else { 1 }
      if ($score -gt $bestMem) { $bestMem = $score; $bestGpu = $hw }
    }
  }
  if ($null -ne $bestGpu) {
    $r.gpuUsage = Find-Sensor $bestGpu 'Load' @('GPU Core','D3D 3D')
    $r.gpuTemp = Find-Sensor $bestGpu 'Temperature' @('GPU Core','GPU Hot Spot')
    $r.gpuClock = Find-Sensor $bestGpu 'Clock' @('GPU Core')
    $r.gpuMemClock = Find-Sensor $bestGpu 'Clock' @('GPU Memory')
    $r.vramUsedMb = Find-Sensor $bestGpu 'SmallData' @('D3D Dedicated Memory Used','GPU Memory Used')
  }
  return $r
}

# ---- Windows performance counters (any graphics vendor) --------------------
$engine = @{}
$memory = @{}
$luid = $null
$nextRefresh = 0
function Refresh-Counters {
  $script:nextRefresh = $script:sw.ElapsedMilliseconds + 5000
  $seenEngine = @{}
  try {
    $cat = New-Object System.Diagnostics.PerformanceCounterCategory('GPU Engine')
    foreach ($n in $cat.GetInstanceNames()) {
      $seenEngine[$n] = $true
      if (-not $script:engine.ContainsKey($n) -and $n -match 'luid_(0x[0-9a-fA-F]+_0x[0-9a-fA-F]+)_phys_\d+_eng_\d+_engtype_(.+)$') {
        $pc = New-Object System.Diagnostics.PerformanceCounter('GPU Engine', 'Utilization Percentage', $n, $true)
        [void]$pc.NextValue()
        $script:engine[$n] = @{ pc = $pc; key = $matches[1] + '|' + $matches[2]; luid = $matches[1] }
      }
    }
  } catch {}
  foreach ($k in @($script:engine.Keys)) {
    if (-not $seenEngine.ContainsKey($k)) { try { $script:engine[$k].pc.Dispose() } catch {}; $script:engine.Remove($k) }
  }
  $seenMemory = @{}
  try {
    $cat = New-Object System.Diagnostics.PerformanceCounterCategory('GPU Adapter Memory')
    foreach ($n in $cat.GetInstanceNames()) {
      $seenMemory[$n] = $true
      if (-not $script:memory.ContainsKey($n) -and $n -match 'luid_(0x[0-9a-fA-F]+_0x[0-9a-fA-F]+)') {
        $pc = New-Object System.Diagnostics.PerformanceCounter('GPU Adapter Memory', 'Dedicated Usage', $n, $true)
        $script:memory[$n] = @{ pc = $pc; luid = $matches[1] }
      }
    }
  } catch {}
  foreach ($k in @($script:memory.Keys)) {
    if (-not $seenMemory.ContainsKey($k)) { try { $script:memory[$k].pc.Dispose() } catch {}; $script:memory.Remove($k) }
  }
  # The adapter holding the most video memory is the one the game uses.
  $best = -1
  foreach ($m in $script:memory.Values) {
    try { $v = $m.pc.NextValue() } catch { continue }
    if ($v -gt $best) { $best = $v; $script:luid = $m.luid }
  }
}

function Read-Counters {
  if ($script:sw.ElapsedMilliseconds -ge $script:nextRefresh) { Refresh-Counters }
  $r = @{}
  $sums = @{}
  foreach ($e in $script:engine.Values) {
    if ($e.luid -ne $script:luid) { continue }
    try { $v = $e.pc.NextValue() } catch { continue }
    $sums[$e.key] = [double]$sums[$e.key] + $v
  }
  if ($script:engine.Count -gt 0) {
    $max = 0.0
    foreach ($v in $sums.Values) { if ($v -gt $max) { $max = $v } }
    $r.gpuUsage = [math]::Min(100.0, [math]::Round($max, 1))
  }
  foreach ($m in $script:memory.Values) {
    if ($m.luid -ne $script:luid) { continue }
    try { $r.vramUsedMb = [math]::Round($m.pc.NextValue() / 1MB) } catch {}
  }
  return $r
}

function Read-Sensors([bool]$gpu, [bool]$cpu) {
  if (-not $script:lhmTried) { Init-Lhm $gpu $cpu }
  $r = @{}
  if ($null -ne $script:lhm) {
    foreach ($pair in (Read-Lhm $gpu $cpu).GetEnumerator()) { if ($null -ne $pair.Value) { $r[$pair.Key] = $pair.Value } }
  }
  if ($gpu -and (-not $r.ContainsKey('gpuUsage') -or -not $r.ContainsKey('vramUsedMb'))) {
    foreach ($pair in (Read-Counters).GetEnumerator()) { if (-not $r.ContainsKey($pair.Key)) { $r[$pair.Key] = $pair.Value } }
  }
  $r.lhm = ($null -ne $script:lhm)
  return $r
}

Send 'READY'
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $parts = $line.Trim().Split(' ')
  switch ($parts[0]) {
    'I' { Send ('I,' + (ConvertTo-Json -Compress -InputObject (Get-Adapters))) }
    'W' {
      $value = 0L
      if ($parts.Length -gt 1 -and [long]::TryParse($parts[1], [ref]$value)) { Send ('W,' + [SRM]::Query($value)) }
    }
    'S' {
      $gpu = ($parts.Length -gt 1 -and $parts[1] -eq '1')
      $cpu = ($parts.Length -gt 2 -and $parts[2] -eq '1')
      Send ('S,' + (ConvertTo-Json -Compress -InputObject (Read-Sensors $gpu $cpu)))
    }
  }
}
if ($null -ne $lhm) { try { $lhm.Close() } catch {} }
`

// ---------------------------------------------------------------------------
// Frame rate host: real-time ETW session on the DXGI / D3D9 present events of
// the selected game (the same events PresentMon uses). Windows only allows
// this for administrators (or members of "Performance Log Users").
//
//   START <pid> -> START,OK | START,ERR:<code>
//   TAKE        -> F,<fps> | F,NA   (NA until the first present was seen)
//   QUIT
// ---------------------------------------------------------------------------

export const FPS_HOST_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch {}
function Send([string]$text) { [Console]::Out.WriteLine($text); [Console]::Out.Flush() }
$source = @'
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Threading;

public static class SRFps
{
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate void RecordCallback(IntPtr record);

    [StructLayout(LayoutKind.Sequential)]
    struct EVENT_TRACE_HEADER
    {
        public ushort Size; public ushort FieldTypeFlags; public uint Version;
        public uint ThreadId; public uint ProcessId; public long TimeStamp;
        public Guid Guid; public uint KernelTime; public uint UserTime;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct EVENT_TRACE
    {
        public EVENT_TRACE_HEADER Header; public uint InstanceId; public uint ParentInstanceId;
        public Guid ParentGuid; public IntPtr MofData; public uint MofLength; public uint ClientContext;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct SYSTEMTIME
    {
        public ushort a; public ushort b; public ushort c; public ushort d;
        public ushort e; public ushort f; public ushort g; public ushort h;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct NAME64
    {
        public uint a0; public uint a1; public uint a2; public uint a3; public uint a4; public uint a5; public uint a6; public uint a7;
        public uint a8; public uint a9; public uint a10; public uint a11; public uint a12; public uint a13; public uint a14; public uint a15;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct TIME_ZONE_INFORMATION
    {
        public int Bias; public NAME64 StandardName; public SYSTEMTIME StandardDate; public int StandardBias;
        public NAME64 DaylightName; public SYSTEMTIME DaylightDate; public int DaylightBias;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct TRACE_LOGFILE_HEADER
    {
        public uint BufferSize; public uint Version; public uint ProviderVersion; public uint NumberOfProcessors;
        public long EndTime; public uint TimerResolution; public uint MaximumFileSize; public uint LogFileMode; public uint BuffersWritten;
        public uint StartBuffers; public uint PointerSize; public uint EventsLost; public uint CpuSpeedInMHz;
        public IntPtr LoggerName; public IntPtr LogFileName; public TIME_ZONE_INFORMATION TimeZone;
        public long BootTime; public long PerfFreq; public long StartTime; public uint ReservedFlags; public uint BuffersLost;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct EVENT_TRACE_LOGFILE
    {
        public IntPtr LogFileName; public IntPtr LoggerName; public long CurrentTime; public uint BuffersRead; public uint ProcessTraceMode;
        public EVENT_TRACE CurrentEvent; public TRACE_LOGFILE_HEADER LogfileHeader;
        public IntPtr BufferCallback; public uint BufferSize; public uint Filled; public uint EventsLost;
        public IntPtr EventRecordCallback; public uint IsKernelTrace; public IntPtr Context;
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
    static extern uint StartTraceW(out ulong handle, string name, IntPtr props);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
    static extern uint ControlTraceW(ulong handle, string name, IntPtr props, uint code);
    [DllImport("advapi32.dll")]
    static extern uint EnableTraceEx2(ulong handle, ref Guid provider, uint control, byte level, ulong matchAny, ulong matchAll, uint timeout, IntPtr parameters);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern ulong OpenTraceW(ref EVENT_TRACE_LOGFILE logfile);
    [DllImport("advapi32.dll")]
    static extern uint ProcessTrace(ulong[] handles, uint count, IntPtr start, IntPtr end);
    [DllImport("advapi32.dll")]
    static extern uint CloseTrace(ulong handle);

    const string SessionName = "SUPERRECORD_FPS";
    const int PropsSize = 120 + 2048;

    static readonly object gate = new object();
    static readonly List<long> dxgiTimes = new List<long>();
    static readonly List<long> d3d9Times = new List<long>();
    static RecordCallback callback;
    static ulong session;
    static ulong trace;
    static int target;
    static bool seen;
    static long lastArrival;

    static IntPtr MakeProps()
    {
        IntPtr p = Marshal.AllocHGlobal(PropsSize);
        for (int i = 0; i < PropsSize; i += 8) Marshal.WriteInt64(p, i, 0L);
        Marshal.WriteInt32(p, 0, PropsSize);        // Wnode.BufferSize
        Marshal.WriteInt32(p, 40, 1);               // Wnode.ClientContext: QPC
        Marshal.WriteInt32(p, 44, 0x00020000);      // Wnode.Flags: WNODE_FLAG_TRACED_GUID
        Marshal.WriteInt32(p, 64, 0x00000100);      // LogFileMode: real time
        Marshal.WriteInt32(p, 68, 1);               // FlushTimer: 1 second
        Marshal.WriteInt32(p, 116, 120);            // LoggerNameOffset
        return p;
    }

    static void OnRecord(IntPtr rec)
    {
        try
        {
            if (Marshal.ReadInt32(rec, 12) != target) return;
            int id = (ushort)Marshal.ReadInt16(rec, 40);
            int data1 = Marshal.ReadInt32(rec, 24);
            bool dxgi = data1 == unchecked((int)0xCA11C036) && id == 42;
            bool d3d9 = data1 == 0x783ACA0A && id == 1;
            if (!dxgi && !d3d9) return;
            long ts = Marshal.ReadInt64(rec, 16);
            lock (gate)
            {
                List<long> list = dxgi ? dxgiTimes : d3d9Times;
                list.Add(ts);
                if (list.Count > 8192) list.RemoveRange(0, list.Count - 4096);
                seen = true;
                lastArrival = Environment.TickCount;
            }
        }
        catch (Exception) { }
    }

    public static string Start(int pid)
    {
        try
        {
            target = pid;
            IntPtr props = MakeProps();
            ulong handle;
            uint status = StartTraceW(out handle, SessionName, props);
            if (status == 183)
            {
                // A session left behind by a crash: stop it and start again.
                IntPtr old = MakeProps();
                ControlTraceW(0UL, SessionName, old, 1);
                Marshal.FreeHGlobal(old);
                props = MakeProps();
                status = StartTraceW(out handle, SessionName, props);
            }
            if (status != 0) return "ERR:" + status;
            session = handle;

            Guid dxgiGuid = new Guid("CA11C036-0102-4A2D-A6AD-F03CFED5D3C9");
            uint enabled = EnableTraceEx2(handle, ref dxgiGuid, 1, 5, ulong.MaxValue, 0UL, 0, IntPtr.Zero);
            if (enabled != 0) { Stop(); return "ERR:enable" + enabled; }
            Guid d3d9Guid = new Guid("783ACA0A-790E-4D7F-8451-AA850511C6B9");
            EnableTraceEx2(handle, ref d3d9Guid, 1, 5, ulong.MaxValue, 0UL, 0, IntPtr.Zero);

            callback = new RecordCallback(OnRecord);
            EVENT_TRACE_LOGFILE file = new EVENT_TRACE_LOGFILE();
            file.LoggerName = Marshal.StringToHGlobalUni(SessionName);
            file.ProcessTraceMode = 0x10000100;     // real time + event record
            file.EventRecordCallback = Marshal.GetFunctionPointerForDelegate(callback);
            ulong opened = OpenTraceW(ref file);
            if (opened == ulong.MaxValue)
            {
                int error = Marshal.GetLastWin32Error();
                Stop();
                return "ERR:open" + error;
            }
            trace = opened;
            Thread worker = new Thread(delegate () { ProcessTrace(new ulong[] { opened }, 1, IntPtr.Zero, IntPtr.Zero); });
            worker.IsBackground = true;
            worker.Start();
            AppDomain.CurrentDomain.ProcessExit += delegate (object s, EventArgs e) { Stop(); };
            return "OK";
        }
        catch (Exception ex)
        {
            return "ERR:" + ex.Message;
        }
    }

    public static void SetTarget(int pid)
    {
        lock (gate)
        {
            target = pid;
            dxgiTimes.Clear();
            d3d9Times.Clear();
            seen = false;
        }
    }

    static double Rate(List<long> list)
    {
        if (list.Count < 2) return 0;
        long newest = list[list.Count - 1];
        long from = newest - 10000000L;
        int i = list.Count - 1;
        while (i > 0 && list[i - 1] > from) i--;
        int count = list.Count - i;
        if (count < 2) return 0;
        double span = (newest - list[i]) / 10000000.0;
        return span <= 0 ? 0 : (count - 1) / span;
    }

    public static string Take()
    {
        lock (gate)
        {
            if (!seen) return "NA";
            // Nothing arrived for a while: the game stopped presenting.
            if (unchecked(Environment.TickCount - (int)lastArrival) > 3500) return "0.0";
            double a = Rate(dxgiTimes);
            double b = Rate(d3d9Times);
            return (a > b ? a : b).ToString("0.0", CultureInfo.InvariantCulture);
        }
    }

    public static void Stop()
    {
        try
        {
            if (session != 0UL)
            {
                IntPtr p = MakeProps();
                ControlTraceW(session, null, p, 1);
                Marshal.FreeHGlobal(p);
                session = 0UL;
            }
            if (trace != 0UL && trace != ulong.MaxValue)
            {
                CloseTrace(trace);
                trace = 0UL;
            }
        }
        catch (Exception) { }
    }
}
'@
try { Add-Type -TypeDefinition $source -Language CSharp } catch { Send 'READY,ERR:compile'; exit 1 }
Send 'READY'
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $parts = $line.Trim().Split(' ')
  if ($parts[0] -eq 'START' -and $parts.Length -gt 1) {
    Send ('START,' + [SRFps]::Start([int]$parts[1]))
  } elseif ($parts[0] -eq 'TARGET' -and $parts.Length -gt 1) {
    [SRFps]::SetTarget([int]$parts[1])
  } elseif ($parts[0] -eq 'TAKE') {
    Send ('F,' + [SRFps]::Take())
  } elseif ($parts[0] -eq 'QUIT') {
    break
  }
}
[SRFps]::Stop()
`
