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
        Arc::new(client::Config {
            inactivity_timeout: None,
            keepalive_interval: None,
            nodelay: true,
            channel_buffer_size: 2048,
            ..Default::default()
        })
    }
}

impl Transport for RusshTransport {
    type Conn = RusshConnection;

    async fn dial(
        &self,
        host: &str,
        port: u16,
        timeout: Duration,
    ) -> Result<RusshConnection, ConnectError> {
        let host_key = Arc::new(Mutex::new(None));
        let (events, _) = broadcast::channel(16);
        let dropped = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let handler = ClientHandler {
            host_key: host_key.clone(),
            events: events.clone(),
            dropped: dropped.clone(),
        };
        let addr = format!("{host}:{port}");
        let handshake = async {
            let tcp = TcpStream::connect(&addr)
                .await
                .map_err(|e| ConnectError::Transport(e.to_string()))?;
            let _ = tcp.set_nodelay(true);
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
        let conn = RusshConnection {
            handle: Arc::new(RwLock::new(handle)),
            host_key: digest,
            events,
            runtime: self.runtime.clone(),
            agent: self.agent.clone(),
            dropped,
            keepalive: Default::default(),
        };
        conn.spawn_watcher();
        Ok(conn)
    }

    async fn sleep(&self, d: Duration) {
        tokio::time::sleep(d).await;
    }
}
