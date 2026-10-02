use serde::Serialize;

pub type Result<T> = std::result::Result<T, AppError>;

#[derive(Debug, Clone)]
pub struct AppError(pub String);

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for AppError {}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.0)
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError(e.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError(e.to_string())
    }
}

impl From<reqwest::Error> for AppError {
    fn from(e: reqwest::Error) -> Self {
        AppError(sanitize_reqwest_error(&e))
    }
}

/// Render a reqwest error without its URL path/query.
///
/// reqwest's `Display` appends the full URL, and our endpoints put secrets in
/// theirs: the Telegram bot token lives in `…/bot<TOKEN>/…` and OneDrive hands
/// out a pre-authenticated `uploadUrl`. This string reaches frontend events
/// and logs, so report only `scheme://host` + status/error kind.
pub(crate) fn sanitize_reqwest_error(e: &reqwest::Error) -> String {
    let mut out = String::new();
    match e.url() {
        // Path and query are dropped on purpose — that is where the
        // credentials are.
        Some(url) => {
            out.push_str(url.scheme());
            out.push_str("://");
            out.push_str(url.host_str().unwrap_or("<host>"));
            if let Some(port) = url.port() {
                out.push_str(&format!(":{port}"));
            }
        }
        None => out.push_str("<url>"),
    }
    out.push_str(": ");
    if let Some(status) = e.status() {
        out.push_str(&format!("HTTP {status}"));
    } else if e.is_connect() {
        out.push_str("connection failed");
    } else if e.is_body() {
        out.push_str("sending the request body failed");
    } else if e.is_decode() {
        out.push_str("decoding the response failed");
    } else if e.is_redirect() {
        out.push_str("redirect failed");
    } else if e.is_builder() {
        out.push_str("client build failed");
    } else {
        out.push_str("request failed");
    }
    if e.is_timeout() {
        out.push_str(" (timed out)");
    }
    out
}
