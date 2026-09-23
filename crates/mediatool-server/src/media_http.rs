//! Byte-range media streaming for the browser shell's rough-cut preview.
//!
//! A `<video>` element cannot set an Authorization header, so the token rides
//! in the query string — the same LAN-grade compromise as the WebSocket
//! handshake — and the path is resolved against the allowlisted roots before
//! any byte is read. Seeking in a player fires Range requests, which are
//! answered with 206 + Content-Range; everything else streams whole.

use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use tokio_util::io::ReaderStream;

use crate::rpc::AppState;

#[derive(Deserialize)]
pub struct MediaQuery {
    path: String,
}

fn mime_of(path: &std::path::Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "mp4" | "m4v" => "video/mp4",
        "mkv" => "video/x-matroska",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "ts" | "mpeg" | "mpg" => "video/mp2t",
        "avi" => "video/x-msvideo",
        "flv" => "video/x-flv",
        "wmv" => "video/x-ms-wmv",
        "3gp" => "video/3gpp",
        "mp3" => "audio/mpeg",
        "aac" => "audio/aac",
        "m4a" => "audio/mp4",
        "opus" | "ogg" => "audio/ogg",
        "flac" => "audio/flac",
        "wav" => "audio/wav",
        _ => "application/octet-stream",
    }
}

/// One parsed Range request: bytes [start, end] inclusive.
struct ByteRange {
    start: u64,
    end: u64,
}

/// Parse the single-range subset of RFC 9110 (`bytes=start-end`, `bytes=start-`,
/// `bytes=-suffix`). Multi-range requests fall back to serving the whole file.
fn parse_range(value: &str, len: u64) -> Option<ByteRange> {
    let spec = value.strip_prefix("bytes=")?.split(',').next()?.trim();
    let (first, last) = spec.split_once('-')?;
    if first.is_empty() {
        // suffix form: the final N bytes
        let n: u64 = last.trim().parse().ok()?;
        if n == 0 {
            return None;
        }
        let start = len.checked_sub(n.min(len))?;
        return Some(ByteRange {
            start,
            end: len - 1,
        });
    }
    let start: u64 = first.trim().parse().ok()?;
    let end = match last.trim().parse::<u64>() {
        Ok(e) => e.min(len - 1),
        Err(_) => len - 1,
    };
    if start > end {
        return None;
    }
    Some(ByteRange { start, end })
}

pub async fn stream(
    State(state): State<Arc<AppState>>,
    Query(q): Query<MediaQuery>,
    headers: HeaderMap,
) -> Response {
    // Canonicalise + allowlist: only files under a configured media root can
    // ever leave the server, whatever path string arrives.
    let roots = state.roots.clone();
    let path = match tokio::task::spawn_blocking(move || roots.resolve(&q.path)).await {
        Ok(Ok(p)) => p,
        Ok(Err(e)) => {
            let msg = e.0;
            return (StatusCode::BAD_REQUEST, msg).into_response();
        }
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("路径解析失败: {e}"),
            )
                .into_response()
        }
    };

    let meta = match tokio::fs::metadata(&path).await {
        Ok(m) if m.is_file() => m,
        _ => return (StatusCode::NOT_FOUND, "文件不存在".to_string()).into_response(),
    };
    let len = meta.len();
    let mime = mime_of(&path);

    let range = headers
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| parse_range(v, len));

    let mut file = match tokio::fs::File::open(&path).await {
        Ok(f) => f,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("文件打开失败: {e}"),
            )
                .into_response()
        }
    };

    let mut builder = Response::builder().header(header::CONTENT_TYPE, mime);
    match range {
        Some(ByteRange { start, end }) => {
            use std::io::SeekFrom;
            use tokio::io::AsyncSeekExt;
            if file.seek(SeekFrom::Start(start)).await.is_err() {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "文件定位失败".to_string(),
                )
                    .into_response();
            }
            let chunk = end - start + 1;
            builder = builder
                .status(StatusCode::PARTIAL_CONTENT)
                .header(
                    header::CONTENT_RANGE,
                    format!("bytes {start}-{end}/{len}"),
                )
                .header(header::CONTENT_LENGTH, chunk)
                .header(header::ACCEPT_RANGES, "bytes");
        }
        None => {
            builder = builder
                .status(StatusCode::OK)
                .header(header::CONTENT_LENGTH, len)
                .header(header::ACCEPT_RANGES, "bytes");
        }
    }

    builder
        .body(Body::from_stream(ReaderStream::new(file)))
        .unwrap_or_else(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response())
}
