#![cfg(test)]
#![cfg(test)]
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tether_core::connect::{ConnectError, Connection, Credential, Transport};
use tether_core::profiles::{Auth, Machine};
use tether_core::resize::GridSize;
use tether_core::zmx::ZmxSession;
use tether_ssh::{ConnectionEvent, PtyEvent};
use tokio::sync::{broadcast, mpsc};
use uuid::Uuid;

use super::remote::{PtySink, Remote, SessionConn};

pub fn machine() -> Machine {
    Machine {
        id: Uuid::nil(),
        name: "devbox".into(),
        host: "devbox.lan".into(),
        port: 22,
        user: "sam".into(),
        auth: Auth::Password,
        jump: None,
    }
}

pub fn session(name: &str, created: i64) -> ZmxSession {
    ZmxSession {
        name: name.into(),
        pid: 1,
        clients: 0,
        created,
        cwd: format!("file://devbox/home/sam/{name}"),
    }
}

pub fn grid() -> GridSize {
    GridSize {
        cols: 80,
        rows: 24,
        width_px: 640,
        height_px: 384,
    }
}

#[derive(Clone, Default)]
pub struct FakeSink {
    pub log: Arc<Mutex<Vec<String>>>,
    pub hang_writes: Arc<std::sync::atomic::AtomicBool>,
}

impl PtySink for FakeSink {
    async fn write(&self, bytes: Vec<u8>) {
        if self.hang_writes.load(std::sync::atomic::Ordering::SeqCst) {
            std::future::pending::<()>().await;
        }
        self.log
            .lock()
            .unwrap()
            .push(format!("write {}", String::from_utf8_lossy(&bytes)));
    }
    async fn resize(&self, size: GridSize) {
        self.log
            .lock()
            .unwrap()
            .push(format!("resize {}x{}", size.cols, size.rows));
    }
    async fn close(&self) {
        self.log.lock().unwrap().push("close".into());
    }
}

/// Scripted dials: each `dial` pops the next result; `exec` answers from `exec_replies` by prefix.
#[derive(Clone, Default)]
pub struct FakeTransport {
    pub dials: Arc<Mutex<VecDeque<Result<(), ConnectError>>>>,
    pub host_key: [u8; 32],
    pub exec_replies: Arc<Mutex<HashMap<String, Result<String, ConnectError>>>>,
    pub log: Arc<Mutex<Vec<String>>>,
}

pub struct FakeConn {
    t: FakeTransport,
    drops: broadcast::Sender<ConnectionEvent>,
}

impl Transport for FakeTransport {
    type Conn = FakeConn;
    async fn dial(
        &self,
        host: &str,
        port: u16,
        _timeout: Duration,
    ) -> Result<FakeConn, ConnectError> {
        self.log.lock().unwrap().push(format!("dial {host}:{port}"));
        self.dials.lock().unwrap().pop_front().unwrap_or(Ok(()))?;
        Ok(FakeConn {
            t: self.clone(),
            drops: broadcast::channel(4).0,
        })
    }
    async fn dial_via(
        &self,
        _via: FakeConn,
        host: &str,
        port: u16,
        timeout: Duration,
    ) -> Result<FakeConn, ConnectError> {
        self.log.lock().unwrap().push(format!("via {host}:{port}"));
        self.dial(host, port, timeout).await
    }
    async fn sleep(&self, _d: Duration) {}
}

impl Connection for FakeConn {
    fn host_key_sha256(&self) -> [u8; 32] {
        self.t.host_key
    }
    async fn authenticate(&mut self, user: &str, _cred: Credential) -> Result<(), ConnectError> {
        self.t.log.lock().unwrap().push(format!("auth {user}"));
        Ok(())
    }
    fn start_keepalive(&mut self, _every: Duration) {}
    async fn exec(&self, command: &str) -> Result<String, ConnectError> {
        self.t.log.lock().unwrap().push(format!("exec {command}"));
        let replies = self.t.exec_replies.lock().unwrap();
        replies
            .iter()
            .find(|(k, _)| command.starts_with(k.as_str()))
            .map(|(_, v)| v.clone())
            .unwrap_or(Ok(String::new()))
    }
}

impl SessionConn for FakeConn {
    type Sink = FakeSink;
    async fn open_pty(
        &self,
        size: GridSize,
    ) -> Result<(FakeSink, mpsc::Receiver<PtyEvent>), ConnectError> {
        self.t
            .log
            .lock()
            .unwrap()
            .push(format!("pty {}x{}", size.cols, size.rows));
        let (_tx, rx) = mpsc::channel(8);
        Ok((FakeSink::default(), rx))
    }
    async fn scp_send(&self, remote_path: &str, bytes: &[u8]) -> Result<(), ConnectError> {
        self.t
            .log
            .lock()
            .unwrap()
            .push(format!("scp {remote_path} {}", bytes.len()));
        Ok(())
    }
    fn drops(&self) -> broadcast::Receiver<ConnectionEvent> {
        self.drops.subscribe()
    }
    async fn close(&self) {
        self.t.log.lock().unwrap().push("close".into());
    }
}

/// Driver-level fake: every PTY gets a sender the test can push bytes into.
pub struct FakeRemote {
    pub log: Mutex<Vec<String>>,
    pub opens: Mutex<VecDeque<Result<(), ConnectError>>>,
    pub sessions: Mutex<Result<Vec<ZmxSession>, ConnectError>>,
    pub ptys: Mutex<HashMap<String, (FakeSink, mpsc::Sender<PtyEvent>)>>,
    pub drop_tx: broadcast::Sender<ConnectionEvent>,
    pub control_tx: broadcast::Sender<ConnectionEvent>,
    pub uploads_dir: Mutex<Option<String>>,
    pub upload_results: Mutex<VecDeque<Result<(), ConnectError>>>,
    pub hold_attach: Mutex<Option<Arc<tokio::sync::Notify>>>,
    pub histories: Mutex<HashMap<String, Result<String, ConnectError>>>,
    /// Control-connection exec replies by command substring; anything else answers with nothing.
    pub exec_replies: Mutex<Vec<(String, Result<String, ConnectError>)>>,
    /// Answers `exec` in order after `exec_replies`; an empty queue answers with empty output.
    pub exec_queue: Mutex<VecDeque<Result<String, ConnectError>>>,
}

impl Default for FakeRemote {
    fn default() -> Self {
        Self {
            log: Mutex::default(),
            opens: Mutex::default(),
            sessions: Mutex::new(Ok(vec![])),
            ptys: Mutex::default(),
            drop_tx: broadcast::channel(4).0,
            control_tx: broadcast::channel(4).0,
            uploads_dir: Mutex::new(Some("/home/sam/.tether/uploads".into())),
            upload_results: Mutex::default(),
            hold_attach: Mutex::default(),
            histories: Mutex::default(),
            exec_queue: Mutex::default(),
            exec_replies: Mutex::default(),
        }
    }
}

impl FakeRemote {
    pub fn log(&self) -> Vec<String> {
        self.log.lock().unwrap().clone()
    }
    pub fn sink(&self, name: &str) -> FakeSink {
        self.ptys.lock().unwrap()[name].0.clone()
    }
    pub async fn push(&self, name: &str, bytes: &[u8]) {
        let tx = self.ptys.lock().unwrap()[name].1.clone();
        tx.send(PtyEvent::Data(bytes.to_vec())).await.unwrap();
    }
    pub fn drop_connection(&self) {
        let _ = self.drop_tx.send(ConnectionEvent::Dropped);
    }
    pub fn drop_control(&self) {
        let _ = self.control_tx.send(ConnectionEvent::Dropped);
    }
}

impl Remote for FakeRemote {
    type Sink = FakeSink;
    async fn open(
        &self,
    ) -> Result<
        (
            broadcast::Receiver<ConnectionEvent>,
            broadcast::Receiver<ConnectionEvent>,
        ),
        ConnectError,
    > {
        self.log.lock().unwrap().push("open".into());
        self.opens.lock().unwrap().pop_front().unwrap_or(Ok(()))?;
        Ok((self.drop_tx.subscribe(), self.control_tx.subscribe()))
    }
    async fn redial_control(&self) -> Result<broadcast::Receiver<ConnectionEvent>, ConnectError> {
        self.log.lock().unwrap().push("redial-control".into());
        Ok(self.control_tx.subscribe())
    }
    async fn ls(&self) -> Result<Vec<ZmxSession>, ConnectError> {
        self.log.lock().unwrap().push("ls".into());
        self.sessions.lock().unwrap().clone()
    }
    async fn kill(&self, name: &str) -> Result<(), ConnectError> {
        self.log.lock().unwrap().push(format!("kill {name}"));
        Ok(())
    }
    async fn history(&self, name: &str) -> Result<String, ConnectError> {
        self.log.lock().unwrap().push(format!("history {name}"));
        self.histories
            .lock()
            .unwrap()
            .get(name)
            .cloned()
            .unwrap_or(Ok(String::new()))
    }
    async fn uploads_dir(&self) -> Option<String> {
        self.uploads_dir.lock().unwrap().clone()
    }
    async fn exec(&self, command: &str) -> Result<String, ConnectError> {
        self.log.lock().unwrap().push(format!("exec {command}"));
        self.exec_replies
            .lock()
            .unwrap()
            .iter()
            .find(|(needle, _)| command.contains(needle.as_str()))
            .map(|(_, reply)| reply.clone())
            .or_else(|| self.exec_queue.lock().unwrap().pop_front())
            .unwrap_or(Ok(String::new()))
    }
    async fn attach(
        &self,
        name: &str,
        size: GridSize,
    ) -> Result<(FakeSink, mpsc::Receiver<PtyEvent>), ConnectError> {
        self.log
            .lock()
            .unwrap()
            .push(format!("attach {name} {}x{}", size.cols, size.rows));
        let (tx, rx) = mpsc::channel(64);
        let sink = FakeSink::default();
        self.ptys
            .lock()
            .unwrap()
            .insert(name.into(), (sink.clone(), tx));
        let gate = self.hold_attach.lock().unwrap().clone();
        if let Some(gate) = gate {
            gate.notified().await;
        }
        Ok((sink, rx))
    }
    async fn upload(&self, remote_path: &str, bytes: Vec<u8>) -> Result<(), ConnectError> {
        self.log
            .lock()
            .unwrap()
            .push(format!("upload {remote_path} {}", bytes.len()));
        self.upload_results
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(Ok(()))
    }
    async fn close(&self) {
        self.log.lock().unwrap().push("close".into());
    }
}
