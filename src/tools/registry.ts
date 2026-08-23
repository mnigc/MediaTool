import type { ToolId } from "../types";

export type ToolCategory = "common" | "video" | "audio" | "image" | "general";

/** Pseudo-tool rendered as a panel but never queued as a job. */
export type WorkbenchId = ToolId | "inspect";

export interface ToolMeta {
  id: WorkbenchId;
  category: ToolCategory;
  /** File extensions accepted by this tool (lowercase, no dot). */
  accepts: string[];
  multiFile: boolean;
}

export const VIDEO_EXTS = [
  "mp4", "mkv", "mov", "webm", "avi", "flv", "ts", "m4v", "wmv", "mpeg", "mpg", "3gp",
];
export const AUDIO_EXTS = [
  "mp3", "aac", "m4a", "opus", "flac", "wav", "ogg", "wma", "aiff",
];
export const IMAGE_EXTS = [
  "jpg", "jpeg", "png", "webp", "gif", "bmp", "avif",
];

export const TOOLS: ToolMeta[] = [
  {
    id: "compress",
    category: "common",
    accepts: [...VIDEO_EXTS, ...AUDIO_EXTS, ...IMAGE_EXTS],
    multiFile: true,
  },
  { id: "gif", category: "video", accepts: VIDEO_EXTS, multiFile: false },
  { id: "screenshot", category: "video", accepts: VIDEO_EXTS, multiFile: false },
  { id: "speed", category: "video", accepts: VIDEO_EXTS, multiFile: false },
  { id: "watermark", category: "video", accepts: VIDEO_EXTS, multiFile: false },
  { id: "inspect", category: "general", accepts: [...VIDEO_EXTS, ...AUDIO_EXTS, ...IMAGE_EXTS], multiFile: false },
];

export function toolsByCategory(): Array<{
  category: ToolCategory;
  tools: ToolMeta[];
}> {
  const order: ToolCategory[] = ["common", "video", "audio", "image", "general"];
  return order
    .map((category) => ({
      category,
      tools: TOOLS.filter((t) => t.category === category),
    }))
    .filter((g) => g.tools.length > 0);
}

export function getTool(id: WorkbenchId): ToolMeta | undefined {
  return TOOLS.find((t) => t.id === id);
}
