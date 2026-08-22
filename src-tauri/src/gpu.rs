use std::process::Command;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::ffmpeg;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuBackend {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuInfo {
    pub available: bool,
    pub backends: Vec<GpuBackend>,
}

/// Run `ffmpeg -encoders` and return its stdout (falls back to stderr).
fn probe_encoders(app: &tauri::AppHandle) -> Result<String> {
    let bin = ffmpeg::resolve(app, "ffmpeg").ok_or_else(|| {
        AppError("找不到 ffmpeg，无法检测 GPU 支持".into())
    })?;
    let output = Command::new(&bin)
        .args(["-hide_banner", "-encoders"])
        .output()
        .map_err(AppError::from)?;
    let mut s = String::from_utf8_lossy(&output.stdout).to_string();
    if s.trim().is_empty() {
        s = String::from_utf8_lossy(&output.stderr).to_string();
    }
    Ok(s)
}

/// Detect available hardware-accelerated video encoders by inspecting the
/// FFmpeg build. Returns the list of usable GPU backends (if any).
pub fn detect_gpu(app: &tauri::AppHandle) -> Result<GpuInfo> {
    let text = probe_encoders(app).unwrap_or_default();
    let mut backends: Vec<GpuBackend> = Vec::new();
    let mut seen = std::collections::HashSet::new();

    let candidates: &[(&str, &str)] = &[
        ("nvenc", "NVIDIA NVENC"),
        ("qsv", "Intel Quick Sync"),
        ("videotoolbox", "Apple VideoToolbox"),
        ("amf", "AMD AMF"),
        ("vaapi", "VAAPI (Linux)"),
    ];

    for (id, name) in candidates {
        if text.contains(id) && seen.insert(*id) {
            backends.push(GpuBackend {
                id: id.to_string(),
                name: name.to_string(),
            });
        }
    }

    Ok(GpuInfo {
        available: !backends.is_empty(),
        backends,
    })
}
