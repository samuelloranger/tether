//! UniFFI facade over [`tether-core`]. iOS only — desktop links the core directly.

mod deep_link;
mod error;
mod grid_snapshot;
mod host_health;
mod host_store;
mod replay;

pub use deep_link::{
    DeepLinkResolver, DeepLinkSessionCallback, FfiDeepLinkResult, FfiSessionDeepLink,
    HostProfileProvider,
};
pub use error::{FfiCursorError, FfiHostStoreError};
pub use grid_snapshot::{
    decode_grid_snapshot, encode_grid_snapshot, grid_snapshot_buffer_size, GridCell,
    GridSnapshotError, GridSnapshotHeader, GRID_ATTR_BOLD, GRID_ATTR_DIM, GRID_ATTR_INVERSE,
    GRID_ATTR_ITALIC, GRID_ATTR_STRIKETHROUGH, GRID_ATTR_UNDERLINE, GRID_CELL_STRIDE,
    GRID_HEADER_SIZE, GRID_SNAPSHOT_MAGIC, GRID_SNAPSHOT_VERSION,
};
pub use host_health::FfiHostHealth;
pub use host_store::{
    FfiHostProfile, FfiHostProfileChanges, FfiNewHostProfile, HostStorage, HostStoreHandle,
    SecretStore,
};
pub use replay::FfiReplayStore;

uniffi::setup_scaffolding!();
