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
  format: string; // mp4 | mkv | webm | mov
  preset: string;
  startTime?: number; // trim start offset, seconds
  duration?: number; // trim length, seconds (undefined = to end)
  fps?: number; // output fps (undefined/0 = follow source, ignored for copy)
  stripMetadata?: boolean; // strip container metadata / EXIF via -map_metadata -1
  extractAudio?: boolean; // extract audio track only from a video
  extractFormat?: string; // mp3 | aac | m4a | opus | flac (used when extractAudio)
  gpu?: string; // GPU backend id (nvenc/qsv/videotoolbox/amf/vaapi); "" or unset = CPU
}

export interface ImageParams {
  format: string; // jpeg | png | webp | avif | keep
  quality: number; // 1..100
  maxDimension?: number;
  stripMetadata?: boolean;
}

export interface AudioParams {
  format: string; // mp3 | aac | m4a | opus | flac
  bitrateKbps: number;
  stripMetadata?: boolean;
}

/* ── Toolbox tools ─────────────────────────────────────────── */

export type ToolId = "video-compress" | "audio-compress" | "image-compress" | "gif" | "screenshot" | "speed" | "watermark";

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

export type ToolParams =
  | VideoParams
  | ImageParams
  | AudioParams
  | GifParams
  | ScreenshotParams
  | SpeedParams
  | WatermarkParams;

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
  speed?: string | null;
  sizeEstimate?: { bytes: number; exact: boolean } | null;
  estimating?: boolean;
}
