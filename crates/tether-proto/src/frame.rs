//! Length-prefixed binary framing, matching `apps/server/src/server/proto/frame.ts`
//! byte for byte:
//!
//! ```text
//! u8  kind
//! u32 len   (big-endian)
//! [len bytes payload]
//! ```
//!
//! Payloads are opaque here. Protocol v2 puts raw PTY bytes behind
//! `FRAME_KIND_OUTPUT` and protobuf behind everything else.

use std::fmt;

/// Bytes in the kind + length prefix.
pub const FRAME_HEADER_BYTES: usize = 5;

/// Hard ceiling on one frame's payload. A single TUI repaint can be hundreds of
/// KB, and replay coalesces 200 rows per frame, so this has to be generous — but
/// it must exist: a desynced or hostile peer otherwise makes us allocate on a
/// 4 GB length prefix.
pub const MAX_FRAME_BYTES: usize = 32 * 1024 * 1024;

/// One decoded frame. `payload` is owned so it does not pin the read buffer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodedFrame {
    pub kind: u8,
    pub payload: Vec<u8>,
}

/// Errors from encode or a streaming decode that cannot resynchronize.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FrameError {
    PayloadTooLarge(usize),
}

impl fmt::Display for FrameError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::PayloadTooLarge(n) => write!(f, "frame payload too large: {n}"),
        }
    }
}

impl std::error::Error for FrameError {}

/// Encodes one frame. `kind` must fit in a byte.
pub fn encode_frame(kind: u8, payload: &[u8]) -> Result<Vec<u8>, FrameError> {
    if payload.len() > MAX_FRAME_BYTES {
        return Err(FrameError::PayloadTooLarge(payload.len()));
    }
    let mut out = Vec::with_capacity(FRAME_HEADER_BYTES + payload.len());
    out.push(kind);
    out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    out.extend_from_slice(payload);
    Ok(out)
}

/// Concatenates frames into one write — one syscall instead of N.
pub fn concat_frames(frames: &[Vec<u8>]) -> Vec<u8> {
    let total: usize = frames.iter().map(|f| f.len()).sum();
    let mut out = Vec::with_capacity(total);
    for f in frames {
        out.extend_from_slice(f);
    }
    out
}

/// Streaming decoder. Sockets hand us arbitrary chunk boundaries, so a frame can
/// arrive split across any number of `push` calls (and several frames can arrive
/// in one).
///
/// Errors on a payload length above `max_frame_bytes`: at that point the stream
/// is desynced and there is no honest way to resynchronize, so the caller must
/// drop the connection rather than guess.
#[derive(Debug, Default)]
pub struct FrameDecoder {
    buf: Vec<u8>,
    max_frame_bytes: usize,
}

impl FrameDecoder {
    pub fn new() -> Self {
        Self {
            buf: Vec::new(),
            max_frame_bytes: MAX_FRAME_BYTES,
        }
    }

    pub fn with_max_frame_bytes(max_frame_bytes: usize) -> Self {
        Self {
            buf: Vec::new(),
            max_frame_bytes,
        }
    }

    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<DecodedFrame>, FrameError> {
        self.buf.extend_from_slice(chunk);

        let mut frames = Vec::new();
        let mut at = 0usize;
        while self.buf.len() - at >= FRAME_HEADER_BYTES {
            let len = u32::from_be_bytes([
                self.buf[at + 1],
                self.buf[at + 2],
                self.buf[at + 3],
                self.buf[at + 4],
            ]) as usize;
            if len > self.max_frame_bytes {
                self.buf.clear();
                return Err(FrameError::PayloadTooLarge(len));
            }
            let end = at + FRAME_HEADER_BYTES + len;
            if self.buf.len() < end {
                break;
            }
            frames.push(DecodedFrame {
                kind: self.buf[at],
                // Owned copy: the payload outlives this buffer (logged, broadcast,
                // queued) and must not pin the whole read buffer alive.
                payload: self.buf[at + FRAME_HEADER_BYTES..end].to_vec(),
            });
            at = end;
        }
        if at > 0 {
            self.buf.drain(..at);
        }
        Ok(frames)
    }

    /// Bytes held back waiting for the rest of a frame.
    pub fn pending(&self) -> usize {
        self.buf.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bytes(v: &[u8]) -> Vec<u8> {
        v.to_vec()
    }

    #[test]
    fn encode_writes_kind_be_length_then_payload() {
        let frame = encode_frame(7, &[0xaa, 0xbb, 0xcc]).unwrap();
        assert_eq!(frame, vec![7, 0, 0, 0, 3, 0xaa, 0xbb, 0xcc]);
    }

    #[test]
    fn empty_payload_is_bare_header() {
        let frame = encode_frame(6, &[]).unwrap();
        assert_eq!(frame.len(), FRAME_HEADER_BYTES);
        assert_eq!(frame, vec![6, 0, 0, 0, 0]);
    }

    #[test]
    fn lengths_above_64kb_stay_exact() {
        let payload = vec![1u8; 70_000];
        let frame = encode_frame(1, &payload).unwrap();
        assert_eq!(&frame[..5], &[1, 0, 1, 0x11, 0x70]);
        let decoded = FrameDecoder::new().push(&frame).unwrap();
        assert_eq!(decoded[0].payload.len(), 70_000);
    }

    #[test]
    fn encode_rejects_oversize_payload() {
        let payload = vec![0u8; MAX_FRAME_BYTES + 1];
        assert!(matches!(
            encode_frame(1, &payload),
            Err(FrameError::PayloadTooLarge(_))
        ));
    }

    #[test]
    fn decoder_round_trips_a_frame() {
        let frames = FrameDecoder::new()
            .push(&encode_frame(3, &[1, 2, 3]).unwrap())
            .unwrap();
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].kind, 3);
        assert_eq!(frames[0].payload, vec![1, 2, 3]);
    }

    #[test]
    fn decoder_several_frames_in_one_chunk() {
        let chunk = concat_frames(&[
            encode_frame(1, &[9]).unwrap(),
            encode_frame(2, &[]).unwrap(),
            encode_frame(3, &[8]).unwrap(),
        ]);
        let frames = FrameDecoder::new().push(&chunk).unwrap();
        assert_eq!(
            frames.iter().map(|f| f.kind).collect::<Vec<_>>(),
            vec![1, 2, 3]
        );
        assert_eq!(frames[0].payload, vec![9]);
        assert!(frames[1].payload.is_empty());
    }

    #[test]
    fn decoder_reassembles_split_byte_by_byte() {
        let mut dec = FrameDecoder::new();
        let frame = encode_frame(4, &[1, 2, 3, 4, 5]).unwrap();
        let mut out: Vec<Vec<u8>> = Vec::new();
        for b in frame {
            for f in dec.push(&[b]).unwrap() {
                out.push(f.payload);
            }
        }
        assert_eq!(out, vec![vec![1, 2, 3, 4, 5]]);
        assert_eq!(dec.pending(), 0);
    }

    #[test]
    fn decoder_holds_partial_header() {
        let mut dec = FrameDecoder::new();
        let frame = encode_frame(5, &[7, 7]).unwrap();
        assert!(dec.push(&frame[..3]).unwrap().is_empty());
        assert_eq!(dec.pending(), 3);
        let frames = dec.push(&frame[3..]).unwrap();
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].payload, vec![7, 7]);
    }

    #[test]
    fn payload_bytes_that_look_like_a_header_do_not_resync() {
        let payload = bytes(&[1, 0, 0, 0, 99, 0x0a, 0x7b, 0x0a]);
        let frames = FrameDecoder::new()
            .push(&encode_frame(1, &payload).unwrap())
            .unwrap();
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].payload, payload);
    }

    #[test]
    fn throws_on_absurd_length_prefix() {
        let mut dec = FrameDecoder::with_max_frame_bytes(1024);
        assert!(matches!(
            dec.push(&[1, 0xff, 0xff, 0xff, 0xff]),
            Err(FrameError::PayloadTooLarge(_))
        ));
    }

    #[test]
    fn decoded_payload_does_not_alias_read_buffer() {
        let mut dec = FrameDecoder::new();
        let chunk = concat_frames(&[
            encode_frame(1, &[1, 1]).unwrap(),
            encode_frame(1, &[2, 2]).unwrap(),
        ]);
        let frames = dec.push(&chunk).unwrap();
        assert_eq!(frames[0].payload, vec![1, 1]);
        assert_eq!(frames[1].payload, vec![2, 2]);
        // Each payload is an owned copy — mutating one must not affect the other.
        let mut first = frames[0].payload.clone();
        first[0] = 9;
        assert_eq!(frames[0].payload[0], 1);
        assert_eq!(first[0], 9);
    }
}
