use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use tether_core::host_store::{
    HostProfile, HostProfileChanges, HostStore, HostStoreError, NewHostProfile,
};

use crate::error::FfiHostStoreError;

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct FfiHostProfile {
    pub id: String,
    pub name: String,
    pub color: String,
    pub host: String,
    pub port: String,
    pub identity_name: String,
    pub order: u32,
    pub scheme: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct FfiNewHostProfile {
    pub name: String,
    pub color: String,
    pub host: String,
    pub port: String,
    pub identity_name: String,
    pub scheme: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, uniffi::Record)]
pub struct FfiHostProfileChanges {
    pub name: Option<String>,
    pub color: Option<String>,
    pub host: Option<String>,
    pub port: Option<String>,
    pub identity_name: Option<String>,
}

impl From<HostProfile> for FfiHostProfile {
    fn from(profile: HostProfile) -> Self {
        Self {
            id: profile.id,
            name: profile.name,
            color: profile.color,
            host: profile.host,
            port: profile.port,
            identity_name: profile.identity_name,
            order: profile.order as u32,
            scheme: profile.scheme,
        }
    }
}

impl From<FfiNewHostProfile> for NewHostProfile {
    fn from(input: FfiNewHostProfile) -> Self {
        Self {
            name: input.name,
            color: input.color,
            host: input.host,
            port: input.port,
            identity_name: input.identity_name,
            scheme: input.scheme,
        }
    }
}

impl From<FfiHostProfileChanges> for HostProfileChanges {
    fn from(changes: FfiHostProfileChanges) -> Self {
        Self {
            name: changes.name,
            color: changes.color,
            host: changes.host,
            port: changes.port,
            identity_name: changes.identity_name,
        }
    }
}

/// Platform key-value store for host profile JSON (AsyncStorage on RN).
#[uniffi::export(callback_interface)]
pub trait HostStorage: Send + Sync {
    fn get_item(&self, key: String) -> Result<Option<String>, FfiHostStoreError>;
    fn set_item(&self, key: String, value: String) -> Result<(), FfiHostStoreError>;
    fn remove_item(&self, key: String) -> Result<(), FfiHostStoreError>;
}

struct StorageAdapter(Box<dyn HostStorage>);

impl tether_core::host_store::HostStorage for StorageAdapter {
    fn get_item(&self, key: &str) -> Result<Option<String>, HostStoreError> {
        self.0.get_item(key.to_string()).map_err(Into::into)
    }

    fn set_item(&self, key: &str, value: String) -> Result<(), HostStoreError> {
        self.0.set_item(key.to_string(), value).map_err(Into::into)
    }

    fn remove_item(&self, key: &str) -> Result<(), HostStoreError> {
        self.0.remove_item(key.to_string()).map_err(Into::into)
    }
}

#[derive(uniffi::Object)]
pub struct HostStoreHandle {
    inner: HostStore<StorageAdapter, Box<dyn FnMut() -> String + Send>>,
}

#[uniffi::export]
impl HostStoreHandle {
    #[uniffi::constructor]
    pub fn new(storage: Box<dyn HostStorage>) -> Arc<Self> {
        let next_id = Arc::new(AtomicU64::new(0));
        let store = HostStore::new(StorageAdapter(storage), {
            let next_id = Arc::clone(&next_id);
            Box::new(move || format!("host-{}", next_id.fetch_add(1, Ordering::Relaxed)))
                as Box<dyn FnMut() -> String + Send>
        });
        Arc::new(Self { inner: store })
    }

    pub fn list(&self) -> Result<Vec<FfiHostProfile>, FfiHostStoreError> {
        Ok(self
            .inner
            .list()?
            .into_iter()
            .map(FfiHostProfile::from)
            .collect())
    }

    pub fn create(&self, input: FfiNewHostProfile) -> Result<FfiHostProfile, FfiHostStoreError> {
        Ok(self.inner.create(input.into())?.into())
    }

    pub fn update(
        &self,
        id: String,
        changes: FfiHostProfileChanges,
    ) -> Result<FfiHostProfile, FfiHostStoreError> {
        Ok(self.inner.update(&id, changes.into())?.into())
    }

    pub fn remove(&self, id: String) -> Result<(), FfiHostStoreError> {
        self.inner.remove(&id).map_err(Into::into)
    }

    pub fn reorder(&self, ids: Vec<String>) -> Result<Vec<FfiHostProfile>, FfiHostStoreError> {
        Ok(self
            .inner
            .reorder(&ids)?
            .into_iter()
            .map(FfiHostProfile::from)
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    struct MemoryStorage(Mutex<HashMap<String, String>>);

    impl HostStorage for MemoryStorage {
        fn get_item(&self, key: String) -> Result<Option<String>, FfiHostStoreError> {
            Ok(self.0.lock().unwrap().get(&key).cloned())
        }

        fn set_item(&self, key: String, value: String) -> Result<(), FfiHostStoreError> {
            self.0.lock().unwrap().insert(key, value);
            Ok(())
        }

        fn remove_item(&self, key: String) -> Result<(), FfiHostStoreError> {
            self.0.lock().unwrap().remove(&key);
            Ok(())
        }
    }

    #[test]
    fn host_store_round_trips_through_ffi_adapters() {
        let store = HostStoreHandle::new(Box::new(MemoryStorage(Mutex::new(HashMap::new()))));
        let profile = store
            .create(FfiNewHostProfile {
                name: "Dev".to_string(),
                color: "#89b4fa".to_string(),
                host: "dev.local".to_string(),
                port: "8085".to_string(),
                identity_name: "dev".to_string(),
                scheme: None,
            })
            .unwrap();
        assert_eq!(store.list().unwrap(), vec![profile]);
    }
}
