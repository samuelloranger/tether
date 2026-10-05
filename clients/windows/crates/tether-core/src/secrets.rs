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
    #[error("not a secret account: {0:?}")]
    BadAccount(String),
}

pub trait SecretStore: Send + Sync {
    fn get(&self, account: &str) -> Result<Option<Zeroizing<Vec<u8>>>, SecretError>;
    fn set(&self, account: &str, secret: &[u8]) -> Result<(), SecretError>;
    /// Deleting an absent secret is not an error.
    fn delete(&self, account: &str) -> Result<(), SecretError>;
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
        && account.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    if ok { Ok(()) } else { Err(SecretError::BadAccount(account.to_string())) }
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
        self.secrets.lock().unwrap().insert(account.to_string(), Zeroizing::new(secret.to_vec()));
        Ok(())
    }

    fn delete(&self, account: &str) -> Result<(), SecretError> {
        check_account(account)?;
        self.secrets.lock().unwrap().remove(account);
        Ok(())
    }
}

#[cfg(windows)]
pub struct DpapiSecretStore {
    dir: std::path::PathBuf,
}

#[cfg(windows)]
impl DpapiSecretStore {
    pub fn new(dir: &DataDir) -> Self {
        Self { dir: dir.root().join("secrets") }
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
        CRYPT_INTEGER_BLOB { cbData: bytes.len() as u32, pbData: bytes.as_ptr() as *mut u8 }
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
            CryptProtectData(&input, PCWSTR::null(), Some(&entropy), None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out)
                .map_err(|e| SecretError::Crypto(e.to_string()))?;
            Ok(take(out).to_vec())
        }
    }

    pub fn unprotect(sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>, SecretError> {
        let input = blob(sealed);
        let entropy = blob(ENTROPY);
        let mut out = CRYPT_INTEGER_BLOB::default();
        unsafe {
            CryptUnprotectData(&input, None, Some(&entropy), None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out)
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
        assert_eq!(store.get(&account).unwrap().unwrap().as_slice(), b"-----BEGIN PRIVATE KEY-----");
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
        assert_eq!(password_account(id), "host-password-6f1c8a52-0d0e-4b9e-9a37-0a6f8e8c1d11");
    }

    #[test]
    fn memory_store_round_trips_and_deletes() {
        exercise(&MemorySecretStore::default());
    }

    #[test]
    fn account_names_cannot_escape_the_secrets_dir() {
        let store = MemorySecretStore::default();
        for bad in ["", "../profiles", "a\\b", "a/b", "key-x.bin", "key x"] {
            assert!(matches!(store.set(bad, b"x"), Err(SecretError::BadAccount(_))), "{bad:?}");
            assert!(matches!(store.get(bad), Err(SecretError::BadAccount(_))), "{bad:?}");
        }
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
        let on_disk = std::fs::read(dir.path().join("secrets").join(format!("{account}.bin"))).unwrap();
        assert!(!on_disk.windows(7).any(|w| w == b"hunter2"));
    }
}
