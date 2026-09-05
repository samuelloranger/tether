use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use thiserror::Error;
use tokio::sync::mpsc::{self, UnboundedSender};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

use crate::protocol::{ClientFrame, ServerFrame};
use crate::store::ReplayStore;

#[derive(Debug, Clone)]
pub struct SessionConfig {
    /// Origin only, e.g. `ws://host:8085` — no path, no query.
    pub base_ws_url: String,
    pub bearer: String,
    pub session_id: String,
    pub cols: u16,
    pub rows: u16,
}

/// What the core hands its host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CoreEvent {
    /// The server's JSON frame, verbatim. Forwarded rather than re-serialized so
    /// payloads the core doesn't model (`diff`'s summary/status) stay byte-exact.
    Frame(String),
    /// The socket ended. The host drives reconnection in P0.
    Closed,
}

#[derive(Debug, Error)]
pub enum SessionError {
    #[error("invalid websocket url: {0}")]
    Url(String),
    #[error("invalid authorization header")]
    AuthHeader,
    #[error("connect failed: {0}")]
    Connect(String),
}

/// Percent-encodes the characters that would otherwise break out of a query
/// value. Hand-rolled to keep the crate's dependency list minimal for the
/// eventual iOS build.
fn encode_query_value(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// Builds the v1 `/api/ws` URL. `since_id` is passed in rather than read from
/// the store so this stays a pure function.
pub fn ws_url(cfg: &SessionConfig, since_id: u64) -> String {
    format!(
        "{}/api/ws?sessionId={}&sinceId={}&cols={}&rows={}",
        cfg.base_ws_url.trim_end_matches('/'),
        encode_query_value(&cfg.session_id),
        since_id,
        cfg.cols,
        cfg.rows
    )
}

/// A live session. Dropping it does not close the socket — call [`Self::close`].
#[derive(Debug, Clone)]
pub struct SessionHandle {
    outgoing: UnboundedSender<Outgoing>,
}

#[derive(Debug)]
enum Outgoing {
    Frame(String),
    Close,
}

impl SessionHandle {
    pub fn send(&self, frame: ClientFrame) {
        let _ = self.outgoing.send(Outgoing::Frame(frame.to_json()));
    }

    /// Sends an already-serialized v1 client frame. Used by hosts whose UI layer
    /// builds the JSON itself.
    pub fn send_raw(&self, text: String) {
        let _ = self.outgoing.send(Outgoing::Frame(text));
    }

    pub fn close(&self) {
        let _ = self.outgoing.send(Outgoing::Close);
    }
}

/// Opens a session, spawning a reader and a writer task.
///
/// The reader parses each frame only to decide: a duplicate `output` is dropped,
/// a `reset` rewinds the stored cursor. Everything that survives is emitted
/// verbatim. `sinceId` comes from `store`, which is why the caller no longer
/// passes it.
pub async fn open_session(
    cfg: SessionConfig,
    store: Arc<ReplayStore>,
    events: UnboundedSender<CoreEvent>,
) -> Result<SessionHandle, SessionError> {
    let url = ws_url(&cfg, store.since_id(&cfg.session_id));
    let mut request = url
        .into_client_request()
        .map_err(|e| SessionError::Url(e.to_string()))?;
    request.headers_mut().insert(
        "Authorization",
        format!("Bearer {}", cfg.bearer)
            .parse()
            .map_err(|_| SessionError::AuthHeader)?,
    );

    let (socket, _response) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|e| SessionError::Connect(e.to_string()))?;
    let (mut write, mut read) = socket.split();
    let (outgoing_tx, mut outgoing_rx) = mpsc::unbounded_channel::<Outgoing>();

    let session_id = cfg.session_id.clone();
    tokio::spawn(async move {
        while let Some(message) = read.next().await {
            let text = match message {
                Ok(Message::Text(text)) => text,
                Ok(Message::Close(_)) | Err(_) => break,
                _ => continue,
            };
            match serde_json::from_str::<ServerFrame>(&text) {
                Ok(ServerFrame::Output { id, .. }) => {
                    if !store.accept_output(&session_id, id) {
                        continue;
                    }
                }
                Ok(ServerFrame::Reset) => store.reset(&session_id),
                // Unparseable frames are forwarded, not dropped: the WebView's
                // parser is the one that has to be satisfied, not ours.
                Ok(_) | Err(_) => {}
            }
            if events.send(CoreEvent::Frame(text.to_string())).is_err() {
                return;
            }
        }
        let _ = events.send(CoreEvent::Closed);
    });

    tokio::spawn(async move {
        while let Some(outgoing) = outgoing_rx.recv().await {
            match outgoing {
                Outgoing::Frame(text) => {
                    if write.send(Message::Text(text)).await.is_err() {
                        break;
                    }
                }
                Outgoing::Close => {
                    let _ = write.close().await;
                    break;
                }
            }
        }
    });

    Ok(SessionHandle {
        outgoing: outgoing_tx,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_the_v1_ws_url_with_the_stored_cursor() {
        let cfg = SessionConfig {
            base_ws_url: "ws://10.0.0.5:8085".to_string(),
            bearer: "secret".to_string(),
            session_id: "build".to_string(),
            cols: 120,
            rows: 40,
        };
        assert_eq!(
            ws_url(&cfg, 512),
            "ws://10.0.0.5:8085/api/ws?sessionId=build&sinceId=512&cols=120&rows=40"
        );
    }

    // Session ids come from user-supplied names, so they must not be able to
    // inject extra query parameters.
    #[test]
    fn percent_encodes_the_session_id() {
        let cfg = SessionConfig {
            base_ws_url: "ws://h:1".to_string(),
            bearer: String::new(),
            session_id: "a b&cols=1".to_string(),
            cols: 80,
            rows: 24,
        };
        assert_eq!(
            ws_url(&cfg, 0),
            "ws://h:1/api/ws?sessionId=a%20b%26cols%3D1&sinceId=0&cols=80&rows=24"
        );
    }
}
