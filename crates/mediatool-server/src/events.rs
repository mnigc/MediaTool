//! [`Emitter`] that fans engine events out to every connected WebSocket.
//!
//! Frames keep Tauri's `{ event, payload }` shape so the web client can hand
//! `payload` straight to the same callbacks the desktop listeners use.

use mediatool_core::ctx::Emitter;
use tokio::sync::broadcast;

/// One `{event, payload}` frame as sent over the socket.
pub type Frame = std::sync::Arc<str>;

pub struct WsEmitter {
    tx: broadcast::Sender<Frame>,
}

impl WsEmitter {
    pub fn new(capacity: usize) -> Self {
        let (tx, _rx) = broadcast::channel(capacity.max(16));
        Self { tx }
    }

    /// New listener. A client that falls `capacity` events behind is dropped by
    /// the WebSocket handler rather than allowed to stall the engine.
    pub fn subscribe(&self) -> broadcast::Receiver<Frame> {
        self.tx.subscribe()
    }
}

impl Emitter for WsEmitter {
    /// Called from engine threads, including blocking ones, so it must not
    /// await. `send` is non-blocking; a full channel means every client is
    /// already lagging, which the receiving half reports as `Lagged`.
    fn emit(&self, event: &str, payload: serde_json::Value) {
        let frame = serde_json::json!({ "event": event, "payload": payload }).to_string();
        // No subscribers yet is normal (server starting, UI closed).
        let _ = self.tx.send(frame.into());
    }
}
