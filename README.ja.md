[🇨🇳 中文](README.zh.md) | [🇺🇸 English](README.md) | [🇰🇷 한국어](README.ko.md) | [🇯🇵 日本語](README.ja.md)

---

# MediaTool

ローカルメディア圧縮・変換ツールで、動画、画像、音声ファイルを一括処理できます。**Tauri 2 + React + TypeScript** ベースのデスクトップアプリケーションで、**FFmpeg** を処理エンジンとして使用します。

> 法的遵守：デフォルトでは特許リスクのないコーデックのみ有効化されています（H.264/AAC の特許は期限切れ、VP9/Opus/WebP/AVIF/AV1 はロイヤリティフリー）。**HEVC/H.265** など特許リスクのあるコーデックは**提供されません**。

## 機能

- **ツールボックスレイアウト** — 左側カテゴリツールツリー（動画/音声/画像/ツール、全 37 ツール）+ 下部統合タスクドック、異なるツールのタスクを同時実行
- **動画圧縮** — H.264、VP9、AV1 (SVT-AV1) エンコード、CRF/目標サイズ/固定ビットレート品質モード、解像度（480p〜2160p）、フレームレート、エンコード速度
- **動画変換** — コンテナとコーデックの自由な組み合わせ（MP4/WebM/MKV/MOV × H.264/VP9/AV1）、コンテナ切替時にデフォルトコーデックを自動マッチング
- **動画トリム** — ロスレス高速モード（ストリームコピー、キーフレーム整列）または精密モード（再エンコード）
- **音声トラック除去** — ストリームコピーによるロスレス除去、瞬時に完了
- **回転・反転** — 90° 時計回り/反時計回り、180° 回転、水平/垂直ミラー
- **GIF 変換** — パレットアルゴリズムによる高品質アニメ GIF 生成
- **スクリーンショット** — 単一フレームまたは一定間隔で PNG/JPEG 書き出し
- **速度変更** — 0.25x〜4x の動画/音声速度変更（チェーン atempo）、ミュート選択可
- **ウォーターマーク** — 動画への画像ウォーターマーク合成、9 分割位置・サイズ・不透明度調整
- **音声圧縮 / 変換** — フォーマット維持でビットレート削減、または MP3/AAC/M4A/Opus/FLAC 相互変換
- **音声抽出** — 動画から音声トラックを独立ファイルとして抽出
- **画像圧縮 / 変換** — 元フォーマット維持で品質・サイズ調整、または WebP/JPEG/PNG/AVIF 相互変換
- **メタデータ除去** — EXIF/GPS などの個人情報を削除；A/V はロスレス処理、画像は高品質再エンコード
- **メディア情報** — ffprobe ベースの完全なフォーマット/ストリーム情報を即時表示
- **GPU アクセラレーション** — NVIDIA NVENC、Intel QSV、Apple VideoToolbox、AMD AMF、VAAPI を自動検出
- **同名ファイル競合ポリシー** — 出力ファイル名が重複する場合、自動リネーム・スキップ・上書きから選択
- **内蔵・カスタムプリセット** — ツールごとに分離されたプリセットシステム
- **出力サイズ予測** — パラメータベースの理論推定 + サンプルエンコードによる正確な予測
- **多言語** — 中文, English | **テーマ** — ライト / ダーク / システム設定

## スクリーンショット

![MediaTool スクリーンショット](https://via.placeholder.com/800x500?text=MediaTool+Screenshot)

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
MediaTool/
├── src/                    # React フロントエンド
│   ├── components/         # UI コンポーネント（JobCard、JobList、ToolNav、OptionsPanel など）
│   ├── contexts/           # TaskCenter（統合タスクキュー・イベント・設定）
│   ├── tools/              # ツールボックス：ツールレジストリ、ワークベンチ、パラメータパネル
│   ├── workflow/           # マルチステップワークフローエンジンと型
│   ├── hooks/              # カスタム Hooks（useTheme、useToasts）
│   ├── i18n/               # 国際化（2 言語：中文 / English）
│   ├── lib/                # ユーティリティ（プリセット管理、出力推定、Tauri 呼び出し）
│   ├── App.tsx             # メインアプリコンポーネント
│   ├── main.tsx            # エントリーポイント
│   ├── types.ts            # TypeScript 型定義
│   └── index.css           # スタイル（Tailwind CSS 4）
├── src-tauri/              # Rust バックエンド
│   ├── src/                # Rust ソース
│   │   ├── commands.rs     # Tauri コマンド登録
│   │   ├── jobs.rs         # タスクキュー、FFmpeg 引数、進捗/イベント
│   │   ├── inspect.rs      # ffprobe ベースの完全なメディア検査
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