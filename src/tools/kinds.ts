import type { ToolId } from "../types";

/** Batch tools with editable per-job params and size estimation
 *  (the three compress tools + the three convert tools). */
export const BATCH_EDITABLE_TOOLS: ReadonlySet<string> = new Set<ToolId>([
  "video-compress",
  "video-convert",
  "audio-compress",
  "audio-convert",
  "image-compress",
  "image-convert",
]);

export function isBatchEditable(toolId: string): boolean {
  return BATCH_EDITABLE_TOOLS.has(toolId);
}

export function mediaTypeOfBatchTool(
  toolId: BatchToolId
): "video" | "audio" | "image" {
  if (toolId.startsWith("video")) return "video";
  if (toolId.startsWith("audio")) return "audio";
  return "image";
}

export type BatchToolId =
  | "video-compress"
  | "video-convert"
  | "audio-compress"
  | "audio-convert"
  | "image-compress"
  | "image-convert";
