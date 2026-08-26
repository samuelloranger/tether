//! Spawns a real `tether` server and pairs with it, so the tests below drive
//! the actual HTTP surface instead of a mock.
//!
//! Isolation rests on one fact worth stating: `TETHER_DB_PATH` also relocates
//! the config dir, and the holder sockets live in the config dir. Pointing it
//! at a temp dir therefore keeps a test's PTYs out of `~/.tether/holders`,
//! where the live daemon's holders are. Without that, a test kill could reach
//! a real shell.

#![allow(dead_code)]

use std::collections::BTreeMap;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::Value;
use tether_core::host_client::{HostClient, HttpMethod, HttpRequest};
use tether_core::host_store::HostProfile;

/// The server binary under test. Built by `bun build:server`; the tests refuse
/// to run rather than silently exercise nothing, because a skipped suite that
/// reports success is worse than a red one.
fn server_binary() -> PathBuf {
    if let Ok(explicit) = std::env::var("TETHER_E2E_BIN") {
        return PathBuf::from(explicit);
    }
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .expect("repo root")
        .to_path_buf();
    repo.join("apps/server/dist/tether")
}

fn free_port() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral");
    let port = listener.local_addr().expect("local addr").port();
    drop(listener);
    port
}

pub struct Server {
    child: Child,
    binary: PathBuf,
    workdir: Option<PathBuf>,
    db_path: PathBuf,
    pub port: u16,
    pub password: String,
    pub state_dir: tempfile::TempDir,
    pub http: reqwest::Client,
}

impl Server {
    /// Starts a paired server. Panics with a readable reason on every failure
    /// path — a test harness that degrades quietly is how a green suite ends up
    /// meaning nothing.
    pub async fn start() -> Self {
        Self::start_in(None).await
    }

    /// Starts a server whose process cwd is `workdir`. Git and workspace routes
    /// resolve their repo and file roots from the session's cwd, which a
    /// freshly started session inherits from the server process — so this is how
    /// a test points them at a throwaway repo.
    pub async fn start_in(workdir: Option<&Path>) -> Self {
        let binary = server_binary();
        assert!(
            binary.exists(),
            "server binary missing at {}\nbuild it first: bun build:server",
            binary.display()
        );

        let state_dir = tempfile::tempdir().expect("temp state dir");
        let db_path = state_dir.path().join("tether.db");
        let port = free_port();

        let mut command = Command::new(&binary);
        if let Some(dir) = workdir {
            command.current_dir(dir);
        }
        let child = command
            .arg("serve")
            .env("TETHER_PORT", port.to_string())
            // The TLS listener would claim a second port we never asked for.
            .env("TETHER_TLS", "off")
            .env("TETHER_DB_PATH", &db_path)
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap_or_else(|e| panic!("spawn {}: {e}", binary.display()));

        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .expect("reqwest client");

        let mut server = Self {
            child,
            binary: binary.clone(),
            workdir: workdir.map(Path::to_path_buf),
            db_path: db_path.clone(),
            port,
            password: "e2e-password".to_string(),
            state_dir,
            http,
        };
        server.await_ready().await;
        server.pair().await;
        server
    }

    /// Stops and restarts the server on the same port and database, the way
    /// `tether restart` does. The holders are separate detached processes, so a
    /// session started before this call must survive it — that promise is the
    /// reason the holder architecture exists, and it needs a test that actually
    /// stops a server.
    pub async fn restart(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();

        let mut command = Command::new(&self.binary);
        if let Some(dir) = &self.workdir {
            command.current_dir(dir);
        }
        self.child = command
            .arg("serve")
            .env("TETHER_PORT", self.port.to_string())
            .env("TETHER_TLS", "off")
            .env("TETHER_DB_PATH", &self.db_path)
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .expect("respawn server");
        self.await_ready().await;
    }

    fn base(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    /// Polls `/api/status` until it answers. Reports the child's exit status on
    /// give-up, because "server never came up" is nearly always the server
    /// having died with a message worth reading.
    async fn await_ready(&mut self) {
        let deadline = Instant::now() + Duration::from_secs(20);
        let url = format!("{}/api/status", self.base());
        while Instant::now() < deadline {
            if let Some(status) = self.child.try_wait().expect("try_wait") {
                panic!("server exited before becoming ready: {status}");
            }
            if let Ok(response) = self.http.get(&url).send().await {
                if response.status().is_success() {
                    return;
                }
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        panic!("server did not answer /api/status within 20s");
    }

    /// First-run TOFU pairing. `needsSetup` must be true on a fresh temp DB; if
    /// it is not, the DB is not the one we thought we handed it.
    async fn pair(&self) {
        let status: Value = self
            .http
            .get(format!("{}/api/status", self.base()))
            .send()
            .await
            .expect("status")
            .json()
            .await
            .expect("status json");
        assert_eq!(
            status["needsSetup"], true,
            "a fresh temp DB should need setup, got {status}"
        );

        let setup: Value = self
            .http
            .post(format!("{}/api/setup", self.base()))
            .json(&serde_json::json!({ "password": self.password }))
            .send()
            .await
            .expect("setup")
            .json()
            .await
            .expect("setup json");
        assert_eq!(setup["ok"], true, "pairing failed: {setup}");
    }

    /// A `HostClient` pointed at this server, which is what the desktop and iOS
    /// clients build every request through.
    pub fn client(&self) -> HostClient {
        HostClient::new(
            HostProfile {
                id: "e2e".to_string(),
                name: "e2e".to_string(),
                color: "#888888".to_string(),
                host: "127.0.0.1".to_string(),
                port: self.port.to_string(),
                identity_name: "e2e".to_string(),
                order: 0,
            },
            self.password.clone(),
        )
    }

    /// A client pointed at this server with an arbitrary password, for the
    /// tests that assert what a wrong or rotated credential does.
    pub fn client_with(&self, password: &str) -> HostClient {
        HostClient::new(
            HostProfile {
                id: "e2e-alt".to_string(),
                name: "e2e-alt".to_string(),
                color: "#888888".to_string(),
                host: "127.0.0.1".to_string(),
                port: self.port.to_string(),
                identity_name: "e2e-alt".to_string(),
                order: 0,
            },
            password.to_string(),
        )
    }

    /// Runs a core-built `HttpRequest` the way the desktop's `http::execute`
    /// does, so the tests exercise the same request shapes the app sends.
    pub async fn exec(&self, request: &HttpRequest) -> (u16, Value) {
        let mut builder = match request.method {
            HttpMethod::Get => self.http.get(&request.url),
            HttpMethod::Post => self.http.post(&request.url),
            HttpMethod::Delete => self.http.delete(&request.url),
            HttpMethod::Patch => self.http.patch(&request.url),
        };
        for (name, value) in &request.headers {
            builder = builder.header(name, value);
        }
        if let Some(body) = &request.body {
            builder = builder.body(body.clone());
        }
        let response = builder.send().await.expect("request");
        let status = response.status().as_u16();
        let text = response.text().await.expect("body text");
        let body = if text.trim().is_empty() {
            Value::Null
        } else {
            serde_json::from_str(&text).unwrap_or(Value::String(text))
        };
        (status, body)
    }

    pub fn auth(&self) -> BTreeMap<String, String> {
        self.client().auth_header()
    }

    pub fn ws_base(&self) -> String {
        format!("ws://127.0.0.1:{}", self.port)
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        // Kill by the handle we own. Never by pattern: a pattern-based kill on
        // this machine has already taken out the production daemon.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Waits for `predicate` to hold, polling. Returns the last value seen so a
/// failure can report what it actually got.
pub async fn eventually<F, Fut, T>(label: &str, mut probe: F) -> T
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Option<T>>,
{
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if let Some(value) = probe().await {
            return value;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("timed out waiting for {label}");
}

/// A throwaway git repo with one commit, so diff/stage/commit tests have real
/// history to act on. Identity is set locally: a machine without a global
/// user.email would otherwise fail every commit.
pub fn scratch_repo() -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("temp repo");
    let run = |args: &[&str]| {
        let status = Command::new("git")
            .args(args)
            .current_dir(dir.path())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap_or_else(|e| panic!("git {args:?}: {e}"));
        assert!(status.success(), "git {args:?} failed");
    };
    run(&["init", "-q", "-b", "main"]);
    run(&["config", "user.email", "e2e@example.com"]);
    run(&["config", "user.name", "E2E"]);
    std::fs::write(dir.path().join("tracked.txt"), "one\ntwo\nthree\n").expect("write");
    run(&["add", "tracked.txt"]);
    run(&["commit", "-q", "-m", "initial"]);
    dir
}
