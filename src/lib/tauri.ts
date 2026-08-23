import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { DoneEvent, EstimateRequest, EstimateResult, GpuInfo, JobRequest, MediaInfo, MediaReport, ProgressEvent, StartJobResult } from "../types";

export async function probeFile(path: string): Promise<MediaInfo> {
  return invoke<MediaInfo>("probe_file", { path });
}

export async function startJob(request: JobRequest): Promise<StartJobResult> {
  return invoke<StartJobResult>("start_job", { request });
}

export async function inspectMedia(path: string): Promise<MediaReport> {
  return invoke<MediaReport>("inspect_media", { path });
}

export async function cancelJob(id: string): Promise<void> {
  return invoke<void>("cancel_job", { id });
}

export async function openOutputFolder(path: string): Promise<void> {
  return invoke<void>("open_output_folder", { path });
}

export async function getThumbnail(path: string, mediaType: string): Promise<string | null> {
  return invoke<string | null>("get_thumbnail", { path, mediaType });
}

export async function detectGpu(): Promise<GpuInfo> {
  return invoke<GpuInfo>("detect_gpu");
}

export function estimateSize(request: EstimateRequest): Promise<EstimateResult> {
  return invoke<EstimateResult>("estimate_size", { request });
}

export function onProgress(cb: (e: ProgressEvent) => void): Promise<UnlistenFn> {
  return listen<ProgressEvent>("job-progress", (event) => cb(event.payload));
}

export function onDone(cb: (e: DoneEvent) => void): Promise<UnlistenFn> {
  return listen<DoneEvent>("job-done", (event) => cb(event.payload));
}

export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const v = bytes / Math.pow(1024, i);
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
