use std::io::Read;
use std::path::Path;

use tauri::AppHandle;

use crate::error::{AppError, Result};
use crate::ffmpeg;
use crate::models::{MediaInfo, MediaType};

/// Probe a media file using ffprobe. Blocking; call within spawn_blocking.
fn probe_sync(app: &AppHandle, path: &str) -> Result<MediaInfo> {
    let size_bytes = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);

    let args = vec![
        "-v".into(),
        "quiet".into(),
        "-print_format".into(),
        "json".into(),
        "-show_format".into(),
        "-show_streams".into(),
        path.to_string(),
    ];
    let (_child, stdout) = ffmpeg::spawn(app, "ffprobe", &args)?;

    let mut out = String::new();
    let mut reader = std::io::BufReader::new(stdout);
    reader.read_to_string(&mut out)?;
    // Ensure the child has exited.
    // (stdout EOF implies process ended; we ignore the wait result here.)

    let v: serde_json::Value = serde_json::from_str(&out)?;

    let duration_secs = v
        .get("format")
        .and_then(|f| f.get("duration"))
        .and_then(|d| d.as_str())
        .and_then(|s| s.parse::<f64>().ok());

    let bitrate_kbps = v
        .get("format")
        .and_then(|f| f.get("bit_rate"))
        .and_then(|b| b.as_str())
        .and_then(|s| s.parse::<u64>().ok())
        .map(|b| b / 1000);

    let mut width = None;
    let mut height = None;
    let mut video_codec = None;
    let mut audio_codec = None;
    let mut has_video = false;
    let mut has_audio = false;

    if let Some(streams) = v.get("streams").and_then(|s| s.as_array()) {
        for s in streams {
            let kind = s.get("codec_type").and_then(|c| c.as_str()).unwrap_or("");
            match kind {
                "video" => {
                    has_video = true;
                    video_codec = s.get("codec_name").and_then(|c| c.as_str()).map(String::from);
                    width = s.get("width").and_then(|w| w.as_u64()).map(|w| w as u32);
                    height = s.get("height").and_then(|h| h.as_u64()).map(|h| h as u32);
                }
                "audio" => {
                    has_audio = true;
                    audio_codec = s.get("codec_name").and_then(|c| c.as_str()).map(String::from);
                }
                _ => {}
            }
        }
    }

    let media_type = if let Some(mt) = guess_image_type(path) {
        mt
    } else if has_video {
        MediaType::Video
    } else if has_audio {
        MediaType::Audio
    } else {
        MediaType::Unknown
    };

    Ok(MediaInfo {
        path: path.to_string(),
        media_type,
        duration_secs,
        width,
        height,
        video_codec,
        audio_codec,
        bitrate_kbps,
        size_bytes,
    })
}

/// Async wrapper around the blocking probe.
pub async fn probe(app: &AppHandle, path: &str) -> Result<MediaInfo> {
    let app = app.clone();
    let path = path.to_string();
    let inner = tauri::async_runtime::spawn_blocking(move || probe_sync(&app, &path))
        .await
        .map_err(|e| AppError(e.to_string()))?;
    inner
}

fn guess_image_type(path: &str) -> Option<MediaType> {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase());
    match ext.as_deref() {
        Some("jpg") | Some("jpeg") | Some("png") | Some("webp") | Some("avif") | Some("bmp")
        | Some("gif") => Some(MediaType::Image),
        _ => None,
    }
}
