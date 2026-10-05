use std::{
    io,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use tether_core::{
    DataDir, HostKeyStore, KeyForm, KeyOrigin, KeyRecords, PasswordAction, Preferences, Profiles,
    SecretError, SecretStore, ServerForm, apply_server_form, generate_ed25519, key_account,
    keys::{KEYS_FILE, import_record, normalize_pem},
    password_account,
    profiles::PROFILES_FILE,
};
use uuid::Uuid;

pub struct AppState {
    pub data: DataDir,
    pub profiles: Profiles,
    pub keys: KeyRecords,
    pub prefs: Preferences,
    pub secrets: Arc<dyn SecretStore>,
    #[allow(dead_code)]
    pub hostkeys: Arc<dyn HostKeyStore>,
}

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    Io(#[from] io::Error),
    #[error("{0}")]
    Secret(#[from] SecretError),
}

pub fn save_failed_hint(e: &AppError) -> String {
    format!("Couldn't save: {e}")
}

pub fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64)
}

impl AppState {
    pub fn load(
        data: DataDir,
        secrets: Arc<dyn SecretStore>,
        hostkeys: Arc<dyn HostKeyStore>,
    ) -> Result<Self, AppError> {
        Ok(Self {
            profiles: data.load(PROFILES_FILE)?,
            keys: data.load(KEYS_FILE)?,
            prefs: Preferences::load(&data)?,
            data,
            secrets,
            hostkeys,
        })
    }

    pub fn save_prefs(&self) {
        if let Err(e) = self.prefs.save(&self.data) {
            tracing::warn!("saving preferences failed: {e}");
        }
    }

    pub fn has_saved_password(&self, id: Uuid) -> bool {
        matches!(self.secrets.get(&password_account(id)), Ok(Some(_)))
    }

    pub fn save_server(
        &mut self,
        editing: Option<Uuid>,
        form: &ServerForm,
    ) -> Result<Uuid, AppError> {
        let existing = editing.and_then(|id| self.profiles.get(id)).cloned();
        let (machine, action) = apply_server_form(existing.as_ref(), form);
        let id = machine.id;
        if let PasswordAction::Set(pw) = &action {
            self.secrets.set(&password_account(id), pw.as_bytes())?;
        }
        let mut next = self.profiles.clone();
        if existing.is_some() {
            next.replace(machine);
        } else {
            next.add(machine);
        }
        self.data.save(PROFILES_FILE, &next)?;
        self.profiles = next;
        if matches!(action, PasswordAction::Delete) {
            self.secrets.delete(&password_account(id))?;
        }
        Ok(id)
    }

    pub fn remove_machine(&mut self, id: Uuid) -> Result<(), AppError> {
        let mut next = self.profiles.clone();
        next.remove(id);
        self.data.save(PROFILES_FILE, &next)?;
        self.profiles = next;
        self.secrets.delete(&password_account(id))?;
        Ok(())
    }

    pub fn generate_key(&mut self, name: &str, now: i64) -> Result<Uuid, AppError> {
        let (record, pem) = generate_ed25519(name.trim(), now);
        self.add_key(record, pem.as_bytes())
    }

    pub fn save_imported_key(
        &mut self,
        form: &KeyForm,
        origin: KeyOrigin,
        now: i64,
    ) -> Result<Uuid, AppError> {
        let record = import_record(form.name.trim(), &form.public, origin, now);
        self.add_key(record, normalize_pem(&form.private).as_bytes())
    }

    fn add_key(&mut self, record: tether_core::KeyRecord, secret: &[u8]) -> Result<Uuid, AppError> {
        let id = record.id;
        let mut next = self.keys.clone();
        next.add(record);
        self.data.save(KEYS_FILE, &next)?;
        if let Err(e) = self.secrets.set(&key_account(id), secret) {
            let _ = self.data.save(KEYS_FILE, &self.keys);
            return Err(e.into());
        }
        self.keys = next;
        Ok(id)
    }

    pub fn delete_key(&mut self, id: Uuid) -> Result<(), AppError> {
        let mut next = self.keys.clone();
        next.remove(id);
        self.data.save(KEYS_FILE, &next)?;
        self.keys = next;
        self.secrets.delete(&key_account(id))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tether_core::{AuthChoice, HostKeyStore, MemoryHostKeys, MemorySecretStore};

    fn state(dir: &std::path::Path) -> (AppState, Arc<MemorySecretStore>, Arc<MemoryHostKeys>) {
        let secrets = Arc::new(MemorySecretStore::default());
        let hostkeys = Arc::new(MemoryHostKeys::default());
        let s = AppState::load(DataDir::new(dir), secrets.clone(), hostkeys.clone()).unwrap();
        (s, secrets, hostkeys)
    }

    fn form(auth: AuthChoice, password: &str) -> ServerForm {
        ServerForm {
            name: "devbox".into(),
            host: " 192.0.2.10 ".into(),
            port: "22".into(),
            user: "dev".into(),
            auth,
            password: password.into(),
            has_saved_password: false,
        }
    }

    #[test]
    fn add_server_persists_and_stores_the_password() {
        let dir = tempfile::tempdir().unwrap();
        let (mut s, secrets, _) = state(dir.path());
        let id = s
            .save_server(None, &form(AuthChoice::Password, "hunter2"))
            .unwrap();
        assert_eq!(s.profiles.machines[0].host, "192.0.2.10");
        assert_eq!(
            secrets.get(&password_account(id)).unwrap().unwrap().as_slice(),
            b"hunter2"
        );
        let (reloaded, _, _) = state(dir.path());
        assert_eq!(reloaded.profiles.machines.len(), 1);
        assert!(s.has_saved_password(id));
    }

    #[test]
    fn edit_keeps_order_and_leaving_password_deletes_it() {
        let dir = tempfile::tempdir().unwrap();
        let (mut s, secrets, _) = state(dir.path());
        let a = s.save_server(None, &form(AuthChoice::Password, "pw")).unwrap();
        let mut second = form(AuthChoice::Agent, "");
        second.name = "vps".into();
        s.save_server(None, &second).unwrap();
        let mut edit = form(AuthChoice::Agent, "");
        edit.has_saved_password = true;
        s.save_server(Some(a), &edit).unwrap();
        assert_eq!(s.profiles.machines[0].id, a);
        assert_eq!(s.profiles.machines[1].name, "vps");
        assert!(secrets.get(&password_account(a)).unwrap().is_none());
    }

    #[test]
    fn empty_password_on_edit_keeps_the_saved_one() {
        let dir = tempfile::tempdir().unwrap();
        let (mut s, secrets, _) = state(dir.path());
        let a = s.save_server(None, &form(AuthChoice::Password, "pw")).unwrap();
        let mut edit = form(AuthChoice::Password, "");
        edit.has_saved_password = true;
        s.save_server(Some(a), &edit).unwrap();
        assert_eq!(
            secrets.get(&password_account(a)).unwrap().unwrap().as_slice(),
            b"pw"
        );
    }

    #[test]
    fn remove_machine_forgets_password_but_keeps_the_pin() {
        let dir = tempfile::tempdir().unwrap();
        let (mut s, secrets, hostkeys) = state(dir.path());
        let a = s.save_server(None, &form(AuthChoice::Password, "pw")).unwrap();
        hostkeys.pin("192.0.2.10", 22, "aa:bb");
        s.remove_machine(a).unwrap();
        assert!(s.profiles.machines.is_empty());
        assert!(secrets.get(&password_account(a)).unwrap().is_none());
        assert_eq!(hostkeys.pinned("192.0.2.10", 22).as_deref(), Some("aa:bb"));
    }

    #[test]
    fn generate_then_delete_key_leaves_machine_with_key_missing() {
        let dir = tempfile::tempdir().unwrap();
        let (mut s, secrets, _) = state(dir.path());
        let k = s.generate_key(" desktop ", 1_791_000_000).unwrap();
        assert_eq!(s.keys.keys[0].name, "desktop");
        assert!(
            secrets
                .get(&key_account(k))
                .unwrap()
                .unwrap()
                .starts_with(b"-----BEGIN PRIVATE KEY-----")
        );
        let m = s
            .save_server(None, &form(AuthChoice::Key(Some(k)), ""))
            .unwrap();
        s.delete_key(k).unwrap();
        assert!(s.keys.keys.is_empty());
        assert!(secrets.get(&key_account(k)).unwrap().is_none());
        assert!(s.profiles.get(m).unwrap().key_missing(&s.keys));
        let (reloaded, _, _) = state(dir.path());
        assert!(reloaded.keys.keys.is_empty());
    }

    #[test]
    fn imported_key_keeps_its_origin_and_normalized_pem() {
        let dir = tempfile::tempdir().unwrap();
        let (mut s, secrets, _) = state(dir.path());
        let form = KeyForm {
            name: "work".into(),
            private: "-----BEGIN OPENSSH PRIVATE KEY-----\r\nabc\r\n-----END OPENSSH PRIVATE KEY-----\r\n"
                .into(),
            public: "  ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBq work  ".into(),
        };
        let id = s.save_imported_key(&form, KeyOrigin::Pasted, 5).unwrap();
        let rec = s.keys.get(id).unwrap();
        assert_eq!(rec.origin, KeyOrigin::Pasted);
        assert_eq!(
            rec.public_line,
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBq work"
        );
        let pem = secrets.get(&key_account(id)).unwrap().unwrap();
        assert!(!pem.contains(&b'\r'));
    }

    #[test]
    fn failed_save_changes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let (mut s, _, _) = state(dir.path());
        let blocker = dir.path().join("not-a-dir");
        std::fs::write(&blocker, b"x").unwrap();
        s.data = DataDir::new(&blocker);
        let err = s.save_server(None, &form(AuthChoice::Agent, "")).unwrap_err();
        assert!(s.profiles.machines.is_empty());
        assert!(save_failed_hint(&err).starts_with("Couldn't save: "));
        assert!(s.generate_key("k", 1).is_err());
        assert!(s.keys.keys.is_empty());
    }

    #[test]
    fn failed_save_keeps_the_password() {
        let dir = tempfile::tempdir().unwrap();
        let (mut s, secrets, _) = state(dir.path());
        let a = s.save_server(None, &form(AuthChoice::Password, "pw")).unwrap();
        let blocker = dir.path().join("blocked");
        std::fs::write(&blocker, b"x").unwrap();
        s.data = DataDir::new(&blocker);
        let mut edit = form(AuthChoice::Agent, "");
        edit.has_saved_password = true;
        assert!(s.save_server(Some(a), &edit).is_err());
        assert_eq!(
            secrets.get(&password_account(a)).unwrap().unwrap().as_slice(),
            b"pw"
        );
        assert_eq!(
            s.profiles.get(a).unwrap().auth,
            tether_core::Auth::Password
        );
    }
}
