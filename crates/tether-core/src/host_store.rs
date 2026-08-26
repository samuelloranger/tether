use std::collections::HashSet;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const HOST_PROFILES_KEY: &str = "tether_host_profiles";
pub const LEGACY_SERVER_IP_KEY: &str = "tether_server_ip";
pub const LEGACY_PORT_KEY: &str = "tether_port";

fn taken(profiles: &[HostProfile]) -> HashSet<String> {
    profiles.iter().map(|profile| profile.id.clone()).collect()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostProfile {
    pub id: String,
    pub name: String,
    pub color: String,
    pub host: String,
    pub port: String,
    pub identity_name: String,
    pub order: usize,
}

/// Creation input deliberately excludes core-owned identity and ordering.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewHostProfile {
    pub name: String,
    pub color: String,
    pub host: String,
    pub port: String,
    pub identity_name: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HostProfileChanges {
    pub name: Option<String>,
    pub color: Option<String>,
    pub host: Option<String>,
    pub port: Option<String>,
    pub identity_name: Option<String>,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum HostStoreError {
    #[error("storage operation failed: {0}")]
    Storage(String),
    #[error("secret operation failed: {0}")]
    Secret(String),
    #[error("unknown host profile: {0}")]
    UnknownProfile(String),
    #[error("migrated host password could not be read back")]
    PasswordVerification,
    #[error("migrated host profile could not be read back")]
    ProfileVerification,
}

/// Platform storage seam. The core owns migration ordering, never the I/O.
pub trait HostStorage {
    fn get_item(&self, key: &str) -> Result<Option<String>, HostStoreError>;
    fn set_item(&self, key: &str, value: String) -> Result<(), HostStoreError>;
    fn remove_item(&self, key: &str) -> Result<(), HostStoreError>;
}

/// Platform secret-storage seam, preserving the legacy-password migration.
pub trait HostSecrets {
    fn get(&self, host_id: &str) -> Result<Option<String>, HostStoreError>;
    fn set(&self, host_id: &str, password: &str) -> Result<(), HostStoreError>;
    fn clear(&self, host_id: &str) -> Result<(), HostStoreError>;
    fn get_legacy(&self) -> Result<Option<String>, HostStoreError>;
    fn clear_legacy(&self) -> Result<(), HostStoreError>;
}

pub struct HostStore<S, H, I> {
    storage: S,
    secrets: H,
    make_id: Mutex<I>,
}

impl<S, H, I> HostStore<S, H, I>
where
    S: HostStorage,
    H: HostSecrets,
    I: FnMut() -> String,
{
    pub fn new(storage: S, secrets: H, make_id: I) -> Self {
        Self {
            storage,
            secrets,
            make_id: Mutex::new(make_id),
        }
    }

    pub fn list(&self) -> Result<Vec<HostProfile>, HostStoreError> {
        let profiles = self.repair_duplicate_ids(parse_profiles(
            self.storage.get_item(HOST_PROFILES_KEY)?.as_deref(),
        ))?;
        let Some(legacy_host) = self
            .storage
            .get_item(LEGACY_SERVER_IP_KEY)?
            .filter(|host| !host.is_empty())
        else {
            return Ok(profiles);
        };
        let legacy_port = self
            .storage
            .get_item(LEGACY_PORT_KEY)?
            .filter(|port| !port.is_empty())
            .unwrap_or_else(|| "8085".to_string());

        let mut profiles = profiles;
        let profile = if let Some(profile) = profiles
            .iter()
            .find(|profile| profile.host == legacy_host && profile.port == legacy_port)
            .cloned()
        {
            profile
        } else {
            let profile = HostProfile {
                id: self.unique_id(&taken(&profiles)),
                name: legacy_host.clone(),
                color: "#89b4fa".to_string(),
                host: legacy_host,
                port: legacy_port,
                identity_name: String::new(),
                order: profiles.len(),
            };
            profiles.push(profile.clone());
            self.write(&profiles)?;
            profile
        };

        if let Some(password) = self.secrets.get_legacy()? {
            self.secrets.set(&profile.id, &password)?;
            if self.secrets.get(&profile.id)?.as_deref() != Some(password.as_str()) {
                return Err(HostStoreError::PasswordVerification);
            }
        }

        let reread = parse_profiles(self.storage.get_item(HOST_PROFILES_KEY)?.as_deref());
        if !reread.iter().any(|candidate| candidate.id == profile.id) {
            return Err(HostStoreError::ProfileVerification);
        }

        // Cleanup is best-effort only after the replacement state is readable.
        // An interrupted migration will verify the same state on next launch.
        let _ = self.storage.remove_item(LEGACY_SERVER_IP_KEY);
        let _ = self.storage.remove_item(LEGACY_PORT_KEY);
        let _ = self.secrets.clear_legacy();
        Ok(reread)
    }

    /// Seed profiles from a raw JSON array when storage is empty (desktop
    /// localStorage → file migration). Preserves ids and order.
    pub fn seed_if_empty(&self, profiles_json: &str) -> Result<Vec<HostProfile>, HostStoreError> {
        let existing = self.list()?;
        if !existing.is_empty() {
            return Ok(existing);
        }
        let seeded = parse_profiles(Some(profiles_json));
        if seeded.is_empty() {
            return Ok(existing);
        }
        self.write(&seeded)?;
        self.list()
    }

    pub fn create(&self, input: NewHostProfile) -> Result<HostProfile, HostStoreError> {
        let mut profiles = self.list()?;
        let profile = HostProfile {
            id: self.unique_id(&taken(&profiles)),
            name: input.name,
            color: input.color,
            host: input.host,
            port: input.port,
            identity_name: input.identity_name,
            order: profiles.len(),
        };
        profiles.push(profile.clone());
        self.write(&profiles)?;
        Ok(profile)
    }

    pub fn update(
        &self,
        id: &str,
        changes: HostProfileChanges,
    ) -> Result<HostProfile, HostStoreError> {
        let mut profiles = self.list()?;
        let profile = profiles
            .iter_mut()
            .find(|profile| profile.id == id)
            .ok_or_else(|| HostStoreError::UnknownProfile(id.to_string()))?;
        apply_changes(profile, changes);
        let next = profile.clone();
        self.write(&profiles)?;
        Ok(next)
    }

    pub fn remove(&self, id: &str) -> Result<(), HostStoreError> {
        let profiles = self.list()?;
        if !profiles.iter().any(|profile| profile.id == id) {
            return Ok(());
        }
        self.secrets.clear(id)?;
        let next = profiles
            .into_iter()
            .filter(|profile| profile.id != id)
            .enumerate()
            .map(|(order, mut profile)| {
                profile.order = order;
                profile
            })
            .collect::<Vec<_>>();
        self.write(&next)
    }

    pub fn reorder(&self, ids: &[String]) -> Result<Vec<HostProfile>, HostStoreError> {
        let profiles = self.list()?;
        let mut next = ids
            .iter()
            .filter_map(|id| profiles.iter().find(|profile| &profile.id == id).cloned())
            .collect::<Vec<_>>();
        next.extend(
            profiles
                .into_iter()
                .filter(|profile| !ids.contains(&profile.id)),
        );
        for (order, profile) in next.iter_mut().enumerate() {
            profile.order = order;
        }
        self.write(&next)?;
        Ok(next)
    }

    /// An id no stored profile is already using.
    ///
    /// The injected generator cannot know what is persisted — the iOS one is a
    /// counter that restarts at zero on every launch, so the first host added in
    /// a later run was handed `host-0` again, the id the first host already had.
    /// That collision is not cosmetic: the keychain entry and the session cache
    /// are both keyed by host id, so the new host silently took over the older
    /// one's password (leaving it permanently 401) and its cached sessions.
    ///
    /// Uniqueness is this store's invariant, so it is enforced here instead of
    /// being trusted to whoever supplied the generator. Suffixing rather than
    /// re-rolling also terminates against a generator that always answers the
    /// same string.
    fn unique_id(&self, taken: &HashSet<String>) -> String {
        let base = self.next_id();
        let mut id = base.clone();
        let mut suffix = 1;
        while taken.contains(&id) {
            id = format!("{base}-{suffix}");
            suffix += 1;
        }
        id
    }

    /// Repairs ids an earlier build handed out twice.
    ///
    /// Anyone who added a second host before `unique_id` existed has two
    /// profiles sharing one id on disk, and no amount of correct code going
    /// forward untangles that — the drawer collapses them into one row and every
    /// request for the second one authenticates as the first. Renaming the later
    /// profile splits them apart.
    ///
    /// Secrets are deliberately left alone. The stored password sits under the
    /// shared id, so after the split the first profile keeps it and the second
    /// has none, which makes the app ask for that host's password. That is the
    /// visible version of what was already happening silently.
    fn repair_duplicate_ids(
        &self,
        profiles: Vec<HostProfile>,
    ) -> Result<Vec<HostProfile>, HostStoreError> {
        let mut seen: HashSet<String> = HashSet::with_capacity(profiles.len());
        let mut ambiguous: Vec<String> = Vec::new();
        let mut out = Vec::with_capacity(profiles.len());
        for mut profile in profiles {
            if !seen.insert(profile.id.clone()) {
                // The colliding id's stored secret belongs to whichever host
                // wrote it LAST, and nothing records which that was. Leaving it
                // in place is not merely untidy: the profile that keeps the id
                // would then send the other host's password to its own server.
                // Both sides therefore have to re-authenticate.
                ambiguous.push(profile.id.clone());
                let fresh = self.unique_id(&seen);
                seen.insert(fresh.clone());
                profile.id = fresh;
            }
            out.push(profile);
        }
        if !ambiguous.is_empty() {
            self.write(&out)?;
            // After the profiles are persisted, so an interrupted repair leaves
            // a password to re-enter rather than a duplicate id still in place.
            for id in ambiguous {
                self.secrets.clear(&id)?;
            }
        }
        Ok(out)
    }

    fn next_id(&self) -> String {
        let mut make_id = self
            .make_id
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        make_id()
    }

    fn write(&self, profiles: &[HostProfile]) -> Result<(), HostStoreError> {
        let json = serde_json::to_string(&ordered(profiles.to_vec()))
            .map_err(|error| HostStoreError::Storage(error.to_string()))?;
        self.storage.set_item(HOST_PROFILES_KEY, json)
    }
}

fn ordered(mut profiles: Vec<HostProfile>) -> Vec<HostProfile> {
    profiles.sort_by_key(|profile| profile.order);
    profiles
}

fn parse_profiles(value: Option<&str>) -> Vec<HostProfile> {
    let Some(value) = value else {
        return Vec::new();
    };
    let Ok(serde_json::Value::Array(values)) = serde_json::from_str(value) else {
        return Vec::new();
    };
    ordered(
        values
            .into_iter()
            .filter_map(|value| serde_json::from_value(value).ok())
            .collect(),
    )
}

fn apply_changes(profile: &mut HostProfile, changes: HostProfileChanges) {
    if let Some(name) = changes.name {
        profile.name = name;
    }
    if let Some(color) = changes.color {
        profile.color = color;
    }
    if let Some(host) = changes.host {
        profile.host = host;
    }
    if let Some(port) = changes.port {
        profile.port = port;
    }
    if let Some(identity_name) = changes.identity_name {
        profile.identity_name = identity_name;
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Arc;

    use super::*;

    #[derive(Clone, Default)]
    struct MemoryStorage {
        values: Arc<Mutex<HashMap<String, String>>>,
        fail_set: bool,
    }

    impl MemoryStorage {
        fn seeded(values: &[(&str, &str)]) -> Self {
            Self {
                values: Arc::new(Mutex::new(
                    values
                        .iter()
                        .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
                        .collect(),
                )),
                fail_set: false,
            }
        }

        fn get(&self, key: &str) -> Option<String> {
            self.values.lock().unwrap().get(key).cloned()
        }
    }

    impl HostStorage for MemoryStorage {
        fn get_item(&self, key: &str) -> Result<Option<String>, HostStoreError> {
            Ok(self.get(key))
        }

        fn set_item(&self, key: &str, value: String) -> Result<(), HostStoreError> {
            if self.fail_set {
                return Err(HostStoreError::Storage("disk full".to_string()));
            }
            self.values.lock().unwrap().insert(key.to_string(), value);
            Ok(())
        }

        fn remove_item(&self, key: &str) -> Result<(), HostStoreError> {
            self.values.lock().unwrap().remove(key);
            Ok(())
        }
    }

    #[derive(Clone, Default)]
    struct MemorySecrets(Arc<Mutex<HashMap<String, String>>>);

    impl MemorySecrets {
        fn seeded(values: &[(&str, &str)]) -> Self {
            Self(Arc::new(Mutex::new(
                values
                    .iter()
                    .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
                    .collect(),
            )))
        }

        fn get_value(&self, key: &str) -> Option<String> {
            self.0.lock().unwrap().get(key).cloned()
        }
    }

    impl HostSecrets for MemorySecrets {
        fn get(&self, host_id: &str) -> Result<Option<String>, HostStoreError> {
            Ok(self.get_value(host_id))
        }

        fn set(&self, host_id: &str, password: &str) -> Result<(), HostStoreError> {
            self.0
                .lock()
                .unwrap()
                .insert(host_id.to_string(), password.to_string());
            Ok(())
        }

        fn clear(&self, host_id: &str) -> Result<(), HostStoreError> {
            self.0.lock().unwrap().remove(host_id);
            Ok(())
        }

        fn get_legacy(&self) -> Result<Option<String>, HostStoreError> {
            Ok(self.get_value("legacy"))
        }

        fn clear_legacy(&self) -> Result<(), HostStoreError> {
            self.clear("legacy")
        }
    }

    fn profile_input(id: &str) -> NewHostProfile {
        NewHostProfile {
            name: id.to_string(),
            color: "#89b4fa".to_string(),
            host: format!("{id}.local"),
            port: "8085".to_string(),
            identity_name: id.to_string(),
        }
    }

    #[test]
    fn splits_apart_profiles_an_earlier_build_stored_under_one_id() {
        // Exactly what the simulator had on disk after adding a second host.
        let stored = r##"[{"id":"host-0","name":"first","color":"#89b4fa","host":"10.0.0.1","port":"8097","identityName":"first","order":0},{"id":"host-0","name":"second","color":"#89b4fa","host":"10.0.0.2","port":"8100","identityName":"second","order":1}]"##;
        let storage = MemoryStorage::seeded(&[(HOST_PROFILES_KEY, stored)]);
        // The secret the collision left behind. It was written by whichever host
        // saved last, so it belongs to neither profile in particular — the whole
        // point of the assertion below.
        let secrets = MemorySecrets::seeded(&[("host-0", "second-hosts-password")]);
        let store = HostStore::new(storage.clone(), secrets.clone(), || "host-0".to_string());

        let profiles = store.list().unwrap();
        assert_eq!(profiles.len(), 2);
        assert_ne!(profiles[0].id, profiles[1].id);
        assert_eq!(profiles[0].id, "host-0", "the first profile keeps its id");
        assert_eq!(profiles[0].port, "8097");
        assert_eq!(profiles[1].port, "8100");

        // Persisted, so the split survives the next launch.
        let reread = parse_profiles(storage.get(HOST_PROFILES_KEY).as_deref());
        assert_eq!(reread, profiles);

        // The ambiguous secret is GONE for both ids. Keeping it under the
        // profile that retained the id would have sent the second host's
        // password to the first host's server.
        assert_eq!(secrets.get_value("host-0"), None);
        assert_eq!(secrets.get_value(&profiles[1].id), None);
    }

    #[test]
    fn create_never_reuses_an_id_the_generator_hands_out_twice() {
        // The iOS generator is a counter built at launch, so a second app run
        // starts back at `host-0`. A constant generator is that bug at its worst.
        let storage = MemoryStorage::default();
        let store = HostStore::new(storage, MemorySecrets::default(), || "host-0".to_string());

        let first = store
            .create(NewHostProfile {
                name: "first".to_string(),
                color: "#89b4fa".to_string(),
                host: "10.0.0.1".to_string(),
                port: "8085".to_string(),
                identity_name: "first".to_string(),
            })
            .unwrap();
        let second = store
            .create(NewHostProfile {
                name: "second".to_string(),
                color: "#89b4fa".to_string(),
                host: "10.0.0.2".to_string(),
                port: "8085".to_string(),
                identity_name: "second".to_string(),
            })
            .unwrap();

        assert_ne!(first.id, second.id);
        assert_eq!(store.list().unwrap().len(), 2);

        // The reason the invariant matters: the keychain and the session cache
        // are both keyed by this id, so a duplicate makes the newer host take
        // over the older one's password and cached sessions.
        let ids: Vec<String> = store.list().unwrap().into_iter().map(|p| p.id).collect();
        assert_eq!(
            ids.iter().collect::<std::collections::HashSet<_>>().len(),
            2
        );
    }

    #[test]
    fn migrates_legacy_address_and_password_only_after_the_new_profile_is_readable() {
        let storage = MemoryStorage::seeded(&[
            (LEGACY_SERVER_IP_KEY, "agent.local"),
            (LEGACY_PORT_KEY, "9000"),
        ]);
        let secrets = MemorySecrets::seeded(&[("legacy", "correct horse battery staple")]);
        let store = HostStore::new(storage.clone(), secrets.clone(), || "host-1".to_string());

        assert_eq!(
            store.list().unwrap(),
            vec![HostProfile {
                id: "host-1".to_string(),
                name: "agent.local".to_string(),
                color: "#89b4fa".to_string(),
                host: "agent.local".to_string(),
                port: "9000".to_string(),
                identity_name: String::new(),
                order: 0,
            }]
        );
        assert!(storage.get(HOST_PROFILES_KEY).unwrap().contains("host-1"));
        assert_eq!(storage.get(LEGACY_SERVER_IP_KEY), None);
        assert_eq!(storage.get(LEGACY_PORT_KEY), None);
        assert_eq!(
            secrets.get_value("host-1").as_deref(),
            Some("correct horse battery staple")
        );
        assert_eq!(secrets.get_value("legacy"), None);
    }

    #[test]
    fn does_not_create_a_profile_or_consume_a_password_without_a_legacy_address() {
        let storage = MemoryStorage::default();
        let secrets = MemorySecrets::seeded(&[("legacy", "orphaned-password")]);
        let store = HostStore::new(storage, secrets.clone(), || "unused".to_string());

        assert_eq!(store.list().unwrap(), Vec::<HostProfile>::new());
        assert_eq!(
            secrets.get_value("legacy").as_deref(),
            Some("orphaned-password")
        );
    }

    #[test]
    fn treats_an_empty_legacy_address_as_absent() {
        let storage = MemoryStorage::seeded(&[(LEGACY_SERVER_IP_KEY, "")]);
        let secrets = MemorySecrets::seeded(&[("legacy", "orphaned-password")]);
        let store = HostStore::new(storage.clone(), secrets.clone(), || "unused".to_string());

        assert_eq!(store.list().unwrap(), Vec::<HostProfile>::new());
        assert_eq!(storage.get(LEGACY_SERVER_IP_KEY).as_deref(), Some(""));
        assert_eq!(
            secrets.get_value("legacy").as_deref(),
            Some("orphaned-password")
        );
    }

    #[test]
    fn defaults_an_empty_legacy_port_to_8085() {
        let storage =
            MemoryStorage::seeded(&[(LEGACY_SERVER_IP_KEY, "agent.local"), (LEGACY_PORT_KEY, "")]);
        let store = HostStore::new(storage, MemorySecrets::default(), || "host-1".to_string());

        assert_eq!(store.list().unwrap()[0].port, "8085");
    }

    #[test]
    fn keeps_legacy_values_when_writing_the_migrated_state_fails() {
        let storage = MemoryStorage {
            fail_set: true,
            ..MemoryStorage::seeded(&[
                (LEGACY_SERVER_IP_KEY, "agent.local"),
                (LEGACY_PORT_KEY, "8085"),
            ])
        };
        let secrets = MemorySecrets::seeded(&[("legacy", "legacy-password")]);
        let store = HostStore::new(storage.clone(), secrets, || "host-1".to_string());

        assert_eq!(
            store.list(),
            Err(HostStoreError::Storage("disk full".to_string()))
        );
        assert_eq!(
            storage.get(LEGACY_SERVER_IP_KEY).as_deref(),
            Some("agent.local")
        );
        assert_eq!(storage.get(LEGACY_PORT_KEY).as_deref(), Some("8085"));
    }

    #[test]
    fn creates_updates_deletes_and_reorders_profiles_with_sequential_order_values() {
        let mut next_id = 0;
        let store = HostStore::new(
            MemoryStorage::default(),
            MemorySecrets::default(),
            move || {
                next_id += 1;
                format!("host-{next_id}")
            },
        );

        let first = store.create(profile_input("ignored")).unwrap();
        let second = store.create(profile_input("ignored")).unwrap();
        store
            .update(
                &first.id,
                HostProfileChanges {
                    name: Some("Renamed".to_string()),
                    ..HostProfileChanges::default()
                },
            )
            .unwrap();
        store
            .reorder(&[second.id.clone(), first.id.clone()])
            .unwrap();

        let profiles = store.list().unwrap();
        assert_eq!(profiles[0].id, second.id);
        assert_eq!(profiles[0].order, 0);
        assert_eq!(profiles[1].id, first.id);
        assert_eq!(profiles[1].name, "Renamed");
        assert_eq!(profiles[1].order, 1);

        store.remove(&second.id).unwrap();
        let profiles = store.list().unwrap();
        assert_eq!(profiles.len(), 1);
        assert_eq!(profiles[0].id, first.id);
        assert_eq!(profiles[0].order, 0);
    }
}
