use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};
use tether_core::noise::driver::{client_pair, client_reconnect, Transport};
use tether_core::noise::pairing::{derive_public, generate_static_keypair};
use tether_core::noise::{code, psk, NoiseSession};
use tether_core::terminal_session_logic::{backoff_delay, retry_after_close};
use tokio::sync::mpsc;

use crate::commands::connect::{now_ms, random_unit, HEALTHY_MS};
use crate::noise_session::{
    decode_server, encode_devices_list, encode_devices_revoke, encode_frontend_output,
    encode_start, translate_frontend, DeviceInfo, ServerMsg,
};
use crate::noise_store::{
    load_device_keypair_in, load_pinned_server_key_in, save_device_keypair_in,
    save_pinned_server_key_in, KeyStore, KeyringKeyStore,
};
use crate::noise_ws::{NoiseWs, NoiseWsRx, NoiseWsTx};
use crate::state::{NoiseHandle, SharedState};

fn fingerprint(key: &[u8]) -> String {
    Sha256::digest(key)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn load_or_generate<K: KeyStore>(store: &K, host_id: &str) -> Result<Vec<u8>, String> {
    if let Some(existing) = load_device_keypair_in(store, host_id).map_err(|e| e.to_string())? {
        return Ok(existing);
    }
    let kp = generate_static_keypair().map_err(|e| e.to_string())?;
    save_device_keypair_in(store, host_id, &kp.private).map_err(|e| e.to_string())?;
    Ok(kp.private)
}

/// Derive this device's own Noise fingerprint for `host_id`, generating the
/// device keypair if it does not exist yet (same key `pair_with` would use).
/// Returns the lowercase 64-hex sha256 of the device's PUBLIC key — the same
/// shape as the pinned server fingerprint — so the pairing screen can show it
/// for the user to read aloud, matching the iOS "waiting" screen.
fn device_fingerprint_in<K: KeyStore>(store: &K, host_id: &str) -> Result<String, String> {
    let device_priv = load_or_generate(store, host_id)?;
    let priv32: [u8; 32] = device_priv
        .as_slice()
        .try_into()
        .map_err(|_| "device private key is not 32 bytes".to_string())?;
    Ok(fingerprint(&derive_public(&priv32)))
}

/// The device's own fingerprint under `host_id` (see [`device_fingerprint_in`]).
/// Shown on the desktop pairing screen so the user can verify it against the
/// host's confirm prompt — parity with iOS.
#[tauri::command]
pub async fn core_noise_device_fingerprint(host_id: String) -> Result<String, String> {
    device_fingerprint_in(&KeyringKeyStore, &host_id)
}

pub async fn pair_with<T: Transport, K: KeyStore>(
    store: &K,
    host_id: &str,
    transport: &mut T,
    code: &str,
) -> Result<String, String> {
    let device_priv = load_or_generate(store, host_id)?;
    let normalized = code::normalize(code).map_err(|e| e.to_string())?;
    let psk = psk::derive(&normalized).map_err(|e| e.to_string())?;
    let (_session, server_pub) = client_pair(transport, &device_priv, &psk)
        .await
        .map_err(|e| e.to_string())?;
    // The handshake finishing is NOT approval: the server enrolls the device only
    // after the host confirms, then sends a plaintext `{ok}` verdict and closes.
    // Wait for it so pairing reflects the real outcome (and only pin on approval),
    // matching the iOS client — otherwise we'd report success before the host said yes.
    let verdict = transport.recv().await.map_err(|e| e.to_string())?;
    let reply: PairReply =
        serde_json::from_slice(&verdict).map_err(|e| format!("bad pairing reply: {e}"))?;
    if !reply.ok {
        return Err(reply
            .error
            .unwrap_or_else(|| "pairing was rejected".to_string()));
    }
    save_pinned_server_key_in(store, host_id, &server_pub).map_err(|e| e.to_string())?;
    Ok(fingerprint(&server_pub))
}

/// The plaintext verdict the `/api/noise/pair` route sends after the host confirms.
#[derive(serde::Deserialize)]
struct PairReply {
    ok: bool,
    error: Option<String>,
}

pub async fn reconnect_with<T: Transport, K: KeyStore>(
    store: &K,
    host_id: &str,
    transport: &mut T,
) -> Result<(), String> {
    let device_priv = load_device_keypair_in(store, host_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "missing device keypair for host".to_string())?;
    let server_pub = load_pinned_server_key_in(store, host_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "missing pinned server key for host".to_string())?;
    client_reconnect(transport, &device_priv, &server_pub)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn core_noise_pair(
    host_id: String,
    address: String,
    code: String,
) -> Result<String, String> {
    let mut ws = NoiseWs::connect(&address)
        .await
        .map_err(|error| error.to_string())?;
    pair_with(&KeyringKeyStore, &host_id, &mut ws, &code).await
}

#[tauri::command]
pub async fn core_noise_reconnect(host_id: String, address: String) -> Result<(), String> {
    let mut ws = NoiseWs::connect(&address)
        .await
        .map_err(|error| error.to_string())?;
    reconnect_with(&KeyringKeyStore, &host_id, &mut ws).await
}

/// The verdict of a `devices.revoke`, relayed verbatim to the webview. The server
/// allows self-revoke; this just reports whatever it decided (the UI does the
/// warning).
#[derive(serde::Serialize)]
pub struct RevokeResult {
    pub ok: bool,
    pub error: Option<String>,
}

/// Open a short-lived authenticated management session to `address` using the
/// pinned keys stored under `host_id`. Fail-closed: a WS-connect or handshake
/// failure (a revoked or unknown device fails the IK handshake here) returns Err.
async fn open_management_session<K: KeyStore>(
    store: &K,
    host_id: &str,
    address: &str,
) -> Result<(NoiseWs, NoiseSession), String> {
    let device_priv = load_device_keypair_in(store, host_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "missing device keypair for host".to_string())?;
    let server_pub = load_pinned_server_key_in(store, host_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "missing pinned server key for host".to_string())?;
    let mut ws = NoiseWs::connect(address)
        .await
        .map_err(|error| error.to_string())?;
    let session = client_reconnect(&mut ws, &device_priv, &server_pub)
        .await
        .map_err(|error| error.to_string())?;
    Ok((ws, session))
}

/// Reachability check for a Noise host: attempt the IK reconnect handshake. A
/// success means the host is up AND this device is still authorized; any failure
/// (host down, or this device revoked/unknown) is `false`. Used for the host
/// health badge, since the password `/api/status` probe always 401s a Noise host.
#[tauri::command]
pub async fn core_noise_ping(host_id: String, address: String) -> Result<bool, String> {
    Ok(open_management_session(&KeyringKeyStore, &host_id, &address)
        .await
        .is_ok())
}

/// List the devices paired with a Noise host over a dedicated management session.
/// Fail-closed: a reconnect/handshake failure (revoked or unknown device) errors.
#[tauri::command]
pub async fn core_noise_devices_list(
    host_id: String,
    address: String,
) -> Result<Vec<DeviceInfo>, String> {
    let (mut ws, mut session) =
        open_management_session(&KeyringKeyStore, &host_id, &address).await?;
    let wire = session
        .seal(&encode_devices_list())
        .map_err(|error| error.to_string())?;
    ws.send(wire).await.map_err(|error| error.to_string())?;
    loop {
        let frame = ws.recv().await.map_err(|error| error.to_string())?;
        let plain = session.open(&frame).map_err(|error| error.to_string())?;
        if let ServerMsg::Devices(items) =
            decode_server(&plain).map_err(|error| error.to_string())?
        {
            return Ok(items);
        }
    }
}

/// Revoke one device (by exact `id`) on a Noise host. Reads until the
/// `devices.revoked` verdict for THIS target, then relays `{ok,error}`. Self
/// revoke is allowed by the server — the UI warns; this just reports the verdict.
#[tauri::command]
pub async fn core_noise_revoke(
    host_id: String,
    address: String,
    target: String,
) -> Result<RevokeResult, String> {
    let (mut ws, mut session) =
        open_management_session(&KeyringKeyStore, &host_id, &address).await?;
    let wire = session
        .seal(&encode_devices_revoke(&target))
        .map_err(|error| error.to_string())?;
    ws.send(wire).await.map_err(|error| error.to_string())?;
    loop {
        let frame = ws.recv().await.map_err(|error| error.to_string())?;
        let plain = session.open(&frame).map_err(|error| error.to_string())?;
        if let ServerMsg::DevicesRevoked {
            target: verdict_target,
            ok,
            error,
        } = decode_server(&plain).map_err(|error| error.to_string())?
        {
            if verdict_target == target {
                return Ok(RevokeResult { ok, error });
            }
        }
    }
}

/// Rebuild a fresh authenticated Noise session to `address` from already-loaded
/// keys — the reconnect step for the live terminal pump. Unlike
/// [`open_management_session`] it takes the raw key bytes (captured once by the
/// pump) instead of re-reading the keyring on every retry.
async fn reconnect_terminal_session(
    address: &str,
    device_priv: &[u8],
    server_pub: &[u8],
) -> Result<(NoiseWs, NoiseSession), String> {
    let mut ws = NoiseWs::connect(address)
        .await
        .map_err(|error| error.to_string())?;
    let session = client_reconnect(&mut ws, device_priv, server_pub)
        .await
        .map_err(|error| error.to_string())?;
    Ok((ws, session))
}

/// Reconnect the live pump after an unexpected socket drop, mirroring the
/// password path's backoff loop (`core_connect`). Emits `"reconnecting"`, then
/// retries `NoiseWs::connect` + `client_reconnect` with capped exponential
/// backoff until it succeeds — swapping in the new socket/session and emitting
/// `"connected"` — or the cancel flag is set (returns `false`, meaning give up
/// and let the pump emit close). There is no max-attempt cap on purpose: a
/// paired terminal should ride out a long server restart the way the password
/// path does. The cancel flag is checked on both sides of each backoff sleep so
/// `core_noise_close` stops it promptly.
#[allow(clippy::too_many_arguments)]
async fn reconnect(
    app: &AppHandle,
    cancel: &AtomicBool,
    status_evt: &str,
    address: &str,
    device_priv: &[u8],
    server_pub: &[u8],
    retry: &mut u32,
    opened_at: &mut u64,
    tx: &mut NoiseWsTx,
    rx: &mut NoiseWsRx,
    session: &mut NoiseSession,
) -> bool {
    let _ = app.emit(status_evt, "reconnecting");
    // A socket that lived long enough resets the counter (immediate retry);
    // otherwise the previous outage's backoff carries over.
    *retry = retry_after_close(*retry, *opened_at, now_ms(), HEALTHY_MS);
    loop {
        if cancel.load(Ordering::SeqCst) {
            return false;
        }
        let delay = backoff_delay(*retry, random_unit());
        tokio::time::sleep(Duration::from_millis(delay)).await;
        if cancel.load(Ordering::SeqCst) {
            return false;
        }
        match reconnect_terminal_session(address, device_priv, server_pub).await {
            Ok((ws, new_session)) => {
                let (ntx, nrx) = ws.into_split();
                *tx = ntx;
                *rx = nrx;
                *session = new_session;
                *opened_at = now_ms();
                let _ = app.emit(status_evt, "connected");
                return true;
            }
            Err(_) => {
                *retry = retry.saturating_add(1);
            }
        }
    }
}

/// Open a live terminal over a Noise session and stream it toward the frontend.
///
/// The first connect is **synchronous and fail-closed**: the WebSocket connect
/// and the IK handshake must succeed (a revoked/unknown device fails the
/// handshake here and this command errors) before we spawn the pump. After the
/// handshake, the pump owns the socket + [`NoiseSession`] and translates between
/// the two protocols:
///
/// - inbound sealed `{"t":"output","chunk"}` → `core-message-{conn_id}` carrying
///   `{"type":"output","id":<n>,"chunk"}`, `<n>` a per-connection monotonic
///   counter (Noise reconnect replays the whole tail on `start`, so a fresh
///   counter is correct);
/// - inbound sealed `{"t":"exit",…}` → end the pump, emit `core-closed-{conn_id}`;
/// - outgoing frontend WS-JSON on the handle's channel → translated + sealed onto
///   the socket (`input`/`resize`; `focus` and unknowns dropped).
///
/// **Reconnect (parity with the password path `core_connect`):** an *unexpected*
/// socket drop while the user has NOT closed the session triggers a
/// backoff+replay reconnect — rebuild a fresh Noise session to the same
/// `address`, re-send `start` (the server replays the whole tail, so the
/// terminal catches up), swap the live socket/session the pump uses, and keep
/// pumping. `core-status-{conn_id}` emits `"reconnecting"` before each attempt
/// and `"connected"` on success, mirroring the password path. A user close (the
/// cancel flag set by `core_noise_close`, which also drops the outgoing sender)
/// and a remote `exit` both end the pump and emit `core-closed-{conn_id}`.
///
/// The `id` counter is monotonic ACROSS reconnects on purpose: the frontend
/// drops any `output` frame with `id <= lastAppliedId`, so a reset counter would
/// make the replayed tail (and every later frame) be silently discarded. Keeping
/// it climbing lets the replayed tail apply and the terminal catch up.
///
/// Retry policy mirrors `core_connect`: reconnect indefinitely with capped
/// exponential backoff, giving up ONLY when the cancel flag is set (no max
/// attempts) — a paired terminal should survive a long server restart the same
/// way the password path does. The cancel flag is honored between retries so
/// `core_noise_close` stops it promptly.
///
/// TODO: server→client `title`/`activity`/`diff`/`reset` WS message types do not
/// flow over Noise yet — only `output`/`exit` are translated.
/// TODO: cols/rows are captured at connect time and reused verbatim on the
/// reconnect `start`. If the terminal was resized mid-session the replayed
/// geometry is momentarily stale, but the frontend re-sends `resize` on the new
/// socket, so it self-corrects.
#[tauri::command]
pub async fn core_noise_connect(
    app: AppHandle,
    conn_id: String,
    host_id: String,
    address: String,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let device_priv = load_device_keypair_in(&KeyringKeyStore, &host_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "missing device keypair for host".to_string())?;
    let server_pub = load_pinned_server_key_in(&KeyringKeyStore, &host_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "missing pinned server key for host".to_string())?;

    // Synchronous handshake: unreachable host or a failed/rejected IK handshake
    // errors the command exactly like the password path's first connect.
    let mut ws = NoiseWs::connect(&address)
        .await
        .map_err(|error| error.to_string())?;
    let session = client_reconnect(&mut ws, &device_priv, &server_pub)
        .await
        .map_err(|error| error.to_string())?;

    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
    let cancel = Arc::new(AtomicBool::new(false));

    let state = app.state::<SharedState>();
    state.bridge.noise_sessions.lock().unwrap().insert(
        conn_id.clone(),
        NoiseHandle {
            outgoing: out_tx,
            cancel: cancel.clone(),
        },
    );

    let msg_evt = format!("core-message-{conn_id}");
    let close_evt = format!("core-closed-{conn_id}");
    let status_evt = format!("core-status-{conn_id}");
    let (mut tx, mut rx) = ws.into_split();
    let mut session = session;

    tauri::async_runtime::spawn(async move {
        let state = app.state::<SharedState>();
        // Monotonic ACROSS reconnects: the frontend drops `output` frames whose
        // id is <= the last it applied, so resetting per reconnect would discard
        // the replayed tail and everything after it.
        let mut counter: u64 = 0;
        let mut retry: u32 = 0;
        let mut opened_at = now_ms();

        'outer: loop {
            // (Re)open the remote session by replaying the whole tail from `start`.
            match session.seal(&encode_start(&session_id, cols, rows)) {
                Ok(wire) => {
                    if tx.send(wire).await.is_err() {
                        // The just-swapped socket already failed; fall through to
                        // the reconnect path instead of ending outright.
                        if reconnect(
                            &app,
                            &cancel,
                            &status_evt,
                            &address,
                            &device_priv,
                            &server_pub,
                            &mut retry,
                            &mut opened_at,
                            &mut tx,
                            &mut rx,
                            &mut session,
                        )
                        .await
                        {
                            continue 'outer;
                        }
                        break 'outer;
                    }
                }
                // A seal failure means the cipher is unusable — a reconnect
                // rebuilds the session, so try it rather than giving up blind.
                Err(_) => {
                    if reconnect(
                        &app,
                        &cancel,
                        &status_evt,
                        &address,
                        &device_priv,
                        &server_pub,
                        &mut retry,
                        &mut opened_at,
                        &mut tx,
                        &mut rx,
                        &mut session,
                    )
                    .await
                    {
                        continue 'outer;
                    }
                    break 'outer;
                }
            }

            // Pump until the socket drops (→ reconnect) or the session ends
            // (user close / remote exit / unrecoverable decode → close).
            let dropped = loop {
                tokio::select! {
                    inbound = rx.recv() => {
                        let wire = match inbound {
                            Ok(wire) => wire,
                            Err(_) => break true, // socket closed / errored → reconnect
                        };
                        let plain = match session.open(&wire) {
                            Ok(plain) => plain,
                            Err(_) => break false, // decrypt failure ends the session
                        };
                        match decode_server(&plain) {
                            Ok(ServerMsg::Output { chunk }) => {
                                counter += 1;
                                let _ = app.emit(&msg_evt, encode_frontend_output(counter, &chunk));
                            }
                            Ok(ServerMsg::Exit { .. }) => break false, // remote exit → close
                            // devices.* replies + anything else the terminal ignores.
                            Ok(ServerMsg::Devices(_) | ServerMsg::DevicesRevoked { .. }) => {}
                            Ok(ServerMsg::Other) => {}
                            Err(_) => break false, // undecodable plaintext → close
                        }
                    }
                    maybe = out_rx.recv() => {
                        let ws_json = match maybe {
                            Some(text) => text,
                            None => break false, // handle dropped by core_noise_close → close
                        };
                        if let Some(plain) = translate_frontend(&session_id, &ws_json) {
                            match session.seal(&plain) {
                                Ok(wire) => {
                                    if tx.send(wire).await.is_err() {
                                        break true; // socket send failed → reconnect
                                    }
                                }
                                Err(_) => break false, // seal failure desyncs the cipher
                            }
                        }
                    }
                }
            };

            // A user close (cancel flag) always wins over a reconnect. Only an
            // unexpected drop with no close request reconnects.
            if !dropped || cancel.load(Ordering::SeqCst) {
                break 'outer;
            }
            if reconnect(
                &app,
                &cancel,
                &status_evt,
                &address,
                &device_priv,
                &server_pub,
                &mut retry,
                &mut opened_at,
                &mut tx,
                &mut rx,
                &mut session,
            )
            .await
            {
                continue 'outer;
            }
            break 'outer;
        }

        finish(&state, &app, &conn_id, &close_evt);
    });

    Ok(())
}

/// Remove the per-conn handle and emit the frontend close event. The cancel flag
/// (set by `core_noise_close`) is now load-bearing: the reconnect loop checks it
/// between retries, so a user close stops the pump from re-opening a socket it is
/// about to tear down. Dropping the outgoing sender also unblocks the `select!`.
fn finish(state: &SharedState, app: &AppHandle, conn_id: &str, close_evt: &str) {
    state.bridge.noise_sessions.lock().unwrap().remove(conn_id);
    let _ = app.emit(close_evt, ());
}

/// Push one frontend WS-JSON line to the live pump for `conn_id`. The pump
/// translates + seals it; `focus`/unknown lines are dropped there.
#[tauri::command]
pub fn core_noise_send(
    state: State<SharedState>,
    conn_id: String,
    text: String,
) -> Result<(), String> {
    let handle = state
        .bridge
        .noise_sessions
        .lock()
        .unwrap()
        .get(&conn_id)
        .cloned()
        .ok_or_else(|| format!("no noise session for {conn_id}"))?;
    handle
        .outgoing
        .send(text)
        .map_err(|_| format!("noise session {conn_id} is closed"))
}

/// Close a live Noise session: set the cancel flag and drop the handle. Dropping
/// the outgoing sender closes the pump's receiver, so it breaks its loop and
/// emits `core-closed-{conn_id}`.
#[tauri::command]
pub fn core_noise_close(state: State<SharedState>, conn_id: String) {
    if let Some(handle) = state.bridge.noise_sessions.lock().unwrap().remove(&conn_id) {
        handle.cancel.store(true, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex};

    use crate::noise_store::MemoryKeyStore;
    use tether_core::noise::driver::Transport;
    use tether_core::noise::pairing::{generate_static_keypair, PairingResponder};
    use tether_core::noise::reconnect::ReconnectResponder;
    use tether_core::noise::{psk, NoiseError};

    type Queue = Arc<Mutex<VecDeque<Vec<u8>>>>;

    #[derive(Clone)]
    struct MemChan {
        tx: Queue,
        rx: Queue,
    }

    impl Transport for MemChan {
        async fn send(&mut self, frame: Vec<u8>) -> Result<(), NoiseError> {
            self.tx.lock().unwrap().push_back(frame);
            Ok(())
        }
        async fn recv(&mut self) -> Result<Vec<u8>, NoiseError> {
            loop {
                if let Some(frame) = self.rx.lock().unwrap().pop_front() {
                    return Ok(frame);
                }
                tokio::time::sleep(std::time::Duration::from_millis(1)).await;
            }
        }
    }

    async fn pop(q: &Queue) -> Vec<u8> {
        loop {
            if let Some(frame) = q.lock().unwrap().pop_front() {
                return frame;
            }
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
        }
    }

    fn duplex() -> (MemChan, Queue, Queue) {
        let c2s: Queue = Arc::new(Mutex::new(VecDeque::new()));
        let s2c: Queue = Arc::new(Mutex::new(VecDeque::new()));
        (
            MemChan {
                tx: c2s.clone(),
                rx: s2c.clone(),
            },
            c2s,
            s2c,
        )
    }

    #[test]
    fn fingerprint_is_hex_sha256_of_the_pinned_key() {
        assert_eq!(
            fingerprint(&[0u8; 32]),
            "66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925"
        );
    }

    #[test]
    fn device_fingerprint_is_deterministic_and_64_hex() {
        let store = MemoryKeyStore::new();
        // First call generates + stores the device key; the second reuses it, so
        // the fingerprint is stable across calls.
        let first = device_fingerprint_in(&store, "host-a").unwrap();
        let second = device_fingerprint_in(&store, "host-a").unwrap();
        assert_eq!(first, second);
        assert_eq!(first.len(), 64);
        assert!(first
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));

        // It really is the fingerprint of the stored key's public half.
        let priv_bytes = load_device_keypair_in(&store, "host-a").unwrap().unwrap();
        let priv32: [u8; 32] = priv_bytes.as_slice().try_into().unwrap();
        assert_eq!(first, fingerprint(&derive_public(&priv32)));

        // A different host id derives a different device fingerprint.
        let other = device_fingerprint_in(&store, "host-b").unwrap();
        assert_ne!(first, other);
    }

    #[tokio::test]
    async fn pair_saves_device_key_pins_server_and_returns_fingerprint() {
        let server = generate_static_keypair().unwrap();
        let store = MemoryKeyStore::new();
        let store_task = store.clone();
        let (mut client, c2s, s2c) = duplex();
        let k = psk::derive("011B23456789").unwrap();

        let client_task = tokio::spawn(async move {
            pair_with(&store_task, "host-a", &mut client, "011B-2345-6789").await
        });

        let mut r = PairingResponder::new(&server.private, &k).unwrap();
        let mut rb = [0u8; 65535];
        let mut buf = [0u8; 65535];
        let m = pop(&c2s).await;
        r.read_message(&m, &mut rb).unwrap();
        let n = r.write_message(&[], &mut buf).unwrap();
        s2c.lock().unwrap().push_back(buf[..n].to_vec());
        let m = pop(&c2s).await;
        r.read_message(&m, &mut rb).unwrap();
        // The host confirmed: send the plaintext `{ok}` verdict pair_with waits for.
        s2c.lock().unwrap().push_back(br#"{"ok":true}"#.to_vec());

        let fp = client_task.await.unwrap().unwrap();
        assert_eq!(fp, fingerprint(&server.public));
        assert!(load_device_keypair_in(&store, "host-a").unwrap().is_some());
        assert_eq!(
            load_pinned_server_key_in(&store, "host-a")
                .unwrap()
                .unwrap(),
            server.public
        );
    }

    #[tokio::test]
    async fn pair_reuses_an_existing_device_keypair() {
        let server = generate_static_keypair().unwrap();
        let device = generate_static_keypair().unwrap();
        let store = MemoryKeyStore::new();
        save_device_keypair_in(&store, "host-a", &device.private).unwrap();
        let store_task = store.clone();
        let (mut client, c2s, s2c) = duplex();
        let k = psk::derive("011B23456789").unwrap();

        let client_task = tokio::spawn(async move {
            pair_with(&store_task, "host-a", &mut client, "011B-2345-6789").await
        });

        let mut r = PairingResponder::new(&server.private, &k).unwrap();
        let mut rb = [0u8; 65535];
        let mut buf = [0u8; 65535];
        let m = pop(&c2s).await;
        r.read_message(&m, &mut rb).unwrap();
        let n = r.write_message(&[], &mut buf).unwrap();
        s2c.lock().unwrap().push_back(buf[..n].to_vec());
        let m = pop(&c2s).await;
        r.read_message(&m, &mut rb).unwrap();
        // The host confirmed: send the plaintext `{ok}` verdict pair_with waits for.
        s2c.lock().unwrap().push_back(br#"{"ok":true}"#.to_vec());

        client_task.await.unwrap().unwrap();
        assert_eq!(r.remote_static().unwrap(), device.public);
        assert_eq!(
            load_device_keypair_in(&store, "host-a").unwrap().unwrap(),
            device.private
        );
    }

    #[tokio::test]
    async fn reconnect_completes_with_stored_keys() {
        let server = generate_static_keypair().unwrap();
        let device = generate_static_keypair().unwrap();
        let store = MemoryKeyStore::new();
        save_device_keypair_in(&store, "host-a", &device.private).unwrap();
        save_pinned_server_key_in(&store, "host-a", &server.public).unwrap();
        let store_task = store.clone();
        let (mut client, c2s, s2c) = duplex();

        let client_task =
            tokio::spawn(async move { reconnect_with(&store_task, "host-a", &mut client).await });

        let mut r = ReconnectResponder::new(&server.private).unwrap();
        let mut rb = [0u8; 65535];
        let mut buf = [0u8; 65535];
        let m = pop(&c2s).await;
        r.read_message(&m, &mut rb).unwrap();
        let n = r.write_message(&[], &mut buf).unwrap();
        s2c.lock().unwrap().push_back(buf[..n].to_vec());

        client_task.await.unwrap().unwrap();
        assert_eq!(r.remote_static().unwrap(), device.public);
    }

    #[tokio::test]
    async fn reconnect_errors_when_keys_are_missing() {
        let store = MemoryKeyStore::new();
        let (mut client, _, _) = duplex();
        let err = reconnect_with(&store, "host-a", &mut client)
            .await
            .expect_err("missing keys");
        assert!(
            err.contains("missing"),
            "expected a missing-key error, got {err}"
        );
    }
}

/// Live end-to-end test for the desktop Noise transport: pairs against a REAL
/// running tether server, reconnects, and streams a shell command over the
/// sealed channel using the same codec + NoiseWs the Tauri pump uses. Skipped
/// unless TETHER_E2E_URL + TETHER_E2E_CODE are set (a fresh `tether pair` code
/// with the host auto-confirming). Mirrors the iOS Stage-1 live E2E.
#[cfg(test)]
mod live_e2e {
    use crate::noise_session::{
        decode_server, encode_devices_list, encode_devices_revoke, encode_input, encode_start,
        ServerMsg,
    };
    use crate::noise_store::{load_device_keypair_in, load_pinned_server_key_in, MemoryKeyStore};
    use crate::noise_ws::NoiseWs;
    use std::time::Duration;
    use tether_core::noise::driver::{client_reconnect, Transport};

    use super::pair_with;

    #[tokio::test]
    async fn live_pair_reconnect_stream_shell() {
        let (base, code) = match (
            std::env::var("TETHER_E2E_URL"),
            std::env::var("TETHER_E2E_CODE"),
        ) {
            (Ok(b), Ok(c)) => (b, c),
            _ => {
                eprintln!(
                    "skip live_pair_reconnect_stream_shell: set TETHER_E2E_URL + TETHER_E2E_CODE"
                );
                return;
            }
        };
        let ws = base
            .replacen("https://", "wss://", 1)
            .replacen("http://", "ws://", 1);
        let store = MemoryKeyStore::new();
        let host_id = "desktop-e2e";

        // Pair (XXpsk2). The host auto-confirms out of band.
        let mut wp = NoiseWs::connect(&format!("{ws}/api/noise/pair"))
            .await
            .expect("pair connect");
        pair_with(&store, host_id, &mut wp, &code)
            .await
            .expect("pair");
        let device_priv = load_device_keypair_in(&store, host_id).unwrap().unwrap();
        let server_pub = load_pinned_server_key_in(&store, host_id).unwrap().unwrap();

        // Enrollment lands just after the host confirms — retry the reconnect a
        // few times so the test isn't racing the auto-confirm.
        let mut saw = false;
        'attempts: for _ in 0..10 {
            let mut sock = match NoiseWs::connect(&format!("{ws}/api/noise/session")).await {
                Ok(s) => s,
                Err(_) => {
                    tokio::time::sleep(Duration::from_millis(300)).await;
                    continue;
                }
            };
            let mut session = match client_reconnect(&mut sock, &device_priv, &server_pub).await {
                Ok(s) => s,
                Err(_) => {
                    tokio::time::sleep(Duration::from_millis(300)).await;
                    continue;
                }
            };
            // start + input over the sealed channel.
            sock.send(session.seal(&encode_start("d1", 80, 24)).unwrap())
                .await
                .unwrap();
            tokio::time::sleep(Duration::from_millis(400)).await;
            sock.send(
                session
                    .seal(&encode_input("d1", "echo desktop-e2e-marker\n"))
                    .unwrap(),
            )
            .await
            .unwrap();

            for _ in 0..60 {
                let frame = match tokio::time::timeout(Duration::from_secs(3), sock.recv()).await {
                    Ok(Ok(f)) => f,
                    _ => break,
                };
                let plaintext = match session.open(&frame) {
                    Ok(p) => p,
                    Err(_) => break,
                };
                if let Ok(ServerMsg::Output { chunk }) = decode_server(&plaintext) {
                    if chunk.contains("desktop-e2e-marker") {
                        saw = true;
                        break 'attempts;
                    }
                }
            }
        }
        assert!(saw, "never saw shell output over the desktop Noise session");
    }

    /// Live device-management E2E: pair, list devices over the authenticated Noise
    /// session (this device shows with is_self), revoke it, and prove the revoke
    /// took effect — a fresh session can no longer carry app data (fail-closed).
    #[tokio::test]
    async fn live_devices_list_and_self_revoke() {
        let (base, code) = match (
            std::env::var("TETHER_E2E_URL"),
            std::env::var("TETHER_E2E_CODE"),
        ) {
            (Ok(b), Ok(c)) => (b, c),
            _ => {
                eprintln!(
                    "skip live_devices_list_and_self_revoke: set TETHER_E2E_URL + TETHER_E2E_CODE"
                );
                return;
            }
        };
        let ws = base
            .replacen("https://", "wss://", 1)
            .replacen("http://", "ws://", 1);
        let store = MemoryKeyStore::new();
        let host_id = "desktop-dev-e2e";

        let mut wp = NoiseWs::connect(&format!("{ws}/api/noise/pair"))
            .await
            .expect("pair connect");
        pair_with(&store, host_id, &mut wp, &code)
            .await
            .expect("pair");
        let device_priv = load_device_keypair_in(&store, host_id).unwrap().unwrap();
        let server_pub = load_pinned_server_key_in(&store, host_id).unwrap().unwrap();

        // devices.list — find THIS device (is_self).
        let mut self_id = None;
        {
            let mut sock = NoiseWs::connect(&format!("{ws}/api/noise/session"))
                .await
                .expect("list session");
            let mut session = client_reconnect(&mut sock, &device_priv, &server_pub)
                .await
                .expect("list reconnect");
            sock.send(session.seal(&encode_devices_list()).unwrap())
                .await
                .unwrap();
            for _ in 0..30 {
                let frame = match tokio::time::timeout(Duration::from_secs(3), sock.recv()).await {
                    Ok(Ok(f)) => f,
                    _ => break,
                };
                if let Ok(ServerMsg::Devices(items)) = decode_server(&session.open(&frame).unwrap())
                {
                    self_id = items.into_iter().find(|d| d.is_self).map(|d| d.id);
                    break;
                }
            }
        }
        let self_id = self_id.expect("devices.list should include this device with is_self");

        // devices.revoke self — server acks ok.
        {
            let mut sock = NoiseWs::connect(&format!("{ws}/api/noise/session"))
                .await
                .expect("revoke session");
            let mut session = client_reconnect(&mut sock, &device_priv, &server_pub)
                .await
                .expect("revoke reconnect");
            sock.send(session.seal(&encode_devices_revoke(&self_id)).unwrap())
                .await
                .unwrap();
            let mut ok = false;
            for _ in 0..30 {
                let frame = match tokio::time::timeout(Duration::from_secs(3), sock.recv()).await {
                    Ok(Ok(f)) => f,
                    _ => break,
                };
                if let Ok(ServerMsg::DevicesRevoked { target, ok: v, .. }) =
                    decode_server(&session.open(&frame).unwrap())
                {
                    if target == self_id {
                        ok = v;
                        break;
                    }
                }
            }
            assert!(ok, "server should ack the self-revoke ok");
        }

        // Fail-closed: a fresh session can no longer carry app data. Every path
        // below assigns, so no dead initializer (clippy `unused_assignments`).
        let fail_closed;
        if let Ok(mut sock) = NoiseWs::connect(&format!("{ws}/api/noise/session")).await {
            match client_reconnect(&mut sock, &device_priv, &server_pub).await {
                Err(_) => fail_closed = true,
                Ok(mut session) => {
                    let sealed = session.seal(&encode_devices_list()).unwrap();
                    if sock.send(sealed).await.is_err() {
                        fail_closed = true;
                    } else {
                        match tokio::time::timeout(Duration::from_secs(4), sock.recv()).await {
                            Ok(Ok(frame)) => fail_closed = session.open(&frame).is_err(),
                            _ => fail_closed = true,
                        }
                    }
                }
            }
        } else {
            fail_closed = true;
        }
        assert!(
            fail_closed,
            "a revoked device must not be able to use a Noise session"
        );
    }
}
