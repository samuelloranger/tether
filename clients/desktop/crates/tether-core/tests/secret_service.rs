//! Runs only on a private session bus the caller set up, never the user's own:
//!
//! ```sh
//! dbus-run-session -- sh -c 'echo pw | gnome-keyring-daemon --unlock --components=secrets >/dev/null;
//!   TETHER_TEST_SECRET_SERVICE=present cargo test -p tether-core --test secret_service'
//! # a bus with no activatable service (a minimal bus config without servicedirs)
//! dbus-run-session --config-file=bare.conf -- env TETHER_TEST_SECRET_SERVICE=absent cargo test -p tether-core --test secret_service
//! # a bus that activates gnome-keyring locked, with nobody to answer the unlock prompt
//! dbus-run-session -- env TETHER_TEST_SECRET_SERVICE=locked cargo test -p tether-core --test secret_service
//! # the same bus with a fresh XDG_DATA_HOME, so there is no default keyring at all
//! dbus-run-session -- env TETHER_TEST_SECRET_SERVICE=nodefault cargo test -p tether-core --test secret_service
//! # no session bus: DBUS_SESSION_BUS_ADDRESS unset and an empty XDG_RUNTIME_DIR
//! env -u DBUS_SESSION_BUS_ADDRESS TETHER_TEST_SECRET_SERVICE=nobus cargo test -p tether-core --test secret_service
//! ```
//!
//! Also point `XDG_RUNTIME_DIR` and `XDG_DATA_HOME` at scratch folders so a started daemon
//! cannot touch the real keyring.
#![cfg(target_os = "linux")]

use tether_core::{SecretError, SecretServiceStore, SecretStore, key_account};
use uuid::Uuid;

fn mode() -> Option<String> {
    std::env::var("TETHER_TEST_SECRET_SERVICE").ok()
}

#[test]
fn round_trips_through_a_private_keyring() {
    if mode().as_deref() != Some("present") {
        return;
    }
    let store = SecretServiceStore;
    let account = key_account(Uuid::new_v4());
    assert!(store.get(&account).unwrap().is_none());
    store.set(&account, b"-----BEGIN PRIVATE KEY-----").unwrap();
    assert_eq!(
        store.get(&account).unwrap().unwrap().as_slice(),
        b"-----BEGIN PRIVATE KEY-----"
    );
    store.set(&account, b"second").unwrap();
    assert_eq!(store.get(&account).unwrap().unwrap().as_slice(), b"second");
    assert!(store.contains(&account).unwrap());
    store.delete(&account).unwrap();
    assert!(store.get(&account).unwrap().is_none());
    assert!(!store.contains(&account).unwrap());
    store.delete(&account).unwrap();

    // Last, because it leaves the keyring locked.
    let account = key_account(Uuid::new_v4());
    store.set(&account, b"secret").unwrap();
    let service =
        secret_service::blocking::SecretService::connect(secret_service::EncryptionType::Dh)
            .unwrap();
    service.get_default_collection().unwrap().lock().unwrap();
    assert!(store.contains(&account).unwrap());
    let read = store.get(&account);
    assert!(matches!(read, Err(SecretError::Locked)), "{read:?}");
}

#[test]
fn a_bus_without_a_service_refuses_to_save() {
    if mode().as_deref() != Some("absent") {
        return;
    }
    let store = SecretServiceStore;
    let account = key_account(Uuid::new_v4());
    let set = store.set(&account, b"secret");
    assert!(matches!(set, Err(SecretError::Unavailable)), "{set:?}");
    assert!(matches!(store.get(&account), Err(SecretError::Unavailable)));
}

#[test]
fn a_locked_keyring_with_no_one_to_unlock_it_refuses_to_save() {
    if mode().as_deref() != Some("locked") {
        return;
    }
    let store = SecretServiceStore;
    let set = store.set(&key_account(Uuid::new_v4()), b"secret");
    assert!(matches!(set, Err(SecretError::Locked)), "{set:?}");
}

#[test]
fn a_profile_with_no_keyring_reads_as_empty_and_only_a_save_asks_to_create_one() {
    if mode().as_deref() != Some("nodefault") {
        return;
    }
    let store = SecretServiceStore;
    let account = key_account(Uuid::new_v4());
    assert!(store.get(&account).unwrap().is_none());
    assert!(!store.contains(&account).unwrap());
    store.delete(&account).unwrap();
    let set = store.set(&account, b"secret");
    assert!(matches!(set, Err(SecretError::Locked)), "{set:?}");
}

#[test]
fn no_session_bus_means_no_service() {
    if mode().as_deref() != Some("nobus") {
        return;
    }
    let store = SecretServiceStore;
    let account = key_account(Uuid::new_v4());
    let set = store.set(&account, b"secret");
    assert!(matches!(set, Err(SecretError::Unavailable)), "{set:?}");
    assert!(matches!(
        store.contains(&account),
        Err(SecretError::Unavailable)
    ));
}
