//! One open chat: the port of iOS `ChatSessionModel` onto the sans-IO `ChatClient`. Every dial
//! bumps `generation`, and anything that answers for an older one is dropped.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use tether_core::acp::agent::{self, AgentProfile, CLAUDE};
use tether_core::acp::auth::matches_auth_error;
use tether_core::acp::client::{ChatClient, ClientError, Completion, Outbound, RequestKind, Undo};
use tether_core::acp::defaults::ChatDefaults;
use tether_core::acp::files::ChatFiles;
use tether_core::acp::format::{
    self, AfterLoss, Attempt, LinkTracker, Outbox, Phase as LinkPhase, Resume,
};
use tether_core::acp::host;
use tether_core::acp::images::{ImageAttachment, ImageSink};
use tether_core::acp::journal::Snapshot;
use tether_core::acp::mention::{self, FileIndex};
use tether_core::acp::message::{AcpId, ConfigOption, ToolStatus};
use tether_core::acp::options::StartOptions;
use tether_core::acp::question::{QuestionAction, QuestionDraft};
use tether_core::acp::reducer::{ChatState, ItemKind, LinkState, ToolCall, Turn};
use tether_core::acp::slash;
use tether_core::acp::workflows;

use super::{
    AnswersWhy, ChatJob, ChatMsg, ExecTag, ImageSource, InspectWhy, Out, Pixels, WriteTag,
};

pub struct Ctx<'a> {
    pub now: Duration,
    pub out: &'a mut Out,
    pub files: Option<&'a ChatFiles>,
    pub connected: bool,
    pub defaults: &'a ChatDefaults,
}

const SNAPSHOT_EVERY: Duration = Duration::from_secs(3);
const LEARN_RETRY: Duration = Duration::from_millis(1500);

#[derive(Debug, Clone, PartialEq)]
pub enum OptionChange {
    Pending(String),
    Failed(String, String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignIn {
    Idle,
    Checking,
    StillSignedOut,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Chan {
    Closed,
    Opening(u64),
    Live(u64),
}

#[derive(Debug, Clone, PartialEq)]
enum Handshake {
    Idle,
    Initializing,
    Opening,
    Ready,
}

pub enum AttachmentState {
    Encoding,
    Ready(ImageAttachment, Arc<Pixels>),
}

pub struct Attachment {
    pub key: String,
    pub state: AttachmentState,
}

pub struct Session {
    pub name: String,
    pub cwd: String,
    pub read_only: bool,
    /// Opened on a chat another client started: no spawn and no handshake, the session comes from the log.
    joined: bool,
    multi: bool,
    /// What this client is called to a holder that takes several (`attach --client`).
    client_id: Option<String>,
    load: Option<String>,
    client: Option<ChatClient>,
    /// What the screen shows without a client, and while a reconnect replays under it.
    frozen: ChatState,
    holding: bool,
    pub link: LinkTracker,
    pub outbox: Outbox,
    pub answer_failures: HashSet<AcpId>,
    pub notice: Option<String>,
    pub option_changes: HashMap<String, OptionChange>,
    /// The request of the stored default being set on a chat this device just started, the ids
    /// already tried, and the ids the user changed since (those are never set from a default).
    applying: Option<AcpId>,
    applied: Vec<String>,
    touched: HashSet<String>,
    /// The agent the chat runs; `None` is one this build does not know.
    agent: Option<&'static AgentProfile>,
    /// What the New chat dialog asked this chat to start with.
    start: StartOptions,
    /// The options last reported for the options cache, so an unchanged list is not reported again.
    published: Vec<ConfigOption>,
    pub files: FileIndex,
    files_loading: bool,
    /// What the host says of this chat's Workflow runs; never persisted.
    pub workflows: workflows::Tracker,
    /// The dial generation an ask is out for: one loop, and an answer for an older dial is dropped.
    workflow_asked: Option<u64>,
    workflow_next: Duration,
    pub sign_in: SignIn,
    generation: u64,
    dialing: bool,
    chan: Chan,
    attempt: Option<Attempt>,
    candidate: Option<Snapshot>,
    resume: Option<Snapshot>,
    skip_snapshot: bool,
    spawned: bool,
    identity: Option<i64>,
    learn_tries: u8,
    learn_at: Option<Duration>,
    answers: Option<Option<HashMap<AcpId, String>>>,
    early: Vec<Vec<u8>>,
    handshake: Handshake,
    snapshot_at: Duration,
    last_title: Option<String>,
    left: bool,
    pub expanded: HashSet<String>,
    pub window_start: Option<i64>,
    pub draft: String,
    /// Character offset of the caret in `draft`.
    pub cursor: usize,
    pub palette_dismissed: Option<String>,
    pub attachments: Vec<Attachment>,
    pub attach_error: Option<String>,
    pub question_drafts: HashMap<String, QuestionDraft>,
    rev: u64,
    shown_rev: u64,
    snapshot_rev: u64,
}

/// A chat's local files are a cache of the host's log: a failed write only costs a longer replay.
fn saved(result: std::io::Result<()>) {
    if let Err(e) = result {
        tracing::warn!("chat file not saved: {e}");
    }
}

fn describe(error: &ClientError) -> String {
    match error {
        ClientError::Agent { message, .. } if !message.is_empty() => message.clone(),
        ClientError::Agent { .. } => "The agent refused the change.".into(),
        _ => "The change didn't reach the agent.".into(),
    }
}

fn is_auth(error: &ClientError) -> bool {
    matches!(error, ClientError::Agent { code, message } if matches_auth_error(*code, message))
}

impl Session {
    /// `multi`: the chat's holder takes several clients, so this one names itself to it and a
    /// chat started elsewhere (`OpenMode::Join`) is joined instead of read.
    pub fn new(
        name: &str,
        cwd: &str,
        mode: host::OpenMode,
        multi: bool,
        load: Option<String>,
        files: Option<&ChatFiles>,
    ) -> Self {
        let outbox = files
            .map(|f| Outbox::restoring(&f.outbox(name)))
            .unwrap_or_default();
        Self {
            name: name.to_string(),
            cwd: cwd.to_string(),
            read_only: mode == host::OpenMode::ReadOnly,
            joined: mode == host::OpenMode::Join,
            multi,
            client_id: None,
            load,
            client: None,
            frozen: ChatState::default(),
            holding: false,
            link: LinkTracker::default(),
            outbox,
            answer_failures: HashSet::new(),
            notice: None,
            option_changes: HashMap::new(),
            applying: None,
            applied: Vec::new(),
            touched: HashSet::new(),
            agent: Some(&CLAUDE),
            start: StartOptions::Stored,
            published: Vec::new(),
            files: FileIndex::default(),
            files_loading: false,
            workflows: workflows::Tracker::default(),
            workflow_asked: None,
            workflow_next: Duration::ZERO,
            sign_in: SignIn::Idle,
            generation: 0,
            dialing: false,
            chan: Chan::Closed,
            attempt: None,
            candidate: None,
            resume: None,
            skip_snapshot: false,
            spawned: false,
            identity: None,
            learn_tries: 0,
            learn_at: None,
            answers: None,
            early: Vec::new(),
            handshake: Handshake::Idle,
            snapshot_at: Duration::ZERO,
            last_title: None,
            left: false,
            expanded: HashSet::new(),
            window_start: None,
            draft: String::new(),
            cursor: 0,
            palette_dismissed: None,
            attachments: Vec::new(),
            attach_error: None,
            question_drafts: HashMap::new(),
            rev: 1,
            shown_rev: 0,
            snapshot_rev: 0,
        }
    }

    pub fn with_agent(mut self, agent: Option<&'static AgentProfile>) -> Self {
        self.agent = agent;
        self
    }

    pub fn with_start(mut self, start: StartOptions) -> Self {
        self.start = start;
        self
    }

    pub fn agent(&self) -> Option<&'static AgentProfile> {
        self.agent
    }

    /// The host's report can say more than the local record did when the chat was opened.
    pub fn set_agent(&mut self, agent: Option<&'static AgentProfile>) {
        if self.agent != agent {
            self.agent = agent;
            self.touched();
        }
    }

    /// The remembered options this agent offers, for the New chat dialog's choices. Only when the
    /// session is settled, so a replay of an older log never overwrites a newer list.
    fn publish_options(&mut self, ctx: &mut Ctx<'_>) {
        let Some(agent) = self.agent else { return };
        if self.link.phase() != LinkPhase::Live || self.holding {
            return;
        }
        let options = &self.state().config_options;
        if options.is_empty() || *options == self.published {
            return;
        }
        let options = options.clone();
        self.published = options.clone();
        ctx.out.options_seen.push((agent.key.to_string(), options));
    }

    #[cfg(debug_assertions)]
    pub(super) fn dev_state(&mut self, state: ChatState, now: Duration) {
        self.frozen = state;
        self.link.dial_succeeded(now);
        self.link.settle_if_quiet(now + Duration::from_secs(60));
    }

    pub fn state(&self) -> &ChatState {
        match &self.client {
            Some(c) if !self.holding => c.state(),
            _ => &self.frozen,
        }
    }

    pub fn title(&self) -> String {
        self.state()
            .title
            .clone()
            .unwrap_or_else(|| format::folder_name(&self.cwd))
    }

    /// Send, Stop and the answers wait for the replay: until it settles the transcript may be
    /// partial and a pending request may already have been answered.
    pub fn can_interact(&self) -> bool {
        self.link.allows_interaction() && !self.read_only
    }

    pub fn can_send(&self) -> bool {
        self.can_interact() && !self.needs_sign_in()
    }

    pub fn needs_sign_in(&self) -> bool {
        let state = self.state();
        state.session_id.is_none()
            && matches!(
                state.items.last().map(|i| &i.kind),
                Some(ItemKind::SignedOut)
            )
    }

    pub fn has_ended(&self) -> bool {
        self.link.phase() == LinkPhase::Ended
    }

    pub fn is_working(&self) -> bool {
        self.state().turn == Turn::Working
    }

    pub fn changed_since_shown(&self) -> bool {
        self.rev != self.shown_rev
    }

    pub fn mark_shown(&mut self) {
        self.shown_rev = self.rev;
    }

    fn touched(&mut self) {
        self.rev += 1;
    }

    // MARK: Connection

    pub fn connect(&mut self, ctx: &mut Ctx<'_>) {
        let client_usable = self.client.is_some() && self.link.phase() != LinkPhase::Lost;
        if self.dialing || self.left || client_usable {
            return;
        }
        // Opened while the terminal is down: lost, so the reconnect picks it up.
        if !ctx.connected {
            self.link.connection_lost();
            self.touched();
            return;
        }
        self.dialing = true;
        self.generation += 1;
        self.workflow_asked = None;
        self.workflow_next = Duration::ZERO;
        self.detach(ctx);
        self.link.dial_started();
        self.notice = None;
        let mut journal = ctx.files.map(|f| f.journal(&self.name)).unwrap_or_default();
        if self.multi
            && !self.read_only
            && journal.client_id.is_none()
            && let Some(files) = ctx.files
        {
            journal.client_id = Some(host::new_client_id());
            saved(files.save_journal(&self.name, &journal));
        }
        self.client_id = journal.client_id.clone().filter(|_| self.multi);
        let spawn = !self.read_only && !self.joined && journal.session_id.is_none();
        self.spawned = spawn;
        self.answers = None;
        self.early.clear();
        self.handshake = Handshake::Idle;
        ctx.out.jobs.push(ChatJob::Exec {
            tag: ExecTag::Answers {
                name: self.name.clone(),
                generation: self.generation,
                why: AnswersWhy::Dial,
            },
            command: format!("{} 2>/dev/null || true", host::answers_command(&self.name)),
        });
        let candidate = if self.skip_snapshot || spawn {
            None
        } else {
            ctx.files.and_then(|f| f.snapshot(&self.name))
        };
        self.skip_snapshot = false;
        if candidate.is_some() {
            self.candidate = candidate;
            self.inspect(InspectWhy::Resume, ctx);
        } else {
            self.dial(None, spawn, ctx);
        }
        self.touched();
    }

    fn inspect(&mut self, why: InspectWhy, ctx: &mut Ctx<'_>) {
        ctx.out.jobs.push(ChatJob::Exec {
            tag: ExecTag::Inspect {
                name: self.name.clone(),
                generation: self.generation,
                why,
            },
            command: format!("{} 2>/dev/null || true", host::LIST),
        });
    }

    fn dial(&mut self, resume: Option<Snapshot>, spawn: bool, ctx: &mut Ctx<'_>) {
        self.attempt = resume.as_ref().map(|r| Attempt {
            offset: r.offset,
            identity: r.identity,
        });
        self.identity = resume.as_ref().map(|r| r.identity);
        self.holding = !self.frozen.items.is_empty() && resume.is_none();
        let offset = resume.as_ref().map_or(0, |r| r.offset);
        self.resume = resume;
        let command = host::attach_command(
            &self.name,
            &self.cwd,
            spawn.then(|| self.agent.unwrap_or(&CLAUDE)),
            offset,
            self.client_id.as_deref(),
        );
        self.applying = None;
        self.chan = Chan::Opening(self.generation);
        ctx.out.jobs.push(ChatJob::Dial {
            name: self.name.clone(),
            generation: self.generation,
            command,
        });
    }

    pub fn on_inspect(
        &mut self,
        generation: u64,
        why: InspectWhy,
        output: Option<String>,
        ctx: &mut Ctx<'_>,
    ) {
        if generation != self.generation || self.left {
            return;
        }
        let summary = output.and_then(|o| {
            host::parse_listing(&o)
                .chats
                .into_iter()
                .find(|c| c.name == self.name)
        });
        match why {
            InspectWhy::Resume => {
                let journal = ctx.files.map(|f| f.journal(&self.name)).unwrap_or_default();
                let candidate = self.candidate.take();
                let resume =
                    Resume::usable(candidate.as_ref(), &journal, summary.as_ref()).cloned();
                if resume.is_none()
                    && summary.is_some()
                    && let Some(files) = ctx.files
                {
                    files.clear_snapshot(&self.name);
                }
                self.dial(resume, false, ctx);
            }
            InspectWhy::Learn => match summary {
                Some(s) => self.identity = Some(Resume::identity_of(&s)),
                None if self.learn_tries > 0 => {
                    self.learn_tries -= 1;
                    self.learn_at = Some(ctx.now + LEARN_RETRY);
                }
                None => {}
            },
            InspectWhy::Loss => {
                let Some(client) = &self.client else {
                    return;
                };
                let next = Resume::after_loss(
                    self.attempt,
                    client.received_bytes(),
                    client.failed_decoding(),
                    summary.as_ref(),
                );
                match next {
                    AfterLoss::ReplayFromZero => {
                        if let Some(files) = ctx.files {
                            files.clear_snapshot(&self.name);
                        }
                        self.skip_snapshot = true;
                        self.connect(ctx);
                    }
                    AfterLoss::Ended => self.link.ended(),
                    AfterLoss::Lost => {}
                }
                self.touched();
            }
        }
    }

    pub fn on_answers(
        &mut self,
        generation: u64,
        why: AnswersWhy,
        output: Option<String>,
        ctx: &mut Ctx<'_>,
    ) {
        if generation != self.generation {
            return;
        }
        let answers = output.map(|o| host::parse_answers(&o));
        match why {
            AnswersWhy::Dial => {
                self.answers = Some(answers);
                self.maybe_start(false, ctx);
            }
            AnswersWhy::Adopt(request) => {
                let taken = answers.as_ref().is_some_and(|a| a.contains_key(&request));
                if taken {
                    if let (Some(client), Some(answers)) = (self.client.as_mut(), answers) {
                        client.adopt_host_answers(&answers);
                    }
                    self.persist_journal(ctx);
                } else {
                    self.answer_failures.insert(request);
                }
                self.touched();
            }
        }
    }

    pub fn on_dialed(&mut self, generation: u64, result: Result<(), String>, ctx: &mut Ctx<'_>) {
        if generation != self.generation || self.left {
            return;
        }
        match result {
            Ok(()) => {
                self.chan = Chan::Live(generation);
                self.maybe_start(false, ctx);
            }
            Err(reason) => {
                self.dialing = false;
                self.chan = Chan::Closed;
                self.fail(reason);
            }
        }
        self.touched();
    }

    /// The client starts once the stream is open and the host's recorded answers are in its
    /// journal, so a replay never asks again what the host already took.
    fn maybe_start(&mut self, force: bool, ctx: &mut Ctx<'_>) {
        if self.client.is_some() || self.chan != Chan::Live(self.generation) {
            return;
        }
        if self.answers.is_none() && !force {
            return;
        }
        self.dialing = false;
        let journal = ctx.files.map(|f| f.journal(&self.name)).unwrap_or_default();
        let images: Option<Arc<dyn ImageSink>> = ctx
            .files
            .map(|f| Arc::new(f.images(&self.name)) as Arc<dyn ImageSink>);
        let mut client = ChatClient::new(journal, self.resume.take(), images);
        if self.joined {
            client.join();
        }
        if let Some(Some(answers)) = self.answers.take() {
            client.adopt_host_answers(&answers);
        }
        self.client = Some(client);
        if self.attempt.is_none() && ctx.files.is_some() {
            self.learn_tries = if self.spawned { 3 } else { 0 };
            self.inspect(InspectWhy::Learn, ctx);
        }
        self.link.dial_succeeded(ctx.now);
        self.snapshot_at = ctx.now;
        self.persist_journal(ctx);
        for bytes in std::mem::take(&mut self.early) {
            self.feed(&bytes, ctx);
        }
        if !self.read_only && !self.joined && self.needs_handshake() {
            self.begin_handshake(ctx);
        }
        self.receive(ctx);
    }

    fn needs_handshake(&self) -> bool {
        self.client
            .as_ref()
            .is_some_and(|c| c.journal().session_id.is_none())
    }

    fn begin_handshake(&mut self, ctx: &mut Ctx<'_>) {
        let Some(client) = self.client.as_mut() else {
            return;
        };
        let out = client.initialize();
        self.handshake = Handshake::Initializing;
        self.persist_journal(ctx);
        self.write(out.line.clone(), Some(WriteTag::Request(out)), ctx);
    }

    pub fn on_data(&mut self, generation: u64, bytes: &[u8], ctx: &mut Ctx<'_>) {
        if generation != self.generation || self.left {
            return;
        }
        if self.client.is_none() {
            self.early.push(bytes.to_vec());
            return;
        }
        self.feed(bytes, ctx);
        self.receive(ctx);
        self.snapshot_if_due(ctx);
    }

    fn feed(&mut self, bytes: &[u8], ctx: &mut Ctx<'_>) {
        let Some(client) = self.client.as_mut() else {
            return;
        };
        let completions = client.feed(bytes);
        for c in completions {
            self.on_completion(c, ctx);
        }
        self.persist_journal(ctx);
        self.link.activity(ctx.now);
        self.touched();
    }

    pub fn on_closed(&mut self, generation: u64, ctx: &mut Ctx<'_>) {
        if generation != self.generation || self.left {
            return;
        }
        if self.client.is_none() && self.chan == Chan::Live(generation) {
            self.maybe_start(true, ctx);
        }
        self.chan = Chan::Closed;
        if let Some(client) = self.client.as_mut() {
            let completions = client.connection_lost();
            for c in completions {
                self.on_completion(c, ctx);
            }
            self.receive(ctx);
        } else {
            self.dialing = false;
            self.agent_stopped();
        }
        self.touched();
    }

    fn on_completion(&mut self, c: Completion, ctx: &mut Ctx<'_>) {
        match c.kind {
            RequestKind::Initialize => match c.outcome {
                Ok(_) => {
                    let load = self.load.clone().or_else(|| {
                        self.client
                            .as_ref()
                            .and_then(|cl| cl.journal().loaded_session_id.clone())
                    });
                    let cwd = self.cwd.clone();
                    let Some(client) = self.client.as_mut() else {
                        return;
                    };
                    let out = match load {
                        Some(id) => client.load_session(&id, &cwd),
                        None => client.new_session(&cwd),
                    };
                    self.handshake = Handshake::Opening;
                    self.persist_journal(ctx);
                    self.write(out.line.clone(), Some(WriteTag::Request(out)), ctx);
                }
                Err(e) => self.start_failed(e),
            },
            RequestKind::NewSession | RequestKind::LoadSession => match c.outcome {
                Ok(_) => {
                    self.handshake = Handshake::Ready;
                    if self.sign_in == SignIn::Checking {
                        self.sign_in = SignIn::Idle;
                    }
                    self.applying = None;
                    self.applied.clear();
                    self.remember_picks_already_set(ctx);
                    self.apply_next_default(ctx);
                }
                Err(e) => self.start_failed(e),
            },
            RequestKind::SetConfig { id, value } if self.applying.as_ref() == Some(&c.id) => {
                self.applying = None;
                // A value the dialog picked that the agent took is the user's choice.
                if c.outcome.is_ok() && self.start.is_chosen(&id) {
                    self.remember(id, value, ctx);
                }
                self.apply_next_default(ctx);
            }
            RequestKind::SetConfig { id, value } => match c.outcome {
                Ok(_) => {
                    self.option_changes.remove(&id);
                    self.remember(id, value, ctx);
                }
                Err(e) => {
                    self.option_changes
                        .insert(id, OptionChange::Failed(value, describe(&e)));
                }
            },
            RequestKind::Prompt => {}
        }
    }

    fn remember(&self, id: String, value: String, ctx: &mut Ctx<'_>) {
        if agent::remembered_ids(agent::key(self.agent)).contains(&id.as_str()) {
            ctx.out
                .remembered
                .push((agent::key(self.agent).to_string(), id, value));
        }
    }

    /// The dialog's picks the agent already had set need no request, but they are still the
    /// user's choice.
    fn remember_picks_already_set(&mut self, ctx: &mut Ctx<'_>) {
        let StartOptions::Picks { values, .. } = &self.start else {
            return;
        };
        let Some(client) = self.client.as_ref() else {
            return;
        };
        let current: Vec<(String, String)> = client
            .state()
            .config_options
            .iter()
            .filter(|o| values.get(&o.id) == Some(&o.current_value) && self.start.is_chosen(&o.id))
            .map(|o| (o.id.clone(), o.current_value.clone()))
            .collect();
        for (id, value) in current {
            self.remember(id, value, ctx);
        }
    }

    /// Sets the next stored default on a chat this device started. Each answer carries the options
    /// as they now stand, so a model's effort levels are checked after the model took. A failure
    /// shows nothing and keeps the stored value.
    fn apply_next_default(&mut self, ctx: &mut Ctx<'_>) {
        let Some(client) = self.client.as_mut() else {
            return;
        };
        let skip: Vec<String> = self
            .applied
            .iter()
            .chain(self.touched.iter())
            .cloned()
            .collect();
        let Some((id, value)) = ctx.defaults.next_apply_for(
            agent::key(self.agent),
            &client.state().config_options,
            &skip,
            &self.start,
        ) else {
            return;
        };
        self.applied.push(id.clone());
        let Ok(out) = client.set_config_option(&id, &value) else {
            return;
        };
        self.applying = out.id.clone();
        self.persist_journal(ctx);
        self.write(
            out.line.clone(),
            Some(WriteTag::Config { out, id, value }),
            ctx,
        );
    }

    fn start_failed(&mut self, error: ClientError) {
        self.handshake = Handshake::Idle;
        if error == ClientError::ConnectionLost {
            if self.sign_in != SignIn::Checking {
                self.agent_stopped();
            }
            return;
        }
        if self.sign_in == SignIn::Checking {
            if is_auth(&error) {
                self.sign_in = SignIn::StillSignedOut;
            } else {
                self.sign_in = SignIn::Idle;
                self.notice = Some(format!("Couldn't reach the agent: {}", describe(&error)));
            }
            return;
        }
        if let ClientError::Agent { message, .. } = &error
            && self.load.is_some()
            && !is_auth(&error)
        {
            self.notice = Some(if message.is_empty() {
                "Couldn't load that conversation.".into()
            } else {
                format!("Couldn't load that conversation: {message}")
            });
            return;
        }
        // The transcript already carries the sign-in row; the link itself is fine.
        if error == ClientError::NoSession {
            self.agent_stopped();
        } else if !is_auth(&error) {
            self.link.dial_failed();
            self.holding = false;
            self.notice = Some(error.to_string());
        }
    }

    /// Mirrors the client's state into the screen and notices a stream that ended.
    fn receive(&mut self, ctx: &mut Ctx<'_>) {
        let Some(client) = &self.client else {
            return;
        };
        if client.state().connection == LinkState::Lost {
            let first = self.link.phase() != LinkPhase::Lost;
            self.link.connection_lost();
            self.holding = false;
            self.persist_title(ctx);
            if first {
                self.inspect(InspectWhy::Loss, ctx);
            }
            return;
        }
        if !self.holding {
            self.persist_title(ctx);
        }
        self.publish_options(ctx);
    }

    pub fn tick(&mut self, ctx: &mut Ctx<'_>) -> bool {
        let mut changed = false;
        if self.link.phase() == LinkPhase::CatchingUp && self.link.settle_if_quiet(ctx.now) {
            self.holding = false;
            self.persist_title(ctx);
            self.publish_options(ctx);
            changed = true;
        }
        if let Some(at) = self.learn_at
            && ctx.now >= at
        {
            self.learn_at = None;
            self.inspect(InspectWhy::Learn, ctx);
        }
        self.poll_workflows(ctx);
        if self.client.is_some()
            && self.rev != self.snapshot_rev
            && ctx.now.saturating_sub(self.snapshot_at) >= SNAPSHOT_EVERY
        {
            self.save_snapshot(ctx);
        }
        if changed {
            self.touched();
        }
        changed
    }

    /// The Workflow tool calls in the transcript.
    fn workflow_calls(&self) -> Vec<&ToolCall> {
        self.state()
            .items
            .iter()
            .filter_map(|i| match &i.kind {
                ItemKind::Tool(call) if call.is_workflow => Some(call),
                _ => None,
            })
            .collect()
    }

    /// Asks the host every few seconds while a Workflow call is not known to be over: only with
    /// the stream up, so a chat that left the front or lost its connection asks nothing. A host
    /// that answers like one without the command is left alone.
    fn poll_workflows(&mut self, ctx: &mut Ctx<'_>) {
        if self.client.is_none()
            || self.left
            || self.has_ended()
            || !ctx.connected
            || self.workflow_asked.is_some()
            || ctx.now < self.workflow_next
        {
            return;
        }
        let Some(id) = self.state().session_id.clone() else {
            return;
        };
        if !self.workflows.needs_polling(&self.workflow_calls()) {
            return;
        }
        self.workflow_asked = Some(self.generation);
        ctx.out.jobs.push(ChatJob::Exec {
            tag: ExecTag::Workflows {
                name: self.name.clone(),
                generation: self.generation,
            },
            command: workflows::command(&id),
        });
    }

    /// Whether the answer changed what the screen shows. The tracker is not persisted, so this
    /// never bumps the revision that triggers a snapshot write.
    pub fn on_workflows(
        &mut self,
        generation: u64,
        output: Option<String>,
        ctx: &mut Ctx<'_>,
    ) -> bool {
        // `background` clears the ask, so an answer that still names it is for an older dial.
        if self.workflow_asked != Some(generation) {
            return false;
        }
        self.workflow_asked = None;
        if generation != self.generation || self.client.is_none() {
            return false;
        }
        let calls: Vec<ToolCall> = self.workflow_calls().into_iter().cloned().collect();
        let refs: Vec<&ToolCall> = calls.iter().collect();
        let before = (self.workflows.runs().to_vec(), self.workflows.supported());
        self.workflows.apply(output.as_deref(), &refs, ctx.now);
        self.workflow_next = ctx.now + self.workflows.interval(workflows::POLL_INTERVAL, ctx.now);
        before != (self.workflows.runs().to_vec(), self.workflows.supported())
    }

    /// How a tool row reads: a Workflow row follows the host until it reports the end, and a
    /// chat that has ended keeps what ACP said.
    pub fn tool_status(&self, call: &ToolCall) -> ToolStatus {
        if self.has_ended() {
            call.status
        } else {
            self.workflows.display_status(call)
        }
    }

    /// Whether the host lists this Workflow call, so its row can open the run's sheet.
    pub fn workflow_listed(&self, call: &ToolCall) -> bool {
        call.is_workflow
            && self.workflows.supported()
            && self.workflows.run_for_call(&call.id).is_some()
    }

    /// The Workflow call a transcript row key names, when the host lists its run.
    pub fn workflow_call_for_key(&self, key: &str) -> Option<String> {
        let id: i64 = key.strip_prefix("item:")?.parse().ok()?;
        self.state().items.iter().find_map(|item| match &item.kind {
            ItemKind::Tool(call) if item.id == id && self.workflow_listed(call) => {
                Some(call.id.clone())
            }
            _ => None,
        })
    }

    /// The workflows running now, for the strip; a chat that has ended shows none.
    pub fn running_workflows(&self) -> Vec<&workflows::Run> {
        if self.has_ended() {
            Vec::new()
        } else {
            self.workflows.running()
        }
    }

    fn snapshot_if_due(&mut self, ctx: &mut Ctx<'_>) {
        let ended = self.client.as_mut().is_some_and(|c| c.turn_just_ended());
        if ended || ctx.now.saturating_sub(self.snapshot_at) >= SNAPSHOT_EVERY {
            self.save_snapshot(ctx);
        }
    }

    /// Only once the host log's identity is known, and never for a state that lost its link.
    fn save_snapshot(&mut self, ctx: &mut Ctx<'_>) {
        self.snapshot_at = ctx.now;
        let (Some(files), Some(client), Some(identity)) = (ctx.files, &self.client, self.identity)
        else {
            return;
        };
        if let Some(snapshot) = client.snapshot(identity) {
            saved(files.save_snapshot(&self.name, &snapshot));
            self.snapshot_rev = self.rev;
        }
    }

    /// The request the card in front answers, for telling when it was answered.
    pub fn first_pending(&self) -> Option<AcpId> {
        let state = self.state();
        state
            .pending_questions()
            .first()
            .map(|q| q.request_id.clone())
            .or_else(|| {
                state
                    .pending_permissions()
                    .first()
                    .map(|p| p.request_id.clone())
            })
    }

    fn persist_journal(&mut self, ctx: &mut Ctx<'_>) {
        if let (Some(files), Some(client)) = (ctx.files, self.client.as_mut())
            && client.take_journal_changed()
        {
            saved(files.save_journal(&self.name, client.journal()));
        }
    }

    fn persist_title(&mut self, ctx: &mut Ctx<'_>) {
        let title = self.state().title.clone();
        if title != self.last_title {
            if let (Some(files), Some(t)) = (ctx.files, &title) {
                saved(files.set_title(&self.name, t));
            }
            self.last_title = title;
        }
    }

    /// The agent ended before the chat started: not a problem of reaching the host.
    fn agent_stopped(&mut self) {
        self.link.dial_failed();
        self.holding = false;
        self.notice = Some(ClientError::NoSession.to_string());
    }

    fn fail(&mut self, reason: String) {
        self.link.dial_failed();
        self.holding = false;
        self.notice = Some(format!("Couldn't reach the host: {reason}"));
    }

    /// Drops the stream and keeps the transcript; a later `connect` resumes from the snapshot.
    fn detach(&mut self, ctx: &mut Ctx<'_>) {
        if let Some(client) = self.client.take() {
            if !client.ended()
                && let (Some(files), Some(identity)) = (ctx.files, self.identity)
                && let Some(snapshot) = client.snapshot(identity)
            {
                saved(files.save_snapshot(&self.name, &snapshot));
            }
            self.frozen = client.state().clone();
        }
        self.holding = false;
        if self.chan != Chan::Closed {
            ctx.out.jobs.push(ChatJob::Hangup {
                name: self.name.clone(),
            });
            self.chan = Chan::Closed;
        }
    }

    /// The chat left the front (or the terminal connection dropped): the socket goes, and coming
    /// back is a clean resume.
    pub fn background(&mut self, ctx: &mut Ctx<'_>) {
        if self.left {
            return;
        }
        self.generation += 1;
        self.dialing = false;
        self.workflow_asked = None;
        self.workflow_next = Duration::ZERO;
        self.detach(ctx);
        self.link.connection_lost();
        self.touched();
    }

    pub fn leave(&mut self, ctx: &mut Ctx<'_>) {
        self.background(ctx);
        self.left = true;
    }

    pub fn reconnect_if_lost(&mut self, ctx: &mut Ctx<'_>) {
        if format::should_reconnect(self.link.phase(), self.dialing, self.left) {
            self.connect(ctx);
        }
    }

    fn write(&mut self, bytes: Vec<u8>, tag: Option<WriteTag>, ctx: &mut Ctx<'_>) {
        ctx.out.jobs.push(ChatJob::Write {
            name: self.name.clone(),
            generation: self.generation,
            bytes,
            tag,
            ack: false,
        });
    }

    /// A Stop lands first and is journaled after, as iOS does: a cancel that never reached the
    /// agent must not read "Stopped" or drop the queued messages.
    pub fn on_written(&mut self, generation: u64, tag: WriteTag, ctx: &mut Ctx<'_>) {
        if generation != self.generation || !matches!(tag, WriteTag::Cancel(_)) {
            return;
        }
        let Some(client) = self.client.as_mut() else {
            return;
        };
        // Stop drops what was waiting; as in Claude Code, it goes out next instead.
        let (resend, images) = client.state().queued_resend();
        let answers = client.cancelled();
        self.persist_journal(ctx);
        for out in answers {
            self.write(out.line.clone(), Some(WriteTag::Answer(out)), ctx);
        }
        if !resend.is_empty() {
            self.deliver(resend, Vec::new(), 0, ctx);
        }
        if images > 0 {
            self.notice = Some(format!(
                "The waiting messages went out again without their {}.",
                format::image_label(images)
            ));
        }
        self.touched();
    }

    /// A write that failed after the chat redialed: the client that journaled it is gone, so the
    /// stored journal is corrected instead, or a replay would show it delivered.
    fn undo_stored(&self, out: &Outbound, ctx: &mut Ctx<'_>) {
        use tether_core::acp::journal::EntryKind;
        let (Some(files), Some(id)) = (ctx.files, out.id.as_ref()) else {
            return;
        };
        let kinds: &[EntryKind] = match out.undo {
            Undo::Prompt => &[EntryKind::Prompt],
            Undo::Permission { .. } | Undo::Question { .. } => {
                &[EntryKind::Answer, EntryKind::QuestionAnswer]
            }
            _ => return,
        };
        let mut journal = files.journal(&self.name);
        if let Some(i) = journal
            .entries
            .iter()
            .rposition(|e| kinds.contains(&e.kind) && e.request_id.as_ref() == Some(id))
        {
            journal.entries.remove(i);
            saved(files.save_journal(&self.name, &journal));
        }
    }

    pub fn on_write_failed(&mut self, generation: u64, tag: WriteTag, ctx: &mut Ctx<'_>) {
        // After a redial the new client was built from the journal that holds the entry, so it
        // takes it back; with no client yet, the stored journal is corrected instead.
        let undo = |s: &mut Self, out: &Outbound, ctx: &mut Ctx<'_>| -> Option<Completion> {
            let current = generation == s.generation;
            match s.client.as_mut() {
                // A request id belongs to its own connection: a newer client may reuse it.
                Some(_) if !current && matches!(out.undo, Undo::Request | Undo::None) => None,
                Some(c) => {
                    let done = c.undelivered(out);
                    current.then_some(done).flatten()
                }
                None => {
                    s.undo_stored(out, ctx);
                    None
                }
            }
        };
        match tag {
            WriteTag::Request(out) => {
                if let Some(c) = undo(self, &out, ctx) {
                    self.on_completion(c, ctx);
                }
            }
            WriteTag::Prompt {
                out,
                text,
                images,
                lost,
            } => {
                undo(self, &out, ctx);
                self.outbox.record_failure(&text, images, lost, None);
                self.persist_outbox(ctx);
            }
            WriteTag::Answer(out) => {
                undo(self, &out, ctx);
                if let Some(request) = out.id {
                    self.ask_host_answer(request, ctx);
                }
            }
            WriteTag::Cancel(_) => {
                self.notice = Some("Stop didn't reach the agent. Try again.".into());
            }
            WriteTag::Config { out, id, value } => {
                undo(self, &out, ctx);
                if out.id.is_some() && self.applying == out.id {
                    self.applying = None;
                } else {
                    self.option_changes.insert(
                        id,
                        OptionChange::Failed(value, "The change didn't reach the agent.".into()),
                    );
                }
            }
        }
        self.persist_journal(ctx);
        self.touched();
    }

    /// The host may have taken an answer from another device first: then the card is simply
    /// resolved and there is nothing to report.
    fn ask_host_answer(&mut self, request: AcpId, ctx: &mut Ctx<'_>) {
        ctx.out.jobs.push(ChatJob::Exec {
            tag: ExecTag::Answers {
                name: self.name.clone(),
                generation: self.generation,
                why: AnswersWhy::Adopt(request),
            },
            command: format!("{} 2>/dev/null || true", host::answers_command(&self.name)),
        });
    }

    fn persist_outbox(&self, ctx: &mut Ctx<'_>) {
        if let Some(files) = ctx.files {
            saved(files.save_outbox(&self.name, &self.outbox.persisted()));
        }
    }

    // MARK: Actions

    fn ready_images(&self) -> Vec<ImageAttachment> {
        self.attachments
            .iter()
            .filter_map(|a| match &a.state {
                AttachmentState::Ready(img, _) => Some(img.clone()),
                AttachmentState::Encoding => None,
            })
            .collect()
    }

    pub fn encoding(&self) -> usize {
        self.attachments
            .iter()
            .filter(|a| matches!(a.state, AttachmentState::Encoding))
            .count()
    }

    pub fn can_send_now(&self) -> bool {
        format::can_send(
            &self.draft,
            self.attachments.len() - self.encoding(),
            self.encoding(),
            self.can_send(),
        )
    }

    pub fn send_draft(&mut self, ctx: &mut Ctx<'_>) -> bool {
        if self.answer_pending() || !self.can_send_now() {
            return false;
        }
        let text = self.draft.trim().to_string();
        let images = self.ready_images();
        self.deliver(text, images, 0, ctx);
        self.draft.clear();
        self.cursor = 0;
        self.attachments.clear();
        self.attach_error = None;
        self.touched();
        true
    }

    pub fn send_text(&mut self, text: &str, ctx: &mut Ctx<'_>) -> bool {
        if !self.can_send() || self.is_working() {
            return false;
        }
        self.deliver(text.to_string(), Vec::new(), 0, ctx);
        true
    }

    fn deliver(
        &mut self,
        text: String,
        images: Vec<ImageAttachment>,
        lost: usize,
        ctx: &mut Ctx<'_>,
    ) {
        let store = ctx.files.map(|f| f.images(&self.name));
        let live = matches!(self.chan, Chan::Live(_));
        let prompt = match (self.client.as_mut(), live) {
            (Some(client), true) => client.prompt(&text, &images, store.as_ref()).ok(),
            _ => None,
        };
        match prompt {
            Some(out) => {
                self.persist_journal(ctx);
                self.write(
                    out.line.clone(),
                    Some(WriteTag::Prompt {
                        out,
                        text,
                        images,
                        lost,
                    }),
                    ctx,
                );
            }
            None => {
                self.outbox.record_failure(&text, images, lost, None);
            }
        }
        // A retried message left the outbox before this attempt; the stored copy follows the outcome.
        self.persist_outbox(ctx);
        self.touched();
    }

    pub fn answer_pending(&self) -> bool {
        let state = self.state();
        !state.pending_permissions().is_empty() || !state.pending_questions().is_empty()
    }

    pub fn set_option(&mut self, id: &str, value: &str, ctx: &mut Ctx<'_>) {
        if !self.can_interact() || self.client.is_none() {
            return;
        }
        self.touched.insert(id.to_string());
        if matches!(self.option_changes.get(id), Some(OptionChange::Pending(_))) {
            return;
        }
        if self
            .state()
            .option(id)
            .is_some_and(|o| o.current_value == value)
        {
            self.option_changes.remove(id);
            return;
        }
        let Some(client) = self.client.as_mut() else {
            return;
        };
        match client.set_config_option(id, value) {
            Ok(out) => {
                self.option_changes
                    .insert(id.to_string(), OptionChange::Pending(value.to_string()));
                self.persist_journal(ctx);
                self.write(
                    out.line.clone(),
                    Some(WriteTag::Config {
                        out,
                        id: id.to_string(),
                        value: value.to_string(),
                    }),
                    ctx,
                );
            }
            Err(e) => {
                self.option_changes.insert(
                    id.to_string(),
                    OptionChange::Failed(value.to_string(), describe(&e)),
                );
            }
        }
        self.touched();
    }

    pub fn attach(&mut self, source: ImageSource, ctx: &mut Ctx<'_>) {
        if self.read_only || self.has_ended() {
            return;
        }
        if self.attachments.len() >= format::MAX_IMAGES {
            self.attach_error = Some(format!(
                "Up to {} images go with one message.",
                format::MAX_IMAGES
            ));
            self.touched();
            return;
        }
        let key = uuid::Uuid::new_v4().to_string();
        self.attachments.push(Attachment {
            key: key.clone(),
            state: AttachmentState::Encoding,
        });
        ctx.out.jobs.push(ChatJob::Encode {
            name: self.name.clone(),
            key,
            source,
        });
        self.touched();
    }

    pub fn on_encoded(
        &mut self,
        key: &str,
        result: Result<(ImageAttachment, Arc<Pixels>), String>,
    ) {
        match result {
            Ok((img, thumb)) => {
                if let Some(a) = self.attachments.iter_mut().find(|a| a.key == key) {
                    a.state = AttachmentState::Ready(img, thumb);
                }
            }
            Err(message) => {
                self.attachments.retain(|a| a.key != key);
                self.attach_error = Some(message);
            }
        }
        self.touched();
    }

    pub fn on_files(&mut self, output: Option<String>, ctx: &mut Ctx<'_>) {
        self.files_loading = false;
        if let Some(output) = output {
            self.files.store(mention::parse_file_list(&output), ctx.now);
            self.touched();
        }
    }

    /// The `@` palette lists the folder again when the cached list is over a minute old; a failed
    /// listing keeps what was there and is retried the next time.
    fn load_files(&mut self, ctx: &mut Ctx<'_>) {
        if self.files_loading || !self.files.is_stale(ctx.now) || !ctx.connected {
            return;
        }
        self.files_loading = true;
        ctx.out.jobs.push(ChatJob::Exec {
            tag: ExecTag::Files {
                name: self.name.clone(),
            },
            command: mention::file_list_command(&self.cwd),
        });
    }

    pub fn slash_query(&self) -> Option<String> {
        self.slash_query_str().map(str::to_string)
    }

    fn slash_query_str(&self) -> Option<&str> {
        if self.answer_pending() || self.state().commands.is_empty() {
            return None;
        }
        if self.palette_dismissed.as_deref() == Some(self.draft.as_str()) {
            return None;
        }
        slash::query(&self.draft)
    }

    pub fn mention_token(&self) -> Option<mention::Token> {
        if self.answer_pending()
            || self.read_only
            || self.has_ended()
            || self.slash_query().is_some()
        {
            return None;
        }
        if self.palette_dismissed.as_deref() == Some(self.draft.as_str()) {
            return None;
        }
        mention::token(&self.draft, Some(self.cursor))
    }

    /// (primary, secondary) rows and whether they are commands, for the palette.
    pub fn palette(&self) -> Option<(bool, Vec<(String, String)>)> {
        if let Some(q) = self.slash_query() {
            let rows = slash::matches(&q, &self.state().commands, 20)
                .into_iter()
                .map(|c| (format!("/{}", c.name), c.description.clone()))
                .collect();
            return Some((true, rows));
        }
        let token = self.mention_token()?;
        let matches = mention::matches(&token.query, self.files.files(), 60);
        if matches.is_empty() {
            return None;
        }
        Some((
            false,
            matches
                .iter()
                .map(|m| (m.name().to_string(), m.folder().to_string()))
                .collect(),
        ))
    }

    pub fn palette_pick(&mut self, index: usize, ctx: &mut Ctx<'_>) -> bool {
        if let Some(q) = self.slash_query() {
            let commands = slash::matches(&q, &self.state().commands, 20);
            let Some(command) = commands.get(index) else {
                return false;
            };
            self.draft = slash::insertion(command).0;
            self.cursor = self.draft.chars().count();
            self.touched();
            return true;
        }
        let Some(token) = self.mention_token() else {
            return false;
        };
        let matches = mention::matches(&token.query, self.files.files(), 60);
        let Some(m) = matches.get(index) else {
            return false;
        };
        let (text, cursor) = mention::insertion(&self.draft, &token, &m.path);
        self.draft = text;
        self.cursor = cursor;
        self.load_files(ctx);
        self.touched();
        true
    }

    /// Puts `text` at the caret and moves the caret past it.
    pub fn insert_text(&mut self, text: &str) -> bool {
        if self.read_only || self.has_ended() {
            return false;
        }
        let at = self
            .draft
            .char_indices()
            .nth(self.cursor)
            .map_or(self.draft.len(), |(i, _)| i);
        self.draft.insert_str(at, text);
        self.cursor += text.chars().count();
        self.touched();
        true
    }

    fn first_question_key(&self) -> Option<String> {
        self.state()
            .pending_questions()
            .first()
            .map(|q| q.request_id.describe())
    }

    pub fn handle_ui(&mut self, msg: ChatMsg, ctx: &mut Ctx<'_>) {
        match msg {
            ChatMsg::Toggle(key) => {
                if !self.expanded.remove(&key) {
                    self.expanded.insert(key);
                }
            }
            ChatMsg::OpenTool(key) => {
                self.expanded.insert(key);
            }
            ChatMsg::Earlier => {
                self.window_start = super::rows::earlier_start(self);
            }
            // The window follows the end while the reader is there, and holds its start once
            // they scroll up, so rows never leave from under them.
            ChatMsg::Following(true) => self.window_start = None,
            ChatMsg::Following(false) => {
                if self.window_start.is_none() {
                    self.window_start = super::rows::current_start(self);
                }
            }
            ChatMsg::Retry(key) => self.retry(&key, ctx),
            ChatMsg::Discard(key) => {
                if let Ok(id) = uuid::Uuid::parse_str(&key) {
                    self.outbox.discard(id);
                    self.persist_outbox(ctx);
                }
            }
            ChatMsg::SignInRetry => self.retry_sign_in(ctx),
            ChatMsg::DismissNotice => self.notice = None,
            ChatMsg::Reconnect => self.reconnect_if_lost(ctx),
            ChatMsg::DraftEdited { text, cursor_byte } => {
                let cursor = text
                    .get(..cursor_byte.min(text.len()))
                    .map_or(text.chars().count(), |s| s.chars().count());
                if text != self.draft {
                    self.palette_dismissed = None;
                }
                self.draft = text;
                self.cursor = cursor;
                if self.mention_token().is_some() {
                    self.load_files(ctx);
                }
            }
            ChatMsg::Stop => self.stop(ctx),
            ChatMsg::RemoveAttachment(key) => self.attachments.retain(|a| a.key != key),
            ChatMsg::DismissAttachError => self.attach_error = None,
            ChatMsg::PaletteClose => self.palette_dismissed = Some(self.draft.clone()),
            ChatMsg::Approve(option) => self.approve(&option, ctx),
            ChatMsg::QuestionChoose { field, value } => self.question_choose(&field, &value, ctx),
            ChatMsg::QuestionText { name, text } => {
                if let Some(key) = self.first_question_key() {
                    self.question_drafts
                        .entry(key)
                        .or_default()
                        .set_text(&name, &text);
                }
            }
            ChatMsg::QuestionFlag { name, value } => {
                if let Some(key) = self.first_question_key() {
                    self.question_drafts
                        .entry(key)
                        .or_default()
                        .set_flag(&name, value);
                }
            }
            ChatMsg::QuestionOpenCustom(name) => {
                if let Some(key) = self.first_question_key() {
                    self.question_drafts
                        .entry(key)
                        .or_default()
                        .open_custom(&name);
                }
            }
            ChatMsg::QuestionSubmit => self.answer_question(QuestionAction::Accept, ctx),
            ChatMsg::QuestionDecline => self.answer_question(QuestionAction::Decline, ctx),
            ChatMsg::ControlsDismiss(id) => {
                if matches!(self.option_changes.get(&id), Some(OptionChange::Failed(..))) {
                    self.option_changes.remove(&id);
                }
            }
            _ => {}
        }
        self.touched();
    }

    fn retry(&mut self, key: &str, ctx: &mut Ctx<'_>) {
        let Ok(id) = uuid::Uuid::parse_str(key) else {
            return;
        };
        if !self.can_send() {
            return;
        }
        let Some(entry) = self.outbox.entry_for(id).cloned() else {
            return;
        };
        if !entry.can_retry() {
            return;
        }
        // The stored copy only changes with the outcome, so a message is never lost in between.
        self.outbox.discard(id);
        self.deliver(
            entry.text.clone(),
            entry.images.clone(),
            entry.images_lost,
            ctx,
        );
    }

    fn retry_sign_in(&mut self, ctx: &mut Ctx<'_>) {
        if !self.can_interact() || !self.needs_sign_in() || self.sign_in == SignIn::Checking {
            return;
        }
        if self.client.is_none() {
            return;
        }
        self.sign_in = SignIn::Checking;
        self.begin_handshake(ctx);
    }

    fn stop(&mut self, ctx: &mut Ctx<'_>) {
        if !self.can_interact() {
            return;
        }
        let Some(client) = self.client.as_mut() else {
            return;
        };
        match client.cancel_line() {
            Ok(out) => ctx.out.jobs.push(ChatJob::Write {
                name: self.name.clone(),
                generation: self.generation,
                bytes: out.line.clone(),
                tag: Some(WriteTag::Cancel(out)),
                ack: true,
            }),
            Err(_) => self.notice = Some("Stop didn't reach the agent. Try again.".into()),
        }
    }

    fn approve(&mut self, option: &str, ctx: &mut Ctx<'_>) {
        if !self.can_interact() {
            return;
        }
        let Some(permission) = self
            .state()
            .pending_permissions()
            .first()
            .map(|p| (*p).clone())
        else {
            return;
        };
        self.answer_failures.remove(&permission.request_id);
        let Some(client) = self.client.as_mut() else {
            return;
        };
        if let Some(line) = client.answer_permission(&permission.request_id, option) {
            self.persist_journal(ctx);
            let out = Outbound {
                id: Some(permission.request_id.clone()),
                line: line.clone(),
                undo: Undo::Permission {
                    option_id: option.to_string(),
                },
            };
            self.write(line, Some(WriteTag::Answer(out)), ctx);
        }
    }

    fn question_choose(&mut self, field: &str, value: &str, ctx: &mut Ctx<'_>) {
        let Some(question) = self
            .state()
            .pending_questions()
            .first()
            .map(|q| (*q).clone())
        else {
            return;
        };
        let key = question.request_id.describe();
        let Some(f) = question.fields.iter().find(|f| f.name == field) else {
            return;
        };
        let draft = self.question_drafts.entry(key).or_default();
        draft.choose(f, value);
        let submit = draft.submits_on_tap(&question.fields);
        if submit {
            self.answer_question(QuestionAction::Accept, ctx);
        }
    }

    fn answer_question(&mut self, action: QuestionAction, ctx: &mut Ctx<'_>) {
        if !self.can_interact() {
            return;
        }
        let Some(question) = self
            .state()
            .pending_questions()
            .first()
            .map(|q| (*q).clone())
        else {
            return;
        };
        let key = question.request_id.describe();
        let draft = self.question_drafts.get(&key).cloned().unwrap_or_default();
        if action == QuestionAction::Accept && !draft.can_submit(&question.fields) {
            return;
        }
        let content = if action == QuestionAction::Accept {
            draft.content(&question.fields)
        } else {
            Default::default()
        };
        self.answer_failures.remove(&question.request_id);
        let Some(client) = self.client.as_mut() else {
            return;
        };
        if let Some(line) = client.answer_question(&question.request_id, action, content.clone()) {
            self.persist_journal(ctx);
            let out = Outbound {
                id: Some(question.request_id.clone()),
                line: line.clone(),
                undo: Undo::Question { action, content },
            };
            self.write(line, Some(WriteTag::Answer(out)), ctx);
        }
    }
}
