# Tether Client Noise Driver (Plan 4a of 5 — shared client core)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans.

**Goal:** A shared, async client-side driver in `tether-core` that pumps the Noise handshake over a transport and yields an encrypted session — one for `IK` reconnect, one for `XXpsk2` pairing. Both iOS and the Tauri desktop consume this (desktop links `tether-core`; iOS via FFI later), so the client handshake logic lives once, in Rust, cargo-tested. No platform keyring / WS / UI here.

**Architecture:** A `Transport` trait (async `send`/`recv` of byte frames — a WebSocket in production, in-memory in tests). `client_reconnect` / `client_pair` drive the existing `ReconnectInitiator` / `PairingInitiator` primitives (Plan 1) over it and return a `NoiseSession`. Tested by pumping the raw responder primitives inline against an in-memory duplex.

**Tech Stack:** Rust 2021, `tokio` (already a dep), the `noise` module from Plan 1.

**Spec:** `docs/superpowers/specs/2026-09-03-tether-noise-pairing-design.md`.

## Global Constraints

- Device is the initiator in both flows.
- `client_pair` returns the session **and** the server's static public key (from `get_remote_static`) so the caller can pin it.
- Async fn in traits (stable since Rust 1.75) — concrete transport types only; no `dyn`.
- Inline `#[cfg(test)] mod tests`, matching the crate.

---

## File Structure

- Create `crates/tether-core/src/noise/driver.rs` — `Transport` trait + `client_reconnect` + `client_pair`.
- Modify `crates/tether-core/src/noise/mod.rs` — `pub mod driver;`.

---

## Task 1: `Transport` trait + `client_reconnect`

**Files:** Create `crates/tether-core/src/noise/driver.rs`; modify `mod.rs`.

**Interfaces:**
- Produces:
  - `pub trait Transport { async fn send(&mut self, frame: Vec<u8>) -> Result<(), NoiseError>; async fn recv(&mut self) -> Result<Vec<u8>, NoiseError>; }`
  - `pub async fn client_reconnect<T: Transport>(t: &mut T, device_priv: &[u8], server_pub: &[u8]) -> Result<NoiseSession, NoiseError>`

- [ ] **Step 1: Write the module + failing test.** Create `driver.rs`:

```rust
//! Async client-side Noise drivers, shared by every native client. They pump
//! the initiator handshake (Plan 1 primitives) over a Transport and return an
//! encrypted session.

use super::pairing::PairingInitiator;
use super::reconnect::ReconnectInitiator;
use super::{NoiseError, NoiseSession};

#[allow(async_fn_in_trait)]
pub trait Transport {
    async fn send(&mut self, frame: Vec<u8>) -> Result<(), NoiseError>;
    async fn recv(&mut self) -> Result<Vec<u8>, NoiseError>;
}

pub async fn client_reconnect<T: Transport>(
    t: &mut T,
    device_priv: &[u8],
    server_pub: &[u8],
) -> Result<NoiseSession, NoiseError> {
    let mut i = ReconnectInitiator::new(device_priv, server_pub)?;
    let mut buf = [0u8; 65535];
    let n = i.write_message(&[], &mut buf)?; // -> e, es, s, ss
    t.send(buf[..n].to_vec()).await?;
    let msg = t.recv().await?; // <- e, ee, se
    let mut rb = [0u8; 65535];
    i.read_message(&msg, &mut rb)?;
    i.into_transport()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::noise::pairing::generate_static_keypair;
    use crate::noise::reconnect::ReconnectResponder;
    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex};

    // An in-memory duplex: two shared queues. Each end sends into one and
    // receives from the other.
    #[derive(Clone)]
    struct MemChan {
        tx: Arc<Mutex<VecDeque<Vec<u8>>>>,
        rx: Arc<Mutex<VecDeque<Vec<u8>>>>,
    }
    impl Transport for MemChan {
        async fn send(&mut self, frame: Vec<u8>) -> Result<(), NoiseError> {
            self.tx.lock().unwrap().push_back(frame);
            Ok(())
        }
        async fn recv(&mut self) -> Result<Vec<u8>, NoiseError> {
            loop {
                if let Some(f) = self.rx.lock().unwrap().pop_front() {
                    return Ok(f);
                }
                tokio::time::sleep(std::time::Duration::from_millis(1)).await;
            }
        }
    }
    fn duplex() -> (MemChan, Arc<Mutex<VecDeque<Vec<u8>>>>, Arc<Mutex<VecDeque<Vec<u8>>>>) {
        let a = Arc::new(Mutex::new(VecDeque::new())); // client->server
        let b = Arc::new(Mutex::new(VecDeque::new())); // server->client
        (MemChan { tx: a.clone(), rx: b.clone() }, a, b)
    }

    #[tokio::test]
    async fn reconnect_driver_completes_and_streams() {
        let server = generate_static_keypair().unwrap();
        let device = generate_static_keypair().unwrap();
        let (mut client, c2s, s2c) = duplex();

        // Drive the client and a hand-pumped responder concurrently.
        let dev_priv = device.private.clone();
        let srv_pub = server.public.clone();
        let client_task =
            tokio::spawn(async move { client_reconnect(&mut client, &dev_priv, &srv_pub).await });

        // Responder side, pumped off the raw queues.
        let mut r = ReconnectResponder::new(&server.private).unwrap();
        let mut rb = [0u8; 65535];
        let msg1 = loop {
            if let Some(f) = c2s.lock().unwrap().pop_front() {
                break f;
            }
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
        };
        r.read_message(&msg1, &mut rb).unwrap();
        let mut buf = [0u8; 65535];
        let n = r.write_message(&[], &mut buf).unwrap();
        s2c.lock().unwrap().push_back(buf[..n].to_vec());
        assert_eq!(r.remote_static().unwrap(), device.public);

        let mut client_session = client_task.await.unwrap().unwrap();
        let mut server_session = r.into_transport().unwrap();

        // client -> server frame
        let wire = client_session.seal(b"hello").unwrap();
        assert_eq!(server_session.open(&wire).unwrap(), b"hello");
    }
}
```

- [ ] **Step 2:** Add `pub mod driver;` to `crates/tether-core/src/noise/mod.rs` (keep alphabetical: after `pub mod code;`).

- [ ] **Step 3: Run → PASS.** `cargo test --manifest-path crates/tether-core/Cargo.toml --lib noise::driver`. If the async-fn-in-trait lint errors instead of warns, the `#[allow(async_fn_in_trait)]` on the trait covers it; ensure it's present.

- [ ] **Step 4: Commit.** `git commit -am "feat(noise): async client_reconnect driver in tether-core"`

---

## Task 2: `client_pair`

**Files:** Modify `crates/tether-core/src/noise/driver.rs`.

**Interfaces:**
- Produces: `pub async fn client_pair<T: Transport>(t: &mut T, device_priv: &[u8], psk: &[u8; 32]) -> Result<(NoiseSession, Vec<u8>), NoiseError>` — returns the session and the server's pinned static public key.

- [ ] **Step 1: Implement** above the test module:

```rust
pub async fn client_pair<T: Transport>(
    t: &mut T,
    device_priv: &[u8],
    psk: &[u8; 32],
) -> Result<(NoiseSession, Vec<u8>), NoiseError> {
    let mut i = PairingInitiator::new(device_priv, psk)?;
    let mut buf = [0u8; 65535];
    let mut rb = [0u8; 65535];
    let n = i.write_message(&[], &mut buf)?; // -> e
    t.send(buf[..n].to_vec()).await?;
    let msg = t.recv().await?; // <- e, ee, s, es
    i.read_message(&msg, &mut rb)?;
    let server_pub = i.remote_static()?;
    let n = i.write_message(&[], &mut buf)?; // -> s, se
    t.send(buf[..n].to_vec()).await?;
    let session = i.into_transport()?;
    Ok((session, server_pub))
}
```

- [ ] **Step 2: Write the test** (add to the `tests` module): pair the client driver against a hand-pumped `PairingResponder` (from `crate::noise::pairing`) with a PSK from `crate::noise::psk::derive("011B23456789")`; assert the returned `server_pub` equals `server.public`, and that a device-sealed frame opens on the server session.

- [ ] **Step 3: Run → PASS.**

- [ ] **Step 4: clippy + fmt gate.** `cargo clippy --manifest-path crates/tether-core/Cargo.toml --lib -- -D warnings && cargo fmt --manifest-path crates/tether-core/Cargo.toml -- --check` (fix + re-run).

- [ ] **Step 5: Commit.** `git commit -am "feat(noise): async client_pair driver + pin server key"`

---

## Self-Review

- Shared client handshake driver lives once in `tether-core` → both clients reuse it. ✅
- Reconnect + pairing initiator flows, async over a transport → Tasks 1–2. ✅
- Pairing pins the server static key (returned to caller) → Task 2. ✅
- **Deferred to the platform client plans:** per-host keypair storage (keyring on desktop / Keychain on iOS), WS transport implementing `Transport`, pairing + device-management UI, and consuming this driver in `host_client`. Those are per-platform and need the server WS glue to integration-test.

## Execution Handoff

Plan 4a. Desktop (4b) and iOS (3) then wrap platform storage + a real WS `Transport` + UI around these drivers.
