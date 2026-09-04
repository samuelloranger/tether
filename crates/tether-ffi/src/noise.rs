//! UniFFI surface over `tether-core::noise` for the iOS client. Swift drives the
//! handshake pump (write/read one message at a time over its own WebSocket),
//! exactly as the Bun server binding does over `bun:ffi`. No key/nonce bytes are
//! exposed beyond the device's own keypair, the pinned server key, and the PSK.

use std::sync::Mutex;

use thiserror::Error;

use tether_core::noise::pairing::{
    derive_public, generate_static_keypair, PairingInitiator, PairingResponder,
};
use tether_core::noise::reconnect::{ReconnectInitiator, ReconnectResponder};
use tether_core::noise::{code, psk, NoiseError, NoiseSession};

#[derive(Debug, Error, uniffi::Error)]
pub enum FfiNoiseError {
    #[error("noise handshake failed")]
    Handshake,
    #[error("noise transport failed")]
    Transport,
    #[error("peer static key unavailable")]
    MissingRemoteStatic,
    #[error("enrollment code malformed")]
    BadCode,
    #[error("key derivation failed")]
    Kdf,
    #[error("wrong session state for this operation")]
    State,
}

impl From<NoiseError> for FfiNoiseError {
    fn from(e: NoiseError) -> Self {
        match e {
            NoiseError::Handshake | NoiseError::BadParams => Self::Handshake,
            NoiseError::Transport | NoiseError::BadFrame => Self::Transport,
            NoiseError::MissingRemoteStatic => Self::MissingRemoteStatic,
            NoiseError::BadCode => Self::BadCode,
            NoiseError::Kdf => Self::Kdf,
        }
    }
}

#[derive(uniffi::Record)]
pub struct FfiNoiseKeypair {
    pub public: Vec<u8>,
    pub private: Vec<u8>,
}

#[uniffi::export]
pub fn noise_gen_keypair() -> Result<FfiNoiseKeypair, FfiNoiseError> {
    let kp = generate_static_keypair()?;
    Ok(FfiNoiseKeypair {
        public: kp.public,
        private: kp.private,
    })
}

#[uniffi::export]
pub fn noise_derive_psk(code: String) -> Result<Vec<u8>, FfiNoiseError> {
    let normalized = code::normalize(&code)?;
    Ok(psk::derive(&normalized)?.to_vec())
}

/// Recover the device's own static public key from its stored private key, so a
/// client can present its public (and fingerprint) without having persisted it.
/// Returns byte-identical output to the `public` from `noise_gen_keypair`.
/// A private key that is not exactly 32 bytes is rejected as `Handshake`.
#[uniffi::export]
pub fn noise_derive_public(private: Vec<u8>) -> Result<Vec<u8>, FfiNoiseError> {
    Ok(derive_public(&take32(&private)?).to_vec())
}

enum Handshake {
    PairInit(PairingInitiator),
    PairResp(PairingResponder),
    ReconInit(ReconnectInitiator),
    ReconResp(ReconnectResponder),
}

enum Inner {
    // Boxed: the snow handshake/transport states dwarf the empty variant.
    Hs(Box<Handshake>),
    Ts(Box<NoiseSession>),
    // Transient state while into_transport swaps; never observed by callers.
    Empty,
}

/// One Noise session: a handshake that Swift pumps message-by-message, then a
/// transport for `seal`/`open`.
#[derive(uniffi::Object)]
pub struct FfiNoiseSession {
    inner: Mutex<Inner>,
}

impl FfiNoiseSession {
    fn wrap(hs: Handshake) -> std::sync::Arc<Self> {
        std::sync::Arc::new(Self {
            inner: Mutex::new(Inner::Hs(Box::new(hs))),
        })
    }
}

fn take32(bytes: &[u8]) -> Result<[u8; 32], FfiNoiseError> {
    bytes.try_into().map_err(|_| FfiNoiseError::Handshake)
}

#[uniffi::export]
impl FfiNoiseSession {
    #[uniffi::constructor]
    pub fn pair_initiator(
        device_priv: Vec<u8>,
        psk: Vec<u8>,
    ) -> Result<std::sync::Arc<Self>, FfiNoiseError> {
        Ok(Self::wrap(Handshake::PairInit(PairingInitiator::new(
            &device_priv,
            &take32(&psk)?,
        )?)))
    }

    #[uniffi::constructor]
    pub fn pair_responder(
        server_priv: Vec<u8>,
        psk: Vec<u8>,
    ) -> Result<std::sync::Arc<Self>, FfiNoiseError> {
        Ok(Self::wrap(Handshake::PairResp(PairingResponder::new(
            &server_priv,
            &take32(&psk)?,
        )?)))
    }

    #[uniffi::constructor]
    pub fn reconnect_initiator(
        device_priv: Vec<u8>,
        server_pub: Vec<u8>,
    ) -> Result<std::sync::Arc<Self>, FfiNoiseError> {
        Ok(Self::wrap(Handshake::ReconInit(ReconnectInitiator::new(
            &device_priv,
            &server_pub,
        )?)))
    }

    #[uniffi::constructor]
    pub fn reconnect_responder(
        server_priv: Vec<u8>,
    ) -> Result<std::sync::Arc<Self>, FfiNoiseError> {
        Ok(Self::wrap(Handshake::ReconResp(ReconnectResponder::new(
            &server_priv,
        )?)))
    }

    pub fn write_message(&self, payload: Vec<u8>) -> Result<Vec<u8>, FfiNoiseError> {
        let mut guard = self.inner.lock().unwrap();
        let Inner::Hs(hs) = &mut *guard else {
            return Err(FfiNoiseError::State);
        };
        let mut buf = [0u8; 65535];
        let n = match hs.as_mut() {
            Handshake::PairInit(x) => x.write_message(&payload, &mut buf),
            Handshake::PairResp(x) => x.write_message(&payload, &mut buf),
            Handshake::ReconInit(x) => x.write_message(&payload, &mut buf),
            Handshake::ReconResp(x) => x.write_message(&payload, &mut buf),
        }?;
        Ok(buf[..n].to_vec())
    }

    pub fn read_message(&self, message: Vec<u8>) -> Result<Vec<u8>, FfiNoiseError> {
        let mut guard = self.inner.lock().unwrap();
        let Inner::Hs(hs) = &mut *guard else {
            return Err(FfiNoiseError::State);
        };
        let mut buf = [0u8; 65535];
        let n = match hs.as_mut() {
            Handshake::PairInit(x) => x.read_message(&message, &mut buf),
            Handshake::PairResp(x) => x.read_message(&message, &mut buf),
            Handshake::ReconInit(x) => x.read_message(&message, &mut buf),
            Handshake::ReconResp(x) => x.read_message(&message, &mut buf),
        }?;
        Ok(buf[..n].to_vec())
    }

    pub fn is_finished(&self) -> bool {
        match &*self.inner.lock().unwrap() {
            Inner::Hs(hs) => match hs.as_ref() {
                Handshake::PairInit(x) => x.is_finished(),
                Handshake::PairResp(x) => x.is_finished(),
                Handshake::ReconInit(x) => x.is_finished(),
                Handshake::ReconResp(x) => x.is_finished(),
            },
            Inner::Ts(_) => true,
            Inner::Empty => false,
        }
    }

    pub fn remote_static(&self) -> Result<Vec<u8>, FfiNoiseError> {
        let guard = self.inner.lock().unwrap();
        let Inner::Hs(hs) = &*guard else {
            return Err(FfiNoiseError::State);
        };
        match hs.as_ref() {
            Handshake::PairInit(x) => Ok(x.remote_static()?),
            Handshake::PairResp(x) => Ok(x.remote_static()?),
            Handshake::ReconResp(x) => Ok(x.remote_static()?),
            Handshake::ReconInit(_) => Err(FfiNoiseError::State),
        }
    }

    pub fn into_transport(&self) -> Result<(), FfiNoiseError> {
        let mut guard = self.inner.lock().unwrap();
        let Inner::Hs(hs) = std::mem::replace(&mut *guard, Inner::Empty) else {
            return Err(FfiNoiseError::State);
        };
        let ts = match *hs {
            Handshake::PairInit(x) => x.into_transport(),
            Handshake::PairResp(x) => x.into_transport(),
            Handshake::ReconInit(x) => x.into_transport(),
            Handshake::ReconResp(x) => x.into_transport(),
        };
        match ts {
            Ok(session) => {
                *guard = Inner::Ts(Box::new(session));
                Ok(())
            }
            Err(e) => Err(e.into()),
        }
    }

    pub fn seal(&self, plaintext: Vec<u8>) -> Result<Vec<u8>, FfiNoiseError> {
        let mut guard = self.inner.lock().unwrap();
        let Inner::Ts(ts) = &mut *guard else {
            return Err(FfiNoiseError::State);
        };
        Ok(ts.seal(&plaintext)?)
    }

    pub fn open(&self, wire: Vec<u8>) -> Result<Vec<u8>, FfiNoiseError> {
        let mut guard = self.inner.lock().unwrap();
        let Inner::Ts(ts) = &mut *guard else {
            return Err(FfiNoiseError::State);
        };
        Ok(ts.open(&wire)?)
    }

    pub fn rekey_outgoing(&self) -> Result<(), FfiNoiseError> {
        let mut guard = self.inner.lock().unwrap();
        let Inner::Ts(ts) = &mut *guard else {
            return Err(FfiNoiseError::State);
        };
        ts.rekey_outgoing();
        Ok(())
    }

    pub fn rekey_incoming(&self) -> Result<(), FfiNoiseError> {
        let mut guard = self.inner.lock().unwrap();
        let Inner::Ts(ts) = &mut *guard else {
            return Err(FfiNoiseError::State);
        };
        ts.rekey_incoming();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pair_then_transport_through_the_uniffi_surface() {
        let server = noise_gen_keypair().unwrap();
        let device = noise_gen_keypair().unwrap();
        let psk = noise_derive_psk("011B-2345-6789".to_string()).unwrap();

        let i = FfiNoiseSession::pair_initiator(device.private.clone(), psk.clone()).unwrap();
        let r = FfiNoiseSession::pair_responder(server.private.clone(), psk).unwrap();

        r.read_message(i.write_message(vec![]).unwrap()).unwrap(); // -> e
        i.read_message(r.write_message(vec![]).unwrap()).unwrap(); // <- e,ee,s,es
        r.read_message(i.write_message(vec![]).unwrap()).unwrap(); // -> s,se

        assert!(i.is_finished() && r.is_finished());
        assert_eq!(r.remote_static().unwrap(), device.public);

        i.into_transport().unwrap();
        r.into_transport().unwrap();

        let sealed = i.seal(b"hello ios".to_vec()).unwrap();
        assert_eq!(r.open(sealed).unwrap(), b"hello ios");
    }

    #[test]
    fn derive_public_recovers_keypair_public_through_the_uniffi_surface() {
        let kp = noise_gen_keypair().unwrap();
        let recovered = noise_derive_public(kp.private.clone()).unwrap();
        assert_eq!(recovered, kp.public);
    }

    #[test]
    fn derive_public_rejects_bad_length() {
        assert!(matches!(
            noise_derive_public(vec![0u8; 31]),
            Err(FfiNoiseError::Handshake)
        ));
    }

    #[test]
    fn reconnect_through_the_uniffi_surface() {
        let server = noise_gen_keypair().unwrap();
        let device = noise_gen_keypair().unwrap();

        let i = FfiNoiseSession::reconnect_initiator(device.private.clone(), server.public.clone())
            .unwrap();
        let r = FfiNoiseSession::reconnect_responder(server.private.clone()).unwrap();

        r.read_message(i.write_message(vec![]).unwrap()).unwrap();
        i.read_message(r.write_message(vec![]).unwrap()).unwrap();

        assert!(i.is_finished() && r.is_finished());
        assert_eq!(r.remote_static().unwrap(), device.public);

        i.into_transport().unwrap();
        r.into_transport().unwrap();
        let sealed = i.seal(b"reconnected".to_vec()).unwrap();
        assert_eq!(r.open(sealed).unwrap(), b"reconnected");
    }
}
