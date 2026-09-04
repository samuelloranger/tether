//! Async client-side Noise drivers, shared by every native client. They pump
//! the initiator handshake (Plan 1 primitives) over a Transport and return an
//! encrypted session.

use super::pairing::PairingInitiator;
use super::reconnect::ReconnectInitiator;
use super::{NoiseError, NoiseSession};

#[allow(async_fn_in_trait)]
pub trait Transport {
    async fn send(&mut self, frame: Vec<u8>) -> Result<(), NoiseError>;
    async fn recv(&mut self) -> Result<Vec<u8>, NoiseError>;
}

/// Reconnect (IK): the device already knows the pinned server static key.
pub async fn client_reconnect<T: Transport>(
    t: &mut T,
    device_priv: &[u8],
    server_pub: &[u8],
) -> Result<NoiseSession, NoiseError> {
    let mut i = ReconnectInitiator::new(device_priv, server_pub)?;
    let mut buf = [0u8; 65535];
    let n = i.write_message(&[], &mut buf)?; // -> e, es, s, ss
    t.send(buf[..n].to_vec()).await?;
    let msg = t.recv().await?; // <- e, ee, se
    let mut rb = [0u8; 65535];
    i.read_message(&msg, &mut rb)?;
    i.into_transport()
}

/// Pairing (XXpsk2): returns the session and the server's static public key to pin.
pub async fn client_pair<T: Transport>(
    t: &mut T,
    device_priv: &[u8],
    psk: &[u8; 32],
) -> Result<(NoiseSession, Vec<u8>), NoiseError> {
    let mut i = PairingInitiator::new(device_priv, psk)?;
    let mut buf = [0u8; 65535];
    let mut rb = [0u8; 65535];
    let n = i.write_message(&[], &mut buf)?; // -> e
    t.send(buf[..n].to_vec()).await?;
    let msg = t.recv().await?; // <- e, ee, s, es
    i.read_message(&msg, &mut rb)?;
    let server_pub = i.remote_static()?;
    let n = i.write_message(&[], &mut buf)?; // -> s, se
    t.send(buf[..n].to_vec()).await?;
    let session = i.into_transport()?;
    Ok((session, server_pub))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::noise::pairing::{generate_static_keypair, PairingResponder};
    use crate::noise::psk;
    use crate::noise::reconnect::ReconnectResponder;
    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex};

    type Queue = Arc<Mutex<VecDeque<Vec<u8>>>>;

    // An in-memory duplex: each end sends into one queue, receives from the other.
    #[derive(Clone)]
    struct MemChan {
        tx: Queue,
        rx: Queue,
    }
    impl Transport for MemChan {
        async fn send(&mut self, frame: Vec<u8>) -> Result<(), NoiseError> {
            self.tx.lock().unwrap().push_back(frame);
            Ok(())
        }
        async fn recv(&mut self) -> Result<Vec<u8>, NoiseError> {
            loop {
                if let Some(f) = self.rx.lock().unwrap().pop_front() {
                    return Ok(f);
                }
                tokio::time::sleep(std::time::Duration::from_millis(1)).await;
            }
        }
    }

    async fn pop(q: &Queue) -> Vec<u8> {
        loop {
            if let Some(f) = q.lock().unwrap().pop_front() {
                return f;
            }
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
        }
    }

    fn duplex() -> (MemChan, Queue, Queue) {
        let c2s: Queue = Arc::new(Mutex::new(VecDeque::new()));
        let s2c: Queue = Arc::new(Mutex::new(VecDeque::new()));
        (
            MemChan {
                tx: c2s.clone(),
                rx: s2c.clone(),
            },
            c2s,
            s2c,
        )
    }

    #[tokio::test]
    async fn reconnect_driver_completes_and_streams() {
        let server = generate_static_keypair().unwrap();
        let device = generate_static_keypair().unwrap();
        let (mut client, c2s, s2c) = duplex();

        let dev_priv = device.private.clone();
        let srv_pub = server.public.clone();
        let client_task =
            tokio::spawn(async move { client_reconnect(&mut client, &dev_priv, &srv_pub).await });

        let mut r = ReconnectResponder::new(&server.private).unwrap();
        let mut rb = [0u8; 65535];
        let msg1 = pop(&c2s).await;
        r.read_message(&msg1, &mut rb).unwrap();
        let mut buf = [0u8; 65535];
        let n = r.write_message(&[], &mut buf).unwrap();
        s2c.lock().unwrap().push_back(buf[..n].to_vec());
        assert_eq!(r.remote_static().unwrap(), device.public);

        let mut client_session = client_task.await.unwrap().unwrap();
        let mut server_session = r.into_transport().unwrap();

        let wire = client_session.seal(b"hello").unwrap();
        assert_eq!(server_session.open(&wire).unwrap(), b"hello");
    }

    #[tokio::test]
    async fn pair_driver_completes_and_pins_server_key() {
        let server = generate_static_keypair().unwrap();
        let device = generate_static_keypair().unwrap();
        let k = psk::derive("011B23456789").unwrap();
        let (mut client, c2s, s2c) = duplex();

        let dev_priv = device.private.clone();
        let client_task =
            tokio::spawn(async move { client_pair(&mut client, &dev_priv, &k).await });

        let mut r = PairingResponder::new(&server.private, &k).unwrap();
        let mut rb = [0u8; 65535];
        let mut buf = [0u8; 65535];
        // -> e
        let m = pop(&c2s).await;
        r.read_message(&m, &mut rb).unwrap();
        // <- e, ee, s, es
        let n = r.write_message(&[], &mut buf).unwrap();
        s2c.lock().unwrap().push_back(buf[..n].to_vec());
        // -> s, se
        let m = pop(&c2s).await;
        r.read_message(&m, &mut rb).unwrap();

        let (mut client_session, server_pub) = client_task.await.unwrap().unwrap();
        assert_eq!(server_pub, server.public);
        assert_eq!(r.remote_static().unwrap(), device.public);

        let mut server_session = r.into_transport().unwrap();
        let wire = client_session.seal(b"enrolled").unwrap();
        assert_eq!(server_session.open(&wire).unwrap(), b"enrolled");
    }
}
