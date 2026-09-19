//! JSON-facing wrappers over the allowlisted filesystem views.

use mediatool_core::error::{AppError, Result};
use serde_json::{json, Value};

use crate::paths::{display, list_dir, Roots};

/// Roots the operator mounted; the browser UI opens on this list.
pub fn roots(roots: &Roots) -> Result<Value> {
    Ok(json!(roots.list()))
}

pub fn list(roots: &Roots, path: &str) -> Result<Value> {
    if path.trim().is_empty() {
        // Top of the browser: the mounted roots, shaped like any other
        // directory so the UI never special-cases it.
        return serde_json::to_value(roots.as_listing()).map_err(AppError::from);
    }
    serde_json::to_value(list_dir(roots, path)?).map_err(AppError::from)
}

pub fn stat(roots: &Roots, path: &str) -> Result<Value> {
    let resolved = roots.resolve(path)?;
    let meta = std::fs::metadata(&resolved).map_err(AppError::from)?;
    Ok(json!({
        "path": display(&resolved),
        "isDir": meta.is_dir(),
        "size": meta.len(),
    }))
}
