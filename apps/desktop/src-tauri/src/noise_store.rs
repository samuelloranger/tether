use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use tether_core::host_store::HostStoreError;

use crate::storage::secret_error_message;

/// Injected secret backend so tests never touch the real keyring.
pub trait KeyStore {
    fn set(&self, account: &str, value: &str) -> Result<(), HostStoreError>;
    fn get(&self, account: &str) -> Result<Option<String>, HostStoreError>;
}

pub struct KeyringKeyStore;

impl KeyStore for KeyringKeyStore {
    fn set(&self, account: &str, value: &str) -> Result<(), HostStoreError> {
        keyring::Entry::new("tether-desktop", account)
            .map_err(|error| HostStoreError::Secret(secret_error_message(&error)))?
            .set_password(value)
            .map_err(|error| HostStoreError::Secret(secret_error_message(&error)))
    }

    fn get(&self, account: &str) -> Result<Option<String>, HostStoreError> {
        match keyring::Entry::new("tether-desktop", account)
            .map_err(|error| HostStoreError::Secret(secret_error_message(&error)))?
            .get_password()
        {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(HostStoreError::Secret(secret_error_message(&error))),
        }
    }
}

fn device_account(host_id: &str) -> String {
    format!("noise-device-key-{host_id}")
}

fn server_account(host_id: &str) -> String {
    format!("noise-server-key-{host_id}")
}

pub fn save_device_keypair_in<K: KeyStore>(
    store: &K,
    host_id: &str,
    private: &[u8],
) -> Result<(), HostStoreError> {
    store.set(&device_account(host_id), &BASE64.encode(private))
}

pub fn load_device_keypair_in<K: KeyStore>(
    store: &K,
    host_id: &str,
) -> Result<Option<Vec<u8>>, HostStoreError> {
    load_bytes(store, &device_account(host_id))
}

pub fn save_pinned_server_key_in<K: KeyStore>(
    store: &K,
    host_id: &str,
    public: &[u8],
) -> Result<(), HostStoreError> {
    store.set(&server_account(host_id), &BASE64.encode(public))
}

pub fn load_pinned_server_key_in<K: KeyStore>(
    store: &K,
    host_id: &str,
) -> Result<Option<Vec<u8>>, HostStoreError> {
    load_bytes(store, &server_account(host_id))
}

fn load_bytes<K: KeyStore>(store: &K, account: &str) -> Result<Option<Vec<u8>>, HostStoreError> {
    match store.get(account)? {
        Some(encoded) => BASE64
            .decode(encoded.as_bytes())
            .map(Some)
            .map_err(|error| HostStoreError::Secret(error.to_string())),
        None => Ok(None),
    }
}

#[cfg(test)]
#[derive(Clone)]
pub(crate) struct MemoryKeyStore(
    std::sync::Arc<std::sync::Mutex<std::collections::HashMap<String, String>>>,
);

#[cfg(test)]
impl MemoryKeyStore {
    pub(crate) fn new() -> Self {
        Self(std::sync::Arc::new(std::sync::Mutex::new(
            std::collections::HashMap::new(),
        )))
    }
}

#[cfg(test)]
impl KeyStore for MemoryKeyStore {
    fn set(&self, account: &str, value: &str) -> Result<(), HostStoreError> {
        self.0
            .lock()
            .map_err(|error| HostStoreError::Secret(error.to_string()))?
            .insert(account.to_string(), value.to_string());
        Ok(())
    }

    fn get(&self, account: &str) -> Result<Option<String>, HostStoreError> {
        Ok(self
            .0
            .lock()
            .map_err(|error| HostStoreError::Secret(error.to_string()))?
            .get(account)
            .cloned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use base64::{engine::general_purpose::STANDARD as BASE64, Engine};

    #[test]
    fn missing_device_keypair_is_none() {
        let store = MemoryKeyStore::new();
        assert_eq!(load_device_keypair_in(&store, "host-a").unwrap(), None);
    }

    #[test]
    fn device_keypair_roundtrips_and_is_stored_as_base64() {
        let store = MemoryKeyStore::new();
        let private = [0x11u8; 32];
        save_device_keypair_in(&store, "host-a", &private).unwrap();
        assert_eq!(
            load_device_keypair_in(&store, "host-a").unwrap().as_deref(),
            Some(private.as_slice())
        );
        let stored = store.get("noise-device-key-host-a").unwrap().unwrap();
        assert_eq!(stored, BASE64.encode(private));
    }

    #[test]
    fn pinned_server_key_roundtrips_under_its_own_account() {
        let store = MemoryKeyStore::new();
        let public = [0x22u8; 32];
        save_pinned_server_key_in(&store, "host-a", &public).unwrap();
        assert_eq!(
            load_pinned_server_key_in(&store, "host-a")
                .unwrap()
                .as_deref(),
            Some(public.as_slice())
        );
        let stored = store.get("noise-server-key-host-a").unwrap().unwrap();
        assert_eq!(stored, BASE64.encode(public));
    }

    #[test]
    fn host_ids_do_not_share_keys() {
        let store = MemoryKeyStore::new();
        save_device_keypair_in(&store, "host-a", &[1u8; 32]).unwrap();
        save_device_keypair_in(&store, "host-b", &[2u8; 32]).unwrap();
        assert_eq!(
            load_device_keypair_in(&store, "host-a").unwrap().unwrap()[0],
            1
        );
        assert_eq!(
            load_device_keypair_in(&store, "host-b").unwrap().unwrap()[0],
            2
        );
        assert_eq!(load_pinned_server_key_in(&store, "host-a").unwrap(), None);
    }
}
