import type { JobParams } from "../types";
import { defaultParamsFor } from "./defaults";

export interface Preset {
  name: string;
  /** Tool this preset belongs to; presets are scoped per tool. */
  toolId: string;
  params: JobParams;
  builtin?: boolean;
}

const KEY = "mediapress.presets";

const keyOf = (p: { toolId: string; name: string }) => `${p.toolId}::${p.name}`;

export const BUILTIN_PRESETS: Preset[] = [
  // ── 视频压缩 ──────────────────────────────
  {
    name: "默认参数",
    toolId: "video-compress",
    builtin: true,
    params: { ...defaultParamsFor("video-compress") },
  },
  {
    name: "高压缩 (H.264)",
    toolId: "video-compress",
    builtin: true,
    params: {
      videoCodec: "libx264",
      qualityMode: "crf",
      crf: 30,
      resolution: "original",
      audioCodec: "aac",
      audioBitrateKbps: 96,
      format: "source",
      preset: "slow",
      fps: undefined,
    },
  },
  {
    name: "社交平台 720p",
    toolId: "video-compress",
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
      fps: undefined,
    },
  },
  {
    name: "高压缩 (AV1)",
    toolId: "video-compress",
    builtin: true,
    params: {
      videoCodec: "libsvtav1",
      qualityMode: "crf",
      crf: 32,
      resolution: "original",
      audioCodec: "opus",
      audioBitrateKbps: 128,
      format: "source",
      preset: "medium",
      fps: undefined,
    },
  },
  {
    name: "目标大小 10MB",
    toolId: "video-compress",
    builtin: true,
    params: {
      videoCodec: "libx264",
      qualityMode: "target_size",
      crf: undefined,
      targetSizeMb: 10,
      resolution: "original",
      audioCodec: "aac",
      audioBitrateKbps: 128,
      format: "source",
      preset: "medium",
      fps: undefined,
    },
  },
  // ── 音频压缩（保持格式降码率）───────────────
  {
    name: "默认参数",
    toolId: "audio-compress",
    builtin: true,
    params: { ...defaultParamsFor("audio-compress") },
  },
  {
    name: "MP3 128k",
    toolId: "audio-compress",
    builtin: true,
    params: { format: "source", bitrateKbps: 128 },
  },
  {
    name: "MP3 96k 极限压缩",
    toolId: "audio-compress",
    builtin: true,
    params: { format: "source", bitrateKbps: 96 },
  },
  // ── 图片压缩（保持原格式）──────────────────
  {
    name: "默认参数",
    toolId: "image-compress",
    builtin: true,
    params: { ...defaultParamsFor("image-compress") },
  },
  {
    name: "高质量 90",
    toolId: "image-compress",
    builtin: true,
    params: { format: "source", quality: 90, maxDimension: undefined },
  },
  {
    name: "小文件 60",
    toolId: "image-compress",
    builtin: true,
    params: { format: "source", quality: 60, maxDimension: undefined },
  },
  {
    name: "限制 1920 宽",
    toolId: "image-compress",
    builtin: true,
    params: { format: "source", quality: 80, maxDimension: 1920 },
  },
  // ── 提取音频 ──────────────────────────────
  {
    name: "MP3 192k",
    toolId: "extract-audio",
    builtin: true,
    params: { format: "mp3", bitrateKbps: 192 },
  },
  {
    name: "AAC 128k",
    toolId: "extract-audio",
    builtin: true,
    params: { format: "aac", bitrateKbps: 128 },
  },
  {
    name: "FLAC 无损",
    toolId: "extract-audio",
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
    (p) => !(p.toolId === preset.toolId && p.name === preset.name)
  );
  customs.push({ ...preset, builtin: false });
  saveCustoms(customs);
  return loadPresets();
}

export function removePreset(toolId: string, name: string): Preset[] {
  const customs = loadCustoms().filter(
    (p) => !(p.toolId === toolId && p.name === name)
  );
  saveCustoms(customs);
  return loadPresets();
}
