import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  CacheCleanResult,
  CacheReport,
  DoneEvent,
  DownloadDoneEvent,
  DownloadProgressEvent,
  DownloadRequest,
  DownloadStartedEvent,
  EstimateRequest,
  EstimateResult,
  GpuInfo,
  JobRequest,
  MediaInfo,
  MediaReport,
  MonitorEdit,
  MonitorInfo,
  MonitorRequest,
  NetOptions,
  ProgressEvent,
  StartJobResult,
  StartWorkflowResult,
  StreamlinkRelease,
  StreamlinkStatus,
  WorkflowRequest,
  YtdlpInstallProgress,
  YtdlpStatus,
} from "../types";

export async function probeFile(path: string): Promise<MediaInfo> {
  return invoke<MediaInfo>("probe_file", { path });
}

export async function startJob(request: JobRequest): Promise<StartJobResult> {
  return invoke<StartJobResult>("start_job", { request });
}

export async function startWorkflow(request: WorkflowRequest): Promise<StartWorkflowResult> {
  return invoke<StartWorkflowResult>("start_workflow", { request });
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

/** Sizes of the app's own scratch data (user files are never reported). */
export function cacheReport(): Promise<CacheReport> {
  return invoke<CacheReport>("cache_report");
}

/** Remove every removable bucket; returns how much space was freed. */
export function cacheClean(): Promise<CacheCleanResult> {
  return invoke<CacheCleanResult>("cache_clean");
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

/* ── yt-dlp download / record ─────────────────────────────────── */

export function ytdlpStatus(): Promise<YtdlpStatus> {
  return invoke<YtdlpStatus>("ytdlp_status");
}

export function ytdlpInstall(): Promise<YtdlpStatus> {
  return invoke<YtdlpStatus>("ytdlp_install");
}

/** Latest upstream release tag; queries GitHub without downloading. */
export function ytdlpLatestVersion(): Promise<string> {
  return invoke<string>("ytdlp_latest_version");
}

export function ytdlpProbe(url: string, options?: NetOptions): Promise<Record<string, unknown>> {
  return invoke<Record<string, unknown>>("ytdlp_probe", { url, options: options ?? {} });
}

export function ytdlpStartDownload(request: DownloadRequest): Promise<StartJobResult> {
  return invoke<StartJobResult>("ytdlp_start_download", { request });
}

/** In-flight download/record jobs, for re-adopting cards after a reload. */
export function dlActiveTasks(): Promise<DownloadStartedEvent[]> {
  return invoke<DownloadStartedEvent[]>("dl_active_tasks");
}

export function monitorAdd(request: MonitorRequest): Promise<MonitorInfo> {
  return invoke<MonitorInfo>("monitor_add", { request });
}

export function monitorList(): Promise<MonitorInfo[]> {
  return invoke<MonitorInfo[]>("monitor_list");
}

export function monitorRemove(id: string): Promise<void> {
  return invoke<void>("monitor_remove", { id });
}

export function monitorRecordNow(id: string): Promise<void> {
  return invoke<void>("monitor_record_now", { id });
}

export function monitorUpdate(id: string, edit: MonitorEdit): Promise<MonitorInfo> {
  return invoke<MonitorInfo>("monitor_update", { id, edit });
}

export function onDownloadProgress(cb: (e: DownloadProgressEvent) => void): Promise<UnlistenFn> {
  return listen<DownloadProgressEvent>("download-progress", (event) => cb(event.payload));
}

export function onDownloadDone(cb: (e: DownloadDoneEvent) => void): Promise<UnlistenFn> {
  return listen<DownloadDoneEvent>("download-done", (event) => cb(event.payload));
}

export function onDownloadStarted(cb: (e: DownloadStartedEvent) => void): Promise<UnlistenFn> {
  return listen<DownloadStartedEvent>("download-started", (event) => cb(event.payload));
}

export function onMonitorStatus(cb: (e: MonitorInfo) => void): Promise<UnlistenFn> {
  return listen<MonitorInfo>("monitor-status", (event) => cb(event.payload));
}

export function onYtdlpInstallProgress(cb: (e: YtdlpInstallProgress) => void): Promise<UnlistenFn> {
  return listen<YtdlpInstallProgress>("ytdlp-install-progress", (event) => cb(event.payload));
}

/* ── streamlink live-recording engine ───────────────────────────── */

export function streamlinkStatus(): Promise<StreamlinkStatus> {
  return invoke<StreamlinkStatus>("streamlink_status");
}

/** GitHub release pointer for this platform; nothing is downloaded. */
export function streamlinkLatestRelease(): Promise<StreamlinkRelease> {
  return invoke<StreamlinkRelease>("streamlink_latest_release");
}

export function streamlinkInstall(): Promise<StreamlinkStatus> {
  return invoke<StreamlinkStatus>("streamlink_install");
}

export function onStreamlinkInstallProgress(cb: (e: YtdlpInstallProgress) => void): Promise<UnlistenFn> {
  return listen<YtdlpInstallProgress>("streamlink-install-progress", (event) => cb(event.payload));
}

export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const v = bytes / Math.pow(1024, i);
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
