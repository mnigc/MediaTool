export type MediaType = "video" | "image" | "audio" | "unknown";

export interface GpuBackend {
  id: string;
  name: string;
}

export interface GpuInfo {
  available: boolean;
  backends: GpuBackend[];
}

export interface MediaInfo {
  path: string;
  mediaType: MediaType;
  durationSecs?: number | null;
  width?: number | null;
  height?: number | null;
  videoCodec?: string | null;
  audioCodec?: string | null;
  bitrateKbps?: number | null;
  sizeBytes: number;
}

export interface VideoParams {
  videoCodec: string; // libx264 | libvpx-vp9 | libsvtav1 | copy
  qualityMode: string; // crf | target_size | bitrate
  crf?: number;
  targetSizeMb?: number;
  videoBitrateKbps?: number;
  resolution: string; // original | 720p | ...
  audioCodec: string; // aac | opus | copy | none
  audioBitrateKbps?: number;
  format: string; // source | mp4 | mkv | webm | mov
  preset: string;
  fps?: number; // output fps (undefined/0 = follow source, ignored for copy)
  gpu?: string; // GPU backend id (nvenc/qsv/videotoolbox/amf/vaapi); "" or unset = CPU
}

export interface ImageParams {
  format: string; // source | jpeg | png | webp | avif
  quality: number; // 1..100
  maxDimension?: number;
}

export interface AudioParams {
  format: string; // source | mp3 | aac | m4a | opus | flac
  bitrateKbps: number;
}

/* ── Toolbox tools ─────────────────────────────────────────── */

export type ToolId =
  | "video-compress"
  | "video-convert"
  | "audio-compress"
  | "audio-convert"
  | "image-compress"
  | "image-convert"
  | "gif"
  | "screenshot"
  | "speed"
  | "watermark"
  | "trim"
  | "rotate"
  | "mute"
  | "extract-audio"
  | "strip-metadata";

export interface GifParams {
  startTime?: number;
  duration?: number;
  fps: number; // 5..30, default 12
  width: number; // default 480
}

export interface ScreenshotParams {
  mode: "single" | "interval";
  atSec?: number; // single mode
  everySec?: number; // interval mode
  startSec?: number;
  endSec?: number;
  format: string; // png | jpeg
  maxWidth?: number;
}

export interface SpeedParams {
  rate: number; // 0.25..4
  muteAudio?: boolean;
}

export interface WatermarkParams {
  imagePath: string;
  position: string; // tl|tc|tr|ml|mc|mr|bl|bc|br
  scalePercent: number;
  opacity: number; // 0..1
  marginPercent: number;
}

/** Video trim tool: lossless keyframe-aligned cut or precise re-encode. */
export interface TrimParams {
  startTime: number;
  duration?: number; // undefined = to end
  mode: "copy" | "encode";
}

/** Rotate/flip tool (re-encodes). */
export interface RotateParams {
  transform: "90c" | "90cc" | "180" | "hflip" | "vflip";
}

/** Remove-audio-track tool (lossless stream copy, no params). */
export type MuteParams = Record<string, never>;

/** Video -> standalone audio file. */
export interface ExtractAudioParams {
  format: string; // mp3 | aac | m4a | opus | flac
  bitrateKbps: number;
}

/** Metadata-stripping tool for any media type (no params). */
export type StripMetadataParams = Record<string, never>;

export type ToolParams =
  | VideoParams
  | ImageParams
  | AudioParams
  | GifParams
  | ScreenshotParams
  | SpeedParams
  | WatermarkParams
  | TrimParams
  | RotateParams
  | MuteParams
  | ExtractAudioParams
  | StripMetadataParams;

export type JobParams = ToolParams;

export interface StreamReport {
  index: number;
  kind: string;
  codecName?: string | null;
  codecLong?: string | null;
  profile?: string | null;
  pixFmt?: string | null;
  width?: number | null;
  height?: number | null;
  avgFrameRate?: string | null;
  sampleRate?: number | null;
  channels?: number | null;
  channelLayout?: string | null;
  bitrateKbps?: number | null;
  language?: string | null;
  tags: unknown;
}

export interface MediaReport {
  path: string;
  sizeBytes: number;
  formatName?: string | null;
  formatLong?: string | null;
  durationSecs?: number | null;
  bitrateKbps?: number | null;
  tags: unknown;
  streams: StreamReport[];
  chapterCount: number;
}

export interface JobRequest {
  toolId: string; // compress | gif | screenshot | speed | watermark
  inputs: string[]; // one or more input files
  outputDir?: string;
  params: JobParams;
  outputSuffix?: string;
  gpu?: string; // GPU backend id; empty/undefined = CPU (compress only)
  overwritePolicy?: "overwrite" | "rename" | "skip"; // default: rename
}

/* ── Multi-step workflow ─────────────────────────────────────── */

export interface WorkflowStepInput {
  toolId: string;
  params: JobParams;
}

export interface WorkflowRequest {
  input: string;
  steps: WorkflowStepInput[];
  outputDir?: string;
  outputSuffix?: string;
  gpu?: string;
  overwritePolicy?: "overwrite" | "rename" | "skip";
}

export interface StartWorkflowResult {
  id: string;
  /** true when the steps were merged into one FFmpeg command now running on
   *  `id`; false means the caller should run the steps one by one. */
  merged: boolean;
}

export interface StartJobResult {
  id: string;
  skipped: boolean; // output existed and policy = skip; nothing was encoded
}

export interface EstimateRequest {
  info: MediaInfo;
  params: JobParams;
  mediaType: MediaType;
  sampleSecs?: number;
}

export interface EstimateResult {
  sampledBytes: number;
  sampledSecs: number;
  totalSecs?: number | null;
  bytes: number;
  exact: boolean;
}

export interface ProgressEvent {
  id: string;
  percent: number;
  phase: string; // running | done | error | cancelled
  speed?: string | null;
}

export interface DoneEvent {
  id: string;
  ok: boolean;
  cancelled?: boolean;
  output?: string | null;
  error?: string | null;
  inputSize: number;
  outputSize?: number | null;
}

export interface Job {
  uiId: string;
  toolId: string;
  info: MediaInfo;
  params: JobParams;
  rustId?: string;
  percent: number;
  phase: "queued" | "running" | "done" | "error" | "cancelled" | "skipped";
  output?: string | null;
  error?: string | null;
  outputSize?: number | null;
  startedAt?: number | null;
  /** Timestamp when the job was added to the queue (ms epoch). */
  createdAt?: number | null;
  /** Saved error/log summary retained on the task (for history/retry). */
  logs?: string | null;
  /** Output file paths produced by this task. */
  resultFiles?: string[];
  speed?: string | null;
  sizeEstimate?: { bytes: number; exact: boolean } | null;
  estimating?: boolean;
}
