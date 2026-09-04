//! IK reconnect handshake. Device = initiator and already knows (pinned) the
//! server's static key; server = responder and learns the device's static key.
//! Completing IK proves key possession only — the caller must look the device
//! key up in the registry to authorize (see spec).

use snow::{Builder, HandshakeState};

use super::{params, NoiseError};

pub struct ReconnectInitiator {
    hs: HandshakeState,
}
pub struct ReconnectResponder {
    hs: HandshakeState,
}

impl ReconnectInitiator {
    pub fn new(device_priv: &[u8], server_pub_pinned: &[u8]) -> Result<Self, NoiseError> {
        let params = params::parse(params::RECONNECT_PATTERN)?;
        let hs = Builder::new(params)
            .local_private_key(device_priv)
            .map_err(|_| NoiseError::Handshake)?
            .remote_public_key(server_pub_pinned)
            .map_err(|_| NoiseError::Handshake)?
            .prologue(params::PROLOGUE)
            .map_err(|_| NoiseError::Handshake)?
            .build_initiator()
            .map_err(|_| NoiseError::Handshake)?;
        Ok(Self { hs })
    }
    pub fn write_message(&mut self, payload: &[u8], out: &mut [u8]) -> Result<usize, NoiseError> {
        self.hs
            .write_message(payload, out)
            .map_err(|_| NoiseError::Handshake)
    }
    pub fn read_message(&mut self, msg: &[u8], out: &mut [u8]) -> Result<usize, NoiseError> {
        self.hs
            .read_message(msg, out)
            .map_err(|_| NoiseError::Handshake)
    }
    pub fn is_finished(&self) -> bool {
        self.hs.is_handshake_finished()
    }
    pub fn into_transport(self) -> Result<super::transport::NoiseSession, NoiseError> {
        let ts = self
            .hs
            .into_transport_mode()
            .map_err(|_| NoiseError::Transport)?;
        Ok(super::transport::NoiseSession::from_transport(ts))
    }
}

impl ReconnectResponder {
    pub fn new(server_priv: &[u8]) -> Result<Self, NoiseError> {
        let params = params::parse(params::RECONNECT_PATTERN)?;
        let hs = Builder::new(params)
            .local_private_key(server_priv)
            .map_err(|_| NoiseError::Handshake)?
            .prologue(params::PROLOGUE)
            .map_err(|_| NoiseError::Handshake)?
            .build_responder()
            .map_err(|_| NoiseError::Handshake)?;
        Ok(Self { hs })
    }
    pub fn write_message(&mut self, payload: &[u8], out: &mut [u8]) -> Result<usize, NoiseError> {
        self.hs
            .write_message(payload, out)
            .map_err(|_| NoiseError::Handshake)
    }
    pub fn read_message(&mut self, msg: &[u8], out: &mut [u8]) -> Result<usize, NoiseError> {
        self.hs
            .read_message(msg, out)
            .map_err(|_| NoiseError::Handshake)
    }
    pub fn is_finished(&self) -> bool {
        self.hs.is_handshake_finished()
    }
    pub fn remote_static(&self) -> Result<Vec<u8>, NoiseError> {
        self.hs
            .get_remote_static()
            .map(|s| s.to_vec())
            .ok_or(NoiseError::MissingRemoteStatic)
    }
    pub fn into_transport(self) -> Result<super::transport::NoiseSession, NoiseError> {
        let ts = self
            .hs
            .into_transport_mode()
            .map_err(|_| NoiseError::Transport)?;
        Ok(super::transport::NoiseSession::from_transport(ts))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::noise::pairing::generate_static_keypair;

    #[test]
    fn ik_completes_and_server_learns_device_key() {
        let dev = generate_static_keypair().unwrap();
        let srv = generate_static_keypair().unwrap();

        let mut i = ReconnectInitiator::new(&dev.private, &srv.public).unwrap();
        let mut r = ReconnectResponder::new(&srv.private).unwrap();
        let (mut b, mut rb) = ([0u8; 65535], [0u8; 65535]);
        // -> e, es, s, ss
        let n = i.write_message(&[], &mut b).unwrap();
        r.read_message(&b[..n], &mut rb).unwrap();
        // <- e, ee, se
        let n = r.write_message(&[], &mut b).unwrap();
        i.read_message(&b[..n], &mut rb).unwrap();

        assert!(i.is_finished() && r.is_finished());
        assert_eq!(r.remote_static().unwrap(), dev.public);
    }

    #[test]
    fn ik_against_the_wrong_server_key_fails() {
        let dev = generate_static_keypair().unwrap();
        let srv = generate_static_keypair().unwrap();
        let impostor = generate_static_keypair().unwrap();

        // Device pins the impostor's key, but the real responder holds srv.
        let mut i = ReconnectInitiator::new(&dev.private, &impostor.public).unwrap();
        let mut r = ReconnectResponder::new(&srv.private).unwrap();
        let (mut b, mut rb) = ([0u8; 65535], [0u8; 65535]);
        let n = i.write_message(&[], &mut b).unwrap();
        // Responder cannot decrypt msg1 (encrypted to the impostor key).
        assert!(r.read_message(&b[..n], &mut rb).is_err());
    }
}
