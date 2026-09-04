use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};
use tether_core::noise::driver::{client_pair, client_reconnect, Transport};
use tether_core::noise::pairing::generate_static_keypair;
use tether_core::noise::{code, psk};
use tokio::sync::mpsc;

use crate::noise_session::{
    decode_server, encode_frontend_output, encode_start, translate_frontend, ServerMsg,
};
use crate::noise_store::{
    load_device_keypair_in, load_pinned_server_key_in, save_device_keypair_in,
    save_pinned_server_key_in, KeyStore, KeyringKeyStore,
};
use crate::noise_ws::NoiseWs;
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
    save_pinned_server_key_in(store, host_id, &server_pub).map_err(|e| e.to_string())?;
    Ok(fingerprint(&server_pub))
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
/// TODO: unlike the password path (`core_connect`), a dropped socket is NOT
/// reconnected with backoff/replay — the pump just ends and emits close. The
/// frontend can re-issue `core_noise_connect`, which replays the tail via
/// `start`. Wire full reconnect later if the UX needs it.
/// TODO: server→client `title`/`activity`/`diff`/`reset` WS message types do not
/// flow over Noise yet — only `output`/`exit` are translated.
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
    let (mut tx, mut rx) = ws.into_split();
    let mut session = session;

    tauri::async_runtime::spawn(async move {
        let state = app.state::<SharedState>();
        let mut counter: u64 = 0;

        // Open the remote session by replaying the whole tail from the cursor.
        match session.seal(&encode_start(&session_id, cols, rows)) {
            Ok(wire) => {
                if tx.send(wire).await.is_err() {
                    finish(&state, &app, &conn_id, &close_evt);
                    return;
                }
            }
            Err(_) => {
                finish(&state, &app, &conn_id, &close_evt);
                return;
            }
        }

        loop {
            tokio::select! {
                inbound = rx.recv() => {
                    let wire = match inbound {
                        Ok(wire) => wire,
                        Err(_) => break, // socket closed / errored
                    };
                    let plain = match session.open(&wire) {
                        Ok(plain) => plain,
                        Err(_) => break, // decrypt failure ends the session
                    };
                    match decode_server(&plain) {
                        Ok(ServerMsg::Output { chunk }) => {
                            counter += 1;
                            let _ = app.emit(&msg_evt, encode_frontend_output(counter, &chunk));
                        }
                        Ok(ServerMsg::Exit { .. }) => break,
                        Ok(ServerMsg::Other) => {} // devices.* etc. — ignore
                        Err(_) => break, // undecodable plaintext
                    }
                }
                maybe = out_rx.recv() => {
                    let ws_json = match maybe {
                        Some(text) => text,
                        None => break, // handle dropped by core_noise_close
                    };
                    if let Some(plain) = translate_frontend(&session_id, &ws_json) {
                        match session.seal(&plain) {
                            Ok(wire) => {
                                if tx.send(wire).await.is_err() {
                                    break; // socket send failed
                                }
                            }
                            Err(_) => break, // seal failure desyncs the cipher
                        }
                    }
                }
            }
        }

        finish(&state, &app, &conn_id, &close_evt);
    });

    Ok(())
}

/// Remove the per-conn handle and emit the frontend close event. The cancel flag
/// (set by `core_noise_close`) is advisory today — dropping the outgoing sender
/// is what actually unblocks the pump — but is kept for parity with the password
/// path and for a future reconnect loop.
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
