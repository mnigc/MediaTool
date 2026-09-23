//! Smoke tests for the upload module: pure helpers plus a WebDAV transfer
//! against a local fake server, exercising the real streaming path.

use super::*;
use std::sync::mpsc::Receiver;

fn noop_progress() -> ProgressFn {
    Arc::new(|_, _, _| {})
}

const MiB: u64 = 1024 * 1024;

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

/* ── OAuth grant registry (web-mode callback) ─────────────── */

fn flow() -> OauthFlow {
    OauthFlow {
        kind: "youtube".into(),
        client_id: "id".into(),
        client_secret: "secret".into(),
        tenant: "common".into(),
        scope: "https://www.googleapis.com/auth/youtube.upload",
        redirect_uri: "http://nas:8787/oauth/callback".into(),
        verifier: "v".into(),
        proxy: None,
    }
}

#[test]
fn a_state_can_only_be_claimed_once() {
    let m = OauthManager::default();
    m.offer("st1", "req-1", flow());
    assert!(m.claim_by_state("st1").is_some());
    // A reload of the callback page, or a replayed URL, must not run a second
    // exchange for the same code.
    assert!(m.claim_by_state("st1").is_none());
}

#[test]
fn claiming_by_request_withdraws_the_state_too() {
    let m = OauthManager::default();
    m.offer("st2", "req-2", flow());
    // Cancel, or the timeout timer, wins the grant first…
    assert!(m.claim_by_request("req-2").is_some());
    // …so the browser arriving later finds nothing to report against.
    assert!(m.claim_by_state("st2").is_none());
    m.finish("req-2");
    assert!(m.claim_by_request("req-2").is_none());
}

#[test]
fn unknown_state_claims_nothing() {
    let m = OauthManager::default();
    m.offer("st3", "req-3", flow());
    assert!(m.claim_by_state("guessed").is_none());
    assert!(m.claim_by_request("other").is_none());
    // Rejected lookups must not burn someone else's pending grant.
    assert!(m.claim_by_state("st3").is_some());
}

/* ── Desktop loopback OAuth, end to end ───────────────────── */

/// A shell with no browser and no directories: enough to drive `oauth_begin`,
/// with every emitted event recorded for assertions.
#[derive(Clone)]
struct TestShell {
    events: Arc<Mutex<Vec<(String, serde_json::Value)>>>,
}

struct TestEnv;

impl crate::ctx::AppEnv for TestEnv {
    fn resource_dir(&self) -> Option<PathBuf> {
        None
    }
    fn app_data_dir(&self) -> Option<PathBuf> {
        None
    }
    fn open_url(&self, _url: &str) {}
}

impl crate::ctx::Emitter for TestShell {
    fn emit(&self, event: &str, payload: serde_json::Value) {
        self.events
            .lock()
            .unwrap()
            .push((event.to_string(), payload));
    }
}

fn test_ctx() -> (Ctx, TestShell) {
    let shell = TestShell {
        events: Arc::new(Mutex::new(Vec::new())),
    };
    let ctx = Ctx::new(
        Arc::new(TestEnv),
        Arc::new(shell.clone()),
        Arc::new(crate::state::JobManager::new()),
        Arc::new(crate::ytdlp::MonitorManager::default()),
        Arc::default(),
        Arc::default(),
    );
    (ctx, shell)
}

fn wait_for_oauth_result(shell: &TestShell, request_id: &str) -> serde_json::Value {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if let Some((_, payload)) = shell.events.lock().unwrap().iter().find(|(e, p)| {
            e == "oauth-result" && p.get("requestId").and_then(|v| v.as_str()) == Some(request_id)
        }) {
            return payload.clone();
        }
        assert!(
            Instant::now() < deadline,
            "no oauth-result for {request_id}"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// The desktop path must keep working after the web callback was added: the
/// loopback listener has to catch the redirect, answer it, and report.
#[test]
fn loopback_oauth_catches_the_redirect_and_reports_it() {
    use std::io::{Read, Write};
    let (ctx, shell) = test_ctx();
    let begin = crate::block_on_owned(oauth_begin(
        ctx,
        OauthBeginRequest {
            kind: "youtube".into(),
            client_id: "test-client".into(),
            client_secret: Some("secret".into()),
            tenant: None,
            proxy: None,
        },
    ))
    .expect("oauth_begin");

    assert!(
        begin.redirect_uri.starts_with("http://127.0.0.1:"),
        "desktop must still use a loopback redirect, got {}",
        begin.redirect_uri
    );
    let state = begin
        .auth_url
        .split("state=")
        .nth(1)
        .and_then(|s| s.split('&').next())
        .expect("auth url carries state");

    let addr = begin.redirect_uri.trim_start_matches("http://");
    let mut stream = std::net::TcpStream::connect(addr).expect("loopback listener is up");
    stream
        .write_all(
            format!("GET /?code=dummy&state={state} HTTP/1.1\r\nHost: {addr}\r\n\r\n").as_bytes(),
        )
        .unwrap();
    let mut reply = String::new();
    let _ = stream.read_to_string(&mut reply);
    assert!(
        reply.starts_with("HTTP/1.1 200"),
        "listener replied: {reply}"
    );

    let result = wait_for_oauth_result(&shell, &begin.request_id);
    assert_eq!(result["ok"], serde_json::Value::Bool(false));
    // The dummy code cannot survive the real token endpoint; what matters is
    // that we got far enough to talk to it rather than bailing on the state.
    assert!(
        !result["error"]
            .as_str()
            .unwrap_or("")
            .contains("State mismatch"),
        "listener did not accept our state: {result}"
    );
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
            let Ok((stream, _)) = listener.accept() else {
                break;
            };
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
                if line
                    .to_ascii_lowercase()
                    .contains("transfer-encoding: chunked")
                {
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
    let dir =
        std::env::temp_dir().join(format!("mediatool-upload-{}-{}", name, std::process::id()));
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
    let outcome = crate::block_on_owned(upload_webdav(
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
        Some(format!("http://{addr}/media/%E5%86%92%E7%83%9F%E6%B5%8B%E8%AF%95.bin").as_str())
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
    let result = crate::block_on_owned(upload_webdav(
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

/* ── Telegram albums ──────────────────────────────────────────── */

fn upload_file(name: &str, size: u64) -> UploadFile {
    UploadFile {
        path: PathBuf::from(name),
        size,
        name: name.to_string(),
    }
}

#[test]
fn telegram_shape_follows_format_then_size() {
    assert_eq!(TgShape::of("clip.mp4", MiB), TgShape::Video);
    assert_eq!(TgShape::of("frame.png", MiB), TgShape::Photo);
    // What Telegram can't render inline stays a document …
    assert_eq!(TgShape::of("clip.mkv", MiB), TgShape::Document);
    assert_eq!(TgShape::of("notes.txt", MiB), TgShape::Document);
    // … including an image past the bot's photo ceiling, which would otherwise
    // fail the send outright.
    assert_eq!(
        TgShape::of("big.png", TELEGRAM_PHOTO_LIMIT + 1),
        TgShape::Document
    );
    assert_eq!(
        TgShape::of("big.mp4", TELEGRAM_BOT_LIMIT + 1),
        TgShape::Document
    );
}

#[test]
fn telegram_plan_keeps_documents_out_of_the_album() {
    let files = vec![
        upload_file("cover.jpg", MiB),
        upload_file("clip.mp4", 8 * MiB),
        upload_file("notes.txt", MiB),
    ];
    let (album, docs) = tg_plan(&files);
    assert_eq!(album.len(), 2, "photo and video share one album");
    assert_eq!(docs.len(), 1, "a document gets its own message");
    assert_eq!(docs[0].0.name, "notes.txt");
}
