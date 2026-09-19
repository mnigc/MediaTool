use std::process::Command;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

use crate::ctx::AppEnv;
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

/// A hardware encoder and the arguments that reproduce how `jobs.rs` invokes
/// it. VAAPI is the one backend that cannot be named without also naming a
/// render node and uploading frames, so the tail is per-backend rather than a
/// bare codec list.
struct Backend {
    id: &'static str,
    name: &'static str,
    codec: &'static str,
    tail: &'static [&'static str],
}

const BACKENDS: &[Backend] = &[
    Backend {
        id: "nvenc",
        name: "NVIDIA NVENC",
        codec: "h264_nvenc",
        tail: &["-c:v", "h264_nvenc"],
    },
    Backend {
        id: "qsv",
        name: "Intel Quick Sync",
        codec: "h264_qsv",
        tail: &["-c:v", "h264_qsv"],
    },
    Backend {
        id: "videotoolbox",
        name: "Apple VideoToolbox",
        codec: "h264_videotoolbox",
        tail: &["-c:v", "h264_videotoolbox"],
    },
    Backend {
        id: "amf",
        name: "AMD AMF",
        codec: "h264_amf",
        tail: &["-c:v", "h264_amf"],
    },
    Backend {
        id: "vaapi",
        name: "VAAPI (Linux)",
        codec: "h264_vaapi",
        tail: &[
            "-vaapi_device",
            "/dev/dri/renderD128",
            "-vf",
            "format=nv12,hwupload",
            "-c:v",
            "h264_vaapi",
        ],
    },
];

/// A 256px, ~2-frame encode. Fast enough to run at startup, real enough to
/// fail when the driver or device is missing.
const PROBE_INPUT: &str = "color=c=black:s=256x256:d=0.1";

/// Detection spawns ffmpeg processes, so the result is computed once. It is
/// only cached once ffmpeg has actually been located: before that the answer
/// is "nothing", and caching that would hide the GPU for the whole session.
static CACHED: OnceLock<GpuInfo> = OnceLock::new();

/// Run `ffmpeg -encoders` and return its output (stdout, falling back to
/// stderr) — used only to skip backends the build does not even contain.
fn encoder_listing(bin: &std::path::Path) -> String {
    let output = Command::new(bin)
        .args(["-hide_banner", "-encoders"])
        .output();
    match output {
        Ok(o) => {
            let mut s = String::from_utf8_lossy(&o.stdout).to_string();
            if s.trim().is_empty() {
                s = String::from_utf8_lossy(&o.stderr).to_string();
            }
            s
        }
        Err(_) => String::new(),
    }
}

/// Ask ffmpeg to actually encode with this backend. Success means the driver
/// loaded, the device was found and the encoder accepted a frame.
fn backend_works(bin: &std::path::Path, backend: &Backend) -> bool {
    let mut args = vec![
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-f",
        "lavfi",
        "-i",
        PROBE_INPUT,
    ];
    args.extend_from_slice(backend.tail);
    args.extend_from_slice(&["-f", "null", "-"]);
    Command::new(bin)
        .args(&args)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn detect(env: &dyn AppEnv) -> Option<GpuInfo> {
    let bin = ffmpeg::resolve(env, "ffmpeg")?;
    let listing = encoder_listing(&bin);
    let backends: Vec<GpuBackend> = BACKENDS
        .iter()
        .filter(|b| listing.contains(b.codec))
        .filter(|b| backend_works(&bin, b))
        .map(|b| GpuBackend {
            id: b.id.to_string(),
            name: b.name.to_string(),
        })
        .collect();
    Some(GpuInfo {
        available: !backends.is_empty(),
        backends,
    })
}

/// Detect usable hardware video encoders.
///
/// Listing `ffmpeg -encoders` is not enough: a Linux distro build compiles in
/// qsv, vaapi and amf alike, so the text says every vendor is present even on
/// a machine with none of their hardware. Each candidate therefore has to
/// encode a frame before it is offered to the user.
pub fn detect_gpu(env: &dyn AppEnv) -> Result<GpuInfo> {
    if let Some(cached) = CACHED.get() {
        return Ok(cached.clone());
    }
    let info = detect(env).ok_or_else(|| AppError("找不到 ffmpeg，无法检测 GPU 支持".into()))?;
    let _ = CACHED.set(info.clone());
    Ok(info)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_backend_names_the_codec_it_probes() {
        for b in BACKENDS {
            assert!(
                b.tail.windows(2).any(|w| w[0] == "-c:v" && w[1] == b.codec),
                "{} must pass its own codec to -c:v",
                b.id
            );
        }
    }

    #[test]
    fn ids_are_unique() {
        let mut seen = std::collections::HashSet::new();
        for b in BACKENDS {
            assert!(seen.insert(b.id), "duplicate backend id {}", b.id);
        }
    }
}
