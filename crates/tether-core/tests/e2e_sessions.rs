//! Session lifecycle and the terminal stream, against a real server and a real
//! PTY. These are the paths every client depends on before anything else works.

mod support;

use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use support::{eventually, Server};
use tether_core::protocol::ClientFrame;
use tether_core::session::{open_session, CoreEvent, SessionConfig};
use tether_core::store::ReplayStore;

/// Auth is the whole security model: a wrong bearer must not reach any route.
#[tokio::test]
async fn rejects_a_wrong_password_and_accepts_the_paired_one() {
    let server = Server::start().await;

    let (status, _) = server.exec(&server.client().get("/api/health", server.auth())).await;
    assert_eq!(status, 200, "the paired password should be accepted");

    let bad = server.client_with("not-the-password");
    let (status, _) = server.exec(&bad.get("/api/health", bad.auth_header())).await;
    assert_eq!(status, 401, "a wrong password must be refused");
}

/// Pairing is one-shot; a second setup on a paired server must not re-key it.
#[tokio::test]
async fn setup_refuses_a_second_pairing() {
    let server = Server::start().await;
    let response = server
        .http
        .post(format!("http://127.0.0.1:{}/api/setup", server.port))
        .json(&json!({ "password": "someone-elses-password" }))
        .send()
        .await
        .expect("setup");
    assert_eq!(response.status().as_u16(), 409, "setup must self-lock");
}

#[tokio::test]
async fn starts_lists_renames_and_kills_a_session() {
    let server = Server::start().await;
    let client = server.client();

    let (status, body) = server
        .exec(&client.post(
            "/api/sessions/start",
            server.auth(),
            Some(json!({ "id": "s1", "cols": 80, "rows": 24 }).to_string()),
        ))
        .await;
    assert_eq!(status, 200, "start failed: {body}");
    assert_eq!(body["ok"], true);

    let listed = eventually("the session to appear as running", || async {
        let (_, body) = server.exec(&client.get("/api/sessions", server.auth())).await;
        let found = body
            .as_array()?
            .iter()
            .find(|s| s["id"] == "s1")?
            .clone();
        (found["status"] == "running").then_some(found)
    })
    .await;
    assert_eq!(listed["status"], "running");

    let (status, _) = server
        .exec(&client.post(
            "/api/sessions/rename",
            server.auth(),
            Some(json!({ "id": "s1", "name": "renamed" }).to_string()),
        ))
        .await;
    assert_eq!(status, 200);
    let renamed = eventually("the rename to be listed", || async {
        let (_, body) = server.exec(&client.get("/api/sessions", server.auth())).await;
        let found = body.as_array()?.iter().find(|s| s["id"] == "s1")?.clone();
        (found["name"] == "renamed").then_some(found)
    })
    .await;
    assert_eq!(renamed["name"], "renamed");

    let (status, body) = server
        .exec(&client.post(
            "/api/sessions/kill",
            server.auth(),
            Some(json!({ "id": "s1" }).to_string()),
        ))
        .await;
    assert_eq!(status, 200, "kill failed: {body}");
    assert_eq!(body["ok"], true, "kill reported no session killed");
}

/// The core loop: open a socket to a live PTY, type, and see the shell answer.
/// Everything the clients render sits downstream of this.
#[tokio::test]
async fn round_trips_input_through_a_live_pty() {
    let server = Server::start().await;
    let client = server.client();

    let (status, _) = server
        .exec(&client.post(
            "/api/sessions/start",
            server.auth(),
            Some(json!({ "id": "pty1", "cols": 80, "rows": 24 }).to_string()),
        ))
        .await;
    assert_eq!(status, 200);

    let store = Arc::new(ReplayStore::new());
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let handle = open_session(
        SessionConfig {
            base_ws_url: server.ws_base(),
            password: server.password.clone(),
            session_id: "pty1".to_string(),
            cols: 80,
            rows: 24,
        },
        store.clone(),
        tx,
    )
    .await
    .expect("open session");

    // The shell echoes the command line before running it, so the needle is
    // split with '' — the echo shows `e2e-mark''er-42`, only the command's own
    // output contains `e2e-marker-42`. Matching the echo would pass even if the
    // shell never ran the command.
    handle.send(ClientFrame::Input {
        text: "echo e2e-mark''er-42\r".to_string(),
    });

    let mut seen = String::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    while tokio::time::Instant::now() < deadline {
        match tokio::time::timeout_at(deadline, rx.recv()).await {
            Ok(Some(CoreEvent::Frame(text))) => {
                seen.push_str(&text);
                if seen.contains("e2e-marker-42") {
                    break;
                }
            }
            Ok(Some(CoreEvent::Closed)) | Ok(None) => break,
            Err(_) => break,
        }
    }
    handle.close();
    assert!(
        seen.contains("e2e-marker-42"),
        "the PTY never echoed the marker; frames seen: {seen}"
    );
}
