//! Smoke tests for the upload module: pure helpers plus a WebDAV transfer
//! against a local fake server, exercising the real streaming path.

use super::*;
use std::sync::mpsc::Receiver;

fn noop_progress() -> ProgressFn {
    Arc::new(|_, _, _| {})
}

/* ── pure helpers ─────────────────────────────────────────── */

#[test]
fn enc_percent_encodes_unsafe_bytes() {
    assert_eq!(enc("a b/c"), "a%20b%2Fc");
    assert_eq!(enc("视频.mp4"), "%E8%A7%86%E9%A2%91.mp4");
    assert_eq!(enc("safe-name_1.0~"), "safe-name_1.0~");
}

#[test]
fn remote_path_joins_and_encodes() {
    let dir = Some("a/b".to_string());
    assert_eq!(remote_path(&dir, "clip.mp4"), "/a/b/clip.mp4");
    let cn = Some("视频".to_string());
    assert_eq!(
        remote_path(&cn, "片段.mp4"),
        "/%E8%A7%86%E9%A2%91/%E7%89%87%E6%AE%B5.mp4"
    );
    assert_eq!(remote_path(&None, "x.bin"), "/x.bin");
}

#[test]
fn ancestor_dirs_builds_chain() {
    let dir = Some("a/b".to_string());
    assert_eq!(ancestor_dirs(&dir), vec!["/a", "/a/b"]);
    assert!(ancestor_dirs(&None).is_empty());
}

#[test]
fn parse_range_end_reads_last_segment() {
    assert_eq!(parse_range_end("bytes=0-8388607"), Some(8388607));
    assert_eq!(parse_range_end("bytes=0-0"), Some(0));
    assert_eq!(parse_range_end("junk"), None);
}

#[test]
fn strip_extension_only_strips_short_extensions() {
    assert_eq!(strip_extension("clip.mp4"), "clip");
    assert_eq!(strip_extension("我的.视频.MKV"), "我的.视频");
    assert_eq!(strip_extension("v1.2.3"), "v1.2");
    assert_eq!(strip_extension("archive.tar"), "archive");
    assert_eq!(strip_extension(".hidden"), ".hidden");
}

#[test]
fn ascii_fallback_keeps_ascii_uses_upload_for_cjk() {
    assert_eq!(ascii_fallback_name("clip.mp4"), "clip.mp4");
    assert_eq!(ascii_fallback_name("视频.mp4"), "upload.mp4");
    assert_eq!(ascii_fallback_name("视频"), "upload.bin");
}

#[test]
fn target_config_validates_required_fields() {
    let mut t = webdav_target("127.0.0.1:1".parse().unwrap());
    assert!(t.validate().is_ok());
    t.url = Some("  ".into());
    assert!(t.validate().is_err());

    let tg = TargetConfig {
        kind: "telegram".into(),
        url: None,
        username: None,
        password: None,
        directory: None,
        bot_token: Some("t".into()),
        chat_id: None,
        client_id: None,
        client_secret: None,
        refresh_token: None,
        tenant: None,
        folder_id: None,
        privacy: None,
        description: None,
        proxy: None,
    };
    assert!(tg.validate().is_err());

    let mut yt = tg.clone();
    yt.kind = "youtube".into();
    yt.client_id = Some("id".into());
    yt.client_secret = Some("secret".into());
    yt.refresh_token = Some("rt".into());
    assert!(yt.validate().is_ok());
}

/* ── WebDAV end-to-end against a local fake server ────────── */

/// Commands the scripted server handled, in order.
#[derive(Debug)]
enum Req {
    Put { path: String, body: Vec<u8> },
    Mkcol { path: String },
}

/// One-connection-per-request fake WebDAV server. `script[i]` describes the
/// expected i-th request; PUT bodies are decoded from chunked transfer
/// encoding so the test can assert on the exact uploaded bytes.
fn fake_webdav(script: Vec<(&'static str, u16)>) -> (std::net::SocketAddr, Receiver<Req>) {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let addr = listener.local_addr().unwrap();
    let (tx, rx) = std::sync::mpsc::channel::<Req>();
    std::thread::spawn(move || {
        for (kind, status) in script {
            let Ok((stream, _)) = listener.accept() else { break };
            let mut reader = std::io::BufReader::new(stream);
            use std::io::BufRead;
            let mut request_line = String::new();
            if reader.read_line(&mut request_line).is_err() {
                break;
            }
            let path = request_line
                .split_whitespace()
                .nth(1)
                .unwrap_or("/")
                .to_string();
            let mut chunked = false;
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).is_err() || line.trim().is_empty() {
                    break;
                }
                if line.to_ascii_lowercase().contains("transfer-encoding: chunked") {
                    chunked = true;
                }
            }
            let mut body = Vec::new();
            if kind == "PUT" && chunked {
                loop {
                    let mut size_line = String::new();
                    if reader.read_line(&mut size_line).is_err() {
                        break;
                    }
                    let n = usize::from_str_radix(
                        size_line.trim().split(';').next().unwrap_or("0"),
                        16,
                    )
                    .unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    let mut chunk = vec![0u8; n];
                    if std::io::Read::read_exact(&mut reader, &mut chunk).is_err() {
                        break;
                    }
                    body.extend_from_slice(&chunk);
                    let mut crlf = [0u8; 2];
                    let _ = std::io::Read::read_exact(&mut reader, &mut crlf);
                }
            }
            let mut stream = reader.into_inner();
            use std::io::Write;
            let _ = stream.write_all(
                format!("HTTP/1.1 {status} TEST\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                    .as_bytes(),
            );
            let _ = stream.flush();
            let _ = stream.shutdown(std::net::Shutdown::Write);
            let req = match kind {
                "PUT" => Req::Put { path, body },
                _ => Req::Mkcol { path },
            };
            if tx.send(req).is_err() {
                break;
            }
        }
    });
    (addr, rx)
}

fn webdav_target(addr: std::net::SocketAddr) -> TargetConfig {
    TargetConfig {
        kind: "webdav".into(),
        url: Some(format!("http://{addr}")),
        username: Some("u".into()),
        password: Some("p".into()),
        directory: Some("media".into()),
        bot_token: None,
        chat_id: None,
        client_id: None,
        client_secret: None,
        refresh_token: None,
        tenant: None,
        folder_id: None,
        privacy: None,
        description: None,
        proxy: None,
    }
}

fn temp_file(name: &str, content: &[u8]) -> (std::path::PathBuf, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!(
        "mediatool-upload-{}-{}",
        name,
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join(name);
    std::fs::write(&file, content).unwrap();
    (dir, file)
}

#[test]
fn webdav_upload_creates_parents_and_streams_body() {
    let content: Vec<u8> = (0..512 * 1024u32).map(|i| (i % 251) as u8).collect();
    let (dir, file) = temp_file("e2e.bin", &content);

    // PUT → 409 (missing collection) → MKCOL → PUT → 201.
    let (addr, rx) = fake_webdav(vec![("PUT", 409), ("MKCOL", 201), ("PUT", 201)]);

    let flag = Arc::new(AtomicBool::new(false));
    let outcome = tauri::async_runtime::block_on(upload_webdav(
        &noop_progress(),
        &webdav_target(addr),
        &file,
        content.len() as u64,
        "冒烟测试.bin",
        &flag,
    ))
    .expect("upload should succeed");

    assert_eq!(
        outcome.0.as_deref(),
        Some(
            format!("http://{addr}/media/%E5%86%92%E7%83%9F%E6%B5%8B%E8%AF%95.bin").as_str()
        )
    );

    // Request order: PUT, MKCOL for the missing parent, retried PUT.
    assert!(matches!(rx.recv().unwrap(), Req::Put { .. }));
    match rx.recv().unwrap() {
        Req::Mkcol { path } => assert_eq!(path, "/media"),
        other => panic!("expected MKCOL, got {other:?}"),
    }
    match rx.recv().unwrap() {
        Req::Put { path, body } => {
            assert_eq!(path, "/media/%E5%86%92%E7%83%9F%E6%B5%8B%E8%AF%95.bin");
            assert_eq!(body, content, "uploaded bytes must match the file");
        }
        other => panic!("expected PUT, got {other:?}"),
    }

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn webdav_upload_aborts_when_cancelled() {
    let content = vec![0u8; 4 * 1024 * 1024];
    let (dir, file) = temp_file("cancel.bin", &content);

    // The server would accept the PUT, but the flag is set up-front: the
    // counting stream must abort the transfer instead of finishing it.
    let (addr, _rx) = fake_webdav(vec![("PUT", 201)]);
    let flag = Arc::new(AtomicBool::new(true));
    let result = tauri::async_runtime::block_on(upload_webdav(
        &noop_progress(),
        &webdav_target(addr),
        &file,
        content.len() as u64,
        "cancel.bin",
        &flag,
    ));
    assert!(result.is_err(), "cancelled upload must fail");

    std::fs::remove_dir_all(&dir).ok();
}
