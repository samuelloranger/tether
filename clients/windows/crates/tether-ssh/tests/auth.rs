mod support;

use russh::keys::{
    PrivateKey,
    ssh_key::{Algorithm, LineEnding},
};
use support::server::{Options, start};
use tether_core::connect::{ConnectError, Connection, Credential, Transport};
use zeroize::Zeroizing;

async fn dial(port: u16) -> tether_ssh::RusshConnection {
    support::transport()
        .dial("127.0.0.1", port, support::TIMEOUT)
        .await
        .unwrap()
}

#[tokio::test]
async fn password_accepted() {
    let server = start(Options {
        password: Some(("tester".into(), "hunter2".into())),
        ..Default::default()
    })
    .await;
    let mut conn = dial(server.addr.port()).await;
    conn.authenticate(
        "tester",
        Credential::Password(Zeroizing::new("hunter2".into())),
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn wrong_password_is_auth_rejected() {
    let server = start(Options {
        password: Some(("tester".into(), "hunter2".into())),
        ..Default::default()
    })
    .await;
    let mut conn = dial(server.addr.port()).await;
    let err = conn
        .authenticate(
            "tester",
            Credential::Password(Zeroizing::new("nope".into())),
        )
        .await
        .err()
        .unwrap();
    assert_eq!(err, ConnectError::AuthRejected);
}

#[tokio::test]
async fn generated_ed25519_pkcs8_key_signs_in() {
    let (record, pem) = tether_core::keys::generate_ed25519("laptop", 0);
    let public = russh::keys::PublicKey::from_openssh(&record.public_line).unwrap();
    let server = start(Options {
        allowed_keys: vec![public],
        ..Default::default()
    })
    .await;
    let mut conn = dial(server.addr.port()).await;
    conn.authenticate("tester", Credential::Key(pem))
        .await
        .unwrap();
}

#[tokio::test]
async fn openssh_format_key_signs_in() {
    let key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
    let pem = Zeroizing::new(key.to_openssh(LineEnding::LF).unwrap().to_string());
    let server = start(Options {
        allowed_keys: vec![key.public_key().clone()],
        ..Default::default()
    })
    .await;
    let mut conn = dial(server.addr.port()).await;
    conn.authenticate("tester", Credential::Key(pem))
        .await
        .unwrap();
}

#[tokio::test]
async fn rsa_key_signs_in_with_sha2() {
    let key = PrivateKey::random(&mut rand::rng(), Algorithm::Rsa { hash: None }).unwrap();
    let pem = Zeroizing::new(key.to_openssh(LineEnding::LF).unwrap().to_string());
    let server = start(Options {
        allowed_keys: vec![key.public_key().clone()],
        ..Default::default()
    })
    .await;
    let mut conn = dial(server.addr.port()).await;
    conn.authenticate("tester", Credential::Key(pem))
        .await
        .unwrap();
}

#[tokio::test]
async fn unknown_key_is_auth_rejected() {
    let key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
    let pem = Zeroizing::new(key.to_openssh(LineEnding::LF).unwrap().to_string());
    let server = start(Options::default()).await;
    let mut conn = dial(server.addr.port()).await;
    let err = conn
        .authenticate("tester", Credential::Key(pem))
        .await
        .err()
        .unwrap();
    assert_eq!(err, ConnectError::AuthRejected);
}

#[tokio::test]
async fn garbage_key_is_a_transport_error_not_a_panic() {
    let server = start(Options::default()).await;
    let mut conn = dial(server.addr.port()).await;
    let err = conn
        .authenticate(
            "tester",
            Credential::Key(Zeroizing::new(
                "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n".into(),
            )),
        )
        .await
        .err()
        .unwrap();
    assert!(matches!(err, ConnectError::Transport(_)), "{err:?}");
}
