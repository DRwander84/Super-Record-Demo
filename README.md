 <div align="center">
  <img src="public/icon.png" width="190" alt="SUPER RECORD Logo">

  <h1>SUPER RECORD</h1>

  <p>SUPER RECORD is an Electron + React + TypeScript screen and game recorder for Windows. Video is captured and encoded by a native FFmpeg engine, so recordings are fast and use the GPU when one is available.</p>
</div>

## Features

SUPER RECORD provides several recording modes and configuration options to suit different recording needs. Whether you want to capture your desktop, record gameplay, or customize your recording settings, you can choose the mode and options that best fit your workflow.

What makes SUPER RECORD stand out is its collection of optional features, giving you more control over your recordings and adding useful capabilities beyond standard screen and game capture.

### Optional Features

- **Mouse Focus:** Zoom in on the mouse pointer while recording by holding the assigned keyboard shortcut. The zoom follows the cursor, making it especially useful for tutorials, software demonstrations, and educational videos.

- **Block Notifications:** Temporarily disable Windows notifications while gaming, helping you avoid unwanted interruptions during gameplay and recording.

- **HDR Recording:** Capture gameplay in HDR, preserving a wider range of brightness and color when supported by your display and hardware.

- **Low Latency Capture:** Reduces capture hand-off overhead and applies the fastest available encoder settings for a more responsive recording pipeline.

- **Speedrun Timer:** An integrated timer designed for speedrunners. Start and pause it using the assigned keyboard shortcuts while recording your gameplay.

- **Hardware Monitoring:** Display live hardware usage information directly in your gameplay recordings. GPU and CPU models are detected automatically, making this feature especially useful for gaming benchmarks, hardware testing, and performance comparison videos.

- **Language:** This app supports both English and Persian languages.

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