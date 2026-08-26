//! Shared Tether client core.
//!
//! Consumed as a plain crate by the Tauri desktop backend, and (from P4) over
//! UniFFI by the iOS app. Deliberately free of any Tauri or platform
//! dependency.

pub mod connection_test;
pub mod deep_link;
pub mod file_tree;
pub mod host_client;
pub mod host_health;
pub mod host_polling;
pub mod host_store;
pub mod protocol;
pub mod push_deep_link;
pub mod push_registration;
pub mod replay;
pub mod session;
pub mod session_cache;
pub mod session_host_ops;
pub mod session_polling;
pub mod store;
#[cfg(feature = "terminal-parser")]
pub mod terminal;
pub mod terminal_session_logic;
pub mod tether_app_actions;
pub mod workspace;
