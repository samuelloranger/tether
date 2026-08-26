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

pub struct KeyringHostSecrets;

fn secure_entry(host_id: &str) -> Result<keyring::Entry, HostStoreError> {
    keyring::Entry::new("tether-desktop", &format!("server-password-{host_id}"))
        .map_err(|error| HostStoreError::Secret(error.to_string()))
}

fn legacy_secure_entry() -> Result<keyring::Entry, HostStoreError> {
    keyring::Entry::new("tether-desktop", "server-password")
        .map_err(|error| HostStoreError::Secret(error.to_string()))
}

impl HostSecrets for KeyringHostSecrets {
    fn get(&self, host_id: &str) -> Result<Option<String>, HostStoreError> {
        match secure_entry(host_id)?.get_password() {
            Ok(password) => Ok(Some(password)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(HostStoreError::Secret(error.to_string())),
        }
    }

    fn set(&self, host_id: &str, password: &str) -> Result<(), HostStoreError> {
        secure_entry(host_id)?
            .set_password(password)
            .map_err(|error| HostStoreError::Secret(error.to_string()))
    }

    fn clear(&self, host_id: &str) -> Result<(), HostStoreError> {
        match secure_entry(host_id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(HostStoreError::Secret(error.to_string())),
        }
    }

    fn get_legacy(&self) -> Result<Option<String>, HostStoreError> {
        match legacy_secure_entry()?.get_password() {
            Ok(password) => Ok(Some(password)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(HostStoreError::Secret(error.to_string())),
        }
    }

    fn clear_legacy(&self) -> Result<(), HostStoreError> {
        match legacy_secure_entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(HostStoreError::Secret(error.to_string())),
        }
    }
}

pub type DesktopHostStore = HostStore<FileHostStorage, KeyringHostSecrets, fn() -> String>;

pub fn new_host_store(path: PathBuf) -> DesktopHostStore {
    HostStore::new(FileHostStorage::new(path), KeyringHostSecrets, || {
        uuid::Uuid::new_v4().to_string()
    })
}
