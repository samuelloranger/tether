//! Tether's rules, with no UI and no network.

pub mod secrets;
pub mod store;
#[cfg(windows)]
pub use secrets::DpapiSecretStore;
pub use secrets::{MemorySecretStore, SecretError, SecretStore, key_account, password_account};
pub use store::DataDir;
