mod support;

use std::time::Duration;

use support::proxy::Proxy;
use support::server::{Options, start};
use tether_core::connect::{Connection, Credential, Transport};
use tether_ssh::ConnectionEvent;
use zeroize::Zeroizing;

const EVERY: Duration = Duration::from_millis(150);

async fn through_proxy() -> (support::server::Running, Proxy, tether_ssh::RusshConnection) {
    let server = start(Options {
        password: Some(("tester".into(), "hunter2".into())),
        ..Default::default()
    })
    .await;
    let proxy = Proxy::start(server.addr).await;
    let mut conn = support::transport()
        .dial("127.0.0.1", proxy.addr.port(), support::TIMEOUT)
        .await
        .unwrap();
    conn.authenticate(
        "tester",
        Credential::Password(Zeroizing::new("hunter2".into())),
    )
    .await
    .unwrap();
    (server, proxy, conn)
}

#[tokio::test]
async fn a_healthy_link_never_drops() {
    let (_s, _p, mut conn) = through_proxy().await;
    let mut events = conn.events();
    conn.start_keepalive(EVERY);
    let got = tokio::time::timeout(EVERY * 8, events.recv()).await;
    assert!(got.is_err(), "unexpected event {got:?}");
}

#[tokio::test]
async fn two_missed_pings_drop_the_link() {
    let (_s, proxy, mut conn) = through_proxy().await;
    let mut events = conn.events();
    conn.start_keepalive(EVERY);
    proxy.freeze();
    let got = tokio::time::timeout(EVERY * 6, events.recv())
        .await
        .expect("no drop within 6 intervals");
    assert_eq!(got.unwrap(), ConnectionEvent::Dropped);
}

#[tokio::test]
async fn a_killed_socket_drops_without_keepalive() {
    let (_s, proxy, conn) = through_proxy().await;
    let mut events = conn.events();
    proxy.kill();
    let got = tokio::time::timeout(Duration::from_secs(3), events.recv())
        .await
        .expect("no drop after RST");
    assert_eq!(got.unwrap(), ConnectionEvent::Dropped);
    assert!(conn.is_closed());
}

#[tokio::test]
async fn an_intentional_close_is_not_reported_as_a_drop() {
    let (_s, _p, conn) = through_proxy().await;
    let mut events = conn.events();
    conn.close().await;
    let got = tokio::time::timeout(Duration::from_millis(800), events.recv()).await;
    assert!(got.is_err(), "unexpected {got:?}");
}

#[tokio::test]
async fn dropped_fires_once() {
    let (_s, proxy, mut conn) = through_proxy().await;
    let mut events = conn.events();
    conn.start_keepalive(EVERY);
    proxy.kill();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(3), events.recv())
            .await
            .unwrap()
            .unwrap(),
        ConnectionEvent::Dropped
    );
    assert!(
        tokio::time::timeout(EVERY * 4, events.recv())
            .await
            .is_err()
    );
}
