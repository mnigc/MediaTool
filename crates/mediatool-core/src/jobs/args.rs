//! Pure ffmpeg argument builders: every `build_*` function maps probed media
//! info plus tool params onto a `Vec<String>` command line without touching
//! the app environment. Also hosts the `%03d` sequence-pattern helpers for
//! interval screenshots and the rough-cut planners.
use std::path::{Path, PathBuf};

use crate::error::{AppError, Result};
use crate::models::{
    AudioChoice, AudioFormat, AudioParams, AudioVolumeParams, ContactMode, ContactSheetParams,
    CutMode, FrameSampleParams, ImageFormat, MediaInfo, MediaType, MuteParams, OutputFormat,
    QualityMode, RoughCutClip, RoughCutParams, ScreenshotParams, SpeedParams,
    SpeedPreset, StripMetadataParams, SubtitleParams, VideoCodec, VideoParams, VideoSilenceParams,
    VolumeMode, WatermarkPosition, WatermarkParams,
};
#[cfg(test)]
use crate::models::{RoughCutContainer, ScreenshotMode, TrimParams};

use super::prepare::{codec_family, PreparedJob, MP4_COPY_AUDIO, MP4_COPY_VIDEO};
use super::util::{
    atempo_chain, crf_to_bitrate, even, gpu_plan, hdr_tonemap_vf, input_ext, metadata_strip_args,
    uuid, vaapi_render_node, video_filter_chain, vp9_cpu_used, svt_preset,
};
use super::workflow::video_encoder_args;

pub(super) fn build_video_args(info: &MediaInfo, p: &VideoParams, out: &Path) -> Vec<String> {
    let (vcodec, hwaccel) = gpu_plan(&p.video_codec, p.gpu.as_ref());
    let is_vaapi = vcodec == "h264_vaapi" || vcodec == "hevc_vaapi";
    let mut a: Vec<String> = vec![];

    let vf = video_filter_chain(info, &vcodec, &p.resolution);
    if let Some(hw) = hwaccel {
        a.push("-hwaccel".into());
        a.push(hw.to_string());
        // A software `-vf` chain needs frames in system memory; locking QSV
        // frames in video memory makes the scale filter fail with
        // "Impossible to convert between the formats".
        if hw == "qsv" && vf.is_none() {
            a.push("-hwaccel_output_format".into());
            a.push("qsv".into());
        }
    }

    if is_vaapi {
        // Callers gate on ensure_vaapi_device; skip the flag here so the
        // builder stays infallible on hosts without a render node.
        if let Some(node) = vaapi_render_node() {
            a.push("-vaapi_device".into());
            a.push(node.into());
        }
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
            if matches!(p.quality_mode, QualityMode::Crf) {
                a.push("-crf".into());
                a.push(p.crf.unwrap_or(28).to_string());
            }
            a.push("-preset".into());
            a.push(p.preset.as_str().into());
        }
        "libx265" => {
            if matches!(p.quality_mode, QualityMode::Crf) {
                a.push("-crf".into());
                a.push(p.crf.unwrap_or(28).to_string());
            }
            a.push("-preset".into());
            a.push(p.preset.as_str().into());
        }
        "libvpx-vp9" => {
            if matches!(p.quality_mode, QualityMode::Crf) {
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
            if matches!(p.quality_mode, QualityMode::Crf) {
                a.push("-crf".into());
                a.push(p.crf.unwrap_or(32).to_string());
            } else if matches!(p.quality_mode, QualityMode::TargetSize) {
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
            if matches!(p.quality_mode, QualityMode::Crf) {
                a.push("-cq".into());
                a.push(p.crf.unwrap_or(28).to_string());
            }
            a.push("-preset".into());
            a.push("p4".into());
        }
        "h264_qsv" => {
            if matches!(p.quality_mode, QualityMode::Crf) {
                a.push("-q:v".into());
                a.push(p.crf.unwrap_or(28).to_string());
            }
        }
        "h264_videotoolbox" => {
            if matches!(p.quality_mode, QualityMode::Crf) {
                a.push("-b:v".into());
                a.push(format!("{}k", crf_to_bitrate(p.crf.unwrap_or(28))));
            }
        }
        "h264_amf" => {
            if matches!(p.quality_mode, QualityMode::Crf) {
                a.push("-rc".into());
                a.push("cqp".into());
                a.push("-qp".into());
                a.push(p.crf.unwrap_or(28).to_string());
            }
        }
        "h264_vaapi" => {
            if matches!(p.quality_mode, QualityMode::Crf) {
                a.push("-b:v".into());
                a.push(format!("{}k", crf_to_bitrate(p.crf.unwrap_or(28))));
            }
        }
        "hevc_nvenc" => {
            if matches!(p.quality_mode, QualityMode::Crf) {
                a.push("-cq".into());
                a.push(p.crf.unwrap_or(28).to_string());
            }
            a.push("-preset".into());
            a.push("p4".into());
        }
        "hevc_qsv" => {
            if matches!(p.quality_mode, QualityMode::Crf) {
                a.push("-q:v".into());
                a.push(p.crf.unwrap_or(28).to_string());
            }
        }
        "hevc_videotoolbox" => {
            if matches!(p.quality_mode, QualityMode::Crf) {
                a.push("-b:v".into());
                a.push(format!("{}k", crf_to_bitrate(p.crf.unwrap_or(28))));
            }
        }
        "hevc_amf" => {
            if matches!(p.quality_mode, QualityMode::Crf) {
                a.push("-rc".into());
                a.push("cqp".into());
                a.push("-qp".into());
                a.push(p.crf.unwrap_or(28).to_string());
            }
        }
        "hevc_vaapi" => {
            if matches!(p.quality_mode, QualityMode::Crf) {
                a.push("-b:v".into());
                a.push(format!("{}k", crf_to_bitrate(p.crf.unwrap_or(28))));
            }
        }
        _ => {}
    }

    match p.quality_mode {
        QualityMode::Bitrate => {
            if let Some(b) = p.video_bitrate_kbps {
                a.push("-b:v".into());
                a.push(format!("{}k", b));
            }
        }
        QualityMode::TargetSize => {
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
        // CRF was already handled per encoder above.
        QualityMode::Crf | QualityMode::Other(_) => {}
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

    match p.audio_codec {
        AudioChoice::None => a.push("-an".into()),
        AudioChoice::Copy => {
            a.push("-c:a".into());
            a.push("copy".into());
        }
        AudioChoice::Aac => {
            a.push("-c:a".into());
            a.push("aac".into());
            if let Some(b) = p.audio_bitrate_kbps {
                a.push("-b:a".into());
                a.push(format!("{}k", b));
            }
        }
        AudioChoice::Opus => {
            a.push("-c:a".into());
            a.push("libopus".into());
            if let Some(b) = p.audio_bitrate_kbps {
                a.push("-b:a".into());
                a.push(format!("{}k", b));
            }
        }
        // Unreachable after validation; historically an unrecognized codec
        // pushed no flag and ffmpeg picked its default.
        AudioChoice::Other(_) => {}
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

pub(super) fn build_audio_args(info: &MediaInfo, p: &AudioParams, out: &Path) -> Vec<String> {
    let mut a: Vec<String> = vec!["-i".into(), info.path.clone(), "-vn".into()];

    // "source" keeps the input codec family; the effective format (possibly a
    // container-ish one like "wav") is then resolved from the input extension.
    let fmt = match &p.format {
        AudioFormat::Source | AudioFormat::Other(_) => source_audio_format(&info.path),
        other => other.as_str().to_string(),
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
pub(super) fn source_audio_format(path: &str) -> String {
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
pub(super) fn safe_container_ext(info: &MediaInfo) -> String {
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
pub(super) fn build_strip_metadata_args(
    info: &MediaInfo,
    _p: &StripMetadataParams,
    out: &Path,
) -> Vec<String> {
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
pub(super) fn build_mute_args(info: &MediaInfo, _p: &MuteParams, out: &Path) -> Vec<String> {
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
pub(super) fn build_trim_segment_args(
    info: &MediaInfo,
    start: f64,
    duration: Option<f64>,
    mode: &CutMode,
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

    if *mode == CutMode::Encode {
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

pub(super) fn screenshot_ext(format: &ImageFormat) -> &'static str {
    match format {
        ImageFormat::Jpeg => "jpg",
        // PNG is also what unrecognized values always fell back to.
        ImageFormat::Png | ImageFormat::Other(_) => "png",
    }
}

/// Turn `<stem><suffix>.<ext>` into the `%03d` sequence pattern used by
/// interval screenshots.
pub(super) fn interval_pattern(base: PathBuf) -> PathBuf {
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
            e.eq_ignore_ascii_case(ext)
                && !num.is_empty()
                && num.chars().all(|c| c.is_ascii_digit())
        }
        None => false,
    }
}

pub(super) fn scan_pattern_outputs(out: &Path) -> Vec<PathBuf> {
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

pub(super) fn pattern_output_size(out: &Path) -> Option<u64> {
    Some(
        scan_pattern_outputs(out)
            .iter()
            .filter_map(|p| std::fs::metadata(p).ok())
            .map(|m| m.len())
            .sum(),
    )
}

pub(super) fn cleanup_pattern_outputs(out: &Path) {
    for p in scan_pattern_outputs(out) {
        let _ = std::fs::remove_file(p);
    }
}

pub(super) fn build_screenshot_single(info: &MediaInfo, p: &ScreenshotParams, out: &Path) -> Vec<String> {
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
    if p.format == ImageFormat::Jpeg {
        a.push("-q:v".into());
        a.push("2".into());
    }

    a.push("-progress".into());
    a.push("pipe:1".into());
    a.push("-y".into());
    a.push(out.to_string_lossy().to_string());
    a
}

pub(super) fn build_screenshot_interval(info: &MediaInfo, p: &ScreenshotParams, out: &Path) -> Vec<String> {
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

    if p.format == ImageFormat::Jpeg {
        a.push("-q:v".into());
        a.push("2".into());
    }

    a.push("-progress".into());
    a.push("pipe:1".into());
    a.push("-y".into());
    a.push(out.to_string_lossy().to_string());
    a
}

/// count mode: derive the interval from the duration so N frames land at the
/// midpoints of N equal segments spread evenly across the whole file.
pub(super) fn build_screenshot_count(info: &MediaInfo, p: &ScreenshotParams, out: &Path) -> Vec<String> {
    let total = info.duration_secs.unwrap_or(0.0);
    let n = p.count.unwrap_or(1).max(1) as f64;
    let every = if total > 0.0 {
        (total / n).clamp(0.1, 3600.0)
    } else {
        p.every_sec.unwrap_or(5.0).clamp(0.1, 3600.0)
    };
    let mut cp = p.clone();
    cp.every_sec = Some(every);
    cp.start_sec = Some(every / 2.0);
    cp.end_sec = None;
    build_screenshot_interval(info, &cp, out)
}

/// Playback speed change: setpts for video, chained atempo for audio.
/// Re-encodes explicitly (ffmpeg's default encoder would be mpeg4).
pub(super) fn build_speed_args(info: &MediaInfo, p: &SpeedParams, out: &Path) -> Vec<String> {
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
pub(super) fn build_watermark_args(
    info: &MediaInfo,
    p: &WatermarkParams,
    wm_path: &str,
    out: &Path,
) -> Vec<String> {
    let vw = info.width.unwrap_or(1280) as f64;
    let vh = info.height.unwrap_or(720) as f64;

    let scale_pct = p.scale_percent.clamp(1, 100) as f64 / 100.0;
    let tw = ((vw * scale_pct) as u32).max(16);
    let opacity = p.opacity.unwrap_or(1.0).clamp(0.0, 1.0) as f64;
    let margin_pct = p.margin_percent.unwrap_or(3).clamp(0, 30) as f64 / 100.0;
    let margin = ((vw.min(vh)) * margin_pct) as i64;

    let x = match p.position {
        WatermarkPosition::Tl | WatermarkPosition::Ml | WatermarkPosition::Bl => {
            format!("{}", margin)
        }
        WatermarkPosition::Tc | WatermarkPosition::Mc | WatermarkPosition::Bc => {
            "(main_w-overlay_w)/2".to_string()
        }
        WatermarkPosition::Tr | WatermarkPosition::Mr | WatermarkPosition::Br => {
            format!("main_w-overlay_w-{}", margin)
        }
        // Unreachable after validation; historically any unknown position
        // anchored bottom-right.
        WatermarkPosition::Other(_) => format!("main_w-overlay_w-{}", margin),
    };
    let y = match p.position {
        WatermarkPosition::Tl | WatermarkPosition::Tc | WatermarkPosition::Tr => {
            format!("{}", margin)
        }
        WatermarkPosition::Ml | WatermarkPosition::Mc | WatermarkPosition::Mr => {
            "(main_h-overlay_h)/2".to_string()
        }
        WatermarkPosition::Bl | WatermarkPosition::Bc | WatermarkPosition::Br => {
            format!("main_h-overlay_h-{}", margin)
        }
        WatermarkPosition::Other(_) => format!("main_h-overlay_h-{}", margin),
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

pub(super) fn build_video_subtitle_args(info: &MediaInfo, p: &SubtitleParams, out: &Path) -> Vec<String> {
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

/* ── Rough cut (粗剪): ordered clip list → one file ─────────────── */

/// Resolved cut window of one clip: [start, end) clamped to the probed source
/// duration. Errors when the duration is unknown and no end point was given.
pub(super) fn roughcut_window(clip: &RoughCutClip, info: &MediaInfo) -> Result<(f64, f64)> {
    let start = clip.start_time.max(0.0);
    let end = match (clip.end_time, info.duration_secs) {
        (Some(e), Some(t)) => e.min(t),
        (Some(e), None) => e,
        (None, Some(t)) => t,
        (None, None) => {
            return Err(AppError(format!(
                "无法确定素材时长，请为片段设置出点：{}",
                clip.path
            )))
        }
    };
    let end = end.max(start);
    if end - start < 0.01 {
        return Err(AppError(format!("片段的出点需大于入点（{}）", clip.path)));
    }
    Ok((start, end))
}

/// Lossless rough cut: stream-copy each cut to a scratch segment, then join
/// with the concat demuxer. Requires matching codec families + resolution
/// across clips (finer mismatches — fps, pixel format, profile — are the
/// frontend pre-check's job and degrade gracefully in players).
pub(super) fn prepare_roughcut_copy(
    clips: &[RoughCutClip],
    windows: &[(f64, f64)],
    infos: &[MediaInfo],
    container: &str,
    out: PathBuf,
) -> Result<PreparedJob> {
    let first = &infos[0];
    let vcodec = codec_family(first.video_codec.as_deref().unwrap_or(""));
    if vcodec.is_empty() {
        return Err(AppError("素材缺少视频轨，无法进行无损粗剪".into()));
    }
    let any_audio = infos.iter().any(|i| i.audio_codec.is_some());
    let all_audio = infos.iter().all(|i| i.audio_codec.is_some());
    if any_audio && !all_audio {
        return Err(AppError(
            "素材音轨不一致（部分有音轨、部分没有）：请改用「精确重编码」模式".into(),
        ));
    }
    for (idx, inf) in infos.iter().enumerate() {
        let fam = codec_family(inf.video_codec.as_deref().unwrap_or(""));
        if container == "mp4" {
            if !MP4_COPY_VIDEO.contains(&fam) {
                return Err(AppError(format!(
                    "片段 {} 的视频编码 {fam} 无法无损封装进 MP4：请改用 MKV 容器或「精确重编码」模式",
                    idx + 1
                )));
            }
            if let Some(a) = inf.audio_codec.as_deref() {
                let afam = codec_family(a);
                if !MP4_COPY_AUDIO.contains(&afam) {
                    return Err(AppError(format!(
                        "片段 {} 的音频编码 {afam} 无法无损封装进 MP4：请改用 MKV 容器或「精确重编码」模式",
                        idx + 1
                    )));
                }
            }
        }
        if fam != vcodec {
            return Err(AppError(format!(
                "片段 {} 的视频编码（{fam}）与片段 1（{vcodec}）不一致，无法无损拼接：请改用「精确重编码」模式",
                idx + 1
            )));
        }
        if (inf.width, inf.height) != (first.width, first.height) {
            return Err(AppError(format!(
                "片段 {} 的分辨率与片段 1 不一致（{}×{} ≠ {}×{}），无法无损拼接：请改用「精确重编码」模式",
                idx + 1,
                inf.width.unwrap_or(0),
                inf.height.unwrap_or(0),
                first.width.unwrap_or(0),
                first.height.unwrap_or(0),
            )));
        }
    }

    let token = uuid();
    let mut runs: Vec<(Vec<String>, PathBuf, f64)> = Vec::with_capacity(clips.len() + 1);
    let mut cleanup: Vec<PathBuf> = Vec::with_capacity(clips.len() + 2);
    let mut list = String::from("ffconcat version 1.0\n");
    for (i, (clip, (start, end))) in clips.iter().zip(windows).enumerate() {
        let part = std::env::temp_dir()
            .join(format!("mediatool_rc_{token}_part{}.{container}", i + 1));
        let dur = end - start;
        runs.push((
            build_roughcut_part_args(&clip.path, *start, dur, container, &part),
            part.clone(),
            dur,
        ));
        cleanup.push(part.clone());
        list.push_str(&format!(
            "file '{}'\n",
            concat_escape(&part.to_string_lossy())
        ));
    }
    let list_path = std::env::temp_dir().join(format!("mediatool_rc_{token}_list.txt"));
    std::fs::write(&list_path, list).map_err(|e| AppError(format!("写入拼接清单失败: {e}")))?;
    cleanup.push(list_path.clone());
    // The concat pass copies near-instantly; a zero duration keeps it from
    // inflating the progress denominator.
    let concat_args = build_roughcut_concat_args(&list_path, container, &out);
    runs.push((concat_args, out.clone(), 0.0));
    Ok(PreparedJob::RunMany {
        runs,
        cleanup,
        final_out: Some(out),
    })
}

/// Stream-copy one cut range into a scratch segment file.
fn build_roughcut_part_args(
    src: &str,
    start: f64,
    dur: f64,
    container: &str,
    out: &Path,
) -> Vec<String> {
    let mut a: Vec<String> = vec![
        "-ss".into(),
        format!("{:.3}", start.max(0.0)),
        "-i".into(),
        src.to_string(),
        "-t".into(),
        format!("{:.3}", dur),
        "-map".into(),
        "0".into(),
        "-c".into(),
        "copy".into(),
    ];
    if container == "mp4" {
        // Keyframe-snapped copy cuts can start with negative timestamps,
        // which breaks both the MP4 muxer and the concat demuxer.
        a.push("-avoid_negative_ts".into());
        a.push("make_zero".into());
    }
    a.push("-progress".into());
    a.push("pipe:1".into());
    a.push("-y".into());
    a.push(out.to_string_lossy().to_string());
    a
}

/// Join the scratch segments via the concat demuxer.
fn build_roughcut_concat_args(list: &Path, container: &str, out: &Path) -> Vec<String> {
    let mut a: Vec<String> = vec![
        "-f".into(),
        "concat".into(),
        "-safe".into(),
        "0".into(),
        "-i".into(),
        list.to_string_lossy().to_string(),
        "-c".into(),
        "copy".into(),
    ];
    if container == "mp4" {
        a.push("-movflags".into());
        a.push("+faststart".into());
    }
    a.push("-progress".into());
    a.push("pipe:1".into());
    a.push("-y".into());
    a.push(out.to_string_lossy().to_string());
    a
}

/// Escape a path for the concat demuxer's single-quoted file directive.
fn concat_escape(path: &str) -> String {
    path.replace('\'', "'\\''")
}

/// The ffmpeg output geometry every video branch is normalized to (the concat
/// filter requires identical sizes). Derived from the first clip's aspect and
/// the encode resolution; None when the sources have no probed dimensions.
fn roughcut_target_dims(first: &MediaInfo, resolution: &str) -> Option<(u32, u32)> {
    let (w0, h0) = match (first.width, first.height) {
        (Some(w), Some(h)) if w >= 2 && h >= 2 => (w as f64, h as f64),
        _ => return None,
    };
    let keep = (even(w0 as i64) as u32, even(h0 as i64) as u32);
    let fixed_h = |h: u32| -> (u32, u32) {
        let w = ((w0 * h as f64) / h0).round() as i64;
        (even(w.max(2)) as u32, h)
    };
    Some(match resolution {
        "original" | "" => keep,
        "480p" => fixed_h(480),
        "720p" => fixed_h(720),
        "1080p" => fixed_h(1080),
        "1440p" => fixed_h(1440),
        "2160p" => fixed_h(2160),
        custom if custom.contains('x') => custom
            .split_once('x')
            .and_then(|(w, h)| {
                let w = w.trim().parse::<i64>().ok()?;
                let h = h.trim().parse::<i64>().ok()?;
                if w >= 2 && h >= 2 {
                    Some((even(w) as u32, even(h) as u32))
                } else {
                    None
                }
            })
            .unwrap_or(keep),
        _ => keep,
    })
}

/// Every audio branch ends with this so the concat filter never sees mixed
/// sample rates / layouts across segments (44.1 kHz sources resampled, mono
/// up-mixed, silence sized to match).
const ROUGHCUT_AUDIO_TAIL: &str =
    ",aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo";

/// The assembled plan for a rough-cut re-encode: ffmpeg inputs plus the filter
/// graph that cuts, retimes and re-levels every clip, then concatenates.
pub(super) struct RoughCutPlan {
    /// Arguments up to and including every `-i input`.
    input_args: Vec<String>,
    filter_complex: String,
    /// False when audio is dropped entirely (audioCodec "none" or no audible
    /// clip) — the concat then runs v-only and the output gets `-an`.
    with_audio: bool,
    /// True when the video branches end with `format=nv12,hwupload` (VAAPI
    /// encode), in which case `-pix_fmt` must stay off.
    vaapi: bool,
}

/// Pure planner for the encode mode — testable without an app environment.
pub(super) fn plan_roughcut_encode(
    first: &MediaInfo,
    clips: &[RoughCutClip],
    windows: &[(f64, f64)],
    infos: &[MediaInfo],
    p: &RoughCutParams,
) -> Result<RoughCutPlan> {
    let ep = p.encode.clone().unwrap_or_else(default_roughcut_encode);
    let want_audio = !matches!(ep.audio_codec, AudioChoice::None)
        && clips
            .iter()
            .zip(infos.iter())
            .any(|(c, i)| !c.mute && i.audio_codec.is_some());
    let target = roughcut_target_dims(first, &ep.resolution);
    // Every branch is resampled to the first clip's frame rate: the concat
    // filter tolerates mixed rates but the muxer then carries variable-frame
    // timestamps, which players and editors handle badly.
    let target_fps = first.fps;
    let vaapi = gpu_plan(&ep.video_codec, ep.gpu.as_ref()).0.ends_with("_vaapi");

    let mut input_args: Vec<String> = Vec::new();
    if vaapi {
        // Same guard as build_video_args: the caller (prepare_job) has
        // already validated the render node via ensure_vaapi_device.
        if let Some(node) = vaapi_render_node() {
            input_args.push("-vaapi_device".into());
            input_args.push(node.into());
        }
    }
    let mut fc = String::new();
    let mut input_idx = 0usize;
    // concat's input pads are segment-interleaved: [v0][a0][v1][a1]… (audio
    // pads omitted when the whole export is silent).
    let mut seg_labels: Vec<String> = Vec::with_capacity(clips.len());

    for (i, ((clip, inf), (start, end))) in clips.iter().zip(infos.iter()).zip(windows).enumerate()
    {
        let dur = end - start;
        let speed = clip.speed.clamp(0.25, 4.0);
        // Input seek lands on a keyframe at/before the cut; the trim filter
        // below makes the cut frame-exact from there.
        input_args.push("-ss".into());
        input_args.push(format!("{:.3}", start.max(0.0)));
        input_args.push("-i".into());
        input_args.push(clip.path.clone());
        let vi = input_idx;
        input_idx += 1;

        // Video: exact cut, retime, then normalize geometry so concat never
        // sees mismatched sizes or sample aspects.
        let pts = if (speed - 1.0).abs() > 1e-9 {
            format!("setpts=(PTS-STARTPTS)/{speed:.6}")
        } else {
            "setpts=PTS-STARTPTS".to_string()
        };
        fc.push_str(&format!("[{vi}:v]trim=duration={dur:.3},{pts}"));
        // Tone-mapped per clip, not from the first one: an SDR clip in an HDR
        // timeline must not be flattened, and vice versa.
        if inf.hdr {
            fc.push(',');
            fc.push_str(hdr_tonemap_vf());
        }
        if let Some(f) = target_fps {
            fc.push_str(&format!(",fps={f:.4}"));
        }
        if let Some((w, h)) = target {
            fc.push_str(&format!(",scale={w}:{h}"));
        }
        fc.push_str(",setsar=1");
        if vaapi {
            fc.push_str(",format=nv12,hwupload");
        }
        fc.push_str(&format!("[v{i}];"));

        // Audio: audible clips get cut / retimed / leveled; muted or
        // audio-less clips splice in sized silence so concat stays uniform.
        if want_audio {
            if inf.audio_codec.is_some() && !clip.mute {
                fc.push_str(&format!(
                    "[{vi}:a]atrim=duration={dur:.3},asetpts=PTS-STARTPTS"
                ));
                for f in atempo_chain(speed) {
                    fc.push_str(&format!(",atempo={f}"));
                }
                let vol = clip.volume.clamp(0.0, 4.0);
                if (vol - 1.0).abs() > 1e-9 {
                    fc.push_str(&format!(",volume={vol:.3}"));
                }
                fc.push_str(ROUGHCUT_AUDIO_TAIL);
            } else {
                input_args.push("-f".into());
                input_args.push("lavfi".into());
                input_args.push("-t".into());
                input_args.push(format!("{:.3}", dur / speed));
                input_args.push("-i".into());
                input_args.push("anullsrc=channel_layout=stereo:sample_rate=48000".into());
                let si = input_idx;
                input_idx += 1;
                // anullsrc already runs at the target rate/layout; only the
                // sample format needs pinning (no leading comma — the label
                // is directly followed by the filter).
                fc.push_str(&format!(
                    "[{si}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo"
                ));
            }
            fc.push_str(&format!("[a{i}];"));
            seg_labels.push(format!("[v{i}][a{i}]"));
        } else {
            seg_labels.push(format!("[v{i}]"));
        }
    }

    let n = clips.len();
    let with_audio = want_audio; // every clip then yields exactly one audio label
    fc.push_str(&seg_labels.concat());
    if with_audio {
        fc.push_str(&format!("concat=n={n}:v=1:a=1[vout][aout]"));
    } else {
        fc.push_str(&format!("concat=n={n}:v=1:a=0[vout]"));
    }

    Ok(RoughCutPlan {
        input_args,
        filter_complex: fc,
        with_audio,
        vaapi,
    })
}

/// Defaults when the frontend sends no encode recipe for precise mode.
fn default_roughcut_encode() -> VideoParams {
    VideoParams {
        video_codec: VideoCodec::LibX264,
        quality_mode: QualityMode::Crf,
        crf: Some(20),
        target_size_mb: None,
        video_bitrate_kbps: None,
        resolution: "original".into(),
        audio_codec: AudioChoice::Aac,
        audio_bitrate_kbps: Some(192),
        format: OutputFormat::Mp4,
        preset: SpeedPreset::Medium,
        fps: None,
        gpu: None,
    }
}

/// Full argument list for a rough-cut encode pass.
pub(super) fn roughcut_encode_args(
    plan: &RoughCutPlan,
    info: &MediaInfo,
    p: &RoughCutParams,
    container: &str,
    out: &Path,
) -> Vec<String> {
    let ep = p.encode.clone().unwrap_or_else(default_roughcut_encode);
    let mut a = plan.input_args.clone();
    a.push("-filter_complex".into());
    a.push(plan.filter_complex.clone());
    a.push("-map".into());
    a.push("[vout]".into());
    if plan.with_audio {
        a.push("-map".into());
        a.push("[aout]".into());
        match ep.audio_codec {
            AudioChoice::Opus => {
                a.push("-c:a".into());
                a.push("libopus".into());
                a.push("-b:a".into());
                a.push(format!("{}k", ep.audio_bitrate_kbps.unwrap_or(192)));
            }
            // Historical default: everything but Opus encoded to AAC.
            AudioChoice::Aac
            | AudioChoice::Copy
            | AudioChoice::None
            | AudioChoice::Other(_) => {
                a.push("-c:a".into());
                a.push("aac".into());
                a.push("-b:a".into());
                a.push(format!("{}k", ep.audio_bitrate_kbps.unwrap_or(192)));
            }
        }
    } else {
        a.push("-an".into());
    }
    a.extend(video_encoder_args(info, &ep));
    if !plan.vaapi {
        a.push("-pix_fmt".into());
        a.push("yuv420p".into());
    }
    if container == "mp4" {
        a.push("-movflags".into());
        a.push("+faststart".into());
    }
    a.push("-threads".into());
    a.push("0".into());
    a.push("-progress".into());
    a.push("pipe:1".into());
    a.push("-y".into());
    a.push(out.to_string_lossy().to_string());
    a
}

pub(super) fn build_audio_volume_args(info: &MediaInfo, p: &AudioVolumeParams, out: &Path) -> Vec<String> {
    let af = match p.mode {
        VolumeMode::Normalize => "loudnorm".to_string(),
        // Gain is also what unrecognized values always fell back to.
        VolumeMode::Gain | VolumeMode::Other(_) => {
            let db = p.gain.unwrap_or(0.0).clamp(-20.0, 20.0);
            format!("volume=volume={:.1}dB", db)
        }
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
pub(super) fn build_audio_merge_args(inputs: &[String], out: &Path) -> Vec<String> {
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

pub(super) fn build_video_frames_args(info: &MediaInfo, p: &FrameSampleParams, out: &Path) -> Vec<String> {
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

pub(super) fn build_video_contact_args(info: &MediaInfo, p: &ContactSheetParams, out: &Path) -> Vec<String> {
    let thumb_w = p.thumb_w.max(32);
    // In "count" mode spread the requested number of thumbnails evenly across
    // the whole video; an explicit `countCols` fixes the grid width (the wide,
    // short layout player hover-previews expect), otherwise auto-fit a
    // near-square grid. Interval mode honors the user's sampling rate and
    // explicit columns/rows.
    let (cols, rows) = if p.mode == ContactMode::Count {
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
    let fps_expr = if p.mode == ContactMode::Count {
        let dur = info.duration_secs.unwrap_or(0.0).max(0.1);
        let n = p.count.max(1) as f64;
        format!("1/{:.4}", dur / n)
    } else {
        format!("1/{:.3}", p.interval.max(0.1))
    };
    let mut a: Vec<String> = vec!["-i".into(), info.path.clone()];
    a.push("-vf".into());
    a.push(format!(
        "fps={},scale={}:-2,tile={}x{}",
        fps_expr, thumb_w, cols, rows
    ));
    a.push("-frames:v".into());
    a.push("1".into());
    a.push("-progress".into());
    a.push("pipe:1".into());
    a.push("-y".into());
    a.push(out.to_string_lossy().to_string());
    a
}

pub(super) fn build_video_silence_args(info: &MediaInfo, p: &VideoSilenceParams, _out: &Path) -> Vec<String> {
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

pub(super) fn audio_ext_for(codec: &AudioFormat) -> &'static str {
    match codec {
        AudioFormat::Aac | AudioFormat::M4a => "m4a",
        AudioFormat::Opus => "opus",
        AudioFormat::Flac => "flac",
        // Historical default (also covers "source", which extract-audio
        // never offered): MP3 is the safe common denominator.
        AudioFormat::Source | AudioFormat::Mp3 | AudioFormat::Other(_) => "mp3",
    }
}

/// Resolve the output file extension based on the tool and its params.
/// Tools that preserve the input streams keep the input container; compress /
/// convert honor a chosen format with "source" meaning keep-input.
///
/// Reads `format` straight from the raw params JSON so it can run before the
/// typed parse; unrecognized values pass through as their literal string and
/// are rejected by the params validation right after.
pub(super) fn extension_for(tool_id: &str, info: &MediaInfo, params: &serde_json::Value) -> String {
    let fmt = |default: &str| -> String {
        let f = params
            .get("format")
            .and_then(|f| f.as_str())
            .map_or_else(
                || OutputFormat::from_wire(default.to_string()),
                |s| OutputFormat::from_wire(s.to_string()),
            );
        match f {
            OutputFormat::Source => String::new(),
            other => other.as_str().to_string(),
        }
    };

    match tool_id {
        "extract-audio" => audio_ext_for(
            &params
                .get("format")
                .and_then(|f| f.as_str())
                .map(str::to_string)
                .map(AudioFormat::from_wire)
                .unwrap_or(AudioFormat::Mp3),
        )
        .to_string(),
        "trim" | "mute" | "strip-metadata" => input_ext(info, "mp4"),
        "video-subtitle" => safe_container_ext(info),
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


#[cfg(test)]
mod tests {
    use super::*;
    use crate::jobs::test_support::sample_info;

    fn video_params() -> VideoParams {
        VideoParams {
            video_codec: VideoCodec::LibX264,
            quality_mode: QualityMode::Crf,
            crf: Some(26),
            target_size_mb: None,
            video_bitrate_kbps: None,
            resolution: "720p".into(),
            audio_codec: AudioChoice::Aac,
            audio_bitrate_kbps: Some(128),
            format: OutputFormat::Mp4,
            preset: SpeedPreset::Medium,
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
        p.quality_mode = QualityMode::TargetSize;
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
        p.video_codec = VideoCodec::LibVpxVp9;
        p.format = OutputFormat::Webm;
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
        let p = AudioParams {
            format: AudioFormat::Source,
            bitrate_kbps: 192,
        };
        let args = build_audio_args(&info, &p, Path::new("o.mp3"));
        assert!(args.contains(&"libmp3lame".to_string()));
        assert!(args.contains(&"192k".to_string()));

        info.path = "song.flac".into();
        let args = build_audio_args(&info, &p, Path::new("o.flac"));
        assert!(args.contains(&"flac".to_string()));
        assert!(
            !args.contains(&"-b:a".to_string()),
            "flac is lossless, no bitrate flag"
        );
    }

    #[test]
    fn audio_mp3_bitrate() {
        let p = AudioParams {
            format: AudioFormat::Mp3,
            bitrate_kbps: 192,
        };
        let args = build_audio_args(&sample_info(), &p, Path::new("o.mp3"));
        assert!(args.contains(&"-vn".to_string()));
        assert!(args.contains(&"libmp3lame".to_string()));
        assert!(args.contains(&"-b:a".to_string()));
        assert!(args.contains(&"192k".to_string()));
    }

    #[test]
    fn av1_crf_and_preset() {
        let mut p = video_params();
        p.video_codec = VideoCodec::LibSvtAv1;
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
        p.video_codec = VideoCodec::LibSvtAv1;
        p.quality_mode = QualityMode::Bitrate;
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

        p.video_codec = VideoCodec::Copy;
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
        let args = build_strip_metadata_args(&info, &StripMetadataParams {}, Path::new("o.jpg"));
        assert!(args.contains(&"-q:v".to_string()));
        assert!(args.contains(&"2".to_string()));
        // Image path re-encodes, but container-level metadata is still
        // dropped explicitly via -map_metadata -1 (EXIF/GPS must not survive
        // the re-encode).
        assert!(args.contains(&"-map_metadata".to_string()));
    }

    #[test]
    fn mute_args_lossless() {
        let args = build_mute_args(&sample_info(), &MuteParams {}, Path::new("o.mp4"));
        assert!(args.contains(&"-an".to_string()));
        assert!(args.contains(&"-c".to_string()));
        assert!(args.contains(&"copy".to_string()));
        assert!(!args.contains(&"libx264".to_string()));
    }

    fn trim_params(mode: CutMode) -> TrimParams {
        TrimParams {
            start_time: 5.5,
            duration: Some(10.0),
            mode,
            segments: vec![],
        }
    }

    #[test]
    fn trim_copy_args() {
        let args = build_trim_args(&sample_info(), &trim_params(CutMode::Copy), Path::new("o.mp4"));
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
        let args = build_trim_args(&sample_info(), &trim_params(CutMode::Encode), Path::new("o.mp4"));
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
            extension_for(
                "extract-audio",
                &info,
                &serde_json::json!({"format": "aac"})
            ),
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

    fn shot_params(mode: ScreenshotMode) -> ScreenshotParams {
        ScreenshotParams {
            mode,
            at_sec: Some(3.5),
            every_sec: Some(5.0),
            count: Some(4),
            start_sec: Some(2.0),
            end_sec: Some(30.0),
            format: ImageFormat::Png,
            max_width: Some(1280),
        }
    }

    #[test]
    fn screenshot_single_and_interval() {
        let sp = shot_params(ScreenshotMode::Single);
        let args = build_screenshot_single(&sample_info(), &sp, Path::new("o.png"));
        let ss = args.iter().position(|a| a == "-ss").unwrap();
        assert_eq!(args[ss + 1], "3.500");
        assert!(args.contains(&"-frames:v".to_string()));
        assert!(args.contains(&"scale=1280:-2".to_string()));

        let ip = shot_params(ScreenshotMode::Interval);
        let args = build_screenshot_interval(&sample_info(), &ip, Path::new("o_%03d.png"));
        assert!(args.iter().any(|a| a.contains("fps=1/5.000")));
        let t = args.iter().position(|a| a == "-t").unwrap();
        assert_eq!(args[t + 1], "28.000");
        assert_eq!(args.last().unwrap(), "o_%03d.png");
    }

    #[test]
    fn screenshot_count_spreads_frames_evenly() {
        // 10s video, 4 frames → every 2.5s, first frame at the 1.25s midpoint
        let cp = shot_params(ScreenshotMode::Count);
        let args = build_screenshot_count(&sample_info(), &cp, Path::new("o_%03d.png"));
        assert!(args.iter().any(|a| a.contains("fps=1/2.500")));
        let ss = args.iter().position(|a| a == "-ss").unwrap();
        assert_eq!(args[ss + 1], "1.250");
        assert!(!args.iter().any(|a| a == "-t"));
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

    fn speed_params(rate: f64, mute: bool) -> SpeedParams {
        SpeedParams {
            rate,
            mute_audio: Some(mute),
        }
    }

    #[test]
    fn speed_video_args() {
        let p = speed_params(4.0, false);
        let args = build_speed_args(&sample_info(), &p, Path::new("o.mp4"));
        assert!(args.contains(&"setpts=PTS/4.000000".to_string()));
        assert!(args
            .iter()
            .any(|a| a.contains("atempo=2.000000,atempo=2.000000")));
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

    fn wm_params(pos: WatermarkPosition, opacity: Option<f32>) -> WatermarkParams {
        WatermarkParams {
            image_path: "wm.png".into(),
            position: pos,
            scale_percent: 20,
            opacity,
            margin_percent: Some(3),
        }
    }

    #[test]
    fn watermark_args_geometry() {
        let p = wm_params(WatermarkPosition::Br, Some(0.5));
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
        let p = wm_params(WatermarkPosition::Tl, None);
        let args = build_watermark_args(&sample_info(), &p, "wm.png", Path::new("o.mp4"));
        let fc_idx = args.iter().position(|a| a == "-filter_complex").unwrap();
        let fc_val = &args[fc_idx + 1];
        assert!(!fc_val.contains("colorchannelmixer"));
        assert!(fc_val.contains("x=32:y=32"));
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
        cp.video_codec = VideoCodec::Copy;
        let copied = build_video_args(&info, &cp, Path::new("out.mp4"));
        assert!(!has_tonemap(&copied));
        assert!(!copied.contains(&"-vf".to_string()));
    }

    #[test]
    fn sequence_file_matching_is_precise() {
        assert!(is_sequence_file(
            "clip_mediatool_001.png",
            "clip_mediatool_",
            "png"
        ));
        assert!(is_sequence_file(
            "clip_mediatool_042.PNG",
            "clip_mediatool_",
            "png"
        ));
        assert!(!is_sequence_file(
            "clip_mediatool_final.png",
            "clip_mediatool_",
            "png"
        ));
        assert!(!is_sequence_file(
            "other_mediatool_001.png",
            "clip_mediatool_",
            "png"
        ));
        assert!(!is_sequence_file(
            "clip_mediatool_jpg",
            "clip_mediatool_",
            "png"
        ));
    }

    /* ── rough cut ────────────────────────────────────────────────── */

    fn rc_clip(path: &str, start: f64, end: Option<f64>) -> RoughCutClip {
        RoughCutClip {
            path: path.into(),
            start_time: start,
            end_time: end,
            mute: false,
            volume: 1.0,
            speed: 1.0,
        }
    }

    fn rc_params(clips: Vec<RoughCutClip>) -> RoughCutParams {
        RoughCutParams {
            mode: CutMode::Encode,
            clips,
            container: RoughCutContainer::Mp4,
            encode: None,
        }
    }

    #[test]
    fn roughcut_window_clamps_to_duration() {
        let info = sample_info(); // 10 s
        let (s, e) = roughcut_window(&rc_clip("a.mp4", 2.0, Some(20.0)), &info).unwrap();
        assert_eq!((s, e), (2.0, 10.0));
        let (s, e) = roughcut_window(&rc_clip("a.mp4", -3.0, None), &info).unwrap();
        assert_eq!((s, e), (0.0, 10.0));
        let mut unknown = sample_info();
        unknown.duration_secs = None;
        assert!(roughcut_window(&rc_clip("a.mp4", 0.0, None), &unknown).is_err());
        // Empty window: end == start.
        assert!(roughcut_window(&rc_clip("a.mp4", 5.0, Some(5.0)), &info).is_err());
    }

    #[test]
    fn roughcut_part_and_concat_args() {
        let part = build_roughcut_part_args("in.mp4", 4.0, 6.0, "mp4", Path::new("p1.mp4"));
        let ss = part.iter().position(|a| a == "-ss").unwrap();
        assert_eq!(part[ss + 1], "4.000");
        let i = part.iter().position(|a| a == "-i").unwrap();
        assert!(ss < i, "-ss must precede -i for fast seek");
        assert!(part.contains(&"-c".to_string()) && part.contains(&"copy".to_string()));
        assert!(part.contains(&"-avoid_negative_ts".to_string()));

        let mkv = build_roughcut_part_args("in.mkv", 0.0, 1.0, "mkv", Path::new("p.mkv"));
        assert!(!mkv.contains(&"-avoid_negative_ts".to_string()));

        let mp4 = build_roughcut_concat_args(Path::new("l.txt"), "mp4", Path::new("o.mp4"));
        assert!(mp4.contains(&"-f".to_string()) && mp4.contains(&"concat".to_string()));
        assert!(mp4.contains(&"-safe".to_string()) && mp4.contains(&"0".to_string()));
        assert!(mp4.contains(&"-movflags".to_string()));
        let mkv = build_roughcut_concat_args(Path::new("l.txt"), "mkv", Path::new("o.mkv"));
        assert!(!mkv.contains(&"-movflags".to_string()));

        assert_eq!(concat_escape("a'b.mp4"), "a'\\''b.mp4");
    }

    #[test]
    fn roughcut_target_dims_match_aspect() {
        let info = sample_info(); // 1920x1080
        assert_eq!(roughcut_target_dims(&info, "original"), Some((1920, 1080)));
        assert_eq!(roughcut_target_dims(&info, "720p"), Some((1280, 720)));
        assert_eq!(roughcut_target_dims(&info, "1080x100"), Some((1080, 100)));
        let mut odd = sample_info();
        odd.width = Some(1921);
        odd.height = Some(1079);
        let (w, h) = roughcut_target_dims(&odd, "original").unwrap();
        assert_eq!(w % 2, 0);
        assert_eq!(h % 2, 0);
        // Unknown dimensions disable geometry normalization.
        let mut blind = sample_info();
        blind.width = None;
        blind.height = None;
        assert_eq!(roughcut_target_dims(&blind, "720p"), None);
    }

    #[test]
    fn roughcut_encode_plan_audio_and_speed() {
        let info = sample_info();
        let mut muted = rc_clip("b.mp4", 1.0, Some(3.0));
        muted.mute = true;
        let mut fast = rc_clip("a.mp4", 2.0, Some(4.0));
        fast.speed = 2.0;
        fast.volume = 1.5;
        let clips = vec![rc_clip("a.mp4", 0.0, Some(4.0)), muted, fast];
        let windows = vec![(0.0, 4.0), (1.0, 3.0), (2.0, 4.0)];
        let p = rc_params(clips);
        let plan = plan_roughcut_encode(
            &info,
            &p.clips,
            &windows,
            &[info.clone(), info.clone(), info.clone()],
            &p,
        )
        .unwrap();
        assert!(plan.with_audio);
        // The muted middle clip splices in sized silence…
        assert!(plan
            .input_args
            .iter()
            .any(|a| a.contains("anullsrc=channel_layout=stereo:sample_rate=48000")));
        // …the 2x clip retimes video and audio…
        assert!(plan.filter_complex.contains("setpts=(PTS-STARTPTS)/2.000000"));
        assert!(plan.filter_complex.contains("atempo=2.000000"));
        assert!(plan.filter_complex.contains("volume=1.500"));
        // …and concat joins v+a across all three segments, pads interleaved
        // per segment (concat's input order).
        assert!(
            plan.filter_complex
                .contains("[v0][a0][v1][a1][v2][a2]concat=n=3:v=1:a=1[vout][aout]"),
            "fc = {}",
            plan.filter_complex
        );
        assert!(plan.filter_complex.contains("sample_rates=48000"));
        assert!(
            !plan.filter_complex.contains(":a],"),
            "no empty filter after a stream label: {}",
            plan.filter_complex
        );
    }

    #[test]
    fn roughcut_encode_normalizes_fps_and_hdr_per_clip() {
        let info = sample_info(); // 25 fps, SDR
        let mut hdr_info = sample_info();
        hdr_info.hdr = true;
        let p = rc_params(vec![
            rc_clip("a.mp4", 0.0, Some(4.0)),
            rc_clip("h.mp4", 0.0, Some(4.0)),
        ]);
        let windows = vec![(0.0, 4.0), (0.0, 4.0)];
        let plan = plan_roughcut_encode(
            &info,
            &p.clips,
            &windows,
            &[sample_info(), hdr_info],
            &p,
        )
        .unwrap();
        // Every branch lands on the first clip's frame rate…
        assert_eq!(plan.filter_complex.matches(",fps=25.0000").count(), 2);
        // …and only the HDR branch tone-maps, with the rate applied after it.
        assert_eq!(plan.filter_complex.matches("tonemap=hable").count(), 1);
        assert!(plan
            .filter_complex
            .contains("format=yuv420p,fps=25.0000"));

        // A source with no measurable rate leaves the filter out entirely.
        let mut blind = sample_info();
        blind.fps = None;
        let plan = plan_roughcut_encode(
            &blind,
            &p.clips,
            &windows,
            &[blind.clone(), blind.clone()],
            &rc_params(p.clips.clone()),
        )
        .unwrap();
        assert!(!plan.filter_complex.contains(",fps="));
    }

    #[test]
    fn roughcut_encode_all_muted_drops_audio() {
        let info = sample_info();
        let mut m1 = rc_clip("a.mp4", 0.0, Some(4.0));
        let mut m2 = rc_clip("a.mp4", 0.0, Some(4.0));
        m1.mute = true;
        m2.mute = true;
        let p = rc_params(vec![m1, m2]);
        let windows = vec![(0.0, 4.0), (0.0, 4.0)];
        let plan =
            plan_roughcut_encode(&info, &p.clips, &windows, &[info.clone(), info.clone()], &p)
                .unwrap();
        assert!(!plan.with_audio);
        assert!(plan.filter_complex.contains("concat=n=2:v=1:a=0[vout]"));
        assert!(
            !plan.filter_complex.contains("anullsrc"),
            "no audio branches are built at all"
        );
    }

    #[test]
    fn roughcut_encode_args_shape() {
        let info = sample_info();
        let p = rc_params(vec![rc_clip("a.mp4", 1.0, Some(5.0))]);
        let windows = vec![(1.0, 5.0)];
        let plan =
            plan_roughcut_encode(&info, &p.clips, &windows, &[info.clone()], &p).unwrap();
        let args = roughcut_encode_args(&plan, &info, &p, "mp4", Path::new("o.mp4"));
        assert_eq!(
            args.iter().filter(|a| **a == "-i").count(),
            1,
            "single audible clip = single input"
        );
        let fc = args.iter().position(|a| a == "-filter_complex").unwrap();
        assert!(args[fc + 1].starts_with("[0:v]trim=duration=4.000"));
        assert!(args.contains(&"-map".to_string()) && args.contains(&"[vout]".to_string()));
        assert!(args.contains(&"libx264".to_string()));
        assert!(args.contains(&"-crf".to_string()));
        assert!(args.contains(&"-pix_fmt".to_string()));
        assert!(args.contains(&"-movflags".to_string()));
        assert_eq!(args.last().unwrap(), "o.mp4");
    }

    #[test]
    fn roughcut_copy_mode_runmany() {
        let info = sample_info();
        let mut p = rc_params(vec![
            rc_clip("a.mp4", 0.0, Some(4.0)),
            rc_clip("a.mp4", 4.0, None),
        ]);
        p.mode = CutMode::Copy;
        let windows = vec![(0.0, 4.0), (4.0, 10.0)];
        match prepare_roughcut_copy(
            &p.clips,
            &windows,
            &[info.clone(), info],
            "mp4",
            PathBuf::from("out.mp4"),
        )
        .unwrap()
        {
            PreparedJob::RunMany {
                runs,
                cleanup,
                final_out,
            } => {
                assert_eq!(runs.len(), 3, "two scratch parts + one concat");
                assert_eq!(cleanup.len(), 3, "two parts + the concat list");
                assert!(final_out.is_some());
                let (args, _, dur) = runs.last().unwrap();
                assert_eq!(*dur, 0.0, "concat pass must not inflate the denominator");
                assert!(args.contains(&"concat".to_string()));
                // The prepare step really wrote the concat list; clean it up
                // so tests don't leave scratch files behind.
                for path in &cleanup {
                    let _ = std::fs::remove_file(path);
                }
            }
            _ => panic!("expected RunMany"),
        }
    }

    #[test]
    fn roughcut_copy_rejects_mismatched_clips() {
        let mut b = sample_info();
        b.width = Some(1280);
        let mut p = rc_params(vec![
            rc_clip("a.mp4", 0.0, Some(4.0)),
            rc_clip("b.mp4", 0.0, Some(4.0)),
        ]);
        p.mode = CutMode::Copy;
        let windows = vec![(0.0, 4.0), (0.0, 4.0)];
        let err = prepare_roughcut_copy(
            &p.clips,
            &windows,
            &[sample_info(), b],
            "mp4",
            PathBuf::from("o.mp4"),
        )
        .unwrap_err();
        assert!(err.0.contains("分辨率"), "{}", err.0);

        // Different codec families are equally fatal in copy mode.
        let mut c = sample_info();
        c.video_codec = Some("vp9".into());
        let err = prepare_roughcut_copy(
            &p.clips,
            &windows,
            &[sample_info(), c],
            "mp4",
            PathBuf::from("o.mp4"),
        )
        .unwrap_err();
        assert!(err.0.contains("编码"), "{}", err.0);

        // Mixed audio presence points at the precise mode instead.
        let mut silent = sample_info();
        silent.audio_codec = None;
        let err = prepare_roughcut_copy(
            &p.clips,
            &windows,
            &[sample_info(), silent],
            "mp4",
            PathBuf::from("o.mp4"),
        )
        .unwrap_err();
        assert!(err.0.contains("音轨"), "{}", err.0);
    }
}
