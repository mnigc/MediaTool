use std::collections::HashMap;
use std::process::Child;
use std::sync::{Arc, Mutex};

#[derive(Default)]
pub struct JobManager {
    pub children: Mutex<HashMap<String, Arc<Mutex<Child>>>>,
    pub cancelled: Mutex<HashMap<String, bool>>,
}

impl JobManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&self, id: &str, child: Arc<Mutex<Child>>) {
        self.children.lock().unwrap().insert(id.to_string(), child);
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

    /// Kill the child process if running. Best-effort.
    pub fn kill(&self, id: &str) {
        if let Some(child) = self.children.lock().unwrap().get(id) {
            let _ = child.lock().unwrap().kill();
        }
    }

    pub fn finish(&self, id: &str) {
        self.children.lock().unwrap().remove(id);
        self.cancelled.lock().unwrap().remove(id);
    }
}
