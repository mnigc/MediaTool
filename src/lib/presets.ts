import type { JobParams, MediaType } from "../types";
import { blankParams } from "./defaults";

export interface Preset {
  name: string;
  mediaType: MediaType;
  params: JobParams;
  builtin?: boolean;
}

const KEY = "mediapress.presets";

const keyOf = (p: { mediaType: MediaType; name: string }) =>
  `${p.mediaType}::${p.name}`;

export const BUILTIN_PRESETS: Preset[] = [
  // 默认参数（与文件添加时的初始值一致，便于从其他预设回归）
  {
    name: "默认参数",
    mediaType: "video",
    builtin: true,
    params: { ...blankParams("video") },
  },
  {
    name: "默认参数",
    mediaType: "image",
    builtin: true,
    params: { ...blankParams("image") },
  },
  {
    name: "默认参数",
    mediaType: "audio",
    builtin: true,
    params: { ...blankParams("audio") },
  },
  // 视频
  {
    name: "高压缩 (H.264)",
    mediaType: "video",
    builtin: true,
    params: {
      videoCodec: "libx264",
      qualityMode: "crf",
      crf: 30,
      resolution: "original",
      audioCodec: "aac",
      audioBitrateKbps: 96,
      format: "mp4",
      preset: "slow",
      startTime: undefined,
      duration: undefined,
      extractAudio: false,
      extractFormat: "mp3",
    },
  },
  {
    name: "保持画质 (CRF 20)",
    mediaType: "video",
    builtin: true,
    params: {
      videoCodec: "libx264",
      qualityMode: "crf",
      crf: 20,
      resolution: "original",
      audioCodec: "aac",
      audioBitrateKbps: 192,
      format: "mp4",
      preset: "medium",
      startTime: undefined,
      duration: undefined,
      extractAudio: false,
      extractFormat: "mp3",
    },
  },
  {
    name: "社交平台 (720p)",
    mediaType: "video",
    builtin: true,
    params: {
      videoCodec: "libx264",
      qualityMode: "crf",
      crf: 26,
      resolution: "720p",
      audioCodec: "aac",
      audioBitrateKbps: 128,
      format: "mp4",
      preset: "medium",
      startTime: undefined,
      duration: undefined,
      extractAudio: false,
      extractFormat: "mp3",
    },
  },
  {
    name: "仅提取音频 (MP3)",
    mediaType: "video",
    builtin: true,
    params: {
      videoCodec: "libx264",
      qualityMode: "crf",
      crf: 28,
      resolution: "original",
      audioCodec: "aac",
      audioBitrateKbps: 128,
      format: "mp4",
      preset: "medium",
      startTime: undefined,
      duration: undefined,
        extractAudio: true,
        extractFormat: "mp3",
      },
    },
  // 社交媒体（最高画质、最小体积）
  {
    name: "YouTube 上传",
    mediaType: "video",
    builtin: true,
    params: {
      videoCodec: "libx264",
      qualityMode: "crf",
      crf: 18,
      resolution: "original",
      audioCodec: "aac",
      audioBitrateKbps: 192,
      format: "mp4",
      preset: "slow",
      startTime: undefined,
      duration: undefined,
      extractAudio: false,
      extractFormat: "mp3",
    },
  },
  {
    name: "哔哩哔哩 上传",
    mediaType: "video",
    builtin: true,
    params: {
      videoCodec: "libx264",
      qualityMode: "crf",
      crf: 20,
      resolution: "original",
      audioCodec: "aac",
      audioBitrateKbps: 192,
      format: "mp4",
      preset: "slow",
      startTime: undefined,
      duration: undefined,
      extractAudio: false,
      extractFormat: "mp3",
    },
  },
  {
    name: "抖音 上传",
    mediaType: "video",
    builtin: true,
    params: {
      videoCodec: "libx264",
      qualityMode: "crf",
      crf: 22,
      resolution: "1080p",
      audioCodec: "aac",
      audioBitrateKbps: 192,
      format: "mp4",
      preset: "slow",
      startTime: undefined,
      duration: undefined,
      extractAudio: false,
      extractFormat: "mp3",
    },
  },
  {
    name: "小红书 上传",
    mediaType: "video",
    builtin: true,
    params: {
      videoCodec: "libx264",
      qualityMode: "crf",
      crf: 22,
      resolution: "1080p",
      audioCodec: "aac",
      audioBitrateKbps: 192,
      format: "mp4",
      preset: "slow",
      startTime: undefined,
      duration: undefined,
      extractAudio: false,
      extractFormat: "mp3",
    },
  },
  {
    name: "微信视频号 上传",
    mediaType: "video",
    builtin: true,
    params: {
      videoCodec: "libx264",
      qualityMode: "crf",
      crf: 21,
      resolution: "1080p",
      audioCodec: "aac",
      audioBitrateKbps: 192,
      format: "mp4",
      preset: "slow",
      startTime: undefined,
      duration: undefined,
      extractAudio: false,
      extractFormat: "mp3",
    },
  },
  // 图片
  {
    name: "WebP 高质量",
    mediaType: "image",
    builtin: true,
    params: { format: "webp", quality: 85 },
  },
  {
    name: "WebP 压缩",
    mediaType: "image",
    builtin: true,
    params: { format: "webp", quality: 60 },
  },
  {
    name: "JPEG 小图",
    mediaType: "image",
    builtin: true,
    params: { format: "jpeg", quality: 70 },
  },
  {
    name: "限制 1920 宽",
    mediaType: "image",
    builtin: true,
    params: { format: "webp", quality: 80, maxDimension: 1920 },
  },
  // 音频
  {
    name: "MP3 标准",
    mediaType: "audio",
    builtin: true,
    params: { format: "mp3", bitrateKbps: 128 },
  },
  {
    name: "MP3 高质",
    mediaType: "audio",
    builtin: true,
    params: { format: "mp3", bitrateKbps: 256 },
  },
  {
    name: "AAC 高效",
    mediaType: "audio",
    builtin: true,
    params: { format: "aac", bitrateKbps: 96 },
  },
  {
    name: "FLAC 无损",
    mediaType: "audio",
    builtin: true,
    params: { format: "flac", bitrateKbps: 128 },
  },
];

function loadCustoms(): Preset[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Preset[]) : [];
  } catch {
    return [];
  }
}

export function loadPresets(): Preset[] {
  const byKey = new Map<string, Preset>();
  for (const p of BUILTIN_PRESETS) byKey.set(keyOf(p), { ...p, builtin: true });
  for (const p of loadCustoms()) byKey.set(keyOf(p), { ...p, builtin: false });
  return [...byKey.values()];
}

function saveCustoms(customs: Preset[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(customs));
  } catch {
    // ignore quota / serialization errors
  }
}

export function addPreset(preset: Preset): Preset[] {
  const customs = loadCustoms().filter(
    (p) => !(p.mediaType === preset.mediaType && p.name === preset.name)
  );
  customs.push({ ...preset, builtin: false });
  saveCustoms(customs);
  return loadPresets();
}

export function removePreset(mediaType: MediaType, name: string): Preset[] {
  const customs = loadCustoms().filter(
    (p) => !(p.mediaType === mediaType && p.name === name)
  );
  saveCustoms(customs);
  return loadPresets();
}

export function blankPreset(mediaType: MediaType): Preset {
  return { name: "", mediaType, params: blankParams(mediaType), builtin: false };
}
