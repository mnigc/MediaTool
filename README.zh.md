[🇨🇳 中文](README.zh.md) | [🇺🇸 English](README.md) | [🇰🇷 한국어](README.ko.md) | [🇯🇵 日本語](README.ja.md)

---

# MediaTool

本地媒体**工具箱**，支持视频、图片、音频的批量处理与多种实用工具。基于 **Tauri 2 + React + TypeScript** 桌面端，底层使用 **FFmpeg** 作为处理引擎。

> 法律合规说明：默认仅启用无专利风险的编码（H.264/AAC 已过期、VP9/Opus/WebP/AVIF/AV1 均为免版税），**不提供 HEVC/H.265** 等有专利风险的编码。

## 功能特性

- **工具箱布局** — 左侧分类工具树（视频/音频/图片/工具，共 37 个小工具）+ 底部统一任务坞，不同工具的任务可同时进行
- **视频压缩** — H.264、VP9、AV1 (SVT-AV1) 编码，CRF/目标大小/固定码率三种质量模式，分辨率（480p ~ 2160p）、帧率、编码速度
- **视频转换** — 自由选择容器与编码组合（MP4/WebM/MKV/MOV × H.264/VP9/AV1），切换容器自动匹配默认编码器
- **视频裁剪** — 无损快速模式（流复制、关键帧对齐）与精确模式（重编码）两种裁剪方式
- **移除音轨** — 无损流复制移除音频轨，瞬间完成
- **旋转翻转** — 90° 顺/逆时针、180° 旋转及水平/垂直镜像
- **转 GIF** — 调色板算法高质量动图（起止时间/帧率/宽度可调）
- **截图导出** — 单帧截图或定时序列导出 PNG/JPEG
- **变速** — 视频/音频 0.25x ~ 4x 变速（atempo 链式处理），可选移除音频
- **图片水印** — 视频叠加图片水印，九宫格定位、缩放与不透明度调节
- **音频压缩 / 音频转换** — 保持格式降码率，或 MP3/AAC/M4A/Opus/FLAC 格式互转
- **提取音频** — 从视频中提取音轨为独立音频文件
- **图片压缩 / 图片转换** — 保持原格式调质量限尺寸，或 WebP/JPEG/PNG/AVIF 格式互转
- **去除元数据** — 删除 EXIF/GPS 等隐私信息；音视频无损流复制处理，图片高质量重编码
- **格式体检** — 基于 ffprobe 的完整封装/流信息即时查看
- **GPU 加速** — 自动检测 NVIDIA NVENC、Intel QSV、Apple VideoToolbox、AMD AMF、VAAPI 后端
- **批量处理** — 拖拽添加或文件选择器批量导入，并发数控制（1/2/4），任务坞统一进度/重试/取消
- **重名冲突策略** — 输出文件重名时可自动重命名、跳过或覆盖
- **内置与自定义预设** — 按工具隔离的预设系统，常用参数快速复用
- **输出大小预估** — 基于参数的理论估算 + 采样编码精确估算
- **多语言** — 中文、English | **主题** — 浅色 / 深色 / 跟随系统

## 截图

![MediaTool 界面](https://via.placeholder.com/800x500?text=MediaTool+Screenshot)

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
MediaTool/
├── src/                    # React 前端
│   ├── components/         # UI 组件（JobCard、JobList、ToolNav、OptionsPanel 等）
│   ├── contexts/           # TaskCenter（统一任务队列、事件、设置）
│   ├── tools/              # 工具箱：工具注册表、工作台、参数面板
│   ├── workflow/           # 多步骤工作流引擎与类型
│   ├── hooks/              # 自定义 Hooks（useTheme、useToasts）
│   ├── i18n/               # 国际化（2 种语言：中文 / English）
│   ├── lib/                # 工具库（预设管理、输出估算、Tauri 调用）
│   ├── App.tsx             # 主应用组件
│   ├── main.tsx            # 入口
│   ├── types.ts            # TypeScript 类型定义
│   └── index.css           # 样式（Tailwind CSS 4）
├── src-tauri/              # Rust 后端
│   ├── src/                # Rust 源码
│   │   ├── commands.rs     # Tauri 命令注册
│   │   ├── jobs.rs         # 任务队列、FFmpeg 参数构建、进度/事件
│   │   ├── inspect.rs      # 基于 ffprobe 的完整媒体检测
│   │   ├── ffmpeg.rs       # FFmpeg 进程查找与启动
│   │   ├── media.rs        # ffprobe 媒体探测
│   │   ├── gpu.rs          # GPU 加速后端检测
│   │   ├── thumbnail.rs    # 视频/图片缩略图生成
│   │   ├── models.rs       # 数据模型
│   │   ├── state.rs        # 任务管理器（子进程生命周期）
│   │   └── error.rs        # 错误类型
│   ├── binaries/           # FFmpeg sidecar 二进制（gitignored）
│   ├── icons/              # 应用图标
│   └── tauri.conf.json     # Tauri 配置
├── scripts/                # 辅助脚本
│   ├── fetch-ffmpeg.ps1    # 下载 FFmpeg 二进制
│   └── await-ffmpeg.ps1    # 等待 FFmpeg 就绪
├── package.json
├── vite.config.ts
└── tsconfig.json
```

## 技术栈

- **前端**：React 19 + TypeScript + Tailwind CSS 4
- **桌面框架**：Tauri 2
- **后端**：Rust（Tauri 命令）
- **处理引擎**：FFmpeg（sidecar 进程）
- **构建工具**：Vite 7

## 备注

- FFmpeg 二进制较大，`scripts/fetch-ffmpeg.ps1` 会从 GitHub 下载 GPL 构建（含 x264 / VP9 / AV1 / MP3 / Opus 等编码器）。下载较慢时请耐心等待，或自行安装到 `PATH`。
- 开发时把 `ffmpeg.exe` / `ffprobe.exe` 放在 `src-tauri/binaries/`（或程序同目录 / `PATH`）即可运行。
- 前端使用 Tailwind CSS 4（`@tailwindcss/vite` 插件），无需 PostCSS 配置文件。