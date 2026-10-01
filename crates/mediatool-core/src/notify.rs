//! Out-of-band event pushes for live monitors: a Telegram bot message and a
//! generic JSON webhook. Both carry the same payload, so one config covers
//! Telegram plus any JSON-speaking receiver (DingTalk, Feishu, Bark, …).
//!
//! Sending is fire-and-forget on a detached thread: a slow or dead endpoint
//! must never stall the monitor loop or the recording it accompanies.

use serde::{Deserialize, Serialize};
use std::time::Duration;

use crate::ctx::AppEnv;
use crate::error::AppError;

/// The one notification config every monitor shares, persisted as
/// `<app_data>/notify_targets.json` so the desktop app and the headless
/// server push from the same registry.
pub fn load_targets(env: &dyn AppEnv) -> Vec<NotifyTarget> {
    let Some(dir) = env.app_data_dir() else {
        return vec![];
    };
    let Ok(text) = std::fs::read_to_string(dir.join("notify_targets.json")) else {
        return vec![];
    };
    serde_json::from_str(&text).unwrap_or_default()
}

pub fn save_targets(env: &dyn AppEnv, targets: &[NotifyTarget]) -> Result<(), AppError> {
    let Some(dir) = env.app_data_dir() else {
        return Err(AppError("无应用数据目录".into()));
    };
    std::fs::create_dir_all(&dir).map_err(|e| AppError(format!("无法创建数据目录: {e}")))?;
    let json = serde_json::to_string_pretty(targets).map_err(|e| AppError(e.to_string()))?;
    std::fs::write(dir.join("notify_targets.json"), json)
        .map_err(|e| AppError(format!("写入通知配置失败: {e}")))
}

/// One push destination bound to a monitor.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum NotifyTarget {
    #[serde(rename_all = "camelCase")]
    Telegram { bot_token: String, chat_id: String },
    #[serde(rename_all = "camelCase")]
    Webhook { url: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NotifyEventKind {
    /// The room just transitioned to live.
    Live,
    /// A recording of this room finished (any outcome).
    RecordingFinished,
}

#[derive(Debug, Clone, Serialize)]
pub struct NotifyEvent {
    pub kind: NotifyEventKind,
    pub monitor: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_sec: Option<u64>,
}

impl NotifyEvent {
    fn who(&self) -> &str {
        self.author.as_deref().unwrap_or(&self.monitor)
    }

    fn fmt_duration(&self) -> String {
        let Some(secs) = self.duration_sec else {
            return String::new();
        };
        let h = secs / 3600;
        let m = (secs % 3600) / 60;
        let s = secs % 60;
        if h > 0 {
            format!("{h}小时{m}分")
        } else if m > 0 {
            format!("{m}分{s}秒")
        } else {
            format!("{s}秒")
        }
    }

    /// Human-readable message for the Telegram push.
    fn text(&self) -> String {
        match self.kind {
            NotifyEventKind::Live => {
                let title = self.title.as_deref().unwrap_or("");
                format!("🔴 {} 开播了\n{title}\n{}", self.who(), self.url)
            }
            NotifyEventKind::RecordingFinished => format!(
                "⏹ {} 的录制已结束（时长 {}）\n{}",
                self.who(),
                self.fmt_duration(),
                self.url
            ),
        }
    }
}

/// Queue `event` to every target on a detached thread, two tries each with a
/// short pause between. Best-effort by design: failures are logged, never
/// surfaced to the caller.
pub fn push(targets: &[NotifyTarget], proxy: Option<&str>, event: &NotifyEvent) {
    if targets.is_empty() {
        return;
    }
    let targets = targets.to_vec();
    let proxy = proxy.map(str::to_string);
    let event = event.clone();
    std::thread::spawn(move || {
        for target in targets {
            for attempt in 0..2 {
                let result = match &target {
                    NotifyTarget::Telegram { bot_token, chat_id } => {
                        send_telegram(bot_token, chat_id, &event, proxy.as_deref())
                    }
                    NotifyTarget::Webhook { url } => send_webhook(url, &event, proxy.as_deref()),
                };
                if result.is_ok() || attempt == 1 {
                    if let Err(e) = result {
                        eprintln!("notify {:?}: {e}", event.kind);
                    }
                    break;
                }
                std::thread::sleep(Duration::from_secs(2));
            }
        }
    });
}

fn client(proxy: Option<&str>, no_proxy: bool) -> std::result::Result<reqwest::blocking::Client, String> {
    let mut builder = reqwest::blocking::Client::builder().timeout(Duration::from_secs(15));
    // Loopback receivers (local automation scripts) must never ride a proxy:
    // reqwest picks up the system proxy by default, which would break them.
    if no_proxy {
        builder = builder.no_proxy();
    } else if let Some(p) = proxy {
        builder = builder.proxy(
            reqwest::Proxy::all(p).map_err(|e| format!("bad proxy: {e}"))?,
        );
    }
    builder.build().map_err(|e| e.to_string())
}

/// True for URLs aimed at this machine — those bypass any proxy.
fn is_loopback_url(url: &str) -> bool {
    reqwest::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_ascii_lowercase))
        .is_some_and(|h| h == "127.0.0.1" || h == "localhost" || h == "::1" || h == "[::1]")
}

fn send_telegram(
    token: &str,
    chat_id: &str,
    event: &NotifyEvent,
    proxy: Option<&str>,
) -> std::result::Result<(), String> {
    if token.is_empty() || chat_id.is_empty() {
        return Err("telegram: empty bot token or chat id".into());
    }
    let client = client(proxy, false)?;
    let resp = client
        .post(format!("https://api.telegram.org/bot{token}/sendMessage"))
        .form(&[("chat_id", chat_id), ("text", &event.text())])
        .send()
        .map_err(|e| format!("telegram sendMessage: {e}"))?;
    let status = resp.status();
    let body: serde_json::Value = resp.json().unwrap_or(serde_json::Value::Null);
    if status.is_success() && body.get("ok").and_then(|v| v.as_bool()) == Some(true) {
        Ok(())
    } else {
        Err(format!("telegram sendMessage: HTTP {status}: {body}"))
    }
}

fn send_webhook(
    url: &str,
    event: &NotifyEvent,
    proxy: Option<&str>,
) -> std::result::Result<(), String> {
    if url.is_empty() {
        return Err("webhook: empty url".into());
    }
    let client = client(proxy, is_loopback_url(url))?;
    let resp = client
        .post(url)
        .json(event)
        .send()
        .map_err(|e| format!("webhook POST: {e}"))?;
    let status = resp.status();
    if status.is_success() {
        Ok(())
    } else {
        Err(format!("webhook POST: HTTP {status}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(kind: NotifyEventKind) -> NotifyEvent {
        NotifyEvent {
            kind,
            monitor: "房间1".into(),
            author: Some("主播".into()),
            title: Some("测试直播".into()),
            url: "https://live.douyin.com/123".into(),
            duration_sec: Some(3661),
        }
    }

    #[test]
    fn live_text_has_author_title_url() {
        let text = event(NotifyEventKind::Live).text();
        assert!(text.contains("主播 开播了"));
        assert!(text.contains("测试直播"));
        assert!(text.contains("https://live.douyin.com/123"));
    }

    #[test]
    fn finished_text_has_duration() {
        let text = event(NotifyEventKind::RecordingFinished).text();
        assert!(text.contains("1小时1分"));
    }

    #[test]
    fn target_json_uses_camel_case_kind_tag() {
        let tg = NotifyTarget::Telegram {
            bot_token: "t".into(),
            chat_id: "1".into(),
        };
        let v = serde_json::to_value(&tg).unwrap();
        assert_eq!(v["kind"], "telegram");
        assert_eq!(v["botToken"], "t");
        assert_eq!(v["chatId"], "1");

        let back: NotifyTarget = serde_json::from_value(v).unwrap();
        assert_eq!(back, tg);

        let wh = NotifyTarget::Webhook {
            url: "https://example.com/hook".into(),
        };
        let v = serde_json::to_value(&wh).unwrap();
        assert_eq!(v["kind"], "webhook");
        let back: NotifyTarget = serde_json::from_value(v).unwrap();
        assert_eq!(back, wh);
    }

    #[test]
    fn webhook_json_payload_omits_missing_fields() {
        let mut ev = event(NotifyEventKind::Live);
        ev.author = None;
        ev.duration_sec = None;
        let v = serde_json::to_value(&ev).unwrap();
        assert!(v.get("author").is_none());
        assert!(v.get("durationSec").is_none());
        assert_eq!(v["kind"], "live");
    }

    /// End-to-end: the blocking client really POSTs the JSON body and maps
    /// status codes to results, exercised against a loopback listener.
    #[test]
    fn webhook_posts_json_and_maps_status() {
        use std::io::{Read, Write};
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            let mut buf = [0u8; 4096];
            let n = sock.read(&mut buf).unwrap_or(0);
            let req = String::from_utf8_lossy(&buf[..n]).into_owned();
            sock.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
                .unwrap();
            req
        });

        let ev = event(NotifyEventKind::Live);
        send_webhook(&format!("http://{addr}/hook"), &ev, None).unwrap();

        let req = server.join().unwrap();
        assert!(req.starts_with("POST /hook "));
        assert!(req.contains(r#""kind":"live""#));
        assert!(req.contains(r#""url":"https://live.douyin.com/123""#));
    }

    #[test]
    fn webhook_maps_http_errors_to_err() {
        use std::io::{Read, Write};
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            let mut buf = [0u8; 1024];
            let _ = sock.read(&mut buf);
            sock.write_all(b"HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\n\r\n")
                .unwrap();
        });

        let ev = event(NotifyEventKind::Live);
        let err = send_webhook(&format!("http://{addr}/hook"), &ev, None).unwrap_err();
        server.join().unwrap();
        assert!(err.contains("500"), "unexpected error: {err}");
    }
}
