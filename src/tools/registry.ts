import type { ToolId } from "../types";

export type ToolCategory = "video" | "audio" | "image" | "tools";

/** Top-level navigation modules. "tasks" and "presets" are full pages, the
 *  rest (video/audio/image/tools) render a function-card grid. "workflow" is a
 *  full-page multi-step pipeline builder. */
export type ModuleId =
  | "video"
  | "audio"
  | "image"
  | "tools"
  | "tasks"
  | "presets"
  | "workflow";

/** Pseudo-tool rendered as a panel but never queued as a job. */
export type WorkbenchId = ToolId | "inspect" | "workflow";

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
  mediaType?: "video" | "audio" | "image";
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
  "video",
  "audio",
  "image",
  "workflow",
  "tools",
  "tasks",
  "presets",
];

export const TOOLS: ToolMeta[] = [
  // video
  { id: "video-compress", category: "video", accepts: VIDEO_EXTS, multiFile: true, mediaType: "video" },
  { id: "video-convert", category: "video", accepts: VIDEO_EXTS, multiFile: true, mediaType: "video" },
  { id: "trim", category: "video", accepts: VIDEO_EXTS, multiFile: true },
  { id: "mute", category: "video", accepts: VIDEO_EXTS, multiFile: true },
  { id: "rotate", category: "video", accepts: VIDEO_EXTS, multiFile: true },
  { id: "gif", category: "video", accepts: VIDEO_EXTS, multiFile: false },
  { id: "screenshot", category: "video", accepts: VIDEO_EXTS, multiFile: false },
  { id: "speed", category: "video", accepts: VIDEO_EXTS, multiFile: false },
  { id: "watermark", category: "video", accepts: VIDEO_EXTS, multiFile: false },
  { id: "video-crop", category: "video", accepts: VIDEO_EXTS, multiFile: false, mediaType: "video" },
  { id: "video-volume", category: "video", accepts: VIDEO_EXTS, multiFile: false, mediaType: "video" },
  { id: "video-reverse", category: "video", accepts: VIDEO_EXTS, multiFile: false, mediaType: "video" },
  { id: "video-subtitle", category: "video", accepts: VIDEO_EXTS, multiFile: false, mediaType: "video" },
  { id: "video-addaudio", category: "video", accepts: VIDEO_EXTS, multiFile: false, mediaType: "video" },
  { id: "video-merge", category: "video", accepts: VIDEO_EXTS, multiFile: true, mediaType: "video" },
  { id: "video-frames", category: "video", accepts: VIDEO_EXTS, multiFile: false, mediaType: "video" },
  { id: "video-contact", category: "video", accepts: VIDEO_EXTS, multiFile: false, mediaType: "video" },
  { id: "video-silence", category: "video", accepts: VIDEO_EXTS, multiFile: false, mediaType: "video" },
  // audio
  { id: "audio-compress", category: "audio", accepts: AUDIO_EXTS, multiFile: true, mediaType: "audio" },
  { id: "audio-convert", category: "audio", accepts: AUDIO_EXTS, multiFile: true, mediaType: "audio" },
  { id: "extract-audio", category: "audio", accepts: VIDEO_EXTS, multiFile: true },
  { id: "audio-trim", category: "audio", accepts: AUDIO_EXTS, multiFile: false, mediaType: "audio" },
  { id: "audio-fade", category: "audio", accepts: AUDIO_EXTS, multiFile: false, mediaType: "audio" },
  { id: "audio-volume", category: "audio", accepts: AUDIO_EXTS, multiFile: false, mediaType: "audio" },
  { id: "audio-pitch", category: "audio", accepts: AUDIO_EXTS, multiFile: false, mediaType: "audio" },
  { id: "audio-silence", category: "audio", accepts: AUDIO_EXTS, multiFile: false, mediaType: "audio" },
  { id: "audio-merge", category: "audio", accepts: AUDIO_EXTS, multiFile: true, mediaType: "audio" },
  // image
  { id: "image-compress", category: "image", accepts: IMAGE_EXTS, multiFile: true, mediaType: "image" },
  { id: "image-convert", category: "image", accepts: IMAGE_EXTS, multiFile: true, mediaType: "image" },
  { id: "image-resize", category: "image", accepts: IMAGE_EXTS, multiFile: false, mediaType: "image" },
  { id: "image-rotate", category: "image", accepts: IMAGE_EXTS, multiFile: false, mediaType: "image" },
  { id: "image-crop", category: "image", accepts: IMAGE_EXTS, multiFile: false, mediaType: "image" },
  { id: "image-watermark", category: "image", accepts: IMAGE_EXTS, multiFile: false, mediaType: "image" },
  { id: "image-pdf", category: "image", accepts: IMAGE_EXTS, multiFile: false, mediaType: "image" },
  { id: "image-adjust", category: "image", accepts: IMAGE_EXTS, multiFile: false, mediaType: "image" },
  // tools (utilities)
  { id: "strip-metadata", category: "tools", accepts: ALL_EXTS, multiFile: true },
  { id: "inspect", category: "tools", accepts: ALL_EXTS, multiFile: false },
];

function categoryToModule(cat: ToolCategory): ModuleId {
  return cat; // video/audio/image/tools map 1:1 to their module
}

export function getTool(id: WorkbenchId): ToolMeta | undefined {
  return TOOLS.find((t) => t.id === id);
}

/** The top-level module a tool belongs to. */
export function toolToModule(tool: WorkbenchId): ModuleId {
  return categoryToModule(getTool(tool)?.category ?? "tools");
}

/** Function cards shown on a module landing page (empty for tasks/presets). */
export function cardsOfModule(module: ModuleId): ToolMeta[] {
  return TOOLS.filter((t) => categoryToModule(t.category) === module);
}
