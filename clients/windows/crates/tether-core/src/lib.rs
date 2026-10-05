//! Tether's rules, with no UI and no network.

pub mod keys;
pub mod profiles;
pub mod secrets;
pub mod store;
#[cfg(windows)]
pub use secrets::DpapiSecretStore;
pub use keys::{KEYS_FILE, KeyOrigin, KeyRecord, KeyRecords};
pub use profiles::{
    PROFILES_FILE, Auth, Machine, Profiles, delete_key_warning, keys_subtitle, machines_subtitle,
    used_by_line,
};
pub use secrets::{MemorySecretStore, SecretError, SecretStore, key_account, password_account};
pub use store::DataDir;
