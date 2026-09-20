//! Thin `#[tauri::command]` wrappers around the shared engine crate.
//!
//! Each wrapper unpacks the shell's `Ctx` and hands control to
//! `mediatool-core`; all real logic lives there so the headless server can
//! expose the same operations over HTTP.

use mediatool_core::models::{
    EstimateRequest, EstimateResult, JobRequest, MediaInfo, MediaReport, StartJobResult,
    StartWorkflowResult, WorkflowRequest,
};
use mediatool_core::{error, gpu, inspect, jobs, media};
use tauri::{AppHandle, Manager};

use crate::error::Result;
use crate::shell::ShellState;

fn ctx(app: &AppHandle) -> mediatool_core::ctx::Ctx {
    app.state::<ShellState>().ctx.clone()
}

/* ── Cache ──────────────────────────────────────────────────────── */

#[tauri::command]
pub fn cache_report(app: AppHandle) -> mediatool_core::cache::CacheReport {
    mediatool_core::cache::cache_report(&*ctx(&app).env)
}

#[tauri::command]
pub async fn cache_clean(app: AppHandle) -> mediatool_core::cache::CacheCleanResult {
    mediatool_core::cache::cache_clean(ctx(&app).env.clone()).await
}

/* ── Jobs / media ───────────────────────────────────────────────── */

#[tauri::command]
pub async fn probe_file(app: AppHandle, path: String) -> Result<MediaInfo> {
    media::probe(ctx(&app).env.clone(), &path).await
}

#[tauri::command]
pub async fn start_job(app: AppHandle, request: JobRequest) -> Result<StartJobResult> {
    jobs::start_job(ctx(&app), request).await
}

#[tauri::command]
pub async fn start_workflow(
    app: AppHandle,
    request: WorkflowRequest,
) -> Result<StartWorkflowResult> {
    jobs::start_workflow(ctx(&app), request).await
}

#[tauri::command]
pub async fn estimate_size(app: AppHandle, request: EstimateRequest) -> Result<EstimateResult> {
    jobs::estimate_size(ctx(&app), request).await
}

#[tauri::command]
pub async fn inspect_media(app: AppHandle, path: String) -> Result<MediaReport> {
    inspect::inspect(ctx(&app).env.clone(), path).await
}

#[tauri::command]
pub async fn get_thumbnail(
    app: AppHandle,
    path: String,
    media_type: String,
    duration_secs: Option<f64>,
) -> Result<Option<String>> {
    let env = ctx(&app).env.clone();
    mediatool_core::thumbnail::get_thumbnail_spawn(env, path, media_type, duration_secs).await
}

#[tauri::command]
pub fn cancel_job(app: AppHandle, id: String) {
    let state = app.state::<ShellState>();
    state.jobs.mark_cancelled(&id);
    state.jobs.kill(&id);
}

/// `ffmpeg -encoders` blocks while the 164 MB sidecar image loads; keep it on
/// a worker thread so the startup probe cannot freeze the window (this runs
/// on TaskCenter mount).
#[tauri::command]
pub async fn detect_gpu(app: AppHandle) -> Result<gpu::GpuInfo> {
    let env = ctx(&app).env.clone();
    tokio::task::spawn_blocking(move || gpu::detect_gpu(&*env))
        .await
        .map_err(|e| error::AppError(e.to_string()))?
}

#[tauri::command]
pub async fn ffmpeg_status(app: AppHandle) -> Result<mediatool_core::ffmpeg::FfmpegStatus> {
    let env = ctx(&app).env.clone();
    tokio::task::spawn_blocking(move || mediatool_core::ffmpeg::status(&*env))
        .await
        .map_err(|e| error::AppError(e.to_string()))
}

#[tauri::command]
pub fn open_output_folder(app: AppHandle, path: String) -> Result<()> {
    use tauri_plugin_opener::OpenerExt;
    // Files open their parent folder; directories are opened as-is (the
    // download page's save-location bar passes a folder).
    let p = std::path::Path::new(&path);
    let dir = if p.is_dir() {
        p.to_path_buf()
    } else {
        p.parent()
            .map(|d| d.to_path_buf())
            .unwrap_or_else(|| std::path::PathBuf::from("."))
    };
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| error::AppError(e.to_string()))?;
    Ok(())
}

/* ── Downloads (yt-dlp) ─────────────────────────────────────────── */

#[tauri::command]
pub async fn ytdlp_status(app: AppHandle) -> Result<mediatool_core::ytdlp::YtdlpStatus> {
    mediatool_core::ytdlp::ytdlp_status(ctx(&app)).await
}

#[tauri::command]
pub async fn ytdlp_install(app: AppHandle) -> Result<mediatool_core::ytdlp::YtdlpStatus> {
    mediatool_core::ytdlp::ytdlp_install(ctx(&app)).await
}

#[tauri::command]
pub async fn ytdlp_latest_version() -> Result<String> {
    mediatool_core::ytdlp::ytdlp_latest_version().await
}

#[tauri::command]
pub async fn ytdlp_probe(
    app: AppHandle,
    url: String,
    options: Option<mediatool_core::ytdlp::NetOptions>,
) -> Result<serde_json::Value> {
    mediatool_core::ytdlp::ytdlp_probe(ctx(&app), url, options).await
}

#[tauri::command]
pub async fn ytdlp_start_download(
    app: AppHandle,
    request: mediatool_core::ytdlp::DownloadRequest,
) -> Result<mediatool_core::models::StartJobResult> {
    mediatool_core::ytdlp::ytdlp_start_download(ctx(&app), request).await
}

#[tauri::command]
pub fn dl_active_tasks(app: AppHandle) -> Vec<mediatool_core::ytdlp::ActiveDlTask> {
    mediatool_core::ytdlp::dl_active_tasks(ctx(&app))
}

#[tauri::command]
pub fn monitor_add(
    app: AppHandle,
    request: mediatool_core::ytdlp::MonitorRequest,
) -> Result<mediatool_core::ytdlp::MonitorInfo> {
    mediatool_core::ytdlp::monitor_add(ctx(&app), request)
}

#[tauri::command]
pub fn monitor_list(app: AppHandle) -> Vec<mediatool_core::ytdlp::MonitorInfo> {
    mediatool_core::ytdlp::monitor_list(ctx(&app))
}

#[tauri::command]
pub fn monitor_remove(app: AppHandle, id: String) -> Result<()> {
    mediatool_core::ytdlp::monitor_remove(ctx(&app), id)
}

#[tauri::command]
pub fn monitor_record_now(app: AppHandle, id: String) -> Result<()> {
    mediatool_core::ytdlp::monitor_record_now(ctx(&app), id)
}

#[tauri::command]
pub fn monitor_update(
    app: AppHandle,
    id: String,
    edit: mediatool_core::ytdlp::MonitorEdit,
) -> Result<mediatool_core::ytdlp::MonitorInfo> {
    mediatool_core::ytdlp::monitor_update(ctx(&app), id, edit)
}

/* ── Live recording (streamlink) ────────────────────────────────── */

#[tauri::command]
pub async fn streamlink_status(
    app: AppHandle,
) -> Result<mediatool_core::streamlink::StreamlinkStatus> {
    mediatool_core::streamlink::streamlink_status(ctx(&app)).await
}

#[tauri::command]
pub async fn streamlink_latest_release() -> Result<serde_json::Value> {
    mediatool_core::streamlink::streamlink_latest_release().await
}

#[tauri::command]
pub async fn streamlink_install(
    app: AppHandle,
) -> Result<mediatool_core::streamlink::StreamlinkStatus> {
    mediatool_core::streamlink::streamlink_install(ctx(&app)).await
}

/* ── Uploads ────────────────────────────────────────────────────── */

#[tauri::command]
pub async fn upload_start(
    app: AppHandle,
    request: mediatool_core::upload::UploadRequest,
) -> Result<mediatool_core::upload::UploadStartResult> {
    mediatool_core::upload::upload_start(ctx(&app), request).await
}

#[tauri::command]
pub fn cancel_upload(app: AppHandle, id: String) {
    mediatool_core::upload::cancel_upload(ctx(&app), id)
}

#[tauri::command]
pub async fn oauth_begin(
    app: AppHandle,
    request: mediatool_core::upload::OauthBeginRequest,
) -> Result<mediatool_core::upload::OauthBeginResult> {
    mediatool_core::upload::oauth_begin(ctx(&app), request).await
}

#[tauri::command]
pub fn oauth_cancel(app: AppHandle, request_id: String) {
    mediatool_core::upload::oauth_cancel(ctx(&app), request_id)
}
