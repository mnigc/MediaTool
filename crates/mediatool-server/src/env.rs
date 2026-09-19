//! [`AppEnv`] for a headless process: fixed directories from config, and
//! "open a URL" degraded to logging it since there is no browser to launch.

use std::path::PathBuf;

use mediatool_core::ctx::AppEnv;

pub struct ServerEnv {
    data_dir: PathBuf,
    resource_dir: Option<PathBuf>,
    oauth_base: Option<String>,
}

impl ServerEnv {
    pub fn new(
        data_dir: PathBuf,
        resource_dir: Option<PathBuf>,
        oauth_base: Option<String>,
    ) -> Self {
        if let Err(e) = std::fs::create_dir_all(&data_dir) {
            tracing::warn!(?data_dir, %e, "数据目录不可写，托管二进制与监控状态将无法保存");
        }
        match &oauth_base {
            Some(base) => tracing::info!(callback = %format!("{base}/oauth/callback"), "浏览器授权回调"),
            None => tracing::warn!(
                "未配置 MEDIATOOL_PUBLIC_URL，网页模式的 YouTube/Google Drive/OneDrive 授权不可用（其余功能不受影响）"
            ),
        }
        Self {
            data_dir,
            resource_dir,
            oauth_base,
        }
    }
}

impl AppEnv for ServerEnv {
    fn resource_dir(&self) -> Option<PathBuf> {
        self.resource_dir.clone()
    }

    fn app_data_dir(&self) -> Option<PathBuf> {
        Some(self.data_dir.clone())
    }

    /// No desktop to hand a browser to: log it so the operator opens the OAuth
    /// consent page themselves. The web UI opens it on its own anyway.
    fn open_url(&self, url: &str) {
        tracing::info!(%url, "请在浏览器中打开此链接完成授权");
    }

    /// The container's own loopback is unreachable from the user's browser, so
    /// OAuth has to come back through this server's public address.
    fn oauth_redirect_base(&self) -> Option<String> {
        self.oauth_base.clone()
    }
}
