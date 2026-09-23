use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Child;
use std::time::{Duration, Instant};

use crate::ctx::AppEnv;
use crate::error::Result;
use crate::ffmpeg;

const THUMB_TIMEOUT: Duration = Duration::from_secs(15);
/// A 320px JPEG this small is near-certainly a black lead-in frame (black
/// compresses ~10x better than any real image); try a deeper position before
/// settling for it.
const SUSPICIOUS_THUMB_BYTES: usize = 3 * 1024;

/// Async wrapper: ffmpeg runs block for seconds; keep them off async workers.
pub async fn get_thumbnail_spawn(
    env: std::sync::Arc<dyn AppEnv>,
    path: String,
    media_type: String,
    duration_secs: Option<f64>,
) -> Result<Option<String>> {
    tokio::task::spawn_blocking(move || {
        get_thumbnail_sync(&*env, &path, &media_type, duration_secs)
    })
    .await
    .map_err(|e| crate::error::AppError(e.to_string()))?
}

/// Return a data-URL thumbnail (base64) for the given media path, or `None` if
/// no preview is available (audio, unknown, or generation failed). Blocking;
/// call within spawn_blocking.
pub fn get_thumbnail_sync(
    env: &dyn AppEnv,
    path: &str,
    media_type: &str,
    duration_secs: Option<f64>,
) -> Result<Option<String>> {
    let path = PathBuf::from(path);
    if !path.exists() {
        return Ok(None);
    }
    if media_type != "image" && media_type != "video" {
        return Ok(None);
    }
    match media_type {
        "image" => image_thumbnail(env, &path),
        _ => video_thumbnail(env, &path, duration_secs),
    }
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

/// Run each ffmpeg invocation in order, writing `tmp`, and return the first
/// output that doesn't look like a black frame as a data URL (`mime` must
/// match the container the filter writes). A suspiciously small frame is kept
/// as a fallback while later attempts run; if every attempt fails or looks
/// black, the least-bad frame still wins over no preview at all.
fn render_thumbnail(
    env: &dyn AppEnv,
    attempts: Vec<Vec<String>>,
    tmp: &Path,
    mime: &str,
) -> Result<Option<String>> {
    let mut fallback: Option<Vec<u8>> = None;
    for args in attempts {
        let _ = std::fs::remove_file(tmp);
        let Ok((child, _stdout, _stderr, _drain)) = ffmpeg::spawn(env, "ffmpeg", &args) else {
            continue;
        };
        if !wait_with_timeout(child, THUMB_TIMEOUT) || !tmp.exists() {
            continue;
        }
        let mut buf = Vec::new();
        let read = std::fs::File::open(tmp)
            .ok()
            .and_then(|mut f| f.read_to_end(&mut buf).ok());
        let _ = std::fs::remove_file(tmp);
        match read {
            Some(_) if buf.len() >= SUSPICIOUS_THUMB_BYTES => {
                return Ok(Some(format!("data:{mime};base64,{}", base64_encode(&buf))));
            }
            Some(_) if !buf.is_empty() && fallback.is_none() => fallback = Some(buf),
            _ => {}
        }
    }
    Ok(fallback.map(|buf| format!("data:{mime};base64,{}", base64_encode(&buf))))
}

/// Images stay PNG: user art (logos in the watermark tool) often carries
/// transparency, which a JPEG would flatten to black.
fn image_thumbnail(env: &dyn AppEnv, path: &Path) -> Result<Option<String>> {
    let tmp = temp_thumb("mediatool_imgthumb", "png");
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
    render_thumbnail(env, vec![args], &tmp, "image/png")
}

/// Video frames go out as JPEG: a 320px PNG frame runs ~10x larger, and these
/// are cached per download card — batches and the startup backfill pull a
/// dozen of them.
///
/// Seeking 10% in skips the black lead-in most movie files start with (frame 1
/// is black far more often than not); a second position covers titles that
/// stay dark past that, and the frame-1 fallback covers clips shorter than the
/// seek target.
fn video_thumbnail(
    env: &dyn AppEnv,
    path: &Path,
    duration_secs: Option<f64>,
) -> Result<Option<String>> {
    let tmp = temp_thumb("mediatool_thumb", "jpg");
    let p = path.to_string_lossy().to_string();
    let seek_at = |frac: f64, dflt: &str| -> String {
        match duration_secs {
            Some(d) if d > 1.0 => format!("{:.1}", (d * frac).clamp(1.0, d - 0.5)),
            _ => dflt.to_string(),
        }
    };
    let args_at = |at: &str| -> Vec<String> {
        vec![
            "-ss".into(),
            at.to_string(),
            "-i".into(),
            p.clone(),
            "-frames:v".into(),
            "1".into(),
            "-vf".into(),
            "scale=320:-2".into(),
            "-q:v".into(),
            "6".into(),
            "-y".into(),
            tmp.to_string_lossy().to_string(),
        ]
    };
    let attempts = vec![
        args_at(&seek_at(0.1, "1")),
        args_at(&seek_at(0.4, "10")),
        // Last resort: first frame (also covers files where every seek lands
        // past the last keyframe).
        vec![
            "-i".into(),
            p,
            "-frames:v".into(),
            "1".into(),
            "-vf".into(),
            "scale=320:-2".into(),
            "-q:v".into(),
            "6".into(),
            "-y".into(),
            tmp.to_string_lossy().to_string(),
        ],
    ];
    render_thumbnail(env, attempts, &tmp, "image/jpeg")
}

fn temp_thumb(prefix: &str, ext: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "{}_{}.{}",
        prefix,
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
        ext
    ))
}

/* ── Rough-cut timeline filmstrip ──────────────────────────────── */

/// Async wrapper: N evenly spaced frames for a timeline filmstrip.
pub async fn get_filmstrip_spawn(
    env: std::sync::Arc<dyn AppEnv>,
    path: String,
    count: u32,
    width: Option<u32>,
    duration_secs: Option<f64>,
) -> Result<Vec<String>> {
    tokio::task::spawn_blocking(move || {
        get_filmstrip_sync(&*env, &path, count, width, duration_secs)
    })
    .await
    .map_err(|e| crate::error::AppError(e.to_string()))?
}

/// Up to `count` JPEG frames spread across the source, as data URLs. One
/// ffmpeg pass dumps a numbered sequence into a temp dir; when the duration is
/// unknown it falls back to the first frames.
///
/// `-skip_frame nokey` is what keeps this usable on a feature-length file:
/// sampling every `d/n` seconds would otherwise decode everything in between,
/// a pass the timeout cuts off with nothing to show. Keyframes are precisely
/// the frames a filmstrip wants, so skipping the rest leaves only demuxing.
/// Frames written before a timeout are still returned.
pub fn get_filmstrip_sync(
    env: &dyn AppEnv,
    path: &str,
    count: u32,
    width: Option<u32>,
    duration_secs: Option<f64>,
) -> Result<Vec<String>> {
    let p = PathBuf::from(path);
    if !p.exists() {
        return Ok(vec![]);
    }
    let n = count.clamp(2, 32);
    let w = width.filter(|w| *w >= 16).unwrap_or(160);
    let dir = std::env::temp_dir().join(format!(
        "mediatool_strip_{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    std::fs::create_dir_all(&dir)?;

    let mut vf = match duration_secs {
        Some(d) if d > 0.0 => format!("fps={n}/{:.3},scale={w}:-2", d),
        _ => format!("scale={w}:-2"),
    };
    vf.push_str(",setpts=N/FRAME_RATE/TB");
    let pattern = dir.join("%03d.jpg");
    let args: Vec<String> = vec![
        "-skip_frame".into(),
        "nokey".into(),
        "-i".into(),
        p.to_string_lossy().to_string(),
        "-an".into(),
        "-sn".into(),
        "-vf".into(),
        vf,
        "-frames:v".into(),
        n.to_string(),
        "-q:v".into(),
        "7".into(),
        "-y".into(),
        pattern.to_string_lossy().to_string(),
    ];
    let Ok((child, _stdout, _stderr, _drain)) = ffmpeg::spawn(env, "ffmpeg", &args) else {
        let _ = std::fs::remove_dir_all(&dir);
        return Ok(vec![]);
    };
    let _ = wait_with_timeout(child, THUMB_TIMEOUT);
    // ffmpeg replaced %03d starting at 1; stop at the first gap. A killed pass
    // leaves the tail unwritten, and so does a source with too few frames.
    let mut urls = Vec::new();
    for i in 1..=n {
        let f = dir.join(format!("{i:03}.jpg"));
        match std::fs::read(&f) {
            Ok(buf) if is_complete_jpeg(&buf) => {
                urls.push(format!("data:image/jpeg;base64,{}", base64_encode(&buf)))
            }
            _ => break,
        }
    }
    let _ = std::fs::remove_dir_all(&dir);
    Ok(urls)
}

/// A frame ffmpeg was killed while writing has no end-of-image marker and
/// would render as a broken image, so it counts as missing.
fn is_complete_jpeg(buf: &[u8]) -> bool {
    buf.len() > 4 && buf.ends_with(&[0xFF, 0xD9])
}

fn base64_encode(input: &[u8]) -> String {
    const CHARS: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
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
