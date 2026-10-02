//! Runtime loop for single jobs: spawn ffmpeg, stream its `-progress` stdout,
//! poll the child without a blocking wait so cancel stays responsive, emit
//! progress / done events and clean up outputs and scratch files on failure.
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use crate::ctx::{emit, Ctx, Emitter};
use crate::error::{AppError, Result};
use crate::ffmpeg;
use crate::media::probe;
use crate::models::{
    DoneEvent, JobRequest, MediaInfo, ProgressEvent, RoughCutParams, ScreenshotParams,
    StartJobResult, TrimParams, VideoParams,
};

use super::args::{cleanup_pattern_outputs, pattern_output_size, scan_pattern_outputs};
use super::prepare::{
    mp4_copy_fallback, norm_tool_id, parse_params, prepare_job, tool_dispatch, PreparedJob,
};
use super::util::{trim_window_secs, uuid};

/// Start a conversion job. Spawns FFmpeg, streams progress, emits events.
pub async fn start_job(ctx: Ctx, req: JobRequest) -> Result<StartJobResult> {
    let id = uuid();
    // Fresh run: clear any stale cancel latch for this id. The id only becomes
    // observable to the frontend when this command returns, so no cancel can
    // be erased here — everything after this point must see a cancel stick
    // (finish() no longer clears it, which is what keeps a multi-run job from
    // losing a cancel that lands between two runs).
    ctx.jobs.begin(&id);
    let input = req
        .inputs
        .first()
        .cloned()
        .ok_or_else(|| AppError("缺少输入文件".into()))?;
    let info = probe(ctx.env.clone(), &input).await?;
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
    // prepare_job may block (probing rough-cut sources, converting a PDF source
    // image) — keep it off the async runtime workers.
    let prepared = {
        let ctx2 = ctx.clone();
        let info2 = info.clone();
        let req2 = req.clone();
        tokio::task::spawn_blocking(move || {
            prepare_job(Some(&*ctx2.env), &info2, &req2, &suffix, &policy)
        })
        .await
        .map_err(|e| AppError(e.to_string()))??
    };

    let (runs, cleanup, final_out) = match prepared {
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
            (vec![(args, out, dur)], Vec::new(), None)
        }
        PreparedJob::RunMany {
            runs,
            cleanup,
            final_out,
        } => (runs, cleanup, final_out),
    };

    if runs.is_empty() {
        return Ok(StartJobResult {
            id,
            skipped: true,
            output: None,
            note: None,
        });
    }
    let input_size = info.size_bytes;
    let total_dur: f64 = runs.iter().map(|r| r.2.max(0.0)).sum();
    let task_id = id.clone();

    emit_progress(ctx.emitter.as_ref(), &task_id, 0.0, "running", None);

    let ctx = ctx.clone();
    std::thread::spawn(move || {
        let mut accum = 0.0_f64;
        let mut last_percent = 0.0_f64;
        let mut last_speed: Option<String> = None;
        // The reported deliverable: the rough-cut concat file rather than the
        // first temp segment.
        let first_out = final_out
            .clone()
            .or_else(|| runs.first().map(|r| r.1.clone()));
        let mut total_size: u64 = 0;
        let mut ok = false;
        let mut cancelled = false;
        let mut err_msg: Option<String> = None;

        'runs: for (_idx, (rargs, out, dur)) in runs.iter().enumerate() {
            let mut args = rargs.clone();
            args.insert(0, "-nostats".into());
            let (child, stdout, stderr_buf, stderr_drain) =
                match ffmpeg::spawn(&*ctx.env, "ffmpeg", &args) {
                    Ok(v) => v,
                    Err(e) => {
                        ok = false;
                        err_msg = Some(e.to_string());
                        // Same scratch cleanup as a mid-run failure: the
                        // reserved 0-byte outputs, the rough-cut segments and
                        // the final concat target must not linger.
                        if out.to_string_lossy().contains("%03d") {
                            cleanup_pattern_outputs(out);
                        } else {
                            let _ = std::fs::remove_file(out);
                        }
                        for scratch in &cleanup {
                            let _ = std::fs::remove_file(scratch);
                        }
                        if let Some(f) = &final_out {
                            let _ = std::fs::remove_file(f);
                        }
                        break 'runs;
                    }
                };

            let child = std::sync::Arc::new(std::sync::Mutex::new(child));
            let manager = ctx.jobs.clone();
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

            // Process finished; collect exit status. Reap via a poll loop,
            // never a blocking wait(): wait() holds the child mutex until
            // exit, which deadlocks cancel's kill() (same pattern as
            // ytdlp.rs). finish() only runs once the process is confirmed
            // dead, so a cancel can always still find its target.
            let manager = ctx.jobs.clone();
            let code = loop {
                match child.lock().unwrap().try_wait() {
                    Ok(Some(status)) => break status.code().unwrap_or(-1),
                    Ok(None) => {}
                    Err(_) => break -1,
                }
                // Re-kill while the cancel flag is set: enforces a cancel
                // whose first kill failed.
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
                for scratch in &cleanup {
                    let _ = std::fs::remove_file(scratch);
                }
                if let Some(f) = &final_out {
                    // The reserved placeholder (or a partially written concat
                    // result) is garbage once the job fails — leaving it
                    // would poison the next overwrite resolution.
                    let _ = std::fs::remove_file(f);
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
            // Assembled jobs (rough-cut) deliver one final file built from
            // scratch segments — report that file's size, not the sum, which
            // would double-count the parts — and drop the scratch artifacts.
            if let Some(f) = &final_out {
                total_size = std::fs::metadata(f).map(|m| m.len()).unwrap_or(0);
            }
            for scratch in &cleanup {
                let _ = std::fs::remove_file(scratch);
            }
            emit_progress(
                ctx.emitter.as_ref(),
                &task_id,
                100.0,
                "done",
                last_speed.clone(),
            );
            // Every file the job delivered: an assembled job ships only its
            // final cut, a multi-segment one ships each part, and a `%03d`
            // sequence expands into the frames ffmpeg wrote.
            let outputs: Vec<String> = match &final_out {
                Some(f) => deliverables(f),
                None => runs
                    .iter()
                    .flat_map(|(_, out, _)| deliverables(out))
                    .collect(),
            };
            emit_done(
                ctx.emitter.as_ref(),
                &task_id,
                true,
                false,
                false,
                first_out.map(|p| p.to_string_lossy().to_string()),
                (outputs.len() > 1).then_some(outputs),
                None,
                input_size,
                if total_size > 0 {
                    Some(total_size)
                } else {
                    None
                },
            );
        } else {
            emit_done(
                ctx.emitter.as_ref(),
                &task_id,
                false,
                cancelled,
                false,
                None,
                None,
                err_msg,
                input_size,
                None,
            );
        }
    });

    Ok(StartJobResult {
        id,
        skipped: false,
        output: None,
        note: copy_note,
    })
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
        "roughcut" => parse_params::<RoughCutParams>(&req.params)
            .map(|p| {
                // The encode pass's out_time covers the OUTPUT timeline, so
                // the denominator is the speed-adjusted total. Clips ending
                // "to source end" approximate their length from the first
                // clip's duration — the bar may sag slightly, never stall.
                p.clips
                    .iter()
                    .map(|c| {
                        let speed = c.speed.clamp(0.25, 4.0);
                        let end = c.end_time.unwrap_or(total);
                        ((end - c.start_time).max(0.0)) / speed
                    })
                    .sum()
            })
            .unwrap_or(total),
        _ => total,
    }
}

/// Tail of a (possibly multi-byte) log string, safe on char boundaries.
pub(super) fn tail_chars(s: &str, max_bytes: usize) -> String {
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

pub(super) fn emit_progress(
    emitter: &dyn Emitter,
    id: &str,
    percent: f64,
    phase: &str,
    speed: Option<String>,
) {
    emit(
        emitter,
        "job-progress",
        &ProgressEvent {
            id: id.to_string(),
            percent,
            phase: phase.to_string(),
            speed,
        },
    );
}

pub(super) fn emit_done(
    emitter: &dyn Emitter,
    id: &str,
    ok: bool,
    cancelled: bool,
    skipped: bool,
    output: Option<String>,
    outputs: Option<Vec<String>>,
    error: Option<String>,
    input_size: u64,
    output_size: Option<u64>,
) {
    emit(
        emitter,
        "job-done",
        &DoneEvent {
            id: id.to_string(),
            ok,
            cancelled,
            skipped: if skipped { Some(true) } else { None },
            output,
            outputs,
            error,
            input_size,
            output_size,
        },
    );
}

/// The files one run actually left behind, a `%03d` sequence expanded into its
/// individual frames.
pub(super) fn deliverables(out: &Path) -> Vec<String> {
    let files: Vec<PathBuf> = if out.to_string_lossy().contains("%03d") {
        scan_pattern_outputs(out)
    } else {
        vec![out.to_path_buf()]
    };
    files
        .into_iter()
        .filter(|p| p.is_file())
        .map(|p| p.to_string_lossy().to_string())
        .collect()
}

