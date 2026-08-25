//! Protocol v2 wire types and framing.
//!
//! `schema/wire.proto` is the single source of truth. Prost types are generated
//! at build time via a vendored `protoc` (see `build.rs`). Framing lives here
//! so Rust and TypeScript share one length-prefix layout.

pub mod frame;

/// Generated prost messages and `FrameKind` for `package tether.v2`.
pub mod wire {
    include!(concat!(env!("OUT_DIR"), "/tether.v2.rs"));
}

pub use frame::{
    concat_frames, encode_frame, DecodedFrame, FrameDecoder, FrameError, FRAME_HEADER_BYTES,
    MAX_FRAME_BYTES,
};
pub use wire::*;
