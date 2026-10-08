mod support;

use std::time::Duration;

use support::server::{Options, start};
use tether_core::connect::{Connection, Credential, Transport};
use tether_core::resize::GridSize;
use tether_ssh::PtyEvent;
use tokio::sync::mpsc::Receiver;
use zeroize::Zeroizing;

const SIZE: GridSize = GridSize {
    cols: 120,
    rows: 40,
    width_px: 960,
    height_px: 640,
};

async fn signed_in() -> (support::server::Running, tether_ssh::RusshConnection) {
    let server = start(Options {
        password: Some(("tester".into(), "hunter2".into())),
        ..Default::default()
    })
    .await;
    let mut conn = support::transport()
        .dial("127.0.0.1", server.addr.port(), support::TIMEOUT)
        .await
        .unwrap();
    conn.authenticate(
        "tester",
        Credential::Password(Zeroizing::new("hunter2".into())),
    )
    .await
    .unwrap();
    (server, conn)
}

async fn read_until(events: &mut Receiver<PtyEvent>, needle: &str) -> String {
    let mut seen = String::new();
    tokio::time::timeout(Duration::from_secs(5), async {
        while !seen.contains(needle) {
            match events.recv().await {
                Some(PtyEvent::Data(d)) => seen.push_str(&String::from_utf8_lossy(&d)),
                other => panic!("unexpected {other:?} after {seen:?}"),
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("never saw {needle:?}; got {seen:?}"));
    seen
}

#[tokio::test]
async fn pty_is_requested_at_the_grid_size_then_the_size_is_pushed() {
    let (server, conn) = signed_in().await;
    let mut pty = conn.open_pty(SIZE).await.unwrap();
    read_until(&mut pty.events, "ready 0").await;
    let state = server.state.lock().unwrap();
    assert_eq!(state.ptys, vec![(120, 40)]);
    assert_eq!(state.window_changes, vec![(120, 40)]);
}

#[tokio::test]
async fn two_channels_on_one_connection_keep_their_own_data() {
    let (_server, conn) = signed_in().await;
    let mut a = conn.open_pty(SIZE).await.unwrap();
    let mut b = conn.open_pty(SIZE).await.unwrap();
    read_until(&mut a.events, "ready 0").await;
    read_until(&mut b.events, "ready 1").await;
    a.writer.write(b"alpha").await;
    b.writer.write(b"beta").await;
    assert!(
        read_until(&mut a.events, "<0>alpha")
            .await
            .contains("<0>alpha")
    );
    let got_b = read_until(&mut b.events, "<1>beta").await;
    assert!(!got_b.contains("alpha"));
}

#[tokio::test]
async fn resize_sends_a_window_change() {
    let (server, conn) = signed_in().await;
    let mut pty = conn.open_pty(SIZE).await.unwrap();
    read_until(&mut pty.events, "ready").await;
    pty.writer
        .resize(GridSize {
            cols: 100,
            rows: 30,
            width_px: 800,
            height_px: 480,
        })
        .await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(
        server.state.lock().unwrap().window_changes.last(),
        Some(&(100, 30))
    );
}

#[tokio::test]
async fn close_ends_the_event_stream_with_closed() {
    let (_server, conn) = signed_in().await;
    let mut pty = conn.open_pty(SIZE).await.unwrap();
    read_until(&mut pty.events, "ready").await;
    pty.writer.close().await;
    let last = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match pty.events.recv().await {
                Some(PtyEvent::Data(_)) => continue,
                other => return other,
            }
        }
    })
    .await
    .unwrap();
    assert!(matches!(last, Some(PtyEvent::Closed) | None));
}

#[tokio::test]
async fn slow_reader_does_not_stall_other_channel() {
    let (_server, conn) = signed_in().await;
    let idle = conn.open_pty(SIZE).await.unwrap();
    let mut busy = conn.open_pty(SIZE).await.unwrap();
    for _ in 0..200 {
        idle.writer.write(&[b'x'; 512]).await;
    }
    busy.writer.write(b"still-alive").await;
    read_until(&mut busy.events, "still-alive").await;
    drop(idle);
}

#[tokio::test]
async fn an_unread_burst_arrives_in_order() {
    let (_server, conn) = signed_in().await;
    let mut pty = conn.open_pty(SIZE).await.unwrap();
    read_until(&mut pty.events, "ready").await;
    pty.writer.write(b"flood").await;
    tokio::time::sleep(Duration::from_millis(200)).await;

    const TOTAL: usize = 5 * 1024 * 1024;
    let mut got = Vec::with_capacity(TOTAL);
    tokio::time::timeout(Duration::from_secs(30), async {
        while got.len() < TOTAL {
            match pty.events.recv().await {
                Some(PtyEvent::Data(d)) => got.extend_from_slice(&d),
                other => panic!("{other:?} after {} bytes", got.len()),
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("short read {}", got.len()));
    assert_eq!(got.len(), TOTAL);
    assert!(got.iter().enumerate().all(|(i, b)| *b == (i % 251) as u8));
}

#[tokio::test]
async fn a_cloned_writer_writes_to_the_same_channel() {
    let (_server, conn) = signed_in().await;
    let mut pty = conn.open_pty(SIZE).await.unwrap();
    read_until(&mut pty.events, "ready").await;
    let clone = pty.writer.clone();
    clone.write(b"via-clone").await;
    read_until(&mut pty.events, "<0>via-clone").await;
}
