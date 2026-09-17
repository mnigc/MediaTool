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
  | "screenshot"
  | "speed"
  | "watermark"
  | "trim"
  | "mute"
  | "extract-audio"
  | "strip-metadata"
  | "video-subtitle"
  | "video-merge"
  | "video-frames"
  | "video-contact"
  | "video-silence"
  | "audio-trim"
  | "audio-fade"
  | "audio-volume"
  | "audio-pitch"
  | "audio-silence"
  | "audio-merge";

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
  imagePath?: string;
  position: string; // tl|tc|tr|ml|mc|mr|bl|bc|br
  scalePercent: number;
  opacity: number; // 0..1
  marginPercent: number;
}

/** Video trim tool: lossless keyframe-aligned cut or precise re-encode. */
export interface TrimSegment {
  startTime: number;
  duration?: number; // undefined = to end
}

export interface TrimParams {
  startTime: number;
  duration?: number; // undefined = to end
  mode: "copy" | "encode";
  /** Multiple cut ranges, each exported as its own clip. Empty = single
   *  legacy range from startTime/duration. */
  segments?: TrimSegment[];
}

/* ── New video tools ───────────────────────────────────────── */

/** Burn-in (or soft-mux) subtitles from an external file. */
export interface SubtitleParams {
  path: string;
  burn?: boolean;
}

/** Concatenate multiple video clips. */
export interface VideoMergeParams {
  mode: "concat";
  mergeInputs?: string[];
}

/* ── New audio tools ───────────────────────────────────────── */

/** Lossless audio trim. */
export interface AudioTrimParams {
  startTime: number;
  duration?: number;
}

/** Fade audio in / out. */
export interface FadeParams {
  inSec: number;
  outSec: number;
}

/** Adjust the audio level of an audio file. */
export interface AudioVolumeParams {
  mode: "normalize" | "gain";
  gain?: number;
}

/** Change speed and/or pitch of an audio file. */
export interface PitchParams {
  speed: number; // 0.5..2.0
  pitch: number; // semitones, -12..12
}

/** Remove (or detect) silent passages. */
export interface SilenceParams {
  mode: "remove" | "detect";
  thresholdDb?: number;
  minLen?: number; // seconds
}

/** Concatenate multiple audio files. */
export interface AudioMergeParams {
  mode: "concat";
  mergeInputs?: string[];
}

/** Sample frames at an interval and re-encode them into a (sped-up) video. */
export interface FrameSampleParams {
  interval: number; // seconds between sampled frames
  fps: number; // output frame rate
  width: number; // sampled frame width (px)
}

/** Build a contact sheet / sprite grid of thumbnails from the video.
 *  mode "interval": capture every `interval` seconds. mode "count": capture
 *  `count` thumbnails spread evenly across the whole video (grid auto-fits). */
export interface ContactSheetParams {
  mode: "interval" | "count";
  interval: number; // seconds between thumbnails (interval mode)
  count: number; // total thumbnails (count mode)
  cols: number;
  rows: number;
  thumbW: number; // thumbnail width (px)
}

/** Detect silent segments in a video's audio track (writes a text report). */
export interface VideoSilenceParams {
  threshold: number; // dB (negative)
  minLen: number; // minimum silence length (seconds)
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
  | AudioParams
  | ScreenshotParams
  | SpeedParams
  | WatermarkParams
  | TrimParams
  | MuteParams
  | ExtractAudioParams
  | StripMetadataParams
  | SubtitleParams
  | VideoMergeParams
  | AudioTrimParams
  | FadeParams
  | AudioVolumeParams
  | PitchParams
  | SilenceParams
  | AudioMergeParams
  | FrameSampleParams
  | ContactSheetParams
  | VideoSilenceParams;

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
  /** true when the output already existed and the policy was "skip", so
   *  nothing was encoded and the run should be treated as finished. */
  skipped?: boolean;
}

export interface StartJobResult {
  id: string;
  skipped: boolean; // output existed and policy = skip; nothing was encoded
  /** The already-existing output file when `skipped` is true. */
  output?: string | null;
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
