//! A sans-IO port of the iOS `ACPClient`. It owns the journal, the transcript builder and the
//! table of requests waiting for an answer; it never reads or writes a socket. The caller
//! writes every returned line to the holder, feeds back what the holder sends, and reports a
//! write that failed with the matching `*_undelivered` call (or [`ChatClient::undelivered`]).
//!
//! Persisting is the caller's job too: after any call, `take_journal_changed()` says whether
//! the journal must be saved.

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use serde_json::{Value, json};

use super::images::{ImageAttachment, ImageSink, ImageStore};
use super::journal::{Entry, EntryKind, Journal, Snapshot, TranscriptBuilder};
use super::lines::LineError;
use super::message::{AcpId, AcpResult, Inbound, sorted};
use super::question::{QuestionAction, QuestionValue};
use super::reducer::{ChatEvent, ChatState, LinkState, Turn};

fn agent_error_text(code: i64, message: &str) -> String {
    if message.is_empty() {
        format!("The agent reported an error (code {code}).")
    } else {
        message.to_string()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ClientError {
    #[error("The connection to the agent was lost.")]
    ConnectionLost,
    #[error("The agent stopped before the chat started.")]
    NoSession,
    #[error("{}", agent_error_text(*code, message))]
    Agent { code: i64, message: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RequestKind {
    Initialize,
    NewSession,
    LoadSession,
    Prompt,
    SetConfig { id: String, value: String },
}

/// How to take a write back when it fails.
#[derive(Debug, Clone, PartialEq)]
pub enum Undo {
    None,
    Prompt,
    Request,
    Permission {
        option_id: String,
    },
    Question {
        action: QuestionAction,
        content: BTreeMap<String, QuestionValue>,
    },
}

/// One line to write to the holder. `line` ends with a newline and is JSON with sorted keys.
/// `id` is the request id a request, a prompt or an answer carries; `None` for a notification.
#[derive(Debug, Clone, PartialEq)]
pub struct Outbound {
    pub id: Option<AcpId>,
    pub line: Vec<u8>,
    pub undo: Undo,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Completion {
    pub id: AcpId,
    pub kind: RequestKind,
    pub outcome: Result<AcpResult, ClientError>,
}

struct Pending {
    kind: RequestKind,
    /// The conversation a `session/load` asked for, used when the answer carries no id.
    load_id: Option<String>,
}

pub struct ChatClient {
    journal: Journal,
    builder: TranscriptBuilder,
    pending: HashMap<AcpId, Pending>,
    ended: bool,
    failed: bool,
    was_working: bool,
    journal_changed: bool,
    joining: bool,
}

fn encode(message: Value) -> Vec<u8> {
    let mut line = serde_json::to_vec(&sorted(&message)).unwrap_or_default();
    line.push(b'\n');
    line
}

impl ChatClient {
    /// `resume` must already be checked against the journal with `Snapshot::is_consistent`; the
    /// stream is then expected to start at its offset.
    pub fn new(
        journal: Journal,
        resume: Option<Snapshot>,
        images: Option<Arc<dyn ImageSink>>,
    ) -> Self {
        let builder = match &resume {
            Some(snapshot) => TranscriptBuilder::resuming(&journal, snapshot, images),
            None => TranscriptBuilder::new(&journal, images),
        };
        Self {
            journal,
            builder,
            pending: HashMap::new(),
            ended: false,
            failed: false,
            was_working: false,
            journal_changed: false,
            joining: false,
        }
    }

    /// For a chat another client started on a holder that takes several: no handshake of its
    /// own, the session comes from the log.
    pub fn join(&mut self) {
        self.joining = true;
    }

    pub fn state(&self) -> &ChatState {
        self.builder.state()
    }

    pub fn journal(&self) -> &Journal {
        &self.journal
    }

    pub fn session_id(&self) -> Option<&str> {
        self.journal.session_id.as_deref()
    }

    /// True until a session exists: a client with one skips the handshake entirely.
    pub fn needs_handshake(&self) -> bool {
        self.journal.session_id.is_none()
    }

    /// The conversation to ask `session/load` for after `initialize`, when the chat continues
    /// an earlier one; a redial before the load answered asks for the same.
    pub fn loaded_session_id(&self) -> Option<&str> {
        self.journal.loaded_session_id.as_deref()
    }

    /// True once since the last call if the journal changed; the caller persists it then.
    pub fn take_journal_changed(&mut self) -> bool {
        std::mem::take(&mut self.journal_changed)
    }

    /// Bytes taken from the stream so far.
    pub fn received_bytes(&self) -> usize {
        self.builder.received_bytes()
    }

    pub fn consumed_offset(&self) -> usize {
        self.builder.consumed_offset()
    }

    /// True when the agent's output could not be decoded; a resumed client then replays from zero.
    pub fn failed_decoding(&self) -> bool {
        self.failed
    }

    pub fn ended(&self) -> bool {
        self.ended
    }

    fn save(&mut self) {
        self.journal_changed = true;
    }

    /// A client named to a holder that takes several prefixes its ids with its name, so two
    /// clients writing to one agent never send the same id.
    fn allocate_id(&mut self) -> AcpId {
        let n = self.journal.next_request_id;
        let id = match &self.journal.client_id {
            Some(client) => AcpId::Str(format!("{client}-{n}")),
            None => AcpId::Int(n),
        };
        self.journal.next_request_id += 1;
        self.save();
        id
    }

    fn request(
        &mut self,
        method: &str,
        params: Value,
        kind: RequestKind,
        load_id: Option<String>,
        silent: bool,
    ) -> Outbound {
        let id = self.allocate_id();
        if silent {
            self.journal.entries.push(
                Entry::new(EntryKind::SilentRequest, self.builder.consumed_offset())
                    .with_request(id.clone()),
            );
            self.builder.apply(ChatEvent::SilentRequest {
                request_id: id.clone(),
            });
            self.save();
        }
        let line = encode(
            json!({"jsonrpc": "2.0", "id": id.to_json(), "method": method, "params": params}),
        );
        self.pending.insert(id.clone(), Pending { kind, load_id });
        Outbound {
            id: Some(id),
            line,
            undo: Undo::Request,
        }
    }

    pub fn initialize(&mut self) -> Outbound {
        self.request(
            "initialize",
            json!({
                "protocolVersion": 1,
                "clientCapabilities": {
                    "fs": {"readTextFile": false, "writeTextFile": false},
                    "terminal": false,
                    // Without this the adapter leaves AskUserQuestion out; a chat started before it has none until recreated.
                    "elicitation": {"form": {}},
                    // Notices and compaction updates stream only to a client that declares them; terminal_output
                    // moves Bash output into _meta. Not `_meta.jetbrains.air`: that switches the adapter's dialect.
                    "session": {"notices": {}, "compaction": {}},
                    "_meta": {"terminal_output": true},
                },
            }),
            RequestKind::Initialize,
            None,
            false,
        )
    }

    pub fn new_session(&mut self, cwd: &str) -> Outbound {
        self.request(
            "session/new",
            json!({"cwd": cwd, "mcpServers": []}),
            RequestKind::NewSession,
            None,
            false,
        )
    }

    /// The agent replays the conversation as `session/update` notifications before it answers,
    /// so the history arrives through the same feed as live output.
    pub fn load_session(&mut self, id: &str, cwd: &str) -> Outbound {
        self.journal.loaded_session_id = Some(id.to_string());
        self.save();
        self.request(
            "session/load",
            json!({"sessionId": id, "cwd": cwd, "mcpServers": []}),
            RequestKind::LoadSession,
            Some(id.to_string()),
            false,
        )
    }

    /// Journaled and shown before the write; if the write fails, call `prompt_undelivered`.
    /// Images are stored through `store` (when given) so the row can show them again.
    pub fn prompt(
        &mut self,
        text: &str,
        images: &[ImageAttachment],
        store: Option<&ImageStore>,
    ) -> Result<Outbound, ClientError> {
        let session_id = self
            .journal
            .session_id
            .clone()
            .ok_or(ClientError::NoSession)?;
        if self.ended {
            return Err(ClientError::ConnectionLost);
        }
        let offset = self.builder.consumed_offset();
        let count = images.len();
        let refs: Vec<_> = images
            .iter()
            .filter_map(|image| store.and_then(|s| s.put(image)))
            .collect();
        let id = self.allocate_id();
        let mut entry = Entry::new(EntryKind::Prompt, offset)
            .with_text(text)
            .with_request(id.clone());
        entry.image_count = count;
        entry.images = refs.clone();
        self.journal.entries.push(entry);
        self.builder.apply(ChatEvent::UserPrompt {
            text: text.to_string(),
            image_count: count,
            at_offset: offset,
            request_id: Some(id.clone()),
            images: refs,
        });
        self.save();
        let mut blocks: Vec<Value> = images
            .iter()
            .map(|i| json!({"type": "image", "mimeType": i.mime_type, "data": i.data}))
            .collect();
        if !text.is_empty() {
            blocks.push(json!({"type": "text", "text": text}));
        }
        let line = encode(json!({
            "jsonrpc": "2.0", "id": id.to_json(), "method": "session/prompt",
            "params": {"sessionId": session_id, "prompt": blocks},
        }));
        self.pending.insert(
            id.clone(),
            Pending {
                kind: RequestKind::Prompt,
                load_id: None,
            },
        );
        Ok(Outbound {
            id: Some(id),
            line,
            undo: Undo::Prompt,
        })
    }

    /// The prompt's write failed: take it back out of the journal and the transcript.
    pub fn prompt_undelivered(&mut self, id: &AcpId) {
        self.pending.remove(id);
        let Some(index) = self
            .journal
            .entries
            .iter()
            .rposition(|e| e.kind == EntryKind::Prompt && e.request_id.as_ref() == Some(id))
        else {
            return;
        };
        let entry = self.journal.entries.remove(index);
        self.save();
        self.builder.apply(ChatEvent::PromptUndelivered {
            text: entry.text.unwrap_or_default(),
            image_count: entry.image_count,
            at_offset: entry.offset,
            request_id: entry.request_id,
            images: entry.images,
        });
    }

    /// A silent request: its failure never shows in the transcript. The new value reaches
    /// `state` through the result's options.
    pub fn set_config_option(&mut self, id: &str, value: &str) -> Result<Outbound, ClientError> {
        let session_id = self
            .journal
            .session_id
            .clone()
            .ok_or(ClientError::NoSession)?;
        if self.ended {
            return Err(ClientError::ConnectionLost);
        }
        Ok(self.request(
            "session/set_config_option",
            json!({"sessionId": session_id, "configId": id, "value": value}),
            RequestKind::SetConfig {
                id: id.to_string(),
                value: value.to_string(),
            },
            None,
            true,
        ))
    }

    /// `session/cancel`, then a cancelled outcome for every pending permission and a cancel for
    /// every pending question. Everything is journaled and shown at once: report each line that
    /// failed to write with [`ChatClient::undelivered`] and its card asks again.
    pub fn cancel(&mut self) -> Result<Vec<Outbound>, ClientError> {
        let mut out = vec![self.cancel_line()?];
        out.extend(self.cancelled());
        Ok(out)
    }

    /// The `session/cancel` notification alone, journaling nothing: a caller that learns when its
    /// write lands sends this first and calls [`ChatClient::cancelled`] after, as iOS does.
    pub fn cancel_line(&self) -> Result<Outbound, ClientError> {
        let session_id = self
            .journal
            .session_id
            .clone()
            .ok_or(ClientError::NoSession)?;
        Ok(Outbound {
            id: None,
            line: encode(
                json!({"jsonrpc": "2.0", "method": "session/cancel", "params": {"sessionId": session_id}}),
            ),
            undo: Undo::None,
        })
    }

    /// Journals a delivered cancel and answers every pending permission and question with it.
    pub fn cancelled(&mut self) -> Vec<Outbound> {
        let mut out = Vec::new();
        self.journal.entries.push(Entry::new(
            EntryKind::Cancel,
            self.builder.consumed_offset(),
        ));
        self.builder.apply(ChatEvent::CancelRequested);
        self.save();
        let permissions: Vec<AcpId> = self
            .builder
            .state()
            .pending_permissions()
            .iter()
            .map(|p| p.request_id.clone())
            .collect();
        for id in permissions {
            let line = self.respond(&id, json!({"outcome": "cancelled"}), "cancelled");
            out.push(Outbound {
                id: Some(id),
                line,
                undo: Undo::Permission {
                    option_id: "cancelled".into(),
                },
            });
        }
        let questions: Vec<AcpId> = self
            .builder
            .state()
            .pending_questions()
            .iter()
            .map(|q| q.request_id.clone())
            .collect();
        for id in questions {
            if let Some(line) = self.answer_question(&id, QuestionAction::Cancel, BTreeMap::new()) {
                out.push(Outbound {
                    id: Some(id),
                    line,
                    undo: Undo::Question {
                        action: QuestionAction::Cancel,
                        content: BTreeMap::new(),
                    },
                });
            }
        }
        out
    }

    /// The answer is journaled and shown before the write so a replay resolves the card; if the
    /// write fails, call `answer_permission_undelivered`. None when nothing waits on this request.
    pub fn answer_permission(&mut self, request: &AcpId, option_id: &str) -> Option<Vec<u8>> {
        if !self
            .builder
            .state()
            .pending_permissions()
            .iter()
            .any(|p| p.request_id == *request)
        {
            return None;
        }
        Some(self.respond(
            request,
            json!({"outcome": "selected", "optionId": option_id}),
            option_id,
        ))
    }

    fn respond(&mut self, id: &AcpId, outcome: Value, option_id: &str) -> Vec<u8> {
        self.journal.entries.push(
            Entry::new(EntryKind::Answer, self.builder.consumed_offset())
                .with_request(id.clone())
                .with_option(option_id),
        );
        self.builder.apply(ChatEvent::PermissionAnswered {
            request_id: id.clone(),
            option_id: option_id.to_string(),
        });
        self.save();
        encode(json!({"jsonrpc": "2.0", "id": id.to_json(), "result": {"outcome": outcome}}))
    }

    /// The write failed: a card the agent never heard from must ask again.
    pub fn answer_permission_undelivered(&mut self, request: &AcpId, option_id: &str) {
        if let Some(index) = self.journal.entries.iter().rposition(|e| {
            e.kind == EntryKind::Answer
                && e.request_id.as_ref() == Some(request)
                && e.option_id.as_deref() == Some(option_id)
        }) {
            self.journal.entries.remove(index);
        }
        self.save();
        self.builder.apply(ChatEvent::PermissionAnswerUndelivered {
            request_id: request.clone(),
            option_id: option_id.to_string(),
        });
    }

    /// Journaled and shown before the write, like a permission answer. `content` is only sent
    /// with an accept.
    pub fn answer_question(
        &mut self,
        request: &AcpId,
        action: QuestionAction,
        content: BTreeMap<String, QuestionValue>,
    ) -> Option<Vec<u8>> {
        if !self
            .builder
            .state()
            .pending_questions()
            .iter()
            .any(|q| q.request_id == *request)
        {
            return None;
        }
        let accept = action == QuestionAction::Accept;
        let sent = if accept { content } else { BTreeMap::new() };
        let mut entry = Entry::new(EntryKind::QuestionAnswer, self.builder.consumed_offset())
            .with_request(request.clone())
            .with_option(action.as_str());
        entry.content = accept.then(|| sent.clone());
        self.journal.entries.push(entry);
        self.builder.apply(ChatEvent::QuestionAnswered {
            request_id: request.clone(),
            action,
            content: sent.clone(),
        });
        self.save();
        let mut result = json!({"action": action.as_str()});
        if accept {
            let values: serde_json::Map<String, Value> =
                sent.iter().map(|(k, v)| (k.clone(), v.to_json())).collect();
            result["content"] = Value::Object(values);
        }
        Some(encode(
            json!({"jsonrpc": "2.0", "id": request.to_json(), "result": result}),
        ))
    }

    pub fn answer_question_undelivered(
        &mut self,
        request: &AcpId,
        action: QuestionAction,
        content: BTreeMap<String, QuestionValue>,
    ) {
        if let Some(index) = self.journal.entries.iter().rposition(|e| {
            e.kind == EntryKind::QuestionAnswer
                && e.request_id.as_ref() == Some(request)
                && e.option_id.as_deref() == Some(action.as_str())
        }) {
            self.journal.entries.remove(index);
        }
        self.save();
        let content = if action == QuestionAction::Accept {
            content
        } else {
            BTreeMap::new()
        };
        self.builder.apply(ChatEvent::QuestionAnswerUndelivered {
            request_id: request.clone(),
            action,
            content,
        });
    }

    /// Takes back whichever write `out` was. A request's failure completes it with
    /// `ConnectionLost`, as a dropped socket would.
    pub fn undelivered(&mut self, out: &Outbound) -> Option<Completion> {
        let id = out.id.as_ref()?;
        match &out.undo {
            Undo::None => {}
            Undo::Prompt => self.prompt_undelivered(id),
            Undo::Request => {
                let pending = self.pending.remove(id)?;
                return Some(Completion {
                    id: id.clone(),
                    kind: pending.kind,
                    outcome: Err(ClientError::ConnectionLost),
                });
            }
            Undo::Permission { option_id } => self.answer_permission_undelivered(id, option_id),
            Undo::Question { action, content } => {
                self.answer_question_undelivered(id, *action, content.clone())
            }
        }
        None
    }

    /// Answers the host recorded for requests this client never answered. The journal keeps
    /// them so a replay from zero resolves the same cards.
    pub fn adopt_host_answers(&mut self, answers: &HashMap<AcpId, String>) {
        let known = self.journal.answered_request_ids();
        let mut fresh: Vec<(&AcpId, &String)> = answers
            .iter()
            .filter(|(id, _)| !known.contains(*id))
            .collect();
        if fresh.is_empty() {
            return;
        }
        fresh.sort_by_key(|(id, _)| id.describe());
        for (id, option_id) in fresh {
            self.journal.entries.push(
                Entry::new(EntryKind::HostAnswer, 0)
                    .with_request(id.clone())
                    .with_option(option_id),
            );
            self.builder.apply(ChatEvent::HostAnswered {
                request_id: id.clone(),
                option_id: option_id.clone(),
            });
        }
        self.save();
    }

    /// Feed what the holder sent. Responses to requests this client is waiting on complete
    /// them; replayed old responses only feed the transcript. Output that cannot be decoded
    /// applies the failure event and ends the client, failing everything pending.
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<Completion> {
        if self.ended {
            return Vec::new();
        }
        match self.builder.feed(bytes) {
            Ok(messages) => self.route(messages),
            Err(error) => {
                self.failed = true;
                let LineError::LineTooLong { limit } = error;
                self.builder.apply(ChatEvent::Failure(format!(
                    "Agent output was not valid: lineTooLong(limit: {limit})"
                )));
                self.finish_loop()
            }
        }
    }

    /// The stream ended. Call `snapshot` first if one is wanted: a lost state is never saved.
    pub fn connection_lost(&mut self) -> Vec<Completion> {
        if self.ended {
            return Vec::new();
        }
        self.builder.apply(ChatEvent::ConnectionLost);
        self.finish_loop()
    }

    fn finish_loop(&mut self) -> Vec<Completion> {
        self.ended = true;
        let mut waiting: Vec<(AcpId, Pending)> = self.pending.drain().collect();
        waiting.sort_by(|a, b| a.0.cmp(&b.0));
        waiting
            .into_iter()
            .map(|(id, p)| Completion {
                id,
                kind: p.kind,
                outcome: Err(ClientError::ConnectionLost),
            })
            .collect()
    }

    fn route(&mut self, messages: Vec<Inbound>) -> Vec<Completion> {
        let mut done = Vec::new();
        for message in messages {
            match message {
                Inbound::Response { id, result } => {
                    if let AcpId::Int(n) = id
                        && n >= self.journal.next_request_id
                    {
                        self.journal.next_request_id = n + 1;
                        self.save();
                    }
                    self.adopt_session(result.session_id.as_deref());
                    let Some(pending) = self.pending.remove(&id) else {
                        continue;
                    };
                    let outcome = self.complete(&pending, result);
                    done.push(Completion {
                        id,
                        kind: pending.kind,
                        outcome,
                    });
                }
                Inbound::ClientEcho { message, .. } => {
                    if matches!(
                        message.get("method").and_then(Value::as_str),
                        Some("session/prompt" | "session/load")
                    ) {
                        let session = message
                            .get("params")
                            .and_then(|p| p.get("sessionId"))
                            .and_then(Value::as_str);
                        self.adopt_session(session);
                    }
                }
                Inbound::ErrorResponse {
                    id: Some(id),
                    code,
                    message,
                } => {
                    if let Some(pending) = self.pending.remove(&id) {
                        done.push(Completion {
                            id,
                            kind: pending.kind,
                            outcome: Err(ClientError::Agent { code, message }),
                        });
                    }
                }
                _ => {}
            }
        }
        done
    }

    /// A client that joined a chat another one started learns the session from the log: the
    /// answer to the other client's `session/new` names it, and so do its `session/load` and
    /// every prompt it sent.
    fn adopt_session(&mut self, session_id: Option<&str>) {
        if !self.joining || self.journal.session_id.is_some() {
            return;
        }
        if let Some(id) = session_id {
            self.journal.session_id = Some(id.to_string());
            self.save();
        }
    }

    fn complete(&mut self, pending: &Pending, result: AcpResult) -> Result<AcpResult, ClientError> {
        match pending.kind {
            RequestKind::NewSession => {
                let id = result.session_id.clone().ok_or(ClientError::NoSession)?;
                self.journal.session_id = Some(id);
                self.save();
            }
            RequestKind::LoadSession => {
                let loaded = result.session_id.clone().or(pending.load_id.clone());
                self.journal.session_id = loaded;
                self.save();
            }
            _ => {}
        }
        Ok(result)
    }

    /// The resume snapshot: only while live and decodable, and never before a line was
    /// consumed. A lost or failed state holds events the log does not.
    pub fn snapshot(&self, identity: i64) -> Option<Snapshot> {
        let state = self.builder.state();
        let consumed = self.builder.consumed_offset();
        if state.connection != LinkState::Live || self.failed || consumed == 0 {
            return None;
        }
        Some(Snapshot::new(
            identity,
            consumed,
            &self.journal,
            state.clone(),
        ))
    }

    /// The rule behind `snapshotIfDue`: true once when the turn went from working to idle since
    /// the last call. The caller snapshots then, and otherwise on its own interval.
    pub fn turn_just_ended(&mut self) -> bool {
        let working = self.builder.state().turn == Turn::Working;
        let ended = self.was_working && !working;
        self.was_working = working;
        ended
    }
}

#[cfg(test)]
mod tests {
    use super::super::fixture::{self, PROMPT_TEXT};
    use super::super::journal::TranscriptBuilder;
    use super::super::question::QuestionState;
    use super::super::reducer::ItemKind;
    use super::*;

    fn parse(line: &[u8]) -> Value {
        serde_json::from_slice(line).unwrap()
    }

    fn feed_lines(
        c: &mut ChatClient,
        f: &fixture::Fixture,
        range: std::ops::Range<usize>,
    ) -> Vec<Completion> {
        c.feed(&f.log_range(range))
    }

    fn replay(log: &[u8], journal: &Journal) -> ChatState {
        TranscriptBuilder::replay(log, journal, None).unwrap()
    }

    fn client(journal: Journal) -> ChatClient {
        ChatClient::new(journal, None, None)
    }

    fn method(v: &Value) -> &str {
        v["method"].as_str().unwrap_or("")
    }

    /// What a holder that takes several clients writes for a named client's line.
    fn echoed(client: &str, line: &[u8]) -> Vec<u8> {
        let message: Value = serde_json::from_slice(line).unwrap();
        encode(json!({"jsonrpc": "2.0", "method": "_tether/client",
            "params": {"client": client, "message": message}}))
    }

    fn user_texts(state: &ChatState) -> Vec<String> {
        state
            .items
            .iter()
            .filter_map(|i| match &i.kind {
                super::super::reducer::ItemKind::User { text, .. } => Some(text.clone()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn a_second_client_joins_from_the_log_and_both_see_each_others_prompts() {
        let named = |id: &str| Journal {
            client_id: Some(id.into()),
            ..Journal::default()
        };
        let mut a = client(named("aa"));
        let mut log = Vec::new();
        let init = a.initialize();
        assert_eq!(init.id, Some(AcpId::Str("aa-1".into())));
        log.extend(br#"{"jsonrpc":"2.0","id":"aa-1","result":{"protocolVersion":1}}"#);
        log.push(b'\n');
        a.feed(&log);
        a.new_session("/work");
        let start = log.len();
        log.extend(b"{\"jsonrpc\":\"2.0\",\"id\":\"aa-2\",\"result\":{\"sessionId\":\"s1\"}}\n");
        a.feed(&log[start..]);
        let start = log.len();
        let prompt = a.prompt("from a", &[], None).unwrap();
        log.extend(echoed("aa", &prompt.line));
        log.extend(
            b"{\"jsonrpc\":\"2.0\",\"id\":\"aa-3\",\"result\":{\"stopReason\":\"end_turn\"}}\n",
        );
        a.feed(&log[start..]);
        assert_eq!(
            user_texts(a.state()),
            ["from a"],
            "its own echo is not a second row"
        );

        let mut b = client(named("bb"));
        b.join();
        b.feed(&log);
        assert_eq!(b.session_id(), Some("s1"), "learned from the log");
        assert_eq!(user_texts(b.state()), ["from a"]);
        assert_eq!(b.state().turn, Turn::Idle);
        let reply = b.prompt("from b", &[], None).unwrap();
        let v = parse(&reply.line);
        assert_eq!(v["id"], json!("bb-1"));
        assert_eq!(v["params"]["sessionId"], json!("s1"));

        let more = echoed("bb", &reply.line);
        a.feed(&more);
        b.feed(&more);
        assert_eq!(user_texts(a.state()), ["from a", "from b"]);
        assert_eq!(
            a.state().turn,
            Turn::Working,
            "b's turn runs on a's screen too"
        );
        assert_eq!(user_texts(b.state()), ["from a", "from b"]);
        let mut whole = log.clone();
        whole.extend(&more);
        assert_eq!(
            replay(&whole, b.journal()).items,
            b.state().items,
            "replay equals live"
        );
    }

    #[test]
    fn an_unnamed_client_keeps_number_ids_and_reads_others_as_before() {
        let mut c = client(Journal::default());
        assert_eq!(c.initialize().id, Some(AcpId::Int(1)));
        c.feed(&echoed("zz", br#"{"jsonrpc":"2.0","id":"zz-3","method":"session/prompt","params":{"sessionId":"s","prompt":[{"type":"text","text":"hi"}]}}"#));
        assert_eq!(
            c.session_id(),
            None,
            "only a joining client takes the session"
        );
        assert_eq!(user_texts(c.state()), ["hi"]);
    }

    #[test]
    fn a_joining_client_takes_the_session_a_continued_chat_loaded() {
        let mut c = client(Journal {
            client_id: Some("bb".into()),
            ..Journal::default()
        });
        c.join();
        c.feed(&echoed("aa", br#"{"jsonrpc":"2.0","id":"aa-2","method":"session/load","params":{"sessionId":"old-1","cwd":"/w","mcpServers":[]}}"#));
        c.feed(b"{\"jsonrpc\":\"2.0\",\"id\":\"aa-2\",\"result\":{}}\n");
        assert_eq!(c.session_id(), Some("old-1"));
    }

    #[test]
    fn the_wire_lines_end_with_a_newline_and_sort_their_keys() {
        let mut c = client(Journal::default());
        let out = c.initialize();
        assert_eq!(out.id, Some(AcpId::Int(1)));
        assert_eq!(*out.line.last().unwrap(), b'\n');
        let text = String::from_utf8(out.line).unwrap();
        assert!(text.starts_with("{\"id\":1,\"jsonrpc\":\"2.0\",\"method\":\"initialize\",\"params\":{\"clientCapabilities\":"), "{text}");
    }

    #[test]
    fn new_chats_advertise_the_form_elicitation_capability() {
        let mut c = client(Journal::default());
        let v = parse(&c.initialize().line);
        let caps = &v["params"]["clientCapabilities"];
        assert_eq!(caps["elicitation"], json!({"form": {}}));
        assert_eq!(caps["terminal"], json!(false));
        assert_eq!(
            caps["fs"],
            json!({"readTextFile": false, "writeTextFile": false})
        );
        assert_eq!(v["params"]["protocolVersion"], json!(1));
    }

    #[test]
    fn initialize_declares_notices_compaction_and_terminal_output_but_not_air() {
        let mut c = client(Journal::default());
        let v = parse(&c.initialize().line);
        let caps = &v["params"]["clientCapabilities"];
        assert_eq!(caps["session"], json!({"notices": {}, "compaction": {}}));
        assert_eq!(caps["_meta"], json!({"terminal_output": true}));
        assert!(!String::from_utf8_lossy(&c.initialize().line).contains("jetbrains"));
    }

    #[test]
    fn handshake_prompt_permission_answer_and_loss() {
        let mut c = client(Journal::default());
        assert!(c.needs_handshake());
        let init = c.initialize();
        assert!(String::from_utf8_lossy(&init.line).contains("\"method\":\"initialize\""));
        let done = feed_lines(&mut c, &fixture::TURN, 0..1);
        assert_eq!(done.len(), 1);
        assert_eq!(done[0].kind, RequestKind::Initialize);
        assert_eq!(done[0].outcome.as_ref().unwrap().load_session, Some(true));

        let session = c.new_session("/work/project");
        assert!(String::from_utf8_lossy(&session.line).contains("session/new"));
        let done = feed_lines(&mut c, &fixture::TURN, 1..2);
        assert_eq!(done[0].kind, RequestKind::NewSession);
        assert_eq!(c.session_id(), Some("sess-1"));

        let prompt = c.prompt(PROMPT_TEXT, &[], None).unwrap();
        let v = parse(&prompt.line);
        assert_eq!(method(&v), "session/prompt");
        assert_eq!(v["id"], json!(3));
        assert_eq!(
            v["params"]["prompt"],
            json!([{"type": "text", "text": PROMPT_TEXT}])
        );
        assert_eq!(c.state().turn, Turn::Working);

        let permission_line = fixture::TURN.index_containing("session/request_permission");
        feed_lines(&mut c, &fixture::TURN, 2..permission_line + 1);
        assert!(!c.state().pending_permissions().is_empty());

        let reply = c.answer_permission(&AcpId::Int(0), "allow-once").unwrap();
        assert_eq!(
            parse(&reply),
            json!({"jsonrpc": "2.0", "id": 0, "result": {"outcome": {"outcome": "selected", "optionId": "allow-once"}}})
        );
        assert_eq!(
            c.answer_permission(&AcpId::Int(0), "reject"),
            None,
            "answering twice does not write twice"
        );

        let total = fixture::TURN.agent_lines().len();
        let done = feed_lines(&mut c, &fixture::TURN, permission_line + 1..total);
        assert_eq!(done.len(), 1);
        assert_eq!(done[0].kind, RequestKind::Prompt);
        assert_eq!(
            done[0].outcome.as_ref().unwrap().stop_reason.as_deref(),
            Some("end_turn")
        );
        assert_eq!(c.state().turn, Turn::Idle);
        assert_eq!(c.state().last_stop_reason.as_deref(), Some("end_turn"));
        assert_eq!(c.state().model_id.as_deref(), Some("claude-sonnet-5-5"));
        assert_eq!(c.state().cost.as_ref().unwrap().currency, "USD");

        assert_eq!(c.journal().session_id.as_deref(), Some("sess-1"));
        let mut expected = fixture::turn_journal().entries;
        expected[0].request_id = Some(AcpId::Int(3));
        assert_eq!(c.journal().entries, expected);
        assert_eq!(c.state(), &replay(&fixture::TURN.log(None), c.journal()));
        assert!(c.take_journal_changed());
        assert!(!c.take_journal_changed());

        let lost = c.connection_lost();
        assert!(lost.is_empty());
        assert_eq!(c.state().connection, LinkState::Lost);
        assert!(c.ended());
    }

    #[test]
    fn resume_replays_without_a_handshake_and_does_not_resurface_the_answered_permission() {
        let mut c = client(fixture::turn_journal());
        assert!(!c.needs_handshake());
        c.feed(&fixture::TURN.log(None));
        assert_eq!(c.state().turn, Turn::Idle);
        assert_eq!(c.state().last_stop_reason.as_deref(), Some("end_turn"));
        assert!(c.state().pending_permissions().is_empty());
        assert_eq!(
            c.state(),
            &replay(&fixture::TURN.log(None), &fixture::turn_journal())
        );
        let prompt = c.prompt("again", &[], None).unwrap();
        assert_eq!(parse(&prompt.line)["id"], json!(4));
    }

    #[test]
    fn a_dropped_stream_fails_waiters_and_surfaces_connection_lost() {
        let mut c = client(Journal::default());
        let init = c.initialize();
        let done = c.connection_lost();
        assert_eq!(
            done,
            [Completion {
                id: init.id.unwrap(),
                kind: RequestKind::Initialize,
                outcome: Err(ClientError::ConnectionLost)
            }]
        );
        assert_eq!(c.state().connection, LinkState::Lost);
        assert_eq!(
            c.set_config_option("mode", "plan"),
            Err(ClientError::NoSession)
        );
    }

    #[test]
    fn a_runaway_line_surfaces_an_error_instead_of_growing() {
        let mut c = client(Journal::default());
        let init = c.initialize();
        let done = c.feed(&vec![0u8; 17 * 1024 * 1024]);
        assert_eq!(c.state().connection, LinkState::Lost);
        assert!(matches!(
            c.state().items.last().unwrap().kind,
            ItemKind::Error(_)
        ));
        assert!(c.failed_decoding());
        assert!(c.ended());
        assert_eq!(done.len(), 1);
        assert_eq!(done[0].id, init.id.unwrap());
        assert_eq!(c.snapshot(1), None);
        assert!(c.feed(b"{}\n").is_empty());
    }

    fn controls_client() -> ChatClient {
        client(fixture::controls_journal())
    }

    const EXTRA_COMMANDS: &str = "{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"update\":{\"sessionUpdate\":\"available_commands_update\",\"availableCommands\":[{\"name\":\"context\",\"description\":\"d\",\"input\":null}]}}}";

    #[test]
    fn set_config_option_waits_for_the_agent_and_live_state_equals_replay() {
        let mut c = controls_client();
        let out = c.set_config_option("model", "haiku").unwrap();
        let v = parse(&out.line);
        assert_eq!(method(&v), "session/set_config_option");
        assert_eq!(
            v["params"],
            json!({"sessionId": "sess-2", "configId": "model", "value": "haiku"})
        );
        assert_eq!(v["id"], json!(3));
        assert!(c.state().config_options.is_empty());

        let lines = fixture::CONTROLS.agent_lines();
        let done = c.feed(&fixture::join(&lines[2..4]));
        assert_eq!(done.len(), 1);
        assert_eq!(
            done[0].kind,
            RequestKind::SetConfig {
                id: "model".into(),
                value: "haiku".into()
            }
        );
        assert!(done[0].outcome.is_ok());
        assert_eq!(c.state().option("model").unwrap().current_value, "haiku");

        let mut rest: Vec<String> = lines[4..].to_vec();
        rest.push(EXTRA_COMMANDS.to_string());
        c.feed(&fixture::join(&rest));
        assert!(!c.state().commands.is_empty());
        assert_eq!(c.state().mode_id.as_deref(), Some("default"));
        let mut log_lines: Vec<String> = lines[2..].to_vec();
        log_lines.push(EXTRA_COMMANDS.to_string());
        assert_eq!(c.state(), &replay(&fixture::join(&log_lines), c.journal()));
        assert_eq!(c.state().current_choice("model").unwrap(), "Haiku 5.5");
    }

    #[test]
    fn a_refused_option_change_reports_the_agent_error_without_touching_the_transcript() {
        let mut c = controls_client();
        let out = c.set_config_option("model", "nope").unwrap();
        let error = "{\"jsonrpc\":\"2.0\",\"id\":3,\"error\":{\"code\":-32602,\"message\":\"bad value\"}}\n";
        let done = c.feed(error.as_bytes());
        assert_eq!(
            done,
            [Completion {
                id: out.id.unwrap(),
                kind: RequestKind::SetConfig {
                    id: "model".into(),
                    value: "nope".into()
                },
                outcome: Err(ClientError::Agent {
                    code: -32602,
                    message: "bad value".into()
                })
            }]
        );
        assert!(c.state().items.is_empty());
        assert_eq!(
            c.state(),
            &replay(error.as_bytes(), c.journal()),
            "a replay must not surface the refusal either"
        );
    }

    #[test]
    fn set_config_option_fails_without_a_session_or_on_a_dead_connection() {
        let mut none = client(Journal::default());
        assert_eq!(
            none.set_config_option("mode", "plan"),
            Err(ClientError::NoSession)
        );
        let mut c = controls_client();
        c.connection_lost();
        assert_eq!(
            c.set_config_option("mode", "plan"),
            Err(ClientError::ConnectionLost)
        );
        assert_eq!(c.prompt("x", &[], None), Err(ClientError::ConnectionLost));
    }

    #[test]
    fn an_image_prompt_sends_images_first_then_text_and_journals_the_count() {
        let mut c = controls_client();
        let images = [
            ImageAttachment {
                mime_type: "image/png".into(),
                data: "AAAA".into(),
            },
            ImageAttachment {
                mime_type: "image/jpeg".into(),
                data: "BBBB".into(),
            },
        ];
        let out = c.prompt("what is this", &images, None).unwrap();
        assert_eq!(
            parse(&out.line)["params"]["prompt"],
            json!([
                {"type": "image", "mimeType": "image/png", "data": "AAAA"},
                {"type": "image", "mimeType": "image/jpeg", "data": "BBBB"},
                {"type": "text", "text": "what is this"},
            ])
        );
        let counts: Vec<_> = c.journal().entries.iter().map(|e| e.image_count).collect();
        assert_eq!(counts, [2]);
        assert_eq!(c.state().items.len(), 1);
        let ItemKind::User { image_count, .. } = &c.state().items[0].kind else {
            panic!()
        };
        assert_eq!(*image_count, 2);

        let second = c.prompt("", &images[..1], None).unwrap();
        assert_eq!(
            parse(&second.line)["params"]["prompt"],
            json!([{"type": "image", "mimeType": "image/png", "data": "AAAA"}])
        );
    }

    #[test]
    fn an_image_prompt_that_cannot_be_written_is_removed_again() {
        let mut c = controls_client();
        let image = ImageAttachment {
            mime_type: "image/png".into(),
            data: "AAAA".into(),
        };
        let out = c.prompt("x", &[image], None).unwrap();
        assert!(c.undelivered(&out).is_none());
        assert!(c.state().items.is_empty());
        assert_eq!(c.state().turn, Turn::Idle);
        assert!(c.journal().entries.is_empty());
        assert!(
            c.feed(b"{\"jsonrpc\":\"2.0\",\"id\":3,\"result\":{}}\n")
                .is_empty()
        );
    }

    #[test]
    fn two_prompts_in_flight_stay_working_until_both_answer_and_replay_equals_live() {
        let mut c = client(Journal {
            session_id: Some("sess-q".into()),
            ..Journal::default()
        });
        let mut log = Vec::new();
        let mut agent = |c: &mut ChatClient, json: &str| {
            let line = format!("{json}\n");
            log.extend_from_slice(line.as_bytes());
            c.feed(line.as_bytes())
        };
        let a = c.prompt("first", &[], None).unwrap();
        let b = c.prompt("second", &[], None).unwrap();
        assert_eq!(
            [a.id.clone().unwrap(), b.id.clone().unwrap()],
            [AcpId::Int(1), AcpId::Int(2)]
        );
        assert_eq!(c.state().queued_item_ids.len(), 1);

        agent(
            &mut c,
            "{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"update\":{\"sessionUpdate\":\"agent_message_chunk\",\"content\":{\"type\":\"text\",\"text\":\"a\"},\"messageId\":\"m1\"}}}",
        );
        let done = agent(
            &mut c,
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"stopReason\":\"end_turn\"}}",
        );
        assert_eq!(done.len(), 1);
        assert_eq!(c.state().turn, Turn::Working);
        assert_eq!(c.state().queued_item_ids.len(), 1);

        agent(
            &mut c,
            "{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"update\":{\"sessionUpdate\":\"agent_message_chunk\",\"content\":{\"type\":\"text\",\"text\":\"b\"},\"messageId\":\"m2\"}}}",
        );
        assert!(c.state().queued_item_ids.is_empty());
        let out = c.cancel().unwrap();
        assert_eq!(out.len(), 1);
        agent(
            &mut c,
            "{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"stopReason\":\"cancelled\"}}",
        );
        assert_eq!(c.state().turn, Turn::Idle);
        assert_eq!(
            c.state().items.last().unwrap().kind,
            ItemKind::Notice("Stopped".into()),
            "the cancel notice follows the stopped turn's output"
        );
        assert_eq!(c.state(), &replay(&log, c.journal()));
        assert!(
            c.journal()
                .entries
                .iter()
                .any(|e| e.kind == EntryKind::Cancel)
        );
    }

    // Snapshots

    #[test]
    fn a_client_snapshots_at_turn_end_and_a_resumed_one_matches_the_live_state() {
        let mut first = client(fixture::turn_journal());
        assert_eq!(first.snapshot(42), None, "nothing consumed yet");
        let cut = fixture::TURN.agent_lines().len() - 3;
        first.feed(&fixture::TURN.log(Some(cut)));
        assert_eq!(first.received_bytes(), fixture::TURN.offset_after(cut));
        let saved = first.snapshot(42).unwrap();
        assert_eq!(saved.offset, fixture::TURN.offset_after(cut));
        assert_eq!(saved.identity, 42);
        assert!(saved.is_consistent(&fixture::turn_journal()));

        let mut second = ChatClient::new(fixture::turn_journal(), Some(saved.clone()), None);
        let full = fixture::TURN.log(None);
        second.feed(&full[saved.offset..]);
        assert_eq!(second.state().turn, Turn::Idle);
        assert_eq!(second.state().last_stop_reason.as_deref(), Some("end_turn"));
        assert_eq!(second.state(), &replay(&full, &fixture::turn_journal()));
    }

    #[test]
    fn turn_just_ended_fires_once_when_the_turn_goes_idle() {
        let mut c = client(fixture::turn_journal());
        let mut fired = Vec::new();
        for line in fixture::TURN.agent_lines() {
            c.feed(format!("{line}\n").as_bytes());
            fired.push(c.turn_just_ended());
        }
        assert_eq!(fired.iter().filter(|f| **f).count(), 1);
        assert!(*fired.last().unwrap());
        assert!(!c.turn_just_ended());
    }

    #[test]
    fn no_snapshot_after_the_connection_dropped_and_none_for_undecodable_output() {
        let mut c = client(fixture::turn_journal());
        c.feed(&fixture::TURN.log(Some(4)));
        let before = c.snapshot(9).unwrap();
        assert_eq!(before.offset, fixture::TURN.offset_after(4));
        assert_eq!(before.state.connection, LinkState::Live);
        c.connection_lost();
        assert_eq!(
            c.snapshot(9),
            None,
            "a lost state holds events the log does not"
        );

        let mut bad = client(Journal::default());
        bad.feed(&vec![
            0x61u8;
            super::super::lines::DEFAULT_MAX_LINE_BYTES + 10
        ]);
        assert!(bad.failed_decoding());
        assert_eq!(bad.snapshot(1), None);
    }

    // Failed writes

    fn pending_permission() -> ChatClient {
        let mut unanswered = fixture::turn_journal();
        unanswered.entries.pop();
        let mut c = client(unanswered);
        c.feed(&fixture::TURN.log(Some(
            fixture::TURN.index_containing("session/request_permission") + 1,
        )));
        assert!(!c.state().pending_permissions().is_empty());
        c
    }

    #[test]
    fn a_permission_answer_that_cannot_be_written_is_taken_back_and_can_be_retried() {
        let mut c = pending_permission();
        let line = c.answer_permission(&AcpId::Int(0), "allow-once").unwrap();
        assert!(c.state().pending_permissions().is_empty());
        c.answer_permission_undelivered(&AcpId::Int(0), "allow-once");
        let ids: Vec<_> = c
            .state()
            .pending_permissions()
            .iter()
            .map(|p| p.request_id.clone())
            .collect();
        assert_eq!(ids, [AcpId::Int(0)], "the card stays pending");
        assert!(
            !c.journal()
                .entries
                .iter()
                .any(|e| e.kind == EntryKind::Answer)
        );

        let again = c.answer_permission(&AcpId::Int(0), "allow-once").unwrap();
        assert_eq!(again, line);
        assert!(c.state().pending_permissions().is_empty());
        assert_eq!(
            c.journal()
                .entries
                .iter()
                .filter(|e| e.kind == EntryKind::Answer)
                .count(),
            1
        );
    }

    #[test]
    fn a_failed_cancel_leaves_the_pending_permission_cards() {
        let mut c = pending_permission();
        let out = c.cancel().unwrap();
        assert_eq!(method(&parse(&out[0].line)), "session/cancel");
        assert_eq!(out.len(), 2);
        assert_eq!(
            parse(&out[1].line),
            json!({"jsonrpc": "2.0", "id": 0, "result": {"outcome": {"outcome": "cancelled"}}})
        );
        for o in &out {
            c.undelivered(o);
        }
        assert_eq!(c.state().pending_permissions().len(), 1);
        assert!(
            !c.journal()
                .entries
                .iter()
                .any(|e| e.kind == EntryKind::Answer)
        );
    }

    #[test]
    fn cancel_needs_a_session() {
        assert_eq!(
            client(Journal::default()).cancel(),
            Err(ClientError::NoSession)
        );
    }

    #[test]
    fn host_answers_are_journaled_in_a_stable_order_and_only_once() {
        let mut c = pending_permission();
        let answers = HashMap::from([(AcpId::Int(0), "reject".to_string())]);
        c.adopt_host_answers(&answers);
        assert!(c.state().pending_permissions().is_empty());
        assert_eq!(
            c.journal().entries.last().unwrap().kind,
            EntryKind::HostAnswer
        );
        assert!(c.take_journal_changed());
        c.adopt_host_answers(&answers);
        assert!(
            !c.take_journal_changed(),
            "an answer already journaled adds nothing"
        );

        let mut many = client(Journal::default());
        many.adopt_host_answers(&HashMap::from([
            (AcpId::Str("b".into()), "x".to_string()),
            (AcpId::Int(2), "y".to_string()),
            (AcpId::Int(10), "z".to_string()),
        ]));
        let order: Vec<_> = many
            .journal()
            .entries
            .iter()
            .map(|e| e.request_id.clone().unwrap())
            .collect();
        assert_eq!(
            order,
            [AcpId::Int(10), AcpId::Int(2), AcpId::Str("b".into())]
        );
    }

    // Load session

    fn loaded(mut c: ChatClient) -> ChatClient {
        let init = c.initialize();
        assert!(String::from_utf8_lossy(&init.line).contains("\"method\":\"initialize\""));
        c.feed(&fixture::LOAD.log_range(0..1));
        let load = c.load_session("sess-4", "/work/project");
        assert!(String::from_utf8_lossy(&load.line).contains("session/load"));
        let total = fixture::LOAD.agent_lines().len();
        let done = c.feed(&fixture::LOAD.log_range(1..total));
        assert_eq!(done.len(), 1);
        assert_eq!(done[0].kind, RequestKind::LoadSession);
        c
    }

    #[test]
    fn a_load_asks_for_session_load_not_session_new() {
        let mut c = client(Journal::default());
        c.initialize();
        c.feed(&fixture::LOAD.log_range(0..1));
        let load = c.load_session("sess-4", "/work/project");
        let v = parse(&load.line);
        assert_eq!(method(&v), "session/load");
        assert_eq!(v["id"], json!(2));
        assert_eq!(
            v["params"],
            json!({"sessionId": "sess-4", "cwd": "/work/project", "mcpServers": []})
        );
    }

    #[test]
    fn the_replayed_history_becomes_the_transcript_and_the_load_answer_is_read_like_session_new() {
        let c = loaded(client(Journal::default()));
        let state = c.state();
        assert_eq!(state.session_id.as_deref(), Some("sess-4"));
        assert_eq!(state.turn, Turn::Idle);
        assert!(!state.config_options.is_empty());
        assert!(!state.commands.is_empty());
        assert_eq!(state.items.len(), 3);
        let ItemKind::User { text, .. } = &state.items[0].kind else {
            panic!("first row is the user message")
        };
        assert!(text.contains("cat notes.txt"));
        let ItemKind::Tool(call) = &state.items[1].kind else {
            panic!("second row is the tool call")
        };
        assert_eq!(call.title, "cat notes.txt");
        assert_eq!(call.status, super::super::message::ToolStatus::Completed);
        assert_eq!(call.kind, super::super::message::ToolKind::Execute);
        let ItemKind::Assistant { text, .. } = &state.items[2].kind else {
            panic!("third row is the reply")
        };
        assert_eq!(text, "3");
        assert_eq!(c.journal().session_id.as_deref(), Some("sess-4"));
        assert_eq!(c.journal().loaded_session_id.as_deref(), Some("sess-4"));
        assert!(c.journal().entries.is_empty());
    }

    #[test]
    fn replay_from_zero_equals_the_live_load() {
        let c = loaded(client(Journal::default()));
        let total = fixture::LOAD.agent_lines().len();
        let full = fixture::LOAD.log_range(0..total);
        assert_eq!(c.state(), &replay(&full, c.journal()));
    }

    #[test]
    fn a_snapshot_taken_inside_the_replay_resumes_to_the_same_state() {
        let journal = Journal {
            session_id: Some("sess-4".into()),
            loaded_session_id: Some("sess-4".into()),
            ..Journal::default()
        };
        let cut = fixture::load_response_line();
        let mut builder = TranscriptBuilder::new(&journal, None);
        builder.feed(&fixture::LOAD.log_range(0..cut)).unwrap();
        let snapshot = Snapshot::new(
            7,
            fixture::LOAD.offset_after(cut),
            &journal,
            builder.state().clone(),
        );
        assert!(snapshot.is_consistent(&journal));

        let mut c = ChatClient::new(journal.clone(), Some(snapshot), None);
        assert!(!c.needs_handshake(), "a resume writes nothing");
        let total = fixture::LOAD.agent_lines().len();
        c.feed(&fixture::LOAD.log_range(cut..total));
        assert!(!c.state().commands.is_empty());
        let full = fixture::LOAD.log_range(0..total);
        assert_eq!(c.state(), &replay(&full, &journal));
    }

    #[test]
    fn a_redial_before_the_load_answered_asks_for_the_same_conversation_and_a_resume_skips_it() {
        let interrupted = Journal {
            loaded_session_id: Some("sess-4".into()),
            ..Journal::default()
        };
        let mut c = client(interrupted.clone());
        assert!(c.needs_handshake());
        assert_eq!(c.loaded_session_id(), Some("sess-4"));
        c.initialize();
        c.feed(&fixture::LOAD.log_range(0..1));
        let id = c.loaded_session_id().unwrap().to_string();
        let load = c.load_session(&id, "/work/project");
        assert!(String::from_utf8_lossy(&load.line).contains("\"sessionId\":\"sess-4\""));

        let mut done = interrupted;
        done.session_id = Some("sess-4".into());
        assert!(!client(done).needs_handshake());
    }

    #[test]
    fn a_refused_load_reports_the_agent_error_and_keeps_asking_for_the_same_id() {
        let mut c = client(Journal::default());
        c.initialize();
        c.feed(&fixture::LOAD.log_range(0..1));
        c.load_session("sess-gone", "/work/project");
        let done = c.feed(b"{\"jsonrpc\":\"2.0\",\"id\":2,\"error\":{\"code\":-32002,\"message\":\"Session not found\"}}\n");
        assert_eq!(
            done[0].outcome,
            Err(ClientError::Agent {
                code: -32002,
                message: "Session not found".into()
            })
        );
        assert_eq!(c.journal().session_id, None);
        assert_eq!(c.journal().loaded_session_id.as_deref(), Some("sess-gone"));
    }

    // Questions

    fn answer() -> BTreeMap<String, QuestionValue> {
        BTreeMap::from([
            ("question_0".to_string(), QuestionValue::Text("red".into())),
            (
                "question_0_custom".to_string(),
                QuestionValue::Text("a note".into()),
            ),
        ])
    }

    fn pending_question() -> ChatClient {
        let mut c = client(fixture::elicitation_journal(None));
        c.feed(&fixture::ELICITATION.log(Some(fixture::elicitation_request_line() + 1)));
        assert!(!c.state().pending_questions().is_empty());
        c
    }

    fn question_state(c: &ChatClient) -> QuestionState {
        c.state()
            .items
            .iter()
            .find_map(|i| match &i.kind {
                ItemKind::Question(q) => Some(q.state.clone()),
                _ => None,
            })
            .unwrap()
    }

    #[test]
    fn an_accepted_answer_is_written_journaled_and_equals_a_replay() {
        let mut c = pending_question();
        let line = c
            .answer_question(&AcpId::Int(0), QuestionAction::Accept, answer())
            .unwrap();
        let v = parse(&line);
        assert_eq!(v["result"]["action"], json!("accept"));
        assert_eq!(
            v["result"]["content"],
            json!({"question_0": "red", "question_0_custom": "a note"})
        );
        assert!(v.get("method").is_none());
        let entry = c.journal().entries.last().unwrap();
        assert_eq!(entry.kind, EntryKind::QuestionAnswer);
        assert_eq!(entry.content.as_ref(), Some(&answer()));
        assert_eq!(entry.offset, fixture::elicitation_answer_offset());
        assert!(c.state().pending_questions().is_empty());
        let log = fixture::ELICITATION.log(Some(fixture::elicitation_request_line() + 1));
        assert_eq!(c.state(), &replay(&log, c.journal()));
        assert_eq!(
            c.answer_question(&AcpId::Int(0), QuestionAction::Decline, BTreeMap::new()),
            None
        );
    }

    #[test]
    fn decline_sends_no_content_and_multi_values_are_arrays() {
        let mut c = pending_question();
        let line = c
            .answer_question(&AcpId::Int(0), QuestionAction::Decline, answer())
            .unwrap();
        assert_eq!(parse(&line)["result"], json!({"action": "decline"}));
        assert_eq!(c.journal().entries.last().unwrap().content, None);
        assert_eq!(
            QuestionValue::List(vec!["a".into(), "b".into()]).to_json(),
            json!(["a", "b"])
        );
        assert_eq!(QuestionValue::Flag(true).to_json(), json!(true));
    }

    #[test]
    fn an_answer_that_cannot_be_written_is_taken_back_and_can_be_retried() {
        let mut c = pending_question();
        c.answer_question(&AcpId::Int(0), QuestionAction::Accept, answer())
            .unwrap();
        c.answer_question_undelivered(&AcpId::Int(0), QuestionAction::Accept, answer());
        let ids: Vec<_> = c
            .state()
            .pending_questions()
            .iter()
            .map(|q| q.request_id.clone())
            .collect();
        assert_eq!(ids, [AcpId::Int(0)], "the card reopens");
        assert!(
            !c.journal()
                .entries
                .iter()
                .any(|e| e.kind == EntryKind::QuestionAnswer)
        );
        c.answer_question(&AcpId::Int(0), QuestionAction::Accept, answer())
            .unwrap();
        assert!(c.state().pending_questions().is_empty());
        assert_eq!(
            c.journal()
                .entries
                .iter()
                .filter(|e| e.kind == EntryKind::QuestionAnswer)
                .count(),
            1
        );
    }

    #[test]
    fn cancelling_the_turn_cancels_the_pending_question() {
        let mut c = pending_question();
        let out = c.cancel().unwrap();
        assert!(
            out.iter()
                .any(|o| method(&parse(&o.line)) == "session/cancel")
        );
        let reply = out
            .iter()
            .map(|o| parse(&o.line))
            .find(|v| v["id"] == json!(0))
            .unwrap();
        assert_eq!(reply["result"], json!({"action": "cancel"}));
        assert!(c.state().pending_questions().is_empty());
        assert_eq!(question_state(&c), QuestionState::Cancelled);
        assert_eq!(
            c.journal().entries.last().unwrap().option_id.as_deref(),
            Some("cancel")
        );
    }

    #[test]
    fn the_end_of_the_turn_clears_a_question_nobody_answered() {
        let mut c = client(fixture::elicitation_journal(None));
        c.feed(&fixture::ELICITATION.log(None));
        assert_eq!(c.state().last_stop_reason.as_deref(), Some("end_turn"));
        assert!(c.state().pending_questions().is_empty());
        assert_eq!(
            c.state(),
            &replay(
                &fixture::ELICITATION.log(None),
                &fixture::elicitation_journal(None)
            )
        );
    }

    #[test]
    fn host_answers_for_a_question_are_journaled_and_resolve_it_like_a_replay() {
        let mut c = pending_question();
        c.adopt_host_answers(&HashMap::from([(AcpId::Int(0), "green".to_string())]));
        assert_eq!(
            question_state(&c),
            QuestionState::Answered(BTreeMap::from([(
                "question_0".to_string(),
                QuestionValue::Text("green".into())
            )]))
        );
        assert_eq!(
            c.journal().entries.last().unwrap().kind,
            EntryKind::HostAnswer
        );
        let log = fixture::ELICITATION.log(Some(fixture::elicitation_request_line() + 1));
        assert_eq!(c.state(), &replay(&log, c.journal()));

        let mut declined = pending_question();
        declined.adopt_host_answers(&HashMap::from([(AcpId::Int(0), "declined".to_string())]));
        assert!(declined.state().pending_questions().is_empty());
    }

    #[test]
    fn a_resumed_client_with_a_journaled_answer_shows_the_question_resolved() {
        let mut c = client(fixture::elicitation_journal(Some(answer())));
        assert!(!c.needs_handshake(), "no handshake on resume");
        c.feed(&fixture::ELICITATION.log(Some(fixture::elicitation_request_line() + 1)));
        assert!(
            c.state()
                .items
                .iter()
                .any(|i| matches!(i.kind, ItemKind::Question(_)))
        );
        assert!(c.state().pending_questions().is_empty());
    }
}
