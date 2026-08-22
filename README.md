# MediPress

本地媒体格式转换与压缩工具（视频 / 图片 / 音频）。基于 **Tauri 2 + React + TypeScript** 桌面端，底层使用 **FFmpeg** 作为处理引擎。

> 法律合规说明：默认仅启用无专利风险的编码（H.264/AAC 已过期、VP9/Opus/WebP/AVIF 均为免版税），**不提供 HEVC/H.265** 等有专利风险的编码。

## 环境要求

- **Node.js** ≥ 18（含 npm）
- **Rust** 工具链（[rustup](https://rustup.rs/) 安装，需包含 `stable` 与 MSVC 编译目标）
- **FFmpeg**：运行时需要 `ffmpeg` / `ffprobe`。程序按以下顺序查找：
  1. 与可执行文件同一目录（`ffmpeg.exe` / `ffprobe.exe`）；
  2. Tauri 资源目录（`resource_dir`）；
  3. 系统 `PATH` 中的 `ffmpeg`。
  - 若都找不到，应用会在调用时提示「找不到 ffmpeg」。
  - 推荐用脚本一键获取：`pwsh scripts/fetch-ffmpeg.ps1`（下载并放到 `src-tauri/binaries/`）。
  - 也可自行在系统安装 FFmpeg 并加入 `PATH`。

## 安装依赖

```bash
npm install
```

## 启动开发模式

```bash
npm run tauri dev
```

该命令会：先启动 Vite 前端（http://localhost:1420），再编译并启动 Rust 后端窗口。修改前端代码会热更新，修改 Rust 代码会重新编译。

## 打包为安装程序

```bash
npm run tauri build
```

产物位于 `src-tauri/target/release/bundle/`（Windows 为 `.msi` / `.exe`）。

## 常用脚本

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 仅启动前端（Vite，不含 Tauri 窗口） |
| `npm run build` | 仅构建前端静态资源 |
| `npm run tauri dev` | 启动完整桌面应用（开发） |
| `npm run tauri build` | 打包桌面应用（发布） |

## 目录结构

```
MediPress/
├── src/                 # React 前端
├── src-tauri/          # Rust 后端
│   ├── binaries/       # 打包的 FFmpeg / ffprobe sidecar
│   └── src/            # 命令、任务队列、参数构建、探针
├── package.json
└── tauri.conf.json      # Tauri 配置（含 sidecar 声明）
```

## 备注

- FFmpeg 二进制较大，`scripts/fetch-ffmpeg.ps1` 会从 GitHub 下载 GPL 构建（含 x264 / VP9 / AV1(AVIF) / MP3 / Opus 等编码器）。下载较慢时请耐心等待，或自行安装到 `PATH`。
- 开发时把 `ffmpeg.exe` / `ffprobe.exe` 放在 `src-tauri/binaries/`（或程序同目录 / `PATH`）即可运行。
