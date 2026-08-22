[🇨🇳 中文](README.zh.md) | [🇺🇸 English](README.md) | [🇰🇷 한국어](README.ko.md) | [🇯🇵 日本語](README.ja.md) | [🇷🇺 Русский](README.ru.md)

---

# MediPress

ローカルメディア圧縮・変換ツールで、動画、画像、音声ファイルを一括処理できます。**Tauri 2 + React + TypeScript** ベースのデスクトップアプリケーションで、**FFmpeg** を処理エンジンとして使用します。

> 法的遵守：デフォルトでは特許リスクのないコーデックのみ有効化されています（H.264/AAC の特許は期限切れ、VP9/Opus/WebP/AVIF はロイヤリティフリー）。**HEVC/H.265** など特許リスクのあるコーデックは**提供されません**。

## 機能

- **動画圧縮・変換** — H.264、VP9 エンコード、CRF/目標サイズ/固定ビットレート品質モード、カスタム解像度（480p〜2160p）、エンコード速度、トリム制御
- **画像圧縮・変換** — JPEG、PNG、WebP 形式変換、品質調整と最大サイズ制限
- **音声変換** — MP3、AAC、M4A、Opus、FLAC 形式変換、ビットレート制御
- **音声抽出** — 動画から音声トラックを抽出（MP3/AAC/Opus/FLAC）
- **GPU アクセラレーション** — NVIDIA NVENC、Intel QSV、Apple VideoToolbox、AMD AMF、VAAPI を自動検出
- **一括処理** — ドラッグ＆ドロップまたはファイル選択で一括インポート、同時処理制御（1/2/4）
- **内蔵プリセット** — YouTube、Bilibili、Douyin、Xiaohongshu、WeChat Channels に最適化
- **カスタムプリセット** — よく使うパラメータをプリセットとして保存し、すぐに再利用
- **出力サイズ予測** — パラメータベースの理論推定 + サンプルエンコードによる正確な予測
- **リアルタイム進捗** — 進捗バー、速度、ETA 予測
- **ドラッグ＆ドロップ並べ替え** — タスクリストをドラッグして順序変更
- **多言語** — 中文, English, 한국어, 日本語, Русский, Español
- **テーマ** — ライト / ダーク / システム設定
- **出力接尾辞** — カスタム出力ファイル名の接尾辞で元ファイルの上書き防止

## スクリーンショット

![MediPress スクリーンショット](https://via.placeholder.com/800x500?text=MediPress+Screenshot)

## 環境要件

- **Node.js** ≥ 18（npm 含む）
- **Rust** ツールチェーン（[rustup](https://rustup.rs/) でインストール、`stable` と MSVC ターゲットを含む）
- **FFmpeg**：実行時は `ffmpeg` / `ffprobe` が必要。以下の順序で検索：
  1. 実行ファイルと同じディレクトリ（`ffmpeg.exe` / `ffprobe.exe`）
  2. Tauri リソースディレクトリ（`resource_dir`）
  3. システム `PATH`
  - 見つからない場合、「FFmpeg が見つかりません」と表示
  - 推奨：`pwsh scripts/fetch-ffmpeg.ps1` を実行してダウンロードし、`src-tauri/binaries/` に配置
  - または、システムに FFmpeg をインストールして `PATH` に追加

## 依存関係のインストール

```bash
npm install
```

## 開発モードの起動

```bash
npm run tauri dev
```

Vite フロントエンド（http://localhost:1420）を起動した後、Rust バックエンドウィンドウをコンパイルして起動します。フロントエンドの変更はホットリロード、Rust の変更は再コンパイルされます。

## インストーラーのビルド

```bash
npm run tauri build
```

出力先：`src-tauri/target/release/bundle/`（Windows: `.msi` / `.exe`）

## スクリプト

| コマンド | 説明 |
| --- | --- |
| `npm run dev` | フロントエンドのみ（Vite、Tauri ウィンドウなし） |
| `npm run build` | フロントエンドの静的アセットのみビルド |
| `npm run tauri dev` | 完全なデスクトップアプリ（開発） |
| `npm run tauri build` | デスクトップアプリをパッケージ化（リリース） |

## ディレクトリ構造

```
MediPress/
├── src/                    # React フロントエンド
│   ├── components/         # UI コンポーネント（JobCard、OptionsPanel、Sidebar など）
│   ├── hooks/              # カスタム Hooks（useJobs、useTheme、useToasts）
│   ├── i18n/               # 国際化（6 言語）
│   ├── lib/                # ユーティリティ（プリセット管理、出力推定、Tauri 呼び出し）
│   ├── App.tsx             # メインアプリコンポーネント
│   ├── main.tsx            # エントリーポイント
│   ├── types.ts            # TypeScript 型定義
│   └── index.css           # スタイル（Tailwind CSS 4）
├── src-tauri/              # Rust バックエンド
│   ├── src/                # Rust ソース
│   │   ├── commands.rs     # Tauri コマンド登録
│   │   ├── jobs.rs         # タスクキュー、FFmpeg 引数、進捗/イベント
│   │   ├── ffmpeg.rs       # FFmpeg プロセス検索と起動
│   │   ├── media.rs        # ffprobe メディア検出
│   │   ├── gpu.rs          # GPU アクセラレーション検出
│   │   ├── thumbnail.rs    # 動画/画像サムネイル生成
│   │   ├── models.rs       # データモデル
│   │   ├── state.rs        # タスクマネージャー（子プロセスのライフサイクル）
│   │   └── error.rs        # エラータイプ
│   ├── binaries/           # FFmpeg sidecar バイナリ（gitignored）
│   ├── icons/              # アプリアイコン
│   └── tauri.conf.json     # Tauri 設定
├── scripts/                # ヘルパースクリプト
│   ├── fetch-ffmpeg.ps1    # FFmpeg バイナリのダウンロード
│   └── await-ffmpeg.ps1    # FFmpeg 準備完了待機
├── package.json
├── vite.config.ts
└── tsconfig.json
```

## 技術スタック

- **フロントエンド**: React 19 + TypeScript + Tailwind CSS 4
- **デスクトップフレームワーク**: Tauri 2
- **バックエンド**: Rust（Tauri コマンド）
- **処理エンジン**: FFmpeg（sidecar プロセス）
- **ビルドツール**: Vite 7

## 備考

- FFmpeg バイナリは大きいです。`scripts/fetch-ffmpeg.ps1` は GitHub から GPL ビルド（x264 / VP9 / AV1 / MP3 / Opus エンコーダーを含む）をダウンロードします。ダウンロードが遅い場合はお待ちいただくか、手動で FFmpeg を `PATH` にインストールしてください。
- 開発時は `ffmpeg.exe` / `ffprobe.exe` を `src-tauri/binaries/`（またはアプリと同じディレクトリ / `PATH`）に配置してください。
- フロントエンドは Tailwind CSS 4 を使用しています（`@tailwindcss/vite` プラグイン）。PostCSS 設定ファイルは不要です。