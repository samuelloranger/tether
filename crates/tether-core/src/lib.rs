//! Shared Tether client core: the VT terminal emulator and its grid/replay
//! model, consumed over UniFFI by the iOS app. Deliberately free of any
//! platform or transport dependency.

pub mod deep_link;
pub mod pty_input;
pub mod replay;
pub mod store;
#[cfg(feature = "terminal-parser")]
pub mod terminal;
