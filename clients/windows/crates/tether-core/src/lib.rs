//! Tether's rules, with no UI and no network.

pub mod edit;
pub mod hints;
pub mod keys;
pub mod prefs;
pub mod profiles;
pub mod secrets;
pub mod store;
#[cfg(windows)]
pub use secrets::DpapiSecretStore;
pub use edit::{PasswordAction, apply_server_form};
pub use hints::{AuthChoice, KeyForm, ServerForm, generate_hint};
pub use keys::{
    KEYS_FILE, KeyError, KeyOrigin, KeyRecord, KeyRecords, algorithm_of, derive_public_line,
    fingerprint, fingerprint_digest, generate_ed25519, import_record, is_encrypted, normalize_pem,
    public_key_body, randomart, short_fingerprint,
};
pub use prefs::{CursorShape, Preferences, TerminalPrefs, ThemeMode, WindowPlacement};
pub use profiles::{
    PROFILES_FILE, Auth, Machine, Profiles, delete_key_warning, keys_subtitle, machines_subtitle,
    used_by_line,
};
pub use secrets::{MemorySecretStore, SecretError, SecretStore, key_account, password_account};
pub use store::DataDir;
