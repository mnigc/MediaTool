//! Output size estimation: encode a short sample of the input with the real
//! job's argument builders and extrapolate the produced byte count over the
//! full duration.
use crate::ctx::Ctx;
use crate::error::{AppError, Result};
use crate::ffmpeg;
use crate::models::{AudioParams, EstimateRequest, EstimateResult, MediaType, VideoParams};

use super::args::{build_audio_args, build_video_args, extension_for};
use super::prepare::parse_params;
use super::util::{ensure_vaapi_device, uuid};

/// Refined size estimate via a short real encode of a sample clip.
///
/// Reuses the exact same argument builders as `start_job`, but encodes only a
/// few seconds to a temp file, then extrapolates the produced byte count over
/// the total duration.
pub async fn estimate_size(ctx: Ctx, req: EstimateRequest) -> Result<EstimateResult> {
    let sample_secs = req.sample_secs.unwrap_or(8.0).max(0.1);
    let info = req.info;
    let ext = extension_for("estimate", &info, &req.params);
    let tmp = std::env::temp_dir().join(format!("mediatool_est_{}.{}", uuid(), ext));

    let total = info.duration_secs;

    // Decide where to sample from: skip the first ~10% to avoid static
    // intros, but keep at least a sliver of headroom.
    let offset = match total {
        Some(t) if t > 0.2 => (t * 0.1).min(t - 0.1).max(0.0),
        _ => 0.0,
    };

    let max_dur = total.map_or(sample_secs, |t| (t - offset).max(0.1));
    let sample_dur = sample_secs.min(max_dur);

    // Build args from the original params; the sample window is added below.
    let mut base_args: Vec<String> = match req.media_type {
        MediaType::Video => {
            let p: VideoParams = parse_params(&req.params)?;
            p.validate()?;
            ensure_vaapi_device(&p)?;
            build_video_args(&info, &p, &tmp)
        }
        MediaType::Image | MediaType::Unknown => return Err(AppError("不支持的媒体类型".into())),
        MediaType::Audio => {
            let p: AudioParams = parse_params(&req.params)?;
            p.validate()?;
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

    // Nothing here ever reads the child's pipes: a piped stderr that fills
    // its 64 KB buffer would block ffmpeg forever mid-estimate. Discard both.
    let bin = ffmpeg::resolve(&*ctx.env, "ffmpeg").ok_or_else(|| {
        AppError("找不到 ffmpeg：请将 FFmpeg 放在程序同目录，或安装到系统 PATH 中".into())
    })?;
    let mut cmd = std::process::Command::new(&bin);
    cmd.args(&final_args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    ffmpeg::hide_console(&mut cmd);
    let mut child = cmd.spawn().map_err(AppError::from)?;
    // Sample-encoding a real clip blocks for seconds — keep it off the async
    // runtime workers.
    let waited = tokio::task::spawn_blocking(move || {
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

