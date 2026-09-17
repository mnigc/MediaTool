import type { ToolId } from "../types";

/** Batch tools with editable per-job params and size estimation
 *  (the two compress tools + the two convert tools). */
export const BATCH_EDITABLE_TOOLS: ReadonlySet<string> = new Set<ToolId>([
  "video-compress",
  "video-convert",
  "audio-compress",
  "audio-convert",
]);

export function isBatchEditable(toolId: string): boolean {
  return BATCH_EDITABLE_TOOLS.has(toolId);
}

export function mediaTypeOfBatchTool(toolId: BatchToolId): "video" | "audio" {
  return toolId.startsWith("audio") ? "audio" : "video";
}

export type BatchToolId =
  | "video-compress"
  | "video-convert"
  | "audio-compress"
  | "audio-convert";
