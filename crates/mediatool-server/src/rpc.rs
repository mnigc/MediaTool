//! The engine commands, reachable over HTTP.
//!
//! One endpoint, `POST /api/invoke/{command}`, taking the same JSON argument
//! object the desktop frontend already hands to `invoke()`. A per-command REST
//! route would be more idiomatic HTTP and would drift: 29 hand-written
//! handlers, each free to rename a field differently from the client. Sharing
//! the argument shape means the web adapter is a thin `fetch` and the command
//! surface cannot diverge between the two shells.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use mediatool_core::ctx::Ctx;
use mediatool_core::error::{AppError, Result};
use mediatool_core::models::{EstimateRequest, WorkflowRequest};
use mediatool_core::upload::{OauthBeginRequest, UploadRequest};
use mediatool_core::{cache, inspect, jobs, media, streamlink, thumbnail, upload, ytdlp};
use serde::Deserialize;

use crate::fsbrowse;
use crate::paths::Roots;

pub struct AppState {
    pub ctx: Ctx,
    pub roots: Roots,
}

/* ── Argument shapes ────────────────────────────────────────────────
Tauri maps a command's snake_case parameters to the camelCase keys the
frontend sends, so these structs mirror that convention. */

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct Args {
    path: String,
    id: String,
    request_id: String,
    url: String,
    media_type: String,
    duration_secs: Option<f64>,
    #[serde(default)]
    request: serde_json::Value,
    #[serde(default)]
    options: serde_json::Value,
    #[serde(default)]
    edit: serde_json::Value,
}

fn parse(raw: &Bytes) -> Result<Args> {
    if raw.is_empty() {
        return Ok(Args::default());
    }
    serde_json::from_slice(raw).map_err(AppError::from)
}

/// Pull a typed `request`/`edit` payload out of the loosely-typed envelope.
fn field<T: serde::de::DeserializeOwned>(v: &serde_json::Value, what: &str) -> Result<T> {
    if v.is_null() {
        return Err(AppError(format!("缺少参数 {what}")));
    }
    serde_json::from_value(v.clone()).map_err(AppError::from)
}

pub async fn handle(
    State(state): State<Arc<AppState>>,
    Path(command): Path<String>,
    raw: Bytes,
) -> Response {
    match dispatch(&state, &command, &raw).await {
        Ok(value) => Json(value).into_response(),
        // A Tauri `invoke()` rejects with the error value itself, and
        // `AppError` serializes to a bare string, so the web adapter can
        // hand callers exactly the same thing.
        Err(AppError(message)) => (StatusCode::BAD_REQUEST, Json(message)).into_response(),
    }
}

async fn dispatch(state: &Arc<AppState>, command: &str, raw: &Bytes) -> Result<serde_json::Value> {
    let ctx = &state.ctx;
    let a = parse(raw)?;
    macro_rules! json {
        ($e:expr) => {
            serde_json::to_value($e).map_err(AppError::from)
        };
    }

    match command {
        /* ── cache ── */
        "cache_report" => {
            let env = ctx.env.clone();
            let report = tokio::task::spawn_blocking(move || cache::cache_report(&*env))
                .await
                .map_err(|e| AppError(e.to_string()))?;
            json!(report)
        }
        "cache_clean" => json!(cache::cache_clean(ctx.env.clone()).await),

        /* ── jobs / media ── */
        "probe_file" => json!(media::probe(ctx.env.clone(), &a.path).await?),
        "inspect_media" => json!(inspect::inspect(ctx.env.clone(), a.path).await?),
        "get_thumbnail" => json!(
            thumbnail::get_thumbnail_spawn(ctx.env.clone(), a.path, a.media_type, a.duration_secs)
                .await?
        ),
        "start_job" => json!(jobs::start_job(ctx.clone(), field(&a.request, "request")?).await?),
        "start_workflow" => {
            let req: WorkflowRequest = field(&a.request, "request")?;
            json!(jobs::start_workflow(ctx.clone(), req).await?)
        }
        "estimate_size" => {
            let req: EstimateRequest = field(&a.request, "request")?;
            json!(jobs::estimate_size(ctx.clone(), req).await?)
        }
        "cancel_job" => {
            ctx.jobs.mark_cancelled(&a.id);
            ctx.jobs.kill(&a.id);
            Ok(serde_json::Value::Null)
        }
        "detect_gpu" => {
            let env = ctx.env.clone();
            let info = tokio::task::spawn_blocking(move || mediatool_core::gpu::detect_gpu(&*env))
                .await
                .map_err(|e| AppError(e.to_string()))??;
            json!(info)
        }
        "open_output_folder" => Err(AppError(
            "网页模式无法打开本地文件夹，请直接在文件管理器中访问该路径".into(),
        )),

        /* ── downloads (yt-dlp) ── */
        "ytdlp_status" => json!(ytdlp::ytdlp_status(ctx.clone()).await?),
        "ytdlp_install" => json!(ytdlp::ytdlp_install(ctx.clone()).await?),
        "ytdlp_latest_version" => json!(ytdlp::ytdlp_latest_version().await?),
        "ytdlp_probe" => {
            let options = if a.options.is_null() {
                None
            } else {
                Some(field(&a.options, "options")?)
            };
            json!(ytdlp::ytdlp_probe(ctx.clone(), a.url, options).await?)
        }
        "ytdlp_start_download" => {
            let req = field(&a.request, "request")?;
            json!(ytdlp::ytdlp_start_download(ctx.clone(), req).await?)
        }
        "dl_active_tasks" => json!(ytdlp::dl_active_tasks(ctx.clone())),

        /* ── live monitors ── */
        "monitor_add" => {
            let req = field(&a.request, "request")?;
            json!(ytdlp::monitor_add(ctx.clone(), req)?)
        }
        "monitor_list" => json!(ytdlp::monitor_list(ctx.clone())),
        "monitor_remove" => json!(ytdlp::monitor_remove(ctx.clone(), a.id)?),
        "monitor_record_now" => json!(ytdlp::monitor_record_now(ctx.clone(), a.id)?),
        "monitor_update" => {
            let edit = field(&a.edit, "edit")?;
            json!(ytdlp::monitor_update(ctx.clone(), a.id, edit)?)
        }

        /* ── streamlink ── */
        "streamlink_status" => json!(streamlink::streamlink_status(ctx.clone()).await?),
        "streamlink_latest_release" => json!(streamlink::streamlink_latest_release().await?),
        "streamlink_install" => json!(streamlink::streamlink_install(ctx.clone()).await?),

        /* ── uploads / oauth ── */
        "upload_start" => {
            let req: UploadRequest = field(&a.request, "request")?;
            json!(upload::upload_start(ctx.clone(), req).await?)
        }
        "cancel_upload" => json!(upload::cancel_upload(ctx.clone(), a.id)),
        "oauth_begin" => {
            let req: OauthBeginRequest = field(&a.request, "request")?;
            json!(upload::oauth_begin(ctx.clone(), req).await?)
        }
        "oauth_cancel" => json!(upload::oauth_cancel(ctx.clone(), a.request_id)),

        /* ── web-only filesystem browsing ── */
        "fs_roots" | "fs_list" | "fs_stat" => {
            let roots = state.roots.clone();
            let command = command.to_string();
            let path = a.path.clone();
            let out = tokio::task::spawn_blocking(move || match command.as_str() {
                "fs_roots" => fsbrowse::roots(&roots),
                "fs_list" => fsbrowse::list(&roots, &path),
                _ => fsbrowse::stat(&roots, &path),
            })
            .await
            .map_err(|e| AppError(e.to_string()))??;
            json!(out)
        }

        other => Err(AppError(format!("未知命令: {other}"))),
    }
}
