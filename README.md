[🇨🇳 中文](README.zh.md) | [🇺🇸 English](README.md) | [🇰🇷 한국어](README.ko.md) | [🇯🇵 日本語](README.ja.md)

---

# MediaTool

A local media **toolbox** for batch processing of video, image, and audio files. Built on **Tauri 2 + React + TypeScript** with **FFmpeg** as the processing engine.

> Legal compliance: Only royalty-free encoders are enabled by default (H.264/AAC patents have expired, VP9/Opus/WebP/AVIF/AV1 are royalty-free). **HEVC/H.265** and other patent-encumbered encoders are **not provided**.

## Features

- **Toolbox Layout** — categorized tool tree (video / audio / image / general, 15 tools in total) with a unified bottom task dock; different tools can run tasks simultaneously
- **Video Compress** — H.264, VP9, AV1 (SVT-AV1) encoding with CRF/target size/fixed bitrate quality modes, resolution (480p ~ 2160p), frame rate and speed presets
- **Video Convert** — free container & codec combos (MP4/WebM/MKV/MOV × H.264/VP9/AV1); switching containers auto-selects matching codecs
- **Video Trim** — lossless quick mode (stream copy, keyframe-aligned) or precise mode (re-encode)
- **Remove Audio** — lossless audio-track removal via stream copy
- **Rotate & Flip** — 90° CW/CCW, 180°, horizontal/vertical mirror
- **Video → GIF** — high-quality palette-based GIF conversion (start/duration/fps/width)
- **Screenshot Export** — single frame or interval series export to PNG/JPEG
- **Speed Change** — 0.25x ~ 4x video/audio speed change with chained atempo, optional mute
- **Image Watermark** — overlay watermark on video with 9-grid positioning, scale & opacity control
- **Audio Compress / Convert** — lower bitrate keeping the source codec, or convert between MP3/AAC/M4A/Opus/FLAC
- **Extract Audio** — pull the audio track out of a video into its own file
- **Image Compress / Convert** — adjust quality & size keeping the source format, or convert between WebP/JPEG/PNG/AVIF
- **Strip Metadata** — remove EXIF/GPS and other metadata; lossless stream-copy for A/V, high-quality re-encode for images
- **Media Info** — instant full codec/stream inspection report via ffprobe
- **GPU Acceleration** — Auto-detects NVIDIA NVENC, Intel QSV, Apple VideoToolbox, AMD AMF, VAAPI backends
- **Batch Processing** — Drag-and-drop import, concurrent task execution (1/2/4), unified task dock with progress/retry/cancel
- **Name Conflict Policy** — auto-rename, skip, or overwrite when output files already exist
- **Built-in & Custom Presets** — per-tool scoped preset system for quick reuse
- **Output Size Estimation** — theoretical estimation + sample encoding for accurate prediction
- **Real-time Progress** — Progress bar, speed, and ETA estimation
- **Drag-and-Drop Sorting** — Reorder task list by dragging
- **Output Suffix** — Custom output filename suffix to avoid overwriting source files

## Screenshot

![MediaTool Screenshot](https://via.placeholder.com/800x500?text=MediaTool+Screenshot)

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
MediaTool/
├── src/                    # React frontend
│   ├── components/         # UI components (JobCard, TaskDock, ToolNav, OptionsPanel, etc.)
│   ├── contexts/           # TaskCenter (unified task queue, events, settings)
│   ├── tools/              # Toolbox: tool registry, workbenches, tool param panels
│   ├── hooks/              # Custom hooks (useTheme, useToasts)
│   ├── i18n/               # Internationalization (4 languages)
│   ├── lib/                # Utilities (preset management, output estimation, Tauri calls)
│   ├── App.tsx             # Main app component
│   ├── main.tsx            # Entry point
│   ├── types.ts            # TypeScript type definitions
│   └── index.css           # Styles (Tailwind CSS 4)
├── src-tauri/              # Rust backend
│   ├── src/                # Rust source
│   │   ├── commands.rs     # Tauri command registration
│   │   ├── jobs.rs         # Per-tool FFmpeg arg builders, task queue, progress/events
│   │   ├── inspect.rs      # ffprobe-based full media inspection
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