use std::path::Path;

use crate::ctx::AppEnv;
use crate::error::{AppError, Result};
use crate::ffmpeg;
use crate::models::{MediaInfo, MediaType};

/// Probe a media file using ffprobe. Blocking; call within spawn_blocking.
pub fn probe_sync(env: &dyn AppEnv, path: &str) -> Result<MediaInfo> {
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
    let (child, stdout, _stderr_buf, _drain) = ffmpeg::spawn(env, "ffprobe", &args)?;
    let out = read_stdout_timeout(child, stdout, std::time::Duration::from_secs(30))?;

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
    let mut hdr = false;

    if let Some(streams) = v.get("streams").and_then(|s| s.as_array()) {
        for s in streams {
            let kind = s.get("codec_type").and_then(|c| c.as_str()).unwrap_or("");
            match kind {
                "video" => {
                    has_video = true;
                    video_codec = s
                        .get("codec_name")
                        .and_then(|c| c.as_str())
                        .map(String::from);
                    width = s.get("width").and_then(|w| w.as_u64()).map(|w| w as u32);
                    height = s.get("height").and_then(|h| h.as_u64()).map(|h| h as u32);
                    // HDR10 (smpte2084) and HLG (arib-std-b67) transfers; DV
                    // sources expose the same transfer on their base layer.
                    let transfer = s
                        .get("color_transfer")
                        .and_then(|c| c.as_str())
                        .unwrap_or("");
                    let primaries = s
                        .get("color_primaries")
                        .and_then(|c| c.as_str())
                        .unwrap_or("");
                    if transfer == "smpte2084"
                        || transfer == "arib-std-b67"
                        || primaries == "bt2020"
                    {
                        hdr = true;
                    }
                }
                "audio" => {
                    has_audio = true;
                    audio_codec = s
                        .get("codec_name")
                        .and_then(|c| c.as_str())
                        .map(String::from);
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
        hdr,
    })
}

/// Read a child's stdout to EOF with a hard timeout. On timeout the child is
/// killed and an error returned — corrupt files or slow/network paths can
/// otherwise hang ffprobe forever.
pub(crate) fn read_stdout_timeout(
    child: std::process::Child,
    stdout: std::process::ChildStdout,
    timeout: std::time::Duration,
) -> Result<String> {
    use std::sync::mpsc;
    use std::sync::{Arc, Mutex};

    let child = Arc::new(Mutex::new(child));
    let (tx, rx) = mpsc::channel::<std::io::Result<Vec<u8>>>();
    let child_in_thread = child.clone();
    std::thread::spawn(move || {
        let mut stdout = stdout;
        let mut buf = Vec::new();
        let res = std::io::Read::read_to_end(&mut stdout, &mut buf);
        let _ = tx.send(res.map(|_| buf));
        if let Ok(mut c) = child_in_thread.lock() {
            let _ = c.wait();
        }
    });

    match rx.recv_timeout(timeout) {
        Ok(Ok(bytes)) => Ok(String::from_utf8_lossy(&bytes).to_string()),
        Ok(Err(e)) => Err(AppError(format!("ffprobe 读取失败: {}", e))),
        Err(_) => {
            if let Ok(mut c) = child.lock() {
                let _ = c.kill();
            }
            Err(AppError(
                "ffprobe 读取超时（文件可能已损坏，或位于慢速/网络介质上）".into(),
            ))
        }
    }
}

/// Async wrapper around the blocking probe.
pub async fn probe(env: std::sync::Arc<dyn AppEnv>, path: &str) -> Result<MediaInfo> {
    let path = path.to_string();
    let inner = tokio::task::spawn_blocking(move || probe_sync(&*env, &path))
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
