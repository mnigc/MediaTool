//! The engine's command and event surface, as the UI calls it.
//!
//! Shell-agnostic by design: `lib/shell.ts` routes each call to Tauri or to
//! the HTTP/WebSocket RPC, so this file lists operations rather than a
//! transport. Keep argument names in sync with the Rust command parameters —
//! both shells read the same camelCase keys.

import { invoke, listen, type UnlistenFn } from "./shell";
import type {
  CacheCleanResult,
  CacheReport,
  DoneEvent,
  DownloadDoneEvent,
  DownloadProgressEvent,
  DownloadRequest,
  DownloadStartedEvent,
  DirListing,
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
  OauthBeginRequest,
  OauthBeginResult,
  OauthResultEvent,
  ProgressEvent,
  StartJobResult,
  StartWorkflowResult,
  StreamlinkRelease,
  StreamlinkStatus,
  UploadDoneEvent,
  UploadProgressEvent,
  UploadRequest,
  UploadStartResult,
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

/** `durationSecs` (when known) lets the backend seek past black lead-in
 *  frames instead of grabbing frame ~1. */
export async function getThumbnail(
  path: string,
  mediaType: string,
  durationSecs?: number | null
): Promise<string | null> {
  return invoke<string | null>("get_thumbnail", {
    path,
    mediaType,
    durationSecs: durationSecs ?? null,
  });
}

export async function detectGpu(): Promise<GpuInfo> {
  return invoke<GpuInfo>("detect_gpu");
}

export function estimateSize(request: EstimateRequest): Promise<EstimateResult> {
  return invoke<EstimateResult>("estimate_size", { request });
}

export function onProgress(cb: (e: ProgressEvent) => void): Promise<UnlistenFn> {
  return listen<ProgressEvent>("job-progress", cb);
}

export function onDone(cb: (e: DoneEvent) => void): Promise<UnlistenFn> {
  return listen<DoneEvent>("job-done", cb);
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
  return listen<DownloadProgressEvent>("download-progress", cb);
}

export function onDownloadDone(cb: (e: DownloadDoneEvent) => void): Promise<UnlistenFn> {
  return listen<DownloadDoneEvent>("download-done", cb);
}

export function onDownloadStarted(cb: (e: DownloadStartedEvent) => void): Promise<UnlistenFn> {
  return listen<DownloadStartedEvent>("download-started", cb);
}

export function onMonitorStatus(cb: (e: MonitorInfo) => void): Promise<UnlistenFn> {
  return listen<MonitorInfo>("monitor-status", cb);
}

export function onYtdlpInstallProgress(cb: (e: YtdlpInstallProgress) => void): Promise<UnlistenFn> {
  return listen<YtdlpInstallProgress>("ytdlp-install-progress", cb);
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
  return listen<YtdlpInstallProgress>("streamlink-install-progress", cb);
}

/* ── uploads (post-processing push to remote targets) ─────────── */

export function uploadStart(request: UploadRequest): Promise<UploadStartResult> {
  return invoke<UploadStartResult>("upload_start", { request });
}

export function cancelUpload(id: string): Promise<void> {
  return invoke<void>("cancel_upload", { id });
}

/**
 * Open a browser OAuth loop. Desktop catches the redirect on a loopback port;
 * web mode bounces it through the server's own `/oauth/callback`, which needs
 * `MEDIATOOL_PUBLIC_URL`. Either way the result arrives as `oauth-result`, and
 * `authUrl` is the consent page — web mode has to open it itself.
 */
export function oauthBegin(request: OauthBeginRequest): Promise<OauthBeginResult> {
  return invoke<OauthBeginResult>("oauth_begin", { request });
}

export function oauthCancel(requestId: string): Promise<void> {
  return invoke<void>("oauth_cancel", { requestId });
}

export function onUploadProgress(cb: (e: UploadProgressEvent) => void): Promise<UnlistenFn> {
  return listen<UploadProgressEvent>("upload-progress", cb);
}

export function onUploadDone(cb: (e: UploadDoneEvent) => void): Promise<UnlistenFn> {
  return listen<UploadDoneEvent>("upload-done", cb);
}

export function onOauthResult(cb: (e: OauthResultEvent) => void): Promise<UnlistenFn> {
  return listen<OauthResultEvent>("oauth-result", cb);
}

/* ── server-side directory browsing (web mode) ─────────────────── */

/** Roots the operator mounted; the browser's starting points. */
export function fsRoots(): Promise<string[]> {
  return invoke<string[]>("fs_roots");
}

/** One directory level, or the root list when `path` is empty. */
export function fsList(path: string): Promise<DirListing> {
  return invoke<DirListing>("fs_list", { path });
}

export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const v = bytes / Math.pow(1024, i);
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
