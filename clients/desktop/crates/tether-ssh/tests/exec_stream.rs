mod support;

use support::server::{Options, start};
use tether_core::connect::{Connection, Credential, Transport};
use tether_ssh::ExecEvent;
use tokio::sync::mpsc::Receiver;
use zeroize::Zeroizing;

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

async fn collect(events: &mut Receiver<ExecEvent>) -> Vec<ExecEvent> {
    let mut out = Vec::new();
    while let Ok(Some(event)) =
        tokio::time::timeout(std::time::Duration::from_secs(5), events.recv()).await
    {
        let closed = event == ExecEvent::Closed;
        out.push(event);
        if closed {
            break;
        }
    }
    out
}

fn stdout(events: &[ExecEvent]) -> String {
    events
        .iter()
        .filter_map(|e| match e {
            ExecEvent::Data(bytes) => Some(String::from_utf8_lossy(bytes).into_owned()),
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn output_exit_status_and_close_arrive_in_order() {
    let (_server, conn) = signed_in().await;
    let mut channel = conn.open_exec("tether-echo hi").await.unwrap();
    let events = collect(&mut channel.events).await;
    assert_eq!(stdout(&events), "hi\n");
    let tail: Vec<_> = events
        .iter()
        .filter(|e| !matches!(e, ExecEvent::Data(_)))
        .collect();
    assert_eq!(tail, [&ExecEvent::Exit(0), &ExecEvent::Closed]);
}

#[tokio::test]
async fn a_failing_command_keeps_its_output() {
    let (_server, conn) = signed_in().await;
    let mut channel = conn.open_exec("tether-fail").await.unwrap();
    let events = collect(&mut channel.events).await;
    assert_eq!(stdout(&events), "partial\n");
    assert!(events.contains(&ExecEvent::Exit(3)));
}

#[tokio::test]
async fn stdin_reaches_a_running_command_and_its_replies_stream_back() {
    let (server, conn) = signed_in().await;
    let mut channel = conn.open_exec("tether-hang").await.unwrap();
    channel.writer.write(b"{\"id\":1}\n").await.unwrap();
    let mut seen = String::new();
    while !seen.contains("{\"id\":1}") {
        match tokio::time::timeout(std::time::Duration::from_secs(5), channel.events.recv()).await {
            Ok(Some(ExecEvent::Data(bytes))) => seen.push_str(&String::from_utf8_lossy(&bytes)),
            other => panic!("{other:?}"),
        }
    }
    assert!(
        server
            .state
            .lock()
            .unwrap()
            .execs
            .contains(&"tether-hang".to_string())
    );
}

#[tokio::test]
async fn close_ends_the_stream_and_later_writes_fail() {
    let (_server, conn) = signed_in().await;
    let mut channel = conn.open_exec("tether-hang").await.unwrap();
    channel.writer.close().await;
    assert_eq!(
        collect(&mut channel.events).await.last(),
        Some(&ExecEvent::Closed)
    );
    assert!(channel.writer.write(b"x").await.is_err());
}
