mod support;

use std::time::{Duration, Instant};

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
async fn exec_returns_stdout_and_drops_stderr() {
    let (_server, conn) = signed_in().await;
    assert_eq!(
        conn.exec("tether-echo hello there").await.unwrap(),
        "hello there\n"
    );
}

#[tokio::test]
async fn a_nonzero_exit_is_an_error_not_empty_output() {
    let (_server, conn) = signed_in().await;
    let err = conn.exec("tether-fail").await.unwrap_err();
    assert!(matches!(err, ConnectError::Transport(m) if m.contains("status 3")));
}

#[tokio::test]
async fn a_channel_that_closes_without_an_exit_status_is_an_error() {
    let (_server, conn) = signed_in().await;
    let err = conn.exec("tether-drop").await.unwrap_err();
    assert!(matches!(err, ConnectError::Transport(_)));
}

#[tokio::test]
async fn concurrent_execs_on_one_connection_do_not_mix() {
    let (_server, conn) = signed_in().await;
    let (a, b) = tokio::join!(conn.exec("tether-echo a"), conn.exec("tether-echo b"));
    assert_eq!(a.unwrap(), "a\n");
    assert_eq!(b.unwrap(), "b\n");
}

#[tokio::test]
async fn an_exec_that_never_closes_times_out() {
    let (_server, conn) = signed_in().await;
    let started = Instant::now();
    let err = conn.exec("tether-hang").await.unwrap_err();
    assert_eq!(err, ConnectError::Timeout);
    let elapsed = started.elapsed();
    assert!(elapsed >= Duration::from_secs(14), "{elapsed:?}");
    assert!(elapsed < Duration::from_secs(20), "{elapsed:?}");
}

#[cfg(unix)]
#[tokio::test]
async fn hostile_names_reach_zmx_as_one_argument() {
    let (server, conn) = signed_in().await;
    let bin = server.home.path().join(".local/bin");
    std::fs::create_dir_all(&bin).unwrap();
    let zmx = bin.join("zmx");
    std::fs::write(&zmx, "#!/bin/sh\nprintf '<%s>\\n' \"$@\"\n").unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&zmx, std::fs::Permissions::from_mode(0o755)).unwrap();

    for name in [
        "it's",
        "a b",
        "$(touch pwned)",
        "`touch pwned`",
        ";touch pwned",
        "ünï",
    ] {
        let out = conn
            .exec(&tether_core::zmx::kill_command(name).unwrap())
            .await
            .unwrap();
        assert_eq!(
            out,
            format!("<kill>\n<{name}>\n<--force>\n"),
            "name {name:?}"
        );
    }
    assert!(!server.home.path().join("pwned").exists());
    assert!(!std::path::Path::new("pwned").exists());
}
