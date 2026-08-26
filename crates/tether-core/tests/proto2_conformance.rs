//! Cross-language protocol v2 conformance against the real Bun server.
//!
//! Marked `#[ignore]` so plain `cargo test` stays hermetic and fast. CI runs it
//! explicitly with `cargo test -- --ignored` after `bun install` so
//! `apps/server` dependencies exist.

use std::collections::HashSet;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use prost::Message;
use tempfile::TempDir;
use tokio::net::TcpListener;
use tokio::process::{Child, Command};
use tokio::time::{sleep, timeout};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::{HeaderValue, AUTHORIZATION};
use tokio_tungstenite::tungstenite::Message as WsMessage;

use tether_proto::frame::{encode_frame, FrameDecoder};
use tether_proto::{
    ActivityFrame, CursorFrame, DiffFrame, ExitFrame, FocusFrame, FrameKind, InputFrame,
    ResizeFrame, TitleFrame,
};

const PASSWORD: &str = "conformance-p1";
const SESSION_ID: &str = "proto2-conformance";

struct LiveServer {
    child: Child,
    port: u16,
    /// Owns the temp directory (DB + holders); removed on drop.
    tmp: TempDir,
    base: String,
}

impl LiveServer {
    async fn spawn() -> Self {
        let tmp = TempDir::new().expect("temp dir");
        let db_path = tmp.path().join("tether.db");
        let port = free_port().await;
        let server_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../apps/server")
            .canonicalize()
            .expect("apps/server");

        let child = Command::new("bun")
            .args(["run", "src/server/index.ts"])
            .current_dir(&server_dir)
            .env("TETHER_PORT", port.to_string())
            .env("TETHER_DB_PATH", &db_path)
            .env("TETHER_TLS", "off")
            // Scrub agent vars so they don't leak into the PTY the way the
            // daemon start path does.
            .env_remove("CLAUDE_CODE_CHILD_SESSION")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .expect("spawn bun server");

        let base = format!("http://127.0.0.1:{port}");
        let mut server = Self {
            child,
            port,
            tmp,
            base,
        };
        server.wait_ready().await;
        server
    }

    async fn wait_ready(&mut self) {
        let client = reqwest::Client::new();
        let url = format!("{}/api/status", self.base);
        for _ in 0..50 {
            if let Some(status) = self.child.try_wait().expect("server status") {
                panic!("server exited early: {status:?}");
            }
            match client.get(&url).send().await {
                Ok(res) if res.status().is_success() => return,
                _ => sleep(Duration::from_millis(100)).await,
            }
        }
        panic!("server never became ready on {}", self.base);
    }

    fn auth_header() -> String {
        format!("Bearer {PASSWORD}")
    }

    async fn setup(&self) {
        let client = reqwest::Client::new();
        let status: serde_json::Value = client
            .get(format!("{}/api/status", self.base))
            .send()
            .await
            .expect("status")
            .json()
            .await
            .expect("status json");
        assert_eq!(status["needsSetup"], true);

        let res = client
            .post(format!("{}/api/setup", self.base))
            .json(&serde_json::json!({ "password": PASSWORD }))
            .send()
            .await
            .expect("setup");
        assert!(res.status().is_success(), "setup failed: {}", res.status());
    }

    async fn kill_session(&self) {
        let client = reqwest::Client::new();
        let _ = client
            .post(format!("{}/api/sessions/kill", self.base))
            .bearer_auth(PASSWORD)
            .json(&serde_json::json!({ "id": SESSION_ID }))
            .send()
            .await;
    }

    async fn shutdown(mut self) {
        self.kill_session().await;
        sleep(Duration::from_millis(200)).await;
        let _ = self.child.kill().await;
        let _ = self.child.wait().await;
        // TempDir drop removes the DB + holders dir.
    }
}

async fn free_port() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    listener.local_addr().expect("addr").port()
}

fn kind_u8(k: FrameKind) -> u8 {
    k as i32 as u8
}

fn encode_input(data: &[u8]) -> Vec<u8> {
    let msg = InputFrame {
        data: data.to_vec(),
    };
    encode_frame(kind_u8(FrameKind::Input), &msg.encode_to_vec()).unwrap()
}

fn encode_resize(cols: u32, rows: u32) -> Vec<u8> {
    let msg = ResizeFrame { cols, rows };
    encode_frame(kind_u8(FrameKind::Resize), &msg.encode_to_vec()).unwrap()
}

fn encode_focus(focused: bool) -> Vec<u8> {
    let msg = FocusFrame { focused };
    encode_frame(kind_u8(FrameKind::Focus), &msg.encode_to_vec()).unwrap()
}

/// Collects decoded v2 frames until `predicate` is true or the deadline hits.
async fn collect_until<F>(
    read: &mut (impl StreamExt<Item = Result<WsMessage, tokio_tungstenite::tungstenite::Error>> + Unpin),
    decoder: &mut FrameDecoder,
    deadline: Duration,
    mut predicate: F,
) -> Vec<(u8, Vec<u8>)>
where
    F: FnMut(&[(u8, Vec<u8>)]) -> bool,
{
    let mut frames: Vec<(u8, Vec<u8>)> = Vec::new();
    let end = tokio::time::Instant::now() + deadline;
    while tokio::time::Instant::now() < end {
        if predicate(&frames) {
            break;
        }
        let remaining = end.saturating_duration_since(tokio::time::Instant::now());
        let msg = match timeout(remaining, read.next()).await {
            Ok(Some(Ok(WsMessage::Binary(b)))) => b,
            Ok(Some(Ok(WsMessage::Close(_)))) | Ok(None) => break,
            Ok(Some(Ok(_))) => continue,
            Ok(Some(Err(e))) => panic!("ws read error: {e}"),
            Err(_) => break,
        };
        for f in decoder.push(&msg).expect("frame decode") {
            frames.push((f.kind, f.payload));
        }
    }
    frames
}

fn has_kind(frames: &[(u8, Vec<u8>)], kind: FrameKind) -> bool {
    let k = kind_u8(kind);
    frames.iter().any(|(kind, _)| *kind == k)
}

fn kinds_seen(frames: &[(u8, Vec<u8>)]) -> HashSet<u8> {
    frames.iter().map(|(k, _)| *k).collect()
}

/// Spawns the real Bun server and drives `/api/ws?proto=2`, asserting server→client
/// frame kinds decode and client→server kinds are accepted.
///
/// # Why ignored
/// Plain `cargo test` must stay hermetic and fast (no Bun, no PTY, no network).
/// CI runs this explicitly after `bun install`.
#[tokio::test]
#[ignore = "spawns the real Bun server; CI runs with cargo test -- --ignored"]
async fn proto2_frame_kinds_round_trip_against_real_server() {
    let server = LiveServer::spawn().await;
    server.setup().await;
    // Do NOT HTTP-start the session first: activity transitions fire while the
    // holder is coming up, and with no subscriber they are lost. Letting the
    // WS hydrate path start the session means we are attached for the first
    // OUTPUT → ACTIVITY broadcast.

    let ws_url = format!(
        "ws://127.0.0.1:{}/api/ws?proto=2&sessionId={SESSION_ID}&cols=80&rows=24",
        server.port
    );
    let mut request = ws_url.into_client_request().expect("ws url");
    request.headers_mut().insert(
        AUTHORIZATION,
        HeaderValue::from_str(&LiveServer::auth_header()).expect("auth header"),
    );

    let (socket, _) = tokio_tungstenite::connect_async(request)
        .await
        .expect("ws connect");
    let (mut write, mut read) = socket.split();
    let mut decoder = FrameDecoder::new();

    // Subscribe always pushes DIFF; shell startup yields OUTPUT+CURSOR+ACTIVITY.
    let initial = collect_until(&mut read, &mut decoder, Duration::from_secs(20), |f| {
        has_kind(f, FrameKind::Output)
            && has_kind(f, FrameKind::Cursor)
            && has_kind(f, FrameKind::Diff)
            && has_kind(f, FrameKind::Activity)
    })
    .await;

    assert!(
        has_kind(&initial, FrameKind::Output),
        "expected OUTPUT from shell; kinds={:?}",
        kinds_seen(&initial)
    );
    assert!(
        has_kind(&initial, FrameKind::Cursor),
        "expected CURSOR alongside OUTPUT; kinds={:?}",
        kinds_seen(&initial)
    );
    assert!(
        has_kind(&initial, FrameKind::Diff),
        "expected DIFF on subscribe; kinds={:?}",
        kinds_seen(&initial)
    );
    assert!(
        has_kind(&initial, FrameKind::Activity),
        "expected ACTIVITY on first live output; kinds={:?}",
        kinds_seen(&initial)
    );

    // Decode at least one cursor and one diff payload as protobuf.
    let cursor_payload = initial
        .iter()
        .find(|(k, _)| *k == kind_u8(FrameKind::Cursor))
        .map(|(_, p)| p.as_slice())
        .expect("cursor payload");
    let cursor = CursorFrame::decode(cursor_payload).expect("cursor protobuf");
    assert!(!cursor.cursor.is_empty(), "cursor must be non-empty");

    let diff_payload = initial
        .iter()
        .find(|(k, _)| *k == kind_u8(FrameKind::Diff))
        .map(|(_, p)| p.as_slice())
        .expect("diff payload");
    DiffFrame::decode(diff_payload).expect("diff protobuf");

    // Client → server: INPUT (echo a marker), RESIZE, FOCUS.
    let marker = "P1_CONFORMANCE_MARKER\n";
    write
        .send(WsMessage::Binary(encode_input(marker.as_bytes())))
        .await
        .expect("send input");
    write
        .send(WsMessage::Binary(encode_resize(100, 30)))
        .await
        .expect("send resize");
    write
        .send(WsMessage::Binary(encode_focus(true)))
        .await
        .expect("send focus");

    // OSC title via the PTY so the server emits TITLE.
    let title_cmd = "printf '\\033]0;p1-conformance\\007'\n";
    write
        .send(WsMessage::Binary(encode_input(title_cmd.as_bytes())))
        .await
        .expect("send title osc");

    let after_input = collect_until(&mut read, &mut decoder, Duration::from_secs(10), |f| {
        has_kind(f, FrameKind::Title)
    })
    .await;

    let mut all = initial;
    all.extend(after_input);

    assert!(
        has_kind(&all, FrameKind::Title),
        "expected TITLE from OSC; kinds={:?}",
        kinds_seen(&all)
    );
    let title_payload = all
        .iter()
        .find(|(k, _)| *k == kind_u8(FrameKind::Title))
        .map(|(_, p)| p.as_slice())
        .unwrap();
    let title = TitleFrame::decode(title_payload).expect("title protobuf");
    assert!(
        title.title.contains("p1-conformance"),
        "title was {:?}",
        title.title
    );

    // ACTIVITY usually flips to working on the first real output chunk.
    let activity_payload = all
        .iter()
        .find(|(k, _)| *k == kind_u8(FrameKind::Activity))
        .map(|(_, p)| p.as_slice())
        .expect("activity payload");
    ActivityFrame::decode(activity_payload).expect("activity protobuf");

    // EXIT via HTTP kill while still subscribed.
    server.kill_session().await;
    let after_kill = collect_until(&mut read, &mut decoder, Duration::from_secs(5), |f| {
        has_kind(f, FrameKind::Exit)
    })
    .await;
    all.extend(after_kill);
    assert!(
        has_kind(&all, FrameKind::Exit),
        "expected EXIT after kill; kinds={:?}",
        kinds_seen(&all)
    );
    let exit_payload = all
        .iter()
        .find(|(k, _)| *k == kind_u8(FrameKind::Exit))
        .map(|(_, p)| p.as_slice())
        .unwrap();
    ExitFrame::decode(exit_payload).expect("exit protobuf");

    let _ = write.close().await;

    // PING: server interval is 20s — wait one tick after a fresh connect would be
    // expensive; we do not wait here. RESET only fires on pruned/over-budget
    // replay, which needs megabytes of retained log — not exercised.
    //
    // Client kinds INPUT/RESIZE/FOCUS were sent above; the server stays up and
    // delivers OUTPUT/TITLE/EXIT afterward, which is the round-trip signal
    // (there is no ack frame for those).

    let seen = kinds_seen(&all);
    eprintln!(
        "conformance kinds observed: {:?}",
        seen.iter().copied().collect::<Vec<_>>()
    );
    eprintln!("not triggered in this test: PING (20s keepalive), RESET (needs byte-budget hole)");
    assert!(
        server.tmp.path().exists(),
        "temp DB dir should exist until shutdown"
    );

    server.shutdown().await;
}
