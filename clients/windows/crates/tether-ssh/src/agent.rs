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
