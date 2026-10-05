use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use russh::Disconnect;
use russh::client;
use russh::client::AuthResult;
use russh::keys::{PrivateKeyWithHashAlg, decode_secret_key};
use tether_core::connect::{ConnectError, Connection, Credential};
use tokio::sync::{RwLock, broadcast};

use crate::agent::AgentConnector;
use crate::handler::ClientHandler;

const MISSES_FOR_DROP: u8 = 2;
const WATCH_EVERY: Duration = Duration::from_millis(250);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConnectionEvent {
    Dropped,
}

#[derive(Default)]
pub(crate) struct Misses(u8);

impl Misses {
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

    pub fn is_closed(&self) -> bool {
        self.handle
            .try_read()
            .map(|h| h.is_closed())
            .unwrap_or(false)
    }

    pub async fn close(&self) {
        self.dropped.store(true, Ordering::SeqCst);
        if let Some(task) = self.keepalive.lock().unwrap().take() {
            task.abort();
        }
        let _ = self
            .handle
            .read()
            .await
            .disconnect(Disconnect::ByApplication, "", "en")
            .await;
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

impl Drop for RusshConnection {
    fn drop(&mut self) {
        self.dropped.store(true, Ordering::SeqCst);
        if let Some(task) = self.keepalive.lock().unwrap().take() {
            task.abort();
        }
    }
}

fn transport(e: impl std::fmt::Display) -> ConnectError {
    ConnectError::Transport(e.to_string())
}

fn auth_outcome(result: AuthResult) -> Result<(), ConnectError> {
    if result.success() {
        Ok(())
    } else {
        Err(ConnectError::AuthRejected)
    }
}

impl Connection for RusshConnection {
    fn host_key_sha256(&self) -> [u8; 32] {
        self.host_key
    }

    async fn authenticate(&mut self, user: &str, cred: Credential) -> Result<(), ConnectError> {
        let mut handle = self.handle.write().await;
        match cred {
            Credential::Password(password) => {
                let result = handle
                    .authenticate_password(user, password.as_str())
                    .await
                    .map_err(transport)?;
                auth_outcome(result)
            }
            Credential::Key(pem) => {
                let key = decode_secret_key(pem.as_str(), None).map_err(transport)?;
                let hash = if key.algorithm().is_rsa() {
                    handle
                        .best_supported_rsa_hash()
                        .await
                        .map_err(transport)?
                        .flatten()
                } else {
                    None
                };
                let result = handle
                    .authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(key), hash))
                    .await
                    .map_err(transport)?;
                auth_outcome(result)
            }
            Credential::Agent => {
                crate::agent::authenticate_with_agent(&mut handle, user, &*self.agent).await
            }
        }
    }

    fn start_keepalive(&mut self, every: Duration) {
        let handle = self.handle.clone();
        let events = self.events.clone();
        let dropped = self.dropped.clone();
        let task = self.runtime.spawn(async move {
            let mut misses = Misses::default();
            let mut tick = tokio::time::interval(every);
            tick.tick().await;
            loop {
                tick.tick().await;
                let ping = async { handle.read().await.send_ping().await };
                match tokio::time::timeout(every, ping).await {
                    Ok(Ok(())) => misses.replied(),
                    Ok(Err(_)) => break,
                    Err(_) if misses.missed() => break,
                    Err(_) => {}
                }
            }
            if !dropped.load(Ordering::SeqCst) {
                report_drop(&events, &dropped);
                let _ = handle
                    .read()
                    .await
                    .disconnect(Disconnect::ByApplication, "keepalive timeout", "en")
                    .await;
            }
        });
        if let Some(old) = self.keepalive.lock().unwrap().replace(task) {
            old.abort();
        }
    }

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
                russh::ChannelMsg::Failure => {
                    return Err(ConnectError::Transport(
                        "the host refused the command".into(),
                    ));
                }
                russh::ChannelMsg::Close => break,
                _ => {}
            }
        }
        Ok(String::from_utf8_lossy(&stdout).into_owned())
    }
}

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
