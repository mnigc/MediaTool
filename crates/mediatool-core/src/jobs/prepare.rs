//! Job preparation: parse and validate tool params, apply the overwrite
//! policy (reserve / skip / rename), normalize tool ids and dispatch every
//! tool to its argument builder, producing a ready-to-run `PreparedJob`.
use std::path::{Path, PathBuf};

use crate::ctx::AppEnv;
use crate::error::{AppError, Result};
use crate::models::{
    AudioMergeParams, AudioParams, AudioVolumeParams, ContactSheetParams, ExtractAudioParams,
    FrameSampleParams, JobRequest, MediaInfo, MediaType, MuteParams, RoughCutParams,
    ScreenshotParams, SpeedParams, StripMetadataParams, SubtitleParams, TrimParams, TrimSegment,
    VideoParams, VideoSilenceParams, WatermarkParams,
};

use super::args::{
    audio_ext_for, build_audio_args, build_audio_merge_args, build_audio_volume_args,
    build_mute_args, build_screenshot_count, build_screenshot_interval, build_screenshot_single,
    build_speed_args, build_strip_metadata_args, build_trim_segment_args, build_video_args,
    build_video_contact_args, build_video_frames_args, build_video_silence_args,
    build_video_subtitle_args, build_watermark_args, extension_for, interval_pattern,
    plan_roughcut_encode, prepare_roughcut_copy, roughcut_encode_args, roughcut_window,
    safe_container_ext, screenshot_ext, source_audio_format,
};
use super::util::{
    apply_overwrite_policy, ensure_vaapi_device, input_ext, output_path, output_path_labeled,
};

/// Collapse encoder names into codec families for container validation.
pub(super) fn codec_family<'a>(codec: &'a str) -> &'a str {
    match codec {
        "libx264" | "h264_nvenc" | "h264_qsv" | "h264_videotoolbox" | "h264_amf" | "h264_vaapi"
        | "h264" => "h264",
        "libx265" | "hevc_nvenc" | "hevc_qsv" | "hevc_videotoolbox" | "hevc_amf" | "hevc_vaapi"
        | "h265" | "hevc" => "hevc",
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
pub(super) const MP4_COPY_VIDEO: &[&str] = &["h264", "h265", "hevc", "av1", "vp9", "mpeg4"];
pub(super) const MP4_COPY_AUDIO: &[&str] = &["aac", "mp3", "ac3", "eac3", "alac"];

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
pub(super) fn mp4_copy_fallback(p: &mut VideoParams, info: &MediaInfo) -> Option<String> {
    if p.format != "mp4" {
        return None;
    }
    let incompatible = |codec: Option<&str>, allowed: &[&str]| match codec {
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
        parts.push(format!(
            "视频编码 {}",
            info.video_codec.as_deref().unwrap_or("")
        ));
        p.video_codec = "libx264".into();
        p.quality_mode = "crf".into();
        p.crf = Some(23);
        p.preset = "medium".into();
    }
    if a_bad {
        parts.push(format!(
            "音频编码 {}",
            info.audio_codec.as_deref().unwrap_or("")
        ));
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
pub(super) fn validate_video_container(
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

pub(super) fn parse_params<T: serde::de::DeserializeOwned>(params: &serde_json::Value) -> Result<T> {
    serde_json::from_value(params.clone()).map_err(AppError::from)
}

/// A fully prepared job: either skipped by the overwrite policy, ready to run
/// with a single ffmpeg invocation, or a sequence of invocations that produce
/// multiple output files (e.g. multi-segment trim).
#[derive(Debug)]
pub(super) enum PreparedJob {
    Skipped {
        /// The existing output file that caused the skip, so callers can chain
        /// it as the "output" of this step.
        existing: Option<PathBuf>,
    },
    Run {
        args: Vec<String>,
        out: PathBuf,
    },
    RunMany {
        runs: Vec<(Vec<String>, PathBuf, f64)>,
        /// Scratch artifacts (rough-cut segment parts, concat list) removed
        /// once the whole sequence settles, success or failure.
        cleanup: Vec<PathBuf>,
        /// The user-facing output when the deliverable is not the first run's
        /// target (rough-cut's final concat file).
        final_out: Option<PathBuf>,
    },
}

/// Create an empty placeholder file so concurrent jobs can't resolve to the
/// same output name. ffmpeg later overwrites it with -y.
fn reserve(path: &Path) {
    let _ = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path);
}

/// Resolve an output path applying the rename/skip/overwrite policy.
/// Ok = path to use; Err = policy is "skip" and the file already exists (the
/// existing path is returned so the caller can report/chain it).
pub(super) fn resolve_policy(out: PathBuf, policy: &str) -> std::result::Result<PathBuf, PathBuf> {
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

/// The frontend uses prefixed ids ("video-compress", "audio-convert", …) while
/// the dispatch below matches the unprefixed tool ("compress", "convert"). This
/// normalizes both conventions so a single tool id works everywhere.
pub(super) fn norm_tool_id(id: &str) -> &str {
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
pub(super) fn tool_dispatch(id: &str) -> &str {
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
    let count = req
        .params
        .get("count")
        .and_then(|v| v.as_u64())
        .unwrap_or(100) as u32;
    let cols = req
        .params
        .get("cols")
        .and_then(|v| v.as_u64())
        .unwrap_or(10) as u32;
    let thumb_w = req
        .params
        .get("thumbW")
        .and_then(|v| v.as_u64())
        .unwrap_or(160) as u32;
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
    JobRequest {
        tool_id: "video-contact".into(),
        params,
        ..req.clone()
    }
}

/// Build the args + output path for any tool id, or mark as skipped.
/// Blocking (may probe the rough-cut clip sources); call within
/// spawn_blocking. `env` is only needed by tools that probe extra inputs
/// (rough cut); tests pass None.
pub(super) fn prepare_job(
    env: Option<&dyn AppEnv>,
    info: &MediaInfo,
    req: &JobRequest,
    suffix: &str,
    policy: &str,
) -> Result<PreparedJob> {
    let req = legacy_tool_request(req);
    match tool_dispatch(&req.tool_id) {
        "compress" | "convert" => {
            let ext = extension_for(&req.tool_id, info, &req.params);
            // Parse and validate BEFORE reserving the output placeholder: an
            // early error must not leave a 0-byte stub that the next
            // rename/skip resolution would mistake for a real output.
            enum Src {
                Video(VideoParams),
                Audio(AudioParams),
            }
            let src = match info.media_type {
                MediaType::Video => {
                    let mut p: VideoParams = parse_params(&req.params)?;
                    p.gpu = req.gpu.clone();
                    validate_video_container(&ext, &p.video_codec, &p.audio_codec, info)?;
                    ensure_vaapi_device(&p)?;
                    Src::Video(p)
                }
                MediaType::Audio => Src::Audio(parse_params(&req.params)?),
                MediaType::Image | MediaType::Unknown => {
                    return Err(AppError("不支持的媒体类型".into()));
                }
            };
            let out = output_path(&info.path, &req.output_dir, &ext, suffix)?;
            let out = match resolve_policy(out, policy) {
                Ok(p) => p,
                Err(existing) => {
                    return Ok(PreparedJob::Skipped {
                        existing: Some(existing),
                    })
                }
            };
            let args = match src {
                Src::Video(p) => build_video_args(info, &p, &out),
                Src::Audio(p) => build_audio_args(info, &p, &out),
            };
            Ok(PreparedJob::Run { args, out })
        }
        "screenshot" => {
            let p: ScreenshotParams = parse_params(&req.params)?;
            let ext = screenshot_ext(&p.format);
            if p.mode == "interval" || p.mode == "count" {
                // Sequence outputs use a %03d pattern; the overwrite policy
                // does not apply (ffmpeg overwrites numbered files with -y).
                let base = output_path(&info.path, &req.output_dir, ext, suffix)?;
                let out = interval_pattern(base);
                let args = if p.mode == "count" {
                    build_screenshot_count(info, &p, &out)
                } else {
                    build_screenshot_interval(info, &p, &out)
                };
                Ok(PreparedJob::Run { args, out })
            } else {
                let base = output_path(&info.path, &req.output_dir, ext, suffix)?;
                let out = match resolve_policy(base, policy) {
                    Ok(p) => p,
                    Err(existing) => {
                        return Ok(PreparedJob::Skipped {
                            existing: Some(existing),
                        })
                    }
                };
                Ok(PreparedJob::Run {
                    args: build_screenshot_single(info, &p, &out),
                    out,
                })
            }
        }
        "speed" => {
            let p: SpeedParams = parse_params(&req.params)?;
            let ext = safe_container_ext(info);
            let out = output_path(&info.path, &req.output_dir, &ext, suffix)?;
            let out = match resolve_policy(out, policy) {
                Ok(p) => p,
                Err(existing) => {
                    return Ok(PreparedJob::Skipped {
                        existing: Some(existing),
                    })
                }
            };
            Ok(PreparedJob::Run {
                args: build_speed_args(info, &p, &out),
                out,
            })
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
                Err(existing) => {
                    return Ok(PreparedJob::Skipped {
                        existing: Some(existing),
                    })
                }
            };
            let wm_path = p.image_path.clone();
            Ok(PreparedJob::Run {
                args: build_watermark_args(info, &p, &wm_path, &out),
                out,
            })
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
                Err(existing) => {
                    return Ok(PreparedJob::Skipped {
                        existing: Some(existing),
                    })
                }
            };
            let ap = AudioParams {
                format: p.format,
                bitrate_kbps: p.bitrate_kbps,
            };
            Ok(PreparedJob::Run {
                args: build_audio_args(info, &ap, &out),
                out,
            })
        }
        "strip-metadata" => {
            let p: StripMetadataParams = parse_params(&req.params)?;
            let fallback = match info.media_type {
                MediaType::Image => "jpg",
                MediaType::Audio => "mp3",
                _ => "mp4",
            };
            let ext = input_ext(info, fallback);
            let out = output_path(&info.path, &req.output_dir, &ext, suffix)?;
            let out = match resolve_policy(out, policy) {
                Ok(p) => p,
                Err(existing) => {
                    return Ok(PreparedJob::Skipped {
                        existing: Some(existing),
                    })
                }
            };
            Ok(PreparedJob::Run {
                args: build_strip_metadata_args(info, &p, &out),
                out,
            })
        }
        "trim" => {
            let p: TrimParams = parse_params(&req.params)?;
            let ext = if p.mode == "encode" {
                safe_container_ext(info)
            } else {
                input_ext(info, "mp4")
            };
            let segments: Vec<TrimSegment> = if p.segments.is_empty() {
                vec![TrimSegment {
                    start_time: p.start_time,
                    duration: p.duration,
                }]
            } else {
                p.segments
            };
            let total_dur = info.duration_secs.unwrap_or(0.0);
            let multi = segments.len() > 1;
            let mut runs: Vec<(Vec<String>, PathBuf, f64)> = Vec::with_capacity(segments.len());
            let mut reserved: Vec<PathBuf> = Vec::new();
            for (i, seg) in segments.iter().enumerate() {
                let label = if multi {
                    format!("_{}", i + 1)
                } else {
                    String::new()
                };
                let out = output_path_labeled(&info.path, &req.output_dir, &ext, &suffix, &label)?;
                let out = match resolve_policy(out, policy) {
                    Ok(p) => {
                        reserved.push(p.clone());
                        p
                    }
                    Err(existing) => {
                        // A later segment hit the skip policy: roll back the
                        // placeholders reserved for the earlier segments —
                        // nothing will ever be written to them.
                        for r in reserved {
                            let _ = std::fs::remove_file(r);
                        }
                        return Ok(PreparedJob::Skipped {
                            existing: Some(existing),
                        });
                    }
                };
                let args =
                    build_trim_segment_args(info, seg.start_time, seg.duration, &p.mode, &out);
                let dur = seg
                    .duration
                    .unwrap_or_else(|| (total_dur - seg.start_time).max(0.0));
                runs.push((args, out, dur));
            }
            if multi {
                Ok(PreparedJob::RunMany {
                    runs,
                    cleanup: Vec::new(),
                    final_out: None,
                })
            } else {
                let (args, out, _) = runs.pop().expect("already branched on multi");
                Ok(PreparedJob::Run { args, out })
            }
        }
        "mute" => {
            let p: MuteParams = parse_params(&req.params)?;
            let ext = input_ext(info, "mp4");
            let out = output_path(&info.path, &req.output_dir, &ext, suffix)?;
            let out = match resolve_policy(out, policy) {
                Ok(p) => p,
                Err(existing) => {
                    return Ok(PreparedJob::Skipped {
                        existing: Some(existing),
                    })
                }
            };
            Ok(PreparedJob::Run {
                args: build_mute_args(info, &p, &out),
                out,
            })
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
                Err(existing) => {
                    return Ok(PreparedJob::Skipped {
                        existing: Some(existing),
                    })
                }
            };
            Ok(PreparedJob::Run {
                args: build_video_subtitle_args(info, &p, &out),
                out,
            })
        }
        "roughcut" => {
            let p: RoughCutParams = parse_params(&req.params)?;
            if p.clips.is_empty() {
                return Err(AppError("粗剪时间线为空：请先添加素材片段".into()));
            }
            // VAAPI requests need a render node; refuse before any file work.
            if p.mode == "encode" {
                if let Some(ep) = &p.encode {
                    ensure_vaapi_device(ep)?;
                }
            }
            let container = if p.container == "mkv" { "mkv" } else { "mp4" };
            // The deliverable is named after the first clip.
            let ext = container.to_string();
            let out = output_path(&info.path, &req.output_dir, &ext, &suffix)?;
            let out = match resolve_policy(out, policy) {
                Ok(p) => p,
                Err(existing) => {
                    return Ok(PreparedJob::Skipped {
                        existing: Some(existing),
                    })
                }
            };
            // Everything past the reserve can still fail (missing env, source
            // probing, window validation, filter planning): roll the reserved
            // placeholder back on any of those paths so no 0-byte stub is
            // left behind to poison the next overwrite resolution.
            let reserved_out = out.clone();
            let prepared = (|| -> Result<PreparedJob> {
                // Every clip is probed: durations clamp the cut windows, and
                // the audio presence / codecs drive both modes' validation
                // and the filter graph (silence splicing).
                let env = env.ok_or_else(|| AppError("内部错误：缺少应用环境".into()))?;
                let mut clip_infos: Vec<MediaInfo> = Vec::with_capacity(p.clips.len());
                for c in &p.clips {
                    if c.path.trim().is_empty() {
                        return Err(AppError("存在未指定源文件的片段".into()));
                    }
                    clip_infos.push(crate::media::probe_sync(env, &c.path)?);
                }
                let windows: Vec<(f64, f64)> = p
                    .clips
                    .iter()
                    .zip(&clip_infos)
                    .map(|(c, inf)| roughcut_window(c, inf))
                    .collect::<Result<_>>()?;
                if p.mode == "encode" {
                    let plan = plan_roughcut_encode(info, &p.clips, &windows, &clip_infos, &p)?;
                    Ok(PreparedJob::Run {
                        args: roughcut_encode_args(&plan, info, &p, container, &out),
                        out,
                    })
                } else {
                    prepare_roughcut_copy(&p.clips, &windows, &clip_infos, container, out)
                }
            })();
            match prepared {
                Ok(p) => Ok(p),
                Err(e) => {
                    let _ = std::fs::remove_file(&reserved_out);
                    Err(e)
                }
            }
        }
        "video-frames" => {
            let p: FrameSampleParams = parse_params(&req.params)?;
            let ext = safe_container_ext(info);
            let out = output_path(&info.path, &req.output_dir, &ext, suffix)?;
            let out = match resolve_policy(out, policy) {
                Ok(p) => p,
                Err(existing) => {
                    return Ok(PreparedJob::Skipped {
                        existing: Some(existing),
                    })
                }
            };
            Ok(PreparedJob::Run {
                args: build_video_frames_args(info, &p, &out),
                out,
            })
        }
        "video-contact" => {
            let p: ContactSheetParams = parse_params(&req.params)?;
            let out = output_path(&info.path, &req.output_dir, "png", suffix)?;
            let out = match resolve_policy(out, policy) {
                Ok(p) => p,
                Err(existing) => {
                    return Ok(PreparedJob::Skipped {
                        existing: Some(existing),
                    })
                }
            };
            Ok(PreparedJob::Run {
                args: build_video_contact_args(info, &p, &out),
                out,
            })
        }
        "video-silence" => {
            let p: VideoSilenceParams = parse_params(&req.params)?;
            let out = output_path(&info.path, &req.output_dir, "txt", suffix)?;
            let out = match resolve_policy(out, policy) {
                Ok(p) => p,
                Err(existing) => {
                    return Ok(PreparedJob::Skipped {
                        existing: Some(existing),
                    })
                }
            };
            Ok(PreparedJob::Run {
                args: build_video_silence_args(info, &p, &out),
                out,
            })
        }
        /* ── New audio tools ── */
        "audio-volume" => {
            let p: AudioVolumeParams = parse_params(&req.params)?;
            let ext = source_audio_format(&info.path).to_string();
            let out = output_path(&info.path, &req.output_dir, &ext, suffix)?;
            let out = match resolve_policy(out, policy) {
                Ok(p) => p,
                Err(existing) => {
                    return Ok(PreparedJob::Skipped {
                        existing: Some(existing),
                    })
                }
            };
            Ok(PreparedJob::Run {
                args: build_audio_volume_args(info, &p, &out),
                out,
            })
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
                Err(existing) => {
                    return Ok(PreparedJob::Skipped {
                        existing: Some(existing),
                    })
                }
            };
            Ok(PreparedJob::Run {
                args: build_audio_merge_args(&req.inputs, &out),
                out,
            })
        }
        other => Err(AppError(format!("未知工具: {}", other))),
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::jobs::util::gpu_plan;
    use crate::jobs::test_support::sample_info;

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
            &req(
                "extract-audio",
                serde_json::json!({"format":"opus","bitrateKbps":128}),
            ),
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
        match prepare_job(
            None,
            &info,
            &req("strip-metadata", serde_json::json!({})),
            "_mediatool",
            "rename",
        )
        .unwrap()
        {
            PreparedJob::Run { args, out } => {
                assert!(out.to_string_lossy().ends_with(".mp4"), "got {:?}", out);
                assert!(args.contains(&"copy".to_string()));
            }
            _ => panic!("expected Run"),
        }
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

    #[test]
    fn norm_tool_id_maps_prefixed_tools() {
        assert_eq!(norm_tool_id("video-compress"), "compress");
        assert_eq!(norm_tool_id("audio-compress"), "compress");
        assert_eq!(norm_tool_id("trim"), "trim");
        assert_eq!(norm_tool_id("extract-audio"), "extract-audio");
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

}
