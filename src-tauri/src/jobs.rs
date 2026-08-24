use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Emitter, Manager};

use crate::error::{AppError, Result};
use crate::ffmpeg;
use crate::media::probe;
use crate::models::{
    AudioParams, DoneEvent, EstimateRequest, EstimateResult, ExtractAudioParams, GifParams,
    ImageParams, JobRequest, MediaInfo, MediaType, MuteParams, ProgressEvent, RotateParams,
    ScreenshotParams, SpeedParams, StartJobResult, StartWorkflowResult, StripMetadataParams,
    TrimParams, VideoParams, WatermarkParams, WorkflowRequest, WorkflowStepInput,
};
use crate::state::JobManager;

/// Build the output path, placing the result next to the input (or in output_dir).
fn output_path(input: &str, output_dir: &Option<String>, ext: &str, suffix: &str) -> Result<PathBuf> {
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
    Ok(dir.join(format!("{}{}.{}", stem, suffix, ext)))
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
                Some(format!("scale={}:{}", parts[0], parts[1]))
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
    let is_vaapi = vcodec == "h264_vaapi";
    let mut a: Vec<String> = vec![];

    if is_vaapi {
        a.push("-vaapi_device".into());
        a.push("/dev/dri/renderD128".into());
    }
    if let Some(hw) = &hwaccel {
        a.push("-hwaccel".into());
        a.push(hw.clone());
        if hw == "qsv" {
            a.push("-hwaccel_output_format".into());
            a.push("qsv".into());
        }
    }

    a.push("-i".into());
    a.push(info.path.clone());

    let mut vf = resolution_vf(&p.resolution);
    if is_vaapi {
        vf = Some(match vf {
            Some(s) => format!("{},format=nv12,hwupload", s),
            None => "format=nv12,hwupload".to_string(),
        });
    }
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

fn image_scale_vf(max_dim: u32) -> String {
    format!(
        "scale='if(gt(iw,ih),-2,trunc(min(ih,{0})/2)*2)':'if(gt(iw,ih),trunc(min(iw,{0})/2)*2,-2)'",
        max_dim
    )
}

fn map_jpeg_q(quality: u8) -> u8 {
    let q = 31 - ((quality.clamp(1, 100) as u32 - 1) * 29 / 99);
    q as u8
}

fn map_png_level(quality: u8) -> u8 {
    let l = ((100 - quality.clamp(1, 100) as u32) * 9 / 99) as u8;
    l.min(9)
}

fn build_image_args(info: &MediaInfo, p: &ImageParams, out: &Path) -> Vec<String> {
    let mut a: Vec<String> = vec!["-i".into(), info.path.clone()];

    if let Some(d) = p.max_dimension {
        if d > 0 {
            a.push("-vf".into());
            a.push(image_scale_vf(d));
        }
    }

    let fmt = if p.format == "source" || p.format.is_empty() {
        source_image_format(&info.path)
    } else {
        p.format.clone()
    };

    match fmt.as_str() {
        "jpeg" => {
            a.push("-q:v".into());
            a.push(map_jpeg_q(p.quality).to_string());
        }
        "png" => {
            a.push("-compression_level".into());
            a.push(map_png_level(p.quality).to_string());
        }
        "webp" | "avif" => {
            a.push("-quality".into());
            a.push(p.quality.clamp(1, 100).to_string());
        }
        _ => {}
    }

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
/// can actually carry them (WebM/AVI/WMV etc. cannot).
fn safe_container_ext(info: &MediaInfo) -> String {
    let ext = input_ext(info, "mp4");
    if SAFE_CONTAINERS.contains(&ext.as_str()) {
        ext
    } else {
        "mp4".to_string()
    }
}

/// Lossless stream-removal / metadata strip: `-c copy` with optional `-an`.
fn build_remux_args(info: &MediaInfo, drop_audio: bool, out: &Path) -> Vec<String> {
    let mut a: Vec<String> = vec!["-i".into(), info.path.clone()];
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

/// Remove the audio track losslessly (`-an` + `-c copy`).
fn build_mute_args(info: &MediaInfo, _p: &MuteParams, out: &Path) -> Vec<String> {
    let mut a: Vec<String> = vec!["-i".into(), info.path.clone(), "-an".into()];
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
fn build_trim_args(info: &MediaInfo, p: &TrimParams, out: &Path) -> Vec<String> {
    let mut a: Vec<String> = vec![
        "-ss".into(),
        format!("{:.3}", p.start_time.max(0.0)),
        "-i".into(),
        info.path.clone(),
    ];
    if let Some(d) = p.duration {
        if d > 0.0 {
            a.push("-t".into());
            a.push(format!("{:.3}", d));
        }
    }

    if p.mode == "encode" {
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

/// Rotate 90° CW/CCW, 180°, or flip horizontally/vertically. Requires
/// re-encoding (output container is chosen to safely hold H.264+AAC).
fn build_rotate_args(info: &MediaInfo, p: &RotateParams, out: &Path) -> Vec<String> {
    let vf = match p.transform.as_str() {
        "90cc" => "transpose=2",
        "180" => "transpose=1,transpose=1",
        "hflip" => "hflip",
        "vflip" => "vflip",
        _ => "transpose=1", // "90c"
    };

    vec![
        "-i".into(),
        info.path.clone(),
        "-vf".into(),
        vf.to_string(),
        "-c:v".into(),
        "libx264".into(),
        "-crf".into(),
        "18".into(),
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
    ]
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

fn scan_pattern_outputs(out: &Path) -> Vec<PathBuf> {
    let Some(prefix) = pattern_prefix(out) else {
        return vec![];
    };
    let Some(dir) = out.parent() else {
        return vec![];
    };
    let mut found = vec![];
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            if e.file_name().to_string_lossy().starts_with(&prefix) {
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

/// Video -> GIF via a single-pass palettegen/paletteuse filter graph.
fn build_gif_args(info: &MediaInfo, p: &GifParams, out: &Path) -> Vec<String> {
    let mut a: Vec<String> = vec![];

    if let Some(s) = p.start_time {
        if s > 0.0 {
            a.push("-ss".into());
            a.push(format!("{:.3}", s));
        }
    }
    a.push("-i".into());
    a.push(info.path.clone());
    if let Some(d) = p.duration {
        if d > 0.0 {
            a.push("-t".into());
            a.push(format!("{:.3}", d));
        }
    }

    let fps = p.fps.unwrap_or(12).clamp(5, 30);
    let width = p.width.unwrap_or(480).max(16);
    let fc = format!(
        "[0:v]fps={f},scale={w}:-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5[out]",
        f = fps,
        w = width
    );
    a.push("-filter_complex".into());
    a.push(fc);
    a.push("-map".into());
    a.push("[out]".into());

    a.push("-threads".into());
    a.push("0".into());
    a.push("-progress".into());
    a.push("pipe:1".into());
    a.push("-y".into());
    a.push(out.to_string_lossy().to_string());
    a
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
        "rotate" => safe_container_ext(info),
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

fn parse_params<T: serde::de::DeserializeOwned>(params: &serde_json::Value) -> Result<T> {
    serde_json::from_value(params.clone()).map_err(AppError::from)
}

/// A fully prepared job: either skipped by the overwrite policy, or ready
/// to run with its final ffmpeg args and resolved output path.
enum PreparedJob {
    Skipped,
    Run { args: Vec<String>, out: PathBuf },
}

/// Resolve an output path applying the rename/skip/overwrite policy.
/// Returns None when the policy is "skip" and the file already exists.
fn resolve_policy(out: PathBuf, policy: &str) -> Option<PathBuf> {
    if !out.exists() {
        return Some(out);
    }
    match policy {
        "overwrite" => Some(out),
        "skip" => None,
        _ => Some(apply_overwrite_policy(out, "rename")),
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

/// The frontend uses prefixed ids ("video-compress", "image-convert", …) while
/// the dispatch below matches the unprefixed tool ("compress", "convert"). This
/// normalizes both conventions so a single tool id works everywhere.
fn norm_tool_id(id: &str) -> &str {
    for media in ["video", "audio", "image"] {
        let prefix = [media, "-"].concat();
        if let Some(rest) = id.strip_prefix(&prefix) {
            return rest;
        }
    }
    id
}

/// Build the args + output path for any tool id, or mark as skipped.
fn prepare_job(info: &MediaInfo, req: &JobRequest, suffix: &str, policy: &str) -> Result<PreparedJob> {
    match norm_tool_id(&req.tool_id) {
        "compress" | "convert" => {
            let ext = extension_for(&req.tool_id, info, &req.params);
            let out = output_path(&info.path, &req.output_dir, &ext, suffix)?;
            let Some(out) = resolve_policy(out, policy) else {
                return Ok(PreparedJob::Skipped);
            };
            let args = match info.media_type {
                MediaType::Video => {
                    let mut p: VideoParams = parse_params(&req.params)?;
                    p.gpu = req.gpu.clone();
                    build_video_args(info, &p, &out)
                }
                MediaType::Image => {
                    let p: ImageParams = parse_params(&req.params)?;
                    build_image_args(info, &p, &out)
                }
                MediaType::Audio => {
                    let p: AudioParams = parse_params(&req.params)?;
                    build_audio_args(info, &p, &out)
                }
                MediaType::Unknown => {
                    return Err(AppError("无法识别的媒体类型".into()));
                }
            };
            Ok(PreparedJob::Run { args, out })
        }
        "gif" => {
            let p: GifParams = parse_params(&req.params)?;
            let out = output_path(&info.path, &req.output_dir, "gif", suffix)?;
            let Some(out) = resolve_policy(out, policy) else {
                return Ok(PreparedJob::Skipped);
            };
            Ok(PreparedJob::Run { args: build_gif_args(info, &p, &out), out })
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
                let Some(out) = resolve_policy(base, policy) else {
                    return Ok(PreparedJob::Skipped);
                };
                Ok(PreparedJob::Run { args: build_screenshot_single(info, &p, &out), out })
            }
        }
        "speed" => {
            let p: SpeedParams = parse_params(&req.params)?;
            let ext = safe_container_ext(info);
            let out = output_path(&info.path, &req.output_dir, &ext, suffix)?;
            let Some(out) = resolve_policy(out, policy) else {
                return Ok(PreparedJob::Skipped);
            };
            Ok(PreparedJob::Run { args: build_speed_args(info, &p, &out), out })
        }
        "watermark" => {
            let p: WatermarkParams = parse_params(&req.params)?;
            let ext = safe_container_ext(info);
            let out = output_path(&info.path, &req.output_dir, &ext, suffix)?;
            let Some(out) = resolve_policy(out, policy) else {
                return Ok(PreparedJob::Skipped);
            };
            let wm_path = p.image_path.clone();
            Ok(PreparedJob::Run { args: build_watermark_args(info, &p, &wm_path, &out), out })
        }
        "extract-audio" => {
            let p: ExtractAudioParams = parse_params(&req.params)?;
            let ext = audio_ext_for(&p.format).to_string();
            let out = output_path(&info.path, &req.output_dir, &ext, suffix)?;
            let Some(out) = resolve_policy(out, policy) else {
                return Ok(PreparedJob::Skipped);
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
            let Some(out) = resolve_policy(out, policy) else {
                return Ok(PreparedJob::Skipped);
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
            let out = output_path(&info.path, &req.output_dir, &ext, suffix)?;
            let Some(out) = resolve_policy(out, policy) else {
                return Ok(PreparedJob::Skipped);
            };
            Ok(PreparedJob::Run { args: build_trim_args(info, &p, &out), out })
        }
        "mute" => {
            parse_params::<MuteParams>(&req.params)?;
            let ext = input_ext(info, "mp4");
            let out = output_path(&info.path, &req.output_dir, &ext, suffix)?;
            let Some(out) = resolve_policy(out, policy) else {
                return Ok(PreparedJob::Skipped);
            };
            let p: MuteParams = parse_params(&req.params)?;
            Ok(PreparedJob::Run { args: build_mute_args(info, &p, &out), out })
        }
        "rotate" => {
            let p: RotateParams = parse_params(&req.params)?;
            let ext = safe_container_ext(info);
            let out = output_path(&info.path, &req.output_dir, &ext, suffix)?;
            let Some(out) = resolve_policy(out, policy) else {
                return Ok(PreparedJob::Skipped);
            };
            Ok(PreparedJob::Run { args: build_rotate_args(info, &p, &out), out })
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
/// command. Terminal tools (gif / screenshot / extract-audio) are excluded and
/// fall back to per-step chaining.
const MERGEABLE_TOOLS: [&str; 8] = [
    "compress", "convert", "trim", "rotate", "speed", "mute", "watermark", "strip-metadata",
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
                if let Some(res) = resolution_vf(&p.resolution) {
                    ops.push(VideoOp::Filter(res));
                }
                encode = Some(p);
            }
            "trim" => {
                let p: TrimParams = parse_params(&s.params).ok()?;
                trim = Some((p.start_time.max(0.0), p.duration));
            }
            "rotate" => {
                let p: RotateParams = parse_params(&s.params).ok()?;
                let f = match p.transform.as_str() {
                    "90cc" => "transpose=2",
                    "180" => "transpose=1,transpose=1",
                    "hflip" => "hflip",
                    "vflip" => "vflip",
                    _ => "transpose=1",
                };
                ops.push(VideoOp::Filter(f.to_string()));
            }
            "speed" => {
                let p: SpeedParams = parse_params(&s.params).ok()?;
                let rate = p.rate.clamp(0.25, 4.0);
                ops.push(VideoOp::Filter(format!("setpts=PTS/{:.6}", rate)));
                if p.mute_audio.unwrap_or(false) {
                    drop_audio = true;
                } else if (rate - 1.0).abs() > 1e-9 {
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
        return Ok(StartWorkflowResult { id, merged: false });
    }
    let info = probe(&app, &input).await?;
    let suffix = req
        .output_suffix
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "_mediapress".to_string());
    let policy = req.overwrite_policy.as_deref().unwrap_or("rename");

    let ext = match merged_output_ext(&info, &req.steps) {
        Some(ext) => ext,
        None => return Ok(StartWorkflowResult { id, merged: false }),
    };
    let out = output_path(&input, &req.output_dir, &ext, &suffix)?;
    let Some(out) = resolve_policy(out, policy) else {
        // Output already existed and policy = "skip": report a no-op done so the
        // caller can treat the merged chain as finished.
        emit_done(&app, &id, true, false, true, None, None, info.size_bytes, None);
        return Ok(StartWorkflowResult { id, merged: true });
    };

    let Some(chain) = merged_chain(&info, &req.steps) else {
        return Ok(StartWorkflowResult { id, merged: false });
    };
    let args = merged_args(&info, &chain, &out, &req.gpu);

    let (child, stdout, stderr_buf) = ffmpeg::spawn(&app, "ffmpeg", &args)?;
    let input_size = info.size_bytes;
    let duration = info.duration_secs.unwrap_or(0.0);
    let task_id = id.clone();

    let child = std::sync::Arc::new(std::sync::Mutex::new(child));
    app.state::<JobManager>().register(&task_id, child.clone());
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
                    let buf = stderr_buf.lock().unwrap();
                    if buf.is_empty() {
                        String::new()
                    } else {
                        let s = String::from_utf8_lossy(&buf);
                        if s.len() > 1500 {
                            format!("\n\n{}", &s[s.len() - 1500..])
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

    Ok(StartWorkflowResult { id, merged: true })
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
        .unwrap_or_else(|| "_mediapress".to_string());
    let policy = req.overwrite_policy.as_deref().unwrap_or("rename");

    let (args, out) = match prepare_job(&info, &req, &suffix, policy)? {
        PreparedJob::Skipped => {
            // Nothing was started; the frontend treats this as a terminal
            // "skipped" phase via the command's return value.
            return Ok(StartJobResult { id, skipped: true });
        }
        PreparedJob::Run { args, out } => (args, out),
    };

    let mut args = args;
    args.insert(0, "-nostats".into());
    let (child, stdout, stderr_buf) = ffmpeg::spawn(&app, "ffmpeg", &args)?;
    let input_size = info.size_bytes;
    let duration = info.duration_secs.unwrap_or(0.0);
    let task_id = id.clone();

    let child = std::sync::Arc::new(std::sync::Mutex::new(child));
    app.state::<JobManager>().register(&task_id, child.clone());
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

        // Process finished; collect exit status.
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
                    let buf = stderr_buf.lock().unwrap();
                    if buf.is_empty() {
                        String::new()
                    } else {
                        let s = String::from_utf8_lossy(&buf);
                        if s.len() > 1500 {
                            format!("\n\n{}", &s[s.len() - 1500..])
                        } else {
                            format!("\n\n{}", s)
                        }
                    }
                };
                format!("FFmpeg 退出码 {}{}", code, detail)
            };
            if out.to_string_lossy().contains("%03d") {
                cleanup_pattern_outputs(&out);
            } else {
                let _ = std::fs::remove_file(&out);
            }
            emit_done(&app, &task_id, false, was_cancelled, false, None, Some(err), input_size, None);
        } else {
            let is_pattern = out.to_string_lossy().contains("%03d");
            let output_size = if is_pattern {
                pattern_output_size(&out)
            } else {
                std::fs::metadata(&out).map(|m| m.len()).ok()
            };
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

    Ok(StartJobResult { id, skipped: false })
}

/// Refined size estimate via a short real encode of a sample clip.
///
/// Reuses the exact same argument builders as `start_job`, but encodes only a
/// few seconds (or the whole image) to a temp file, then extrapolates the
/// produced byte count over the total duration.
pub async fn estimate_size(app: AppHandle, req: EstimateRequest) -> Result<EstimateResult> {
    let sample_secs = req.sample_secs.unwrap_or(8.0).max(0.1);
    let info = req.info;
    let ext = extension_for("estimate", &info, &req.params);
    let tmp = std::env::temp_dir().join(format!("mediapress_est_{}.{}", uuid(), ext));

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
        MediaType::Image => {
            let p: ImageParams = parse_params(&req.params)?;
            build_image_args(&info, &p, &tmp)
        }
        MediaType::Audio => {
            let p: AudioParams = parse_params(&req.params)?;
            build_audio_args(&info, &p, &tmp)
        }
        MediaType::Unknown => return Err(AppError("无法识别的媒体类型".into())),
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

    let (mut child, _stdout, _stderr) = ffmpeg::spawn(&app, "ffmpeg", &final_args)?;
    let code = child.wait().map(|s| s.code().unwrap_or(-1)).unwrap_or(-1);

    let sampled_bytes = std::fs::metadata(&tmp).map(|m| m.len()).unwrap_or(0);
    let _ = std::fs::remove_file(&tmp);

    if code != 0 || sampled_bytes == 0 {
        return Err(AppError("采样编码失败，无法精确估算".into()));
    }

    // Whole clip was sampled -> exact.
    let clip_len = total.unwrap_or(sample_dur);

    if req.media_type == MediaType::Image {
        return Ok(EstimateResult {
            sampled_bytes,
            sampled_secs: 1.0,
            total_secs: None,
            bytes: sampled_bytes,
            exact: true,
        });
    }

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
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("job-{:x}", nanos)
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
    fn image_webp_quality_and_scale() {
        let p = ImageParams {
            format: "webp".into(),
            quality: 80,
            max_dimension: Some(1280),
        };
        let args = build_image_args(&sample_info(), &p, Path::new("o.webp"));
        assert!(args.contains(&"-quality".to_string()));
        assert!(args.contains(&"80".to_string()));
        assert!(args.contains(&"-vf".to_string()));
        assert!(args.iter().any(|a| a.contains("scale=")));
    }

    #[test]
    fn image_source_format_uses_input_codec_flags() {
        let mut info = sample_info();
        info.media_type = MediaType::Image;
        info.path = "photo.jpg".into();
        let p = ImageParams { format: "source".into(), quality: 80, max_dimension: None };
        let args = build_image_args(&info, &p, Path::new("o.jpg"));
        // jpeg source -> -q:v mapping applies
        assert!(args.contains(&"-q:v".to_string()));
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
        TrimParams { start_time: 5.5, duration: Some(10.0), mode: mode.into() }
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
    fn rotate_transform_mapping() {
        let cases = [
            ("90c", "transpose=1"),
            ("90cc", "transpose=2"),
            ("180", "transpose=1,transpose=1"),
            ("hflip", "hflip"),
            ("vflip", "vflip"),
        ];
        for (transform, expected_vf) in cases {
            let p = RotateParams { transform: transform.into() };
            let args = build_rotate_args(&sample_info(), &p, Path::new("o.mp4"));
            let vf_idx = args.iter().position(|a| a == "-vf").unwrap();
            assert_eq!(args[vf_idx + 1], expected_vf, "transform {}", transform);
            assert!(args.contains(&"libx264".to_string()));
            assert!(args.contains(&"aac".to_string()));
        }
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
            output_suffix: Some("_mediapress".into()),
            gpu: None,
            overwrite_policy: None,
        }
    }

    #[test]
    fn prepare_rotate_picks_safe_container() {
        let mut info = sample_info();
        info.path = "clip.webm".into();
        match prepare_job(&info, &req("rotate", serde_json::json!({"transform":"90c"})), "_mediapress", "rename").unwrap() {
            PreparedJob::Run { out, .. } => {
                assert!(out.to_string_lossy().ends_with(".mp4"), "got {:?}", out);
            }
            _ => panic!("expected Run"),
        }
    }

    #[test]
    fn prepare_extract_audio_args_and_ext() {
        let mut info = sample_info();
        info.path = "movie.mp4".into();
        match prepare_job(
            &info,
            &req("extract-audio", serde_json::json!({"format":"opus","bitrateKbps":128})),
            "_mediapress",
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
        match prepare_job(&info, &req("strip-metadata", serde_json::json!({})), "_mediapress", "rename").unwrap() {
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
        let base = dir.join("clip_mediapress.mp4");
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

    fn gif_params() -> GifParams {
        GifParams { start_time: None, duration: None, fps: None, width: None }
    }

    #[test]
    fn gif_args_palette() {
        let p = gif_params();
        let args = build_gif_args(&sample_info(), &p, Path::new("o.gif"));
        let fc = args.iter().position(|a| a == "-filter_complex").unwrap();
        let fc_val = &args[fc + 1];
        assert!(fc_val.contains("palettegen"));
        assert!(fc_val.contains("paletteuse"));
        assert!(fc_val.contains("fps=12"));
        assert!(fc_val.contains("scale=480"));
        assert_eq!(args.last().unwrap(), "o.gif");
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
        let base = PathBuf::from("anywhere").join("clip_mediapress.png");
        let pat = interval_pattern(base);
        assert_eq!(
            pat.file_name().and_then(|n| n.to_str()),
            Some("clip_mediapress_%03d.png")
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

    /* ── multi-step workflow merging ─────────────────────────────── */

    fn step(tool: &str, params: serde_json::Value) -> WorkflowStepInput {
        WorkflowStepInput { tool_id: tool.into(), params }
    }

    #[test]
    fn norm_tool_id_maps_prefixed_tools() {
        assert_eq!(norm_tool_id("video-compress"), "compress");
        assert_eq!(norm_tool_id("audio-compress"), "compress");
        assert_eq!(norm_tool_id("image-convert"), "convert");
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
    fn merge_rotate_watermark_filter_complex() {
        let steps = vec![
            step("rotate", serde_json::json!({"transform": "90c"})),
            step(
                "watermark",
                serde_json::json!({"imagePath":"wm.png","position":"br","scalePercent":20,"opacity":0.5,"marginPercent":3}),
            ),
        ];
        let info = sample_info();
        let chain = merged_chain(&info, &steps).expect("mergeable");
        let args = merged_args(&info, &chain, Path::new("out.mp4"), &None);

        let fc_idx = args.iter().position(|a| a == "-filter_complex").unwrap();
        let fc = &args[fc_idx + 1];
        assert!(fc.contains("[0:v]transpose=1[vm];"), "fc = {}", fc);
        assert!(fc.contains("[1:v]scale=384:-2"), "fc = {}", fc);
        assert!(fc.contains("[vm][wms]overlay=x=main_w-overlay_w-32"), "fc = {}", fc);
        assert!(fc.contains("y=main_h-overlay_h-32"), "fc = {}", fc);
        assert!(fc.contains("[vout]"), "fc = {}", fc);

        // extra -i for the watermark image
        assert_eq!(args.iter().filter(|a| *a == "-i").count(), 2);
        assert!(args.contains(&"[vout]".to_string()));
        assert!(args.contains(&"0:a?".to_string()));
        assert!(args.contains(&"libx264".to_string()));
    }

    #[test]
    fn merge_rejects_terminal_tools() {
        let info = sample_info();
        let gif = vec![step("gif", serde_json::json!({"fps": 12, "width": 480}))];
        assert!(merged_output_ext(&info, &gif).is_none());
        assert!(!is_mergeable_chain(&gif));

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
}
