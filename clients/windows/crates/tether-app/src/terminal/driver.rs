use std::collections::HashMap;
use std::sync::Arc;

use tether_core::connect::ConnectError;
use tether_core::zmx::attach_command;
use tether_ssh::{ConnectionEvent, PtyEvent};
use tokio::sync::{broadcast, mpsc};
use tokio::task::JoinHandle;
use tokio::time::{Instant, MissedTickBehavior, interval};

use crate::terminal::frame::FramePacer;
use crate::terminal::model::{Effect, Msg, TICK, TerminalModel, TerminalView};
use crate::terminal::remote::{PtySink, Remote};
use crate::terminal::ui_port::UiPort;

pub enum DriverMsg<S> {
    Model(Msg),
    Opened {
        terminal: broadcast::Receiver<ConnectionEvent>,
        control: broadcast::Receiver<ConnectionEvent>,
    },
    Sink {
        name: String,
        id: u64,
        sink: S,
        reader: JoinHandle<()>,
    },
    Presented,
}

const WRITER_CLOSE_GRACE: std::time::Duration = std::time::Duration::from_secs(2);

enum ChanOp {
    Resize(tether_core::resize::GridSize),
    Write(Vec<u8>),
    /// Typed only when this attach id is still the one the tab wants.
    Attach {
        id: u64,
        bytes: Vec<u8>,
    },
    Close,
}

fn spawn_writer<S: PtySink>(
    sink: S,
    mut rx: mpsc::UnboundedReceiver<ChanOp>,
    wanted: Arc<std::sync::Mutex<HashMap<String, u64>>>,
    name: String,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        while let Some(op) = rx.recv().await {
            match op {
                ChanOp::Resize(size) => sink.resize(size).await,
                ChanOp::Write(bytes) => sink.write(bytes).await,
                ChanOp::Attach { id, bytes } => {
                    let still = wanted.lock().unwrap().get(&name).copied() == Some(id);
                    if still {
                        sink.write(bytes).await;
                    }
                }
                ChanOp::Close => {
                    sink.close().await;
                    break;
                }
            }
        }
    })
}

pub type MsgSink = Arc<dyn Fn(Msg) + Send + Sync>;

pub fn msg_sink<S: Send + 'static>(tx: mpsc::UnboundedSender<DriverMsg<S>>) -> MsgSink {
    Arc::new(move |m| {
        let _ = tx.send(DriverMsg::Model(m));
    })
}

pub fn presented_sink<S: Send + 'static>(
    tx: mpsc::UnboundedSender<DriverMsg<S>>,
) -> Arc<dyn Fn() + Send + Sync> {
    Arc::new(move || {
        let _ = tx.send(DriverMsg::Presented);
    })
}

pub struct Driver<R: Remote, U: UiPort> {
    remote: Arc<R>,
    ui: U,
    tx: mpsc::UnboundedSender<DriverMsg<R::Sink>>,
    wanted: Arc<std::sync::Mutex<HashMap<String, u64>>>,
    readers: HashMap<String, JoinHandle<()>>,
    writers: HashMap<String, (mpsc::UnboundedSender<ChanOp>, JoinHandle<()>)>,
    drop_watch: Option<JoinHandle<()>>,
    control_watch: Option<JoinHandle<()>>,
    ls_seq: u64,
    pacer: FramePacer,
    last_view: Option<TerminalView>,
}

impl<R: Remote, U: UiPort> Driver<R, U> {
    pub fn new(remote: Arc<R>, ui: U, tx: mpsc::UnboundedSender<DriverMsg<R::Sink>>) -> Self {
        Self {
            remote,
            ui,
            tx,
            wanted: Arc::new(std::sync::Mutex::new(HashMap::new())),
            readers: HashMap::new(),
            writers: HashMap::new(),
            drop_watch: None,
            control_watch: None,
            ls_seq: 0,
            pacer: FramePacer::default(),
            last_view: None,
        }
    }

    pub async fn run(
        mut self,
        mut model: TerminalModel,
        initial: Vec<Effect>,
        mut rx: mpsc::UnboundedReceiver<DriverMsg<R::Sink>>,
    ) {
        let start = Instant::now();
        let mut tick = interval(TICK);
        tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
        let mut exit = self.apply(&mut model, initial).await;
        self.push_view(&model);
        while !exit {
            let msg = tokio::select! {
                m = rx.recv() => match m { Some(m) => m, None => break },
                _ = tick.tick() => DriverMsg::Model(Msg::Tick),
            };
            let now = start.elapsed();
            let fx = match msg {
                DriverMsg::Model(m) => model.handle(m, now),
                DriverMsg::Opened { terminal, control } => {
                    self.watch_drops(terminal);
                    self.watch_control(control);
                    model.handle(Msg::Opened, now)
                }
                DriverMsg::Sink {
                    name,
                    id,
                    sink,
                    reader,
                } => {
                    let current = self.wanted.lock().unwrap().get(&name).copied();
                    if current == Some(id) && attach_command(&name).is_none() {
                        reader.abort();
                        tokio::spawn(async move {
                            sink.close().await;
                        });
                        model.handle(
                            Msg::AttachFailed {
                                name,
                                id,
                                reason: "invalid session name".into(),
                            },
                            now,
                        )
                    } else if current == Some(id) {
                        if let Some(old) = self.readers.insert(name.clone(), reader) {
                            old.abort();
                        }
                        self.retire_writer(&name);
                        let (wtx, wrx) = mpsc::unbounded_channel();
                        let writer = spawn_writer(sink, wrx, self.wanted.clone(), name.clone());
                        let _ = wtx.send(ChanOp::Resize(model.grid()));
                        let _ = wtx.send(ChanOp::Attach {
                            id,
                            bytes: attach_command(&name).unwrap_or_default().into_bytes(),
                        });
                        self.writers.insert(name.clone(), (wtx, writer));
                        model.handle(Msg::Attached { name }, now)
                    } else {
                        // Detached (or re-attached) while this channel was still opening.
                        reader.abort();
                        tokio::spawn(async move {
                            sink.close().await;
                        });
                        Vec::new()
                    }
                }
                DriverMsg::Presented => {
                    if self.pacer.presented() {
                        self.render(&model);
                    }
                    Vec::new()
                }
            };
            exit = self.apply(&mut model, fx).await;
            self.push_view(&model);
        }
    }

    fn watch_drops(&mut self, mut drops: broadcast::Receiver<ConnectionEvent>) {
        if let Some(h) = self.drop_watch.take() {
            h.abort();
        }
        let tx = self.tx.clone();
        // An intentional close aborts this task first, so any wake-up here is a real drop.
        self.drop_watch = Some(tokio::spawn(async move {
            let _ = drops.recv().await;
            let _ = tx.send(DriverMsg::Model(Msg::Dropped));
        }));
    }

    fn watch_control(&mut self, drops: broadcast::Receiver<ConnectionEvent>) {
        if let Some(h) = self.control_watch.take() {
            h.abort();
        }
        let tx = self.tx.clone();
        let remote = self.remote.clone();
        self.control_watch = Some(tokio::spawn(async move {
            let mut drops = drops;
            loop {
                match drops.recv().await {
                    Ok(_) => match remote.redial_control().await {
                        Ok(next) => drops = next,
                        Err(_) => {
                            let _ = tx.send(DriverMsg::Model(Msg::Dropped));
                            break;
                        }
                    },
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        }));
    }

    fn retire_writer(&mut self, name: &str) {
        if let Some((tx, handle)) = self.writers.remove(name) {
            let _ = tx.send(ChanOp::Close);
            tokio::spawn(async move {
                let _ = handle.await;
            });
        }
    }

    fn render(&mut self, model: &TerminalModel) {
        match model.frame_job() {
            Some(job) => self.ui.render(job),
            None => self.pacer.cancel(),
        }
    }

    fn push_view(&mut self, model: &TerminalModel) {
        let view = model.view();
        if self.last_view.as_ref() != Some(&view) {
            self.ui.view(view.clone());
            self.last_view = Some(view);
        }
    }

    async fn close_channels(&mut self) {
        if let Some(h) = self.drop_watch.take() {
            h.abort();
        }
        if let Some(h) = self.control_watch.take() {
            h.abort();
        }
        self.wanted.lock().unwrap().clear();
        for (_, reader) in self.readers.drain() {
            reader.abort();
        }
        let writers = std::mem::take(&mut self.writers);
        let deadline = Instant::now() + WRITER_CLOSE_GRACE;
        let mut pending = Vec::new();
        for (tx, handle) in writers.into_values() {
            let _ = tx.send(ChanOp::Close);
            pending.push(handle);
        }
        // A writer blocked in `sink.write` (full SSH window) never reaches Close.
        for mut handle in pending {
            if tokio::time::timeout_at(deadline, &mut handle)
                .await
                .is_err()
            {
                handle.abort();
            }
        }
    }

    /// Returns true when the page is leaving and the loop should end.
    async fn apply(&mut self, model: &mut TerminalModel, fx: Vec<Effect>) -> bool {
        let mut exit = false;
        for effect in fx {
            match effect {
                Effect::Open => {
                    let (r, tx) = (self.remote.clone(), self.tx.clone());
                    tokio::spawn(async move {
                        let msg = match r.open().await {
                            Ok((terminal, control)) => DriverMsg::Opened { terminal, control },
                            Err(e) => DriverMsg::Model(Msg::OpenFailed(e)),
                        };
                        let _ = tx.send(msg);
                    });
                }
                Effect::Close => {
                    self.close_channels().await;
                    self.remote.close().await;
                    exit = true;
                }
                Effect::DropConnection => {
                    self.close_channels().await;
                    self.remote.close().await;
                }
                Effect::Ls => {
                    self.ls_seq += 1;
                    let id = self.ls_seq;
                    let (r, tx) = (self.remote.clone(), self.tx.clone());
                    tokio::spawn(async move {
                        let _ = tx.send(DriverMsg::Model(Msg::Ls {
                            id,
                            result: r.ls().await,
                        }));
                    });
                }
                Effect::Kill { name } => {
                    let (r, tx) = (self.remote.clone(), self.tx.clone());
                    tokio::spawn(async move {
                        let _ = r.kill(&name).await;
                        let _ = tx.send(DriverMsg::Model(Msg::KillDone));
                    });
                }
                Effect::Attach { name, id, size } => {
                    self.wanted.lock().unwrap().insert(name.clone(), id);
                    let (r, tx) = (self.remote.clone(), self.tx.clone());
                    tokio::spawn(async move {
                        match r.attach(&name, size).await {
                            Ok((sink, mut events)) => {
                                let (txr, n) = (tx.clone(), name.clone());
                                // Drain without pause: M3's queue holds 1024 events, and a
                                // full queue in one tab stalls every channel on the connection.
                                let reader = tokio::spawn(async move {
                                    while let Some(PtyEvent::Data(bytes)) = events.recv().await {
                                        let _ = txr.send(DriverMsg::Model(Msg::PtyData {
                                            name: n.clone(),
                                            bytes,
                                        }));
                                    }
                                    let _ = txr.send(DriverMsg::Model(Msg::PtyClosed { name: n }));
                                });
                                let _ = tx.send(DriverMsg::Sink {
                                    name,
                                    id,
                                    sink,
                                    reader,
                                });
                            }
                            Err(e) => {
                                let _ = tx.send(DriverMsg::Model(Msg::AttachFailed {
                                    name,
                                    id,
                                    reason: e.sentence(),
                                }));
                            }
                        }
                    });
                }
                Effect::Detach { name } => {
                    self.wanted.lock().unwrap().remove(&name);
                    if let Some(reader) = self.readers.remove(&name) {
                        reader.abort();
                    }
                    self.retire_writer(&name);
                }
                Effect::Write { name, bytes } => {
                    if let Some((tx, _)) = self.writers.get(&name) {
                        let _ = tx.send(ChanOp::Write(bytes));
                    }
                }
                Effect::ResizeAll(size) => {
                    for (tx, _) in self.writers.values() {
                        let _ = tx.send(ChanOp::Resize(size));
                    }
                }
                Effect::ScheduleRedial { after, generation } => {
                    let tx = self.tx.clone();
                    tokio::spawn(async move {
                        tokio::time::sleep(after).await;
                        let _ = tx.send(DriverMsg::Model(Msg::RedialDue { generation }));
                    });
                }
                Effect::StartSend(job) => {
                    tokio::spawn(crate::terminal::files::run_send(
                        self.remote.clone(),
                        job,
                        msg_sink(self.tx.clone()),
                    ));
                }
                Effect::AgentPoll => {
                    let (r, tx) = (self.remote.clone(), self.tx.clone());
                    tokio::spawn(async move {
                        let result = r.exec(&tether_core::agents::status_command()).await;
                        let now_unix = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map_or(0, |d| d.as_secs() as i64);
                        let _ = tx.send(DriverMsg::Model(Msg::AgentStatusOut { result, now_unix }));
                    });
                }
                Effect::AgentPending { session } => {
                    let (r, tx) = (self.remote.clone(), self.tx.clone());
                    tokio::spawn(async move {
                        let result = match tether_core::agents::pending_command(&session) {
                            Some(command) => r.exec(&command).await,
                            None => Err(ConnectError::Transport("invalid session name".into())),
                        };
                        let _ = tx.send(DriverMsg::Model(Msg::AgentPendingOut { session, result }));
                    });
                }
                Effect::AgentAnswer { command } => {
                    let (r, tx) = (self.remote.clone(), self.tx.clone());
                    tokio::spawn(async move {
                        let result = r.exec(&command).await;
                        let _ = tx.send(DriverMsg::Model(Msg::AgentAnswered { result }));
                    });
                }
                Effect::Redraw => {
                    if self.pacer.mark_dirty() {
                        self.render(model);
                    }
                }
                Effect::Ui(u) => self.ui.apply(u),
            }
        }
        exit
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::terminal::geometry::TermStyle;
    use crate::terminal::model::{TerminalModel, UiEffect};
    use crate::terminal::testkit::*;
    use crate::terminal::ui_port::RecordingUi;
    use std::time::Duration;

    async fn start(remote: Arc<FakeRemote>) -> (RecordingUi, MsgSink, JoinHandle<()>) {
        let ui = RecordingUi::default();
        let (tx, rx) = mpsc::unbounded_channel();
        let (model, fx) = TerminalModel::new(machine(), TermStyle::default(), grid());
        let driver = Driver::new(remote, ui.clone(), tx.clone());
        let handle = tokio::spawn(driver.run(model, fx, rx));
        tokio::time::sleep(Duration::from_millis(100)).await;
        (ui, msg_sink(tx), handle)
    }

    #[tokio::test(start_paused = true)]
    async fn first_connect_attaches_default_by_typing_into_the_login_shell() {
        let remote = Arc::new(FakeRemote::default());
        *remote.sessions.lock().unwrap() = Ok(vec![session("default", 1)]);
        let (ui, _send, _h) = start(remote.clone()).await;
        assert_eq!(remote.log()[..3], ["open", "ls", "attach default 80x24"]);
        assert_eq!(
            *remote.sink("default").log.lock().unwrap(),
            ["resize 80x24", "write ~/.local/bin/zmx attach 'default'\n"]
        );
        assert_eq!(ui.last_view().header.word, "connected");
    }

    #[tokio::test(start_paused = true)]
    async fn background_tabs_keep_streaming() {
        let remote = Arc::new(FakeRemote::default());
        *remote.sessions.lock().unwrap() = Ok(vec![session("a", 1), session("b", 2)]);
        let (ui, send, _h) = start(remote.clone()).await;
        send(Msg::SelectTab("a".into()));
        tokio::time::sleep(Duration::from_millis(100)).await;
        // More than M3's 1024-event queue: the reader must keep draining a background tab.
        for _ in 0..1500 {
            remote.push("b", b"x").await;
        }
        remote.push("b", b"\x07").await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        let v = ui.last_view();
        assert_eq!(v.header.session, "a");
        assert!(v.tabs.iter().find(|t| t.name == "b").unwrap().attention);
    }

    #[tokio::test(start_paused = true)]
    async fn kill_runs_on_control_then_refreshes() {
        let remote = Arc::new(FakeRemote::default());
        *remote.sessions.lock().unwrap() = Ok(vec![session("a", 1), session("b", 2)]);
        let (_ui, send, _h) = start(remote.clone()).await;
        send(Msg::KillRequested("b".into()));
        send(Msg::KillConfirmed);
        tokio::time::sleep(Duration::from_millis(100)).await;
        let log = remote.log();
        let kill = log.iter().position(|l| l == "kill b").expect("kill");
        assert!(log[kill..].iter().any(|l| l == "ls"));
        assert!(
            remote
                .sink("b")
                .log
                .lock()
                .unwrap()
                .contains(&"close".to_string())
        );
    }

    #[tokio::test(start_paused = true)]
    async fn back_closes_and_goes_home() {
        let remote = Arc::new(FakeRemote::default());
        *remote.sessions.lock().unwrap() = Ok(vec![session("default", 1)]);
        let (ui, send, handle) = start(remote.clone()).await;
        send(Msg::Back);
        handle.await.unwrap();
        assert!(remote.log().contains(&"close".to_string()));
        assert!(ui.effects.lock().unwrap().contains(&UiEffect::Home));
    }

    #[tokio::test(start_paused = true)]
    async fn back_does_not_wait_for_a_stuck_writer() {
        let remote = Arc::new(FakeRemote::default());
        *remote.sessions.lock().unwrap() = Ok(vec![session("default", 1)]);
        let (ui, send, handle) = start(remote.clone()).await;
        remote
            .sink("default")
            .hang_writes
            .store(true, std::sync::atomic::Ordering::SeqCst);
        send(Msg::Ime("x".into()));
        tokio::time::sleep(Duration::from_millis(50)).await;
        send(Msg::Back);
        tokio::time::timeout(Duration::from_secs(10), handle)
            .await
            .expect("driver hung on a stuck writer")
            .unwrap();
        assert!(remote.log().contains(&"close".to_string()));
        assert!(ui.effects.lock().unwrap().contains(&UiEffect::Home));
    }

    #[tokio::test(start_paused = true)]
    async fn refresh_fires_every_ten_seconds() {
        let remote = Arc::new(FakeRemote::default());
        *remote.sessions.lock().unwrap() = Ok(vec![session("default", 1)]);
        let (_ui, _send, _h) = start(remote.clone()).await;
        let before = remote.log().iter().filter(|l| *l == "ls").count();
        tokio::time::sleep(Duration::from_secs(21)).await;
        assert_eq!(
            remote.log().iter().filter(|l| *l == "ls").count(),
            before + 2
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_dropped_connection_reaches_the_model() {
        let remote = Arc::new(FakeRemote::default());
        *remote.sessions.lock().unwrap() = Ok(vec![session("default", 1)]);
        let (ui, _send, _h) = start(remote.clone()).await;
        remote.drop_connection();
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert_eq!(ui.last_view().header.word, "reconnecting");
    }

    #[tokio::test(start_paused = true)]
    async fn a_write_that_never_finishes_does_not_stop_ticks() {
        let remote = Arc::new(FakeRemote::default());
        *remote.sessions.lock().unwrap() = Ok(vec![session("default", 1)]);
        let (ui, send, _h) = start(remote.clone()).await;
        remote
            .sink("default")
            .hang_writes
            .store(true, std::sync::atomic::Ordering::SeqCst);
        send(Msg::Ime("x".into()));
        send(Msg::NewSessionBegin);
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(ui.last_view().naming.as_deref(), Some("session-2"));
    }

    #[tokio::test(start_paused = true)]
    async fn a_killed_attach_is_not_typed() {
        let remote = Arc::new(FakeRemote::default());
        *remote.sessions.lock().unwrap() = Ok(vec![session("default", 1)]);
        let gate = Arc::new(tokio::sync::Notify::new());
        *remote.hold_attach.lock().unwrap() = Some(gate.clone());
        let (_ui, send, _h) = start(remote.clone()).await;
        send(Msg::KillRequested("default".into()));
        send(Msg::KillConfirmed);
        *remote.sessions.lock().unwrap() = Ok(vec![]);
        tokio::time::sleep(Duration::from_millis(50)).await;
        gate.notify_one();
        tokio::time::sleep(Duration::from_millis(50)).await;
        let log = remote.sink("default").log.lock().unwrap().clone();
        assert!(
            log.iter().any(|l| l == "close"),
            "sink={log:?} remote={:?}",
            remote.log()
        );
        assert!(!log.iter().any(|l| l.contains("zmx attach")), "{log:?}");
    }

    #[tokio::test(start_paused = true)]
    async fn agent_status_is_read_on_the_control_connection_and_badges_the_tab() {
        let remote = Arc::new(FakeRemote::default());
        *remote.sessions.lock().unwrap() = Ok(vec![session("default", 1)]);
        remote.exec_replies.lock().unwrap().push((
            "tether-notify status".into(),
            Ok(r#"[{"session":"default","state":"working","since":1}]"#.into()),
        ));
        let (ui, _send, _h) = start(remote.clone()).await;
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(
            remote
                .log()
                .iter()
                .any(|l| l.starts_with("exec if [ -x ~/.local/bin/tether-notify ]"))
        );
        let tab = ui.last_view().tabs[0].agent.clone().expect("a badge");
        assert_eq!(tab.label, "working");
    }

    #[tokio::test(start_paused = true)]
    async fn a_failing_status_exec_leaves_the_terminal_connected_with_no_badges() {
        let remote = Arc::new(FakeRemote::default());
        *remote.sessions.lock().unwrap() = Ok(vec![session("default", 1)]);
        remote.exec_replies.lock().unwrap().push((
            "tether-notify status".into(),
            Err(tether_core::connect::ConnectError::Timeout),
        ));
        let (ui, _send, _h) = start(remote.clone()).await;
        tokio::time::sleep(Duration::from_secs(25)).await;
        let v = ui.last_view();
        assert_eq!(v.header.word, "connected");
        assert!(v.tabs[0].agent.is_none());
    }

    #[tokio::test(start_paused = true)]
    async fn answering_a_held_permission_runs_answer_on_the_control_connection() {
        let remote = Arc::new(FakeRemote::default());
        *remote.sessions.lock().unwrap() = Ok(vec![session("default", 1)]);
        remote.exec_replies.lock().unwrap().push((
            "tether-notify status".into(),
            Ok(
                r#"[{"session":"default","state":"waiting","since":1,"version":"v1","pending":{"kind":"permission"}}]"#
                    .into(),
            ),
        ));
        let (ui, send, _h) = start(remote.clone()).await;
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(ui.last_view().agent.sheet.is_some());
        send(Msg::AgentApprove);
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(remote.log().iter().any(|l| {
            l.starts_with("exec ~/.local/bin/tether-notify answer --session 'default' --state 'waiting' --version 'v1' --input")
        }));
        assert!(ui.last_view().agent.sheet.is_none());
    }

    #[tokio::test(start_paused = true)]
    async fn a_dropped_control_connection_is_redialed() {
        let remote = Arc::new(FakeRemote::default());
        *remote.sessions.lock().unwrap() = Ok(vec![session("default", 1)]);
        let (ui, _send, _h) = start(remote.clone()).await;
        remote.drop_control();
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(remote.log().contains(&"redial-control".to_string()));
        assert_eq!(ui.last_view().header.word, "connected");
    }
}
