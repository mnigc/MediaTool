//! The OAuth callback page the provider redirects the browser back to.
//!
//! This route is unauthenticated on purpose: the user's browser arrives here
//! straight from Google/Microsoft and carries no token. The `state` parameter
//! is the credential — a 32-character random string only the app that started
//! the flow knows, and the engine's grant registry accepts it once.

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{Query, State};
use axum::response::Html;

use mediatool_core::upload::{self, OauthCallbackReply};

use crate::rpc::AppState;

pub async fn callback(
    State(state): State<Arc<AppState>>,
    Query(params): Query<HashMap<String, String>>,
) -> Html<String> {
    let ctx = state.ctx.clone();
    let code = value(&params, "code");
    let error = value(&params, "error_description").or_else(|| value(&params, "error"));
    let grant_state = value(&params, "state").unwrap_or_default();

    // The exchange talks to the provider over blocking I/O; keep it off the
    // async worker so one stalled consent page cannot block the API.
    let reply = tokio::task::spawn_blocking(move || {
        upload::oauth_complete(&ctx, &grant_state, code.as_deref(), error.as_deref())
    })
    .await
    .unwrap_or_else(|_| OauthCallbackReply {
        ok: false,
        error: Some("服务器内部错误".into()),
    });

    Html(page(&reply))
}

fn value(params: &HashMap<String, String>, key: &str) -> Option<String> {
    params
        .get(key)
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn page(reply: &OauthCallbackReply) -> String {
    let (title, hint) = if reply.ok {
        ("✅ 授权完成", "MediaTool 已收到授权，请回到设置页面。")
    } else {
        (
            "❌ 授权失败",
            reply.error.as_deref().unwrap_or("请回到 MediaTool 重试。"),
        )
    };
    // This tab is terminal either way; the result reaches the app over the
    // WebSocket, not by keeping the page alive.
    format!(
        "<!doctype html><html lang=\"zh-CN\"><meta charset=\"utf-8\">\
         <title>MediaTool 授权</title>\
         <body style=\"font-family:system-ui,sans-serif;text-align:center;padding-top:4rem;color:#eee;background:#1e1e1e\">\
         <h2>{title}</h2><p>{}</p>\
         <p style=\"color:#888\">可以关闭此标签页。</p></body></html>",
        escape(hint)
    )
}

/// Provider error text goes into the page verbatim, so it has to be escaped.
fn escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_error_text_cannot_inject_markup() {
        let reply = OauthCallbackReply {
            ok: false,
            error: Some("<script>alert(1)</script>".into()),
        };
        let html = page(&reply);
        assert!(!html.contains("<script>alert"), "got {html}");
        assert!(html.contains("&lt;script&gt;"));
    }

    #[test]
    fn blank_query_values_count_as_absent() {
        let mut params = HashMap::new();
        params.insert("code".to_string(), "  ".into());
        params.insert("state".to_string(), "abc".into());
        assert_eq!(value(&params, "code"), None);
        assert_eq!(value(&params, "state").as_deref(), Some("abc"));
        assert_eq!(value(&params, "missing"), None);
    }
}
