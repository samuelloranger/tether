use std::sync::mpsc::{Sender, channel};
use std::time::Duration;
use zbus::blocking::{Connection, MessageIterator, connection::Builder, fdo::DBusProxy};
use zbus::message::Type;
use zbus::{MatchRule, Message};

/// A hung daemon would otherwise hold the worker in a call forever.
const CALL_TIMEOUT: Duration = Duration::from_secs(5);

type Job = Box<dyn FnOnce(&Connection) + Send>;

/// A worker thread that owns the session bus connection, so the UI thread never waits on a
/// notification daemon. The connection is made on the first job, and retried while it fails.
pub struct SessionBus {
    tx: Sender<Job>,
}

impl SessionBus {
    /// `on_connect` runs once, with the first working connection, before any job.
    pub fn spawn(on_connect: impl FnOnce(&Connection) + Send + 'static) -> Self {
        let (tx, rx) = channel::<Job>();
        let spawned = std::thread::Builder::new()
            .name("session-bus".into())
            .spawn(move || {
                let mut on_connect = Some(on_connect);
                let mut conn: Option<Connection> = None;
                for job in rx {
                    if conn.is_none() {
                        match session() {
                            Ok(c) => {
                                if let Some(f) = on_connect.take() {
                                    f(&c);
                                }
                                conn = Some(c);
                            }
                            Err(e) => {
                                tracing::debug!("no session bus: {e}");
                                continue;
                            }
                        }
                    }
                    if let Some(c) = conn.as_ref() {
                        job(c);
                    }
                }
            });
        if let Err(e) = spawned {
            tracing::debug!("session bus thread failed: {e}");
        }
        Self { tx }
    }

    pub fn run(&self, job: impl FnOnce(&Connection) + Send + 'static) {
        let _ = self.tx.send(Box::new(job));
    }
}

pub fn session() -> zbus::Result<Connection> {
    Builder::session()?.method_timeout(CALL_TIMEOUT).build()
}

pub fn system() -> zbus::Result<Connection> {
    Builder::system()?.method_timeout(CALL_TIMEOUT).build()
}

pub fn signal_rule(
    interface: &'static str,
    member: &'static str,
    path: Option<&str>,
) -> zbus::Result<MatchRule<'static>> {
    let mut b = MatchRule::builder()
        .msg_type(Type::Signal)
        .interface(interface)?
        .member(member)?;
    if let Some(path) = path {
        b = b.path(path.to_owned())?;
    }
    Ok(b.build())
}

/// Every signal matching one of `rules`. Blocks the calling thread until the connection closes.
pub fn for_each_signal(
    conn: &Connection,
    rules: Vec<MatchRule<'static>>,
    mut f: impl FnMut(&Message),
) -> zbus::Result<()> {
    let dbus = DBusProxy::new(conn)?;
    for rule in rules {
        dbus.add_match_rule(rule)?;
    }
    for msg in MessageIterator::from(conn).flatten() {
        if msg.header().message_type() == Type::Signal {
            f(&msg);
        }
    }
    Ok(())
}
