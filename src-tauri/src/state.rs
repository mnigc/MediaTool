use std::collections::HashMap;
use std::process::Child;
use std::sync::{Arc, Mutex};

use crate::models::WorkflowStepInput;

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

#[derive(Default)]
pub struct JobManager {
    pub children: Mutex<HashMap<String, Arc<Mutex<Child>>>>,
    /// Extra children owned by the same job (e.g. the ffmpeg muxer behind a
    /// streamlink pipe). Killed only after the main child, so the writer side
    /// closes the pipe first and the muxer can finalize the output file.
    attached: Mutex<HashMap<String, Vec<Arc<Mutex<Child>>>>>,
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
        self.attached
            .lock()
            .unwrap()
            .entry(id.to_string())
            .or_default()
            .push(child);
    }

    fn attached_of(&self, id: &str) -> Vec<Arc<Mutex<Child>>> {
        self.attached.lock().unwrap().get(id).cloned().unwrap_or_default()
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
    /// Peers are killed after a short grace period so the main child closes
    /// its output pipe first and the muxer can finalize the file.
    pub fn kill(&self, id: &str) {
        if let Some(child) = self.children.lock().unwrap().get(id) {
            let _ = child.lock().unwrap().kill();
        }
        let peers = self.attached_of(id);
        if !peers.is_empty() {
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(400));
                for c in peers {
                    let _ = c.lock().unwrap().kill();
                }
            });
        }
    }

    /// Kill every live child. Called on app exit so closing the window doesn't
    /// leave orphan ffmpeg processes burning CPU and writing partial outputs.
    pub fn kill_all(&self) {
        for child in self.children.lock().unwrap().values() {
            let _ = child.lock().unwrap().kill();
        }
        for peers in self.attached.lock().unwrap().values() {
            for child in peers {
                let _ = child.lock().unwrap().kill();
            }
        }
    }

    pub fn finish(&self, id: &str) {
        self.children.lock().unwrap().remove(id);
        self.attached.lock().unwrap().remove(id);
        self.cancelled.lock().unwrap().remove(id);
        self.active_dls.lock().unwrap().remove(id);
    }

    pub fn track_dl(&self, id: &str, info: ActiveDlInfo) {
        self.active_dls.lock().unwrap().insert(id.to_string(), info);
    }

    pub fn untrack_dl(&self, id: &str) {
        self.active_dls.lock().unwrap().remove(id);
    }

    pub fn active_dls(&self) -> Vec<(String, ActiveDlInfo)> {
        self
            .active_dls
            .lock()
            .unwrap()
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }
}
