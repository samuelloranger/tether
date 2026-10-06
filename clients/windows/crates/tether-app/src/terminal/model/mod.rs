use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::time::Duration;

use tether_core::connect::ConnectError;
use tether_core::keymap::{KeyInput, Mods, TetherCommand};
use tether_core::lock::LockGrace;
use tether_core::osc::Progress;
use tether_core::paste::ClipboardSnapshot;
use tether_core::profiles::Machine;
use tether_core::resize::{GridSize, ResizeDebouncer};
use tether_core::tabs::TabStrip;
use tether_core::throttle::{BellThrottle, ToastThrottle};
use tether_core::zmx::ZmxSession;
use tether_term::TabTerminal;

use crate::terminal::geometry::{Layout, TermStyle};
use crate::terminal::status::{ConnStatus, Lamp};

mod events;
mod input;
mod pointer;
mod reconnect;
mod search;
pub(crate) mod send;
mod tabs;

pub use search::SearchView;
pub use send::{SendJob, SendSource};

pub const TICK: Duration = Duration::from_millis(50);
pub const REFRESH_EVERY: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, PartialEq)]
pub enum Screen {
    Terminal,
    Refused { expected: String, got: String },
    Failed { sentence: String },
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum TabJump {
    Next,
    Prev,
    Position(u8),
    Last,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum FontStep {
    Bigger,
    Smaller,
    Reset,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PointerShape {
    Text,
    Hand,
}

#[derive(Debug, Clone, PartialEq)]
pub enum MenuRequest {
    /// Right-click on a tab.
    #[allow(dead_code)] // Slint tab menu → glue::apply_on_ui
    Tab { name: String },
    /// Right-click on a link: Copy link, plus the click's usual Copy or Paste.
    Link { url: String, copy_selection: bool },
}

#[derive(Debug)]
pub enum Msg {
    Opened,
    OpenFailed(ConnectError),
    Ls {
        id: u64,
        result: Result<Vec<ZmxSession>, ConnectError>,
    },
    Attached {
        name: String,
    },
    AttachFailed {
        name: String,
        id: u64,
        reason: String,
    },
    PtyData {
        name: String,
        bytes: Vec<u8>,
    },
    PtyClosed {
        name: String,
    },
    Dropped,
    Tick,
    Focus(bool),
    Modifiers(Mods),
    SelectTab(String),
    #[allow(dead_code)] // Slint shortcuts + unit tests
    TabShortcut(TabJump),
    NewSessionBegin,
    NewSessionCommit(String),
    SearchOpen,
    SearchQuery(String),
    SearchStep {
        older: bool,
    },
    SearchClose,
    NewSessionCancel,
    KillRequested(String),
    KillConfirmed,
    KillCancelled,
    KillDone,
    Key {
        input: KeyInput,
        mods: Mods,
    },
    Ime(String),
    Paste {
        clip: ClipboardSnapshot,
        now_unix: i64,
    },
    Mouse(crate::terminal::mouse::MouseMsg),
    Wheel {
        delta_px: f32,
        mods: Mods,
        x_px: f32,
        y_px: f32,
    },
    WellResized {
        width_px: u32,
        height_px: u32,
        scale: f32,
    },
    StyleChanged(TermStyle),
    Locked,
    Unlocked,
    Resumed,
    Network {
        online: bool,
        route_changed: bool,
    },
    ToastClicked {
        machine: String,
        name: String,
    },
    Retry,
    RetrySession,
    Reconnect,
    Back,
    RedialDue {
        generation: u64,
    },
    DroppedFiles(Vec<PathBuf>),
    SendFiles(Vec<PathBuf>),
    SendStarted {
        names: Vec<String>,
    },
    SendFileStarted {
        index: usize,
    },
    SendFileDone {
        remote: String,
    },
    SendFileFailed {
        reason: String,
    },
    CopySelection,
    PasteClipboard,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Effect {
    Open,
    Close,
    DropConnection,
    Ls,
    Kill {
        name: String,
    },
    Attach {
        name: String,
        id: u64,
        size: GridSize,
    },
    Detach {
        name: String,
    },
    Write {
        name: String,
        bytes: Vec<u8>,
    },
    ResizeAll(GridSize),
    ScheduleRedial {
        after: Duration,
        generation: u64,
    },
    StartSend(SendJob),
    Redraw,
    Ui(UiEffect),
}

#[derive(Debug, Clone, PartialEq)]
pub enum UiEffect {
    Navigate(Screen),
    Home,
    LampFlash,
    FlashTaskbar,
    BringToFront,
    SetTitle(String),
    SetClipboard(String),
    ReadClipboard,
    OpenUrl(String),
    Toast {
        machine: String,
        session: String,
        title: String,
        body: String,
    },
    Taskbar(Option<Progress>),
    FontStep(FontStep),
    Pointer(PointerShape),
    Tooltip(Option<String>),
    Menu(MenuRequest),
    #[allow(dead_code)] // send-file dialog path (platform::pick_files in glue)
    PickFiles,
    AllowIme,
    FocusSearch,
}

#[derive(Debug, Clone, PartialEq)]
pub struct HeaderView {
    pub machine: String,
    pub session: String,
    pub word: &'static str,
    pub lamp: Lamp,
}
#[derive(Debug, Clone, PartialEq)]
pub struct TabView {
    pub name: String,
    pub cwd_leaf: Option<String>,
    pub active: bool,
    pub attention: bool,
    pub progress: Option<Progress>,
}
#[derive(Debug, Clone, PartialEq)]
pub struct EmptyView {
    pub title: String,
    pub body: &'static str,
    pub action: &'static str,
}
#[derive(Debug, Clone, PartialEq)]
pub enum CapsuleView {
    Disconnected,
    Send(String),
}
#[derive(Debug, Clone, PartialEq)]
pub struct TerminalView {
    pub screen: Screen,
    pub header: HeaderView,
    pub tabs: Vec<TabView>,
    pub empty: Option<EmptyView>,
    pub naming: Option<String>,
    pub search: Option<SearchView>,
    pub kill_prompt: Option<String>,
    pub capsule: Option<CapsuleView>,
    pub progress: Option<Progress>,
    pub session_error: Option<String>,
    pub app_keypad: bool,
    pub title: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Chan {
    Opening(u64),
    Live(u64),
}

pub(crate) struct TabState {
    pub term: TabTerminal,
    pub osc_title: Option<String>,
    pub bell: BellThrottle,
    pub attach_error: Option<String>,
}

pub struct TerminalModel {
    machine: Machine,
    style: TermStyle,
    size: GridSize,
    screen: Screen,
    status: ConnStatus,
    /// None until the first `zmx ls` of this open answers.
    strip: Option<TabStrip>,
    pub(crate) tabs: HashMap<String, TabState>,
    channels: HashMap<String, Chan>,
    next_channel: u64,
    view_tick: u64,
    focused: bool,
    mods: Mods,
    last_refresh: Duration,
    /// Sessions created from this window: their first attach is followed by a refresh.
    created_here: HashSet<String>,
    naming: Option<String>,
    search: Option<search::SearchBar>,
    kill_prompt: Option<String>,
    opening: bool,
    attempt: usize,
    generation: u64,
    lock: LockGrace,
    lock_detached: bool,
    ls_seen: u64,
    resize: ResizeDebouncer,
    layout: Option<Layout>,
    well_px: Option<(u32, u32, f32)>,
    toasts: ToastThrottle,
    session_cwds: HashMap<String, String>,
    send: Option<send::SendState>,
    /// When a finished send's capsule appeared; it leaves after CAPSULE_LINGER or a keystroke.
    capsule_shown: Option<Duration>,
    pointer: crate::terminal::mouse::PointerState,
    pub(crate) hover: Option<(usize, usize, usize)>,
    blink_on: bool,
    blink_at: Duration,
}

impl TerminalModel {
    pub fn new(machine: Machine, style: TermStyle, size: GridSize) -> (Self, Vec<Effect>) {
        let m = Self {
            machine,
            style,
            size,
            screen: Screen::Terminal,
            status: ConnStatus::Connecting,
            strip: None,
            tabs: HashMap::new(),
            channels: HashMap::new(),
            next_channel: 0,
            view_tick: 0,
            focused: true,
            mods: Mods::default(),
            last_refresh: Duration::ZERO,
            created_here: HashSet::new(),
            naming: None,
            search: None,
            kill_prompt: None,
            opening: true,
            attempt: 0,
            generation: 0,
            lock: LockGrace::default(),
            lock_detached: false,
            ls_seen: 0,
            resize: ResizeDebouncer::default(),
            layout: None,
            well_px: None,
            toasts: ToastThrottle::default(),
            session_cwds: HashMap::new(),
            send: None,
            capsule_shown: None,
            pointer: crate::terminal::mouse::PointerState::default(),
            hover: None,
            blink_on: true,
            blink_at: Duration::ZERO,
        };
        (m, vec![Effect::Open])
    }

    pub fn handle(&mut self, msg: Msg, now: Duration) -> Vec<Effect> {
        let mut fx = Vec::new();
        match msg {
            Msg::Opened => self.on_opened(now, &mut fx),
            Msg::OpenFailed(err) => self.on_open_failed(err, &mut fx),
            Msg::Ls { id, result } => {
                if id > self.ls_seen {
                    self.ls_seen = id;
                    self.on_ls(result, now, &mut fx);
                }
            }
            Msg::Attached { name } => self.on_attached(&name, &mut fx),
            Msg::AttachFailed { name, id, reason } => {
                self.on_attach_failed(&name, id, &reason, &mut fx);
            }
            Msg::PtyData { name, bytes } => self.on_pty_data(&name, &bytes, now, &mut fx),
            Msg::PtyClosed { name } => {
                self.channels.remove(&name);
                fx.push(Effect::Ls);
            }
            Msg::Dropped => self.on_dropped(&mut fx),
            Msg::Tick => self.on_tick(now, &mut fx),
            Msg::Focus(f) => self.on_focus(f, now, &mut fx),
            Msg::Modifiers(mods) => self.on_modifiers(mods, &mut fx),
            Msg::SelectTab(name) => self.activate(&name, &mut fx),
            Msg::TabShortcut(jump) => self.on_jump(jump, &mut fx),
            Msg::NewSessionBegin => self.on_new_begin(),
            Msg::NewSessionCommit(name) => self.on_new_commit(&name, now, &mut fx),
            Msg::NewSessionCancel => self.naming = None,
            Msg::KillRequested(name) => self.kill_prompt = Some(name),
            Msg::KillConfirmed => self.on_kill_confirmed(&mut fx),
            Msg::KillCancelled => self.kill_prompt = None,
            Msg::KillDone => fx.push(Effect::Ls),
            Msg::Key { input, mods } => self.on_key(&input, mods, now, &mut fx),
            Msg::Ime(text) => {
                self.snap_active_to_bottom();
                self.write_active(text.into_bytes(), &mut fx);
                fx.push(Effect::Ui(UiEffect::AllowIme));
            }
            Msg::Paste { clip, now_unix } => self.on_paste(clip, now_unix, &mut fx),
            Msg::Mouse(m) => self.on_mouse(m, &mut fx),
            Msg::Wheel {
                delta_px,
                mods,
                x_px,
                y_px,
            } => self.on_wheel(delta_px, mods, x_px, y_px, &mut fx),
            Msg::WellResized {
                width_px,
                height_px,
                scale,
            } => self.on_well_resized(width_px, height_px, scale, now, &mut fx),
            Msg::StyleChanged(style) => self.on_style(style, now, &mut fx),
            Msg::Locked => self.lock.on_lock(now),
            Msg::Unlocked => self.on_unlock(&mut fx),
            Msg::Resumed => self.force_redial(&mut fx),
            Msg::Network {
                online,
                route_changed,
            } => self.on_network(online, route_changed, &mut fx),
            Msg::ToastClicked { machine, name } => {
                fx.push(Effect::Ui(UiEffect::BringToFront));
                if machine == self.machine.id.to_string() {
                    self.activate(&name, &mut fx);
                }
            }
            Msg::Retry => self.on_retry(&mut fx),
            Msg::RetrySession => self.retry_session(&mut fx),
            Msg::Reconnect => self.on_reconnect_clicked(&mut fx),
            Msg::Back => {
                fx.push(Effect::Ui(UiEffect::Taskbar(None)));
                fx.push(Effect::Close);
                fx.push(Effect::Ui(UiEffect::Home));
            }
            Msg::RedialDue { generation } => self.on_redial_due(generation, &mut fx),
            Msg::DroppedFiles(paths) | Msg::SendFiles(paths) => self.on_send_files(paths, &mut fx),
            Msg::SendStarted { names } => self.on_send_started(names),
            Msg::SendFileStarted { index } => self.on_send_file_started(index),
            Msg::SendFileDone { remote } => self.on_send_file_done(&remote, now, &mut fx),
            Msg::SendFileFailed { reason } => self.on_send_file_failed(reason, now),
            Msg::CopySelection => self.on_command(
                TetherCommand::Copy,
                Mods {
                    shift: false,
                    alt: false,
                    ctrl: true,
                },
                &mut fx,
            ),
            Msg::PasteClipboard => fx.push(Effect::Ui(UiEffect::ReadClipboard)),
            Msg::SearchOpen => self.on_search_open(&mut fx),
            Msg::SearchQuery(q) => self.on_search_query(q, now, &mut fx),
            Msg::SearchStep { older } => self.on_search_step(older, now, &mut fx),
            Msg::SearchClose => self.on_search_close(&mut fx),
        }
        self.sync_search(now);
        fx
    }

    fn on_opened(&mut self, now: Duration, fx: &mut Vec<Effect>) {
        self.opening = false;
        let was_reconnect = matches!(
            self.status,
            ConnStatus::Reconnecting | ConnStatus::Disconnected
        );
        self.status = ConnStatus::Connected;
        self.attempt = 0;
        self.last_refresh = now;
        fx.push(Effect::Ls);
        if was_reconnect && !self.lock_detached {
            self.reattach_all(fx);
        }
        if was_reconnect {
            fx.push(Effect::Redraw);
        }
    }

    fn on_open_failed(&mut self, err: ConnectError, fx: &mut Vec<Effect>) {
        self.opening = false;
        if self.strip.is_some() || self.status == ConnStatus::Reconnecting {
            return self.on_redial_failed(err, fx);
        }
        let screen = match err {
            ConnectError::HostKeyChanged { expected, got } => Screen::Refused { expected, got },
            other => Screen::Failed {
                sentence: other.sentence(),
            },
        };
        self.screen = screen.clone();
        fx.push(Effect::Ui(UiEffect::Taskbar(None)));
        fx.push(Effect::Ui(UiEffect::Navigate(screen)));
    }

    fn on_retry(&mut self, fx: &mut Vec<Effect>) {
        self.screen = Screen::Terminal;
        self.status = ConnStatus::Connecting;
        self.opening = true;
        fx.push(Effect::Ui(UiEffect::Navigate(Screen::Terminal)));
        fx.push(Effect::Open);
    }

    fn on_ls(
        &mut self,
        result: Result<Vec<ZmxSession>, ConnectError>,
        now: Duration,
        fx: &mut Vec<Effect>,
    ) {
        self.last_refresh = now;
        if let Ok(sessions) = &result {
            self.session_cwds = sessions
                .iter()
                .map(|s| (s.name.clone(), s.display_cwd().to_string()))
                .collect();
        }
        if self.strip.is_none() {
            let strip = match result {
                Ok(sessions) => TabStrip::from_sessions(sessions.as_slice()),
                Err(_) => TabStrip::from_ls_failure(),
            };
            let first = strip.active.clone();
            self.strip = Some(strip);
            if let Some(name) = first {
                self.activate(&name, fx);
            }
            fx.push(Effect::Redraw);
            return;
        }
        if let Ok(sessions) = result {
            self.merge(sessions, now, fx);
        }
    }

    fn on_attached(&mut self, name: &str, fx: &mut Vec<Effect>) {
        if let Some(Chan::Opening(id)) = self.channels.get(name).copied() {
            self.channels.insert(name.to_string(), Chan::Live(id));
        }
        if let Some(bytes) = self
            .send
            .as_mut()
            .and_then(|s| (s.target == name).then(|| s.pending_paste.take()).flatten())
        {
            fx.push(Effect::Write {
                name: name.to_string(),
                bytes,
            });
        }
        if self.created_here.remove(name) {
            fx.push(Effect::Ls);
        }
    }

    fn on_attach_failed(&mut self, name: &str, id: u64, reason: &str, fx: &mut Vec<Effect>) {
        match self.channels.get(name) {
            Some(Chan::Opening(current) | Chan::Live(current)) if *current == id => {}
            _ => return,
        }
        self.channels.remove(name);
        if let Some(tab) = self.tabs.get_mut(name) {
            tab.attach_error = Some(format!("Couldn't open this session: {reason}"));
        }
        if self
            .send
            .as_ref()
            .is_some_and(|s| s.target == name && s.pending_paste.is_some())
        {
            if let Some(state) = self.send.as_mut() {
                state.pending_paste = None;
            }
            self.capsule_shown = Some(Duration::ZERO);
            if let Some(queue) = self.send.as_mut().and_then(|s| s.queue.as_mut()) {
                queue.on_failed("the session isn't open");
            }
        }
        fx.push(Effect::Redraw);
    }

    fn retry_session(&mut self, fx: &mut Vec<Effect>) {
        let Some(name) = self.active_name().map(str::to_string) else {
            return;
        };
        if self
            .tabs
            .get(&name)
            .is_none_or(|t| t.attach_error.is_none())
        {
            return;
        }
        if let Some(tab) = self.tabs.get_mut(&name) {
            tab.attach_error = None;
        }
        self.channels.remove(&name);
        self.open_channel(&name, fx);
        fx.push(Effect::Redraw);
    }

    pub(crate) fn active_name(&self) -> Option<&str> {
        self.strip.as_ref().and_then(|s| s.active.as_deref())
    }

    pub(crate) fn is_live(&self, name: &str) -> bool {
        self.status == ConnStatus::Connected
            && matches!(self.channels.get(name), Some(Chan::Live(_)))
    }

    /// Input goes to the active tab only while its channel is up; it is dropped, not queued.
    pub(crate) fn write_active(&mut self, bytes: Vec<u8>, fx: &mut Vec<Effect>) {
        let Some(name) = self.active_name().map(str::to_string) else {
            return;
        };
        if self.is_live(&name) {
            fx.push(Effect::Write { name, bytes });
        }
    }

    pub(crate) fn open_channel(&mut self, name: &str, fx: &mut Vec<Effect>) {
        if self.status != ConnStatus::Connected || self.channels.contains_key(name) {
            return;
        }
        self.tabs
            .entry(name.to_string())
            .or_insert_with(|| TabState {
                term: TabTerminal::new(self.size, self.style.theme),
                osc_title: None,
                bell: BellThrottle::default(),
                attach_error: None,
            });
        self.next_channel += 1;
        self.channels
            .insert(name.to_string(), Chan::Opening(self.next_channel));
        fx.push(Effect::Attach {
            name: name.to_string(),
            id: self.next_channel,
            size: self.size,
        });
    }

    pub(crate) fn close_channel(&mut self, name: &str, fx: &mut Vec<Effect>) {
        if self.channels.remove(name).is_some() {
            fx.push(Effect::Detach {
                name: name.to_string(),
            });
        }
    }

    pub fn view(&self) -> TerminalView {
        let session = self.active_name().unwrap_or("").to_string();
        let tabs = self
            .strip
            .as_ref()
            .map(|s| {
                s.tabs
                    .iter()
                    .map(|t| TabView {
                        name: t.name.clone(),
                        cwd_leaf: t.cwd_leaf.clone(),
                        active: s.active.as_deref() == Some(&t.name),
                        attention: t.attention,
                        progress: self
                            .tabs
                            .get(&t.name)
                            .and_then(|x| x.term.reports().progress),
                    })
                    .collect()
            })
            .unwrap_or_default();
        let empty = self
            .strip
            .as_ref()
            .filter(|s| s.tabs.is_empty())
            .map(|_| EmptyView {
                title: format!("No session on {}", self.machine.name),
                body: "Nothing runs until you start one.",
                action: "New session",
            });
        let capsule = if self.status == ConnStatus::Disconnected {
            Some(CapsuleView::Disconnected)
        } else {
            self.send_capsule().map(CapsuleView::Send)
        };
        let session_error = self
            .active_name()
            .and_then(|n| self.tabs.get(n).and_then(|t| t.attach_error.clone()));
        let app_keypad = self
            .active_name()
            .and_then(|n| self.tabs.get(n))
            .is_some_and(|t| t.term.context().app_keypad);
        TerminalView {
            screen: self.screen.clone(),
            header: HeaderView {
                machine: self.machine.name.clone(),
                session: session.clone(),
                word: self.status.word(),
                lamp: self.status.lamp(),
            },
            tabs,
            empty,
            naming: self.naming.clone(),
            search: self.search_view(),
            kill_prompt: self.kill_prompt.clone(),
            capsule,
            progress: self
                .active_name()
                .and_then(|n| self.tabs.get(n))
                .and_then(|t| t.term.reports().progress),
            session_error,
            app_keypad,
            title: self.window_title(),
        }
    }

    pub(crate) fn window_title(&self) -> String {
        match self.active_name() {
            None => self.machine.name.clone(),
            Some(s) => {
                let osc = self.tabs.get(s).and_then(|t| t.osc_title.as_deref());
                match osc {
                    Some(title) => format!("{} · {} · {}", self.machine.name, s, title),
                    None => format!("{} · {}", self.machine.name, s),
                }
            }
        }
    }

    pub fn frame_job(&self) -> Option<crate::terminal::frame::FrameJob> {
        use crate::terminal::frame::FrameJob;
        let l = self.layout?;
        let tab = self
            .active_name()
            .and_then(|n| self.tabs.get(n))
            .filter(|_| self.screen == Screen::Terminal);
        let Some(tab) = tab else {
            return Some(FrameJob::Clear {
                width: l.width_px,
                height: l.height_px,
                background: self.style.theme.background,
            });
        };
        let style = tether_term::RenderStyle {
            theme: self.style.theme,
            font: self.style.font,
            size_px: l.size_px,
            line_spacing: self.style.line_spacing,
            padding_px: l.padding_px,
            cursor: self.style.cursor,
            cursor_on: self.focused && (!self.style.blink || self.blink_on),
            hover_link: self.hover,
        };
        Some(FrameJob::Grid {
            snapshot: tab.term.snapshot(),
            style,
            width: l.width_px,
            height: l.height_px,
        })
    }

    pub(crate) fn grid(&self) -> GridSize {
        self.size
    }

    #[allow(dead_code)] // pointer tests read the computed layout
    pub fn layout(&self) -> Option<Layout> {
        self.layout
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::terminal::geometry::TermStyle;
    use crate::terminal::testkit::*;

    pub fn t(ms: u64) -> Duration {
        Duration::from_millis(ms)
    }

    pub fn has_attach(fx: &[Effect], want: &str) -> bool {
        fx.iter()
            .any(|e| matches!(e, Effect::Attach { name, .. } if name == want))
    }

    /// Open → Opened → first ls, returning the model live on `sessions`.
    pub fn live(sessions: Vec<ZmxSession>) -> TerminalModel {
        let (mut m, fx) = TerminalModel::new(machine(), TermStyle::default(), grid());
        assert!(matches!(fx.as_slice(), [Effect::Open, ..]));
        m.handle(Msg::Opened, t(0));
        let fx = m.handle(
            Msg::Ls {
                id: 1,
                result: Ok(sessions),
            },
            t(1),
        );
        for e in fx {
            if let Effect::Attach { name, .. } = e {
                m.handle(Msg::Attached { name }, t(2));
            }
        }
        m
    }

    #[test]
    fn starts_connecting_on_the_terminal_screen() {
        let (m, fx) = TerminalModel::new(machine(), TermStyle::default(), grid());
        assert_eq!(fx, vec![Effect::Open]);
        let v = m.view();
        assert_eq!(v.screen, Screen::Terminal);
        assert_eq!(v.header.word, "connecting");
        assert_eq!(v.header.machine, "devbox");
    }

    #[test]
    fn opened_lists_sessions_and_reads_connected() {
        let (mut m, _) = TerminalModel::new(machine(), TermStyle::default(), grid());
        let fx = m.handle(Msg::Opened, t(0));
        assert_eq!(fx, vec![Effect::Ls]);
        assert_eq!(m.view().header.word, "connected");
    }

    #[test]
    fn default_wins_the_first_tab() {
        let (mut m, _) = TerminalModel::new(machine(), TermStyle::default(), grid());
        m.handle(Msg::Opened, t(0));
        let fx = m.handle(
            Msg::Ls {
                id: 1,
                result: Ok(vec![session("build", 300), session("default", 100)]),
            },
            t(1),
        );
        assert!(has_attach(&fx, "default"));
        assert!(!has_attach(&fx, "build"));
        assert_eq!(
            m.view()
                .tabs
                .iter()
                .map(|t| t.name.as_str())
                .collect::<Vec<_>>(),
            ["default", "build"]
        );
    }

    #[test]
    fn newest_wins_without_default() {
        let (mut m, _) = TerminalModel::new(machine(), TermStyle::default(), grid());
        m.handle(Msg::Opened, t(0));
        let fx = m.handle(
            Msg::Ls {
                id: 1,
                result: Ok(vec![session("a", 100), session("b", 200)]),
            },
            t(1),
        );
        assert!(has_attach(&fx, "b"));
    }

    #[test]
    fn empty_host_attaches_nothing_and_shows_the_empty_state() {
        let m = live(vec![]);
        let v = m.view();
        let empty = v.empty.expect("empty state");
        assert_eq!(empty.title, "No session on devbox");
        assert_eq!(empty.body, "Nothing runs until you start one.");
        assert_eq!(empty.action, "New session");
        assert!(v.tabs.is_empty());
    }

    #[test]
    fn keystrokes_on_an_empty_host_reach_nothing() {
        let mut m = live(vec![]);
        let fx = m.handle(
            Msg::Key {
                input: KeyInput::Char {
                    unmodified: 'a',
                    produced: Some("a".into()),
                    digit: None,
                },
                mods: Mods::default(),
            },
            t(5),
        );
        assert!(!fx.iter().any(|e| matches!(e, Effect::Write { .. })));
    }

    #[test]
    fn ls_failure_opens_default() {
        let (mut m, _) = TerminalModel::new(machine(), TermStyle::default(), grid());
        m.handle(Msg::Opened, t(0));
        let fx = m.handle(
            Msg::Ls {
                id: 1,
                result: Err(ConnectError::Transport("exec".into())),
            },
            t(1),
        );
        assert!(has_attach(&fx, "default"));
    }

    #[test]
    fn host_key_change_goes_to_the_refused_screen() {
        let (mut m, _) = TerminalModel::new(machine(), TermStyle::default(), grid());
        let fx = m.handle(
            Msg::OpenFailed(ConnectError::HostKeyChanged {
                expected: "aa".into(),
                got: "bb".into(),
            }),
            t(0),
        );
        let refused = Screen::Refused {
            expected: "aa".into(),
            got: "bb".into(),
        };
        assert!(fx.contains(&Effect::Ui(UiEffect::Navigate(refused.clone()))));
        assert_eq!(m.view().screen, refused);
    }

    #[test]
    fn other_failures_go_to_couldnt_connect_with_the_core_sentence() {
        let (mut m, _) = TerminalModel::new(machine(), TermStyle::default(), grid());
        m.handle(Msg::OpenFailed(ConnectError::AuthRejected), t(0));
        assert_eq!(
            m.view().screen,
            Screen::Failed {
                sentence: ConnectError::AuthRejected.sentence()
            }
        );
    }

    #[test]
    fn retry_reopens_and_back_goes_home() {
        let (mut m, _) = TerminalModel::new(machine(), TermStyle::default(), grid());
        m.handle(Msg::OpenFailed(ConnectError::Timeout), t(0));
        assert_eq!(
            m.handle(Msg::Retry, t(1)),
            vec![
                Effect::Ui(UiEffect::Navigate(Screen::Terminal)),
                Effect::Open
            ]
        );
        assert_eq!(m.view().header.word, "connecting");
        assert_eq!(
            m.handle(Msg::Back, t(2)),
            vec![
                Effect::Ui(UiEffect::Taskbar(None)),
                Effect::Close,
                Effect::Ui(UiEffect::Home)
            ]
        );
    }

    #[test]
    fn title_is_machine_dot_session() {
        let m = live(vec![session("default", 1)]);
        assert_eq!(m.view().title, "devbox · default");
        assert_eq!(m.view().header.session, "default");
    }

    #[test]
    fn an_older_ls_is_dropped() {
        let mut m = live(vec![session("default", 1)]);
        m.handle(
            Msg::Ls {
                id: 3,
                result: Ok(vec![session("default", 1), session("later", 2)]),
            },
            t(10),
        );
        assert_eq!(m.view().tabs.len(), 2);
        m.handle(
            Msg::Ls {
                id: 2,
                result: Ok(vec![session("default", 1)]),
            },
            t(11),
        );
        assert_eq!(m.view().tabs.len(), 2);
    }

    #[test]
    fn a_failed_attach_names_the_reason_and_a_stale_id_is_ignored() {
        let (mut m, _) = TerminalModel::new(machine(), TermStyle::default(), grid());
        m.handle(Msg::Opened, t(0));
        let fx = m.handle(
            Msg::Ls {
                id: 1,
                result: Ok(vec![session("default", 1)]),
            },
            t(1),
        );
        let id = fx.iter().find_map(|e| match e {
            Effect::Attach { name, id, .. } if name == "default" => Some(*id),
            _ => None,
        });
        let id = id.unwrap();
        m.handle(
            Msg::AttachFailed {
                name: "default".into(),
                id: id + 1,
                reason: "stale".into(),
            },
            t(2),
        );
        assert_eq!(m.view().session_error, None);
        m.handle(
            Msg::AttachFailed {
                name: "default".into(),
                id,
                reason: "no space".into(),
            },
            t(3),
        );
        assert_eq!(
            m.view().session_error.as_deref(),
            Some("Couldn't open this session: no space")
        );
        assert!(has_attach(&m.handle(Msg::RetrySession, t(4)), "default"));
        assert_eq!(m.view().session_error, None);
    }

    #[test]
    fn unlock_reattaches_when_a_reconnect_arrived_while_locked() {
        let mut m = live(vec![session("default", 1)]);
        m.handle(Msg::Locked, t(0));
        m.handle(Msg::Dropped, t(100));
        m.handle(Msg::Tick, t(15_100));
        let fx = m.handle(Msg::Opened, t(16_000));
        assert!(!has_attach(&fx, "default"));
        assert!(has_attach(&m.handle(Msg::Unlocked, t(17_000)), "default"));
    }

    #[test]
    fn failed_and_refused_clear_taskbar_progress() {
        let (mut m, _) = TerminalModel::new(machine(), TermStyle::default(), grid());
        let fx = m.handle(Msg::OpenFailed(ConnectError::Timeout), t(0));
        assert!(fx.contains(&Effect::Ui(UiEffect::Taskbar(None))));
        let (mut m, _) = TerminalModel::new(machine(), TermStyle::default(), grid());
        let fx = m.handle(
            Msg::OpenFailed(ConnectError::HostKeyChanged {
                expected: "a".into(),
                got: "b".into(),
            }),
            t(0),
        );
        assert!(fx.contains(&Effect::Ui(UiEffect::Taskbar(None))));
    }
}
