//! yt-dlp integration: binary management (download/update), URL probing,
//! video downloads and live-stream recording, plus the live-monitor manager
//! that polls channels and auto-records when a stream goes live.
//!
//! No HTTP client is compiled in: downloads of the yt-dlp binary itself go
//! through the system `curl` (bundled with Windows 10+, present on macOS and
//! virtually every Linux), with several mirror prefixes tried in order so the
//! GitHub release is reachable behind regional network restrictions.

use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::ctx::{emit, AppEnv, Ctx, Emitter};
use crate::error::{AppError, Result};
use crate::models::{StartJobResult, WorkflowStepInput};

/* ── Binary management ──────────────────────────────────────────── */

pub fn binary_name() -> String {
    crate::ffmpeg::binary_name("yt-dlp")
}

/// Install location for the managed binary: `<app_data_dir>/bin`.
pub(crate) fn managed_dir(env: &dyn AppEnv) -> Result<PathBuf> {
    let dir = env
        .app_data_dir()
        .ok_or_else(|| AppError("无法定位应用数据目录".into()))?
        .join("bin");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Locate yt-dlp: next to the executable / resource dir (same walk as ffmpeg),
/// then the managed `<app_data>/bin` copy (an in-app update — it must win
/// over the older version bundled as a resource), then the system PATH.
pub fn resolve(env: &dyn AppEnv) -> Option<PathBuf> {
    let name = binary_name();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let p = dir.join(&name);
            if p.exists() {
                return Some(p);
            }
            let mut cur = Some(dir.to_path_buf());
            while let Some(d) = cur {
                let cand = d.join("binaries").join(&name);
                if cand.exists() {
                    return Some(cand);
                }
                cur = d.parent().map(|p| p.to_path_buf());
            }
        }
    }
    // The managed copy exists only when the user installed/updated in-app, so
    // it always beats the (possibly older) bundled resource copy.
    if let Ok(dir) = managed_dir(env) {
        let p = dir.join(&name);
        if p.exists() {
            return Some(p);
        }
    }
    if let Some(res) = env.resource_dir() {
        for cand in [res.join(&name), res.join("binaries").join(&name)] {
            if cand.exists() {
                return Some(cand);
            }
        }
    }
    crate::ffmpeg::find_in_path(&name)
}

fn run_version(bin: &Path) -> Option<String> {
    let mut cmd = Command::new(bin);
    cmd.arg("--version")
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YtdlpStatus {
    pub installed: bool,
    pub version: Option<String>,
    pub path: Option<String>,
    pub ffmpeg_found: bool,
}

/// Status probing runs each engine's `--version`; those subprocesses block for
/// seconds (PyInstaller self-extracts on every run, the streamlink tree boots
/// an embedded Python), so this must stay async — a sync command would pin the
/// main thread and freeze the whole window until they exit.
pub async fn ytdlp_status(ctx: Ctx) -> Result<YtdlpStatus> {
    tokio::task::spawn_blocking(move || {
        let path = resolve(&*ctx.env);
        let version = path.as_ref().and_then(|p| run_version(p));
        let installed = path.is_some() && version.is_some();
        Ok(YtdlpStatus {
            installed,
            version: version.filter(|_| installed),
            path: path
                .filter(|_| installed)
                .map(|p| p.to_string_lossy().to_string()),
            ffmpeg_found: crate::ffmpeg::resolve(&*ctx.env, "ffmpeg").is_some(),
        })
    })
    .await
    .map_err(|e| AppError(e.to_string()))?
}

/// Latest yt-dlp release tag, queried from GitHub without downloading
/// anything. "检查更新" calls this first; the download stays behind an
/// explicit user action.
pub async fn ytdlp_latest_version() -> Result<String> {
    let body = tokio::task::spawn_blocking(|| {
        let mut cmd = Command::new("curl");
        cmd.args([
            "-sS",
            "--fail",
            "--connect-timeout",
            "10",
            "--max-time",
            "30",
            "-H",
            "Accept: application/vnd.github+json",
            "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let out = cmd
            .output()
            .map_err(|e| AppError(format!("curl 启动失败: {e}")))?;
        if !out.status.success() {
            let code = out.status.code().unwrap_or(-1);
            let stderr = String::from_utf8_lossy(&out.stderr);
            let detail = if stderr.trim().is_empty() {
                format!("退出码 {code}")
            } else {
                // Keep only the first line: 403 rate-limit bodies are noisy.
                stderr.trim().lines().next().unwrap_or_default().to_string()
            };
            return Err(AppError(format!("查询失败（{detail}）")));
        }
        let body = String::from_utf8_lossy(&out.stdout).to_string();
        if body.is_empty() {
            return Err(AppError("空响应".into()));
        }
        Ok(body)
    })
    .await
    .map_err(|e| AppError(e.to_string()))??;

    let json: serde_json::Value = serde_json::from_str(&body)
        .map_err(|e| AppError(format!("GitHub 返回内容无法解析（{e}）")))?;
    let tag = json["tag_name"]
        .as_str()
        .unwrap_or("")
        .trim()
        .trim_start_matches('v');
    if tag.is_empty() {
        return Err(AppError("GitHub 未返回版本号".into()));
    }
    Ok(tag.to_string())
}

/* ── Install / update via system curl ───────────────────────────── */

fn platform_asset() -> Result<&'static str> {
    if cfg!(target_os = "windows") {
        if cfg!(target_arch = "aarch64") {
            Ok("yt-dlp_arm64.exe")
        } else {
            Ok("yt-dlp.exe")
        }
    } else if cfg!(target_os = "macos") {
        Ok("yt-dlp_macos")
    } else if cfg!(target_arch = "aarch64") {
        Ok("yt-dlp_linux_aarch64")
    } else {
        Ok("yt-dlp_linux")
    }
}

pub(crate) const MIRROR_PREFIXES: [&str; 3] = [
    // Direct GitHub release (redirects /releases/latest/download/<asset>).
    "",
    // Common regional reverse proxies for GitHub downloads.
    "https://ghproxy.net/",
    "https://gh-proxy.com/",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallProgressEvent {
    pub stage: String, // downloading | done | error
    pub message: String,
    /// Download percentage (0-100); absent when the server sent no
    /// Content-Length or the stage is not a byte download.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub percent: Option<u8>,
}

pub(crate) fn install_message(source: &str, done: u64, total: Option<u64>) -> String {
    const MB: f64 = 1_048_576.0;
    match total {
        Some(t) => format!("{source}：已下载 {:.1} / {:.1} MB", done as f64 / MB, t as f64 / MB),
        None => format!("{source}：已下载 {:.1} MB", done as f64 / MB),
    }
}

/// Download (or update) yt-dlp into the managed dir, trying each mirror
/// until one succeeds. Emits `ytdlp-install-progress` with byte percentages.
pub async fn ytdlp_install(ctx: Ctx) -> Result<YtdlpStatus> {
    let asset = platform_asset()?;
    let url = format!(
        "https://github.com/yt-dlp/yt-dlp/releases/latest/download/{}",
        asset
    );
    let dir = managed_dir(&*ctx.env)?;
    let target = dir.join(binary_name());
    let tmp = dir.join(format!("{}.download", binary_name()));

    let candidates: Vec<String> = MIRROR_PREFIXES
        .iter()
        .map(|p| format!("{p}{url}"))
        .collect();
    let emitter = ctx.emitter.clone();
    let mut on_progress = |i: usize, done: u64, total: Option<u64>| {
        let source = if i == 0 {
            "GitHub".to_string()
        } else {
            format!("镜像 {}", candidates[i].split('/').nth(2).unwrap_or("GitHub"))
        };
        emit(
            emitter.as_ref(),
            "ytdlp-install-progress",
            &InstallProgressEvent {
                stage: "downloading".into(),
                message: install_message(&source, done, total),
                percent: total.map(|t| ((done * 100) / t.max(1)).min(100) as u8),
            },
        );
    };
    if let Err(e) = crate::download::fetch_with_progress(&candidates, &tmp, 1_000_000, &mut on_progress).await {
        emit(
            ctx.emitter.as_ref(),
            "ytdlp-install-progress",
            &InstallProgressEvent {
                stage: "error".into(),
                message: format!(
                    "yt-dlp 下载失败：{}。请检查网络，或手动放置 yt-dlp 到 PATH。",
                    e.0
                ),
                percent: None,
            },
        );
        return Err(AppError(format!(
            "yt-dlp 下载失败：{}。请检查网络，或手动放置 yt-dlp 到 PATH。",
            e.0
        )));
    }

    std::fs::rename(&tmp, &target)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755));
    }

    let version = run_version(&target);
    let ok = version.is_some();
    emit(
        ctx.emitter.as_ref(),
        "ytdlp-install-progress",
        &InstallProgressEvent {
            stage: if ok { "done".into() } else { "error".into() },
            message: if ok {
                format!("yt-dlp {} 就绪", version.clone().unwrap_or_default())
            } else {
                "下载完成但二进制无法运行".into()
            },
            percent: None,
        },
    );
    if !ok {
        let _ = std::fs::remove_file(&target);
        return Err(AppError("下载完成但二进制无法运行，已清理".into()));
    }
    Ok(YtdlpStatus {
        installed: true,
        version,
        path: Some(target.to_string_lossy().to_string()),
        ffmpeg_found: crate::ffmpeg::resolve(&*ctx.env, "ffmpeg").is_some(),
    })
}

/* ── URL probe ──────────────────────────────────────────────────── */

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NetOptions {
    pub cookies_file: Option<String>,
    pub cookies_text: Option<String>,
    pub proxy: Option<String>,
}

/// The cookie file to hand to `--cookies` / `--cookie-file`: an explicit path
/// wins over pasted text, which is materialised into the app data dir.
/// A missing app dir produces no path.
pub(crate) fn cookies_path(env: &dyn AppEnv, opts: &NetOptions) -> Option<String> {
    if let Some(f) = opts
        .cookies_file
        .as_deref()
        .map(str::trim)
        .filter(|f| !f.is_empty())
    {
        return Some(f.to_string());
    }
    let dir = env.app_data_dir()?.join("cookies");
    let Some(text) = opts
        .cookies_text
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
    else {
        // The pasted text is gone — don't leave the stale cookie copy on disk.
        let _ = std::fs::remove_file(dir.join("pasted.txt"));
        return None;
    };
    std::fs::create_dir_all(&dir).ok()?;
    let path = dir.join("pasted.txt");
    if std::fs::read_to_string(&path).ok().as_deref() != Some(text) {
        std::fs::write(&path, text).ok()?;
    }
    Some(path.to_string_lossy().into_owned())
}

/// Cookies saved for one live platform, keyed by the room URL's host. The
/// pasted text is materialised into a per-host file at save time so two
/// platforms never overwrite each other's cookies, and resolution only ever
/// sees a plain path.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PlatformCookies {
    pub host: String,
    pub cookies_file: Option<String>,
    /// Kept verbatim so the settings page can re-display what was pasted.
    pub cookies_text: Option<String>,
}

fn platform_cookies_path(env: &dyn AppEnv) -> Option<PathBuf> {
    Some(env.app_data_dir()?.join("platform_cookies.json"))
}

fn read_platform_cookies(env: &dyn AppEnv) -> Vec<PlatformCookies> {
    let Some(path) = platform_cookies_path(env) else {
        return vec![];
    };
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
        Err(_) => vec![],
    }
}

fn write_platform_cookies(env: &dyn AppEnv, list: &[PlatformCookies]) -> Result<()> {
    let path = platform_cookies_path(env).ok_or_else(|| AppError("无法定位应用数据目录".into()))?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(AppError::from)?;
    }
    std::fs::write(path, serde_json::to_string_pretty(list).map_err(AppError::from)?)
        .map_err(AppError::from)
}

/// The host a room URL belongs to, lower-cased with the scheme, `www.` and
/// anything after the authority stripped — the key cookies are matched on.
pub fn host_key(url: &str) -> Option<String> {
    let after_scheme = url.split_once("://").map(|(_, rest)| rest).unwrap_or(url);
    let authority = after_scheme
        .split(['/', '?', '#'])
        .next()
        .filter(|s| !s.is_empty())?;
    // With userinfo the real host is what follows the '@', so keying on the
    // text before it would hand a spoofed URL another platform's cookies.
    // An IPv6 literal is not a platform we support either.
    if authority.contains('@') || authority.starts_with('[') {
        return None;
    }
    let host = authority.rsplit_once(':').map(|(h, _)| h).unwrap_or(authority);
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    let host = host.strip_prefix("www.").unwrap_or(&host);
    (!host.is_empty()).then(|| host.to_string())
}

fn cookie_file_slug(host: &str) -> String {
    host.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect()
}

pub fn cookies_list(env: &dyn AppEnv) -> Vec<PlatformCookies> {
    read_platform_cookies(env)
}

/// Upsert by host. An entry with neither a file nor text clears the platform's
/// cookies, so the UI can delete a row and the recorder falls back to global.
pub fn cookies_set(env: &dyn AppEnv, entry: PlatformCookies) -> Result<PlatformCookies> {
    let host = host_key(&entry.host).filter(|h| h.contains('.'))
        .ok_or_else(|| AppError("请填写平台域名，例如 live.douyin.com".into()))?;
    let file = entry
        .cookies_file
        .as_deref()
        .map(str::trim)
        .filter(|f| !f.is_empty())
        .map(str::to_string);
    let text = entry
        .cookies_text
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_string);

    let mut stored_file = file.clone();
    if stored_file.is_none() {
        if let Some(t) = &text {
            let dir = env
                .app_data_dir()
                .map(|d| d.join("cookies"))
                .ok_or_else(|| AppError("无法定位应用数据目录".into()))?;
            std::fs::create_dir_all(&dir).map_err(AppError::from)?;
            let path = dir.join(format!("{}.txt", cookie_file_slug(&host)));
            if std::fs::read_to_string(&path).ok().as_deref() != Some(t.as_str()) {
                std::fs::write(&path, t).map_err(AppError::from)?;
            }
            stored_file = Some(path.to_string_lossy().into_owned());
        }
    }

    let stored = PlatformCookies {
        host: host.clone(),
        cookies_file: stored_file,
        cookies_text: text,
    };
    let mut list = read_platform_cookies(env);
    list.retain(|e| e.host != host);
    if stored.cookies_file.is_some() {
        list.push(stored.clone());
    }
    write_platform_cookies(env, &list)?;
    Ok(stored)
}

pub fn cookies_remove(env: &dyn AppEnv, host: String) -> Result<()> {
    let Some(host) = host_key(&host) else {
        return Ok(());
    };
    let list = read_platform_cookies(env);
    let owned_dir = env.app_data_dir().map(|d| d.join("cookies"));
    if let Some(entry) = list.iter().find(|e| e.host == host) {
        // Only files we materialised ourselves are ours to delete.
        if let (Some(dir), Some(f)) = (&owned_dir, entry.cookies_file.as_deref()) {
            if Path::new(f).starts_with(dir) {
                let _ = std::fs::remove_file(f);
            }
        }
    }
    let kept: Vec<PlatformCookies> = list.into_iter().filter(|e| e.host != host).collect();
    write_platform_cookies(env, &kept)
}

/// The cookies a monitor should probe and record with: a platform entry wins
/// over the values the monitor was created with, because the global setting is
/// one file for every site while a live room needs its own platform's session.
pub(crate) fn monitor_net(env: &dyn AppEnv, i: &MonitorInfo) -> NetOptions {
    let mut net = NetOptions {
        cookies_file: i.cookies_file.clone(),
        cookies_text: i.cookies_text.clone(),
        proxy: i.proxy.clone(),
    };
    if let Some(p) = platform_cookies_for(env, &i.url) {
        net.cookies_file = p.cookies_file;
        net.cookies_text = p.cookies_text;
    }
    net
}

/// Cookies that apply to a room URL: a platform entry wins over whatever the
/// monitor was created with, because the global setting is one file for every
/// site while a live room needs its own platform's session.
fn platform_cookies_for(env: &dyn AppEnv, url: &str) -> Option<PlatformCookies> {
    let host = host_key(url)?;
    read_platform_cookies(env)
        .into_iter()
        .find(|e| e.host == host || host.ends_with(&format!(".{}", e.host)))
}

pub(crate) fn common_net_args(env: &dyn AppEnv, bin: &Path, opts: &NetOptions) -> Vec<String> {
    let _ = bin;
    let mut a: Vec<String> = Vec::new();
    if let Some(f) = cookies_path(env, opts) {
        a.push("--cookies".into());
        a.push(f);
    }
    if let Some(p) = opts.proxy.as_deref() {
        if !p.is_empty() {
            a.push("--proxy".into());
            a.push(p.to_string());
        }
    }
    a
}

/// Resolve metadata for a URL (`yt-dlp -J`). Playlist pages return the
/// playlist object; the UI reads its first entry.
pub async fn ytdlp_probe(
    ctx: Ctx,
    url: String,
    options: Option<NetOptions>,
) -> Result<serde_json::Value> {
    let bin = resolve(&*ctx.env).ok_or_else(|| AppError("尚未安装 yt-dlp".into()))?;
    let opts = options.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        // -J on a playlist/season URL dumps every entry's full metadata, which
        // for a 50-episode season means a minute-long probe for one title.
        // The frontend only reads entries[0], so cap the dump at item 1.
        let mut args = vec![
            "-J".to_string(),
            "--no-playlist".to_string(),
            "--playlist-items".to_string(),
            "1".to_string(),
            "--no-warnings".to_string(),
            "--socket-timeout".to_string(),
            "20".to_string(),
        ];
        args.extend(common_net_args(&*ctx.env, &bin, &opts));
        args.push(url);
        let out = run_capture(&bin, &args)?;
        if out.0 != 0 {
            return Err(AppError(format!("解析失败: {}", tail_text(&out.2))));
        }
        serde_json::from_str::<serde_json::Value>(&out.1)
            .map_err(|e| AppError(format!("解析结果无法解析: {}", e)))
    })
    .await
    .map_err(|e| AppError(e.to_string()))?
}

pub(crate) fn run_capture(bin: &Path, args: &[String]) -> Result<(i32, String, String)> {
    let mut cmd = Command::new(bin);
    cmd.args(args)
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUTF8", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let out = cmd.output()?;
    Ok((
        out.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&out.stdout).to_string(),
        String::from_utf8_lossy(&out.stderr).to_string(),
    ))
}

pub(crate) fn tail_text(s: &str) -> String {
    let s = s.trim();
    const MAX: usize = 4000;
    if s.len() <= MAX {
        return s.to_string();
    }
    // Walk forward to a char boundary — stderr often contains CJK text and a
    // raw byte-index slice would panic mid-character.
    let mut start = s.len() - MAX;
    while !s.is_char_boundary(start) {
        start += 1;
    }
    s[start..].to_string()
}

/* ── Downloads & recordings ─────────────────────────────────────── */

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DownloadRequest {
    pub url: String,
    /// best | 2160p | 1080p | 720p | 480p | audio
    pub quality: String,
    /// mp3 | m4a | opus | flac — only for quality == "audio"
    pub audio_format: Option<String>,
    pub output_dir: String,
    /// yt-dlp output template; default `%(title)s.%(ext)s`
    pub filename_template: Option<String>,
    pub cookies_file: Option<String>,
    pub cookies_text: Option<String>,
    pub proxy: Option<String>,
    /// Also save subtitles (converted to srt)
    pub subtitles: Option<bool>,
    /// download | record (live capture: mpegts-friendly, resumable segmenting)
    pub kind: Option<String>,
    /// Recording safety limit in seconds; the capture is stopped (and kept)
    /// when exceeded. None = unlimited.
    pub max_duration_sec: Option<u64>,
    /// Display title when the real one is unknown yet (monitor recordings).
    pub title: Option<String>,
}

fn format_selector(quality: &str, audio_format: Option<&str>) -> (Vec<String>, String) {
    match quality {
        "audio" => (
            vec![
                "-x".into(),
                "--audio-format".into(),
                audio_format.unwrap_or("mp3").into(),
                "--audio-quality".into(),
                "0".into(),
            ],
            "bestaudio/best".to_string(),
        ),
        "2160p" => (vec!["-S".into(), "res:2160,ext".into()], "b".into()),
        "1080p" => (vec!["-S".into(), "res:1080,ext".into()], "b".into()),
        "720p" => (vec!["-S".into(), "res:720,ext".into()], "b".into()),
        "480p" => (vec!["-S".into(), "res:480,ext".into()], "b".into()),
        // best: no resolution cap; still prefer mp4-capable merges as a tiebreak
        _ => (vec!["-S".into(), "ext".into()], "bv*+ba/b".to_string()),
    }
}

fn build_download_args(env: &dyn AppEnv, bin: &Path, req: &DownloadRequest) -> Result<Vec<String>> {
    let is_record = req.kind.as_deref() == Some("record");
    let mut a: Vec<String> = vec![
        "--no-playlist".into(),
        "--no-warnings".into(),
        "--no-mtime".into(),
        "--windows-filenames".into(),
        "--newline".into(),
        "--progress".into(),
    ];

    // Machine-parseable progress: downloaded | total | estimate | speed | eta,
    // "NA" when a field is unknown.
    a.push("--progress-template".into());
    a.push("download:PROG|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s".into());

    // yt-dlp's own default template: the id suffix keeps distinct videos that
    // share a title from colliding — with a title-only name the second
    // download is silently skipped as "already downloaded" and the post
    // pipeline would then run against the first video's file.
    let template = req
        .filename_template
        .as_deref()
        .filter(|t| !t.is_empty())
        .unwrap_or("%(title)s [%(id)s].%(ext)s");
    if is_record {
        let ts = "%(epoch>%Y%m%d-%H%M%S)s";
        a.push("-o".into());
        a.push(format!(
            "{}/%(title).180B [{}].%(ext)s",
            req.output_dir.replace('\\', "/").trim_end_matches('/'),
            ts
        ));
    } else {
        a.push("-o".into());
        a.push(format!(
            "{}/{}",
            req.output_dir.replace('\\', "/").trim_end_matches('/'),
            template
        ));
    }

    a.push("--ffmpeg-location".into());
    let ffmpeg = crate::ffmpeg::resolve(env, "ffmpeg")
        .ok_or_else(|| AppError("找不到 ffmpeg：下载合并/转封装需要它".into()))?;
    a.push(ffmpeg.to_string_lossy().to_string());

    a.extend(common_net_args(
        env,
        bin,
        &NetOptions {
            cookies_file: req.cookies_file.clone(),
            cookies_text: req.cookies_text.clone(),
            proxy: req.proxy.clone(),
        },
    ));

    let (qual_args, selector) = format_selector(&req.quality, req.audio_format.as_deref());
    a.extend(qual_args);
    a.push("-f".into());
    a.push(selector);

    if req.subtitles.unwrap_or(false) && !is_record {
        a.push("--write-subs".into());
        a.push("--write-auto-subs".into());
        a.push("--sub-langs".into());
        // Bilibili serves danmaku comments as an XML "subtitle" track; ffmpeg
        // cannot parse it, so `--convert-subs srt` fails the whole download
        // (exit 1) after the video itself already succeeded.
        a.push("all,-live_chat,-danmaku".into());
        a.push("--convert-subs".into());
        a.push("srt".into());
    }

    if is_record {
        // TS muxing survives crashes mid-stream; a plain MP4 would be lost.
        a.push("--hls-use-mpegts".into());
        a.push("--no-part".into());
    }

    a.push(req.url.clone());
    Ok(a)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgressEvent {
    pub id: String,
    pub percent: f64,
    pub phase: String, // running | done
    pub speed: Option<String>,
    pub eta: Option<String>,
    pub downloaded_bytes: Option<u64>,
    pub total_bytes: Option<u64>,
    pub postprocessing: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadDoneEvent {
    pub id: String,
    pub ok: bool,
    pub cancelled: bool,
    /// download | record
    pub kind: String,
    pub output: Option<String>,
    pub error: Option<String>,
    /// set when the recording hit its max-duration limit and was stopped
    pub limit_reached: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadStartedEvent {
    pub id: String,
    pub url: String,
    pub title: String,
    pub kind: String,
    #[serde(default)]
    pub pipeline: Vec<WorkflowStepInput>,
    /// Upload targets the frontend should push the final product to.
    #[serde(default)]
    pub upload_to: Vec<String>,
}

/// Parse one `--progress-template` line:
/// `PROG|downloaded|total|estimate|speed|eta` — fields are "NA" when unknown.
/// Returns (downloaded, total-or-estimate, speed bytes/s, eta secs).
fn parse_progress_line(line: &str) -> Option<(Option<u64>, Option<u64>, Option<u64>, Option<u64>)> {
    let rest = line.strip_prefix("PROG|")?;
    let field = |i: usize| -> Option<u64> {
        rest.split('|')
            .nth(i)
            .and_then(|s| s.trim().parse::<f64>().ok())
            .map(|v| v as u64)
    };
    let dl = field(0);
    let total = field(1).or_else(|| field(2));
    let speed = field(3);
    let eta = field(4);
    Some((dl, total, speed, eta))
}

pub(crate) fn format_speed(bytes_per_sec: f64) -> String {
    let units = ["B/s", "KB/s", "MB/s", "GB/s"];
    let mut v = bytes_per_sec.max(0.0);
    let mut i = 0;
    while v >= 1024.0 && i < units.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    format!("{:.1} {}", v, units[i])
}

fn format_eta(secs: f64) -> String {
    let s = secs.max(0.0) as u64;
    if s >= 3600 {
        format!("{}:{:02}:{:02}", s / 3600, (s % 3600) / 60, s % 60)
    } else {
        format!("{}:{:02}", s / 60, s % 60)
    }
}

/// Spawn yt-dlp with stdout/stderr wired like the ffmpeg spawner.
fn spawn_process(
    bin: &Path,
    args: &[String],
) -> Result<(
    std::process::Child,
    std::process::ChildStdout,
    Arc<Mutex<Vec<u8>>>,
    std::thread::JoinHandle<()>,
)> {
    let mut cmd = Command::new(bin);
    cmd.args(args)
        // The PyInstaller Python runtime defaults piped stdout to the ANSI
        // code page (GBK on zh-CN Windows). Rust reads the pipe as UTF-8, and
        // a GBK byte would fail the line parse — force UTF-8 so titles and
        // progress arrive decodable.
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUTF8", "1")
        // GUI parents have no console: an inherited stdin would be an
        // invalid handle, and yt-dlp's own ffmpeg-spawning postprocessors
        // then die with "[Errno 22] Invalid argument". A null stdin gives
        // every grandchild a valid handle.
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = cmd.spawn().map_err(AppError::from)?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError("无法获取子进程 stdout".into()))?;
    let stderr_buf: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
    let drain = if let Some(stderr) = child.stderr.take() {
        let buf = stderr_buf.clone();
        const CAP: usize = 1_000_000;
        std::thread::spawn(move || {
            let mut r = stderr;
            let mut chunk = [0u8; 4096];
            loop {
                match r.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(n) => {
                        let mut g = buf.lock().unwrap();
                        if g.len() < CAP {
                            let take = (CAP - g.len()).min(n);
                            g.extend_from_slice(&chunk[..take]);
                        }
                    }
                    Err(_) => break,
                }
            }
        })
    } else {
        std::thread::spawn(|| {})
    };
    Ok((child, stdout, stderr_buf, drain))
}

/// Track the newest reported destination so the done event can point at the
/// final file (after merge / extract-audio the name changes).
struct DestTracker(Option<String>);
impl DestTracker {
    fn observe(&mut self, line: &str) {
        // [Merger] Merging formats into "<path>"
        if let Some(idx) = line.find("[Merger] Merging formats into \"") {
            let rest = &line[idx + "[Merger] Merging formats into \"".len()..];
            if let Some(end) = rest.find('"') {
                self.0 = Some(rest[..end].to_string());
            }
            return;
        }
        // [VideoRemuxer] Remuxing video from <old> to <new>
        if let Some(idx) = line.find("[VideoRemuxer] Remuxing video from ") {
            let rest = &line[idx + "[VideoRemuxer] Remuxing video from ".len()..];
            if let Some(pos) = rest.find(" to ") {
                let new = rest[pos + 4..].trim();
                if !new.is_empty() {
                    self.0 = Some(new.to_string());
                }
            }
            return;
        }
        // [download] Destination: <path> / [ExtractAudio] Destination: <path>
        for marker in ["[download] Destination: ", "[ExtractAudio] Destination: "] {
            if let Some(idx) = line.find(marker) {
                let path = line[idx + marker.len()..].trim();
                if !path.is_empty() {
                    self.0 = Some(path.to_string());
                }
                return;
            }
        }
        // [download] <path> has already been downloaded — a deliberate
        // re-download resolves to the existing file so the done event (and a
        // bound pipeline) still point at something real.
        if let Some(idx) = line.find(" has already been downloaded") {
            if let Some(path) = line[..idx].trim().strip_prefix("[download] ") {
                let path = path.trim();
                if !path.is_empty() {
                    self.0 = Some(path.to_string());
                }
            }
        }
    }
}

/// Run a download/record to completion on the calling thread, emitting
/// progress/done events. Used both by `ytdlp_start_download` (own thread) and
/// by the monitor loop (so it knows when its auto-recording ended).
pub fn run_download_blocking(
    ctx: &Ctx,
    bin: &Path,
    req: DownloadRequest,
    id: &str,
    pipeline: Vec<WorkflowStepInput>,
    upload_to: Vec<String>,
) {
    let kind = req.kind.clone().unwrap_or_else(|| "download".into());
    let is_record = kind == "record";
    // Registered for the whole life of the job so a frontend reload can
    // re-adopt the running card (see `dl_active_tasks`).
    ctx.jobs.track_dl(
        id,
        crate::state::ActiveDlInfo {
            url: req.url.clone(),
            title: req
                .title
                .clone()
                .filter(|t| !t.is_empty())
                .unwrap_or_else(|| req.url.clone()),
            kind: kind.clone(),
            pipeline: pipeline.clone(),
            upload_to: upload_to.clone(),
        },
    );
    // Live capture is streamlink's specialty: it handles the HLS/DASH
    // adaptation of a stream that never ends far better. When the engine is
    // present, hand the whole recording over to it — and the monitor probes
    // with it first too (see `monitor_loop`), so detection and capture agree;
    // yt-dlp serves sites streamlink has no plugin for, plus every VOD download.
    if is_record {
        if let Some(sl) = crate::streamlink::available(&*ctx.env) {
            crate::streamlink::run_record_blocking(ctx, &sl, req, id, pipeline, upload_to);
            return;
        }
    }
    let args = match build_download_args(&*ctx.env, bin, &req) {
        Ok(a) => a,
        Err(e) => {
            emit_dl_done(
                ctx,
                id,
                false,
                false,
                &kind,
                None,
                Some(e.to_string()),
                false,
                &pipeline,
            );
            return;
        }
    };
    if let Some(t) = &req.title {
        emit(
            ctx.emitter.as_ref(),
            "download-started",
            &DownloadStartedEvent {
                id: id.to_string(),
                url: req.url.clone(),
                title: t.clone(),
                kind: kind.clone(),
                pipeline: pipeline.clone(),
                upload_to: upload_to.clone(),
            },
        );
    }
    let (child, stdout, stderr_buf, drain) = match spawn_process(bin, &args) {
        Ok(v) => v,
        Err(e) => {
            emit_dl_done(
                ctx,
                id,
                false,
                false,
                &kind,
                None,
                Some(e.to_string()),
                false,
                &pipeline,
            );
            return;
        }
    };
    let child = Arc::new(Mutex::new(child));
    let manager = ctx.jobs.clone();
    manager.register(id, child.clone());
    if manager.is_cancelled(id) {
        if let Ok(mut c) = child.lock() {
            let _ = crate::state::kill_tree(&mut c);
        }
    }

    let started = Instant::now();
    let max_secs = req.max_duration_sec.filter(|_| is_record);
    let mut last_percent = -1.0_f64;
    let mut last_speed: Option<String> = None;
    let mut dest = DestTracker(None);
    let mut limit_reached = false;
    // Read raw bytes and decode lossily: a UTF-8 validation failure inside
    // `lines()` would end the loop, drop the pipe read end, and the child's
    // next write would die with "[Errno 22] Invalid argument".
    let mut reader = BufReader::new(stdout);
    let mut raw: Vec<u8> = Vec::new();
    loop {
        raw.clear();
        match reader.read_until(b'\n', &mut raw) {
            Ok(0) => break,
            Ok(_) => {}
            Err(_) => break,
        }
        let line = String::from_utf8_lossy(&raw);
        let line = line.trim_end_matches(['\r', '\n']);
        dest.observe(line);
        if line.starts_with("PROG|") {
            if let Some((dl, total, speed, eta)) = parse_progress_line(&line) {
                if let Some(v) = speed {
                    last_speed = Some(format_speed(v as f64));
                }
                let pct = match (dl, total) {
                    (Some(d), Some(t)) if t > 0 => (d as f64 / t as f64 * 100.0).clamp(0.0, 100.0),
                    _ => 0.0,
                };
                if (pct - last_percent).abs() >= 0.5 || pct == 0.0 {
                    last_percent = pct;
                    emit(
                        ctx.emitter.as_ref(),
                        "download-progress",
                        &DownloadProgressEvent {
                            id: id.to_string(),
                            percent: pct,
                            phase: "running".into(),
                            speed: last_speed.clone(),
                            eta: eta.map(|v| format_eta(v as f64)),
                            downloaded_bytes: dl,
                            total_bytes: total,
                            postprocessing: Some(false),
                        },
                    );
                }
            }
        } else if line.contains("[Merger]")
            || line.contains("[ExtractAudio]")
            || line.contains("[EmbedThumbnail]")
            || line.contains("[VideoRemuxer]")
        {
            emit(
                ctx.emitter.as_ref(),
                "download-progress",
                &DownloadProgressEvent {
                    id: id.to_string(),
                    percent: 100.0,
                    phase: "running".into(),
                    speed: None,
                    eta: None,
                    downloaded_bytes: None,
                    total_bytes: None,
                    postprocessing: Some(true),
                },
            );
        }
        if let Some(limit) = max_secs {
            if started.elapsed() >= Duration::from_secs(limit) && !limit_reached {
                limit_reached = true;
                if let Ok(mut c) = child.lock() {
                    let _ = crate::state::kill_tree(&mut c);
                }
            }
        }
    }
    let _ = drain.join();
    // Reap via a poll loop, never a blocking wait(): wait() holds the child
    // mutex until exit, which deadlocks cancel_job's kill(); and finish() used
    // to drop the registry entry before the process was confirmed dead. Either
    // way a live yt-dlp could end up unkillable from the UI. Re-killing while
    // the cancel flag is set also enforces a cancel whose first kill failed.
    let code = loop {
        let alive = match child.lock().unwrap().try_wait() {
            Ok(Some(s)) => break s.code().unwrap_or(-1),
            Ok(None) => true,
            Err(_) => break -1,
        };
        if alive && manager.is_cancelled(id) {
            if let Err(e) = crate::state::kill_tree(&mut child.lock().unwrap()) {
                eprintln!("kill yt-dlp job {id}: {e}");
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    let was_cancelled = manager.is_cancelled(id);
    manager.finish(id);
    if was_cancelled {
        emit_dl_done(
            ctx,
            id,
            false,
            true,
            &kind,
            None,
            Some("已取消".into()),
            false,
            &pipeline,
        );
        return;
    }
    // The duration-limit stop kills the child (nonzero exit) but keeps the file.
    if code != 0 && !limit_reached {
        let detail = tail_text(&String::from_utf8_lossy(&stderr_buf.lock().unwrap()));
        emit_dl_done(
            ctx,
            id,
            false,
            false,
            &kind,
            None,
            Some(format!(
                "yt-dlp 退出码 {}{}",
                code,
                if detail.is_empty() {
                    String::new()
                } else {
                    format!("\n\n{}", detail)
                }
            )),
            false,
            &pipeline,
        );
        return;
    }
    // Success (or limit stop): resolve the produced file.
    let mut output = dest.0.clone().filter(|p| Path::new(p).exists());
    if output.is_none() {
        // Fall back to the newest media file in the output dir.
        output = newest_media_file(Path::new(&req.output_dir), started);
    }
    let size = output
        .as_ref()
        .and_then(|p| std::fs::metadata(p).ok())
        .map(|m| m.len());
    let _ = emit(
        ctx.emitter.as_ref(),
        "download-progress",
        &DownloadProgressEvent {
            id: id.to_string(),
            percent: 100.0,
            phase: "done".into(),
            speed: None,
            eta: None,
            downloaded_bytes: size,
            total_bytes: size,
            postprocessing: Some(false),
        },
    );
    emit_dl_done(
        ctx,
        id,
        true,
        false,
        &kind,
        output,
        None,
        limit_reached,
        &pipeline,
    );
}

/// Media extensions considered a valid recording/download output for the
/// fallback "newest file" scan.
const OUTPUT_EXTS: [&str; 12] = [
    "mp4", "mkv", "webm", "ts", "flv", "mov", "mp3", "m4a", "opus", "flac", "wav", "aac",
];

pub(crate) fn newest_media_file(dir: &Path, since: Instant) -> Option<String> {
    let entries = std::fs::read_dir(dir).ok()?;
    let mut best: Option<(SystemTime, PathBuf)> = None;
    for e in entries.flatten() {
        let p = e.path();
        let ext = p
            .extension()
            .and_then(|x| x.to_str())
            .map(|x| x.to_ascii_lowercase());
        let Some(ext) = ext else { continue };
        // Subtitles are sidecar outputs; skip them as "the" result.
        if !OUTPUT_EXTS.contains(&ext.as_str()) {
            continue;
        }
        // .part files are incomplete downloads.
        if p.to_string_lossy().ends_with(".part") {
            continue;
        }
        let meta = e.metadata().ok()?;
        let modified = meta.modified().ok()?;
        // Only files written during this run count.
        if modified < started_threshold(since) {
            continue;
        }
        if best.as_ref().map(|(t, _)| modified > *t).unwrap_or(true) {
            best = Some((modified, p));
        }
    }
    best.map(|(_, p)| p.to_string_lossy().to_string())
}

/// Files written after `now - elapsed - slack`.
fn started_threshold(since: Instant) -> SystemTime {
    let elapsed = since.elapsed();
    SystemTime::now() - elapsed - Duration::from_secs(5)
}

pub(crate) fn emit_dl_done(
    ctx: &Ctx,
    id: &str,
    ok: bool,
    cancelled: bool,
    kind: &str,
    output: Option<String>,
    error: Option<String>,
    limit_reached: bool,
    _pipeline: &[WorkflowStepInput],
) {
    ctx.jobs.untrack_dl(id);
    emit(
        ctx.emitter.as_ref(),
        "download-done",
        &DownloadDoneEvent {
            id: id.to_string(),
            ok,
            cancelled,
            kind: kind.to_string(),
            output,
            error,
            limit_reached: if limit_reached { Some(true) } else { None },
        },
    );
}

/// In-flight download/record jobs, so a frontend that reloaded mid-capture
/// can rebuild the running cards it missed the events for.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveDlTask {
    pub id: String,
    pub url: String,
    pub title: String,
    pub kind: String,
    pub pipeline: Vec<WorkflowStepInput>,
    #[serde(default)]
    pub upload_to: Vec<String>,
}

pub fn dl_active_tasks(ctx: Ctx) -> Vec<ActiveDlTask> {
    ctx.jobs
        .active_dls()
        .into_iter()
        .map(|(id, i)| ActiveDlTask {
            id,
            url: i.url,
            title: i.title,
            kind: i.kind,
            pipeline: i.pipeline,
            upload_to: i.upload_to,
        })
        .collect()
}

pub async fn ytdlp_start_download(ctx: Ctx, request: DownloadRequest) -> Result<StartJobResult> {
    let bin = resolve(&*ctx.env).ok_or_else(|| AppError("尚未安装 yt-dlp".into()))?;
    if req_output_dir_missing(&request) {
        std::fs::create_dir_all(&request.output_dir)?;
    }
    let id = format!(
        "dl-{:x}-{}",
        std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
        std::process::id()
    );
    let ctx2 = ctx.clone();
    let id2 = id.clone();
    std::thread::spawn(move || {
        run_download_blocking(&ctx2, &bin, request, &id2, Vec::new(), Vec::new());
    });
    Ok(StartJobResult {
        id,
        skipped: false,
        output: None,
        note: None,
    })
}

fn req_output_dir_missing(req: &DownloadRequest) -> bool {
    !Path::new(&req.output_dir).exists()
}

/* ── Live monitors ──────────────────────────────────────────────── */

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MonitorRequest {
    pub url: String,
    pub name: Option<String>,
    /// Poll interval in seconds (default 180, min 30).
    pub interval_sec: u64,
    /// Auto-start recording when the channel is live.
    pub auto_record: bool,
    pub quality: String,
    pub output_dir: String,
    pub cookies_file: Option<String>,
    pub cookies_text: Option<String>,
    pub proxy: Option<String>,
    /// Post-processing workflow bound to every recording of this monitor.
    #[serde(default)]
    pub pipeline: Vec<WorkflowStepInput>,
    /// Upload targets bound to every recording of this monitor.
    #[serde(default)]
    pub upload_to: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MonitorInfo {
    pub id: String,
    pub url: String,
    pub name: String,
    pub interval_sec: u64,
    pub auto_record: bool,
    pub quality: String,
    pub output_dir: String,
    pub cookies_file: Option<String>,
    pub cookies_text: Option<String>,
    pub proxy: Option<String>,
    /// watching | recording | stopping
    pub status: String,
    pub title: Option<String>,
    /// Streamer nickname reported by the probe.
    pub author: Option<String>,
    pub live_status: Option<String>,
    pub last_checked: Option<u64>,
    pub current_job: Option<String>,
    #[serde(default)]
    pub pipeline: Vec<WorkflowStepInput>,
    #[serde(default)]
    pub upload_to: Vec<String>,
    /// Where this room's recordings land, for the UI's open-folder action.
    /// Filled in whenever the info is handed out, never stored by the caller.
    #[serde(default)]
    pub record_dir: Option<String>,
}

/// One folder per live room under the monitor's output dir, named after the
/// streamer; the monitor's base dir when no usable room name exists yet.
fn room_dir(i: &MonitorInfo) -> String {
    match record_subdir(i.author.as_deref(), &i.name, &i.url) {
        Some(sub) => Path::new(&i.output_dir)
            .join(sub)
            .to_string_lossy()
            .into_owned(),
        None => i.output_dir.clone(),
    }
}

impl MonitorInfo {
    fn reported(mut self) -> Self {
        self.record_dir = Some(room_dir(&self));
        self
    }
}

impl MonitorInfo {
    fn from_request(id: &str, r: &MonitorRequest) -> Self {
        MonitorInfo {
            id: id.to_string(),
            url: r.url.clone(),
            name: r
                .name
                .clone()
                .filter(|n| !n.is_empty())
                .unwrap_or_else(|| r.url.clone()),
            interval_sec: r.interval_sec.max(30),
            auto_record: r.auto_record,
            quality: r.quality.clone(),
            output_dir: r.output_dir.clone(),
            cookies_file: r.cookies_file.clone(),
            cookies_text: r.cookies_text.clone(),
            proxy: r.proxy.clone(),
            status: "watching".into(),
            title: None,
            author: None,
            live_status: None,
            last_checked: None,
            current_job: None,
            pipeline: r.pipeline.clone(),
            upload_to: r.upload_to.clone(),
            record_dir: None,
        }
    }
}

struct MonitorHandle {
    stop: Arc<AtomicBool>,
    record_now: Arc<AtomicBool>,
    info: Arc<Mutex<MonitorInfo>>,
}

#[derive(Default)]
pub struct MonitorManager {
    monitors: Mutex<std::collections::HashMap<String, MonitorHandle>>,
}

impl MonitorManager {
    fn emit_info(emitter: &dyn Emitter, info: &MonitorInfo) {
        emit(emitter, "monitor-status", &info.clone().reported());
    }

    fn persist(env: &dyn AppEnv, mgr: &MonitorManager) {
        let map = mgr.monitors.lock().unwrap();
        let infos: Vec<MonitorInfo> = map
            .values()
            .map(|h| h.info.lock().unwrap().clone())
            .collect();
        drop(map);
        if let Some(dir) = env.app_data_dir() {
            let _ = std::fs::create_dir_all(&dir);
            let path = dir.join("monitors.json");
            if let Ok(json) = serde_json::to_string_pretty(&infos) {
                let _ = std::fs::write(path, json);
            }
        }
    }

    fn load(env: &dyn AppEnv) -> Vec<MonitorInfo> {
        let Some(dir) = env.app_data_dir() else {
            return vec![];
        };
        let path = dir.join("monitors.json");
        let Ok(text) = std::fs::read_to_string(path) else {
            return vec![];
        };
        serde_json::from_str(&text).unwrap_or_default()
    }
}

/// Probe a URL's live status cheaply.
fn check_live(
    env: &dyn AppEnv,
    bin: &Path,
    url: &str,
    opts: &NetOptions,
) -> std::result::Result<(String, String, String), String> {
    let mut args: Vec<String> = vec![
        "--simulate".into(),
        "--no-playlist".into(),
        "--no-warnings".into(),
        "--socket-timeout".into(),
        "15".into(),
        "--print".into(),
        "%(live_status)s\t%(title)s\t%(uploader)s".into(),
    ];
    args.extend(common_net_args(env, bin, opts));
    args.push(url.to_string());
    let (code, out, err) = run_capture(bin, args.as_slice()).map_err(|e| e.to_string())?;
    if code != 0 {
        return Err(tail_text(&err));
    }
    let mut parts = out.trim().splitn(3, '\t').map(clean_field);
    let status = parts.next().unwrap_or_else(|| "unknown".to_string());
    let title = parts.next().unwrap_or_default();
    let author = parts.next().unwrap_or_default();
    Ok((status, title, author))
}

/// A `--print` field yt-dlp couldn't resolve comes back as the literal "NA".
fn clean_field(s: &str) -> String {
    let s = s.trim();
    if s == "NA" {
        String::new()
    } else {
        s.to_string()
    }
}

/// Douyin room links come in two shapes: the canonical `live.douyin.com/<room_id>`
/// that the recording engine's matcher requires (a non-empty path segment), and
/// referral forms like `live.douyin.com/?anchor_id=…` with no room id in the
/// path — monitors on those would probe "unknown" forever. Reject the referral
/// shape with guidance instead of adding a monitor that can never go live.
fn validate_live_url(url: &str) -> Result<()> {
    let lower = url.to_ascii_lowercase();
    let douyin_path = lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"))
        .map(|host| host.strip_prefix("live.").unwrap_or(host))
        .and_then(|host| host.strip_prefix("douyin.com/"));
    let Some(path) = douyin_path else {
        return Ok(());
    };
    let room = path.split(['?', '#']).next().unwrap_or("");
    if room.is_empty() || !room.bytes().all(|b| b.is_ascii_digit()) {
        return Err(AppError(
            "抖音直播仅支持直播间链接（live.douyin.com/房间号）：带 ?anchor_id= 参数的推荐页链接无法解析，请进入直播间后从地址栏复制".into(),
        ));
    }
    Ok(())
}

pub fn monitor_add(ctx: Ctx, request: MonitorRequest) -> Result<MonitorInfo> {
    let bin = resolve(&*ctx.env).ok_or_else(|| AppError("尚未安装 yt-dlp".into()))?;
    validate_live_url(&request.url)?;
    let id = format!(
        "mon-{:x}",
        std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    let info = MonitorInfo::from_request(&id, &request);
    let handle = spawn_monitor(ctx.clone(), bin, info.clone());
    ctx.monitors.monitors.lock().unwrap().insert(id, handle);
    MonitorManager::persist(&*ctx.env, &ctx.monitors);
    Ok(info.reported())
}

fn spawn_monitor(ctx: Ctx, bin: PathBuf, info: MonitorInfo) -> MonitorHandle {
    let stop = Arc::new(AtomicBool::new(false));
    let record_now = Arc::new(AtomicBool::new(false));
    let info = Arc::new(Mutex::new(info));
    let stop2 = stop.clone();
    let record_now2 = record_now.clone();
    let info2 = info.clone();
    // The thread detaches: removing a monitor only signals `stop`; joining
    // could block for the whole length of an in-flight recording.
    std::thread::spawn(move || {
        monitor_loop(ctx, bin, info2, stop2, record_now2);
    });
    MonitorHandle {
        stop,
        record_now,
        info,
    }
}

fn monitor_loop(
    ctx: Ctx,
    bin: PathBuf,
    info: Arc<Mutex<MonitorInfo>>,
    stop: Arc<AtomicBool>,
    record_now: Arc<AtomicBool>,
) {
    let opts = |i: &MonitorInfo| monitor_net(&*ctx.env, i);
    loop {
        if stop.load(Ordering::Relaxed) {
            break;
        }
        let interval = {
            let mut i = info.lock().unwrap();
            i.last_checked = Some(now_secs());
            i.status = if i.current_job.is_some() {
                "recording".into()
            } else {
                "watching".into()
            };
            i.interval_sec.max(30)
        };

        let want_now = record_now.load(Ordering::Relaxed);
        let mut auto_recording = false;
        if !want_now {
            let (url, net, auto) = {
                let i = info.lock().unwrap();
                (i.url.clone(), opts(&i), i.auto_record)
            };
            // Probe with the capture engine first: recording always goes to
            // streamlink when it's installed, so its answer is the one that
            // predicts a successful capture (and its plugins report the
            // author, which yt-dlp's live extractors often leave "NA").
            // Sites streamlink has no plugin for — or machines without the
            // engine — fall back to yt-dlp.
            let probe = {
                let cookies = cookies_path(&*ctx.env, &net);
                crate::streamlink::probe_live(
                    &*ctx.env,
                    &url,
                    net.proxy.as_deref(),
                    cookies.as_deref(),
                )
                .or_else(|_| check_live(&*ctx.env, &bin, &url, &net))
            };
            match probe {
                Ok((status, title, author)) => {
                    let live = status == "is_live";
                    let mut i = info.lock().unwrap();
                    i.live_status = Some(status);
                    i.title = (!title.is_empty()).then_some(title);
                    if !author.is_empty() {
                        i.author = Some(author);
                    }
                    auto_recording = live && auto;
                }
                Err(_) => {
                    info.lock().unwrap().live_status = Some("unknown".into());
                }
            }
            MonitorManager::emit_info(ctx.emitter.as_ref(), &info.lock().unwrap().clone());
        }

        if want_now || auto_recording {
            record_now.store(false, Ordering::Relaxed);
            // Safety net for the yt-dlp fallback probe: its live extractors
            // often report no uploader, which would leave the recording in
            // the base output dir instead of the per-author folder.
            if info.lock().unwrap().author.is_none() {
                let (url, net) = {
                    let i = info.lock().unwrap();
                    (i.url.clone(), opts(&i))
                };
                let cookies = cookies_path(&*ctx.env, &net);
                if let Ok((_, _, author)) = crate::streamlink::probe_live(
                    &*ctx.env,
                    &url,
                    net.proxy.as_deref(),
                    cookies.as_deref(),
                ) {
                    if !author.is_empty() {
                        info.lock().unwrap().author = Some(author);
                    }
                }
            }
            // Auto-monitored channels keep watching for the next stream;
            // a manual one-shot recording stops the monitor afterwards.
            let one_shot = !info.lock().unwrap().auto_record;
            record_once(&ctx, &bin, &info);
            if stop.load(Ordering::Relaxed) || one_shot {
                break;
            }
            continue;
        }

        // Sleep the poll interval in 1s slices so stop/record-now react fast.
        for _ in 0..interval {
            if stop.load(Ordering::Relaxed) || record_now.load(Ordering::Relaxed) {
                break;
            }
            std::thread::sleep(Duration::from_secs(1));
        }
    }
    {
        let mut i = info.lock().unwrap();
        i.status = "stopped".into();
        i.current_job = None;
    }
    MonitorManager::emit_info(ctx.emitter.as_ref(), &info.lock().unwrap().clone());
}

/// One folder per live room under the monitor's output dir, named after the
/// streamer. Falls back to the monitor name; returns `None` when neither can
/// produce a usable folder name, keeping the base dir.
fn record_subdir(author: Option<&str>, name: &str, url: &str) -> Option<String> {
    let clean = |s: &str| -> String {
        s.chars()
            // Path separators and control chars would escape the output dir.
            .filter(|c| {
                !matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
                    && *c as u32 >= 0x20
            })
            .collect::<String>()
            .trim()
            .chars()
            .take(60)
            .collect()
    };
    author.map(clean).filter(|a| !a.is_empty()).or_else(|| {
        let n = clean(name);
        (!n.is_empty() && n != clean(url)).then_some(n)
    })
}

/// Run one recording synchronously (blocks the monitor thread) and update the
/// monitor's status around it. `auto` decides whether the monitor keeps
/// running for the next stream (true) or stops after this recording (false).
fn record_once(ctx: &Ctx, bin: &Path, info: &Arc<Mutex<MonitorInfo>>) {
    let (req, pipeline, upload_to, auto) = {
        let i = info.lock().unwrap();
        let net = monitor_net(&*ctx.env, &i);
        let output_dir = room_dir(&i);
        (
            DownloadRequest {
                url: i.url.clone(),
                quality: i.quality.clone(),
                audio_format: None,
                output_dir,
                filename_template: None,
                cookies_file: net.cookies_file,
                cookies_text: net.cookies_text,
                proxy: net.proxy,
                subtitles: Some(false),
                kind: Some("record".into()),
                max_duration_sec: None,
                title: Some(
                    i.title
                        .clone()
                        .or_else(|| i.author.clone())
                        .unwrap_or_else(|| format!("{} 的直播", i.name)),
                ),
            },
            i.pipeline.clone(),
            i.upload_to.clone(),
            i.auto_record,
        )
    };
    let id = format!(
        "dl-{:x}-{}",
        std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
        std::process::id()
    );
    {
        let mut i = info.lock().unwrap();
        i.status = "recording".into();
        i.current_job = Some(id.clone());
    }
    MonitorManager::emit_info(ctx.emitter.as_ref(), &info.lock().unwrap().clone());
    // The download-started event (emitted inside run_download_blocking via
    // req.title) creates the task item on the frontend.
    run_download_blocking(ctx, bin, req, &id, pipeline, upload_to);
    {
        let mut i = info.lock().unwrap();
        i.current_job = None;
        // Manual one-shot recordings stop the monitor; auto recordings keep it
        // running for the next stream.
        i.status = if auto {
            "watching".into()
        } else {
            "stopped".into()
        };
    }
    MonitorManager::emit_info(ctx.emitter.as_ref(), &info.lock().unwrap().clone());
}

pub fn monitor_list(ctx: Ctx) -> Vec<MonitorInfo> {
    let list: Vec<MonitorInfo> = ctx
        .monitors
        .monitors
        .lock()
        .unwrap()
        .values()
        .map(|h| h.info.lock().unwrap().clone().reported())
        .collect();
    list
}

pub fn monitor_record_now(ctx: Ctx, id: String) -> Result<()> {
    let map = ctx.monitors.monitors.lock().unwrap();
    let h = map.get(&id).ok_or_else(|| AppError("监控不存在".into()))?;
    if h.info.lock().unwrap().current_job.is_some() {
        return Err(AppError("该直播间正在录制中".into()));
    }
    h.record_now.store(true, Ordering::Relaxed);
    Ok(())
}

/// Partial edit of a monitor's room info. Absent fields keep their value.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MonitorEdit {
    /// Empty string clears the custom name (falls back to the URL).
    pub name: Option<String>,
    pub interval_sec: Option<u64>,
    pub auto_record: Option<bool>,
    pub quality: Option<String>,
}

pub fn monitor_update(ctx: Ctx, id: String, edit: MonitorEdit) -> Result<MonitorInfo> {
    let mut pause_job: Option<String> = None;
    let info = {
        let mut map = ctx.monitors.monitors.lock().unwrap();
        let h = map
            .get_mut(&id)
            .ok_or_else(|| AppError("监控不存在".into()))?;
        let mut i = h.info.lock().unwrap();
        if let Some(name) = edit.name {
            let name = name.trim();
            i.name = if name.is_empty() {
                i.url.clone()
            } else {
                name.to_string()
            };
        }
        if let Some(interval) = edit.interval_sec {
            i.interval_sec = interval.max(30);
        }
        if let Some(auto) = edit.auto_record {
            // Flipping the switch off mid-capture is a pause: stop the
            // running recording now (footage so far is kept) instead of
            // waiting for the streamer to go offline.
            if !auto && i.auto_record {
                pause_job = i.current_job.clone();
            }
            i.auto_record = auto;
        }
        if let Some(quality) = edit.quality.filter(|q| !q.trim().is_empty()) {
            i.quality = quality.trim().to_string();
        }
        // A one-shot manual recording lets the monitor thread exit ("stopped").
        // Any edit revives it so the new settings actually take effect.
        if i.status == "stopped" {
            i.status = "watching".into();
            if let Some(bin) = resolve(&*ctx.env) {
                let stop = Arc::new(AtomicBool::new(false));
                let record_now = Arc::new(AtomicBool::new(false));
                let (ctx2, info2, stop2, rn2) = (
                    ctx.clone(),
                    h.info.clone(),
                    stop.clone(),
                    record_now.clone(),
                );
                std::thread::spawn(move || monitor_loop(ctx2, bin, info2, stop2, rn2));
                h.stop = stop;
                h.record_now = record_now;
            }
        }
        i.clone()
    };
    MonitorManager::emit_info(ctx.emitter.as_ref(), &info);
    MonitorManager::persist(&*ctx.env, &ctx.monitors);
    // Cancel outside the manager lock; the recording thread emits its own
    // status update once the capture winds down.
    if let Some(job_id) = pause_job {
        ctx.jobs.mark_cancelled(&job_id);
        ctx.jobs.kill(&job_id);
    }
    Ok(info.reported())
}

pub fn monitor_remove(ctx: Ctx, id: String) -> Result<()> {
    let handle = ctx.monitors.monitors.lock().unwrap().remove(&id);
    MonitorManager::persist(&*ctx.env, &ctx.monitors);
    if let Some(h) = handle {
        // If it is recording, cancel the running capture first.
        let job = h.info.lock().unwrap().current_job.clone();
        if let Some(job_id) = job {
            ctx.jobs.mark_cancelled(&job_id);
            ctx.jobs.kill(&job_id);
        }
        h.stop.store(true, Ordering::Relaxed);
        h.record_now.store(false, Ordering::Relaxed);
    }
    Ok(())
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Resume persisted monitors at startup.
pub fn resume_monitors(ctx: &Ctx) {
    let bin = match resolve(&*ctx.env) {
        Some(b) => b,
        None => return, // yt-dlp missing: nothing to resume; UI shows install prompt
    };
    for info in MonitorManager::load(&*ctx.env) {
        let id = info.id.clone();
        let handle = spawn_monitor(ctx.clone(), bin.clone(), info);
        ctx.monitors.monitors.lock().unwrap().insert(id, handle);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn douyin_room_urls_pass_validation() {
        assert!(validate_live_url("https://live.douyin.com/969060865386").is_ok());
        assert!(validate_live_url("https://live.douyin.com/969060865386?from=share").is_ok());
        assert!(validate_live_url("http://douyin.com/123456").is_ok());
    }

    #[test]
    fn douyin_referral_urls_are_rejected() {
        // Recommend-page shapes: no room id in the path.
        assert!(validate_live_url(
            "https://live.douyin.com/?anchor_id=80188783996&category_name=all"
        )
        .is_err());
        assert!(validate_live_url(
            "https://live.douyin.com/?activity_name=&anchor_id=1873170450364324"
        )
        .is_err());
        assert!(validate_live_url("https://live.douyin.com/").is_err());
        // Non-digit path segments are not room ids either.
        assert!(validate_live_url("https://live.douyin.com/enter").is_err());
    }

    #[test]
    fn other_sites_are_not_judged() {
        assert!(validate_live_url("https://live.bilibili.com/123").is_ok());
        assert!(validate_live_url("https://www.twitch.tv/x").is_ok());
        assert!(validate_live_url("https://www.douyin.com/video/123").is_ok());
    }

    #[test]
    fn host_key_normalises_the_authority() {
        assert_eq!(host_key("https://live.douyin.com/969060865386?x=1").as_deref(), Some("live.douyin.com"));
        assert_eq!(host_key("https://WWW.Twitch.TV/someone").as_deref(), Some("twitch.tv"));
        assert_eq!(host_key("http://127.0.0.1:8787/x").as_deref(), Some("127.0.0.1"));
        assert_eq!(host_key("twitch.tv/someone").as_deref(), Some("twitch.tv"));
    }

    #[test]
    fn host_key_refers_to_the_authority_not_the_query() {
        // The path/query must never be mistaken for the host: a crafted URL
        // would otherwise inherit another platform's cookies.
        assert_eq!(host_key("https://evil.com/?x=live.douyin.com").as_deref(), Some("evil.com"));
        assert_eq!(host_key("https://live.douyin.com@evil.com/"), None);
        assert_eq!(host_key("https://[::1]:8787/x"), None);
        assert_eq!(host_key("https:///x"), None);
    }

    #[test]
    fn pasted_cookies_are_materialised_one_file_per_platform() {
        let env = temp_env("per-host");
        cookies_set(&env, PlatformCookies { host: "live.douyin.com".into(), cookies_text: Some("DOUYIN".into()), ..Default::default() }).unwrap();
        cookies_set(&env, PlatformCookies { host: "live.bilibili.com".into(), cookies_text: Some("BILI".into()), ..Default::default() }).unwrap();

        let list = cookies_list(&env);
        assert_eq!(list.len(), 2);
        let douyin = list.iter().find(|e| e.host == "live.douyin.com").unwrap();
        let bili = list.iter().find(|e| e.host == "live.bilibili.com").unwrap();
        assert_ne!(douyin.cookies_file, bili.cookies_file);
        assert_eq!(std::fs::read_to_string(douyin.cookies_file.as_ref().unwrap()).unwrap(), "DOUYIN");
        assert_eq!(std::fs::read_to_string(bili.cookies_file.as_ref().unwrap()).unwrap(), "BILI");
    }

    #[test]
    fn a_rooms_platform_cookie_beats_the_global_one() {
        let env = temp_env("precedence");
        let mut monitor = MonitorInfo {
            url: "https://live.douyin.com/123".into(),
            cookies_file: Some("global.txt".into()),
            ..Default::default()
        };
        assert_eq!(monitor_net(&env, &monitor).cookies_file.as_deref(), Some("global.txt"));

        cookies_set(&env, PlatformCookies { host: "douyin.com".into(), cookies_file: Some("douyin.txt".into()), ..Default::default() }).unwrap();
        // A parent domain covers its subdomains, so `douyin.com` applies here.
        assert_eq!(monitor_net(&env, &monitor).cookies_file.as_deref(), Some("douyin.txt"));

        monitor.url = "https://live.bilibili.com/1".into();
        assert_eq!(monitor_net(&env, &monitor).cookies_file.as_deref(), Some("global.txt"));
    }

    #[test]
    fn removing_a_platform_clears_its_materialised_file() {
        let env = temp_env("remove");
        let stored = cookies_set(&env, PlatformCookies { host: "live.douyin.com".into(), cookies_text: Some("X".into()), ..Default::default() }).unwrap();
        let file = stored.cookies_file.unwrap();
        assert!(Path::new(&file).exists());
        cookies_remove(&env, "https://live.douyin.com/123".into()).unwrap();
        assert!(cookies_list(&env).is_empty());
        assert!(!Path::new(&file).exists());
    }

    struct TestEnv(PathBuf);

    impl AppEnv for TestEnv {
        fn resource_dir(&self) -> Option<PathBuf> {
            None
        }
        fn app_data_dir(&self) -> Option<PathBuf> {
            Some(self.0.clone())
        }
        fn open_url(&self, _url: &str) {}
    }

    fn temp_env(tag: &str) -> TestEnv {
        let dir = std::env::temp_dir().join(format!(
            "mediatool-cookies-{tag}-{:x}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        TestEnv(dir)
    }
}
