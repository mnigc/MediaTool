use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

use tauri::Manager;

use crate::error::{AppError, Result};

/// Platform-specific binary name (ffmpeg / ffprobe).
pub fn binary_name(base: &str) -> String {
    if cfg!(windows) {
        format!("{}.exe", base)
    } else {
        base.to_string()
    }
}

/// Locate a binary: next to the running executable, then walking up the
/// directory tree looking for a `binaries/` folder (dev layout:
/// `src-tauri/binaries`), then the resource dir, then the system PATH
/// (verified by a quick `-version` probe).
pub fn resolve(app: &tauri::AppHandle, base: &str) -> Option<PathBuf> {
    let name = binary_name(base);

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let p = dir.join(&name);
            if p.exists() {
                return Some(p);
            }

            // Walk up the directory tree looking for a `binaries` folder that
            // holds the sidecar (e.g. src-tauri/binaries when running a dev
            // build from src-tauri/target/debug).
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

    if let Ok(res) = app.path().resource_dir() {
        let p = res.join(&name);
        if p.exists() {
            return Some(p);
        }
        let p = res.join("binaries").join(&name);
        if p.exists() {
            return Some(p);
        }
    }

    if Command::new(&name)
        .arg("-version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
    {
        return Some(PathBuf::from(&name));
    }

    None
}

/// Spawn a process, returning the child handle, its stdout pipe, and a shared
/// buffer that captures stderr (used to surface FFmpeg error output on failure).
pub fn spawn(
    app: &tauri::AppHandle,
    base: &str,
    args: &[String],
) -> Result<(std::process::Child, std::process::ChildStdout, Arc<Mutex<Vec<u8>>>)> {
    let bin = resolve(app, base).ok_or_else(|| {
        AppError(format!(
            "找不到 {}：请将 FFmpeg 放在程序同目录，或安装到系统 PATH 中",
            base
        ))
    })?;

    let mut cmd = Command::new(&bin);
    cmd.args(args).stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(AppError::from)?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError("无法获取子进程 stdout".into()))?;

    // FFmpeg writes per-frame stats to stderr by default. Drain stderr in a
    // background thread so the pipe buffer never fills and blocks the process,
    // while capturing it for error reporting (capped to avoid unbounded growth).
    let stderr_buf: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
    if let Some(stderr) = child.stderr.take() {
        let buf_clone = stderr_buf.clone();
        const CAP: usize = 200_000;
        std::thread::spawn(move || {
            let mut r = stderr;
            let mut chunk = [0u8; 4096];
            loop {
                match r.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(n) => {
                        let mut guard = buf_clone.lock().unwrap();
                        if guard.len() < CAP {
                            let take = (CAP - guard.len()).min(n);
                            guard.extend_from_slice(&chunk[..take]);
                        }
                    }
                    Err(_) => break,
                }
            }
        });
    }

    Ok((child, stdout, stderr_buf))
}
