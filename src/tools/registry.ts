import type { ToolId } from "../types";

export type ToolCategory = "video" | "audio";

/** Top-level navigation modules. "tasks" and "presets" are full pages, the
 *  rest (video/audio) render a function-card grid. "workflow" is a
 *  full-page multi-step pipeline builder. "download"/"record" are the
 *  yt-dlp powered acquisition pages. */
export type ModuleId =
  | "download"
  | "record"
  | "video"
  | "audio"
  | "tasks"
  | "presets"
  | "workflow"
  | "settings"
  | "about";

/** Pseudo-tool rendered as a panel but never queued as a job.
 *  "strip-metadata" is also no longer a workbench: it is triggered from the
 *  inspect page as a plain job. */
export type WorkbenchId = Exclude<ToolId, "strip-metadata"> | "inspect";

/** App navigation state: either a module landing page, or a concrete tool. */
export type Route =
  | { kind: "module"; id: ModuleId }
  | { kind: "tool"; tool: WorkbenchId };

export interface ToolMeta {
  id: WorkbenchId;
  category: ToolCategory;
  /** File extensions accepted by this tool (lowercase, no dot). */
  accepts: string[];
  multiFile: boolean;
  /** For compress tools: which media type to filter for */
  mediaType?: "video" | "audio";
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

export const ALL_EXTS = [...VIDEO_EXTS, ...AUDIO_EXTS, ...IMAGE_EXTS];

export const MODULES: ModuleId[] = [
  "download",
  "record",
  "video",
  "audio",
  "workflow",
  "tasks",
  "presets",
  "settings",
  "about",
];

export const TOOLS: ToolMeta[] = [
  // video
  { id: "video-compress", category: "video", accepts: VIDEO_EXTS, multiFile: true, mediaType: "video" },
  { id: "trim", category: "video", accepts: VIDEO_EXTS, multiFile: true },
  { id: "mute", category: "video", accepts: VIDEO_EXTS, multiFile: true },
  { id: "screenshot", category: "video", accepts: VIDEO_EXTS, multiFile: false },
  { id: "speed", category: "video", accepts: VIDEO_EXTS, multiFile: false },
  { id: "watermark", category: "video", accepts: VIDEO_EXTS, multiFile: false },
  { id: "video-subtitle", category: "video", accepts: VIDEO_EXTS, multiFile: false, mediaType: "video" },
  { id: "video-merge", category: "video", accepts: VIDEO_EXTS, multiFile: true, mediaType: "video" },
  { id: "video-frames", category: "video", accepts: VIDEO_EXTS, multiFile: false, mediaType: "video" },
  { id: "video-contact", category: "video", accepts: VIDEO_EXTS, multiFile: false, mediaType: "video" },
  { id: "video-silence", category: "video", accepts: VIDEO_EXTS, multiFile: false, mediaType: "video" },
  // Instant ffprobe report; accepts any media type, listed last on the video page.
  { id: "inspect", category: "video", accepts: ALL_EXTS, multiFile: false },
  // audio
  { id: "audio-compress", category: "audio", accepts: AUDIO_EXTS, multiFile: true, mediaType: "audio" },
  { id: "extract-audio", category: "audio", accepts: VIDEO_EXTS, multiFile: true },
  { id: "audio-volume", category: "audio", accepts: AUDIO_EXTS, multiFile: false, mediaType: "audio" },
  { id: "audio-merge", category: "audio", accepts: AUDIO_EXTS, multiFile: true, mediaType: "audio" },
];

function categoryToModule(cat: ToolCategory): ModuleId {
  return cat; // video/audio map 1:1 to their module
}

export function getTool(id: WorkbenchId): ToolMeta | undefined {
  return TOOLS.find((t) => t.id === id);
}

/** The top-level module a tool belongs to. */
export function toolToModule(tool: WorkbenchId): ModuleId {
  return categoryToModule(getTool(tool)?.category ?? "video");
}

/** Function cards shown on a module landing page (empty for tasks/presets). */
export function cardsOfModule(module: ModuleId): ToolMeta[] {
  return TOOLS.filter((t) => categoryToModule(t.category) === module);
}
