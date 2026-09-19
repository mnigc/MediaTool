//! The shell-provided environment the engine runs in.
//!
//! The engine crate is GUI- and Tauri-free: the desktop app and the headless
//! server are thin shells that implement [`AppEnv`] (where bundled binaries
//! and app data live) and [`Emitter`] (where progress events go), bundle them
//! into a [`Ctx`], and hand it to the engine.

use std::path::PathBuf;
use std::sync::Arc;

use crate::state::JobManager;

/// Filesystem environment: where bundled resources and writable app data are.
pub trait AppEnv: Send + Sync + 'static {
    /// Directory holding bundled resources (streamlink.zip, engine binaries in
    /// packaged builds). `None` when the shell has no bundled resources.
    fn resource_dir(&self) -> Option<PathBuf>;
    /// Writable per-app data dir (monitors.json, yt-dlp cookies, managed
    /// binaries). `None` when there is nowhere writable.
    fn app_data_dir(&self) -> Option<PathBuf>;
    /// Open a URL in the user's browser (OAuth consent pages). A headless
    /// shell may fall back to logging the URL so the operator can open it.
    fn open_url(&self, url: &str);
    /// Base URL this shell is reachable at from the user's browser, e.g.
    /// `http://nas.local:8787`. When set, OAuth redirects to a callback page
    /// served by the shell at `<base>/oauth/callback`; when `None` the shell
    /// catches the redirect on a loopback port of its own, which only works
    /// when the browser runs next to the process (desktop).
    fn oauth_redirect_base(&self) -> Option<String> {
        None
    }
}

/// Progress-event sink. Desktop emits into the webview; the server broadcasts
/// over WebSocket. Events keep the same names/payloads on both shells.
pub trait Emitter: Send + Sync + 'static {
    fn emit(&self, event: &str, payload: serde_json::Value);
}

/// Emit a serializable payload through an [`Emitter`].
pub fn emit<T: serde::Serialize>(emitter: &dyn Emitter, event: &str, payload: &T) {
    emitter.emit(
        event,
        serde_json::to_value(payload).unwrap_or(serde_json::Value::Null),
    );
}

/// Everything the engine needs from its shell, handed down as one handle.
///
/// The manager fields are added here rather than fetched from a framework's
/// state store so the engine works identically under Tauri and axum.
#[derive(Clone)]
pub struct Ctx {
    pub env: Arc<dyn AppEnv>,
    pub emitter: Arc<dyn Emitter>,
    pub jobs: Arc<JobManager>,
    /// Live-download/record monitor registry (ytdlp.rs).
    pub monitors: Arc<crate::ytdlp::MonitorManager>,
    /// In-flight upload registry (upload.rs).
    pub uploads: Arc<crate::upload::UploadManager>,
    /// Pending OAuth authorization registry (upload.rs).
    pub oauth: Arc<crate::upload::OauthManager>,
}

impl Ctx {
    pub fn new(
        env: Arc<dyn AppEnv>,
        emitter: Arc<dyn Emitter>,
        jobs: Arc<JobManager>,
        monitors: Arc<crate::ytdlp::MonitorManager>,
        uploads: Arc<crate::upload::UploadManager>,
        oauth: Arc<crate::upload::OauthManager>,
    ) -> Self {
        Self {
            env,
            emitter,
            jobs,
            monitors,
            uploads,
            oauth,
        }
    }
}
