//! UniFFI facade over [`tether-core`] for the iOS app.

mod deep_link;
mod error;
mod grid_snapshot;
mod replay;
mod terminal;

pub use deep_link::{parse_session_deep_link, FfiSessionDeepLink};
pub use error::FfiCursorError;
pub use grid_snapshot::{
    decode_grid_snapshot, encode_grid_snapshot, grid_snapshot_buffer_size, GridCell,
    GridSnapshotError, GridSnapshotHeader, GRID_ATTR_BOLD, GRID_ATTR_DIM, GRID_ATTR_INVERSE,
    GRID_ATTR_ITALIC, GRID_ATTR_STRIKETHROUGH, GRID_ATTR_UNDERLINE, GRID_CELL_STRIDE,
    GRID_HEADER_SIZE, GRID_SNAPSHOT_MAGIC, GRID_SNAPSHOT_VERSION,
};
pub use replay::FfiReplayStore;
pub use terminal::FfiTerminalEmulator;

uniffi::setup_scaffolding!();
