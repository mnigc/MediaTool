//! Shared helpers for the jobs modules: output-path and overwrite-policy
//! resolution, codec / GPU / preset mapping, filter-chain fragments and other
//! small pure utilities used by the argument builders, job preparation and
//! the runtime loop.
use std::path::{Path, PathBuf};

use crate::error::{AppError, Result};
use crate::models::{GpuBackend, MediaInfo, SpeedPreset, VideoCodec, VideoParams};

/// Build the output path, placing the result next to the input (or in output_dir).
pub(super) fn output_path(
    input: &str,
    output_dir: &Option<String>,
    ext: &str,
    suffix: &str,
) -> Result<PathBuf> {
    output_path_labeled(input, output_dir, ext, suffix, "")
}

/// Like `output_path` but inserts an extra `label` (e.g. "_1", "_2") before the
/// extension so multiple outputs from the same job never collide.
pub(super) fn output_path_labeled(
    input: &str,
    output_dir: &Option<String>,
    ext: &str,
    suffix: &str,
    label: &str,
) -> Result<PathBuf> {
    let input_p = Path::new(input);
    let stem = input_p
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("media")
        .to_string();
    let dir = match output_dir {
        Some(d) => PathBuf::from(d),
        None => input_p
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| PathBuf::from(".")),
    };
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join(format!("{}{}{}.{}", stem, suffix, label, ext)))
}

/// Apply the overwrite policy to a computed output path.
/// - "overwrite": keep as-is (ffmpeg runs with -y)
/// - "skip" / others: returned untouched; caller decides based on existence
/// - "rename": when the file exists, produce "<stem> (2).<ext>", " (3)", …
pub(crate) fn apply_overwrite_policy(out: PathBuf, policy: &str) -> PathBuf {
    if !out.exists() || policy == "overwrite" {
        return out;
    }
    if policy != "rename" {
        return out; // "skip" handled by the caller via existence check
    }
    let dir = out
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));
    let stem = out
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("media")
        .to_string();
    let ext = out
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    for n in 2..10000u32 {
        let name = if ext.is_empty() {
            format!("{} ({})", stem, n)
        } else {
            format!("{} ({}).{}", stem, n, ext)
        };
        let candidate = dir.join(name);
        if !candidate.exists() {
            return candidate;
        }
    }
    out
}

/// Strip container-level metadata (and chapters) via -map_metadata -1.
pub(super) fn metadata_strip_args(strip: bool, with_chapters: bool) -> Vec<String> {
    if !strip {
        return vec![];
    }
    let mut a = vec!["-map_metadata".to_string(), "-1".to_string()];
    if with_chapters {
        a.push("-map_chapters".to_string());
        a.push("-1".to_string());
    }
    a
}

/// Software HDR→SDR tone-mapping chain, prepended before any scaling: linearize
/// the PQ/HLG transfer (1000-nit nominal peak), Hable-map into SDR, then
/// convert to BT.709 8-bit 4:2:0. The bundled ffmpeg ships libzimg (zscale)
/// and the tonemap filter, so this is always available; stream copy never
/// touches it.
pub(super) fn hdr_tonemap_vf() -> &'static str {
    "zscale=t=linear:npl=1000,format=gbrpf32le,tonemap=hable:desat=0,zscale=p=bt709:t=bt709:m=bt709:r=tv,format=yuv420p"
}

/// Full video filter chain for a job: HDR tone-mapping (HDR sources being
/// re-encoded) followed by the optional resolution scale. Stream copy never
/// gets filters — any filter forces a re-encode.
pub(super) fn video_filter_chain(info: &MediaInfo, codec: &str, resolution: &str) -> Option<String> {
    if codec == "copy" {
        return None;
    }
    let res = resolution_vf(resolution);
    if !info.hdr {
        return res;
    }
    let chain = hdr_tonemap_vf();
    Some(match res {
        Some(s) => format!("{chain},{s}"),
        None => chain.to_string(),
    })
}

fn resolution_vf(res: &str) -> Option<String> {
    match res {
        "original" | "" => None,
        "480p" => Some("scale=-2:480".to_string()),
        "720p" => Some("scale=-2:720".to_string()),
        "1080p" => Some("scale=-2:1080".to_string()),
        "1440p" => Some("scale=-2:1440".to_string()),
        "2160p" => Some("scale=-2:2160".to_string()),
        custom if custom.contains('x') => {
            let parts: Vec<&str> = custom.split('x').collect();
            if parts.len() == 2 {
                // Even-align both sides: yuv420p encoders reject odd dimensions.
                match (
                    parts[0].trim().parse::<i64>(),
                    parts[1].trim().parse::<i64>(),
                ) {
                    (Ok(w), Ok(h)) if w >= 2 && h >= 2 => {
                        Some(format!("scale={}:{}", even(w), even(h)))
                    }
                    _ => None,
                }
            } else {
                None
            }
        }
        _ => None,
    }
}

pub(super) fn vp9_cpu_used(preset: &SpeedPreset) -> u32 {
    match preset {
        SpeedPreset::Veryfast => 5,
        SpeedPreset::Faster => 4,
        SpeedPreset::Fast => 3,
        SpeedPreset::Medium => 2,
        SpeedPreset::Slow => 1,
        SpeedPreset::Slower | SpeedPreset::Veryslow => 0,
        // Unreachable after validation; keeps the historical default.
        SpeedPreset::Other(_) => 2,
    }
}

/// Map the x264-style speed presets onto SVT-AV1's preset (cpu-used) scale.
/// SVT-AV1 accepts roughly 1..=13 where higher = faster / lower quality.
pub(super) fn svt_preset(preset: &SpeedPreset) -> u32 {
    match preset {
        SpeedPreset::Veryfast => 10,
        SpeedPreset::Faster => 9,
        SpeedPreset::Fast => 8,
        SpeedPreset::Medium => 7,
        SpeedPreset::Slow => 5,
        SpeedPreset::Slower => 3,
        SpeedPreset::Veryslow => 2,
        // Unreachable after validation; keeps the historical default.
        SpeedPreset::Other(_) => 7,
    }
}

/// Swap the chosen codec family for the hardware encoder when a backend was
/// picked and the codec has a hardware implementation for it. Returns the
/// effective ffmpeg encoder name plus the `-hwaccel` hint. Unknown codec or
/// backend values fall through to CPU encoding — exactly the behavior the
/// free-string version had.
pub(super) fn gpu_plan(codec: &VideoCodec, gpu: Option<&GpuBackend>) -> (String, Option<&'static str>) {
    let pair = |name: &'static str, accel: Option<&'static str>| (name.to_string(), accel);
    match (codec, gpu) {
        (VideoCodec::LibX264, Some(GpuBackend::Nvenc)) => pair("h264_nvenc", Some("cuda")),
        (VideoCodec::LibX264, Some(GpuBackend::Qsv)) => pair("h264_qsv", Some("qsv")),
        (VideoCodec::LibX264, Some(GpuBackend::Videotoolbox)) => {
            pair("h264_videotoolbox", Some("videotoolbox"))
        }
        (VideoCodec::LibX264, Some(GpuBackend::Amf)) => pair("h264_amf", Some("d3d11va")),
        (VideoCodec::LibX264, Some(GpuBackend::Vaapi)) => pair("h264_vaapi", None),
        (VideoCodec::LibX265, Some(GpuBackend::Nvenc)) => pair("hevc_nvenc", Some("cuda")),
        (VideoCodec::LibX265, Some(GpuBackend::Qsv)) => pair("hevc_qsv", Some("qsv")),
        (VideoCodec::LibX265, Some(GpuBackend::Videotoolbox)) => {
            pair("hevc_videotoolbox", Some("videotoolbox"))
        }
        (VideoCodec::LibX265, Some(GpuBackend::Amf)) => pair("hevc_amf", Some("d3d11va")),
        (VideoCodec::LibX265, Some(GpuBackend::Vaapi)) => pair("hevc_vaapi", None),
        (codec, _) => (codec.as_str().to_string(), None),
    }
}

/// Rough mapping from CRF (x264 18..40, lower = better) to a bitrate in kbps,
/// used by hardware encoders that lack a CRF-style constant-quality mode.
pub(super) fn crf_to_bitrate(crf: u32) -> u32 {
    let c = crf.clamp(18, 40) as i32;
    // 9000 / 230 / 300 are an empirical fit, not a model: CRF 18 ≈ 9 Mbps,
    // minus 230 kbps per CRF step, floored at the encoder's 300 kbps minimum.
    // Chosen so the hardware output lands near its x264 counterpart.
    let b = 9000 - (c - 18) * 230;
    (b.max(300)) as u32
}

/// VAAPI encodes through a DRM render node that only exists on Linux with a
/// loaded GPU driver. Gating on its presence keeps a VAAPI request from
/// reaching ffmpeg with a device path it cannot open (non-Linux platforms or
/// a driverless Linux box would only die with a cryptic muxer error later).
pub(super) fn vaapi_render_node() -> Option<&'static str> {
    const NODE: &str = "/dev/dri/renderD128";
    if cfg!(target_os = "linux") && Path::new(NODE).exists() {
        Some(NODE)
    } else {
        None
    }
}

/// Refuse a VAAPI request early, with an actionable message, when no render
/// node is available. The companion guard for `vaapi_render_node()` — the
/// arg builders themselves stay infallible and simply skip the device flag.
pub(super) fn ensure_vaapi_device(p: &VideoParams) -> Result<()> {
    if gpu_plan(&p.video_codec, p.gpu.as_ref()).0.ends_with("_vaapi") && vaapi_render_node().is_none() {
        return Err(AppError(
            "VAAPI 硬件加速需要 Linux 且存在渲染节点 /dev/dri/renderD128：请检查显卡驱动，或改用 CPU 编码器／其他硬件后端".into(),
        ));
    }
    Ok(())
}

pub(super) fn even(v: i64) -> i64 {
    if v % 2 == 0 {
        v
    } else {
        v - 1
    }
}

/// Build an atempo factor chain for arbitrary rates. atempo only accepts
/// 0.5..=2.0 per instance, so chain factors whose product equals `rate`.
pub(crate) fn atempo_chain(rate: f64) -> Vec<String> {
    let mut rem = rate.clamp(0.25, 4.0);
    let mut factors: Vec<f64> = Vec::new();
    while rem > 2.0 + 1e-9 {
        factors.push(2.0);
        rem /= 2.0;
    }
    while rem < 0.5 - 1e-9 {
        factors.push(0.5);
        rem /= 0.5;
    }
    if (rem - 1.0).abs() > 1e-9 {
        factors.push(rem);
    }
    factors.iter().map(|f| format!("{:.6}", f)).collect()
}

/// Effective duration of a trimmed window, used as the progress denominator:
/// ffmpeg's out_time only covers [start, start+duration).
pub(super) fn trim_window_secs(total: f64, start: f64, dur: Option<f64>) -> f64 {
    let s = start.max(0.0);
    let end = match dur {
        Some(d) if d > 0.0 => s + d,
        _ => total,
    };
    (end.min(total) - s).max(0.0)
}

/// Preserve the input's container extension for re-encoding tools.
pub(super) fn input_ext(info: &MediaInfo, fallback: &str) -> String {
    Path::new(&info.path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .filter(|e| !e.is_empty() && e.len() <= 5 && e.chars().all(|c| c.is_ascii_alphanumeric()))
        .unwrap_or_else(|| fallback.to_string())
}

pub(super) fn uuid() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    // Nanos alone can collide when two jobs start within one clock tick;
    // pid + monotonic counter make the id unique.
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("job-{:x}-{}-{}", nanos, std::process::id(), n)
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overwrite_policy_rename() {
        let dir = std::env::temp_dir().join(format!("mp_ov_test_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let base = dir.join("clip_mediatool.mp4");
        std::fs::write(&base, b"x").unwrap();

        let renamed = apply_overwrite_policy(base.clone(), "rename");
        assert_ne!(renamed, base);
        assert!(renamed.to_string_lossy().contains("(2)"));

        // Existing "(2)" too -> picks "(3)"
        std::fs::write(&renamed, b"x").unwrap();
        let renamed2 = apply_overwrite_policy(base.clone(), "rename");
        assert!(renamed2.to_string_lossy().contains("(3)"));

        // overwrite keeps the path untouched
        assert_eq!(apply_overwrite_policy(base.clone(), "overwrite"), base);
        // skip keeps the path; caller checks existence
        assert_eq!(apply_overwrite_policy(base.clone(), "skip"), base);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn atempo_chain_values() {
        assert_eq!(atempo_chain(1.0), Vec::<String>::new());
        assert_eq!(atempo_chain(1.5), vec!["1.500000".to_string()]);
        assert_eq!(
            atempo_chain(4.0),
            vec!["2.000000".to_string(), "2.000000".to_string()]
        );
        assert_eq!(
            atempo_chain(0.25),
            vec!["0.500000".to_string(), "0.500000".to_string()]
        );
        // 0.75 -> 0.75 stays single (>= 0.5)
        assert_eq!(atempo_chain(0.75), vec!["0.750000".to_string()]);
    }

    #[test]
    fn trim_window_progress_denominator() {
        assert_eq!(trim_window_secs(7200.0, 10.0, Some(10.0)), 10.0);
        assert_eq!(trim_window_secs(100.0, 0.0, Some(500.0)), 100.0);
        assert_eq!(trim_window_secs(100.0, 40.0, None), 60.0);
        assert_eq!(trim_window_secs(100.0, 120.0, None), 0.0);
    }
}
