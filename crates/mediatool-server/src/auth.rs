//! Bearer-token gate for the API and the WebSocket.
//!
//! Most endpoints accept only the `Authorization` header. Two of them — the
//! WebSocket upgrade and `/api/media` — also accept a `?token=` query
//! parameter, because a browser can attach neither a header to a WS handshake
//! nor to a `<video>` element. That value lands in proxy access logs, which
//! is why the concession is scoped to exactly those routes and why this is
//! LAN-grade auth and not a public-internet boundary.

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

/// Reject anything that does not carry the configured token in the
/// `Authorization` header. Used for the JSON API.
pub async fn require_token(auth: axum::extract::State<Auth>, req: Request, next: Next) -> Response {
    gate(auth, req, next, false).await
}

/// Same gate, but also accepting `?token=`. Only for the WebSocket upgrade
/// (`/api/events`) and `/api/media`: their clients cannot set headers (see
/// the module docs). Everything else must present the header, so a leaked
/// query string cannot authenticate the rest of the API.
pub async fn require_token_with_query(
    auth: axum::extract::State<Auth>,
    req: Request,
    next: Next,
) -> Response {
    gate(auth, req, next, true).await
}

async fn gate(
    auth: axum::extract::State<Auth>,
    req: Request,
    next: Next,
    allow_query_token: bool,
) -> Response {
    let header = header_token(req.headers());
    let supplied = if allow_query_token {
        header.or_else(|| query_token(req.uri().query()))
    } else {
        header
    };

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
    // Fold the length difference into the accumulator and walk the longer
    // side (short side padded with zero): bailing out early on a length
    // mismatch would tell a caller how long the real token is.
    let mut diff = (a.len() ^ b.len()) as u32;
    for i in 0..a.len().max(b.len()) {
        let x = a.get(i).copied().unwrap_or(0);
        let y = b.get(i).copied().unwrap_or(0);
        diff |= (x ^ y) as u32;
    }
    diff == 0
}

/// Tokens are URL-encoded by the client, but with `encodeURI`, not form
/// encoding: only `%XX` escapes are decoded and a literal `+` must stay a
/// `+`, or a token containing one can never authenticate.
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
    fn urldecode_keeps_literal_plus() {
        // Clients use encodeURI (not form encoding), so `+` is not a space.
        assert_eq!(query_token(Some("token=a+b")).as_deref(), Some("a+b"));
        assert_eq!(query_token(Some("token=%2B")).as_deref(), Some("+"));
    }

    #[test]
    fn compare_is_exact() {
        assert!(matches("abc", "abc"));
        assert!(!matches("abc", "abd"));
        assert!(!matches("abc", "abcd"));
        assert!(!matches("", "a"));
    }
}
