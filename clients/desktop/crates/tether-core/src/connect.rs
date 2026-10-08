use std::fmt;
use std::future::Future;
use std::time::Duration;

use zeroize::Zeroizing;

use crate::hostkey::{HostKeyDecision, HostKeyStore, hex_fingerprint, verify_host_key};
use crate::profiles::{Auth, Machine};
use crate::secrets::{SecretStore, key_account, password_account};

pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
pub const AUTH_TIMEOUT: Duration = Duration::from_secs(10);
/// The agent may wait on the user (a 1Password or Windows Hello prompt) before it signs.
pub const AGENT_AUTH_TIMEOUT: Duration = Duration::from_secs(90);
pub const KEEPALIVE_EVERY: Duration = Duration::from_secs(15);
pub const TRANSPORT_ATTEMPTS: usize = 3;
pub const RETRY_DELAY: Duration = Duration::from_millis(500);
pub const RECONNECT_BACKOFF: [Duration; 3] = [
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(4),
];

pub enum Credential {
    Key(Zeroizing<String>),
    Password(Zeroizing<String>),
    Agent,
}

impl Credential {
    pub fn kind(&self) -> &'static str {
        match self {
            Credential::Key(_) => "key",
            Credential::Password(_) => "password",
            Credential::Agent => "agent",
        }
    }
}

impl fmt::Debug for Credential {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Credential::{}", self.kind())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnectError {
    HostKeyChanged {
        expected: String,
        got: String,
    },
    AuthRejected,
    KeyMissing,
    AgentNotRunning,
    AgentNoKey,
    Timeout,
    Transport(String),
    /// The machine to connect through was removed, or the jumps loop back on themselves.
    JumpMissing,
}

#[cfg(windows)]
const NO_AGENT: &str = "No SSH agent is running. Start the OpenSSH Authentication Agent service or Pageant, or choose a key.";
#[cfg(not(windows))]
const NO_AGENT: &str =
    "No SSH agent was found. Start ssh-agent and set SSH_AUTH_SOCK, or choose a key.";

impl ConnectError {
    pub fn sentence(&self) -> String {
        match self {
            ConnectError::HostKeyChanged { .. } => "Host key changed — refused.".into(),
            ConnectError::AuthRejected => {
                "Authentication failed. Check the key or password.".into()
            }
            ConnectError::KeyMissing => {
                "This machine's key was deleted. Edit the machine and choose another key.".into()
            }
            ConnectError::AgentNotRunning => NO_AGENT.into(),
            ConnectError::AgentNoKey => "The SSH agent has no key this host accepts.".into(),
            ConnectError::Timeout => "The host stopped answering.".into(),
            ConnectError::Transport(detail) => format!("Could not connect: {detail}"),
            ConnectError::JumpMissing => {
                "The machine this one connects through is gone. Edit the machine and choose another, or Direct.".into()
            }
        }
    }

    pub fn retryable(&self) -> bool {
        matches!(self, ConnectError::Transport(_) | ConnectError::Timeout)
    }
}

pub trait Transport: Send + Sync {
    type Conn: Connection;
    fn dial(
        &self,
        host: &str,
        port: u16,
        timeout: Duration,
    ) -> impl Future<Output = Result<Self::Conn, ConnectError>> + Send;
    /// Opens an SSH session to `host:port` tunnelled through `via` (direct-tcpip). The new
    /// connection owns `via` and keeps it open.
    fn dial_via(
        &self,
        via: Self::Conn,
        host: &str,
        port: u16,
        timeout: Duration,
    ) -> impl Future<Output = Result<Self::Conn, ConnectError>> + Send;
    fn sleep(&self, d: Duration) -> impl Future<Output = ()> + Send;
}

pub trait Connection: Send {
    fn host_key_sha256(&self) -> [u8; 32];
    fn authenticate(
        &mut self,
        user: &str,
        cred: Credential,
    ) -> impl Future<Output = Result<(), ConnectError>> + Send;
    fn start_keepalive(&mut self, every: Duration);
    fn exec(&self, command: &str) -> impl Future<Output = Result<String, ConnectError>> + Send;
}

#[derive(Debug, Clone)]
pub struct ConnectRequest {
    pub machine: Machine,
    /// The machines to pass through, first hop first. Built by [`jump_chain`].
    pub jumps: Vec<Machine>,
}

pub const MAX_JUMPS: usize = 4;

/// Follows each machine's `jump` back to one reached directly.
pub fn jump_chain(machines: &[Machine], machine: &Machine) -> Result<Vec<Machine>, ConnectError> {
    let mut chain = Vec::new();
    let mut next = machine.jump;
    while let Some(id) = next {
        if id == machine.id
            || chain.iter().any(|m: &Machine| m.id == id)
            || chain.len() == MAX_JUMPS
        {
            return Err(ConnectError::JumpMissing);
        }
        let hop = machines
            .iter()
            .find(|m| m.id == id)
            .ok_or(ConnectError::JumpMissing)?;
        next = hop.jump;
        chain.push(hop.clone());
    }
    chain.reverse();
    Ok(chain)
}

fn secret_text(bytes: Zeroizing<Vec<u8>>) -> Option<Zeroizing<String>> {
    std::str::from_utf8(&bytes)
        .ok()
        .map(|s| Zeroizing::new(s.to_owned()))
}

/// Loaded per attempt and dropped (zeroized) with it; never kept in the profile.
pub fn load_credential(
    machine: &Machine,
    secrets: &dyn SecretStore,
) -> Result<Credential, ConnectError> {
    let read = |account: String| {
        secrets
            .get(&account)
            .map_err(|e| ConnectError::Transport(format!("{e:?}")))
    };
    match &machine.auth {
        Auth::Agent => Ok(Credential::Agent),
        Auth::Key { id } => read(key_account(*id))?
            .and_then(secret_text)
            .map(Credential::Key)
            .ok_or(ConnectError::KeyMissing),
        Auth::Password => read(password_account(machine.id))?
            .and_then(secret_text)
            .map(Credential::Password)
            .ok_or(ConnectError::AuthRejected),
        Auth::Unknown => Err(ConnectError::AuthRejected),
    }
}

/// `None` when the deadline completes first. The deadline is only started once `work`
/// is found pending, and `work` wins a tie.
async fn within<F: Future, D: Future<Output = ()>>(
    work: F,
    deadline: impl FnOnce() -> D,
) -> Option<F::Output> {
    let mut work = std::pin::pin!(work);
    let mut deadline = Some(deadline);
    let mut timer = None;
    std::future::poll_fn(|cx| {
        if let std::task::Poll::Ready(out) = work.as_mut().poll(cx) {
            return std::task::Poll::Ready(Some(out));
        }
        if timer.is_none() {
            timer = deadline.take().map(|start| Box::pin(start()));
        }
        match timer.as_mut() {
            Some(t) => t.as_mut().poll(cx).map(|()| None),
            None => std::task::Poll::Pending,
        }
    })
    .await
}

async fn attempt<T: Transport>(
    t: &T,
    req: &ConnectRequest,
    hostkeys: &dyn HostKeyStore,
    secrets: &dyn SecretStore,
) -> Result<T::Conn, ConnectError> {
    let mut via = None;
    for hop in req.jumps.iter().chain(std::iter::once(&req.machine)) {
        via = Some(hop_through(t, via, hop, hostkeys, secrets).await?);
    }
    let mut conn = via.expect("the chain ends with the machine itself");
    conn.start_keepalive(KEEPALIVE_EVERY);
    Ok(conn)
}

/// Dials `m` directly or through `via`, pins its host key, and authenticates.
async fn hop_through<T: Transport>(
    t: &T,
    via: Option<T::Conn>,
    m: &Machine,
    hostkeys: &dyn HostKeyStore,
    secrets: &dyn SecretStore,
) -> Result<T::Conn, ConnectError> {
    let cred = load_credential(m, secrets)?;
    let mut conn = match via {
        None => t.dial(&m.host, m.port, CONNECT_TIMEOUT).await?,
        Some(via) => t.dial_via(via, &m.host, m.port, CONNECT_TIMEOUT).await?,
    };
    let fingerprint = hex_fingerprint(&conn.host_key_sha256());
    let decision = verify_host_key(&fingerprint, &m.host, m.port, hostkeys)
        .map_err(|e| ConnectError::Transport(format!("could not save the host key: {e}")))?;
    if let HostKeyDecision::Mismatch { expected, got } = decision {
        return Err(ConnectError::HostKeyChanged { expected, got });
    }
    let limit = match m.auth {
        Auth::Agent => AGENT_AUTH_TIMEOUT,
        _ => AUTH_TIMEOUT,
    };
    match within(conn.authenticate(&m.user, cred), || t.sleep(limit)).await {
        Some(result) => result?,
        None => return Err(ConnectError::Timeout),
    }
    Ok(conn)
}

pub async fn connect<T: Transport>(
    t: &T,
    req: &ConnectRequest,
    hostkeys: &dyn HostKeyStore,
    secrets: &dyn SecretStore,
) -> Result<T::Conn, ConnectError> {
    let mut tries = 1;
    loop {
        match attempt(t, req, hostkeys, secrets).await {
            Err(e) if e.retryable() && tries < TRANSPORT_ATTEMPTS => {
                tries += 1;
                t.sleep(RETRY_DELAY).await;
            }
            result => return result,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::SecretError;
    use futures::executor::block_on;
    use std::collections::{HashMap, VecDeque};
    use std::sync::{Arc, Mutex};
    use uuid::Uuid;

    type Log = Arc<Mutex<Vec<String>>>;

    struct FakeTransport {
        log: Log,
        dials: Mutex<VecDeque<Result<[u8; 32], ConnectError>>>,
        auths: Mutex<VecDeque<Result<(), ConnectError>>>,
        hang_auth: bool,
    }

    struct FakeConn {
        log: Log,
        key: [u8; 32],
        auth: Result<(), ConnectError>,
        hang_auth: bool,
    }

    impl Transport for FakeTransport {
        type Conn = FakeConn;

        fn dial(
            &self,
            host: &str,
            port: u16,
            timeout: Duration,
        ) -> impl Future<Output = Result<FakeConn, ConnectError>> + Send {
            self.log
                .lock()
                .unwrap()
                .push(format!("dial {host}:{port} {}s", timeout.as_secs()));
            let next = self
                .dials
                .lock()
                .unwrap()
                .pop_front()
                .expect("unexpected dial");
            let auth = self.auths.lock().unwrap().pop_front().unwrap_or(Ok(()));
            let log = self.log.clone();
            let hang_auth = self.hang_auth;
            async move {
                next.map(|key| FakeConn {
                    log,
                    key,
                    auth,
                    hang_auth,
                })
            }
        }

        fn dial_via(
            &self,
            via: FakeConn,
            host: &str,
            port: u16,
            timeout: Duration,
        ) -> impl Future<Output = Result<FakeConn, ConnectError>> + Send {
            self.log.lock().unwrap().push(format!(
                "via {:02x} {host}:{port} {}s",
                via.key[0],
                timeout.as_secs()
            ));
            self.dial("", 0, timeout)
        }

        fn sleep(&self, d: Duration) -> impl Future<Output = ()> + Send {
            self.log
                .lock()
                .unwrap()
                .push(format!("sleep {}ms", d.as_millis()));
            async {}
        }
    }

    impl Connection for FakeConn {
        fn host_key_sha256(&self) -> [u8; 32] {
            self.key
        }

        fn authenticate(
            &mut self,
            user: &str,
            cred: Credential,
        ) -> impl Future<Output = Result<(), ConnectError>> + Send {
            self.log
                .lock()
                .unwrap()
                .push(format!("auth {user} {}", cred.kind()));
            let result = self.auth.clone();
            let hang = self.hang_auth;
            async move {
                if hang {
                    std::future::pending::<()>().await;
                }
                result
            }
        }

        fn start_keepalive(&mut self, every: Duration) {
            self.log
                .lock()
                .unwrap()
                .push(format!("keepalive {}s", every.as_secs()));
        }

        fn exec(&self, command: &str) -> impl Future<Output = Result<String, ConnectError>> + Send {
            self.log.lock().unwrap().push(format!("exec {command}"));
            async { Ok(String::new()) }
        }
    }

    struct Pins {
        log: Log,
        map: Mutex<HashMap<String, String>>,
        fail: std::sync::atomic::AtomicBool,
    }

    impl HostKeyStore for Pins {
        fn pinned(&self, host: &str, port: u16) -> Option<String> {
            self.map
                .lock()
                .unwrap()
                .get(&format!("{host}:{port}"))
                .cloned()
        }
        fn pin(&self, host: &str, port: u16, fingerprint: &str) -> std::io::Result<()> {
            self.log.lock().unwrap().push("pin".into());
            if self.fail.load(std::sync::atomic::Ordering::SeqCst) {
                return Err(std::io::Error::other("disk full"));
            }
            self.map
                .lock()
                .unwrap()
                .insert(format!("{host}:{port}"), fingerprint.into());
            Ok(())
        }
    }

    struct Secrets(Mutex<HashMap<String, Vec<u8>>>);

    impl SecretStore for Secrets {
        fn get(&self, account: &str) -> Result<Option<Zeroizing<Vec<u8>>>, SecretError> {
            Ok(self
                .0
                .lock()
                .unwrap()
                .get(account)
                .cloned()
                .map(Zeroizing::new))
        }
        fn set(&self, account: &str, secret: &[u8]) -> Result<(), SecretError> {
            self.0
                .lock()
                .unwrap()
                .insert(account.into(), secret.to_vec());
            Ok(())
        }
        fn delete(&self, account: &str) -> Result<(), SecretError> {
            self.0.lock().unwrap().remove(account);
            Ok(())
        }
    }

    struct World {
        log: Log,
        transport: FakeTransport,
        pins: Pins,
        secrets: Secrets,
        key_id: Uuid,
    }

    fn world(
        dials: Vec<Result<[u8; 32], ConnectError>>,
        auths: Vec<Result<(), ConnectError>>,
    ) -> World {
        let log: Log = Arc::default();
        let key_id = Uuid::new_v4();
        let secrets = Secrets(Mutex::new(HashMap::from([(
            key_account(key_id),
            b"-----BEGIN OPENSSH PRIVATE KEY-----".to_vec(),
        )])));
        World {
            transport: FakeTransport {
                log: log.clone(),
                dials: Mutex::new(dials.into()),
                auths: Mutex::new(auths.into()),
                hang_auth: false,
            },
            pins: Pins {
                log: log.clone(),
                map: Mutex::default(),
                fail: Default::default(),
            },
            secrets,
            log,
            key_id,
        }
    }

    fn machine(auth: Auth) -> ConnectRequest {
        ConnectRequest {
            machine: Machine {
                id: Uuid::new_v4(),
                name: "devbox".into(),
                host: "h".into(),
                port: 22,
                user: "u".into(),
                auth,
                jump: None,
            },
            jumps: Vec::new(),
        }
    }

    fn run(w: &World, req: &ConnectRequest) -> Result<FakeConn, ConnectError> {
        block_on(connect(&w.transport, req, &w.pins, &w.secrets))
    }

    fn log(w: &World) -> Vec<String> {
        w.log.lock().unwrap().clone()
    }

    const KEY_A: [u8; 32] = [0xaa; 32];
    const KEY_B: [u8; 32] = [0xbb; 32];

    #[test]
    fn first_connect_pins_before_auth_and_keepalive_starts_after_auth() {
        let w = world(vec![Ok(KEY_A)], vec![]);
        let req = machine(Auth::Key { id: w.key_id });
        assert!(run(&w, &req).is_ok());
        assert_eq!(
            log(&w),
            ["dial h:22 10s", "pin", "auth u key", "keepalive 15s"]
        );
        assert_eq!(w.pins.pinned("h", 22), Some(hex_fingerprint(&KEY_A)));
    }

    #[test]
    fn a_matching_pin_continues_without_writing() {
        let w = world(vec![Ok(KEY_A)], vec![]);
        w.pins
            .map
            .lock()
            .unwrap()
            .insert("h:22".into(), hex_fingerprint(&KEY_A));
        assert!(run(&w, &machine(Auth::Agent)).is_ok());
        assert_eq!(log(&w), ["dial h:22 10s", "auth u agent", "keepalive 15s"]);
    }

    #[test]
    fn a_mismatch_is_refused_not_written_and_never_retried() {
        let w = world(vec![Ok(KEY_B), Ok(KEY_B)], vec![]);
        w.pins
            .map
            .lock()
            .unwrap()
            .insert("h:22".into(), hex_fingerprint(&KEY_A));
        let err = run(&w, &machine(Auth::Agent)).err().unwrap();
        assert_eq!(
            err,
            ConnectError::HostKeyChanged {
                expected: hex_fingerprint(&KEY_A),
                got: hex_fingerprint(&KEY_B),
            }
        );
        assert_eq!(log(&w), ["dial h:22 10s"]);
        assert_eq!(w.pins.pinned("h", 22), Some(hex_fingerprint(&KEY_A)));
        assert!(!err.retryable());
    }

    #[test]
    fn agent_auth_waits_longer_for_a_user_prompt() {
        let mut w = world(vec![Ok(KEY_A), Ok(KEY_A), Ok(KEY_A)], vec![]);
        w.transport.hang_auth = true;
        assert_eq!(
            run(&w, &machine(Auth::Agent)).err(),
            Some(ConnectError::Timeout)
        );
        let agent = format!("sleep {}ms", AGENT_AUTH_TIMEOUT.as_millis());
        assert!(log(&w).contains(&agent));
        assert!(!log(&w).contains(&format!("sleep {}ms", AUTH_TIMEOUT.as_millis())));
    }

    #[test]
    fn an_auth_that_never_answers_times_out_and_is_retried() {
        let mut w = world(vec![Ok(KEY_A), Ok(KEY_A), Ok(KEY_A)], vec![]);
        w.transport.hang_auth = true;
        let req = machine(Auth::Key { id: w.key_id });
        assert_eq!(run(&w, &req).err(), Some(ConnectError::Timeout));
        let dials = log(&w).iter().filter(|l| l.starts_with("dial")).count();
        assert_eq!(dials, TRANSPORT_ATTEMPTS);
    }

    #[test]
    fn a_failed_pin_save_stops_before_auth() {
        let w = world(vec![Ok(KEY_A); 3], vec![]);
        w.pins.fail.store(true, std::sync::atomic::Ordering::SeqCst);
        let req = machine(Auth::Key { id: w.key_id });
        assert!(matches!(
            run(&w, &req).err(),
            Some(ConnectError::Transport(m)) if m.contains("host key")
        ));
        assert!(!log(&w).iter().any(|l| l.starts_with("auth")));
    }

    #[test]
    fn an_auth_failure_is_not_retried() {
        let w = world(
            vec![Ok(KEY_A), Ok(KEY_A)],
            vec![Err(ConnectError::AuthRejected)],
        );
        let mut req = machine(Auth::Password);
        w.secrets
            .set(&password_account(req.machine.id), b"hunter2")
            .unwrap();
        req.machine.port = 2222;
        assert_eq!(run(&w, &req).err(), Some(ConnectError::AuthRejected));
        assert_eq!(log(&w), ["dial h:2222 10s", "pin", "auth u password"]);
    }

    #[test]
    fn transport_failures_retry_three_attempts_500ms_apart() {
        let refused = || Err(ConnectError::Transport("connection refused".into()));
        let w = world(vec![refused(), refused(), refused()], vec![]);
        assert_eq!(
            run(&w, &machine(Auth::Agent)).err(),
            Some(ConnectError::Transport("connection refused".into()))
        );
        assert_eq!(
            log(&w),
            [
                "dial h:22 10s",
                "sleep 500ms",
                "dial h:22 10s",
                "sleep 500ms",
                "dial h:22 10s"
            ]
        );
    }

    fn hop(id: u128, host: &str, jump: Option<u128>) -> Machine {
        Machine {
            id: Uuid::from_u128(id),
            name: host.into(),
            host: host.into(),
            port: 22,
            user: "j".into(),
            auth: Auth::Agent,
            jump: jump.map(Uuid::from_u128),
        }
    }

    #[test]
    fn a_jump_chain_lists_the_first_hop_first() {
        let (a, b, c) = (
            hop(1, "a", None),
            hop(2, "b", Some(1)),
            hop(3, "c", Some(2)),
        );
        let all = [a.clone(), b.clone(), c.clone()];
        let chain = jump_chain(&all, &c).unwrap();
        assert_eq!(
            chain.iter().map(|m| m.host.as_str()).collect::<Vec<_>>(),
            ["a", "b"]
        );
        assert!(jump_chain(&all, &a).unwrap().is_empty());
    }

    #[test]
    fn a_missing_or_looping_jump_is_refused() {
        let gone = hop(2, "b", Some(9));
        assert_eq!(
            jump_chain(std::slice::from_ref(&gone), &gone),
            Err(ConnectError::JumpMissing)
        );
        let (x, y) = (hop(1, "x", Some(2)), hop(2, "y", Some(1)));
        assert_eq!(
            jump_chain(&[x.clone(), y], &x),
            Err(ConnectError::JumpMissing)
        );
        let own = hop(1, "self", Some(1));
        assert_eq!(
            jump_chain(std::slice::from_ref(&own), &own),
            Err(ConnectError::JumpMissing)
        );
        let deep: Vec<Machine> = (1..=6)
            .map(|i| hop(i, "h", (i > 1).then(|| i - 1)))
            .collect();
        assert_eq!(jump_chain(&deep, &deep[5]), Err(ConnectError::JumpMissing));
        assert!(!ConnectError::JumpMissing.retryable());
    }

    #[test]
    fn each_hop_is_pinned_and_authenticated_before_the_next_and_only_the_last_keeps_alive() {
        let w = world(vec![Ok(KEY_A), Ok(KEY_B)], vec![]);
        let mut req = machine(Auth::Agent);
        req.jumps = vec![hop(1, "bastion", None)];
        assert!(run(&w, &req).is_ok());
        assert_eq!(
            log(&w),
            [
                "dial bastion:22 10s",
                "pin",
                "auth j agent",
                "via aa h:22 10s",
                "dial :0 10s",
                "pin",
                "auth u agent",
                "keepalive 15s"
            ]
        );
        let pins = w.pins.map.lock().unwrap();
        assert_eq!(pins.get("bastion:22"), Some(&hex_fingerprint(&KEY_A)));
        assert_eq!(pins.get("h:22"), Some(&hex_fingerprint(&KEY_B)));
    }

    #[test]
    fn a_changed_jump_host_key_stops_before_the_target() {
        let w = world(vec![Ok(KEY_B)], vec![]);
        w.pins
            .map
            .lock()
            .unwrap()
            .insert("bastion:22".into(), hex_fingerprint(&KEY_A));
        let mut req = machine(Auth::Agent);
        req.jumps = vec![hop(1, "bastion", None)];
        assert!(matches!(
            run(&w, &req),
            Err(ConnectError::HostKeyChanged { .. })
        ));
        assert!(!log(&w).iter().any(|l| l.starts_with("via")));
    }

    #[test]
    fn a_timeout_retries_and_a_later_attempt_can_succeed() {
        let w = world(vec![Err(ConnectError::Timeout), Ok(KEY_A)], vec![]);
        assert!(run(&w, &machine(Auth::Agent)).is_ok());
        assert_eq!(
            log(&w),
            [
                "dial h:22 10s",
                "sleep 500ms",
                "dial h:22 10s",
                "pin",
                "auth u agent",
                "keepalive 15s"
            ]
        );
    }

    #[test]
    fn agent_errors_are_not_retried() {
        let w = world(
            vec![Ok(KEY_A), Ok(KEY_A)],
            vec![Err(ConnectError::AgentNotRunning)],
        );
        assert_eq!(
            run(&w, &machine(Auth::Agent)).err(),
            Some(ConnectError::AgentNotRunning)
        );
        assert_eq!(log(&w).iter().filter(|l| l.starts_with("dial")).count(), 1);
    }

    #[test]
    fn a_deleted_key_fails_before_dialing() {
        let w = world(vec![], vec![]);
        let req = machine(Auth::Key { id: Uuid::new_v4() });
        assert_eq!(run(&w, &req).err(), Some(ConnectError::KeyMissing));
        assert!(log(&w).is_empty());
    }

    #[test]
    fn a_missing_saved_password_is_an_auth_failure() {
        let w = world(vec![], vec![]);
        assert_eq!(
            run(&w, &machine(Auth::Password)).err(),
            Some(ConnectError::AuthRejected)
        );
    }

    #[test]
    fn sentences_are_verbatim() {
        assert_eq!(
            ConnectError::AuthRejected.sentence(),
            "Authentication failed. Check the key or password."
        );
        assert_eq!(
            ConnectError::KeyMissing.sentence(),
            "This machine's key was deleted. Edit the machine and choose another key."
        );
        #[cfg(windows)]
        assert_eq!(
            ConnectError::AgentNotRunning.sentence(),
            "No SSH agent is running. Start the OpenSSH Authentication Agent service or Pageant, or choose a key."
        );
        #[cfg(not(windows))]
        assert_eq!(
            ConnectError::AgentNotRunning.sentence(),
            "No SSH agent was found. Start ssh-agent and set SSH_AUTH_SOCK, or choose a key."
        );
        assert_eq!(
            ConnectError::AgentNoKey.sentence(),
            "The SSH agent has no key this host accepts."
        );
        assert_eq!(
            ConnectError::Timeout.sentence(),
            "The host stopped answering."
        );
        assert_eq!(
            ConnectError::Transport("no route".into()).sentence(),
            "Could not connect: no route"
        );
    }

    #[test]
    fn credentials_never_print_their_secret() {
        let c = Credential::Password(Zeroizing::new("hunter2".into()));
        assert!(!format!("{c:?}").contains("hunter2"));
    }

    #[test]
    fn reconnect_backs_off_one_two_four_seconds() {
        assert_eq!(
            RECONNECT_BACKOFF,
            [
                Duration::from_secs(1),
                Duration::from_secs(2),
                Duration::from_secs(4)
            ]
        );
    }
}
