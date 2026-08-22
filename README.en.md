[🇨🇳 中文](README.md) | [🇺🇸 English](README.en.md) | [🇰🇷 한국어](README.ko.md) | [🇯🇵 日本語](README.ja.md) | [🇷🇺 Русский](README.ru.md)

---

# MediPress

A local media compression and conversion tool for batch processing of video, image, and audio files. Built on **Tauri 2 + React + TypeScript** with **FFmpeg** as the processing engine.

> Legal compliance: Only royalty-free encoders are enabled by default (H.264/AAC patents have expired, VP9/Opus/WebP/AVIF are royalty-free). **HEVC/H.265** and other patent-encumbered encoders are **not provided**.

## Features

- **Video Compression & Conversion** — H.264, VP9 encoding with CRF/target size/fixed bitrate quality modes, custom resolution (480p ~ 2160p), encoding speed, and trim controls
- **Image Compression & Conversion** — Convert between JPEG, PNG, WebP formats with quality adjustment and max dimension limit
- **Audio Conversion** — Convert between MP3, AAC, M4A, Opus, FLAC formats with bitrate control
- **Audio Extraction** — Extract audio tracks from video files (MP3/AAC/Opus/FLAC)
- **GPU Acceleration** — Auto-detects NVIDIA NVENC, Intel QSV, Apple VideoToolbox, AMD AMF, VAAPI backends
- **Batch Processing** — Drag-and-drop or file picker for batch import, concurrent processing control (1/2/4)
- **Built-in Presets** — Optimized for YouTube, Bilibili, Douyin, Xiaohongshu, WeChat Channels
- **Custom Presets** — Save frequently used parameters as presets for quick reuse
- **Output Size Estimation** — Theoretical estimation based on parameters + sample encoding for accurate prediction
- **Real-time Progress** — Progress bar, speed, and ETA estimation
- **Drag-and-Drop Sorting** — Reorder task list by dragging
- **Multi-language** — 中文, English, 한국어, 日本語, Русский, Español
- **Theme** — Light / Dark / System
- **Output Suffix** — Custom output filename suffix to avoid overwriting source files

## Screenshot

![MediPress Screenshot](https://via.placeholder.com/800x500?text=MediPress+Screenshot)

## Requirements

- **Node.js** ≥ 18 (with npm)
- **Rust** toolchain ([rustup](https://rustup.rs/), including `stable` and MSVC target)
- **FFmpeg**: Runtime requires `ffmpeg` / `ffprobe`. The app searches in this order:
  1. Same directory as the executable (`ffmpeg.exe` / `ffprobe.exe`);
  2. Tauri resource directory (`resource_dir`);
  3. System `PATH`.
  - If none found, the app will prompt "FFmpeg not found".
  - Recommended: run `pwsh scripts/fetch-ffmpeg.ps1` to download and place in `src-tauri/binaries/`.
  - Alternatively, install FFmpeg system-wide and add it to `PATH`.

## Install Dependencies

```bash
npm install
```

## Start Development

```bash
npm run tauri dev
```

This launches the Vite frontend (http://localhost:1420), then compiles and starts the Rust backend window. Frontend changes hot-reload, Rust changes trigger recompilation.

## Build Installer

```bash
npm run tauri build
```

Output is in `src-tauri/target/release/bundle/` (Windows: `.msi` / `.exe`).

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Frontend only (Vite, no Tauri window) |
| `npm run build` | Build frontend static assets only |
| `npm run tauri dev` | Full desktop app (development) |
| `npm run tauri build` | Package desktop app (release) |

## Directory Structure

```
MediPress/
├── src/                    # React frontend
│   ├── components/         # UI components (JobCard, OptionsPanel, Sidebar, etc.)
│   ├── hooks/              # Custom hooks (useJobs, useTheme, useToasts)
│   ├── i18n/               # Internationalization (6 languages)
│   ├── lib/                # Utilities (preset management, output estimation, Tauri calls)
│   ├── App.tsx             # Main app component
│   ├── main.tsx            # Entry point
│   ├── types.ts            # TypeScript type definitions
│   └── index.css           # Styles (Tailwind CSS 4)
├── src-tauri/              # Rust backend
│   ├── src/                # Rust source
│   │   ├── commands.rs     # Tauri command registration
│   │   ├── jobs.rs         # Task queue, FFmpeg args, progress/events
│   │   ├── ffmpeg.rs       # FFmpeg process lookup & spawn
│   │   ├── media.rs        # ffprobe media detection
│   │   ├── gpu.rs          # GPU acceleration detection
│   │   ├── thumbnail.rs    # Video/image thumbnail generation
│   │   ├── models.rs       # Data models
│   │   ├── state.rs        # Job manager (child process lifecycle)
│   │   └── error.rs        # Error types
│   ├── binaries/           # FFmpeg sidecar binaries (gitignored)
│   ├── icons/              # App icons
│   └── tauri.conf.json     # Tauri configuration
├── scripts/                # Helper scripts
│   ├── fetch-ffmpeg.ps1    # Download FFmpeg binary
│   └── await-ffmpeg.ps1    # Wait for FFmpeg readiness
├── package.json
├── vite.config.ts
└── tsconfig.json
```

## Tech Stack

- **Frontend**: React 19 + TypeScript + Tailwind CSS 4
- **Desktop Framework**: Tauri 2
- **Backend**: Rust (Tauri commands)
- **Processing Engine**: FFmpeg (sidecar process)
- **Build Tool**: Vite 7

## Notes

- FFmpeg binaries are large. `scripts/fetch-ffmpeg.ps1` downloads a GPL build from GitHub (includes x264 / VP9 / AV1 / MP3 / Opus encoders). Please be patient if the download is slow, or install FFmpeg to `PATH` manually.
- For development, place `ffmpeg.exe` / `ffprobe.exe` in `src-tauri/binaries/` (or the same directory as the app / `PATH`).
- The frontend uses Tailwind CSS 4 (`@tailwindcss/vite` plugin), no PostCSS config file needed.