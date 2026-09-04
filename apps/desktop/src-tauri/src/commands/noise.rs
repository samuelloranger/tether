use sha2::{Digest, Sha256};
use tether_core::noise::driver::{client_pair, client_reconnect, Transport};
use tether_core::noise::pairing::generate_static_keypair;
use tether_core::noise::{code, psk};

use crate::noise_store::{
    load_device_keypair_in, load_pinned_server_key_in, save_device_keypair_in,
    save_pinned_server_key_in, KeyStore, KeyringKeyStore,
};
use crate::noise_ws::NoiseWs;

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
