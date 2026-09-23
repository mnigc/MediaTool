import type { PipelineRun } from "./workflow/types";

export type MediaType = "video" | "image" | "audio" | "unknown";

export interface GpuBackend {
  id: string;
  name: string;
}

export interface GpuInfo {
  available: boolean;
  backends: GpuBackend[];
}

/** One bucket of app-owned scratch data reported by `cache_report`. */
export interface CacheBucket {
  key: string;
  /** i18n key of the display label. */
  labelKey: string;
  path: string;
  sizeBytes: number;
  fileCount: number;
  /** Whether "清除缓存" removes this bucket. */
  removable: boolean;
}

export interface CacheReport {
  totalBytes: number;
  removableBytes: number;
  buckets: CacheBucket[];
}

export interface CacheCleanResult {
  freedBytes: number;
  removed: number;
  /** Entries that existed but could not be deleted (usually in use). */
  failed: number;
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
  /** HDR transfer detected at probe time (HDR10/HLG/DV base layer). */
  hdr?: boolean;
}

export interface VideoParams {
  videoCodec: string; // libx264 | libx265 | libvpx-vp9 | libsvtav1 | copy
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
  | "audio-compress"
  | "screenshot"
  | "speed"
  | "watermark"
  | "trim"
  | "mute"
  | "extract-audio"
  | "strip-metadata"
  | "video-subtitle"
  | "video-frames"
  | "video-contact"
  | "video-silence"
  | "roughcut"
  | "audio-volume"
  | "audio-merge";

export interface ScreenshotParams {
  mode: "single" | "interval" | "count";
  atSec?: number; // single mode
  everySec?: number; // interval mode
  count?: number; // count mode: N frames spread evenly across the video
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

/* ── Rough cut (timeline editor) ───────────────────────────── */

/** One segment of the rough-cut timeline. */
export interface RoughCutClip {
  path: string;
  startTime: number;
  /** undefined = to end of source */
  endTime?: number;
  mute?: boolean;
  volume?: number; // linear gain, 1 = unchanged
  speed?: number; // 0.25..4, 1 = unchanged
}

/** Ordered clip list exported as one file. */
export interface RoughCutParams {
  mode: "copy" | "encode";
  clips: RoughCutClip[];
  container: "mp4" | "mkv";
  /** Encoding recipe for "encode" mode; backend defaults when omitted. */
  encode?: VideoParams;
}

/* ── New audio tools ───────────────────────────────────────── */

/** Adjust the audio level of an audio file. */
export interface AudioVolumeParams {
  mode: "normalize" | "gain";
  gain?: number;
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
 *  `count` thumbnails spread evenly across the whole video (grid auto-fits,
 *  or a fixed `countCols` width for the player-preview layout). */
export interface ContactSheetParams {
  mode: "interval" | "count";
  interval: number; // seconds between thumbnails (interval mode)
  count: number; // total thumbnails (count mode)
  countCols?: number; // count mode: fixed grid columns (0/undefined = auto-fit)
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
  | RoughCutParams
  | AudioVolumeParams
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
  /** Bound pipelines only: when a stream-copy step targets MP4 with codecs
   *  the container can't carry, swap them for the transcode recipe (the
   *  result carries a `note` explaining it). Tool pages keep the hard error. */
  allowCopyFallback?: boolean;
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
  /** Opt into the remux auto-fallback (see JobRequest). */
  allowCopyFallback?: boolean;
}

export interface StartWorkflowResult {
  id: string;
  /** true when the steps were merged into one FFmpeg command now running on
   *  `id`; false means the caller should run the steps one by one. */
  merged: boolean;
  /** true when the output already existed and the policy was "skip", so
   *  nothing was encoded and the run should be treated as finished. */
  skipped?: boolean;
  /** Non-fatal adjustment the backend made while preparing (remux fallback). */
  note?: string | null;
}

export interface StartJobResult {
  id: string;
  skipped: boolean; // output existed and policy = skip; nothing was encoded
  /** The already-existing output file when `skipped` is true. */
  output?: string | null;
  /** Non-fatal adjustment the backend made while preparing (remux fallback). */
  note?: string | null;
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
  /** Every deliverable of the job; absent when it is just `output`. */
  outputs?: string[] | null;
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
  /** Post-processing pipeline bound at creation time; its final output
   *  replaces the raw encode output as the product (upload target). */
  pipelineSteps?: WorkflowStepInput[];
  /** Runtime state of the bound pipeline; absent until it first runs. */
  pipeline?: PipelineRun | null;
  /** Upload targets bound at creation time; the final product is pushed to
   *  them when the job (and its pipeline, if any) completes. */
  uploadTo?: string[];
}

/* ── yt-dlp download / record ─────────────────────────────────── */

export interface YtdlpStatus {
  installed: boolean;
  version?: string | null;
  path?: string | null;
  ffmpegFound: boolean;
}

export interface YtdlpInstallProgress {
  stage: string; // downloading | done | error
  message: string;
  /** Download percentage 0-100; absent when the server sent no Content-Length. */
  percent?: number | null;
}

/** FFmpeg/ffprobe: the format-conversion engine behind every media job. */
export interface FfmpegStatus {
  installed: boolean;
  ffmpegVersion?: string | null;
  ffprobeVersion?: string | null;
  path?: string | null;
}

/** streamlink: the live-recording engine (VOD stays on yt-dlp). */
export interface StreamlinkStatus {
  installed: boolean;
  version?: string | null;
  path?: string | null;
  ffmpegFound: boolean;
  /** Whether the in-app installer supports this platform (Windows x64 only). */
  installable: boolean;
}

/** GitHub release pointer used by "检查更新": the tag plus the asset URL. */
export interface StreamlinkRelease {
  tag: string;
  url: string;
}

export interface NetOptions {
  cookiesFile?: string | null;
  cookiesText?: string | null;
  proxy?: string | null;
}

export interface DownloadRequest {
  url: string;
  quality: string; // best | 2160p | 1080p | 720p | 480p | audio
  audioFormat?: string | null; // mp3 | m4a | opus | flac (quality=audio)
  outputDir: string;
  filenameTemplate?: string | null;
  cookiesFile?: string | null;
  cookiesText?: string | null;
  proxy?: string | null;
  subtitles?: boolean;
  kind?: "download" | "record";
  maxDurationSec?: number | null;
  title?: string | null;
}

export interface DownloadProgressEvent {
  id: string;
  percent: number;
  phase: string; // running | done
  speed?: string | null;
  eta?: string | null;
  downloadedBytes?: number | null;
  totalBytes?: number | null;
  postprocessing?: boolean | null;
}

export interface DownloadDoneEvent {
  id: string;
  ok: boolean;
  cancelled: boolean;
  kind: string; // download | record
  output?: string | null;
  error?: string | null;
  limitReached?: boolean | null;
}

export interface DownloadStartedEvent {
  id: string;
  url: string;
  title: string;
  kind: string;
  pipeline?: WorkflowStepInput[];
  /** Upload targets bound to this acquisition (frontend uploads when done). */
  uploadTo?: string[];
}

export interface MonitorRequest {
  url: string;
  name?: string | null;
  intervalSec: number;
  autoRecord: boolean;
  quality: string;
  outputDir: string;
  cookiesFile?: string | null;
  cookiesText?: string | null;
  proxy?: string | null;
  pipeline?: WorkflowStepInput[];
  /** Upload targets bound to every recording of this monitor. */
  uploadTo?: string[];
}

export interface MonitorEdit {
  name?: string;
  intervalSec?: number;
  autoRecord?: boolean;
  quality?: string;
}

/** Cookies saved for one live platform, keyed by the room URL's host. */
export interface PlatformCookies {
  host: string;
  cookiesFile?: string | null;
  cookiesText?: string | null;
}

export interface MonitorInfo {
  id: string;
  url: string;
  name: string;
  intervalSec: number;
  autoRecord: boolean;
  quality: string;
  outputDir: string;
  cookiesFile?: string | null;
  cookiesText?: string | null;
  proxy?: string | null;
  status: string; // watching | recording | stopped
  title?: string | null;
  author?: string | null;
  liveStatus?: string | null; // is_live | not_live | post_live | unknown
  lastChecked?: number | null;
  currentJob?: string | null;
  pipeline: WorkflowStepInput[];
  uploadTo?: string[];
  /** Where this room's recordings land; drives the open-folder action. */
  recordDir?: string | null;
}

/* ── Upload targets & tasks ───────────────────────────────────── */

export type UploadTargetKind = "webdav" | "telegram" | "youtube" | "gdrive" | "onedrive";

interface UploadTargetBase {
  id: string;
  name: string;
  kind: UploadTargetKind;
}

export interface WebdavTarget extends UploadTargetBase {
  kind: "webdav";
  url: string;
  username: string;
  password: string;
  directory: string;
  proxy?: string;
}

export interface TelegramTarget extends UploadTargetBase {
  kind: "telegram";
  botToken: string;
  chatId: string;
  proxy?: string;
}

export interface YoutubeTarget extends UploadTargetBase {
  kind: "youtube";
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  privacy: "private" | "unlisted" | "public";
  description: string;
  proxy?: string;
}

export interface GdriveTarget extends UploadTargetBase {
  kind: "gdrive";
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  folderId: string;
  proxy?: string;
}

export interface OnedriveTarget extends UploadTargetBase {
  kind: "onedrive";
  clientId: string;
  tenant: string;
  refreshToken: string;
  directory: string;
  proxy?: string;
}

export type UploadTarget =
  | WebdavTarget
  | TelegramTarget
  | YoutubeTarget
  | GdriveTarget
  | OnedriveTarget;

export type UploadPhase = "queued" | "running" | "done" | "error" | "cancelled";

export interface UploadTask {
  id: string;
  rustId?: string;
  targetId: string;
  targetName: string;
  kind: UploadTargetKind;
  /** Everything handed to this one transfer; only Telegram groups several
   *  files into a single upload (an album), other kinds get one file each. */
  filePaths: string[];
  size: number;
  percent: number;
  phase: UploadPhase;
  error?: string | null;
  url?: string | null;
  /** Transfer rate rendered on the card (e.g. "3.2 MB/s"). */
  speed?: string | null;
  createdAt: number;
}

export interface UploadRequest {
  target: Record<string, unknown>;
  filePaths: string[];
}

export interface UploadStartResult {
  id: string;
}

export interface UploadProgressEvent {
  id: string;
  percent: number;
  uploadedBytes: number;
  totalBytes: number;
}

export interface UploadDoneEvent {
  id: string;
  ok: boolean;
  cancelled: boolean;
  error?: string | null;
  url?: string | null;
  newRefreshToken?: string | null;
}

export interface OauthBeginRequest {
  kind: "youtube" | "gdrive" | "onedrive";
  clientId: string;
  clientSecret?: string;
  tenant?: string;
  proxy?: string;
}

export interface OauthBeginResult {
  requestId: string;
  authUrl: string;
  redirectUri: string;
}

export interface OauthResultEvent {
  requestId: string;
  kind: string;
  ok: boolean;
  error?: string | null;
  refreshToken?: string | null;
}

/* ── server-side directory browsing (web mode) ──────────────────── */

export interface FsEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modified?: number | null;
}

export interface DirListing {
  path: string;
  parent?: string | null;
  entries: FsEntry[];
  truncated: boolean;
}
