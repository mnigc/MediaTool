import type { JobParams } from "../types";
import { defaultParamsFor } from "./defaults";
import { readStorage, writeStorage } from "./storage";

export interface Preset {
  name: string;
  /** Tool this preset belongs to; presets are scoped per tool. */
  toolId: string;
  params: JobParams;
  builtin?: boolean;
}

const KEY = "mediatool.presets";

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
  /* ── 图片裁切/缩放 ── */
  "一寸证件照": "preset.p_id_1z",
  "二寸证件照": "preset.p_id_2z",
  "小一寸证件照": "preset.p_id_small",
  "大一寸证件照": "preset.p_id_big",
  "身份证照": "preset.p_id_card",
  "小红书竖版": "preset.p_xhs",
  "电影宽幅": "preset.p_cinema",
  "微信头像": "preset.p_avatar_640",
  "公众号封面": "preset.p_cover_900",
  "电商主图": "preset.p_shop_800",
  "手机壁纸": "preset.p_wallpaper_1080",
  /* ── GIF ── */
  "微信表情包": "preset.p_gif_wechat",
  "QQ表情": "preset.p_gif_qq",
  "论坛签名": "preset.p_gif_forum",
  "高清动图": "preset.p_gif_hd",
  /* ── 图片调色 ── */
  "自动美白": "preset.p_adj_whiten",
  "冷色调": "preset.p_adj_cool",
  "暖色调": "preset.p_adj_warm",
  "复古": "preset.p_adj_retro",
  "黑白": "preset.p_adj_bw",
  "鲜艳": "preset.p_adj_vivid",
  /* ── 水印 ── */
  "底部版权水印": "preset.p_wm_copyright",
  "居中半透明": "preset.p_wm_center",
  "角落防搬运": "preset.p_wm_corner",
  "右上角Logo": "preset.p_wm_topright",
  /* ── 图片压缩 ── */
  "微信分享": "preset.p_wechat_share",
  "网页用途": "preset.p_web_img",
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
  // ── 视频裁剪 · 平台比例 ────────────────────────
  {
    name: "小红书竖版",
    toolId: "video-crop",
    builtin: true,
    params: { mode: "center", aspect: "3:4" },
  },
  {
    name: "电影宽幅",
    toolId: "video-crop",
    builtin: true,
    params: { mode: "center", aspect: "21:9" },
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
  {
    name: "微信分享",
    toolId: "image-compress",
    builtin: true,
    params: { format: "source", quality: 70, maxDimension: undefined },
  },
  {
    name: "网页用途",
    toolId: "image-compress",
    builtin: true,
    params: { format: "source", quality: 82, maxDimension: 1920 },
  },
  // ── 图片裁切 · 证件照/平台比例 ────────────────
  {
    name: "一寸证件照",
    toolId: "image-crop",
    builtin: true,
    params: { mode: "center", aspect: "295:413" },
  },
  {
    name: "二寸证件照",
    toolId: "image-crop",
    builtin: true,
    params: { mode: "center", aspect: "413:579" },
  },
  {
    name: "身份证照",
    toolId: "image-crop",
    builtin: true,
    params: { mode: "center", aspect: "358:441" },
  },
  {
    name: "小红书竖版",
    toolId: "image-crop",
    builtin: true,
    params: { mode: "center", aspect: "3:4" },
  },
  {
    name: "电影宽幅",
    toolId: "image-crop",
    builtin: true,
    params: { mode: "center", aspect: "21:9" },
  },
  // ── 图片缩放 · 常用尺寸 ────────────────────────
  {
    name: "一寸证件照",
    toolId: "image-resize",
    builtin: true,
    params: { mode: "exact", width: 295, height: 413 },
  },
  {
    name: "二寸证件照",
    toolId: "image-resize",
    builtin: true,
    params: { mode: "exact", width: 413, height: 579 },
  },
  {
    name: "小一寸证件照",
    toolId: "image-resize",
    builtin: true,
    params: { mode: "exact", width: 260, height: 378 },
  },
  {
    name: "大一寸证件照",
    toolId: "image-resize",
    builtin: true,
    params: { mode: "exact", width: 389, height: 566 },
  },
  {
    name: "微信头像",
    toolId: "image-resize",
    builtin: true,
    params: { mode: "longest", width: 640 },
  },
  {
    name: "公众号封面",
    toolId: "image-resize",
    builtin: true,
    params: { mode: "longest", width: 900 },
  },
  {
    name: "电商主图",
    toolId: "image-resize",
    builtin: true,
    params: { mode: "exact", width: 800, height: 800 },
  },
  {
    name: "手机壁纸",
    toolId: "image-resize",
    builtin: true,
    params: { mode: "longest", width: 1080 },
  },
  // ── 转 GIF · 平台尺寸 ──────────────────────────
  {
    name: "微信表情包",
    toolId: "gif",
    builtin: true,
    params: { startTime: undefined, duration: undefined, fps: 10, width: 240 },
  },
  {
    name: "QQ表情",
    toolId: "gif",
    builtin: true,
    params: { startTime: undefined, duration: undefined, fps: 12, width: 320 },
  },
  {
    name: "论坛签名",
    toolId: "gif",
    builtin: true,
    params: { startTime: undefined, duration: undefined, fps: 12, width: 480 },
  },
  {
    name: "高清动图",
    toolId: "gif",
    builtin: true,
    params: { startTime: undefined, duration: undefined, fps: 20, width: 720 },
  },
  // ── 图片调色 · 风格滤镜 ────────────────────────
  {
    name: "自动美白",
    toolId: "image-adjust",
    builtin: true,
    params: { brightness: 0.12, contrast: 1.1, saturation: 0.9 },
  },
  {
    name: "冷色调",
    toolId: "image-adjust",
    builtin: true,
    params: { brightness: 0, contrast: 1.1, saturation: 0.8 },
  },
  {
    name: "暖色调",
    toolId: "image-adjust",
    builtin: true,
    params: { brightness: 0.06, contrast: 1.05, saturation: 1.2 },
  },
  {
    name: "复古",
    toolId: "image-adjust",
    builtin: true,
    params: { brightness: -0.05, contrast: 0.9, saturation: 0.6 },
  },
  {
    name: "黑白",
    toolId: "image-adjust",
    builtin: true,
    params: { brightness: 0, contrast: 1.15, saturation: 0 },
  },
  {
    name: "鲜艳",
    toolId: "image-adjust",
    builtin: true,
    params: { brightness: 0, contrast: 1.1, saturation: 1.5 },
  },
  // ── 图片水印 · 布局场景 ────────────────────────
  {
    name: "底部版权水印",
    toolId: "image-watermark",
    builtin: true,
    params: {
      mode: "text",
      position: "bc",
      scalePercent: 15,
      opacity: 0.6,
      marginPercent: 3,
      fontSize: 24,
      color: "#ffffff",
    },
  },
  {
    name: "居中半透明",
    toolId: "image-watermark",
    builtin: true,
    params: {
      mode: "text",
      position: "mc",
      scalePercent: 20,
      opacity: 0.4,
      marginPercent: 3,
      fontSize: 48,
      color: "#ffffff",
    },
  },
  {
    name: "角落防搬运",
    toolId: "image-watermark",
    builtin: true,
    params: {
      mode: "text",
      position: "tr",
      scalePercent: 12,
      opacity: 0.5,
      marginPercent: 3,
      fontSize: 20,
      color: "#ffffff",
    },
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

export function loadPresets(): Preset[] {
  const byKey = new Map<string, Preset>();
  for (const p of BUILTIN_PRESETS) byKey.set(keyOf(p), { ...p, builtin: true });
  for (const p of loadCustoms()) byKey.set(keyOf(p), { ...p, builtin: false });
  return [...byKey.values()];
}

function saveCustoms(customs: Preset[]): void {
  writeStorage(KEY, JSON.stringify(customs));
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
