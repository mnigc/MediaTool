//! Headless MediaTool: the shared engine behind HTTP + WebSocket.

mod auth;
mod config;
mod env;
mod events;
mod fsbrowse;
mod oauth;
mod paths;
mod rpc;
mod ws;

use std::sync::Arc;

use axum::http::Method;
use axum::routing::{get, post};
use axum::Json;
use axum::Router;
use mediatool_core::ctx::Ctx;
use mediatool_core::state::JobManager;
use mediatool_core::{streamlink, upload, ytdlp};
use tower_http::cors::{Any, CorsLayer};
use tower_http::services::ServeDir;

use crate::auth::Auth;
use crate::config::Config;
use crate::env::ServerEnv;
use crate::events::WsEmitter;
use crate::paths::Roots;
use crate::rpc::AppState;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    if let Err(e) = run().await {
        tracing::error!(%e, "服务启动失败");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let cfg = Config::load();
    cfg.validate()?;

    let roots = Roots::new(&cfg.roots);
    if roots.is_empty() {
        tracing::warn!(
            "配置的目录全部不存在，文件浏览将不可用；检查挂载: {:?}",
            cfg.roots
        );
    } else {
        tracing::info!(allowed = ?roots.list(), "文件浏览允许根目录");
    }

    let emitter = Arc::new(WsEmitter::new(1024));
    let ctx = Ctx::new(
        Arc::new(ServerEnv::new(
            cfg.data_dir.clone(),
            cfg.resource_dir.clone(),
            cfg.oauth_base(),
        )),
        emitter.clone(),
        Arc::new(JobManager::new()),
        Arc::new(ytdlp::MonitorManager::default()),
        Arc::new(upload::UploadManager::default()),
        Arc::new(upload::OauthManager::default()),
    );

    // Same warm-up the desktop app does at startup: unpack the recording
    // engine and put live monitors back to sleep/wake on their own schedule.
    streamlink::prepare(&ctx);
    ytdlp::resume_monitors(&ctx);

    let state = Arc::new(AppState {
        ctx: ctx.clone(),
        roots,
    });

    let api = Router::new()
        .route(
            "/api/invoke/{command}",
            post(rpc::handle).with_state(state.clone()),
        )
        .route("/api/events", get(ws::upgrade).with_state(emitter))
        .layer(axum::middleware::from_fn_with_state(
            Auth::new(cfg.token.clone()),
            auth::require_token,
        ));

    // Unauthenticated on purpose: a container healthcheck must not need the
    // operator's token, and the OAuth callback is reached by the browser
    // straight from the provider. `/healthz` reports nothing but liveness;
    // `/oauth/callback` is only useful with a `state` the app handed out.
    let open = Router::new()
        .route(
            "/healthz",
            get(|| async move {
                Json(serde_json::json!({
                    "ok": true,
                    "version": env!("CARGO_PKG_VERSION"),
                }))
            }),
        )
        .route("/oauth/callback", get(oauth::callback).with_state(state));

    let app = Router::new().merge(api).merge(open);

    // The token is a header/query credential rather than a cookie, so a
    // permissive CORS policy here does not open a CSRF path.
    let mut app = app.layer(
        CorsLayer::new()
            .allow_origin(Any)
            .allow_methods([Method::GET, Method::POST])
            .allow_headers(Any),
    );

    let static_dir = cfg.static_dir.filter(|d| d.is_dir());
    match &static_dir {
        Some(dir) => {
            app = app.fallback_service(ServeDir::new(dir));
            tracing::info!(dir = %dir.display(), "托管前端静态文件");
        }
        None => {
            app = app.fallback(|| async {
                (
                    axum::http::StatusCode::NOT_FOUND,
                    "未找到前端资源：请用 --static 或 MEDIATOOL_STATIC 指向前端构建产物",
                )
            });
        }
    }

    let listener = tokio::net::TcpListener::bind(&cfg.listen).await?;
    let addr = listener.local_addr()?;
    tracing::info!(%addr, "MediaTool 服务已就绪");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    // Mirrors the desktop app's exit hook: never leave an ffmpeg child
    // writing to the volume after the process is gone.
    ctx.jobs.kill_all();
    Ok(())
}

/// Ctrl-C everywhere, SIGTERM as well, since that is what `docker stop` sends.
async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut s) => {
                s.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {}
        _ = terminate => {}
    }
    tracing::info!("收到退出信号，正在终止运行中的任务");
}
