use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Emitter, Manager};

use crate::error::{AppError, Result};
use crate::ffmpeg;
use crate::media::probe;
use crate::models::{
    AudioParams, DoneEvent, EstimateRequest, EstimateResult, GifParams, ImageParams, JobRequest,
    MediaInfo, MediaType, ProgressEvent, ScreenshotParams, SpeedParams, StartJobResult,
    VideoParams, WatermarkParams,
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

    if let Some(start) = p.start_time {
        if start > 0.0 {
            a.push("-ss".into());
            a.push(format!("{:.3}", start));
        }
    }

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

    if let Some(dur) = p.duration {
        if dur > 0.0 {
            a.push("-t".into());
            a.push(format!("{:.3}", dur));
        }
    }

    a.extend(metadata_strip_args(p.strip_metadata.unwrap_or(false), true));

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

    a.extend(metadata_strip_args(p.strip_metadata.unwrap_or(false), false));

    if let Some(d) = p.max_dimension {
        if d > 0 {
            a.push("-vf".into());
            a.push(image_scale_vf(d));
        }
    }

    match p.format.as_str() {
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

fn build_audio_args(info: &MediaInfo, p: &AudioParams, out: &Path) -> Vec<String> {
    let mut a: Vec<String> = vec!["-i".into(), info.path.clone(), "-vn".into()];

    a.extend(metadata_strip_args(p.strip_metadata.unwrap_or(false), false));

    match p.format.as_str() {
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
        _ => {
            a.push("-c:a".into());
            a.push("copy".into());
        }
    }

    if p.format != "flac" {
        a.push("-b:a".into());
        a.push(format!("{}k", p.bitrate_kbps));
    }

    a.push("-progress".into());
    a.push("pipe:1".into());
    a.push("-y".into());
    a.push(out.to_string_lossy().to_string());
    a
}

/* ── Toolbox tools ─────────────────────────────────────────────── */

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

fn extension_for(media_type: MediaType, params: &serde_json::Value) -> String {
    let extract_audio = params
        .get("extractAudio")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    match media_type {
        MediaType::Video if extract_audio => {
            let fmt = params
                .get("extractFormat")
                .and_then(|f| f.as_str())
                .unwrap_or("mp3");
            audio_ext_for(fmt).to_string()
        }
        MediaType::Video => params
            .get("format")
            .and_then(|f| f.as_str())
            .unwrap_or("mp4")
            .to_string(),
        MediaType::Image => params
            .get("format")
            .and_then(|f| f.as_str())
            .unwrap_or("webp")
            .to_string(),
        MediaType::Audio => params
            .get("format")
            .and_then(|f| f.as_str())
            .unwrap_or("mp3")
            .to_string(),
        MediaType::Unknown => "out".to_string(),
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

/// Build the args + output path for any tool id, or mark as skipped.
fn prepare_job(info: &MediaInfo, req: &JobRequest, suffix: &str, policy: &str) -> Result<PreparedJob> {
    match req.tool_id.as_str() {
        "compress" => {
            let ext = extension_for(info.media_type, &req.params);
            let out = output_path(&info.path, &req.output_dir, &ext, suffix)?;
            let Some(out) = resolve_policy(out, policy) else {
                return Ok(PreparedJob::Skipped);
            };
            let args = match info.media_type {
                MediaType::Video => {
                    let mut p: VideoParams = parse_params(&req.params)?;
                    p.gpu = req.gpu.clone();
                    if p.extract_audio.unwrap_or(false) {
                        let ap = AudioParams {
                            format: audio_ext_for(p.extract_format.as_deref().unwrap_or("mp3"))
                                .to_string(),
                            bitrate_kbps: p.audio_bitrate_kbps.unwrap_or(128),
                            strip_metadata: p.strip_metadata,
                        };
                        build_audio_args(info, &ap, &out)
                    } else {
                        build_video_args(info, &p, &out)
                    }
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
            let ext = input_ext(info, "mp4");
            let out = output_path(&info.path, &req.output_dir, &ext, suffix)?;
            let Some(out) = resolve_policy(out, policy) else {
                return Ok(PreparedJob::Skipped);
            };
            Ok(PreparedJob::Run { args: build_speed_args(info, &p, &out), out })
        }
        "watermark" => {
            let p: WatermarkParams = parse_params(&req.params)?;
            let ext = input_ext(info, "mp4");
            let out = output_path(&info.path, &req.output_dir, &ext, suffix)?;
            let Some(out) = resolve_policy(out, policy) else {
                return Ok(PreparedJob::Skipped);
            };
            let wm_path = p.image_path.clone();
            Ok(PreparedJob::Run { args: build_watermark_args(info, &p, &wm_path, &out), out })
        }
        other => Err(AppError(format!("未知工具: {}", other))),
    }
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
/// produced byte count over the (trimmed) total duration.
pub async fn estimate_size(app: AppHandle, req: EstimateRequest) -> Result<EstimateResult> {
    let sample_secs = req.sample_secs.unwrap_or(8.0).max(0.1);
    let info = req.info;
    let ext = extension_for(req.media_type, &req.params);
    let tmp = std::env::temp_dir().join(format!("mediapress_est_{}.{}", uuid(), ext));

    // Original trim window (for video / audio extraction).
    let (base_start, clip_end): (f64, Option<f64>) = match req.media_type {
        MediaType::Video => {
            let p: VideoParams = parse_params(&req.params)?;
            let s = p.start_time.unwrap_or(0.0);
            let e = p.duration.map(|d| s + d);
            (s, e)
        }
        _ => (0.0, None),
    };

    let total = info.duration_secs;

    // Decide where to sample from: skip the first ~10% to avoid static
    // intros, but keep at least a sliver of headroom.
    let offset = match total {
        Some(t) if t > base_start + 0.2 => {
            let skip = ((t - base_start) * 0.1).min(t - base_start - 0.1);
            (base_start + skip).max(0.0)
        }
        _ => base_start,
    };

    let max_dur = match (total, clip_end) {
        (Some(_t), Some(e)) => (e - offset).max(0.1),
        (Some(t), None) => (t - offset).max(0.1),
        (None, Some(e)) => (e - offset).max(0.1),
        (None, None) => sample_secs,
    };
    let sample_dur = sample_secs.min(max_dur);

    // Build args from the ORIGINAL params but without their own -ss/-t (we add
    // the sample window ourselves for uniform handling across media types).
    let mut base_args: Vec<String> = match req.media_type {
        MediaType::Video => {
            let mut p: VideoParams = parse_params(&req.params)?;
            p.start_time = None;
            p.duration = None;
            if p.extract_audio.unwrap_or(false) {
                let ap = AudioParams {
                    format: audio_ext_for(p.extract_format.as_deref().unwrap_or("mp3")).to_string(),
                    bitrate_kbps: p.audio_bitrate_kbps.unwrap_or(128),
                    strip_metadata: p.strip_metadata,
                };
                build_audio_args(&info, &ap, &tmp)
            } else {
                build_video_args(&info, &p, &tmp)
            }
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

    // Whole trimmed clip was sampled -> exact.
    let clip_len = match (total, clip_end) {
        (Some(_t), Some(e)) => (e - base_start).max(0.0),
        (Some(t), None) => (t - base_start).max(0.0),
        _ => sample_dur,
    };

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
            start_time: None,
            duration: None,
            fps: None,
            strip_metadata: None,
            extract_audio: None,
            extract_format: None,
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
    fn video_trim_args() {
        let mut p = video_params();
        p.start_time = Some(5.5);
        p.duration = Some(10.0);
        let args = build_video_args(&sample_info(), &p, Path::new("o.mp4"));
        let ss_idx = args.iter().position(|a| a == "-ss").unwrap();
        assert_eq!(args[ss_idx + 1], "5.500");
        let i_idx = args.iter().position(|a| a == "-i").unwrap();
        assert!(ss_idx < i_idx, "-ss must precede -i for fast seek");
        let t_idx = args.iter().position(|a| a == "-t").unwrap();
        assert_eq!(args[t_idx + 1], "10.000");
        assert!(i_idx < t_idx, "-t must follow -i");
    }

    #[test]
    fn video_extract_audio_args() {
        let p = VideoParams {
            video_codec: "libx264".into(),
            quality_mode: "crf".into(),
            crf: Some(28),
            target_size_mb: None,
            video_bitrate_kbps: None,
            resolution: "original".into(),
            audio_codec: "aac".into(),
            audio_bitrate_kbps: Some(192),
            format: "mp4".into(),
            preset: "medium".into(),
            start_time: None,
            duration: None,
            fps: None,
            strip_metadata: None,
            extract_audio: Some(true),
            extract_format: Some("opus".into()),
            gpu: None,
        };
        let ap = AudioParams {
            format: audio_ext_for(p.extract_format.as_deref().unwrap_or("mp3")).to_string(),
            bitrate_kbps: p.audio_bitrate_kbps.unwrap_or(128),
            strip_metadata: None,
        };
        let args = build_audio_args(&sample_info(), &ap, Path::new("o.opus"));
        assert!(args.contains(&"-vn".to_string()));
        assert!(args.contains(&"libopus".to_string()));
        assert!(args.contains(&"192k".to_string()));
        assert_eq!(args.last().unwrap(), "o.opus");
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
            strip_metadata: None,
        };
        let args = build_image_args(&sample_info(), &p, Path::new("o.webp"));
        assert!(args.contains(&"-quality".to_string()));
        assert!(args.contains(&"80".to_string()));
        assert!(args.contains(&"-vf".to_string()));
        assert!(args.iter().any(|a| a.contains("scale=")));
    }

    #[test]
    fn audio_mp3_bitrate() {
        let p = AudioParams {
            format: "mp3".into(),
            bitrate_kbps: 192,
            strip_metadata: None,
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

    #[test]
    fn strip_metadata_flags() {
        let mut p = video_params();
        p.strip_metadata = Some(true);
        let args = build_video_args(&sample_info(), &p, Path::new("o.mp4"));
        assert!(args.contains(&"-map_metadata".to_string()));
        assert!(args.contains(&"-map_chapters".to_string()));

        let ap = AudioParams { format: "mp3".into(), bitrate_kbps: 128, strip_metadata: Some(true) };
        let args = build_audio_args(&sample_info(), &ap, Path::new("o.mp3"));
        assert!(args.contains(&"-map_metadata".to_string()));
        assert!(!args.contains(&"-map_chapters".to_string()));

        let ip = ImageParams { format: "webp".into(), quality: 80, max_dimension: None, strip_metadata: Some(true) };
        let args = build_image_args(&sample_info(), &ip, Path::new("o.webp"));
        assert!(args.contains(&"-map_metadata".to_string()));
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
}

