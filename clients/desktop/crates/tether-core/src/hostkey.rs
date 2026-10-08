use std::collections::BTreeMap;
use std::io;
use std::sync::Mutex;

use crate::DataDir;

pub const HOSTKEYS_FILE: &str = "hostkeys.json";

pub trait HostKeyStore: Send + Sync {
    fn pinned(&self, host: &str, port: u16) -> Option<String>;
    /// An error means the pin is not durable: the caller must not proceed as if pinned.
    fn pin(&self, host: &str, port: u16, fingerprint: &str) -> io::Result<()>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostKeyDecision {
    Pinned,
    Matched,
    Mismatch { expected: String, got: String },
}

fn key(host: &str, port: u16) -> String {
    format!("{host}:{port}")
}

pub fn hex_fingerprint(sha256: &[u8; 32]) -> String {
    sha256
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<Vec<_>>()
        .join(":")
}

/// Pins on first sight, before auth. A mismatch never writes and has no override.
pub fn verify_host_key(
    fingerprint: &str,
    host: &str,
    port: u16,
    store: &dyn HostKeyStore,
) -> io::Result<HostKeyDecision> {
    Ok(match store.pinned(host, port) {
        None => {
            store.pin(host, port, fingerprint)?;
            HostKeyDecision::Pinned
        }
        Some(pinned) if pinned == fingerprint => HostKeyDecision::Matched,
        Some(expected) => HostKeyDecision::Mismatch {
            expected,
            got: fingerprint.to_string(),
        },
    })
}

#[derive(Default)]
pub struct MemoryHostKeys {
    pins: Mutex<BTreeMap<String, String>>,
}

impl HostKeyStore for MemoryHostKeys {
    fn pinned(&self, host: &str, port: u16) -> Option<String> {
        self.pins.lock().unwrap().get(&key(host, port)).cloned()
    }

    fn pin(&self, host: &str, port: u16, fingerprint: &str) -> io::Result<()> {
        self.pins
            .lock()
            .unwrap()
            .insert(key(host, port), fingerprint.to_string());
        Ok(())
    }
}

pub struct JsonHostKeys {
    dir: DataDir,
    pins: Mutex<BTreeMap<String, String>>,
}

impl JsonHostKeys {
    pub fn new(dir: DataDir) -> io::Result<Self> {
        let pins = dir.load(HOSTKEYS_FILE)?;
        Ok(Self {
            dir,
            pins: Mutex::new(pins),
        })
    }
}

impl HostKeyStore for JsonHostKeys {
    fn pinned(&self, host: &str, port: u16) -> Option<String> {
        self.pins.lock().unwrap().get(&key(host, port)).cloned()
    }

    /// Read-modify-write under an exclusive lock, so another running instance's pins are
    /// kept. A different pin already on disk for this host is refused, never replaced.
    fn pin(&self, host: &str, port: u16, fingerprint: &str) -> io::Result<()> {
        let mut cache = self.pins.lock().unwrap();
        let lock = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(self.dir.root().join(format!("{HOSTKEYS_FILE}.lock")))?;
        lock.lock()?;
        let mut disk: BTreeMap<String, String> = self.dir.load(HOSTKEYS_FILE)?;
        let k = key(host, port);
        match disk.get(&k) {
            Some(existing) if existing != fingerprint => {
                cache.extend(disk);
                return Err(io::Error::other(
                    "a different host key was pinned for this host in the meantime",
                ));
            }
            Some(_) => {}
            None => {
                disk.insert(k, fingerprint.to_string());
                self.dir.save(HOSTKEYS_FILE, &disk)?;
            }
        }
        *cache = disk;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Auth, AuthChoice, Machine, ServerForm, apply_server_form};

    #[test]
    fn hex_is_lowercase_colon_separated() {
        let mut d = [0u8; 32];
        d[0] = 0xAB;
        d[1] = 0x01;
        d[31] = 0xFF;
        let s = hex_fingerprint(&d);
        assert!(s.starts_with("ab:01:00:"));
        assert!(s.ends_with(":ff"));
        assert_eq!(s.len(), 32 * 3 - 1);
    }

    #[test]
    fn first_seen_is_pinned_then_matches() {
        let store = MemoryHostKeys::default();
        assert_eq!(
            verify_host_key("aa:bb", "devbox", 22, &store).unwrap(),
            HostKeyDecision::Pinned
        );
        assert_eq!(store.pinned("devbox", 22).as_deref(), Some("aa:bb"));
        assert_eq!(
            verify_host_key("aa:bb", "devbox", 22, &store).unwrap(),
            HostKeyDecision::Matched
        );
    }

    #[test]
    fn mismatch_is_refused_and_does_not_write() {
        let store = MemoryHostKeys::default();
        store.pin("devbox", 22, "aa:bb").unwrap();
        assert_eq!(
            verify_host_key("11:22", "devbox", 22, &store).unwrap(),
            HostKeyDecision::Mismatch {
                expected: "aa:bb".into(),
                got: "11:22".into()
            }
        );
        assert_eq!(store.pinned("devbox", 22).as_deref(), Some("aa:bb"));
    }

    #[test]
    fn pins_are_per_host_and_port() {
        let store = MemoryHostKeys::default();
        store.pin("devbox", 22, "aa").unwrap();
        assert_eq!(store.pinned("devbox", 2222), None);
        assert_eq!(store.pinned("other", 22), None);
    }

    #[test]
    fn json_pins_persist_across_instances() {
        let dir = tempfile::tempdir().unwrap();
        let a = JsonHostKeys::new(DataDir::new(dir.path())).unwrap();
        assert_eq!(
            verify_host_key("aa:bb", "10.0.0.5", 22, &a).unwrap(),
            HostKeyDecision::Pinned
        );
        let b = JsonHostKeys::new(DataDir::new(dir.path())).unwrap();
        assert_eq!(b.pinned("10.0.0.5", 22).as_deref(), Some("aa:bb"));
        let raw = std::fs::read_to_string(dir.path().join(HOSTKEYS_FILE)).unwrap();
        assert!(raw.contains("\"10.0.0.5:22\""));
    }

    #[test]
    fn two_instances_pinning_different_hosts_both_survive() {
        let dir = tempfile::tempdir().unwrap();
        let a = JsonHostKeys::new(DataDir::new(dir.path())).unwrap();
        let b = JsonHostKeys::new(DataDir::new(dir.path())).unwrap();
        a.pin("one", 22, "aa").unwrap();
        b.pin("two", 22, "bb").unwrap();
        let c = JsonHostKeys::new(DataDir::new(dir.path())).unwrap();
        assert_eq!(c.pinned("one", 22).as_deref(), Some("aa"));
        assert_eq!(c.pinned("two", 22).as_deref(), Some("bb"));
    }

    #[test]
    fn a_pin_made_elsewhere_for_the_same_host_is_not_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let a = JsonHostKeys::new(DataDir::new(dir.path())).unwrap();
        let b = JsonHostKeys::new(DataDir::new(dir.path())).unwrap();
        a.pin("one", 22, "aa").unwrap();
        assert!(b.pin("one", 22, "zz").is_err());
        assert_eq!(b.pinned("one", 22).as_deref(), Some("aa"));
        let c = JsonHostKeys::new(DataDir::new(dir.path())).unwrap();
        assert_eq!(c.pinned("one", 22).as_deref(), Some("aa"));
    }

    #[test]
    fn a_failed_save_is_reported_not_swallowed() {
        let dir = tempfile::tempdir().unwrap();
        let a = JsonHostKeys::new(DataDir::new(dir.path())).unwrap();
        std::fs::create_dir(dir.path().join(format!("{HOSTKEYS_FILE}.tmp"))).unwrap();
        assert!(a.pin("one", 22, "aa").is_err());
        assert!(verify_host_key("aa", "one", 22, &a).is_err());
    }

    #[test]
    fn a_new_host_or_port_leaves_the_old_pin_in_place() {
        let store = MemoryHostKeys::default();
        store.pin("old", 22, "aa:bb").unwrap();
        let old = Machine {
            id: uuid::Uuid::nil(),
            name: "devbox".into(),
            host: "old".into(),
            port: 22,
            user: "sam".into(),
            auth: Auth::Agent,
            jump: None,
        };
        let mut form = ServerForm::from_machine(&old, false);
        form.host = "new".into();
        form.port = "2222".into();
        form.auth = AuthChoice::Agent;
        let (edited, _) = apply_server_form(Some(&old), &form);
        assert_eq!(store.pinned("old", 22).as_deref(), Some("aa:bb"));
        assert_eq!(store.pinned(&edited.host, edited.port), None);
    }

    #[test]
    fn unreadable_hostkeys_are_not_rewritten() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(HOSTKEYS_FILE);
        std::fs::create_dir(&path).unwrap();
        let Err(err) = JsonHostKeys::new(DataDir::new(dir.path())) else {
            panic!("unreadable hostkeys loaded");
        };
        assert_ne!(err.kind(), io::ErrorKind::NotFound);
        assert!(path.is_dir());
    }
}
