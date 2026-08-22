export type MediaType = "video" | "image" | "audio" | "unknown";

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
  videoCodec: string; // libx264 | libvpx-vp9 | copy
  qualityMode: string; // crf | target_size | bitrate
  crf?: number;
  targetSizeMb?: number;
  videoBitrateKbps?: number;
  resolution: string; // original | 720p | ...
  audioCodec: string; // aac | opus | copy | none
  audioBitrateKbps?: number;
  format: string; // mp4 | mkv | webm | mov
  preset: string;
}

export interface ImageParams {
  format: string; // jpeg | png | webp | avif
  quality: number; // 1..100
  maxDimension?: number;
}

export interface AudioParams {
  format: string; // mp3 | aac | m4a | opus | flac
  bitrateKbps: number;
}

export type JobParams = VideoParams | ImageParams | AudioParams;

export interface JobRequest {
  input: string;
  outputDir?: string;
  mediaType: MediaType;
  params: JobParams;
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
  output?: string | null;
  error?: string | null;
  inputSize: number;
  outputSize?: number | null;
}

export interface Job {
  uiId: string;
  info: MediaInfo;
  params: JobParams;
  rustId?: string;
  percent: number;
  phase: "queued" | "running" | "done" | "error" | "cancelled";
  output?: string | null;
  error?: string | null;
  outputSize?: number | null;
}
