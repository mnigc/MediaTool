//! Cache and temp-file maintenance: report how much space the app's scratch
//! data takes, and delete only the parts that are safe to drop.
//!
//! Nothing here ever touches the user's download/output directories, and the
//! installed yt-dlp binary is measured but never removed — deleting it would
//! break downloads (reinstalling is what "检查更新" is for).

use std::fs;
use std::path::Path;

use serde::Serialize;
use tauri::{AppHandle, Manager};

/// Every scratch file the app writes into the OS temp dir starts with this
/// prefix (thumbnail frames, size estimates, …). Only that prefix is removed,
/// so a foreign file that happens to sit in the same folder is left alone.
const TEMP_PREFIX: &str = "mediatool_";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheBucket {
    pub key: String,
    /// i18n key of the display label.
    pub label_key: String,
    pub path: String,
    pub size_bytes: u64,
    pub file_count: u64,
    /// Whether "清除缓存" removes this bucket.
    pub removable: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheReport {
    pub total_bytes: u64,
    pub removable_bytes: u64,
    pub buckets: Vec<CacheBucket>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheCleanResult {
    pub freed_bytes: u64,
    pub removed: u64,
    /// Entries that existed but could not be deleted (usually in use).
    pub failed: u64,
}

/// `(total bytes, file count)` of one entry, walking into directories.
fn walk_size(path: &Path) -> (u64, u64) {
    let meta = match fs::metadata(path) {
        Ok(m) => m,
        Err(_) => return (0, 0),
    };
    if !meta.is_dir() {
        return (meta.len(), 1);
    }
    let mut size = 0u64;
    let mut count = 0u64;
    if let Ok(rd) = fs::read_dir(path) {
        for entry in rd.flatten() {
            let (s, c) = walk_size(entry.path().as_path());
            size = size.saturating_add(s);
            count = count.saturating_add(c);
        }
    }
    (size, count)
}

fn managed_bin_dir(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("bin"))
}

/// App scratch entries in the OS temp dir.
fn temp_entries() -> Vec<std::path::PathBuf> {
    let Ok(rd) = fs::read_dir(std::env::temp_dir()) else {
        return Vec::new();
    };
    rd.flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with(TEMP_PREFIX))
        .map(|e| e.path())
        .collect()
}

/// Partial `.download` files left behind by a failed yt-dlp install/update, and
/// the staging archive/folder a interrupted streamlink install leaves behind.
fn partial_entries(bin_dir: &Path) -> Vec<std::path::PathBuf> {
    let Ok(rd) = fs::read_dir(bin_dir) else {
        return Vec::new();
    };
    rd.flatten()
        .filter(|e| {
            let n = e.file_name().to_string_lossy().to_string();
            n.ends_with(".download") || n.ends_with(".stage") || n.ends_with(".stage.zip")
        })
        .map(|e| e.path())
        .collect()
}

#[tauri::command]
pub fn cache_report(app: AppHandle) -> CacheReport {
    let mut buckets = Vec::new();

    let mut temp_size = 0u64;
    let mut temp_count = 0u64;
    for p in temp_entries() {
        let (s, c) = walk_size(&p);
        temp_size = temp_size.saturating_add(s);
        temp_count = temp_count.saturating_add(c);
    }
    buckets.push(CacheBucket {
        key: "temp".into(),
        label_key: "cache.temp".into(),
        path: std::env::temp_dir().to_string_lossy().to_string(),
        size_bytes: temp_size,
        file_count: temp_count,
        removable: true,
    });

    if let Some(bin_dir) = managed_bin_dir(&app) {
        let mut part_size = 0u64;
        let mut part_count = 0u64;
        for p in partial_entries(&bin_dir) {
            let (s, c) = walk_size(&p);
            part_size = part_size.saturating_add(s);
            part_count = part_count.saturating_add(c);
        }
        buckets.push(CacheBucket {
            key: "partial".into(),
            label_key: "cache.partial".into(),
            path: bin_dir.to_string_lossy().to_string(),
            size_bytes: part_size,
            file_count: part_count,
            removable: true,
        });

        // The managed engine binary, when the user installed it in-app.
        let engine = bin_dir.join(crate::ytdlp::binary_name());
        let (engine_size, engine_count) = walk_size(&engine);
        if engine_count > 0 {
            buckets.push(CacheBucket {
                key: "engine".into(),
                label_key: "cache.engine".into(),
                path: engine.to_string_lossy().to_string(),
                size_bytes: engine_size,
                file_count: engine_count,
                removable: false,
            });
        }

        // The live-recording engine, unpacked from the bundle on first start.
        let engine = bin_dir.join(crate::streamlink::PORTABLE_DIR);
        let (engine_size, engine_count) = walk_size(&engine);
        if engine_count > 0 {
            buckets.push(CacheBucket {
                key: "streamlink".into(),
                label_key: "cache.streamlink".into(),
                path: engine.to_string_lossy().to_string(),
                size_bytes: engine_size,
                file_count: engine_count,
                removable: false,
            });
        }
    }

    let total_bytes = buckets.iter().map(|b| b.size_bytes).sum();
    let removable_bytes = buckets.iter().filter(|b| b.removable).map(|b| b.size_bytes).sum();
    CacheReport { total_bytes, removable_bytes, buckets }
}

/// Delete every removable entry. Runs off the main thread: the scan plus the
/// recursive removals can mean thousands of filesystem calls.
#[tauri::command]
pub async fn cache_clean(app: AppHandle) -> CacheCleanResult {
    let bin_dir = managed_bin_dir(&app);
    let result = tauri::async_runtime::spawn_blocking(move || {
        let bin_dir = bin_dir;
        let mut targets: Vec<std::path::PathBuf> = temp_entries();
        if let Some(dir) = &bin_dir {
            targets.extend(partial_entries(dir));
        }

        let mut freed_bytes = 0u64;
        let mut removed = 0u64;
        let mut failed = 0u64;
        for p in targets {
            let (size, _) = walk_size(&p);
            let ok = if p.is_dir() {
                fs::remove_dir_all(&p).is_ok()
            } else {
                fs::remove_file(&p).is_ok()
            };
            if ok {
                freed_bytes = freed_bytes.saturating_add(size);
                removed += 1;
            } else {
                failed += 1;
            }
        }
        (freed_bytes, removed, failed)
    })
    .await
    .unwrap_or((0, 0, 0));

    let (freed_bytes, removed, failed) = result;
    CacheCleanResult { freed_bytes, removed, failed }
}
