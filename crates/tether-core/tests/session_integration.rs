//! Drives a real `open_session` against an in-process WebSocket server, so the
//! read loop, duplicate rejection, and cursor retention are exercised over an
//! actual socket rather than mocked.

use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use tether_core::protocol::ClientFrame;
use tether_core::session::{open_session, CoreEvent, SessionConfig};
use tether_core::store::ReplayStore;

/// Starts a WS server that sends `to_send` on connect, then reports the request
/// path and the first client frame it receives.
#[allow(clippy::result_large_err)] // tungstenite's handshake callback signature
async fn spawn_server(
    to_send: Vec<String>,
) -> (
    String,
    tokio::sync::oneshot::Receiver<(String, Option<String>)>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (report_tx, report_rx) = tokio::sync::oneshot::channel();

    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut path = String::new();
        let socket = tokio_tungstenite::accept_hdr_async(
            stream,
            |req: &tokio_tungstenite::tungstenite::handshake::server::Request,
             res: tokio_tungstenite::tungstenite::handshake::server::Response| {
                path = req.uri().to_string();
                Ok(res)
            },
        )
        .await
        .unwrap();
        let (mut write, mut read) = socket.split();
        for frame in to_send {
            write.send(Message::Text(frame)).await.unwrap();
        }
        // Tests that don't send a client frame would hang forever on read.next().
        // Race a short idle against the first client message, then hang up so
        // emits_closed / second-connection tests can complete.
        let first_client_frame = tokio::select! {
            msg = read.next() => match msg {
                Some(Ok(Message::Text(t))) => Some(t.to_string()),
                _ => None,
            },
            _ = tokio::time::sleep(std::time::Duration::from_millis(100)) => None,
        };
        let _ = write.close().await;
        let _ = report_tx.send((path, first_client_frame));
    });

    (format!("ws://127.0.0.1:{port}"), report_rx)
}

fn config(base: &str, session_id: &str) -> SessionConfig {
    SessionConfig {
        base_ws_url: base.to_string(),
        bearer: "pw".to_string(),
        session_id: session_id.to_string(),
        cols: 80,
        rows: 24,
    }
}

#[tokio::test]
async fn forwards_frames_and_drops_duplicate_output() {
    let (base, report) = spawn_server(vec![
        r#"{"type":"output","chunk":"a","id":1}"#.to_string(),
        r#"{"type":"output","chunk":"a-again","id":1}"#.to_string(),
        r#"{"type":"output","chunk":"b","id":2}"#.to_string(),
        r#"{"type":"title","title":"vim"}"#.to_string(),
    ])
    .await;
    let store = Arc::new(ReplayStore::new());
    let (tx, mut rx) = mpsc::unbounded_channel();

    let handle = open_session(config(&base, "s1"), store.clone(), tx)
        .await
        .unwrap();
    handle.send(ClientFrame::Input {
        text: "ls\r".to_string(),
    });

    assert_eq!(
        rx.recv().await.unwrap(),
        CoreEvent::Frame(r#"{"type":"output","chunk":"a","id":1}"#.to_string())
    );
    // id 1 arrives twice; the second is a replay overlap and must not surface.
    assert_eq!(
        rx.recv().await.unwrap(),
        CoreEvent::Frame(r#"{"type":"output","chunk":"b","id":2}"#.to_string())
    );
    assert_eq!(
        rx.recv().await.unwrap(),
        CoreEvent::Frame(r#"{"type":"title","title":"vim"}"#.to_string())
    );
    assert_eq!(store.since_id("s1"), 2);

    let (path, client_frame) = report.await.unwrap();
    assert_eq!(path, "/api/ws?sessionId=s1&sinceId=0&cols=80&rows=24");
    assert_eq!(
        client_frame.as_deref(),
        Some(r#"{"type":"input","text":"ls\r"}"#)
    );
}

#[tokio::test]
async fn a_second_connection_resumes_from_the_stored_cursor() {
    let store = Arc::new(ReplayStore::new());

    let (base, first) =
        spawn_server(vec![r#"{"type":"output","chunk":"a","id":9}"#.to_string()]).await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    open_session(config(&base, "s1"), store.clone(), tx)
        .await
        .unwrap();
    rx.recv().await.unwrap();
    let _ = first.await;

    // New socket, same store — the cursor must travel.
    let (base2, second) = spawn_server(vec![]).await;
    let (tx2, _rx2) = mpsc::unbounded_channel();
    open_session(config(&base2, "s1"), store.clone(), tx2)
        .await
        .unwrap();
    let (path, _) = second.await.unwrap();
    assert_eq!(path, "/api/ws?sessionId=s1&sinceId=9&cols=80&rows=24");
}

#[tokio::test]
async fn reset_rewinds_the_cursor() {
    let (base, _report) = spawn_server(vec![
        r#"{"type":"output","chunk":"a","id":4}"#.to_string(),
        r#"{"type":"reset"}"#.to_string(),
    ])
    .await;
    let store = Arc::new(ReplayStore::new());
    let (tx, mut rx) = mpsc::unbounded_channel();

    open_session(config(&base, "s1"), store.clone(), tx)
        .await
        .unwrap();
    rx.recv().await.unwrap();
    // The reset itself is forwarded so the WebView clears its emulator.
    assert_eq!(
        rx.recv().await.unwrap(),
        CoreEvent::Frame(r#"{"type":"reset"}"#.to_string())
    );
    assert_eq!(store.since_id("s1"), 0);
}

#[tokio::test]
async fn emits_closed_when_the_server_hangs_up() {
    let (base, _report) = spawn_server(vec![]).await;
    let store = Arc::new(ReplayStore::new());
    let (tx, mut rx) = mpsc::unbounded_channel();

    open_session(config(&base, "s1"), store, tx).await.unwrap();
    assert_eq!(rx.recv().await.unwrap(), CoreEvent::Closed);
}
