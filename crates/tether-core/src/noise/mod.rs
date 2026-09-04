//! Tether's Noise transport: pairing (XXpsk2), reconnect (IK), and a chunked
//! transport with in-band rekey. Wraps the audited `snow` crate behind a
//! misuse-resistant API. The device is always the initiator; the server the
//! responder.

pub mod code;
pub mod pairing;
pub mod params;
pub mod psk;
pub mod reconnect;

use thiserror::Error;

#[derive(Debug, Error)]
pub enum NoiseError {
    #[error("invalid noise parameters")]
    BadParams,
    #[error("handshake failed")]
    Handshake,
    #[error("transport decrypt/encrypt failed")]
    Transport,
    #[error("peer static key was not available")]
    MissingRemoteStatic,
    #[error("enrollment code was malformed")]
    BadCode,
    #[error("key derivation failed")]
    Kdf,
    #[error("frame was malformed")]
    BadFrame,
}
