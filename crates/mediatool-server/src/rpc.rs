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
use mediatool_core::error::AppError;
use mediatool_core::models::{EstimateRequest, JobRequest, WorkflowRequest};
use mediatool_core::upload::{OauthBeginRequest, UploadRequest};
use mediatool_core::{cache, inspect, jobs, media, streamlink, thumbnail, upload, ytdlp};
use serde::Deserialize;

use crate::fsbrowse;
use crate::paths::Roots;

pub struct AppState {
    pub ctx: Ctx,
    pub roots: Roots,
}

/// Why a dispatch failed. Business errors stay a 400 — a Tauri `invoke()`
/// rejects with the error value itself and `AppError` serializes to a bare
/// string, so the web adapter can hand callers exactly the same thing. A
/// worker panic or runtime shutdown is *our* fault, not the caller's, so it
/// must not be dressed up as "bad request": those map to a 500.
#[derive(Debug)]
enum DispatchError {
    /// Caller-facing failure: bad args, missing file, path outside the roots.
    Biz(AppError),
    /// A blocking worker died (JoinError); nothing the client sent caused it.
    Fault(String),
}

impl From<AppError> for DispatchError {
    fn from(e: AppError) -> Self {
        Self::Biz(e)
    }
}

impl From<tokio::task::JoinError> for DispatchError {
    fn from(e: tokio::task::JoinError) -> Self {
        Self::Fault(e.to_string())
    }
}

/* ── Argument shapes ────────────────────────────────────────────────
Tauri maps a command's snake_case parameters to the camelCase keys the
frontend sends, so these structs mirror that convention. */

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct Args {
    path: String,
    id: String,
    host: String,
    request_id: String,
    url: String,
    media_type: String,
    duration_secs: Option<f64>,
    width: Option<u32>,
    count: Option<u32>,
    #[serde(default)]
    request: serde_json::Value,
    #[serde(default)]
    options: serde_json::Value,
    #[serde(default)]
    edit: serde_json::Value,
    #[serde(default)]
    entry: serde_json::Value,
}

fn parse(raw: &Bytes) -> Result<Args, DispatchError> {
    if raw.is_empty() {
        return Ok(Args::default());
    }
    // serde_json::Error -> AppError -> DispatchError::Biz
    serde_json::from_slice(raw).map_err(|e| AppError::from(e).into())
}

/// Pull a typed `request`/`edit` payload out of the loosely-typed envelope.
fn field<T: serde::de::DeserializeOwned>(
    v: &serde_json::Value,
    what: &str,
) -> Result<T, DispatchError> {
    if v.is_null() {
        return Err(AppError(format!("缺少参数 {what}")).into());
    }
    serde_json::from_value(v.clone()).map_err(|e| AppError::from(e).into())
}

/* ── Path allowlist ─────────────────────────────────────────────────
The desktop shell receives paths from OS dialogs the user already sat
through; here they arrive over the network, so every path a command will
touch — input or output — has to pass the same `roots` check the file
browser uses. `resolve` canonicalises first, so `..` segments and symlinks
cannot smuggle a request outside the allowlist. */

fn ensure_allowed(roots: &Roots, raw: &str) -> Result<(), DispatchError> {
    // Empty means "unset / engine default" for the optional paths (output
    // dir, cookie file): nothing to check and nothing to leak.
    if raw.trim().is_empty() {
        return Ok(());
    }
    roots
        .resolve(raw)
        .map_err(DispatchError::Biz)
        .map(|_| ())
}

/// The input list, the output dir, and the path-typed fields nested inside a
/// job request's opaque `params`.
fn ensure_job_paths_allowed(
    roots: &Roots,
    inputs: &[String],
    output_dir: Option<&str>,
    params: &serde_json::Value,
) -> Result<(), DispatchError> {
    for input in inputs {
        ensure_allowed(roots, input)?;
    }
    if let Some(dir) = output_dir {
        ensure_allowed(roots, dir)?;
    }
    ensure_params_allowed(roots, params)
}

/// Params travel as opaque JSON, but some tools embed real paths (subtitle
/// `path`, watermark `imagePath`, rough-cut `clips[].path`). Walk the value
/// and validate every string under a path-typed key so those inputs cannot
/// bypass the allowlist either.
fn ensure_params_allowed(roots: &Roots, value: &serde_json::Value) -> Result<(), DispatchError> {
    const PATH_KEYS: [&str; 2] = ["path", "imagePath"];
    match value {
        serde_json::Value::Object(map) => {
            for (key, val) in map {
                if PATH_KEYS.contains(&key.as_str()) {
                    if let Some(s) = val.as_str() {
                        ensure_allowed(roots, s)?;
                        continue;
                    }
                }
                ensure_params_allowed(roots, val)?;
            }
            Ok(())
        }
        serde_json::Value::Array(items) => {
            for item in items {
                ensure_params_allowed(roots, item)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

pub async fn handle(
    State(state): State<Arc<AppState>>,
    Path(command): Path<String>,
    raw: Bytes,
) -> Response {
    match dispatch(&state, &command, &raw).await {
        Ok(value) => Json(value).into_response(),
        Err(DispatchError::Biz(AppError(message))) => {
            (StatusCode::BAD_REQUEST, Json(message)).into_response()
        }
        Err(DispatchError::Fault(message)) => {
            (StatusCode::INTERNAL_SERVER_ERROR, Json(message)).into_response()
        }
    }
}

async fn dispatch(
    state: &Arc<AppState>,
    command: &str,
    raw: &Bytes,
) -> Result<serde_json::Value, DispatchError> {
    let ctx = &state.ctx;
    let a = parse(raw)?;
    macro_rules! json {
        ($e:expr) => {
            serde_json::to_value($e).map_err(AppError::from)?
        };
    }

    Ok(match command {
        /* ── cache ── */
        "cache_report" => {
            let env = ctx.env.clone();
            // A JoinError means the worker panicked or the runtime is shutting
            // down: `?` routes it to DispatchError::Fault (500).
            json!(tokio::task::spawn_blocking(move || cache::cache_report(&*env)).await?)
        }
        "cache_clean" => json!(cache::cache_clean(ctx.env.clone()).await?),

        /* ── jobs / media ── */
        "probe_file" => {
            ensure_allowed(&state.roots, &a.path)?;
            json!(media::probe(ctx.env.clone(), &a.path).await?)
        }
        "inspect_media" => {
            ensure_allowed(&state.roots, &a.path)?;
            json!(inspect::inspect(ctx.env.clone(), a.path).await?)
        }
        "get_thumbnail" => {
            ensure_allowed(&state.roots, &a.path)?;
            json!(
                thumbnail::get_thumbnail_spawn(ctx.env.clone(), a.path, a.media_type, a.duration_secs)
                    .await?
            )
        }
        "get_filmstrip" => {
            ensure_allowed(&state.roots, &a.path)?;
            json!(
                thumbnail::get_filmstrip_spawn(
                    ctx.env.clone(),
                    a.path,
                    a.count.unwrap_or(8),
                    a.width,
                    a.duration_secs
                )
                .await?
            )
        }
        "start_job" => {
            let req: JobRequest = field(&a.request, "request")?;
            ensure_job_paths_allowed(
                &state.roots,
                &req.inputs,
                req.output_dir.as_deref(),
                &req.params,
            )?;
            json!(jobs::start_job(ctx.clone(), req).await?)
        }
        "start_workflow" => {
            let req: WorkflowRequest = field(&a.request, "request")?;
            ensure_allowed(&state.roots, &req.input)?;
            ensure_allowed(&state.roots, req.output_dir.as_deref().unwrap_or(""))?;
            for step in &req.steps {
                ensure_params_allowed(&state.roots, &step.params)?;
            }
            json!(jobs::start_workflow(ctx.clone(), req).await?)
        }
        "estimate_size" => {
            let req: EstimateRequest = field(&a.request, "request")?;
            // The estimate encodes a real sample of the input file.
            ensure_allowed(&state.roots, &req.info.path)?;
            json!(jobs::estimate_size(ctx.clone(), req).await?)
        }
        "cancel_job" => {
            ctx.jobs.mark_cancelled(&a.id);
            ctx.jobs.kill(&a.id);
            serde_json::Value::Null
        }
        "detect_gpu" => {
            let env = ctx.env.clone();
            json!(tokio::task::spawn_blocking(move || mediatool_core::gpu::detect_gpu(&*env)).await??)
        }
        "ffmpeg_status" => {
            let env = ctx.env.clone();
            json!(tokio::task::spawn_blocking(move || mediatool_core::ffmpeg::status(&*env)).await?)
        }
        "open_output_folder" => {
            return Err(AppError(
                "网页模式无法打开本地文件夹，请直接在文件管理器中访问该路径".into(),
            )
            .into())
        }

        /* ── downloads (yt-dlp) ── */
        "ytdlp_status" => json!(ytdlp::ytdlp_status(ctx.clone()).await?),
        "ytdlp_install" => json!(ytdlp::ytdlp_install(ctx.clone()).await?),
        "ytdlp_latest_version" => json!(ytdlp::ytdlp_latest_version().await?),
        "ytdlp_probe" => {
            let options: Option<ytdlp::NetOptions> = if a.options.is_null() {
                None
            } else {
                Some(field(&a.options, "options")?)
            };
            // The probe hands the cookie file straight to yt-dlp.
            if let Some(o) = &options {
                if let Some(file) = &o.cookies_file {
                    ensure_allowed(&state.roots, file)?;
                }
            }
            json!(ytdlp::ytdlp_probe(ctx.clone(), a.url, options).await?)
        }
        "ytdlp_start_download" => {
            let req: ytdlp::DownloadRequest = field(&a.request, "request")?;
            ensure_allowed(&state.roots, &req.output_dir)?;
            if let Some(file) = &req.cookies_file {
                ensure_allowed(&state.roots, file)?;
            }
            json!(ytdlp::ytdlp_start_download(ctx.clone(), req).await?)
        }
        "dl_active_tasks" => json!(ytdlp::dl_active_tasks(ctx.clone())),

        /* ── live monitors ── */
        "monitor_add" => {
            let req: ytdlp::MonitorRequest = field(&a.request, "request")?;
            ensure_allowed(&state.roots, &req.output_dir)?;
            if let Some(file) = &req.cookies_file {
                ensure_allowed(&state.roots, file)?;
            }
            json!(ytdlp::monitor_add(ctx.clone(), req)?)
        }
        "monitor_list" => json!(ytdlp::monitor_list(ctx.clone())),
        "monitor_remove" => json!(ytdlp::monitor_remove(ctx.clone(), a.id)?),
        "monitor_record_now" => json!(ytdlp::monitor_record_now(ctx.clone(), a.id)?),
        "monitor_update" => {
            let edit = field(&a.edit, "edit")?;
            json!(ytdlp::monitor_update(ctx.clone(), a.id, edit)?)
        }

        /* ── per-platform cookies ── */
        "cookies_list" => json!(ytdlp::cookies_list(&*ctx.env)),
        "cookies_set" => {
            let entry: ytdlp::PlatformCookies = field(&a.entry, "entry")?;
            if let Some(file) = &entry.cookies_file {
                ensure_allowed(&state.roots, file)?;
            }
            json!(ytdlp::cookies_set(&*ctx.env, entry)?)
        }
        "cookies_remove" => json!(ytdlp::cookies_remove(&*ctx.env, a.host)?),

        /* ── streamlink ── */
        "streamlink_status" => json!(streamlink::streamlink_status(ctx.clone()).await?),
        "streamlink_latest_release" => json!(streamlink::streamlink_latest_release().await?),
        "streamlink_install" => json!(streamlink::streamlink_install(ctx.clone()).await?),

        /* ── uploads / oauth ── */
        "upload_start" => {
            let req: UploadRequest = field(&a.request, "request")?;
            for file in &req.file_paths {
                ensure_allowed(&state.roots, file)?;
            }
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
            json!(tokio::task::spawn_blocking(move || match command.as_str() {
                "fs_roots" => fsbrowse::roots(&roots),
                "fs_list" => fsbrowse::list(&roots, &path),
                _ => fsbrowse::stat(&roots, &path),
            })
            .await??)
        }

        other => {
            return Err(AppError(format!("未知命令: {other}")).into())
        }
    })
}
