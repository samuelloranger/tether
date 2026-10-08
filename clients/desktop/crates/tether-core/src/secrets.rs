use std::collections::HashMap;
use std::io;
use std::sync::Mutex;

use uuid::Uuid;
use zeroize::Zeroizing;

#[cfg(windows)]
use crate::DataDir;

#[derive(Debug, thiserror::Error)]
pub enum SecretError {
    #[error("secret store I/O: {0}")]
    Io(#[from] io::Error),
    #[error("DPAPI: {0}")]
    Crypto(String),
    #[error(
        "No secret service is running. Start GNOME Keyring, KWallet or KeePassXC with its Secret Service enabled, then try again."
    )]
    Unavailable,
    #[error("The keyring is locked. Unlock it and try again.")]
    Locked,
    #[error("The keyring did not answer in time. Try again.")]
    Timeout,
    #[error("secret service: {0}")]
    Backend(String),
    #[error("not a secret account: {0:?}")]
    BadAccount(String),
}

pub trait SecretStore: Send + Sync {
    fn get(&self, account: &str) -> Result<Option<Zeroizing<Vec<u8>>>, SecretError>;
    fn set(&self, account: &str, secret: &[u8]) -> Result<(), SecretError>;
    /// Deleting an absent secret is not an error.
    fn delete(&self, account: &str) -> Result<(), SecretError>;
    /// Whether a secret exists, without asking the user for anything the store could ask.
    fn contains(&self, account: &str) -> Result<bool, SecretError> {
        Ok(self.get(account)?.is_some())
    }
}

pub fn key_account(id: Uuid) -> String {
    format!("key-{id}")
}

pub fn password_account(id: Uuid) -> String {
    format!("host-password-{id}")
}

/// The account becomes a file name, so only the characters Tether's own names use pass.
fn check_account(account: &str) -> Result<(), SecretError> {
    let ok = !account.is_empty()
        && account
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-');
    if ok {
        Ok(())
    } else {
        Err(SecretError::BadAccount(account.to_string()))
    }
}

#[derive(Default)]
pub struct MemorySecretStore {
    secrets: Mutex<HashMap<String, Zeroizing<Vec<u8>>>>,
}

impl SecretStore for MemorySecretStore {
    fn get(&self, account: &str) -> Result<Option<Zeroizing<Vec<u8>>>, SecretError> {
        check_account(account)?;
        Ok(self.secrets.lock().unwrap().get(account).cloned())
    }

    fn set(&self, account: &str, secret: &[u8]) -> Result<(), SecretError> {
        check_account(account)?;
        self.secrets
            .lock()
            .unwrap()
            .insert(account.to_string(), Zeroizing::new(secret.to_vec()));
        Ok(())
    }

    fn delete(&self, account: &str) -> Result<(), SecretError> {
        check_account(account)?;
        self.secrets.lock().unwrap().remove(account);
        Ok(())
    }
}

/// The freedesktop Secret Service (GNOME Keyring, KWallet, KeePassXC) over the session bus.
/// There is no plaintext fallback: with no service, saving fails.
#[cfg(target_os = "linux")]
#[derive(Default)]
pub struct SecretServiceStore;

#[cfg(target_os = "linux")]
mod secret_service_store {
    use std::collections::HashMap;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    use secret_service::blocking::{Collection, SecretService};
    use secret_service::{EncryptionType, Error as SsError};
    use zeroize::Zeroizing;

    use super::{SecretError, SecretServiceStore, SecretStore, check_account};

    const APPLICATION: &str = "tether";
    /// How long a call that shows no prompt may take. Callers sit on the UI thread.
    const QUIET: Duration = Duration::from_secs(5);
    /// Once the keyring shows an unlock or creation prompt, how long the user gets to answer.
    const PROMPTED: Duration = Duration::from_secs(120);

    pub(super) fn attributes(account: &str) -> HashMap<&str, &str> {
        HashMap::from([("application", APPLICATION), ("account", account)])
    }

    pub(super) fn label(account: &str) -> String {
        format!("Tether ({account})")
    }

    fn is_service_missing(name: &str) -> bool {
        matches!(
            name,
            "org.freedesktop.DBus.Error.ServiceUnknown"
                | "org.freedesktop.DBus.Error.NameHasNoOwner"
                | "org.freedesktop.DBus.Error.NoServer"
                | "org.freedesktop.DBus.Error.FileNotFound"
        )
    }

    pub(super) fn map_error(e: SsError) -> SecretError {
        match e {
            SsError::Unavailable => SecretError::Unavailable,
            SsError::Locked | SsError::Prompt => SecretError::Locked,
            SsError::Zbus(zbus::Error::Address(_)) | SsError::Zbus(zbus::Error::InputOutput(_)) => {
                SecretError::Unavailable
            }
            SsError::Zbus(zbus::Error::MethodError(name, _, _)) if is_service_missing(&name) => {
                SecretError::Unavailable
            }
            SsError::ZbusFdo(zbus::fdo::Error::ServiceUnknown(_))
            | SsError::ZbusFdo(zbus::fdo::Error::NameHasNoOwner(_)) => SecretError::Unavailable,
            other => SecretError::Backend(other.to_string()),
        }
    }

    enum Event<T> {
        Prompting,
        Done(Result<T, SecretError>),
    }

    /// Runs `work` on its own thread so a stuck keyring can never hold the caller for longer
    /// than `quiet`, or than `prompted` once `work` reports it is waiting on a prompt. A
    /// timed-out thread is left to finish on its own.
    pub(super) fn run_bounded<T: Send + 'static>(
        quiet: Duration,
        prompted: Duration,
        work: impl FnOnce(&dyn Fn()) -> Result<T, SecretError> + Send + 'static,
    ) -> Result<T, SecretError> {
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let result = work(&|| {
                let _ = tx.send(Event::Prompting);
            });
            let _ = tx.send(Event::Done(result));
        });
        let mut deadline = Instant::now() + quiet;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match rx.recv_timeout(left) {
                Ok(Event::Done(result)) => return result,
                Ok(Event::Prompting) => deadline = Instant::now() + prompted,
                Err(_) => return Err(SecretError::Timeout),
            }
        }
    }

    /// Any failure to reach the service means there is none to use.
    fn connect() -> Result<SecretService<'static>, SecretError> {
        SecretService::connect(EncryptionType::Dh).map_err(|_| SecretError::Unavailable)
    }

    fn default_collection<'a>(
        service: &'a SecretService<'a>,
        create: bool,
        prompting: &dyn Fn(),
    ) -> Result<Option<Collection<'a>>, SecretError> {
        match service.get_default_collection() {
            Ok(c) => Ok(Some(c)),
            // A fresh profile has no default keyring; only a save may ask to create one.
            Err(SsError::NoResult) if create => {
                prompting();
                service
                    .create_collection("Login", "default")
                    .map(Some)
                    .map_err(map_error)
            }
            Err(SsError::NoResult) => Ok(None),
            Err(e) => Err(map_error(e)),
        }
    }

    fn unlocked(collection: &Collection<'_>, prompting: &dyn Fn()) -> Result<(), SecretError> {
        if collection.is_locked().map_err(map_error)? {
            prompting();
            collection.unlock().map_err(map_error)?;
        }
        collection.ensure_unlocked().map_err(map_error)
    }

    fn read(
        account: String,
        prompting: &dyn Fn(),
    ) -> Result<Option<Zeroizing<Vec<u8>>>, SecretError> {
        let service = connect()?;
        let Some(collection) = default_collection(&service, false, prompting)? else {
            return Ok(None);
        };
        unlocked(&collection, prompting)?;
        let items = collection
            .search_items(attributes(&account))
            .map_err(map_error)?;
        items
            .first()
            .map(|item| item.get_secret().map(Zeroizing::new).map_err(map_error))
            .transpose()
    }

    fn write(
        account: String,
        secret: Zeroizing<Vec<u8>>,
        prompting: &dyn Fn(),
    ) -> Result<(), SecretError> {
        let service = connect()?;
        let collection = default_collection(&service, true, prompting)?
            .ok_or_else(|| SecretError::Backend("no default collection".into()))?;
        unlocked(&collection, prompting)?;
        collection
            .create_item(
                &label(&account),
                attributes(&account),
                &secret,
                true,
                "application/octet-stream",
            )
            .map(drop)
            .map_err(map_error)
    }

    fn remove(account: String, prompting: &dyn Fn()) -> Result<(), SecretError> {
        let service = connect()?;
        let Some(collection) = default_collection(&service, false, prompting)? else {
            return Ok(());
        };
        unlocked(&collection, prompting)?;
        for item in collection
            .search_items(attributes(&account))
            .map_err(map_error)?
        {
            item.delete().map_err(map_error)?;
        }
        Ok(())
    }

    /// Existence needs no unlock: a search lists locked items too.
    fn exists(account: String, _prompting: &dyn Fn()) -> Result<bool, SecretError> {
        let service = connect()?;
        let Some(collection) = default_collection(&service, false, &|| {})? else {
            return Ok(false);
        };
        Ok(!collection
            .search_items(attributes(&account))
            .map_err(map_error)?
            .is_empty())
    }

    impl SecretStore for SecretServiceStore {
        fn get(&self, account: &str) -> Result<Option<Zeroizing<Vec<u8>>>, SecretError> {
            check_account(account)?;
            let account = account.to_string();
            run_bounded(QUIET, PROMPTED, move |p| read(account, p))
        }

        fn set(&self, account: &str, secret: &[u8]) -> Result<(), SecretError> {
            check_account(account)?;
            let (account, secret) = (account.to_string(), Zeroizing::new(secret.to_vec()));
            run_bounded(QUIET, PROMPTED, move |p| write(account, secret, p))
        }

        fn delete(&self, account: &str) -> Result<(), SecretError> {
            check_account(account)?;
            let account = account.to_string();
            run_bounded(QUIET, PROMPTED, move |p| remove(account, p))
        }

        fn contains(&self, account: &str) -> Result<bool, SecretError> {
            check_account(account)?;
            let account = account.to_string();
            run_bounded(QUIET, QUIET, move |p| exists(account, p))
        }
    }
}

#[cfg(windows)]
pub struct DpapiSecretStore {
    dir: std::path::PathBuf,
}

#[cfg(windows)]
impl DpapiSecretStore {
    pub fn new(dir: &DataDir) -> Self {
        Self {
            dir: dir.root().join("secrets"),
        }
    }

    fn path(&self, account: &str) -> std::path::PathBuf {
        self.dir.join(format!("{account}.bin"))
    }
}

#[cfg(windows)]
impl SecretStore for DpapiSecretStore {
    fn get(&self, account: &str) -> Result<Option<Zeroizing<Vec<u8>>>, SecretError> {
        check_account(account)?;
        match std::fs::read(self.path(account)) {
            Ok(sealed) => dpapi::unprotect(&sealed).map(Some),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    fn set(&self, account: &str, secret: &[u8]) -> Result<(), SecretError> {
        check_account(account)?;
        let sealed = dpapi::protect(secret)?;
        crate::store::write_atomic(&self.path(account), &sealed)?;
        Ok(())
    }

    fn delete(&self, account: &str) -> Result<(), SecretError> {
        check_account(account)?;
        match std::fs::remove_file(self.path(account)) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e.into()),
            _ => Ok(()),
        }
    }
}

#[cfg(windows)]
mod dpapi {
    use windows::Win32::Foundation::{HLOCAL, LocalFree};
    use windows::Win32::Security::Cryptography::{
        CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData,
    };
    use windows::core::PCWSTR;
    use zeroize::Zeroizing;

    use super::SecretError;

    // Changing these after release makes every stored secret undecryptable.
    const ENTROPY: &[u8] = b"tether-windows-secrets-v1";

    fn blob(bytes: &[u8]) -> CRYPT_INTEGER_BLOB {
        CRYPT_INTEGER_BLOB {
            cbData: bytes.len() as u32,
            pbData: bytes.as_ptr() as *mut u8,
        }
    }

    /// Copies the LocalAlloc'd output out, wipes it, and frees it.
    unsafe fn take(out: CRYPT_INTEGER_BLOB) -> Zeroizing<Vec<u8>> {
        let bytes = unsafe { std::slice::from_raw_parts(out.pbData, out.cbData as usize) };
        let copy = Zeroizing::new(bytes.to_vec());
        unsafe {
            std::ptr::write_bytes(out.pbData, 0, out.cbData as usize);
            let _ = LocalFree(Some(HLOCAL(out.pbData.cast())));
        }
        copy
    }

    pub fn protect(plain: &[u8]) -> Result<Vec<u8>, SecretError> {
        let input = blob(plain);
        let entropy = blob(ENTROPY);
        let mut out = CRYPT_INTEGER_BLOB::default();
        unsafe {
            CryptProtectData(
                &input,
                PCWSTR::null(),
                Some(&entropy),
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            )
            .map_err(|e| SecretError::Crypto(e.to_string()))?;
            Ok(take(out).to_vec())
        }
    }

    pub fn unprotect(sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>, SecretError> {
        let input = blob(sealed);
        let entropy = blob(ENTROPY);
        let mut out = CRYPT_INTEGER_BLOB::default();
        unsafe {
            CryptUnprotectData(
                &input,
                None,
                Some(&entropy),
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            )
            .map_err(|e| SecretError::Crypto(e.to_string()))?;
            Ok(take(out))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exercise(store: &dyn SecretStore) {
        let account = key_account(Uuid::nil());
        assert!(store.get(&account).unwrap().is_none());
        store.set(&account, b"-----BEGIN PRIVATE KEY-----").unwrap();
        assert_eq!(
            store.get(&account).unwrap().unwrap().as_slice(),
            b"-----BEGIN PRIVATE KEY-----"
        );
        store.set(&account, b"second").unwrap();
        assert_eq!(store.get(&account).unwrap().unwrap().as_slice(), b"second");
        store.delete(&account).unwrap();
        assert!(store.get(&account).unwrap().is_none());
        store.delete(&account).unwrap();
    }

    #[test]
    fn account_names() {
        let id = Uuid::parse_str("6f1c8a52-0d0e-4b9e-9a37-0a6f8e8c1d11").unwrap();
        assert_eq!(key_account(id), "key-6f1c8a52-0d0e-4b9e-9a37-0a6f8e8c1d11");
        assert_eq!(
            password_account(id),
            "host-password-6f1c8a52-0d0e-4b9e-9a37-0a6f8e8c1d11"
        );
    }

    #[test]
    fn memory_store_round_trips_and_deletes() {
        exercise(&MemorySecretStore::default());
    }

    #[test]
    fn account_names_cannot_escape_the_secrets_dir() {
        let store = MemorySecretStore::default();
        for bad in ["", "../profiles", "a\\b", "a/b", "key-x.bin", "key x"] {
            assert!(
                matches!(store.set(bad, b"x"), Err(SecretError::BadAccount(_))),
                "{bad:?}"
            );
            assert!(
                matches!(store.get(bad), Err(SecretError::BadAccount(_))),
                "{bad:?}"
            );
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn secret_service_items_carry_the_app_and_account() {
        use super::secret_service_store::{attributes, label};
        let a = attributes("key-1");
        assert_eq!(a["application"], "tether");
        assert_eq!(a["account"], "key-1");
        assert_eq!(label("key-1"), "Tether (key-1)");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn secret_service_errors_map_to_what_the_user_can_act_on() {
        use super::secret_service_store::map_error;
        use secret_service::Error as E;
        assert!(matches!(
            map_error(E::Unavailable),
            SecretError::Unavailable
        ));
        assert!(matches!(map_error(E::Locked), SecretError::Locked));
        assert!(matches!(map_error(E::Prompt), SecretError::Locked));
        assert!(matches!(
            map_error(E::Zbus(zbus::Error::Address("none".into()))),
            SecretError::Unavailable
        ));
        assert!(matches!(map_error(E::NoResult), SecretError::Backend(_)));
    }

    #[cfg(target_os = "linux")]
    mod bounded {
        use super::super::secret_service_store::run_bounded;
        use super::*;
        use std::time::Duration;

        const SHORT: Duration = Duration::from_millis(100);

        #[test]
        fn a_quiet_call_that_hangs_times_out() {
            let r = run_bounded(SHORT, Duration::from_secs(30), |_| {
                std::thread::sleep(Duration::from_secs(5));
                Ok(())
            });
            assert!(matches!(r, Err(SecretError::Timeout)));
        }

        #[test]
        fn a_prompt_extends_the_wait() {
            let r = run_bounded(SHORT, Duration::from_secs(5), |prompting| {
                prompting();
                std::thread::sleep(SHORT * 4);
                Ok(7)
            });
            assert_eq!(r.unwrap(), 7);
        }

        #[test]
        fn a_prompt_has_its_own_bound() {
            let r = run_bounded(SHORT, SHORT, |prompting| {
                prompting();
                std::thread::sleep(Duration::from_secs(5));
                Ok(())
            });
            assert!(matches!(r, Err(SecretError::Timeout)));
        }

        #[test]
        fn results_and_errors_pass_through() {
            assert!(matches!(
                run_bounded(SHORT, SHORT, |_| Err::<(), _>(SecretError::Locked)),
                Err(SecretError::Locked)
            ));
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn secret_service_rejects_bad_accounts_before_any_bus_call() {
        let store = SecretServiceStore;
        assert!(matches!(
            store.set("../x", b"x"),
            Err(SecretError::BadAccount(_))
        ));
    }

    #[cfg(windows)]
    #[test]
    fn dpapi_store_round_trips_and_encrypts_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let data = DataDir::new(dir.path());
        let store = DpapiSecretStore::new(&data);
        exercise(&store);

        let account = password_account(Uuid::nil());
        store.set(&account, b"hunter2-hunter2").unwrap();
        let on_disk =
            std::fs::read(dir.path().join("secrets").join(format!("{account}.bin"))).unwrap();
        assert!(!on_disk.windows(7).any(|w| w == b"hunter2"));
    }
}
