//! Post-processing uploads: after a job or download finishes, its output can
//! be pushed to a user-configured target — WebDAV (坚果云/NAS/Alist), a
//! Telegram bot chat, YouTube, Google Drive or OneDrive.
//!
//! Uploads are async tasks like jobs: the backend owns the transfer (streaming
//! with progress, cancellation, OAuth refresh) and reports on the
//! `upload-progress` / `upload-done` events. Credentials live on the frontend
//! (localStorage) and are passed per request; the backend never persists them.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine as _;
use bytes::Bytes;
use futures_util::Stream;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

use crate::ctx::{emit, Ctx, Emitter};
use crate::error::{AppError, Result};

/* ── Models ─────────────────────────────────────────────────────── */

/// One upload destination, as configured on the settings page. Fields are
/// optional because the shape differs per kind; required ones are validated
/// in `validate` before anything is spawned.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetConfig {
    /// "webdav" | "telegram" | "youtube" | "gdrive" | "onedrive"
    pub kind: String,
    pub url: Option<String>,
    pub username: Option<String>,
    pub password: Option<String>,
    /// WebDAV remote directory / OneDrive remote folder path.
    pub directory: Option<String>,
    pub bot_token: Option<String>,
    pub chat_id: Option<String>,
    pub client_id: Option<String>,
    pub client_secret: Option<String>,
    pub refresh_token: Option<String>,
    /// OneDrive tenant ("common" / "consumers" / an org id).
    pub tenant: Option<String>,
    /// Google Drive parent folder id (empty = My Drive root).
    pub folder_id: Option<String>,
    /// YouTube privacy: "private" | "unlisted" | "public".
    pub privacy: Option<String>,
    pub description: Option<String>,
    /// Optional proxy URL (http:// or socks5://), e.g. for Telegram/YouTube.
    pub proxy: Option<String>,
}

impl TargetConfig {
    fn validate(&self) -> std::result::Result<(), String> {
        match self.kind.as_str() {
            "webdav" => {
                if self.url.as_deref().map(str::trim).unwrap_or("").is_empty() {
                    return Err("WebDAV URL is required".into());
                }
            }
            "telegram" => {
                if self
                    .bot_token
                    .as_deref()
                    .map(str::trim)
                    .unwrap_or("")
                    .is_empty()
                {
                    return Err("Telegram bot token is required".into());
                }
                if self
                    .chat_id
                    .as_deref()
                    .map(str::trim)
                    .unwrap_or("")
                    .is_empty()
                {
                    return Err("Telegram chat id is required".into());
                }
            }
            "youtube" | "gdrive" => {
                self.validate_google()?;
            }
            "onedrive" => {
                if self
                    .client_id
                    .as_deref()
                    .map(str::trim)
                    .unwrap_or("")
                    .is_empty()
                {
                    return Err("Client id is required".into());
                }
                if self
                    .refresh_token
                    .as_deref()
                    .map(str::trim)
                    .unwrap_or("")
                    .is_empty()
                {
                    return Err("Account is not authorized yet".into());
                }
            }
            other => return Err(format!("Unknown upload target kind: {other}")),
        }
        Ok(())
    }

    fn validate_google(&self) -> std::result::Result<(), String> {
        if self
            .client_id
            .as_deref()
            .map(str::trim)
            .unwrap_or("")
            .is_empty()
        {
            return Err("Client id is required".into());
        }
        if self
            .client_secret
            .as_deref()
            .map(str::trim)
            .unwrap_or("")
            .is_empty()
        {
            return Err("Client secret is required".into());
        }
        if self
            .refresh_token
            .as_deref()
            .map(str::trim)
            .unwrap_or("")
            .is_empty()
        {
            return Err("Account is not authorized yet".into());
        }
        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadRequest {
    pub target: TargetConfig,
    pub file_path: String,
    /// Remote/display name; defaults to the file's own name.
    pub name: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadStartResult {
    pub id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UploadProgressEvent {
    id: String,
    percent: f64,
    uploaded_bytes: u64,
    total_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UploadDoneEvent {
    id: String,
    ok: bool,
    cancelled: bool,
    error: Option<String>,
    /// Watch/page link when the target provides one.
    url: Option<String>,
    /// Rotated refresh token (OAuth targets) the frontend must persist.
    new_refresh_token: Option<String>,
}

/* ── OAuth models ───────────────────────────────────────────────── */

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OauthBeginRequest {
    /// "youtube" | "gdrive" | "onedrive"
    pub kind: String,
    pub client_id: String,
    pub client_secret: Option<String>,
    pub tenant: Option<String>,
    pub proxy: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OauthBeginResult {
    pub request_id: String,
    pub auth_url: String,
    /// The exact redirect URI to register in the provider console. Desktop
    /// uses a loopback address (Google allows any port on `127.0.0.1`,
    /// Microsoft on `localhost`); the web server uses its own hosted
    /// `<publicUrl>/oauth/callback`, which must be registered verbatim.
    pub redirect_uri: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OauthResultEvent {
    request_id: String,
    kind: String,
    ok: bool,
    error: Option<String>,
    refresh_token: Option<String>,
}

/// What a browser needs to know after the provider redirected back: whether
/// the grant was stored, and why not. Rendering is the shell's business.
#[derive(Debug, Clone)]
pub struct OauthCallbackReply {
    pub ok: bool,
    pub error: Option<String>,
}

impl OauthCallbackReply {
    fn fail(error: impl Into<String>) -> Self {
        Self {
            ok: false,
            error: Some(error.into()),
        }
    }
}

/// Everything the token endpoint needs beyond the one-time authorization code.
#[derive(Clone)]
struct OauthFlow {
    kind: String,
    client_id: String,
    client_secret: String,
    tenant: String,
    scope: &'static str,
    redirect_uri: String,
    verifier: String,
    proxy: Option<String>,
}

/// A parked flow plus the request id its UI is waiting on.
struct Grant {
    request_id: String,
    flow: OauthFlow,
}

/* ── State ──────────────────────────────────────────────────────── */

/// Cancellation flags of in-flight uploads, mirroring JobManager's pattern.
#[derive(Default)]
pub struct UploadManager {
    cancelled: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl UploadManager {
    pub fn register(&self, id: &str, flag: Arc<AtomicBool>) {
        self.cancelled.lock().unwrap().insert(id.to_string(), flag);
    }
    pub fn finish(&self, id: &str) {
        self.cancelled.lock().unwrap().remove(id);
    }
}

/// Pending browser-OAuth authorizations.
///
/// Two shapes, because the redirect has nowhere to go in a container: desktop
/// only needs a cancellation flag for its loopback listener thread, while the
/// web server keeps the full exchange state under the `state` parameter and
/// waits for its own callback route to hand the code back.
#[derive(Default)]
pub struct OauthManager {
    cancelled: Mutex<HashMap<String, Arc<AtomicBool>>>,
    grants: Mutex<HashMap<String, Grant>>,
    /// `state` per pending request id, so cancel and timeout can withdraw a
    /// grant without a reverse index.
    states: Mutex<HashMap<String, String>>,
}

impl OauthManager {
    pub fn register(&self, id: &str, flag: Arc<AtomicBool>) {
        self.cancelled.lock().unwrap().insert(id.to_string(), flag);
    }
    pub fn finish(&self, id: &str) {
        self.cancelled.lock().unwrap().remove(id);
        self.states.lock().unwrap().remove(id);
    }

    /// Park a grant for the hosted callback to pick up.
    fn offer(&self, state: &str, request_id: &str, flow: OauthFlow) {
        self.grants.lock().unwrap().insert(
            state.to_string(),
            Grant {
                request_id: request_id.to_string(),
                flow,
            },
        );
        self.states
            .lock()
            .unwrap()
            .insert(request_id.to_string(), state.to_string());
    }

    /// Claim a grant by `state`. Single use on purpose: whoever claims first
    /// owns the outcome, so a replayed callback and the timeout timer cannot
    /// both report a result for the same request.
    fn claim_by_state(&self, state: &str) -> Option<Grant> {
        self.grants.lock().unwrap().remove(state)
    }

    /// Claim a grant by request id, used by the timeout timer and by cancel.
    fn claim_by_request(&self, request_id: &str) -> Option<Grant> {
        let state = self.states.lock().unwrap().get(request_id).cloned()?;
        self.grants.lock().unwrap().remove(&state)
    }
}

/// How long a browser OAuth flow may stay unfinished before it is dropped.
const OAUTH_TIMEOUT: Duration = Duration::from_secs(300);

fn uuid(prefix: &str) -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}-{:x}-{}-{}", nanos, std::process::id(), n)
}

/* ── Commands ───────────────────────────────────────────────────── */

pub async fn upload_start(ctx: Ctx, request: UploadRequest) -> Result<UploadStartResult> {
    request.target.validate().map_err(AppError)?;
    let path = PathBuf::from(&request.file_path);
    let meta = tokio::fs::metadata(&path)
        .await
        .map_err(|e| AppError(format!("Cannot read {}: {e}", request.file_path)))?;
    if !meta.is_file() {
        return Err(AppError(format!("Not a file: {}", request.file_path)));
    }
    let size = meta.len();
    let id = uuid("up");
    let flag = Arc::new(AtomicBool::new(false));
    ctx.uploads.register(&id, flag.clone());
    let name = request
        .name
        .clone()
        .unwrap_or_else(|| file_name(&request.file_path));
    let spawn_id = id.clone();
    tokio::task::spawn(async move {
        run_upload(ctx, spawn_id, request.target, path, size, name, flag).await;
    });
    Ok(UploadStartResult { id })
}

pub fn cancel_upload(ctx: Ctx, id: String) {
    if let Some(flag) = ctx.uploads.cancelled.lock().unwrap().get(&id) {
        flag.store(true, Ordering::Relaxed);
    }
}

pub async fn oauth_begin(ctx: Ctx, request: OauthBeginRequest) -> Result<OauthBeginResult> {
    let kind = request.kind.clone();
    match kind.as_str() {
        "youtube" | "gdrive" | "onedrive" => {}
        other => return Err(AppError(format!("Unsupported OAuth kind: {other}"))),
    }

    // Where the provider sends the browser back to. A desktop app can open a
    // loopback port the same browser can reach; a container cannot — its
    // 127.0.0.1 is not the user's, so the redirect goes to a page the web
    // server itself serves and matches back to this request via `state`.
    let hosted_base = ctx
        .env
        .oauth_redirect_base()
        .map(|b| b.trim_end_matches('/').to_string());
    let loopback = match &hosted_base {
        Some(_) => None,
        None => {
            let listener = std::net::TcpListener::bind(("127.0.0.1", 0))
                .map_err(|e| AppError(format!("Cannot bind loopback port: {e}")))?;
            let port = listener
                .local_addr()
                .map_err(|e| AppError(e.to_string()))?
                .port();
            // Google registers the loopback host without a port (any runtime
            // port is allowed); Microsoft does the same for `localhost`.
            Some(match kind.as_str() {
                "youtube" | "gdrive" => (listener, format!("http://127.0.0.1:{port}")),
                _ => (listener, format!("http://localhost:{port}")),
            })
        }
    };
    let redirect_uri = match (&hosted_base, &loopback) {
        (Some(base), _) => format!("{base}/oauth/callback"),
        (_, Some((_, uri))) => uri.clone(),
        (None, None) => return Err(AppError("Shell has no OAuth redirect path".into())),
    };

    let verifier = random_token(64);
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(Sha256::digest(verifier.as_bytes()));
    // In web mode this is the only capability the callback route gets, so it
    // carries the same entropy as the PKCE verifier rather than a short nonce.
    let state = random_token(32);

    let scope = match kind.as_str() {
        "youtube" => "https://www.googleapis.com/auth/youtube.upload",
        "gdrive" => "https://www.googleapis.com/auth/drive.file",
        _ => "files.readwrite offline_access",
    };
    let auth_url = match kind.as_str() {
        "youtube" | "gdrive" => format!(
            "https://accounts.google.com/o/oauth2/v2/auth?client_id={}&redirect_uri={}&response_type=code&scope={}&access_type=offline&prompt=consent&state={}&code_challenge={}&code_challenge_method=S256",
            enc(&request.client_id),
            enc(&redirect_uri),
            enc(scope),
            enc(&state),
            enc(&challenge),
        ),
        _ => {
            let tenant = request.tenant.as_deref().filter(|t| !t.is_empty()).unwrap_or("common");
            format!(
                "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize?client_id={}&response_type=code&redirect_uri={}&response_mode=query&scope={}&state={}&code_challenge={}&code_challenge_method=S256",
                enc(&request.client_id),
                enc(&redirect_uri),
                enc(scope),
                enc(&state),
                enc(&challenge),
            )
        }
    };

    let flow = OauthFlow {
        kind: kind.clone(),
        client_id: request.client_id.clone(),
        client_secret: request.client_secret.clone().unwrap_or_default(),
        tenant: request
            .tenant
            .clone()
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| "common".into()),
        scope,
        redirect_uri: redirect_uri.clone(),
        verifier,
        proxy: request.proxy.clone(),
    };

    let request_id = uuid("oa");
    let flag = Arc::new(AtomicBool::new(false));
    ctx.oauth.register(&request_id, flag.clone());

    // Open the consent page; in a headless shell `open_url` logs the URL and
    // the web UI opens it itself.
    ctx.env.open_url(&auth_url);

    match loopback {
        // The browser comes back to this loopback listener; the listener dies
        // after one code, a cancellation, or a 5-minute timeout.
        Some((listener, _)) => {
            let ctx2 = ctx.clone();
            let ev_id = request_id.clone();
            let ev_state = state.clone();
            let ev_flag = flag.clone();
            std::thread::spawn(move || {
                wait_on_loopback(ctx2, listener, &ev_state, ev_flag, ev_id, flow);
            });
        }
        None => {
            ctx.oauth.offer(&state, &request_id, flow.clone());
            // Nobody may ever come back with the code: expire the request out
            // loud, the way the loopback listener times out on its own.
            let ctx2 = ctx.clone();
            let ev_id = request_id.clone();
            let ev_kind = kind.clone();
            tokio::spawn(async move {
                tokio::time::sleep(OAUTH_TIMEOUT).await;
                if ctx2.oauth.claim_by_request(&ev_id).is_some() {
                    report_oauth_result(
                        &ctx2,
                        &ev_id,
                        &ev_kind,
                        Err("Authorization timed out".into()),
                    );
                }
            });
        }
    }

    Ok(OauthBeginResult {
        request_id,
        auth_url,
        redirect_uri,
    })
}

/// Handle a provider redirect that arrived at the shell's own callback route.
/// `code` and `error` are the two shapes the providers send; `state` picks the
/// pending request. Safe to call from a blocking context.
pub fn oauth_complete(
    ctx: &Ctx,
    state: &str,
    code: Option<&str>,
    error: Option<&str>,
) -> OauthCallbackReply {
    let Some(grant) = ctx.oauth.claim_by_state(state) else {
        // Unknown/expired state, or someone already used it. Nothing here can
        // tell which, and the distinction only helps an attacker probing.
        return OauthCallbackReply::fail("This authorization request is no longer pending");
    };
    let Grant { request_id, flow } = grant;
    let outcome = match (code, error) {
        (Some(code), _) => exchange_oauth_code(&flow, code),
        (None, Some(error)) => Err(format!("The provider refused the request: {error}")),
        (None, None) => Err("Callback carried no authorization code".to_string()),
    };
    let reply = OauthCallbackReply {
        ok: outcome.is_ok(),
        error: outcome.clone().err(),
    };
    // The app that started the flow is watching `oauth-result`, not this page.
    report_oauth_result(ctx, &request_id, &flow.kind, outcome);
    reply
}

/// Report one OAuth outcome and retire the request.
fn report_oauth_result(
    ctx: &Ctx,
    request_id: &str,
    kind: &str,
    outcome: std::result::Result<String, String>,
) {
    let (ok, error, refresh_token) = match outcome {
        Ok(rt) => (true, None, Some(rt)),
        Err(e) => (false, Some(e), None),
    };
    emit(
        ctx.emitter.as_ref(),
        "oauth-result",
        &OauthResultEvent {
            request_id: request_id.to_string(),
            kind: kind.to_string(),
            ok,
            error,
            refresh_token,
        },
    );
    ctx.oauth.finish(request_id);
}

pub fn oauth_cancel(ctx: Ctx, request_id: String) {
    // Loopback: wake the listener thread. Hosted: drop the grant so a late
    // callback finds nothing pending.
    if let Some(flag) = ctx.oauth.cancelled.lock().unwrap().get(&request_id) {
        flag.store(true, Ordering::Relaxed);
    }
    if ctx.oauth.claim_by_request(&request_id).is_some() {
        ctx.oauth.finish(&request_id);
    }
}

/* ── Dispatcher ─────────────────────────────────────────────────── */

async fn run_upload(
    ctx: Ctx,
    id: String,
    target: TargetConfig,
    path: PathBuf,
    size: u64,
    name: String,
    flag: Arc<AtomicBool>,
) {
    let progress = make_progress(&ctx, &id);
    let outcome = upload_dispatch(&progress, &target, &path, size, &name, &flag).await;
    // The cancel flag is the source of truth: a wrapped stream error surfaces
    // as a generic transport error, but the flag tells us why it stopped.
    let was_cancelled = flag.load(Ordering::Relaxed);
    let event = match outcome {
        Ok(outcome) => UploadDoneEvent {
            id: id.clone(),
            ok: true,
            cancelled: false,
            error: None,
            url: outcome.url,
            new_refresh_token: outcome.new_refresh_token,
        },
        Err(e) => UploadDoneEvent {
            id: id.clone(),
            ok: false,
            cancelled: was_cancelled,
            error: Some(if was_cancelled {
                "Upload cancelled".into()
            } else {
                e.0
            }),
            url: None,
            new_refresh_token: None,
        },
    };
    ctx.uploads.finish(&id);
    emit(ctx.emitter.as_ref(), "upload-done", &event);
}

/// Shared result of a successful transfer: a link when the platform has one,
/// plus a possibly rotated refresh token to hand back to the frontend.
struct UploadOutcome {
    url: Option<String>,
    new_refresh_token: Option<String>,
}

async fn upload_dispatch(
    progress: &ProgressFn,
    target: &TargetConfig,
    path: &Path,
    size: u64,
    name: &str,
    flag: &Arc<AtomicBool>,
) -> std::result::Result<UploadOutcome, AppError> {
    progress(0.0, 0, size);
    match target.kind.as_str() {
        "webdav" => upload_webdav(progress, target, path, size, name, flag).await,
        "telegram" => upload_telegram(progress, target, path, size, name, flag).await,
        "youtube" => upload_youtube(progress, target, path, size, name, flag).await,
        "gdrive" => upload_gdrive(progress, target, path, size, name, flag).await,
        "onedrive" => upload_onedrive(progress, target, path, size, name, flag).await,
        other => Err(AppError(format!("Unknown upload target kind: {other}"))),
    }
    .map(|(url, rt)| UploadOutcome {
        url,
        new_refresh_token: rt,
    })
}

fn check_cancelled(flag: &AtomicBool) -> std::result::Result<(), AppError> {
    if flag.load(Ordering::Relaxed) {
        Err(AppError("cancelled".into()))
    } else {
        Ok(())
    }
}

/* ── WebDAV ─────────────────────────────────────────────────────── */

async fn upload_webdav(
    progress: &ProgressFn,
    target: &TargetConfig,
    path: &Path,
    size: u64,
    name: &str,
    flag: &Arc<AtomicBool>,
) -> std::result::Result<(Option<String>, Option<String>), AppError> {
    let base = target.url.as_deref().unwrap_or("").trim_end_matches('/');
    let client = build_client(target.proxy.as_deref())?;
    let mut auth = reqwest::header::HeaderMap::new();
    if !target.username.as_deref().unwrap_or("").is_empty()
        || !target.password.as_deref().unwrap_or("").is_empty()
    {
        let cred = format!(
            "{}:{}",
            target.username.as_deref().unwrap_or(""),
            target.password.as_deref().unwrap_or("")
        );
        auth.insert(
            reqwest::header::AUTHORIZATION,
            format!(
                "Basic {}",
                base64::engine::general_purpose::STANDARD.encode(cred.as_bytes())
            )
            .parse()
            .map_err(|e| AppError(format!("{e}")))?,
        );
    }

    let remote = remote_path(&target.directory, name);
    let url = format!("{base}{remote}");

    let webdav_put = |client: reqwest::Client, url: String, auth: reqwest::header::HeaderMap| {
        let path = path.to_path_buf();
        let flag = flag.clone();
        let progress = progress.clone();
        async move {
            let file = tokio::fs::File::open(&path)
                .await
                .map_err(|e| AppError(format!("Cannot open file: {e}")))?;
            let stream = file_stream(file).boxed();
            let counted = CountingStream::new(stream, size, progress, flag);
            let resp = client
                .put(&url)
                .headers(auth)
                .header(reqwest::header::CONTENT_TYPE, mime_for(name))
                .body(reqwest::Body::wrap_stream(counted))
                .send()
                .await?;
            Ok::<_, AppError>(resp)
        }
    };

    let mut resp = webdav_put(client.clone(), url.clone(), auth.clone()).await?;
    // Missing parent collection: create the whole chain, then retry once.
    if resp.status().as_u16() == 409 {
        for ancestor in ancestor_dirs(&target.directory) {
            let mk = format!("{base}{ancestor}");
            let _ = client
                .request(reqwest::Method::from_bytes(b"MKCOL").unwrap(), &mk)
                .headers(auth.clone())
                .send()
                .await;
        }
        resp = webdav_put(client, url.clone(), auth).await?;
    }
    let status = resp.status().as_u16();
    if !(200..=207).contains(&status) {
        return Err(AppError(format!(
            "WebDAV upload failed: HTTP {status} — {}",
            tail(&resp.text().await.unwrap_or_default(), 300)
        )));
    }
    progress(100.0, size, size);
    Ok((Some(url), None))
}

/* ── Telegram ───────────────────────────────────────────────────── */

const TELEGRAM_BOT_LIMIT: u64 = 50 * 1024 * 1024;

async fn upload_telegram(
    progress: &ProgressFn,
    target: &TargetConfig,
    path: &Path,
    size: u64,
    name: &str,
    flag: &Arc<AtomicBool>,
) -> std::result::Result<(Option<String>, Option<String>), AppError> {
    if size > TELEGRAM_BOT_LIMIT {
        return Err(AppError(format!(
            "Telegram Bot API 限制 50 MB（此文件 {}）；更大文件可用本地 Bot API server 或改用其他目标",
            format_size(size)
        )));
    }
    let token = target.bot_token.as_deref().unwrap_or("");
    let chat = target.chat_id.as_deref().unwrap_or("");
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|e| AppError(format!("Cannot read file: {e}")))?;

    let boundary = format!("mediatool{}", uuid("b"));
    let mut head = Vec::new();
    for (field, value) in [("chat_id", chat)] {
        head.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{field}\"\r\n\r\n{value}\r\n").as_bytes());
    }
    head.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"document\"; filename=\"{}\"; filename*=utf-8''{}\r\nContent-Type: {}\r\n\r\n",
            ascii_fallback_name(name),
            enc(name),
            mime_for(name)
        )
        .as_bytes(),
    );
    let mut tail_part = Vec::new();
    tail_part.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    let total = (head.len() + bytes.len() + tail_part.len()) as u64;

    let head_bytes = Bytes::from(head);
    let file_bytes = Bytes::from(bytes);
    let tail_bytes = Bytes::from(tail_part);
    let stream = futures_util::stream::iter(vec![Ok(head_bytes)])
        .chain(futures_util::stream::iter(
            file_bytes
                .chunks(512 * 1024)
                .map(Bytes::copy_from_slice)
                .map(Ok)
                .collect::<Vec<_>>(),
        ))
        .chain(futures_util::stream::iter(vec![Ok(tail_bytes)]))
        .boxed();
    let counted = CountingStream::new(stream, total, progress.clone(), flag.clone());

    let client = build_client(target.proxy.as_deref())?;
    let resp = client
        .post(format!("https://api.telegram.org/bot{token}/sendDocument"))
        .header(
            reqwest::header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={boundary}"),
        )
        .body(reqwest::Body::wrap_stream(counted))
        .send()
        .await?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(AppError(format!(
            "Telegram upload failed: HTTP {} — {}",
            status.as_u16(),
            tail(&text, 300)
        )));
    }
    let v: serde_json::Value = serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);
    if v.get("ok").and_then(|x| x.as_bool()) != Some(true) {
        return Err(AppError(format!(
            "Telegram error: {}",
            v.get("description")
                .and_then(|x| x.as_str())
                .unwrap_or("unknown")
        )));
    }
    let link = v
        .pointer("/result/chat/username")
        .and_then(|u| u.as_str())
        .zip(v.pointer("/result/message_id").and_then(|m| m.as_i64()))
        .map(|(u, m)| format!("https://t.me/{u}/{m}"));
    progress(100.0, total, total);
    Ok((link, None))
}

/* ── YouTube ────────────────────────────────────────────────────── */

async fn upload_youtube(
    progress: &ProgressFn,
    target: &TargetConfig,
    path: &Path,
    size: u64,
    name: &str,
    flag: &Arc<AtomicBool>,
) -> std::result::Result<(Option<String>, Option<String>), AppError> {
    let client = build_client(target.proxy.as_deref())?;
    let title = strip_extension(name).to_string();
    let privacy = match target.privacy.as_deref() {
        Some("public") => "public",
        Some("unlisted") => "unlisted",
        _ => "private",
    };
    let meta = serde_json::json!({
        "snippet": {
            "title": title,
            "description": target.description.as_deref().unwrap_or(""),
            "categoryId": "22",
        },
        "status": {
            "privacyStatus": privacy,
            "selfDeclaredMadeForKids": false,
        },
    });
    let init = |access: &str| {
        client
            .post("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status")
            .bearer_auth(access)
            .header(reqwest::header::CONTENT_TYPE, "application/json; charset=UTF-8")
            .header("X-Upload-Content-Length", size.to_string())
            .header("X-Upload-Content-Type", mime_for(name))
            .json(&meta)
            .send()
    };
    let access = google_access_token(client.clone(), target).await?;
    let resp = init(&access).await?;
    // 401 on init: refresh once and replay the init call.
    let resp = if resp.status().as_u16() == 401 {
        let access = google_access_token(client.clone(), target).await?;
        init(&access).await?
    } else {
        resp
    };
    let status = resp.status();
    if !status.is_success() {
        return Err(AppError(format!(
            "YouTube init failed: HTTP {} — {}",
            status.as_u16(),
            tail(&resp.text().await.unwrap_or_default(), 300)
        )));
    }
    let session = resp
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| AppError("YouTube did not return an upload session".into()))?
        .to_string();
    let final_resp = google_resumable(progress, client, &session, path, size, flag).await?;
    let v: serde_json::Value = serde_json::from_str(&final_resp)
        .map_err(|e| AppError(format!("Bad YouTube response: {e}")))?;
    let vid = v
        .get("id")
        .and_then(|x| x.as_str())
        .ok_or_else(|| AppError("YouTube response has no video id".into()))?;
    Ok((Some(format!("https://www.youtube.com/watch?v={vid}")), None))
}

/* ── Google Drive ───────────────────────────────────────────────── */

async fn upload_gdrive(
    progress: &ProgressFn,
    target: &TargetConfig,
    path: &Path,
    size: u64,
    name: &str,
    flag: &Arc<AtomicBool>,
) -> std::result::Result<(Option<String>, Option<String>), AppError> {
    let client = build_client(target.proxy.as_deref())?;
    let access = google_access_token(client.clone(), target).await?;
    let mut meta = serde_json::json!({ "name": name });
    if let Some(folder) = target.folder_id.as_deref().filter(|f| !f.trim().is_empty()) {
        meta["parents"] = serde_json::json!([folder.trim()]);
    }
    let init = client
        .post("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,webViewLink,size")
        .bearer_auth(&access)
        .header(reqwest::header::CONTENT_TYPE, "application/json; charset=UTF-8")
        .header("X-Upload-Content-Length", size.to_string())
        .header("X-Upload-Content-Type", mime_for(name))
        .json(&meta)
        .send()
        .await?;
    let status = init.status();
    if !status.is_success() {
        return Err(AppError(format!(
            "Google Drive init failed: HTTP {} — {}",
            status.as_u16(),
            tail(&init.text().await.unwrap_or_default(), 300)
        )));
    }
    let session = init
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| AppError("Google Drive did not return an upload session".into()))?
        .to_string();
    let final_resp = google_resumable(progress, client, &session, path, size, flag).await?;
    let v: serde_json::Value = serde_json::from_str(&final_resp)
        .map_err(|e| AppError(format!("Bad Google Drive response: {e}")))?;
    let link = v
        .get("webViewLink")
        .and_then(|x| x.as_str())
        .map(str::to_string)
        .or_else(|| {
            v.get("id")
                .and_then(|x| x.as_str())
                .map(|fid| format!("https://drive.google.com/file/d/{fid}/view"))
        });
    Ok((link, None))
}

/* ── OneDrive (Microsoft Graph) ─────────────────────────────────── */

async fn upload_onedrive(
    progress: &ProgressFn,
    target: &TargetConfig,
    path: &Path,
    size: u64,
    name: &str,
    flag: &Arc<AtomicBool>,
) -> std::result::Result<(Option<String>, Option<String>), AppError> {
    let client = build_client(target.proxy.as_deref())?;
    let mut rotated: Option<String> = None;
    let mut access = microsoft_access_token(client.clone(), target, &mut rotated).await?;

    let remote = remote_path(&target.directory, name);
    // /me/drive/root:{path}:/createUploadSession — `{path}` includes the
    // leading slash and the encoded file name.
    let url =
        format!("https://graph.microsoft.com/v1.0/me/drive/root:{remote}:/createUploadSession");
    let body = serde_json::json!({
        "item": {
            "@microsoft.graph.conflictBehavior": "rename",
            "name": name,
        }
    });
    let mut resp = client
        .post(&url)
        .bearer_auth(&access)
        .json(&body)
        .send()
        .await?;
    if resp.status().as_u16() == 401 {
        access = microsoft_access_token(client.clone(), target, &mut rotated).await?;
        resp = client
            .post(&url)
            .bearer_auth(&access)
            .json(&body)
            .send()
            .await?;
    }
    let status = resp.status();
    if !status.is_success() {
        return Err(AppError(format!(
            "OneDrive session failed: HTTP {} — {}",
            status.as_u16(),
            tail(&resp.text().await.unwrap_or_default(), 300)
        )));
    }
    let v: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| AppError(format!("Bad OneDrive response: {e}")))?;
    let upload_url = v
        .get("uploadUrl")
        .and_then(|x| x.as_str())
        .ok_or_else(|| AppError("OneDrive did not return an uploadUrl".into()))?
        .to_string();

    // The upload session URL is pre-authenticated — no Authorization header
    // here. Chunks must be multiples of 320 KiB (except the last).
    const CHUNK: usize = 5 * 1024 * 1024;
    let mut offset: u64 = 0;
    let mut no_progress = 0u32;
    let mut file = open_seeker(path).await?;
    while offset < size {
        check_cancelled(flag)?;
        let end = std::cmp::min(offset + CHUNK as u64, size);
        let chunk = read_chunk(&mut file, offset, (end - offset) as usize).await?;
        let cr = format!("bytes {}-{}/{}", offset, end - 1, size);
        let resp = client
            .put(&upload_url)
            .header(reqwest::header::CONTENT_RANGE, cr)
            .body(chunk)
            .send()
            .await?;
        let status = resp.status().as_u16();
        if status == 401 {
            return Err(AppError("OneDrive session expired mid-upload".into()));
        }
        if !(200..300).contains(&status) && status != 416 {
            return Err(AppError(format!(
                "OneDrive chunk failed: HTTP {status} — {}",
                tail(&resp.text().await.unwrap_or_default(), 300)
            )));
        }
        let v: serde_json::Value = resp.json().await.unwrap_or(serde_json::Value::Null);
        if status == 416 {
            // Range already covered — resync from the server's expectation.
            if let Some(next) = next_expected(&v) {
                if next > offset {
                    offset = next;
                    no_progress = 0;
                    continue;
                }
            }
        }
        if let Some(next) = next_expected(&v) {
            if next == offset {
                no_progress += 1;
                if no_progress > 5 {
                    return Err(AppError("OneDrive upload made no progress".into()));
                }
            } else {
                no_progress = 0;
                offset = next;
            }
        } else if status == 200 || status == 201 {
            offset = size;
        } else {
            offset = end;
        }
        progress(offset as f64 / size as f64 * 100.0, offset, size);
    }
    progress(100.0, size, size);
    Ok((None, rotated))
}

fn next_expected(v: &serde_json::Value) -> Option<u64> {
    v.get("nextExpectedRanges")
        .and_then(|r| r.get(0))
        .and_then(|s| s.as_str())
        .and_then(|s| s.split('-').next())
        .and_then(|s| s.parse::<u64>().ok())
}

/* ── Google OAuth + resumable core ──────────────────────────────── */

/// Refresh the Google access token.
async fn google_access_token(client: reqwest::Client, target: &TargetConfig) -> Result<String> {
    #[derive(Deserialize)]
    #[serde(rename_all = "snake_case")]
    struct Tok {
        access_token: String,
    }
    let resp = client
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("client_id", target.client_id.as_deref().unwrap_or("")),
            (
                "client_secret",
                target.client_secret.as_deref().unwrap_or(""),
            ),
            (
                "refresh_token",
                target.refresh_token.as_deref().unwrap_or(""),
            ),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .await?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    let v: serde_json::Value = serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);
    if !status.is_success() {
        return Err(AppError(format!(
            "Google token refresh failed: {}",
            v.get("error_description")
                .and_then(|x| x.as_str())
                .or_else(|| v.get("error").and_then(|x| x.as_str()))
                .unwrap_or("unknown")
        )));
    }
    let tok: Tok = serde_json::from_value(v).map_err(|e| AppError(format!("{e}")))?;
    Ok(tok.access_token)
}

async fn microsoft_access_token(
    client: reqwest::Client,
    target: &TargetConfig,
    rotated: &mut Option<String>,
) -> Result<String> {
    let tenant = target
        .tenant
        .as_deref()
        .filter(|t| !t.trim().is_empty())
        .unwrap_or("common")
        .trim();
    let endpoint = format!("https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token");
    let resp = client
        .post(&endpoint)
        .form(&[
            ("client_id", target.client_id.as_deref().unwrap_or("")),
            (
                "refresh_token",
                target.refresh_token.as_deref().unwrap_or(""),
            ),
            ("scope", "files.readwrite offline_access"),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .await?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    let v: serde_json::Value = serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);
    if !status.is_success() {
        return Err(AppError(format!(
            "Microsoft token refresh failed: {}",
            v.get("error_description")
                .and_then(|x| x.as_str())
                .unwrap_or("unknown")
        )));
    }
    let access = v
        .get("access_token")
        .and_then(|x| x.as_str())
        .ok_or_else(|| AppError("Microsoft response has no access_token".into()))?
        .to_string();
    if let Some(rt) = v.get("refresh_token").and_then(|x| x.as_str()) {
        *rotated = Some(rt.to_string());
    }
    Ok(access)
}

/// Drive-style resumable upload: fixed-size chunks (multiples of 256 KiB),
/// 308 + `Range` between chunks, 2xx at the end. The session URI is
/// pre-authenticated, so no Authorization header is needed on chunk PUTs.
async fn google_resumable(
    progress: &ProgressFn,
    client: reqwest::Client,
    session: &str,
    path: &Path,
    size: u64,
    flag: &Arc<AtomicBool>,
) -> Result<String> {
    const CHUNK: u64 = 8 * 1024 * 1024;
    let mut offset: u64 = 0;
    let mut no_progress = 0u32;
    let mut file = open_seeker(path).await?;
    while offset < size {
        check_cancelled(flag)?;
        let end = std::cmp::min(offset + CHUNK, size);
        let chunk = read_chunk(&mut file, offset, (end - offset) as usize).await?;
        let cr = format!("bytes {offset}-{}/{size}", end - 1);
        let resp = client
            .put(session)
            .header(reqwest::header::CONTENT_RANGE, &cr)
            .body(chunk)
            .send()
            .await?;
        let status = resp.status().as_u16();
        if status == 308 {
            let next = resp
                .headers()
                .get(reqwest::header::RANGE)
                .and_then(|v| v.to_str().ok())
                .and_then(parse_range_end);
            match next {
                Some(n) if n + 1 > offset => {
                    offset = n + 1;
                    no_progress = 0;
                }
                _ => {
                    no_progress += 1;
                    if no_progress > 5 {
                        return Err(AppError("Upload made no progress".into()));
                    }
                }
            }
            progress(offset as f64 / size as f64 * 100.0, offset, size);
            continue;
        }
        if status == 401 {
            return Err(AppError("Google session expired mid-upload".into()));
        }
        if !(200..300).contains(&status) {
            return Err(AppError(format!(
                "Upload failed: HTTP {status} — {}",
                tail(&resp.text().await.unwrap_or_default(), 300)
            )));
        }
        let text = resp.text().await.unwrap_or_default();
        progress(100.0, size, size);
        return Ok(text);
    }
    // size == 0: a single finalizing PUT with the zero-length range.
    let resp = client
        .put(session)
        .header(reqwest::header::CONTENT_RANGE, format!("bytes */{size}"))
        .send()
        .await?;
    let status = resp.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(AppError(format!("Upload failed: HTTP {status}")));
    }
    Ok(resp.text().await.unwrap_or_default())
}

fn parse_range_end(v: &str) -> Option<u64> {
    let s = v.trim().strip_prefix("bytes=")?;
    let end = s.rsplit('-').next()?;
    end.trim().parse().ok()
}

/* ── OAuth code exchange + loopback plumbing ────────────────────── */

/// Drive a desktop loopback listener until the browser returns with a code.
/// Exits after one code, a cancellation, or [`OAUTH_TIMEOUT`].
fn wait_on_loopback(
    ctx: Ctx,
    listener: std::net::TcpListener,
    state: &str,
    flag: Arc<AtomicBool>,
    request_id: String,
    flow: OauthFlow,
) {
    let _ = listener.set_nonblocking(true);
    let deadline = Instant::now() + OAUTH_TIMEOUT;
    loop {
        if flag.load(Ordering::Relaxed) {
            ctx.oauth.finish(&request_id);
            return;
        }
        if Instant::now() > deadline {
            report_oauth_result(
                &ctx,
                &request_id,
                &flow.kind,
                Err("Authorization timed out".into()),
            );
            return;
        }
        match listener.accept() {
            Ok((stream, _)) => {
                let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                let Some((code, got_state)) = read_oauth_callback(&stream) else {
                    // Favicon or random GET: acknowledge and keep waiting.
                    let _ = write_simple_404(&stream);
                    continue;
                };
                let outcome = if got_state != state {
                    Err("State mismatch — please retry from the app".to_string())
                } else {
                    exchange_oauth_code(&flow, &code)
                };
                let _ = write_oauth_reply(&stream, outcome.is_ok());
                report_oauth_result(&ctx, &request_id, &flow.kind, outcome);
                return;
            }
            Err(_) => std::thread::sleep(Duration::from_millis(100)),
        }
    }
}

fn exchange_oauth_code(flow: &OauthFlow, code: &str) -> std::result::Result<String, String> {
    let mut form: Vec<(&str, &str)> = vec![
        ("code", code),
        ("client_id", &flow.client_id),
        ("redirect_uri", &flow.redirect_uri),
        ("grant_type", "authorization_code"),
        ("code_verifier", &flow.verifier),
    ];
    let endpoint;
    if flow.kind == "onedrive" {
        endpoint = format!(
            "https://login.microsoftonline.com/{}/oauth2/v2.0/token",
            flow.tenant
        );
        form.push(("scope", flow.scope));
    } else {
        endpoint = "https://oauth2.googleapis.com/token".to_string();
        form.push(("client_secret", &flow.client_secret));
    }
    let proxy = flow.proxy.clone();
    let fut = async {
        let client = build_client(proxy.as_deref()).map_err(|e| e.to_string())?;
        let resp = client
            .post(&endpoint)
            .form(&form)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        let v: serde_json::Value = serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);
        if !status.is_success() {
            return Err(v
                .get("error_description")
                .or_else(|| v.get("error"))
                .and_then(|x| x.as_str())
                .unwrap_or("token exchange failed")
                .to_string());
        }
        v.get("refresh_token")
            .and_then(|x| x.as_str())
            .map(str::to_string)
            .ok_or_else(|| {
                "No refresh token returned — make sure to pick the account on the consent screen (Google requires prompt=consent; re-run the login)".to_string()
            })
    };
    crate::block_on_owned(fut)
}

/// Read one GET from the loopback connection and extract `code`/`state`.
fn read_oauth_callback(stream: &std::net::TcpStream) -> Option<(String, String)> {
    use std::io::Read;
    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    let mut stream = stream;
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.windows(4).any(|w| w == b"\r\n\r\n") || buf.len() > 16 * 1024 {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let text = String::from_utf8_lossy(&buf);
    let line = text.lines().next()?;
    let target = line.split_whitespace().nth(1)?;
    let query = target.split('?').nth(1)?;
    let mut code = None;
    let mut state = None;
    for pair in query.split('&') {
        let (k, v) = pair.split_once('=')?;
        match k {
            "code" => code = Some(v.to_string()),
            "state" => state = Some(v.to_string()),
            _ => {}
        }
    }
    Some((code?, state.unwrap_or_default()))
}

fn write_oauth_reply(stream: &std::net::TcpStream, ok: bool) -> std::io::Result<()> {
    let body = if ok {
        "<html><body style=\"font-family:sans-serif;text-align:center;padding-top:4rem\"><h2>✅ 授权完成</h2><p>请回到 MediaTool。</p><p style=\"color:#888\">Authorization complete — you can close this tab.</p></body></html>"
    } else {
        "<html><body style=\"font-family:sans-serif;text-align:center;padding-top:4rem\"><h2>❌ 授权失败</h2><p>请回到 MediaTool 重试。</p><p style=\"color:#888\">Authorization failed — please retry from MediaTool.</p></body></html>"
    };
    use std::io::Write;
    let mut stream = stream;
    stream.write_all(
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        )
        .as_bytes(),
    )?;
    stream.flush()
}

fn write_simple_404(stream: &std::net::TcpStream) -> std::io::Result<()> {
    use std::io::Write;
    let mut stream = stream;
    stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
}

/* ── Shared helpers ─────────────────────────────────────────────── */

fn build_client(proxy: Option<&str>) -> Result<reqwest::Client> {
    let mut b = reqwest::Client::builder().connect_timeout(Duration::from_secs(30));
    if let Some(p) = proxy.map(str::trim).filter(|p| !p.is_empty()) {
        let p = reqwest::Proxy::all(p).map_err(|e| AppError(format!("Bad proxy: {e}")))?;
        b = b.proxy(p);
    }
    b.build().map_err(|e| AppError(format!("HTTP client: {e}")))
}

/// Progress sink shared by every platform uploader: `(percent, uploaded, total)`.
/// Production wires it to the `upload-progress` event; tests use a recorder.
type ProgressFn = Arc<dyn Fn(f64, u64, u64) + Send + Sync>;

fn make_progress(ctx: &Ctx, id: &str) -> ProgressFn {
    let id = id.to_string();
    let emitter = ctx.emitter.clone();
    Arc::new(move |pct, uploaded, total| emit_progress(emitter.as_ref(), &id, pct, uploaded, total))
}

fn emit_progress(emitter: &dyn Emitter, id: &str, percent: f64, uploaded: u64, total: u64) {
    emit(
        emitter,
        "upload-progress",
        &UploadProgressEvent {
            id: id.to_string(),
            percent,
            uploaded_bytes: uploaded,
            total_bytes: total,
        },
    );
}

/// Reads a file as fixed-size chunks and reports progress through
/// `CountingStream`; aborted as soon as the cancel flag is set.
fn file_stream(file: tokio::fs::File) -> impl Stream<Item = std::io::Result<bytes::Bytes>> {
    const PIECE: usize = 256 * 1024;
    futures_util::stream::unfold((file, vec![0u8; PIECE]), |(mut f, mut buf)| async move {
        match f.read(&mut buf).await {
            Ok(0) => None,
            Ok(n) => Some((Ok(bytes::Bytes::copy_from_slice(&buf[..n])), (f, buf))),
            Err(e) => Some((Err(e), (f, buf))),
        }
    })
}

/// Wraps a byte stream: counts transferred bytes, throttles progress events,
/// and fails fast when the upload is cancelled.
struct CountingStream<S> {
    inner: S,
    total: u64,
    sent: u64,
    last_emit: Instant,
    progress: ProgressFn,
    flag: Arc<AtomicBool>,
}

impl<S> CountingStream<S> {
    fn new(inner: S, total: u64, progress: ProgressFn, flag: Arc<AtomicBool>) -> Self {
        Self {
            inner,
            total,
            sent: 0,
            last_emit: Instant::now() - Duration::from_millis(400),
            progress,
            flag,
        }
    }
}

impl<S> Stream for CountingStream<S>
where
    S: Stream<Item = std::io::Result<bytes::Bytes>> + Unpin,
{
    type Item = std::io::Result<bytes::Bytes>;

    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        if self.flag.load(Ordering::Relaxed) {
            return std::task::Poll::Ready(Some(Err(std::io::Error::other("cancelled"))));
        }
        match std::pin::Pin::new(&mut self.inner).poll_next(cx) {
            std::task::Poll::Ready(Some(Ok(bytes))) => {
                self.sent += bytes.len() as u64;
                let pct = if self.total > 0 {
                    self.sent as f64 / self.total as f64 * 100.0
                } else {
                    0.0
                };
                let now = Instant::now();
                if now.duration_since(self.last_emit) > Duration::from_millis(200)
                    || self.sent == self.total
                {
                    self.last_emit = now;
                    (self.progress)(pct, self.sent, self.total);
                }
                std::task::Poll::Ready(Some(Ok(bytes)))
            }
            other => other,
        }
    }
}

async fn open_seeker(path: &Path) -> Result<tokio::fs::File> {
    tokio::fs::File::open(path)
        .await
        .map_err(|e| AppError(format!("Cannot open file: {e}")))
}

async fn read_chunk(file: &mut tokio::fs::File, offset: u64, len: usize) -> Result<bytes::Bytes> {
    file.seek(std::io::SeekFrom::Start(offset))
        .await
        .map_err(|e| AppError(format!("Seek failed: {e}")))?;
    let mut buf = vec![0u8; len];
    file.read_exact(&mut buf)
        .await
        .map_err(|e| AppError(format!("Read failed: {e}")))?;
    Ok(bytes::Bytes::from(buf))
}

/// Remote path joined as `/dir/subdir/name`, percent-encoded per segment.
fn remote_path(directory: &Option<String>, name: &str) -> String {
    let mut out = String::new();
    if let Some(dir) = directory
        .as_deref()
        .map(str::trim)
        .filter(|d| !d.is_empty())
    {
        for seg in dir.split('/') {
            if seg.is_empty() || seg == "." {
                continue;
            }
            if seg == ".." {
                continue;
            }
            out.push('/');
            out.push_str(&enc(seg));
        }
    }
    out.push('/');
    out.push_str(&enc(name));
    out
}

fn ancestor_dirs(directory: &Option<String>) -> Vec<String> {
    let mut out = Vec::new();
    let mut acc = String::new();
    if let Some(dir) = directory.as_deref() {
        for seg in dir.split('/') {
            if seg.is_empty() || seg == "." || seg == ".." {
                continue;
            }
            acc.push('/');
            acc.push_str(&enc(seg));
            out.push(acc.clone());
        }
    }
    out
}

/// Percent-encode everything outside the RFC 3986 unreserved set.
fn enc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn file_name(p: &str) -> String {
    let norm = p.replace('\\', "/");
    norm.rsplit('/').next().unwrap_or("file").to_string()
}

fn mime_for(name: &str) -> &'static str {
    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "mp4" | "m4v" => "video/mp4",
        "mkv" => "video/x-matroska",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "avi" => "video/x-msvideo",
        "ts" => "video/mp2t",
        "flv" => "video/x-flv",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "opus" => "audio/opus",
        "flac" => "audio/flac",
        "wav" => "audio/wav",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => "application/octet-stream",
    }
}

/// ASCII-safe filename for a Content-Disposition header byte string.
fn ascii_fallback_name(name: &str) -> String {
    if name.is_ascii() && !name.is_empty() {
        return name.to_string();
    }
    match name.rsplit('.').next() {
        Some(ext)
            if ext.is_ascii()
                && !ext.is_empty()
                && ext.len() <= 5
                && ext.contains(|c: char| c.is_ascii_alphanumeric()) =>
        {
            format!("upload.{ext}")
        }
        _ => "upload.bin".to_string(),
    }
}

/// Strip a short trailing extension (`clip.mp4` → `clip`) for display names.
fn strip_extension(name: &str) -> &str {
    match name.rsplit_once('.') {
        Some((stem, ext))
            if !stem.is_empty()
                && ext.len() <= 5
                && ext.chars().all(|c| c.is_ascii_alphanumeric()) =>
        {
            stem
        }
        _ => name,
    }
}

fn format_size(n: u64) -> String {
    let units = ["B", "KB", "MB", "GB", "TB"];
    let mut v = n as f64;
    let mut i = 0;
    while v >= 1024.0 && i < units.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    format!("{v:.1} {}", units[i])
}

fn tail(s: &str, max_bytes: usize) -> String {
    let s = s.trim();
    if s.len() <= max_bytes {
        return s.to_string();
    }
    let mut start = s.len() - max_bytes;
    while !s.is_char_boundary(start) {
        start += 1;
    }
    s[start..].to_string()
}

fn random_token(len: usize) -> String {
    use rand::Rng;
    const CHARSET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    let mut rng = rand::thread_rng();
    (0..len)
        .map(|_| CHARSET[rng.gen_range(0..CHARSET.len())] as char)
        .collect()
}

#[cfg(test)]
#[path = "upload_tests.rs"]
mod tests;
