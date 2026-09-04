//! XXpsk2 pairing handshake. Device = initiator, server = responder. The PSK
//! (derived from the enrollment code) gates completion, so a peer without the
//! code cannot finish. After completion both sides know each other's static key.

use curve25519_dalek::montgomery::MontgomeryPoint;
use snow::{Builder, HandshakeState};

use super::{params, NoiseError};

pub struct Keypair {
    pub public: Vec<u8>,
    pub private: Vec<u8>,
}

pub struct PairingInitiator {
    hs: HandshakeState,
}
pub struct PairingResponder {
    hs: HandshakeState,
}

pub fn generate_static_keypair() -> Result<Keypair, NoiseError> {
    let params = params::parse(params::PAIRING_PATTERN)?;
    let kp = Builder::new(params)
        .generate_keypair()
        .map_err(|_| NoiseError::Handshake)?;
    Ok(Keypair {
        public: kp.public,
        private: kp.private,
    })
}

/// Recover the X25519 static public key that pairs with `private`.
///
/// The key store persists only the private scalar; this recomputes the public
/// half so a device can present its own key (and fingerprint) without having
/// kept it. It uses the *same* curve25519 primitive snow uses to derive a
/// keypair's public (`MontgomeryPoint::mul_base_clamped`), so the result is
/// byte-identical to the `public` that `generate_static_keypair` produced for
/// the same `private`. Clamping happens inside the multiply, so a raw
/// (unclamped) stored private — exactly what snow stores — is accepted.
pub fn derive_public(private: &[u8; 32]) -> [u8; 32] {
    MontgomeryPoint::mul_base_clamped(*private).to_bytes()
}

impl PairingInitiator {
    pub fn new(device_priv: &[u8], psk: &[u8; 32]) -> Result<Self, NoiseError> {
        let params = params::parse(params::PAIRING_PATTERN)?;
        let hs = Builder::new(params)
            .local_private_key(device_priv)
            .map_err(|_| NoiseError::Handshake)?
            .prologue(params::PROLOGUE)
            .map_err(|_| NoiseError::Handshake)?
            .psk(2, psk)
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

impl PairingResponder {
    pub fn new(server_priv: &[u8], psk: &[u8; 32]) -> Result<Self, NoiseError> {
        let params = params::parse(params::PAIRING_PATTERN)?;
        let hs = Builder::new(params)
            .local_private_key(server_priv)
            .map_err(|_| NoiseError::Handshake)?
            .prologue(params::PROLOGUE)
            .map_err(|_| NoiseError::Handshake)?
            .psk(2, psk)
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
    use crate::noise::psk;

    fn run_pairing(dev: &Keypair, srv: &Keypair, psk_i: &[u8; 32], psk_r: &[u8; 32]) -> bool {
        let mut i = match PairingInitiator::new(&dev.private, psk_i) {
            Ok(x) => x,
            Err(_) => return false,
        };
        let mut r = match PairingResponder::new(&srv.private, psk_r) {
            Ok(x) => x,
            Err(_) => return false,
        };
        let (mut b, mut rb) = ([0u8; 65535], [0u8; 65535]);
        // -> e
        let Ok(n) = i.write_message(&[], &mut b) else {
            return false;
        };
        if r.read_message(&b[..n], &mut rb).is_err() {
            return false;
        }
        // <- e, ee, s, es
        let Ok(n) = r.write_message(&[], &mut b) else {
            return false;
        };
        if i.read_message(&b[..n], &mut rb).is_err() {
            return false;
        }
        // -> s, se
        let Ok(n) = i.write_message(&[], &mut b) else {
            return false;
        };
        if r.read_message(&b[..n], &mut rb).is_err() {
            return false;
        }
        i.is_finished() && r.is_finished()
    }

    #[test]
    fn derive_public_matches_generated_keypair() {
        // The core guarantee: recomputing the public from the stored private
        // reproduces exactly the public snow handed back at generation time.
        for _ in 0..16 {
            let kp = generate_static_keypair().unwrap();
            let priv32: [u8; 32] = kp.private.as_slice().try_into().unwrap();
            assert_eq!(derive_public(&priv32).to_vec(), kp.public);
        }
    }

    #[test]
    fn derive_public_known_vector() {
        // RFC 7748 §6.1 Alice: private scalar -> public key.
        let priv_hex = "77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a";
        let pub_hex = "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a";
        let mut priv32 = [0u8; 32];
        for (i, b) in priv32.iter_mut().enumerate() {
            *b = u8::from_str_radix(&priv_hex[i * 2..i * 2 + 2], 16).unwrap();
        }
        let got = derive_public(&priv32);
        let got_hex: String = got.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(got_hex, pub_hex);
    }

    #[test]
    fn correct_code_completes_and_reveals_static_keys() {
        let dev = generate_static_keypair().unwrap();
        let srv = generate_static_keypair().unwrap();
        let psk = psk::derive("011B23456789").unwrap();
        let mut i = PairingInitiator::new(&dev.private, &psk).unwrap();
        let mut r = PairingResponder::new(&srv.private, &psk).unwrap();
        let (mut b, mut rb) = ([0u8; 65535], [0u8; 65535]);
        let n = i.write_message(&[], &mut b).unwrap();
        r.read_message(&b[..n], &mut rb).unwrap();
        let n = r.write_message(&[], &mut b).unwrap();
        i.read_message(&b[..n], &mut rb).unwrap();
        let n = i.write_message(&[], &mut b).unwrap();
        r.read_message(&b[..n], &mut rb).unwrap();
        assert!(i.is_finished() && r.is_finished());
        assert_eq!(i.remote_static().unwrap(), srv.public); // device pins server
        assert_eq!(r.remote_static().unwrap(), dev.public); // server learns device
    }

    #[test]
    fn wrong_code_fails_to_complete() {
        let dev = generate_static_keypair().unwrap();
        let srv = generate_static_keypair().unwrap();
        let good = psk::derive("011B23456789").unwrap();
        let bad = psk::derive("011B2345678A").unwrap();
        assert!(!run_pairing(&dev, &srv, &good, &bad));
    }

    #[test]
    fn prologue_mismatch_breaks_the_handshake() {
        use snow::Builder;
        let dev = generate_static_keypair().unwrap();
        let srv = generate_static_keypair().unwrap();
        let psk = psk::derive("011B23456789").unwrap();

        let mut i = PairingInitiator::new(&dev.private, &psk).unwrap();
        // Responder built by hand with the WRONG prologue.
        let p = params::parse(params::PAIRING_PATTERN).unwrap();
        let mut r = Builder::new(p)
            .local_private_key(&srv.private)
            .unwrap()
            .prologue(b"tether-noise/2")
            .unwrap()
            .psk(2, &psk)
            .unwrap()
            .build_responder()
            .unwrap();

        // Drive the whole handshake; a differing prologue diverges the transcript
        // hash, so the handshake must fail at *some* step and never fully
        // complete on both sides. We don't care which step trips.
        let (mut b, mut rb) = ([0u8; 65535], [0u8; 65535]);
        let completed = (|| -> Option<()> {
            let n = i.write_message(&[], &mut b).ok()?; // -> e
            r.read_message(&b[..n], &mut rb).ok()?;
            let n = r.write_message(&[], &mut b).ok()?; // <- e, ee, s, es
            i.read_message(&b[..n], &mut rb).ok()?;
            let n = i.write_message(&[], &mut b).ok()?; // -> s, se
            r.read_message(&b[..n], &mut rb).ok()?;
            Some(())
        })();
        assert!(completed.is_none() || !(i.is_finished() && r.is_handshake_finished()));
    }
}
