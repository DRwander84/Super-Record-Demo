# SUPER RECORD

SUPER RECORD is an Electron + React + TypeScript screen and game recorder for Windows. Video is captured and encoded by a native FFmpeg engine, so recordings are fast and use the GPU when one is available.

## Features

### Screen Record

- Native FFmpeg capture: Desktop Duplication (`ddagrab`) with an automatic GDI fallback.
- Hardware encoders (NVENC, AMF, QSV) are used first when available; software encoders are the fallback.
- Codecs: H.264, H.265 / HEVC and AV1.
- Containers: MP4, MKV, MOV (all codecs) and WebM (AV1 only).
- Capture modes: Full Screen, Custom Resolution (aspect ratio preserved) and Select Area, with monitor selection.
- Configurable frame rate, video bitrate and cursor visibility.
- Microphone and system (loopback) audio, with selectable audio codec and bitrate.
- Optional webcam overlay with shape, size, position, mirror and opacity settings.
- Optional Mouse Click Effects and Mouse Focus (hold-key zoom).
- Pause, resume and stop. Pausing creates a new video segment; all segments are joined when the recording stops.

### Gaming Mode

- Detects running games and records the selected program.
- Per-program audio capture, so only the game's sound is recorded.
- Constant or variable frame rate, Low Latency Capture and HDR10 recording (HEVC).
- Optional Speedrun Timer and hardware Monitoring panel drawn into the video.

### General

- Frameless window with an isolated preload bridge.
- Customizable global keyboard shortcuts that also work while another application has focus.
- Persistent settings, window position and selectable output folder.
- Each finished recording gets a small `<file>.json` sidecar with its resolution, FPS, codec and bitrate.
- My Recordings library for listing, searching, opening, revealing and deleting videos in the output folder.

## Requirements

- Windows 10 or Windows 11 (64-bit).
- To build from source: Node.js 22 or newer and npm.

## Download

Prebuilt Windows releases are available on the [GitHub Releases](https://github.com/DRwander84/Super-Record-Demo/releases) page.

Each release includes:

- `Super-Record-Setup-<version>.exe` - Windows installer.
- `Super-Record-Portable-<version>.exe` - Portable version that runs without installation.

The builds are not code-signed, so Windows SmartScreen may show a warning.

## Development

```bash
npm install
npm run dev
```

## Checks and build

```bash
npm run typecheck
npm run lint
npm run build
```

`npm run build` creates the renderer in `dist/` and the Electron main and preload bundles in `dist-electron/`.

## Building the Windows installer

```bash
npm install
npm run dist
```

The installer and the portable executable are created in the `release/` folder.

## Optional hardware monitoring library

GPU values for NVIDIA cards, RAM, CPU usage and the CPU / GPU names work out of the box. For CPU temperature and for clocks and temperature of AMD / Intel graphics cards, copy the LibreHardwareMonitor library into the `monitoring/` folder. See `monitoring/README.txt` for details.

## Third-party software

- [FFmpeg](https://ffmpeg.org/) is used for capture and encoding, installed through the `ffmpeg-static` package. FFmpeg and its encoders have their own licenses; check them before redistributing builds.
- The Poppins font is distributed under the SIL Open Font License.

## License

SUPER RECORD is licensed under the Apache License, Version 2.0.

You may use, modify, and redistribute this software under the terms of the license.

See the [LICENSE](LICENSE) file for the full license text and the [NOTICE](NOTICE) file for attribution information.
