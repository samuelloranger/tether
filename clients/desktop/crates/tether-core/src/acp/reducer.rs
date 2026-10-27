use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use super::auth::matches_auth_error;
use super::images::ImageRef;
use super::message::{
    AcpDiff, AcpId, Command, ConfigOption, Cost, Inbound, PermissionOption, PlanEntry, ToolFields,
    ToolKind, ToolStatus, Update,
};
use super::question::{
    ElicitationRequest, Question, QuestionAction, QuestionState, QuestionValue, TOOL_NAME,
};

pub const LAUNCH_TOOL_NAMES: [&str; 2] = ["Agent", "Task"];
pub const ASYNC_LAUNCH_PREFIX: &str = "Async agent launched successfully";

/// A subagent launch, as the adapter's `Agent` tool (older `Task`) describes it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Subagent {
    pub description: Option<String>,
    pub model: Option<String>,
    pub subagent_type: Option<String>,
    pub prompt: Option<String>,
    /// Set by `run_in_background` or by the launch result; a background run reports back as assistant text.
    pub background: bool,
}

impl Subagent {
    pub fn merge(&mut self, input: &BTreeMap<String, String>) {
        if let Some(v) = input.get("description") {
            self.description = Some(v.clone());
        }
        if let Some(v) = input.get("model") {
            self.model = Some(v.clone());
        }
        if let Some(v) = input.get("subagent_type") {
            self.subagent_type = Some(v.clone());
        }
        if let Some(v) = input.get("prompt") {
            self.prompt = Some(v.clone());
        }
        if input.get("run_in_background").map(String::as_str) == Some("true") {
            self.background = true;
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub title: String,
    pub kind: ToolKind,
    pub status: ToolStatus,
    pub diff: Option<AcpDiff>,
    pub text: Option<String>,
    pub raw_output: Option<String>,
    /// The pictures the result carried; the files live in the chat's image store.
    #[serde(default)]
    pub images: Vec<ImageRef>,
    pub parent_id: Option<String>,
    pub subagent: Option<Subagent>,
    /// A launch row's own tool calls, in arrival order.
    #[serde(default)]
    pub children: Vec<ToolCall>,
    #[serde(default)]
    pub has_terminal: bool,
    #[serde(default)]
    pub background_task_id: Option<String>,
    #[serde(default)]
    pub terminal_exited: bool,
    /// The command's raw output, kept so a delta can be appended before the text is fenced again.
    #[serde(default)]
    pub terminal_data: String,
}

impl ToolCall {
    pub fn new(fields: &ToolFields) -> Self {
        let mut call = Self {
            id: fields.id.clone(),
            title: fields.title.clone().unwrap_or_else(|| "Tool".into()),
            kind: fields.kind.unwrap_or(ToolKind::Other),
            status: fields.status.unwrap_or(ToolStatus::Pending),
            diff: fields.diff.clone(),
            text: None,
            raw_output: None,
            images: Vec::new(),
            parent_id: fields.parent_id.clone(),
            subagent: None,
            children: Vec::new(),
            has_terminal: false,
            background_task_id: None,
            terminal_exited: false,
            terminal_data: String::new(),
        };
        if let Some(name) = &fields.tool_name
            && LAUNCH_TOOL_NAMES.contains(&name.as_str())
        {
            call.subagent = Some(Subagent::default());
        }
        call.merge(fields);
        call
    }

    pub fn merge(&mut self, fields: &ToolFields) {
        if let Some(v) = &fields.title {
            self.title = v.clone();
        }
        if let Some(v) = fields.kind {
            self.kind = v;
        }
        if let Some(v) = fields.status {
            self.status = v;
        }
        if let Some(v) = &fields.diff {
            self.diff = Some(v.clone());
        }
        if let Some(v) = &fields.parent_id {
            self.parent_id = Some(v.clone());
        }
        if let Some(v) = &fields.raw_output {
            self.raw_output = Some(v.clone());
        }
        if let Some(v) = &fields.images
            && !v.is_empty()
        {
            self.images = v.clone();
        }
        self.has_terminal |= fields.has_terminal;
        self.terminal_exited |= fields.terminal_exit;
        if let Some(id) = &fields.background_task_id {
            self.background_task_id = Some(id.clone());
        }
        let mut terminal_text = None;
        if let Some(data) = &fields.terminal_data {
            self.terminal_data = data.clone();
            terminal_text = Some(console_fence(&self.terminal_data));
        }
        if let Some(delta) = &fields.terminal_delta {
            self.terminal_data.push_str(delta);
            terminal_text = Some(console_fence(&self.terminal_data));
        }
        if let Some(sub) = self.subagent.as_mut() {
            if let Some(input) = &fields.input {
                sub.merge(input);
            }
            match &fields.text {
                Some(v) if v.starts_with(ASYNC_LAUNCH_PREFIX) => sub.background = true,
                Some(v) => self.text = Some(v.clone()),
                None => {}
            }
        } else if let Some(v) = terminal_text.as_ref().or(fields.text.as_ref()) {
            self.text = Some(v.clone());
        }
    }

    /// A command the agent sent to the background that has not ended. A chat whose agent
    /// predates the terminal metadata never reports an end, so one without a terminal does not count.
    pub fn is_background_running(&self) -> bool {
        self.background_task_id.is_some() && self.has_terminal && !self.terminal_exited
    }

    pub fn is_running(&self) -> bool {
        matches!(self.status, ToolStatus::Pending | ToolStatus::InProgress)
    }

    /// Whether the row should show a spinner: its own call, or a background run still making calls.
    pub fn is_active(&self) -> bool {
        self.is_running()
            || (self.subagent.as_ref().is_some_and(|s| s.background)
                && self.children.iter().any(ToolCall::is_running))
    }

    pub fn subagent_title(&self) -> String {
        if let Some(d) = self.subagent.as_ref().and_then(|s| s.description.as_ref())
            && !d.is_empty()
        {
            return d.clone();
        }
        if self.title == "Task" || self.title == "Agent" {
            "Subagent".into()
        } else {
            self.title.clone()
        }
    }
}

/// The text a Bash row and its detail show for output, as older adapters sent it.
fn console_fence(data: &str) -> String {
    format!("```console\n{}\n```", data.trim_end())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CompactionStatus {
    InProgress,
    Completed,
    Failed,
    Cancelled,
}

impl CompactionStatus {
    fn parse(text: &str) -> Option<Self> {
        Some(match text {
            "in_progress" => Self::InProgress,
            "completed" => Self::Completed,
            "failed" => Self::Failed,
            "cancelled" => Self::Cancelled,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Permission {
    pub request_id: AcpId,
    pub tool_call_id: String,
    pub title: String,
    pub kind: ToolKind,
    pub diff: Option<AcpDiff>,
    pub text: Option<String>,
    pub options: Vec<PermissionOption>,
    /// The option the user picked, or "cancelled"; None while the agent is still waiting.
    pub resolved_option_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Item {
    pub id: i64,
    pub kind: ItemKind,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum ItemKind {
    User {
        text: String,
        image_count: usize,
        offset: usize,
        images: Vec<ImageRef>,
    },
    Assistant {
        text: String,
        message_id: Option<String>,
    },
    /// Pictures the agent sent in its message, in order with the text around them.
    Images {
        refs: Vec<ImageRef>,
        message_id: Option<String>,
    },
    Thought {
        text: String,
    },
    Tool(ToolCall),
    Permission(Permission),
    Question(Question),
    Plan(Vec<PlanEntry>),
    Notice(String),
    /// A notice the agent raised, with its severity (`info`, `warning`, `error`; absent when unsaid).
    AgentNotice {
        severity: Option<String>,
        title: String,
        description: Option<String>,
    },
    /// One context compaction; the summary may arrive in chunks before the final status.
    Compaction {
        compaction_id: String,
        status: CompactionStatus,
        summary: String,
    },
    Error(String),
    /// A quiet rule in the transcript, such as where the agent's context was cleared.
    Divider(String),
    /// The agent refused for lack of a login on its host; the view names the host.
    SignedOut,
}

impl ItemKind {
    pub fn user(text: &str, offset: usize) -> Self {
        Self::User {
            text: text.to_string(),
            image_count: 0,
            offset,
            images: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Turn {
    Idle,
    Working,
}

/// Swift's `Connection`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LinkState {
    Live,
    Lost,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InFlightPrompt {
    pub item_id: i64,
    /// None for a prompt journaled before ids were recorded; such a response matches the oldest.
    pub request_id: Option<AcpId>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChatState {
    pub items: Vec<Item>,
    pub turn: Turn,
    pub connection: LinkState,
    pub session_id: Option<String>,
    pub title: Option<String>,
    pub mode_id: Option<String>,
    pub config_options: Vec<ConfigOption>,
    pub commands: Vec<Command>,
    pub cost: Option<Cost>,
    pub model_id: Option<String>,
    pub context_used: Option<i64>,
    pub context_size: Option<i64>,
    pub last_stop_reason: Option<String>,
    pub load_session: Option<bool>,
    /// User messages sent while an earlier prompt was still running, until the agent starts them.
    /// Owned by the reducer: read it, do not write it.
    pub queued_item_ids: Vec<i64>,
    in_flight: Vec<InFlightPrompt>,
    /// A prompt just ended while others wait: the next agent output or echoed message starts the oldest.
    start_pending: bool,
    next_item_id: i64,
    /// Requests whose failure belongs to the caller, not the transcript.
    silent_request_ids: BTreeSet<AcpId>,
    /// Answers the host took while no client was attached, so a replayed request shows resolved.
    host_answers: Vec<(AcpId, String)>,
    /// The question tool's own calls: the question row stands for them.
    question_tool_ids: BTreeSet<String>,
    /// The id of the replayed user message the last user row came from, so two messages in a row stay two rows.
    last_user_message_id: Option<String>,
    /// The turn running now was started by the agent itself (a finished background command), so no prompt is in flight.
    #[serde(default)]
    agent_started: bool,
    /// Until the answer to `session/new` or `session/load` arrives, agent output is history, not a turn.
    /// A snapshot from before this field was taken after that answer, hence the false default on decode.
    #[serde(default)]
    awaiting_session: bool,
}

impl Default for ChatState {
    fn default() -> Self {
        Self {
            items: Vec::new(),
            turn: Turn::Idle,
            connection: LinkState::Live,
            session_id: None,
            title: None,
            mode_id: None,
            config_options: Vec::new(),
            commands: Vec::new(),
            cost: None,
            model_id: None,
            context_used: None,
            context_size: None,
            last_stop_reason: None,
            load_session: None,
            queued_item_ids: Vec::new(),
            in_flight: Vec::new(),
            start_pending: false,
            next_item_id: 0,
            silent_request_ids: BTreeSet::new(),
            host_answers: Vec::new(),
            question_tool_ids: BTreeSet::new(),
            last_user_message_id: None,
            agent_started: false,
            awaiting_session: true,
        }
    }
}

impl ChatState {
    pub fn is_queued(&self, item_id: i64) -> bool {
        self.queued_item_ids.contains(&item_id)
    }

    /// What a Stop sends again: the waiting messages' text as one prompt. Their pictures are not
    /// kept for it, so they are only counted, for the notice that says so.
    pub fn queued_resend(&self) -> (String, usize) {
        let images = self
            .queued_item_ids
            .iter()
            .filter_map(|id| self.items.iter().find(|i| i.id == *id))
            .map(|i| match &i.kind {
                ItemKind::User { image_count, .. } => *image_count,
                _ => 0,
            })
            .sum();
        (self.queued_texts().join("\n\n"), images)
    }

    /// The text of each message waiting for the running turn, oldest first.
    pub fn queued_texts(&self) -> Vec<String> {
        self.queued_item_ids
            .iter()
            .filter_map(|id| self.items.iter().find(|i| i.id == *id))
            .filter_map(|i| match &i.kind {
                ItemKind::User { text, .. } if !text.trim().is_empty() => Some(text.clone()),
                _ => None,
            })
            .collect()
    }

    pub fn option(&self, id: &str) -> Option<&ConfigOption> {
        self.config_options.iter().find(|o| o.id == id)
    }

    /// The human name of the option's current choice, for a chip.
    pub fn current_choice(&self, id: &str) -> Option<String> {
        let option = self.option(id)?;
        Some(
            option
                .choices
                .iter()
                .find(|c| c.value == option.current_value)
                .map(|c| c.name.clone())
                .unwrap_or_else(|| option.current_value.clone()),
        )
    }

    /// What a running subagent is doing now, for the working indicator.
    pub fn subagent_activity(&self) -> Option<String> {
        for item in self.items.iter().rev() {
            let ItemKind::Tool(call) = &item.kind else {
                continue;
            };
            if call.subagent.is_none() || !call.is_active() {
                continue;
            }
            let latest = call
                .children
                .iter()
                .rev()
                .find(|c| c.is_running())
                .or(call.children.last());
            return Some(match latest {
                None => call.subagent_title(),
                Some(latest) => format!("{} \u{00B7} {}", call.subagent_title(), latest.title),
            });
        }
        None
    }

    /// The background commands still running, oldest first, with the row each one belongs to.
    pub fn background_commands(&self) -> Vec<&ToolCall> {
        let mut out = Vec::new();
        for item in &self.items {
            if let ItemKind::Tool(call) = &item.kind {
                if call.is_background_running() {
                    out.push(call);
                }
                out.extend(call.children.iter().filter(|c| c.is_background_running()));
            }
        }
        out
    }

    pub fn pending_permissions(&self) -> Vec<&Permission> {
        self.items
            .iter()
            .filter_map(|i| match &i.kind {
                ItemKind::Permission(p) if p.resolved_option_id.is_none() => Some(p),
                _ => None,
            })
            .collect()
    }

    pub fn pending_questions(&self) -> Vec<&Question> {
        self.items
            .iter()
            .filter_map(|i| match &i.kind {
                ItemKind::Question(q) if q.is_pending() => Some(q),
                _ => None,
            })
            .collect()
    }
}

#[derive(Debug, Clone, PartialEq)]
#[allow(clippy::large_enum_variant)]
pub enum ChatEvent {
    Message(Inbound),
    UserPrompt {
        text: String,
        image_count: usize,
        at_offset: usize,
        request_id: Option<AcpId>,
        images: Vec<ImageRef>,
    },
    /// The user pressed Stop: messages still waiting to start are no longer shown as queued.
    CancelRequested,
    /// A request whose error response must not surface as a transcript row.
    SilentRequest {
        request_id: AcpId,
    },
    PermissionAnswered {
        request_id: AcpId,
        option_id: String,
    },
    /// The answer never reached the agent: the card asks again, unless something else resolved it since.
    PermissionAnswerUndelivered {
        request_id: AcpId,
        option_id: String,
    },
    /// The host answered this request itself; the card resolves now or when the request arrives.
    HostAnswered {
        request_id: AcpId,
        option_id: String,
    },
    /// The user answered, declined or cancelled a question; `content` is only meaningful for an accept.
    QuestionAnswered {
        request_id: AcpId,
        action: QuestionAction,
        content: BTreeMap<String, QuestionValue>,
    },
    /// The answer never reached the agent: the question asks again, unless something else resolved it since.
    QuestionAnswerUndelivered {
        request_id: AcpId,
        action: QuestionAction,
        content: BTreeMap<String, QuestionValue>,
    },
    /// The prompt never reached the agent: drop it from the transcript and end the turn it opened.
    PromptUndelivered {
        text: String,
        image_count: usize,
        at_offset: usize,
        request_id: Option<AcpId>,
        images: Vec<ImageRef>,
    },
    ConnectionLost,
    Failure(String),
}

impl ChatEvent {
    pub fn user_prompt(text: &str, at_offset: usize, request_id: Option<AcpId>) -> Self {
        Self::UserPrompt {
            text: text.to_string(),
            image_count: 0,
            at_offset,
            request_id,
            images: Vec::new(),
        }
    }
}

pub fn reduce(state: &mut ChatState, event: ChatEvent) {
    match event {
        ChatEvent::Message(message) => apply(&message, state),
        ChatEvent::UserPrompt {
            text,
            image_count,
            at_offset,
            request_id,
            images,
        } => {
            let item_id = state.next_item_id;
            append(
                ItemKind::User {
                    text,
                    image_count,
                    offset: at_offset,
                    images,
                },
                state,
            );
            if !state.in_flight.is_empty() {
                state.queued_item_ids.push(item_id);
                move_to_end(item_id, state);
            }
            state.in_flight.push(InFlightPrompt {
                item_id,
                request_id,
            });
            state.agent_started = false;
            state.turn = Turn::Working;
        }
        ChatEvent::CancelRequested => {
            // The agent drops every prompt that has not started, so they leave the transcript; the
            // client that pressed Stop sends their text again as one new prompt.
            let queued = std::mem::take(&mut state.queued_item_ids);
            state.items.retain(|i| !queued.contains(&i.id));
            state.in_flight.retain(|p| !queued.contains(&p.item_id));
            state.start_pending = false;
            if state.turn == Turn::Working {
                append(ItemKind::Notice("Stopped".into()), state);
            }
            state.agent_started = false;
            state.turn = turn_for(state);
        }
        ChatEvent::SilentRequest { request_id } => {
            state.silent_request_ids.insert(request_id);
        }
        ChatEvent::PermissionAnswered {
            request_id,
            option_id,
        } => resolve(&request_id, &option_id, state),
        ChatEvent::PermissionAnswerUndelivered {
            request_id,
            option_id,
        } => reopen(&request_id, &option_id, state),
        ChatEvent::QuestionAnswered {
            request_id,
            action,
            content,
        } => resolve_question(
            &request_id,
            QuestionState::from_action(action, content),
            state,
        ),
        ChatEvent::QuestionAnswerUndelivered {
            request_id,
            action,
            content,
        } => reopen_question(
            &request_id,
            &QuestionState::from_action(action, content),
            state,
        ),
        ChatEvent::HostAnswered {
            request_id,
            option_id,
        } => {
            match state
                .host_answers
                .iter_mut()
                .find(|(id, _)| *id == request_id)
            {
                Some(entry) => entry.1 = option_id.clone(),
                None => state
                    .host_answers
                    .push((request_id.clone(), option_id.clone())),
            }
            resolve(&request_id, &option_id, state);
            resolve_question_host(&request_id, &option_id, state);
        }
        ChatEvent::PromptUndelivered {
            text,
            image_count,
            at_offset,
            images,
            ..
        } => {
            let wanted = ItemKind::User {
                text,
                image_count,
                offset: at_offset,
                images,
            };
            if let Some(index) = state.items.iter().rposition(|i| i.kind == wanted) {
                let item_id = state.items[index].id;
                state.items.remove(index);
                state.in_flight.retain(|p| p.item_id != item_id);
                state.queued_item_ids.retain(|q| *q != item_id);
                if state.queued_item_ids.is_empty() {
                    state.start_pending = false;
                }
            }
            state.turn = turn_for(state);
        }
        ChatEvent::ConnectionLost => state.connection = LinkState::Lost,
        ChatEvent::Failure(message) => {
            append(ItemKind::Error(message), state);
            state.connection = LinkState::Lost;
        }
    }
}

fn turn_for(state: &ChatState) -> Turn {
    if state.in_flight.is_empty() && !state.agent_started {
        Turn::Idle
    } else {
        Turn::Working
    }
}

/// Queued messages wait at the end of `items` in the order they were sent; everything else goes
/// in before them, so the running turn keeps streaming into its own rows.
fn open_end(state: &ChatState) -> usize {
    let mut end = state.items.len();
    while end > 0 && state.queued_item_ids.contains(&state.items[end - 1].id) {
        end -= 1;
    }
    end
}

fn last_open(state: &mut ChatState) -> Option<&mut Item> {
    let end = open_end(state);
    state.items[..end].last_mut()
}

fn append(kind: ItemKind, state: &mut ChatState) {
    let at = open_end(state);
    state.items.insert(
        at,
        Item {
            id: state.next_item_id,
            kind,
        },
    );
    state.next_item_id += 1;
}

fn apply(message: &Inbound, state: &mut ChatState) {
    match message {
        Inbound::Response { id, result } => {
            if let Some(s) = &result.session_id {
                state.session_id = Some(s.clone());
            }
            if let Some(load) = result.load_session {
                state.load_session = Some(load);
            }
            if let Some(options) = &result.config_options {
                set_config_options(options, state);
            }
            if result.session_established {
                state.awaiting_session = false;
                end_background_commands(state);
            }
            if let Some(reason) = &result.stop_reason {
                let finished = finish_prompt(id, state);
                state.last_stop_reason = Some(reason.clone());
                if let Some(item_id) = finished {
                    mark_end(item_id, reason, state);
                }
                end_pending_questions(state);
            }
        }
        Inbound::ErrorResponse { id, code, message } => {
            // A failed session/load is the session answer too: what follows is live, not history.
            if let Some(id) = id
                && !state
                    .in_flight
                    .iter()
                    .any(|p| p.request_id.as_ref() == Some(id))
            {
                state.awaiting_session = false;
            }
            if let Some(id) = id
                && state.silent_request_ids.contains(id)
            {
                return;
            }
            if let Some(id) = id {
                finish_prompt(id, state);
            } else {
                state.turn = turn_for(state);
            }
            if matches_auth_error(*code, message) {
                mark_signed_out(state);
            } else {
                append(
                    ItemKind::Error(if message.is_empty() {
                        format!("Agent error {code}")
                    } else {
                        message.clone()
                    }),
                    state,
                );
            }
            end_pending_questions(state);
        }
        Inbound::PermissionRequest { id, request } => {
            start_queued(state);
            merge_tool(&request.tool, false, state);
            append(
                ItemKind::Permission(Permission {
                    request_id: id.clone(),
                    tool_call_id: request.tool.id.clone(),
                    title: request
                        .tool
                        .title
                        .clone()
                        .unwrap_or_else(|| "Permission requested".into()),
                    kind: request.tool.kind.unwrap_or(ToolKind::Other),
                    diff: request.tool.diff.clone(),
                    text: request.tool.text.clone(),
                    options: request.options.clone(),
                    resolved_option_id: None,
                }),
                state,
            );
            if let Some(option_id) = host_answer(state, id) {
                resolve(id, &option_id, state);
            }
        }
        Inbound::Elicitation { id, request } => {
            start_queued(state);
            elicitation(id, request, state);
        }
        Inbound::Update(update) => apply_update(update, state),
        Inbound::AuthStatus { signed_in } => {
            start_queued(state);
            if *signed_in {
                state.items.retain(|i| i.kind != ItemKind::SignedOut);
            } else {
                mark_signed_out(state);
            }
        }
        // Translated by the transcript builder, which knows which client this is.
        Inbound::ClientEcho { .. } | Inbound::Unknown { .. } => {}
    }
}

fn host_answer(state: &ChatState, id: &AcpId) -> Option<String> {
    state
        .host_answers
        .iter()
        .find(|(k, _)| k == id)
        .map(|(_, v)| v.clone())
}

fn elicitation(id: &AcpId, request: &ElicitationRequest, state: &mut ChatState) {
    if let Some(tool) = &request.tool_call_id {
        state.question_tool_ids.insert(tool.clone());
    }
    append(
        ItemKind::Question(Question {
            request_id: id.clone(),
            tool_call_id: request.tool_call_id.clone(),
            message: request.message.clone(),
            fields: request.fields.clone(),
            state: QuestionState::Pending,
        }),
        state,
    );
    if let Some(value) = host_answer(state, id) {
        resolve_question_host(id, &value, state);
    }
}

fn apply_update(update: &Update, state: &mut ChatState) {
    match update {
        Update::AgentMessage { text, message_id } => {
            start_queued(state);
            begin_agent_turn(state);
            if let Some(last) = last_open(state)
                && let ItemKind::Assistant {
                    text: existing,
                    message_id: existing_id,
                } = &mut last.kind
                && existing_id == message_id
            {
                existing.push_str(text);
                return;
            }
            append(
                ItemKind::Assistant {
                    text: text.clone(),
                    message_id: message_id.clone(),
                },
                state,
            );
        }
        Update::AgentImage { image, message_id } => {
            start_queued(state);
            begin_agent_turn(state);
            if let Some(last) = last_open(state)
                && let ItemKind::Images {
                    refs,
                    message_id: existing_id,
                } = &mut last.kind
                && existing_id == message_id
            {
                refs.push(image.clone());
                return;
            }
            append(
                ItemKind::Images {
                    refs: vec![image.clone()],
                    message_id: message_id.clone(),
                },
                state,
            );
        }
        Update::AgentThought { text } => {
            start_queued(state);
            begin_agent_turn(state);
            if let Some(last) = last_open(state)
                && let ItemKind::Thought { text: existing } = &mut last.kind
            {
                existing.push_str(text);
                return;
            }
            append(ItemKind::Thought { text: text.clone() }, state);
        }
        Update::UserMessage { text, message_id } => {
            if let Some(&first) = state.queued_item_ids.first() {
                unqueue(first, state);
                state.start_pending = false;
                if let Some(item) = state.items.iter().find(|i| i.id == first)
                    && let ItemKind::User { text: echoed, .. } = &item.kind
                    && echoed == text
                {
                    return;
                }
            }
            let same_message = message_id.is_none()
                || state.last_user_message_id.is_none()
                || *message_id == state.last_user_message_id;
            let merged = match last_open(state) {
                Some(Item {
                    kind: ItemKind::User { text: existing, .. },
                    ..
                }) if same_message => {
                    existing.push_str(text);
                    true
                }
                _ => false,
            };
            if !merged {
                append(ItemKind::user(text, 0), state);
            }
            state.last_user_message_id = message_id.clone();
        }
        Update::ToolCall(fields) | Update::ToolCallUpdate(fields) => {
            start_queued(state);
            if fields.tool_name.as_deref() == Some(TOOL_NAME) {
                state.question_tool_ids.insert(fields.id.clone());
            }
            if state.question_tool_ids.contains(&fields.id) {
                return;
            }
            if matches!(update, Update::ToolCall(_)) {
                begin_agent_turn(state);
            }
            merge_tool(fields, true, state);
        }
        Update::Plan(entries) => {
            start_queued(state);
            let mut replaced = false;
            let end = open_end(state);
            for item in state.items[..end].iter_mut().rev() {
                if matches!(item.kind, ItemKind::User { .. }) {
                    break;
                }
                if matches!(item.kind, ItemKind::Plan(_)) {
                    item.kind = ItemKind::Plan(entries.clone());
                    replaced = true;
                    break;
                }
            }
            if !replaced {
                append(ItemKind::Plan(entries.clone()), state);
            }
        }
        Update::CurrentMode(mode) => {
            state.mode_id = Some(mode.clone());
            if let Some(option) = state.config_options.iter_mut().find(|o| o.id == "mode") {
                option.current_value = mode.clone();
            }
        }
        Update::ConfigOptions(options) => set_config_options(options, state),
        Update::Commands(commands) => state.commands = commands.clone(),
        Update::SessionInfo { title } => {
            if let Some(title) = title {
                state.title = Some(title.clone());
            }
        }
        Update::Usage {
            used,
            size,
            cost,
            model_id,
        } => {
            state.context_used = Some(*used);
            state.context_size = Some(*size);
            if let Some(cost) = cost {
                state.cost = Some(cost.clone());
                if state.agent_started && state.in_flight.is_empty() {
                    state.agent_started = false;
                    state.turn = turn_for(state);
                }
            }
            if let Some(model) = model_id {
                state.model_id = Some(model.clone());
            }
        }
        Update::Notice {
            severity,
            title,
            description,
        } => append(
            ItemKind::AgentNotice {
                severity: severity.clone(),
                title: title.clone(),
                description: description.clone(),
            },
            state,
        ),
        Update::Compaction {
            id,
            status,
            summary,
        } => {
            let status = CompactionStatus::parse(status);
            match compaction_index(id, state) {
                Some(index) => {
                    if let ItemKind::Compaction {
                        status: current,
                        summary: text,
                        ..
                    } = &mut state.items[index].kind
                    {
                        if let Some(status) = status {
                            *current = status;
                        }
                        if let Some(summary) = summary {
                            *text = summary.clone();
                        }
                    }
                }
                None => append(
                    ItemKind::Compaction {
                        compaction_id: id.clone(),
                        status: status.unwrap_or(CompactionStatus::InProgress),
                        summary: summary.clone().unwrap_or_default(),
                    },
                    state,
                ),
            }
        }
        Update::CompactionChunk { id, text } => match compaction_index(id, state) {
            Some(index) => {
                if let ItemKind::Compaction { summary, .. } = &mut state.items[index].kind {
                    summary.push_str(text);
                }
            }
            None => append(
                ItemKind::Compaction {
                    compaction_id: id.clone(),
                    status: CompactionStatus::InProgress,
                    summary: text.clone(),
                },
                state,
            ),
        },
        Update::Unknown { .. } => {}
    }
}

fn compaction_index(id: &str, state: &ChatState) -> Option<usize> {
    state.items.iter().rposition(
        |i| matches!(&i.kind, ItemKind::Compaction { compaction_id, .. } if compaction_id == id),
    )
}

/// Agent output with no prompt in flight and no history being replayed is a turn the agent began
/// on its own, such as the report after a background command ended.
fn begin_agent_turn(state: &mut ChatState) {
    if state.in_flight.is_empty() && !state.awaiting_session && !state.agent_started {
        state.agent_started = true;
        state.turn = Turn::Working;
    }
}

fn end_background_commands(state: &mut ChatState) {
    for item in &mut state.items {
        if let ItemKind::Tool(call) = &mut item.kind {
            call.terminal_exited = true;
            for child in &mut call.children {
                child.terminal_exited = true;
            }
        }
    }
}

fn mark_signed_out(state: &mut ChatState) {
    if matches!(
        state.items[..open_end(state)].last().map(|i| &i.kind),
        Some(ItemKind::SignedOut)
    ) {
        return;
    }
    append(ItemKind::SignedOut, state);
}

/// Agent output after a prompt ended is what tells the next waiting message has begun.
fn start_queued(state: &mut ChatState) {
    if !state.start_pending || state.queued_item_ids.is_empty() {
        return;
    }
    unqueue(state.queued_item_ids[0], state);
    state.start_pending = false;
}

fn move_to_end(item_id: i64, state: &mut ChatState) {
    if let Some(index) = state.items.iter().position(|i| i.id == item_id) {
        let item = state.items.remove(index);
        state.items.push(item);
    }
}

/// A queued message that starts joins the transcript below what came before it, ahead of the
/// messages still waiting.
fn unqueue(item_id: i64, state: &mut ChatState) {
    state.queued_item_ids.retain(|q| *q != item_id);
    if let Some(index) = state.items.iter().position(|i| i.id == item_id) {
        let item = state.items.remove(index);
        let at = open_end(state);
        state.items.insert(at, item);
    }
}

/// Takes the prompt a response answers out of the in-flight list; the turn stays working until
/// the last one is answered.
fn finish_prompt(id: &AcpId, state: &mut ChatState) -> Option<i64> {
    let index = state
        .in_flight
        .iter()
        .position(|p| p.request_id.as_ref() == Some(id))
        .or_else(|| state.in_flight.iter().position(|p| p.request_id.is_none()));
    let mut finished = None;
    if let Some(index) = index {
        let prompt = state.in_flight.remove(index);
        if state.queued_item_ids.contains(&prompt.item_id) {
            unqueue(prompt.item_id, state);
        }
        finished = Some(prompt.item_id);
        state.start_pending = !state.queued_item_ids.is_empty();
    }
    state.turn = turn_for(state);
    finished
}

/// `/clear` and `/compact` end silently; a rule marks where the agent's context changed.
fn mark_end(prompt_item: i64, reason: &str, state: &mut ChatState) {
    if reason != "end_turn" {
        return;
    }
    let Some(start) = state.items.iter().position(|i| i.id == prompt_item) else {
        return;
    };
    let ItemKind::User { text, .. } = &state.items[start].kind else {
        return;
    };
    let label = match text.trim() {
        "/clear" => "Context cleared",
        "/compact" => {
            if state.items[start + 1..]
                .iter()
                .any(|i| matches!(i.kind, ItemKind::Compaction { .. }))
            {
                return;
            }
            let announced = state.items[start + 1..].iter().any(|i| match &i.kind {
                ItemKind::Assistant { text, .. } => text.to_lowercase().contains("compact"),
                _ => false,
            });
            if announced {
                return;
            }
            "Context compacted"
        }
        _ => return,
    };
    let later = (start + 1..state.items.len()).find(|&index| {
        state
            .in_flight
            .iter()
            .any(|p| p.item_id == state.items[index].id)
    });
    let item = Item {
        id: state.next_item_id,
        kind: ItemKind::Divider(label.into()),
    };
    state.next_item_id += 1;
    state.items.insert(later.unwrap_or(state.items.len()), item);
}

fn set_config_options(options: &[ConfigOption], state: &mut ChatState) {
    state.config_options = options.to_vec();
    if let Some(mode) = options.iter().find(|o| o.id == "mode") {
        state.mode_id = Some(mode.current_value.clone());
    }
}

fn merge_tool(fields: &ToolFields, creating: bool, state: &mut ChatState) {
    for item in state.items.iter_mut().rev() {
        let ItemKind::Tool(call) = &mut item.kind else {
            continue;
        };
        if call.id == fields.id {
            call.merge(fields);
            return;
        }
        if let Some(child) = call.children.iter_mut().find(|c| c.id == fields.id) {
            child.merge(fields);
            return;
        }
    }
    if !creating {
        return;
    }
    if let Some(parent_id) = &fields.parent_id
        && let Some(index) = launch_index(parent_id, state)
        && let ItemKind::Tool(call) = &mut state.items[index].kind
    {
        call.children.push(ToolCall::new(fields));
        return;
    }
    append(ItemKind::Tool(ToolCall::new(fields)), state);
}

/// The top-level row a child belongs under; a subagent launched by a subagent shares its parent's list.
fn launch_index(parent_id: &str, state: &ChatState) -> Option<usize> {
    state.items.iter().rposition(|item| match &item.kind {
        ItemKind::Tool(call) => {
            call.id == parent_id || call.children.iter().any(|c| c.id == parent_id)
        }
        _ => false,
    })
}

fn set_question(
    request_id: &AcpId,
    state: &mut ChatState,
    change: impl FnOnce(&mut Question) -> bool,
) {
    for item in state.items.iter_mut().rev() {
        if let ItemKind::Question(q) = &mut item.kind
            && q.request_id == *request_id
        {
            change(q);
            return;
        }
    }
}

fn resolve_question(request_id: &AcpId, resolution: QuestionState, state: &mut ChatState) {
    set_question(request_id, state, |q| {
        if !q.is_pending() {
            return false;
        }
        q.state = resolution;
        true
    });
}

fn resolve_question_host(request_id: &AcpId, value: &str, state: &mut ChatState) {
    set_question(request_id, state, |q| {
        if !q.is_pending() {
            return false;
        }
        q.state = q.host_state(value);
        true
    });
}

fn reopen_question(request_id: &AcpId, resolution: &QuestionState, state: &mut ChatState) {
    set_question(request_id, state, |q| {
        if q.state != *resolution {
            return false;
        }
        q.state = QuestionState::Pending;
        true
    });
}

/// A finished turn leaves nothing to answer: the agent has stopped waiting, as the holder sees it.
fn end_pending_questions(state: &mut ChatState) {
    for item in &mut state.items {
        if let ItemKind::Question(q) = &mut item.kind
            && q.is_pending()
        {
            q.state = QuestionState::Cancelled;
        }
    }
}

fn reopen(request_id: &AcpId, option_id: &str, state: &mut ChatState) {
    for item in state.items.iter_mut().rev() {
        if let ItemKind::Permission(p) = &mut item.kind
            && p.request_id == *request_id
            && p.resolved_option_id.as_deref() == Some(option_id)
        {
            p.resolved_option_id = None;
            return;
        }
    }
}

fn resolve(request_id: &AcpId, option_id: &str, state: &mut ChatState) {
    for item in state.items.iter_mut().rev() {
        if let ItemKind::Permission(p) = &mut item.kind
            && p.request_id == *request_id
            && p.resolved_option_id.is_none()
        {
            p.resolved_option_id = Some(option_id.to_string());
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::message::{AcpResult, PermissionRequest, decode};
    use crate::acp::question::{FieldKind, QuestionChoice, QuestionField};
    use serde_json::{Value, json};

    fn done(id: i64, reason: &str) -> Inbound {
        decode(
            format!(
                "{{\"jsonrpc\":\"2.0\",\"id\":{id},\"result\":{{\"stopReason\":\"{reason}\"}}}}"
            )
            .as_bytes(),
            None,
        )
    }

    fn msg(state: &mut ChatState, m: Inbound) {
        reduce(state, ChatEvent::Message(m));
    }

    fn chunk(text: &str, id: &str) -> Inbound {
        Inbound::Update(Update::AgentMessage {
            text: text.into(),
            message_id: Some(id.into()),
        })
    }

    fn user_chunk(text: &str, id: Option<&str>) -> Inbound {
        Inbound::Update(Update::UserMessage {
            text: text.into(),
            message_id: id.map(String::from),
        })
    }

    fn prompt(state: &mut ChatState, text: &str, id: i64) {
        reduce(state, ChatEvent::user_prompt(text, 0, Some(AcpId::Int(id))));
    }

    fn user_id(text: &str, state: &ChatState) -> i64 {
        state
            .items
            .iter()
            .find(|i| matches!(&i.kind, ItemKind::User { text: t, .. } if t == text))
            .unwrap()
            .id
    }

    fn kinds(state: &ChatState) -> Vec<&ItemKind> {
        state.items.iter().map(|i| &i.kind).collect()
    }

    fn user_texts(state: &ChatState) -> Vec<String> {
        state
            .items
            .iter()
            .filter_map(|i| match &i.kind {
                ItemKind::User { text, .. } => Some(text.clone()),
                _ => None,
            })
            .collect()
    }

    fn has_divider(state: &ChatState) -> bool {
        state
            .items
            .iter()
            .any(|i| matches!(i.kind, ItemKind::Divider(_)))
    }

    // Queue

    #[test]
    fn a_second_prompt_is_queued_until_the_first_ends_and_the_agent_starts_it() {
        let mut s = ChatState::default();
        prompt(&mut s, "one", 1);
        assert!(
            s.queued_item_ids.is_empty(),
            "the first prompt starts at once"
        );
        prompt(&mut s, "two", 2);
        let two = user_id("two", &s);
        assert_eq!(s.queued_item_ids, [two]);

        msg(&mut s, chunk("working on one", "m1"));
        assert!(
            s.is_queued(two),
            "output of the running prompt does not start the next"
        );
        msg(&mut s, done(1, "end_turn"));
        assert_eq!(
            s.turn,
            Turn::Working,
            "the turn lasts until the last prompt answers"
        );
        assert!(
            s.is_queued(two),
            "kept until the agent's own output arrives"
        );
        msg(&mut s, chunk("working on two", "m2"));
        assert!(!s.is_queued(two));
        msg(&mut s, done(2, "end_turn"));
        assert_eq!(s.turn, Turn::Idle);
    }

    #[test]
    fn a_queued_prompt_moves_below_the_turn_it_waited_on_when_it_starts() {
        let mut s = ChatState::default();
        prompt(&mut s, "one", 1);
        prompt(&mut s, "two", 2);
        msg(&mut s, chunk("working on one", "m1"));
        msg(&mut s, done(1, "end_turn"));
        msg(&mut s, chunk("working on two", "m2"));
        let order: Vec<_> = s
            .items
            .iter()
            .map(|i| match &i.kind {
                ItemKind::User { text, .. } | ItemKind::Assistant { text, .. } => text.as_str(),
                _ => "",
            })
            .collect();
        assert_eq!(order, ["one", "working on one", "two", "working on two"]);
    }

    #[test]
    fn the_running_answer_keeps_streaming_into_one_row_past_a_queued_message() {
        let mut s = ChatState::default();
        prompt(&mut s, "one", 1);
        msg(&mut s, chunk("Hel", "m1"));
        msg(
            &mut s,
            Inbound::Update(Update::AgentThought { text: "hm".into() }),
        );
        prompt(&mut s, "two", 2);
        prompt(&mut s, "three", 3);
        msg(
            &mut s,
            Inbound::Update(Update::AgentThought { text: "m".into() }),
        );
        msg(&mut s, chunk("lo", "m1"));
        msg(&mut s, chunk("lo", "m1"));
        let kinds: Vec<_> = s.items.iter().map(|i| &i.kind).collect();
        assert!(matches!(kinds[1], ItemKind::Assistant { text, .. } if text == "Hel"));
        assert!(matches!(kinds[2], ItemKind::Thought { text } if text == "hmm"));
        assert!(matches!(kinds[3], ItemKind::Assistant { text, .. } if text == "lolo"));
        assert_eq!(
            user_texts(&s),
            ["one", "two", "three"],
            "queued ones wait at the end, in order"
        );
        msg(&mut s, done(1, "end_turn"));
        msg(&mut s, chunk("on two", "m2"));
        assert_eq!(user_texts(&s), ["one", "two", "three"]);
        assert!(
            matches!(&s.items.last().unwrap().kind, ItemKind::User { text, .. } if text == "three")
        );
        assert_eq!(s.queued_item_ids, [user_id("three", &s)]);
    }

    #[test]
    fn the_prompts_own_response_clears_its_label_even_without_output() {
        let mut s = ChatState::default();
        prompt(&mut s, "one", 1);
        prompt(&mut s, "two", 2);
        msg(&mut s, done(1, "end_turn"));
        msg(&mut s, done(2, "end_turn"));
        assert!(s.queued_item_ids.is_empty());
        assert_eq!(s.turn, Turn::Idle);
    }

    #[test]
    fn responses_match_by_id_not_by_order() {
        let mut s = ChatState::default();
        prompt(&mut s, "one", 1);
        prompt(&mut s, "two", 2);
        prompt(&mut s, "three", 3);
        msg(&mut s, done(2, "cancelled"));
        assert_eq!(s.turn, Turn::Working);
        assert_eq!(s.queued_item_ids, [user_id("three", &s)]);
        msg(&mut s, done(1, "end_turn"));
        msg(&mut s, done(3, "end_turn"));
        assert_eq!(s.turn, Turn::Idle);
    }

    #[test]
    fn an_echoed_user_message_starts_the_queued_prompt_without_doubling_it() {
        let mut s = ChatState::default();
        prompt(&mut s, "one", 1);
        prompt(&mut s, "two", 2);
        msg(&mut s, done(1, "end_turn"));
        msg(&mut s, user_chunk("two", None));
        assert!(s.queued_item_ids.is_empty());
        assert_eq!(user_texts(&s), ["one", "two"]);
    }

    #[test]
    fn stop_withdraws_the_queued_prompts_and_notes_it_once() {
        let mut s = ChatState::default();
        prompt(&mut s, "one", 1);
        prompt(&mut s, "two", 2);
        reduce(&mut s, ChatEvent::CancelRequested);
        assert!(s.queued_item_ids.is_empty());
        assert_eq!(user_texts(&s), ["one"], "the agent never ran it");
        assert_eq!(
            s.items.last().unwrap().kind,
            ItemKind::Notice("Stopped".into())
        );
        assert_eq!(
            s.turn,
            Turn::Working,
            "only the agent's responses end the turn"
        );
        msg(&mut s, done(1, "cancelled"));
        msg(&mut s, done(2, "cancelled"));
        assert_eq!(s.turn, Turn::Idle);
        reduce(&mut s, ChatEvent::CancelRequested);
        let stops = s
            .items
            .iter()
            .filter(|i| i.kind == ItemKind::Notice("Stopped".into()))
            .count();
        assert_eq!(stops, 1, "nothing to stop when idle");
    }

    fn undelivered(text: &str, id: i64) -> ChatEvent {
        ChatEvent::PromptUndelivered {
            text: text.into(),
            image_count: 0,
            at_offset: 0,
            request_id: Some(AcpId::Int(id)),
            images: vec![],
        }
    }

    #[test]
    fn an_undelivered_queued_prompt_leaves_the_running_turn_working() {
        let mut s = ChatState::default();
        prompt(&mut s, "one", 1);
        prompt(&mut s, "two", 2);
        reduce(&mut s, undelivered("two", 2));
        assert_eq!(s.turn, Turn::Working);
        assert!(s.queued_item_ids.is_empty());
        assert_eq!(s.items.len(), 1);
        reduce(&mut s, undelivered("one", 1));
        assert_eq!(s.turn, Turn::Idle);
    }

    #[test]
    fn a_prompt_recorded_without_an_id_still_matches_the_oldest_response() {
        let mut s = ChatState::default();
        reduce(&mut s, ChatEvent::user_prompt("old", 0, None));
        msg(&mut s, done(7, "end_turn"));
        assert_eq!(s.turn, Turn::Idle);
    }

    #[test]
    fn clear_adds_a_divider_when_it_ends() {
        let mut s = ChatState::default();
        prompt(&mut s, "hello", 1);
        msg(&mut s, chunk("hi", "m1"));
        msg(&mut s, done(1, "end_turn"));
        prompt(&mut s, " /clear \n", 2);
        assert!(!has_divider(&s));
        msg(&mut s, done(2, "end_turn"));
        assert_eq!(
            s.items.last().unwrap().kind,
            ItemKind::Divider("Context cleared".into())
        );
        assert_eq!(s.items.len(), 4, "history stays above the divider");
    }

    #[test]
    fn clear_that_was_cancelled_or_refused_adds_no_divider() {
        let mut s = ChatState::default();
        prompt(&mut s, "/clear", 1);
        msg(&mut s, done(1, "cancelled"));
        assert!(!has_divider(&s));
        prompt(&mut s, "/clearly not", 2);
        msg(&mut s, done(2, "end_turn"));
        assert!(!has_divider(&s));
    }

    #[test]
    fn compact_adds_a_divider_unless_the_agent_announced_it() {
        let mut quiet = ChatState::default();
        prompt(&mut quiet, "/compact", 1);
        msg(&mut quiet, done(1, "end_turn"));
        assert_eq!(
            quiet.items.last().unwrap().kind,
            ItemKind::Divider("Context compacted".into())
        );

        let mut announced = ChatState::default();
        prompt(&mut announced, "/compact", 1);
        msg(&mut announced, chunk("Conversation compacted", "m1"));
        msg(&mut announced, done(1, "end_turn"));
        assert!(!has_divider(&announced));
    }

    #[test]
    fn a_divider_sits_before_messages_queued_behind_it() {
        let mut s = ChatState::default();
        prompt(&mut s, "/clear", 1);
        prompt(&mut s, "next", 2);
        msg(&mut s, done(1, "end_turn"));
        assert_eq!(s.items[1].kind, ItemKind::Divider("Context cleared".into()));
        assert!(matches!(
            s.items.last().unwrap().kind,
            ItemKind::User { .. }
        ));
    }

    #[test]
    fn an_auth_error_becomes_one_sign_in_row_not_an_error_row() {
        let mut s = ChatState::default();
        prompt(&mut s, "hi", 1);
        let auth = |id| Inbound::ErrorResponse {
            id: Some(AcpId::Int(id)),
            code: -32000,
            message: "Authentication required".into(),
        };
        msg(&mut s, auth(1));
        assert_eq!(s.items.last().unwrap().kind, ItemKind::SignedOut);
        assert_eq!(s.turn, Turn::Idle);
        msg(&mut s, auth(2));
        assert_eq!(
            s.items
                .iter()
                .filter(|i| i.kind == ItemKind::SignedOut)
                .count(),
            1
        );
    }

    #[test]
    fn the_adapters_auth_status_notification_drives_the_sign_in_row() {
        let status = |kind: &str| {
            decode(
                json!({"jsonrpc": "2.0", "method": "_auth/status_update",
                    "params": {"authStatus": {"kind": kind, "label": "x"}}})
                .to_string()
                .as_bytes(),
                None,
            )
        };
        assert_eq!(status("none"), Inbound::AuthStatus { signed_in: false });
        assert_eq!(status("account"), Inbound::AuthStatus { signed_in: true });
        let mut s = ChatState::default();
        msg(&mut s, status("none"));
        assert_eq!(kinds(&s), [&ItemKind::SignedOut]);
        msg(&mut s, status("none"));
        assert_eq!(s.items.len(), 1);
        msg(&mut s, status("account"));
        assert!(s.items.is_empty(), "a later login makes the old row stale");
    }

    #[test]
    fn a_failed_prompt_after_the_status_notice_shows_one_sign_in_row() {
        let mut s = ChatState::default();
        prompt(&mut s, "hi", 1);
        msg(&mut s, Inbound::AuthStatus { signed_in: false });
        msg(
            &mut s,
            Inbound::ErrorResponse {
                id: Some(AcpId::Int(1)),
                code: -32000,
                message: "Authentication required".into(),
            },
        );
        assert_eq!(
            s.items
                .iter()
                .filter(|i| i.kind == ItemKind::SignedOut)
                .count(),
            1
        );
        assert_eq!(s.turn, Turn::Idle);
    }

    #[test]
    fn the_status_notice_that_opens_a_turn_starts_the_queued_prompt() {
        let mut s = ChatState::default();
        prompt(&mut s, "one", 1);
        prompt(&mut s, "two", 2);
        msg(&mut s, Inbound::AuthStatus { signed_in: true });
        assert_eq!(
            s.queued_item_ids.len(),
            1,
            "the running prompt's own notice does not start the next"
        );
        msg(&mut s, done(1, "end_turn"));
        msg(&mut s, Inbound::AuthStatus { signed_in: true });
        assert!(s.queued_item_ids.is_empty());
    }

    #[test]
    fn other_errors_stay_error_rows() {
        let mut s = ChatState::default();
        msg(
            &mut s,
            Inbound::ErrorResponse {
                id: Some(AcpId::Int(3)),
                code: -32603,
                message: "Internal error".into(),
            },
        );
        assert_eq!(
            s.items.last().unwrap().kind,
            ItemKind::Error("Internal error".into())
        );
    }

    // Load session user messages

    #[test]
    fn replayed_user_messages_with_different_ids_stay_separate_rows_and_chunks_of_one_merge() {
        let mut s = ChatState::default();
        for m in [
            user_chunk("first ", Some("u1")),
            user_chunk("part", Some("u1")),
            user_chunk("second", Some("u2")),
        ] {
            msg(&mut s, m);
        }
        assert_eq!(user_texts(&s), ["first part", "second"]);
    }

    #[test]
    fn the_echo_of_a_queued_prompt_after_a_load_adds_no_second_row() {
        let mut s = ChatState::default();
        msg(&mut s, user_chunk("old question", Some("u1")));
        reduce(
            &mut s,
            ChatEvent::user_prompt("now", 10, Some(AcpId::Int(3))),
        );
        reduce(
            &mut s,
            ChatEvent::user_prompt("queued", 10, Some(AcpId::Int(4))),
        );
        msg(&mut s, user_chunk("queued", Some("u9")));
        assert_eq!(user_texts(&s).len(), 3);
    }

    // Transcript

    fn plan_entry(status: &str) -> PlanEntry {
        PlanEntry {
            content: "x".into(),
            status: status.into(),
            priority: "low".into(),
        }
    }

    #[test]
    fn errors_and_plan_and_thought_reduce_into_items() {
        let mut s = ChatState::default();
        reduce(&mut s, ChatEvent::user_prompt("go", 0, None));
        msg(
            &mut s,
            Inbound::Update(Update::AgentThought { text: "a".into() }),
        );
        msg(
            &mut s,
            Inbound::Update(Update::AgentThought { text: "b".into() }),
        );
        msg(
            &mut s,
            Inbound::Update(Update::Plan(vec![plan_entry("pending")])),
        );
        msg(
            &mut s,
            Inbound::Update(Update::Plan(vec![plan_entry("completed")])),
        );
        assert_eq!(s.items.len(), 3);
        assert_eq!(s.items[1].kind, ItemKind::Thought { text: "ab".into() });
        assert_eq!(
            s.items[2].kind,
            ItemKind::Plan(vec![plan_entry("completed")])
        );
        msg(
            &mut s,
            Inbound::ErrorResponse {
                id: Some(AcpId::Int(3)),
                code: -1,
                message: "nope".into(),
            },
        );
        assert_eq!(s.turn, Turn::Idle);
        assert_eq!(s.items.last().unwrap().kind, ItemKind::Error("nope".into()));
        reduce(&mut s, ChatEvent::ConnectionLost);
        assert_eq!(s.connection, LinkState::Lost);
    }

    #[test]
    fn a_host_answer_that_lands_during_a_failed_write_is_not_undone() {
        let mut s = ChatState::default();
        msg(
            &mut s,
            Inbound::PermissionRequest {
                id: AcpId::Int(0),
                request: PermissionRequest {
                    tool: ToolFields::new("t"),
                    options: vec![PermissionOption {
                        option_id: "a".into(),
                        name: "A".into(),
                        kind: "allow_once".into(),
                    }],
                },
            },
        );
        let ev = |option: &str| ChatEvent::PermissionAnswerUndelivered {
            request_id: AcpId::Int(0),
            option_id: option.into(),
        };
        reduce(
            &mut s,
            ChatEvent::PermissionAnswered {
                request_id: AcpId::Int(0),
                option_id: "a".into(),
            },
        );
        reduce(&mut s, ev("other"));
        assert!(s.pending_permissions().is_empty());
        reduce(&mut s, ev("a"));
        assert_eq!(s.pending_permissions().len(), 1);
    }

    #[test]
    fn subagent_children_nest_under_their_launch_row() {
        let mut s = ChatState::default();
        let launch = ToolFields {
            tool_name: Some("Agent".into()),
            title: Some("Task".into()),
            status: Some(ToolStatus::InProgress),
            input: Some(BTreeMap::from([(
                "description".into(),
                "check things".into(),
            )])),
            ..ToolFields::new("a")
        };
        msg(&mut s, Inbound::Update(Update::ToolCall(launch)));
        let child = ToolFields {
            title: Some("Read a".into()),
            parent_id: Some("a".into()),
            status: Some(ToolStatus::InProgress),
            ..ToolFields::new("c1")
        };
        msg(&mut s, Inbound::Update(Update::ToolCall(child)));
        assert_eq!(s.items.len(), 1);
        assert_eq!(
            s.subagent_activity().unwrap(),
            "check things \u{00B7} Read a"
        );
        let async_done = ToolFields {
            status: Some(ToolStatus::Completed),
            text: Some("Async agent launched successfully. (internal)".into()),
            ..ToolFields::new("a")
        };
        msg(&mut s, Inbound::Update(Update::ToolCallUpdate(async_done)));
        let ItemKind::Tool(call) = &s.items[0].kind else {
            panic!()
        };
        assert!(call.subagent.as_ref().unwrap().background);
        assert_eq!(call.text, None, "the launch boilerplate is not shown");
        assert!(
            call.is_active(),
            "a background run with a running child is active"
        );
    }

    // Questions

    fn choice(value: &str) -> QuestionChoice {
        QuestionChoice {
            value: value.into(),
            title: value.into(),
            description: String::new(),
        }
    }

    fn question_request(id: i64) -> Inbound {
        Inbound::Elicitation {
            id: AcpId::Int(id),
            request: ElicitationRequest {
                tool_call_id: Some("t1".into()),
                message: "Pick".into(),
                fields: vec![QuestionField {
                    name: "question_0".into(),
                    title: "question_0".into(),
                    description: String::new(),
                    kind: FieldKind::Single(vec![choice("red"), choice("blue")]),
                    required: false,
                    custom: None,
                }],
            },
        }
    }

    fn question_state(s: &ChatState) -> QuestionState {
        s.items
            .iter()
            .find_map(|i| match &i.kind {
                ItemKind::Question(q) => Some(q.state.clone()),
                _ => None,
            })
            .unwrap()
    }

    fn pending_question() -> ChatState {
        let mut s = ChatState::default();
        msg(&mut s, question_request(5));
        s
    }

    fn red() -> BTreeMap<String, QuestionValue> {
        BTreeMap::from([("question_0".into(), QuestionValue::Text("red".into()))])
    }

    fn answered(action: QuestionAction, content: BTreeMap<String, QuestionValue>) -> ChatEvent {
        ChatEvent::QuestionAnswered {
            request_id: AcpId::Int(5),
            action,
            content,
        }
    }

    #[test]
    fn a_request_appends_a_pending_question() {
        let s = pending_question();
        assert_eq!(s.pending_questions().len(), 1);
        assert_eq!(s.pending_questions()[0].request_id, AcpId::Int(5));
        assert_eq!(s.pending_questions()[0].message, "Pick");
    }

    #[test]
    fn answer_decline_and_cancel_resolve_the_question() {
        let mut s = pending_question();
        reduce(&mut s, answered(QuestionAction::Accept, red()));
        assert!(s.pending_questions().is_empty());
        assert_eq!(question_state(&s), QuestionState::Answered(red()));
        for (action, expected) in [
            (QuestionAction::Decline, QuestionState::Declined),
            (QuestionAction::Cancel, QuestionState::Cancelled),
        ] {
            let mut s = pending_question();
            reduce(&mut s, answered(action, BTreeMap::new()));
            assert_eq!(question_state(&s), expected);
        }
    }

    #[test]
    fn a_second_answer_does_not_override_the_first() {
        let mut s = pending_question();
        reduce(&mut s, answered(QuestionAction::Decline, BTreeMap::new()));
        reduce(&mut s, answered(QuestionAction::Accept, red()));
        assert_eq!(question_state(&s), QuestionState::Declined);
    }

    #[test]
    fn an_undelivered_answer_reopens_the_question_unless_something_else_resolved_it() {
        let undelivered = ChatEvent::QuestionAnswerUndelivered {
            request_id: AcpId::Int(5),
            action: QuestionAction::Accept,
            content: red(),
        };
        let mut s = pending_question();
        reduce(&mut s, answered(QuestionAction::Accept, red()));
        reduce(&mut s, undelivered.clone());
        assert_eq!(s.pending_questions().len(), 1);
        reduce(
            &mut s,
            ChatEvent::HostAnswered {
                request_id: AcpId::Int(5),
                option_id: "blue".into(),
            },
        );
        assert!(s.pending_questions().is_empty());
        reduce(&mut s, undelivered);
        assert!(s.pending_questions().is_empty(), "the host's answer stands");
    }

    #[test]
    fn a_turn_end_or_error_clears_an_unanswered_question_as_cancelled() {
        for ending in [
            done(3, "end_turn"),
            Inbound::ErrorResponse {
                id: Some(AcpId::Int(3)),
                code: -1,
                message: "boom".into(),
            },
        ] {
            let mut s = pending_question();
            msg(&mut s, ending);
            assert!(s.pending_questions().is_empty());
            assert_eq!(question_state(&s), QuestionState::Cancelled);
        }
        let mut s = pending_question();
        reduce(&mut s, answered(QuestionAction::Decline, BTreeMap::new()));
        msg(&mut s, done(3, "end_turn"));
        assert_eq!(
            question_state(&s),
            QuestionState::Declined,
            "a resolved question keeps its outcome"
        );
    }

    #[test]
    fn host_answers_map_values_and_resolve_a_request_that_arrives_later() {
        let fields = vec![
            QuestionField {
                name: "a_note".into(),
                title: "a_note".into(),
                description: String::new(),
                kind: FieldKind::Text,
                required: false,
                custom: None,
            },
            QuestionField {
                name: "q1".into(),
                title: "q1".into(),
                description: String::new(),
                kind: FieldKind::Multi(vec![choice("x"), choice("y")]),
                required: false,
                custom: None,
            },
        ];
        let request = |fields: &Vec<QuestionField>| Inbound::Elicitation {
            id: AcpId::Int(5),
            request: ElicitationRequest {
                tool_call_id: None,
                message: "Pick".into(),
                fields: fields.clone(),
            },
        };
        let outcome = |value: &str| {
            let mut s = ChatState::default();
            reduce(
                &mut s,
                ChatEvent::HostAnswered {
                    request_id: AcpId::Int(5),
                    option_id: value.into(),
                },
            );
            msg(&mut s, request(&fields));
            question_state(&s)
        };
        assert_eq!(
            outcome("x"),
            QuestionState::Answered(BTreeMap::from([(
                "q1".into(),
                QuestionValue::List(vec!["x".into()])
            )]))
        );
        assert_eq!(outcome("declined"), QuestionState::Declined);
        assert_eq!(outcome("cancelled"), QuestionState::Cancelled);

        let mut live = pending_question();
        reduce(
            &mut live,
            ChatEvent::HostAnswered {
                request_id: AcpId::Int(5),
                option_id: "blue".into(),
            },
        );
        assert_eq!(
            question_state(&live),
            QuestionState::Answered(BTreeMap::from([(
                "question_0".into(),
                QuestionValue::Text("blue".into())
            )]))
        );
        reduce(
            &mut live,
            ChatEvent::HostAnswered {
                request_id: AcpId::Int(6),
                option_id: "red".into(),
            },
        );
        assert_eq!(
            live.items.len(),
            1,
            "an answer for an unknown request adds nothing"
        );
    }

    #[test]
    fn the_question_tools_own_calls_stay_out_of_the_transcript() {
        let call = |status: Option<ToolStatus>, name: Option<&str>| {
            Inbound::Update(Update::ToolCall(ToolFields {
                title: Some("Asking for your input".into()),
                status,
                tool_name: name.map(String::from),
                ..ToolFields::new("t1")
            }))
        };
        let mut s = ChatState::default();
        msg(
            &mut s,
            call(Some(ToolStatus::Pending), Some("AskUserQuestion")),
        );
        msg(&mut s, call(Some(ToolStatus::Completed), None));
        assert!(s.items.is_empty());
        let mut other = ChatState::default();
        msg(&mut other, call(Some(ToolStatus::Pending), Some("Bash")));
        assert_eq!(other.items.len(), 1);
    }

    #[test]
    fn state_round_trips_through_json_with_its_bookkeeping() {
        let mut s = pending_question();
        prompt(&mut s, "x", 1);
        reduce(
            &mut s,
            ChatEvent::HostAnswered {
                request_id: AcpId::Int(9),
                option_id: "a".into(),
            },
        );
        reduce(
            &mut s,
            ChatEvent::SilentRequest {
                request_id: AcpId::Str("s".into()),
            },
        );
        let json = serde_json::to_string(&s).unwrap();
        let back: ChatState = serde_json::from_str(&json).unwrap();
        assert_eq!(back, s);
        let _: Value = serde_json::from_str(&json).unwrap();
        let _ = AcpResult::default();
    }

    #[test]
    fn config_options_set_the_mode_and_a_mode_update_edits_the_option() {
        let option = |id: &str, value: &str| ConfigOption {
            id: id.into(),
            name: id.into(),
            description: String::new(),
            category: None,
            current_value: value.into(),
            choices: vec![],
        };
        let mut s = ChatState::default();
        msg(
            &mut s,
            Inbound::Update(Update::ConfigOptions(vec![option("mode", "default")])),
        );
        assert_eq!(s.mode_id.as_deref(), Some("default"));
        msg(&mut s, Inbound::Update(Update::CurrentMode("plan".into())));
        assert_eq!(s.option("mode").unwrap().current_value, "plan");
        assert_eq!(s.current_choice("mode").unwrap(), "plan");
    }
}
