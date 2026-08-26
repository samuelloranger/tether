use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use tether_core::host_store::{HostSecrets, HostStorage, HostStore, HostStoreError};

pub struct FileHostStorage {
    path: PathBuf,
    lock: Mutex<()>,
}

impl FileHostStorage {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            lock: Mutex::new(()),
        }
    }

    fn read_map(&self) -> Result<HashMap<String, String>, HostStoreError> {
        if !self.path.exists() {
            return Ok(HashMap::new());
        }
        let raw = fs::read_to_string(&self.path)
            .map_err(|error| HostStoreError::Storage(error.to_string()))?;
        if raw.trim().is_empty() {
            return Ok(HashMap::new());
        }
        serde_json::from_str(&raw).map_err(|error| HostStoreError::Storage(error.to_string()))
    }

    fn write_map(&self, map: &HashMap<String, String>) -> Result<(), HostStoreError> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| HostStoreError::Storage(error.to_string()))?;
        }
        let raw = serde_json::to_string_pretty(map)
            .map_err(|error| HostStoreError::Storage(error.to_string()))?;
        fs::write(&self.path, raw).map_err(|error| HostStoreError::Storage(error.to_string()))
    }
}

impl HostStorage for FileHostStorage {
    fn get_item(&self, key: &str) -> Result<Option<String>, HostStoreError> {
        let _guard = self
            .lock
            .lock()
            .map_err(|error| HostStoreError::Storage(error.to_string()))?;
        Ok(self.read_map()?.get(key).cloned())
    }

    fn set_item(&self, key: &str, value: String) -> Result<(), HostStoreError> {
        let _guard = self
            .lock
            .lock()
            .map_err(|error| HostStoreError::Storage(error.to_string()))?;
        let mut map = self.read_map()?;
        map.insert(key.to_string(), value);
        self.write_map(&map)
    }

    fn remove_item(&self, key: &str) -> Result<(), HostStoreError> {
        let _guard = self
            .lock
            .lock()
            .map_err(|error| HostStoreError::Storage(error.to_string()))?;
        let mut map = self.read_map()?;
        map.remove(key);
        self.write_map(&map)
    }
}

/// Turns a keyring failure into something the user can act on.
///
/// The platform errors are useless alone. A locked macOS login keychain reports
/// only "User interaction is not allowed" — it never mentions the keychain, and
/// the app cannot prompt its way out of it. A Linux box with no Secret Service
/// running reports a D-Bus failure. Driving the real app found that this
/// dead-ends host setup with nothing the user can do about it, so the hint has
/// to come from here; the raw error is kept for the bug report.
pub fn secret_error_message(error: &keyring::Error) -> String {
    let raw = error.to_string();
    if raw.contains("User interaction is not allowed") {
        return format!("{} ({raw})", locked_store_hint());
    }
    match error {
        keyring::Error::NoStorageAccess(_) => format!("{} ({raw})", no_store_hint()),
        _ => raw,
    }
}

fn locked_store_hint() -> &'static str {
    if cfg!(target_os = "macos") {
        "Your login keychain is locked, so the password could not be saved. \
Unlock it in Keychain Access — select the login keychain, then File → Unlock \
Keychain — and try again."
    } else {
        "The system secret store is locked, so the password could not be saved. \
Unlock your keyring and try again."
    }
}

fn no_store_hint() -> &'static str {
    if cfg!(target_os = "macos") {
        "macOS would not give this app access to the keychain, so the password \
could not be saved."
    } else {
        "No secret service is running, so the password could not be saved. Start \
a keyring service (gnome-keyring or kwallet) and try again."
    }
}

pub struct KeyringHostSecrets;

fn secure_entry(host_id: &str) -> Result<keyring::Entry, HostStoreError> {
    keyring::Entry::new("tether-desktop", &format!("server-password-{host_id}"))
        .map_err(|error| HostStoreError::Secret(secret_error_message(&error)))
}

fn legacy_secure_entry() -> Result<keyring::Entry, HostStoreError> {
    keyring::Entry::new("tether-desktop", "server-password")
        .map_err(|error| HostStoreError::Secret(secret_error_message(&error)))
}

impl HostSecrets for KeyringHostSecrets {
    fn get(&self, host_id: &str) -> Result<Option<String>, HostStoreError> {
        match secure_entry(host_id)?.get_password() {
            Ok(password) => Ok(Some(password)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(HostStoreError::Secret(secret_error_message(&error))),
        }
    }

    fn set(&self, host_id: &str, password: &str) -> Result<(), HostStoreError> {
        secure_entry(host_id)?
            .set_password(password)
            .map_err(|error| HostStoreError::Secret(secret_error_message(&error)))
    }

    fn clear(&self, host_id: &str) -> Result<(), HostStoreError> {
        match secure_entry(host_id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(HostStoreError::Secret(secret_error_message(&error))),
        }
    }

    fn get_legacy(&self) -> Result<Option<String>, HostStoreError> {
        match legacy_secure_entry()?.get_password() {
            Ok(password) => Ok(Some(password)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(HostStoreError::Secret(secret_error_message(&error))),
        }
    }

    fn clear_legacy(&self) -> Result<(), HostStoreError> {
        match legacy_secure_entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(HostStoreError::Secret(secret_error_message(&error))),
        }
    }
}

pub type DesktopHostStore = HostStore<FileHostStorage, KeyringHostSecrets, fn() -> String>;

pub fn new_host_store(path: PathBuf) -> DesktopHostStore {
    HostStore::new(FileHostStorage::new(path), KeyringHostSecrets, || {
        uuid::Uuid::new_v4().to_string()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn platform_failure(message: &str) -> keyring::Error {
        keyring::Error::PlatformFailure(Box::new(std::io::Error::other(message.to_string())))
    }

    #[test]
    fn a_locked_store_is_explained_rather_than_echoed() {
        let message = secret_error_message(&platform_failure(
            "Platform secure storage failure: User interaction is not allowed.",
        ));
        assert!(
            message.to_lowercase().contains("locked"),
            "the user is not told the store is locked: {message}"
        );
        assert!(
            message.contains("User interaction is not allowed"),
            "the raw error must survive for bug reports: {message}"
        );
    }

    #[test]
    fn a_missing_secret_service_is_explained() {
        let message = secret_error_message(&keyring::Error::NoStorageAccess(Box::new(
            std::io::Error::other("dbus: no such service"),
        )));
        assert!(
            message.contains("could not be saved"),
            "no actionable hint for a missing store: {message}"
        );
    }

    /// Anything we do not recognise must pass through untouched — inventing a
    /// hint for an unknown failure would send the user after the wrong thing.
    #[test]
    fn an_unrecognised_failure_is_passed_through_verbatim() {
        let error = platform_failure("something else entirely");
        assert_eq!(secret_error_message(&error), error.to_string());
    }
}
