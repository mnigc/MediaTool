//! WebSocket fan-out of engine events.

use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::broadcast;
use tokio::sync::broadcast::error::RecvError;

use crate::events::{Frame, WsEmitter};

/// Idle WebSockets get dropped by NAS reverse proxies; the ping keeps the
/// connection alive and also detects a client whose tab went away.
const HEARTBEAT: Duration = Duration::from_secs(30);

pub async fn upgrade(State(emitter): State<Arc<WsEmitter>>, ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(move |socket| pump(socket, emitter.subscribe()))
}

async fn pump(mut socket: WebSocket, mut rx: broadcast::Receiver<Frame>) {
    let mut heartbeat = tokio::time::interval(HEARTBEAT);
    loop {
        tokio::select! {
            received = rx.recv() => match received {
                Ok(frame) => {
                    if socket.send(Message::Text(frame.to_string().into())).await.is_err() {
                        break;
                    }
                }
                // Falling behind means the client stopped reading. Replaying
                // stale progress would be worse than dropping it.
                Err(RecvError::Lagged(skipped)) => {
                    tracing::warn!(skipped, "事件订阅者落后于推送，断开该连接");
                    break;
                }
                Err(RecvError::Closed) => break,
            },
            _ = heartbeat.tick() => {
                if socket.send(Message::Ping(Vec::new().into())).await.is_err() {
                    break;
                }
            }
            inbound = socket.next() => match inbound {
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                Some(Ok(_)) => {}
            },
        }
    }
    let _ = socket.close().await;
}
