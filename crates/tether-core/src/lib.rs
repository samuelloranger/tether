//! Shared Tether client core.
//!
//! Consumed as a plain crate by the Tauri desktop backend, and (from P4) over
//! UniFFI by the iOS app. Deliberately free of any Tauri or platform
//! dependency.

pub mod protocol;
pub mod replay;
