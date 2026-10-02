//! Multi-step workflow: decide whether a chain of steps can merge into a
//! single ffmpeg command (shared filter chain plus at most one overlay
//! input), build the merged arguments and run it with the same
//! spawn / poll / emit loop as single jobs.
use std::io::{BufRead, BufReader};
use std::path::Path;

use crate::ctx::Ctx;
use crate::error::Result;
use crate::ffmpeg;
use crate::media::probe;
use crate::models::{
    MediaInfo, SpeedParams, StartWorkflowResult, TrimParams, VideoParams, WatermarkParams,
    WorkflowRequest, WorkflowStepInput,
};

use super::args::safe_container_ext;
use super::prepare::{
    mp4_copy_fallback, norm_tool_id, parse_params, resolve_policy, validate_video_container,
};
use super::run::{deliverables, emit_done, emit_progress, tail_chars};
use super::util::{
    atempo_chain, crf_to_bitrate, gpu_plan, input_ext, metadata_strip_args, output_path,
    svt_preset, trim_window_secs, uuid, video_filter_chain, vp9_cpu_used,
};

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
    "compress",
    "convert",
    "trim",
    "speed",
    "mute",
    "watermark",
    "strip-metadata",
];

/// Precondition for merging. Rejects terminal tools and combinations that
/// cannot be expressed as a single command (stream-copy trim, >1 watermark,
/// >1 trim).
fn is_mergeable_chain(steps: &[WorkflowStepInput]) -> bool {
    let mut wm = 0usize;
    let mut trims = 0usize;
    for s in steps {
        let id = norm_tool_id(&s.tool_id);
        if !MERGEABLE_TOOLS.contains(&id) {
            return false;
        }
        if id == "trim" {
            // merged_chain keeps a single trim window; a second trim step
            // would silently override the first, so fall back to running the
            // steps sequentially instead.
            trims += 1;
            if trims > 1 {
                return false;
            }
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
pub(super) fn video_encoder_args(info: &MediaInfo, ep: &VideoParams) -> Vec<String> {
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
    fc.push_str(&format!(
        "{}[wms]overlay=x={}:y={}{};",
        main, x, y, ov_label
    ));
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
fn merged_args(
    info: &MediaInfo,
    chain: &MergedChain,
    out: &Path,
    gpu: &Option<String>,
) -> Vec<String> {
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

    let overlay = chain.ops.iter().find_map(|o| match o {
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
pub(crate) fn merged_output_ext(info: &MediaInfo, steps: &[WorkflowStepInput]) -> Option<String> {
    merged_chain(info, steps).map(|c| c.ext)
}

/// Start a workflow. When the steps are composable they are merged into a single
/// FFmpeg command that emits progress/done on `id`; otherwise `merged: false` is
/// returned so the frontend runs the steps one after another.
pub async fn start_workflow(ctx: Ctx, req: WorkflowRequest) -> Result<StartWorkflowResult> {
    let id = uuid();
    // Fresh run: clear any stale cancel latch for this id. The id only becomes
    // observable to the frontend when this command returns, so no cancel can
    // be erased here — everything after this point must see a cancel stick.
    ctx.jobs.begin(&id);
    let input = req.input.clone();
    // An empty chain cannot be merged; let the caller decide how to behave.
    if req.steps.is_empty() {
        return Ok(StartWorkflowResult {
            id,
            merged: false,
            skipped: false,
            note: None,
        });
    }
    let info = probe(ctx.env.clone(), &input).await?;
    let suffix = req
        .output_suffix
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "_mediatool".to_string());
    let policy = req.overwrite_policy.as_deref().unwrap_or("rename");

    let ext = match merged_output_ext(&info, &req.steps) {
        Some(ext) => ext,
        None => {
            return Ok(StartWorkflowResult {
                id,
                merged: false,
                skipped: false,
                note: None,
            })
        }
    };
    let out = output_path(&input, &req.output_dir, &ext, &suffix)?;
    let out = match resolve_policy(out, policy) {
        Ok(p) => p,
        Err(_existing) => {
            // Output already existed and policy = "skip": signal a no-op via the
            // `skipped` flag instead of emitting a synchronous done event (which
            // the frontend would race and miss). The caller finishes immediately.
            return Ok(StartWorkflowResult {
                id,
                merged: true,
                skipped: true,
                note: None,
            });
        }
    };

    let Some(mut chain) = merged_chain(&info, &req.steps) else {
        return Ok(StartWorkflowResult {
            id,
            merged: false,
            skipped: false,
            note: None,
        });
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

    let (child, stdout, stderr_buf, stderr_drain) = ffmpeg::spawn(&*ctx.env, "ffmpeg", &args)?;
    let input_size = info.size_bytes;
    let task_id = id.clone();

    let child = std::sync::Arc::new(std::sync::Mutex::new(child));
    let manager = ctx.jobs.clone();
    manager.register(&task_id, child.clone());
    // If cancel arrived between spawn and register the kill above missed the
    // child; kill it now so the cancel is honored immediately.
    if manager.is_cancelled(&task_id) {
        if let Ok(mut c) = child.lock() {
            let _ = c.kill();
        }
    }
    emit_progress(ctx.emitter.as_ref(), &task_id, 0.0, "running", None);

    let ctx = ctx.clone();
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
                        emit_progress(
                            ctx.emitter.as_ref(),
                            &task_id,
                            pct,
                            "running",
                            last_speed.clone(),
                        );
                    }
                }
            } else if line.starts_with("speed=") {
                last_speed = Some(line["speed=".len()..].trim().to_string());
            }
        }

        let manager = ctx.jobs.clone();
        // Reap via a poll loop, never a blocking wait(): wait() holds the
        // child mutex until exit, which deadlocks cancel's kill() (same
        // pattern as ytdlp.rs). finish() only runs once the process is
        // confirmed dead, so a cancel can always still find its target.
        let code = loop {
            match child.lock().unwrap().try_wait() {
                Ok(Some(status)) => break status.code().unwrap_or(-1),
                Ok(None) => {}
                Err(_) => break -1,
            }
            // Re-kill while the cancel flag is set: enforces a cancel whose
            // first kill failed.
            if manager.is_cancelled(&task_id) {
                if let Err(e) = crate::state::kill_tree(&mut child.lock().unwrap()) {
                    eprintln!("kill job {task_id}: {e}");
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        };
        let was_cancelled = manager.is_cancelled(&task_id);
        manager.finish(&task_id);

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
            emit_done(
                ctx.emitter.as_ref(),
                &task_id,
                false,
                was_cancelled,
                false,
                None,
                None,
                Some(err),
                input_size,
                None,
            );
        } else {
            let output_size = std::fs::metadata(&out).map(|m| m.len()).ok();
            emit_progress(
                ctx.emitter.as_ref(),
                &task_id,
                100.0,
                "done",
                last_speed.clone(),
            );
            let outs = deliverables(&out);
            emit_done(
                ctx.emitter.as_ref(),
                &task_id,
                true,
                false,
                false,
                Some(out.to_string_lossy().to_string()),
                (outs.len() > 1).then_some(outs),
                None,
                input_size,
                output_size,
            );
        }
    });

    Ok(StartWorkflowResult {
        id,
        merged: true,
        skipped: false,
        note: copy_note,
    })
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::jobs::test_support::sample_info;

    /* ── multi-step workflow merging ─────────────────────────────── */

    fn step(tool: &str, params: serde_json::Value) -> WorkflowStepInput {
        WorkflowStepInput {
            tool_id: tool.into(),
            params,
        }
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
            step(
                "speed",
                serde_json::json!({"rate": 1.5, "muteAudio": false}),
            ),
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
        assert!(
            vf.contains("scale=-2:720,setpts=PTS/1.500000"),
            "vf = {}",
            vf
        );

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
        let shot = vec![step(
            "screenshot",
            serde_json::json!({"mode":"single","atSec":1.0,"format":"png"}),
        )];
        assert!(merged_output_ext(&info, &shot).is_none());
    }

    #[test]
    fn merge_rejects_stream_copy_trim() {
        let steps = vec![
            step(
                "trim",
                serde_json::json!({"startTime": 1.0, "mode": "copy"}),
            ),
            step(
                "speed",
                serde_json::json!({"rate": 2.0, "muteAudio": false}),
            ),
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
    fn merge_rejects_multiple_trims() {
        // A merged command keeps a single trim window, so a second trim step
        // must fall back to sequential execution instead of silently
        // overriding the first.
        let t = || {
            serde_json::json!({"startTime": 1.0, "duration": 2.0, "mode": "encode"})
        };
        let steps = vec![step("trim", t()), step("trim", t())];
        assert!(!is_mergeable_chain(&steps));
        assert!(merged_output_ext(&sample_info(), &steps).is_none());
    }

    #[test]
    fn trim_encode_merge_applies_seek_and_duration() {
        let steps = vec![
            step(
                "trim",
                serde_json::json!({"startTime": 5.5, "duration": 10.0, "mode": "encode"}),
            ),
            step("speed", serde_json::json!({"rate": 2.0, "muteAudio": true})),
        ];
        let info = sample_info();
        let chain = merged_chain(&info, &steps).expect("mergeable");
        let args = merged_args(&info, &chain, Path::new("out.mp4"), &None);

        let ss = args.iter().position(|a| a == "-ss").unwrap();
        assert_eq!(args[ss + 1], "5.500");
        let t = args.iter().position(|a| a == "-t").unwrap();
        assert_eq!(args[t + 1], "10.000");
        assert!(
            args.contains(&"-an".to_string()),
            "speed muted audio keeps -an"
        );
        assert!(args.last().unwrap() == &"out.mp4".to_string());
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
