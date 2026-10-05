use std::collections::BTreeMap;
use std::io;
use std::sync::Mutex;

use crate::DataDir;

pub const HOSTKEYS_FILE: &str = "hostkeys.json";

pub trait HostKeyStore: Send + Sync {
    fn pinned(&self, host: &str, port: u16) -> Option<String>;
    fn pin(&self, host: &str, port: u16, fingerprint: &str);
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
) -> HostKeyDecision {
    match store.pinned(host, port) {
        None => {
            store.pin(host, port, fingerprint);
            HostKeyDecision::Pinned
        }
        Some(pinned) if pinned == fingerprint => HostKeyDecision::Matched,
        Some(expected) => HostKeyDecision::Mismatch {
            expected,
            got: fingerprint.to_string(),
        },
    }
}

#[derive(Default)]
pub struct MemoryHostKeys {
    pins: Mutex<BTreeMap<String, String>>,
}

impl HostKeyStore for MemoryHostKeys {
    fn pinned(&self, host: &str, port: u16) -> Option<String> {
        self.pins.lock().unwrap().get(&key(host, port)).cloned()
    }

    fn pin(&self, host: &str, port: u16, fingerprint: &str) {
        self.pins
            .lock()
            .unwrap()
            .insert(key(host, port), fingerprint.to_string());
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

    fn pin(&self, host: &str, port: u16, fingerprint: &str) {
        let mut pins = self.pins.lock().unwrap();
        pins.insert(key(host, port), fingerprint.to_string());
        // The pin holds for this run even if the disk write fails; the next run re-pins.
        let _ = self.dir.save(HOSTKEYS_FILE, &*pins);
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
            verify_host_key("aa:bb", "devbox", 22, &store),
            HostKeyDecision::Pinned
        );
        assert_eq!(store.pinned("devbox", 22).as_deref(), Some("aa:bb"));
        assert_eq!(
            verify_host_key("aa:bb", "devbox", 22, &store),
            HostKeyDecision::Matched
        );
    }

    #[test]
    fn mismatch_is_refused_and_does_not_write() {
        let store = MemoryHostKeys::default();
        store.pin("devbox", 22, "aa:bb");
        assert_eq!(
            verify_host_key("11:22", "devbox", 22, &store),
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
        store.pin("devbox", 22, "aa");
        assert_eq!(store.pinned("devbox", 2222), None);
        assert_eq!(store.pinned("other", 22), None);
    }

    #[test]
    fn json_pins_persist_across_instances() {
        let dir = tempfile::tempdir().unwrap();
        let a = JsonHostKeys::new(DataDir::new(dir.path())).unwrap();
        assert_eq!(
            verify_host_key("aa:bb", "10.0.0.5", 22, &a),
            HostKeyDecision::Pinned
        );
        let b = JsonHostKeys::new(DataDir::new(dir.path())).unwrap();
        assert_eq!(b.pinned("10.0.0.5", 22).as_deref(), Some("aa:bb"));
        let raw = std::fs::read_to_string(dir.path().join(HOSTKEYS_FILE)).unwrap();
        assert!(raw.contains("\"10.0.0.5:22\""));
    }

    #[test]
    fn a_new_host_or_port_leaves_the_old_pin_in_place() {
        let store = MemoryHostKeys::default();
        store.pin("old", 22, "aa:bb");
        let old = Machine {
            id: uuid::Uuid::nil(),
            name: "devbox".into(),
            host: "old".into(),
            port: 22,
            user: "sam".into(),
            auth: Auth::Agent,
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
