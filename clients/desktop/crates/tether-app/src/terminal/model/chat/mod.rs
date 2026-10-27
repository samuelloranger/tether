//! Chats with the host's agent, as tabs beside the sessions. One ACP stream per open chat, over an
//! exec channel on the terminal connection (`tether acp attach`); every other host command runs
//! on the control connection. The protocol, transcript and stores are `tether_core::acp`.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use tether_core::acp::agent::{self, AgentProfile, CLAUDE};
use tether_core::acp::client::Outbound;
use tether_core::acp::defaults::ChatDefaults;
use tether_core::acp::files::ChatFiles;
use tether_core::acp::host::{self, ChatSummary};
use tether_core::acp::images::ImageAttachment;
use tether_core::acp::message::{AcpId, ConfigOption};
use tether_core::acp::options::{OptionsCache, OptionsDraft, StartOptions};
use tether_core::connect::ConnectError;

#[cfg(debug_assertions)]
mod devsample;
mod newchat;
mod rows;
mod screen;
mod session;
pub mod view;

pub use newchat::NewChat;
use session::Session;
pub use view::{ChatScreen, Pixels};

/// While the host has chats its status is read this often, the iOS drawer's tick.
pub const POLL_WITH_CHATS: Duration = Duration::from_secs(5);
pub const POLL_WITHOUT: Duration = Duration::from_secs(10);
/// Streaming redraws at most this often; the newest state wins.
pub const FRAME: Duration = Duration::from_millis(33);
const FOLDER_COPIED_FOR: Duration = Duration::from_millis(1300);

#[derive(Debug, Clone, PartialEq)]
pub enum ExecTag {
    Status,
    List,
    Inspect {
        name: String,
        generation: u64,
        why: InspectWhy,
    },
    Answers {
        name: String,
        generation: u64,
        why: AnswersWhy,
    },
    Files {
        name: String,
    },
    Kill {
        name: String,
    },
    NewChat {
        request: u64,
        step: newchat::Step,
    },
    /// The words a running turn shows (see `acp::verbs`).
    Verbs,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InspectWhy {
    /// Whether the stored snapshot may be resumed.
    Resume,
    /// The identity a fresh log's snapshots are stored under.
    Learn,
    /// What a lost stream means.
    Loss,
}

#[derive(Debug, Clone, PartialEq)]
pub enum AnswersWhy {
    Dial,
    /// A write of this answer failed: the host may have taken one first.
    Adopt(AcpId),
}

/// What a failed write takes back; the line itself says how (`Outbound::undo`).
#[derive(Debug, Clone, PartialEq)]
pub enum WriteTag {
    Request(Outbound),
    Prompt {
        out: Outbound,
        text: String,
        images: Vec<ImageAttachment>,
        lost: usize,
    },
    /// A permission or question answer: the host may have taken one first.
    Answer(Outbound),
    Cancel(Outbound),
    Config {
        out: Outbound,
        id: String,
        value: String,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub enum ImageSource {
    File(PathBuf),
    Bytes(Vec<u8>),
}

#[derive(Debug, Clone, PartialEq)]
pub enum ChatJob {
    Exec {
        tag: ExecTag,
        command: String,
    },
    Dial {
        name: String,
        generation: u64,
        command: String,
    },
    Write {
        name: String,
        generation: u64,
        bytes: Vec<u8>,
        tag: Option<WriteTag>,
        /// Report the write once it landed: a Stop is journaled only after its cancel is sent.
        ack: bool,
    },
    Hangup {
        name: String,
    },
    Encode {
        name: String,
        key: String,
        source: ImageSource,
    },
    Thumb {
        id: String,
        path: PathBuf,
    },
}

#[derive(Debug)]
pub enum ChatMsg {
    // From the window.
    Select(String),
    Delete(String),
    /// Home's Chat on a machine card: the dialog opens once the session list is in.
    NewChatWhenReady,
    DeleteConfirmed,
    DeleteCancelled,
    NewChat(u8),
    Toggle(String),
    /// A task line in the strip: open the tool row it stands for.
    OpenTool(String),
    /// Debug builds: show the canned chat.
    #[cfg(debug_assertions)]
    DevSample(String),
    OpenLink(String),
    OpenImage(String),
    CloseViewer,
    CopyFolder,
    Earlier,
    Following(bool),
    Retry(String),
    Discard(String),
    SignInRetry,
    DismissNotice,
    Reconnect,
    DraftEdited {
        text: String,
        cursor_byte: usize,
    },
    Send,
    Stop,
    AttachFiles(Vec<PathBuf>),
    AttachBytes(Vec<u8>),
    RemoveAttachment(String),
    DismissAttachError,
    PalettePick(usize),
    PaletteClose,
    Approve(String),
    Review,
    CloseReview,
    QuestionChoose {
        field: String,
        value: String,
    },
    QuestionText {
        name: String,
        text: String,
    },
    QuestionFlag {
        name: String,
        value: bool,
    },
    QuestionOpenCustom(String),
    QuestionSubmit,
    QuestionDecline,
    Controls,
    ControlsClose,
    ControlsChoose {
        id: String,
        value: String,
    },
    ControlsDismiss(String),
    ControlsCommand(String),
    BypassConfirmed,
    BypassCancelled,
    NewChatStart,
    NewChatCancel,
    NewChatMode(u8),
    NewChatFolder(String),
    /// The agent picker: an agent key.
    NewChatAgent(String),
    /// The opened Options row: one menu's choice.
    NewChatPick {
        id: String,
        value: String,
    },
    NewChatReset,
    NewChatContinue(String),
    NewChatRetry,
    /// Esc with the chat in front: the topmost overlay closes.
    Escape,
    // From the driver.
    ExecDone {
        tag: ExecTag,
        result: Result<String, ConnectError>,
    },
    Dialed {
        name: String,
        generation: u64,
        result: Result<(), String>,
    },
    Data {
        name: String,
        generation: u64,
        bytes: Vec<u8>,
    },
    Closed {
        name: String,
        generation: u64,
    },
    WriteFailed {
        name: String,
        generation: u64,
        tag: WriteTag,
    },
    Written {
        name: String,
        generation: u64,
        tag: WriteTag,
    },
    Encoded {
        name: String,
        key: String,
        result: Result<(ImageAttachment, Arc<Pixels>), String>,
    },
    Thumb {
        id: String,
        pixels: Option<Arc<Pixels>>,
    },
}

/// What the chats ask of the terminal model around them.
#[derive(Debug, Default)]
pub struct Out {
    pub jobs: Vec<ChatJob>,
    pub open_url: Option<String>,
    pub clipboard: Option<String>,
    pub pick_images: bool,
    /// The chat left the front: the terminal's own tab comes back.
    pub show_terminal: bool,
    pub toasts: Vec<(String, String, String)>,
    /// Options the user changed and the agent confirmed: `(agent key, option id, value)`.
    pub remembered: Vec<(String, String, String)>,
    /// The options a settled session offers, per agent key, for the New chat dialog's menus.
    pub options_seen: Vec<(String, Vec<ConfigOption>)>,
    /// The agent a chat was just started with: the next dialog opens on it.
    pub picked_agent: Option<String>,
}

pub struct Chats {
    files: Option<ChatFiles>,
    defaults: ChatDefaults,
    options_cache: OptionsCache,
    /// The host as the options cache and the chat files name it (`host:port`).
    scope: String,
    last_agent: String,
    /// The host as messages name it.
    host: String,
    listed: Vec<ChatSummary>,
    /// Chats started here that the host has not listed yet.
    provisional: Vec<ChatSummary>,
    status_supported: bool,
    polled_at: Option<Duration>,
    polling: bool,
    sessions: HashMap<String, Session>,
    active: Option<String>,
    new_chat: Option<NewChat>,
    /// Asked of the host the first time a chat opens; empty until then, and then Tether's own.
    verbs: Vec<String>,
    verbs_asked: bool,
    delete_prompt: Option<String>,
    controls_open: bool,
    bypass: Option<(String, String)>,
    review: bool,
    viewer: Option<String>,
    thumbs: HashMap<String, Arc<Pixels>>,
    thumbs_asked: HashSet<String>,
    follow_seq: u64,
    focus_seq: u64,
    draft_seq: u64,
    folder_copied_at: Option<Duration>,
    waiting_seen: HashSet<String>,
    /// The first listing after a connect only learns what is already waiting: nothing toasts.
    baseline: bool,
    new_chat_when_ready: bool,
    dirty: bool,
    shown_at: Option<Duration>,
    last_screen: Option<ChatScreen>,
    connected: bool,
    focused: bool,
}

impl Chats {
    pub fn set_defaults(&mut self, defaults: ChatDefaults) {
        self.defaults = defaults;
    }

    pub fn set_options_cache(&mut self, cache: OptionsCache, scope: &str, last_agent: &str) {
        self.options_cache = cache;
        self.scope = scope.to_string();
        self.last_agent = last_agent.to_string();
    }

    pub fn remember(&mut self, agent: &str, id: &str, value: &str) {
        self.defaults.remember(agent, id, value);
    }

    /// Keeps the model's copy of the cache current; true when the list changed and is to be saved.
    pub fn cache_options(&mut self, agent: &str, options: &[ConfigOption]) -> bool {
        self.options_cache.store(&self.scope, agent, options)
    }

    pub fn scope(&self) -> &str {
        &self.scope
    }

    fn draft_for(&self, agent: &AgentProfile) -> OptionsDraft {
        OptionsDraft::new(
            agent,
            &self.defaults,
            self.options_cache.get(&self.scope, agent.key),
        )
    }

    /// Agents of chats this device started.
    fn local_agents(&self, names: &[String]) -> HashMap<String, String> {
        self.files
            .as_ref()
            .map(|f| f.agents(names))
            .unwrap_or_default()
    }

    fn agent_of(&self, chat: &ChatSummary) -> Option<&'static AgentProfile> {
        let local = self.files.as_ref().and_then(|f| f.agent(&chat.name));
        agent::resolve(local.as_deref(), &chat.spawn)
    }

    pub fn new(files: Option<ChatFiles>, host: &str) -> Self {
        Self {
            files,
            defaults: ChatDefaults::default(),
            options_cache: OptionsCache::default(),
            scope: host.to_string(),
            last_agent: String::new(),
            host: host.to_string(),
            listed: Vec::new(),
            provisional: Vec::new(),
            status_supported: true,
            polled_at: None,
            polling: false,
            sessions: HashMap::new(),
            active: None,
            new_chat: None,
            verbs: Vec::new(),
            verbs_asked: false,
            delete_prompt: None,
            controls_open: false,
            bypass: None,
            review: false,
            viewer: None,
            thumbs: HashMap::new(),
            thumbs_asked: HashSet::new(),
            follow_seq: 0,
            focus_seq: 0,
            draft_seq: 0,
            folder_copied_at: None,
            waiting_seen: HashSet::new(),
            baseline: true,
            new_chat_when_ready: false,
            dirty: false,
            shown_at: None,
            last_screen: None,
            connected: false,
            focused: true,
        }
    }

    pub fn active(&self) -> Option<&str> {
        self.active.as_deref()
    }

    pub fn is_chat(&self, name: &str) -> bool {
        self.tab_names().iter().any(|n| n == name)
    }

    pub fn tab_names(&self) -> Vec<String> {
        self.ordered().into_iter().map(|c| c.name.clone()).collect()
    }

    /// Oldest left, like the session tabs; chats started here sit at the end until listed.
    fn ordered(&self) -> Vec<&ChatSummary> {
        let mut chats: Vec<&ChatSummary> = self.listed.iter().collect();
        chats.sort_by_key(|c| c.created);
        for p in &self.provisional {
            if !chats.iter().any(|c| c.name == p.name) {
                chats.push(p);
            }
        }
        chats
    }

    pub fn on_connected(&mut self, now: Duration, out: &mut Out) {
        self.connected = true;
        self.baseline = true;
        // The first read waits for the next tick, behind the session list.
        self.polled_at = None;
        if let Some(name) = self.active.clone() {
            self.with_session(&name, now, out, |s, ctx| s.reconnect_if_lost(ctx));
        }
    }

    pub fn on_dropped(&mut self, now: Duration, out: &mut Out) {
        self.connected = false;
        self.polling = false;
        let names: Vec<String> = self.sessions.keys().cloned().collect();
        for name in names {
            self.with_session(&name, now, out, |s, ctx| s.background(ctx));
        }
    }

    pub fn on_focus(&mut self, focused: bool, now: Duration, out: &mut Out) {
        self.focused = focused;
        if focused && let Some(name) = self.active.clone() {
            self.with_session(&name, now, out, |s, ctx| s.reconnect_if_lost(ctx));
        }
    }

    pub fn on_tick(&mut self, now: Duration, out: &mut Out) {
        let every = if self.has_chats() {
            POLL_WITH_CHATS
        } else {
            POLL_WITHOUT
        };
        if self
            .polled_at
            .is_none_or(|t| now.saturating_sub(t) >= every)
        {
            self.poll(now, out);
        }
        if self
            .folder_copied_at
            .is_some_and(|t| now.saturating_sub(t) >= FOLDER_COPIED_FOR)
        {
            self.folder_copied_at = None;
            self.dirty = true;
        }
        let names: Vec<String> = self.sessions.keys().cloned().collect();
        for name in names {
            self.with_session(&name, now, out, |s, ctx| s.tick(ctx));
        }
        if let Some(nc) = self.new_chat.as_mut()
            && let Some(job) = nc.tick(now)
        {
            out.jobs.push(job);
            self.dirty = true;
        }
    }

    fn has_chats(&self) -> bool {
        !self.listed.is_empty() || !self.provisional.is_empty()
    }

    fn poll(&mut self, now: Duration, out: &mut Out) {
        if !self.connected || self.polling {
            return;
        }
        self.polling = true;
        self.polled_at = Some(now);
        let (tag, command) = if self.status_supported {
            (ExecTag::Status, format!("{} || true", host::STATUS))
        } else {
            (ExecTag::List, format!("{} 2>/dev/null || true", host::LIST))
        };
        out.jobs.push(ChatJob::Exec { tag, command });
    }

    fn on_listing(&mut self, chats: Vec<ChatSummary>, now: Duration, out: &mut Out) {
        for chat in &chats {
            let waiting = chat.is_running
                && chat.has_status
                && chat.turn == tether_core::acp::host::HostTurn::Waiting;
            if waiting && self.waiting_seen.insert(chat.name.clone()) {
                let looking = self.focused && self.active.as_deref() == Some(chat.name.as_str());
                if !looking && !self.baseline {
                    let title = self.title_of(chat);
                    out.toasts.push((
                        chat.name.clone(),
                        title,
                        "The agent needs your answer.".to_string(),
                    ));
                }
            } else if !waiting {
                self.waiting_seen.remove(&chat.name);
            }
        }
        self.baseline = false;
        self.provisional
            .retain(|p| !chats.iter().any(|c| c.name == p.name));
        let gone: Vec<String> = self
            .listed
            .iter()
            .filter(|c| !chats.iter().any(|n| n.name == c.name))
            .map(|c| c.name.clone())
            .filter(|n| !self.provisional.iter().any(|p| &p.name == n))
            .collect();
        self.listed = chats;
        let listed = self.listed.clone();
        for chat in &listed {
            let agent = self.agent_of(chat);
            if let Some(s) = self.sessions.get_mut(&chat.name) {
                s.set_agent(agent);
            }
        }
        for name in gone {
            // Killed from another client: its tab goes, as a session's does.
            if self.active.as_deref() == Some(name.as_str()) {
                self.leave_active(now, out);
            }
            if let Some(mut s) = self.sessions.remove(&name) {
                s.leave(&mut self.ctx(now, out));
            }
        }
        self.dirty = true;
    }

    fn title_of(&self, chat: &ChatSummary) -> String {
        let titles = self.stored_titles(std::slice::from_ref(&chat.name));
        host::drawer_rows(std::slice::from_ref(chat), &titles, &HashMap::new())
            .first()
            .map(|r| r.title.clone())
            .unwrap_or_else(|| chat.name.clone())
    }

    fn stored_titles(&self, names: &[String]) -> HashMap<String, String> {
        self.files
            .as_ref()
            .map(|f| f.titles(names))
            .unwrap_or_default()
    }

    /// Opens a chat tab: an open chat reconnects, another one opens from its journal.
    pub fn select(&mut self, name: &str, now: Duration, out: &mut Out) {
        if self.active.as_deref() == Some(name) {
            return;
        }
        if !self.verbs_asked {
            self.verbs_asked = true;
            out.jobs.push(ChatJob::Exec {
                tag: ExecTag::Verbs,
                command: tether_core::acp::verbs::command(),
            });
        }
        if let Some(previous) = self.active.take() {
            self.with_session(&previous, now, out, |s, ctx| s.background(ctx));
        }
        let Some(chat) = self.ordered().into_iter().find(|c| c.name == name).cloned() else {
            return;
        };
        if !self.sessions.contains_key(name) {
            let journal = self
                .files
                .as_ref()
                .map(|f| f.journal(name))
                .unwrap_or_default();
            let mode = host::open_mode(&journal, chat.multi_client);
            let session = Session::new(
                name,
                &chat.cwd,
                mode,
                chat.multi_client,
                None,
                self.files.as_ref(),
            )
            .with_agent(self.agent_of(&chat));
            self.sessions.insert(name.to_string(), session);
        }
        self.active = Some(name.to_string());
        self.controls_open = false;
        self.review = false;
        self.follow_seq += 1;
        self.focus_seq += 1;
        self.draft_seq += 1;
        self.with_session(name, now, out, |s, ctx| s.connect(ctx));
        self.dirty = true;
    }

    /// A route from the new-chat dialog: the chat starts and takes the front.
    #[allow(clippy::too_many_arguments)]
    fn open_route(
        &mut self,
        name: String,
        cwd: String,
        load: Option<String>,
        multi: bool,
        agent: &'static AgentProfile,
        start: StartOptions,
        now: Duration,
        out: &mut Out,
    ) {
        if let Some(files) = &self.files
            && let Err(e) = files.set_agent(&name, agent.key)
        {
            tracing::warn!("chat agent not saved: {e}");
        }
        self.last_agent = agent.key.to_string();
        out.picked_agent = Some(agent.key.to_string());
        let created = self.ordered().iter().map(|c| c.created).max().unwrap_or(0) + 1;
        self.provisional.push(ChatSummary {
            name: name.clone(),
            is_running: true,
            log_bytes: 0,
            cwd: cwd.clone(),
            created,
            spawn: agent.spawn.to_string(),
            turn: host::HostTurn::Idle,
            host_title: None,
            has_status: false,
            multi_client: multi,
            tasks: 0,
        });
        let session = Session::new(
            &name,
            &cwd,
            host::OpenMode::Resume,
            multi,
            load,
            self.files.as_ref(),
        )
        .with_agent(Some(agent))
        .with_start(start);
        self.sessions.insert(name.clone(), session);
        self.select(&name, now, out);
    }

    /// `active` is the agent key of the chat in front; the other two agents get a tab each.
    #[cfg(debug_assertions)]
    fn dev_sample(&mut self, active: &str, now: Duration) {
        let front = agent::by_key(active).unwrap_or(&CLAUDE);
        let mut sample = Session::new(
            "sample",
            "/srv/app",
            host::OpenMode::Resume,
            false,
            None,
            None,
        )
        .with_agent(Some(front));
        sample.dev_state(devsample::state(), now);
        self.sessions.insert("sample".into(), sample);
        let rows = [
            ("sample", "/srv/app", front, "Release the new build"),
            ("other", "/srv/docs", &agent::CODEX, "Fix the pack cleanup"),
            ("third", "/srv/site", &agent::OPENCODE, "Tidy the README"),
        ];
        for (i, (name, cwd, agent, title)) in rows.into_iter().enumerate() {
            let mut chat = ChatSummary::new(name, cwd);
            chat.has_status = true;
            chat.spawn = agent.spawn.to_string();
            chat.host_title = Some(title.to_string());
            chat.created = i as i64;
            if name == "other" {
                chat.tasks = 2;
            }
            if name == "third" {
                chat.turn = host::HostTurn::Waiting;
            }
            self.provisional.push(chat);
        }
        // opencode has no chat on this host yet: its dialog shows the first-time note.
        for a in [&agent::CLAUDE, &agent::CODEX] {
            self.options_cache
                .store(&self.scope, a.key, &devsample::options(a.key));
        }
        self.active = Some("sample".into());
        self.follow_seq += 1;
        self.focus_seq += 1;
    }

    pub fn take_new_chat_when_ready(&mut self) -> bool {
        std::mem::take(&mut self.new_chat_when_ready)
    }

    /// `folder` is where the dialog starts: the active session's directory when it has one.
    pub fn open_new_chat(&mut self, mode: u8, folder: String, now: Duration, out: &mut Out) {
        self.dirty = true;
        let agent = agent::by_key(&self.last_agent).unwrap_or(&CLAUDE);
        self.new_chat = Some(NewChat::open(mode, folder, agent, self.draft_for(agent)));
        if let Some(job) = self.new_chat.as_mut().and_then(|n| n.reload(now)) {
            out.jobs.push(job);
        }
    }

    pub fn leave_active(&mut self, now: Duration, out: &mut Out) {
        if let Some(name) = self.active.take() {
            self.with_session(&name, now, out, |s, ctx| s.background(ctx));
            out.show_terminal = true;
        }
        self.controls_open = false;
        self.review = false;
        self.viewer = None;
        self.dirty = true;
    }

    pub fn handle(&mut self, msg: ChatMsg, now: Duration, out: &mut Out) {
        self.dirty = true;
        match msg {
            #[cfg(debug_assertions)]
            ChatMsg::DevSample(agent) => self.dev_sample(&agent, now),
            ChatMsg::Select(name) => self.select(&name, now, out),
            ChatMsg::Delete(name) => self.delete_prompt = Some(name),
            ChatMsg::NewChatWhenReady => self.new_chat_when_ready = true,
            ChatMsg::DeleteCancelled => {
                self.delete_prompt = None;
                self.focus_seq += 1;
            }
            ChatMsg::DeleteConfirmed => self.delete_confirmed(now, out),
            ChatMsg::NewChat(mode) => self.open_new_chat(mode, "~".into(), now, out),
            ChatMsg::NewChatCancel => {
                self.new_chat = None;
                self.focus_seq += 1;
            }
            ChatMsg::NewChatMode(mode) => {
                if let Some(job) = self.new_chat.as_mut().and_then(|n| n.set_mode(mode, now)) {
                    out.jobs.push(job);
                }
            }
            ChatMsg::NewChatFolder(text) => {
                if let Some(nc) = self.new_chat.as_mut() {
                    nc.set_folder(text, now);
                }
            }
            ChatMsg::NewChatAgent(key) => {
                if let Some(agent) = agent::by_key(&key) {
                    let draft = self.draft_for(agent);
                    if let Some(job) = self
                        .new_chat
                        .as_mut()
                        .and_then(|n| n.set_agent(agent, draft, now))
                    {
                        out.jobs.push(job);
                    }
                }
            }
            ChatMsg::NewChatPick { id, value } => {
                if let Some(nc) = self.new_chat.as_mut() {
                    nc.options.pick(&id, &value);
                }
            }
            ChatMsg::NewChatReset => {
                if let Some(nc) = self.new_chat.as_mut() {
                    nc.options.reset();
                }
            }
            ChatMsg::NewChatRetry => {
                if let Some(job) = self.new_chat.as_mut().and_then(|n| n.reload(now)) {
                    out.jobs.push(job);
                }
            }
            ChatMsg::NewChatStart => {
                if let Some(job) = self.new_chat.as_mut().and_then(|n| n.start(None)) {
                    out.jobs.push(job);
                }
            }
            ChatMsg::NewChatContinue(id) => {
                if let Some(job) = self.new_chat.as_mut().and_then(|n| n.start(Some(id))) {
                    out.jobs.push(job);
                }
            }
            ChatMsg::ExecDone {
                tag: ExecTag::NewChat { request, step },
                result,
            } => {
                let host = self.host.clone();
                let Some(nc) = self.new_chat.as_mut() else {
                    return;
                };
                match nc.on_exec(request, step, result, &host) {
                    newchat::Next::Nothing => {}
                    newchat::Next::Job(job) => out.jobs.push(job),
                    newchat::Next::Open {
                        cwd,
                        load,
                        multi,
                        agent,
                        start,
                    } => {
                        self.new_chat = None;
                        self.open_route(
                            host::new_chat_name(),
                            cwd,
                            load,
                            multi,
                            agent,
                            start,
                            now,
                            out,
                        );
                    }
                }
            }
            ChatMsg::ExecDone {
                tag: ExecTag::Verbs,
                result,
            } => {
                self.verbs = tether_core::acp::verbs::parse(&result.unwrap_or_default());
                self.dirty = true;
            }
            ChatMsg::ExecDone {
                tag: ExecTag::Status,
                result,
            } => {
                self.polling = false;
                if let Ok(output) = result {
                    let listing = host::parse_status(&output);
                    if listing.unsupported {
                        self.status_supported = false;
                        self.polled_at = None;
                        self.poll(now, out);
                    } else {
                        self.on_listing(listing.chats, now, out);
                    }
                }
            }
            ChatMsg::ExecDone {
                tag: ExecTag::List,
                result,
            } => {
                self.polling = false;
                if let Ok(output) = result {
                    self.on_listing(host::parse_listing(&output).chats, now, out);
                }
            }
            ChatMsg::ExecDone {
                tag: ExecTag::Kill { .. },
                ..
            } => {
                self.polled_at = None;
                self.poll(now, out);
            }
            ChatMsg::Escape => self.escape(now, out),
            ChatMsg::Controls => {
                self.controls_open = !self.controls_open;
            }
            ChatMsg::ControlsClose => {
                self.controls_open = false;
                self.bypass = None;
                self.focus_seq += 1;
            }
            ChatMsg::ControlsChoose { id, value } => {
                let bypass = id == "mode" && value == "bypassPermissions";
                let current = self
                    .active_session()
                    .and_then(|s| s.state().option(&id).map(|o| o.current_value == value));
                if bypass && current == Some(false) {
                    self.bypass = Some((id, value));
                } else if let Some(name) = self.active.clone() {
                    self.with_session(&name, now, out, |s, ctx| s.set_option(&id, &value, ctx));
                }
            }
            ChatMsg::BypassConfirmed => {
                if let (Some((id, value)), Some(name)) = (self.bypass.take(), self.active.clone()) {
                    self.with_session(&name, now, out, |s, ctx| s.set_option(&id, &value, ctx));
                }
            }
            ChatMsg::BypassCancelled => {
                self.bypass = None;
                self.focus_seq += 1;
            }
            ChatMsg::ControlsCommand(text) => {
                if let Some(name) = self.active.clone() {
                    let sent = self
                        .with_session(&name, now, out, |s, ctx| s.send_text(&text, ctx))
                        .unwrap_or(false);
                    if sent {
                        self.controls_open = false;
                        self.follow_seq += 1;
                    }
                }
            }
            // Only the links the grid would open: http, https and mailto.
            ChatMsg::OpenLink(url) => {
                if tether_core::links::is_openable(&url) {
                    out.open_url = Some(url);
                }
            }
            ChatMsg::Review => self.review = true,
            ChatMsg::CloseReview => {
                self.review = false;
                self.focus_seq += 1;
            }
            ChatMsg::OpenImage(id) => self.viewer = Some(id),
            ChatMsg::CloseViewer => {
                self.viewer = None;
                self.focus_seq += 1;
            }
            ChatMsg::CopyFolder => {
                if let Some(s) = self.active_session() {
                    out.clipboard = Some(s.cwd.clone());
                    self.folder_copied_at = Some(now);
                }
            }
            ChatMsg::Thumb { id, pixels } => {
                if let Some(p) = pixels {
                    self.thumbs.insert(id, p);
                }
            }
            ChatMsg::Send => {
                if let Some(name) = self.active.clone() {
                    let sent = self
                        .with_session(&name, now, out, |s, ctx| s.send_draft(ctx))
                        .unwrap_or(false);
                    if sent {
                        self.follow_seq += 1;
                        self.draft_seq += 1;
                    }
                }
            }
            ChatMsg::AttachFiles(paths) => {
                if let Some(name) = self.active.clone() {
                    self.with_session(&name, now, out, |s, ctx| {
                        for p in paths {
                            s.attach(ImageSource::File(p), ctx);
                        }
                    });
                }
            }
            ChatMsg::AttachBytes(bytes) => {
                if let Some(name) = self.active.clone() {
                    self.with_session(&name, now, out, |s, ctx| {
                        s.attach(ImageSource::Bytes(bytes), ctx)
                    });
                }
            }
            ChatMsg::PalettePick(i) => {
                if let Some(name) = self.active.clone() {
                    let picked = self
                        .with_session(&name, now, out, |s, ctx| s.palette_pick(i, ctx))
                        .unwrap_or(false);
                    if picked {
                        self.draft_seq += 1;
                    }
                }
            }
            // Per-chat messages from the driver name their chat.
            ChatMsg::Dialed {
                name,
                generation,
                result,
            } => {
                self.with_session(&name, now, out, |s, ctx| {
                    s.on_dialed(generation, result, ctx)
                });
            }
            ChatMsg::Data {
                name,
                generation,
                bytes,
            } => {
                self.with_session(&name, now, out, |s, ctx| s.on_data(generation, &bytes, ctx));
                // Streaming output redraws at the frame rate, not per chunk.
                self.dirty = self.shown_at.is_none_or(|t| now.saturating_sub(t) >= FRAME);
            }
            ChatMsg::Closed { name, generation } => {
                self.with_session(&name, now, out, |s, ctx| s.on_closed(generation, ctx));
            }
            ChatMsg::WriteFailed {
                name,
                generation,
                tag,
            } => {
                self.with_session(&name, now, out, |s, ctx| {
                    s.on_write_failed(generation, tag, ctx)
                });
            }
            ChatMsg::Written {
                name,
                generation,
                tag,
            } => {
                self.with_session(&name, now, out, |s, ctx| s.on_written(generation, tag, ctx));
            }
            ChatMsg::Encoded { name, key, result } => {
                self.with_session(&name, now, out, |s, _| s.on_encoded(&key, result));
            }
            ChatMsg::ExecDone {
                tag:
                    ExecTag::Inspect {
                        name,
                        generation,
                        why,
                    },
                result,
            } => {
                self.with_session(&name, now, out, |s, ctx| {
                    s.on_inspect(generation, why, result.ok(), ctx)
                });
            }
            ChatMsg::ExecDone {
                tag:
                    ExecTag::Answers {
                        name,
                        generation,
                        why,
                    },
                result,
            } => {
                self.with_session(&name, now, out, |s, ctx| {
                    s.on_answers(generation, why, result.ok(), ctx)
                });
            }
            ChatMsg::ExecDone {
                tag: ExecTag::Files { name },
                result,
            } => {
                self.with_session(&name, now, out, |s, ctx| s.on_files(result.ok(), ctx));
            }
            // The rest act on the chat in front.
            other => {
                if let Some(name) = self.active.clone() {
                    // An answered card leaves; the keyboard goes back to the composer.
                    let answered = self
                        .with_session(&name, now, out, |s, ctx| {
                            let before = s.first_pending();
                            s.handle_ui(other, ctx);
                            before.is_some() && s.first_pending() != before
                        })
                        .unwrap_or(false);
                    if answered {
                        self.focus_seq += 1;
                    }
                }
            }
        }
    }

    fn escape(&mut self, now: Duration, out: &mut Out) {
        // Whatever closes, the keyboard goes back to the composer.
        self.focus_seq += 1;
        if self.delete_prompt.take().is_some() {
            return;
        }
        if self.new_chat.take().is_some() {
            return;
        }
        if self.viewer.take().is_some() {
            return;
        }
        if self.bypass.take().is_some() {
            return;
        }
        if self.review {
            self.review = false;
            return;
        }
        if self.controls_open {
            self.controls_open = false;
            return;
        }
        if let Some(name) = self.active.clone() {
            self.with_session(&name, now, out, |s, ctx| {
                s.handle_ui(ChatMsg::PaletteClose, ctx)
            });
        }
    }

    fn delete_confirmed(&mut self, now: Duration, out: &mut Out) {
        let Some(name) = self.delete_prompt.take() else {
            return;
        };
        if self.active.as_deref() == Some(name.as_str()) {
            self.leave_active(now, out);
        }
        if let Some(mut s) = self.sessions.remove(&name) {
            s.leave(&mut self.ctx(now, out));
        }
        out.jobs.push(ChatJob::Exec {
            tag: ExecTag::Kill { name: name.clone() },
            command: host::kill_command(&name),
        });
        if let Some(files) = &self.files {
            files.clear(&name);
        }
        self.listed.retain(|c| c.name != name);
        self.provisional.retain(|c| c.name != name);
    }

    fn active_session(&self) -> Option<&Session> {
        self.active.as_ref().and_then(|n| self.sessions.get(n))
    }

    fn ctx<'a>(&'a mut self, now: Duration, out: &'a mut Out) -> session::Ctx<'a> {
        session::Ctx {
            now,
            out,
            files: self.files.as_ref(),
            connected: self.connected,
            defaults: &self.defaults,
        }
    }

    fn with_session<R>(
        &mut self,
        name: &str,
        now: Duration,
        out: &mut Out,
        f: impl FnOnce(&mut Session, &mut session::Ctx<'_>) -> R,
    ) -> Option<R> {
        let mut s = self.sessions.remove(name)?;
        let result = {
            let mut ctx = session::Ctx {
                now,
                out,
                files: self.files.as_ref(),
                connected: self.connected,
                defaults: &self.defaults,
            };
            f(&mut s, &mut ctx)
        };
        self.sessions.insert(name.to_string(), s);
        Some(result)
    }

    /// The pane as it should look now, when anything changed since the last one.
    pub fn screen(&mut self, now: Duration, out: &mut Out) -> Option<ChatScreen> {
        if !self.dirty {
            return None;
        }
        self.dirty = false;
        let screen = screen::build(self, now, out);
        if self.last_screen.as_ref() == Some(&screen) {
            return None;
        }
        self.shown_at = Some(now);
        self.last_screen = Some(screen.clone());
        Some(screen)
    }

    /// A chunk that arrived inside the frame window still has to be drawn once the window passes.
    pub fn flush_due(&mut self, now: Duration) {
        let active = self.active.as_ref().and_then(|n| self.sessions.get(n));
        if self
            .shown_at
            .is_some_and(|t| now.saturating_sub(t) >= FRAME)
            && active.is_some_and(Session::changed_since_shown)
        {
            self.dirty = true;
        }
    }
}

#[cfg(test)]
mod tests;
