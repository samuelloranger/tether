mod support;

use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};
use support::server::{Options, start};
use tether_core::connect::{ConnectError, Connection, Transport};

#[tokio::test]
async fn dial_captures_the_host_key_blob_digest() {
    let server = start(Options::default()).await;
    let conn = support::transport()
        .dial("127.0.0.1", server.addr.port(), support::TIMEOUT)
        .await
        .unwrap();
    let expected: [u8; 32] = Sha256::digest(server.host_public.to_bytes().unwrap()).into();
    assert_eq!(conn.host_key_sha256(), expected);
    assert_eq!(
        server.state.lock().unwrap().auth_attempts,
        0,
        "dial must not authenticate"
    );
}

#[tokio::test]
async fn a_listener_that_never_speaks_times_out() {
    let silent = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = silent.local_addr().unwrap().port();
    let _keep = tokio::spawn(async move {
        let mut held = Vec::new();
        while let Ok((s, _)) = silent.accept().await {
            held.push(s);
        }
    });
    let started = Instant::now();
    let err = support::transport()
        .dial("127.0.0.1", port, Duration::from_millis(300))
        .await
        .err()
        .unwrap();
    assert_eq!(err, ConnectError::Timeout);
    assert!(started.elapsed() < Duration::from_secs(2));
}

#[tokio::test]
async fn a_closed_port_is_a_transport_error() {
    let port = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };
    let err = support::transport()
        .dial("127.0.0.1", port, support::TIMEOUT)
        .await
        .err()
        .unwrap();
    assert!(matches!(err, ConnectError::Transport(_)), "{err:?}");
}

#[tokio::test]
async fn dial_accepts_a_bracketed_ipv6_literal() {
    if tokio::net::TcpListener::bind("[::1]:0").await.is_err() {
        eprintln!("skip: no IPv6 loopback");
        return;
    }
    let server = start(Options {
        listen: Some("::1".into()),
        ..Default::default()
    })
    .await;
    let conn = support::transport()
        .dial("[::1]", server.addr.port(), support::TIMEOUT)
        .await
        .unwrap();
    let expected: [u8; 32] = Sha256::digest(server.host_public.to_bytes().unwrap()).into();
    assert_eq!(conn.host_key_sha256(), expected);
}
