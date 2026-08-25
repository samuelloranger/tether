# tether-core P0 Spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the `tether-core` boundary by moving the terminal WebSocket protocol and replay (`sinceId`) ownership out of TypeScript into a new Rust crate, linked into the existing Tauri desktop backend, streaming a live session to the existing xterm.js WebView with no UI changes.

**Architecture:** A new `crates/tether-core` crate owns frame parsing, duplicate-output rejection, and per-session `sinceId` retention. `apps/mobile/src-tauri` takes it as a path dependency and exposes `core_connect` / `core_send` / `core_close` Tauri commands alongside the existing `ws_connect` / `ws_send` / `ws_close`. The core re-emits the *same* JSON frames the WebView already parses, so the frontend change is a transport swap behind an opt-in flag — trivially revertible and A/B comparable against the old path.

**Tech Stack:** Rust (tokio, tokio-tungstenite 0.24, serde, serde_json), Tauri 2, TypeScript (Bun test).

**Spec:** `docs/superpowers/specs/2026-08-25-native-client-rewrite-design.md`

## Global Constraints

- **P0 is a boundary spike, not a feature.** No new UI, no user-visible behavior change when the flag is off.
- **Rust edition `2021`**, matching the existing `tether-desktop` crate.
- **`tokio-tungstenite` stays at `0.24`** — the version `tether-desktop` already resolves. Do not bump it in this plan.
- **The core does NOT auto-reconnect in P0.** It emits a close event and the existing TypeScript reconnect loop in `apps/mobile/src/tether/sessionTransport.ts` drives reconnection, exactly as today. The core retains `since_id` per session across those reconnects — that is the thing being proven. Auto-reconnect inside the core is P2 work; adding it here would double-reconnect against the existing TS generation logic.
- **The core emits verbatim server JSON**, not a re-serialized structure. Parse to decide (drop duplicate `output`, reset on `reset`), then forward the original text. This keeps `diff`/`status` passthrough byte-exact without modelling those payloads in P0.
- **The v1 wire protocol is unchanged.** No server edits in this plan. Protobuf and TLS are P1.
- **Existing `ws_*` commands stay in place and untouched.** The old transport must keep working for the RN client and as the A/B baseline.
- **Formatting:** `cargo fmt` for Rust; Biome (2-space, single quotes, semicolons, trailing commas, width 100) for TypeScript. Run `bun format` before committing TS.

---

## File Structure

**Created:**
- `crates/tether-core/Cargo.toml` — crate manifest. No Tauri dependency, by design: the core must be linkable from iOS later.
- `crates/tether-core/src/lib.rs` — public surface and re-exports.
- `crates/tether-core/src/protocol.rs` — `ServerFrame` / `ClientFrame` serde types for the v1 wire format.
- `crates/tether-core/src/replay.rs` — `ReplayTracker`, the pure `sinceId` / `lastAppliedId` state machine ported from `terminalSessionLogic.ts`.
- `crates/tether-core/src/store.rs` — `ReplayStore`, per-session-id tracker retention across connections.
- `crates/tether-core/src/session.rs` — the WS client: URL construction, auth header, read loop, event emission.
- `crates/tether-core/tests/session_integration.rs` — drives the session against a real in-process WS server.
- `apps/mobile/src/tether/coreTransport.ts` — the `core_*` transport, mirroring `openTauriSocket`.
- `apps/mobile/src/tether/coreTransport.test.ts` — flag selection + invoke-shape tests.

**Modified:**
- `apps/mobile/src-tauri/Cargo.toml` — add the `tether-core` path dependency.
- `apps/mobile/src-tauri/src/main.rs` — add `core_connect` / `core_send` / `core_close` and register them.
- `apps/mobile/src/wsTransport.ts` — route to the core transport when the flag is on.
- `.github/workflows/ci.yml` — add a `cargo test` step.

**Responsibility split:** `protocol.rs` knows the wire and nothing else. `replay.rs` is pure logic with no I/O and no async — it is the piece most worth unit-testing and the piece that ports to iOS unchanged. `store.rs` holds the only mutable cross-connection state. `session.rs` is the only file that touches the network. `main.rs` is the only file that knows Tauri exists.

---

### Task 1: Scaffold the crate and the protocol types

**Files:**
- Create: `crates/tether-core/Cargo.toml`
- Create: `crates/tether-core/src/lib.rs`
- Create: `crates/tether-core/src/protocol.rs`
- Test: `crates/tether-core/src/protocol.rs` (inline `#[cfg(test)]` module — the Rust convention, and the convention this repo's colocated-test rule implies)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `tether_core::protocol::ServerFrame` — enum with variants `Output { id: u64, chunk: String }`, `Exit { exit_code: Option<i32> }`, `Title { title: String }`, `Activity { activity: String }`, `Diff`, `Reset`, `Ping`, `Unknown`.
  - `tether_core::protocol::ClientFrame` — enum with variants `Input { text: String }`, `Resize { cols: u16, rows: u16 }`, `Focus { focused: bool }`; method `fn to_json(&self) -> String`.

- [ ] **Step 1: Create the manifest**

`crates/tether-core/Cargo.toml`:

```toml
[package]
name = "tether-core"
version = "0.1.0"
edition = "2021"
description = "Shared Tether client core: protocol, replay, sessions"
publish = false

[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tokio = { version = "1", features = ["rt", "sync", "macros"] }
tokio-tungstenite = "0.24"
futures-util = "0.3"
thiserror = "2"

[dev-dependencies]
tokio = { version = "1", features = ["rt-multi-thread", "macros", "net", "time"] }
```

- [ ] **Step 2: Write the failing test**

`crates/tether-core/src/protocol.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_output_frame() {
        let frame: ServerFrame =
            serde_json::from_str(r#"{"type":"output","chunk":"hi","id":42}"#).unwrap();
        assert_eq!(
            frame,
            ServerFrame::Output {
                id: 42,
                chunk: "hi".to_string()
            }
        );
    }

    #[test]
    fn parses_exit_frame_with_camel_case_code() {
        let frame: ServerFrame =
            serde_json::from_str(r#"{"type":"exit","exitCode":130}"#).unwrap();
        assert_eq!(frame, ServerFrame::Exit { exit_code: Some(130) });
    }

    #[test]
    fn parses_exit_frame_without_code() {
        let frame: ServerFrame = serde_json::from_str(r#"{"type":"exit"}"#).unwrap();
        assert_eq!(frame, ServerFrame::Exit { exit_code: None });
    }

    #[test]
    fn parses_reset_and_ping() {
        assert_eq!(
            serde_json::from_str::<ServerFrame>(r#"{"type":"reset"}"#).unwrap(),
            ServerFrame::Reset
        );
        assert_eq!(
            serde_json::from_str::<ServerFrame>(r#"{"type":"ping"}"#).unwrap(),
            ServerFrame::Ping
        );
    }

    #[test]
    fn parses_title_and_activity() {
        assert_eq!(
            serde_json::from_str::<ServerFrame>(r#"{"type":"title","title":"vim"}"#).unwrap(),
            ServerFrame::Title { title: "vim".to_string() }
        );
        assert_eq!(
            serde_json::from_str::<ServerFrame>(r#"{"type":"activity","activity":"working"}"#)
                .unwrap(),
            ServerFrame::Activity { activity: "working".to_string() }
        );
    }

    // The core must not choke on a frame shape it doesn't model. `diff` carries
    // nested summary/status objects P0 deliberately doesn't parse, and a future
    // server may add frames outright.
    #[test]
    fn tolerates_unmodelled_frames() {
        let diff = r#"{"type":"diff","summary":{"files":[]},"status":{"branch":"main"}}"#;
        assert_eq!(serde_json::from_str::<ServerFrame>(diff).unwrap(), ServerFrame::Diff);
        assert_eq!(
            serde_json::from_str::<ServerFrame>(r#"{"type":"someFutureThing"}"#).unwrap(),
            ServerFrame::Unknown
        );
    }

    #[test]
    fn serializes_client_frames_in_the_v1_shape() {
        assert_eq!(
            ClientFrame::Input { text: "ls\r".to_string() }.to_json(),
            r#"{"type":"input","text":"ls\r"}"#
        );
        assert_eq!(
            ClientFrame::Resize { cols: 120, rows: 40 }.to_json(),
            r#"{"type":"resize","cols":120,"rows":40}"#
        );
        assert_eq!(
            ClientFrame::Focus { focused: true }.to_json(),
            r#"{"type":"focus","focused":true}"#
        );
    }
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd crates/tether-core && cargo test`
Expected: FAIL — `cannot find type ServerFrame in this scope`.

- [ ] **Step 4: Write the implementation**

At the top of `crates/tether-core/src/protocol.rs`, above the test module:

```rust
use serde::{Deserialize, Serialize};

/// A frame received from the server on `/api/ws`.
///
/// `Diff` and `Unknown` are intentionally payload-free: P0 forwards the original
/// JSON text to the WebView rather than re-serializing, so nothing here needs to
/// model `diff`'s nested summary/status. Parsing exists only to *decide* — drop a
/// duplicate `output`, clear the replay cursor on `reset`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ServerFrame {
    Output { id: u64, chunk: String },
    #[serde(rename_all = "camelCase")]
    Exit {
        #[serde(default)]
        exit_code: Option<i32>,
    },
    Title { title: String },
    Activity { activity: String },
    Diff,
    Reset,
    Ping,
    #[serde(other)]
    Unknown,
}

/// A frame sent to the server on `/api/ws`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ClientFrame {
    Input { text: String },
    Resize { cols: u16, rows: u16 },
    Focus { focused: bool },
}

impl ClientFrame {
    /// Serializes to the v1 wire shape. Infallible: every variant is a flat
    /// struct of primitives, so `serde_json` cannot fail here.
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("ClientFrame is always serializable")
    }
}
```

`crates/tether-core/src/lib.rs`:

```rust
//! Shared Tether client core.
//!
//! Consumed as a plain crate by the Tauri desktop backend, and (from P4) over
//! UniFFI by the iOS app. Deliberately free of any Tauri or platform
//! dependency.

pub mod protocol;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd crates/tether-core && cargo test`
Expected: PASS, 7 tests.

- [ ] **Step 6: Format and commit**

```bash
cd crates/tether-core && cargo fmt
cd /home/samuelloranger/sites/tether
git add crates/tether-core
git commit -m "feat(core): scaffold tether-core with v1 wire protocol types"
```

---

### Task 2: The replay tracker

**Files:**
- Create: `crates/tether-core/src/replay.rs`
- Modify: `crates/tether-core/src/lib.rs`
- Test: `crates/tether-core/src/replay.rs` (inline `#[cfg(test)]` module)

**Interfaces:**
- Consumes: nothing from Task 1 — this module is pure and standalone.
- Produces: `tether_core::replay::ReplayTracker` with `ReplayTracker::default()`, `fn since_id(&self) -> u64`, `fn accept_output(&mut self, id: u64) -> bool`, `fn reset(&mut self)`.

**Why this exists:** it is the port of `apps/mobile/src/tether/terminalSessionLogic.ts:132-147` (duplicate rejection via `lastAppliedId`, cursor advance via `sinceId`) and `:216-221` (both cleared on `reset`). Today that logic lives in a React-adjacent module; here it is a pure struct that iOS will reuse verbatim.

- [ ] **Step 1: Write the failing test**

`crates/tether-core/src/replay.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starts_from_zero() {
        let tracker = ReplayTracker::default();
        assert_eq!(tracker.since_id(), 0);
    }

    #[test]
    fn accepts_advancing_ids_and_advances_the_cursor() {
        let mut tracker = ReplayTracker::default();
        assert!(tracker.accept_output(1));
        assert_eq!(tracker.since_id(), 1);
        assert!(tracker.accept_output(7));
        assert_eq!(tracker.since_id(), 7);
    }

    // A replay overlapping what the client already applied must not be written
    // to the emulator twice — that is what `lastAppliedId` guards in the TS.
    #[test]
    fn rejects_duplicate_and_stale_ids_without_moving_the_cursor() {
        let mut tracker = ReplayTracker::default();
        assert!(tracker.accept_output(5));
        assert!(!tracker.accept_output(5));
        assert!(!tracker.accept_output(3));
        assert_eq!(tracker.since_id(), 5);
    }

    // A server `reset` means the client's history has a hole; the cursor must
    // rewind to 0 so the next connection asks for everything retained.
    #[test]
    fn reset_rewinds_the_cursor_and_reopens_earlier_ids() {
        let mut tracker = ReplayTracker::default();
        tracker.accept_output(9);
        tracker.reset();
        assert_eq!(tracker.since_id(), 0);
        assert!(tracker.accept_output(4));
        assert_eq!(tracker.since_id(), 4);
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd crates/tether-core && cargo test replay`
Expected: FAIL — `cannot find type ReplayTracker in this scope`.

- [ ] **Step 3: Write the implementation**

At the top of `crates/tether-core/src/replay.rs`:

```rust
/// Tracks how far a client has consumed a session's log so a reconnect replays
/// only what it missed, and an overlapping replay is not applied twice.
///
/// Ported from `apps/mobile/src/tether/terminalSessionLogic.ts`. Pure and
/// sync — no I/O, no async, no platform types.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReplayTracker {
    since_id: u64,
    last_applied_id: u64,
}

impl ReplayTracker {
    /// The `sinceId` to send on the next connection.
    pub fn since_id(&self) -> u64 {
        self.since_id
    }

    /// Returns true if this output frame is new and should be applied. A frame
    /// at or below the last applied id is a replay overlap and is dropped
    /// without moving the cursor.
    pub fn accept_output(&mut self, id: u64) -> bool {
        if id <= self.last_applied_id {
            return false;
        }
        self.last_applied_id = id;
        self.since_id = id;
        true
    }

    /// Clears the cursor after a server `reset` — the client's history has a
    /// hole, so the next connection must ask for everything still retained.
    pub fn reset(&mut self) {
        self.since_id = 0;
        self.last_applied_id = 0;
    }
}
```

Add to `crates/tether-core/src/lib.rs`, after `pub mod protocol;`:

```rust
pub mod replay;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd crates/tether-core && cargo test replay`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
cd crates/tether-core && cargo fmt
cd /home/samuelloranger/sites/tether
git add crates/tether-core
git commit -m "feat(core): add ReplayTracker ported from terminalSessionLogic"
```

---

### Task 3: Per-session replay retention

**Files:**
- Create: `crates/tether-core/src/store.rs`
- Modify: `crates/tether-core/src/lib.rs`
- Test: `crates/tether-core/src/store.rs` (inline `#[cfg(test)]` module)

**Interfaces:**
- Consumes: `tether_core::replay::ReplayTracker` (Task 2).
- Produces: `tether_core::store::ReplayStore` with `ReplayStore::new()`, `fn since_id(&self, session_id: &str) -> u64`, `fn accept_output(&self, session_id: &str, id: u64) -> bool`, `fn reset(&self, session_id: &str)`, `fn forget(&self, session_id: &str)`.

**Why this exists:** this is the actual claim P0 tests. Today `sinceId` lives in the TypeScript session cache and is handed to the Rust bridge as a URL parameter. Here the Rust side retains it per session id across connections, so the TS reconnect no longer needs to know it exists. Interior mutability (`&self`, not `&mut self`) because Tauri command handlers receive shared state.

- [ ] **Step 1: Write the failing test**

`crates/tether-core/src/store.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_sessions_start_at_zero() {
        let store = ReplayStore::new();
        assert_eq!(store.since_id("nope"), 0);
    }

    // The point of the whole spike: a session's cursor survives the connection
    // that produced it, so the TS reconnect doesn't have to carry sinceId.
    #[test]
    fn retains_the_cursor_across_connections() {
        let store = ReplayStore::new();
        assert!(store.accept_output("build", 12));
        assert_eq!(store.since_id("build"), 12);
        // ...connection drops, a new one opens, same store:
        assert_eq!(store.since_id("build"), 12);
        assert!(!store.accept_output("build", 12));
        assert!(store.accept_output("build", 13));
        assert_eq!(store.since_id("build"), 13);
    }

    #[test]
    fn keeps_sessions_independent() {
        let store = ReplayStore::new();
        store.accept_output("a", 5);
        store.accept_output("b", 99);
        assert_eq!(store.since_id("a"), 5);
        assert_eq!(store.since_id("b"), 99);
    }

    #[test]
    fn reset_clears_only_the_named_session() {
        let store = ReplayStore::new();
        store.accept_output("a", 5);
        store.accept_output("b", 99);
        store.reset("a");
        assert_eq!(store.since_id("a"), 0);
        assert_eq!(store.since_id("b"), 99);
    }

    // A killed session must not leave its cursor behind: a later session
    // reusing the id would silently skip its own early output.
    #[test]
    fn forget_drops_the_session_entirely() {
        let store = ReplayStore::new();
        store.accept_output("a", 5);
        store.forget("a");
        assert_eq!(store.since_id("a"), 0);
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd crates/tether-core && cargo test store`
Expected: FAIL — `cannot find type ReplayStore in this scope`.

- [ ] **Step 3: Write the implementation**

At the top of `crates/tether-core/src/store.rs`:

```rust
use std::collections::HashMap;
use std::sync::Mutex;

use crate::replay::ReplayTracker;

/// Holds one [`ReplayTracker`] per session id, retained across connections.
///
/// Interior mutability because Tauri command handlers hold shared state, and
/// because iOS will call this from Swift through an immutable reference.
#[derive(Debug, Default)]
pub struct ReplayStore(Mutex<HashMap<String, ReplayTracker>>);

impl ReplayStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// The `sinceId` for the next connection to this session. Unknown sessions
    /// start at 0, which asks the server for everything it still retains.
    pub fn since_id(&self, session_id: &str) -> u64 {
        self.lock()
            .get(session_id)
            .map(ReplayTracker::since_id)
            .unwrap_or(0)
    }

    /// See [`ReplayTracker::accept_output`]. Creates the tracker on first use.
    pub fn accept_output(&self, session_id: &str, id: u64) -> bool {
        self.lock()
            .entry(session_id.to_string())
            .or_default()
            .accept_output(id)
    }

    /// See [`ReplayTracker::reset`].
    pub fn reset(&self, session_id: &str) {
        self.lock()
            .entry(session_id.to_string())
            .or_default()
            .reset();
    }

    /// Drops a session's cursor entirely — for a killed session, so a later
    /// session reusing the id doesn't skip its own early output.
    pub fn forget(&self, session_id: &str) {
        self.lock().remove(session_id);
    }

    /// A poisoned mutex here means another thread panicked mid-update. The
    /// tracker is two integers with no invariant spanning them, so recovering
    /// the guard is safe and strictly better than propagating a panic into a
    /// Tauri command.
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, ReplayTracker>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
}
```

Add to `crates/tether-core/src/lib.rs`, after `pub mod replay;`:

```rust
pub mod store;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd crates/tether-core && cargo test store`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
cd crates/tether-core && cargo fmt
cd /home/samuelloranger/sites/tether
git add crates/tether-core
git commit -m "feat(core): retain replay cursors per session in ReplayStore"
```

---

### Task 4: The session WebSocket client

**Files:**
- Create: `crates/tether-core/src/session.rs`
- Modify: `crates/tether-core/src/lib.rs`
- Test: `crates/tether-core/tests/session_integration.rs`

**Interfaces:**
- Consumes: `protocol::{ServerFrame, ClientFrame}` (Task 1), `store::ReplayStore` (Task 3).
- Produces:
  - `tether_core::session::SessionConfig { pub base_ws_url: String, pub password: String, pub session_id: String, pub cols: u16, pub rows: u16 }`
  - `tether_core::session::CoreEvent` — enum: `Frame(String)` (verbatim server JSON to hand the WebView), `Closed`.
  - `tether_core::session::SessionHandle` — `fn send(&self, frame: ClientFrame)`, `fn close(&self)`.
  - `tether_core::session::SessionError` — `thiserror` enum.
  - `tether_core::session::ws_url(cfg: &SessionConfig, since_id: u64) -> String`
  - `async fn tether_core::session::open_session(cfg: SessionConfig, store: Arc<ReplayStore>, events: UnboundedSender<CoreEvent>) -> Result<SessionHandle, SessionError>`

- [ ] **Step 1: Write the failing URL test**

Add to `crates/tether-core/src/session.rs` an inline test module:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_the_v1_ws_url_with_the_stored_cursor() {
        let cfg = SessionConfig {
            base_ws_url: "ws://10.0.0.5:8085".to_string(),
            password: "secret".to_string(),
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
            password: String::new(),
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd crates/tether-core && cargo test session`
Expected: FAIL — `cannot find function ws_url in this scope`.

- [ ] **Step 3: Write the implementation**

At the top of `crates/tether-core/src/session.rs`:

```rust
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
    pub password: String,
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
        format!("Bearer {}", cfg.password)
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
                    if write.send(Message::Text(text.into())).await.is_err() {
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

    Ok(SessionHandle { outgoing: outgoing_tx })
}
```

Add to `crates/tether-core/src/lib.rs`, after `pub mod store;`:

```rust
pub mod session;
```

- [ ] **Step 4: Run the URL tests to verify they pass**

Run: `cd crates/tether-core && cargo test session`
Expected: PASS, 2 tests.

- [ ] **Step 5: Write the failing integration test**

`crates/tether-core/tests/session_integration.rs`:

```rust
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
async fn spawn_server(
    to_send: Vec<String>,
) -> (String, tokio::sync::oneshot::Receiver<(String, Option<String>)>) {
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
            write.send(Message::Text(frame.into())).await.unwrap();
        }
        let first_client_frame = match read.next().await {
            Some(Ok(Message::Text(t))) => Some(t.to_string()),
            _ => None,
        };
        let _ = report_tx.send((path, first_client_frame));
    });

    (format!("ws://127.0.0.1:{port}"), report_rx)
}

fn config(base: &str, session_id: &str) -> SessionConfig {
    SessionConfig {
        base_ws_url: base.to_string(),
        password: "pw".to_string(),
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
    handle.send(ClientFrame::Input { text: "ls\r".to_string() });

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
    assert_eq!(client_frame.as_deref(), Some(r#"{"type":"input","text":"ls\r"}"#));
}

#[tokio::test]
async fn a_second_connection_resumes_from_the_stored_cursor() {
    let store = Arc::new(ReplayStore::new());

    let (base, first) = spawn_server(vec![r#"{"type":"output","chunk":"a","id":9}"#.to_string()]).await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    open_session(config(&base, "s1"), store.clone(), tx).await.unwrap();
    rx.recv().await.unwrap();
    let _ = first.await;

    // New socket, same store — the cursor must travel.
    let (base2, second) = spawn_server(vec![]).await;
    let (tx2, _rx2) = mpsc::unbounded_channel();
    open_session(config(&base2, "s1"), store.clone(), tx2).await.unwrap();
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

    open_session(config(&base, "s1"), store.clone(), tx).await.unwrap();
    rx.recv().await.unwrap();
    // The reset itself is forwarded so the WebView clears its emulator.
    assert_eq!(rx.recv().await.unwrap(), CoreEvent::Frame(r#"{"type":"reset"}"#.to_string()));
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
```

- [ ] **Step 6: Run it to verify it fails, then passes**

Run: `cd crates/tether-core && cargo test --test session_integration`
Expected: the tests compile and pass against the Step 3 implementation. If `accept_hdr_async` is missing, add `features = ["handshake"]` to the `tokio-tungstenite` dev-dependency and re-run.

- [ ] **Step 7: Commit**

```bash
cd crates/tether-core && cargo fmt && cargo clippy -- -D warnings
cd /home/samuelloranger/sites/tether
git add crates/tether-core
git commit -m "feat(core): add session WS client with core-owned replay cursor"
```

---

### Task 5: Wire the core into the Tauri backend

**Files:**
- Modify: `apps/mobile/src-tauri/Cargo.toml`
- Modify: `apps/mobile/src-tauri/src/main.rs`

**Interfaces:**
- Consumes: `tether_core::session::{open_session, ws_url, CoreEvent, SessionConfig, SessionHandle}`, `tether_core::protocol::ClientFrame`, `tether_core::store::ReplayStore` (Tasks 1–4).
- Produces: Tauri commands `core_connect(conn_id, base_ws_url, password, session_id, cols, rows)`, `core_send(conn_id, text)`, `core_close(conn_id)`, `core_forget(session_id)`; events `core-message-<conn_id>` (payload: the server's JSON string) and `core-closed-<conn_id>` (no payload).

**Note on the command shape:** `core_connect` deliberately has **no `sinceId` parameter** — that is the whole point. It takes `base_ws_url` (origin only) instead of a full URL, because the core builds the path and query. `core_send` takes the already-serialized client JSON so the existing TypeScript callers, which build `{"type":"input",...}` themselves, need no changes beyond the transport swap.

- [ ] **Step 1: Add the dependency**

In `apps/mobile/src-tauri/Cargo.toml`, under `[dependencies]`, after the `tokio` line:

```toml
tether-core = { path = "../../../crates/tether-core" }
```

- [ ] **Step 2: Verify it resolves**

Run: `cd apps/mobile/src-tauri && cargo check`
Expected: compiles; `Cargo.lock` gains a `tether-core` entry.

- [ ] **Step 3: Add the commands**

Append to `apps/mobile/src-tauri/src/main.rs`, before the `main()` function:

```rust
// The core-backed transport. Unlike the `ws_*` bridge above — a dumb byte pipe
// where TypeScript owns sinceId and hands it over as a URL parameter — here
// `tether-core` owns the replay cursor and builds the URL itself. Frames are
// re-emitted verbatim, so the WebView's parser sees exactly what the server
// sent and needs no changes.
#[derive(Default)]
struct CoreBridge {
    sessions: Mutex<HashMap<String, tether_core::session::SessionHandle>>,
    replay: std::sync::Arc<tether_core::store::ReplayStore>,
}

#[tauri::command]
async fn core_connect(
    app: AppHandle,
    conn_id: String,
    base_ws_url: String,
    password: String,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let (tx, mut rx) = mpsc::unbounded_channel::<tether_core::session::CoreEvent>();
    let replay = app.state::<CoreBridge>().replay.clone();
    let handle = tether_core::session::open_session(
        tether_core::session::SessionConfig {
            base_ws_url,
            password,
            session_id,
            cols,
            rows,
        },
        replay,
        tx,
    )
    .await
    .map_err(|e| e.to_string())?;

    app.state::<CoreBridge>()
        .sessions
        .lock()
        .unwrap()
        .insert(conn_id.clone(), handle);

    // Events are scoped by conn_id, matching the ws_* bridge, so a superseded
    // connection's late frames can't land on a newer socket.
    let msg_evt = format!("core-message-{conn_id}");
    let close_evt = format!("core-closed-{conn_id}");
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                tether_core::session::CoreEvent::Frame(text) => {
                    let _ = app.emit(&msg_evt, text);
                }
                tether_core::session::CoreEvent::Closed => break,
            }
        }
        app.state::<CoreBridge>()
            .sessions
            .lock()
            .unwrap()
            .remove(&conn_id);
        let _ = app.emit(&close_evt, ());
    });

    Ok(())
}

#[tauri::command]
fn core_send(bridge: State<CoreBridge>, conn_id: String, text: String) -> Result<(), String> {
    let handle = bridge
        .sessions
        .lock()
        .unwrap()
        .get(&conn_id)
        .cloned()
        .ok_or_else(|| format!("no core session for {conn_id}"))?;
    // The webview already serializes v1 client frames, so pass the text through
    // rather than re-encoding it.
    handle.send(tether_core::protocol::ClientFrame::Input { text });
    Ok(())
}

#[tauri::command]
fn core_close(bridge: State<CoreBridge>, conn_id: String) {
    if let Some(handle) = bridge.sessions.lock().unwrap().remove(&conn_id) {
        handle.close();
    }
}

#[tauri::command]
fn core_forget(bridge: State<CoreBridge>, session_id: String) {
    bridge.replay.forget(&session_id);
}
```

**Correction to apply while writing this:** `core_send` above wraps the text in `ClientFrame::Input`, which is wrong for resize and focus frames the WebView also sends. Instead, give `SessionHandle` a raw-text path. In `crates/tether-core/src/session.rs`, add to `impl SessionHandle`:

```rust
    /// Sends an already-serialized v1 client frame. Used by hosts whose UI layer
    /// builds the JSON itself.
    pub fn send_raw(&self, text: String) {
        let _ = self.outgoing.send(Outgoing::Frame(text));
    }
```

and change `core_send`'s body to `handle.send_raw(text);`, dropping the unused `ClientFrame` import if nothing else uses it.

- [ ] **Step 4: Register the commands and the state**

In `main()`, add `.manage(CoreBridge::default())` next to the existing `Bridge` management, and extend the `tauri::generate_handler![...]` list with `core_connect, core_send, core_close, core_forget`.

- [ ] **Step 5: Verify it compiles**

Run: `cd apps/mobile/src-tauri && cargo check && cargo clippy -- -D warnings`
Expected: no errors, no warnings.

- [ ] **Step 6: Commit**

```bash
cd apps/mobile/src-tauri && cargo fmt
cd /home/samuelloranger/sites/tether
git add crates/tether-core apps/mobile/src-tauri
git commit -m "feat(desktop): expose core_connect/send/close backed by tether-core"
```

---

### Task 6: The TypeScript core transport, behind a flag

**Files:**
- Create: `apps/mobile/src/tether/coreTransport.ts`
- Create: `apps/mobile/src/tether/coreTransport.test.ts`
- Modify: `apps/mobile/src/wsTransport.ts`

**Interfaces:**
- Consumes: the Tauri commands from Task 5; `TerminalSocket` and `TransportHandlers` from `apps/mobile/src/wsTransport.ts`.
- Produces: `openCoreSocket(connId, params, password, handlers)` returning `Promise<TerminalSocket>`; `coreTransportEnabled(): boolean`.

**The flag:** `coreTransportEnabled()` reads `globalThis.localStorage?.getItem('tether.coreTransport') === '1'`, wrapped in try/catch. Opt-in, per-machine, no rebuild needed to flip — which is what makes the A/B comparison against the `ws_*` path practical.

- [ ] **Step 1: Write the failing test**

`apps/mobile/src/tether/coreTransport.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import { buildCoreConnectArgs, coreTransportEnabled } from './coreTransport';

describe('coreTransportEnabled', () => {
  it('is off when the flag is unset', () => {
    expect(coreTransportEnabled({ getItem: () => null })).toBe(false);
  });

  it('is on only for the exact opt-in value', () => {
    expect(coreTransportEnabled({ getItem: () => '1' })).toBe(true);
    expect(coreTransportEnabled({ getItem: () => 'true' })).toBe(false);
  });

  // A storage backend that throws (private mode, disabled site data) must not
  // take the transport down with it.
  it('is off when storage throws', () => {
    expect(
      coreTransportEnabled({
        getItem: () => {
          throw new Error('nope');
        },
      }),
    ).toBe(false);
  });

  it('is off when there is no storage at all', () => {
    expect(coreTransportEnabled(undefined)).toBe(false);
  });
});

describe('buildCoreConnectArgs', () => {
  // The core owns sinceId, so it must NOT appear in the invoke payload — that
  // absence is the whole point of the spike.
  it('sends the origin and session, never sinceId', () => {
    const args = buildCoreConnectArgs('conn-3', 'ws://10.0.0.5:8085', 'pw', {
      sessionId: 'build',
      sinceId: 512,
      cols: 120,
      rows: 40,
    });
    expect(args).toEqual({
      connId: 'conn-3',
      baseWsUrl: 'ws://10.0.0.5:8085',
      password: 'pw',
      sessionId: 'build',
      cols: 120,
      rows: 40,
    });
    expect('sinceId' in args).toBe(false);
  });

  it('defaults cols and rows when the caller omits them', () => {
    const args = buildCoreConnectArgs('c', 'ws://h:1', '', { sessionId: 's' });
    expect(args.cols).toBe(80);
    expect(args.rows).toBe(24);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun --cwd apps/mobile run test src/tether/coreTransport.test.ts`
Expected: FAIL — cannot resolve `./coreTransport`.

- [ ] **Step 3: Write the implementation**

`apps/mobile/src/tether/coreTransport.ts`:

```ts
import type { TerminalSocket, TransportHandlers } from '../wsTransport';

// The tether-core transport (P0 spike). Unlike `openTauriSocket`, this does not
// pass sinceId: the Rust core retains the replay cursor per session, so a
// reconnect resumes correctly without the TS side tracking it. Frames arrive
// verbatim on `core-message-<connId>`, so callers parse exactly what they parse
// on the old path.
//
// Opt-in per machine:  localStorage.setItem('tether.coreTransport', '1')

type StorageLike = { getItem(key: string): string | null } | undefined;

export const CORE_TRANSPORT_FLAG = 'tether.coreTransport';

export function coreTransportEnabled(storage?: StorageLike): boolean {
  const store = storage ?? (globalThis as { localStorage?: StorageLike }).localStorage;
  if (!store) return false;
  try {
    return store.getItem(CORE_TRANSPORT_FLAG) === '1';
  } catch {
    return false;
  }
}

export interface CoreConnectParams {
  sessionId: string;
  sinceId?: number;
  cols?: number;
  rows?: number;
}

export interface CoreConnectArgs {
  connId: string;
  baseWsUrl: string;
  password: string;
  sessionId: string;
  cols: number;
  rows: number;
}

/** Builds the `core_connect` payload. `sinceId` is dropped on purpose. */
export function buildCoreConnectArgs(
  connId: string,
  baseWsUrl: string,
  password: string,
  params: CoreConnectParams,
): CoreConnectArgs {
  return {
    connId,
    baseWsUrl,
    password,
    sessionId: params.sessionId,
    cols: params.cols ?? 80,
    rows: params.rows ?? 24,
  };
}

export async function openCoreSocket(
  connId: string,
  baseWsUrl: string,
  password: string,
  params: CoreConnectParams,
  h: TransportHandlers,
): Promise<TerminalSocket> {
  const { invoke } = await import('@tauri-apps/api/core');
  const { listen } = await import('@tauri-apps/api/event');
  const unMsg = await listen<string>(`core-message-${connId}`, (e) => h.onMessage(e.payload));
  const unClose = await listen(`core-closed-${connId}`, () => h.onClose());
  const cleanup = () => {
    unMsg();
    unClose();
  };
  try {
    await invoke('core_connect', buildCoreConnectArgs(connId, baseWsUrl, password, params));
    h.onOpen();
  } catch {
    cleanup();
    h.onClose();
  }
  return {
    send: (text) => {
      invoke('core_send', { connId, text }).catch(() => {
        cleanup();
        h.onClose();
      });
    },
    close: () => {
      cleanup();
      invoke('core_close', { connId }).catch(() => {});
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun --cwd apps/mobile run test src/tether/coreTransport.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Route to it from wsTransport**

`openTerminalSocket` in `apps/mobile/src/wsTransport.ts` currently receives a fully-built URL with the query string already attached. The core transport needs the origin and the params separately. Rather than change every caller in this spike, parse them back out at the transport boundary — a deliberate spike-only shim, and note it as such in a comment:

```ts
// Spike-only: the core transport needs origin + params separately, while every
// caller still builds a full URL for the ws_* path. Splitting it here keeps the
// blast radius at one file. When the core becomes the only transport, push this
// split up into hostClient.openSocket and delete this.
function splitSocketUrl(url: string): { baseWsUrl: string; params: CoreConnectParams } {
  const parsed = new URL(url);
  const number = (key: string, fallback: number) => {
    const raw = parsed.searchParams.get(key);
    const value = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(value) ? value : fallback;
  };
  return {
    baseWsUrl: `${parsed.protocol}//${parsed.host}`,
    params: {
      sessionId: parsed.searchParams.get('sessionId') ?? 'default',
      cols: number('cols', 80),
      rows: number('rows', 24),
    },
  };
}
```

Next, both transports return `Promise<TerminalSocket>` while callers need a synchronous
`TerminalSocket`. `openTerminalSocket` already solves this, but the adapter is inlined in
its Tauri branch (`wsTransport.ts:93-113`: a `real`/`closed`/`pending` closure that
queues sends until the promise resolves). Extract it verbatim so both transports share
one mechanism instead of two copies:

```ts
// Adapts a Promise<TerminalSocket> into the synchronous TerminalSocket callers
// expect, queueing sends until the real socket resolves. Extracted from
// openTerminalSocket's Tauri branch so both transports share it.
function deferredSocket(pending$: Promise<TerminalSocket>): TerminalSocket {
  let real: TerminalSocket | null = null;
  let closed = false;
  const pending: string[] = [];
  pending$.then((s) => {
    if (closed) {
      s.close();
      return;
    }
    real = s;
    for (const t of pending) s.send(t);
    pending.length = 0;
  });
  return {
    send: (t) => {
      if (real) real.send(t);
      else pending.push(t);
    },
    close: () => {
      closed = true;
      real?.close();
    },
  };
}
```

Then rewrite the Tauri branch of `openTerminalSocket` to pick a transport, replacing the
inline adapter that now lives in `deferredSocket`:

```ts
  if (isTauri()) {
    const connId = `c${++connSeq}`;
    if (coreTransportEnabled()) {
      const { baseWsUrl, params } = splitSocketUrl(url);
      return deferredSocket(openCoreSocket(connId, baseWsUrl, password, params, h));
    }
    return deferredSocket(openTauriSocket(connId, url, password, h));
  }
```

The `ws_*` path must come out of this byte-for-byte equivalent to what it was — the whole
A/B comparison rests on the baseline being unchanged.

- [ ] **Step 6: Verify lint and the full mobile suite**

Run: `bun format && bun lint && bun --cwd apps/mobile run test`
Expected: Biome clean, both typechecks clean, mobile logic suite green.

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/src/tether/coreTransport.ts apps/mobile/src/tether/coreTransport.test.ts apps/mobile/src/wsTransport.ts
git commit -m "feat(desktop): add opt-in tether-core transport behind a flag"
```

---

### Task 7: CI, manual verification, and the go/no-go writeup

**Files:**
- Modify: `.github/workflows/ci.yml`
- Create: `docs/superpowers/plans/2026-08-25-tether-core-p0-findings.md`

**Interfaces:**
- Consumes: everything above.
- Produces: a written go/no-go recommendation on P1–P5.

- [ ] **Step 1: Add Rust to CI**

In `.github/workflows/ci.yml`, in the `lint-test` job after the "Mobile tests (components)" step:

```yaml
      # tether-core is plain Rust with no Tauri dependency, so it tests on a
      # bare runner — no system webkit/gtk packages needed.
      - uses: dtolnay/rust-toolchain@stable
        with:
          components: clippy, rustfmt

      - uses: actions/cache@v4
        with:
          path: |
            ~/.cargo/registry
            ~/.cargo/git
            crates/tether-core/target
          key: cargo-core-${{ runner.os }}-${{ hashFiles('crates/tether-core/Cargo.toml') }}
          restore-keys: |
            cargo-core-${{ runner.os }}-

      - name: Core tests (rust)
        timeout-minutes: 10
        run: cargo fmt --check && cargo clippy -- -D warnings && cargo test
        working-directory: crates/tether-core
```

Note: the other `uses:` entries in this workflow are pinned by commit SHA. Pin `dtolnay/rust-toolchain` the same way before merging — resolve the SHA for the `stable` tag and substitute it.

- [ ] **Step 2: Verify CI locally**

Run: `cd crates/tether-core && cargo fmt --check && cargo clippy -- -D warnings && cargo test`
Expected: all three clean.

- [ ] **Step 3: Manual end-to-end verification**

This is the actual spike result — do not skip it or infer it from the unit tests.

1. Start the dev server: `bun dev:server`
2. Run the desktop app: `bun --cwd apps/mobile run tauri:dev`
3. With the flag **off**, open a session, run `ls`, `htop`, and a `find /` that produces heavy output. Note that it works — this is the baseline.
4. In the app's devtools console: `localStorage.setItem('tether.coreTransport', '1')`, then reload.
5. Repeat step 3 on the core transport. Confirm: output renders identically, keyboard input works, resize works.
6. **The replay test.** With a session producing output, kill the server (`tether stop` or Ctrl-C on the dev server), wait ~10s, restart it. Confirm the session reconnects and replays only what was missed — no duplicated block, no missing block, no full-history re-render.
7. **The reset test.** Reconnect with a `sinceId` older than the server's `pruned_before` (easiest: let a session produce more than the ~2000-row cap while disconnected). Confirm the terminal clears once and renders a coherent recent tail rather than a corrupted screen.

- [ ] **Step 4: Write the findings**

Create `docs/superpowers/plans/2026-08-25-tether-core-p0-findings.md` covering, with actual observations rather than expectations:

- Did the core transport behave identically to the `ws_*` baseline? Any visible difference in output fidelity, input latency, or resize behavior?
- Heavy-output throughput: subjectively, did `find /` render as fast on the core path? Any stall or backpressure the old path didn't have?
- Did replay-after-reconnect work with the core owning `sinceId`? Any duplicated or lost output?
- Did `reset` clear correctly?
- How much friction was the boundary itself — the `SessionConfig`/`CoreEvent` shape, the verbatim-forwarding choice, the URL-splitting shim?
- **Go/no-go on P1–P5**, with reasoning. If no-go, name what specifically failed and what it implies for the spec.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml docs/superpowers/plans/2026-08-25-tether-core-p0-findings.md
git commit -m "ci: test tether-core; docs: P0 spike findings"
```

---

## Self-Review

**Spec coverage.** P0's spec text is: *"`tether-core` with ws + replay only, linked into the current Tauri backend, streaming one session to the existing xterm.js via Tauri events. Proves the core boundary with zero new UI."* Tasks 1–4 build the crate (protocol + replay + store + ws). Task 5 links it into the existing backend. Task 6 streams to the existing xterm.js with zero UI change. Task 7 is the go/no-go the spec calls for. Covered.

Deliberately **not** covered here, and correctly so — each belongs to a later phase per the spec: protobuf and binary framing (P1), TLS and pinning (P1), the terminal parser and grid snapshots (P2/P4), UniFFI (P4), and auto-reconnect inside the core (P2, and explicitly excluded by a Global Constraint to avoid double-reconnecting against the existing TS generation logic).

**Placeholder scan.** No TBDs. Every code step carries real code. One step directs the implementer to look up a fact in the repo rather than deferring a decision: Task 7 Step 1, resolving the commit SHA for the `dtolnay/rust-toolchain` pin, since this workflow pins its actions by SHA.

**Type consistency.** `ReplayTracker` (Task 2) is consumed by `ReplayStore` (Task 3) with matching `since_id` / `accept_output` / `reset` signatures. `SessionConfig` fields in Task 4 match the `core_connect` parameters in Task 5. `CoreEvent::{Frame, Closed}` in Task 4 matches the match arms in Task 5. `buildCoreConnectArgs` in Task 6 emits exactly the six parameters `core_connect` declares, in camelCase as Tauri expects.

**One known wart, flagged rather than hidden.** Task 5 Step 3 writes a `core_send` that wraps text in `ClientFrame::Input`, then Step 3 immediately corrects it to a `send_raw` path — because `resize` and `focus` frames also flow through `core_send`. It is written that way deliberately: the wrong version is the obvious one to write, and an implementer who reads only the code block would ship the bug. The correction adds a method to Task 4's `SessionHandle`, so Task 4 must be complete before Task 5 begins.

---

**Plan complete and saved to `docs/superpowers/plans/2026-08-25-tether-core-p0-spike.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — tasks executed in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
