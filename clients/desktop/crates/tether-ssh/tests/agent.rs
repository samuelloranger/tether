mod support;

use std::sync::Arc;

use futures::future::BoxFuture;
use russh::keys::agent::client::AgentClient;
use russh::keys::{PrivateKey, ssh_key::Algorithm};
use support::server::{Options, start};
use tether_core::connect::{ConnectError, Connection, Credential, Transport};
use tether_ssh::{
    AgentConnector, AgentStreamBox, RusshTransport, agent_offers_keys, map_agent_io_error,
};

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
    let server = start(Options {
        allowed_keys: vec![accepted.public_key().clone()],
        ..Default::default()
    })
    .await;
    let t = transport(FakeAgent {
        keys: vec![key(), accepted],
    });
    let mut conn = t
        .dial("127.0.0.1", server.addr.port(), support::TIMEOUT)
        .await
        .unwrap();
    conn.authenticate("tester", Credential::Agent)
        .await
        .unwrap();
}

#[tokio::test]
async fn agent_without_an_accepted_key_is_agent_no_key() {
    let server = start(Options {
        allowed_keys: vec![key().public_key().clone()],
        ..Default::default()
    })
    .await;
    let t = transport(FakeAgent { keys: vec![key()] });
    let mut conn = t
        .dial("127.0.0.1", server.addr.port(), support::TIMEOUT)
        .await
        .unwrap();
    assert_eq!(
        conn.authenticate("tester", Credential::Agent).await.err(),
        Some(ConnectError::AgentNoKey)
    );
}

#[tokio::test]
async fn empty_agent_is_agent_no_key() {
    let server = start(Options::default()).await;
    let t = transport(FakeAgent { keys: vec![] });
    let mut conn = t
        .dial("127.0.0.1", server.addr.port(), support::TIMEOUT)
        .await
        .unwrap();
    assert_eq!(
        conn.authenticate("tester", Credential::Agent).await.err(),
        Some(ConnectError::AgentNoKey)
    );
}

#[tokio::test]
async fn unreachable_agent_is_agent_not_running() {
    let server = start(Options::default()).await;
    let t = transport(DeadAgent);
    let mut conn = t
        .dial("127.0.0.1", server.addr.port(), support::TIMEOUT)
        .await
        .unwrap();
    assert_eq!(
        conn.authenticate("tester", Credential::Agent).await.err(),
        Some(ConnectError::AgentNotRunning)
    );
}

#[test]
fn missing_pipe_maps_to_agent_not_running() {
    let e = std::io::Error::from(std::io::ErrorKind::NotFound);
    assert_eq!(map_agent_io_error(&e), ConnectError::AgentNotRunning);
    let other = std::io::Error::other("boom");
    assert!(matches!(
        map_agent_io_error(&other),
        ConnectError::Transport(_)
    ));
}

#[tokio::test]
async fn only_an_agent_holding_a_key_offers_keys() {
    assert!(agent_offers_keys(&FakeAgent { keys: vec![key()] }).await);
    assert!(!agent_offers_keys(&FakeAgent { keys: Vec::new() }).await);
    assert!(!agent_offers_keys(&DeadAgent).await);
}

#[cfg(windows)]
#[tokio::test]
async fn named_pipe_agent_signs_in() {
    use tokio::net::windows::named_pipe::ServerOptions;
    let accepted = key();
    let name = format!(r"\\.\pipe\tether-test-agent-{}", uuid::Uuid::new_v4());
    let pipe = ServerOptions::new()
        .first_pipe_instance(true)
        .create(&name)
        .unwrap();
    tokio::spawn(async move {
        pipe.connect().await.unwrap();
        russh::keys::agent::server::serve(
            futures::stream::iter(vec![Ok::<_, std::io::Error>(pipe)]),
            (),
        )
        .await
    });
    let agent = tether_ssh::NamedPipeAgent { path: name };
    let mut c = agent.connect().await.unwrap();
    c.add_identity(&accepted, &[]).await.unwrap();
    let ids = c.request_identities().await.unwrap();
    assert_eq!(ids.len(), 1);
    assert_eq!(
        ids[0].public_key().key_data(),
        accepted.public_key().key_data()
    );
}

#[cfg(windows)]
#[tokio::test]
async fn missing_named_pipe_is_agent_not_running() {
    let agent = tether_ssh::NamedPipeAgent {
        path: format!(r"\\.\pipe\tether-missing-{}", uuid::Uuid::new_v4()),
    };
    assert_eq!(
        agent.connect().await.err(),
        Some(ConnectError::AgentNotRunning)
    );
}

#[cfg(unix)]
mod unix {
    use super::*;
    use std::path::{Path, PathBuf};
    use std::process::{Child, Command, Stdio};
    use tether_ssh::UnixAgent;

    // A fork holds the parent's sockets until it execs, so a listener closed while another test
    // spawns ssh-agent can still accept a connect. Forks and the stale-socket check take turns.
    static FORK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    struct Agent(Child);
    impl Drop for Agent {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    async fn spawn_agent(sock: &Path) -> Option<Agent> {
        let child = {
            let _turn = FORK.lock().await;
            Command::new("ssh-agent")
                .args(["-D", "-a"])
                .arg(sock)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .ok()?
        };
        let agent = Agent(child);
        for _ in 0..100 {
            if sock.exists() {
                return Some(agent);
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        None
    }

    #[tokio::test]
    async fn unix_agent_lists_the_identities_it_holds() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("agent.sock");
        let Some(_agent) = spawn_agent(&sock).await else {
            eprintln!("ssh-agent is not available; skipping");
            return;
        };
        let held = key();
        let connector = UnixAgent { socket: Some(sock) };
        let mut c = connector.connect().await.unwrap();
        assert!(c.request_identities().await.unwrap().is_empty());
        c.add_identity(&held, &[]).await.unwrap();
        let ids = c.request_identities().await.unwrap();
        assert_eq!(ids.len(), 1);
        assert_eq!(ids[0].public_key().key_data(), held.public_key().key_data());
    }

    #[tokio::test]
    async fn no_socket_or_a_dead_one_is_agent_not_running() {
        let none = UnixAgent { socket: None };
        assert_eq!(
            none.connect().await.err(),
            Some(ConnectError::AgentNotRunning)
        );
        let dir = tempfile::tempdir().unwrap();
        let missing = UnixAgent {
            socket: Some(dir.path().join("absent.sock")),
        };
        assert_eq!(
            missing.connect().await.err(),
            Some(ConnectError::AgentNotRunning)
        );
        let stale: PathBuf = dir.path().join("stale.sock");
        let _turn = FORK.lock().await;
        drop(std::os::unix::net::UnixListener::bind(&stale).unwrap());
        let refused = UnixAgent {
            socket: Some(stale),
        };
        assert_eq!(
            refused.connect().await.err(),
            Some(ConnectError::AgentNotRunning)
        );
    }
}
