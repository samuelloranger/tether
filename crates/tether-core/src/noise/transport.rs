//! Chunked framing over a Noise TransportState. snow caps a record at 65535
//! bytes; PTY output exceeds that, so seal() splits plaintext into records and
//! open() reassembles. Nonces live inside TransportState — never exposed.

use snow::TransportState;

use super::NoiseError;

pub const MAX_PLAINTEXT: usize = 65535 - 16;

pub struct NoiseSession {
    ts: TransportState,
}

impl NoiseSession {
    pub(crate) fn from_transport(ts: TransportState) -> Self {
        Self { ts }
    }

    pub fn seal(&mut self, plaintext: &[u8]) -> Result<Vec<u8>, NoiseError> {
        let chunks: Vec<&[u8]> = if plaintext.is_empty() {
            vec![&[]]
        } else {
            plaintext.chunks(MAX_PLAINTEXT).collect()
        };
        let mut wire = Vec::with_capacity(plaintext.len() + chunks.len() * 18 + 4);
        wire.extend_from_slice(&(chunks.len() as u32).to_be_bytes());
        let mut buf = [0u8; 65535];
        for chunk in chunks {
            let n = self
                .ts
                .write_message(chunk, &mut buf)
                .map_err(|_| NoiseError::Transport)?;
            wire.extend_from_slice(&(n as u16).to_be_bytes());
            wire.extend_from_slice(&buf[..n]);
        }
        Ok(wire)
    }

    pub fn open(&mut self, wire: &[u8]) -> Result<Vec<u8>, NoiseError> {
        if wire.len() < 4 {
            return Err(NoiseError::BadFrame);
        }
        let count = u32::from_be_bytes([wire[0], wire[1], wire[2], wire[3]]) as usize;
        let mut pos = 4;
        let mut out = Vec::new();
        let mut buf = [0u8; 65535];
        for _ in 0..count {
            if pos + 2 > wire.len() {
                return Err(NoiseError::BadFrame);
            }
            let len = u16::from_be_bytes([wire[pos], wire[pos + 1]]) as usize;
            pos += 2;
            if pos + len > wire.len() {
                return Err(NoiseError::BadFrame);
            }
            let n = self
                .ts
                .read_message(&wire[pos..pos + len], &mut buf)
                .map_err(|_| NoiseError::Transport)?;
            out.extend_from_slice(&buf[..n]);
            pos += len;
        }
        Ok(out)
    }

    pub fn rekey_outgoing(&mut self) {
        self.ts.rekey_outgoing();
    }
    pub fn rekey_incoming(&mut self) {
        self.ts.rekey_incoming();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::noise::pairing::{generate_static_keypair, PairingInitiator, PairingResponder};
    use crate::noise::psk;

    // Complete a pairing handshake and hand back both transport sessions.
    fn paired_sessions() -> (NoiseSession, NoiseSession) {
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
        (i.into_transport().unwrap(), r.into_transport().unwrap())
    }

    #[test]
    fn small_payload_round_trips() {
        let (mut i, mut r) = paired_sessions();
        let wire = i.seal(b"hello shell").unwrap();
        assert_eq!(r.open(&wire).unwrap(), b"hello shell");
    }

    #[test]
    fn payload_larger_than_one_record_round_trips() {
        let (mut i, mut r) = paired_sessions();
        let big = vec![0xABu8; MAX_PLAINTEXT * 2 + 500]; // 3 records
        let wire = i.seal(&big).unwrap();
        assert_eq!(r.open(&wire).unwrap(), big);
    }

    #[test]
    fn rekey_mid_stream_keeps_the_channel_working() {
        let (mut i, mut r) = paired_sessions();

        // pre-rekey message
        let w = i.seal(b"before").unwrap();
        assert_eq!(r.open(&w).unwrap(), b"before");

        // both sides rotate in sync: sender's outgoing, receiver's incoming
        i.rekey_outgoing();
        r.rekey_incoming();

        // post-rekey message still round-trips
        let w = i.seal(b"after").unwrap();
        assert_eq!(r.open(&w).unwrap(), b"after");
    }
}
