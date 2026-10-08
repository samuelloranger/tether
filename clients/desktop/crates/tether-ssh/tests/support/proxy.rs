use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Notify;

/// Forwards one TCP connection; `freeze` stops relaying bytes without closing (a suspended
/// laptop), `kill` drops both sockets (an RST).
pub struct Proxy {
    pub addr: SocketAddr,
    frozen: Arc<AtomicBool>,
    killed: Arc<Notify>,
}

impl Proxy {
    pub async fn start(upstream: SocketAddr) -> Proxy {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let frozen = Arc::new(AtomicBool::new(false));
        let killed = Arc::new(Notify::new());
        let (f, k) = (frozen.clone(), killed.clone());
        tokio::spawn(async move {
            let (client, _) = listener.accept().await.unwrap();
            let server = TcpStream::connect(upstream).await.unwrap();
            let (cr, cw) = client.into_split();
            let (sr, sw) = server.into_split();
            let up = tokio::spawn(pump(cr, sw, f.clone()));
            let down = tokio::spawn(pump(sr, cw, f));
            k.notified().await;
            up.abort();
            down.abort();
        });
        Proxy {
            addr,
            frozen,
            killed,
        }
    }

    pub fn freeze(&self) {
        self.frozen.store(true, Ordering::SeqCst);
    }

    pub fn kill(&self) {
        self.killed.notify_one();
    }
}

async fn pump(
    mut from: impl AsyncReadExt + Unpin,
    mut to: impl AsyncWriteExt + Unpin,
    frozen: Arc<AtomicBool>,
) {
    let mut buf = vec![0u8; 16 * 1024];
    loop {
        let n = match from.read(&mut buf).await {
            Ok(0) | Err(_) => return,
            Ok(n) => n,
        };
        if frozen.load(Ordering::SeqCst) {
            continue;
        }
        if to.write_all(&buf[..n]).await.is_err() {
            return;
        }
    }
}
