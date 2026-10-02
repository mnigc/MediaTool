use std::collections::HashMap;
use std::io;
use std::process::Child;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::models::WorkflowStepInput;

/// Kill a child and its whole process tree.
///
/// yt-dlp/streamlink ship as PyInstaller one-file executables: the process we
/// spawn is only the bootloader, and the real downloader runs as its child.
/// `Child::kill()` terminates just the bootloader, orphaning the downloader —
/// it keeps writing the file and holds the inherited stdout pipe, so the
/// job's read loop never ends and a cancel looks ignored. `taskkill /F /T`
/// takes the tree down for real.
pub fn kill_tree(child: &mut Child) -> io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let pid = child.id().to_string();
        let ok = std::process::Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if ok {
            return Ok(());
        }
        // Tree already half-gone (or taskkill missing): plain kill as fallback.
        child.kill()
    }
    #[cfg(not(windows))]
    {
        // Spawn sites in this crate put children in their own process group
        // (see `process_group`), so a negative pid signals the whole tree.
        // The pid stays reserved by the unreaped Child, so it cannot be
        // mistaken for an unrelated group. Engines spawned elsewhere (e.g.
        // yt-dlp's own spawn path) have no such group: kill() then fails and
        // we fall back to the direct child.
        let pid = child.id() as i32;
        if pid > 0 && unsafe { libc::kill(-pid, libc::SIGKILL) } == 0 {
            return Ok(());
        }
        child.kill()
    }
}

/// Put a child into its own process group so `kill_tree` can signal the whole
/// tree on Unix (Windows gets the equivalent for free via `taskkill /T`).
pub(crate) fn process_group(cmd: &mut std::process::Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(not(unix))]
    let _ = cmd;
}

/// What an in-flight download/record looks like to a frontend that missed the
/// `download-started` event (page reload, HMR): enough to rebuild its card.
#[derive(Debug, Clone)]
pub struct ActiveDlInfo {
    pub url: String,
    pub title: String,
    pub kind: String,
    pub pipeline: Vec<WorkflowStepInput>,
    /// Upload targets bound to this acquisition; the frontend uploads the
    /// final product to them when the run completes.
    #[allow(dead_code)]
    pub upload_to: Vec<String>,
}

#[derive(Debug, Clone)]
struct Peer {
    child: Arc<Mutex<Child>>,
    /// How long to wait after the main child dies before killing this peer:
    /// the writer must close the pipe first so the muxer can finalize its
    /// output file. streamlink's ffmpeg muxer needs seconds, not milliseconds.
    grace: Duration,
}

/// Grace used when none was registered explicitly.
const DEFAULT_PEER_GRACE: Duration = Duration::from_millis(400);

#[derive(Default)]
pub struct JobManager {
    pub children: Mutex<HashMap<String, Arc<Mutex<Child>>>>,
    /// Extra children owned by the same job (e.g. the ffmpeg muxer behind a
    /// streamlink pipe). Killed only after the main child, so the writer side
    /// closes the pipe first and the muxer can finalize the output file.
    attached: Mutex<HashMap<String, Vec<Peer>>>,
    pub cancelled: Mutex<HashMap<String, bool>>,
    active_dls: Mutex<HashMap<String, ActiveDlInfo>>,
}

impl JobManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&self, id: &str, child: Arc<Mutex<Child>>) {
        self.children.lock().unwrap().insert(id.to_string(), child);
    }

    /// Register extra children that share the job's lifecycle (pipe peers).
    pub fn attach(&self, id: &str, child: Arc<Mutex<Child>>) {
        self.attach_with_grace(id, child, DEFAULT_PEER_GRACE);
    }

    /// Like `attach`, with an explicit grace before the peer is killed.
    pub fn attach_with_grace(&self, id: &str, child: Arc<Mutex<Child>>, grace: Duration) {
        self.attached
            .lock()
            .unwrap()
            .entry(id.to_string())
            .or_default()
            .push(Peer { child, grace });
    }

    fn attached_of(&self, id: &str) -> Vec<Peer> {
        self.attached
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .unwrap_or_default()
    }

    pub fn mark_cancelled(&self, id: &str) {
        self.cancelled.lock().unwrap().insert(id.to_string(), true);
    }

    pub fn is_cancelled(&self, id: &str) -> bool {
        self.cancelled
            .lock()
            .unwrap()
            .get(id)
            .copied()
            .unwrap_or(false)
    }

    /// Kill the child process (and any pipe peers) if running. Best-effort.
    /// Peers are killed after their registered grace period so the main child
    /// closes its output pipe first and the muxer can finalize the file.
    pub fn kill(&self, id: &str) {
        if let Some(child) = self.children.lock().unwrap().get(id) {
            // A silently-failed kill strands the process with no card to
            // retry from — surface it.
            if let Err(e) = kill_tree(&mut child.lock().unwrap()) {
                eprintln!("kill job {id}: {e}");
            }
        }
        let peers = self.attached_of(id);
        if !peers.is_empty() {
            let id = id.to_string();
            std::thread::spawn(move || kill_peers_after_grace(peers, &id));
        }
    }

    /// Kill every live child. Called on app exit so closing the window doesn't
    /// leave orphan ffmpeg processes burning CPU and writing partial outputs.
    /// Waits out each peer's grace inline: the process is going away, so this
    /// is the last chance for the muxer to finalize its file.
    pub fn kill_all(&self) {
        for child in self.children.lock().unwrap().values() {
            let _ = kill_tree(&mut child.lock().unwrap());
        }
        for (id, peers) in self.attached.lock().unwrap().drain() {
            kill_peers_after_grace(peers, &id);
        }
    }

    pub fn finish(&self, id: &str) {
        self.children.lock().unwrap().remove(id);
        self.attached.lock().unwrap().remove(id);
        self.active_dls.lock().unwrap().remove(id);
        // The cancelled latch intentionally survives finish(): a multi-run job
        // calls finish() between runs, and clearing here would erase a cancel
        // that lands in the gap, letting the remaining runs execute. Runs
        // reset the latch via `begin` at start instead.
    }

    /// Reset the cancel latch for `id` at the start of a run. Callers must
    /// invoke this before the id is observable by the frontend — a cancel
    /// arriving after this point has to stay latched for the whole task.
    pub fn begin(&self, id: &str) {
        self.cancelled.lock().unwrap().remove(id);
    }

    pub fn track_dl(&self, id: &str, info: ActiveDlInfo) {
        self.active_dls.lock().unwrap().insert(id.to_string(), info);
    }

    pub fn untrack_dl(&self, id: &str) {
        self.active_dls.lock().unwrap().remove(id);
    }

    pub fn active_dls(&self) -> Vec<(String, ActiveDlInfo)> {
        self.active_dls
            .lock()
            .unwrap()
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }

    /// How many jobs have a live child process right now. Queued jobs the
    /// frontend has not started yet are not visible here — they exist only
    /// in the frontend's task center and simply never start on exit.
    pub fn active_job_count(&self) -> usize {
        self.children.lock().unwrap().len()
    }
}

/// Kill each pipe peer once its own grace has elapsed, so a muxer gets the
/// time it needs to finalize before being torn down.
fn kill_peers_after_grace(peers: Vec<Peer>, id: &str) {
    for p in peers {
        std::thread::sleep(p.grace);
        if let Err(e) = kill_tree(&mut p.child.lock().unwrap()) {
            eprintln!("kill attached job {id}: {e}");
        }
    }
}
