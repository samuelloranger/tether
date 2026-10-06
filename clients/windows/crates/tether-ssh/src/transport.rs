use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::client;
use tether_core::connect::{ConnectError, Transport};
use tokio::net::TcpStream;
use tokio::sync::{RwLock, broadcast};

use crate::agent::{AgentConnector, FallbackAgent};
use crate::connection::RusshConnection;
use crate::handler::ClientHandler;

pub struct RusshTransport {
    runtime: tokio::runtime::Handle,
    agent: Arc<dyn AgentConnector>,
}

impl RusshTransport {
    pub fn new(runtime: tokio::runtime::Handle) -> Self {
        Self::with_agent(runtime, Arc::new(FallbackAgent::windows()))
    }

    pub fn with_agent(runtime: tokio::runtime::Handle, agent: Arc<dyn AgentConnector>) -> Self {
        Self { runtime, agent }
    }

    fn config() -> Arc<client::Config> {
        Arc::new(client::Config {
            inactivity_timeout: None,
            keepalive_interval: None,
            nodelay: true,
            channel_buffer_size: 2048,
            ..Default::default()
        })
    }
}

impl RusshTransport {
    async fn handshake<F, Fut>(
        &self,
        timeout: Duration,
        via: Option<RusshConnection>,
        open: F,
    ) -> Result<RusshConnection, ConnectError>
    where
        F: FnOnce(ClientHandler) -> Fut,
        Fut: std::future::Future<Output = Result<client::Handle<ClientHandler>, ConnectError>>,
    {
        let host_key = Arc::new(Mutex::new(None));
        let (events, _) = broadcast::channel(16);
        let dropped = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let handler = ClientHandler {
            host_key: host_key.clone(),
            events: events.clone(),
            dropped: dropped.clone(),
        };
        let handle = tokio::time::timeout(timeout, open(handler))
            .await
            .map_err(|_| ConnectError::Timeout)??;
        let digest = host_key
            .lock()
            .unwrap()
            .ok_or_else(|| ConnectError::Transport("the host sent no key".into()))?;
        let conn = RusshConnection {
            handle: Arc::new(RwLock::new(handle)),
            host_key: digest,
            events,
            runtime: self.runtime.clone(),
            agent: self.agent.clone(),
            dropped,
            keepalive: Default::default(),
            _via: via.map(Box::new),
        };
        conn.spawn_watcher();
        Ok(conn)
    }
}

fn dial_host(host: &str) -> &str {
    let host = host.trim();
    host.strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
        .unwrap_or(host)
}

impl Transport for RusshTransport {
    type Conn = RusshConnection;

    async fn dial(
        &self,
        host: &str,
        port: u16,
        timeout: Duration,
    ) -> Result<RusshConnection, ConnectError> {
        let host = dial_host(host).to_string();
        self.handshake(timeout, None, move |handler| async move {
            let tcp = TcpStream::connect((host.as_str(), port))
                .await
                .map_err(|e| tcp_error(&e))?;
            let _ = tcp.set_nodelay(true);
            client::connect_stream(Self::config(), tcp, handler)
                .await
                .map_err(|e| ConnectError::Transport(e.to_string()))
        })
        .await
    }

    async fn dial_via(
        &self,
        via: RusshConnection,
        host: &str,
        port: u16,
        timeout: Duration,
    ) -> Result<RusshConnection, ConnectError> {
        let host = dial_host(host).to_string();
        let jump = via.handle.clone();
        self.handshake(timeout, Some(via), move |handler| async move {
            let channel = jump
                .read()
                .await
                .channel_open_direct_tcpip(host.as_str(), port as u32, "127.0.0.1", 0)
                .await
                .map_err(|e| {
                    ConnectError::Transport(format!("the jump host could not reach {host}: {e}"))
                })?;
            client::connect_stream(Self::config(), channel.into_stream(), handler)
                .await
                .map_err(|e| ConnectError::Transport(e.to_string()))
        })
        .await
    }

    async fn sleep(&self, d: Duration) {
        tokio::time::sleep(d).await;
    }
}

/// Windows formats socket errors in the system language with an OS code; the page wants a
/// short sentence. Anything unrecognised keeps the system's own text.
pub(crate) fn tcp_error(e: &std::io::Error) -> ConnectError {
    use std::io::ErrorKind;
    // WSAHOST_NOT_FOUND, WSANO_DATA: the name did not resolve.
    if matches!(e.raw_os_error(), Some(11001 | 11004)) {
        return ConnectError::Transport("no host by that name".into());
    }
    match e.kind() {
        ErrorKind::ConnectionRefused => {
            ConnectError::Transport("the host refused the connection".into())
        }
        ErrorKind::HostUnreachable | ErrorKind::NetworkUnreachable => {
            ConnectError::Transport("the host can't be reached from this network".into())
        }
        ErrorKind::TimedOut => ConnectError::Timeout,
        _ => ConnectError::Transport(e.to_string()),
    }
}

#[cfg(test)]
mod tcp_error_tests {
    use super::*;
    use std::io::{Error, ErrorKind};

    #[test]
    fn common_failures_read_as_short_sentences() {
        let refused = tcp_error(&Error::from(ErrorKind::ConnectionRefused));
        assert_eq!(
            refused,
            ConnectError::Transport("the host refused the connection".into())
        );
        assert_eq!(
            tcp_error(&Error::from(ErrorKind::TimedOut)),
            ConnectError::Timeout
        );
        assert_eq!(
            tcp_error(&Error::from_raw_os_error(11001)),
            ConnectError::Transport("no host by that name".into())
        );
    }

    #[test]
    fn an_unknown_error_keeps_its_text() {
        let e = Error::other("odd");
        assert_eq!(tcp_error(&e), ConnectError::Transport("odd".into()));
    }
}
