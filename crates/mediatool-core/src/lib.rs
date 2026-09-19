//! Pure media-processing engine for MediaTool.
//!
//! Everything in this crate runs without a GUI or Tauri: the desktop app and
//! the headless server are thin shells on top of it. Tauri-coupled concerns
//! (event emission, binary/location lookup) are reached through the traits
//! defined here, so each shell provides its own implementation.

pub mod cache;
pub mod ctx;
pub mod error;
pub mod ffmpeg;
pub mod gpu;
pub mod inspect;
pub mod jobs;
pub mod media;
pub mod models;
pub mod state;
pub mod streamlink;
pub mod thumbnail;
pub mod upload;
pub mod ytdlp;

/// Run a future to completion on a private current-thread runtime.
///
/// Blocking engine threads (upload workers, install helpers) sometimes need to
/// await async work; this mirrors the old `tauri::async_runtime::block_on`
/// semantics without depending on an ambient runtime.
pub fn block_on_owned<F: std::future::Future>(fut: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("failed to build block-on runtime")
        .block_on(fut)
}
