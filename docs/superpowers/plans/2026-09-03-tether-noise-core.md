# Tether Noise Core Implementation Plan (Plan 1 of 5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pure-Rust Noise cryptographic core in `crates/tether-core` — frozen suites, XXpsk2 pairing, IK reconnect, Argon2id PSK derivation, the 12-char code codec, chunked transport with in-band rekey — with no FFI, server, or client code. Everything is exercised by `cargo test` alone.

**Architecture:** A new `noise` submodule in the existing flat `tether-core` crate. It wraps the audited [`snow`](https://docs.rs/snow) crate behind a small, misuse-resistant API that later plans drive over FFI (Plan 2) and link into the clients (Plans 3–4). The device is always the Noise *initiator*; the server is the *responder*. Pairing uses `Noise_XXpsk2_25519_ChaChaPoly_BLAKE2s`; every reconnect uses `Noise_IK_25519_ChaChaPoly_BLAKE2s`.

**Tech Stack:** Rust 2021, `snow` 0.9, `argon2` 0.5, `getrandom` 0.2. Inline `#[cfg(test)] mod tests` per file (the pattern in `crates/tether-core/src/deep_link.rs`).

**Spec:** `docs/superpowers/specs/2026-09-03-tether-noise-pairing-design.md`

## Global Constraints

- **Frozen suites, never negotiated.** Pairing: `Noise_XXpsk2_25519_ChaChaPoly_BLAKE2s`. Reconnect: `Noise_IK_25519_ChaChaPoly_BLAKE2s`. These are string constants; there is no negotiation path.
- **Prologue bound into every handshake:** the exact bytes `b"tether-noise/1"`. Both peers must set it or the handshake fails.
- **PSK = `Argon2id(password = normalized code bytes, salt = b"tether-noise-pair/1")` → 32 bytes.** Fixed salt on purpose (see spec "Why a fixed salt"). Argon2id parameters are defined once in `psk.rs` as named constants.
- **Enrollment code:** 12 Crockford base32 chars (alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ`, excludes `I L O U`), ~60 bits. Displayed grouped `XXXX-XXXX-XXXX`, accepted case-insensitively with `I/L→1`, `O→0`, dashes/spaces stripped.
- **Noise record cap:** a single `snow` message is ≤ 65535 bytes. Application payloads larger than the plaintext budget are split by the core; callers only ever see whole application frames.
- **No key material crosses the public API as raw mutable state** beyond what a caller must persist (a device's own static keypair bytes, and the pinned server public key). Cipher state stays inside the owned session object.
- Device is initiator, server is responder — in *every* handshake in this crate.
- Colocated inline tests; run with `cargo test -p tether-core noise::`.

---

## File Structure

- Create `crates/tether-core/src/noise/mod.rs` — module root; re-exports; the `NoiseSession` transport type; error enum `NoiseError`.
- Create `crates/tether-core/src/noise/params.rs` — frozen suite + prologue constants; a helper to parse a pattern into `snow::params::NoiseParams`.
- Create `crates/tether-core/src/noise/code.rs` — enrollment-code generation, normalization, and display grouping.
- Create `crates/tether-core/src/noise/psk.rs` — Argon2id PSK derivation + parameters.
- Create `crates/tether-core/src/noise/pairing.rs` — the XXpsk2 pairing handshake driver (initiator + responder halves).
- Create `crates/tether-core/src/noise/reconnect.rs` — the IK reconnect handshake driver.
- Create `crates/tether-core/src/noise/transport.rs` — chunked framing over `snow::TransportState` + in-band rekey.
- Modify `crates/tether-core/src/lib.rs` — add `pub mod noise;`.
- Modify `crates/tether-core/Cargo.toml` — add `snow`, `argon2`, `getrandom` deps.

---

## Task 1: Crate scaffold, dependencies, and frozen params

**Files:**
- Modify: `crates/tether-core/Cargo.toml`
- Create: `crates/tether-core/src/noise/mod.rs`
- Create: `crates/tether-core/src/noise/params.rs`
- Modify: `crates/tether-core/src/lib.rs` (add `pub mod noise;` in the alphabetical module list)

**Interfaces:**
- Produces:
  - `noise::params::PAIRING_PATTERN: &str` = `"Noise_XXpsk2_25519_ChaChaPoly_BLAKE2s"`
  - `noise::params::RECONNECT_PATTERN: &str` = `"Noise_IK_25519_ChaChaPoly_BLAKE2s"`
  - `noise::params::PROLOGUE: &[u8]` = `b"tether-noise/1"`
  - `noise::params::parse(pattern: &str) -> Result<snow::params::NoiseParams, NoiseError>`
  - `noise::NoiseError` (a `thiserror`-derived enum; `thiserror` is already a dependency)

- [ ] **Step 1: Add dependencies to `Cargo.toml`**

Add to the `[dependencies]` section (leave existing lines untouched):

```toml
snow = "0.9"
argon2 = "0.5"
getrandom = "0.2"
```

- [ ] **Step 2: Add the module to `lib.rs`**

Insert `pub mod noise;` in the module list in `crates/tether-core/src/lib.rs`, keeping alphabetical order (between `pub mod links;` and `pub mod notify_rules;`).

- [ ] **Step 3: Write the failing test for params**

Create `crates/tether-core/src/noise/params.rs`:

```rust
//! Frozen Noise suites + prologue. These are constants, never negotiated:
//! changing a suite means bumping the prologue to a new version that old and
//! new peers refuse to cross.

use snow::params::NoiseParams;

use super::NoiseError;

pub const PAIRING_PATTERN: &str = "Noise_XXpsk2_25519_ChaChaPoly_BLAKE2s";
pub const RECONNECT_PATTERN: &str = "Noise_IK_25519_ChaChaPoly_BLAKE2s";
pub const PROLOGUE: &[u8] = b"tether-noise/1";

pub fn parse(pattern: &str) -> Result<NoiseParams, NoiseError> {
    pattern.parse().map_err(|_| NoiseError::BadParams)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_frozen_patterns_parse() {
        assert!(parse(PAIRING_PATTERN).is_ok());
        assert!(parse(RECONNECT_PATTERN).is_ok());
    }

    #[test]
    fn a_bogus_pattern_is_rejected() {
        assert!(matches!(parse("Noise_NOPE_25519"), Err(NoiseError::BadParams)));
    }
}
```

- [ ] **Step 4: Create the module root with the error enum**

Create `crates/tether-core/src/noise/mod.rs`:

```rust
//! Tether's Noise transport: pairing (XXpsk2), reconnect (IK), and a chunked
//! transport with in-band rekey. Wraps the audited `snow` crate behind a
//! misuse-resistant API. The device is always the initiator; the server the
//! responder.

pub mod code;
pub mod pairing;
pub mod params;
pub mod psk;
pub mod reconnect;
pub mod transport;

use thiserror::Error;

#[derive(Debug, Error)]
pub enum NoiseError {
    #[error("invalid noise parameters")]
    BadParams,
    #[error("handshake failed")]
    Handshake,
    #[error("transport decrypt/encrypt failed")]
    Transport,
    #[error("peer static key was not available")]
    MissingRemoteStatic,
    #[error("enrollment code was malformed")]
    BadCode,
    #[error("key derivation failed")]
    Kdf,
    #[error("frame was malformed")]
    BadFrame,
}
```

Note: this file references modules (`code`, `pairing`, `psk`, `reconnect`, `transport`) created in later tasks. Until those exist the crate will not compile; add each `pub mod` line only in the task that creates the file. For **this** task, include only `pub mod params;` plus the `NoiseError` enum, and add the other `pub mod` lines in their tasks.

- [ ] **Step 5: Run the params tests**

Run: `cargo test -p tether-core noise::params`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add crates/tether-core/Cargo.toml crates/tether-core/src/lib.rs crates/tether-core/src/noise/mod.rs crates/tether-core/src/noise/params.rs
git commit -m "feat(noise): scaffold noise module with frozen suites + prologue"
```

---

## Task 2: Enrollment code — generate, normalize, group

**Files:**
- Create: `crates/tether-core/src/noise/code.rs`
- Modify: `crates/tether-core/src/noise/mod.rs` (add `pub mod code;`)

**Interfaces:**
- Consumes: `NoiseError` (Task 1).
- Produces:
  - `noise::code::generate() -> String` — 12 raw Crockford chars, no dashes.
  - `noise::code::normalize(input: &str) -> Result<String, NoiseError>` — 12 canonical chars, or `NoiseError::BadCode`.
  - `noise::code::grouped(code: &str) -> String` — `XXXX-XXXX-XXXX` for display.
  - `noise::code::ALPHABET: &str` = `"0123456789ABCDEFGHJKMNPQRSTVWXYZ"`.

- [ ] **Step 1: Write the failing tests**

Create `crates/tether-core/src/noise/code.rs`:

```rust
//! The 12-char Crockford base32 enrollment code. Generation, input
//! normalization (case + ambiguous-char folding), and display grouping.

use super::NoiseError;

pub const ALPHABET: &str = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LEN: usize = 12;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generate_returns_twelve_alphabet_chars() {
        let c = generate();
        assert_eq!(c.len(), CODE_LEN);
        assert!(c.chars().all(|ch| ALPHABET.contains(ch)));
    }

    #[test]
    fn generate_is_not_constant() {
        assert_ne!(generate(), generate());
    }

    #[test]
    fn normalize_folds_case_dashes_and_ambiguous_chars() {
        // lowercase, dashes, spaces, and I/L/O all fold to canonical form.
        assert_eq!(
            normalize("olib-2345-6789").unwrap(), // o->0, l->1, i->1, b->B
            "011B23456789"
        );
    }

    #[test]
    fn normalize_rejects_wrong_length() {
        assert!(matches!(normalize("ABC"), Err(NoiseError::BadCode)));
    }

    #[test]
    fn normalize_rejects_out_of_alphabet() {
        // '!' is not foldable.
        assert!(matches!(normalize("!23456789ABC"), Err(NoiseError::BadCode)));
    }

    #[test]
    fn grouped_inserts_two_dashes() {
        assert_eq!(grouped("011B23456789"), "011B-2345-6789");
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p tether-core noise::code`
Expected: FAIL (functions not defined).

- [ ] **Step 3: Implement generate/normalize/grouped**

Add above the `#[cfg(test)]` block in `code.rs`:

```rust
pub fn generate() -> String {
    let bytes = ALPHABET.as_bytes();
    let mut raw = [0u8; CODE_LEN];
    getrandom::getrandom(&mut raw).expect("system RNG");
    // Reject-free mapping: 256 % 32 == 0, so a plain modulo is unbiased here.
    raw.iter().map(|b| bytes[(*b as usize) % bytes.len()] as char).collect()
}

pub fn normalize(input: &str) -> Result<String, NoiseError> {
    let mut out = String::with_capacity(CODE_LEN);
    for ch in input.chars() {
        let c = match ch.to_ascii_uppercase() {
            '-' | ' ' => continue,
            'O' => '0',
            'I' | 'L' => '1',
            other => other,
        };
        if !ALPHABET.contains(c) {
            return Err(NoiseError::BadCode);
        }
        out.push(c);
    }
    if out.len() != CODE_LEN {
        return Err(NoiseError::BadCode);
    }
    Ok(out)
}

pub fn grouped(code: &str) -> String {
    code.as_bytes()
        .chunks(4)
        .map(|c| std::str::from_utf8(c).unwrap_or(""))
        .collect::<Vec<_>>()
        .join("-")
}
```

- [ ] **Step 4: Wire the module in**

Add `pub mod code;` to `crates/tether-core/src/noise/mod.rs` (it is already listed in the Task 1 mod.rs skeleton; if you followed the Task 1 note and omitted it, add it now).

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test -p tether-core noise::code`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add crates/tether-core/src/noise/code.rs crates/tether-core/src/noise/mod.rs
git commit -m "feat(noise): 12-char Crockford enrollment code codec"
```

---

## Task 3: PSK derivation (Argon2id)

**Files:**
- Create: `crates/tether-core/src/noise/psk.rs`
- Modify: `crates/tether-core/src/noise/mod.rs` (add `pub mod psk;`)

**Interfaces:**
- Consumes: `NoiseError` (Task 1); `code::normalize` (Task 2).
- Produces:
  - `noise::psk::derive(normalized_code: &str) -> Result<[u8; 32], NoiseError>`
  - `noise::psk::PAIR_SALT: &[u8]` = `b"tether-noise-pair/1"`

- [ ] **Step 1: Write the failing tests**

Create `crates/tether-core/src/noise/psk.rs`:

```rust
//! PSK derivation: Argon2id(code, fixed salt) -> 32 bytes. Fixed salt is sound
//! because the code is a 60-bit single-use random value (see spec). Argon2id
//! only makes each guess expensive.

use argon2::{Algorithm, Argon2, Params, Version};

use super::NoiseError;

pub const PAIR_SALT: &[u8] = b"tether-noise-pair/1";

// Parameters: 64 MiB memory, 3 passes, 1 lane, 32-byte output. Tune in review;
// target ~100 ms on a low-end host.
const M_COST_KIB: u32 = 65536;
const T_COST: u32 = 3;
const P_COST: u32 = 1;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derive_is_deterministic_and_32_bytes() {
        let a = derive("011B23456789").unwrap();
        let b = derive("011B23456789").unwrap();
        assert_eq!(a, b);
        assert_eq!(a.len(), 32);
    }

    #[test]
    fn different_codes_derive_different_psks() {
        assert_ne!(derive("011B23456789").unwrap(), derive("011B2345678A").unwrap());
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p tether-core noise::psk`
Expected: FAIL (`derive` not defined).

- [ ] **Step 3: Implement `derive`**

Add above the test block:

```rust
pub fn derive(normalized_code: &str) -> Result<[u8; 32], NoiseError> {
    let params = Params::new(M_COST_KIB, T_COST, P_COST, Some(32)).map_err(|_| NoiseError::Kdf)?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut out = [0u8; 32];
    argon
        .hash_password_into(normalized_code.as_bytes(), PAIR_SALT, &mut out)
        .map_err(|_| NoiseError::Kdf)?;
    Ok(out)
}
```

- [ ] **Step 4: Wire the module in**

Ensure `pub mod psk;` is present in `crates/tether-core/src/noise/mod.rs`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test -p tether-core noise::psk`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add crates/tether-core/src/noise/psk.rs crates/tether-core/src/noise/mod.rs
git commit -m "feat(noise): Argon2id PSK derivation from enrollment code"
```

---

## Task 4: Pairing handshake (XXpsk2)

**Files:**
- Create: `crates/tether-core/src/noise/pairing.rs`
- Modify: `crates/tether-core/src/noise/mod.rs` (add `pub mod pairing;`)

**Interfaces:**
- Consumes: `params` (Task 1), `psk::derive` (Task 3), `NoiseError`.
- Produces:
  - `noise::pairing::Keypair { public: Vec<u8>, private: Vec<u8> }`
  - `noise::pairing::generate_static_keypair() -> Result<Keypair, NoiseError>` — the per-host device key (also used to make the server key in tests/tools).
  - `noise::pairing::PairingInitiator` with `new(device_priv: &[u8], psk: &[u8; 32]) -> Result<Self, NoiseError>`, `write_message(&mut self, payload: &[u8], out: &mut [u8]) -> Result<usize, NoiseError>`, `read_message(&mut self, msg: &[u8], out: &mut [u8]) -> Result<usize, NoiseError>`, `is_finished(&self) -> bool`, `remote_static(&self) -> Result<Vec<u8>, NoiseError>`, `into_transport(self) -> Result<transport::NoiseSession, NoiseError>` (the last used from Task 7 onward).
  - `noise::pairing::PairingResponder` — same shape, `new(server_priv: &[u8], psk: &[u8; 32])`.

The `into_transport` method is declared here but its body depends on Task 7's `NoiseSession`. Implement the handshake methods and `remote_static` in this task; add `into_transport` in Task 7 and mark it here as a stub returning `NoiseError::Transport` until then.

- [ ] **Step 1: Write the failing tests**

Create `crates/tether-core/src/noise/pairing.rs`:

```rust
//! XXpsk2 pairing handshake. Device = initiator, server = responder. The PSK
//! (derived from the enrollment code) gates completion, so a peer without the
//! code cannot finish. After completion both sides know each other's static key.

use snow::{Builder, HandshakeState};

use super::{params, NoiseError};

pub struct Keypair {
    pub public: Vec<u8>,
    pub private: Vec<u8>,
}

pub struct PairingInitiator {
    hs: HandshakeState,
}
pub struct PairingResponder {
    hs: HandshakeState,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::noise::psk;

    fn run_pairing(dev: &Keypair, srv: &Keypair, psk_i: &[u8; 32], psk_r: &[u8; 32]) -> bool {
        let mut i = match PairingInitiator::new(&dev.private, psk_i) {
            Ok(x) => x,
            Err(_) => return false,
        };
        let mut r = match PairingResponder::new(&srv.private, psk_r) {
            Ok(x) => x,
            Err(_) => return false,
        };
        let (mut b, mut rb) = ([0u8; 65535], [0u8; 65535]);
        // -> e
        let Ok(n) = i.write_message(&[], &mut b) else { return false };
        if r.read_message(&b[..n], &mut rb).is_err() { return false }
        // <- e, ee, s, es
        let Ok(n) = r.write_message(&[], &mut b) else { return false };
        if i.read_message(&b[..n], &mut rb).is_err() { return false }
        // -> s, se
        let Ok(n) = i.write_message(&[], &mut b) else { return false };
        if r.read_message(&b[..n], &mut rb).is_err() { return false }
        i.is_finished() && r.is_finished()
    }

    #[test]
    fn correct_code_completes_and_reveals_static_keys() {
        let dev = generate_static_keypair().unwrap();
        let srv = generate_static_keypair().unwrap();
        let psk = psk::derive("011B23456789").unwrap();
        // Re-run capturing the responder to read the device's static key.
        let mut i = PairingInitiator::new(&dev.private, &psk).unwrap();
        let mut r = PairingResponder::new(&srv.private, &psk).unwrap();
        let (mut b, mut rb) = ([0u8; 65535], [0u8; 65535]);
        let n = i.write_message(&[], &mut b).unwrap();
        r.read_message(&b[..n], &mut rb).unwrap();
        let n = r.write_message(&[], &mut b).unwrap();
        i.read_message(&b[..n], &mut rb).unwrap();
        let n = i.write_message(&[], &mut b).unwrap();
        r.read_message(&b[..n], &mut rb).unwrap();
        assert!(i.is_finished() && r.is_finished());
        assert_eq!(i.remote_static().unwrap(), srv.public); // device pins server
        assert_eq!(r.remote_static().unwrap(), dev.public); // server learns device
    }

    #[test]
    fn wrong_code_fails_to_complete() {
        let dev = generate_static_keypair().unwrap();
        let srv = generate_static_keypair().unwrap();
        let good = psk::derive("011B23456789").unwrap();
        let bad = psk::derive("011B2345678A").unwrap();
        assert!(!run_pairing(&dev, &srv, &good, &bad));
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p tether-core noise::pairing`
Expected: FAIL (types/functions not defined).

- [ ] **Step 3: Implement keypair generation and the two handshake halves**

Add above the test block:

```rust
pub fn generate_static_keypair() -> Result<Keypair, NoiseError> {
    let params = params::parse(params::PAIRING_PATTERN)?;
    let kp = Builder::new(params).generate_keypair().map_err(|_| NoiseError::Handshake)?;
    Ok(Keypair { public: kp.public, private: kp.private })
}

impl PairingInitiator {
    pub fn new(device_priv: &[u8], psk: &[u8; 32]) -> Result<Self, NoiseError> {
        let params = params::parse(params::PAIRING_PATTERN)?;
        let hs = Builder::new(params)
            .local_private_key(device_priv)
            .map_err(|_| NoiseError::Handshake)?
            .prologue(params::PROLOGUE)
            .map_err(|_| NoiseError::Handshake)?
            .psk(2, psk)
            .map_err(|_| NoiseError::Handshake)?
            .build_initiator()
            .map_err(|_| NoiseError::Handshake)?;
        Ok(Self { hs })
    }

    pub fn write_message(&mut self, payload: &[u8], out: &mut [u8]) -> Result<usize, NoiseError> {
        self.hs.write_message(payload, out).map_err(|_| NoiseError::Handshake)
    }
    pub fn read_message(&mut self, msg: &[u8], out: &mut [u8]) -> Result<usize, NoiseError> {
        self.hs.read_message(msg, out).map_err(|_| NoiseError::Handshake)
    }
    pub fn is_finished(&self) -> bool { self.hs.is_handshake_finished() }
    pub fn remote_static(&self) -> Result<Vec<u8>, NoiseError> {
        self.hs.get_remote_static().map(|s| s.to_vec()).ok_or(NoiseError::MissingRemoteStatic)
    }
}

impl PairingResponder {
    pub fn new(server_priv: &[u8], psk: &[u8; 32]) -> Result<Self, NoiseError> {
        let params = params::parse(params::PAIRING_PATTERN)?;
        let hs = Builder::new(params)
            .local_private_key(server_priv)
            .map_err(|_| NoiseError::Handshake)?
            .prologue(params::PROLOGUE)
            .map_err(|_| NoiseError::Handshake)?
            .psk(2, psk)
            .map_err(|_| NoiseError::Handshake)?
            .build_responder()
            .map_err(|_| NoiseError::Handshake)?;
        Ok(Self { hs })
    }

    pub fn write_message(&mut self, payload: &[u8], out: &mut [u8]) -> Result<usize, NoiseError> {
        self.hs.write_message(payload, out).map_err(|_| NoiseError::Handshake)
    }
    pub fn read_message(&mut self, msg: &[u8], out: &mut [u8]) -> Result<usize, NoiseError> {
        self.hs.read_message(msg, out).map_err(|_| NoiseError::Handshake)
    }
    pub fn is_finished(&self) -> bool { self.hs.is_handshake_finished() }
    pub fn remote_static(&self) -> Result<Vec<u8>, NoiseError> {
        self.hs.get_remote_static().map(|s| s.to_vec()).ok_or(NoiseError::MissingRemoteStatic)
    }
}
```

- [ ] **Step 4: Wire the module in**

Ensure `pub mod pairing;` is present in `crates/tether-core/src/noise/mod.rs`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test -p tether-core noise::pairing`
Expected: PASS (2 tests). The wrong-code test passes because `snow` fails the PSK-authenticated message.

- [ ] **Step 6: Commit**

```bash
git add crates/tether-core/src/noise/pairing.rs crates/tether-core/src/noise/mod.rs
git commit -m "feat(noise): XXpsk2 pairing handshake with static-key capture"
```

---

## Task 5: Prologue binding is enforced

**Files:**
- Modify: `crates/tether-core/src/noise/pairing.rs` (add a test only)

**Interfaces:** none new — this task proves an existing property.

- [ ] **Step 1: Write the failing test**

Add to the `tests` module in `pairing.rs` a test that builds a responder with a *different* prologue and asserts the handshake fails. Because `PairingResponder::new` hard-codes `params::PROLOGUE`, the test constructs a raw mismatched responder inline:

```rust
    #[test]
    fn prologue_mismatch_breaks_the_handshake() {
        use snow::Builder;
        let dev = generate_static_keypair().unwrap();
        let srv = generate_static_keypair().unwrap();
        let psk = psk::derive("011B23456789").unwrap();

        let mut i = PairingInitiator::new(&dev.private, &psk).unwrap();
        // Responder built by hand with the WRONG prologue.
        let p = params::parse(params::PAIRING_PATTERN).unwrap();
        let mut r = Builder::new(p)
            .local_private_key(&srv.private).unwrap()
            .prologue(b"tether-noise/2").unwrap()
            .psk(2, &psk).unwrap()
            .build_responder().unwrap();

        let (mut b, mut rb) = ([0u8; 65535], [0u8; 65535]);
        let n = i.write_message(&[], &mut b).unwrap();
        // The responder can read msg1 (-> e carries no auth yet)...
        let _ = r.read_message(&b[..n], &mut rb);
        let n = r.write_message(&[], &mut b).unwrap();
        // ...but the initiator rejects msg2 because the transcript hash differs.
        assert!(i.read_message(&b[..n], &mut rb).is_err());
    }
```

- [ ] **Step 2: Run the test**

Run: `cargo test -p tether-core noise::pairing::tests::prologue_mismatch_breaks_the_handshake`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add crates/tether-core/src/noise/pairing.rs
git commit -m "test(noise): prove prologue mismatch breaks pairing (no downgrade)"
```

---

## Task 6: Reconnect handshake (IK)

**Files:**
- Create: `crates/tether-core/src/noise/reconnect.rs`
- Modify: `crates/tether-core/src/noise/mod.rs` (add `pub mod reconnect;`)

**Interfaces:**
- Consumes: `params` (Task 1), `pairing::Keypair` / `generate_static_keypair` (Task 4), `NoiseError`.
- Produces:
  - `noise::reconnect::ReconnectInitiator::new(device_priv: &[u8], server_pub_pinned: &[u8]) -> Result<Self, NoiseError>` + `write_message`/`read_message`/`is_finished`/`into_transport` (transport in Task 7).
  - `noise::reconnect::ReconnectResponder::new(server_priv: &[u8]) -> Result<Self, NoiseError>` + `write_message`/`read_message`/`is_finished`/`remote_static`/`into_transport`.

The server side must expose `remote_static()` — it is the device public key the caller (Plan 2's server) looks up in the registry to authorize. Authorization is **not** performed here; completing the handshake is not authorization (see spec).

- [ ] **Step 1: Write the failing tests**

Create `crates/tether-core/src/noise/reconnect.rs`:

```rust
//! IK reconnect handshake. Device = initiator and already knows (pinned) the
//! server's static key; server = responder and learns the device's static key.
//! Completing IK proves key possession only — the caller must look the device
//! key up in the registry to authorize (see spec).

use snow::{Builder, HandshakeState};

use super::{params, NoiseError};

pub struct ReconnectInitiator {
    hs: HandshakeState,
}
pub struct ReconnectResponder {
    hs: HandshakeState,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::noise::pairing::generate_static_keypair;

    #[test]
    fn ik_completes_and_server_learns_device_key() {
        let dev = generate_static_keypair().unwrap();
        let srv = generate_static_keypair().unwrap();

        let mut i = ReconnectInitiator::new(&dev.private, &srv.public).unwrap();
        let mut r = ReconnectResponder::new(&srv.private).unwrap();
        let (mut b, mut rb) = ([0u8; 65535], [0u8; 65535]);
        // -> e, es, s, ss
        let n = i.write_message(&[], &mut b).unwrap();
        r.read_message(&b[..n], &mut rb).unwrap();
        // <- e, ee, se
        let n = r.write_message(&[], &mut b).unwrap();
        i.read_message(&b[..n], &mut rb).unwrap();

        assert!(i.is_finished() && r.is_finished());
        assert_eq!(r.remote_static().unwrap(), dev.public);
    }

    #[test]
    fn ik_against_the_wrong_server_key_fails() {
        let dev = generate_static_keypair().unwrap();
        let srv = generate_static_keypair().unwrap();
        let impostor = generate_static_keypair().unwrap();

        // Device pins the impostor's key, but the real responder holds srv.
        let mut i = ReconnectInitiator::new(&dev.private, &impostor.public).unwrap();
        let mut r = ReconnectResponder::new(&srv.private).unwrap();
        let (mut b, mut rb) = ([0u8; 65535], [0u8; 65535]);
        let n = i.write_message(&[], &mut b).unwrap();
        // Responder cannot decrypt msg1 (encrypted to the impostor key).
        assert!(r.read_message(&b[..n], &mut rb).is_err());
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p tether-core noise::reconnect`
Expected: FAIL (types not defined).

- [ ] **Step 3: Implement both halves**

Add above the test block:

```rust
impl ReconnectInitiator {
    pub fn new(device_priv: &[u8], server_pub_pinned: &[u8]) -> Result<Self, NoiseError> {
        let params = params::parse(params::RECONNECT_PATTERN)?;
        let hs = Builder::new(params)
            .local_private_key(device_priv).map_err(|_| NoiseError::Handshake)?
            .remote_public_key(server_pub_pinned).map_err(|_| NoiseError::Handshake)?
            .prologue(params::PROLOGUE).map_err(|_| NoiseError::Handshake)?
            .build_initiator().map_err(|_| NoiseError::Handshake)?;
        Ok(Self { hs })
    }
    pub fn write_message(&mut self, payload: &[u8], out: &mut [u8]) -> Result<usize, NoiseError> {
        self.hs.write_message(payload, out).map_err(|_| NoiseError::Handshake)
    }
    pub fn read_message(&mut self, msg: &[u8], out: &mut [u8]) -> Result<usize, NoiseError> {
        self.hs.read_message(msg, out).map_err(|_| NoiseError::Handshake)
    }
    pub fn is_finished(&self) -> bool { self.hs.is_handshake_finished() }
}

impl ReconnectResponder {
    pub fn new(server_priv: &[u8]) -> Result<Self, NoiseError> {
        let params = params::parse(params::RECONNECT_PATTERN)?;
        let hs = Builder::new(params)
            .local_private_key(server_priv).map_err(|_| NoiseError::Handshake)?
            .prologue(params::PROLOGUE).map_err(|_| NoiseError::Handshake)?
            .build_responder().map_err(|_| NoiseError::Handshake)?;
        Ok(Self { hs })
    }
    pub fn write_message(&mut self, payload: &[u8], out: &mut [u8]) -> Result<usize, NoiseError> {
        self.hs.write_message(payload, out).map_err(|_| NoiseError::Handshake)
    }
    pub fn read_message(&mut self, msg: &[u8], out: &mut [u8]) -> Result<usize, NoiseError> {
        self.hs.read_message(msg, out).map_err(|_| NoiseError::Handshake)
    }
    pub fn is_finished(&self) -> bool { self.hs.is_handshake_finished() }
    pub fn remote_static(&self) -> Result<Vec<u8>, NoiseError> {
        self.hs.get_remote_static().map(|s| s.to_vec()).ok_or(NoiseError::MissingRemoteStatic)
    }
}
```

- [ ] **Step 4: Wire the module in**

Ensure `pub mod reconnect;` is present in `crates/tether-core/src/noise/mod.rs`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test -p tether-core noise::reconnect`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add crates/tether-core/src/noise/reconnect.rs crates/tether-core/src/noise/mod.rs
git commit -m "feat(noise): IK reconnect handshake, server learns device key"
```

---

## Task 7: Transport — chunked framing over TransportState

**Files:**
- Create: `crates/tether-core/src/noise/transport.rs`
- Modify: `crates/tether-core/src/noise/mod.rs` (add `pub mod transport;` and `pub use transport::NoiseSession;`)
- Modify: `crates/tether-core/src/noise/pairing.rs` and `reconnect.rs` (implement the `into_transport` methods declared in Tasks 4/6)

**Interfaces:**
- Consumes: `snow::TransportState`, `NoiseError`.
- Produces:
  - `noise::transport::NoiseSession` wrapping a `snow::TransportState`.
  - `NoiseSession::from_transport(ts: snow::TransportState) -> Self` (crate-internal; the `into_transport` methods call it).
  - `NoiseSession::seal(&mut self, plaintext: &[u8]) -> Result<Vec<u8>, NoiseError>` — returns one wire buffer: a 4-byte big-endian record count, then each record as a 2-byte big-endian length + ciphertext. Splits plaintext into ≤ `MAX_PLAINTEXT` chunks so every Noise record stays under 65535.
  - `NoiseSession::open(&mut self, wire: &[u8]) -> Result<Vec<u8>, NoiseError>` — inverse; reassembles the original plaintext.
  - `noise::transport::MAX_PLAINTEXT: usize` = `65519` (65535 minus the 16-byte ChaChaPoly tag).

- [ ] **Step 1: Write the failing tests**

Create `crates/tether-core/src/noise/transport.rs`:

```rust
//! Chunked framing over a Noise TransportState. snow caps a record at 65535
//! bytes; PTY output exceeds that, so seal() splits plaintext into records and
//! open() reassembles. Nonces live inside TransportState — never exposed.

use snow::TransportState;

use super::NoiseError;

pub const MAX_PLAINTEXT: usize = 65535 - 16;

pub struct NoiseSession {
    ts: TransportState,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::noise::pairing::{generate_static_keypair, PairingInitiator, PairingResponder};
    use crate::noise::psk;

    // Complete a pairing handshake and hand back both transport sessions.
    fn paired_sessions() -> (NoiseSession, NoiseSession) {
        let dev = generate_static_keypair().unwrap();
        let srv = generate_static_keypair().unwrap();
        let psk = psk::derive("011B23456789").unwrap();
        let mut i = PairingInitiator::new(&dev.private, &psk).unwrap();
        let mut r = PairingResponder::new(&srv.private, &psk).unwrap();
        let (mut b, mut rb) = ([0u8; 65535], [0u8; 65535]);
        let n = i.write_message(&[], &mut b).unwrap();
        r.read_message(&b[..n], &mut rb).unwrap();
        let n = r.write_message(&[], &mut b).unwrap();
        i.read_message(&b[..n], &mut rb).unwrap();
        let n = i.write_message(&[], &mut b).unwrap();
        r.read_message(&b[..n], &mut rb).unwrap();
        (i.into_transport().unwrap(), r.into_transport().unwrap())
    }

    #[test]
    fn small_payload_round_trips() {
        let (mut i, mut r) = paired_sessions();
        let wire = i.seal(b"hello shell").unwrap();
        assert_eq!(r.open(&wire).unwrap(), b"hello shell");
    }

    #[test]
    fn payload_larger_than_one_record_round_trips() {
        let (mut i, mut r) = paired_sessions();
        let big = vec![0xABu8; MAX_PLAINTEXT * 2 + 500]; // 3 records
        let wire = i.seal(&big).unwrap();
        assert_eq!(r.open(&wire).unwrap(), big);
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p tether-core noise::transport`
Expected: FAIL (`into_transport`, `seal`, `open` not defined).

- [ ] **Step 3: Implement `NoiseSession` seal/open**

Add above the test block in `transport.rs`:

```rust
impl NoiseSession {
    pub(crate) fn from_transport(ts: TransportState) -> Self {
        Self { ts }
    }

    pub fn seal(&mut self, plaintext: &[u8]) -> Result<Vec<u8>, NoiseError> {
        let chunks: Vec<&[u8]> = if plaintext.is_empty() {
            vec![&[]]
        } else {
            plaintext.chunks(MAX_PLAINTEXT).collect()
        };
        let mut wire = Vec::with_capacity(plaintext.len() + chunks.len() * 18 + 4);
        wire.extend_from_slice(&(chunks.len() as u32).to_be_bytes());
        let mut buf = [0u8; 65535];
        for chunk in chunks {
            let n = self.ts.write_message(chunk, &mut buf).map_err(|_| NoiseError::Transport)?;
            wire.extend_from_slice(&(n as u16).to_be_bytes());
            wire.extend_from_slice(&buf[..n]);
        }
        Ok(wire)
    }

    pub fn open(&mut self, wire: &[u8]) -> Result<Vec<u8>, NoiseError> {
        if wire.len() < 4 {
            return Err(NoiseError::BadFrame);
        }
        let count = u32::from_be_bytes([wire[0], wire[1], wire[2], wire[3]]) as usize;
        let mut pos = 4;
        let mut out = Vec::new();
        let mut buf = [0u8; 65535];
        for _ in 0..count {
            if pos + 2 > wire.len() {
                return Err(NoiseError::BadFrame);
            }
            let len = u16::from_be_bytes([wire[pos], wire[pos + 1]]) as usize;
            pos += 2;
            if pos + len > wire.len() {
                return Err(NoiseError::BadFrame);
            }
            let n = self
                .ts
                .read_message(&wire[pos..pos + len], &mut buf)
                .map_err(|_| NoiseError::Transport)?;
            out.extend_from_slice(&buf[..n]);
            pos += len;
        }
        Ok(out)
    }
}
```

- [ ] **Step 4: Implement the `into_transport` methods**

In `pairing.rs`, add to both `impl PairingInitiator` and `impl PairingResponder`:

```rust
    pub fn into_transport(self) -> Result<super::transport::NoiseSession, NoiseError> {
        let ts = self.hs.into_transport_mode().map_err(|_| NoiseError::Transport)?;
        Ok(super::transport::NoiseSession::from_transport(ts))
    }
```

In `reconnect.rs`, add the identical method to both `impl ReconnectInitiator` and `impl ReconnectResponder`.

- [ ] **Step 5: Wire the module in**

Add to `crates/tether-core/src/noise/mod.rs`:

```rust
pub mod transport;
pub use transport::NoiseSession;
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cargo test -p tether-core noise::`
Expected: PASS (all noise tests, including the two new transport tests).

- [ ] **Step 7: Commit**

```bash
git add crates/tether-core/src/noise/transport.rs crates/tether-core/src/noise/pairing.rs crates/tether-core/src/noise/reconnect.rs crates/tether-core/src/noise/mod.rs
git commit -m "feat(noise): chunked transport framing over Noise TransportState"
```

---

## Task 8: In-band rekey

**Files:**
- Modify: `crates/tether-core/src/noise/transport.rs`

**Interfaces:**
- Produces:
  - `NoiseSession::rekey_outgoing(&mut self)` — rotate the send key.
  - `NoiseSession::rekey_incoming(&mut self)` — rotate the receive key.

The *signal* that triggers a rekey (a control frame) is an application-protocol concern for Plan 2; this task provides the synchronized primitive and proves it works mid-stream.

- [ ] **Step 1: Write the failing test**

Add to the `tests` module in `transport.rs`:

```rust
    #[test]
    fn rekey_mid_stream_keeps_the_channel_working() {
        let (mut i, mut r) = paired_sessions();

        // pre-rekey message
        let w = i.seal(b"before").unwrap();
        assert_eq!(r.open(&w).unwrap(), b"before");

        // both sides rotate in sync: sender's outgoing, receiver's incoming
        i.rekey_outgoing();
        r.rekey_incoming();

        // post-rekey message still round-trips
        let w = i.seal(b"after").unwrap();
        assert_eq!(r.open(&w).unwrap(), b"after");
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p tether-core noise::transport::tests::rekey_mid_stream_keeps_the_channel_working`
Expected: FAIL (`rekey_outgoing` not defined).

- [ ] **Step 3: Implement the rekey methods**

Add to `impl NoiseSession` in `transport.rs`:

```rust
    pub fn rekey_outgoing(&mut self) {
        self.ts.rekey_outgoing();
    }
    pub fn rekey_incoming(&mut self) {
        self.ts.rekey_incoming();
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p tether-core noise::transport::tests::rekey_mid_stream_keeps_the_channel_working`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/tether-core/src/noise/transport.rs
git commit -m "feat(noise): in-band synchronized rekey on the transport session"
```

---

## Task 9: Full end-to-end integration test + lint gate

**Files:**
- Create: `crates/tether-core/src/noise/tests_e2e.rs`
- Modify: `crates/tether-core/src/noise/mod.rs` (add `#[cfg(test)] mod tests_e2e;`)

**Interfaces:** none new — this task exercises the whole crate as one flow.

- [ ] **Step 1: Write the failing end-to-end test**

Create `crates/tether-core/src/noise/tests_e2e.rs`:

```rust
//! One test that walks the whole intended flow: generate a code, derive the
//! PSK on both sides, pair, then reconnect with the pinned key and exchange a
//! large payload over the transport.

use super::{code, pairing, psk, reconnect};

#[test]
fn pair_then_reconnect_then_stream() {
    // --- server + device long-term keys ---
    let server = pairing::generate_static_keypair().unwrap();
    let device = pairing::generate_static_keypair().unwrap();

    // --- pairing: server prints a code, device types it ---
    let printed = code::generate();
    let typed = code::normalize(&code::grouped(&printed)).unwrap();
    let psk_server = psk::derive(&code::normalize(&printed).unwrap()).unwrap();
    let psk_device = psk::derive(&typed).unwrap();

    let mut i = pairing::PairingInitiator::new(&device.private, &psk_device).unwrap();
    let mut r = pairing::PairingResponder::new(&server.private, &psk_server).unwrap();
    let (mut b, mut rb) = ([0u8; 65535], [0u8; 65535]);
    let n = i.write_message(&[], &mut b).unwrap();
    r.read_message(&b[..n], &mut rb).unwrap();
    let n = r.write_message(&[], &mut b).unwrap();
    i.read_message(&b[..n], &mut rb).unwrap();
    let n = i.write_message(&[], &mut b).unwrap();
    r.read_message(&b[..n], &mut rb).unwrap();

    let pinned_server_pub = i.remote_static().unwrap();
    let enrolled_device_pub = r.remote_static().unwrap();
    assert_eq!(pinned_server_pub, server.public);
    assert_eq!(enrolled_device_pub, device.public);

    // --- reconnect later: IK with the pinned server key ---
    let mut ri = reconnect::ReconnectInitiator::new(&device.private, &pinned_server_pub).unwrap();
    let mut rr = reconnect::ReconnectResponder::new(&server.private).unwrap();
    let n = ri.write_message(&[], &mut b).unwrap();
    rr.read_message(&b[..n], &mut rb).unwrap();
    let n = rr.write_message(&[], &mut b).unwrap();
    ri.read_message(&b[..n], &mut rb).unwrap();

    // server would look this up in its registry to authorize:
    assert_eq!(rr.remote_static().unwrap(), device.public);

    // --- stream a large payload over the transport ---
    let mut cs = ri.into_transport().unwrap();
    let mut ss = rr.into_transport().unwrap();
    let payload = vec![0x42u8; 200_000];
    let wire = cs.seal(&payload).unwrap();
    assert_eq!(ss.open(&wire).unwrap(), payload);
}
```

- [ ] **Step 2: Wire the test module in**

Add to `crates/tether-core/src/noise/mod.rs`:

```rust
#[cfg(test)]
mod tests_e2e;
```

- [ ] **Step 3: Run the whole noise suite**

Run: `cargo test -p tether-core noise::`
Expected: PASS (all tasks' tests + the e2e test).

- [ ] **Step 4: Run clippy and fmt gates**

Run: `cargo clippy -p tether-core --all-targets -- -D warnings && cargo fmt -p tether-core -- --check`
Expected: no warnings, no diff. Fix any clippy findings (e.g. needless clones) and re-run.

- [ ] **Step 5: Commit**

```bash
git add crates/tether-core/src/noise/tests_e2e.rs crates/tether-core/src/noise/mod.rs
git commit -m "test(noise): full pair -> reconnect -> stream integration test"
```

---

## Self-Review

**Spec coverage (foundation items that belong to the Rust core):**
- Frozen suites + prologue, no negotiation → Task 1 + Task 5. ✅
- XXpsk2 pairing, device learns/pins server key → Task 4. ✅
- IK reconnect, server learns device key → Task 6. ✅
- IK completion ≠ authorization → the registry lookup lives in Plan 2 (server); Task 6 deliberately exposes `remote_static()` and does *not* authorize, with a comment saying so. ✅ (boundary correct)
- Argon2id PSK, fixed salt → Task 3. ✅
- 12-char Crockford code, fold + group → Task 2. ✅
- Chunking > 64 KB → Task 7. ✅
- In-band synchronized rekey → Task 8. ✅
- Opaque session, no nonce/key bytes in the API → `NoiseSession` holds `TransportState` privately; only `seal`/`open`/`rekey_*` are public. ✅
- **Out of scope for Plan 1 (correctly deferred):** the C-ABI/FFI surface, single-owner threading enforcement, `bun --compile` packaging, device registry, CLI, password removal — all Plan 2. Per-host keypair *storage* (Keychain/keyring) is Plans 3–4; Plan 1 only generates the bytes.

**Placeholder scan:** no TBD/TODO; every code step is complete Rust. The one forward-reference (`into_transport` declared in Task 4, bodied in Task 7) is called out explicitly in both tasks.

**Type consistency:** `NoiseError` variants used across files all exist in the Task 1 enum. `generate_static_keypair`/`Keypair` defined in Task 4 and reused verbatim in Tasks 6/7/9. `NoiseSession::from_transport` (Task 7) is `pub(crate)` and called only by `into_transport` methods. `remote_static()` name identical across pairing + reconnect. `seal`/`open`/`rekey_outgoing`/`rekey_incoming` names stable Tasks 7→9.

**One risk flagged for execution:** `snow`'s exact builder method names (`remote_public_key`, `rekey_outgoing`, `rekey_incoming`, `get_remote_static`) were taken from snow 0.9 docs. If a patch release renamed one, the compiler will catch it at the first failing task — fix the call, not the design.

---

## Execution Handoff

This is Plan 1 of 5 (Rust core). Plans 2–5 (FFI+server, iOS, desktop, docs/hardening) are separate and depend on this one shipping green.
