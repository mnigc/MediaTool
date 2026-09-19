//! Path allowlist and directory browsing for web mode.
//!
//! The desktop app gets file paths from an OS dialog, which the user is already
//! inside of. Here a browser sends a path string over the network, so every
//! request is checked against `roots` before the filesystem is touched.
//!
//! The check canonicalises first: `..` segments and symlinks are resolved by
//! the OS, so a link inside a media root pointing at `/etc` fails the prefix
//! test instead of slipping through.

use std::path::{Path, PathBuf};

use mediatool_core::error::{AppError, Result};
use serde::Serialize;

/// Refuse to walk directories larger than this; a stray mount at the top of a
/// media tree can hold hundreds of thousands of entries.
const MAX_ENTRIES: usize = 5000;

/// A path as the browser should see it. Windows `canonicalize()` yields
/// verbatim `\\?\` paths, which are meaningless in a UI and cannot be typed
/// back in; the prefix is a no-op to strip on Linux.
pub fn display(path: &Path) -> String {
    let raw = path.to_string_lossy();
    let trimmed = raw
        .strip_prefix(r"\\?\UNC\")
        .map_or(raw.as_ref(), |rest| rest);
    let restored = if raw.starts_with(r"\\?\UNC\") {
        format!(r"\\{trimmed}")
    } else {
        raw.strip_prefix(r"\\?\")
            .unwrap_or(raw.as_ref())
            .to_string()
    };
    restored
}

#[derive(Debug, Clone)]
pub struct Roots {
    allowed: Vec<PathBuf>,
}

impl Roots {
    /// Drop roots that do not exist. A NAS volume that is not mounted yet
    /// should not make the whole server refuse to start; it just shows up as
    /// an empty browser.
    pub fn new(configured: &[PathBuf]) -> Self {
        let allowed = configured
            .iter()
            .filter_map(|p| p.canonicalize().ok())
            .collect();
        Self { allowed }
    }

    pub fn is_empty(&self) -> bool {
        self.allowed.is_empty()
    }

    /// Resolve `raw` and confirm it is `root` itself or below it.
    pub fn resolve(&self, raw: &str) -> Result<PathBuf> {
        if self.allowed.is_empty() {
            return Err(AppError("服务器未配置可访问目录".into()));
        }
        if raw.trim().is_empty() {
            return Err(AppError("路径不能为空".into()));
        }
        let path = Path::new(raw);
        let canonical = path
            .canonicalize()
            .map_err(|e| AppError(format!("路径不存在或不可访问: {e}")))?;
        self.check(&canonical)?;
        Ok(canonical)
    }

    fn check(&self, canonical: &Path) -> Result<()> {
        let ok = self
            .allowed
            .iter()
            .any(|root| canonical.starts_with(root) || canonical == root.as_path());
        if ok {
            Ok(())
        } else {
            Err(AppError("该路径不在服务器允许的目录内".into()))
        }
    }

    pub fn list(&self) -> Vec<String> {
        self.allowed.iter().map(|p| display(p)).collect()
    }

    /// The roots as a directory listing, so the browser's top level has the
    /// same shape as every level below it.
    pub fn as_listing(&self) -> DirListing {
        let entries = self
            .list()
            .into_iter()
            .map(|p| DirEntry {
                name: Path::new(&p)
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| p.clone()),
                path: p,
                is_dir: true,
                size: 0,
                modified: None,
            })
            .collect();
        DirListing {
            path: String::new(),
            parent: None,
            entries,
            truncated: false,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    /// Whole seconds since the Unix epoch; `None` when the OS withholds it.
    pub modified: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirListing {
    pub path: String,
    pub parent: Option<String>,
    pub entries: Vec<DirEntry>,
    /// True when the directory held more than `MAX_ENTRIES` items.
    pub truncated: bool,
}

/// One level of a directory, directories first then names in order.
pub fn list_dir(roots: &Roots, raw: &str) -> Result<DirListing> {
    let dir = roots.resolve(raw)?;
    if !dir.is_dir() {
        return Err(AppError("该路径不是目录".into()));
    }
    let read = std::fs::read_dir(&dir).map_err(AppError::from)?;

    let mut entries = Vec::new();
    let mut truncated = false;
    for item in read.flatten() {
        if entries.len() >= MAX_ENTRIES {
            truncated = true;
            break;
        }
        let path = item.path();
        let meta = match path.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        entries.push(DirEntry {
            name: item.file_name().to_string_lossy().into_owned(),
            path: display(&path),
            is_dir: meta.is_dir(),
            size: if meta.is_dir() { 0 } else { meta.len() },
            modified: meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs()),
        });
    }

    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    let parent = dir
        .parent()
        .and_then(|p| roots.resolve(&p.to_string_lossy()).ok())
        .map(|p| display(&p));

    Ok(DirListing {
        path: display(&dir),
        parent,
        entries,
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile_dir::Dir, PathBuf) {
        tempfile_dir::make("mediatool-roots-test")
    }

    #[test]
    fn allows_paths_under_a_root() {
        let (_guard, base) = fixture();
        let media = base.join("media");
        std::fs::create_dir_all(media.join("sub")).unwrap();
        let roots = Roots::new(std::slice::from_ref(&media));
        assert!(roots.resolve(&media.join("sub").to_string_lossy()).is_ok());
    }

    #[test]
    fn rejects_traversal_outside_the_root() {
        let (_guard, base) = fixture();
        let media = base.join("media");
        std::fs::create_dir_all(&media).unwrap();
        let roots = Roots::new(std::slice::from_ref(&media));
        let escape = media.join("..").join("..");
        assert!(roots.resolve(&escape.to_string_lossy()).is_err());
    }

    #[test]
    fn rejects_the_parent_of_a_root() {
        let (_guard, base) = fixture();
        let media = base.join("media");
        std::fs::create_dir_all(&media).unwrap();
        let roots = Roots::new(std::slice::from_ref(&media));
        assert!(roots.resolve(&base.to_string_lossy()).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinks_pointing_outside() {
        let (_guard, base) = fixture();
        let media = base.join("media");
        let secret = base.join("secret");
        std::fs::create_dir_all(&media).unwrap();
        std::fs::create_dir_all(&secret).unwrap();
        let link = media.join("link");
        if std::os::unix::fs::symlink(&secret, &link).is_err() {
            return; // filesystem without symlink support
        }
        let roots = Roots::new(std::slice::from_ref(&media));
        assert!(roots.resolve(&link.to_string_lossy()).is_err());
    }

    #[test]
    fn missing_roots_are_skipped_not_fatal() {
        let (_guard, base) = fixture();
        let roots = Roots::new(&[base.join("nope")]);
        assert!(roots.is_empty());
        assert!(roots.resolve("/tmp").is_err());
    }

    #[test]
    fn listing_sorts_directories_first() {
        let (_guard, base) = fixture();
        let media = base.join("media");
        std::fs::create_dir_all(media.join("Bee")).unwrap();
        std::fs::write(media.join("a.mkv"), b"x").unwrap();
        std::fs::create_dir_all(media.join("ant")).unwrap();
        let roots = Roots::new(std::slice::from_ref(&media));
        let listing = list_dir(&roots, &media.to_string_lossy()).unwrap();
        let names: Vec<_> = listing.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["ant", "Bee", "a.mkv"]);
        assert!(!listing.truncated);
    }

    #[test]
    fn parent_is_exposed_only_when_it_is_allowed_too() {
        let (_guard, base) = fixture();
        let media = base.join("media");
        std::fs::create_dir_all(media.join("sub")).unwrap();
        let roots = Roots::new(std::slice::from_ref(&media));

        // `media`'s own parent is the scratch dir, outside the allowlist.
        let at_root = list_dir(&roots, &media.to_string_lossy()).unwrap();
        assert_eq!(at_root.parent, None);

        let nested = list_dir(&roots, &media.join("sub").to_string_lossy()).unwrap();
        let expected = display(&media.canonicalize().unwrap());
        assert_eq!(nested.parent.as_deref(), Some(expected.as_str()));
    }

    #[test]
    fn the_roots_are_a_directory_listing_too() {
        let (_guard, base) = fixture();
        let media = base.join("media");
        let out = base.join("out");
        std::fs::create_dir_all(&media).unwrap();
        std::fs::create_dir_all(&out).unwrap();
        let roots = Roots::new(&[media.clone(), out.clone()]);
        let listing = roots.as_listing();
        assert_eq!(listing.path, "");
        assert_eq!(
            listing.parent, None,
            "the top level has nowhere to go up to"
        );
        assert!(!listing.truncated);
        let names: Vec<_> = listing.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["media", "out"]);
        assert!(listing.entries.iter().all(|e| e.is_dir));
        // What the browser shows is the container path; what it sends back
        // must be a path the server accepts.
        let first = &listing.entries[0].path;
        assert!(roots.resolve(first).is_ok());
    }
}

#[cfg(test)]
mod tempfile_dir {
    use std::path::PathBuf;

    pub struct Dir(PathBuf);
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    pub fn make(tag: &str) -> (Dir, PathBuf) {
        let mut p = std::env::temp_dir();
        let unique = format!(
            "{tag}-{}-{:x}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        p.push(unique);
        std::fs::create_dir_all(&p).unwrap();
        (Dir(p.clone()), p)
    }
}
