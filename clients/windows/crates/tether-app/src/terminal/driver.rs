use std::collections::HashMap;
use std::sync::Arc;

use tether_core::zmx::attach_command;
use tether_ssh::{ConnectionEvent, PtyEvent};
use tokio::sync::{broadcast, mpsc};
use tokio::task::JoinHandle;
use tokio::time::{interval, Instant, MissedTickBehavior};

use crate::terminal::frame::FramePacer;
use crate::terminal::model::{Effect, Msg, TerminalModel, TerminalView, TICK};
use crate::terminal::remote::{PtySink, Remote};
use crate::terminal::ui_port::UiPort;

pub enum DriverMsg<S> {
    Model(Msg),
    Opened(broadcast::Receiver<ConnectionEvent>),
    Sink {
        name: String,
        id: u64,
        sink: S,
        reader: JoinHandle<()>,
    },
    Presented,
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
    wanted: HashMap<String, u64>,
    sinks: HashMap<String, (R::Sink, JoinHandle<()>)>,
    drop_watch: Option<JoinHandle<()>>,
    pacer: FramePacer,
    last_view: Option<TerminalView>,
}

impl<R: Remote, U: UiPort> Driver<R, U> {
    pub fn new(remote: Arc<R>, ui: U, tx: mpsc::UnboundedSender<DriverMsg<R::Sink>>) -> Self {
        Self {
            remote,
            ui,
            tx,
            wanted: HashMap::new(),
            sinks: HashMap::new(),
            drop_watch: None,
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
                DriverMsg::Opened(drops) => {
                    self.watch_drops(drops);
                    model.handle(Msg::Opened, now)
                }
                DriverMsg::Sink {
                    name,
                    id,
                    sink,
                    reader,
                } => {
                    if self.wanted.get(&name) == Some(&id) {
                        if let Some((old, h)) = self.sinks.insert(name.clone(), (sink, reader)) {
                            h.abort();
                            tokio::spawn(async move {
                                old.close().await;
                            });
                        }
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
        self.wanted.clear();
        for (_, (sink, reader)) in self.sinks.drain() {
            reader.abort();
            sink.close().await;
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
                            Ok(drops) => DriverMsg::Opened(drops),
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
                    let (r, tx) = (self.remote.clone(), self.tx.clone());
                    tokio::spawn(async move {
                        let _ = tx.send(DriverMsg::Model(Msg::Ls(r.ls().await)));
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
                    self.wanted.insert(name.clone(), id);
                    let (r, tx) = (self.remote.clone(), self.tx.clone());
                    tokio::spawn(async move {
                        match r.attach(&name, size).await {
                            Ok((sink, mut events)) => {
                                sink.resize(size).await;
                                sink.write(attach_command(&name).into_bytes()).await;
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
                            Err(_) => {
                                let _ = tx.send(DriverMsg::Model(Msg::AttachFailed { name }));
                            }
                        }
                    });
                }
                Effect::Detach { name } => {
                    self.wanted.remove(&name);
                    if let Some((sink, reader)) = self.sinks.remove(&name) {
                        reader.abort();
                        tokio::spawn(async move {
                            sink.close().await;
                        });
                    }
                }
                Effect::Write { name, bytes } => {
                    if let Some((sink, _)) = self.sinks.get(&name) {
                        sink.write(bytes).await;
                    }
                }
                Effect::ResizeAll(size) => {
                    for (sink, _) in self.sinks.values() {
                        sink.resize(size).await;
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
            [
                "resize 80x24",
                "write ~/.local/bin/zmx attach 'default'\n"
            ]
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
        assert!(
            v.tabs
                .iter()
                .find(|t| t.name == "b")
                .unwrap()
                .attention
        );
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
}
