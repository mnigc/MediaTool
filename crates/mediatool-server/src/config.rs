//! Server configuration: a TOML file plus `MEDIATOOL_*` environment overrides.
//!
//! Container deployments normally pass everything through env vars; the file
//! exists so a bare `mediatool-server` run picks up the same settings.

use std::path::PathBuf;

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Config {
    /// Address and port to bind, e.g. `0.0.0.0:8787`.
    pub listen: String,
    /// Access token required on every API call and WebSocket upgrade.
    /// Empty means the server refuses to start — see `Config::validate`.
    pub token: String,
    /// Writable dir for managed binaries, cookies and monitor state.
    pub data_dir: PathBuf,
    /// Bundled resources dir; absent in containers, which use PATH binaries.
    pub resource_dir: Option<PathBuf>,
    /// Directory trees the browser UI may list and read. Everything outside is
    /// rejected, so this is also the security boundary.
    pub roots: Vec<PathBuf>,
    /// Static frontend to serve at `/` (skip when the dir is missing).
    pub static_dir: Option<PathBuf>,
    /// Externally reachable base URL of this server, e.g.
    /// `https://nas.example.com:8787`. OAuth redirects must point at whatever
    /// the *browser* can reach, which is not the bind address, so this has to
    /// be configured. Without it browser OAuth (YouTube/Drive/OneDrive) is
    /// unavailable; every other feature works.
    pub public_url: Option<String>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            listen: "0.0.0.0:8787".into(),
            token: String::new(),
            data_dir: "/data".into(),
            resource_dir: None,
            roots: Vec::new(),
            static_dir: Some("./web".into()),
            public_url: None,
        }
    }
}

impl Config {
    /// `MEDIATOOL_CONFIG` points at the file; otherwise `config.toml` next to
    /// the data dir. A missing file is fine — env vars and defaults carry it.
    pub fn load() -> Self {
        let path = std::env::var("MEDIATOOL_CONFIG")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("config.toml"));
        let mut cfg = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| toml::from_str::<Config>(&s).ok())
            .unwrap_or_default();
        cfg.apply_env();
        cfg
    }

    fn apply_env(&mut self) {
        if let Ok(v) = std::env::var("MEDIATOOL_LISTEN") {
            self.listen = v;
        }
        if let Ok(v) = std::env::var("MEDIATOOL_TOKEN") {
            self.token = v;
        }
        if let Ok(v) = std::env::var("MEDIATOOL_DATA") {
            self.data_dir = v.into();
        }
        if let Ok(v) = std::env::var("MEDIATOOL_RESOURCES") {
            self.resource_dir = Some(v.into());
        }
        if let Ok(v) = std::env::var("MEDIATOOL_ROOTS") {
            self.roots = split_paths(&v);
        }
        if let Ok(v) = std::env::var("MEDIATOOL_STATIC") {
            self.static_dir = Some(v.into());
        }
        if let Ok(v) = std::env::var("MEDIATOOL_PUBLIC_URL") {
            self.public_url = Some(v);
        }
    }

    /// Fail fast on a config that would leave the engine unusable or the port
    /// wide open, rather than starting and erroring on the first job.
    pub fn validate(&self) -> Result<(), String> {
        if self.token.is_empty() {
            return Err(
                "未配置访问令牌：设置 MEDIATOOL_TOKEN 或 config.toml 的 token（服务会暴露文件浏览与转码能力，不能匿名开放）".into(),
            );
        }
        if self.roots.is_empty() {
            return Err(
                "未配置可访问目录：设置 MEDIATOOL_ROOTS（逗号分隔）或 config.toml 的 roots".into(),
            );
        }
        // A blank value means "not configured" (compose passes `${PUBLIC_URL:-}`
        // through as empty), so only a non-empty one has to look like a URL.
        if let Some(url) = self.oauth_base() {
            if !(url.starts_with("http://") || url.starts_with("https://")) {
                return Err(format!(
                    "MEDIATOOL_PUBLIC_URL 需要带协议，例如 http://192.168.1.10:8787（当前值：{url}）"
                ));
            }
        }
        Ok(())
    }

    /// The base URL for OAuth redirects, or `None` when unset/blank.
    pub fn oauth_base(&self) -> Option<String> {
        self.public_url
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    }
}

/// Split a separated list. `,` and `;` are both illegal in a Windows path and
/// rare in a POSIX one; `:` is deliberately not a separator because it appears
/// in `C:\` drive prefixes.
fn split_paths(raw: &str) -> Vec<PathBuf> {
    raw.split([',', ';'])
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roots_list_splits_on_comma_and_semicolon() {
        assert_eq!(
            split_paths("/a,/b;/c ,, /d"),
            vec![
                PathBuf::from("/a"),
                PathBuf::from("/b"),
                PathBuf::from("/c"),
                PathBuf::from("/d")
            ]
        );
    }

    #[test]
    fn windows_drive_prefixes_survive_parsing() {
        let parsed = split_paths("C:\\media,D:\\videos");
        assert_eq!(parsed[0], PathBuf::from("C:\\media"));
        assert_eq!(parsed[1], PathBuf::from("D:\\videos"));
    }

    #[test]
    fn refuses_to_start_without_a_token_or_any_root() {
        assert!(Config {
            token: String::new(),
            roots: vec!["/a".into()],
            ..Default::default()
        }
        .validate()
        .is_err());
        assert!(Config {
            token: "t".into(),
            roots: Vec::new(),
            ..Default::default()
        }
        .validate()
        .is_err());
        assert!(Config {
            token: "t".into(),
            roots: vec!["/a".into()],
            ..Default::default()
        }
        .validate()
        .is_ok());
    }

    #[test]
    fn oauth_base_needs_a_scheme() {
        let base = |v: &str| Config {
            token: "t".into(),
            roots: vec!["/a".into()],
            public_url: Some(v.into()),
            ..Default::default()
        };
        assert!(base("nas.local:8787").validate().is_err());
        assert!(base("http://nas.local:8787").validate().is_ok());
        // Blank means "not configured", not "redirect to /oauth/callback".
        assert_eq!(base("   ").oauth_base(), None);
        assert!(base("").validate().is_ok());
        assert_eq!(
            base("http://192.168.1.10:8787").oauth_base().as_deref(),
            Some("http://192.168.1.10:8787")
        );
    }
}
