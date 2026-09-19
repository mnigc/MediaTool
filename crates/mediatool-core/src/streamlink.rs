//! streamlink: the live-recording engine.
//!
//! Scope is deliberately narrow — only `kind = "record"` capture goes through
//! here (see `ytdlp::run_download_blocking`, which falls back to yt-dlp when
//! this engine is not installed). VOD downloads and link probing stay on yt-dlp.
//!
//! A recording is a two-process pipeline: `streamlink --stdout` writes the raw
//! adapted stream into ffmpeg's stdin, and ffmpeg alone muxes to Matroska.
//! Every stop path kills streamlink first and then waits for ffmpeg to see
//! EOF, so the file is closed properly and stays playable.
//!
//! Progress is derived from the muxed file's growth rather than from engine
//! logs: streamlink only reports written bytes at debug log level, and the file
//! is the ground truth for what actually survived to disk.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::ctx::{emit, AppEnv, Ctx, Emitter};
use crate::error::{AppError, Result};
use crate::models::WorkflowStepInput;
use crate::ytdlp::{
    self, emit_dl_done, format_speed, DownloadProgressEvent, DownloadRequest, DownloadStartedEvent,
    InstallProgressEvent,
};

const POLL: Duration = Duration::from_secs(2);
/// Time given to ffmpeg to finish the file after the writer is killed.
const MUXER_GRACE: Duration = Duration::from_secs(10);

/* ── Binary management ──────────────────────────────────────────── */

pub fn binary_name() -> String {
    crate::ffmpeg::binary_name("streamlink")
}

/// Name of the folder the portable archive is unpacked into.
pub(crate) const PORTABLE_DIR: &str = "streamlink-portable";
/// Bundled portable archive, shipped as a bundle resource on Windows.
const ARCHIVE_NAME: &str = "streamlink.zip";
/// Marks which archive the unpacked tree came from, so an app update that
/// carries a newer bundle re-unpacks instead of reusing the stale copy.
const MARKER: &str = ".prepared";

/// CLI inside an unpacked portable tree: the archive is a whole embedded-Python
/// environment whose exe only runs in place, so it keeps its `bin/` layout.
fn cli_in(root: &Path) -> PathBuf {
    root.join("bin").join(binary_name())
}

/// Directories worth searching for an engine or its archive, best first: next
/// to the executable, every `binaries/` folder up the tree (dev layout), the
/// managed `<app_data>/bin` (an install we made beats a stale PATH entry), then
/// the bundle resources.
fn search_bases(env: &dyn AppEnv) -> Vec<PathBuf> {
    let mut bases: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            bases.push(dir.to_path_buf());
            let mut cur = Some(dir.to_path_buf());
            while let Some(d) = cur {
                bases.push(d.join("binaries"));
                cur = d.parent().map(|p| p.to_path_buf());
            }
        }
    }
    if let Ok(dir) = ytdlp::managed_dir(env) {
        bases.push(dir);
    }
    if let Some(res) = env.resource_dir() {
        bases.extend([res.clone(), res.join("binaries")]);
    }
    bases
}

/// Locate streamlink: see `search_bases`, then the system PATH. Each location is
/// checked both as a loose exe and as an unpacked portable tree, since that is
/// how the official bundle is shaped.
pub fn resolve(env: &dyn AppEnv) -> Option<PathBuf> {
    let name = binary_name();
    search_bases(env)
        .iter()
        .flat_map(|b| [b.join(&name), cli_in(&b.join(PORTABLE_DIR))])
        .find(|p| p.exists())
        .or_else(|| crate::ffmpeg::find_in_path(&name))
}

/// The portable archive shipped with this app, if any. Windows builds carry
/// one as a bundle resource; elsewhere streamlink only comes from pip.
fn bundled_archive(env: &dyn AppEnv) -> Option<PathBuf> {
    search_bases(env)
        .into_iter()
        .map(|b| b.join(ARCHIVE_NAME))
        .find(|p| p.exists())
}

/// Managed dir + bundled archive + the stamp identifying that archive.
fn bundle_stamp(env: &dyn AppEnv) -> Option<(PathBuf, PathBuf, String)> {
    let dir = ytdlp::managed_dir(env).ok()?;
    let archive = bundled_archive(env)?;
    let stamp = format!("{}-{}", file_size(&archive), env!("CARGO_PKG_VERSION"));
    Some((dir, archive, stamp))
}

/// Record that the current bundle is already unpacked, so a manual "检查更新"
/// install is not silently downgraded back to the bundled version at next start.
fn mark_prepared(env: &dyn AppEnv) {
    if let Some((dir, _, stamp)) = bundle_stamp(env) {
        let _ = std::fs::write(dir.join(PORTABLE_DIR).join(MARKER), stamp);
    }
}

/// Unpack the bundled archive into the managed dir the first time it is needed
/// (and again whenever an app update ships a newer one). Best-effort: a failure
/// just leaves the engine absent, and live recording falls back to yt-dlp.
///
/// Runs on its own thread because extracting a full Python tree takes seconds,
/// and reports through `streamlink-install-progress`, which the frontend already
/// renders and refreshes on `done`.
pub fn prepare(ctx: &Ctx) {
    static PREPARED: AtomicBool = AtomicBool::new(false);
    if PREPARED.swap(true, Ordering::SeqCst) {
        return;
    }
    let ctx = ctx.clone();
    std::thread::spawn(move || prepare_blocking(&ctx));
}

fn prepare_blocking(ctx: &Ctx) {
    let Some((dir, archive, stamp)) = bundle_stamp(&*ctx.env) else {
        return;
    };
    let root = dir.join(PORTABLE_DIR);
    let fresh = std::fs::read_to_string(root.join(MARKER))
        .map(|s| s == stamp && run_version(&cli_in(&root)).is_some())
        .unwrap_or(false);
    if fresh {
        return;
    }
    emit(
        ctx.emitter.as_ref(),
        "streamlink-install-progress",
        &InstallProgressEvent {
            stage: "downloading".into(),
            message: "正在解压随包 streamlink 引擎…".into(),
        },
    );
    let exe = {
        let _g = unpack_lock();
        unpack_portable(&archive, &dir.join(format!("{PORTABLE_DIR}.stage")), &dir)
    };
    match exe {
        Ok(exe) => {
            mark_prepared(&*ctx.env);
            let version = run_version(&exe).unwrap_or_default();
            emit(
                ctx.emitter.as_ref(),
                "streamlink-install-progress",
                &InstallProgressEvent {
                    stage: "done".into(),
                    message: format!("streamlink {version} 就绪"),
                },
            );
        }
        Err(e) => {
            emit(
                ctx.emitter.as_ref(),
                "streamlink-install-progress",
                &InstallProgressEvent {
                    stage: "error".into(),
                    message: format!("随包 streamlink 引擎不可用：{e}"),
                },
            );
        }
    }
}

/// Serializes unpacking so the bundled copy and a manual "检查更新" install
/// cannot extract into the same staging folder at the same time.
fn unpack_lock() -> MutexGuard<'static, ()> {
    static UNPACK: Mutex<()> = Mutex::new(());
    UNPACK.lock().unwrap_or_else(|e| e.into_inner())
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
    // "streamlink 7.12.0" → "7.12.0"
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let v = s.split_whitespace().last().unwrap_or("").to_string();
    (!v.is_empty()).then_some(v)
}

/// A usable engine binary, or None. Checked once per recording so a broken
/// install falls back to yt-dlp instead of failing the capture.
pub fn available(env: &dyn AppEnv) -> Option<PathBuf> {
    resolve(env).filter(|p| run_version(p).is_some())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamlinkStatus {
    pub installed: bool,
    pub version: Option<String>,
    pub path: Option<String>,
    pub ffmpeg_found: bool,
    /// In-app install exists only where the official repo publishes a bundle.
    pub installable: bool,
}

/// Only the official Windows builds ship a standalone bundle, and only for
/// x64; elsewhere streamlink comes from pip/pipx/brew.
fn installable() -> bool {
    cfg!(all(target_os = "windows", target_arch = "x86_64"))
}

/// Probing runs streamlink's `--version`, an embedded-Python boot that blocks
/// for a second or more; keep it on a worker thread (see `ytdlp_status` — a
/// sync command would pin the main thread and freeze the window at startup).
pub async fn streamlink_status(ctx: Ctx) -> Result<StreamlinkStatus> {
    tokio::task::spawn_blocking(move || {
        let path = available(&*ctx.env);
        let version = path.as_ref().and_then(|p| run_version(p));
        Ok(StreamlinkStatus {
            installed: path.is_some(),
            version,
            path: path.map(|p| p.to_string_lossy().to_string()),
            ffmpeg_found: crate::ffmpeg::resolve(&*ctx.env, "ffmpeg").is_some(),
            installable: installable(),
        })
    })
    .await
    .map_err(|e| AppError(e.to_string()))?
}

/* ── Install / update (Windows portable archive) ────────────────── */

/// streamlink's own releases are source tarballs; the Windows bundles live in a
/// separate official repository, which publishes an NSIS installer plus a
/// portable archive. We take the archive: no registry, no PATH edits, and the
/// whole tree can be deleted to uninstall.
const RELEASE_API: &str = "https://api.github.com/repos/streamlink/windows-builds/releases/latest";

/// Latest release tag + the stable `/releases/latest/download/<asset>` URL for
/// this platform, read from the GitHub API via system curl (no HTTP client
/// compiled in, same as yt-dlp).
pub async fn streamlink_latest_release() -> Result<serde_json::Value> {
    tokio::task::spawn_blocking(|| {
        if !installable() {
            return Err(AppError(
                "应用内安装仅支持 Windows x64，其他平台请用 pip/pipx/brew 更新 streamlink".into(),
            ));
        }
        let json = fetch_release_json()?;
        // Tag "8.6.1-1" is build 1 of streamlink 8.6.1; the app compares the
        // engine's own version, so drop the bundle revision.
        let tag = json["tag_name"]
            .as_str()
            .unwrap_or("")
            .split('-')
            .next()
            .unwrap_or("")
            .trim_start_matches('v')
            .to_string();
        let asset = json["assets"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|a| a["name"].as_str().unwrap_or(""))
            .find(|name| name.ends_with("-x86_64.zip"))
            .unwrap_or_default()
            .to_string();
        if tag.is_empty() || asset.is_empty() {
            return Err(AppError("GitHub 未发布适用于本平台的 streamlink 独立程序".into()));
        }
        Ok(serde_json::json!({
            "tag": tag,
            "url": format!("https://github.com/streamlink/windows-builds/releases/latest/download/{asset}"),
        }))
    })
    .await
    .map_err(|e| AppError(e.to_string()))?
}

fn fetch_release_json() -> Result<serde_json::Value> {
    let args = [
        "-sS",
        "--fail",
        "--location",
        "--connect-timeout",
        "10",
        "--max-time",
        "30",
        "-H",
        "Accept: application/vnd.github+json",
        RELEASE_API,
    ]
    .iter()
    .map(|s| s.to_string())
    .collect::<Vec<_>>();
    let (code, stdout, stderr) = ytdlp::run_capture(Path::new("curl"), &args)?;
    if code != 0 {
        let detail = stderr.trim().lines().last().unwrap_or_default();
        return Err(AppError(if detail.is_empty() {
            format!("查询失败（退出码 {code}）")
        } else {
            format!("查询失败（{detail}）")
        }));
    }
    serde_json::from_str(&stdout).map_err(|e| AppError(format!("GitHub 返回内容无法解析（{e}）")))
}

/// Download the portable archive and unpack it into the managed bin dir.
pub async fn streamlink_install(ctx: Ctx) -> Result<StreamlinkStatus> {
    if !installable() {
        return Err(AppError(
            "此平台没有独立可执行程序，请用 pip/pipx/brew 安装 streamlink 后重启应用".into(),
        ));
    }
    let release = streamlink_latest_release().await?;
    let url = release["url"].as_str().unwrap_or("").to_string();
    let dir = ytdlp::managed_dir(&*ctx.env)?;
    // Both staging names are what the cache cleaner treats as junk, so an
    // install interrupted by a crash still leaves nothing behind.
    let archive = dir.join(format!("{PORTABLE_DIR}.stage.zip"));
    let stage = dir.join(format!("{PORTABLE_DIR}.stage"));

    let progress = |emitter: &dyn Emitter, stage: &str, message: String| {
        emit(
            emitter,
            "streamlink-install-progress",
            &InstallProgressEvent {
                stage: stage.into(),
                message,
            },
        );
    };

    /* Download */
    let ctx2 = ctx.clone();
    let archive2 = archive.clone();
    let candidates: Vec<String> = ytdlp::MIRROR_PREFIXES
        .iter()
        .map(|p| format!("{p}{url}"))
        .collect();
    let downloaded: Result<()> = tokio::task::spawn_blocking(move || {
        let archive = archive2;
        let _ = std::fs::remove_file(&archive);
        let mut last_err = String::from("未尝试任何下载源");
        for (i, full) in candidates.iter().enumerate() {
            let source = if i == 0 {
                "GitHub".to_string()
            } else {
                full.split('/').nth(2).unwrap_or(full).to_string()
            };
            progress(
                ctx2.emitter.as_ref(),
                "downloading",
                if i == 0 {
                    "正在从 GitHub 下载 streamlink（约 80 MB）…".into()
                } else {
                    format!("直连失败，正在尝试镜像 {source} …")
                },
            );
            let mut cmd = Command::new("curl");
            cmd.args([
                "-L",
                "--fail",
                "--connect-timeout",
                "20",
                "--max-time",
                "1800",
                "-o",
            ])
            .arg(&archive)
            .arg(full)
            .stdout(Stdio::null())
            .stderr(Stdio::null());
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(0x0800_0000);
            }
            match cmd.status() {
                // The bundle is tens of MB; anything smaller is an error page.
                Ok(s) if s.success() && file_size(&archive) > 20_000_000 => return Ok(()),
                Ok(s) => last_err = format!("{source} 退出码 {}", s.code().unwrap_or(-1)),
                Err(e) => last_err = format!("{source} 启动 curl 失败: {e}"),
            }
            let _ = std::fs::remove_file(&archive);
        }
        Err(AppError(format!(
            "streamlink 下载失败：{last_err}。请检查网络，或手动安装 streamlink 到 PATH。"
        )))
    })
    .await
    .map_err(|e| AppError(e.to_string()))?;
    if let Err(e) = downloaded {
        emit(
            ctx.emitter.as_ref(),
            "streamlink-install-progress",
            &InstallProgressEvent {
                stage: "error".into(),
                message: e.0.clone(),
            },
        );
        return Err(e);
    }

    /* Unpack */
    progress(
        ctx.emitter.as_ref(),
        "downloading",
        "正在解压 streamlink…".into(),
    );
    let result = {
        let _g = unpack_lock();
        unpack_portable(&archive, &stage, &dir)
    };
    let _ = std::fs::remove_file(&archive);
    let exe = match result {
        Ok(p) => p,
        Err(e) => {
            progress(ctx.emitter.as_ref(), "error", format!("安装失败：{}", e.0));
            return Err(e);
        }
    };

    /* Verify */
    let version = run_version(&exe);
    if version.is_none() {
        let _ = std::fs::remove_dir_all(dir.join(PORTABLE_DIR));
        progress(
            ctx.emitter.as_ref(),
            "error",
            "解压完成但程序无法运行，已清理".into(),
        );
        return Err(AppError("解压完成但程序无法运行，已清理".into()));
    }
    mark_prepared(&*ctx.env);
    progress(
        ctx.emitter.as_ref(),
        "done",
        format!("streamlink {} 就绪", version.clone().unwrap_or_default()),
    );
    Ok(StreamlinkStatus {
        installed: true,
        version,
        path: Some(exe.to_string_lossy().to_string()),
        ffmpeg_found: crate::ffmpeg::resolve(&*ctx.env, "ffmpeg").is_some(),
        installable: true,
    })
}

/// Extract `archive` into `stage`, then move the single top-level folder the
/// archive carries onto the managed portable location. Returns the CLI path.
/// The staging folder is always discarded, success or not.
fn unpack_portable(archive: &Path, stage: &Path, dir: &Path) -> Result<PathBuf> {
    let unpacked = (|| -> Result<PathBuf> {
        // A half-finished earlier attempt would otherwise be mistaken for this
        // archive's contents.
        let _ = std::fs::remove_dir_all(stage);
        std::fs::create_dir_all(stage)?;
        extract_zip(archive, stage)?;
        // The archive's top-level folder name embeds the version, so discover
        // it rather than guessing it.
        let root = std::fs::read_dir(stage)
            .map_err(|e| AppError(format!("无法读取解压结果: {e}")))?
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .find(|p| p.is_dir() && cli_in(p).exists())
            .ok_or_else(|| AppError("解压结果中没有 bin/streamlink.exe".into()))?;

        // Replacing a running exe is what actually fails here, so say so.
        let target = dir.join(PORTABLE_DIR);
        if target.exists() {
            std::fs::remove_dir_all(&target)
                .map_err(|_| AppError("旧版本 streamlink 正在使用中，请先停止录制后重试".into()))?;
        }
        std::fs::rename(&root, &target)?;
        Ok(cli_in(&target))
    })();
    let _ = std::fs::remove_dir_all(stage);
    unpacked
}

/// Unzip with a system tool, so no archive crate is compiled in. Windows 10
/// ships bsdtar at `System32\tar.exe`, but a bare `tar` resolves to Git's GNU
/// tar when the app was started from a shell, and GNU tar cannot read zips —
/// hence the absolute path, with PowerShell as the fallback.
fn extract_zip(archive: &Path, dest: &Path) -> Result<()> {
    #[cfg(windows)]
    {
        let quote = |s: &str| s.replace('\'', "''"); // PowerShell literal escape
        let sys_tar = std::env::var("SystemRoot")
            .map(|r| Path::new(&r).join("System32").join("tar.exe"))
            .unwrap_or_else(|_| PathBuf::from("tar"));
        if sys_tar.exists() {
            let mut c = Command::new(&sys_tar);
            c.args(["-xf"]).arg(archive).arg("-C").arg(dest);
            if run_hidden(&mut c)?.success() {
                return Ok(());
            }
        }
        let mut c = Command::new("powershell");
        c.args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
        ])
        .arg(format!(
            "Expand-Archive -LiteralPath '{}' -DestinationPath '{}' -Force",
            quote(&archive.to_string_lossy()),
            quote(&dest.to_string_lossy())
        ));
        if run_hidden(&mut c)?.success() {
            return Ok(());
        }
        Err(AppError(
            "解压失败：系统 tar 与 PowerShell 均无法读取该压缩包".into(),
        ))
    }
    #[cfg(not(windows))]
    {
        let mut c = Command::new("unzip");
        c.arg("-q").arg(archive).arg("-d").arg(dest);
        if run_hidden(&mut c)?.success() {
            return Ok(());
        }
        Err(AppError("解压失败：未找到 unzip".into()))
    }
}

fn run_hidden(cmd: &mut Command) -> Result<std::process::ExitStatus> {
    cmd.stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    // output() drains both pipes, so a chatty tool can never block on a full one.
    Ok(cmd.output()?.status)
}

/* ── Recording ──────────────────────────────────────────────────── */

/// Cheap live-status probe for the monitor loop, used when yt-dlp doesn't
/// recognise the URL at all (e.g. Douyin live, which only this engine can
/// capture here). `--json` resolves the plugin and lists the streams without
/// downloading anything: an object with "streams" means live, an "error"
/// object means otherwise. Returns `(live_status, title, author)`.
pub fn probe_live(
    env: &dyn AppEnv,
    url: &str,
    proxy: Option<&str>,
    cookies: Option<&str>,
) -> std::result::Result<(String, String, String), String> {
    let bin = available(env).ok_or_else(|| "streamlink 未安装".to_string())?;
    let mut args: Vec<String> = vec!["--json".into()];
    if let Some(p) = proxy.filter(|p| !p.is_empty()) {
        args.push(format!("--http-proxy={p}"));
    }
    if let Some(c) = cookies {
        args.push(format!("--cookie-file={c}"));
    }
    args.push(url.to_string());
    let mut cmd = Command::new(&bin);
    cmd.args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUTF8", "1");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let out = cmd
        .output()
        .map_err(|e| format!("启动 streamlink 失败: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let json: serde_json::Value = serde_json::from_str(&stdout).map_err(|_| {
        format!(
            "streamlink 探测输出无法解析（退出码 {}）",
            out.status.code().unwrap_or(-1)
        )
    })?;
    if let Some(err) = json["error"].as_str() {
        // The plugins report an offline channel as "no playable streams".
        if err.contains("No playable streams found") {
            return Ok(("not_live".into(), String::new(), String::new()));
        }
        return Err(err.to_string());
    }
    if json["streams"]
        .as_object()
        .map(|s| s.is_empty())
        .unwrap_or(true)
    {
        return Ok(("not_live".into(), String::new(), String::new()));
    }
    let meta = &json["metadata"];
    let field = |k: &str| {
        meta[k]
            .as_str()
            .filter(|t| !t.trim().is_empty() && *t != "null")
            .unwrap_or_default()
            .to_string()
    };
    let title = {
        let t = field("title");
        if t.is_empty() {
            field("author")
        } else {
            t
        }
    };
    Ok(("is_live".into(), title, field("author")))
}

/// Map the shared quality vocabulary onto streamlink. streamlink names are
/// per-plugin, so a capped request is expressed as a sort exclusion on `best`
/// (which every HTTP plugin resolves) instead of a literal `1080p` name.
fn stream_selection(quality: &str) -> (Vec<String>, String) {
    match quality {
        "" | "best" => (Vec::new(), "best".into()),
        // Live capture has no audio-only mode; take the lowest-bitrate stream
        // with audio rather than failing on an unknown name.
        "audio" => (Vec::new(), "worst".into()),
        other => {
            if let Some(p) = other.strip_suffix('p') {
                if p.parse::<u32>().is_ok() {
                    return (
                        vec!["--stream-sorting-excludes".into(), format!(">{other}")],
                        "best".into(),
                    );
                }
            }
            (Vec::new(), other.to_string())
        }
    }
}

fn build_streamlink_args(
    req: &DownloadRequest,
    ffmpeg: &Path,
    cookies: Option<&str>,
) -> Vec<String> {
    let (excludes, name) = stream_selection(&req.quality);
    let mut a = vec![
        "--stdout".into(),
        // streamlink remuxes the adapted stream for stdout with its own ffmpeg;
        // pin it to the binary this app resolved rather than PATH.
        "--ffmpeg-ffmpeg".into(),
        ffmpeg.to_string_lossy().to_string(),
        // A live playlist can drop mid-recording; poll for it to come back
        // instead of ending the capture on the first hiccup.
        "--retry-streams".into(),
        "5".into(),
        "--retry-max".into(),
        "5".into(),
    ];
    a.extend(excludes);
    if let Some(p) = req.proxy.as_deref().filter(|p| !p.is_empty()) {
        a.push(format!("--http-proxy={p}"));
    }
    if let Some(c) = cookies {
        a.push(format!("--cookie-file={c}"));
    }
    a.push(req.url.clone());
    a.push(name);
    a
}

fn build_muxer_args(out: &Path) -> Vec<String> {
    vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        // Live segments arrive with broken/absent timestamps; regenerate them
        // or the muxer rejects the later input as non-monotonic.
        "-fflags".into(),
        "+genpts".into(),
        "-i".into(),
        "pipe:0".into(),
        "-c".into(),
        "copy".into(),
        // The video plus an audio track when the stream has one.
        "-map".into(),
        "0:v:0".into(),
        "-map".into(),
        "0:a:0?".into(),
        // Matroska, not MP4: live sources routinely carry VP9/Opus, which the
        // MP4 container refuses, and EBML is written as it goes so a killed
        // muxer still leaves a playable file.
        "-f".into(),
        "matroska".into(),
        "-y".into(),
        out.to_string_lossy().to_string(),
    ]
}

/// stderr of a child, drained on a helper thread into a capped buffer so the
/// pipe can never fill and block the process.
fn capture_stderr(stream: Option<impl Read + Send + 'static>) -> Arc<Mutex<Vec<u8>>> {
    let buf: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
    let Some(mut r) = stream else { return buf };
    let sink = buf.clone();
    const CAP: usize = 200_000;
    std::thread::spawn(move || {
        let mut chunk = [0u8; 4096];
        loop {
            match r.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => {
                    let mut g = sink.lock().unwrap();
                    let take = (CAP - g.len()).min(n);
                    g.extend_from_slice(&chunk[..take]);
                }
                Err(_) => break,
            }
        }
    });
    buf
}

struct Session {
    writer: Arc<Mutex<std::process::Child>>,
    muxer: Arc<Mutex<std::process::Child>>,
    writer_log: Arc<Mutex<Vec<u8>>>,
    muxer_log: Arc<Mutex<Vec<u8>>>,
}

impl Session {
    fn spawn(bin: &Path, sl_args: &[String], ffmpeg: &Path, mux_args: &[String]) -> Result<Self> {
        let mut sl = Command::new(bin);
        sl.args(sl_args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // streamlink is a Python program; a GBK console encoding on zh-CN
        // Windows would corrupt its log text the same way it does yt-dlp's.
        sl.env("PYTHONIOENCODING", "utf-8").env("PYTHONUTF8", "1");

        let mut ff = Command::new(ffmpeg);
        ff.args(mux_args)
            .stdout(Stdio::null())
            .stderr(Stdio::piped());

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            sl.creation_flags(0x0800_0000);
            ff.creation_flags(0x0800_0000);
        }

        let mut sl_child = sl.spawn().map_err(AppError::from)?;
        let writer_log = capture_stderr(sl_child.stderr.take());
        let Some(pipe) = sl_child.stdout.take() else {
            let _ = crate::state::kill_tree(&mut sl_child);
            return Err(AppError("无法建立 streamlink → ffmpeg 管道".into()));
        };
        ff.stdin(Stdio::from(pipe));
        let mut ff_child = ff.spawn().map_err(AppError::from)?;
        let muxer_log = capture_stderr(ff_child.stderr.take());
        Ok(Session {
            writer: Arc::new(Mutex::new(sl_child)),
            muxer: Arc::new(Mutex::new(ff_child)),
            writer_log,
            muxer_log,
        })
    }

    fn writer_exited(&self) -> bool {
        self.writer
            .lock()
            .map(|mut c| matches!(c.try_wait(), Ok(Some(_))))
            .unwrap_or(true)
    }

    fn kill_writer(&self) {
        if let Ok(mut c) = self.writer.lock() {
            // streamlink is a PyInstaller one-file exe: killing only the
            // bootloader orphans the real capture process, which keeps the
            // pipe (and the recording) alive.
            let _ = crate::state::kill_tree(&mut c);
        }
    }

    /// Wait for the muxer to close the file after EOF; kill only if it stalls.
    fn wait_muxer(&self) {
        let deadline = Instant::now() + MUXER_GRACE;
        while Instant::now() < deadline {
            let done = self
                .muxer
                .lock()
                .map(|mut c| matches!(c.try_wait(), Ok(Some(_)) | Err(_)))
                .unwrap_or(true);
            if done {
                return;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        if let Ok(mut c) = self.muxer.lock() {
            if matches!(c.try_wait(), Ok(None)) {
                let _ = c.kill();
                let _ = c.wait();
            }
        }
    }

    fn muxer_code(&self) -> Option<i32> {
        self.muxer
            .lock()
            .ok()
            .and_then(|mut c| c.try_wait().ok().flatten())
            .map(|s| s.code().unwrap_or(-1))
    }

    fn error_detail(&self) -> String {
        let read = |b: &Arc<Mutex<Vec<u8>>>| {
            let g = b.lock().unwrap();
            ytdlp::tail_text(&String::from_utf8_lossy(&g))
        };
        let writer = read(&self.writer_log);
        let muxer = read(&self.muxer_log);
        [writer, muxer]
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n")
    }
}

/// Record a live stream until it ends, the user cancels, or the optional
/// duration limit is reached (the file is kept in every case). Blocks the
/// calling thread and emits the same events as a yt-dlp capture, so the
/// frontend and the post-processing pipeline never learn which engine ran.
pub fn run_record_blocking(
    ctx: &Ctx,
    bin: &Path,
    req: DownloadRequest,
    id: &str,
    pipeline: Vec<WorkflowStepInput>,
    upload_to: Vec<String>,
) {
    let kind = "record".to_string();
    let fail = |e: String| {
        emit_dl_done(
            ctx,
            id,
            false,
            false,
            &kind,
            None,
            Some(e),
            false,
            &pipeline,
        )
    };

    let ffmpeg = match crate::ffmpeg::resolve(&*ctx.env, "ffmpeg") {
        Some(p) => p,
        None => return fail("找不到 ffmpeg：直播录制需要它来封装流".into()),
    };
    if let Err(e) = std::fs::create_dir_all(&req.output_dir) {
        return fail(format!("无法创建输出目录: {e}"));
    }
    let out = unique_record_path(Path::new(&req.output_dir), &req);

    // A cookies.txt file (explicit path or materialised pasted text) works
    // the same way for streamlink as it does for yt-dlp.
    let cookies = crate::ytdlp::cookies_path(
        &*ctx.env,
        &crate::ytdlp::NetOptions {
            cookies_file: req.cookies_file.clone(),
            cookies_text: req.cookies_text.clone(),
            proxy: None,
        },
    );

    let session = match Session::spawn(
        bin,
        &build_streamlink_args(&req, &ffmpeg, cookies.as_deref()),
        &ffmpeg,
        &build_muxer_args(&out),
    ) {
        Ok(s) => s,
        Err(e) => return fail(format!("启动 streamlink 失败: {e}")),
    };
    let Session { writer, muxer, .. } = &session;
    let manager = ctx.jobs.clone();
    manager.register(id, writer.clone());
    manager.attach(id, muxer.clone());
    // A cancel between spawn and register would have missed the child.
    if manager.is_cancelled(id) {
        session.kill_writer();
    }

    let title = req.title.clone().unwrap_or_else(|| filename_of(&out));
    emit(
        ctx.emitter.as_ref(),
        "download-started",
        &DownloadStartedEvent {
            id: id.to_string(),
            url: req.url.clone(),
            title,
            kind: kind.clone(),
            pipeline: pipeline.clone(),
            upload_to,
        },
    );

    let started = Instant::now();
    let limit = req.max_duration_sec.filter(|l| *l > 0);
    let mut prev_size = 0_u64;
    let mut prev_at = started;

    loop {
        std::thread::sleep(POLL);
        let size = file_size(&out);
        let elapsed = started.elapsed().as_secs_f64();
        let window = elapsed - prev_at.elapsed().as_secs_f64();
        let speed = if window > 0.5 {
            Some(format_speed(size.saturating_sub(prev_size) as f64 / window))
        } else {
            None
        };
        prev_size = size;
        prev_at = Instant::now();

        let _ = emit(
            ctx.emitter.as_ref(),
            "download-progress",
            &DownloadProgressEvent {
                id: id.to_string(),
                // A live stream has no total, so percent is only meaningful
                // against a duration limit.
                percent: limit
                    .map(|l| (elapsed / l as f64 * 100.0).clamp(0.0, 99.0))
                    .unwrap_or(0.0),
                phase: "running".into(),
                speed,
                eta: limit.map(|l| format_secs(l as f64 - elapsed)),
                downloaded_bytes: Some(size),
                total_bytes: None,
                postprocessing: Some(false),
            },
        );

        let cancelled = manager.is_cancelled(id);
        let limit_hit = limit.map(|l| elapsed >= l as f64).unwrap_or(false);
        if !(cancelled || limit_hit || session.writer_exited()) {
            continue;
        }

        if !session.writer_exited() {
            session.kill_writer();
        }
        session.wait_muxer();
        manager.finish(id);

        if cancelled {
            // Keep what was already captured: footage the user watched is more
            // useful than a tidy disk, and Matroska is written as it streams.
            return emit_dl_done(
                ctx,
                id,
                false,
                true,
                &kind,
                Some(out.to_string_lossy().to_string()),
                Some("已取消".into()),
                false,
                &pipeline,
            );
        }
        // A stream that ended by itself can still leave a valid file behind.
        let muxed = session.muxer_code().unwrap_or(-1) == 0;
        let captured = file_size(&out);
        if captured < 1024 && !muxed {
            let detail = session.error_detail();
            let _ = std::fs::remove_file(&out);
            let msg = format!(
                "streamlink 录制失败{}",
                if detail.is_empty() {
                    String::new()
                } else {
                    format!("\n\n{detail}")
                }
            );
            return emit_dl_done(
                ctx,
                id,
                false,
                false,
                &kind,
                None,
                Some(msg),
                false,
                &pipeline,
            );
        }
        let final_size = file_size(&out);
        let _ = emit(
            ctx.emitter.as_ref(),
            "download-progress",
            &DownloadProgressEvent {
                id: id.to_string(),
                percent: 100.0,
                phase: "done".into(),
                speed: None,
                eta: None,
                downloaded_bytes: Some(final_size),
                total_bytes: Some(final_size),
                postprocessing: Some(false),
            },
        );
        return emit_dl_done(
            ctx,
            id,
            true,
            false,
            &kind,
            Some(out.to_string_lossy().to_string()),
            None,
            limit_hit,
            &pipeline,
        );
    }
}

fn file_size(path: &Path) -> u64 {
    std::fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

fn filename_of(path: &Path) -> String {
    path.file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "直播".into())
}

/// `标题 [YYYYMMDDHHMMSS].mkv`, mirroring the yt-dlp record naming.
fn unique_record_path(dir: &Path, req: &DownloadRequest) -> PathBuf {
    let title = req
        .title
        .as_deref()
        .map(|t| {
            t.chars()
                // Path separators and control chars would escape the output dir.
                .filter(|c| {
                    !matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
                        && *c as u32 >= 0x20
                })
                .collect::<String>()
        })
        .map(|t| t.trim().chars().take(120).collect::<String>())
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| "直播".into());
    let stamp = epoch_to_civil(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0),
    );
    let mut out = dir.join(format!("{title} [{stamp}].mkv"));
    // Two monitors going live in the same second would otherwise collide.
    for n in 1.. {
        if !out.exists() {
            return out;
        }
        out = dir.join(format!("{title} [{stamp}] ({n}).mkv"));
    }
    unreachable!()
}

/// Unix seconds → UTC `YYYYMMDDHHMMSS`, without pulling in a date crate.
fn epoch_to_civil(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (h, mi, s) = (rem / 3600, rem % 3600 / 60, rem % 60);
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y0 = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y0 + 1 } else { y0 };
    format!("{y:04}{m:02}{d:02}{h:02}{mi:02}{s:02}")
}

fn format_secs(secs: f64) -> String {
    let s = secs.max(0.0) as u64;
    if s >= 3600 {
        format!("{}:{:02}:{:02}", s / 3600, s % 3600 / 60, s % 60)
    } else {
        format!("{}:{:02}", s / 60, s % 60)
    }
}
