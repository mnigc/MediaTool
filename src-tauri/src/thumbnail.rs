use std::io::Read;
use std::path::{Path, PathBuf};

use crate::error::Result;
use crate::ffmpeg;

/// Return a data-URL thumbnail (base64) for the given media path, or `None` if
/// no preview is available (audio, unknown, or generation failed).
#[tauri::command]
pub async fn get_thumbnail(app: tauri::AppHandle, path: String, media_type: String) -> Result<Option<String>> {
    let path = PathBuf::from(&path);
    if !path.exists() {
        return Ok(None);
    }

    match media_type.as_str() {
        "image" => Ok(image_thumbnail(&path)),
        "video" => video_thumbnail(&app, &path),
        _ => Ok(None),
    }
}

fn mime_for_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        Some("bmp") => "image/bmp",
        Some("avif") => "image/avif",
        _ => "image/png",
    }
}

fn image_thumbnail(path: &Path) -> Option<String> {
    let mut buf = Vec::new();
    if std::fs::File::open(path).ok()?.read_to_end(&mut buf).is_err() {
        return None;
    }
    let mime = mime_for_path(path);
    let b64 = base64_encode(&buf);
    Some(format!("data:{};base64,{}", mime, b64))
}

fn video_thumbnail(app: &tauri::AppHandle, path: &Path) -> Result<Option<String>> {
    let tmp = std::env::temp_dir().join(format!(
        "mediapress_thumb_{}.png",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));

    let args: Vec<String> = vec![
        "-ss".into(),
        "1".into(),
        "-i".into(),
        path.to_string_lossy().to_string(),
        "-frames:v".into(),
        "1".into(),
        "-vf".into(),
        "scale=320:-1".into(),
        "-y".into(),
        tmp.to_string_lossy().to_string(),
    ];

    let (mut child, _stdout, _stderr) = ffmpeg::spawn(app, "ffmpeg", &args)?;
    let code = child.wait().map(|s| s.code().unwrap_or(-1)).unwrap_or(-1);
    if code != 0 || !tmp.exists() {
        let _ = std::fs::remove_file(&tmp);
        // Fall back: try without fast-seek (short clips).
        let args2: Vec<String> = vec![
            "-i".into(),
            path.to_string_lossy().to_string(),
            "-frames:v".into(),
            "1".into(),
            "-vf".into(),
            "scale=320:-1".into(),
            "-y".into(),
            tmp.to_string_lossy().to_string(),
        ];
        let (mut child2, _s2, _e2) = ffmpeg::spawn(app, "ffmpeg", &args2)?;
        let c2 = child2.wait().map(|s| s.code().unwrap_or(-1)).unwrap_or(-1);
        if c2 != 0 || !tmp.exists() {
            let _ = std::fs::remove_file(&tmp);
            return Ok(None);
        }
    }

    let mut buf = Vec::new();
    match std::fs::File::open(&tmp).ok().and_then(|mut f| f.read_to_end(&mut buf).ok()) {
        Some(_) => {
            let _ = std::fs::remove_file(&tmp);
            let b64 = base64_encode(&buf);
            Ok(Some(format!("data:image/png;base64,{}", b64)))
        }
        None => {
            let _ = std::fs::remove_file(&tmp);
            Ok(None)
        }
    }
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
