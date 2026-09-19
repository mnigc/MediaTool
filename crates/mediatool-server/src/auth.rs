//! Bearer-token gate for the API and the WebSocket.
//!
//! Browsers cannot set headers on a WebSocket handshake, so the token is also
//! accepted as a `?token=` query parameter there. That value lands in proxy
//! access logs, which is why this is LAN-grade auth and not a public-internet
//! boundary.

use axum::extract::Request;
use axum::http::header;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;

#[derive(Clone)]
pub struct Auth {
    token: String,
}

impl Auth {
    pub fn new(token: String) -> Self {
        Self { token }
    }
}

/// Reject anything that does not carry the configured token.
pub async fn require_token(auth: axum::extract::State<Auth>, req: Request, next: Next) -> Response {
    let supplied = header_token(req.headers()).or_else(|| query_token(req.uri().query()));

    let ok = supplied.is_some_and(|s| matches(&s, &auth.token));
    if !ok {
        return (
            axum::http::StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "缺少或错误的访问令牌" })),
        )
            .into_response();
    }
    next.run(req).await
}

fn header_token(headers: &axum::http::HeaderMap) -> Option<String> {
    let raw = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    raw.strip_prefix("Bearer ")
        .or_else(|| raw.strip_prefix("bearer "))
        .map(str::to_string)
}

fn query_token(query: Option<&str>) -> Option<String> {
    let pair = query?.split('&').find(|p| p.starts_with("token="))?;
    let value = pair.strip_prefix("token=")?;
    (!value.is_empty()).then(|| urldecode(value))
}

/// Compare without leaking the token's contents through timing.
fn matches(actual: &str, expected: &str) -> bool {
    let (a, b) = (actual.as_bytes(), expected.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Tokens are URL-encoded by the client; `%` escapes are the only thing that
/// can change the bytes.
fn urldecode(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
                match hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                    Some(b) => {
                        out.push(b);
                        i += 3;
                    }
                    None => {
                        out.push(bytes[i]);
                        i += 1;
                    }
                }
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_reads_from_header_and_query() {
        let mut h = axum::http::HeaderMap::new();
        h.insert(header::AUTHORIZATION, "Bearer abc123".parse().unwrap());
        assert_eq!(header_token(&h).as_deref(), Some("abc123"));
        assert_eq!(
            query_token(Some("x=1&token=abc123")).as_deref(),
            Some("abc123")
        );
        assert_eq!(query_token(Some("token=a%20b")).as_deref(), Some("a b"));
        assert_eq!(query_token(Some("other=1")), None);
    }

    #[test]
    fn compare_is_exact() {
        assert!(matches("abc", "abc"));
        assert!(!matches("abc", "abd"));
        assert!(!matches("abc", "abcd"));
        assert!(!matches("", "a"));
    }
}
