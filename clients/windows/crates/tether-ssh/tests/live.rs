mod support;

use std::time::Duration;

use tether_core::connect::{ConnectRequest, Connection, connect};
use tether_core::hostkey::MemoryHostKeys;
use tether_core::profiles::{Auth, Machine};
use tether_core::resize::GridSize;
use tether_core::secrets::{MemorySecretStore, SecretStore, key_account};
use tether_ssh::PtyEvent;
use uuid::Uuid;

fn live() -> bool {
    if std::env::var("TETHER_LIVE_SSH").as_deref() != Ok("1") {
        eprintln!("skipping live SSH test: set TETHER_LIVE_SSH=1");
        return false;
    }
    true
}

#[tokio::test]
async fn live_host_lists_sessions_and_opens_a_shell() {
    if !live() {
        return;
    }
    let host = std::env::var("TETHER_LIVE_HOST").expect("TETHER_LIVE_HOST");
    let port = std::env::var("TETHER_LIVE_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(22);
    let user = std::env::var("TETHER_LIVE_USER").expect("TETHER_LIVE_USER");
    let secrets = MemorySecretStore::default();
    let id = Uuid::new_v4();
    let auth = if std::env::var("TETHER_LIVE_AGENT").as_deref() == Ok("1") {
        Auth::Agent
    } else {
        let key_id = Uuid::new_v4();
        let pem =
            std::fs::read(std::env::var("TETHER_LIVE_KEY").expect("TETHER_LIVE_KEY")).unwrap();
        secrets.set(&key_account(key_id), &pem).unwrap();
        Auth::Key { id: key_id }
    };
    let machine = Machine {
        id,
        name: "live".into(),
        host,
        port,
        user,
        auth,
    };

    let mut conn = connect(
        &support::transport(),
        &ConnectRequest { machine },
        &MemoryHostKeys::default(),
        &secrets,
    )
    .await
    .unwrap();
    conn.start_keepalive(Duration::from_secs(15));

    let ls = conn.exec(&tether_core::zmx::ls_command()).await.unwrap();
    eprintln!("zmx ls: {:?}", tether_core::zmx::parse_ls(&ls));

    let mut pty = conn
        .open_pty(GridSize {
            cols: 80,
            rows: 24,
            width_px: 640,
            height_px: 384,
        })
        .await
        .unwrap();
    pty.writer.write(b"echo tether-live-$((40+2))\n").await;
    let mut seen = String::new();
    tokio::time::timeout(Duration::from_secs(10), async {
        while !seen.contains("tether-live-42") {
            if let Some(PtyEvent::Data(d)) = pty.events.recv().await {
                seen.push_str(&String::from_utf8_lossy(&d));
            }
        }
    })
    .await
    .expect("shell never echoed");
    pty.writer.close().await;
    conn.close().await;
}
