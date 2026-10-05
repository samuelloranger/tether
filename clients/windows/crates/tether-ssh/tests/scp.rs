mod support;

use support::server::{Options, start};
use tether_core::connect::{ConnectError, Connection, Credential, Transport};
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

#[tokio::test]
async fn sends_bytes_to_the_quoted_path() {
    let (server, conn) = signed_in().await;
    conn.scp_send(
        "/home/me/.tether/uploads/paste-1791082819.png",
        b"\x89PNG data",
    )
    .await
    .unwrap();
    let state = server.state.lock().unwrap();
    assert_eq!(
        state.execs.last().unwrap(),
        "scp -t '/home/me/.tether/uploads/paste-1791082819.png'"
    );
    assert_eq!(
        state.uploads["/home/me/.tether/uploads/paste-1791082819.png"],
        b"\x89PNG data"
    );
}

#[tokio::test]
async fn a_path_with_spaces_and_quotes_arrives_intact() {
    let (server, conn) = signed_in().await;
    let path = "/home/me/.tether/uploads/it's a photo.jpg";
    conn.scp_send(path, b"jpeg").await.unwrap();
    assert_eq!(server.state.lock().unwrap().uploads[path], b"jpeg");
}

#[tokio::test]
async fn a_multi_megabyte_file_is_sent_whole() {
    let (server, conn) = signed_in().await;
    let body: Vec<u8> = (0..5 * 1024 * 1024).map(|i| (i % 251) as u8).collect();
    conn.scp_send("/tmp/big.bin", &body).await.unwrap();
    assert_eq!(server.state.lock().unwrap().uploads["/tmp/big.bin"], body);
}

#[tokio::test]
async fn a_refusal_carries_the_hosts_message() {
    let (_server, conn) = signed_in().await;
    let err = conn.scp_send("/refuse/x.png", b"x").await.err().unwrap();
    assert_eq!(
        err,
        ConnectError::Transport("scp: /refuse: Permission denied".into())
    );
}

#[tokio::test]
async fn a_bare_filename_is_sent_as_given() {
    let (server, conn) = signed_in().await;
    conn.scp_send("photo.jpg", b"j").await.unwrap();
    assert_eq!(
        server.state.lock().unwrap().execs.last().unwrap(),
        "scp -t 'photo.jpg'"
    );
}
