import { useSyncExternalStore } from "react";
import type {
  AudioParams,
  ContactSheetParams,
  ExtractAudioParams,
  JobParams,
  ToolId,
  VideoParams,
  WatermarkParams,
} from "../types";
import { defaultParamsFor } from "./defaults";
import { readStorage, writeStorage } from "./storage";
import { CRF } from "./quality";

export interface Preset {
  name: string;
  /** Tool this preset belongs to; presets are scoped per tool. */
  toolId: string;
  params: JobParams;
  builtin?: boolean;
  /** True when a builtin preset has been edited by the user, i.e. its params
   *  shadow the factory defaults until it is restored. */
  modified?: boolean;
  /** ms epoch of the last apply; drives the most-recently-used ordering. */
  lastUsed?: number;
  /** Builtin preset the user can neither edit nor delete (e.g. the preset
   *  that mirrors the tool defaults). */
  locked?: boolean;
}

const KEY = "mediatool.presets";
/** Builtin-preset edits live separate from custom presets so a modified
 *  default can be reverted to its factory values with one click. */
const OVERRIDE_KEY = "mediatool.presetOverrides";
/** toolId::name -> last-applied timestamp (ms epoch). */
const USAGE_KEY = "mediatool.presetUsage";

const keyOf = (p: { toolId: string; name: string }) => `${p.toolId}::${p.name}`;

/** Encoder ids as users know them (summaries/tooltips), not ffmpeg names. */
const CODEC_LABEL: Record<string, string> = {
  libx264: "H.264",
  libx265: "H.265",
  "libvpx-vp9": "VP9",
  libsvtav1: "AV1",
};

/** Map builtin preset names (stored as stable Chinese identifiers) to i18n
 *  keys, so builtin preset labels follow the active UI language. Custom
 *  presets keep the name the user typed. */
const BUILTIN_NAME_KEYS: Record<string, string> = {
  "均衡通用": "preset.p_balanced",
  "高压缩 (H.264)": "preset.p_high_h264",
  "视觉无损": "preset.p_vlossless",
  "社交平台 720p": "preset.p_social_720",
  "高压缩 (AV1)": "preset.p_high_av1",
  "高质量 1080p": "preset.p_hq_1080",
  "降码率 128k": "preset.p_bitrate_128",
  "极限 96k": "preset.p_bitrate_96",
  "转 MP3 192k": "preset.p_to_mp3_192",
  "MP3 192k": "preset.p_mp3_192",
  "AAC 128k": "preset.p_aac_128",
  "FLAC 无损": "preset.p_flac",
  /* ── 视频压缩 · 平台场景 ── */
  "抖音竖版": "preset.p_douyin",
  "WhatsApp": "preset.p_whatsapp",
  /* ── 水印 ── */
  "右上角Logo": "preset.p_wm_topright",
  "底部版权条": "preset.p_wm_bottom",
  "居中半透明": "preset.p_wm_center",
  /* ── 雪碧图 ── */
  "播放器预览": "preset.p_player_preview",
};

/* ── Preset apply / compare semantics ────────────────────────────────
 * Builtin presets are authored as small diffs on top of the tool defaults;
 * they are materialized into full param objects when loaded, so applying a
 * preset REPLACES the whole encode state instead of shallow-merging over
 * whatever the panel currently holds (which used to leak stale fields and
 * forced every preset to enumerate all fields defensively). */

/** Fields a preset never owns — they describe the user's current input, not
 *  encode settings, so applying a preset must leave them untouched. */
const IDENTITY_FIELDS: Record<string, string[]> = {
  watermark: ["imagePath"],
};

/** Overlay `params` on the tool defaults and drop identity fields, producing
 *  the full param object a (possibly sparse) preset stands for. */
export function materializePresetParams(toolId: string, params: object): JobParams {
  const merged: Record<string, unknown> = {
    ...(defaultParamsFor(toolId as ToolId) as Record<string, unknown>),
    ...(params as Record<string, unknown>),
  };
  for (const f of IDENTITY_FIELDS[toolId] ?? []) delete merged[f];
  return merged as JobParams;
}

/** Full params for applying a preset: keep the current identity fields, then
 *  lay the materialized preset over the (reset) defaults. */
export function applyPresetParams(
  toolId: string,
  current: JobParams,
  presetParams: object
): JobParams {
  const identity = pickIdentity(toolId, current);
  return { ...identity, ...materializePresetParams(toolId, presetParams) } as JobParams;
}

function pickIdentity(toolId: string, params: JobParams): Record<string, unknown> {
  const src = params as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const f of IDENTITY_FIELDS[toolId] ?? []) {
    if (src[f] !== undefined) out[f] = src[f];
  }
  return out;
}

/** Shallow equality ignoring identity fields, treating missing keys and
 *  undefined alike. Used to un-highlight the selected preset chip once the
 *  panel has drifted away from it. */
export function presetParamsEqual(toolId: string, a: JobParams, b: JobParams): boolean {
  const strip = (p: JobParams) => {
    const c = { ...(p as Record<string, unknown>) };
    for (const f of IDENTITY_FIELDS[toolId] ?? []) delete c[f];
    return c;
  };
  const x = strip(a);
  const y = strip(b);
  for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
    if ((x[k] ?? undefined) !== (y[k] ?? undefined)) return false;
  }
  return true;
}

/* ── Shared encode recipes ───────────────────────────────────────────
 * Single source of truth for the builtin preset and the download/record
 * pipeline of the same intent, so the two can never drift apart. */

/** Visually lossless: crf 18 + slow is the accepted visually-lossless tier;
 *  audio is copied so re-encoding never degrades it. */
export const VLOSSLESS_VIDEO_PARAMS: VideoParams = {
  videoCodec: "libx264",
  qualityMode: "crf",
  crf: CRF.vlossless,
  resolution: "original",
  audioCodec: "copy",
  format: "source",
  preset: "slow",
  fps: undefined,
};

/** Player-preview contact sheet: 50 stills in a 10-wide grid. */
export const PLAYER_PREVIEW_CONTACT_PARAMS: ContactSheetParams = {
  mode: "count",
  interval: 5,
  count: 50,
  countCols: 10,
  cols: 10,
  rows: 10,
  thumbW: 160,
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

/** One-line human summary of what a preset sets (chip tooltip). */
export function presetSummary(
  p: Preset,
  t: (key: string, vars?: Record<string, string | number>) => string
): string {
  const q = p.params as Record<string, unknown>;
  const parts: string[] = [];
  const kbps = (n: unknown) => (n === undefined || n === null ? "" : `${n}k`);
  switch (p.toolId) {
    case "video-compress": {
      if (q.format && q.format !== "source") parts.push(String(q.format).toUpperCase());
      if (q.videoCodec && q.videoCodec !== "copy") {
        parts.push(CODEC_LABEL[String(q.videoCodec)] ?? String(q.videoCodec));
      }
      if (q.videoCodec === "copy") {
        parts.push(t("preset.sum.streamCopy"));
      } else {
        if (q.qualityMode === "target_size") {
          parts.push(t("preset.sum.targetMb", { n: Number(q.targetSizeMb) }));
        } else if (q.qualityMode === "bitrate") {
          parts.push(t("preset.sum.kbps", { n: Number(q.videoBitrateKbps) }));
        } else {
          parts.push(`CRF ${q.crf ?? CRF.compact}`);
        }
        if (q.resolution && q.resolution !== "original") parts.push(String(q.resolution));
        if (q.preset && q.preset !== "medium") parts.push(String(q.preset));
      }
      if (q.audioCodec === "copy") parts.push(t("preset.sum.audioCopy"));
      else if (q.audioCodec === "none") parts.push(t("preset.sum.audioNone"));
      else if (q.audioCodec) parts.push(`${String(q.audioCodec).toUpperCase()} ${kbps(q.audioBitrateKbps)}`.trim());
      break;
    }
    case "audio-compress": {
      parts.push(
        q.format === "source"
          ? `${kbps(q.bitrateKbps)}`
          : `${String(q.format).toUpperCase()} ${kbps(q.bitrateKbps)}`.trim()
      );
      break;
    }
    case "extract-audio": {
      parts.push(
        q.format === "flac"
          ? "FLAC"
          : `${String(q.format).toUpperCase()} ${kbps(q.bitrateKbps)}`.trim()
      );
      break;
    }
    case "watermark": {
      if (q.position) parts.push(t(`opt.pos.${q.position}`));
      if (q.scalePercent !== undefined) parts.push(`${q.scalePercent}%`);
      if (q.opacity !== undefined) parts.push(`${Math.round(Number(q.opacity) * 100)}%`);
      break;
    }
    case "video-contact": {
      parts.push(
        q.mode === "count" ? `${q.count} × ${q.thumbW}px` : `${q.interval}s × ${q.thumbW}px`
      );
      break;
    }
  }
  return parts.filter(Boolean).join(" · ");
}

/** Authored form of a builtin preset: a sparse diff over `defaultParamsFor
 *  (toolId)` — only fields that deviate from the defaults are listed.
 *  `loadPresets` materializes them into full param objects. */
type SparseToolParams = Partial<
  VideoParams &
    AudioParams &
    WatermarkParams &
    ContactSheetParams &
    ExtractAudioParams
>;
type BuiltinPreset = Omit<Preset, "params"> & { params: SparseToolParams };

export const BUILTIN_PRESETS: BuiltinPreset[] = [
  // ── 视频压缩 ──────────────────────────────
  {
    name: "均衡通用",
    toolId: "video-compress",
    builtin: true,
    locked: true,
    // Same values as the tool defaults (CRF 23 = x264's own default, the
    // quality/size sweet spot); kept as an explicit preset so it shows up
    // in the preset list and can be applied like any other, but locked:
    // editing it would break its equivalence with the defaults.
    params: {
      qualityMode: "crf",
      crf: CRF.balanced,
      audioBitrateKbps: 128,
    },
  },
  {
    name: "高压缩 (H.264)",
    toolId: "video-compress",
    builtin: true,
    params: {
      qualityMode: "crf",
      crf: CRF.extreme,
      audioBitrateKbps: 96,
      preset: "slow",
    },
  },
  {
    name: "视觉无损",
    toolId: "video-compress",
    builtin: true,
    params: { ...VLOSSLESS_VIDEO_PARAMS },
  },
  {
    name: "高质量 1080p",
    toolId: "video-compress",
    builtin: true,
    params: {
      qualityMode: "crf",
      crf: CRF.high,
      resolution: "1080p",
      audioBitrateKbps: 192,
      format: "mp4",
    },
  },
  {
    name: "社交平台 720p",
    toolId: "video-compress",
    builtin: true,
    params: {
      qualityMode: "crf",
      crf: CRF.social,
      resolution: "720p",
      audioBitrateKbps: 128,
      format: "mp4",
    },
  },
  {
    name: "高压缩 (AV1)",
    toolId: "video-compress",
    builtin: true,
    // AV1 needs a higher CRF than H.264 for the same size, so an explicit
    // value instead of a shared tier. It only muxes safely into modern
    // containers; "source" would break on avi/wmv/flv inputs.
    params: {
      videoCodec: "libsvtav1",
      qualityMode: "crf",
      crf: 32,
      audioCodec: "opus",
      audioBitrateKbps: 128,
      format: "mkv",
    },
  },
  // ── 视频压缩 · 平台场景 ────────────────────────
  {
    name: "抖音竖版",
    toolId: "video-compress",
    builtin: true,
    // Resolution presets scale by height, which undersizes vertical sources
    // (9:16 @ "1080p" → 608x1080), so keep the source dimensions.
    params: {
      qualityMode: "crf",
      crf: CRF.social,
      format: "mp4",
      preset: "fast",
    },
  },
  {
    name: "WhatsApp",
    toolId: "video-compress",
    builtin: true,
    params: {
      qualityMode: "crf",
      crf: CRF.compact,
      resolution: "480p",
      audioBitrateKbps: 96,
      format: "mp4",
      fps: 30,
    },
  },
  // ── 音频压缩（保持格式降码率）───────────────
  {
    name: "降码率 128k",
    toolId: "audio-compress",
    builtin: true,
    params: { format: "source", bitrateKbps: 128 },
  },
  {
    name: "极限 96k",
    toolId: "audio-compress",
    builtin: true,
    params: { format: "source", bitrateKbps: 96 },
  },
  {
    name: "转 MP3 192k",
    toolId: "audio-compress",
    builtin: true,
    params: { format: "mp3", bitrateKbps: 192 },
  },
  // ── 视频水印 · 布局场景 ────────────────────────
  {
    name: "右上角Logo",
    toolId: "watermark",
    builtin: true,
    params: { position: "tr", scalePercent: 12, opacity: 0.9 },
  },
  {
    name: "底部版权条",
    toolId: "watermark",
    builtin: true,
    params: { position: "bc", scalePercent: 15, opacity: 0.8 },
  },
  {
    name: "居中半透明",
    toolId: "watermark",
    builtin: true,
    params: { position: "mc", scalePercent: 20, opacity: 0.5 },
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
    // bitrateKbps is required by the job schema but ignored for flac; it is
    // filled in by materialization from the tool defaults.
    params: { format: "flac" },
  },
  // ── 雪碧图 ────────────────────────────────
  {
    name: "播放器预览",
    toolId: "video-contact",
    builtin: true,
    params: { ...PLAYER_PREVIEW_CONTACT_PARAMS },
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

function loadUsage(): Record<string, number> {
  try {
    const raw = readStorage(USAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function stampUsage(key: string): void {
  const usage = loadUsage();
  usage[key] = Date.now();
  writeStorage(USAGE_KEY, JSON.stringify(usage));
}

/** Mark a preset as just applied so it sorts ahead of unused ones. */
export function recordPresetUsage(toolId: string, name: string): void {
  stampUsage(keyOf({ toolId, name }));
  refresh();
}

export function loadPresets(): Preset[] {
  const byKey = new Map<string, Preset>();
  for (const p of BUILTIN_PRESETS) {
    byKey.set(keyOf(p), { ...p, params: materializePresetParams(p.toolId, p.params) });
  }
  for (const o of loadOverrides()) {
    const base = byKey.get(keyOf(o));
    if (base?.builtin) {
      byKey.set(keyOf(o), { ...base, params: o.params, modified: true });
    }
  }
  for (const p of loadCustoms()) byKey.set(keyOf(p), { ...p, builtin: false, modified: false });
  const list = [...byKey.values()];
  const usage = loadUsage();
  for (const p of list) p.lastUsed = usage[keyOf(p)];
  // Custom presets are what users actually re-apply, so they lead the bars
  // (most recently used first); builtins keep their authored order.
  list.sort((a, b) => {
    if (a.builtin !== b.builtin) return a.builtin ? 1 : -1;
    if (!a.builtin) return (b.lastUsed ?? 0) - (a.lastUsed ?? 0);
    return 0;
  });
  return list;
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
  const base = BUILTIN_PRESETS.find((b) => b.toolId === toolId && b.name === name);
  if (base?.locked) return refresh();
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
  stampUsage(keyOf(preset));
  return refresh();
}

export function hasCustomPreset(toolId: string, name: string): boolean {
  return loadCustoms().some((p) => p.toolId === toolId && p.name === name);
}

/** Update a custom preset in place, optionally renaming it. The usage stamp
 *  travels with the preset so a rename keeps its most-recently-used slot. */
export function saveCustomPreset(
  toolId: string,
  origName: string,
  next: { name: string; params: JobParams }
): Preset[] {
  const customs = loadCustoms().filter(
    (p) => !(p.toolId === toolId && (p.name === origName || p.name === next.name))
  );
  customs.push({ toolId, name: next.name, params: next.params, builtin: false });
  saveCustoms(customs);
  const origKey = keyOf({ toolId, name: origName });
  if (origName !== next.name) {
    const usage = loadUsage();
    if (usage[origKey] !== undefined) {
      delete usage[origKey];
      usage[keyOf({ toolId, name: next.name })] = Date.now();
      writeStorage(USAGE_KEY, JSON.stringify(usage));
    }
  }
  return refresh();
}

export function removePreset(toolId: string, name: string): Preset[] {
  const customs = loadCustoms().filter(
    (p) => !(p.toolId === toolId && p.name === name)
  );
  saveCustoms(customs);
  return refresh();
}
