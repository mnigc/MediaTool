//! The desktop shell's implementation of the engine's environment traits.
//!
//! Everything engine-side is GUI-agnostic (see `mediatool-core::ctx`); this
//! module is the only place that knows about Tauri's paths and event system.

use std::path::PathBuf;
use std::sync::Arc;

use mediatool_core::ctx::{AppEnv, Ctx, Emitter};
use tauri::{AppHandle, Manager};

/// Filesystem environment backed by Tauri's resolved directories.
struct TauriEnv {
    app: AppHandle,
}

impl AppEnv for TauriEnv {
    fn resource_dir(&self) -> Option<PathBuf> {
        self.app.path().resource_dir().ok()
    }

    fn app_data_dir(&self) -> Option<PathBuf> {
        self.app.path().app_data_dir().ok()
    }

    fn open_url(&self, url: &str) {
        use tauri_plugin_opener::OpenerExt;
        let _ = self.app.opener().open_url(url, None::<&str>);
    }
}

/// Event sink backed by Tauri's emit (webview listeners).
struct TauriEmitter {
    app: AppHandle,
}

impl Emitter for TauriEmitter {
    fn emit(&self, event: &str, payload: serde_json::Value) {
        use tauri::Emitter as _;
        let _ = self.app.emit(event, payload);
    }
}

/// The managers shared by both shells. The desktop app `manage`s the same
/// Arcs so `kill_all` on exit reaches the engine's jobs.
pub struct ShellState {
    pub ctx: Ctx,
    pub jobs: Arc<mediatool_core::state::JobManager>,
}

pub fn build(app: &AppHandle) -> ShellState {
    let env: Arc<dyn AppEnv> = Arc::new(TauriEnv { app: app.clone() });
    let emitter: Arc<dyn Emitter> = Arc::new(TauriEmitter { app: app.clone() });
    let jobs = Arc::new(mediatool_core::state::JobManager::new());
    let monitors = Arc::new(mediatool_core::ytdlp::MonitorManager::default());
    let uploads = Arc::new(mediatool_core::upload::UploadManager::default());
    let oauth = Arc::new(mediatool_core::upload::OauthManager::default());
    let ctx = Ctx::new(env, emitter, jobs.clone(), monitors, uploads, oauth);
    ShellState { ctx, jobs }
}
