# Windows M1 — Core Foundation Implementation Plan

> **For the implementer:** Work through the tasks in order. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the `clients/windows/` Cargo workspace and CI, and build `tether-core`'s storage, vault, form, preference, theme, font and host-key logic, all host-free and tested on Linux and Windows.

**Architecture:** One workspace, four crates (three stubs plus `tether-core`). `tether-core` is pure logic plus a `#[cfg(windows)]` DPAPI secret store. JSON files go through one `DataDir` that writes temp-then-rename and quarantines corrupt files. Key material is parsed with `ssh-key` (OpenSSH), `ed25519-dalek`, `rsa`, `p256`, `p384` (PKCS#8 / PKCS#1); public lines and fingerprints are encoded by hand, byte-for-byte like iOS `SSHKeyEncoding`.

**Tech Stack:** Rust stable (edition 2024), serde 1, serde_json 1, uuid 1 (v4, serde), zeroize 1, thiserror 2, ssh-key 0.6, ed25519-dalek 2, rsa 0.9, p256 0.13, p384 0.13, sha2 0.10, base64 0.22, rand_core 0.6, windows 0.62 (Windows only), tempfile 3 (dev).

**Spec:** `clients/windows/SPEC.md`

**Roadmap:** `docs/superpowers/plans/2026-10-05-windows-00-roadmap.md` (the cross-crate contract; every name below matches it)

## Global Constraints

All of the roadmap's Global Constraints apply. M1-specific:

- Workspace root `clients/windows/Cargo.toml`, `resolver = "3"`, `edition = "2024"`, `rust-version = "1.85"`. Run every cargo command from `clients/windows/`.
- `ssh-key 0.6.7` is built against `ed25519-dalek 2`, `rsa 0.9`, `p256/p384 0.13`, `sha2 0.10`, `rand_core 0.6`. Pin those majors — do **not** take `ed25519-dalek 3`, `sha2 0.11` or `rand_core 0.10`; two copies of the RustCrypto traits will not interoperate.
- Theme JSON: `include_str!("../../../../apple/TetherKit/Sources/TetherKit/Resources/TerminalThemes.json")` from `crates/tether-core/src/theme.rs`. License: same directory, `TerminalThemes-LICENSE.txt`.
- Hint copy, verbatim: `Name this machine to save it`, `Add a host to save it`, `Add a user to save it`, `Enter a password to save it`, `Choose a key to save it`, `Name this key to save it`, `Paste the private key to save it`, `Paste the public key to save it`, `This key needs a passphrase — Tether can't use it yet`, `The public key doesn't match the private key`.
- Terminal defaults: scheme `tether`, font `cascadia-mono`, 14 pt, 1.00×, padding 8, `block`, blink off. Clamps: size 8–24 step 1; spacing 1.00–1.60 step 0.05; padding 0–24 step 2.
- Font ids, in order: `cascadia-mono`, `cascadia-code`, `jetbrains-mono`, `monaspace-neon`, `monaspace-radon`, `maple-mono`, `comic-mono`. Only Cascadia Code draws ligatures.
- DPAPI entropy bytes: `b"tether-windows-secrets-v1"`. Never change them after release: every stored secret would stop decrypting.
- Note for the executor: the repo-root `.gitignore` ignores `docs/`. Plan files under `docs/superpowers/` need `git add -f`.

## Review Focus

1. **A corrupt or hand-edited JSON file** (`profiles.json` cut off mid-write by an editor, invalid UTF-8) — the app starts with defaults, the bad file is kept as `<file>.corrupt-<unix>`, and the next save does not destroy the user's original. Pinned in Task 2 (`corrupt_file_is_quarantined_not_overwritten`).
2. **A key copied from Windows Notepad** — CRLF line endings, a UTF-8 BOM, trailing blank lines — parses the same as the LF original. Pinned in Task 6 (`crlf_and_bom_parse_like_lf`).
3. **A pasted public key with or without its comment, or with a trailing newline** — the match check compares only type and blob. Pinned in Task 7 (`public_key_comment_does_not_affect_match`).
4. **A `preferences.json` from another version** — missing fields, unknown fields, `size_pt: 99`, `line_spacing: NaN` written as `null` — loads with per-field defaults and clamps. Pinned in Task 9 (`partial_and_out_of_range_prefs_load_clamped`).
5. **A secret account name that is not one Tether builds** (`../profiles`, empty, `a\b`) — refused before it reaches a file path. Pinned in Task 3 (`account_names_cannot_escape_the_secrets_dir`).

---

### Task 1: Workspace scaffold and CI

**Files:**
- Create: `clients/windows/Cargo.toml`
- Create: `clients/windows/rust-toolchain.toml`
- Create: `clients/windows/.gitignore`
- Create: `clients/windows/crates/tether-core/Cargo.toml`, `clients/windows/crates/tether-core/src/lib.rs`
- Create: `clients/windows/crates/tether-ssh/Cargo.toml`, `clients/windows/crates/tether-ssh/src/lib.rs`
- Create: `clients/windows/crates/tether-term/Cargo.toml`, `clients/windows/crates/tether-term/src/lib.rs`
- Create: `clients/windows/crates/tether-app/Cargo.toml`, `clients/windows/crates/tether-app/src/main.rs`
- Modify: `.github/workflows/ci.yml` (append two jobs)

**Interfaces:**
- Consumes: nothing.
- Produces: the workspace and crate names `tether-core`, `tether-ssh`, `tether-term`, `tether-app`; workspace dependency table every later task adds to with `{ workspace = true }`.

- [ ] **Step 1: Write the workspace manifest**

`clients/windows/Cargo.toml`:

```toml
[workspace]
resolver = "3"
members = [
    "crates/tether-core",
    "crates/tether-ssh",
    "crates/tether-term",
    "crates/tether-app",
]

[workspace.package]
version = "0.1.0"
edition = "2024"
rust-version = "1.85"
publish = false

[workspace.dependencies]
tether-core = { path = "crates/tether-core" }
serde = { version = "1.0.229", features = ["derive"] }
serde_json = "1.0.151"
uuid = { version = "1.27", features = ["v4", "serde"] }
zeroize = "1.9"
thiserror = "2.0.21"
ssh-key = { version = "0.6.7", features = ["std"] }
ed25519-dalek = { version = "2.2", features = ["pkcs8", "pem", "rand_core"] }
rsa = { version = "0.9.10", features = ["pem"] }
p256 = { version = "0.13", features = ["pkcs8", "pem", "ecdsa"] }
p384 = { version = "0.13", features = ["pkcs8", "pem", "ecdsa"] }
sha2 = "0.10"
base64 = "0.22"
rand_core = { version = "0.6", features = ["getrandom"] }
windows = { version = "0.62.2", features = ["Win32_Foundation", "Win32_Security_Cryptography"] }
tempfile = "3.27"
```

`clients/windows/rust-toolchain.toml`:

```toml
[toolchain]
channel = "stable"
components = ["rustfmt", "clippy"]
```

`clients/windows/.gitignore`:

```
/target
```

- [ ] **Step 2: Write the four crate stubs**

`clients/windows/crates/tether-core/Cargo.toml`:

```toml
[package]
name = "tether-core"
version.workspace = true
edition.workspace = true
rust-version.workspace = true
publish.workspace = true

[dependencies]
serde.workspace = true
serde_json.workspace = true
uuid.workspace = true
zeroize.workspace = true
thiserror.workspace = true
ssh-key.workspace = true
ed25519-dalek.workspace = true
rsa.workspace = true
p256.workspace = true
p384.workspace = true
sha2.workspace = true
base64.workspace = true
rand_core.workspace = true

[target.'cfg(windows)'.dependencies]
windows.workspace = true

[dev-dependencies]
tempfile.workspace = true
```

`clients/windows/crates/tether-core/src/lib.rs`:

```rust
//! Tether's rules, with no UI and no network.
```

`clients/windows/crates/tether-ssh/Cargo.toml` and `clients/windows/crates/tether-term/Cargo.toml` (same shape, name changed):

```toml
[package]
name = "tether-ssh"
version.workspace = true
edition.workspace = true
rust-version.workspace = true
publish.workspace = true

[dependencies]
tether-core.workspace = true
```

`clients/windows/crates/tether-ssh/src/lib.rs`:

```rust
//! `tether_core::Transport` over `russh`.
```

`clients/windows/crates/tether-term/src/lib.rs`:

```rust
//! `alacritty_terminal` per tab, and the grid rasterizer.
```

`clients/windows/crates/tether-app/Cargo.toml`:

```toml
[package]
name = "tether-app"
version.workspace = true
edition.workspace = true
rust-version.workspace = true
publish.workspace = true

[[bin]]
name = "tether"
path = "src/main.rs"

[dependencies]
tether-core.workspace = true
```

`clients/windows/crates/tether-app/src/main.rs`:

```rust
fn main() {}
```

- [ ] **Step 3: Build and lint the empty workspace**

Run (from `clients/windows`): `cargo build --workspace && cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings`
Expected: all three succeed; `Cargo.lock` is created.

- [ ] **Step 4: Add the CI jobs**

Append to `.github/workflows/ci.yml` under `jobs:` (same indentation as `ios-build:`):

```yaml
  # The Windows client. Lints and tests the whole workspace and builds the app
  # in release; tether-app is the only crate that needs Windows.
  windows-build:
    runs-on: windows-latest
    defaults:
      run:
        working-directory: clients/windows
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4

      - uses: dtolnay/rust-toolchain@stable
        with:
          components: rustfmt, clippy

      - uses: Swatinem/rust-cache@v2
        with:
          workspaces: clients/windows

      - name: Format
        run: cargo fmt --all --check

      - name: Clippy
        run: cargo clippy --workspace --all-targets -- -D warnings

      - name: Test
        run: cargo test --workspace

      - name: Release build of the app
        run: cargo build --release -p tether-app

  # The Windows client's library crates hold no Win32 code outside cfg(windows),
  # so they must also build and pass on Linux.
  windows-libs-linux:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: clients/windows
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4

      - uses: dtolnay/rust-toolchain@stable
        with:
          components: clippy

      - uses: Swatinem/rust-cache@v2
        with:
          workspaces: clients/windows

      - name: Clippy
        run: cargo clippy -p tether-core -p tether-ssh -p tether-term --all-targets -- -D warnings

      - name: Test
        run: cargo test -p tether-core -p tether-ssh -p tether-term
```

- [ ] **Step 5: Commit**

```bash
git add clients/windows/Cargo.toml clients/windows/Cargo.lock clients/windows/rust-toolchain.toml clients/windows/.gitignore clients/windows/crates .github/workflows/ci.yml
git commit -m "build(windows): scaffold the Cargo workspace and CI jobs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `DataDir` — atomic JSON store

**Files:**
- Create: `clients/windows/crates/tether-core/src/store.rs`
- Modify: `clients/windows/crates/tether-core/src/lib.rs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `pub struct DataDir` with `new(root: impl Into<PathBuf>) -> Self`, `default_windows() -> io::Result<Self>`, `root(&self) -> &Path`, `load<T: DeserializeOwned + Default>(&self, file: &str) -> T`, `save<T: Serialize>(&self, file: &str, value: &T) -> io::Result<()>`.
  - `pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()>` (reused by the DPAPI store).
  - `pub(crate) fn unix_now() -> i64`.

- [ ] **Step 1: Write the failing tests**

`clients/windows/crates/tether-core/src/store.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use serde::{Deserialize, Serialize};

    #[derive(Debug, Default, PartialEq, Serialize, Deserialize)]
    struct Doc {
        items: Vec<String>,
    }

    fn doc(items: &[&str]) -> Doc {
        Doc { items: items.iter().map(|s| s.to_string()).collect() }
    }

    #[test]
    fn missing_file_loads_default() {
        let dir = tempfile::tempdir().unwrap();
        let data = DataDir::new(dir.path());
        assert_eq!(data.load::<Doc>("profiles.json"), Doc::default());
    }

    #[test]
    fn save_then_load_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let data = DataDir::new(dir.path().join("Tether"));
        data.save("profiles.json", &doc(&["devbox"])).unwrap();
        assert_eq!(data.load::<Doc>("profiles.json"), doc(&["devbox"]));
    }

    #[test]
    fn save_replaces_and_leaves_no_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let data = DataDir::new(dir.path());
        data.save("profiles.json", &doc(&["a"])).unwrap();
        data.save("profiles.json", &doc(&["b"])).unwrap();
        assert_eq!(data.load::<Doc>("profiles.json"), doc(&["b"]));
        let names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(names, vec!["profiles.json".to_string()]);
    }

    #[test]
    fn corrupt_file_is_quarantined_not_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let data = DataDir::new(dir.path());
        let original = b"{\"items\": [\"devbox\", ";
        std::fs::write(dir.path().join("profiles.json"), original).unwrap();

        assert_eq!(data.load::<Doc>("profiles.json"), Doc::default());
        data.save("profiles.json", &doc(&["new"])).unwrap();

        let quarantined: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| p.file_name().unwrap().to_string_lossy().starts_with("profiles.json.corrupt-"))
            .collect();
        assert_eq!(quarantined.len(), 1);
        assert_eq!(std::fs::read(&quarantined[0]).unwrap(), original);
        assert_eq!(data.load::<Doc>("profiles.json"), doc(&["new"]));
    }
}
```

Add to `lib.rs`:

```rust
pub mod store;
pub use store::DataDir;
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p tether-core store`
Expected: FAIL — `cannot find type DataDir in this scope`.

- [ ] **Step 3: Implement**

Prepend to `store.rs`:

```rust
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde::de::DeserializeOwned;

pub struct DataDir {
    root: PathBuf,
}

impl DataDir {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    /// `%LOCALAPPDATA%\Tether`. Local, not roaming: the DPAPI secrets the records point at
    /// cannot roam with them.
    pub fn default_windows() -> io::Result<Self> {
        let base = std::env::var_os("LOCALAPPDATA")
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "LOCALAPPDATA is not set"))?;
        let dir = Self::new(PathBuf::from(base).join("Tether"));
        fs::create_dir_all(dir.root())?;
        Ok(dir)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// A file that does not parse is moved aside, so the next save cannot destroy what the
    /// user had in it.
    pub fn load<T: DeserializeOwned + Default>(&self, file: &str) -> T {
        let path = self.root.join(file);
        let Ok(bytes) = fs::read(&path) else {
            return T::default();
        };
        match serde_json::from_slice(&bytes) {
            Ok(value) => value,
            Err(_) => {
                let aside = self.root.join(format!("{file}.corrupt-{}", unix_now()));
                let _ = fs::rename(&path, aside);
                T::default()
            }
        }
    }

    pub fn save<T: Serialize>(&self, file: &str, value: &T) -> io::Result<()> {
        let json = serde_json::to_vec_pretty(value).map_err(io::Error::other)?;
        write_atomic(&self.root.join(file), &json)
    }
}

pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let dir = path.parent().unwrap_or(Path::new("."));
    fs::create_dir_all(dir)?;
    let mut tmp_name = path.file_name().unwrap_or_default().to_os_string();
    tmp_name.push(".tmp");
    let tmp = dir.join(tmp_name);
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    // std's rename replaces the target on Windows (MOVEFILE_REPLACE_EXISTING).
    fs::rename(&tmp, path)
}

pub(crate) fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p tether-core store`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add clients/windows/crates/tether-core
git commit -m "feat(windows): add the atomic JSON data dir with corrupt-file quarantine

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Secret stores — memory and DPAPI

**Files:**
- Create: `clients/windows/crates/tether-core/src/secrets.rs`
- Modify: `clients/windows/crates/tether-core/src/lib.rs`

**Interfaces:**
- Consumes: `DataDir`, `store::write_atomic` (Task 2).
- Produces:
  - `pub trait SecretStore: Send + Sync { fn get(&self, account: &str) -> Result<Option<Zeroizing<Vec<u8>>>, SecretError>; fn set(&self, account: &str, secret: &[u8]) -> Result<(), SecretError>; fn delete(&self, account: &str) -> Result<(), SecretError>; }`
  - `pub enum SecretError { Io(io::Error), Crypto(String), BadAccount(String) }` (thiserror).
  - `pub struct MemorySecretStore` (`Default`).
  - `#[cfg(windows)] pub struct DpapiSecretStore` with `new(dir: &DataDir) -> Self` — files at `<root>\secrets\<account>.bin`.
  - `pub fn key_account(id: Uuid) -> String` → `"key-<uuid>"`; `pub fn password_account(id: Uuid) -> String` → `"host-password-<uuid>"`.

- [ ] **Step 1: Write the failing tests**

`clients/windows/crates/tether-core/src/secrets.rs`:

```rust
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
```

Add to `lib.rs`:

```rust
pub mod secrets;
#[cfg(windows)]
pub use secrets::DpapiSecretStore;
pub use secrets::{MemorySecretStore, SecretError, SecretStore, key_account, password_account};
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p tether-core secrets`
Expected: FAIL — `cannot find function key_account`.

- [ ] **Step 3: Implement**

Prepend to `secrets.rs`:

```rust
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
```

If `cargo check` on Windows reports a signature mismatch for `CryptProtectData`, `CryptUnprotectData` or `LocalFree`, open `https://microsoft.github.io/windows-docs-rs/doc/windows/Win32/Security/Cryptography/fn.CryptProtectData.html` for the pinned `windows` version and adjust the `Option`/pointer wrapping only — the arguments and flags stay as written.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p tether-core secrets`
Expected: PASS — 3 tests on Linux, 4 on Windows (the DPAPI round-trip).

- [ ] **Step 5: Commit**

```bash
git add clients/windows/crates/tether-core
git commit -m "feat(windows): add the memory and DPAPI secret stores

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Profiles and key records

**Files:**
- Create: `clients/windows/crates/tether-core/src/profiles.rs`
- Create: `clients/windows/crates/tether-core/src/keys.rs` (records only; crypto comes in Tasks 5–6)
- Modify: `clients/windows/crates/tether-core/src/lib.rs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `pub enum Auth { Password, Agent, Key { id: Uuid } }` — `#[serde(tag = "kind", rename_all = "lowercase")]`.
  - `pub struct Machine { pub id: Uuid, pub name: String, pub host: String, pub port: u16, pub user: String, pub auth: Auth }`.
  - `pub struct Profiles { pub machines: Vec<Machine> }` with `get(&self, id: Uuid) -> Option<&Machine>`, `add(&mut self, m: Machine)`, `replace(&mut self, m: Machine) -> bool`, `remove(&mut self, id: Uuid) -> Option<Machine>`, `using_key(&self, key: Uuid) -> Vec<&Machine>`.
  - `impl Machine { pub fn auth_label(&self, keys: &KeyRecords) -> String; pub fn summary(&self, keys: &KeyRecords) -> String; pub fn key_missing(&self, keys: &KeyRecords) -> bool }`.
  - `pub fn machines_subtitle(count: usize) -> String`, `pub fn keys_subtitle(count: usize) -> String`.
  - `pub enum KeyOrigin { Generated, Imported, Pasted }` (serde lowercase), `impl KeyOrigin { pub fn label(&self) -> &'static str }`.
  - `pub struct KeyRecord { pub id: Uuid, pub name: String, pub algorithm: String, pub public_line: String, pub fingerprint: String, pub origin: KeyOrigin, pub created: i64 }`.
  - `pub struct KeyRecords { pub keys: Vec<KeyRecord> }` with `get`, `add`, `remove(&mut self, id: Uuid) -> Option<KeyRecord>`.
  - `pub fn used_by_line(machines: &[&Machine]) -> String`, `pub fn delete_key_warning(machines: &[&Machine]) -> Option<String>`.
  - File names: `pub const PROFILES_FILE: &str = "profiles.json"`, `pub const KEYS_FILE: &str = "keys.json"`.

- [ ] **Step 1: Write the failing tests**

`clients/windows/crates/tether-core/src/profiles.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::{KeyOrigin, KeyRecord, KeyRecords};

    fn key(id: u128, name: &str) -> KeyRecord {
        KeyRecord {
            id: Uuid::from_u128(id),
            name: name.into(),
            algorithm: "ssh-ed25519".into(),
            public_line: "ssh-ed25519 AAAA".into(),
            fingerprint: "SHA256:x".into(),
            origin: KeyOrigin::Generated,
            created: 0,
        }
    }

    fn machine(id: u128, name: &str, auth: Auth) -> Machine {
        Machine { id: Uuid::from_u128(id), name: name.into(), host: "10.0.0.5".into(), port: 22, user: "sam".into(), auth }
    }

    #[test]
    fn auth_serializes_with_a_kind_tag() {
        let json = serde_json::to_string(&Auth::Key { id: Uuid::nil() }).unwrap();
        assert_eq!(json, r#"{"kind":"key","id":"00000000-0000-0000-0000-000000000000"}"#);
        assert_eq!(serde_json::to_string(&Auth::Agent).unwrap(), r#"{"kind":"agent"}"#);
        assert_eq!(serde_json::to_string(&Auth::Password).unwrap(), r#"{"kind":"password"}"#);
    }

    #[test]
    fn profiles_never_serialize_a_secret_field() {
        let p = Profiles { machines: vec![machine(1, "devbox", Auth::Password)] };
        let json = serde_json::to_string(&p).unwrap();
        assert!(!json.contains("secret") && !json.contains("pem"));
        let back: Profiles = serde_json::from_str(&json).unwrap();
        assert_eq!(back, p);
    }

    #[test]
    fn summary_names_the_key_agent_password_or_missing_key() {
        let keys = KeyRecords { keys: vec![key(9, "id_ed25519")] };
        let m = machine(1, "devbox", Auth::Key { id: Uuid::from_u128(9) });
        assert_eq!(m.summary(&keys), "sam@10.0.0.5:22 · id_ed25519");
        assert_eq!(machine(1, "d", Auth::Agent).summary(&keys), "sam@10.0.0.5:22 · agent");
        assert_eq!(machine(1, "d", Auth::Password).summary(&keys), "sam@10.0.0.5:22 · password");
        let orphan = machine(1, "d", Auth::Key { id: Uuid::from_u128(8) });
        assert_eq!(orphan.summary(&keys), "sam@10.0.0.5:22 · key missing");
        assert!(orphan.key_missing(&keys));
        assert!(!m.key_missing(&keys));
    }

    #[test]
    fn add_replace_remove_keep_insertion_order() {
        let mut p = Profiles::default();
        p.add(machine(1, "a", Auth::Agent));
        p.add(machine(2, "b", Auth::Agent));
        assert!(p.replace(machine(1, "a2", Auth::Agent)));
        assert_eq!(p.machines.iter().map(|m| m.name.as_str()).collect::<Vec<_>>(), ["a2", "b"]);
        assert_eq!(p.remove(Uuid::from_u128(1)).unwrap().name, "a2");
        assert!(p.remove(Uuid::from_u128(1)).is_none());
        assert!(!p.replace(machine(7, "x", Auth::Agent)));
    }

    #[test]
    fn subtitles() {
        assert_eq!(machines_subtitle(0), "no machines yet");
        assert_eq!(machines_subtitle(1), "1 machine");
        assert_eq!(machines_subtitle(2), "2 machines");
        assert_eq!(keys_subtitle(1), "1 key · on this PC");
        assert_eq!(keys_subtitle(2), "2 keys · on this PC");
    }

    #[test]
    fn key_usage_lines() {
        let k = Uuid::from_u128(9);
        let mut p = Profiles::default();
        assert_eq!(used_by_line(&p.using_key(k)), "not used yet");
        assert_eq!(delete_key_warning(&p.using_key(k)), None);
        p.add(machine(1, "devbox", Auth::Key { id: k }));
        assert_eq!(used_by_line(&p.using_key(k)), "used by devbox");
        assert_eq!(
            delete_key_warning(&p.using_key(k)).unwrap(),
            "devbox won't be able to sign in until it gets another key."
        );
        p.add(machine(2, "nas", Auth::Key { id: k }));
        p.add(machine(3, "pi", Auth::Key { id: k }));
        assert_eq!(used_by_line(&p.using_key(k)), "used by devbox, nas, pi");
        assert_eq!(
            delete_key_warning(&p.using_key(k)).unwrap(),
            "devbox, nas and pi won't be able to sign in until they get another key."
        );
    }
}
```

`clients/windows/crates/tether-core/src/keys.rs`:

```rust
#[cfg(test)]
mod record_tests {
    use super::*;

    #[test]
    fn origin_serializes_lowercase_and_labels_match_the_capsule() {
        assert_eq!(serde_json::to_string(&KeyOrigin::Pasted).unwrap(), "\"pasted\"");
        assert_eq!(KeyOrigin::Generated.label(), "generated");
        assert_eq!(KeyOrigin::Imported.label(), "imported");
    }

    #[test]
    fn records_add_and_remove() {
        let mut r = KeyRecords::default();
        let rec = KeyRecord {
            id: Uuid::from_u128(1),
            name: "k".into(),
            algorithm: "ssh-rsa".into(),
            public_line: "ssh-rsa AAAA".into(),
            fingerprint: "SHA256:x".into(),
            origin: KeyOrigin::Imported,
            created: 1_791_082_819,
        };
        r.add(rec.clone());
        assert_eq!(r.get(rec.id), Some(&rec));
        assert_eq!(r.remove(rec.id), Some(rec.clone()));
        assert_eq!(r.get(rec.id), None);
    }
}
```

Add to `lib.rs`:

```rust
pub mod keys;
pub mod profiles;
pub use keys::{KeyOrigin, KeyRecord, KeyRecords};
pub use profiles::{Auth, Machine, Profiles};
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p tether-core profiles` then `cargo test -p tether-core record_tests`
Expected: FAIL — unresolved `Auth`, `KeyRecord`.

- [ ] **Step 3: Implement**

Prepend to `keys.rs`:

```rust
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const KEYS_FILE: &str = "keys.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KeyOrigin {
    Generated,
    Imported,
    Pasted,
}

impl KeyOrigin {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Generated => "generated",
            Self::Imported => "imported",
            Self::Pasted => "pasted",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KeyRecord {
    pub id: Uuid,
    pub name: String,
    pub algorithm: String,
    pub public_line: String,
    pub fingerprint: String,
    pub origin: KeyOrigin,
    /// Unix seconds.
    pub created: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct KeyRecords {
    pub keys: Vec<KeyRecord>,
}

impl KeyRecords {
    pub fn get(&self, id: Uuid) -> Option<&KeyRecord> {
        self.keys.iter().find(|k| k.id == id)
    }

    pub fn add(&mut self, record: KeyRecord) {
        self.keys.push(record);
    }

    pub fn remove(&mut self, id: Uuid) -> Option<KeyRecord> {
        let at = self.keys.iter().position(|k| k.id == id)?;
        Some(self.keys.remove(at))
    }
}
```

Prepend to `profiles.rs`:

```rust
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::keys::KeyRecords;

pub const PROFILES_FILE: &str = "profiles.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Auth {
    Password,
    Agent,
    Key { id: Uuid },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Machine {
    pub id: Uuid,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: Auth,
}

impl Machine {
    pub fn auth_label(&self, keys: &KeyRecords) -> String {
        match &self.auth {
            Auth::Password => "password".into(),
            Auth::Agent => "agent".into(),
            Auth::Key { id } => keys.get(*id).map_or_else(|| "key missing".into(), |k| k.name.clone()),
        }
    }

    pub fn summary(&self, keys: &KeyRecords) -> String {
        format!("{}@{}:{} · {}", self.user, self.host, self.port, self.auth_label(keys))
    }

    pub fn key_missing(&self, keys: &KeyRecords) -> bool {
        matches!(&self.auth, Auth::Key { id } if keys.get(*id).is_none())
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Profiles {
    pub machines: Vec<Machine>,
}

impl Profiles {
    pub fn get(&self, id: Uuid) -> Option<&Machine> {
        self.machines.iter().find(|m| m.id == id)
    }

    pub fn add(&mut self, machine: Machine) {
        self.machines.push(machine);
    }

    pub fn replace(&mut self, machine: Machine) -> bool {
        match self.machines.iter_mut().find(|m| m.id == machine.id) {
            Some(slot) => {
                *slot = machine;
                true
            }
            None => false,
        }
    }

    pub fn remove(&mut self, id: Uuid) -> Option<Machine> {
        let at = self.machines.iter().position(|m| m.id == id)?;
        Some(self.machines.remove(at))
    }

    pub fn using_key(&self, key: Uuid) -> Vec<&Machine> {
        self.machines.iter().filter(|m| m.auth == Auth::Key { id: key }).collect()
    }
}

pub fn machines_subtitle(count: usize) -> String {
    match count {
        0 => "no machines yet".into(),
        1 => "1 machine".into(),
        n => format!("{n} machines"),
    }
}

pub fn keys_subtitle(count: usize) -> String {
    let noun = if count == 1 { "key" } else { "keys" };
    format!("{count} {noun} · on this PC")
}

pub fn used_by_line(machines: &[&Machine]) -> String {
    if machines.is_empty() {
        return "not used yet".into();
    }
    let names: Vec<&str> = machines.iter().map(|m| m.name.as_str()).collect();
    format!("used by {}", names.join(", "))
}

pub fn delete_key_warning(machines: &[&Machine]) -> Option<String> {
    let names: Vec<&str> = machines.iter().map(|m| m.name.as_str()).collect();
    match names.as_slice() {
        [] => None,
        [one] => Some(format!("{one} won't be able to sign in until it gets another key.")),
        [rest @ .., last] => Some(format!(
            "{} and {last} won't be able to sign in until they get another key.",
            rest.join(", ")
        )),
    }
}
```

Also re-export in `lib.rs`: `pub use profiles::{PROFILES_FILE, delete_key_warning, keys_subtitle, machines_subtitle, used_by_line};` and `pub use keys::KEYS_FILE;`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p tether-core profiles` and `cargo test -p tether-core record_tests`
Expected: PASS, 6 + 2 tests.

- [ ] **Step 5: Commit**

```bash
git add clients/windows/crates/tether-core
git commit -m "feat(windows): add machine profiles and key records

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Key encoding — generate, fingerprint, algorithm, randomart

**Files:**
- Modify: `clients/windows/crates/tether-core/src/keys.rs`
- Modify: `clients/windows/crates/tether-core/src/lib.rs`

**Interfaces:**
- Consumes: `KeyRecord`, `KeyOrigin` (Task 4).
- Produces:
  - `pub fn generate_ed25519(name: &str, now: i64) -> (KeyRecord, Zeroizing<String>)` — PEM is PKCS#8, origin `Generated`, public line `ssh-ed25519 <b64> <name>`.
  - `pub fn openssh_ed25519_line(public: &[u8; 32], comment: Option<&str>) -> String`.
  - `pub fn pkcs8_pem_ed25519(seed: &[u8; 32]) -> Zeroizing<String>`.
  - `pub fn algorithm_of(public_line: &str) -> Option<&str>`.
  - `pub fn fingerprint(public_line: &str) -> Option<String>`; `pub fn fingerprint_digest(public_line: &str) -> Option<[u8; 32]>`.
  - `pub fn short_fingerprint(fingerprint: &str) -> String` (iOS rule: `SHA256:` + first 8 + `…` + last 6 when the body is over 16 chars).
  - `pub fn randomart(digest: &[u8]) -> [[u8; 17]; 9]` (visit counts; 15 = start, 16 = end).
  - `pub(crate) fn ssh_string(out: &mut Vec<u8>, data: &[u8])` (reused by Task 6).

- [ ] **Step 1: Write the failing tests**

Append to `keys.rs` (vectors from iOS `SSHKeyEncodingTests` / `SSHRandomartTests`):

```rust
#[cfg(test)]
mod encoding_tests {
    use super::*;

    const SEED: [u8; 32] = [
        0x0b, 0x8a, 0x44, 0x0c, 0x22, 0x48, 0x54, 0xfb, 0x4f, 0x88, 0x1b, 0x1b, 0xed, 0x94, 0x74, 0x57,
        0xf9, 0x89, 0x5f, 0x09, 0xbc, 0x28, 0xe8, 0xf0, 0xe8, 0xfb, 0xff, 0x54, 0x36, 0x87, 0x70, 0x1b,
    ];
    const PUB: [u8; 32] = [
        0xba, 0xbf, 0x04, 0x3b, 0xfb, 0x1a, 0x9f, 0xf5, 0xc3, 0x30, 0x4c, 0x17, 0xe0, 0xef, 0x11, 0x7e,
        0xa6, 0x58, 0x92, 0x11, 0xd0, 0xdf, 0x15, 0xc0, 0x10, 0xe8, 0x36, 0x2c, 0x8c, 0x71, 0x17, 0xf3,
    ];
    const LINE: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILq/BDv7Gp/1wzBMF+DvEX6mWJIR0N8VwBDoNiyMcRfz";
    const FP: &str = "SHA256:qQubUJmzqluQ5lmjKUy3awN04Qv0ts1nr4pZWS2gI8o";

    #[test]
    fn builds_the_openssh_line_with_and_without_comment() {
        assert_eq!(openssh_ed25519_line(&PUB, None), LINE);
        assert_eq!(openssh_ed25519_line(&PUB, Some("me@pc")), format!("{LINE} me@pc"));
        assert_eq!(openssh_ed25519_line(&PUB, Some("")), LINE);
    }

    #[test]
    fn wraps_the_seed_as_pkcs8_pem() {
        let pem = pkcs8_pem_ed25519(&SEED);
        assert!(pem.starts_with("-----BEGIN PRIVATE KEY-----\n"));
        assert!(pem.contains("MC4CAQAwBQYDK2VwBCIEIAuKRAwiSFT7T4gbG+2UdFf5iV8JvCjo8Oj7/1Q2h3Ab"));
        assert!(pem.ends_with("-----END PRIVATE KEY-----\n"));
    }

    #[test]
    fn fingerprint_matches_ssh_keygen() {
        assert_eq!(fingerprint(LINE).as_deref(), Some(FP));
        assert_eq!(fingerprint(&format!("{LINE} comment")).as_deref(), Some(FP));
        assert_eq!(fingerprint("ssh-ed25519"), None);
        assert_eq!(fingerprint("ssh-ed25519 !!!notbase64"), None);
    }

    #[test]
    fn algorithm_is_the_first_token() {
        assert_eq!(algorithm_of(LINE), Some("ssh-ed25519"));
        assert_eq!(algorithm_of("  ssh-rsa AAAAB3 x"), Some("ssh-rsa"));
        assert_eq!(algorithm_of("ecdsa-sha2-nistp256 AAAAE2"), Some("ecdsa-sha2-nistp256"));
        assert_eq!(algorithm_of("   "), None);
    }

    #[test]
    fn short_fingerprint_follows_the_ios_card() {
        assert_eq!(short_fingerprint(FP), "SHA256:qQubUJmz…S2gI8o");
        assert_eq!(short_fingerprint("SHA256:abc"), "SHA256:abc");
    }

    #[test]
    fn randomart_matches_ssh_keygen_drunken_bishop() {
        let digest = fingerprint_digest(LINE).unwrap();
        let glyphs: Vec<char> = " .o+=*BOX@%&#/^SE".chars().collect();
        let expected = [
            "                 ",
            " . .             ",
            ". o ..           ",
            " + =.o. ..       ",
            "+++*X  oS.       ",
            "BoB++=o+.        ",
            "oE+.oo+ .        ",
            ".. ==+ . .       ",
            "ooo++.o..        ",
        ];
        let rows: Vec<String> = randomart(&digest)
            .iter()
            .map(|row| row.iter().map(|&v| glyphs[v as usize]).collect())
            .collect();
        assert_eq!(rows, expected);
    }

    #[test]
    fn generated_key_round_trips_through_pkcs8_and_signs() {
        use ed25519_dalek::pkcs8::DecodePrivateKey;
        use ed25519_dalek::{Signer, Verifier, VerifyingKey};

        let (record, pem) = generate_ed25519("laptop", 1_791_082_819);
        assert_eq!(record.algorithm, "ssh-ed25519");
        assert_eq!(record.origin, KeyOrigin::Generated);
        assert_eq!(record.created, 1_791_082_819);
        assert_eq!(record.name, "laptop");
        assert!(record.public_line.ends_with(" laptop"));
        assert_eq!(fingerprint(&record.public_line).unwrap(), record.fingerprint);

        let signing = ed25519_dalek::SigningKey::from_pkcs8_pem(&pem).unwrap();
        let blob = base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            record.public_line.split_whitespace().nth(1).unwrap(),
        )
        .unwrap();
        let public: [u8; 32] = blob[blob.len() - 32..].try_into().unwrap();
        let verifying = VerifyingKey::from_bytes(&public).unwrap();
        let sig = signing.sign(b"tether");
        assert!(verifying.verify(b"tether", &sig).is_ok());
    }
}
```

Add to `lib.rs`:

```rust
pub use keys::{algorithm_of, fingerprint, fingerprint_digest, generate_ed25519, randomart, short_fingerprint};
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p tether-core encoding_tests`
Expected: FAIL — `cannot find function openssh_ed25519_line`.

- [ ] **Step 3: Implement**

Add to the top of `keys.rs` (below the existing `use` lines):

```rust
use base64::Engine;
use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;
```

Append (above the test modules):

```rust
pub(crate) fn ssh_string(out: &mut Vec<u8>, data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(data);
}

pub(crate) fn line_from_blob(blob: &[u8], algorithm: &str, comment: Option<&str>) -> String {
    let mut line = format!("{algorithm} {}", STANDARD.encode(blob));
    if let Some(c) = comment.filter(|c| !c.is_empty()) {
        line.push(' ');
        line.push_str(c);
    }
    line
}

pub fn openssh_ed25519_line(public: &[u8; 32], comment: Option<&str>) -> String {
    let mut blob = Vec::with_capacity(51);
    ssh_string(&mut blob, b"ssh-ed25519");
    ssh_string(&mut blob, public);
    line_from_blob(&blob, "ssh-ed25519", comment)
}

/// RFC 8410 one-asymmetric-key wrapping of a raw seed, the same bytes iOS writes.
pub fn pkcs8_pem_ed25519(seed: &[u8; 32]) -> Zeroizing<String> {
    const PREFIX: [u8; 16] = [
        0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
    ];
    let mut der = Zeroizing::new(Vec::with_capacity(48));
    der.extend_from_slice(&PREFIX);
    der.extend_from_slice(seed);
    let body = Zeroizing::new(STANDARD.encode(der.as_slice()));
    let mut pem = Zeroizing::new(String::from("-----BEGIN PRIVATE KEY-----\n"));
    for chunk in body.as_bytes().chunks(64) {
        pem.push_str(std::str::from_utf8(chunk).unwrap());
        pem.push('\n');
    }
    pem.push_str("-----END PRIVATE KEY-----\n");
    pem
}

pub fn generate_ed25519(name: &str, now: i64) -> (KeyRecord, Zeroizing<String>) {
    let signing = ed25519_dalek::SigningKey::generate(&mut rand_core::OsRng);
    let seed = Zeroizing::new(signing.to_bytes());
    let public_line = openssh_ed25519_line(&signing.verifying_key().to_bytes(), Some(name));
    let record = KeyRecord {
        id: Uuid::new_v4(),
        name: name.to_string(),
        algorithm: "ssh-ed25519".into(),
        fingerprint: fingerprint(&public_line).unwrap_or_default(),
        public_line,
        origin: KeyOrigin::Generated,
        created: now,
    };
    (record, pkcs8_pem_ed25519(&seed))
}

pub fn algorithm_of(public_line: &str) -> Option<&str> {
    public_line.split_whitespace().next()
}

fn public_blob(public_line: &str) -> Option<Vec<u8>> {
    let b64 = public_line.split_whitespace().nth(1)?;
    STANDARD.decode(b64).ok()
}

pub fn fingerprint_digest(public_line: &str) -> Option<[u8; 32]> {
    Some(Sha256::digest(public_blob(public_line)?).into())
}

pub fn fingerprint(public_line: &str) -> Option<String> {
    Some(format!("SHA256:{}", STANDARD_NO_PAD.encode(fingerprint_digest(public_line)?)))
}

pub fn short_fingerprint(fingerprint: &str) -> String {
    let body = fingerprint.strip_prefix("SHA256:").unwrap_or(fingerprint);
    let chars: Vec<char> = body.chars().collect();
    if chars.len() <= 16 {
        return fingerprint.to_string();
    }
    let head: String = chars[..8].iter().collect();
    let tail: String = chars[chars.len() - 6..].iter().collect();
    format!("SHA256:{head}…{tail}")
}

/// OpenSSH's drunken-bishop walk, ported from iOS `SSHRandomart`.
pub fn randomart(digest: &[u8]) -> [[u8; 17]; 9] {
    const W: i32 = 17;
    const H: i32 = 9;
    let mut field = [[0u8; 17]; 9];
    let (mut x, mut y) = (W / 2, H / 2);
    for &byte in digest {
        let mut bits = byte;
        for _ in 0..4 {
            x += if bits & 1 == 1 { 1 } else { -1 };
            y += if bits & 2 == 2 { 1 } else { -1 };
            x = x.clamp(0, W - 1);
            y = y.clamp(0, H - 1);
            let cell = &mut field[y as usize][x as usize];
            if *cell < 14 {
                *cell += 1;
            }
            bits >>= 2;
        }
    }
    field[(H / 2) as usize][(W / 2) as usize] = 15;
    field[y as usize][x as usize] = 16;
    field
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p tether-core encoding_tests`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add clients/windows/crates/tether-core
git commit -m "feat(windows): generate ed25519 keys and encode fingerprints and randomart

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Private key parsing — OpenSSH, PKCS#8, PKCS#1

**Files:**
- Create: `clients/windows/crates/tether-core/fixtures/keys/ed25519_openssh`, `ed25519_openssh.pub`, `ed25519_encrypted`, `rsa_pkcs1`, `rsa_pkcs1.pub`, `ecdsa_pkcs8`, `ecdsa_pkcs8.pub`
- Modify: `clients/windows/crates/tether-core/src/keys.rs`
- Modify: `clients/windows/crates/tether-core/src/lib.rs`

**Interfaces:**
- Consumes: `ssh_string`, `line_from_blob`, `fingerprint`, `algorithm_of` (Task 5).
- Produces:
  - `pub enum KeyError { Encrypted, Unsupported, Invalid(String) }` (thiserror).
  - `pub fn normalize_pem(text: &str) -> String` — strips a BOM, turns CRLF/CR into LF, trims, ends with one `\n`.
  - `pub fn is_encrypted(private_pem: &str) -> bool`.
  - `pub fn derive_public_line(private_pem: &str) -> Result<String, KeyError>` — `"<algorithm> <base64 blob>"`, no comment.
  - `pub fn public_key_body(public_line: &str) -> Option<String>` — first two tokens joined by one space.
  - `pub fn import_record(name: &str, public_line: &str, origin: KeyOrigin, now: i64) -> KeyRecord` — trims the public line; algorithm and fingerprint come from it.

- [ ] **Step 1: Add the fixtures**

These were made with Windows OpenSSH `ssh-keygen` (`-t ed25519`, `-t ed25519 -N hunter2`, `-t rsa -b 2048 -m PEM`, `-t ecdsa -b 256 -m PKCS8`), comment `fixture`. They are test-only keys; never use them anywhere else.

`fixtures/keys/ed25519_openssh`:

```
-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACCEF92aCnTA5HOboh2HJ0RMrgcHlESQyNvb0W8BPip+vwAAAJAVlHEZFZRx
GQAAAAtzc2gtZWQyNTUxOQAAACCEF92aCnTA5HOboh2HJ0RMrgcHlESQyNvb0W8BPip+vw
AAAED0llvPLx73UZcEJXbLs2mzKdkgsBD91UoJp6QXfdxJY4QX3ZoKdMDkc5uiHYcnREyu
BweURJDI29vRbwE+Kn6/AAAAB2ZpeHR1cmUBAgMEBQY=
-----END OPENSSH PRIVATE KEY-----
```

`fixtures/keys/ed25519_openssh.pub`:

```
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIQX3ZoKdMDkc5uiHYcnREyuBweURJDI29vRbwE+Kn6/ fixture
```

`fixtures/keys/ed25519_encrypted`:

```
-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAACmFlczI1Ni1jdHIAAAAGYmNyeXB0AAAAGAAAABCcnCQ2qR
w7H7uwsQoU4MHjAAAAGAAAAAEAAAAzAAAAC3NzaC1lZDI1NTE5AAAAIAorDorSI2hUQjEc
iHzNRWeJCHpFb/pQBhwWMD4JJJQZAAAAkMH9q0ybXwkBVRT3p4BQ2W652whu+JdQVYcO2W
oN6R/gM3hPYNgIaw3GxPWJAGn57aR0zGzmQkLU1FEAGysTFCHjXYOvpmscgSxJUrq2lmRh
FaToPTMKq3qrtFoWDmGFch8ldC5DqGr7VW6UiDAjDn578df/tB16/qsiM0SbYKk+S+NV5g
AxWNajNwULMYgpiw==
-----END OPENSSH PRIVATE KEY-----
```

`fixtures/keys/rsa_pkcs1`:

```
-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEAxUgLNHWpIhPqIKCVX7BHvZSbayA7Br0427V999wYqXRHxqma
+6fIXbH5vvSuYhhYwt4weqZgpc5x9RgwBJyrq5Ip+Xvg9SgiosJkuDT5cxjpFrn6
IdRngZuAj00sK1VqvT5F7pYvM/dXhcPLl7eDoU9JLoOTYDc/TT7reWBg51lTI3oe
fPH/kwRZ9WP9SA1b0qWl1Yq+y6j9V1URWZV2/2VKu/4UWx1ay/CsCqH6GohY297O
28cG3W+Y8wgriRs8+dIOR1/+XjxVnNqEBJwEKBK2Pfh0JJkSwcgmh011H8ArMTme
n1/FXxVEXib82gTd9BIFtMLueiHEeP8V9XR0sQIDAQABAoIBAQCnD809TW4+x3J6
0sHr2FHIPzIl05Nor5CYrebQoHfZ9/hYSYRPG9RXU8HUbUvHEisISjPviTlK77oc
/bCcFzhhAFO/S6JCuQwrnEbCn0mmqC+q6S7iuwY0AUUrFQUUZS8Qts1tr4yliw14
30dnYSZ80bF9TDrfPanDdkbd8Dnfbo1chUKFRt9U0UvdywE9RLNKNR9CrfeHqqSb
g6gvQtxMKtO6h2ma++8ZX1LIuOJiGeGfOjL8PPmpQtsW9b6AiMIQ39lNZmtp/mRw
pkin0udLLz4nePxAgKpzRLq+vxWX4uQ/TsxQrenhaCJAc32TW4sCEFXIIQajAs9w
a5Nj34qBAoGBAPNy9pv1j9EDv3T2HSC0kbEUgpbYJmDCxuSS1H6WOHSL7jxdn44E
elawocEpYkv0EJNajJWu8X3e/uj45JZ0POAUtDy6kclIKjnuUtaSeyOlP93t0wg4
lZR7CkW5eSoh/Ffdjfx/laussvj5ZGEt4P+6QephVKiyrB/eQSUNySz5AoGBAM9z
wrM8wGZSAi5tdn0I888PPwOy2mXsmyakYKw2U9BQioghaSSLsfFO5Ui9kNnRy2JO
jcOcoS44+VWyV4P3gc8u0eHWKx08ekWba6dKuAhYuZRHz2wUxJbJ+EaepC4aAIwo
84ehezXF+EHs69+3Wm0kCM7HgMQrSrbiQ1WRS4t5AoGAHBzafYgN44UbRtZk5rHz
YQ+NRP4Q8HuNnDeYckXGny7JhA8Lrcq2lewvwa6Vu0+j2mBKe76IBJELvrt/KiCi
Jv49EgY5b5T1y1rKFh00OxmKFoawJ/Lg0xSiSwrwAv2JtlvPWakiD4ER6c5i2RYD
NYS8t+QlcpWvar6vpyfAY4ECgYBAuS4yu66PfeCeWZqRMhzXKjuPzNpk2Ggjqz9a
G20U3jwKctoaA9eVoPbaNgKeYt0go7+JGzISeMYZ3ZV+X9dJK6Nh4W78JSVE2FPD
EwXN3NixkaH+Z5BaN1NVvSMeGxC2qgQo+dG2Gjj1YJTK7KqyyH5S/V2IVrVtz7QQ
W0+FiQKBgQDp5VnqVKLeAotKELSyW/Nn/effNx5K77YFoeCAsJvGv2jZIVjcPJC5
7NQM7A5bXbVdvI4j50r25y4P03hJHUATXNQwwpMIfqaRlevuG2nPzlEQOzw9ExTb
oBwclLyS/kjjReSIndpnkBK8nVWmY9JKNpiTtlE0fK/RyW51P1dVRA==
-----END RSA PRIVATE KEY-----
```

`fixtures/keys/rsa_pkcs1.pub`:

```
ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDFSAs0dakiE+ogoJVfsEe9lJtrIDsGvTjbtX333BipdEfGqZr7p8hdsfm+9K5iGFjC3jB6pmClznH1GDAEnKurkin5e+D1KCKiwmS4NPlzGOkWufoh1GeBm4CPTSwrVWq9PkXuli8z91eFw8uXt4OhT0kug5NgNz9NPut5YGDnWVMjeh588f+TBFn1Y/1IDVvSpaXVir7LqP1XVRFZlXb/ZUq7/hRbHVrL8KwKofoaiFjb3s7bxwbdb5jzCCuJGzz50g5HX/5ePFWc2oQEnAQoErY9+HQkmRLByCaHTXUfwCsxOZ6fX8VfFUReJvzaBN30EgW0wu56IcR4/xX1dHSx fixture
```

`fixtures/keys/ecdsa_pkcs8`:

```
-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgaaY2mphkwYFj9/1O
U43RpJKZrkmnCZXdP5Z8clhpQqehRANCAATSCH8iH5niOxW6pv63kOqiG01AUNC/
4IWvJDp9OT4ct0DTQ8XpcBaMVTotkdepznl0cIOCG6T8YChmFDYwu7JN
-----END PRIVATE KEY-----
```

`fixtures/keys/ecdsa_pkcs8.pub`:

```
ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBNIIfyIfmeI7Fbqm/reQ6qIbTUBQ0L/gha8kOn05Phy3QNNDxelwFoxVOi2R16nOeXRwg4IbpPxgKGYUNjC7sk0= fixture
```

Add `clients/windows/.gitattributes` so Git on Windows does not rewrite them (the CRLF test builds its own CRLF copy):

```
crates/tether-core/fixtures/** text eol=lf
```

- [ ] **Step 2: Write the failing tests**

Append to `keys.rs`:

```rust
#[cfg(test)]
mod parse_tests {
    use super::*;

    const ED_PRIV: &str = include_str!("../fixtures/keys/ed25519_openssh");
    const ED_PUB: &str = include_str!("../fixtures/keys/ed25519_openssh.pub");
    const ED_ENC: &str = include_str!("../fixtures/keys/ed25519_encrypted");
    const RSA_PRIV: &str = include_str!("../fixtures/keys/rsa_pkcs1");
    const RSA_PUB: &str = include_str!("../fixtures/keys/rsa_pkcs1.pub");
    const EC_PRIV: &str = include_str!("../fixtures/keys/ecdsa_pkcs8");
    const EC_PUB: &str = include_str!("../fixtures/keys/ecdsa_pkcs8.pub");

    fn body(line: &str) -> String {
        public_key_body(line).unwrap()
    }

    #[test]
    fn openssh_ed25519_derives_its_public_line() {
        assert_eq!(derive_public_line(ED_PRIV).unwrap(), body(ED_PUB));
    }

    #[test]
    fn pkcs1_rsa_derives_its_public_line() {
        assert_eq!(derive_public_line(RSA_PRIV).unwrap(), body(RSA_PUB));
    }

    #[test]
    fn pkcs8_ecdsa_derives_its_public_line() {
        assert_eq!(derive_public_line(EC_PRIV).unwrap(), body(EC_PUB));
    }

    #[test]
    fn pkcs8_ed25519_from_generate_derives_its_public_line() {
        let (record, pem) = generate_ed25519("k", 0);
        assert_eq!(derive_public_line(&pem).unwrap(), body(&record.public_line));
    }

    #[test]
    fn crlf_and_bom_parse_like_lf() {
        for (private, public) in [(ED_PRIV, ED_PUB), (RSA_PRIV, RSA_PUB), (EC_PRIV, EC_PUB)] {
            let windows = format!("\u{feff}{}\r\n\r\n", private.replace('\n', "\r\n"));
            assert_eq!(derive_public_line(&windows).unwrap(), body(public));
        }
    }

    #[test]
    fn encrypted_keys_are_detected() {
        assert!(is_encrypted(ED_ENC));
        assert!(matches!(derive_public_line(ED_ENC), Err(KeyError::Encrypted)));
        assert!(is_encrypted("-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIB\n-----END ENCRYPTED PRIVATE KEY-----\n"));
        let legacy = "-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,00\n\nAAAA\n-----END RSA PRIVATE KEY-----\n";
        assert!(is_encrypted(legacy));
        assert!(!is_encrypted(ED_PRIV));
        assert!(!is_encrypted(RSA_PRIV));
        assert!(!is_encrypted(EC_PRIV));
    }

    #[test]
    fn garbage_and_unsupported_formats_are_errors() {
        assert!(matches!(derive_public_line("-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n"), Err(KeyError::Invalid(_))));
        assert!(matches!(derive_public_line("-----BEGIN EC PRIVATE KEY-----\nAAAA\n-----END EC PRIVATE KEY-----\n"), Err(KeyError::Unsupported)));
        assert!(matches!(derive_public_line("hello"), Err(KeyError::Unsupported)));
    }

    #[test]
    fn import_record_takes_algorithm_and_fingerprint_from_the_public_line() {
        let rec = import_record("work", &format!("  {RSA_PUB}\n"), KeyOrigin::Pasted, 7);
        assert_eq!(rec.algorithm, "ssh-rsa");
        assert_eq!(rec.fingerprint, "SHA256:DknoHO6doCbLjndWJUmrVTVRygkrgBJxZAc407XOl5w");
        assert_eq!(rec.public_line, RSA_PUB.trim());
        assert_eq!(rec.origin, KeyOrigin::Pasted);
        let ec = import_record("ec", EC_PUB, KeyOrigin::Imported, 7);
        assert_eq!(ec.algorithm, "ecdsa-sha2-nistp256");
        assert_eq!(ec.fingerprint, "SHA256:EcxK1NjgZg6+rq6g+/PNTpzI2VVRNg79wsZp4QcxfbA");
        let ed = import_record("ed", ED_PUB, KeyOrigin::Imported, 7);
        assert_eq!(ed.fingerprint, "SHA256:8Zpi+pF9V45agFQ8U8K94LzOkaACHmXfH0prkc8Ah20");
    }
}
```

Add to `lib.rs`: `pub use keys::{KeyError, derive_public_line, import_record, is_encrypted, normalize_pem, public_key_body};`

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cargo test -p tether-core parse_tests`
Expected: FAIL — `cannot find function derive_public_line`.

- [ ] **Step 4: Implement**

Append to `keys.rs` (above the test modules):

```rust
#[derive(Debug, thiserror::Error)]
pub enum KeyError {
    #[error("the key is encrypted with a passphrase")]
    Encrypted,
    #[error("unsupported private key format")]
    Unsupported,
    #[error("invalid private key: {0}")]
    Invalid(String),
}

pub fn normalize_pem(text: &str) -> String {
    let text = text.trim_start_matches('\u{feff}').replace("\r\n", "\n").replace('\r', "\n");
    format!("{}\n", text.trim())
}

pub fn is_encrypted(private_pem: &str) -> bool {
    let pem = normalize_pem(private_pem);
    if pem.contains("BEGIN ENCRYPTED PRIVATE KEY") || pem.contains("Proc-Type: 4,ENCRYPTED") {
        return true;
    }
    pem.contains("BEGIN OPENSSH PRIVATE KEY")
        && ssh_key::PrivateKey::from_openssh(&pem).is_ok_and(|k| k.is_encrypted())
}

pub fn public_key_body(public_line: &str) -> Option<String> {
    let mut parts = public_line.split_whitespace();
    Some(format!("{} {}", parts.next()?, parts.next()?))
}

pub fn derive_public_line(private_pem: &str) -> Result<String, KeyError> {
    let pem = normalize_pem(private_pem);
    if is_encrypted(&pem) {
        return Err(KeyError::Encrypted);
    }
    if pem.contains("BEGIN OPENSSH PRIVATE KEY") {
        let key = ssh_key::PrivateKey::from_openssh(&pem).map_err(|e| KeyError::Invalid(e.to_string()))?;
        let line = key.public_key().to_openssh().map_err(|e| KeyError::Invalid(e.to_string()))?;
        return public_key_body(&line).ok_or_else(|| KeyError::Invalid("empty public key".into()));
    }
    if pem.contains("BEGIN RSA PRIVATE KEY") {
        use rsa::pkcs1::DecodeRsaPrivateKey;
        let key = rsa::RsaPrivateKey::from_pkcs1_pem(&pem).map_err(|e| KeyError::Invalid(e.to_string()))?;
        return Ok(rsa_line(&key));
    }
    if pem.contains("BEGIN PRIVATE KEY") {
        return pkcs8_line(&pem);
    }
    Err(KeyError::Unsupported)
}

fn pkcs8_line(pem: &str) -> Result<String, KeyError> {
    use p256::elliptic_curve::sec1::ToEncodedPoint;
    use rsa::pkcs8::DecodePrivateKey;

    if let Ok(k) = ed25519_dalek::SigningKey::from_pkcs8_pem(pem) {
        let line = openssh_ed25519_line(&k.verifying_key().to_bytes(), None);
        return Ok(line);
    }
    if let Ok(k) = rsa::RsaPrivateKey::from_pkcs8_pem(pem) {
        return Ok(rsa_line(&k));
    }
    if let Ok(k) = p256::SecretKey::from_pkcs8_pem(pem) {
        let point = k.public_key().to_encoded_point(false);
        return Ok(ecdsa_line("nistp256", point.as_bytes()));
    }
    if let Ok(k) = p384::SecretKey::from_pkcs8_pem(pem) {
        let point = k.public_key().to_encoded_point(false);
        return Ok(ecdsa_line("nistp384", point.as_bytes()));
    }
    Err(KeyError::Invalid("not an Ed25519, RSA, P-256 or P-384 PKCS#8 key".into()))
}

/// SSH mpint: big-endian, no leading zeros, a 0x00 pad when the high bit is set.
fn ssh_mpint(out: &mut Vec<u8>, be: &[u8]) {
    let trimmed: &[u8] = match be.iter().position(|&b| b != 0) {
        Some(at) => &be[at..],
        None => &[],
    };
    if trimmed.first().is_some_and(|&b| b & 0x80 != 0) {
        let mut padded = Vec::with_capacity(trimmed.len() + 1);
        padded.push(0);
        padded.extend_from_slice(trimmed);
        ssh_string(out, &padded);
    } else {
        ssh_string(out, trimmed);
    }
}

fn rsa_line(key: &rsa::RsaPrivateKey) -> String {
    use rsa::traits::PublicKeyParts;
    let mut blob = Vec::new();
    ssh_string(&mut blob, b"ssh-rsa");
    ssh_mpint(&mut blob, &key.e().to_bytes_be());
    ssh_mpint(&mut blob, &key.n().to_bytes_be());
    line_from_blob(&blob, "ssh-rsa", None)
}

fn ecdsa_line(curve: &str, sec1_point: &[u8]) -> String {
    let algorithm = format!("ecdsa-sha2-{curve}");
    let mut blob = Vec::new();
    ssh_string(&mut blob, algorithm.as_bytes());
    ssh_string(&mut blob, curve.as_bytes());
    ssh_string(&mut blob, sec1_point);
    line_from_blob(&blob, &algorithm, None)
}

pub fn import_record(name: &str, public_line: &str, origin: KeyOrigin, now: i64) -> KeyRecord {
    let public_line = public_line.trim().to_string();
    KeyRecord {
        id: Uuid::new_v4(),
        name: name.to_string(),
        algorithm: algorithm_of(&public_line).unwrap_or_default().to_string(),
        fingerprint: fingerprint(&public_line).unwrap_or_default(),
        public_line,
        origin,
        created: now,
    }
}
```

`p384`'s `ToEncodedPoint` is the same trait re-exported through `elliptic_curve`; if the compiler asks, add `use p384::elliptic_curve::sec1::ToEncodedPoint as _;` in the `p384` branch.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test -p tether-core parse_tests`
Expected: PASS, 8 tests.

- [ ] **Step 6: Commit**

```bash
git add clients/windows/.gitattributes clients/windows/crates/tether-core
git commit -m "feat(windows): parse OpenSSH, PKCS#8 and PKCS#1 private keys

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Form hints — server, import/paste, generate

**Files:**
- Create: `clients/windows/crates/tether-core/src/hints.rs`
- Modify: `clients/windows/crates/tether-core/src/lib.rs`

**Interfaces:**
- Consumes: `is_encrypted`, `derive_public_line`, `public_key_body`, `KeyError` (Task 6); `Machine`, `Auth` (Task 4).
- Produces:
  - `pub enum AuthChoice { Key(Option<Uuid>), Agent, Password }`.
  - `pub struct ServerForm { pub name: String, pub host: String, pub port: String, pub user: String, pub auth: AuthChoice, pub password: String, pub has_saved_password: bool }` with `new_add() -> Self` (port `"22"`, `Key(None)`), `from_machine(m: &Machine, has_saved_password: bool) -> Self` (password empty), `hint(&self) -> Option<&'static str>`, `port_value(&self) -> u16`.
  - `pub struct KeyForm { pub name: String, pub private: String, pub public: String }` with `hint(&self) -> Option<&'static str>`.
  - `pub fn generate_hint(name: &str) -> Option<&'static str>`.
  - `pub const PASSWORD_PLACEHOLDER_EDIT: &str = "Leave empty to keep the saved password";`

- [ ] **Step 1: Write the failing tests**

`clients/windows/crates/tether-core/src/hints.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    const ED_PRIV: &str = include_str!("../fixtures/keys/ed25519_openssh");
    const ED_PUB: &str = include_str!("../fixtures/keys/ed25519_openssh.pub");
    const ED_ENC: &str = include_str!("../fixtures/keys/ed25519_encrypted");
    const RSA_PUB: &str = include_str!("../fixtures/keys/rsa_pkcs1.pub");

    fn ready() -> ServerForm {
        ServerForm {
            name: "devbox".into(),
            host: "10.0.0.5".into(),
            port: "22".into(),
            user: "sam".into(),
            auth: AuthChoice::Key(Some(Uuid::from_u128(1))),
            password: String::new(),
            has_saved_password: false,
        }
    }

    #[test]
    fn server_hints_in_field_order() {
        let empty = ServerForm::new_add();
        assert_eq!(empty.hint(), Some("Name this machine to save it"));
        let f = ServerForm { name: "  ".into(), host: "".into(), ..ready() };
        assert_eq!(f.hint(), Some("Name this machine to save it"));
        assert_eq!(ServerForm { host: " \t".into(), user: "".into(), ..ready() }.hint(), Some("Add a host to save it"));
        assert_eq!(ServerForm { user: " ".into(), ..ready() }.hint(), Some("Add a user to save it"));
        assert_eq!(ServerForm { auth: AuthChoice::Key(None), ..ready() }.hint(), Some("Choose a key to save it"));
        assert_eq!(ready().hint(), None);
        assert_eq!(ServerForm { auth: AuthChoice::Agent, ..ready() }.hint(), None);
    }

    #[test]
    fn password_hint_only_when_nothing_is_saved() {
        let add = ServerForm { auth: AuthChoice::Password, ..ready() };
        assert_eq!(add.hint(), Some("Enter a password to save it"));
        assert_eq!(ServerForm { password: "   ".into(), ..add.clone() }.hint(), Some("Enter a password to save it"));
        assert_eq!(ServerForm { password: "pw".into(), ..add.clone() }.hint(), None);
        assert_eq!(ServerForm { has_saved_password: true, ..add }.hint(), None);
    }

    #[test]
    fn port_falls_back_to_22() {
        let port = |p: &str| ServerForm { port: p.into(), ..ready() }.port_value();
        assert_eq!(port("2222"), 2222);
        assert_eq!(port(" 2222 "), 2222);
        assert_eq!(port("1"), 1);
        assert_eq!(port("65535"), 65535);
        for bad in ["", "0", "65536", "-1", "22.5", "abc", "99999999999"] {
            assert_eq!(port(bad), 22, "{bad:?}");
        }
    }

    #[test]
    fn edit_form_starts_from_the_machine_with_an_empty_password() {
        let m = Machine { id: Uuid::nil(), name: "devbox".into(), host: "h".into(), port: 2200, user: "u".into(), auth: Auth::Password };
        let f = ServerForm::from_machine(&m, true);
        assert_eq!((f.name.as_str(), f.host.as_str(), f.port.as_str(), f.user.as_str()), ("devbox", "h", "2200", "u"));
        assert_eq!(f.auth, AuthChoice::Password);
        assert!(f.password.is_empty() && f.has_saved_password);
        assert_eq!(f.hint(), None);
    }

    fn key_form(name: &str, private: &str, public: &str) -> KeyForm {
        KeyForm { name: name.into(), private: private.into(), public: public.into() }
    }

    #[test]
    fn key_hints_in_order() {
        assert_eq!(key_form(" ", ED_PRIV, ED_PUB).hint(), Some("Name this key to save it"));
        assert_eq!(key_form("k", "ssh-ed25519 AAAA", ED_PUB).hint(), Some("Paste the private key to save it"));
        assert_eq!(key_form("k", ED_PRIV, "").hint(), Some("Paste the public key to save it"));
        assert_eq!(key_form("k", ED_PRIV, "rsa AAAA").hint(), Some("Paste the public key to save it"));
        assert_eq!(
            key_form("k", ED_ENC, include_str!("../fixtures/keys/ed25519_openssh.pub")).hint(),
            Some("This key needs a passphrase — Tether can't use it yet")
        );
        assert_eq!(key_form("k", ED_PRIV, RSA_PUB).hint(), Some("The public key doesn't match the private key"));
        assert_eq!(key_form("k", ED_PRIV, ED_PUB).hint(), None);
    }

    #[test]
    fn public_key_comment_does_not_affect_match() {
        let bare = public_key_body(ED_PUB).unwrap();
        for public in [bare.clone(), format!("{bare}\n"), format!("  {bare} someone@else\r\n")] {
            assert_eq!(key_form("k", ED_PRIV, &public).hint(), None, "{public:?}");
        }
    }

    #[test]
    fn ecdsa_public_prefix_is_accepted() {
        let ec_priv = include_str!("../fixtures/keys/ecdsa_pkcs8");
        let ec_pub = include_str!("../fixtures/keys/ecdsa_pkcs8.pub");
        assert_eq!(key_form("k", ec_priv, ec_pub).hint(), None);
    }

    #[test]
    fn unreadable_private_key_asks_for_the_private_key() {
        let junk = "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n";
        assert_eq!(key_form("k", junk, ED_PUB).hint(), Some("Paste the private key to save it"));
    }

    #[test]
    fn generate_needs_a_name() {
        assert_eq!(generate_hint("  "), Some("Name this key to save it"));
        assert_eq!(generate_hint("laptop"), None);
    }
}
```

Add to `lib.rs`:

```rust
pub mod hints;
pub use hints::{AuthChoice, KeyForm, ServerForm, generate_hint};
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p tether-core hints`
Expected: FAIL — `cannot find type ServerForm`.

- [ ] **Step 3: Implement**

Prepend to `hints.rs`:

```rust
use uuid::Uuid;

use crate::keys::{KeyError, derive_public_line, is_encrypted, public_key_body};
use crate::profiles::{Auth, Machine};

pub const PASSWORD_PLACEHOLDER_EDIT: &str = "Leave empty to keep the saved password";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthChoice {
    Key(Option<Uuid>),
    Agent,
    Password,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerForm {
    pub name: String,
    pub host: String,
    pub port: String,
    pub user: String,
    pub auth: AuthChoice,
    pub password: String,
    /// Edit of a machine whose password is already stored: an empty field keeps it.
    pub has_saved_password: bool,
}

fn blank(s: &str) -> bool {
    s.trim().is_empty()
}

impl ServerForm {
    pub fn new_add() -> Self {
        Self {
            name: String::new(),
            host: String::new(),
            port: "22".into(),
            user: String::new(),
            auth: AuthChoice::Key(None),
            password: String::new(),
            has_saved_password: false,
        }
    }

    pub fn from_machine(m: &Machine, has_saved_password: bool) -> Self {
        Self {
            name: m.name.clone(),
            host: m.host.clone(),
            port: m.port.to_string(),
            user: m.user.clone(),
            auth: match m.auth {
                Auth::Password => AuthChoice::Password,
                Auth::Agent => AuthChoice::Agent,
                Auth::Key { id } => AuthChoice::Key(Some(id)),
            },
            password: String::new(),
            has_saved_password,
        }
    }

    pub fn hint(&self) -> Option<&'static str> {
        if blank(&self.name) {
            return Some("Name this machine to save it");
        }
        if blank(&self.host) {
            return Some("Add a host to save it");
        }
        if blank(&self.user) {
            return Some("Add a user to save it");
        }
        match self.auth {
            AuthChoice::Password if !self.has_saved_password && blank(&self.password) => {
                Some("Enter a password to save it")
            }
            AuthChoice::Key(None) => Some("Choose a key to save it"),
            _ => None,
        }
    }

    pub fn port_value(&self) -> u16 {
        match self.port.trim().parse::<u32>() {
            Ok(p @ 1..=65535) => p as u16,
            _ => 22,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyForm {
    pub name: String,
    pub private: String,
    pub public: String,
}

impl KeyForm {
    pub fn hint(&self) -> Option<&'static str> {
        if blank(&self.name) {
            return Some("Name this key to save it");
        }
        if !self.private.contains("PRIVATE KEY") {
            return Some("Paste the private key to save it");
        }
        let public = self.public.trim();
        if !(public.starts_with("ssh-") || public.starts_with("ecdsa-")) {
            return Some("Paste the public key to save it");
        }
        if is_encrypted(&self.private) {
            return Some("This key needs a passphrase — Tether can't use it yet");
        }
        match derive_public_line(&self.private) {
            Err(KeyError::Encrypted) => Some("This key needs a passphrase — Tether can't use it yet"),
            // The spec has no sentence for an unreadable key; it is not yet a private key Tether can use.
            Err(_) => Some("Paste the private key to save it"),
            Ok(derived) if public_key_body(public).as_deref() != Some(derived.as_str()) => {
                Some("The public key doesn't match the private key")
            }
            Ok(_) => None,
        }
    }
}

pub fn generate_hint(name: &str) -> Option<&'static str> {
    blank(name).then_some("Name this key to save it")
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p tether-core hints`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add clients/windows/crates/tether-core
git commit -m "feat(windows): add server and key form hints in field order

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Edit semantics — `apply_server_form`

**Files:**
- Create: `clients/windows/crates/tether-core/src/edit.rs`
- Modify: `clients/windows/crates/tether-core/src/lib.rs`

**Interfaces:**
- Consumes: `ServerForm`, `AuthChoice` (Task 7); `Machine`, `Auth` (Task 4).
- Produces:
  - `pub enum PasswordAction { Keep, Set(Zeroizing<String>), Delete }`.
  - `pub fn apply_server_form(existing: Option<&Machine>, form: &ServerForm) -> (Machine, PasswordAction)` — precondition: `form.hint().is_none()`. Keeps `existing.id`; new id otherwise. Host and User trimmed; Name kept as typed; port via `port_value()`. The caller writes/deletes `password_account(machine.id)` per the action.

- [ ] **Step 1: Write the failing tests**

`clients/windows/crates/tether-core/src/edit.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn existing(auth: Auth) -> Machine {
        Machine { id: Uuid::from_u128(5), name: "devbox".into(), host: "old".into(), port: 22, user: "sam".into(), auth }
    }

    fn form(auth: AuthChoice, password: &str, saved: bool) -> ServerForm {
        ServerForm {
            name: "devbox".into(),
            host: "  10.0.0.9 ".into(),
            port: "70000".into(),
            user: " sam\t".into(),
            auth,
            password: password.into(),
            has_saved_password: saved,
        }
    }

    #[test]
    fn add_trims_host_and_user_and_falls_back_to_port_22() {
        let (m, action) = apply_server_form(None, &form(AuthChoice::Agent, "", false));
        assert_eq!((m.host.as_str(), m.user.as_str(), m.port), ("10.0.0.9", "sam", 22));
        assert_eq!(m.auth, Auth::Agent);
        assert!(matches!(action, PasswordAction::Keep));
        assert_ne!(m.id, Uuid::nil());
    }

    #[test]
    fn add_with_password_sets_it() {
        let (m, action) = apply_server_form(None, &form(AuthChoice::Password, "pw", false));
        assert_eq!(m.auth, Auth::Password);
        assert!(matches!(action, PasswordAction::Set(p) if p.as_str() == "pw"));
    }

    #[test]
    fn edit_keeps_the_id() {
        let old = existing(Auth::Agent);
        let (m, _) = apply_server_form(Some(&old), &form(AuthChoice::Agent, "", false));
        assert_eq!(m.id, old.id);
    }

    #[test]
    fn edit_with_empty_password_keeps_the_saved_one() {
        let old = existing(Auth::Password);
        let (_, action) = apply_server_form(Some(&old), &form(AuthChoice::Password, "", true));
        assert!(matches!(action, PasswordAction::Keep));
    }

    #[test]
    fn edit_with_new_password_replaces_it() {
        let old = existing(Auth::Password);
        let (_, action) = apply_server_form(Some(&old), &form(AuthChoice::Password, "new", true));
        assert!(matches!(action, PasswordAction::Set(p) if p.as_str() == "new"));
    }

    #[test]
    fn leaving_password_deletes_it() {
        let old = existing(Auth::Password);
        let key = Uuid::from_u128(9);
        let (m, action) = apply_server_form(Some(&old), &form(AuthChoice::Key(Some(key)), "", true));
        assert_eq!(m.auth, Auth::Key { id: key });
        assert!(matches!(action, PasswordAction::Delete));
        let (_, action) = apply_server_form(Some(&old), &form(AuthChoice::Agent, "typed-but-ignored", true));
        assert!(matches!(action, PasswordAction::Delete));
    }

    #[test]
    fn switching_between_key_and_agent_touches_no_password() {
        let old = existing(Auth::Agent);
        let (_, action) = apply_server_form(Some(&old), &form(AuthChoice::Key(Some(Uuid::from_u128(1))), "", false));
        assert!(matches!(action, PasswordAction::Keep));
    }
}
```

Add to `lib.rs`:

```rust
pub mod edit;
pub use edit::{PasswordAction, apply_server_form};
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p tether-core edit`
Expected: FAIL — `cannot find function apply_server_form`.

- [ ] **Step 3: Implement**

Prepend to `edit.rs`:

```rust
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::hints::{AuthChoice, ServerForm};
use crate::profiles::{Auth, Machine};

pub enum PasswordAction {
    Keep,
    Set(Zeroizing<String>),
    Delete,
}

pub fn apply_server_form(existing: Option<&Machine>, form: &ServerForm) -> (Machine, PasswordAction) {
    debug_assert!(form.hint().is_none(), "save is disabled while a hint shows");
    let auth = match form.auth {
        AuthChoice::Password => Auth::Password,
        AuthChoice::Agent => Auth::Agent,
        AuthChoice::Key(Some(id)) => Auth::Key { id },
        // Unreachable behind the hint; never invent a key, keep what was there.
        AuthChoice::Key(None) => existing.map_or(Auth::Agent, |m| m.auth.clone()),
    };
    let had_password = existing.is_some_and(|m| m.auth == Auth::Password);
    let action = match auth {
        Auth::Password if !form.password.trim().is_empty() => {
            PasswordAction::Set(Zeroizing::new(form.password.clone()))
        }
        Auth::Password => PasswordAction::Keep,
        _ if had_password => PasswordAction::Delete,
        _ => PasswordAction::Keep,
    };
    let machine = Machine {
        id: existing.map_or_else(Uuid::new_v4, |m| m.id),
        name: form.name.clone(),
        host: form.host.trim().to_string(),
        port: form.port_value(),
        user: form.user.trim().to_string(),
        auth,
    };
    (machine, action)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p tether-core edit`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add clients/windows/crates/tether-core
git commit -m "feat(windows): apply server form edits with password keep/set/delete

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Preferences — defaults, clamps, font-size shortcuts

**Files:**
- Create: `clients/windows/crates/tether-core/src/prefs.rs`
- Modify: `clients/windows/crates/tether-core/src/lib.rs`

**Interfaces:**
- Consumes: `DataDir` (Task 2) in the round-trip test only.
- Produces:
  - `pub enum ThemeMode { System, Dark, Light }` (serde lowercase, default `System`).
  - `pub enum CursorShape { Block, Bar, Underline }` (serde lowercase, default `Block`).
  - `pub struct TerminalPrefs { pub scheme: String, pub font: String, pub size_pt: f32, pub line_spacing: f32, pub padding_pt: f32, pub cursor: CursorShape, pub blink: bool }` with `clamped(self) -> Self`, `bigger(&mut self)`, `smaller(&mut self)`, `reset_size(&mut self)`.
  - `pub struct WindowPlacement { pub x: i32, pub y: i32, pub width: u32, pub height: u32, pub maximized: bool }`.
  - `pub struct Preferences { pub theme_mode: ThemeMode, pub terminal: TerminalPrefs, pub window: Option<WindowPlacement> }` with `pub fn load(dir: &DataDir) -> Self` (clamped) and `pub fn save(&self, dir: &DataDir) -> io::Result<()>`.
  - Constants: `PREFERENCES_FILE = "preferences.json"`, `DEFAULT_SIZE_PT = 14.0`, `SIZE_RANGE = 8.0..=24.0`, `SPACING_RANGE = 1.0..=1.6`, `PADDING_RANGE = 0.0..=24.0`, `MIN_CLIENT_WIDTH = 640`, `MIN_CLIENT_HEIGHT = 420`.

- [ ] **Step 1: Write the failing tests**

`clients/windows/crates/tether-core/src/prefs.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_defaults() {
        let p = Preferences::default();
        assert_eq!(p.theme_mode, ThemeMode::Dark);
        let t = p.terminal;
        assert_eq!((t.scheme.as_str(), t.font.as_str()), ("tether", "cascadia-mono"));
        assert_eq!((t.size_pt, t.line_spacing, t.padding_pt), (14.0, 1.0, 8.0));
        assert_eq!((t.cursor, t.blink), (CursorShape::Block, false));
        assert!(p.window.is_none());
    }

    #[test]
    fn clamps_and_snaps_to_steps() {
        let t = TerminalPrefs { size_pt: 99.0, line_spacing: 0.2, padding_pt: 7.0, ..TerminalPrefs::default() }.clamped();
        assert_eq!((t.size_pt, t.line_spacing, t.padding_pt), (24.0, 1.0, 8.0));
        let t = TerminalPrefs { size_pt: 3.0, line_spacing: 1.234, padding_pt: 99.0, ..TerminalPrefs::default() }.clamped();
        assert_eq!((t.size_pt, t.padding_pt), (8.0, 24.0));
        assert!((t.line_spacing - 1.25).abs() < 1e-6);
        let t = TerminalPrefs { size_pt: 12.4, line_spacing: 9.0, padding_pt: -3.0, ..TerminalPrefs::default() }.clamped();
        assert_eq!((t.size_pt, t.line_spacing, t.padding_pt), (12.0, 1.6, 0.0));
    }

    #[test]
    fn non_finite_values_fall_back_to_defaults() {
        let t = TerminalPrefs { size_pt: f32::NAN, line_spacing: f32::INFINITY, padding_pt: f32::NAN, ..TerminalPrefs::default() }.clamped();
        assert_eq!((t.size_pt, t.line_spacing, t.padding_pt), (14.0, 1.0, 8.0));
    }

    #[test]
    fn font_size_shortcuts_step_by_one_and_stop_at_the_ends() {
        let mut t = TerminalPrefs::default();
        t.bigger();
        assert_eq!(t.size_pt, 15.0);
        t.smaller();
        t.smaller();
        assert_eq!(t.size_pt, 13.0);
        t.size_pt = 24.0;
        t.bigger();
        assert_eq!(t.size_pt, 24.0);
        t.size_pt = 8.0;
        t.smaller();
        assert_eq!(t.size_pt, 8.0);
        t.reset_size();
        assert_eq!(t.size_pt, 14.0);
    }

    #[test]
    fn partial_and_out_of_range_prefs_load_clamped() {
        let dir = tempfile::tempdir().unwrap();
        let data = DataDir::new(dir.path());
        std::fs::write(
            dir.path().join(PREFERENCES_FILE),
            r#"{"terminal":{"size_pt":99,"line_spacing":null,"cursor":"bar","future_field":1},"unknown":true}"#,
        )
        .unwrap();
        let p = Preferences::load(&data);
        assert_eq!(p.theme_mode, ThemeMode::Dark);
        assert_eq!(p.terminal.size_pt, 24.0);
        assert_eq!(p.terminal.line_spacing, 1.0);
        assert_eq!(p.terminal.cursor, CursorShape::Bar);
        assert_eq!(p.terminal.font, "cascadia-mono");
    }

    #[test]
    fn round_trips_through_the_data_dir() {
        let dir = tempfile::tempdir().unwrap();
        let data = DataDir::new(dir.path());
        let mut p = Preferences::default();
        p.theme_mode = ThemeMode::Light;
        p.terminal.scheme = "dracula".into();
        p.window = Some(WindowPlacement { x: -1200, y: 40, width: 1280, height: 800, maximized: false });
        p.save(&data).unwrap();
        assert_eq!(Preferences::load(&data), p);
    }
}
```

Add to `lib.rs`:

```rust
pub mod prefs;
pub use prefs::{CursorShape, Preferences, TerminalPrefs, ThemeMode, WindowPlacement};
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p tether-core prefs`
Expected: FAIL — `cannot find type Preferences`.

- [ ] **Step 3: Implement**

Prepend to `prefs.rs`:

```rust
use std::io;
use std::ops::RangeInclusive;

use serde::{Deserialize, Deserializer, Serialize};

use crate::DataDir;

pub const PREFERENCES_FILE: &str = "preferences.json";
pub const DEFAULT_SIZE_PT: f32 = 14.0;
pub const SIZE_RANGE: RangeInclusive<f32> = 8.0..=24.0;
pub const SPACING_RANGE: RangeInclusive<f32> = 1.0..=1.6;
pub const PADDING_RANGE: RangeInclusive<f32> = 0.0..=24.0;
pub const MIN_CLIENT_WIDTH: u32 = 640;
pub const MIN_CLIENT_HEIGHT: u32 = 420;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThemeMode {
    System,
    // Night is the default scene, as on iOS.
    #[default]
    Dark,
    Light,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CursorShape {
    #[default]
    Block,
    Bar,
    Underline,
}

/// `null` (how serde_json writes NaN) reads as NaN, which `clamped` then replaces.
fn lenient_f32<'de, D: Deserializer<'de>>(d: D) -> Result<f32, D::Error> {
    Ok(Option::<f32>::deserialize(d)?.unwrap_or(f32::NAN))
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct TerminalPrefs {
    pub scheme: String,
    pub font: String,
    #[serde(deserialize_with = "lenient_f32")]
    pub size_pt: f32,
    #[serde(deserialize_with = "lenient_f32")]
    pub line_spacing: f32,
    #[serde(deserialize_with = "lenient_f32")]
    pub padding_pt: f32,
    pub cursor: CursorShape,
    pub blink: bool,
}

impl Default for TerminalPrefs {
    fn default() -> Self {
        Self {
            scheme: "tether".into(),
            font: "cascadia-mono".into(),
            size_pt: DEFAULT_SIZE_PT,
            line_spacing: 1.0,
            padding_pt: 8.0,
            cursor: CursorShape::Block,
            blink: false,
        }
    }
}

fn snap(value: f32, step: f32, range: RangeInclusive<f32>, fallback: f32) -> f32 {
    if !value.is_finite() {
        return fallback;
    }
    let snapped = (value / step).round() * step;
    // Round off float noise from the step multiply (1.25 not 1.2500001).
    let snapped = (snapped * 100.0).round() / 100.0;
    snapped.clamp(*range.start(), *range.end())
}

impl TerminalPrefs {
    pub fn clamped(mut self) -> Self {
        self.size_pt = snap(self.size_pt, 1.0, SIZE_RANGE, DEFAULT_SIZE_PT);
        self.line_spacing = snap(self.line_spacing, 0.05, SPACING_RANGE, 1.0);
        self.padding_pt = snap(self.padding_pt, 2.0, PADDING_RANGE, 8.0);
        self
    }

    pub fn bigger(&mut self) {
        self.size_pt = snap(self.size_pt + 1.0, 1.0, SIZE_RANGE, DEFAULT_SIZE_PT);
    }

    pub fn smaller(&mut self) {
        self.size_pt = snap(self.size_pt - 1.0, 1.0, SIZE_RANGE, DEFAULT_SIZE_PT);
    }

    pub fn reset_size(&mut self) {
        self.size_pt = DEFAULT_SIZE_PT;
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct WindowPlacement {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub maximized: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Preferences {
    pub theme_mode: ThemeMode,
    pub terminal: TerminalPrefs,
    pub window: Option<WindowPlacement>,
}

impl Preferences {
    pub fn load(dir: &DataDir) -> Self {
        let mut p: Preferences = dir.load(PREFERENCES_FILE);
        p.terminal = p.terminal.clamped();
        p
    }

    pub fn save(&self, dir: &DataDir) -> io::Result<()> {
        dir.save(PREFERENCES_FILE, self)
    }
}
```

Note: padding 7 snaps to 8 (`round(3.5) = 4` → 8), which the test expects.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p tether-core prefs`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add clients/windows/crates/tether-core
git commit -m "feat(windows): add preferences with Windows defaults and clamps

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Theme catalog and font ids

**Files:**
- Create: `clients/windows/crates/tether-core/src/theme.rs`
- Create: `clients/windows/crates/tether-core/src/fonts.rs`
- Modify: `clients/windows/crates/tether-core/src/lib.rs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `pub struct TerminalTheme { pub id: String, pub name: String, pub background: u32, pub foreground: u32, pub cursor: u32, pub selection: Option<u32>, pub ansi: [u32; 16] }` — `0xRRGGBB`.
  - `pub fn catalog() -> &'static [TerminalTheme]` (Tether first, then the JSON order), `pub fn theme_named(id: &str) -> &'static TerminalTheme`, `impl TerminalTheme { pub fn is_light(&self) -> bool; pub fn tether() -> &'static TerminalTheme }`.
  - `pub const THEMES_LICENSE: &str` — the iOS license text, for the app to ship.
  - `pub struct FontFace { pub id: &'static str, pub name: &'static str, pub ligatures: bool }`, `pub const FONTS: [FontFace; 7]`, `pub fn font_named(id: &str) -> &'static FontFace`.

- [ ] **Step 1: Write the failing tests**

`clients/windows/crates/tether-core/src/theme.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tether_is_first_and_is_the_well_color() {
        let first = &catalog()[0];
        assert_eq!((first.id.as_str(), first.name.as_str()), ("tether", "Tether"));
        assert_eq!(first.background, 0x1E1E2E);
        assert_eq!(first.foreground, 0xCCCCCC);
        assert_eq!(first.cursor, 0xFFFFFF);
        assert_eq!(first.ansi[15], 0xFFFFFF);
    }

    #[test]
    fn the_shared_catalog_follows_in_its_own_order() {
        assert_eq!(catalog().len(), 45);
        assert_eq!(catalog()[1].id, "catppuccin-mocha");
        let mut ids: Vec<&str> = catalog().iter().map(|t| t.id.as_str()).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), catalog().len());
    }

    #[test]
    fn lookup_falls_back_to_tether() {
        assert_eq!(theme_named("dracula").name, "Dracula");
        assert_eq!(theme_named("no-such-theme").id, "tether");
        assert_eq!(theme_named("").id, "tether");
    }

    #[test]
    fn light_or_dark_by_relative_luminance() {
        assert!(theme_named("catppuccin-latte").is_light());
        assert!(!theme_named("catppuccin-mocha").is_light());
        assert!(!TerminalTheme::tether().is_light());
    }

    #[test]
    fn license_ships_with_the_catalog() {
        assert!(!THEMES_LICENSE.trim().is_empty());
    }
}
```

`clients/windows/crates/tether-core/src/fonts.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_follow_the_ios_form_in_menu_order() {
        let ids: Vec<&str> = FONTS.iter().map(|f| f.id).collect();
        assert_eq!(
            ids,
            ["cascadia-mono", "cascadia-code", "jetbrains-mono", "monaspace-neon", "monaspace-radon", "maple-mono", "comic-mono"]
        );
        assert_eq!(FONTS[0].name, "Cascadia Mono");
    }

    #[test]
    fn only_cascadia_code_draws_ligatures() {
        let with: Vec<&str> = FONTS.iter().filter(|f| f.ligatures).map(|f| f.id).collect();
        assert_eq!(with, ["cascadia-code"]);
    }

    #[test]
    fn unknown_ids_fall_back_to_cascadia_mono() {
        assert_eq!(font_named("jetbrains-mono").name, "JetBrains Mono");
        assert_eq!(font_named("menlo").id, "cascadia-mono");
        assert_eq!(font_named("sf-mono").id, "cascadia-mono");
    }
}
```

Add to `lib.rs`:

```rust
pub mod fonts;
pub mod theme;
pub use fonts::{FONTS, FontFace, font_named};
pub use theme::{THEMES_LICENSE, TerminalTheme, catalog, theme_named};
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p tether-core theme` and `cargo test -p tether-core fonts`
Expected: FAIL — unresolved `catalog`, `FONTS`.

- [ ] **Step 3: Implement**

Prepend to `theme.rs`:

```rust
use std::sync::LazyLock;

use serde::Deserialize;

// One file for both clients, so the catalogs never drift.
const THEMES_JSON: &str =
    include_str!("../../../../apple/TetherKit/Sources/TetherKit/Resources/TerminalThemes.json");
pub const THEMES_LICENSE: &str =
    include_str!("../../../../apple/TetherKit/Sources/TetherKit/Resources/TerminalThemes-LICENSE.txt");

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalTheme {
    pub id: String,
    pub name: String,
    pub background: u32,
    pub foreground: u32,
    pub cursor: u32,
    pub selection: Option<u32>,
    pub ansi: [u32; 16],
}

#[derive(Deserialize)]
struct Entry {
    id: String,
    name: String,
    background: String,
    foreground: String,
    cursor: Option<String>,
    selection: Option<String>,
    ansi: Vec<String>,
}

fn hex(s: &str) -> Option<u32> {
    (s.len() == 6).then(|| u32::from_str_radix(s, 16).ok()).flatten()
}

impl Entry {
    fn theme(self) -> Option<TerminalTheme> {
        let background = hex(&self.background)?;
        let foreground = hex(&self.foreground)?;
        let ansi: Vec<u32> = self.ansi.iter().filter_map(|a| hex(a)).collect();
        Some(TerminalTheme {
            id: self.id,
            name: self.name,
            background,
            foreground,
            cursor: self.cursor.as_deref().and_then(hex).unwrap_or(foreground),
            selection: self.selection.as_deref().and_then(hex),
            ansi: ansi.try_into().ok()?,
        })
    }
}

fn tether_theme() -> TerminalTheme {
    TerminalTheme {
        id: "tether".into(),
        name: "Tether".into(),
        background: 0x1E1E2E,
        foreground: 0xCCCCCC,
        cursor: 0xFFFFFF,
        selection: None,
        ansi: [
            0x1E1E2E, 0xF38BA8, 0xA6E3A1, 0xF9E2AF, 0x89B4FA, 0xCBA6F7, 0x94E2D5, 0xCDD6F4,
            0x585872, 0xF38BA8, 0xA6E3A1, 0xF9E2AF, 0x89B4FA, 0xCBA6F7, 0x94E2D5, 0xFFFFFF,
        ],
    }
}

static CATALOG: LazyLock<Vec<TerminalTheme>> = LazyLock::new(|| {
    let bundled: Vec<Entry> = serde_json::from_str(THEMES_JSON).unwrap_or_default();
    std::iter::once(tether_theme())
        .chain(bundled.into_iter().filter_map(Entry::theme))
        .collect()
});

pub fn catalog() -> &'static [TerminalTheme] {
    &CATALOG
}

pub fn theme_named(id: &str) -> &'static TerminalTheme {
    catalog().iter().find(|t| t.id == id).unwrap_or(&catalog()[0])
}

impl TerminalTheme {
    pub fn tether() -> &'static TerminalTheme {
        &catalog()[0]
    }

    /// Same rule as iOS: relative luminance of the background above 0.5.
    pub fn is_light(&self) -> bool {
        let c = |shift: u32| ((self.background >> shift) & 0xFF) as f64 / 255.0;
        0.2126 * c(16) + 0.7152 * c(8) + 0.0722 * c(0) > 0.5
    }
}
```

Prepend to `fonts.rs`:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FontFace {
    pub id: &'static str,
    pub name: &'static str,
    pub ligatures: bool,
}

const fn face(id: &'static str, name: &'static str, ligatures: bool) -> FontFace {
    FontFace { id, name, ligatures }
}

pub const FONTS: [FontFace; 7] = [
    face("cascadia-mono", "Cascadia Mono", false),
    face("cascadia-code", "Cascadia Code", true),
    face("jetbrains-mono", "JetBrains Mono", false),
    face("monaspace-neon", "Monaspace Neon", false),
    face("monaspace-radon", "Monaspace Radon", false),
    face("maple-mono", "Maple Mono", false),
    face("comic-mono", "Comic Mono", false),
];

pub fn font_named(id: &str) -> &'static FontFace {
    FONTS.iter().find(|f| f.id == id).unwrap_or(&FONTS[0])
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p tether-core theme` and `cargo test -p tether-core fonts`
Expected: PASS, 5 + 3 tests. If `catalog().len()` is not 45, the iOS JSON changed: update the expected count to `1 + <entries in TerminalThemes.json>`, never filter entries to hit a number.

- [ ] **Step 5: Commit**

```bash
git add clients/windows/crates/tether-core
git commit -m "feat(windows): embed the shared theme catalog and the font id table

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Host-key pins

**Files:**
- Create: `clients/windows/crates/tether-core/src/hostkey.rs`
- Modify: `clients/windows/crates/tether-core/src/lib.rs`

**Interfaces:**
- Consumes: `DataDir` (Task 2); `apply_server_form`, `ServerForm` (Tasks 7–8) in one test.
- Produces:
  - `pub trait HostKeyStore: Send + Sync { fn pinned(&self, host: &str, port: u16) -> Option<String>; fn pin(&self, host: &str, port: u16, fingerprint: &str); }`
  - `pub struct JsonHostKeys` — `new(dir: DataDir) -> Self`, file `hostkeys.json`, map key `"host:port"`.
  - `pub struct MemoryHostKeys` (`Default`).
  - `pub enum HostKeyDecision { Pinned, Matched, Mismatch { expected: String, got: String } }`.
  - `pub fn hex_fingerprint(sha256: &[u8; 32]) -> String`.
  - `pub fn verify_host_key(fingerprint: &str, host: &str, port: u16, store: &dyn HostKeyStore) -> HostKeyDecision`.
  - `pub const HOSTKEYS_FILE: &str = "hostkeys.json"`.

- [ ] **Step 1: Write the failing tests**

`clients/windows/crates/tether-core/src/hostkey.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AuthChoice, Machine, Auth, ServerForm, apply_server_form};

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
        assert_eq!(verify_host_key("aa:bb", "devbox", 22, &store), HostKeyDecision::Pinned);
        assert_eq!(store.pinned("devbox", 22).as_deref(), Some("aa:bb"));
        assert_eq!(verify_host_key("aa:bb", "devbox", 22, &store), HostKeyDecision::Matched);
    }

    #[test]
    fn mismatch_is_refused_and_does_not_write() {
        let store = MemoryHostKeys::default();
        store.pin("devbox", 22, "aa:bb");
        assert_eq!(
            verify_host_key("11:22", "devbox", 22, &store),
            HostKeyDecision::Mismatch { expected: "aa:bb".into(), got: "11:22".into() }
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
        let a = JsonHostKeys::new(DataDir::new(dir.path()));
        assert_eq!(verify_host_key("aa:bb", "10.0.0.5", 22, &a), HostKeyDecision::Pinned);
        let b = JsonHostKeys::new(DataDir::new(dir.path()));
        assert_eq!(b.pinned("10.0.0.5", 22).as_deref(), Some("aa:bb"));
        let raw = std::fs::read_to_string(dir.path().join(HOSTKEYS_FILE)).unwrap();
        assert!(raw.contains("\"10.0.0.5:22\""));
    }

    #[test]
    fn a_new_host_or_port_leaves_the_old_pin_in_place() {
        let store = MemoryHostKeys::default();
        store.pin("old", 22, "aa:bb");
        let old = Machine { id: uuid::Uuid::nil(), name: "devbox".into(), host: "old".into(), port: 22, user: "sam".into(), auth: Auth::Agent };
        let mut form = ServerForm::from_machine(&old, false);
        form.host = "new".into();
        form.port = "2222".into();
        form.auth = AuthChoice::Agent;
        let (edited, _) = apply_server_form(Some(&old), &form);
        assert_eq!(store.pinned("old", 22).as_deref(), Some("aa:bb"));
        assert_eq!(store.pinned(&edited.host, edited.port), None);
    }
}
```

Add to `lib.rs`:

```rust
pub mod hostkey;
pub use hostkey::{HostKeyDecision, HostKeyStore, JsonHostKeys, MemoryHostKeys, hex_fingerprint, verify_host_key};
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p tether-core hostkey`
Expected: FAIL — `cannot find function hex_fingerprint`.

- [ ] **Step 3: Implement**

Prepend to `hostkey.rs`:

```rust
use std::collections::BTreeMap;
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
    sha256.iter().map(|b| format!("{b:02x}")).collect::<Vec<_>>().join(":")
}

/// Pins on first sight, before auth. A mismatch never writes and has no override.
pub fn verify_host_key(fingerprint: &str, host: &str, port: u16, store: &dyn HostKeyStore) -> HostKeyDecision {
    match store.pinned(host, port) {
        None => {
            store.pin(host, port, fingerprint);
            HostKeyDecision::Pinned
        }
        Some(pinned) if pinned == fingerprint => HostKeyDecision::Matched,
        Some(expected) => HostKeyDecision::Mismatch { expected, got: fingerprint.to_string() },
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
        self.pins.lock().unwrap().insert(key(host, port), fingerprint.to_string());
    }
}

pub struct JsonHostKeys {
    dir: DataDir,
    pins: Mutex<BTreeMap<String, String>>,
}

impl JsonHostKeys {
    pub fn new(dir: DataDir) -> Self {
        let pins = dir.load(HOSTKEYS_FILE);
        Self { dir, pins: Mutex::new(pins) }
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p tether-core hostkey`
Expected: PASS, 6 tests.

- [ ] **Step 5: Run the whole crate, fmt and clippy**

Run: `cargo test -p tether-core && cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings`
Expected: all tests pass (≈ 64 on Linux, one more on Windows); fmt and clippy clean.

- [ ] **Step 6: Commit**

```bash
git add clients/windows/crates/tether-core
git commit -m "feat(windows): pin host keys per host:port and refuse a changed key

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Self-review notes

- **Spec coverage (M1 scope):** stored-on-disk table (Tasks 2, 3, 4, 9, 11); DPAPI not Credential Manager (Task 3); key card fields — algorithm from the public line, short fingerprint, randomart, origin capsule, used-by line (Tasks 4–6); delete-key second line (Task 4); Add/Edit server form, hints, trimming, port fallback, password keep/delete, pin left in place (Tasks 7, 8, 11); generate/import/paste hints including encrypted and mismatch (Tasks 6–7); terminal settings defaults and ranges, Ctrl+=/−/0 size steps (Task 9); color scheme catalog, Light/Dark rule, fallback, license (Task 10); font ids, Cascadia default, ligatures, fallback (Task 10). Out of M1: Home/terminal UI (M5/M6), font bytes (M4), the connection sequence (M2).
- **Contract additions:** listed in each task's Produces block — `write_atomic`, `unix_now`, `SecretError::BadAccount`, `Profiles` helpers, subtitles and usage lines, `KeyOrigin::label`, `openssh_ed25519_line`, `pkcs8_pem_ed25519`, `short_fingerprint`, `normalize_pem`, `public_key_body`, `import_record`, `KeyError`, `ServerForm::new_add`/`from_machine`, `PASSWORD_PLACEHOLDER_EDIT`, prefs constants and `Preferences::load/save`, `TerminalTheme::tether`, `THEMES_LICENSE`, `*_FILE` constants.

## Deviations

No public name from the roadmap contract or any task's Produces block was changed.

- `prefs::tests::round_trips_through_the_data_dir` builds `Preferences` with struct update instead of assigning fields on `Preferences::default()`. `clippy::field_reassign_with_default` is denied by `-D warnings`. The saved values and the equality assertion are unchanged.
- `cargo fmt` reflowed long lines from the plan so `cargo fmt --all --check` passes. No behavior change.

