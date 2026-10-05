use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::keys::{PrivateKey, PublicKey, ssh_key::Algorithm};
use russh::server::{self, Auth, Msg, Session};
use russh::{Channel, ChannelId};
use tokio::net::TcpListener;

#[derive(Default)]
pub struct Recorded {
    pub auth_attempts: usize,
    pub agent_forward_requests: usize,
    pub ptys: Vec<(u32, u32)>,
    pub window_changes: Vec<(u32, u32)>,
    pub input: HashMap<usize, Vec<u8>>,
    pub execs: Vec<String>,
    pub uploads: HashMap<String, Vec<u8>>,
}

#[derive(Default, Clone)]
pub struct Options {
    pub password: Option<(String, String)>,
    pub allowed_keys: Vec<PublicKey>,
}

pub struct Running {
    pub addr: SocketAddr,
    pub host_public: PublicKey,
    pub state: Arc<Mutex<Recorded>>,
    pub home: tempfile::TempDir,
}

#[derive(Clone)]
struct Shared {
    opts: Arc<Options>,
    state: Arc<Mutex<Recorded>>,
    home: PathBuf,
}

pub async fn start(opts: Options) -> Running {
    let key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
    let host_public = key.public_key().clone();
    let config = Arc::new(server::Config {
        inactivity_timeout: None,
        auth_rejection_time: Duration::from_millis(1),
        auth_rejection_time_initial: Some(Duration::from_millis(1)),
        channel_buffer_size: 2048,
        keys: vec![key],
        ..Default::default()
    });
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let state = Arc::new(Mutex::new(Recorded::default()));
    let home = tempfile::tempdir().unwrap();
    let shared = Shared {
        opts: Arc::new(opts),
        state: state.clone(),
        home: home.path().to_path_buf(),
    };
    tokio::spawn(async move {
        while let Ok((socket, _)) = listener.accept().await {
            let handler = ConnHandler {
                shared: shared.clone(),
                channels: HashMap::new(),
                order: Vec::new(),
                scp: HashMap::new(),
            };
            let config = config.clone();
            tokio::spawn(async move {
                if let Ok(running) = server::run_stream(config, socket, handler).await {
                    let _ = running.await;
                }
            });
        }
    });
    Running {
        addr,
        host_public,
        state,
        home,
    }
}

struct ConnHandler {
    shared: Shared,
    channels: HashMap<ChannelId, Channel<Msg>>,
    order: Vec<ChannelId>,
    scp: HashMap<ChannelId, super::server_scp::ScpSink>,
}

impl ConnHandler {
    fn index(&self, id: ChannelId) -> usize {
        self.order
            .iter()
            .position(|c| *c == id)
            .unwrap_or(usize::MAX)
    }
}

impl server::Handler for ConnHandler {
    type Error = russh::Error;

    async fn auth_none(&mut self, _user: &str) -> Result<Auth, Self::Error> {
        self.shared.state.lock().unwrap().auth_attempts += 1;
        Ok(Auth::reject())
    }

    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
        self.shared.state.lock().unwrap().auth_attempts += 1;
        let ok = self
            .shared
            .opts
            .password
            .as_ref()
            .is_some_and(|(u, p)| u == user && p == password);
        Ok(if ok { Auth::Accept } else { Auth::reject() })
    }

    async fn auth_publickey_offered(
        &mut self,
        _user: &str,
        key: &PublicKey,
    ) -> Result<Auth, Self::Error> {
        self.shared.state.lock().unwrap().auth_attempts += 1;
        let ok = self
            .shared
            .opts
            .allowed_keys
            .iter()
            .any(|k| k.key_data() == key.key_data());
        Ok(if ok { Auth::Accept } else { Auth::reject() })
    }

    async fn auth_publickey(&mut self, _user: &str, key: &PublicKey) -> Result<Auth, Self::Error> {
        let ok = self
            .shared
            .opts
            .allowed_keys
            .iter()
            .any(|k| k.key_data() == key.key_data());
        Ok(if ok { Auth::Accept } else { Auth::reject() })
    }

    async fn channel_open_session(
        &mut self,
        channel: Channel<Msg>,
        reply: server::ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.order.push(channel.id());
        self.channels.insert(channel.id(), channel);
        reply.accept().await;
        Ok(())
    }

    async fn agent_request(
        &mut self,
        _channel: ChannelId,
        _session: &mut Session,
    ) -> Result<bool, Self::Error> {
        self.shared.state.lock().unwrap().agent_forward_requests += 1;
        Ok(false)
    }

    async fn exec_request(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        let command = String::from_utf8_lossy(data).into_owned();
        self.shared
            .state
            .lock()
            .unwrap()
            .execs
            .push(command.clone());
        session.channel_success(channel)?;
        let handle = session.handle();
        if let Some(target) = command.strip_prefix("scp -t ") {
            self.scp.insert(
                channel,
                super::server_scp::ScpSink::new(super::server_scp::unquote(target)),
            );
            let _ = handle.data(channel, vec![0u8]).await;
            return Ok(());
        }
        if let Some(rest) = command.strip_prefix("tether-echo ") {
            let out = format!("{rest}\n");
            tokio::spawn(async move {
                let _ = handle
                    .extended_data(channel, 1, b"noise on stderr\n".to_vec())
                    .await;
                let _ = handle.data(channel, out.into_bytes()).await;
                let _ = handle.exit_status_request(channel, 3).await;
                let _ = handle.eof(channel).await;
                let _ = handle.close(channel).await;
            });
            return Ok(());
        }
        let home = self.shared.home.clone();
        tokio::spawn(async move {
            #[cfg(unix)]
            let (stdout, code) = match tokio::process::Command::new("sh")
                .arg("-c")
                .arg(&command)
                .env("HOME", &home)
                .output()
                .await
            {
                Ok(out) => (out.stdout, out.status.code().unwrap_or(1) as u32),
                Err(_) => (Vec::new(), 127),
            };
            #[cfg(not(unix))]
            let (stdout, code) = {
                let _ = (&command, &home);
                (Vec::new(), 127u32)
            };
            let _ = handle.data(channel, stdout).await;
            let _ = handle.exit_status_request(channel, code).await;
            let _ = handle.eof(channel).await;
            let _ = handle.close(channel).await;
        });
        Ok(())
    }

    async fn pty_request(
        &mut self,
        channel: ChannelId,
        _term: &str,
        cols: u32,
        rows: u32,
        _pw: u32,
        _ph: u32,
        _modes: &[(russh::Pty, u32)],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.shared.state.lock().unwrap().ptys.push((cols, rows));
        session.channel_success(channel)?;
        Ok(())
    }

    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        session.data(
            channel,
            format!("ready {}\r\n", self.index(channel)).into_bytes(),
        )?;
        Ok(())
    }

    async fn window_change_request(
        &mut self,
        _channel: ChannelId,
        cols: u32,
        rows: u32,
        _pw: u32,
        _ph: u32,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.shared
            .state
            .lock()
            .unwrap()
            .window_changes
            .push((cols, rows));
        Ok(())
    }

    async fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        if let Some(sink) = self.scp.get_mut(&channel) {
            sink.feed(channel, data, session, &self.shared.state);
            return Ok(());
        }
        let idx = self.index(channel);
        self.shared
            .state
            .lock()
            .unwrap()
            .input
            .entry(idx)
            .or_default()
            .extend_from_slice(data);
        session.data(
            channel,
            format!("<{idx}>{}", String::from_utf8_lossy(data)).into_bytes(),
        )?;
        Ok(())
    }

    async fn channel_eof(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        if self.scp.remove(&channel).is_some() {
            session.exit_status_request(channel, 0)?;
            session.eof(channel)?;
            session.close(channel)?;
        } else if self.channels.contains_key(&channel) {
            session.close(channel)?;
        }
        Ok(())
    }
}
