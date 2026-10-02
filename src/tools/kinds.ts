import type { ToolId } from "../types";

/** Batch tools with editable per-job params and size estimation
 *  (the transcode tools — each covers both compress and convert). */
export const BATCH_EDITABLE_TOOLS: ReadonlySet<string> = new Set<ToolId>([
  "video-compress",
  "audio-compress",
]);

export function isBatchEditable(toolId: string): boolean {
  return BATCH_EDITABLE_TOOLS.has(toolId);
}

/** Tools whose cards carry an inline player: their params are cut points, so
 *  the footage has to sit next to the inputs to be set by eye. */
export const PREVIEW_TOOLS: ReadonlySet<string> = new Set<ToolId>(["trim"]);

export function hasInlinePreview(toolId: string): boolean {
  return PREVIEW_TOOLS.has(toolId);
}

export function mediaTypeOfBatchTool(toolId: BatchToolId): "video" | "audio" {
  return toolId.startsWith("audio") ? "audio" : "video";
}

export type BatchToolId = "video-compress" | "audio-compress";

/** Tools that own presets, in display order — the preset manager and the
 *  presets page both edit exactly this set (all support the param editor). */
export const PRESET_TOOLS = [
  "video-compress",
  "audio-compress",
  "watermark",
  "extract-audio",
  "video-contact",
] as const;

export type PresetToolId = (typeof PRESET_TOOLS)[number];

export function isPresetTool(toolId: string): toolId is PresetToolId {
  return (PRESET_TOOLS as readonly string[]).includes(toolId);
}
