//! The terminal stream's durability: replay from a cursor, reconnect, resize,
//! and the promise that a shell outlives the server it was started from.

mod support;

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use support::{eventually, Server};
use tether_core::protocol::ClientFrame;
use tether_core::session::{open_session, CoreEvent, SessionConfig};
use tether_core::store::ReplayStore;

fn config(server: &Server, session_id: &str) -> SessionConfig {
    SessionConfig {
        base_ws_url: server.ws_base(),
        password: server.token.clone(),
        session_id: session_id.to_string(),
        cols: 80,
        rows: 24,
    }
}

async fn start_session(server: &Server, id: &str) {
    let client = server.client();
    let (status, body) = server
        .exec(&client.post(
            "/api/sessions/start",
            BTreeMap::new(),
            Some(json!({ "id": id, "cols": 80, "rows": 24 }).to_string()),
        ))
        .await;
    assert_eq!(status, 200, "session start failed: {body}");
    eventually("the session to be running", || async {
        let (_, body) = server
            .exec(&client.get("/api/sessions", BTreeMap::new()))
            .await;
        let found = body.as_array()?.iter().find(|s| s["id"] == id)?.clone();
        (found["status"] == "running").then_some(())
    })
    .await;
}

/// Collects frames until `needle` shows up, or the deadline passes. Returns
/// everything seen so a failure can show what did arrive.
///
/// Callers must pass a needle that cannot appear in the shell's echo of the
/// command line — the echo arrives as the first output frame, so a needle
/// matching it returns immediately, with the cursor barely advanced and the
/// command possibly never run.
async fn collect_until(
    rx: &mut tokio::sync::mpsc::UnboundedReceiver<CoreEvent>,
    needle: &str,
    within: Duration,
) -> String {
    let mut seen = String::new();
    let deadline = tokio::time::Instant::now() + within;
    while tokio::time::Instant::now() < deadline {
        match tokio::time::timeout_at(deadline, rx.recv()).await {
            Ok(Some(CoreEvent::Frame(text))) => {
                seen.push_str(&text);
                if seen.contains(needle) {
                    return seen;
                }
            }
            Ok(Some(CoreEvent::Closed)) | Ok(None) => break,
            Err(_) => break,
        }
    }
    seen
}

/// The logs endpoint is the HTTP half of replay: same cursor, same tail.
#[tokio::test]
async fn serves_the_replay_log_over_http() {
    let server = Server::start().await;
    start_session(&server, "log1").await;
    let client = server.client();

    // Drive some output through the PTY so there is something to replay.
    let store = Arc::new(ReplayStore::new());
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let handle = open_session(config(&server, "log1"), store.clone(), tx)
        .await
        .expect("open");
    handle.send(ClientFrame::Input {
        text: "echo http-replay-mark''er\r".to_string(),
    });
    let seen = collect_until(&mut rx, "http-replay-marker", Duration::from_secs(15)).await;
    assert!(seen.contains("http-replay-marker"), "no PTY output: {seen}");
    handle.close();

    let (status, body) = server
        .exec(&client.get("/api/sessions/log1/logs?sinceId=0", BTreeMap::new()))
        .await;
    assert_eq!(status, 200, "logs failed: {body}");
    let joined = body.to_string();
    assert!(
        joined.contains("http-replay-marker"),
        "the replay log does not contain the output: {joined}"
    );

    // A cursor past everything must return nothing, not the whole tail again.
    let (status, body) = server
        .exec(&client.get("/api/sessions/log1/logs?sinceId=999999", BTreeMap::new()))
        .await;
    assert_eq!(status, 200);
    assert_eq!(
        body.as_array().map(|a| a.len()),
        Some(0),
        "a cursor past the end still replayed: {body}"
    );
}

/// Reconnecting with the same replay store must not re-deliver what the cursor
/// already covers. Duplicated output is how a terminal ends up showing the same
/// prompt twice after every reconnect.
#[tokio::test]
async fn a_reconnect_does_not_replay_what_the_cursor_already_saw() {
    let server = Server::start().await;
    start_session(&server, "recon1").await;

    let store = Arc::new(ReplayStore::new());
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let handle = open_session(config(&server, "recon1"), store.clone(), tx)
        .await
        .expect("open");
    handle.send(ClientFrame::Input {
        text: "echo first-connection-mark''er\r".to_string(),
    });
    let seen = collect_until(&mut rx, "first-connection-marker", Duration::from_secs(15)).await;
    assert!(
        seen.contains("first-connection-marker"),
        "no output: {seen}"
    );
    handle.close();
    let cursor = store.since_id("recon1");
    assert!(cursor > 0, "the cursor never advanced");

    // Reconnect with the same store; nothing new happened, so nothing old
    // should arrive.
    let (tx2, mut rx2) = tokio::sync::mpsc::unbounded_channel();
    let handle2 = open_session(config(&server, "recon1"), store.clone(), tx2)
        .await
        .expect("reopen");
    let replayed = collect_until(&mut rx2, "first-connection-marker", Duration::from_secs(3)).await;
    handle2.close();
    assert!(
        !replayed.contains("first-connection-marker"),
        "the reconnect replayed output the cursor had already covered: {replayed}"
    );
    assert!(
        store.since_id("recon1") >= cursor,
        "the cursor went backwards across a reconnect"
    );
}

/// The holder is a separate detached process, so stopping the server must not
/// stop the shell. This is the claim the whole architecture rests on.
#[tokio::test]
async fn a_session_survives_a_server_restart() {
    let mut server = Server::start().await;
    start_session(&server, "survivor").await;

    let store = Arc::new(ReplayStore::new());
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let handle = open_session(config(&server, "survivor"), store.clone(), tx)
        .await
        .expect("open");
    handle.send(ClientFrame::Input {
        text: "echo before-restart-mark''er\r".to_string(),
    });
    let seen = collect_until(&mut rx, "before-restart-marker", Duration::from_secs(15)).await;
    assert!(seen.contains("before-restart-marker"), "no output: {seen}");
    handle.close();

    server.restart().await;

    // The reattached session must still be running and still take input.
    let client = server.client();
    eventually(
        "the session to still be running after a restart",
        || async {
            let (_, body) = server
                .exec(&client.get("/api/sessions", BTreeMap::new()))
                .await;
            let found = body
                .as_array()?
                .iter()
                .find(|s| s["id"] == "survivor")?
                .clone();
            (found["status"] == "running").then_some(())
        },
    )
    .await;

    let (tx2, mut rx2) = tokio::sync::mpsc::unbounded_channel();
    let handle2 = open_session(config(&server, "survivor"), store.clone(), tx2)
        .await
        .expect("reopen after restart");
    handle2.send(ClientFrame::Input {
        text: "echo after-restart-mark''er\r".to_string(),
    });
    let seen = collect_until(&mut rx2, "after-restart-marker", Duration::from_secs(15)).await;
    handle2.close();
    assert!(
        seen.contains("after-restart-marker"),
        "the shell did not survive the server restart; frames: {seen}"
    );
}

/// A resize must reach the PTY, or every full-screen program renders wrong.
#[tokio::test]
async fn a_resize_reaches_the_shell() {
    let server = Server::start().await;
    start_session(&server, "size1").await;

    let store = Arc::new(ReplayStore::new());
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let handle = open_session(config(&server, "size1"), store.clone(), tx)
        .await
        .expect("open");

    // The subscribe path writes the URL's dims into this client's entry, so a
    // resize racing ahead of it gets overwritten by the 80 in the URL. Real
    // clients resize after the fit, which is what this wait reproduces.
    tokio::time::sleep(Duration::from_millis(1000)).await;
    handle.send(ClientFrame::Resize {
        cols: 132,
        rows: 43,
    });
    tokio::time::sleep(Duration::from_millis(500)).await;
    handle.send(ClientFrame::Input {
        text: "echo cols-is-$(tput cols)\r".to_string(),
    });

    let seen = collect_until(&mut rx, "cols-is-132", Duration::from_secs(15)).await;
    handle.close();
    assert!(
        seen.contains("cols-is-132"),
        "the shell did not see the new width; frames: {seen}"
    );
}

/// Activity classification drives the drawer dots and every push notification.
#[tokio::test]
async fn classifies_session_activity() {
    let server = Server::start().await;
    start_session(&server, "act1").await;
    let client = server.client();

    let store = Arc::new(ReplayStore::new());
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let handle = open_session(config(&server, "act1"), store.clone(), tx)
        .await
        .expect("open");
    handle.send(ClientFrame::Input {
        text: "echo activity-mark''er\r".to_string(),
    });
    let _ = collect_until(&mut rx, "activity-marker", Duration::from_secs(15)).await;

    let activity = eventually("an activity classification", || async {
        let (_, body) = server
            .exec(&client.get("/api/sessions", BTreeMap::new()))
            .await;
        let found = body.as_array()?.iter().find(|s| s["id"] == "act1")?.clone();
        found["activity"].as_str().map(str::to_string)
    })
    .await;
    handle.close();
    assert!(
        ["working", "waiting", "idle", "done"].contains(&activity.as_str()),
        "unexpected activity value: {activity}"
    );
}
