use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Child;
use std::time::{Duration, Instant};

use crate::error::Result;
use crate::ffmpeg;

const THUMB_TIMEOUT: Duration = Duration::from_secs(15);

/// Return a data-URL thumbnail (base64) for the given media path, or `None` if
/// no preview is available (audio, unknown, or generation failed).
#[tauri::command]
pub async fn get_thumbnail(
    app: tauri::AppHandle,
    path: String,
    media_type: String,
) -> Result<Option<String>> {
    let path = PathBuf::from(&path);
    if !path.exists() {
        return Ok(None);
    }
    if media_type != "image" && media_type != "video" {
        return Ok(None);
    }

    // ffmpeg runs block for seconds; keep them off the async runtime workers.
    let res = tauri::async_runtime::spawn_blocking(move || match media_type.as_str() {
        "image" => image_thumbnail(&app, &path),
        _ => video_thumbnail(&app, &path),
    })
    .await
    .map_err(|e| crate::error::AppError(e.to_string()))?;
    res
}

/// Wait for a child to exit with a hard timeout; kill it when it hangs
/// (corrupt files / slow paths can stall ffmpeg indefinitely).
fn wait_with_timeout(mut child: Child, timeout: Duration) -> bool {
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Ok(None) if start.elapsed() > timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(_) => return false,
        }
    }
}

/// Run one ffmpeg invocation that writes `tmp`, then return its bytes as a
/// PNG data URL. Attempts `args` once; on failure runs `retry_args` if given.
fn render_thumbnail(
    app: &tauri::AppHandle,
    args: Vec<String>,
    retry_args: Option<Vec<String>>,
    tmp: &Path,
) -> Result<Option<String>> {
    let run = |args: Vec<String>| -> bool {
        let Ok((child, _stdout, _stderr, _drain)) = ffmpeg::spawn(app, "ffmpeg", &args) else {
            return false;
        };
        wait_with_timeout(child, THUMB_TIMEOUT) && tmp.exists()
    };

    if !run(args) {
        let _ = std::fs::remove_file(tmp);
        let retried = match retry_args {
            Some(retry) => run(retry),
            None => false,
        };
        if !retried {
            let _ = std::fs::remove_file(tmp);
            return Ok(None);
        }
    }

    let mut buf = Vec::new();
    let read = std::fs::File::open(tmp).ok().and_then(|mut f| f.read_to_end(&mut buf).ok());
    let _ = std::fs::remove_file(tmp);
    match read {
        Some(_) if !buf.is_empty() => {
            Ok(Some(format!("data:image/png;base64,{}", base64_encode(&buf))))
        }
        _ => Ok(None),
    }
}

fn image_thumbnail(app: &tauri::AppHandle, path: &Path) -> Result<Option<String>> {
    let tmp = temp_png("mediatool_imgthumb");
    let args: Vec<String> = vec![
        "-i".into(),
        path.to_string_lossy().to_string(),
        "-frames:v".into(),
        "1".into(),
        "-vf".into(),
        "scale=320:-2".into(),
        "-y".into(),
        tmp.to_string_lossy().to_string(),
    ];
    // Images need no retry pass.
    render_thumbnail(app, args, None, &tmp)
}

fn video_thumbnail(app: &tauri::AppHandle, path: &Path) -> Result<Option<String>> {
    let tmp = temp_png("mediatool_thumb");
    let args: Vec<String> = vec![
        "-ss".into(),
        "1".into(),
        "-i".into(),
        path.to_string_lossy().to_string(),
        "-frames:v".into(),
        "1".into(),
        "-vf".into(),
        "scale=320:-2".into(),
        "-y".into(),
        tmp.to_string_lossy().to_string(),
    ];
    // Retry without fast-seek (short clips where 1s is past the end).
    let retry: Vec<String> = vec![
        "-i".into(),
        path.to_string_lossy().to_string(),
        "-frames:v".into(),
        "1".into(),
        "-vf".into(),
        "scale=320:-2".into(),
        "-y".into(),
        tmp.to_string_lossy().to_string(),
    ];
    render_thumbnail(app, args, Some(retry), &tmp)
}

fn temp_png(prefix: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "{}_{}.png",
        prefix,
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ))
}

fn base64_encode(input: &[u8]) -> String {
    const CHARS: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((input.len() + 2) / 3 * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(CHARS[((triple >> 18) & 63) as usize] as char);
        out.push(CHARS[((triple >> 12) & 63) as usize] as char);
        if chunk.len() > 1 {
            out.push(CHARS[((triple >> 6) & 63) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(CHARS[(triple & 63) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}
