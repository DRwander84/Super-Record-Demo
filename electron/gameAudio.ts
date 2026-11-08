import { app } from 'electron'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

// Records the sound of ONE program (and the programs it starts) through the
// Windows per-process loopback API (Windows 10 version 2004 or newer). Nothing
// else that plays on the PC is captured. The small helper program is compiled
// once with the C# compiler that ships with Windows and writes 48 kHz stereo
// 16-bit PCM to its output.
const HELPER_VERSION = 3

const HELPER_SOURCE = `
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

[ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IActivateAudioInterfaceAsyncOperation {
  [PreserveSig] int GetActivateResult(out int activateResult, [MarshalAs(UnmanagedType.IUnknown)] out object activatedInterface);
}

[ComImport, Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IActivateAudioInterfaceCompletionHandler {
  [PreserveSig] int ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation);
}

[ComImport, Guid("94EA2B94-E9CC-49E0-C0FF-EE64CA8F5B90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAgileObject { }

[ComImport, Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioClient {
  [PreserveSig] int Initialize(int shareMode, uint streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr sessionGuid);
  [PreserveSig] int GetBufferSize(out uint frames);
  [PreserveSig] int GetStreamLatency(out long latency);
  [PreserveSig] int GetCurrentPadding(out uint padding);
  [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest);
  [PreserveSig] int GetMixFormat(out IntPtr format);
  [PreserveSig] int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
  [PreserveSig] int Start();
  [PreserveSig] int Stop();
  [PreserveSig] int Reset();
  [PreserveSig] int SetEventHandle(IntPtr eventHandle);
  [PreserveSig] int GetService(ref Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
}

[ComImport, Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioCaptureClient {
  [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devicePosition, out ulong qpcPosition);
  [PreserveSig] int ReleaseBuffer(uint frames);
  [PreserveSig] int GetNextPacketSize(out uint frames);
}

public class ActivationHandler : IActivateAudioInterfaceCompletionHandler, IAgileObject {
  public ManualResetEvent Done = new ManualResetEvent(false);
  public IActivateAudioInterfaceAsyncOperation Operation;
  public int ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation) {
    Operation = operation;
    Done.Set();
    return 0;
  }
}

public static class GameAudioCapture {
  [DllImport("Mmdevapi.dll", ExactSpelling = true, PreserveSig = false)]
  static extern void ActivateAudioInterfaceAsync(
    [MarshalAs(UnmanagedType.LPWStr)] string deviceInterfacePath,
    ref Guid riid,
    IntPtr activationParams,
    IActivateAudioInterfaceCompletionHandler completionHandler,
    out IActivateAudioInterfaceAsyncOperation activationOperation);
  [DllImport("kernel32.dll")] static extern IntPtr CreateEvent(IntPtr attributes, bool manualReset, bool initialState, string name);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

  static void Fail(string message) {
    Console.Error.WriteLine("ERROR " + message);
    Console.Error.Flush();
    Environment.Exit(2);
  }

  static IAudioClient Activate(uint pid) {
    // AUDIOCLIENT_ACTIVATION_PARAMS: { ActivationType, { TargetProcessId, ProcessLoopbackMode } }
    // ActivationType 1 = process loopback, mode 0 = include the target process tree.
    IntPtr activation = Marshal.AllocHGlobal(12);
    Marshal.WriteInt32(activation, 0, 1);
    Marshal.WriteInt32(activation, 4, (int)pid);
    Marshal.WriteInt32(activation, 8, 0);
    // PROPVARIANT (VT_BLOB) that carries the activation parameters.
    IntPtr variant = Marshal.AllocHGlobal(24);
    for (int i = 0; i < 24; i++) Marshal.WriteByte(variant, i, 0);
    Marshal.WriteInt16(variant, 0, 65);
    Marshal.WriteInt32(variant, 8, 12);
    Marshal.WriteIntPtr(variant, 16, activation);

    Guid clientId = typeof(IAudioClient).GUID;
    ActivationHandler handler = new ActivationHandler();
    IActivateAudioInterfaceAsyncOperation operation;
    ActivateAudioInterfaceAsync("VAD\\\\Process_Loopback", ref clientId, variant, handler, out operation);
    if (!handler.Done.WaitOne(8000)) Fail("activation timed out");
    int activateResult;
    object activated;
    handler.Operation.GetActivateResult(out activateResult, out activated);
    if (activateResult != 0 || activated == null) Fail("activation failed 0x" + activateResult.ToString("X8"));
    return (IAudioClient)activated;
  }

  [MTAThread]
  public static int Main(string[] args) {
    try {
      if (args.Length < 1) Fail("missing process id");
      uint pid = uint.Parse(args[0]);

      // 48 kHz, stereo, 16-bit PCM.
      IntPtr format = Marshal.AllocHGlobal(18);
      Marshal.WriteInt16(format, 0, 1);
      Marshal.WriteInt16(format, 2, 2);
      Marshal.WriteInt32(format, 4, 48000);
      Marshal.WriteInt32(format, 8, 192000);
      Marshal.WriteInt16(format, 12, 4);
      Marshal.WriteInt16(format, 14, 16);
      Marshal.WriteInt16(format, 16, 0);

      // Stream flags: LOOPBACK 0x20000, EVENTCALLBACK 0x40000, NOPERSIST 0x80000,
      // AUTOCONVERTPCM 0x80000000, SRC_DEFAULT_QUALITY 0x08000000. Windows builds
      // differ in which combination a process-loopback client accepts
      // (AUDCLNT_E_INVALID_STREAM_FLAG 0x88890021 otherwise), so the combinations
      // are tried in turn, each on a freshly activated client.
      uint[] attempts = new uint[] {
        0x00020000u | 0x00040000u | 0x00080000u,
        0x00020000u | 0x00040000u | 0x80000000u | 0x08000000u,
        0x00020000u | 0x00040000u,
        0x00020000u | 0x80000000u | 0x08000000u,
        0x00020000u
      };
      IAudioClient client = null;
      uint flagsUsed = 0;
      string failures = "";
      for (int i = 0; i < attempts.Length; i++) {
        IAudioClient candidate = Activate(pid);
        int result = candidate.Initialize(0, attempts[i], 2000000, 0, format, IntPtr.Zero);
        if (result == 0) { client = candidate; flagsUsed = attempts[i]; break; }
        failures += (failures.Length > 0 ? ", " : "") + "0x" + attempts[i].ToString("X") + " -> 0x" + result.ToString("X8");
        try { Marshal.ReleaseComObject(candidate); } catch (Exception) { }
      }
      if (client == null) Fail("initialize failed (flags tried: " + failures + ")");

      bool eventDriven = (flagsUsed & 0x00040000u) != 0;
      IntPtr waitEvent = IntPtr.Zero;
      int hr;
      if (eventDriven) {
        waitEvent = CreateEvent(IntPtr.Zero, false, false, null);
        hr = client.SetEventHandle(waitEvent);
        if (hr != 0) Fail("event failed 0x" + hr.ToString("X8"));
      }
      Guid captureId = typeof(IAudioCaptureClient).GUID;
      object service;
      hr = client.GetService(ref captureId, out service);
      if (hr != 0) Fail("capture service failed 0x" + hr.ToString("X8"));
      IAudioCaptureClient capture = (IAudioCaptureClient)service;
      hr = client.Start();
      if (hr != 0) Fail("start failed 0x" + hr.ToString("X8"));

      // The parent closes our input when it wants us to stop (or when it dies).
      Thread watcher = new Thread(delegate() {
        try { while (Console.In.Read() >= 0) { } } catch (Exception) { }
        Environment.Exit(0);
      });
      watcher.IsBackground = true;
      watcher.Start();

      Console.Error.WriteLine("READY");
      Console.Error.Flush();

      Stream output = Console.OpenStandardOutput();
      while (true) {
        if (eventDriven) WaitForSingleObject(waitEvent, 100); else Thread.Sleep(10);
        uint packet;
        while (capture.GetNextPacketSize(out packet) == 0 && packet > 0) {
          IntPtr data;
          uint frames;
          uint flags;
          ulong devicePosition;
          ulong qpcPosition;
          if (capture.GetBuffer(out data, out frames, out flags, out devicePosition, out qpcPosition) != 0) break;
          int bytes = (int)frames * 4;
          byte[] buffer = new byte[bytes];
          if ((flags & 2) == 0) Marshal.Copy(data, buffer, 0, bytes);
          capture.ReleaseBuffer(frames);
          output.Write(buffer, 0, bytes);
        }
        output.Flush();
      }
    } catch (Exception error) {
      Fail(error.Message);
      return 2;
    }
  }
}
`

let helper: ChildProcess | null = null

function cscPath(): string | null {
  const root = process.env.SystemRoot || 'C:\\Windows'
  const candidates = [
    path.join(root, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(root, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ]
  return candidates.find((item) => existsSync(item)) ?? null
}

async function ensureHelper(): Promise<string> {
  const directory = path.join(app.getPath('userData'), 'tools')
  await mkdir(directory, { recursive: true })
  const exePath = path.join(directory, `game-audio-v${HELPER_VERSION}.exe`)
  if (existsSync(exePath)) return exePath

  const compiler = cscPath()
  if (!compiler) throw new Error('The Windows C# compiler was not found, so game audio cannot be captured.')
  const sourcePath = path.join(directory, `game-audio-v${HELPER_VERSION}.cs`)
  await writeFile(sourcePath, HELPER_SOURCE, 'utf8')

  await new Promise<void>((resolve, reject) => {
    execFile(
      compiler,
      ['/nologo', '/target:exe', '/optimize+', '/platform:x64', `/out:${exePath}`, sourcePath],
      { windowsHide: true, timeout: 60_000 },
      (error, stdout) => (error ? reject(new Error(`Could not prepare game audio: ${String(stdout).trim().split(/\r?\n/)[0] || error.message}`)) : resolve()),
    )
  })
  return exePath
}

export function stopGameAudio(): void {
  const child = helper
  helper = null
  if (!child) return
  try { child.stdin?.end() } catch { /* already closed */ }
  setTimeout(() => { try { child.kill() } catch { /* already gone */ } }, 500)
}

export async function startGameAudio(
  processId: number,
  onData: (chunk: Buffer) => void,
): Promise<{ success: boolean; message: string }> {
  if (process.platform !== 'win32') return { success: false, message: 'Game audio capture is only available on Windows.' }
  if (!Number.isInteger(processId) || processId <= 0) return { success: false, message: 'Invalid game process.' }
  stopGameAudio()

  let exePath: string
  try {
    exePath = await ensureHelper()
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : 'Could not prepare game audio.' }
  }

  return new Promise((resolve) => {
    const child = spawn(exePath, [String(processId)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    helper = child
    let settled = false
    let errorText = ''

    const finish = (result: { success: boolean; message: string }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (!result.success && helper === child) stopGameAudio()
      resolve(result)
    }

    const timer = setTimeout(() => finish({ success: false, message: 'Game audio capture did not start in time.' }), 10_000)

    child.stdout?.on('data', (chunk: Buffer) => {
      if (helper === child) onData(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      errorText += chunk.toString('utf8')
      if (/READY/.test(errorText)) finish({ success: true, message: 'Game audio is being captured.' })
    })
    child.stdin?.on('error', () => undefined)
    child.on('error', (error) => finish({ success: false, message: error.message }))
    child.on('exit', () => {
      if (helper === child) helper = null
      const detail = errorText.replace(/READY/g, '').trim() || 'The game audio capture stopped.'
      // Only these codes really mean "this Windows version cannot do it":
      // E_NOTIMPL, E_NOINTERFACE and ERROR_NOT_SUPPORTED / REGDB_E_CLASSNOTREG.
      const unsupported = /0x80004001|0x80004002|0x80070032|0x80040154/i.test(detail)
      const processGone = /0x8007000[2-6]/i.test(detail)
      finish({
        success: false,
        message: unsupported
          ? `Game audio capture needs Windows 10 (version 2004) or newer. ${detail}`
          : processGone
            ? `The selected game is no longer running. ${detail}`
            : detail,
      })
    })
  })
}
