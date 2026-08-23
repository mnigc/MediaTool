use std::io::Read;
use std::path::Path;

use serde_json::Value;
use tauri::AppHandle;

use crate::error::{AppError, Result};
use crate::ffmpeg;
use crate::models::{MediaReport, StreamReport};

fn s<'a>(v: &'a Value, key: &str) -> Option<String> {
    v.get(key)?.as_str().map(String::from)
}

fn n<T: std::str::FromStr>(v: &Value, key: &str) -> Option<T> {
    v.get(key)?.as_str()?.parse::<T>().ok()
}

fn parse_stream(raw: &Value) -> StreamReport {
    let kind = s(raw, "codec_type").unwrap_or_default();
    let tags = raw.get("tags").cloned().unwrap_or(Value::Null);
    let language = tags
        .get("language")
        .and_then(|l| l.as_str())
        .map(String::from);
    let bitrate_kbps = n::<u64>(raw, "bit_rate").map(|b| b / 1000);
    // Some formats report bit_rate only in stats tags (e.g. attached pics).
    StreamReport {
        index: raw.get("index").and_then(|i| i.as_i64()).unwrap_or(0),
        kind,
        codec_name: s(raw, "codec_name"),
        codec_long: s(raw, "codec_long_name"),
        profile: s(raw, "profile"),
        pix_fmt: s(raw, "pix_fmt"),
        width: raw.get("width").and_then(|w| w.as_u64()).map(|w| w as u32),
        height: raw.get("height").and_then(|h| h.as_u64()).map(|h| h as u32),
        avg_frame_rate: s(raw, "avg_frame_rate")
            .filter(|r| r != "0/0"),
        sample_rate: n::<u64>(raw, "sample_rate"),
        channels: raw
            .get("channels")
            .and_then(|c| c.as_u64())
            .map(|c| c as u32),
        channel_layout: s(raw, "channel_layout"),
        bitrate_kbps,
        language,
        tags,
    }
}

pub fn inspect_sync(app: &AppHandle, path: &str) -> Result<MediaReport> {
    if !Path::new(path).exists() {
        return Err(AppError("文件不存在".into()));
    }
    let size_bytes = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);

    let args = vec![
        "-v".to_string(),
        "quiet".to_string(),
        "-print_format".to_string(),
        "json".to_string(),
        "-show_format".to_string(),
        "-show_streams".to_string(),
        "-show_chapters".to_string(),
        path.to_string(),
    ];
    let (_child, stdout, _stderr_buf) = ffmpeg::spawn(app, "ffprobe", &args)?;

    let mut out = String::new();
    let mut reader = std::io::BufReader::new(stdout);
    reader.read_to_string(&mut out)?;
    let v: Value = serde_json::from_str(&out)?;

    let format = v.get("format").cloned().unwrap_or(Value::Null);
    let streams = v
        .get("streams")
        .and_then(|s| s.as_array())
        .map(|arr| arr.iter().map(parse_stream).collect())
        .unwrap_or_else(Vec::new);
    let chapter_count = v
        .get("chapters")
        .and_then(|c| c.as_array())
        .map(|a| a.len())
        .unwrap_or(0);

    Ok(MediaReport {
        path: path.to_string(),
        size_bytes,
        format_name: s(&format, "format_name").filter(|f| f != "unknown"),
        format_long: s(&format, "format_long_name"),
        duration_secs: n::<f64>(&format, "duration"),
        bitrate_kbps: n::<u64>(&format, "bit_rate").map(|b| b / 1000),
        tags: format.get("tags").cloned().unwrap_or(Value::Null),
        streams,
        chapter_count,
    })
}

/// Async wrapper around the blocking inspection.
pub async fn inspect(app: AppHandle, path: String) -> Result<MediaReport> {
    let inner = tauri::async_runtime::spawn_blocking(move || inspect_sync(&app, &path))
        .await
        .map_err(|e| AppError(e.to_string()))?;
    inner
}
