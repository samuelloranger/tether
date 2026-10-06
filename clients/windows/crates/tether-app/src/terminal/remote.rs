use std::future::Future;
use std::sync::Arc;
use tether_core::connect::{ConnectError, ConnectRequest, Connection, Transport, connect};
use tether_core::hostkey::HostKeyStore;
use tether_core::profiles::Machine;
use tether_core::resize::GridSize;
use tether_core::secrets::SecretStore;
use tether_core::upload::{UPLOADS_COMMAND, uploads_directory};
use tether_core::zmx::{ZmxSession, kill_command, ls_command, parse_ls};
use tether_ssh::{ConnectionEvent, PtyEvent};
use tokio::sync::{Mutex, broadcast, mpsc};

pub trait PtySink: Clone + Send + Sync + 'static {
    fn write(&self, bytes: Vec<u8>) -> impl Future<Output = ()> + Send;
    fn resize(&self, size: GridSize) -> impl Future<Output = ()> + Send;
    fn close(&self) -> impl Future<Output = ()> + Send;
}

pub trait SessionConn: Connection + Sync + 'static {
    type Sink: PtySink;
    fn open_pty(
        &self,
        size: GridSize,
    ) -> impl Future<Output = Result<(Self::Sink, mpsc::Receiver<PtyEvent>), ConnectError>> + Send;
    fn scp_send(
        &self,
        remote_path: &str,
        bytes: &[u8],
    ) -> impl Future<Output = Result<(), ConnectError>> + Send;
    fn drops(&self) -> broadcast::Receiver<ConnectionEvent>;
    fn close(&self) -> impl Future<Output = ()> + Send;
}

pub trait Remote: Send + Sync + 'static {
    type Sink: PtySink;
    fn open(
        &self,
    ) -> impl Future<
        Output = Result<
            (
                broadcast::Receiver<ConnectionEvent>,
                broadcast::Receiver<ConnectionEvent>,
            ),
            ConnectError,
        >,
    > + Send;
    fn redial_control(
        &self,
    ) -> impl Future<Output = Result<broadcast::Receiver<ConnectionEvent>, ConnectError>> + Send;
    fn ls(&self) -> impl Future<Output = Result<Vec<ZmxSession>, ConnectError>> + Send;
    fn kill(&self, name: &str) -> impl Future<Output = Result<(), ConnectError>> + Send;
    fn uploads_dir(&self) -> impl Future<Output = Option<String>> + Send;
    /// One command on the control connection, its stdout on success.
    fn exec(&self, command: &str) -> impl Future<Output = Result<String, ConnectError>> + Send;
    fn attach(
        &self,
        name: &str,
        size: GridSize,
    ) -> impl Future<Output = Result<(Self::Sink, mpsc::Receiver<PtyEvent>), ConnectError>> + Send;
    fn upload(
        &self,
        remote_path: &str,
        bytes: Vec<u8>,
    ) -> impl Future<Output = Result<(), ConnectError>> + Send;
    fn close(&self) -> impl Future<Output = ()> + Send;
}

/// The iOS connection split: one terminal connection for every PTY, one control
/// connection for exec, and a fresh connection per upload.
pub struct SshRemote<T: Transport> {
    transport: T,
    request: ConnectRequest,
    hostkeys: Arc<dyn HostKeyStore>,
    secrets: Arc<dyn SecretStore>,
    terminal: Mutex<Option<Arc<T::Conn>>>,
    control: Mutex<Option<Arc<T::Conn>>>,
}

impl<T: Transport> SshRemote<T> {
    pub fn new(
        transport: T,
        machine: Machine,
        hostkeys: Arc<dyn HostKeyStore>,
        secrets: Arc<dyn SecretStore>,
    ) -> Self {
        Self {
            transport,
            request: ConnectRequest { machine },
            hostkeys,
            secrets,
            terminal: Mutex::new(None),
            control: Mutex::new(None),
        }
    }

    async fn dial(&self) -> Result<T::Conn, ConnectError> {
        connect(
            &self.transport,
            &self.request,
            self.hostkeys.as_ref(),
            self.secrets.as_ref(),
        )
        .await
    }

    async fn control(&self) -> Result<Arc<T::Conn>, ConnectError> {
        self.control
            .lock()
            .await
            .clone()
            .ok_or(ConnectError::Transport("not connected".into()))
    }
}

impl<T> Remote for SshRemote<T>
where
    T: Transport + 'static,
    T::Conn: SessionConn,
{
    type Sink = <T::Conn as SessionConn>::Sink;

    async fn open(
        &self,
    ) -> Result<
        (
            broadcast::Receiver<ConnectionEvent>,
            broadcast::Receiver<ConnectionEvent>,
        ),
        ConnectError,
    > {
        let terminal = Arc::new(self.dial().await?);
        let control = Arc::new(self.dial().await?);
        let terminal_drops = terminal.drops();
        let control_drops = control.drops();
        *self.terminal.lock().await = Some(terminal);
        *self.control.lock().await = Some(control);
        Ok((terminal_drops, control_drops))
    }

    async fn redial_control(&self) -> Result<broadcast::Receiver<ConnectionEvent>, ConnectError> {
        let conn = Arc::new(self.dial().await?);
        let drops = conn.drops();
        if let Some(old) = self.control.lock().await.replace(conn) {
            old.close().await;
        }
        Ok(drops)
    }

    async fn ls(&self) -> Result<Vec<ZmxSession>, ConnectError> {
        Ok(parse_ls(&self.control().await?.exec(&ls_command()).await?))
    }

    async fn kill(&self, name: &str) -> Result<(), ConnectError> {
        let command = kill_command(name)
            .ok_or_else(|| ConnectError::Transport("invalid session name".into()))?;
        self.control().await?.exec(&command).await.map(|_| ())
    }

    async fn uploads_dir(&self) -> Option<String> {
        let out = self
            .control()
            .await
            .ok()?
            .exec(UPLOADS_COMMAND)
            .await
            .ok()?;
        uploads_directory(&out)
    }

    async fn exec(&self, command: &str) -> Result<String, ConnectError> {
        self.control().await?.exec(command).await
    }

    async fn attach(
        &self,
        _name: &str,
        size: GridSize,
    ) -> Result<(Self::Sink, mpsc::Receiver<PtyEvent>), ConnectError> {
        let conn = self
            .terminal
            .lock()
            .await
            .clone()
            .ok_or(ConnectError::Transport("not connected".into()))?;
        conn.open_pty(size).await
    }

    async fn upload(&self, remote_path: &str, bytes: Vec<u8>) -> Result<(), ConnectError> {
        let conn = self.dial().await?;
        let result = conn.scp_send(remote_path, &bytes).await;
        conn.close().await;
        result
    }

    async fn close(&self) {
        for slot in [&self.terminal, &self.control] {
            if let Some(conn) = slot.lock().await.take() {
                conn.close().await;
            }
        }
    }
}

impl PtySink for tether_ssh::PtyWriter {
    async fn write(&self, bytes: Vec<u8>) {
        tether_ssh::PtyWriter::write(self, &bytes).await
    }
    async fn resize(&self, size: GridSize) {
        tether_ssh::PtyWriter::resize(self, size).await
    }
    async fn close(&self) {
        tether_ssh::PtyWriter::close(self).await
    }
}

impl SessionConn for tether_ssh::RusshConnection {
    type Sink = tether_ssh::PtyWriter;
    async fn open_pty(
        &self,
        size: GridSize,
    ) -> Result<(Self::Sink, mpsc::Receiver<PtyEvent>), ConnectError> {
        let ch = tether_ssh::RusshConnection::open_pty(self, size).await?;
        Ok((ch.writer, ch.events))
    }
    async fn scp_send(&self, remote_path: &str, bytes: &[u8]) -> Result<(), ConnectError> {
        tether_ssh::RusshConnection::scp_send(self, remote_path, bytes).await
    }
    fn drops(&self) -> broadcast::Receiver<ConnectionEvent> {
        self.events()
    }
    async fn close(&self) {
        tether_ssh::RusshConnection::close(self).await
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::terminal::testkit::*;
    use tether_core::hostkey::{HostKeyStore, MemoryHostKeys, hex_fingerprint};
    use tether_core::secrets::{MemorySecretStore, SecretStore, password_account};
    use tether_core::zmx::kill_command;

    fn remote(t: FakeTransport) -> SshRemote<FakeTransport> {
        let secrets = MemorySecretStore::default();
        secrets
            .set(&password_account(machine().id), b"hunter2")
            .unwrap();
        SshRemote::new(
            t,
            machine(),
            Arc::new(MemoryHostKeys::default()),
            Arc::new(secrets),
        )
    }

    #[tokio::test]
    async fn open_dials_terminal_then_control() {
        let t = FakeTransport::default();
        let r = remote(t.clone());
        r.open().await.unwrap();
        let log = t.log.lock().unwrap().clone();
        assert_eq!(
            log.iter()
                .filter(|l| l.starts_with("dial devbox.lan:22"))
                .count(),
            2
        );
    }

    #[tokio::test]
    async fn ls_runs_zmx_ls_on_control_and_parses() {
        let t = FakeTransport::default();
        t.exec_replies.lock().unwrap().insert(
            "~/.local/bin/zmx ls".into(),
            Ok("name=default\tpid=10\tclients=0\tcreated=100\tcwd=/home/sam\n".into()),
        );
        let r = remote(t);
        r.open().await.unwrap();
        let s = r.ls().await.unwrap();
        assert_eq!(s.len(), 1);
        assert_eq!(s[0].name, "default");
    }

    #[tokio::test]
    async fn kill_quotes_the_name() {
        let t = FakeTransport::default();
        let r = remote(t.clone());
        r.open().await.unwrap();
        r.kill("it's $(x)").await.unwrap();
        assert!(
            t.log
                .lock()
                .unwrap()
                .contains(&format!("exec {}", kill_command("it's $(x)").unwrap()))
        );
    }

    #[tokio::test]
    async fn kill_refuses_an_invalid_name_without_running_anything() {
        let t = FakeTransport::default();
        let r = remote(t.clone());
        r.open().await.unwrap();
        for name in ["a\u{15}b", "a\nb", "-rf"] {
            assert!(r.kill(name).await.is_err(), "{name:?}");
        }
        assert!(!t.log.lock().unwrap().iter().any(|l| l.starts_with("exec")));
    }

    #[tokio::test]
    async fn uploads_dir_requires_the_marker() {
        let t = FakeTransport::default();
        t.exec_replies.lock().unwrap().insert(
            "mkdir -p".into(),
            Ok("motd line\n/home/sam/.tether/uploads\n__TETHER_UPLOADS_OK__\n".into()),
        );
        let r = remote(t.clone());
        r.open().await.unwrap();
        assert_eq!(
            r.uploads_dir().await.as_deref(),
            Some("/home/sam/.tether/uploads")
        );
    }

    #[tokio::test]
    async fn upload_uses_its_own_connection() {
        let t = FakeTransport::default();
        let r = remote(t.clone());
        r.open().await.unwrap();
        r.upload("/home/sam/.tether/uploads/a.png", vec![1, 2, 3])
            .await
            .unwrap();
        let log = t.log.lock().unwrap().clone();
        assert_eq!(log.iter().filter(|l| l.starts_with("dial")).count(), 3);
        assert!(log.contains(&"scp /home/sam/.tether/uploads/a.png 3".to_string()));
    }

    #[tokio::test]
    async fn host_key_change_surfaces_as_refused() {
        let t = FakeTransport::default();
        let hostkeys = Arc::new(MemoryHostKeys::default());
        hostkeys
            .pin("devbox.lan", 22, &hex_fingerprint(&[9; 32]))
            .unwrap();
        let secrets = Arc::new(MemorySecretStore::default());
        secrets.set(&password_account(machine().id), b"x").unwrap();
        let r = SshRemote::new(t, machine(), hostkeys, secrets);
        assert!(matches!(
            r.open().await,
            Err(ConnectError::HostKeyChanged { .. })
        ));
    }
}
