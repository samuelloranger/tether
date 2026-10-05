# M3 — `tether-ssh` Implementation Plan

> **For the implementer:** Work through the tasks in order. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `tether_core::Transport` / `Connection` with `russh`: dial, capture the host key for core to pin before auth, authenticate by vault key, password, or the Windows OpenSSH agent, keep the link alive after auth, carry many PTY channels on one connection, run one-off execs, and send files with SCP sink mode.

**Architecture:** One `RusshTransport` (holds the app's tokio runtime handle and an agent connector) dials a `RusshConnection`. A `ClientHandler` captures the host key digest during KEX and reports drops; core's `connect()` reads the digest, decides pin / match / mismatch, and only then calls `authenticate`, so a mismatch never sends an auth packet. Every remote operation opens its own session channel on the shared `client::Handle` (behind a `tokio::sync::RwLock`: auth takes the write lock, everything else reads concurrently). All tests run against an in-process `russh` server in `tests/support/`.

**Tech Stack:** `russh` **=0.64.1** (`default-features = false`, features `ring`, `rsa`, `flate2`), tokio 1, futures 0.3, bytes 1, sha2 0.10, zeroize 1, tracing 0.1; dev: rand 0.10 (`thread_rng`), tempfile 3, uuid 1.

**Spec:** `clients/windows/SPEC.md` (Connect, Reconnect, Upload, "Why `russh`", Tests → the `tether-ssh` line). **Roadmap / contract:** `docs/superpowers/plans/2026-10-05-windows-00-roadmap.md`.

## Global Constraints

Everything in the roadmap's Global Constraints applies. The ones this milestone touches:

- `tether-ssh` builds and tests on Linux and Windows. Win32-only code (the named-pipe agent) is `#[cfg(windows)]`.
- No C toolchain beyond what the MSVC Rust target already needs: russh's default `aws-lc-rs` backend needs CMake + NASM on Windows, so it is **off**; the crypto backend is `ring`.
- Host-key fingerprint: SHA-256 of the host key blob (`PublicKey::to_bytes()`), 32 bytes, formatted by core's `hex_fingerprint`. Pinned before auth. A mismatch is never retried, never overridable, and sends no auth packet.
- Agent: `\\.\pipe\openssh-ssh-agent`, identities offered in the agent's order, the private key never leaves the agent. **Agent forwarding is never requested.**
- Keepalive starts only after auth, every 15 s (core passes the interval). A drop is a socket error or two missed keepalive replies.
- Connect timeout 10 s covers TCP + handshake (core passes it to `dial`).
- The `zmx` path and quoting come from core (`tether_core::zmx::{shell_quote, attach_command, kill_command}`); this crate never builds a shell command by string concatenation of user text without `shell_quote`.
- Comments: minimal, only a non-obvious why. Live SSH test opts in with `TETHER_LIVE_SSH=1`.
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

All commands run from `clients/windows/`.

## Review Focus

1. **A session name that fights the shell** — `it's`, `a b`, `$(touch pwned)`, `` `id` ``, `;rm -rf ~`, `ünï` — sent through `exec(kill_command(name))` on a real `sh` must reach `zmx` as exactly one argument, and nothing else runs. (Task 5, `hostile_names_reach_zmx_as_one_argument`, unix-only because it shells out to `sh`.)
2. **A host whose key changes during a re-key** — `check_server_key` is called again on every KEX; the second key must equal the first or the session ends. Core only verified the first. (Task 1, `rekey_with_a_different_key_is_refused` unit test on `ClientHandler`.)
3. **A background tab nobody reads for a while** — PTY data must keep flowing for every channel; a reader task always drains russh into the tab's `mpsc` (capacity 1024), so one slow consumer cannot stall the shared session loop for the other tabs. (Task 6, `slow_reader_does_not_stall_other_channel`.)
4. **A link that dies silently** (suspend, Wi-Fi drop: socket looks open, no RST) — two missed pings fire `Dropped` within ~2 intervals; a socket that errors fires `Dropped` even if russh's own `disconnected` callback is skipped because the final `shutdown()` fails. (Task 7, freezable proxy tests.)
5. **SCP to a path with spaces or a refused directory** — the quoted target reaches `scp -t` intact, and a `\x01scp: …` refusal surfaces as an error carrying the host's message, not a hang. (Task 8.)

---

## File Structure

```
clients/windows/crates/tether-ssh/
  Cargo.toml
  src/lib.rs          re-exports: RusshTransport, RusshConnection, PtyChannel, PtyWriter, PtyEvent, ConnectionEvent, AgentConnector, NamedPipeAgent
  src/handler.rs      ClientHandler: host-key capture, rekey guard, drop events
  src/transport.rs    RusshTransport: dial (TCP_NODELAY, timeout), russh Config
  src/connection.rs   RusshConnection: Connection impl (authenticate, exec, keepalive), events, close
  src/agent.rs        AgentConnector trait, NamedPipeAgent (windows), io error mapping
  src/pty.rs          open_pty, PtyChannel, PtyWriter, reader task
  src/scp.rs          scp sink-mode client
  tests/support/mod.rs     pub mod server; pub mod proxy; helpers
  tests/support/server.rs  in-process russh server (auth, pty echo, exec, scp sink, agent-forward counter)
  tests/support/proxy.rs   freezable / killable TCP proxy
  tests/dial.rs  tests/auth.rs  tests/connect.rs  tests/agent.rs
  tests/exec.rs  tests/pty.rs   tests/keepalive.rs tests/scp.rs  tests/live.rs
```

Paths from core used here (M1/M2 contract): `tether_core::connect::{Transport, Connection, ConnectError, Credential, ConnectRequest, connect}`, `tether_core::resize::GridSize`, `tether_core::zmx::{shell_quote, kill_command}`, `tether_core::hostkey::{hex_fingerprint, MemoryHostKeys, HostKeyStore}`, `tether_core::secrets::{MemorySecretStore, SecretStore, key_account, password_account}`, `tether_core::profiles::{Machine, Auth}`, `tether_core::keys::generate_ed25519`. If M1/M2 also re-export these at the crate root, either path works.

---

### Task 1: Crate scaffold, `ClientHandler`, and `dial`

**Files:**
- Create: `crates/tether-ssh/Cargo.toml`, `src/lib.rs`, `src/handler.rs`, `src/transport.rs`, `src/connection.rs` (struct + `host_key_sha256` only), `src/agent.rs` (trait only)
- Create: `tests/support/mod.rs`, `tests/support/server.rs` (start + host key only), `tests/dial.rs`
- Modify: `clients/windows/Cargo.toml` — confirm `crates/tether-ssh` is a workspace member (M1 uses `members = ["crates/*"]`; add it explicitly if M1 listed members by name)

**Interfaces:**
- Consumes: `tether_core::connect::{Transport, Connection, ConnectError}`.
- Produces:
  - `pub struct RusshTransport { runtime: tokio::runtime::Handle, agent: Arc<dyn AgentConnector> }`
  - `impl RusshTransport { pub fn new(runtime: tokio::runtime::Handle) -> Self; pub fn with_agent(runtime: tokio::runtime::Handle, agent: Arc<dyn AgentConnector>) -> Self }`
  - `impl Transport for RusshTransport { type Conn = RusshConnection; … }`
  - `pub struct RusshConnection` with `fn host_key_sha256(&self) -> [u8; 32]`, `pub fn events(&self) -> broadcast::Receiver<ConnectionEvent>`
  - `#[derive(Clone, Copy, Debug, PartialEq, Eq)] pub enum ConnectionEvent { Dropped }`
  - `pub trait AgentConnector: Send + Sync { fn connect(&self) -> BoxFuture<'static, Result<AgentClient<AgentStreamBox>, ConnectError>>; }` and `pub type AgentStreamBox = Box<dyn AgentStream + Send + Unpin>;` (`AgentStream`, `AgentClient` from `russh::keys::agent::client`)

- [ ] **Step 1: Write `Cargo.toml`**

```toml
[package]
name = "tether-ssh"
version = "0.1.0"
edition = "2024"
license = "GPL-3.0-only"
publish = false

[dependencies]
tether-core = { path = "../tether-core" }
russh = { version = "=0.64.1", default-features = false, features = ["ring", "rsa", "flate2"] }
tokio = { version = "1", features = ["rt-multi-thread", "net", "time", "sync", "macros", "io-util"] }
futures = "0.3"
bytes = "1"
sha2 = "0.10"
zeroize = "1"
tracing = "0.1"

[dev-dependencies]
rand = { version = "0.10", features = ["thread_rng"] }
tempfile = "3"
uuid = { version = "1", features = ["v4"] }
tokio = { version = "1", features = ["rt-multi-thread", "net", "time", "sync", "macros", "io-util", "process"] }
```

- [ ] **Step 2: Write the failing handler unit tests** in `src/handler.rs`

```rust
use std::sync::{Arc, Mutex};

use russh::client::{self, DisconnectReason};
use russh::keys::{PublicKey, PublicKeyOrCertificate};
use sha2::{Digest, Sha256};
use tokio::sync::broadcast;

use crate::ConnectionEvent;

pub(crate) struct ClientHandler {
    pub(crate) host_key: Arc<Mutex<Option<[u8; 32]>>>,
    pub(crate) events: broadcast::Sender<ConnectionEvent>,
}

pub(crate) fn host_key_digest(key: &PublicKey) -> Option<[u8; 32]> {
    let blob = key.to_bytes().ok()?;
    Some(Sha256::digest(&blob).into())
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let Some(digest) = host_key_digest(&key.public_key()) else { return Ok(false) };
        let mut slot = self.host_key.lock().unwrap();
        match *slot {
            None => {
                *slot = Some(digest);
                Ok(true)
            }
            // Re-keys present the key again; core verified only the first one.
            Some(first) => Ok(first == digest),
        }
    }

    async fn disconnected(&mut self, reason: DisconnectReason<Self::Error>) -> Result<(), Self::Error> {
        let _ = self.events.send(ConnectionEvent::Dropped);
        match reason {
            DisconnectReason::ReceivedDisconnect(_) => Ok(()),
            DisconnectReason::Error(e) => Err(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh::client::Handler;
    use russh::keys::{PrivateKey, ssh_key::Algorithm};

    fn handler() -> ClientHandler {
        let (events, _) = broadcast::channel(4);
        ClientHandler { host_key: Arc::new(Mutex::new(None)), events }
    }

    fn key() -> PublicKey {
        PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap().public_key().clone()
    }

    #[tokio::test]
    async fn first_key_is_captured_and_accepted() {
        let mut h = handler();
        let k = key();
        assert!(h.check_server_key(&k.clone().into()).await.unwrap());
        let expected: [u8; 32] = Sha256::digest(k.to_bytes().unwrap()).into();
        assert_eq!(*h.host_key.lock().unwrap(), Some(expected));
    }

    #[tokio::test]
    async fn rekey_with_the_same_key_is_accepted() {
        let mut h = handler();
        let k = key();
        assert!(h.check_server_key(&k.clone().into()).await.unwrap());
        assert!(h.check_server_key(&k.into()).await.unwrap());
    }

    #[tokio::test]
    async fn rekey_with_a_different_key_is_refused() {
        let mut h = handler();
        assert!(h.check_server_key(&key().into()).await.unwrap());
        assert!(!h.check_server_key(&key().into()).await.unwrap());
    }
}
```

- [ ] **Step 3: Write `src/lib.rs`, the agent trait, and the transport**

`src/lib.rs`:

```rust
mod agent;
mod connection;
mod handler;
mod pty;
mod scp;
mod transport;

pub use agent::{AgentConnector, AgentStreamBox, NamedPipeAgent, map_agent_io_error};
pub use connection::{ConnectionEvent, RusshConnection};
pub use pty::{PtyChannel, PtyEvent, PtyWriter};
pub use transport::RusshTransport;
```

Create `src/pty.rs` and `src/scp.rs` empty for now (filled in Tasks 6 and 8), and in `src/agent.rs`:

```rust
use futures::future::BoxFuture;
use russh::keys::agent::client::{AgentClient, AgentStream};
use tether_core::connect::ConnectError;

pub type AgentStreamBox = Box<dyn AgentStream + Send + Unpin>;

pub trait AgentConnector: Send + Sync {
    fn connect(&self) -> BoxFuture<'static, Result<AgentClient<AgentStreamBox>, ConnectError>>;
}

/// The Windows OpenSSH agent (1Password serves this pipe too when enabled).
pub struct NamedPipeAgent {
    pub path: String,
}

impl Default for NamedPipeAgent {
    fn default() -> Self {
        Self { path: r"\\.\pipe\openssh-ssh-agent".to_string() }
    }
}

pub fn map_agent_io_error(_e: &std::io::Error) -> ConnectError {
    ConnectError::AgentNotRunning
}

impl AgentConnector for NamedPipeAgent {
    fn connect(&self) -> BoxFuture<'static, Result<AgentClient<AgentStreamBox>, ConnectError>> {
        #[cfg(windows)]
        {
            let path = self.path.clone();
            Box::pin(async move {
                AgentClient::connect_named_pipe(&path)
                    .await
                    .map(|c| c.dynamic())
                    .map_err(|_| ConnectError::AgentNotRunning)
            })
        }
        #[cfg(not(windows))]
        Box::pin(async { Err(ConnectError::AgentNotRunning) })
    }
}
```

(Task 4 refines `map_agent_io_error`; it is exported now so the signature is stable.)

`src/connection.rs` (first slice):

```rust
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use russh::client;
use tokio::sync::{RwLock, broadcast};

use crate::agent::AgentConnector;
use crate::handler::ClientHandler;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConnectionEvent {
    Dropped,
}

pub struct RusshConnection {
    pub(crate) handle: Arc<RwLock<client::Handle<ClientHandler>>>,
    pub(crate) host_key: [u8; 32],
    pub(crate) events: broadcast::Sender<ConnectionEvent>,
    pub(crate) runtime: tokio::runtime::Handle,
    pub(crate) agent: Arc<dyn AgentConnector>,
    pub(crate) dropped: Arc<AtomicBool>,
    pub(crate) keepalive: std::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl RusshConnection {
    pub fn events(&self) -> broadcast::Receiver<ConnectionEvent> {
        self.events.subscribe()
    }
}
```

`src/transport.rs`:

```rust
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::client;
use tether_core::connect::{ConnectError, Transport};
use tokio::net::TcpStream;
use tokio::sync::{RwLock, broadcast};

use crate::agent::{AgentConnector, NamedPipeAgent};
use crate::connection::RusshConnection;
use crate::handler::ClientHandler;

pub struct RusshTransport {
    runtime: tokio::runtime::Handle,
    agent: Arc<dyn AgentConnector>,
}

impl RusshTransport {
    pub fn new(runtime: tokio::runtime::Handle) -> Self {
        Self::with_agent(runtime, Arc::new(NamedPipeAgent::default()))
    }

    pub fn with_agent(runtime: tokio::runtime::Handle, agent: Arc<dyn AgentConnector>) -> Self {
        Self { runtime, agent }
    }

    fn config() -> Arc<client::Config> {
        // Keepalive is driven by RusshConnection::start_keepalive after auth, not by russh:
        // the spec arms it only once auth is done, and Config is fixed at connect time.
        Arc::new(client::Config {
            inactivity_timeout: None,
            keepalive_interval: None,
            nodelay: true,
            ..Default::default()
        })
    }
}

impl Transport for RusshTransport {
    type Conn = RusshConnection;

    async fn dial(&self, host: &str, port: u16, timeout: Duration) -> Result<RusshConnection, ConnectError> {
        let host_key = Arc::new(Mutex::new(None));
        let (events, _) = broadcast::channel(16);
        let handler = ClientHandler { host_key: host_key.clone(), events: events.clone() };
        let addr = format!("{host}:{port}");
        let handshake = async {
            let tcp = TcpStream::connect(&addr)
                .await
                .map_err(|e| ConnectError::Transport(e.to_string()))?;
            let _ = tcp.set_nodelay(true);
            // connect_stream returns only after KEX, so check_server_key has run.
            client::connect_stream(Self::config(), tcp, handler)
                .await
                .map_err(|e| ConnectError::Transport(e.to_string()))
        };
        let handle = tokio::time::timeout(timeout, handshake)
            .await
            .map_err(|_| ConnectError::Timeout)??;
        let digest = host_key
            .lock()
            .unwrap()
            .ok_or_else(|| ConnectError::Transport("the host sent no key".into()))?;
        Ok(RusshConnection {
            handle: Arc::new(RwLock::new(handle)),
            host_key: digest,
            events,
            runtime: self.runtime.clone(),
            agent: self.agent.clone(),
            dropped: Default::default(),
            keepalive: Default::default(),
        })
    }

    async fn sleep(&self, d: Duration) {
        tokio::time::sleep(d).await;
    }
}
```

Add a temporary `impl Connection for RusshConnection` in `connection.rs` whose `host_key_sha256` returns `self.host_key`, whose `authenticate` and `exec` return `Err(ConnectError::Transport("not yet".into()))`, and whose `start_keepalive` is empty — Tasks 2, 5, 7 replace each body. (This is scaffolding inside this task's own commit, removed by the task that owns each method.)

- [ ] **Step 4: Write the test server skeleton** `tests/support/server.rs`

```rust
use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::keys::{PrivateKey, PublicKey, ssh_key::Algorithm};
use russh::server::{self, Auth, Msg, Session};
use russh::{Channel, ChannelId};
use tokio::net::TcpListener;

#[derive(Default)]
pub struct Recorded {
    pub auth_attempts: usize,
    pub agent_forward_requests: usize,
    pub ptys: Vec<(u32, u32)>,
    pub window_changes: Vec<(u32, u32)>,
    pub input: HashMap<usize, Vec<u8>>,
    pub execs: Vec<String>,
    pub uploads: HashMap<String, Vec<u8>>,
}

#[derive(Default, Clone)]
pub struct Options {
    pub password: Option<(String, String)>,
    pub allowed_keys: Vec<PublicKey>,
}

pub struct Running {
    pub addr: SocketAddr,
    pub host_public: PublicKey,
    pub state: Arc<Mutex<Recorded>>,
    pub home: tempfile::TempDir,
}

#[derive(Clone)]
struct Shared {
    opts: Arc<Options>,
    state: Arc<Mutex<Recorded>>,
    home: PathBuf,
}

pub async fn start(opts: Options) -> Running {
    let key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
    let host_public = key.public_key().clone();
    let config = Arc::new(server::Config {
        inactivity_timeout: None,
        auth_rejection_time: Duration::from_millis(1),
        auth_rejection_time_initial: Some(Duration::from_millis(1)),
        keys: vec![key],
        ..Default::default()
    });
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let state = Arc::new(Mutex::new(Recorded::default()));
    let home = tempfile::tempdir().unwrap();
    let shared = Shared { opts: Arc::new(opts), state: state.clone(), home: home.path().to_path_buf() };
    tokio::spawn(async move {
        while let Ok((socket, _)) = listener.accept().await {
            let handler = ConnHandler { shared: shared.clone(), channels: HashMap::new(), order: Vec::new(), scp: HashMap::new() };
            let config = config.clone();
            tokio::spawn(async move {
                if let Ok(running) = server::run_stream(config, socket, handler).await {
                    let _ = running.await;
                }
            });
        }
    });
    Running { addr, host_public, state, home }
}

struct ConnHandler {
    shared: Shared,
    channels: HashMap<ChannelId, Channel<Msg>>,
    order: Vec<ChannelId>,
    scp: HashMap<ChannelId, super::server_scp::ScpSink>,
}

impl ConnHandler {
    fn index(&self, id: ChannelId) -> usize {
        self.order.iter().position(|c| *c == id).unwrap_or(usize::MAX)
    }
}

impl server::Handler for ConnHandler {
    type Error = russh::Error;

    async fn auth_none(&mut self, _user: &str) -> Result<Auth, Self::Error> {
        self.shared.state.lock().unwrap().auth_attempts += 1;
        Ok(Auth::reject())
    }

    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
        self.shared.state.lock().unwrap().auth_attempts += 1;
        let ok = self.shared.opts.password.as_ref().is_some_and(|(u, p)| u == user && p == password);
        Ok(if ok { Auth::Accept } else { Auth::reject() })
    }

    async fn auth_publickey_offered(&mut self, _user: &str, key: &PublicKey) -> Result<Auth, Self::Error> {
        self.shared.state.lock().unwrap().auth_attempts += 1;
        let ok = self.shared.opts.allowed_keys.iter().any(|k| k.key_data() == key.key_data());
        Ok(if ok { Auth::Accept } else { Auth::reject() })
    }

    async fn auth_publickey(&mut self, _user: &str, key: &PublicKey) -> Result<Auth, Self::Error> {
        let ok = self.shared.opts.allowed_keys.iter().any(|k| k.key_data() == key.key_data());
        Ok(if ok { Auth::Accept } else { Auth::reject() })
    }

    async fn channel_open_session(
        &mut self,
        channel: Channel<Msg>,
        reply: server::ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.order.push(channel.id());
        self.channels.insert(channel.id(), channel);
        reply.accept().await;
        Ok(())
    }

    async fn agent_request(&mut self, _channel: ChannelId, _session: &mut Session) -> Result<bool, Self::Error> {
        self.shared.state.lock().unwrap().agent_forward_requests += 1;
        Ok(false)
    }
}
```

Add `tests/support/server_scp.rs` with a stub `pub struct ScpSink;` (Task 8 fills it in) and `tests/support/mod.rs`:

```rust
#![allow(dead_code)]
pub mod proxy;
pub mod server;
pub mod server_scp;

use std::time::Duration;

pub const TIMEOUT: Duration = Duration::from_secs(10);

pub fn transport() -> tether_ssh::RusshTransport {
    tether_ssh::RusshTransport::new(tokio::runtime::Handle::current())
}
```

and an empty `tests/support/proxy.rs` (Task 7).

- [ ] **Step 5: Write the failing dial tests** `tests/dial.rs`

```rust
mod support;

use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};
use support::server::{Options, start};
use tether_core::connect::{ConnectError, Connection, Transport};

#[tokio::test]
async fn dial_captures_the_host_key_blob_digest() {
    let server = start(Options::default()).await;
    let conn = support::transport()
        .dial("127.0.0.1", server.addr.port(), support::TIMEOUT)
        .await
        .unwrap();
    let expected: [u8; 32] = Sha256::digest(server.host_public.to_bytes().unwrap()).into();
    assert_eq!(conn.host_key_sha256(), expected);
    assert_eq!(server.state.lock().unwrap().auth_attempts, 0, "dial must not authenticate");
}

#[tokio::test]
async fn a_listener_that_never_speaks_times_out() {
    let silent = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = silent.local_addr().unwrap().port();
    let _keep = tokio::spawn(async move {
        let mut held = Vec::new();
        while let Ok((s, _)) = silent.accept().await {
            held.push(s);
        }
    });
    let started = Instant::now();
    let err = support::transport()
        .dial("127.0.0.1", port, Duration::from_millis(300))
        .await
        .err()
        .unwrap();
    assert_eq!(err, ConnectError::Timeout);
    assert!(started.elapsed() < Duration::from_secs(2));
}

#[tokio::test]
async fn a_closed_port_is_a_transport_error() {
    let port = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };
    let err = support::transport().dial("127.0.0.1", port, support::TIMEOUT).await.err().unwrap();
    assert!(matches!(err, ConnectError::Transport(_)), "{err:?}");
}
```

(`ConnectError` derives `PartialEq, Debug` per M2; if it does not, use `matches!`.)

Add `sha2 = "0.10"` to `[dev-dependencies]` too (it is already a normal dependency, so tests can use it directly — no change needed).

- [ ] **Step 6: Run tests to verify they fail, then pass**

Run: `cargo test -p tether-ssh` — first run before Step 3's bodies exist fails to compile; with Steps 3–4 in place:
Expected: `first_key_is_captured_and_accepted`, `rekey_with_the_same_key_is_accepted`, `rekey_with_a_different_key_is_refused`, `dial_captures_the_host_key_blob_digest`, `a_listener_that_never_speaks_times_out`, `a_closed_port_is_a_transport_error` PASS.

- [ ] **Step 7: Lint and commit**

Run: `cargo fmt --check && cargo clippy -p tether-ssh --all-targets -- -D warnings`

```bash
git add clients/windows/crates/tether-ssh clients/windows/Cargo.toml
git commit -m "feat(windows): add tether-ssh dial with host-key capture

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Key and password authentication

**Files:**
- Modify: `crates/tether-ssh/src/connection.rs` (real `authenticate` for `Key` and `Password`)
- Create: `tests/auth.rs`

**Interfaces:**
- Consumes: `tether_core::connect::Credential::{Key, Password}` (`Zeroizing<String>`), `tether_core::keys::generate_ed25519(name, now) -> (KeyRecord, Zeroizing<String>)`.
- Produces: `Connection::authenticate` returning `Ok(())`, `Err(ConnectError::AuthRejected)` on a refused credential, `Err(ConnectError::Transport(detail))` for an unreadable key or a dead link.

- [ ] **Step 1: Write the failing tests** `tests/auth.rs`

```rust
mod support;

use russh::keys::{PrivateKey, ssh_key::{Algorithm, LineEnding}};
use support::server::{Options, start};
use tether_core::connect::{ConnectError, Connection, Credential, Transport};
use zeroize::Zeroizing;

async fn dial(port: u16) -> tether_ssh::RusshConnection {
    support::transport().dial("127.0.0.1", port, support::TIMEOUT).await.unwrap()
}

#[tokio::test]
async fn password_accepted() {
    let server = start(Options { password: Some(("tester".into(), "hunter2".into())), ..Default::default() }).await;
    let mut conn = dial(server.addr.port()).await;
    conn.authenticate("tester", Credential::Password(Zeroizing::new("hunter2".into()))).await.unwrap();
}

#[tokio::test]
async fn wrong_password_is_auth_rejected() {
    let server = start(Options { password: Some(("tester".into(), "hunter2".into())), ..Default::default() }).await;
    let mut conn = dial(server.addr.port()).await;
    let err = conn.authenticate("tester", Credential::Password(Zeroizing::new("nope".into()))).await.err().unwrap();
    assert_eq!(err, ConnectError::AuthRejected);
}

#[tokio::test]
async fn generated_ed25519_pkcs8_key_signs_in() {
    let (record, pem) = tether_core::keys::generate_ed25519("laptop", 0);
    let public = russh::keys::PublicKey::from_openssh(&record.public_line).unwrap();
    let server = start(Options { allowed_keys: vec![public], ..Default::default() }).await;
    let mut conn = dial(server.addr.port()).await;
    conn.authenticate("tester", Credential::Key(pem)).await.unwrap();
}

#[tokio::test]
async fn openssh_format_key_signs_in() {
    let key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
    let pem = Zeroizing::new(key.to_openssh(LineEnding::LF).unwrap().to_string());
    let server = start(Options { allowed_keys: vec![key.public_key().clone()], ..Default::default() }).await;
    let mut conn = dial(server.addr.port()).await;
    conn.authenticate("tester", Credential::Key(pem)).await.unwrap();
}

#[tokio::test]
async fn rsa_key_signs_in_with_sha2() {
    let key = PrivateKey::random(&mut rand::rng(), Algorithm::Rsa { hash: None }).unwrap();
    let pem = Zeroizing::new(key.to_openssh(LineEnding::LF).unwrap().to_string());
    let server = start(Options { allowed_keys: vec![key.public_key().clone()], ..Default::default() }).await;
    let mut conn = dial(server.addr.port()).await;
    conn.authenticate("tester", Credential::Key(pem)).await.unwrap();
}

#[tokio::test]
async fn unknown_key_is_auth_rejected() {
    let key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
    let pem = Zeroizing::new(key.to_openssh(LineEnding::LF).unwrap().to_string());
    let server = start(Options::default()).await;
    let mut conn = dial(server.addr.port()).await;
    let err = conn.authenticate("tester", Credential::Key(pem)).await.err().unwrap();
    assert_eq!(err, ConnectError::AuthRejected);
}

#[tokio::test]
async fn garbage_key_is_a_transport_error_not_a_panic() {
    let server = start(Options::default()).await;
    let mut conn = dial(server.addr.port()).await;
    let err = conn
        .authenticate("tester", Credential::Key(Zeroizing::new("-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n".into())))
        .await
        .err()
        .unwrap();
    assert!(matches!(err, ConnectError::Transport(_)), "{err:?}");
}
```

PKCS#1 RSA coverage (`BEGIN RSA PRIVATE KEY`) is parsed by `russh::keys::decode_secret_key`; M1's key-parsing tests own the format matrix, and this task proves that whatever PEM M1 accepted reaches russh unchanged.

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p tether-ssh --test auth`
Expected: FAIL — `authenticate` returns the Task 1 scaffold error.

- [ ] **Step 3: Implement `authenticate`** in `src/connection.rs` (replace the scaffold `impl Connection`; leave `exec` / `start_keepalive` scaffold bodies for Tasks 5 and 7; the `Agent` arm calls `crate::agent::authenticate_with_agent`, which Task 4 writes — until then it returns `Err(ConnectError::AgentNotRunning)` inline)

```rust
use std::sync::Arc;

use russh::client::AuthResult;
use russh::keys::{PrivateKeyWithHashAlg, decode_secret_key};
use tether_core::connect::{ConnectError, Connection, Credential};

fn transport(e: impl std::fmt::Display) -> ConnectError {
    ConnectError::Transport(e.to_string())
}

fn auth_outcome(result: AuthResult) -> Result<(), ConnectError> {
    if result.success() { Ok(()) } else { Err(ConnectError::AuthRejected) }
}

impl Connection for RusshConnection {
    fn host_key_sha256(&self) -> [u8; 32] {
        self.host_key
    }

    async fn authenticate(&mut self, user: &str, cred: Credential) -> Result<(), ConnectError> {
        let mut handle = self.handle.write().await;
        match cred {
            Credential::Password(password) => {
                let result = handle.authenticate_password(user, password.as_str()).await.map_err(transport)?;
                auth_outcome(result)
            }
            Credential::Key(pem) => {
                let key = decode_secret_key(pem.as_str(), None).map_err(transport)?;
                let hash = if key.algorithm().is_rsa() {
                    handle.best_supported_rsa_hash().await.map_err(transport)?.flatten()
                } else {
                    None
                };
                let result = handle
                    .authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(key), hash))
                    .await
                    .map_err(transport)?;
                auth_outcome(result)
            }
            Credential::Agent => crate::agent::authenticate_with_agent(&mut handle, user, &*self.agent).await,
        }
    }

    // exec, start_keepalive: Task 1 scaffold until Tasks 5 and 7.
}
```

The `PrivateKey` lives in an `Arc` only for the duration of this call and is dropped when it returns; the PEM `Zeroizing<String>` is wiped on drop. Nothing is stored on `self`.

- [ ] **Step 4: Run tests**

Run: `cargo test -p tether-ssh --test auth`
Expected: 7 PASS.

- [ ] **Step 5: Commit**

```bash
git add clients/windows/crates/tether-ssh
git commit -m "feat(windows): authenticate by vault key or password over russh

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Core's connection sequence end-to-end (pin before auth, refuse on mismatch)

**Files:**
- Create: `tests/connect.rs`

**Interfaces:**
- Consumes: `tether_core::connect::{connect, ConnectRequest, ConnectError}`, `tether_core::hostkey::{MemoryHostKeys, HostKeyStore, hex_fingerprint}`, `tether_core::secrets::{MemorySecretStore, SecretStore, password_account}`, `tether_core::profiles::{Machine, Auth}`.
- Produces: no new API — this task proves the M2 sequence and the M3 transport compose: the digest `dial` returns is what core pins, and core's mismatch path closes before any auth packet.

- [ ] **Step 1: Write the tests** `tests/connect.rs`

```rust
mod support;

use sha2::{Digest, Sha256};
use support::server::{Options, start};
use tether_core::connect::{ConnectError, ConnectRequest, connect};
use tether_core::hostkey::{HostKeyStore, MemoryHostKeys, hex_fingerprint};
use tether_core::profiles::{Auth, Machine};
use tether_core::secrets::{MemorySecretStore, SecretStore, password_account};
use uuid::Uuid;

fn machine(port: u16) -> Machine {
    Machine {
        id: Uuid::new_v4(),
        name: "devbox".into(),
        host: "127.0.0.1".into(),
        port,
        user: "tester".into(),
        auth: Auth::Password,
    }
}

async fn password_server() -> support::server::Running {
    start(Options { password: Some(("tester".into(), "hunter2".into())), ..Default::default() }).await
}

#[tokio::test]
async fn first_connect_pins_the_hex_fingerprint() {
    let server = password_server().await;
    let m = machine(server.addr.port());
    let secrets = MemorySecretStore::default();
    secrets.set(&password_account(m.id), b"hunter2").unwrap();
    let pins = MemoryHostKeys::default();

    connect(&support::transport(), &ConnectRequest { machine: m.clone() }, &pins, &secrets).await.unwrap();

    let digest: [u8; 32] = Sha256::digest(server.host_public.to_bytes().unwrap()).into();
    assert_eq!(pins.pinned("127.0.0.1", m.port), Some(hex_fingerprint(&digest)));
}

#[tokio::test]
async fn mismatch_is_refused_before_any_auth_packet() {
    let server = password_server().await;
    let m = machine(server.addr.port());
    let secrets = MemorySecretStore::default();
    secrets.set(&password_account(m.id), b"hunter2").unwrap();
    let pins = MemoryHostKeys::default();
    let wrong = hex_fingerprint(&[0xaa; 32]);
    pins.pin("127.0.0.1", m.port, &wrong);

    let err = connect(&support::transport(), &ConnectRequest { machine: m.clone() }, &pins, &secrets)
        .await
        .err()
        .unwrap();

    assert!(matches!(err, ConnectError::HostKeyChanged { ref expected, .. } if *expected == wrong), "{err:?}");
    assert_eq!(server.state.lock().unwrap().auth_attempts, 0);
    assert_eq!(pins.pinned("127.0.0.1", m.port), Some(wrong), "a mismatch never rewrites the pin");
}

#[tokio::test]
async fn agent_forwarding_is_never_requested() {
    let server = password_server().await;
    let m = machine(server.addr.port());
    let secrets = MemorySecretStore::default();
    secrets.set(&password_account(m.id), b"hunter2").unwrap();
    let conn = connect(&support::transport(), &ConnectRequest { machine: m }, &MemoryHostKeys::default(), &secrets)
        .await
        .unwrap();
    let pty = conn.open_pty(tether_core::resize::GridSize { cols: 80, rows: 24, width_px: 640, height_px: 384 }).await.unwrap();
    drop(pty);
    assert_eq!(server.state.lock().unwrap().agent_forward_requests, 0);
}
```

(`agent_forwarding_is_never_requested` depends on `open_pty` from Task 6; mark it `#[ignore = "needs Task 6"]` now and remove the attribute in Task 6 Step 4.)

- [ ] **Step 2: Run**

Run: `cargo test -p tether-ssh --test connect`
Expected: `first_connect_pins_the_hex_fingerprint` and `mismatch_is_refused_before_any_auth_packet` PASS (they exercise M2's `connect` with the real transport). If `mismatch_…` fails on `auth_attempts`, the bug is in core's ordering (M2), not here — fix it there; do not work around it in `tether-ssh`.

- [ ] **Step 3: Commit**

```bash
git add clients/windows/crates/tether-ssh/tests/connect.rs
git commit -m "test(windows): pin before auth and refuse a changed host key over russh

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: SSH agent authentication (Windows OpenSSH agent pipe)

**Files:**
- Modify: `crates/tether-ssh/src/agent.rs` (add `authenticate_with_agent`, refine `map_agent_io_error`)
- Modify: `crates/tether-ssh/src/connection.rs` (the `Agent` arm now calls it — already wired in Task 2)
- Create: `tests/agent.rs`

**Interfaces:**
- Consumes: `AgentConnector`, `russh::keys::agent::client::AgentClient`, `russh::keys::agent::AgentIdentity`.
- Produces:
  - `pub(crate) async fn authenticate_with_agent(handle: &mut client::Handle<ClientHandler>, user: &str, agent: &dyn AgentConnector) -> Result<(), ConnectError>`
  - `pub fn map_agent_io_error(e: &std::io::Error) -> ConnectError` — `NotFound` (Win32 `ERROR_FILE_NOT_FOUND`, the pipe does not exist because the service is stopped) and `ConnectionRefused` → `AgentNotRunning`; anything else → `Transport("SSH agent: <e>")`.

Errors: no identities, or every identity refused → `AgentNoKey` ("The SSH agent has no key this host accepts."). Agent unreachable → `AgentNotRunning`. Certificate identities are skipped (certificate auth is not in v1).

- [ ] **Step 1: Write the failing tests** `tests/agent.rs`

```rust
mod support;

use std::sync::Arc;

use futures::future::BoxFuture;
use russh::keys::agent::client::AgentClient;
use russh::keys::{PrivateKey, ssh_key::Algorithm};
use support::server::{Options, start};
use tether_core::connect::{ConnectError, Connection, Credential, Transport};
use tether_ssh::{AgentConnector, AgentStreamBox, RusshTransport, map_agent_io_error};

/// An in-memory agent: russh's agent server on one end of a duplex pipe.
struct FakeAgent {
    keys: Vec<PrivateKey>,
}

impl AgentConnector for FakeAgent {
    fn connect(&self) -> BoxFuture<'static, Result<AgentClient<AgentStreamBox>, ConnectError>> {
        let keys = self.keys.clone();
        Box::pin(async move {
            let (client_end, server_end) = tokio::io::duplex(64 * 1024);
            tokio::spawn(russh::keys::agent::server::serve(
                futures::stream::iter(vec![Ok::<_, std::io::Error>(server_end)]),
                (),
            ));
            let mut client = AgentClient::connect(client_end).dynamic();
            for k in &keys {
                client.add_identity(k, &[]).await.unwrap();
            }
            Ok(client)
        })
    }
}

struct DeadAgent;
impl AgentConnector for DeadAgent {
    fn connect(&self) -> BoxFuture<'static, Result<AgentClient<AgentStreamBox>, ConnectError>> {
        Box::pin(async { Err(ConnectError::AgentNotRunning) })
    }
}

fn transport(agent: impl AgentConnector + 'static) -> RusshTransport {
    RusshTransport::with_agent(tokio::runtime::Handle::current(), Arc::new(agent))
}

fn key() -> PrivateKey {
    PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap()
}

#[tokio::test]
async fn agent_key_the_host_accepts_signs_in() {
    let accepted = key();
    let server = start(Options { allowed_keys: vec![accepted.public_key().clone()], ..Default::default() }).await;
    let t = transport(FakeAgent { keys: vec![key(), accepted] });
    let mut conn = t.dial("127.0.0.1", server.addr.port(), support::TIMEOUT).await.unwrap();
    conn.authenticate("tester", Credential::Agent).await.unwrap();
}

#[tokio::test]
async fn agent_without_an_accepted_key_is_agent_no_key() {
    let server = start(Options { allowed_keys: vec![key().public_key().clone()], ..Default::default() }).await;
    let t = transport(FakeAgent { keys: vec![key()] });
    let mut conn = t.dial("127.0.0.1", server.addr.port(), support::TIMEOUT).await.unwrap();
    assert_eq!(conn.authenticate("tester", Credential::Agent).await.err(), Some(ConnectError::AgentNoKey));
}

#[tokio::test]
async fn empty_agent_is_agent_no_key() {
    let server = start(Options::default()).await;
    let t = transport(FakeAgent { keys: vec![] });
    let mut conn = t.dial("127.0.0.1", server.addr.port(), support::TIMEOUT).await.unwrap();
    assert_eq!(conn.authenticate("tester", Credential::Agent).await.err(), Some(ConnectError::AgentNoKey));
}

#[tokio::test]
async fn unreachable_agent_is_agent_not_running() {
    let server = start(Options::default()).await;
    let t = transport(DeadAgent);
    let mut conn = t.dial("127.0.0.1", server.addr.port(), support::TIMEOUT).await.unwrap();
    assert_eq!(conn.authenticate("tester", Credential::Agent).await.err(), Some(ConnectError::AgentNotRunning));
}

#[test]
fn missing_pipe_maps_to_agent_not_running() {
    let e = std::io::Error::from(std::io::ErrorKind::NotFound);
    assert_eq!(map_agent_io_error(&e), ConnectError::AgentNotRunning);
    let other = std::io::Error::other("boom");
    assert!(matches!(map_agent_io_error(&other), ConnectError::Transport(_)));
}

#[cfg(windows)]
#[tokio::test]
async fn named_pipe_agent_signs_in() {
    use tokio::net::windows::named_pipe::ServerOptions;
    let accepted = key();
    let name = format!(r"\\.\pipe\tether-test-agent-{}", uuid::Uuid::new_v4());
    let pipe = ServerOptions::new().first_pipe_instance(true).create(&name).unwrap();
    tokio::spawn(async move {
        pipe.connect().await.unwrap();
        russh::keys::agent::server::serve(futures::stream::iter(vec![Ok::<_, std::io::Error>(pipe)]), ()).await
    });
    let agent = tether_ssh::NamedPipeAgent { path: name };
    let mut c = agent.connect().await.unwrap();
    c.add_identity(&accepted, &[]).await.unwrap();
    let ids = c.request_identities().await.unwrap();
    assert_eq!(ids.len(), 1);
    assert_eq!(ids[0].public_key().key_data(), accepted.public_key().key_data());
    // Signing over the real OpenSSH agent pipe is covered by the live test (TETHER_LIVE_AGENT=1).
}

#[cfg(windows)]
#[tokio::test]
async fn missing_named_pipe_is_agent_not_running() {
    let agent = tether_ssh::NamedPipeAgent { path: format!(r"\\.\pipe\tether-missing-{}", uuid::Uuid::new_v4()) };
    assert_eq!(agent.connect().await.err(), Some(ConnectError::AgentNotRunning));
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p tether-ssh --test agent`
Expected: FAIL — `authenticate_with_agent` missing / `map_agent_io_error` returns `AgentNotRunning` for `other`.

- [ ] **Step 3: Implement** in `src/agent.rs`

```rust
use russh::client;
use russh::keys::agent::AgentIdentity;

use crate::handler::ClientHandler;

pub fn map_agent_io_error(e: &std::io::Error) -> ConnectError {
    match e.kind() {
        std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused => ConnectError::AgentNotRunning,
        _ => ConnectError::Transport(format!("SSH agent: {e}")),
    }
}

pub(crate) async fn authenticate_with_agent(
    handle: &mut client::Handle<ClientHandler>,
    user: &str,
    connector: &dyn AgentConnector,
) -> Result<(), ConnectError> {
    let mut agent = connector.connect().await?;
    let identities = agent
        .request_identities()
        .await
        .map_err(|e| ConnectError::Transport(format!("SSH agent: {e}")))?;
    for identity in identities {
        let AgentIdentity::PublicKey { key, .. } = identity else { continue };
        let hash = if key.algorithm().is_rsa() {
            handle.best_supported_rsa_hash().await.ok().flatten().flatten()
        } else {
            None
        };
        match handle.authenticate_publickey_with(user, key, hash, &mut agent).await {
            Ok(result) if result.success() => return Ok(()),
            Ok(_) => continue,
            Err(e) => return Err(ConnectError::Transport(format!("SSH agent: {e}"))),
        }
    }
    Err(ConnectError::AgentNoKey)
}
```

And change `NamedPipeAgent::connect`'s Windows arm to map the error through the helper:

```rust
AgentClient::connect_named_pipe(&path)
    .await
    .map(|c| c.dynamic())
    .map_err(|e| match e {
        russh::keys::Error::IO(io) => map_agent_io_error(&io),
        other => ConnectError::Transport(format!("SSH agent: {other}")),
    })
```

(`russh::keys::Error::IO(std::io::Error)` is the variant `connect_named_pipe` returns via `e.into()`; confirm the variant name with `cargo doc -p russh --open` → `keys::Error` and adjust the pattern if it is spelled differently.)

- [ ] **Step 4: Run tests**

Run: `cargo test -p tether-ssh --test agent`
Expected: Linux — 5 PASS; Windows — 7 PASS.

- [ ] **Step 5: Commit**

```bash
git add clients/windows/crates/tether-ssh
git commit -m "feat(windows): sign in through the Windows OpenSSH agent pipe

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: One-off `exec` (stdout only, quoting-safe)

**Files:**
- Modify: `crates/tether-ssh/src/connection.rs` (real `exec`)
- Modify: `tests/support/server.rs` (add `exec_request`)
- Create: `tests/exec.rs`

**Interfaces:**
- Produces: `Connection::exec(&self, command) -> Result<String, ConnectError>` — opens a fresh session channel, returns stdout decoded lossily as UTF-8 **regardless of exit status** (iOS `LibSSH2Ops.exec` does the same; callers like `uploads_directory` validate the output themselves). stderr is read and discarded so it cannot fill the channel window.

- [ ] **Step 1: Add `exec_request` to the test server** (`impl server::Handler for ConnHandler`)

```rust
async fn exec_request(&mut self, channel: ChannelId, data: &[u8], session: &mut Session) -> Result<(), Self::Error> {
    let command = String::from_utf8_lossy(data).into_owned();
    self.shared.state.lock().unwrap().execs.push(command.clone());
    session.channel_success(channel)?;
    let handle = session.handle();
    if let Some(target) = command.strip_prefix("scp -t ") {
        self.scp.insert(channel, super::server_scp::ScpSink::new(super::server_scp::unquote(target)));
        let _ = handle.data(channel, vec![0u8]).await;
        return Ok(());
    }
    if let Some(rest) = command.strip_prefix("tether-echo ") {
        let out = format!("{rest}\n");
        tokio::spawn(async move {
            let _ = handle.extended_data(channel, 1, b"noise on stderr\n".to_vec()).await;
            let _ = handle.data(channel, out.into_bytes()).await;
            let _ = handle.exit_status_request(channel, 3).await;
            let _ = handle.eof(channel).await;
            let _ = handle.close(channel).await;
        });
        return Ok(());
    }
    let home = self.shared.home.clone();
    tokio::spawn(async move {
        #[cfg(unix)]
        let (stdout, code) = match tokio::process::Command::new("sh").arg("-c").arg(&command).env("HOME", &home).output().await {
            Ok(out) => (out.stdout, out.status.code().unwrap_or(1) as u32),
            Err(_) => (Vec::new(), 127),
        };
        #[cfg(not(unix))]
        let (stdout, code) = { let _ = (&command, &home); (Vec::new(), 127u32) };
        let _ = handle.data(channel, stdout).await;
        let _ = handle.exit_status_request(channel, code).await;
        let _ = handle.eof(channel).await;
        let _ = handle.close(channel).await;
    });
    Ok(())
}
```

`server_scp::unquote` and `ScpSink::new` are added as stubs now (`pub fn unquote(s: &str) -> String { s.to_string() }`, `impl ScpSink { pub fn new(_t: String) -> Self { ScpSink } }`) and replaced in Task 8.

- [ ] **Step 2: Write the failing tests** `tests/exec.rs`

```rust
mod support;

use support::server::{Options, start};
use tether_core::connect::{Connection, Credential, Transport};
use zeroize::Zeroizing;

async fn signed_in() -> (support::server::Running, tether_ssh::RusshConnection) {
    let server = start(Options { password: Some(("tester".into(), "hunter2".into())), ..Default::default() }).await;
    let mut conn = support::transport().dial("127.0.0.1", server.addr.port(), support::TIMEOUT).await.unwrap();
    conn.authenticate("tester", Credential::Password(Zeroizing::new("hunter2".into()))).await.unwrap();
    (server, conn)
}

#[tokio::test]
async fn exec_returns_stdout_and_drops_stderr_even_on_nonzero_exit() {
    let (_server, conn) = signed_in().await;
    assert_eq!(conn.exec("tether-echo hello there").await.unwrap(), "hello there\n");
}

#[tokio::test]
async fn concurrent_execs_on_one_connection_do_not_mix() {
    let (_server, conn) = signed_in().await;
    let (a, b) = tokio::join!(conn.exec("tether-echo a"), conn.exec("tether-echo b"));
    assert_eq!(a.unwrap(), "a\n");
    assert_eq!(b.unwrap(), "b\n");
}

#[cfg(unix)]
#[tokio::test]
async fn hostile_names_reach_zmx_as_one_argument() {
    let (server, conn) = signed_in().await;
    let bin = server.home.path().join(".local/bin");
    std::fs::create_dir_all(&bin).unwrap();
    let zmx = bin.join("zmx");
    std::fs::write(&zmx, "#!/bin/sh\nprintf '<%s>\\n' \"$@\"\n").unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&zmx, std::fs::Permissions::from_mode(0o755)).unwrap();

    for name in ["it's", "a b", "$(touch pwned)", "`touch pwned`", ";touch pwned", "ünï", "--force"] {
        let out = conn.exec(&tether_core::zmx::kill_command(name)).await.unwrap();
        assert_eq!(out, format!("<kill>\n<{name}>\n<--force>\n"), "name {name:?}");
    }
    assert!(!server.home.path().join("pwned").exists());
    assert!(!std::path::Path::new("pwned").exists());
}
```

- [ ] **Step 3: Run to verify failure**

Run: `cargo test -p tether-ssh --test exec`
Expected: FAIL — scaffold `exec` returns an error.

- [ ] **Step 4: Implement `exec`** (replace the scaffold body)

```rust
async fn exec(&self, command: &str) -> Result<String, ConnectError> {
    let mut channel = {
        let handle = self.handle.read().await;
        handle.channel_open_session().await.map_err(transport)?
    };
    channel.exec(true, command).await.map_err(transport)?;
    let mut stdout = Vec::new();
    while let Some(msg) = channel.wait().await {
        match msg {
            russh::ChannelMsg::Data { data } => stdout.extend_from_slice(&data),
            russh::ChannelMsg::Failure => return Err(ConnectError::Transport("the host refused the command".into())),
            russh::ChannelMsg::Close => break,
            _ => {}
        }
    }
    Ok(String::from_utf8_lossy(&stdout).into_owned())
}
```

The read lock is released before waiting on output, so a long exec never blocks `open_pty` or another exec.

- [ ] **Step 5: Run tests**

Run: `cargo test -p tether-ssh --test exec`
Expected: Linux 3 PASS; Windows 2 PASS (the hostile-name test is unix-only; CI's Linux job runs it).

- [ ] **Step 6: Commit**

```bash
git add clients/windows/crates/tether-ssh
git commit -m "feat(windows): run one-off execs on their own channel

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: PTY channels — many per connection

**Files:**
- Modify: `crates/tether-ssh/src/pty.rs`
- Modify: `tests/support/server.rs` (add `pty_request`, `shell_request`, `window_change_request`, `data`)
- Create: `tests/pty.rs`
- Modify: `tests/connect.rs` (remove `#[ignore]` from `agent_forwarding_is_never_requested`)

**Interfaces:**
- Consumes: `tether_core::resize::GridSize { cols: u16, rows: u16, width_px: u32, height_px: u32 }`.
- Produces:
  - `impl RusshConnection { pub async fn open_pty(&self, size: GridSize) -> Result<PtyChannel, ConnectError> }`
  - `pub struct PtyChannel { pub writer: PtyWriter, pub events: tokio::sync::mpsc::Receiver<PtyEvent> }`
  - `#[derive(Clone)] pub struct PtyWriter` with `pub async fn write(&self, bytes: &[u8])`, `pub async fn resize(&self, size: GridSize)`, `pub async fn close(&self)` — failures are logged with `tracing::debug!` and otherwise ignored: a dead link is reported once through `ConnectionEvent::Dropped`, and input during reconnect is dropped by design.
  - `#[derive(Debug, Clone, PartialEq, Eq)] pub enum PtyEvent { Data(Vec<u8>), Closed }`
  - `pub const PTY_TERM: &str = "xterm-256color";`

Sequence (spec Connect steps 7–8 minus the attach, which M6 types through `writer.write(attach_command(name).as_bytes())`): open session → `request_pty(true, "xterm-256color", cols, rows, w, h, &[])` → wait for `Success` → `request_shell(true)` → wait for `Success` → `window_change(size)` ("push the current size") → spawn the reader.

- [ ] **Step 1: Add PTY behavior to the test server**

```rust
async fn pty_request(
    &mut self, channel: ChannelId, _term: &str, cols: u32, rows: u32, _pw: u32, _ph: u32,
    _modes: &[(russh::Pty, u32)], session: &mut Session,
) -> Result<(), Self::Error> {
    self.shared.state.lock().unwrap().ptys.push((cols, rows));
    session.channel_success(channel)?;
    Ok(())
}

async fn shell_request(&mut self, channel: ChannelId, session: &mut Session) -> Result<(), Self::Error> {
    session.channel_success(channel)?;
    session.data(channel, format!("ready {}\r\n", self.index(channel)).into_bytes())?;
    Ok(())
}

async fn window_change_request(
    &mut self, _channel: ChannelId, cols: u32, rows: u32, _pw: u32, _ph: u32, _session: &mut Session,
) -> Result<(), Self::Error> {
    self.shared.state.lock().unwrap().window_changes.push((cols, rows));
    Ok(())
}

async fn data(&mut self, channel: ChannelId, data: &[u8], session: &mut Session) -> Result<(), Self::Error> {
    if let Some(sink) = self.scp.get_mut(&channel) {
        sink.feed(channel, data, session, &self.shared.state);
        return Ok(());
    }
    let idx = self.index(channel);
    self.shared.state.lock().unwrap().input.entry(idx).or_default().extend_from_slice(data);
    session.data(channel, format!("<{idx}>{}", String::from_utf8_lossy(data)).into_bytes())?;
    Ok(())
}
```

(`ScpSink::feed` stub: `pub fn feed(&mut self, _c: ChannelId, _d: &[u8], _s: &mut Session, _st: &Arc<Mutex<Recorded>>) {}` until Task 8.)

- [ ] **Step 2: Write the failing tests** `tests/pty.rs`

```rust
mod support;

use std::time::Duration;

use support::server::{Options, start};
use tether_core::connect::{Connection, Credential, Transport};
use tether_core::resize::GridSize;
use tether_ssh::PtyEvent;
use tokio::sync::mpsc::Receiver;
use zeroize::Zeroizing;

const SIZE: GridSize = GridSize { cols: 120, rows: 40, width_px: 960, height_px: 640 };

async fn signed_in() -> (support::server::Running, tether_ssh::RusshConnection) {
    let server = start(Options { password: Some(("tester".into(), "hunter2".into())), ..Default::default() }).await;
    let mut conn = support::transport().dial("127.0.0.1", server.addr.port(), support::TIMEOUT).await.unwrap();
    conn.authenticate("tester", Credential::Password(Zeroizing::new("hunter2".into()))).await.unwrap();
    (server, conn)
}

async fn read_until(events: &mut Receiver<PtyEvent>, needle: &str) -> String {
    let mut seen = String::new();
    tokio::time::timeout(Duration::from_secs(5), async {
        while !seen.contains(needle) {
            match events.recv().await {
                Some(PtyEvent::Data(d)) => seen.push_str(&String::from_utf8_lossy(&d)),
                other => panic!("unexpected {other:?} after {seen:?}"),
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("never saw {needle:?}; got {seen:?}"));
    seen
}

#[tokio::test]
async fn pty_is_requested_at_the_grid_size_then_the_size_is_pushed() {
    let (server, conn) = signed_in().await;
    let mut pty = conn.open_pty(SIZE).await.unwrap();
    read_until(&mut pty.events, "ready 0").await;
    let state = server.state.lock().unwrap();
    assert_eq!(state.ptys, vec![(120, 40)]);
    assert_eq!(state.window_changes, vec![(120, 40)]);
}

#[tokio::test]
async fn two_channels_on_one_connection_keep_their_own_data() {
    let (_server, conn) = signed_in().await;
    let mut a = conn.open_pty(SIZE).await.unwrap();
    let mut b = conn.open_pty(SIZE).await.unwrap();
    read_until(&mut a.events, "ready 0").await;
    read_until(&mut b.events, "ready 1").await;
    a.writer.write(b"alpha").await;
    b.writer.write(b"beta").await;
    assert!(read_until(&mut a.events, "<0>alpha").await.contains("<0>alpha"));
    let got_b = read_until(&mut b.events, "<1>beta").await;
    assert!(!got_b.contains("alpha"));
}

#[tokio::test]
async fn resize_sends_a_window_change() {
    let (server, conn) = signed_in().await;
    let mut pty = conn.open_pty(SIZE).await.unwrap();
    read_until(&mut pty.events, "ready").await;
    pty.writer.resize(GridSize { cols: 100, rows: 30, width_px: 800, height_px: 480 }).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(server.state.lock().unwrap().window_changes.last(), Some(&(100, 30)));
}

#[tokio::test]
async fn close_ends_the_event_stream_with_closed() {
    let (_server, conn) = signed_in().await;
    let mut pty = conn.open_pty(SIZE).await.unwrap();
    read_until(&mut pty.events, "ready").await;
    pty.writer.close().await;
    let last = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match pty.events.recv().await {
                Some(PtyEvent::Data(_)) => continue,
                other => return other,
            }
        }
    })
    .await
    .unwrap();
    assert!(matches!(last, Some(PtyEvent::Closed) | None));
}

#[tokio::test]
async fn slow_reader_does_not_stall_other_channel() {
    let (_server, conn) = signed_in().await;
    let idle = conn.open_pty(SIZE).await.unwrap(); // never read
    let mut busy = conn.open_pty(SIZE).await.unwrap();
    for _ in 0..200 {
        idle.writer.write(&[b'x'; 512]).await;
    }
    busy.writer.write(b"still-alive").await;
    read_until(&mut busy.events, "still-alive").await;
    drop(idle);
}

#[tokio::test]
async fn a_cloned_writer_writes_to_the_same_channel() {
    let (_server, conn) = signed_in().await;
    let mut pty = conn.open_pty(SIZE).await.unwrap();
    read_until(&mut pty.events, "ready").await;
    let clone = pty.writer.clone();
    clone.write(b"via-clone").await;
    read_until(&mut pty.events, "<0>via-clone").await;
}
```

- [ ] **Step 3: Run to verify failure**

Run: `cargo test -p tether-ssh --test pty`
Expected: FAIL — `open_pty` not defined.

- [ ] **Step 4: Implement** `src/pty.rs`

```rust
use std::sync::Arc;

use bytes::Bytes;
use russh::{ChannelMsg, ChannelReadHalf, ChannelWriteHalf, client};
use tether_core::connect::ConnectError;
use tether_core::resize::GridSize;
use tokio::sync::mpsc;

use crate::connection::RusshConnection;

pub const PTY_TERM: &str = "xterm-256color";
// Deep enough that a busy background tab never back-pressures russh's shared session loop.
const EVENTS_CAPACITY: usize = 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PtyEvent {
    Data(Vec<u8>),
    Closed,
}

pub struct PtyChannel {
    pub writer: PtyWriter,
    pub events: mpsc::Receiver<PtyEvent>,
}

#[derive(Clone)]
pub struct PtyWriter {
    half: Arc<ChannelWriteHalf<client::Msg>>,
}

impl PtyWriter {
    pub async fn write(&self, bytes: &[u8]) {
        if let Err(e) = self.half.data_bytes(Bytes::copy_from_slice(bytes)).await {
            tracing::debug!("pty write dropped: {e}");
        }
    }

    pub async fn resize(&self, size: GridSize) {
        let r = self.half.window_change(size.cols.into(), size.rows.into(), size.width_px, size.height_px).await;
        if let Err(e) = r {
            tracing::debug!("pty resize dropped: {e}");
        }
    }

    pub async fn close(&self) {
        let _ = self.half.eof().await;
        let _ = self.half.close().await;
    }
}

async fn expect_success(read: &mut ChannelReadHalf, what: &str) -> Result<(), ConnectError> {
    loop {
        match read.wait().await {
            Some(ChannelMsg::Success) => return Ok(()),
            Some(ChannelMsg::Failure) => return Err(ConnectError::Transport(format!("the host refused the {what}"))),
            Some(_) => continue,
            None => return Err(ConnectError::Transport("the channel closed".into())),
        }
    }
}

impl RusshConnection {
    pub async fn open_pty(&self, size: GridSize) -> Result<PtyChannel, ConnectError> {
        let channel = {
            let handle = self.handle.read().await;
            handle.channel_open_session().await.map_err(|e| ConnectError::Transport(e.to_string()))?
        };
        let (mut read, write) = channel.split();
        let t = |e: russh::Error| ConnectError::Transport(e.to_string());
        write
            .request_pty(true, PTY_TERM, size.cols.into(), size.rows.into(), size.width_px, size.height_px, &[])
            .await
            .map_err(t)?;
        expect_success(&mut read, "terminal").await?;
        write.request_shell(true).await.map_err(t)?;
        expect_success(&mut read, "shell").await?;
        write
            .window_change(size.cols.into(), size.rows.into(), size.width_px, size.height_px)
            .await
            .map_err(t)?;

        let (tx, rx) = mpsc::channel(EVENTS_CAPACITY);
        self.runtime.spawn(async move {
            while let Some(msg) = read.wait().await {
                match msg {
                    ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                        if tx.send(PtyEvent::Data(data.to_vec())).await.is_err() {
                            return;
                        }
                    }
                    ChannelMsg::Close => break,
                    _ => {}
                }
            }
            let _ = tx.send(PtyEvent::Closed).await;
        });
        Ok(PtyChannel { writer: PtyWriter { half: Arc::new(write) }, events: rx })
    }
}
```

`slow_reader_does_not_stall_other_channel` passes because the idle channel's reader task keeps draining russh into a 1024-deep queue (200 echoes fit); M6's per-tab task must likewise always drain `events` into its `TabTerminal`, never pause reading for a background tab. Note that in M6's Interfaces.

- [ ] **Step 5: Un-ignore** `agent_forwarding_is_never_requested` in `tests/connect.rs`.

- [ ] **Step 6: Run tests**

Run: `cargo test -p tether-ssh --test pty --test connect`
Expected: 6 + 3 PASS.

- [ ] **Step 7: Commit**

```bash
git add clients/windows/crates/tether-ssh
git commit -m "feat(windows): carry one PTY channel per tab on a shared connection

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Keepalive after auth, drop detection, close

**Files:**
- Modify: `crates/tether-ssh/src/connection.rs` (`start_keepalive`, watcher, `is_closed`, `close`, `Drop`)
- Create: `tests/support/proxy.rs`, `tests/keepalive.rs`

**Interfaces:**
- Produces:
  - `Connection::start_keepalive(&mut self, every: Duration)` — spawns a task that every `every` sends `Handle::send_ping()` (keepalive@openssh.com with want-reply, resolves on the reply) under `tokio::time::timeout(every, …)`; two consecutive misses → `ConnectionEvent::Dropped` and disconnect. Calling it again replaces the previous task.
  - A watcher task (spawned in `start_keepalive`, and also by `dial`) polls `handle.is_closed()` every 250 ms and fires `Dropped` once: russh skips `Handler::disconnected` when the final socket `shutdown()` fails, which is exactly the dead-socket case.
  - `pub fn is_closed(&self) -> bool`, `pub async fn close(&self)` (`Disconnect::ByApplication`; marks the connection so no `Dropped` follows an intentional close).
  - `Dropped` is sent at most once per connection (`dropped: AtomicBool`).

Why not `Config.keepalive_interval`: russh's `Config` is fixed when `connect_stream` starts, so its keepalive would run during and before auth; the spec arms keepalive only after auth. A manual `send_ping` loop also lets the "two missed replies" rule be exact.

- [ ] **Step 1: Write the proxy** `tests/support/proxy.rs`

```rust
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Notify;

/// Forwards one TCP connection; `freeze` stops relaying bytes without closing (a suspended
/// laptop), `kill` drops both sockets (an RST).
pub struct Proxy {
    pub addr: SocketAddr,
    frozen: Arc<AtomicBool>,
    killed: Arc<Notify>,
}

impl Proxy {
    pub async fn start(upstream: SocketAddr) -> Proxy {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let frozen = Arc::new(AtomicBool::new(false));
        let killed = Arc::new(Notify::new());
        let (f, k) = (frozen.clone(), killed.clone());
        tokio::spawn(async move {
            let (client, _) = listener.accept().await.unwrap();
            let server = TcpStream::connect(upstream).await.unwrap();
            let (cr, cw) = client.into_split();
            let (sr, sw) = server.into_split();
            let up = tokio::spawn(pump(cr, sw, f.clone()));
            let down = tokio::spawn(pump(sr, cw, f));
            k.notified().await;
            up.abort();
            down.abort();
        });
        Proxy { addr, frozen, killed }
    }

    pub fn freeze(&self) {
        self.frozen.store(true, Ordering::SeqCst);
    }

    pub fn kill(&self) {
        self.killed.notify_one();
    }
}

async fn pump(mut from: impl AsyncReadExt + Unpin, mut to: impl AsyncWriteExt + Unpin, frozen: Arc<AtomicBool>) {
    let mut buf = vec![0u8; 16 * 1024];
    loop {
        let n = match from.read(&mut buf).await {
            Ok(0) | Err(_) => return,
            Ok(n) => n,
        };
        if frozen.load(Ordering::SeqCst) {
            continue; // swallow: the peer sees silence, not a close
        }
        if to.write_all(&buf[..n]).await.is_err() {
            return;
        }
    }
}
```

- [ ] **Step 2: Write the failing tests** `tests/keepalive.rs`

```rust
mod support;

use std::time::Duration;

use support::proxy::Proxy;
use support::server::{Options, start};
use tether_core::connect::{Connection, Credential, Transport};
use tether_ssh::ConnectionEvent;
use zeroize::Zeroizing;

const EVERY: Duration = Duration::from_millis(150);

async fn through_proxy() -> (support::server::Running, Proxy, tether_ssh::RusshConnection) {
    let server = start(Options { password: Some(("tester".into(), "hunter2".into())), ..Default::default() }).await;
    let proxy = Proxy::start(server.addr).await;
    let mut conn = support::transport().dial("127.0.0.1", proxy.addr.port(), support::TIMEOUT).await.unwrap();
    conn.authenticate("tester", Credential::Password(Zeroizing::new("hunter2".into()))).await.unwrap();
    (server, proxy, conn)
}

#[tokio::test]
async fn a_healthy_link_never_drops() {
    let (_s, _p, mut conn) = through_proxy().await;
    let mut events = conn.events();
    conn.start_keepalive(EVERY);
    let got = tokio::time::timeout(EVERY * 8, events.recv()).await;
    assert!(got.is_err(), "unexpected event {got:?}");
}

#[tokio::test]
async fn two_missed_pings_drop_the_link() {
    let (_s, proxy, mut conn) = through_proxy().await;
    let mut events = conn.events();
    conn.start_keepalive(EVERY);
    proxy.freeze();
    let got = tokio::time::timeout(EVERY * 6, events.recv()).await.expect("no drop within 6 intervals");
    assert_eq!(got.unwrap(), ConnectionEvent::Dropped);
}

#[tokio::test]
async fn a_killed_socket_drops_without_keepalive() {
    let (_s, proxy, conn) = through_proxy().await;
    let mut events = conn.events();
    proxy.kill();
    let got = tokio::time::timeout(Duration::from_secs(3), events.recv()).await.expect("no drop after RST");
    assert_eq!(got.unwrap(), ConnectionEvent::Dropped);
    assert!(conn.is_closed());
}

#[tokio::test]
async fn an_intentional_close_is_not_reported_as_a_drop() {
    let (_s, _p, conn) = through_proxy().await;
    let mut events = conn.events();
    conn.close().await;
    let got = tokio::time::timeout(Duration::from_millis(800), events.recv()).await;
    assert!(got.is_err(), "unexpected {got:?}");
}

#[tokio::test]
async fn dropped_fires_once() {
    let (_s, proxy, mut conn) = through_proxy().await;
    let mut events = conn.events();
    conn.start_keepalive(EVERY);
    proxy.kill();
    assert_eq!(tokio::time::timeout(Duration::from_secs(3), events.recv()).await.unwrap().unwrap(), ConnectionEvent::Dropped);
    assert!(tokio::time::timeout(EVERY * 4, events.recv()).await.is_err());
}
```

"One missed ping is not a drop" is a unit test on the miss counter, because a swallowing proxy cannot resume cleanly (bytes lost mid-stream break the SSH MAC sequence). Put this in `src/connection.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::Misses;

    #[test]
    fn one_miss_then_a_reply_resets() {
        let mut m = Misses::default();
        assert!(!m.missed());
        m.replied();
        assert!(!m.missed());
    }

    #[test]
    fn two_consecutive_misses_is_a_drop() {
        let mut m = Misses::default();
        assert!(!m.missed());
        assert!(m.missed());
    }
}
```

- [ ] **Step 3: Run to verify failure**

Run: `cargo test -p tether-ssh --test keepalive && cargo test -p tether-ssh --lib`
Expected: FAIL — `Misses`, `is_closed`, `close` missing; scaffold `start_keepalive` does nothing.

- [ ] **Step 4: Implement** in `src/connection.rs`

```rust
use std::sync::atomic::Ordering;
use std::time::Duration;

use russh::Disconnect;

const MISSES_FOR_DROP: u8 = 2;
const WATCH_EVERY: Duration = Duration::from_millis(250);

#[derive(Default)]
pub(crate) struct Misses(u8);

impl Misses {
    /// True when this miss makes the link dead.
    pub(crate) fn missed(&mut self) -> bool {
        self.0 += 1;
        self.0 >= MISSES_FOR_DROP
    }
    pub(crate) fn replied(&mut self) {
        self.0 = 0;
    }
}

pub(crate) fn report_drop(events: &broadcast::Sender<ConnectionEvent>, dropped: &AtomicBool) {
    if !dropped.swap(true, Ordering::SeqCst) {
        let _ = events.send(ConnectionEvent::Dropped);
    }
}

impl RusshConnection {
    pub fn is_closed(&self) -> bool {
        self.handle.try_read().map(|h| h.is_closed()).unwrap_or(false)
    }

    pub async fn close(&self) {
        // Mark first: the watcher must not report our own disconnect as a drop.
        self.dropped.store(true, Ordering::SeqCst);
        if let Some(task) = self.keepalive.lock().unwrap().take() {
            task.abort();
        }
        let _ = self.handle.read().await.disconnect(Disconnect::ByApplication, "", "en").await;
    }

    pub(crate) fn spawn_watcher(&self) {
        let handle = self.handle.clone();
        let events = self.events.clone();
        let dropped = self.dropped.clone();
        self.runtime.spawn(async move {
            loop {
                tokio::time::sleep(WATCH_EVERY).await;
                if dropped.load(Ordering::SeqCst) {
                    return;
                }
                if handle.read().await.is_closed() {
                    report_drop(&events, &dropped);
                    return;
                }
            }
        });
    }
}
```

In `impl Connection for RusshConnection`, replace the scaffold:

```rust
fn start_keepalive(&mut self, every: Duration) {
    let handle = self.handle.clone();
    let events = self.events.clone();
    let dropped = self.dropped.clone();
    let task = self.runtime.spawn(async move {
        let mut misses = Misses::default();
        let mut tick = tokio::time::interval(every);
        tick.tick().await; // the first tick is immediate
        loop {
            tick.tick().await;
            let ping = async { handle.read().await.send_ping().await };
            match tokio::time::timeout(every, ping).await {
                Ok(Ok(())) => misses.replied(),
                Ok(Err(_)) => break, // the session is gone
                Err(_) if misses.missed() => break,
                Err(_) => {}
            }
        }
        if !dropped.load(Ordering::SeqCst) {
            report_drop(&events, &dropped);
            let _ = handle.read().await.disconnect(Disconnect::ByApplication, "keepalive timeout", "en").await;
        }
    });
    if let Some(old) = self.keepalive.lock().unwrap().replace(task) {
        old.abort();
    }
}
```

The `ClientHandler::disconnected` path must also dedupe: give `ClientHandler` the same `dropped: Arc<AtomicBool>` (create it in `dial`, pass it to both the handler and the connection) and have `disconnected` call `report_drop`. In `dial`, after building `RusshConnection`, call `conn.spawn_watcher()` before returning it.

Add `impl Drop for RusshConnection` that aborts the keepalive task (the `Handle` drop then ends the session):

```rust
impl Drop for RusshConnection {
    fn drop(&mut self) {
        self.dropped.store(true, Ordering::SeqCst);
        if let Some(task) = self.keepalive.lock().unwrap().take() {
            task.abort();
        }
    }
}
```

- [ ] **Step 5: Run tests**

Run: `cargo test -p tether-ssh --test keepalive && cargo test -p tether-ssh --lib`
Expected: 5 keepalive PASS, lib tests PASS (including Task 1's handler tests).

- [ ] **Step 6: Run the whole crate to check nothing regressed**

Run: `cargo test -p tether-ssh`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add clients/windows/crates/tether-ssh
git commit -m "feat(windows): keepalive after auth and report dropped links once

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: SCP sink-mode upload

**Files:**
- Modify: `crates/tether-ssh/src/scp.rs`
- Modify: `tests/support/server_scp.rs` (real sink)
- Create: `tests/scp.rs`

**Interfaces:**
- Consumes: `tether_core::zmx::shell_quote`.
- Produces: `impl RusshConnection { pub async fn scp_send(&self, remote_path: &str, bytes: &[u8]) -> Result<(), ConnectError> }` — runs `scp -t <shell_quote(remote_path)>` on a fresh channel, sends `C0644 <len> <basename>\n`, the bytes, `\0`, then EOF; every step waits for a `\0` ack. A `\x01`/`\x02` ack followed by a line becomes `ConnectError::Transport(<that line, trimmed>)`. The caller (M6) opens one connection per upload and has already checked the 200 MB limit.

The target is the full remote path, as libssh2's `scp_send` (iOS) does: OpenSSH's sink writes to that path when it is not a directory, so the basename in the header is informational.

- [ ] **Step 1: Write the sink** `tests/support/server_scp.rs`

```rust
use std::sync::{Arc, Mutex};

use russh::ChannelId;
use russh::server::Session;

use super::server::Recorded;

/// Undo `shell_quote`: `'a'"'"'b'` → `a'b`. Only the form core produces.
pub fn unquote(s: &str) -> String {
    let mut out = String::new();
    let mut chars = s.trim().chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\'' => {
                for c in chars.by_ref() {
                    if c == '\'' { break }
                    out.push(c);
                }
            }
            '"' => {
                for c in chars.by_ref() {
                    if c == '"' { break }
                    out.push(c);
                }
            }
            other => out.push(other),
        }
    }
    out
}

pub struct ScpSink {
    target: String,
    buf: Vec<u8>,
    expect: Option<(usize, String)>,
}

impl ScpSink {
    pub fn new(target: String) -> Self {
        ScpSink { target, buf: Vec::new(), expect: None }
    }

    pub fn feed(&mut self, channel: ChannelId, data: &[u8], session: &mut Session, state: &Arc<Mutex<Recorded>>) {
        self.buf.extend_from_slice(data);
        loop {
            match &self.expect {
                None => {
                    let Some(nl) = self.buf.iter().position(|b| *b == b'\n') else { return };
                    let line = String::from_utf8_lossy(&self.buf[..nl]).into_owned();
                    self.buf.drain(..=nl);
                    if self.target.starts_with("/refuse") {
                        let _ = session.data(channel, b"\x01scp: /refuse: Permission denied\n".to_vec());
                        return;
                    }
                    let mut parts = line.splitn(3, ' ');
                    let (_mode, len, name) = (parts.next(), parts.next(), parts.next());
                    let len: usize = len.and_then(|l| l.parse().ok()).unwrap_or(0);
                    self.expect = Some((len, name.unwrap_or("").to_string()));
                    let _ = session.data(channel, vec![0u8]);
                }
                Some((len, _name)) => {
                    if self.buf.len() < len + 1 { return }
                    let body = self.buf[..*len].to_vec();
                    self.buf.drain(..=*len);
                    state.lock().unwrap().uploads.insert(self.target.clone(), body);
                    self.expect = None;
                    let _ = session.data(channel, vec![0u8]);
                }
            }
        }
    }
}
```

On the client's EOF, the server should send exit status 0 and close. Add to `ConnHandler`:

```rust
async fn channel_eof(&mut self, channel: ChannelId, session: &mut Session) -> Result<(), Self::Error> {
    if self.scp.remove(&channel).is_some() {
        session.exit_status_request(channel, 0)?;
        session.eof(channel)?;
        session.close(channel)?;
    }
    Ok(())
}
```

- [ ] **Step 2: Write the failing tests** `tests/scp.rs`

```rust
mod support;

use support::server::{Options, start};
use tether_core::connect::{ConnectError, Connection, Credential, Transport};
use zeroize::Zeroizing;

async fn signed_in() -> (support::server::Running, tether_ssh::RusshConnection) {
    let server = start(Options { password: Some(("tester".into(), "hunter2".into())), ..Default::default() }).await;
    let mut conn = support::transport().dial("127.0.0.1", server.addr.port(), support::TIMEOUT).await.unwrap();
    conn.authenticate("tester", Credential::Password(Zeroizing::new("hunter2".into()))).await.unwrap();
    (server, conn)
}

#[tokio::test]
async fn sends_bytes_to_the_quoted_path() {
    let (server, conn) = signed_in().await;
    conn.scp_send("/home/me/.tether/uploads/paste-1791082819.png", b"\x89PNG data").await.unwrap();
    let state = server.state.lock().unwrap();
    assert_eq!(state.execs.last().unwrap(), "scp -t '/home/me/.tether/uploads/paste-1791082819.png'");
    assert_eq!(state.uploads["/home/me/.tether/uploads/paste-1791082819.png"], b"\x89PNG data");
}

#[tokio::test]
async fn a_path_with_spaces_and_quotes_arrives_intact() {
    let (server, conn) = signed_in().await;
    let path = "/home/me/.tether/uploads/it's a photo.jpg";
    conn.scp_send(path, b"jpeg").await.unwrap();
    assert_eq!(server.state.lock().unwrap().uploads[path], b"jpeg");
}

#[tokio::test]
async fn a_multi_megabyte_file_is_sent_whole() {
    let (server, conn) = signed_in().await;
    let body: Vec<u8> = (0..5 * 1024 * 1024).map(|i| (i % 251) as u8).collect();
    conn.scp_send("/tmp/big.bin", &body).await.unwrap();
    assert_eq!(server.state.lock().unwrap().uploads["/tmp/big.bin"], body);
}

#[tokio::test]
async fn a_refusal_carries_the_hosts_message() {
    let (_server, conn) = signed_in().await;
    let err = conn.scp_send("/refuse/x.png", b"x").await.err().unwrap();
    assert_eq!(err, ConnectError::Transport("scp: /refuse: Permission denied".into()));
}

#[tokio::test]
async fn a_bare_filename_is_sent_as_given() {
    let (server, conn) = signed_in().await;
    conn.scp_send("photo.jpg", b"j").await.unwrap();
    assert_eq!(server.state.lock().unwrap().execs.last().unwrap(), "scp -t 'photo.jpg'");
}
```

- [ ] **Step 3: Run to verify failure**

Run: `cargo test -p tether-ssh --test scp`
Expected: FAIL — `scp_send` not defined.

- [ ] **Step 4: Implement** `src/scp.rs`

```rust
use bytes::Bytes;
use russh::{ChannelMsg, ChannelReadHalf};
use tether_core::connect::ConnectError;
use tether_core::zmx::shell_quote;

use crate::connection::RusshConnection;

fn t(e: impl std::fmt::Display) -> ConnectError {
    ConnectError::Transport(e.to_string())
}

/// Reads one scp ack: 0 is OK; 1 or 2 is followed by a message line.
async fn ack(read: &mut ChannelReadHalf, pending: &mut Vec<u8>) -> Result<(), ConnectError> {
    loop {
        if let Some(&code) = pending.first() {
            if code == 0 {
                pending.remove(0);
                return Ok(());
            }
            if let Some(nl) = pending.iter().position(|b| *b == b'\n') {
                let msg = String::from_utf8_lossy(&pending[1..nl]).trim().to_string();
                return Err(ConnectError::Transport(msg));
            }
        }
        match read.wait().await {
            Some(ChannelMsg::Data { data }) => pending.extend_from_slice(&data),
            Some(ChannelMsg::Failure) => return Err(ConnectError::Transport("the host refused scp".into())),
            Some(ChannelMsg::Close) | None => return Err(ConnectError::Transport("scp closed early".into())),
            Some(_) => {}
        }
    }
}

impl RusshConnection {
    pub async fn scp_send(&self, remote_path: &str, bytes: &[u8]) -> Result<(), ConnectError> {
        let channel = {
            let handle = self.handle.read().await;
            handle.channel_open_session().await.map_err(t)?
        };
        let (mut read, write) = channel.split();
        let mut pending = Vec::new();
        write.exec(true, format!("scp -t {}", shell_quote(remote_path))).await.map_err(t)?;
        ack(&mut read, &mut pending).await?;
        let name = remote_path.rsplit('/').next().unwrap_or(remote_path).replace('\n', " ");
        write.data_bytes(Bytes::from(format!("C0644 {} {name}\n", bytes.len()))).await.map_err(t)?;
        ack(&mut read, &mut pending).await?;
        write.data_bytes(Bytes::copy_from_slice(bytes)).await.map_err(t)?;
        write.data_bytes(Bytes::from_static(&[0])).await.map_err(t)?;
        ack(&mut read, &mut pending).await?;
        write.eof().await.map_err(t)?;
        while let Some(msg) = read.wait().await {
            if matches!(msg, ChannelMsg::Close) {
                break;
            }
        }
        Ok(())
    }
}
```

`data_bytes` chunks to the window and max packet size, so a 200 MB buffer streams without extra copies beyond the one `copy_from_slice`.

- [ ] **Step 5: Run tests**

Run: `cargo test -p tether-ssh --test scp`
Expected: 5 PASS.

- [ ] **Step 6: Commit**

```bash
git add clients/windows/crates/tether-ssh
git commit -m "feat(windows): send files with scp sink mode

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Opt-in live test against a real host

**Files:**
- Create: `tests/live.rs`

**Interfaces:**
- Consumes everything above plus core's `connect`, `ls_command`, `parse_ls`.
- Produces: nothing new. Skips (passes trivially, printing why) unless `TETHER_LIVE_SSH=1`.

Env: `TETHER_LIVE_HOST`, `TETHER_LIVE_PORT` (default 22), `TETHER_LIVE_USER`, and either `TETHER_LIVE_KEY` (path to a private key file) or `TETHER_LIVE_AGENT=1` (Windows only: uses the real `\\.\pipe\openssh-ssh-agent`).

- [ ] **Step 1: Write the test**

```rust
mod support;

use std::time::Duration;

use tether_core::connect::{ConnectRequest, Connection, connect};
use tether_core::hostkey::MemoryHostKeys;
use tether_core::profiles::{Auth, Machine};
use tether_core::resize::GridSize;
use tether_core::secrets::{MemorySecretStore, SecretStore, key_account};
use tether_ssh::PtyEvent;
use uuid::Uuid;

fn live() -> bool {
    if std::env::var("TETHER_LIVE_SSH").as_deref() != Ok("1") {
        eprintln!("skipping live SSH test: set TETHER_LIVE_SSH=1");
        return false;
    }
    true
}

#[tokio::test]
async fn live_host_lists_sessions_and_opens_a_shell() {
    if !live() {
        return;
    }
    let host = std::env::var("TETHER_LIVE_HOST").expect("TETHER_LIVE_HOST");
    let port = std::env::var("TETHER_LIVE_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(22);
    let user = std::env::var("TETHER_LIVE_USER").expect("TETHER_LIVE_USER");
    let secrets = MemorySecretStore::default();
    let id = Uuid::new_v4();
    let auth = if std::env::var("TETHER_LIVE_AGENT").as_deref() == Ok("1") {
        Auth::Agent
    } else {
        let key_id = Uuid::new_v4();
        let pem = std::fs::read(std::env::var("TETHER_LIVE_KEY").expect("TETHER_LIVE_KEY")).unwrap();
        secrets.set(&key_account(key_id), &pem).unwrap();
        Auth::Key { id: key_id }
    };
    let machine = Machine { id, name: "live".into(), host, port, user, auth };

    let mut conn = connect(&support::transport(), &ConnectRequest { machine }, &MemoryHostKeys::default(), &secrets)
        .await
        .unwrap();
    conn.start_keepalive(Duration::from_secs(15));

    let ls = conn.exec(&tether_core::zmx::ls_command()).await.unwrap();
    eprintln!("zmx ls: {:?}", tether_core::zmx::parse_ls(&ls));

    let mut pty = conn.open_pty(GridSize { cols: 80, rows: 24, width_px: 640, height_px: 384 }).await.unwrap();
    pty.writer.write(b"echo tether-live-$((40+2))\n").await;
    let mut seen = String::new();
    tokio::time::timeout(Duration::from_secs(10), async {
        while !seen.contains("tether-live-42") {
            if let Some(PtyEvent::Data(d)) = pty.events.recv().await {
                seen.push_str(&String::from_utf8_lossy(&d));
            }
        }
    })
    .await
    .expect("shell never echoed");
    pty.writer.close().await;
    conn.close().await;
}
```

- [ ] **Step 2: Run without the env var**

Run: `cargo test -p tether-ssh --test live -- --nocapture`
Expected: PASS, prints `skipping live SSH test: set TETHER_LIVE_SSH=1`.

- [ ] **Step 3: Run the full crate, lint, and commit**

Run: `cargo fmt --check && cargo clippy -p tether-ssh --all-targets -- -D warnings && cargo test -p tether-ssh`
Expected: all PASS, no warnings.

```bash
git add clients/windows/crates/tether-ssh/tests/live.rs
git commit -m "test(windows): opt-in live SSH test for tether-ssh

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Self-review notes

- **Spec coverage (tether-ssh line):** pin → Task 3; auth by key → Task 2; by agent with a fake agent pipe → Task 4 (in-memory on Linux, real named pipe on Windows); by password → Task 2; several PTY channels each with own data → Task 6; exec → Task 5; SCP sink → Task 8. Connect: 10 s timeout → Task 1 (core passes it); keepalive after auth every 15 s, two missed replies → Task 7; agent order and no forwarding → Tasks 4, 3/6; host-key mismatch hard-refused before auth → Task 3 + Task 1 rekey guard.
- **Out of this milestone:** the retry count (3 × 500 ms), reconnect backoff, and re-attach order are core's (M2) and are exercised by core's fake-transport tests; typing `zmx attach` and per-tab draining are M6.
- **Type consistency:** `GridSize`, `ConnectError`, `Credential`, `Transport`, `Connection` are used exactly as in the roadmap contract; `PtyWriter` methods return `()` per the contract.

## Deviations

No public name from the roadmap contract or a task's Produces block was renamed.

- `NamedPipeAgent` matches `russh::keys::Error::IO` (russh 0.64.1), not `Io`.
- `ClientHandler` holds the `dropped` flag from `dial` so a disconnect is reported once.
- The PTY reader starts before the first `window_change`, then yields so that change reaches the test server on Windows.
- Session channel buffers are 2048 so a slow PTY reader does not stall the other channel. The reader uses `try_send` and drops when the queue is full.
- `PtyWriter::close` drops the write half and enqueues `PtyEvent::Closed`.
- Dependencies are pinned in `tether-ssh/Cargo.toml` rather than the workspace table.
- The PTY reader awaits `send` instead of dropping a full queue. `exec` returns `ConnectError::Timeout` after 15 s. `dial` connects with `(host, port)` after stripping a surrounding `[]`, so an IPv6 literal works. No signature changes.


