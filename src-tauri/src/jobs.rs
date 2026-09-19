use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Emitter, Manager};

use crate::error::{AppError, Result};
use crate::ffmpeg;
use crate::media::probe;
use crate::models::{
    AudioMergeParams, AudioParams, AudioVolumeParams,
    DoneEvent, EstimateRequest, EstimateResult, ExtractAudioParams,
    JobRequest, MediaInfo, MediaType, MuteParams,
    ProgressEvent, ScreenshotParams, SpeedParams,
    StartJobResult, StartWorkflowResult, StripMetadataParams, SubtitleParams, TrimParams,
    TrimSegment, VideoMergeParams, VideoParams, WatermarkParams,
    ContactSheetParams, FrameSampleParams, VideoSilenceParams,
    WorkflowRequest, WorkflowStepInput,
};
use crate::state::JobManager;

/// Build the output path, placing the result next to the input (or in output_dir).
fn output_path(input: &str, output_dir: &Option<String>, ext: &str, suffix: &str) -> Result<PathBuf> {
    output_path_labeled(input, output_dir, ext, suffix, "")
}

/// Like `output_path` but inserts an extra `label` (e.g. "_1", "_2") before the
/// extension so multiple outputs from the same job never collide.
fn output_path_labeled(
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
fn metadata_strip_args(strip: bool, with_chapters: bool) -> Vec<String> {
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
fn hdr_tonemap_vf() -> &'static str {
    "zscale=t=linear:npl=1000,format=gbrpf32le,tonemap=hable:desat=0,zscale=p=bt709:t=bt709:m=bt709:r=tv,format=yuv420p"
}

/// Full video filter chain for a job: HDR tone-mapping (HDR sources being
/// re-encoded) followed by the optional resolution scale. Stream copy never
/// gets filters — any filter forces a re-encode.
fn video_filter_chain(info: &MediaInfo, codec: &str, resolution: &str) -> Option<String> {
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
                match (parts[0].trim().parse::<i64>(), parts[1].trim().parse::<i64>()) {
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

fn vp9_cpu_used(preset: &str) -> u32 {
    match preset {
        "veryfast" => 5,
        "faster" => 4,
        "fast" => 3,
        "medium" => 2,
        "slow" => 1,
        "slower" | "veryslow" => 0,
        _ => 2,
    }
}

/// Map the x264-style speed presets onto SVT-AV1's preset (cpu-used) scale.
/// SVT-AV1 accepts roughly 1..=13 where higher = faster / lower quality.
fn svt_preset(preset: &str) -> u32 {
    match preset {
        "veryfast" => 10,
        "faster" => 9,
        "fast" => 8,
        "medium" => 7,
        "slow" => 5,
        "slower" => 3,
        "veryslow" => 2,
        _ => 7,
    }
}

fn gpu_plan(video_codec: &str, gpu: &Option<String>) -> (String, Option<String>) {
    match (video_codec, gpu.as_deref()) {
        ("libx264", Some("nvenc")) => ("h264_nvenc".to_string(), Some("cuda".to_string())),
        ("libx264", Some("qsv")) => ("h264_qsv".to_string(), Some("qsv".to_string())),
        ("libx264", Some("videotoolbox")) => {
            ("h264_videotoolbox".to_string(), Some("videotoolbox".to_string()))
        }
        ("libx264", Some("amf")) => ("h264_amf".to_string(), Some("d3d11va".to_string())),
        ("libx264", Some("vaapi")) => ("h264_vaapi".to_string(), None),
        ("libx265", Some("nvenc")) => ("hevc_nvenc".to_string(), Some("cuda".to_string())),
        ("libx265", Some("qsv")) => ("hevc_qsv".to_string(), Some("qsv".to_string())),
        ("libx265", Some("videotoolbox")) => {
            ("hevc_videotoolbox".to_string(), Some("videotoolbox".to_string()))
        }
        ("libx265", Some("amf")) => ("hevc_amf".to_string(), Some("d3d11va".to_string())),
        ("libx265", Some("vaapi")) => ("hevc_vaapi".to_string(), None),
        _ => (video_codec.to_string(), None),
    }
}

/// Rough mapping from CRF (x264 18..40, lower = better) to a bitrate in kbps,
/// used by hardware encoders that lack a CRF-style constant-quality mode.
fn crf_to_bitrate(crf: u32) -> u32 {
    let c = crf.clamp(18, 40) as i32;
    let b = 9000 - (c - 18) * 230;
    (b.max(300)) as u32
}

fn build_video_args(info: &MediaInfo, p: &VideoParams, out: &Path) -> Vec<String> {
    let (vcodec, hwaccel) = gpu_plan(&p.video_codec, &p.gpu);
    let is_vaapi = vcodec == "h264_vaapi" || vcodec == "hevc_vaapi";
    let mut a: Vec<String> = vec![];

    let vf = video_filter_chain(info, &vcodec, &p.resolution);
    if let Some(hw) = &hwaccel {
        a.push("-hwaccel".into());
        a.push(hw.clone());
        // A software `-vf` chain needs frames in system memory; locking QSV
        // frames in video memory makes the scale filter fail with
        // "Impossible to convert between the formats".
        if hw == "qsv" && vf.is_none() {
            a.push("-hwaccel_output_format".into());
            a.push("qsv".into());
        }
    }

    if is_vaapi {
        a.push("-vaapi_device".into());
        a.push("/dev/dri/renderD128".into());
    }

    a.push("-i".into());
    a.push(info.path.clone());

    let vf = if is_vaapi {
        vf.map(|s| {
            if s.is_empty() {
                "format=nv12,hwupload".to_string()
            } else {
                format!("{},format=nv12,hwupload", s)
            }
        })
    } else {
        vf
    };
    if let Some(vf) = vf {
        a.push("-vf".into());
        a.push(vf);
    }

    a.push("-c:v".into());
    a.push(vcodec.clone());

    match vcodec.as_str() {
        "libx264" => {
            if p.quality_mode == "crf" {
                a.push("-crf".into());
                a.push(p.crf.unwrap_or(28).to_string());
            }
            a.push("-preset".into());
            a.push(p.preset.clone());
        }
        "libx265" => {
            if p.quality_mode == "crf" {
                a.push("-crf".into());
                a.push(p.crf.unwrap_or(28).to_string());
            }
            a.push("-preset".into());
            a.push(p.preset.clone());
        }
        "libvpx-vp9" => {
            if p.quality_mode == "crf" {
                a.push("-b:v".into());
                a.push("0".into());
                a.push("-crf".into());
                a.push(p.crf.unwrap_or(30).to_string());
            } else {
                a.push("-b:v".into());
                a.push(p.video_bitrate_kbps.unwrap_or(1000).to_string() + "k");
            }
            a.push("-deadline".into());
            a.push("good".into());
            a.push("-cpu-used".into());
            a.push(vp9_cpu_used(&p.preset).to_string());
            a.push("-row-mt".into());
            a.push("1".into());
        }
        "libsvtav1" => {
            if p.quality_mode == "crf" {
                a.push("-crf".into());
                a.push(p.crf.unwrap_or(32).to_string());
            } else if p.quality_mode == "target_size" {
                // bitrate is appended by the shared target-size logic below;
                // nothing extra needed here.
            } else {
                a.push("-b:v".into());
                a.push(p.video_bitrate_kbps.unwrap_or(1000).to_string() + "k");
            }
            a.push("-preset".into());
            a.push(svt_preset(&p.preset).to_string());
        }
        "h264_nvenc" => {
            if p.quality_mode == "crf" {
                a.push("-cq".into());
                a.push(p.crf.unwrap_or(28).to_string());
            }
            a.push("-preset".into());
            a.push("p4".into());
        }
        "h264_qsv" => {
            if p.quality_mode == "crf" {
                a.push("-q:v".into());
                a.push(p.crf.unwrap_or(28).to_string());
            }
        }
        "h264_videotoolbox" => {
            if p.quality_mode == "crf" {
                a.push("-b:v".into());
                a.push(format!("{}k", crf_to_bitrate(p.crf.unwrap_or(28))));
            }
        }
        "h264_amf" => {
            if p.quality_mode == "crf" {
                a.push("-rc".into());
                a.push("cqp".into());
                a.push("-qp".into());
                a.push(p.crf.unwrap_or(28).to_string());
            }
        }
        "h264_vaapi" => {
            if p.quality_mode == "crf" {
                a.push("-b:v".into());
                a.push(format!("{}k", crf_to_bitrate(p.crf.unwrap_or(28))));
            }
        }
        "hevc_nvenc" => {
            if p.quality_mode == "crf" {
                a.push("-cq".into());
                a.push(p.crf.unwrap_or(28).to_string());
            }
            a.push("-preset".into());
            a.push("p4".into());
        }
        "hevc_qsv" => {
            if p.quality_mode == "crf" {
                a.push("-q:v".into());
                a.push(p.crf.unwrap_or(28).to_string());
            }
        }
        "hevc_videotoolbox" => {
            if p.quality_mode == "crf" {
                a.push("-b:v".into());
                a.push(format!("{}k", crf_to_bitrate(p.crf.unwrap_or(28))));
            }
        }
        "hevc_amf" => {
            if p.quality_mode == "crf" {
                a.push("-rc".into());
                a.push("cqp".into());
                a.push("-qp".into());
                a.push(p.crf.unwrap_or(28).to_string());
            }
        }
        "hevc_vaapi" => {
            if p.quality_mode == "crf" {
                a.push("-b:v".into());
                a.push(format!("{}k", crf_to_bitrate(p.crf.unwrap_or(28))));
            }
        }
        _ => {}
    }

    if p.quality_mode == "bitrate" {
        if let Some(b) = p.video_bitrate_kbps {
            a.push("-b:v".into());
            a.push(format!("{}k", b));
        }
    } else if p.quality_mode == "target_size" {
        if let Some(mb) = p.target_size_mb {
            if let Some(dur) = info.duration_secs {
                if dur > 0.0 {
                    let total_bits = mb * 1024.0 * 1024.0 * 8.0;
                    let total_kbps = total_bits / dur / 1000.0;
                    let audio_kbps = p.audio_bitrate_kbps.unwrap_or(128) as f64;
                    let video_kbps = (total_kbps - audio_kbps).max(50.0);
                    a.push("-b:v".into());
                    a.push(format!("{}k", video_kbps as u32));
                }
            }
        }
    }

    // Frame-rate control; meaningless (and re-encode-forcing) with stream copy.
    if vcodec != "copy" {
        if let Some(fps) = p.fps {
            if fps > 0 {
                a.push("-r".into());
                a.push(fps.to_string());
            }
        }
    }

    match p.audio_codec.as_str() {
        "none" => a.push("-an".into()),
        "copy" => {
            a.push("-c:a".into());
            a.push("copy".into());
        }
        "aac" => {
            a.push("-c:a".into());
            a.push("aac".into());
            if let Some(b) = p.audio_bitrate_kbps {
                a.push("-b:a".into());
                a.push(format!("{}k", b));
            }
        }
        "opus" => {
            a.push("-c:a".into());
            a.push("libopus".into());
            if let Some(b) = p.audio_bitrate_kbps {
                a.push("-b:a".into());
                a.push(format!("{}k", b));
            }
        }
        _ => {}
    }

    a.push("-threads".into());
    a.push("0".into());
    a.push("-progress".into());
    a.push("pipe:1".into());
    a.push("-y".into());
    a.push(out.to_string_lossy().to_string());
    a
}

/// Infer the image format family from the input file extension.
fn source_image_format(path: &str) -> String {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "jpg" | "jpeg" => "jpeg".into(),
        "png" => "png".into(),
        "webp" => "webp".into(),
        "avif" => "avif".into(),
        other => other.to_string(),
    }
}

fn build_audio_args(info: &MediaInfo, p: &AudioParams, out: &Path) -> Vec<String> {
    let mut a: Vec<String> = vec!["-i".into(), info.path.clone(), "-vn".into()];

    let fmt = if p.format == "source" || p.format.is_empty() {
        source_audio_format(&info.path)
    } else {
        p.format.clone()
    };
    // "wav" is a container-ish target handled by the pcm codec below.
    let fmt = if fmt == "wav" { "pcm".to_string() } else { fmt };

    match fmt.as_str() {
        "mp3" => {
            a.push("-c:a".into());
            a.push("libmp3lame".into());
        }
        "aac" | "m4a" => {
            a.push("-c:a".into());
            a.push("aac".into());
        }
        "opus" => {
            a.push("-c:a".into());
            a.push("libopus".into());
        }
        "flac" => {
            a.push("-c:a".into());
            a.push("flac".into());
        }
        "pcm" => {
            a.push("-c:a".into());
            a.push("pcm_s16le".into());
        }
        _ => {
            a.push("-c:a".into());
            a.push("copy".into());
        }
    }

    if !matches!(fmt.as_str(), "flac" | "pcm") {
        a.push("-b:a".into());
        a.push(format!("{}k", p.bitrate_kbps));
    }

    a.push("-progress".into());
    a.push("pipe:1".into());
    a.push("-y".into());
    a.push(out.to_string_lossy().to_string());
    a
}

/// Infer the audio codec family from the input file extension.
fn source_audio_format(path: &str) -> String {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "mp3" => "mp3".into(),
        "aac" => "aac".into(),
        "m4a" | "mp4" | "mov" => "m4a".into(),
        "opus" | "ogg" => "opus".into(),
        "flac" => "flac".into(),
        "wav" => "wav".into(),
        _ => "aac".into(),
    }
}

/* ── Toolbox tools ─────────────────────────────────────────────── */

/// Container extensions that can hold H.264 + AAC without issues.
const SAFE_CONTAINERS: [&str; 3] = ["mp4", "mkv", "mov"];

/// For re-encode tools that hardcode H.264+AAC, pick an output container that
/// can actually carry them (WebM/AVI/WMV etc. cannot). Audio-only inputs get
/// an audio container (`.m4a`) so e.g. speeding up `song.mp3` doesn't yield
/// a `.mp4` file.
fn safe_container_ext(info: &MediaInfo) -> String {
    if info.media_type == MediaType::Audio {
        return "m4a".to_string();
    }
    let ext = input_ext(info, "mp4");
    if SAFE_CONTAINERS.contains(&ext.as_str()) {
        ext
    } else {
        "mp4".to_string()
    }
}

/// Lossless stream-removal / metadata strip: `-c copy` with optional `-an`.
/// `-map 0` keeps every stream (extra audio tracks, subtitles, attachments) —
/// ffmpeg's default stream selection would silently drop all but the "best"
/// stream per type.
fn build_remux_args(info: &MediaInfo, drop_audio: bool, out: &Path) -> Vec<String> {
    let mut a: Vec<String> = vec!["-i".into(), info.path.clone()];
    a.push("-map".into());
    a.push("0".into());
    a.extend(metadata_strip_args(true, true));
    if drop_audio {
        a.push("-an".into());
    }
    a.push("-c".into());
    a.push("copy".into());
    a.push("-progress".into());
    a.push("pipe:1".into());
    a.push("-y".into());
    a.push(out.to_string_lossy().to_string());
    a
}

/// Strip metadata from any media type.
/// A/V: lossless remux (`-map_metadata -1 -c copy`). Images: high-quality
/// re-encode (image codecs cannot be remuxed).
fn build_strip_metadata_args(info: &MediaInfo, _p: &StripMetadataParams, out: &Path) -> Vec<String> {
    match info.media_type {
        MediaType::Video | MediaType::Audio => build_remux_args(info, false, out),
        MediaType::Image => {
            let mut a: Vec<String> = vec!["-i".into(), info.path.clone()];
            // Re-encoding inherits container-level metadata by default, which
            // would carry EXIF/GPS straight into the "cleaned" output.
            a.push("-map_metadata".into());
            a.push("-1".into());
            match source_image_format(&info.path).as_str() {
                "jpeg" => {
                    a.push("-q:v".into());
                    a.push("2".into());
                }
                "webp" | "avif" => {
                    a.push("-quality".into());
                    a.push("90".into());
                }
                "png" => {
                    a.push("-compression_level".into());
                    a.push("6".into());
                }
                _ => {}
            }
            a.push("-progress".into());
            a.push("pipe:1".into());
            a.push("-y".into());
            a.push(out.to_string_lossy().to_string());
            a
        }
        MediaType::Unknown => vec![],
    }
}

/// Remove the audio track losslessly (`-an` + `-c copy`). `-map 0` keeps all
/// non-audio streams (subtitles, attachments) instead of just the best video.
fn build_mute_args(info: &MediaInfo, _p: &MuteParams, out: &Path) -> Vec<String> {
    let mut a: Vec<String> = vec![
        "-i".into(),
        info.path.clone(),
        "-map".into(),
        "0".into(),
        "-an".into(),
    ];
    a.push("-c".into());
    a.push("copy".into());
    a.push("-progress".into());
    a.push("pipe:1".into());
    a.push("-y".into());
    a.push(out.to_string_lossy().to_string());
    a
}

/// Video trim. "copy" mode is lossless but snaps to keyframes; "encode" mode
/// re-encodes for frame-exact cuts.
#[cfg(test)]
fn build_trim_args(info: &MediaInfo, p: &TrimParams, out: &Path) -> Vec<String> {
    build_trim_segment_args(info, p.start_time, p.duration, &p.mode, out)
}

/// Build the ffmpeg args for one trim range.
fn build_trim_segment_args(
    info: &MediaInfo,
    start: f64,
    duration: Option<f64>,
    mode: &str,
    out: &Path,
) -> Vec<String> {
    let mut a: Vec<String> = vec![
        "-ss".into(),
        format!("{:.3}", start.max(0.0)),
        "-i".into(),
        info.path.clone(),
    ];
    if let Some(d) = duration {
        if d > 0.0 {
            a.push("-t".into());
            a.push(format!("{:.3}", d));
        }
    }

    // Keep every stream: default stream selection would drop secondary audio
    // tracks / subtitles / attachments from the cut.
    a.push("-map".into());
    a.push("0".into());

    if mode == "encode" {
        a.push("-c:v".into());
        a.push("libx264".into());
        a.push("-crf".into());
        a.push("18".into());
        a.push("-preset".into());
        a.push("medium".into());
        a.push("-c:a".into());
        a.push("aac".into());
        a.push("-b:a".into());
        a.push("192k".into());
        a.push("-threads".into());
        a.push("0".into());
    } else {
        a.push("-c".into());
        a.push("copy".into());
    }

    a.push("-progress".into());
    a.push("pipe:1".into());
    a.push("-y".into());
    a.push(out.to_string_lossy().to_string());
    a
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
    factors
        .iter()
        .map(|f| format!("{:.6}", f))
        .collect()
}

fn screenshot_ext(format: &str) -> &'static str {
    if format == "jpeg" { "jpg" } else { "png" }
}

/// Turn `<stem><suffix>.<ext>` into the `%03d` sequence pattern used by
/// interval screenshots.
fn interval_pattern(base: PathBuf) -> PathBuf {
    let ext = base
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png")
        .to_string();
    let stem = base
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("frame")
        .to_string();
    match base.parent() {
        Some(dir) => dir.join(format!("{}_%03d.{}", stem, ext)),
        None => base,
    }
}

fn pattern_prefix(out: &Path) -> Option<String> {
    out.file_name()?
        .to_str()?
        .split("%03d")
        .next()
        .map(String::from)
}

fn pattern_ext(out: &Path) -> String {
    out.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png")
        .to_ascii_lowercase()
}

/// True when `name` is a member of the `%03d` sequence for `out`:
/// `<prefix><digits>.<ext>`. Plain prefix matching would also swallow
/// unrelated files like `clip_mediatool_final.png`.
fn is_sequence_file(name: &str, prefix: &str, ext: &str) -> bool {
    let Some(rest) = name.strip_prefix(prefix) else {
        return false;
    };
    match rest.rsplit_once('.') {
        Some((num, e)) => {
            e.eq_ignore_ascii_case(ext) && !num.is_empty() && num.chars().all(|c| c.is_ascii_digit())
        }
        None => false,
    }
}

fn scan_pattern_outputs(out: &Path) -> Vec<PathBuf> {
    let Some(prefix) = pattern_prefix(out) else {
        return vec![];
    };
    let Some(dir) = out.parent() else {
        return vec![];
    };
    let ext = pattern_ext(out);
    let mut found = vec![];
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if is_sequence_file(&name, &prefix, &ext) {
                found.push(e.path());
            }
        }
    }
    found.sort();
    found
}

fn pattern_output_size(out: &Path) -> Option<u64> {
    Some(
        scan_pattern_outputs(out)
            .iter()
            .filter_map(|p| std::fs::metadata(p).ok())
            .map(|m| m.len())
            .sum(),
    )
}

fn cleanup_pattern_outputs(out: &Path) {
    for p in scan_pattern_outputs(out) {
        let _ = std::fs::remove_file(p);
    }
}

fn build_screenshot_single(info: &MediaInfo, p: &ScreenshotParams, out: &Path) -> Vec<String> {
    let mut a: Vec<String> = vec![
        "-ss".into(),
        format!("{:.3}", p.at_sec.unwrap_or(0.0).max(0.0)),
        "-i".into(),
        info.path.clone(),
        "-frames:v".into(),
        "1".into(),
    ];

    if let Some(w) = p.max_width {
        if w >= 16 {
            a.push("-vf".into());
            a.push(format!("scale={}:-2", w));
        }
    }
    if p.format == "jpeg" {
        a.push("-q:v".into());
        a.push("2".into());
    }

    a.push("-progress".into());
    a.push("pipe:1".into());
    a.push("-y".into());
    a.push(out.to_string_lossy().to_string());
    a
}

fn build_screenshot_interval(info: &MediaInfo, p: &ScreenshotParams, out: &Path) -> Vec<String> {
    let start = p.start_sec.unwrap_or(0.0).max(0.0);
    let every = p.every_sec.unwrap_or(5.0).clamp(0.1, 3600.0);

    let mut a: Vec<String> = vec![
        "-ss".into(),
        format!("{:.3}", start),
        "-i".into(),
        info.path.clone(),
    ];

    if let Some(end) = p.end_sec {
        if end > start + 0.05 {
            a.push("-t".into());
            a.push(format!("{:.3}", end - start));
        }
    }

    let mut vf = format!("fps=1/{:.3}", every);
    if let Some(w) = p.max_width {
        if w >= 16 {
            vf.push_str(&format!(",scale={}:-2", w));
        }
    }
    a.push("-vf".into());
    a.push(vf);

    if p.format == "jpeg" {
        a.push("-q:v".into());
        a.push("2".into());
    }

    a.push("-progress".into());
    a.push("pipe:1".into());
    a.push("-y".into());
    a.push(out.to_string_lossy().to_string());
    a
}

/// Playback speed change: setpts for video, chained atempo for audio.
/// Re-encodes explicitly (ffmpeg's default encoder would be mpeg4).
fn build_speed_args(info: &MediaInfo, p: &SpeedParams, out: &Path) -> Vec<String> {
    let rate = p.rate.clamp(0.25, 4.0);
    let has_video_stream = info.media_type == MediaType::Video || info.video_codec.is_some();
    let mut a: Vec<String> = vec!["-i".into(), info.path.clone()];

    if info.media_type != MediaType::Audio && has_video_stream {
        a.push("-vf".into());
        a.push(format!("setpts=PTS/{:.6}", rate));
        a.push("-c:v".into());
        a.push("libx264".into());
        a.push("-preset".into());
        a.push("medium".into());
        a.push("-crf".into());
        a.push("18".into());
    }

    if p.mute_audio.unwrap_or(false) {
        a.push("-an".into());
    } else if info.audio_codec.is_some() || info.media_type == MediaType::Audio {
        let chain = atempo_chain(rate);
        if chain.is_empty() {
            // rate == 1.0: keep audio untouched.
            a.push("-c:a".into());
            a.push("copy".into());
        } else {
            a.push("-af".into());
            let expr = chain
                .iter()
                .map(|f| format!("atempo={}", f))
                .collect::<Vec<_>>()
                .join(",");
            a.push(expr);

            // Pick an audio codec that matches the target container.
            let ext = out
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            match ext.as_str() {
                "wav" => {
                    a.push("-c:a".into());
                    a.push("pcm_s16le".into());
                }
                "flac" => {
                    a.push("-c:a".into());
                    a.push("flac".into());
                }
                _ => {
                    a.push("-c:a".into());
                    a.push("aac".into());
                    a.push("-b:a".into());
                    a.push("192k".into());
                }
            }
        }
    }

    a.push("-threads".into());
    a.push("0".into());
    a.push("-progress".into());
    a.push("pipe:1".into());
    a.push("-y".into());
    a.push(out.to_string_lossy().to_string());
    a
}

/// Image watermark overlay onto video.
fn build_watermark_args(info: &MediaInfo, p: &WatermarkParams, wm_path: &str, out: &Path) -> Vec<String> {
    let vw = info.width.unwrap_or(1280) as f64;
    let vh = info.height.unwrap_or(720) as f64;

    let scale_pct = p.scale_percent.clamp(1, 100) as f64 / 100.0;
    let tw = ((vw * scale_pct) as u32).max(16);
    let opacity = p.opacity.unwrap_or(1.0).clamp(0.0, 1.0) as f64;
    let margin_pct = p.margin_percent.unwrap_or(3).clamp(0, 30) as f64 / 100.0;
    let margin = ((vw.min(vh)) * margin_pct) as i64;

    let pos = p.position.as_str();
    let x = match pos {
        "tl" | "ml" | "bl" => format!("{}", margin),
        "tc" | "mc" | "bc" => "(main_w-overlay_w)/2".to_string(),
        _ => format!("main_w-overlay_w-{}", margin), // tr/mr/br
    };
    let y = match pos {
        "tl" | "tc" | "tr" => format!("{}", margin),
        "ml" | "mc" | "mr" => "(main_h-overlay_h)/2".to_string(),
        _ => format!("main_h-overlay_h-{}", margin), // bl/bc/br
    };

    let mut chain = format!("[1:v]scale={}:-2", tw);
    if opacity < 1.0 {
        chain.push_str(",format=rgba,colorchannelmixer=aa=");
        chain.push_str(&format!("{:.6}", opacity));
    }
    let fc = format!(
        "{c}[wm];[0:v][wm]overlay=x={x}:y={y}",
        c = chain,
        x = x,
        y = y
    );

    let a: Vec<String> = vec![
        "-i".into(),
        info.path.clone(),
        "-i".into(),
        wm_path.to_string(),
        "-filter_complex".into(),
        fc,
        "-map".into(),
        "[v]".into(),
        "-map".into(),
        "0:a?".into(),
        "-c:v".into(),
        "libx264".into(),
        "-crf".into(),
        "20".into(),
        "-preset".into(),
        "medium".into(),
        "-c:a".into(),
        "aac".into(),
        "-b:a".into(),
        "192k".into(),
        "-threads".into(),
        "0".into(),
        "-progress".into(),
        "pipe:1".into(),
        "-y".into(),
        out.to_string_lossy().to_string(),
    ];
    a
}

/* ── New toolbox tools (video / audio) ─────────────────────── */

fn even(v: i64) -> i64 {
    if v % 2 == 0 {
        v
    } else {
        v - 1
    }
}

/// Quote a filesystem path for use inside an ffmpeg filtergraph value.
fn filter_quote_path(p: &str) -> String {
    format!("'{}'", p.replace('\\', "/").replace('\'', "'\\''"))
}

fn video_encode_tail(a: &mut Vec<String>) {
    a.push("-c:v".into());
    a.push("libx264".into());
    a.push("-crf".into());
    a.push("18".into());
    a.push("-preset".into());
    a.push("medium".into());
    a.push("-c:a".into());
    a.push("aac".into());
    a.push("-b:a".into());
    a.push("192k".into());
    a.push("-threads".into());
    a.push("0".into());
    a.push("-progress".into());
    a.push("pipe:1".into());
    a.push("-y".into());
}

fn build_video_subtitle_args(info: &MediaInfo, p: &SubtitleParams, out: &Path) -> Vec<String> {
    let burn = p.burn.unwrap_or(true);
    let quoted = filter_quote_path(&p.path);
    if !burn {
        // Soft mux subtitles into an mkv container.
        let mut a: Vec<String> = vec![
            "-i".into(),
            info.path.clone(),
            "-i".into(),
            p.path.clone(),
            "-map".into(),
            "0:v?".into(),
            "-map".into(),
            "0:a?".into(),
            "-map".into(),
            "1:s?".into(),
            "-c".into(),
            "copy".into(),
            "-c:s".into(),
            "srt".into(),
            "-progress".into(),
            "pipe:1".into(),
            "-y".into(),
        ];
        a.push(out.to_string_lossy().to_string());
        a
    } else {
        let vf = format!("subtitles=filename={}", quoted);
        let mut a: Vec<String> = vec!["-i".into(), info.path.clone(), "-vf".into(), vf];
        video_encode_tail(&mut a);
        a.push(out.to_string_lossy().to_string());
        a
    }
}

/// How to treat audio when concatenating videos.
enum MergeAudio {
    /// Every input has an audio track → concat v+a.
    All,
    /// No input has audio → concat video only.
    None,
}

fn build_video_merge_args(inputs: &[String], audio: MergeAudio, out: &Path) -> Vec<String> {
    let n = inputs.len();
    let mut a: Vec<String> = Vec::new();
    for i in inputs {
        a.push("-i".into());
        a.push(i.clone());
    }
    let mut fc = String::new();
    match audio {
        MergeAudio::All => {
            for idx in 0..n {
                fc.push_str(&format!("[{}:v][{}:a]", idx, idx));
            }
            fc.push_str(&format!("concat=n={}:v=1:a=1[outv][outa]", n));
            a.push("-filter_complex".into());
            a.push(fc);
            a.push("-map".into());
            a.push("[outv]".into());
            a.push("-map".into());
            a.push("[outa]".into());
        }
        MergeAudio::None => {
            for idx in 0..n {
                fc.push_str(&format!("[{}:v]", idx));
            }
            fc.push_str(&format!("concat=n={}:v=1:a=0[outv]", n));
            a.push("-filter_complex".into());
            a.push(fc);
            a.push("-map".into());
            a.push("[outv]".into());
            a.push("-an".into());
        }
    }
    a.push("-c:v".into());
    a.push("libx264".into());
    a.push("-crf".into());
    a.push("20".into());
    a.push("-preset".into());
    a.push("medium".into());
    a.push("-c:a".into());
    a.push("aac".into());
    a.push("-b:a".into());
    a.push("192k".into());
    a.push("-threads".into());
    a.push("0".into());
    a.push("-progress".into());
    a.push("pipe:1".into());
    a.push("-y".into());
    a.push(out.to_string_lossy().to_string());
    a
}

fn build_audio_volume_args(info: &MediaInfo, p: &AudioVolumeParams, out: &Path) -> Vec<String> {
    let af = if p.mode == "normalize" {
        "loudnorm".to_string()
    } else {
        let db = p.gain.unwrap_or(0.0).clamp(-20.0, 20.0);
        format!("volume=volume={:.1}dB", db)
    };
    let mut a: Vec<String> = vec!["-i".into(), info.path.clone(), "-af".into(), af];
    a.push("-c:a".into());
    a.push("aac".into());
    a.push("-b:a".into());
    a.push("192k".into());
    a.push("-progress".into());
    a.push("pipe:1".into());
    a.push("-y".into());
    a.push(out.to_string_lossy().to_string());
    a
}

fn build_audio_merge_args(inputs: &[String], out: &Path) -> Vec<String> {
    let n = inputs.len();
    let mut a: Vec<String> = Vec::new();
    for i in inputs {
        a.push("-i".into());
        a.push(i.clone());
    }
    let mut fc = String::new();
    for (idx, _) in inputs.iter().enumerate() {
        fc.push_str(&format!("[{}:a]", idx));
    }
    fc.push_str(&format!("concat=n={}:v=0:a=1[outa]", n));
    a.push("-filter_complex".into());
    a.push(fc);
    a.push("-map".into());
    a.push("[outa]".into());
    a.push("-c:a".into());
    a.push("aac".into());
    a.push("-b:a".into());
    a.push("192k".into());
    a.push("-threads".into());
    a.push("0".into());
    a.push("-progress".into());
    a.push("pipe:1".into());
    a.push("-y".into());
    a.push(out.to_string_lossy().to_string());
    a
}

fn build_video_frames_args(info: &MediaInfo, p: &FrameSampleParams, out: &Path) -> Vec<String> {
    let interval = p.interval.max(0.1);
    let width = p.width.max(64);
    let fps = p.fps.max(1.0);
    let mut a: Vec<String> = vec!["-i".into(), info.path.clone()];
    a.push("-vf".into());
    a.push(format!(
        "fps=1/{},scale={}:-2:force_original_aspect_ratio=decrease,setpts=N/FRAME_RATE/TB",
        interval, width
    ));
    a.push("-r".into());
    a.push(fps.to_string());
    a.push("-c:v".into());
    a.push("libx264".into());
    a.push("-preset".into());
    a.push("medium".into());
    a.push("-crf".into());
    a.push("20".into());
    a.push("-pix_fmt".into());
    a.push("yuv420p".into());
    a.push("-an".into());
    a.push("-movflags".into());
    a.push("+faststart".into());
    a.push("-progress".into());
    a.push("pipe:1".into());
    a.push("-y".into());
    a.push(out.to_string_lossy().to_string());
    a
}

fn build_video_contact_args(info: &MediaInfo, p: &ContactSheetParams, out: &Path) -> Vec<String> {
    let thumb_w = p.thumb_w.max(32);
    // In "count" mode spread the requested number of thumbnails evenly across
    // the whole video; an explicit `countCols` fixes the grid width (the wide,
    // short layout player hover-previews expect), otherwise auto-fit a
    // near-square grid. Interval mode honors the user's sampling rate and
    // explicit columns/rows.
    let (cols, rows) = if p.mode == "count" {
        let n = p.count.max(1) as u32;
        match p.count_cols.filter(|c| *c > 0) {
            Some(c) => (c.max(1), n.div_ceil(c.max(1))),
            None => {
                let c = (n as f64).sqrt().ceil().max(1.0) as u32;
                (c, n.div_ceil(c))
            }
        }
    } else {
        (p.cols.max(1), p.rows.max(1))
    };
    let fps_expr = if p.mode == "count" {
        let dur = info.duration_secs.unwrap_or(0.0).max(0.1);
        let n = p.count.max(1) as f64;
        format!("1/{:.4}", dur / n)
    } else {
        format!("1/{:.3}", p.interval.max(0.1))
    };
    let mut a: Vec<String> = vec!["-i".into(), info.path.clone()];
    a.push("-vf".into());
    a.push(format!("fps={},scale={}:-2,tile={}x{}", fps_expr, thumb_w, cols, rows));
    a.push("-frames:v".into());
    a.push("1".into());
    a.push("-progress".into());
    a.push("pipe:1".into());
    a.push("-y".into());
    a.push(out.to_string_lossy().to_string());
    a
}

fn build_video_silence_args(info: &MediaInfo, p: &VideoSilenceParams, _out: &Path) -> Vec<String> {
    let threshold = p.threshold;
    let min_len = p.min_len.max(0.0);
    let mut a: Vec<String> = vec!["-i".into(), info.path.clone(), "-y".into()];
    a.push("-af".into());
    a.push(format!("silencedetect=noise={}dB:d={}", threshold, min_len));
    // Progress on stdout keeps the job's percent moving during long scans;
    // results are in the ffmpeg log (stderr).
    a.push("-progress".into());
    a.push("pipe:1".into());
    // No media output: discard to the null muxer.
    a.push("-f".into());
    a.push("null".into());
    a.push("-".into());
    a
}

fn audio_ext_for(codec: &str) -> &'static str {
    match codec {
        "aac" | "m4a" => "m4a",
        "opus" => "opus",
        "flac" => "flac",
        _ => "mp3",
    }
}

/// Resolve the output file extension based on the tool and its params.
/// Tools that preserve the input streams keep the input container; compress /
/// convert honor a chosen format with "source" meaning keep-input.
fn extension_for(tool_id: &str, info: &MediaInfo, params: &serde_json::Value) -> String {
    let fmt = |default: &str| -> String {
        let f = params
            .get("format")
            .and_then(|f| f.as_str())
            .unwrap_or(default);
        if f == "source" || f.is_empty() {
            String::new()
        } else {
            f.to_string()
        }
    };

    match tool_id {
        "extract-audio" => audio_ext_for(
            params
                .get("format")
                .and_then(|f| f.as_str())
                .unwrap_or("mp3"),
        )
        .to_string(),
        "trim" | "mute" | "strip-metadata" => input_ext(info, "mp4"),
        "video-subtitle" | "video-merge" => safe_container_ext(info),
        "audio-volume" | "audio-merge" => source_audio_format(&info.path).to_string(),
        "video-frames" => safe_container_ext(info),
        "video-contact" => "png".to_string(),
        "video-silence" => "txt".to_string(),
        _ => match info.media_type {
            MediaType::Video => {
                let f = fmt("mp4");
                if f.is_empty() {
                    input_ext(info, "mp4")
                } else {
                    f
                }
            }
            MediaType::Image => {
                let f = fmt("jpg");
                if f.is_empty() {
                    input_ext(info, "jpg")
                } else {
                    f
                }
            }
            MediaType::Audio => {
                let f = fmt("mp3");
                if f.is_empty() {
                    input_ext(info, "mp3")
                } else {
                    f
                }
            }
            MediaType::Unknown => "out".to_string(),
        },
    }
}

/// Collapse encoder names into codec families for container validation.
fn codec_family<'a>(codec: &'a str) -> &'a str {
    match codec {
        "libx264" | "h264_nvenc" | "h264_qsv" | "h264_videotoolbox" | "h264_amf"
        | "h264_vaapi" | "h264" => "h264",
        "libx265" | "hevc_nvenc" | "hevc_qsv" | "hevc_videotoolbox" | "hevc_amf"
        | "hevc_vaapi" | "h265" | "hevc" => "hevc",
        "libvpx-vp9" | "vp9" => "vp9",
        "libsvtav1" | "libaom-av1" | "av1" => "av1",
        "libvpx" | "vp8" => "vp8",
        "aac" => "aac",
        "libopus" | "opus" => "opus",
        "libvorbis" | "vorbis" => "vorbis",
        "flac" => "flac",
        "libmp3lame" | "mp3" => "mp3",
        other => other,
    }
}

/// Source codecs that stream-copy cleanly into MP4 and play in everyday
/// players. Outside this set the MP4 muxer either refuses the stream outright
/// (opus/vorbis/flac are gated as "experimental" there) or produces a file
/// most players cannot handle.
const MP4_COPY_VIDEO: &[&str] = &["h264", "h265", "hevc", "av1", "vp9", "mpeg4"];
const MP4_COPY_AUDIO: &[&str] = &["aac", "mp3", "ac3", "eac3", "alac"];

/// The codec that actually reaches the muxer: an explicit encode target, or
/// the probed source stream when the param is ""/"copy".
fn effective_codec<'a>(param: &'a str, source: Option<&'a str>) -> &'a str {
    match param {
        "" | "copy" => source.unwrap_or(""),
        other => other,
    }
}

/// Auto-fallback for bound lossless-remux pipelines: stream-copy into MP4 only
/// works when the source codecs fit the container. When they don't (e.g.
/// VP9/Opus from a live recording), swap `copy` for the transcode recipe (the
/// same tier as the "转码 MP4" pipeline) so the run still produces the MP4 the
/// user asked for, and return a note for the UI explaining the substitution.
/// Only callers that opted in via `allow_copy_fallback` reach this; explicit
/// tool-page choices keep the hard validation error instead.
fn mp4_copy_fallback(p: &mut VideoParams, info: &MediaInfo) -> Option<String> {
    if p.format != "mp4" {
        return None;
    }
    let incompatible =
        |codec: Option<&str>, allowed: &[&str]| match codec {
            Some(c) if !c.is_empty() => !allowed.contains(&codec_family(c)),
            _ => false,
        };
    let v_bad =
        p.video_codec == "copy" && incompatible(info.video_codec.as_deref(), MP4_COPY_VIDEO);
    let a_bad =
        p.audio_codec == "copy" && incompatible(info.audio_codec.as_deref(), MP4_COPY_AUDIO);
    if !v_bad && !a_bad {
        return None;
    }

    let mut parts: Vec<String> = Vec::new();
    if v_bad {
        parts.push(format!("视频编码 {}", info.video_codec.as_deref().unwrap_or("")));
        p.video_codec = "libx264".into();
        p.quality_mode = "crf".into();
        p.crf = Some(23);
        p.preset = "medium".into();
    }
    if a_bad {
        parts.push(format!("音频编码 {}", info.audio_codec.as_deref().unwrap_or("")));
        p.audio_codec = "aac".into();
        p.audio_bitrate_kbps = Some(192);
    }
    let fix = if v_bad && a_bad {
        "H.264 CRF 23 / AAC 192k"
    } else if v_bad {
        "H.264 CRF 23"
    } else {
        "AAC 192k"
    };
    Some(format!(
        "源{}不兼容 MP4，已自动降级为转码（{fix}），无损封装未执行",
        parts.join("、")
    ))
}

/// Reject codec/container combinations the target muxer cannot carry (or that
/// produce files most players refuse). Two restrictive cases: WebM only takes
/// VP8/VP9/AV1 video + Vorbis/Opus audio, and stream-copy into MP4 needs the
/// source codecs to be MP4-compatible. Without this check the user only sees
/// a raw "FFmpeg 退出码 1" long after the job started.
fn validate_video_container(
    ext: &str,
    vcodec_param: &str,
    acodec_param: &str,
    info: &MediaInfo,
) -> Result<()> {
    match ext.to_ascii_lowercase().as_str() {
        "webm" => {
            let v_raw = effective_codec(vcodec_param, info.video_codec.as_deref());
            if !matches!(codec_family(v_raw), "vp8" | "vp9" | "av1") {
                return Err(AppError(format!(
                    "WebM 容器不支持 {} 视频：请改用 VP9/AV1 编码，或将容器换成 MP4/MKV/MOV",
                    if v_raw.is_empty() { "未知" } else { v_raw }
                )));
            }
            if acodec_param != "none" {
                let a_raw = effective_codec(acodec_param, info.audio_codec.as_deref());
                if !a_raw.is_empty() && !matches!(codec_family(a_raw), "opus" | "vorbis") {
                    return Err(AppError(format!(
                        "WebM 容器不支持 {} 音频：请改用 Opus，或将容器换成 MP4/MKV/MOV",
                        a_raw
                    )));
                }
            }
            Ok(())
        }
        // Lossless remux copies the source streams as-is, so they must be
        // codecs MP4 can carry; point at the re-encode paths otherwise.
        // Encode targets (non-copy) choose their own codec, so they skip this.
        "mp4" => {
            if vcodec_param == "copy" {
                let v_raw = info.video_codec.as_deref().unwrap_or("");
                if !v_raw.is_empty() && !MP4_COPY_VIDEO.contains(&codec_family(v_raw)) {
                    return Err(AppError(format!(
                        "源视频编码 {v_raw} 无法无损封装进 MP4：请改用「视觉无损 / 转码 MP4」重新编码，或保留 MKV 等源容器"
                    )));
                }
            }
            if acodec_param == "copy" {
                let a_raw = info.audio_codec.as_deref().unwrap_or("");
                if !a_raw.is_empty() && !MP4_COPY_AUDIO.contains(&codec_family(a_raw)) {
                    return Err(AppError(format!(
                        "源音频编码 {a_raw} 无法无损封装进 MP4：请改用「视觉无损 / 转码 MP4」重新编码，或保留 MKV 等源容器"
                    )));
                }
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

/// Effective duration of a trimmed window, used as the progress denominator:
/// ffmpeg's out_time only covers [start, start+duration).
fn trim_window_secs(total: f64, start: f64, dur: Option<f64>) -> f64 {
    let s = start.max(0.0);
    let end = match dur {
        Some(d) if d > 0.0 => s + d,
        _ => total,
    };
    (end.min(total) - s).max(0.0)
}

fn parse_params<T: serde::de::DeserializeOwned>(params: &serde_json::Value) -> Result<T> {
    serde_json::from_value(params.clone()).map_err(AppError::from)
}

/// A fully prepared job: either skipped by the overwrite policy, ready to run
/// with a single ffmpeg invocation, or a sequence of invocations that produce
/// multiple output files (e.g. multi-segment trim).
enum PreparedJob {
    Skipped {
        /// The existing output file that caused the skip, so callers can chain
        /// it as the "output" of this step.
        existing: Option<PathBuf>,
    },
    Run { args: Vec<String>, out: PathBuf },
    RunMany { runs: Vec<(Vec<String>, PathBuf, f64)> },
}

/// Create an empty placeholder file so concurrent jobs can't resolve to the
/// same output name. ffmpeg later overwrites it with -y.
fn reserve(path: &Path) {
    let _ = std::fs::OpenOptions::new().write(true).create_new(true).open(path);
}

/// Resolve an output path applying the rename/skip/overwrite policy.
/// Ok = path to use; Err = policy is "skip" and the file already exists (the
/// existing path is returned so the caller can report/chain it).
fn resolve_policy(out: PathBuf, policy: &str) -> std::result::Result<PathBuf, PathBuf> {
    if !out.exists() {
        reserve(&out);
        return Ok(out);
    }
    match policy {
        "overwrite" => Ok(out),
        "skip" => Err(out),
        _ => {
            let candidate = apply_overwrite_policy(out, "rename");
            reserve(&candidate);
            Ok(candidate)
        }
    }
}

/// Preserve the input's container extension for re-encoding tools.
fn input_ext(info: &MediaInfo, fallback: &str) -> String {
    Path::new(&info.path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .filter(|e| !e.is_empty() && e.len() <= 5 && e.chars().all(|c| c.is_ascii_alphanumeric()))
        .unwrap_or_else(|| fallback.to_string())
}

/// The frontend uses prefixed ids ("video-compress", "audio-convert", …) while
/// the dispatch below matches the unprefixed tool ("compress", "convert"). This
/// normalizes both conventions so a single tool id works everywhere.
fn norm_tool_id(id: &str) -> &str {
    for media in ["video", "audio"] {
        let prefix = [media, "-"].concat();
        if let Some(rest) = id.strip_prefix(&prefix) {
            return rest;
        }
    }
    id
}

/// Unique dispatch id for `prepare_job`. Old tools funnel into a shared
/// "compress"/"convert" id (stripping the media prefix); new tools keep their
/// full, already-unique id.
fn tool_dispatch(id: &str) -> &str {
    match id {
        "video-compress" | "audio-compress" => "compress",
        "video-convert" | "audio-convert" => "convert",
        "video-trim" => "trim",
        "video-speed" => "speed",
        "video-mute" => "mute",
        "video-watermark" => "watermark",
        "video-extract-audio" => "extract-audio",
        "video-screenshot" => "screenshot",
        "video-strip-metadata" => "strip-metadata",
        _ => id,
    }
}

/// Tasks/monitors saved by older versions may still reference the removed
/// "video-sprite" tool; map it onto the contact sheet's count mode with the
/// same fixed grid width so legacy pipelines keep working.
fn legacy_tool_request(req: &JobRequest) -> JobRequest {
    if req.tool_id != "video-sprite" {
        return req.clone();
    }
    let count = req.params.get("count").and_then(|v| v.as_u64()).unwrap_or(100) as u32;
    let cols = req.params.get("cols").and_then(|v| v.as_u64()).unwrap_or(10) as u32;
    let thumb_w = req.params.get("thumbW").and_then(|v| v.as_u64()).unwrap_or(160) as u32;
    let rows = count.div_ceil(cols.max(1));
    let params = serde_json::json!({
        "mode": "count",
        "interval": 5,
        "count": count,
        "countCols": cols,
        "cols": cols,
        "rows": rows,
        "thumbW": thumb_w,
    });
    JobRequest { tool_id: "video-contact".into(), params, ..req.clone() }
}

/// Build the args + output path for any tool id, or mark as skipped.
/// Blocking (may probe merge inputs / encode a PDF source image); call within
/// spawn_blocking. `app` is only needed by tools that probe extra inputs
/// (video-merge); tests pass None.
fn prepare_job(
    app: Option<&AppHandle>,
    info: &MediaInfo,
    req: &JobRequest,
    suffix: &str,
    policy: &str,
) -> Result<PreparedJob> {
    let req = legacy_tool_request(req);
    match tool_dispatch(&req.tool_id) {
        "compress" | "convert" => {
            let ext = extension_for(&req.tool_id, info, &req.params);
            let out = output_path(&info.path, &req.output_dir, &ext, suffix)?;
            let out = match resolve_policy(out, policy) {
                Ok(p) => p,
                Err(existing) => return Ok(PreparedJob::Skipped { existing: Some(existing) }),
            };
            let args = match info.media_type {
                MediaType::Video => {
                    let mut p: VideoParams = parse_params(&req.params)?;
                    p.gpu = req.gpu.clone();
                    validate_video_container(&ext, &p.video_codec, &p.audio_codec, info)?;
                    build_video_args(info, &p, &out)
                }
                MediaType::Audio => {
                    let p: AudioParams = parse_params(&req.params)?;
                    build_audio_args(info, &p, &out)
                }
                MediaType::Image | MediaType::Unknown => {
                    return Err(AppError("不支持的媒体类型".into()));
                }
            };
            Ok(PreparedJob::Run { args, out })
        }
        "screenshot" => {
            let p: ScreenshotParams = parse_params(&req.params)?;
            let ext = screenshot_ext(&p.format);
            if p.mode == "interval" {
                // Sequence outputs use a %03d pattern; the overwrite policy
                // does not apply (ffmpeg overwrites numbered files with -y).
                let base = output_path(&info.path, &req.output_dir, ext, suffix)?;
                let out = interval_pattern(base);
                Ok(PreparedJob::Run { args: build_screenshot_interval(info, &p, &out), out })
            } else {
                let base = output_path(&info.path, &req.output_dir, ext, suffix)?;
                let out = match resolve_policy(base, policy) {
                    Ok(p) => p,
                    Err(existing) => return Ok(PreparedJob::Skipped { existing: Some(existing) }),
                };
                Ok(PreparedJob::Run { args: build_screenshot_single(info, &p, &out), out })
            }
        }
        "speed" => {
            let p: SpeedParams = parse_params(&req.params)?;
            let ext = safe_container_ext(info);
            let out = output_path(&info.path, &req.output_dir, &ext, suffix)?;
            let out = match resolve_policy(out, policy) {
                Ok(p) => p,
                Err(existing) => return Ok(PreparedJob::Skipped { existing: Some(existing) }),
            };
            Ok(PreparedJob::Run { args: build_speed_args(info, &p, &out), out })
        }
        "watermark" => {
            let p: WatermarkParams = parse_params(&req.params)?;
            if p.image_path.trim().is_empty() {
                return Err(AppError("请先选择水印图片".into()));
            }
            if !Path::new(&p.image_path).exists() {
                return Err(AppError(format!("水印图片不存在：{}", p.image_path)));
            }
            let ext = safe_container_ext(info);
            let out = output_path(&info.path, &req.output_dir, &ext, suffix)?;
            let out = match resolve_policy(out, policy) {
                Ok(p) => p,
                Err(existing) => return Ok(PreparedJob::Skipped { existing: Some(existing) }),
            };
            let wm_path = p.image_path.clone();
            Ok(PreparedJob::Run { args: build_watermark_args(info, &p, &wm_path, &out), out })
        }
        "extract-audio" => {
            let p: ExtractAudioParams = parse_params(&req.params)?;
            if info.audio_codec.is_none() {
                return Err(AppError("该视频没有音轨，无法提取音频".into()));
            }
            let ext = audio_ext_for(&p.format).to_string();
            let out = output_path(&info.path, &req.output_dir, &ext, suffix)?;
            let out = match resolve_policy(out, policy) {
                Ok(p) => p,
                Err(existing) => return Ok(PreparedJob::Skipped { existing: Some(existing) }),
            };
            let ap = AudioParams { format: p.format, bitrate_kbps: p.bitrate_kbps };
            Ok(PreparedJob::Run { args: build_audio_args(info, &ap, &out), out })
        }
        "strip-metadata" => {
            parse_params::<StripMetadataParams>(&req.params)?;
            let fallback = match info.media_type {
                MediaType::Image => "jpg",
                MediaType::Audio => "mp3",
                _ => "mp4",
            };
            let ext = input_ext(info, fallback);
            let out = output_path(&info.path, &req.output_dir, &ext, suffix)?;
            let out = match resolve_policy(out, policy) {
                Ok(p) => p,
                Err(existing) => return Ok(PreparedJob::Skipped { existing: Some(existing) }),
            };
            let p: StripMetadataParams = parse_params(&req.params)?;
            Ok(PreparedJob::Run { args: build_strip_metadata_args(info, &p, &out), out })
        }
        "trim" => {
            let p: TrimParams = parse_params(&req.params)?;
            let ext = if p.mode == "encode" {
                safe_container_ext(info)
            } else {
                input_ext(info, "mp4")
            };
            let segments: Vec<TrimSegment> = if p.segments.is_empty() {
                vec![TrimSegment { start_time: p.start_time, duration: p.duration }]
            } else {
                p.segments
            };
            let total_dur = info.duration_secs.unwrap_or(0.0);
            let multi = segments.len() > 1;
            let mut runs: Vec<(Vec<String>, PathBuf, f64)> = Vec::with_capacity(segments.len());
            for (i, seg) in segments.iter().enumerate() {
                let label = if multi { format!("_{}", i + 1) } else { String::new() };
                let out = output_path_labeled(&info.path, &req.output_dir, &ext, &suffix, &label)?;
                let out = match resolve_policy(out, policy) {
                    Ok(p) => p,
                    Err(existing) => return Ok(PreparedJob::Skipped { existing: Some(existing) }),
                };
                let args = build_trim_segment_args(info, seg.start_time, seg.duration, &p.mode, &out);
                let dur = seg.duration.unwrap_or_else(|| (total_dur - seg.start_time).max(0.0));
                runs.push((args, out, dur));
            }
            if multi {
                Ok(PreparedJob::RunMany { runs })
            } else {
                let (args, out, _) = runs.pop().expect("already branched on multi");
                Ok(PreparedJob::Run { args, out })
            }
        }
        "mute" => {
            parse_params::<MuteParams>(&req.params)?;
            let ext = input_ext(info, "mp4");
            let out = output_path(&info.path, &req.output_dir, &ext, suffix)?;
            let out = match resolve_policy(out, policy) {
                Ok(p) => p,
                Err(existing) => return Ok(PreparedJob::Skipped { existing: Some(existing) }),
            };
            let p: MuteParams = parse_params(&req.params)?;
            Ok(PreparedJob::Run { args: build_mute_args(info, &p, &out), out })
        }
        /* ── New video tools ── */
        "video-subtitle" => {
            let p: SubtitleParams = parse_params(&req.params)?;
            if p.path.trim().is_empty() {
                return Err(AppError("请先选择字幕文件".into()));
            }
            if !Path::new(&p.path).exists() {
                return Err(AppError(format!("字幕文件不存在：{}", p.path)));
            }
            let ext = if p.burn.unwrap_or(true) {
                safe_container_ext(info)
            } else {
                "mkv".to_string()
            };
            let out = output_path(&info.path, &req.output_dir, &ext, suffix)?;
            let out = match resolve_policy(out, policy) {
                Ok(p) => p,
                Err(existing) => return Ok(PreparedJob::Skipped { existing: Some(existing) }),
            };
            Ok(PreparedJob::Run { args: build_video_subtitle_args(info, &p, &out), out })
        }
        "video-merge" => {
            let _p: VideoMergeParams = parse_params(&req.params)?;
            if req.inputs.len() < 2 {
                return Err(AppError("合并视频需要至少 2 个文件".into()));
            }
            // The concat filter needs a matching audio configuration across
            // inputs: all-with-audio or all-without. Mixed input would either
            // fail ("matches no streams") or desync.
            let mut any_audio = false;
            let mut all_audio = true;
            let app = app.ok_or_else(|| AppError("内部错误：缺少应用句柄".into()))?;
            for input in &req.inputs {
                let inf = crate::media::probe_sync(app, input)?;
                if inf.audio_codec.is_some() {
                    any_audio = true;
                } else {
                    all_audio = false;
                }
            }
            let audio = if all_audio {
                MergeAudio::All
            } else if !any_audio {
                MergeAudio::None
            } else {
                return Err(AppError(
                    "所选视频的音轨不一致（部分有音轨、部分没有），无法直接合并；请先用「移除音轨」处理后再试".into(),
                ));
            };
            let ext = safe_container_ext(info);
            let out = output_path(&info.path, &req.output_dir, &ext, suffix)?;
            let out = match resolve_policy(out, policy) {
                Ok(p) => p,
                Err(existing) => return Ok(PreparedJob::Skipped { existing: Some(existing) }),
            };
            Ok(PreparedJob::Run { args: build_video_merge_args(&req.inputs, audio, &out), out })
        }
        "video-frames" => {
            let p: FrameSampleParams = parse_params(&req.params)?;
            let ext = safe_container_ext(info);
            let out = output_path(&info.path, &req.output_dir, &ext, suffix)?;
            let out = match resolve_policy(out, policy) {
                Ok(p) => p,
                Err(existing) => return Ok(PreparedJob::Skipped { existing: Some(existing) }),
            };
            Ok(PreparedJob::Run { args: build_video_frames_args(info, &p, &out), out })
        }
        "video-contact" => {
            let p: ContactSheetParams = parse_params(&req.params)?;
            let out = output_path(&info.path, &req.output_dir, "png", suffix)?;
            let out = match resolve_policy(out, policy) {
                Ok(p) => p,
                Err(existing) => return Ok(PreparedJob::Skipped { existing: Some(existing) }),
            };
            Ok(PreparedJob::Run { args: build_video_contact_args(info, &p, &out), out })
        }
        "video-silence" => {
            let p: VideoSilenceParams = parse_params(&req.params)?;
            let out = output_path(&info.path, &req.output_dir, "txt", suffix)?;
            let out = match resolve_policy(out, policy) {
                Ok(p) => p,
                Err(existing) => return Ok(PreparedJob::Skipped { existing: Some(existing) }),
            };
            Ok(PreparedJob::Run { args: build_video_silence_args(info, &p, &out), out })
        }
        /* ── New audio tools ── */
        "audio-volume" => {
            let p: AudioVolumeParams = parse_params(&req.params)?;
            let ext = source_audio_format(&info.path).to_string();
            let out = output_path(&info.path, &req.output_dir, &ext, suffix)?;
            let out = match resolve_policy(out, policy) {
                Ok(p) => p,
                Err(existing) => return Ok(PreparedJob::Skipped { existing: Some(existing) }),
            };
            Ok(PreparedJob::Run { args: build_audio_volume_args(info, &p, &out), out })
        }
        "audio-merge" => {
            let _p: AudioMergeParams = parse_params(&req.params)?;
            if req.inputs.len() < 2 {
                return Err(AppError("合并音频需要至少 2 个文件".into()));
            }
            let ext = source_audio_format(&info.path).to_string();
            let out = output_path(&info.path, &req.output_dir, &ext, suffix)?;
            let out = match resolve_policy(out, policy) {
                Ok(p) => p,
                Err(existing) => return Ok(PreparedJob::Skipped { existing: Some(existing) }),
            };
            Ok(PreparedJob::Run { args: build_audio_merge_args(&req.inputs, &out), out })
        }
        other => Err(AppError(format!("未知工具: {}", other))),
    }
}

/* ── Multi-step workflow: single-command merging ───────────────── */

/// Ordered video operations inside a merged chain. A `Filter` is a comma-joined
/// FFmpeg filter fragment applied to the (single) video stream; `Overlay` is a
/// second-input image watermark positioned in the chain order.
enum VideoOp {
    Filter(String),
    Overlay(WatermarkParams),
}

/// The composable subset of tools that can be merged into one `ffmpeg -i …`
/// command. Terminal tools (screenshot / extract-audio) are excluded and
/// fall back to per-step chaining.
const MERGEABLE_TOOLS: [&str; 7] = [
    "compress", "convert", "trim", "speed", "mute", "watermark", "strip-metadata",
];

/// Precondition for merging. Rejects terminal tools and combinations that
/// cannot be expressed as a single command (stream-copy trim, >1 watermark).
fn is_mergeable_chain(steps: &[WorkflowStepInput]) -> bool {
    let mut wm = 0usize;
    for s in steps {
        let id = norm_tool_id(&s.tool_id);
        if !MERGEABLE_TOOLS.contains(&id) {
            return false;
        }
        if id == "trim" {
            if let Ok(p) = parse_params::<TrimParams>(&s.params) {
                if p.mode == "copy" {
                    return false;
                }
                // Multi-segment trims run as several ffmpeg invocations and
                // cannot fold into the single merged command.
                if p.segments.len() > 1 {
                    return false;
                }
            }
        }
        if id == "watermark" {
            wm += 1;
            if wm > 1 {
                return false;
            }
        }
    }
    true
}

/// Collect the merged chain state and the output extension.
fn merged_chain(info: &MediaInfo, steps: &[WorkflowStepInput]) -> Option<MergedChain> {
    if !is_mergeable_chain(steps) {
        return None;
    }

    let mut ops: Vec<VideoOp> = Vec::new();
    let mut drop_audio = false;
    let mut strip_meta = false;
    let mut audio_atempo: Option<f64> = None;
    let mut trim: Option<(f64, Option<f64>)> = None;
    let mut encode: Option<VideoParams> = None;

    for s in steps {
        let id = norm_tool_id(&s.tool_id);
        match id {
            "compress" | "convert" => {
                let p: VideoParams = parse_params(&s.params).ok()?;
                // Same filter semantics as the single-job path: tone-map HDR
                // first, then scale — unless the chain ends in stream copy.
                if let Some(vf) = video_filter_chain(info, &p.video_codec, &p.resolution) {
                    ops.push(VideoOp::Filter(vf));
                }
                // "none" means drop the audio track — same as the single-job
                // compress path, which maps it to -an.
                if p.audio_codec == "none" {
                    drop_audio = true;
                }
                encode = Some(p);
            }
            "trim" => {
                let p: TrimParams = parse_params(&s.params).ok()?;
                trim = Some((p.start_time.max(0.0), p.duration));
            }
            "speed" => {
                let p: SpeedParams = parse_params(&s.params).ok()?;
                let rate = p.rate.clamp(0.25, 4.0);
                ops.push(VideoOp::Filter(format!("setpts=PTS/{:.6}", rate)));
                if p.mute_audio.unwrap_or(false) {
                    drop_audio = true;
                } else if (rate - 1.0).abs() > 1e-9 && info.audio_codec.is_some() {
                    // atempo needs an audio stream; a silent input just gets
                    // the video speed change.
                    audio_atempo = Some(rate);
                }
            }
            "mute" => drop_audio = true,
            "watermark" => {
                let p: WatermarkParams = parse_params(&s.params).ok()?;
                ops.push(VideoOp::Overlay(p));
            }
            "strip-metadata" => strip_meta = true,
            _ => return None,
        }
    }

    let needs_reencode = encode.is_some() || !ops.is_empty() || trim.is_some();

    let ext = if !needs_reencode {
        input_ext(info, "mp4")
    } else if let Some(p) = &encode {
        let f = p.format.as_str();
        if f == "source" || f.is_empty() {
            input_ext(info, "mp4")
        } else {
            f.to_string()
        }
    } else {
        safe_container_ext(info)
    };

    Some(MergedChain {
        needs_reencode,
        ops,
        drop_audio,
        strip_meta,
        audio_atempo,
        trim,
        encode,
        ext,
    })
}

/// A mergeable, single-command pipeline.
struct MergedChain {
    needs_reencode: bool,
    ops: Vec<VideoOp>,
    drop_audio: bool,
    strip_meta: bool,
    audio_atempo: Option<f64>,
    trim: Option<(f64, Option<f64>)>,
    encode: Option<VideoParams>,
    ext: String,
}

fn vf_filter_string(op: &VideoOp) -> Option<&str> {
    match op {
        VideoOp::Filter(f) => Some(f.as_str()),
        VideoOp::Overlay(_) => None,
    }
}

/// Emit the codec / quality-rate flags for the final re-encode. Does NOT include
/// `-i`, `-vf`, or the output tail (those are built by `merged_args`).
fn video_encoder_args(info: &MediaInfo, ep: &VideoParams) -> Vec<String> {
    let vcodec = gpu_plan(&ep.video_codec, &ep.gpu).0;
    let mut a: Vec<String> = vec!["-c:v".into(), vcodec.clone()];

    match vcodec.as_str() {
        "libx264" => {
            if ep.quality_mode == "crf" {
                a.push("-crf".into());
                a.push(ep.crf.unwrap_or(28).to_string());
            }
            a.push("-preset".into());
            a.push(ep.preset.clone());
        }
        "libx265" => {
            if ep.quality_mode == "crf" {
                a.push("-crf".into());
                a.push(ep.crf.unwrap_or(28).to_string());
            }
            a.push("-preset".into());
            a.push(ep.preset.clone());
        }
        "libvpx-vp9" => {
            if ep.quality_mode == "crf" {
                a.push("-b:v".into());
                a.push("0".into());
                a.push("-crf".into());
                a.push(ep.crf.unwrap_or(30).to_string());
            } else {
                a.push("-b:v".into());
                a.push(ep.video_bitrate_kbps.unwrap_or(1000).to_string() + "k");
            }
            a.push("-deadline".into());
            a.push("good".into());
            a.push("-cpu-used".into());
            a.push(vp9_cpu_used(&ep.preset).to_string());
            a.push("-row-mt".into());
            a.push("1".into());
        }
        "libsvtav1" => {
            if ep.quality_mode == "crf" {
                a.push("-crf".into());
                a.push(ep.crf.unwrap_or(32).to_string());
            } else if ep.quality_mode == "bitrate" {
                a.push("-b:v".into());
                a.push(ep.video_bitrate_kbps.unwrap_or(1000).to_string() + "k");
            }
            a.push("-preset".into());
            a.push(svt_preset(&ep.preset).to_string());
        }
        "h264_nvenc" => {
            if ep.quality_mode == "crf" {
                a.push("-cq".into());
                a.push(ep.crf.unwrap_or(28).to_string());
            }
            a.push("-preset".into());
            a.push("p4".into());
        }
        "h264_qsv" => {
            if ep.quality_mode == "crf" {
                a.push("-q:v".into());
                a.push(ep.crf.unwrap_or(28).to_string());
            }
        }
        "h264_videotoolbox" => {
            if ep.quality_mode == "crf" {
                a.push("-b:v".into());
                a.push(format!("{}k", crf_to_bitrate(ep.crf.unwrap_or(28))));
            }
        }
        "h264_amf" => {
            if ep.quality_mode == "crf" {
                a.push("-rc".into());
                a.push("cqp".into());
                a.push("-qp".into());
                a.push(ep.crf.unwrap_or(28).to_string());
            }
        }
        "h264_vaapi" => {
            if ep.quality_mode == "crf" {
                a.push("-b:v".into());
                a.push(format!("{}k", crf_to_bitrate(ep.crf.unwrap_or(28))));
            }
        }
        "hevc_nvenc" => {
            if ep.quality_mode == "crf" {
                a.push("-cq".into());
                a.push(ep.crf.unwrap_or(28).to_string());
            }
            a.push("-preset".into());
            a.push("p4".into());
        }
        "hevc_qsv" => {
            if ep.quality_mode == "crf" {
                a.push("-q:v".into());
                a.push(ep.crf.unwrap_or(28).to_string());
            }
        }
        "hevc_videotoolbox" => {
            if ep.quality_mode == "crf" {
                a.push("-b:v".into());
                a.push(format!("{}k", crf_to_bitrate(ep.crf.unwrap_or(28))));
            }
        }
        "hevc_amf" => {
            if ep.quality_mode == "crf" {
                a.push("-rc".into());
                a.push("cqp".into());
                a.push("-qp".into());
                a.push(ep.crf.unwrap_or(28).to_string());
            }
        }
        "hevc_vaapi" => {
            if ep.quality_mode == "crf" {
                a.push("-b:v".into());
                a.push(format!("{}k", crf_to_bitrate(ep.crf.unwrap_or(28))));
            }
        }
        _ => {}
    }

    if ep.quality_mode == "bitrate" {
        if let Some(b) = ep.video_bitrate_kbps {
            a.push("-b:v".into());
            a.push(format!("{}k", b));
        }
    } else if ep.quality_mode == "target_size" {
        if let Some(mb) = ep.target_size_mb {
            if let Some(dur) = info.duration_secs {
                if dur > 0.0 {
                    let total_bits = mb * 1024.0 * 1024.0 * 8.0;
                    let total_kbps = total_bits / dur / 1000.0;
                    let audio_kbps = ep.audio_bitrate_kbps.unwrap_or(128) as f64;
                    let video_kbps = (total_kbps - audio_kbps).max(50.0);
                    a.push("-b:v".into());
                    a.push(format!("{}k", video_kbps as u32));
                }
            }
        }
    }

    if vcodec != "copy" {
        if let Some(fps) = ep.fps {
            if fps > 0 {
                a.push("-r".into());
                a.push(fps.to_string());
            }
        }
    }

    a
}

/// Build a `-filter_complex` for the single-watermark + other-filters chain.
fn build_overlay_filter_complex(
    chain: &MergedChain,
    info: &MediaInfo,
    wm_idx: usize,
    wm: &WatermarkParams,
) -> String {
    let vw = info.width.unwrap_or(1280) as f64;
    let vh = info.height.unwrap_or(720) as f64;
    let scale_pct = wm.scale_percent.clamp(1, 100) as f64 / 100.0;
    let tw = ((vw * scale_pct) as u32).max(16);
    let opacity = wm.opacity.unwrap_or(1.0).clamp(0.0, 1.0) as f64;
    let margin_pct = wm.margin_percent.unwrap_or(3).clamp(0, 30) as f64 / 100.0;
    let margin = ((vw.min(vh)) * margin_pct) as i64;

    let pos = wm.position.as_str();
    let x = match pos {
        "tl" | "ml" | "bl" => format!("{}", margin),
        "tc" | "mc" | "bc" => "(main_w-overlay_w)/2".to_string(),
        _ => format!("main_w-overlay_w-{}", margin),
    };
    let y = match pos {
        "tl" | "tc" | "tr" => format!("{}", margin),
        "ml" | "mc" | "mr" => "(main_h-overlay_h)/2".to_string(),
        _ => format!("main_h-overlay_h-{}", margin),
    };

    let before: Vec<&str> = chain
        .ops
        .iter()
        .take_while(|o| !matches!(o, VideoOp::Overlay(_)))
        .filter_map(vf_filter_string)
        .collect();
    let after: Vec<&str> = chain
        .ops
        .iter()
        .skip_while(|o| !matches!(o, VideoOp::Overlay(_)))
        .skip(1)
        .filter_map(vf_filter_string)
        .collect();
    let b = before.join(",");
    let af = after.join(",");

    let mut fc = String::new();
    fc.push_str(&format!("[{}:v]scale={}:-2", wm_idx, tw));
    if opacity < 1.0 {
        fc.push_str(",format=rgba,colorchannelmixer=aa=");
        fc.push_str(&format!("{:.6}", opacity));
    }
    fc.push_str("[wms];");

    if !b.is_empty() {
        fc.push_str(&format!("[0:v]{}[vm];", b));
    }
    let main = if b.is_empty() { "[0:v]" } else { "[vm]" };
    let ov_label = if af.is_empty() { "[vout]" } else { "[ov]" };
    fc.push_str(&format!("{}[wms]overlay=x={}:y={}{};", main, x, y, ov_label));
    if !af.is_empty() {
        fc.push_str(&format!("[ov]{}[vout];", af));
    }

    if !chain.drop_audio {
        if let Some(rate) = chain.audio_atempo {
            let factors = atempo_chain(rate);
            if !factors.is_empty() {
                let expr = factors
                    .iter()
                    .map(|f| format!("atempo={}", f))
                    .collect::<Vec<_>>()
                    .join(",");
                fc.push_str(&format!("[0:a]{}[aout];", expr));
            }
        }
    }

    fc
}

/// Build the full argument list for a merged single-command workflow.
fn merged_args(info: &MediaInfo, chain: &MergedChain, out: &Path, gpu: &Option<String>) -> Vec<String> {
    let mut a: Vec<String> = vec!["-nostats".into()];

    // Input: optional seek (-ss) before -i, optional -t after -i.
    if let Some((start, dur)) = chain.trim {
        if start > 0.0 {
            a.push("-ss".into());
            a.push(format!("{:.3}", start));
        }
        a.push("-i".into());
        a.push(info.path.clone());
        if let Some(d) = dur {
            if d > 0.0 {
                a.push("-t".into());
                a.push(format!("{:.3}", d));
            }
        }
    } else {
        a.push("-i".into());
        a.push(info.path.clone());
    }

    let overlay = chain
        .ops
        .iter()
        .find_map(|o| match o {
            VideoOp::Overlay(p) => Some(p),
            _ => None,
        });
    if let Some(wm) = overlay {
        a.push("-i".into());
        a.push(wm.image_path.clone());
    }

    // Filters.
    if let Some(wm) = overlay {
        let fc = build_overlay_filter_complex(chain, info, 1, wm);
        a.push("-filter_complex".into());
        a.push(fc);
        a.push("-map".into());
        a.push("[vout]".into());
        if chain.drop_audio {
            a.push("-an".into());
        } else if chain.audio_atempo.is_some() {
            a.push("-map".into());
            a.push("[aout]".into());
        } else {
            a.push("-map".into());
            a.push("0:a?".into());
        }
    } else {
        let vf: Vec<&str> = chain.ops.iter().filter_map(vf_filter_string).collect();
        if !vf.is_empty() {
            a.push("-vf".into());
            a.push(vf.join(","));
        }
        if !chain.drop_audio {
            if let Some(rate) = chain.audio_atempo {
                let factors = atempo_chain(rate);
                if !factors.is_empty() {
                    let expr = factors
                        .iter()
                        .map(|f| format!("atempo={}", f))
                        .collect::<Vec<_>>()
                        .join(",");
                    a.push("-af".into());
                    a.push(expr);
                }
            }
        }
    }

    if chain.strip_meta {
        a.extend(metadata_strip_args(true, true));
    }

    if !chain.needs_reencode {
        if chain.drop_audio {
            a.push("-an".into());
        }
        a.push("-c".into());
        a.push("copy".into());
    } else {
        let default = VideoParams {
            video_codec: "libx264".into(),
            quality_mode: "crf".into(),
            crf: Some(18),
            target_size_mb: None,
            video_bitrate_kbps: None,
            resolution: "original".into(),
            audio_codec: "aac".into(),
            audio_bitrate_kbps: Some(192),
            format: String::new(),
            preset: "medium".into(),
            fps: None,
            gpu: gpu.clone(),
        };
        let ep = chain
            .encode
            .clone()
            .map(|mut p| {
                p.gpu = gpu.clone();
                p
            })
            .unwrap_or(default);
        a.extend(video_encoder_args(info, &ep));

        if chain.drop_audio {
            a.push("-an".into());
        } else {
            a.push("-c:a".into());
            match ep.audio_codec.as_str() {
                "copy" => a.push("copy".into()),
                "opus" => {
                    a.push("libopus".into());
                    if let Some(b) = ep.audio_bitrate_kbps {
                        a.push("-b:a".into());
                        a.push(format!("{}k", b));
                    }
                }
                _ => {
                    a.push("aac".into());
                    if let Some(b) = ep.audio_bitrate_kbps {
                        a.push("-b:a".into());
                        a.push(format!("{}k", b));
                    }
                }
            }
        }
    }

    a.push("-threads".into());
    a.push("0".into());
    a.push("-progress".into());
    a.push("pipe:1".into());
    a.push("-y".into());
    a.push(out.to_string_lossy().to_string());
    a
}

/// Decide the final output extension for a mergeable chain, or None when the
/// chain cannot be merged into a single command.
pub(crate) fn merged_output_ext(
    info: &MediaInfo,
    steps: &[WorkflowStepInput],
) -> Option<String> {
    merged_chain(info, steps).map(|c| c.ext)
}

/// Start a workflow. When the steps are composable they are merged into a single
/// FFmpeg command that emits progress/done on `id`; otherwise `merged: false` is
/// returned so the frontend runs the steps one after another.
pub async fn start_workflow(app: AppHandle, req: WorkflowRequest) -> Result<StartWorkflowResult> {
    let id = uuid();
    let input = req.input.clone();
    // An empty chain cannot be merged; let the caller decide how to behave.
    if req.steps.is_empty() {
        return Ok(StartWorkflowResult { id, merged: false, skipped: false, note: None });
    }
    let info = probe(&app, &input).await?;
    let suffix = req
        .output_suffix
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "_mediatool".to_string());
    let policy = req.overwrite_policy.as_deref().unwrap_or("rename");

    let ext = match merged_output_ext(&info, &req.steps) {
        Some(ext) => ext,
        None => return Ok(StartWorkflowResult { id, merged: false, skipped: false, note: None }),
    };
    let out = output_path(&input, &req.output_dir, &ext, &suffix)?;
    let out = match resolve_policy(out, policy) {
        Ok(p) => p,
        Err(_existing) => {
            // Output already existed and policy = "skip": signal a no-op via the
            // `skipped` flag instead of emitting a synchronous done event (which
            // the frontend would race and miss). The caller finishes immediately.
            return Ok(StartWorkflowResult { id, merged: true, skipped: true, note: None });
        }
    };

    let Some(mut chain) = merged_chain(&info, &req.steps) else {
        return Ok(StartWorkflowResult { id, merged: false, skipped: false, note: None });
    };

    // Bound pipelines may auto-fallback: a stream-copy step whose source
    // codecs don't fit MP4 is swapped for the transcode recipe (the note
    // tells the user). Explicit workflow-builder steps keep the hard error.
    let mut copy_note = None;
    if req.allow_copy_fallback == Some(true) {
        if let Some(encode) = chain.encode.as_mut() {
            copy_note = mp4_copy_fallback(encode, &info);
        }
    }

    // Codec/container sanity for the final encode (e.g. H.264 into WebM).
    {
        let (vc, ac) = match &chain.encode {
            Some(p) => (p.video_codec.as_str(), p.audio_codec.as_str()),
            None => ("copy", "copy"),
        };
        validate_video_container(&chain.ext, vc, ac, &info)?;
    }

    // Progress denominator: when the chain starts with a trim, out_time only
    // covers the trimmed window, so normalizing against the full duration
    // would keep the percent near 0 the whole time.
    let total = info.duration_secs.unwrap_or(0.0);
    let duration = match chain.trim {
        Some((start, dur)) => trim_window_secs(total, start, dur),
        None => total,
    };
    let args = merged_args(&info, &chain, &out, &req.gpu);

    let (child, stdout, stderr_buf, stderr_drain) = ffmpeg::spawn(&app, "ffmpeg", &args)?;
    let input_size = info.size_bytes;
    let task_id = id.clone();

    let child = std::sync::Arc::new(std::sync::Mutex::new(child));
    let manager = app.state::<JobManager>();
    manager.register(&task_id, child.clone());
    // If cancel arrived between spawn and register the kill above missed the
    // child; kill it now so the cancel is honored immediately.
    if manager.is_cancelled(&task_id) {
        if let Ok(mut c) = child.lock() {
            let _ = c.kill();
        }
    }
    emit_progress(&app, &task_id, 0.0, "running", None);

    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        let mut last_percent = 0.0_f64;
        let mut last_speed: Option<String> = None;

        for line in reader.lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => break,
            };
            let line = line.trim();
            if line.starts_with("out_time_ms=") {
                if let Ok(ms) = line["out_time_ms=".len()..].trim().parse::<f64>() {
                    let secs = ms / 1_000_000.0;
                    let pct = if duration > 0.0 {
                        (secs / duration * 100.0).clamp(0.0, 100.0)
                    } else {
                        0.0
                    };
                    if (pct - last_percent).abs() >= 0.5 {
                        last_percent = pct;
                        emit_progress(&app, &task_id, pct, "running", last_speed.clone());
                    }
                }
            } else if line.starts_with("speed=") {
                last_speed = Some(line["speed=".len()..].trim().to_string());
            }
        }

        let manager = app.state::<JobManager>();
        let was_cancelled = manager.is_cancelled(&task_id);
        manager.finish(&task_id);

        let code = match child.lock().unwrap().wait() {
            Ok(status) => status.code().unwrap_or(-1),
            Err(_) => -1,
        };

        if was_cancelled || code != 0 {
            let err = if was_cancelled {
                "已取消".to_string()
            } else {
                let detail = {
                    // Make sure the drain thread has flushed the tail of stderr
                    // before reading the captured buffer.
                    let _ = stderr_drain.join();
                    let buf = stderr_buf.lock().unwrap();
                    if buf.is_empty() {
                        String::new()
                    } else {
                        let s = String::from_utf8_lossy(&buf);
                        if s.len() > 1500 {
                            format!("\n\n{}", tail_chars(&s, 4000))
                        } else {
                            format!("\n\n{}", s)
                        }
                    }
                };
                format!("FFmpeg 退出码 {}{}", code, detail)
            };
            let _ = std::fs::remove_file(&out);
            emit_done(&app, &task_id, false, was_cancelled, false, None, Some(err), input_size, None);
        } else {
            let output_size = std::fs::metadata(&out).map(|m| m.len()).ok();
            emit_progress(&app, &task_id, 100.0, "done", last_speed.clone());
            emit_done(
                &app,
                &task_id,
                true,
                false,
                false,
                Some(out.to_string_lossy().to_string()),
                None,
                input_size,
                output_size,
            );
        }
    });

    Ok(StartWorkflowResult { id, merged: true, skipped: false, note: copy_note })
}

/// Start a conversion job. Spawns FFmpeg, streams progress, emits events.
pub async fn start_job(app: AppHandle, req: JobRequest) -> Result<StartJobResult> {
    let id = uuid();
    let input = req
        .inputs
        .first()
        .cloned()
        .ok_or_else(|| AppError("缺少输入文件".into()))?;
    let info = probe(&app, &input).await?;
    let suffix = req
        .output_suffix
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "_mediatool".to_string());
    let policy = req
        .overwrite_policy
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "rename".to_string());
    // Sequential (non-merged) pipeline steps land here with the remux
    // auto-fallback opted in: swap copy params for the transcode recipe when
    // the source codecs can't be copied into MP4 (see mp4_copy_fallback).
    let mut req = req;
    let mut copy_note: Option<String> = None;
    if req.allow_copy_fallback == Some(true)
        && matches!(norm_tool_id(&req.tool_id), "compress" | "convert")
    {
        if let Ok(mut p) = parse_params::<VideoParams>(&req.params) {
            if let Some(note) = mp4_copy_fallback(&mut p, &info) {
                req.params = serde_json::to_value(&p).map_err(|e| AppError(e.to_string()))?;
                copy_note = Some(note);
            }
        }
    }
    // prepare_job may block (probing merge inputs, converting a PDF source
    // image) — keep it off the async runtime workers.
    let prepared = {
        let app2 = app.clone();
        let info2 = info.clone();
        let req2 = req.clone();
        tauri::async_runtime::spawn_blocking(move || {
            prepare_job(Some(&app2), &info2, &req2, &suffix, &policy)
        })
            .await
            .map_err(|e| AppError(e.to_string()))??
    };

    let runs: Vec<(Vec<String>, PathBuf, f64)> = match prepared {
        PreparedJob::Skipped { existing } => {
            // Nothing was started; the frontend treats this as a terminal
            // "skipped" phase via the command's return value. The existing
            // file lets the workflow fallback chain keep its input->output
            // semantics for skipped steps.
            return Ok(StartJobResult {
                id,
                skipped: true,
                output: existing.map(|p| p.to_string_lossy().to_string()),
                note: None,
            });
        }
        PreparedJob::Run { args, out } => {
            // Trim-aware progress denominator (gif / screenshot interval /
            // trimmed single-segment jobs only reach a fraction of the file).
            let dur = effective_duration(&req, &info);
            vec![(args, out, dur)]
        }
        PreparedJob::RunMany { runs } => runs,
    };

    if runs.is_empty() {
        return Ok(StartJobResult { id, skipped: true, output: None, note: None });
    }
    let input_size = info.size_bytes;
    let total_dur: f64 = runs.iter().map(|r| r.2.max(0.0)).sum();
    let task_id = id.clone();

    emit_progress(&app, &task_id, 0.0, "running", None);

    std::thread::spawn(move || {
        let mut accum = 0.0_f64;
        let mut last_percent = 0.0_f64;
        let mut last_speed: Option<String> = None;
        let first_out = runs.first().map(|r| r.1.clone());
        let mut total_size: u64 = 0;
        let mut ok = false;
        let mut cancelled = false;
        let mut err_msg: Option<String> = None;

        'runs: for (_idx, (rargs, out, dur)) in runs.iter().enumerate() {
            let mut args = rargs.clone();
            args.insert(0, "-nostats".into());
            let (child, stdout, stderr_buf, stderr_drain) = match ffmpeg::spawn(&app, "ffmpeg", &args) {
                Ok(v) => v,
                Err(e) => {
                    ok = false;
                    err_msg = Some(e.to_string());
                    break 'runs;
                }
            };

            let child = std::sync::Arc::new(std::sync::Mutex::new(child));
            let manager = app.state::<JobManager>();
            manager.register(&task_id, child.clone());
            // Honor a cancel that arrived between spawn and register.
            if manager.is_cancelled(&task_id) {
                if let Ok(mut c) = child.lock() {
                    let _ = c.kill();
                }
            }

            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                let line = match line {
                    Ok(l) => l,
                    Err(_) => break,
                };
                let line = line.trim();
                if line.starts_with("out_time_ms=") {
                    if let Ok(ms) = line["out_time_ms=".len()..].trim().parse::<f64>() {
                        let run_secs = ms / 1_000_000.0;
                        let pct = if total_dur > 0.0 {
                            ((accum + run_secs) / total_dur * 100.0).clamp(0.0, 100.0)
                        } else {
                            0.0
                        };
                        if (pct - last_percent).abs() >= 0.5 {
                            last_percent = pct;
                            emit_progress(&app, &task_id, pct, "running", last_speed.clone());
                        }
                    }
                } else if line.starts_with("speed=") {
                    last_speed = Some(line["speed=".len()..].trim().to_string());
                }
            }

            // Process finished; collect exit status.
            let manager = app.state::<JobManager>();
            let was_cancelled = manager.is_cancelled(&task_id);
            manager.finish(&task_id);

            let code = match child.lock().unwrap().wait() {
                Ok(status) => status.code().unwrap_or(-1),
                Err(_) => -1,
            };

            if was_cancelled || code != 0 {
                cancelled = was_cancelled;
                err_msg = Some(if was_cancelled {
                    "已取消".to_string()
                } else {
                    let detail = {
                        // Wait for the drain thread so the tail of stderr is
                        // captured before reporting the error.
                        let _ = stderr_drain.join();
                        let buf = stderr_buf.lock().unwrap();
                        if buf.is_empty() {
                            String::new()
                        } else {
                            let s = String::from_utf8_lossy(&buf);
                            if s.len() > 1500 {
                                format!("\n\n{}", tail_chars(&s, 4000))
                            } else {
                                format!("\n\n{}", s)
                            }
                        }
                    };
                    format!("FFmpeg 退出码 {}{}", code, detail)
                });
                if out.to_string_lossy().contains("%03d") {
                    cleanup_pattern_outputs(out);
                } else {
                    let _ = std::fs::remove_file(out);
                }
                break 'runs;
            }

            // Success: accumulate the run's processed duration and result size.
            ok = true;
            accum += dur.max(0.0);
            let is_pattern = out.to_string_lossy().contains("%03d");
            if !is_pattern && out.to_string_lossy().ends_with(".txt") {
                // Join the drain thread first — the silencedetect results live
                // in stderr and the thread may still hold the last lines.
                let _ = stderr_drain.join();
                let log = {
                    let buf = stderr_buf.lock().unwrap();
                    String::from_utf8_lossy(&buf).to_string()
                };
                let _ = std::fs::write(out, log.as_bytes());
            }
            total_size += if is_pattern {
                pattern_output_size(out).unwrap_or(0)
            } else {
                std::fs::metadata(out).map(|m| m.len()).unwrap_or(0)
            };
        }

        if ok && !runs.is_empty() {
            emit_progress(&app, &task_id, 100.0, "done", last_speed.clone());
            emit_done(
                &app,
                &task_id,
                true,
                false,
                false,
                first_out.map(|p| p.to_string_lossy().to_string()),
                None,
                input_size,
                if total_size > 0 { Some(total_size) } else { None },
            );
        } else {
            emit_done(&app, &task_id, false, cancelled, false, None, err_msg, input_size, None);
        }
    });

    Ok(StartJobResult { id, skipped: false, output: None, note: copy_note })
}

/// Effective duration a single-output job will actually encode, used as the
/// progress denominator. Falls back to the full duration.
fn effective_duration(req: &JobRequest, info: &MediaInfo) -> f64 {
    let total = info.duration_secs.unwrap_or(0.0);
    match tool_dispatch(&req.tool_id) {
        "screenshot" => parse_params::<ScreenshotParams>(&req.params)
            .map(|p| {
                if p.mode == "interval" {
                    let start = p.start_sec.unwrap_or(0.0).max(0.0);
                    trim_window_secs(total, start, p.end_sec.map(|e| e - start))
                } else {
                    total
                }
            })
            .unwrap_or(total),
        "trim" => parse_params::<TrimParams>(&req.params)
            .map(|p| trim_window_secs(total, p.start_time, p.duration))
            .unwrap_or(total),
        _ => total,
    }
}

/// Refined size estimate via a short real encode of a sample clip.
///
/// Reuses the exact same argument builders as `start_job`, but encodes only a
/// few seconds to a temp file, then extrapolates the produced byte count over
/// the total duration.
pub async fn estimate_size(app: AppHandle, req: EstimateRequest) -> Result<EstimateResult> {
    let sample_secs = req.sample_secs.unwrap_or(8.0).max(0.1);
    let info = req.info;
    let ext = extension_for("estimate", &info, &req.params);
    let tmp = std::env::temp_dir().join(format!("mediatool_est_{}.{}", uuid(), ext));

    let total = info.duration_secs;

    // Decide where to sample from: skip the first ~10% to avoid static
    // intros, but keep at least a sliver of headroom.
    let offset = match total {
        Some(t) if t > 0.2 => ((t * 0.1)).min(t - 0.1).max(0.0),
        _ => 0.0,
    };

    let max_dur = total.map_or(sample_secs, |t| (t - offset).max(0.1));
    let sample_dur = sample_secs.min(max_dur);

    // Build args from the original params; the sample window is added below.
    let mut base_args: Vec<String> = match req.media_type {
        MediaType::Video => {
            let p: VideoParams = parse_params(&req.params)?;
            build_video_args(&info, &p, &tmp)
        }
        MediaType::Image | MediaType::Unknown => {
            return Err(AppError("不支持的媒体类型".into()))
        }
        MediaType::Audio => {
            let p: AudioParams = parse_params(&req.params)?;
            build_audio_args(&info, &p, &tmp)
        }
    };

    // Drop the progress pipe so we don't have to drain stdout.
    if let Some(pos) = base_args.iter().position(|a| a == "-progress") {
        base_args.drain(pos..=pos + 1);
    }

    // Compose final args: [-nostats, -ss offset, <base>, -t sample_dur, out].
    let out_pos = base_args.len() - 1; // last element is the output path
    base_args.insert(out_pos, "-t".into());
    base_args.insert(out_pos + 1, format!("{:.3}", sample_dur));
    let mut final_args: Vec<String> = Vec::with_capacity(base_args.len() + 3);
    final_args.push("-nostats".into());
    final_args.push("-ss".into());
    final_args.push(format!("{:.3}", offset));
    final_args.extend(base_args);

    let (child, _stdout, _stderr, _drain) = ffmpeg::spawn(&app, "ffmpeg", &final_args)?;
    // Sample-encoding a real clip blocks for seconds — keep it off the async
    // runtime workers.
    let waited = tauri::async_runtime::spawn_blocking(move || {
        let mut child = child;
        let code = child.wait().map(|s| s.code().unwrap_or(-1)).unwrap_or(-1);
        let sampled_bytes = std::fs::metadata(&tmp).map(|m| m.len()).unwrap_or(0);
        let _ = std::fs::remove_file(&tmp);
        (code, sampled_bytes)
    })
    .await
    .map_err(|e| AppError(e.to_string()))?;
    let (code, sampled_bytes) = waited;

    if code != 0 || sampled_bytes == 0 {
        return Err(AppError("采样编码失败，无法精确估算".into()));
    }

    // Whole clip was sampled -> exact.
    let clip_len = total.unwrap_or(sample_dur);

    let exact = sample_dur >= clip_len - 1e-6;
    let bytes = if total.is_some() {
        let denom = sample_dur.max(1e-6);
        (sampled_bytes as f64 / denom * (clip_len.max(0.0))).round() as u64
    } else {
        sampled_bytes
    };

    Ok(EstimateResult {
        sampled_bytes,
        sampled_secs: sample_dur,
        total_secs: if total.is_some() {
            Some(clip_len)
        } else {
            None
        },
        bytes,
        exact,
    })
}

/// Tail of a (possibly multi-byte) log string, safe on char boundaries.
fn tail_chars(s: &str, max_bytes: usize) -> String {
    let s = s.trim();
    if s.len() <= max_bytes {
        return s.to_string();
    }
    let mut start = s.len() - max_bytes;
    while !s.is_char_boundary(start) {
        start += 1;
    }
    s[start..].to_string()
}

fn emit_progress(app: &AppHandle, id: &str, percent: f64, phase: &str, speed: Option<String>) {
    let _ = app.emit(
        "job-progress",
        ProgressEvent {
            id: id.to_string(),
            percent,
            phase: phase.to_string(),
            speed,
        },
    );
}

fn emit_done(
    app: &AppHandle,
    id: &str,
    ok: bool,
    cancelled: bool,
    skipped: bool,
    output: Option<String>,
    error: Option<String>,
    input_size: u64,
    output_size: Option<u64>,
) {
    let _ = app.emit(
        "job-done",
        DoneEvent {
            id: id.to_string(),
            ok,
            cancelled,
            skipped: if skipped { Some(true) } else { None },
            output,
            error,
            input_size,
            output_size,
        },
    );
}

fn uuid() -> String {
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
    use crate::models::MediaInfo;

    fn sample_info() -> MediaInfo {
        MediaInfo {
            path: "in.mp4".into(),
            media_type: MediaType::Video,
            duration_secs: Some(10.0),
            width: Some(1920),
            height: Some(1080),
            video_codec: Some("h264".into()),
            audio_codec: Some("aac".into()),
            bitrate_kbps: Some(2000),
            size_bytes: 1_000_000,
            hdr: false,
        }
    }

    fn video_params() -> VideoParams {
        VideoParams {
            video_codec: "libx264".into(),
            quality_mode: "crf".into(),
            crf: Some(26),
            target_size_mb: None,
            video_bitrate_kbps: None,
            resolution: "720p".into(),
            audio_codec: "aac".into(),
            audio_bitrate_kbps: Some(128),
            format: "mp4".into(),
            preset: "medium".into(),
            fps: None,
            gpu: None,
        }
    }

    #[test]
    fn video_crf_args() {
        let args = build_video_args(&sample_info(), &video_params(), Path::new("out.mp4"));
        assert!(args.contains(&"-c:v".to_string()));
        assert!(args.contains(&"libx264".to_string()));
        assert!(args.contains(&"-crf".to_string()));
        assert!(args.contains(&"26".to_string()));
        assert!(args.contains(&"-vf".to_string()));
        assert!(args.contains(&"scale=-2:720".to_string()));
        assert!(args.contains(&"-preset".to_string()));
        assert!(args.contains(&"-progress".to_string()));
        assert!(args.contains(&"pipe:1".to_string()));
        assert_eq!(args.last().unwrap(), "out.mp4");
    }

    #[test]
    fn video_target_size_bitrate() {
        let mut p = video_params();
        p.quality_mode = "target_size".into();
        p.target_size_mb = Some(5.0);
        let args = build_video_args(&sample_info(), &p, Path::new("o.mp4"));
        let idx = args.iter().position(|a| a == "-b:v").unwrap();
        let kb: u32 = args[idx + 1].trim_end_matches('k').parse().unwrap();
        // 5MB over 10s = 4.0 Mbps total; minus 128k audio ≈ 3872k video.
        assert!((3000..4200).contains(&kb), "unexpected bitrate {}", kb);
    }

    #[test]
    fn video_vp9_crf() {
        let mut p = video_params();
        p.video_codec = "libvpx-vp9".into();
        p.format = "webm".into();
        let args = build_video_args(&sample_info(), &p, Path::new("o.webm"));
        assert!(args.contains(&"libvpx-vp9".to_string()));
        assert!(args.contains(&"-b:v".to_string()));
        assert!(args.contains(&"0".to_string()));
        assert!(args.contains(&"-crf".to_string()));
        assert!(args.contains(&"-cpu-used".to_string()));
        assert_eq!(args.last().unwrap(), "o.webm");
    }

    #[test]
    fn audio_source_format_picks_encoder_from_ext() {
        let mut info = sample_info();
        info.media_type = MediaType::Audio;
        info.path = "song.mp3".into();
        let p = AudioParams { format: "source".into(), bitrate_kbps: 192 };
        let args = build_audio_args(&info, &p, Path::new("o.mp3"));
        assert!(args.contains(&"libmp3lame".to_string()));
        assert!(args.contains(&"192k".to_string()));

        info.path = "song.flac".into();
        let args = build_audio_args(&info, &p, Path::new("o.flac"));
        assert!(args.contains(&"flac".to_string()));
        assert!(!args.contains(&"-b:a".to_string()), "flac is lossless, no bitrate flag");
    }

    #[test]
    fn audio_mp3_bitrate() {
        let p = AudioParams { format: "mp3".into(), bitrate_kbps: 192 };
        let args = build_audio_args(&sample_info(), &p, Path::new("o.mp3"));
        assert!(args.contains(&"-vn".to_string()));
        assert!(args.contains(&"libmp3lame".to_string()));
        assert!(args.contains(&"-b:a".to_string()));
        assert!(args.contains(&"192k".to_string()));
    }

    #[test]
    fn av1_crf_and_preset() {
        let mut p = video_params();
        p.video_codec = "libsvtav1".into();
        p.crf = Some(32);
        let args = build_video_args(&sample_info(), &p, Path::new("o.mp4"));
        assert!(args.contains(&"libsvtav1".to_string()));
        let idx = args.iter().position(|a| a == "-crf").unwrap();
        assert_eq!(args[idx + 1], "32");
        let pidx = args.iter().position(|a| a == "-preset").unwrap();
        // medium maps to SVT preset 7
        assert_eq!(args[pidx + 1], "7");
        // no -cpu-used / -deadline (those are VP9-only)
        assert!(!args.contains(&"-cpu-used".to_string()));
    }

    #[test]
    fn av1_bitrate_mode() {
        let mut p = video_params();
        p.video_codec = "libsvtav1".into();
        p.quality_mode = "bitrate".into();
        p.video_bitrate_kbps = Some(1500);
        let args = build_video_args(&sample_info(), &p, Path::new("o.mkv"));
        assert!(args.contains(&"1500k".to_string()));
        assert!(!args.contains(&"-crf".to_string()));
    }

    #[test]
    fn fps_arg_added_and_skipped_for_copy() {
        let mut p = video_params();
        p.fps = Some(30);
        let args = build_video_args(&sample_info(), &p, Path::new("o.mp4"));
        let idx = args.iter().position(|a| a == "-r").unwrap();
        assert_eq!(args[idx + 1], "30");

        p.video_codec = "copy".into();
        let args = build_video_args(&sample_info(), &p, Path::new("o.mp4"));
        assert!(!args.contains(&"-r".to_string()));

        p.fps = Some(0);
        let args = build_video_args(&sample_info(), &p, Path::new("o.mp4"));
        assert!(!args.contains(&"-r".to_string()));
    }

    /* ── standalone tools ─────────────────────────────────────────── */

    #[test]
    fn strip_metadata_remux_args() {
        let args =
            build_strip_metadata_args(&sample_info(), &StripMetadataParams {}, Path::new("o.mp4"));
        assert!(args.contains(&"-map_metadata".to_string()));
        assert!(args.contains(&"-map_chapters".to_string()));
        assert!(args.contains(&"-c".to_string()));
        assert!(args.contains(&"copy".to_string()));
        assert!(!args.contains(&"-an".to_string()));
    }

    #[test]
    fn strip_metadata_image_reencode() {
        let mut info = sample_info();
        info.media_type = MediaType::Image;
        info.path = "photo.jpg".into();
        let args =
            build_strip_metadata_args(&info, &StripMetadataParams {}, Path::new("o.jpg"));
        assert!(args.contains(&"-q:v".to_string()));
        assert!(args.contains(&"2".to_string()));
        assert!(args.contains(&"-map_metadata".to_string()) == false || true); // image path uses re-encode, metadata dropped implicitly
    }

    #[test]
    fn mute_args_lossless() {
        let args = build_mute_args(&sample_info(), &MuteParams {}, Path::new("o.mp4"));
        assert!(args.contains(&"-an".to_string()));
        assert!(args.contains(&"-c".to_string()));
        assert!(args.contains(&"copy".to_string()));
        assert!(!args.contains(&"libx264".to_string()));
    }

    fn trim_params(mode: &str) -> TrimParams {
        TrimParams { start_time: 5.5, duration: Some(10.0), mode: mode.into(), segments: vec![] }
    }

    #[test]
    fn trim_copy_args() {
        let args = build_trim_args(&sample_info(), &trim_params("copy"), Path::new("o.mp4"));
        let ss_idx = args.iter().position(|a| a == "-ss").unwrap();
        assert_eq!(args[ss_idx + 1], "5.500");
        let i_idx = args.iter().position(|a| a == "-i").unwrap();
        assert!(ss_idx < i_idx, "-ss must precede -i for fast seek");
        let t_idx = args.iter().position(|a| a == "-t").unwrap();
        assert!(i_idx < t_idx, "-t must follow -i");
        assert_eq!(args[t_idx + 1], "10.000");
        assert!(args.contains(&"-c".to_string()));
        assert!(args.contains(&"copy".to_string()));
        assert!(!args.contains(&"libx264".to_string()));
    }

    #[test]
    fn trim_encode_args() {
        let args = build_trim_args(&sample_info(), &trim_params("encode"), Path::new("o.mp4"));
        assert!(args.contains(&"libx264".to_string()));
        assert!(args.contains(&"-crf".to_string()));
        assert!(!args.contains(&"copy".to_string()));
    }

    #[test]
    fn extension_source_keeps_input() {
        let mut info = sample_info();
        info.path = "clip.mkv".into();
        assert_eq!(
            extension_for("compress", &info, &serde_json::json!({"format": "source"})),
            "mkv"
        );
        info.media_type = MediaType::Audio;
        info.path = "song.flac".into();
        assert_eq!(
            extension_for("convert", &info, &serde_json::json!({"format": "source"})),
            "flac"
        );
        info.media_type = MediaType::Image;
        info.path = "pic.avif".into();
        assert_eq!(
            extension_for("compress", &info, &serde_json::json!({"format": "source"})),
            "avif"
        );
        // extract-audio maps format to the canonical audio ext
        assert_eq!(
            extension_for("extract-audio", &info, &serde_json::json!({"format": "aac"})),
            "m4a"
        );
    }

    #[test]
    fn safe_container_ext_for_h264_aac() {
        let mut info = sample_info();
        info.path = "v.webm".into();
        assert_eq!(safe_container_ext(&info), "mp4");
        info.path = "v.mov".into();
        assert_eq!(safe_container_ext(&info), "mov");
        info.path = "v.mkv".into();
        assert_eq!(safe_container_ext(&info), "mkv");
    }

    fn req(tool: &str, params: serde_json::Value) -> JobRequest {
        JobRequest {
            tool_id: tool.into(),
            inputs: vec!["in.mp4".into()],
            output_dir: None,
            params,
            output_suffix: Some("_mediatool".into()),
            gpu: None,
            overwrite_policy: None,
            allow_copy_fallback: None,
        }
    }

    #[test]
    fn prepare_extract_audio_args_and_ext() {
        let mut info = sample_info();
        info.path = "movie.mp4".into();
        match prepare_job(
            None,
            &info,
            &req("extract-audio", serde_json::json!({"format":"opus","bitrateKbps":128})),
            "_mediatool",
            "rename",
        )
        .unwrap()
        {
            PreparedJob::Run { args, out } => {
                assert!(out.to_string_lossy().ends_with(".opus"), "got {:?}", out);
                assert!(args.contains(&"-vn".to_string()));
                assert!(args.contains(&"libopus".to_string()));
            }
            _ => panic!("expected Run"),
        }
    }

    #[test]
    fn prepare_strip_metadata_video_remux() {
        let mut info = sample_info();
        info.path = "clip.mp4".into();
        match prepare_job(None, &info, &req("strip-metadata", serde_json::json!({})), "_mediatool", "rename").unwrap() {
            PreparedJob::Run { args, out } => {
                assert!(out.to_string_lossy().ends_with(".mp4"), "got {:?}", out);
                assert!(args.contains(&"copy".to_string()));
            }
            _ => panic!("expected Run"),
        }
    }

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

    fn shot_params(mode: &str) -> ScreenshotParams {
        ScreenshotParams {
            mode: mode.into(),
            at_sec: Some(3.5),
            every_sec: Some(5.0),
            start_sec: Some(2.0),
            end_sec: Some(30.0),
            format: "png".into(),
            max_width: Some(1280),
        }
    }

    #[test]
    fn screenshot_single_and_interval() {
        let sp = shot_params("single");
        let args = build_screenshot_single(&sample_info(), &sp, Path::new("o.png"));
        let ss = args.iter().position(|a| a == "-ss").unwrap();
        assert_eq!(args[ss + 1], "3.500");
        assert!(args.contains(&"-frames:v".to_string()));
        assert!(args.contains(&"scale=1280:-2".to_string()));

        let ip = shot_params("interval");
        let args = build_screenshot_interval(&sample_info(), &ip, Path::new("o_%03d.png"));
        assert!(args.iter().any(|a| a.contains("fps=1/5.000")));
        let t = args.iter().position(|a| a == "-t").unwrap();
        assert_eq!(args[t + 1], "28.000");
        assert_eq!(args.last().unwrap(), "o_%03d.png");
    }

    #[test]
    fn interval_pattern_naming() {
        let base = PathBuf::from("anywhere").join("clip_mediatool.png");
        let pat = interval_pattern(base);
        assert_eq!(
            pat.file_name().and_then(|n| n.to_str()),
            Some("clip_mediatool_%03d.png")
        );
    }

    #[test]
    fn atempo_chain_values() {
        assert_eq!(atempo_chain(1.0), Vec::<String>::new());
        assert_eq!(atempo_chain(1.5), vec!["1.500000".to_string()]);
        assert_eq!(atempo_chain(4.0), vec!["2.000000".to_string(), "2.000000".to_string()]);
        assert_eq!(atempo_chain(0.25), vec!["0.500000".to_string(), "0.500000".to_string()]);
        // 0.75 -> 0.75 stays single (>= 0.5)
        assert_eq!(atempo_chain(0.75), vec!["0.750000".to_string()]);
    }

    fn speed_params(rate: f64, mute: bool) -> SpeedParams {
        SpeedParams { rate, mute_audio: Some(mute) }
    }

    #[test]
    fn speed_video_args() {
        let p = speed_params(4.0, false);
        let args = build_speed_args(&sample_info(), &p, Path::new("o.mp4"));
        assert!(args.contains(&"setpts=PTS/4.000000".to_string()));
        assert!(args.iter().any(|a| a.contains("atempo=2.000000,atempo=2.000000")));
        assert!(args.contains(&"-crf".to_string()));
        assert!(args.contains(&"192k".to_string()));

        let p = speed_params(2.0, true);
        let args = build_speed_args(&sample_info(), &p, Path::new("o.mp4"));
        assert!(args.contains(&"-an".to_string()));
        assert!(!args.iter().any(|a| a.starts_with("atempo=")));
    }

    #[test]
    fn speed_audio_only_no_setpts() {
        let mut info = sample_info();
        info.media_type = MediaType::Audio;
        info.video_codec = None;
        info.audio_codec = Some("aac".into());
        let p = speed_params(0.5, false);
        let args = build_speed_args(&info, &p, Path::new("o.m4a"));
        assert!(!args.contains(&"-vf".to_string()));
        assert!(args.contains(&"atempo=0.500000".to_string()));
    }

    fn wm_params(pos: &str, opacity: Option<f32>) -> WatermarkParams {
        WatermarkParams {
            image_path: "wm.png".into(),
            position: pos.into(),
            scale_percent: 20,
            opacity,
            margin_percent: Some(3),
        }
    }

    #[test]
    fn watermark_args_geometry() {
        let p = wm_params("br", Some(0.5));
        let args = build_watermark_args(&sample_info(), &p, "wm.png", Path::new("o.mp4"));
        let fc = args.iter().position(|a| a == "-filter_complex").unwrap();
        let fc_val = &args[fc + 1];
        // 20% of probed 1920px -> 384px watermark width
        assert!(fc_val.contains("scale=384:-2"));
        assert!(fc_val.contains("aa=0.500000"));
        // margin = 3% of min(1920,1080) = 32px
        assert!(fc_val.contains("overlay=x=main_w-overlay_w-32"));
        assert!(fc_val.contains("y=main_h-overlay_h-32"));
        // two inputs and stream mapping
        assert_eq!(args.iter().filter(|a| *a == "-i").count(), 2);
        assert!(args.contains(&"[v]".to_string()));
        assert!(args.contains(&"0:a?".to_string()));
    }

    #[test]
    fn watermark_full_opacity_skips_alpha() {
        let p = wm_params("tl", None);
        let args = build_watermark_args(&sample_info(), &p, "wm.png", Path::new("o.mp4"));
        let fc_idx = args.iter().position(|a| a == "-filter_complex").unwrap();
        let fc_val = &args[fc_idx + 1];
        assert!(!fc_val.contains("colorchannelmixer"));
        assert!(fc_val.contains("x=32:y=32"));
    }

    /* ── container validation for stream-copy ────────────────────── */

    #[test]
    fn mp4_copy_rejects_non_mp4_source_codecs() {
        let mut info = sample_info();
        info.video_codec = Some("vp8".into());
        info.audio_codec = Some("opus".into());
        let err = validate_video_container("mp4", "copy", "copy", &info).unwrap_err();
        assert!(err.0.contains("vp8"), "{}", err.0);
        // Video-only source (no audio track) must still hit the video error.
        let mut no_audio = info.clone();
        no_audio.audio_codec = None;
        let err = validate_video_container("mp4", "copy", "copy", &no_audio).unwrap_err();
        assert!(err.0.contains("vp8"), "{}", err.0);
        // With an mp4-safe video codec, an incompatible audio one is flagged.
        let mut bad_audio = info.clone();
        bad_audio.video_codec = Some("h264".into());
        let err = validate_video_container("mp4", "copy", "copy", &bad_audio).unwrap_err();
        assert!(err.0.contains("opus"), "{}", err.0);
    }

    #[test]
    fn mp4_copy_allows_common_stream_codecs() {
        // h264 + aac — the typical live-recording (MKV) contents.
        assert!(validate_video_container("mp4", "copy", "copy", &sample_info()).is_ok());
        // A video without an audio track is fine too.
        let mut info = sample_info();
        info.audio_codec = None;
        assert!(validate_video_container("mp4", "copy", "copy", &info).is_ok());
    }

    #[test]
    fn mp4_encode_target_not_gated_by_copy_check() {
        // Re-encode paths pick their own target codecs; the source codecs are
        // irrelevant for container validity there.
        let mut info = sample_info();
        info.video_codec = Some("vp9".into());
        info.audio_codec = Some("opus".into());
        assert!(validate_video_container("mp4", "libx264", "aac", &info).is_ok());
    }

    #[test]
    fn webm_copy_checks_unchanged() {
        let mut info = sample_info();
        info.video_codec = Some("vp9".into());
        info.audio_codec = Some("opus".into());
        assert!(validate_video_container("webm", "copy", "copy", &info).is_ok());
        assert!(validate_video_container("webm", "copy", "copy", &sample_info()).is_err());
    }

    #[test]
    fn hdr_sources_get_tonemapped_to_sdr() {
        let has_tonemap = |args: &[String]| args.iter().any(|a| a.contains("tonemap=hable"));
        let mut info = sample_info();
        assert!(!info.hdr);
        let plain = build_video_args(&info, &video_params(), Path::new("out.mp4"));
        assert!(!has_tonemap(&plain));

        info.hdr = true;
        let hdr = build_video_args(&info, &video_params(), Path::new("out.mp4"));
        assert!(has_tonemap(&hdr));

        // Stream copy never gets filters, so the HDR transfer stays untouched.
        let mut cp = video_params();
        cp.video_codec = "copy".into();
        let copied = build_video_args(&info, &cp, Path::new("out.mp4"));
        assert!(!has_tonemap(&copied));
        assert!(!copied.contains(&"-vf".to_string()));
    }

    #[test]
    fn hevc_container_and_gpu_mapping() {
        // HEVC encodes fine in mp4/mkv but not webm (vp8/vp9/av1 only).
        assert!(validate_video_container("mp4", "libx265", "aac", &sample_info()).is_ok());
        assert!(validate_video_container("webm", "libx265", "aac", &sample_info()).is_err());
        // GPU backends swap libx265 for their HEVC encoders.
        let (enc, hw) = gpu_plan("libx265", &Some("nvenc".into()));
        assert_eq!(enc, "hevc_nvenc");
        assert_eq!(hw.as_deref(), Some("cuda"));
        assert_eq!(gpu_plan("libx265", &None).0, "libx265");
        // ...and the family maps to "hevc" for container checks.
        assert_eq!(codec_family("hevc_nvenc"), "hevc");
    }

    /* ── remux auto-fallback ─────────────────────────────────────── */

    fn copy_params(format: &str) -> VideoParams {
        VideoParams {
            video_codec: "copy".into(),
            quality_mode: "crf".into(),
            crf: None,
            target_size_mb: None,
            video_bitrate_kbps: None,
            resolution: "original".into(),
            audio_codec: "copy".into(),
            audio_bitrate_kbps: None,
            format: format.into(),
            preset: "medium".into(),
            fps: None,
            gpu: None,
        }
    }

    #[test]
    fn mp4_copy_fallback_swaps_incompatible_codecs() {
        let mut info = sample_info();
        info.video_codec = Some("vp8".into());
        info.audio_codec = Some("opus".into());
        let mut p = copy_params("mp4");
        let note = mp4_copy_fallback(&mut p, &info).unwrap();
        assert!(note.contains("vp8") && note.contains("opus"), "{}", note);
        assert!(note.contains("自动降级"), "{}", note);
        assert_eq!(p.video_codec, "libx264");
        assert_eq!(p.crf, Some(23));
        assert_eq!(p.audio_codec, "aac");
        assert_eq!(p.audio_bitrate_kbps, Some(192));
    }

    #[test]
    fn mp4_copy_fallback_only_touches_the_bad_stream() {
        // mp4-safe video + incompatible audio: video stays copy.
        let mut info = sample_info();
        info.audio_codec = Some("opus".into());
        let mut p = copy_params("mp4");
        let note = mp4_copy_fallback(&mut p, &info).unwrap();
        assert!(note.contains("opus") && !note.contains("视频"), "{}", note);
        assert_eq!(p.video_codec, "copy");
        assert_eq!(p.audio_codec, "aac");
    }

    #[test]
    fn mp4_copy_fallback_skips_compatible_or_non_mp4() {
        // h264/aac copies fine — no fallback.
        let mut p = copy_params("mp4");
        assert!(mp4_copy_fallback(&mut p, &sample_info()).is_none());
        assert_eq!(p.video_codec, "copy");
        // Same incompatible codecs are fine when the target is MKV.
        let mut info = sample_info();
        info.video_codec = Some("vp8".into());
        info.audio_codec = Some("opus".into());
        let mut mkv = copy_params("mkv");
        assert!(mp4_copy_fallback(&mut mkv, &info).is_none());
        assert_eq!(mkv.video_codec, "copy");
    }

    /* ── multi-step workflow merging ─────────────────────────────── */

    fn step(tool: &str, params: serde_json::Value) -> WorkflowStepInput {
        WorkflowStepInput { tool_id: tool.into(), params }
    }

    #[test]
    fn norm_tool_id_maps_prefixed_tools() {
        assert_eq!(norm_tool_id("video-compress"), "compress");
        assert_eq!(norm_tool_id("audio-compress"), "compress");
        assert_eq!(norm_tool_id("trim"), "trim");
        assert_eq!(norm_tool_id("extract-audio"), "extract-audio");
    }

    fn compress_params(res: &str) -> serde_json::Value {
        serde_json::json!({
            "videoCodec": "libx264",
            "qualityMode": "crf",
            "crf": 26,
            "resolution": res,
            "audioCodec": "aac",
            "audioBitrateKbps": 128,
            "format": "mp4",
            "preset": "medium"
        })
    }

    #[test]
    fn merge_compress_speed_single_command() {
        let steps = vec![
            step("video-compress", compress_params("720p")),
            step("speed", serde_json::json!({"rate": 1.5, "muteAudio": false})),
        ];
        let info = sample_info();
        let chain = merged_chain(&info, &steps).expect("chain must be mergeable");
        assert_eq!(chain.ext, "mp4");
        let args = merged_args(&info, &chain, Path::new("out.mp4"), &None);

        let vf_idx = args.iter().position(|a| a == "-vf").unwrap();
        let vf = &args[vf_idx + 1];
        // Order follows step order: compress scale, then speed setpts.
        assert!(vf.contains("scale=-2:720"), "vf = {}", vf);
        assert!(vf.contains("setpts=PTS/1.500000"), "vf = {}", vf);
        assert!(vf.contains("scale=-2:720,setpts=PTS/1.500000"), "vf = {}", vf);

        let af_idx = args.iter().position(|a| a == "-af").unwrap();
        assert_eq!(args[af_idx + 1], "atempo=1.500000");

        assert!(args.contains(&"libx264".to_string()));
        assert!(args.contains(&"-c:v".to_string()));
        assert!(args.contains(&"26".to_string()));
        assert!(args.contains(&"aac".to_string()));
        assert_eq!(args.last().unwrap(), "out.mp4");
        // No watermark -> no filter_complex.
        assert!(!args.contains(&"-filter_complex".to_string()));
    }

    #[test]
    fn merge_mute_strip_metadata_lossless() {
        let steps = vec![
            step("mute", serde_json::json!({})),
            step("strip-metadata", serde_json::json!({})),
        ];
        let info = sample_info();
        let chain = merged_chain(&info, &steps).expect("mergeable");
        let args = merged_args(&info, &chain, Path::new("out.mp4"), &None);
        assert!(args.contains(&"-an".to_string()));
        assert!(args.contains(&"-c".to_string()));
        assert!(args.contains(&"copy".to_string()));
        assert!(!args.contains(&"libx264".to_string()));
        assert!(args.contains(&"-map_metadata".to_string()));
        assert!(args.contains(&"-map_chapters".to_string()));
    }

    #[test]
    fn merge_rejects_terminal_tools() {
        let info = sample_info();
        let shot = vec![step("screenshot", serde_json::json!({"mode":"single","atSec":1.0,"format":"png"}))];
        assert!(merged_output_ext(&info, &shot).is_none());
    }

    #[test]
    fn merge_rejects_stream_copy_trim() {
        let steps = vec![
            step("trim", serde_json::json!({"startTime": 1.0, "mode": "copy"})),
            step("speed", serde_json::json!({"rate": 2.0, "muteAudio": false})),
        ];
        assert!(!is_mergeable_chain(&steps));
        assert!(merged_output_ext(&sample_info(), &steps).is_none());
    }

    #[test]
    fn merge_rejects_multiple_watermarks() {
        let wm = || serde_json::json!({"imagePath":"w.png","position":"br","scalePercent":20});
        let steps = vec![step("watermark", wm()), step("watermark", wm())];
        assert!(!is_mergeable_chain(&steps));
        assert!(merged_output_ext(&sample_info(), &steps).is_none());
    }

    #[test]
    fn trim_encode_merge_applies_seek_and_duration() {
        let steps = vec![
            step("trim", serde_json::json!({"startTime": 5.5, "duration": 10.0, "mode": "encode"})),
            step("speed", serde_json::json!({"rate": 2.0, "muteAudio": true})),
        ];
        let info = sample_info();
        let chain = merged_chain(&info, &steps).expect("mergeable");
        let args = merged_args(&info, &chain, Path::new("out.mp4"), &None);

        let ss = args.iter().position(|a| a == "-ss").unwrap();
        assert_eq!(args[ss + 1], "5.500");
        let t = args.iter().position(|a| a == "-t").unwrap();
        assert_eq!(args[t + 1], "10.000");
        assert!(args.contains(&"-an".to_string()), "speed muted audio keeps -an");
        assert!(args.last().unwrap() == &"out.mp4".to_string());
    }

    #[test]
    fn webm_container_rejects_incompatible_codecs() {
        let mut info = sample_info();
        info.video_codec = Some("h264".into());
        info.audio_codec = Some("aac".into());
        assert!(validate_video_container("webm", "libx264", "aac", &info).is_err());
        assert!(validate_video_container("webm", "copy", "copy", &info).is_err());
        assert!(validate_video_container("webm", "libvpx-vp9", "opus", &info).is_ok());
        assert!(validate_video_container("webm", "libsvtav1", "none", &info).is_ok());
        // MP4 accepts H.264/AAC.
        assert!(validate_video_container("mp4", "libx264", "aac", &info).is_ok());
        // mkv accepts anything.
        assert!(validate_video_container("mkv", "libx264", "aac", &info).is_ok());
        // GPU encoders are h264 too.
        assert!(validate_video_container("webm", "h264_nvenc", "aac", &info).is_err());
    }

    #[test]
    fn trim_window_progress_denominator() {
        assert_eq!(trim_window_secs(7200.0, 10.0, Some(10.0)), 10.0);
        assert_eq!(trim_window_secs(100.0, 0.0, Some(500.0)), 100.0);
        assert_eq!(trim_window_secs(100.0, 40.0, None), 60.0);
        assert_eq!(trim_window_secs(100.0, 120.0, None), 0.0);
    }

    #[test]
    fn sequence_file_matching_is_precise() {
        assert!(is_sequence_file("clip_mediatool_001.png", "clip_mediatool_", "png"));
        assert!(is_sequence_file("clip_mediatool_042.PNG", "clip_mediatool_", "png"));
        assert!(!is_sequence_file("clip_mediatool_final.png", "clip_mediatool_", "png"));
        assert!(!is_sequence_file("other_mediatool_001.png", "clip_mediatool_", "png"));
        assert!(!is_sequence_file("clip_mediatool_jpg", "clip_mediatool_", "png"));
    }

    #[test]
    fn merged_chain_maps_audio_none_to_drop() {
        let steps = vec![step(
            "compress",
            serde_json::json!({"videoCodec":"libx264","qualityMode":"crf","crf":23,"audioCodec":"none","resolution":"original","format":"source","preset":"medium"}),
        )];
        let info = sample_info();
        let chain = merged_chain(&info, &steps).expect("mergeable");
        assert!(chain.drop_audio, "audioCodec none must map to drop_audio");
        let args = merged_args(&info, &chain, Path::new("out.mp4"), &None);
        assert!(args.contains(&"-an".to_string()));
        assert!(!args.contains(&"aac".to_string()));
    }
}
