//! Streaming downloads with byte-level progress, shared by the engine
//! installers.
//!
//! The installers used to shell out to curl, which reports no machine-readable
//! percentages; the UI could only spin. reqwest streams the body instead, so
//! each installer can emit real progress while keeping the mirror fallback.

use std::path::Path;
use std::time::{Duration, Instant};

use tokio::io::AsyncWriteExt;

use crate::error::{AppError, Result};

/// No chunk for this long means the source is dead; abandon it and fall
/// through to the next mirror (curl's `--max-time` equivalent, but per-stall
/// rather than per-whole-download).
const STALL_TIMEOUT: Duration = Duration::from_secs(60);
/// Progress callbacks drive UI events; one per this interval is plenty.
const EMIT_INTERVAL: Duration = Duration::from_millis(250);

/// `(source_index, downloaded_bytes, total_bytes if Content-Length was sent)`
/// `Send` because both shells await the download inside a `Send` command future.
type Progress<'a> = dyn FnMut(usize, u64, Option<u64>) + Send + 'a;

/// Try each candidate URL in order, streaming the winner to `dest`.
/// `min_bytes` rejects error pages served with a 200.
pub async fn fetch_with_progress(
    candidates: &[String],
    dest: &Path,
    min_bytes: u64,
    on_progress: &mut Progress<'_>,
) -> Result<()> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| AppError(e.to_string()))?;

    let mut last_err = String::from("未尝试任何下载源");
    for (i, url) in candidates.iter().enumerate() {
        let _ = std::fs::remove_file(dest);
        match attempt(&client, url, dest, min_bytes, i, on_progress).await {
            Ok(()) => return Ok(()),
            Err(e) => {
                last_err = e.0;
                let _ = std::fs::remove_file(dest);
            }
        }
    }
    Err(AppError(last_err))
}

async fn attempt(
    client: &reqwest::Client,
    url: &str,
    dest: &Path,
    min_bytes: u64,
    source: usize,
    on_progress: &mut Progress<'_>,
) -> Result<()> {
    let mut resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| AppError(format!("请求失败: {e}")))?
        .error_for_status()
        .map_err(|e| AppError(format!("HTTP 状态异常: {e}")))?;
    let total = resp.content_length();
    let mut file = tokio::fs::File::create(dest).await.map_err(AppError::from)?;

    let mut downloaded: u64 = 0;
    let mut last_emit = Instant::now() - EMIT_INTERVAL;
    loop {
        let chunk = tokio::time::timeout(STALL_TIMEOUT, resp.chunk())
            .await
            .map_err(|_| AppError("下载停滞超时".into()))?
            .map_err(|e| AppError(format!("读取失败: {e}")))?;
        let Some(bytes) = chunk else { break };
        file.write_all(&bytes).await.map_err(AppError::from)?;
        downloaded += bytes.len() as u64;
        if last_emit.elapsed() >= EMIT_INTERVAL {
            last_emit = Instant::now();
            on_progress(source, downloaded, total);
        }
    }
    file.flush().await.map_err(AppError::from)?;

    // A mirror answering 200 with an HTML error page must not pass.
    if downloaded < min_bytes {
        return Err(AppError(format!(
            "下载内容过小（{downloaded} 字节），疑似错误页"
        )));
    }
    on_progress(source, downloaded, Some(downloaded.max(total.unwrap_or(0))));
    Ok(())
}
