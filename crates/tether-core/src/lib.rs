//! Shared Tether client core.
//!
//! Consumed as a plain crate by the Tauri desktop backend, and (from P4) over
//! UniFFI by the iOS app. Deliberately free of any Tauri or platform
//! dependency.

pub mod deep_link;
pub mod host_health;
pub mod host_store;
pub mod protocol;
pub mod push_deep_link;
pub mod push_registration;
pub mod replay;
pub mod session;
pub mod store;
