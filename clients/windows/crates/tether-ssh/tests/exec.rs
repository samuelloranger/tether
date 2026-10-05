mod support;

use support::server::{Options, start};
use tether_core::connect::{Connection, Credential, Transport};
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
async fn exec_returns_stdout_and_drops_stderr_even_on_nonzero_exit() {
    let (_server, conn) = signed_in().await;
    assert_eq!(
        conn.exec("tether-echo hello there").await.unwrap(),
        "hello there\n"
    );
}

#[tokio::test]
async fn concurrent_execs_on_one_connection_do_not_mix() {
    let (_server, conn) = signed_in().await;
    let (a, b) = tokio::join!(conn.exec("tether-echo a"), conn.exec("tether-echo b"));
    assert_eq!(a.unwrap(), "a\n");
    assert_eq!(b.unwrap(), "b\n");
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
        "--force",
    ] {
        let out = conn
            .exec(&tether_core::zmx::kill_command(name))
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
