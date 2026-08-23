use tauri::{AppHandle, Manager};

use crate::error::Result;
use crate::gpu;
use crate::jobs;
use crate::media;
use crate::models::{EstimateRequest, EstimateResult, JobRequest, MediaInfo, StartJobResult};
use crate::state::JobManager;

#[tauri::command]
pub async fn probe_file(app: AppHandle, path: String) -> Result<MediaInfo> {
    media::probe(&app, &path).await
}

#[tauri::command]
pub async fn start_job(app: AppHandle, request: JobRequest) -> Result<StartJobResult> {
    jobs::start_job(app, request).await
}

#[tauri::command]
pub async fn estimate_size(app: AppHandle, request: EstimateRequest) -> Result<EstimateResult> {
    jobs::estimate_size(app, request).await
}

#[tauri::command]
pub async fn inspect_media(app: AppHandle, path: String) -> Result<crate::models::MediaReport> {
    crate::inspect::inspect(app, path).await
}

#[tauri::command]
pub fn cancel_job(app: AppHandle, id: String) {
    let manager = app.state::<JobManager>();
    manager.mark_cancelled(&id);
    manager.kill(&id);
}

#[tauri::command]
pub fn detect_gpu(app: AppHandle) -> Result<crate::gpu::GpuInfo> {
    gpu::detect_gpu(&app)
}

#[tauri::command]
pub fn open_output_folder(app: AppHandle, path: String) -> Result<()> {
    use tauri_plugin_opener::OpenerExt;
    let dir = std::path::Path::new(&path)
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| crate::error::AppError(e.to_string()))?;
    Ok(())
}
