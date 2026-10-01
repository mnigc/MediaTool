//! Desktop-shell app settings persisted next to the engine's own config files.
//!
//! The close-request handler in `lib.rs` must know the close behavior without
//! going through the frontend, so this lives in a JSON file under the app data
//! dir (same scheme as the engine's `notify_targets.json`) rather than
//! localStorage.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// What happens when the main window is asked to close (X button, Alt+F4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CloseAction {
    /// Hide the window; the tray icon keeps the app and its tasks running.
    #[default]
    Tray,
    /// Quit the app (with an active-task confirmation, handled in lib.rs).
    Exit,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct AppSettings {
    close_action: CloseAction,
}

fn settings_path(env: &dyn mediatool_core::ctx::AppEnv) -> Option<PathBuf> {
    env.app_data_dir().map(|d| d.join("app_settings.json"))
}

fn load(env: &dyn mediatool_core::ctx::AppEnv) -> AppSettings {
    settings_path(env)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save(env: &dyn mediatool_core::ctx::AppEnv, settings: &AppSettings) -> Result<(), String> {
    let Some(path) = settings_path(env) else {
        return Err("no app data dir".into());
    };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let json =
        serde_json::to_string_pretty(settings).map_err(|e| format!("serialize settings: {e}"))?;
    std::fs::write(path, json).map_err(|e| format!("write settings: {e}"))
}

pub fn load_close_action(env: &dyn mediatool_core::ctx::AppEnv) -> CloseAction {
    load(env).close_action
}

pub fn save_close_action(
    env: &dyn mediatool_core::ctx::AppEnv,
    action: CloseAction,
) -> Result<(), String> {
    let mut settings = load(env);
    settings.close_action = action;
    save(env, &settings)
}
