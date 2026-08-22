use std::io::{BufReader, Read};
use std::path::PathBuf;
use std::process::{Command, Stdio};

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

/// Locate a binary: next to the running executable, then the resource dir,
/// then the system PATH (verified by a quick `-version` probe).
pub fn resolve(app: &tauri::AppHandle, base: &str) -> Option<PathBuf> {
    let name = binary_name(base);

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let p = dir.join(&name);
            if p.exists() {
                return Some(p);
            }
        }
    }

    if let Ok(res) = app.path().resource_dir() {
        let p = res.join(&name);
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

/// Spawn a process, returning the child handle and its stdout pipe.
pub fn spawn(
    app: &tauri::AppHandle,
    base: &str,
    args: &[String],
) -> Result<(std::process::Child, std::process::ChildStdout)> {
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
    // background thread so the pipe buffer never fills and blocks the process.
    if let Some(stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            let mut r = BufReader::new(stderr);
            let mut buf = Vec::new();
            let _ = r.read_to_end(&mut buf);
        });
    }

    Ok((child, stdout))
}
