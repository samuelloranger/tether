mod support;

use sha2::{Digest, Sha256};
use support::server::{Options, start};
use tether_core::connect::{ConnectError, ConnectRequest, connect};
use tether_core::hostkey::{HostKeyStore, MemoryHostKeys, hex_fingerprint};
use tether_core::profiles::{Auth, Machine};
use tether_core::secrets::{MemorySecretStore, SecretStore, password_account};
use uuid::Uuid;

fn machine(port: u16) -> Machine {
    Machine {
        id: Uuid::new_v4(),
        name: "devbox".into(),
        host: "127.0.0.1".into(),
        port,
        user: "tester".into(),
        auth: Auth::Password,
        jump: None,
    }
}

async fn password_server() -> support::server::Running {
    start(Options {
        password: Some(("tester".into(), "hunter2".into())),
        ..Default::default()
    })
    .await
}

#[tokio::test]
async fn first_connect_pins_the_hex_fingerprint() {
    let server = password_server().await;
    let m = machine(server.addr.port());
    let secrets = MemorySecretStore::default();
    secrets.set(&password_account(m.id), b"hunter2").unwrap();
    let pins = MemoryHostKeys::default();

    connect(
        &support::transport(),
        &ConnectRequest {
            machine: m.clone(),
            jumps: Vec::new(),
        },
        &pins,
        &secrets,
    )
    .await
    .unwrap();

    let digest: [u8; 32] = Sha256::digest(server.host_public.to_bytes().unwrap()).into();
    assert_eq!(
        pins.pinned("127.0.0.1", m.port),
        Some(hex_fingerprint(&digest))
    );
}

#[tokio::test]
async fn mismatch_is_refused_before_any_auth_packet() {
    let server = password_server().await;
    let m = machine(server.addr.port());
    let secrets = MemorySecretStore::default();
    secrets.set(&password_account(m.id), b"hunter2").unwrap();
    let pins = MemoryHostKeys::default();
    let wrong = hex_fingerprint(&[0xaa; 32]);
    pins.pin("127.0.0.1", m.port, &wrong).unwrap();

    let err = connect(
        &support::transport(),
        &ConnectRequest {
            machine: m.clone(),
            jumps: Vec::new(),
        },
        &pins,
        &secrets,
    )
    .await
    .err()
    .unwrap();

    assert!(
        matches!(err, ConnectError::HostKeyChanged { ref expected, .. } if *expected == wrong),
        "{err:?}"
    );
    assert_eq!(server.state.lock().unwrap().auth_attempts, 0);
    assert_eq!(
        pins.pinned("127.0.0.1", m.port),
        Some(wrong),
        "a mismatch never rewrites the pin"
    );
}

#[tokio::test]
async fn agent_forwarding_is_never_requested() {
    let server = password_server().await;
    let m = machine(server.addr.port());
    let secrets = MemorySecretStore::default();
    secrets.set(&password_account(m.id), b"hunter2").unwrap();
    let conn = connect(
        &support::transport(),
        &ConnectRequest {
            machine: m,
            jumps: Vec::new(),
        },
        &MemoryHostKeys::default(),
        &secrets,
    )
    .await
    .unwrap();
    let pty = conn
        .open_pty(tether_core::resize::GridSize {
            cols: 80,
            rows: 24,
            width_px: 640,
            height_px: 384,
        })
        .await
        .unwrap();
    drop(pty);
    assert_eq!(server.state.lock().unwrap().agent_forward_requests, 0);
}

#[tokio::test]
async fn a_jump_host_tunnels_to_the_target_and_both_keys_are_pinned() {
    let bastion = password_server().await;
    let target = password_server().await;
    let jump = machine(bastion.addr.port());
    let mut m = machine(target.addr.port());
    m.jump = Some(jump.id);
    let secrets = MemorySecretStore::default();
    secrets.set(&password_account(jump.id), b"hunter2").unwrap();
    secrets.set(&password_account(m.id), b"hunter2").unwrap();
    let pins = MemoryHostKeys::default();

    let conn = connect(
        &support::transport(),
        &ConnectRequest {
            machine: m.clone(),
            jumps: vec![jump.clone()],
        },
        &pins,
        &secrets,
    )
    .await
    .unwrap();

    assert_eq!(
        bastion.state.lock().unwrap().tunnels,
        [format!("127.0.0.1:{}", target.addr.port())]
    );
    let key = |s: &support::server::Running| -> [u8; 32] {
        Sha256::digest(s.host_public.to_bytes().unwrap()).into()
    };
    assert_eq!(
        pins.pinned("127.0.0.1", jump.port),
        Some(hex_fingerprint(&key(&bastion)))
    );
    assert_eq!(
        pins.pinned("127.0.0.1", m.port),
        Some(hex_fingerprint(&key(&target)))
    );
    use tether_core::connect::Connection;
    assert_eq!(conn.exec("tether-echo hi").await.unwrap().trim(), "hi");
}
