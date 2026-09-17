import { useSyncExternalStore } from "react";
import type { JobParams } from "../types";
import { defaultParamsFor } from "./defaults";
import { readStorage, writeStorage } from "./storage";

export interface Preset {
  name: string;
  /** Tool this preset belongs to; presets are scoped per tool. */
  toolId: string;
  params: JobParams;
  builtin?: boolean;
  /** True when a builtin preset has been edited by the user, i.e. its params
   *  shadow the factory defaults until it is restored. */
  modified?: boolean;
}

const KEY = "mediatool.presets";
/** Builtin-preset edits live separate from custom presets so a modified
 *  default can be reverted to its factory values with one click. */
const OVERRIDE_KEY = "mediatool.presetOverrides";

const keyOf = (p: { toolId: string; name: string }) => `${p.toolId}::${p.name}`;

/** Map builtin preset names (stored as stable Chinese identifiers) to i18n
 *  keys, so builtin preset labels follow the active UI language. Custom
 *  presets keep the name the user typed. */
const BUILTIN_NAME_KEYS: Record<string, string> = {
  "默认参数": "preset.p_default",
  "高压缩 (H.264)": "preset.p_high_h264",
  "社交平台 720p": "preset.p_social_720",
  "高压缩 (AV1)": "preset.p_high_av1",
  "目标大小 10MB": "preset.p_size_10mb",
  "MP3 128k": "preset.p_mp3_128",
  "MP3 96k 极限压缩": "preset.p_mp3_96",
  "高质量 90": "preset.p_q90",
  "小文件 60": "preset.p_small_60",
  "限制 1920 宽": "preset.p_max_1920",
  "MP3 192k": "preset.p_mp3_192",
  "AAC 128k": "preset.p_aac_128",
  "FLAC 无损": "preset.p_flac",
  /* ── 视频平台 ── */
  "抖音竖版": "preset.p_douyin",
  "微信视频": "preset.p_wechat_v",
  "B站 1080p": "preset.p_bilibili",
  "YouTube 1080p": "preset.p_youtube",
  "Instagram": "preset.p_instagram",
  "WhatsApp": "preset.p_whatsapp",
  /* ── 水印 ── */
  "右上角Logo": "preset.p_wm_topright",
  /* ── 提取音频 ── */
  "手机听歌 MP3 128k": "preset.p_pocket_mp3",
  "省空间 AAC 96k": "preset.p_small_aac",
};

/** Localized display name for a preset. Builtin presets resolve through i18n;
 *  custom presets render their stored name verbatim. */
export function presetDisplayName(
  p: Preset,
  t: (key: string) => string
): string {
  if (p.builtin) {
    const key = BUILTIN_NAME_KEYS[p.name];
    if (key) return t(key);
  }
  return p.name;
}

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
  // ── 视频压缩 · 平台场景 ────────────────────────
  {
    name: "抖音竖版",
    toolId: "video-compress",
    builtin: true,
    params: {
      videoCodec: "libx264",
      qualityMode: "crf",
      crf: 24,
      resolution: "1080p",
      audioCodec: "aac",
      audioBitrateKbps: 128,
      format: "mp4",
      preset: "fast",
      fps: 30,
    },
  },
  {
    name: "微信视频",
    toolId: "video-compress",
    builtin: true,
    params: {
      videoCodec: "libx264",
      qualityMode: "crf",
      crf: 26,
      resolution: "720p",
      audioCodec: "aac",
      audioBitrateKbps: 96,
      format: "mp4",
      preset: "medium",
      fps: 30,
    },
  },
  {
    name: "B站 1080p",
    toolId: "video-compress",
    builtin: true,
    params: {
      videoCodec: "libx264",
      qualityMode: "crf",
      crf: 20,
      resolution: "1080p",
      audioCodec: "aac",
      audioBitrateKbps: 192,
      format: "mp4",
      preset: "medium",
      fps: 30,
    },
  },
  {
    name: "YouTube 1080p",
    toolId: "video-compress",
    builtin: true,
    params: {
      videoCodec: "libx264",
      qualityMode: "crf",
      crf: 20,
      resolution: "1080p",
      audioCodec: "aac",
      audioBitrateKbps: 192,
      format: "mp4",
      preset: "medium",
      fps: 60,
    },
  },
  {
    name: "Instagram",
    toolId: "video-compress",
    builtin: true,
    params: {
      videoCodec: "libx264",
      qualityMode: "crf",
      crf: 22,
      resolution: "1080p",
      audioCodec: "aac",
      audioBitrateKbps: 128,
      format: "mp4",
      preset: "medium",
      fps: 30,
    },
  },
  {
    name: "WhatsApp",
    toolId: "video-compress",
    builtin: true,
    params: {
      videoCodec: "libx264",
      qualityMode: "crf",
      crf: 28,
      resolution: "480p",
      audioCodec: "aac",
      audioBitrateKbps: 96,
      format: "mp4",
      preset: "medium",
      fps: 30,
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
  // ── 视频水印 · 布局场景 ────────────────────────
  {
    name: "右上角Logo",
    toolId: "watermark",
    builtin: true,
    params: { position: "tr", scalePercent: 12, opacity: 0.9, marginPercent: 3 },
  },
  {
    name: "底部版权条",
    toolId: "watermark",
    builtin: true,
    params: { position: "bc", scalePercent: 15, opacity: 0.8, marginPercent: 3 },
  },
  {
    name: "居中半透明",
    toolId: "watermark",
    builtin: true,
    params: { position: "mc", scalePercent: 20, opacity: 0.5, marginPercent: 3 },
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
  {
    name: "手机听歌 MP3 128k",
    toolId: "extract-audio",
    builtin: true,
    params: { format: "mp3", bitrateKbps: 128 },
  },
  {
    name: "省空间 AAC 96k",
    toolId: "extract-audio",
    builtin: true,
    params: { format: "aac", bitrateKbps: 96 },
  },
];

function loadCustoms(): Preset[] {
  try {
    const raw = readStorage(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Preset[]) : [];
  } catch {
    return [];
  }
}

function saveCustoms(customs: Preset[]): void {
  writeStorage(KEY, JSON.stringify(customs));
}

function loadOverrides(): Preset[] {
  try {
    const raw = readStorage(OVERRIDE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Preset[]) : [];
  } catch {
    return [];
  }
}

function saveOverrides(overrides: Preset[]): void {
  writeStorage(OVERRIDE_KEY, JSON.stringify(overrides));
}

export function loadPresets(): Preset[] {
  const byKey = new Map<string, Preset>();
  for (const p of BUILTIN_PRESETS) byKey.set(keyOf(p), { ...p });
  for (const o of loadOverrides()) {
    const base = byKey.get(keyOf(o));
    if (base?.builtin) {
      byKey.set(keyOf(o), { ...base, params: o.params, modified: true });
    }
  }
  for (const p of loadCustoms()) byKey.set(keyOf(p), { ...p, builtin: false, modified: false });
  return [...byKey.values()];
}

/* ── Global preset store ─────────────────────────────────────────
 * Presets used to be loaded once per component, so a preset saved on one job
 * card was invisible on the others (and vice versa for deletions) until each
 * component remounted. Everything now shares one subscribable snapshot. */
let cache: Preset[] | null = null;
const listeners = new Set<() => void>();

function snapshot(): Preset[] {
  if (!cache) cache = loadPresets();
  return cache;
}

function refresh(): Preset[] {
  cache = loadPresets();
  for (const fn of listeners) fn();
  return cache;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Reactive preset list shared by every consumer (preset bars, manager,
 *  presets page). Always in sync across components. */
export function usePresets(): Preset[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Persist edited params for a builtin preset (keeping its builtin identity)
 *  so it shows up as a modified default and can be restored later. */
export function saveBuiltinOverride(toolId: string, name: string, params: JobParams): Preset[] {
  const overrides = loadOverrides().filter(
    (o) => !(o.toolId === toolId && o.name === name)
  );
  overrides.push({ toolId, name, params });
  saveOverrides(overrides);
  return refresh();
}

/** Drop a builtin-preset override, reverting to its factory defaults. */
export function restoreBuiltin(toolId: string, name: string): Preset[] {
  saveOverrides(loadOverrides().filter((o) => !(o.toolId === toolId && o.name === name)));
  return refresh();
}

export function addPreset(preset: Preset): Preset[] {
  const customs = loadCustoms().filter(
    (p) => !(p.toolId === preset.toolId && p.name === preset.name)
  );
  customs.push({ ...preset, builtin: false });
  saveCustoms(customs);
  return refresh();
}

export function removePreset(toolId: string, name: string): Preset[] {
  const customs = loadCustoms().filter(
    (p) => !(p.toolId === toolId && p.name === name)
  );
  saveCustoms(customs);
  return refresh();
}
