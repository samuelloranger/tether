use std::sync::{Arc, Mutex};

use russh::client::{self, DisconnectReason};
use russh::keys::{PublicKey, PublicKeyOrCertificate};
use sha2::{Digest, Sha256};
use tokio::sync::broadcast;

use crate::ConnectionEvent;

pub(crate) struct ClientHandler {
    pub(crate) host_key: Arc<Mutex<Option<[u8; 32]>>>,
    pub(crate) events: broadcast::Sender<ConnectionEvent>,
    pub(crate) dropped: Arc<std::sync::atomic::AtomicBool>,
}

pub(crate) fn host_key_digest(key: &PublicKey) -> Option<[u8; 32]> {
    let blob = key.to_bytes().ok()?;
    Some(Sha256::digest(&blob).into())
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let Some(digest) = host_key_digest(&key.public_key()) else {
            return Ok(false);
        };
        let mut slot = self.host_key.lock().unwrap();
        match *slot {
            None => {
                *slot = Some(digest);
                Ok(true)
            }
            Some(first) => Ok(first == digest),
        }
    }

    async fn disconnected(
        &mut self,
        reason: DisconnectReason<Self::Error>,
    ) -> Result<(), Self::Error> {
        crate::connection::report_drop(&self.events, &self.dropped);
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
        ClientHandler {
            host_key: Arc::new(Mutex::new(None)),
            events,
            dropped: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }

    fn key() -> PublicKey {
        PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519)
            .unwrap()
            .public_key()
            .clone()
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
