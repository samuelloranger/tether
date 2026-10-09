use std::sync::Arc;

use futures::future::BoxFuture;
use russh::client;
use russh::keys::agent::AgentIdentity;
use russh::keys::agent::client::{AgentClient, AgentStream};
use tether_core::connect::ConnectError;

use crate::handler::ClientHandler;

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
        Self {
            path: r"\\.\pipe\openssh-ssh-agent".to_string(),
        }
    }
}

pub fn map_agent_io_error(e: &std::io::Error) -> ConnectError {
    match e.kind() {
        std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused => {
            ConnectError::AgentNotRunning
        }
        _ => ConnectError::Transport(format!("SSH agent: {e}")),
    }
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
                    .map_err(|e| match e {
                        russh::keys::Error::IO(io) => map_agent_io_error(&io),
                        other => ConnectError::Transport(format!("SSH agent: {other}")),
                    })
            })
        }
        #[cfg(not(windows))]
        Box::pin(async { Err(ConnectError::AgentNotRunning) })
    }
}

#[cfg(unix)]
/// An SSH agent on a Unix-domain socket, normally the one `SSH_AUTH_SOCK` names.
pub struct UnixAgent {
    pub socket: Option<std::path::PathBuf>,
}

#[cfg(unix)]
impl UnixAgent {
    pub fn from_env() -> Self {
        Self {
            socket: std::env::var_os("SSH_AUTH_SOCK")
                .filter(|v| !v.is_empty())
                .map(Into::into),
        }
    }
}

#[cfg(unix)]
impl AgentConnector for UnixAgent {
    fn connect(&self) -> BoxFuture<'static, Result<AgentClient<AgentStreamBox>, ConnectError>> {
        let socket = self.socket.clone();
        Box::pin(async move {
            let Some(socket) = socket else {
                return Err(ConnectError::AgentNotRunning);
            };
            AgentClient::connect_uds(&socket)
                .await
                .map(|c| c.dynamic())
                .map_err(|e| match e {
                    russh::keys::Error::IO(io) => map_agent_io_error(&io),
                    other => ConnectError::Transport(format!("SSH agent: {other}")),
                })
        })
    }
}

/// Pageant, for people who keep their keys in PuTTY's agent.
pub struct PageantAgent;

impl AgentConnector for PageantAgent {
    fn connect(&self) -> BoxFuture<'static, Result<AgentClient<AgentStreamBox>, ConnectError>> {
        #[cfg(windows)]
        {
            Box::pin(async move {
                AgentClient::connect_pageant()
                    .await
                    .map(|c| c.dynamic())
                    .map_err(|_| ConnectError::AgentNotRunning)
            })
        }
        #[cfg(not(windows))]
        Box::pin(async { Err(ConnectError::AgentNotRunning) })
    }
}

/// Tries `first`, and `then` only when `first` is not running at all.
pub struct FallbackAgent {
    pub first: Arc<dyn AgentConnector>,
    pub then: Arc<dyn AgentConnector>,
}

impl FallbackAgent {
    /// The Windows OpenSSH agent, else Pageant.
    pub fn windows() -> Self {
        Self {
            first: Arc::new(NamedPipeAgent::default()),
            then: Arc::new(PageantAgent),
        }
    }
}

/// The agent this OS ships: `SSH_AUTH_SOCK` on Unix, else the Windows pair.
pub fn default_agent() -> Arc<dyn AgentConnector> {
    #[cfg(windows)]
    {
        Arc::new(FallbackAgent::windows())
    }
    #[cfg(unix)]
    {
        Arc::new(UnixAgent::from_env())
    }
}

impl AgentConnector for FallbackAgent {
    fn connect(&self) -> BoxFuture<'static, Result<AgentClient<AgentStreamBox>, ConnectError>> {
        let (first, then) = (self.first.connect(), self.then.clone());
        Box::pin(async move {
            match first.await {
                Err(ConnectError::AgentNotRunning) => then.connect().await,
                other => other,
            }
        })
    }
}

/// Whether an agent is there with at least one key. One that connects but is too slow to list
/// its keys (forwarded, or waiting on an unlock prompt) counts: it may hold the key a host needs.
pub async fn agent_offers_keys(connector: &dyn AgentConnector, wait: std::time::Duration) -> bool {
    let Ok(Ok(mut agent)) = tokio::time::timeout(wait, connector.connect()).await else {
        return false;
    };
    match tokio::time::timeout(wait, agent.request_identities()).await {
        Ok(listed) => listed.is_ok_and(|ids| !ids.is_empty()),
        Err(_) => true,
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
        let AgentIdentity::PublicKey { key, .. } = identity else {
            continue;
        };
        let hash = if key.algorithm().is_rsa() {
            handle
                .best_supported_rsa_hash()
                .await
                .ok()
                .flatten()
                .flatten()
        } else {
            None
        };
        match handle
            .authenticate_publickey_with(user, key, hash, &mut agent)
            .await
        {
            Ok(result) if result.success() => return Ok(()),
            Ok(_) => continue,
            Err(e) => return Err(ConnectError::Transport(format!("SSH agent: {e}"))),
        }
    }
    Err(ConnectError::AgentNoKey)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Fails(ConnectError, Arc<AtomicUsize>);

    impl AgentConnector for Fails {
        fn connect(&self) -> BoxFuture<'static, Result<AgentClient<AgentStreamBox>, ConnectError>> {
            self.1.fetch_add(1, Ordering::SeqCst);
            let e = self.0.clone();
            Box::pin(async move { Err(e) })
        }
    }

    fn pair(first: ConnectError, then: ConnectError) -> (FallbackAgent, Arc<AtomicUsize>) {
        let calls = Arc::new(AtomicUsize::new(0));
        let agent = FallbackAgent {
            first: Arc::new(Fails(first, Arc::new(AtomicUsize::new(0)))),
            then: Arc::new(Fails(then, calls.clone())),
        };
        (agent, calls)
    }

    #[tokio::test]
    async fn a_missing_first_agent_falls_back_to_the_second() {
        let (agent, calls) = pair(ConnectError::AgentNotRunning, ConnectError::AgentNoKey);
        assert_eq!(agent.connect().await.err(), Some(ConnectError::AgentNoKey));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_running_agent_that_fails_does_not_fall_back() {
        let (agent, calls) = pair(
            ConnectError::Transport("SSH agent: refused".into()),
            ConnectError::AgentNoKey,
        );
        assert_eq!(
            agent.connect().await.err(),
            Some(ConnectError::Transport("SSH agent: refused".into()))
        );
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn neither_running_reads_as_not_running() {
        let (agent, _) = pair(ConnectError::AgentNotRunning, ConnectError::AgentNotRunning);
        assert_eq!(
            agent.connect().await.err(),
            Some(ConnectError::AgentNotRunning)
        );
    }
}
