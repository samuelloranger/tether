use std::collections::{BTreeMap, HashSet, VecDeque};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use super::images::{ImageRef, ImageSink};
use super::lines::{LineError, LineSplitter};
use super::message::{AcpId, Inbound, decode};
use super::question::{QuestionAction, QuestionValue};
use super::reducer::{ChatEvent, ChatState, LinkState, reduce};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EntryKind {
    Prompt,
    Answer,
    SilentRequest,
    /// Stop was pressed: replay shows the same notice and drops the same queued labels.
    Cancel,
    /// A question answered here: `option_id` holds the action and `content` the form values.
    QuestionAnswer,
    /// An answer the host recorded while no client was attached; offset 0, applied before the replay.
    HostAnswer,
}

impl EntryKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Prompt => "prompt",
            Self::Answer => "answer",
            Self::SilentRequest => "silentRequest",
            Self::Cancel => "cancel",
            Self::QuestionAnswer => "questionAnswer",
            Self::HostAnswer => "hostAnswer",
        }
    }
}

/// What the agent's byte log cannot contain: the user's prompts and permission answers, each
/// stamped with the log offset (end of the last processed line) at the moment it happened.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Entry {
    pub kind: EntryKind,
    pub offset: usize,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub request_id: Option<AcpId>,
    #[serde(default)]
    pub option_id: Option<String>,
    #[serde(default)]
    pub content: Option<BTreeMap<String, QuestionValue>>,
    /// How many images went with the prompt.
    #[serde(default)]
    pub image_count: usize,
    /// Their references, for showing them again here: the bytes live in the chat's image store, never here.
    #[serde(default)]
    pub images: Vec<ImageRef>,
}

impl Entry {
    pub fn new(kind: EntryKind, offset: usize) -> Self {
        Self {
            kind,
            offset,
            text: None,
            request_id: None,
            option_id: None,
            content: None,
            image_count: 0,
            images: Vec::new(),
        }
    }

    pub fn with_text(mut self, text: &str) -> Self {
        self.text = Some(text.to_string());
        self
    }

    pub fn with_request(mut self, id: AcpId) -> Self {
        self.request_id = Some(id);
        self
    }

    pub fn with_option(mut self, option: &str) -> Self {
        self.option_id = Some(option.to_string());
        self
    }

    pub fn event(&self) -> Option<ChatEvent> {
        match self.kind {
            EntryKind::Prompt => self.text.as_ref().map(|text| ChatEvent::UserPrompt {
                text: text.clone(),
                image_count: self.image_count,
                at_offset: self.offset,
                request_id: self.request_id.clone(),
                images: self.images.clone(),
            }),
            EntryKind::Cancel => Some(ChatEvent::CancelRequested),
            EntryKind::SilentRequest => self
                .request_id
                .clone()
                .map(|request_id| ChatEvent::SilentRequest { request_id }),
            EntryKind::Answer => Some(ChatEvent::PermissionAnswered {
                request_id: self.request_id.clone()?,
                option_id: self.option_id.clone()?,
            }),
            EntryKind::QuestionAnswer => Some(ChatEvent::QuestionAnswered {
                request_id: self.request_id.clone()?,
                action: QuestionAction::parse(self.option_id.as_deref()?)?,
                content: self.content.clone().unwrap_or_default(),
            }),
            EntryKind::HostAnswer => Some(ChatEvent::HostAnswered {
                request_id: self.request_id.clone()?,
                option_id: self.option_id.clone()?,
            }),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Journal {
    #[serde(default)]
    pub session_id: Option<String>,
    /// Set when the chat continues an earlier conversation: the agent is asked to `session/load` this id
    /// instead of `session/new`, and a redial before the load answered must ask for the same one.
    #[serde(default)]
    pub loaded_session_id: Option<String>,
    /// Persisted so a resumed client never reuses an id the agent already answered.
    #[serde(default = "first_request_id")]
    pub next_request_id: i64,
    #[serde(default)]
    pub entries: Vec<Entry>,
}

fn first_request_id() -> i64 {
    1
}

impl Default for Journal {
    fn default() -> Self {
        Self {
            session_id: None,
            loaded_session_id: None,
            next_request_id: 1,
            entries: Vec::new(),
        }
    }
}

impl Journal {
    pub fn answered_request_ids(&self) -> HashSet<AcpId> {
        self.entries
            .iter()
            .filter(|e| {
                matches!(
                    e.kind,
                    EntryKind::Answer | EntryKind::HostAnswer | EntryKind::QuestionAnswer
                )
            })
            .filter_map(|e| e.request_id.clone())
            .collect()
    }

    /// The entries a reducer standing at `offset` has applied, in the order they were journaled.
    pub fn entries_up_to(&self, offset: usize) -> Vec<&Entry> {
        self.entries.iter().filter(|e| e.offset <= offset).collect()
    }
}

/// The reducer's state at a line boundary of the host's log, so a reconnect attaches from
/// `offset` instead of replaying everything. The journal stays authoritative: the snapshot only
/// counts which of its entries it already reflects.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Snapshot {
    pub version: u32,
    /// The host session's created time (unix seconds): a session recreated under the same name has another.
    pub identity: i64,
    /// End of the last processed line; also where the next attach starts.
    pub offset: usize,
    /// How many of the journal's entries at or before `offset` the state reflects, and their digest.
    pub journal_applied: usize,
    pub journal_digest: String,
    pub state: ChatState,
}

/// The desktop's own snapshot format; the iOS one is a different file.
pub const CURRENT_VERSION: u32 = 1;

impl Snapshot {
    pub fn new(identity: i64, offset: usize, journal: &Journal, state: ChatState) -> Self {
        let applied = journal.entries_up_to(offset);
        Self {
            version: CURRENT_VERSION,
            identity,
            offset,
            journal_applied: applied.len(),
            journal_digest: digest(applied.iter().copied()),
            state,
        }
    }

    /// True when the journal still contains, in order, the entries this state was built from.
    pub fn is_consistent(&self, journal: &Journal) -> bool {
        let applied = journal.entries_up_to(self.offset);
        self.version == CURRENT_VERSION
            && applied.len() >= self.journal_applied
            && digest(applied.iter().copied().take(self.journal_applied)) == self.journal_digest
    }
}

fn canonical(content: &BTreeMap<String, QuestionValue>) -> String {
    serde_json::to_string(content).unwrap_or_default()
}

/// FNV-1a over the entries' fields.
pub fn digest<'a>(entries: impl IntoIterator<Item = &'a Entry>) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for entry in entries {
        let mut fields = vec![
            entry.kind.as_str().to_string(),
            entry.offset.to_string(),
            entry.text.clone().unwrap_or_default(),
            entry
                .request_id
                .as_ref()
                .map(AcpId::describe)
                .unwrap_or_default(),
            entry.option_id.clone().unwrap_or_default(),
            entry.image_count.to_string(),
        ];
        if !entry.images.is_empty() {
            fields.push(
                entry
                    .images
                    .iter()
                    .map(|i| i.id.as_str())
                    .collect::<Vec<_>>()
                    .join(","),
            );
        }
        if let Some(content) = &entry.content {
            fields.push(canonical(content));
        }
        let line = fields.join("\u{1F}") + "\n";
        for byte in line.bytes() {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(0x0000_0100_0000_01B3);
        }
    }
    format!("{hash:x}")
}

/// Incremental form of the live path and the replay path at once: agent lines and journal
/// entries are merged by offset, so replaying the whole log gives the transcript the live
/// session had.
pub struct TranscriptBuilder {
    state: ChatState,
    consumed_offset: usize,
    received_bytes: usize,
    splitter: LineSplitter,
    pending: VecDeque<Entry>,
    images: Option<Arc<dyn ImageSink>>,
}

fn sorted_entries(entries: impl Iterator<Item = Entry>) -> VecDeque<Entry> {
    let mut all: Vec<Entry> = entries.collect();
    all.sort_by_key(|e| e.offset);
    all.into()
}

impl TranscriptBuilder {
    pub fn new(journal: &Journal, images: Option<Arc<dyn ImageSink>>) -> Self {
        let mut builder = Self {
            state: ChatState::default(),
            consumed_offset: 0,
            received_bytes: 0,
            splitter: LineSplitter::default(),
            pending: sorted_entries(journal.entries.iter().cloned()),
            images,
        };
        builder.drain(0);
        builder
    }

    /// Continues from a snapshot the caller has checked with `is_consistent`. Journal entries
    /// added since it was taken are applied now; the rest wait for the log to reach their offset.
    pub fn resuming(
        journal: &Journal,
        snapshot: &Snapshot,
        images: Option<Arc<dyn ImageSink>>,
    ) -> Self {
        let mut state = snapshot.state.clone();
        state.connection = LinkState::Live;
        let pending = sorted_entries(
            journal
                .entries
                .iter()
                .filter(|e| e.offset > snapshot.offset)
                .cloned(),
        );
        for entry in journal
            .entries_up_to(snapshot.offset)
            .into_iter()
            .skip(snapshot.journal_applied)
        {
            if let Some(event) = entry.event() {
                reduce(&mut state, event);
            }
        }
        Self {
            state,
            consumed_offset: snapshot.offset,
            received_bytes: snapshot.offset,
            splitter: LineSplitter::new(super::lines::DEFAULT_MAX_LINE_BYTES, snapshot.offset),
            pending,
            images,
        }
    }

    pub fn state(&self) -> &ChatState {
        &self.state
    }

    /// End of the last processed line; this is the offset journal entries are stamped with.
    pub fn consumed_offset(&self) -> usize {
        self.consumed_offset
    }

    /// Raw bytes taken from the stream, partial line included: the offset to reattach from.
    pub fn received_bytes(&self) -> usize {
        self.received_bytes
    }

    /// Returns the decoded messages so a live client can route responses to waiting requests.
    pub fn feed(&mut self, data: &[u8]) -> Result<Vec<Inbound>, LineError> {
        self.received_bytes += data.len();
        let mut messages = Vec::new();
        for line in self.splitter.feed(data)? {
            self.drain(line.start);
            let message = decode(&line.bytes, self.images.as_deref());
            messages.push(message.clone());
            reduce(&mut self.state, ChatEvent::Message(message));
            self.consumed_offset = line.end;
            self.drain(line.end);
        }
        Ok(messages)
    }

    /// A live local event; the caller journals it at `consumed_offset`.
    pub fn apply(&mut self, event: ChatEvent) {
        reduce(&mut self.state, event);
    }

    pub fn finish(&mut self) {
        self.drain(usize::MAX);
    }

    fn drain(&mut self, offset: usize) {
        while self.pending.front().is_some_and(|e| e.offset <= offset) {
            let Some(entry) = self.pending.pop_front() else {
                break;
            };
            if let Some(event) = entry.event() {
                reduce(&mut self.state, event);
            }
        }
    }

    pub fn replay(
        log: &[u8],
        journal: &Journal,
        images: Option<Arc<dyn ImageSink>>,
    ) -> Result<ChatState, LineError> {
        let mut builder = Self::new(journal, images);
        builder.feed(log)?;
        builder.finish();
        Ok(builder.state)
    }
}

#[cfg(test)]
mod tests {
    use super::super::fixture::{self, PROMPT_TEXT, Seeded};
    use super::super::images::testimg::{b64, jpeg, png};
    use super::super::images::{DEFAULT_BUDGET, DIRECTORY_SUFFIX, ImageStore};
    use super::super::message::{Cost, ToolKind, ToolStatus, Update};
    use super::super::reducer::{ItemKind, Turn};
    use super::*;
    use serde_json::{Value, json};

    fn replay(log: &[u8], journal: &Journal) -> ChatState {
        TranscriptBuilder::replay(log, journal, None).unwrap()
    }

    fn tool_calls(state: &ChatState) -> Vec<&super::super::reducer::ToolCall> {
        state
            .items
            .iter()
            .filter_map(|i| match &i.kind {
                ItemKind::Tool(c) => Some(c),
                _ => None,
            })
            .collect()
    }

    fn unanswered() -> Journal {
        let mut j = fixture::turn_journal();
        j.entries.pop();
        j
    }

    #[test]
    fn the_fixture_replays_into_the_expected_transcript() {
        let state = replay(&fixture::TURN.log(None), &fixture::turn_journal());
        assert_eq!(state.turn, Turn::Idle);
        assert_eq!(state.session_id.as_deref(), Some("sess-1"));
        assert_eq!(state.load_session, Some(true));
        assert_eq!(state.last_stop_reason.as_deref(), Some("end_turn"));
        assert_eq!(state.title.as_deref(), Some("Hello.txt to out.txt"));
        assert_eq!(state.context_used, Some(39457));
        assert_eq!(state.items.len(), 5, "{:?}", state.items);

        let ItemKind::User {
            text,
            image_count,
            offset,
            ..
        } = &state.items[0].kind
        else {
            panic!()
        };
        assert_eq!(text, PROMPT_TEXT);
        assert_eq!(*image_count, 0);
        assert_eq!(*offset, fixture::turn_prompt_offset());

        let calls = tool_calls(&state);
        let titles: Vec<_> = calls.iter().map(|c| c.title.as_str()).collect();
        assert_eq!(titles, ["Read hello.txt", "Write out.txt"]);
        assert!(calls.iter().all(|c| c.status == ToolStatus::Completed));
        assert_eq!(calls[0].kind, ToolKind::Read);
        assert_eq!(calls[1].kind, ToolKind::Edit);
        assert!(
            calls[0]
                .raw_output
                .as_ref()
                .unwrap()
                .contains("hello from a fixture")
        );
        let diff = calls[1].diff.as_ref().unwrap();
        assert_eq!(
            (
                diff.path.as_str(),
                diff.old_text.as_deref(),
                diff.new_text.as_str()
            ),
            ("/work/project/out.txt", None, "hi\n")
        );

        let ItemKind::Permission(p) = &state.items[3].kind else {
            panic!()
        };
        assert_eq!(p.resolved_option_id.as_deref(), Some("allow-once"));
        assert_eq!(p.diff.as_ref().unwrap().new_text, "hi\n");
        let ids: Vec<_> = p.options.iter().map(|o| o.option_id.as_str()).collect();
        assert_eq!(ids, ["allow-once", "allow-with-updates", "reject"]);
        let kinds: Vec<_> = p.options.iter().map(|o| o.kind.as_str()).collect();
        assert_eq!(kinds, ["allow_once", "allow_always", "reject_once"]);
        assert_eq!(p.tool_call_id, calls[1].id);
        assert!(state.pending_permissions().is_empty());

        let ItemKind::Assistant { text, .. } = &state.items[4].kind else {
            panic!()
        };
        assert_eq!(
            text,
            "I read `hello.txt` (it says \"hello from a fixture\") and created `out.txt` containing \"hi\"."
        );
        assert_eq!(state.model_id.as_deref(), Some("claude-sonnet-5-5"));
        assert_eq!(
            state.cost,
            Some(Cost {
                amount: 0.1638523,
                currency: "USD".into()
            })
        );
    }

    #[test]
    fn random_chunking_gives_the_identical_transcript() {
        let extra = "{\"jsonrpc\":\"2.0\",\"method\":\"_x/y\",\"params\":{\"s\":\"é你😀\"}}";
        let log = fixture::TURN.log_with(None, &[extra]);
        let journal = fixture::turn_journal();
        let expected = replay(&log, &journal);
        for seed in 0..40u64 {
            let mut rng = Seeded(seed);
            let mut builder = TranscriptBuilder::new(&journal, None);
            let mut position = 0;
            while position < log.len() {
                let max = if seed % 2 == 0 { 7 } else { 400 };
                let size = rng.range(1, max).min(log.len() - position);
                builder.feed(&log[position..position + size]).unwrap();
                position += size;
            }
            builder.finish();
            assert_eq!(builder.state(), &expected, "seed {seed}");
            assert_eq!(builder.received_bytes(), log.len());
        }
    }

    #[test]
    fn the_live_path_and_a_replay_from_zero_agree() {
        let mut builder = TranscriptBuilder::new(&Journal::default(), None);
        let mut journal = Journal {
            session_id: Some("sess-1".into()),
            ..Journal::default()
        };
        let session_line = fixture::TURN.index_containing("\"sessionId\":\"sess-1\",\"modes\"");
        let permission_line = fixture::TURN.index_containing("session/request_permission");
        for (index, line) in fixture::TURN.agent_lines().iter().enumerate() {
            builder.feed(format!("{line}\n").as_bytes()).unwrap();
            if index == session_line {
                journal.entries.push(
                    Entry::new(EntryKind::Prompt, builder.consumed_offset()).with_text(PROMPT_TEXT),
                );
                builder.apply(ChatEvent::user_prompt(
                    PROMPT_TEXT,
                    builder.consumed_offset(),
                    None,
                ));
            }
            if index == permission_line {
                journal.entries.push(
                    Entry::new(EntryKind::Answer, builder.consumed_offset())
                        .with_request(AcpId::Int(0))
                        .with_option("allow-once"),
                );
                builder.apply(ChatEvent::PermissionAnswered {
                    request_id: AcpId::Int(0),
                    option_id: "allow-once".into(),
                });
            }
        }
        assert_eq!(journal.entries, fixture::turn_journal().entries);
        assert_eq!(builder.state(), &replay(&fixture::TURN.log(None), &journal));
    }

    #[test]
    fn a_log_ending_mid_turn_shows_the_unanswered_permission_pending() {
        let cut = fixture::TURN.index_containing("session/request_permission") + 1;
        let pending = replay(&fixture::TURN.log(Some(cut)), &unanswered());
        assert_eq!(pending.turn, Turn::Working);
        let ids: Vec<_> = pending
            .pending_permissions()
            .iter()
            .map(|p| p.request_id.clone())
            .collect();
        assert_eq!(ids, [AcpId::Int(0)]);

        let answered = replay(&fixture::TURN.log(Some(cut)), &fixture::turn_journal());
        assert_eq!(answered.turn, Turn::Working);
        assert!(answered.pending_permissions().is_empty());
        let resolved = answered.items.iter().find_map(|i| match &i.kind {
            ItemKind::Permission(p) => Some(p.resolved_option_id.clone()),
            _ => None,
        });
        assert_eq!(resolved, Some(Some("allow-once".to_string())));
    }

    #[test]
    fn a_host_answer_resolves_the_replayed_permission_and_the_live_adoption_agrees() {
        let cut = fixture::TURN.index_containing("session/request_permission") + 1;
        let mut replay_journal = unanswered();
        replay_journal.entries.push(
            Entry::new(EntryKind::HostAnswer, 0)
                .with_request(AcpId::Int(0))
                .with_option("reject"),
        );
        assert_eq!(
            replay_journal.answered_request_ids(),
            HashSet::from([AcpId::Int(0)])
        );
        let replayed = replay(&fixture::TURN.log(Some(cut)), &replay_journal);
        assert!(replayed.pending_permissions().is_empty());
        let resolved = replayed.items.iter().find_map(|i| match &i.kind {
            ItemKind::Permission(p) => p.resolved_option_id.clone(),
            _ => None,
        });
        assert_eq!(resolved.as_deref(), Some("reject"));

        let mut live = TranscriptBuilder::new(&unanswered(), None);
        live.feed(&fixture::TURN.log(Some(cut))).unwrap();
        assert_eq!(live.state().pending_permissions().len(), 1);
        live.apply(ChatEvent::HostAnswered {
            request_id: AcpId::Int(0),
            option_id: "reject".into(),
        });
        assert_eq!(live.state(), &replayed);
    }

    #[test]
    fn unknown_kinds_and_garbage_lines_are_ignored() {
        let noise = [
            "{\"jsonrpc\":\"2.0\",\"method\":\"_auth/status_update\",\"params\":{\"status\":\"ok\"}}",
            "{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"sessionId\":\"s\",\"update\":{\"sessionUpdate\":\"brand_new_kind\",\"x\":1}}}",
            "{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"update\":{\"sessionUpdate\":\"agent_message_chunk\",\"content\":{\"type\":\"image\"}}}}",
            "{not json at all",
            "[1,2,3]",
            "\"just a string\"",
            "{\"jsonrpc\":\"2.0\",\"id\":99,\"method\":\"fs/read_text_file\",\"params\":{}}",
            "{\"jsonrpc\":\"2.0\"}",
        ];
        let clean = replay(&fixture::TURN.log(None), &fixture::turn_journal());
        let mut lines = fixture::TURN.agent_lines();
        for (index, line) in noise.iter().enumerate() {
            let at = (2 + index * 3).min(lines.len());
            lines.insert(at, line.to_string());
        }
        let mut builder = TranscriptBuilder::new(&Journal::default(), None);
        for line in &lines {
            builder.feed(format!("{line}\n").as_bytes()).unwrap();
            if line.contains("\"sessionId\":\"sess-1\",\"modes\"") {
                builder.apply(ChatEvent::user_prompt(
                    PROMPT_TEXT,
                    builder.consumed_offset(),
                    None,
                ));
            }
            if line.contains("session/request_permission") {
                builder.apply(ChatEvent::PermissionAnswered {
                    request_id: AcpId::Int(0),
                    option_id: "allow-once".into(),
                });
            }
        }
        let normalized = |s: &ChatState| -> Vec<ItemKind> {
            s.items
                .iter()
                .map(|i| match &i.kind {
                    ItemKind::User { text, .. } => ItemKind::user(text, 0),
                    other => other.clone(),
                })
                .collect()
        };
        assert_eq!(normalized(builder.state()), normalized(&clean));
        assert_eq!(builder.state().turn, Turn::Idle);
    }

    // Journal and snapshot

    #[test]
    fn an_old_journal_entry_without_content_still_decodes() {
        let json =
            r#"{"kind":"answer","offset":3,"requestId":0,"optionId":"allow-once","imageCount":0}"#;
        let _ = json;
        let entry: Entry = serde_json::from_str(
            r#"{"kind":"answer","offset":3,"request_id":0,"option_id":"allow-once"}"#,
        )
        .unwrap();
        assert_eq!(entry.content, None);
        assert_eq!(
            entry.event(),
            Some(ChatEvent::PermissionAnswered {
                request_id: AcpId::Int(0),
                option_id: "allow-once".into()
            })
        );
    }

    #[test]
    fn a_journal_from_before_loads_decodes_without_the_field() {
        let journal: Journal =
            serde_json::from_str(r#"{"next_request_id":3,"entries":[],"session_id":"sess-1"}"#)
                .unwrap();
        assert_eq!(journal.session_id.as_deref(), Some("sess-1"));
        assert_eq!(journal.loaded_session_id, None);
        assert_eq!(Journal::default().next_request_id, 1);
        let empty: Journal = serde_json::from_str("{}").unwrap();
        assert_eq!(empty.next_request_id, 1);
    }

    #[test]
    fn the_journal_round_trips() {
        let mut journal = fixture::elicitation_journal(Some(BTreeMap::from([(
            "question_0".into(),
            QuestionValue::Text("green".into()),
        )])));
        journal.loaded_session_id = Some("x".into());
        let back: Journal =
            serde_json::from_str(&serde_json::to_string(&journal).unwrap()).unwrap();
        assert_eq!(back, journal);
        assert!(journal.answered_request_ids().contains(&AcpId::Int(0)));
    }

    #[test]
    fn a_journaled_answer_resolves_the_question_on_replay_and_state_round_trips() {
        let journal = fixture::elicitation_journal(Some(BTreeMap::from([(
            "question_0".into(),
            QuestionValue::Text("green".into()),
        )])));
        let log = fixture::ELICITATION.log(Some(fixture::elicitation_request_line() + 1));
        let state = replay(&log, &journal);
        assert!(state.pending_questions().is_empty());
        let q = state
            .items
            .iter()
            .find_map(|i| match &i.kind {
                ItemKind::Question(q) => Some(q),
                _ => None,
            })
            .unwrap();
        assert_eq!(
            q.state,
            super::super::question::QuestionState::Answered(BTreeMap::from([(
                "question_0".into(),
                QuestionValue::Text("green".into())
            )]))
        );
        let back: ChatState =
            serde_json::from_str(&serde_json::to_string(&state).unwrap()).unwrap();
        assert_eq!(back, state);
        assert!(
            state
                .items
                .iter()
                .all(|i| !matches!(i.kind, ItemKind::Tool(_)))
        );
    }

    fn entry_with(text: &str) -> Entry {
        let mut e = Entry::new(EntryKind::QuestionAnswer, 0)
            .with_request(AcpId::Int(0))
            .with_option("accept");
        e.content = Some(BTreeMap::from([(
            "k".into(),
            QuestionValue::Text(text.into()),
        )]));
        e
    }

    #[test]
    fn the_digest_covers_the_answers_content_and_the_images() {
        assert_eq!(digest([&entry_with("a")]), digest([&entry_with("a")]));
        assert_ne!(digest([&entry_with("a")]), digest([&entry_with("b")]));
        let mut with_image = Entry::new(EntryKind::Prompt, 0).with_text("x");
        with_image.images = vec![ImageRef {
            id: "abc".into(),
            mime_type: "image/png".into(),
            pixel_width: Some(2),
            pixel_height: Some(3),
            byte_count: 9,
        }];
        assert_ne!(
            digest([&with_image]),
            digest([&Entry::new(EntryKind::Prompt, 0).with_text("x")])
        );
    }

    #[test]
    fn the_digest_is_fnv_1a_over_the_separated_fields() {
        let entry = Entry::new(EntryKind::Cancel, 7);
        let line = "cancel\u{1F}7\u{1F}\u{1F}\u{1F}\u{1F}0\n";
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        for b in line.bytes() {
            hash ^= u64::from(b);
            hash = hash.wrapping_mul(0x0000_0100_0000_01B3);
        }
        assert_eq!(digest([&entry]), format!("{hash:x}"));
        assert_eq!(
            digest([&Entry::new(EntryKind::Answer, 1).with_request(AcpId::Int(0))]),
            {
                let line = "answer\u{1F}1\u{1F}\u{1F}int(0)\u{1F}\u{1F}0\n";
                let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
                for b in line.bytes() {
                    hash ^= u64::from(b);
                    hash = hash.wrapping_mul(0x0000_0100_0000_01B3);
                }
                format!("{hash:x}")
            }
        );
        assert_eq!(CURRENT_VERSION, 1);
    }

    // Snapshots: every fixture, every line boundary

    struct Case {
        name: &'static str,
        lines: Vec<String>,
        journal: Journal,
    }

    fn update(body: Value) -> String {
        serde_json::to_string(&super::super::message::sorted(
            &json!({"jsonrpc": "2.0", "method": "session/update", "params": {"update": body}}),
        ))
        .unwrap()
    }

    #[allow(clippy::too_many_arguments)]
    fn tool(
        id: &str,
        title: &str,
        status: &str,
        is_update: bool,
        parent: Option<&str>,
        name: Option<&str>,
        input: Option<Value>,
        text: Option<&str>,
    ) -> String {
        let mut body = json!({
            "sessionUpdate": if is_update { "tool_call_update" } else { "tool_call" },
            "toolCallId": id, "title": title, "status": status,
        });
        let mut meta = serde_json::Map::new();
        if let Some(p) = parent {
            meta.insert("parentToolUseId".into(), json!(p));
        }
        if let Some(n) = name {
            meta.insert("toolName".into(), json!(n));
        }
        if !meta.is_empty() {
            body["_meta"] = json!({"claudeCode": meta});
        }
        if let Some(i) = input {
            body["rawInput"] = i;
        }
        if let Some(t) = text {
            body["content"] = json!([{"type": "content", "content": {"type": "text", "text": t}}]);
        }
        update(body)
    }

    fn nesting() -> Vec<String> {
        vec![
            update(
                json!({"sessionUpdate": "agent_message_chunk", "messageId": "m1", "content": {"type": "text", "text": "héllo "}}),
            ),
            tool(
                "a",
                "Task",
                "pending",
                false,
                None,
                Some("Agent"),
                None,
                None,
            ),
            tool(
                "a",
                "check things",
                "in_progress",
                true,
                None,
                Some("Agent"),
                Some(json!({"description": "check things"})),
                None,
            ),
            tool(
                "c1",
                "Read a",
                "pending",
                false,
                Some("a"),
                None,
                None,
                None,
            ),
            tool(
                "c1",
                "Read a",
                "completed",
                true,
                Some("a"),
                None,
                None,
                Some("body"),
            ),
            tool(
                "c2",
                "Bash b",
                "in_progress",
                false,
                Some("a"),
                None,
                None,
                None,
            ),
            tool("m", "Main tool", "completed", false, None, None, None, None),
            update(
                json!({"sessionUpdate": "agent_thought_chunk", "content": {"type": "text", "text": "thinking"}}),
            ),
            tool(
                "a",
                "check things",
                "completed",
                true,
                None,
                Some("Agent"),
                None,
                Some("The report."),
            ),
            tool(
                "b",
                "Task",
                "pending",
                false,
                None,
                Some("Agent"),
                None,
                None,
            ),
            tool(
                "b",
                "audit",
                "completed",
                true,
                None,
                Some("Agent"),
                Some(json!({"description": "audit"})),
                Some("Async agent launched successfully. (internal)\nagentId: z"),
            ),
            tool(
                "d1",
                "Read d",
                "in_progress",
                false,
                Some("b"),
                None,
                None,
                None,
            ),
            update(
                json!({"sessionUpdate": "agent_message_chunk", "messageId": "m1", "content": {"type": "text", "text": "done"}}),
            ),
        ]
    }

    fn offset(lines: &[String], after: usize) -> usize {
        lines.iter().take(after).map(|l| l.len() + 1).sum()
    }

    fn cases() -> Vec<Case> {
        let lines = nesting();
        let mut nested = Journal {
            session_id: Some("sess-n".into()),
            ..Journal::default()
        };
        let mut again = Entry::new(EntryKind::Prompt, offset(&lines, 6)).with_text("again");
        again.image_count = 2;
        nested.entries = vec![
            Entry::new(EntryKind::Prompt, 0).with_text("go"),
            again,
            Entry::new(EntryKind::SilentRequest, offset(&lines, 6)).with_request(AcpId::Int(9)),
        ];
        let answer = BTreeMap::from([
            ("question_0".to_string(), QuestionValue::Text("red".into())),
            (
                "question_0_custom".to_string(),
                QuestionValue::Text("a note".into()),
            ),
        ]);
        vec![
            Case {
                name: "turn-write",
                lines: fixture::TURN.agent_lines(),
                journal: fixture::turn_journal(),
            },
            Case {
                name: "controls",
                lines: fixture::CONTROLS.agent_lines(),
                journal: fixture::controls_journal(),
            },
            Case {
                name: "nesting",
                lines,
                journal: nested,
            },
            Case {
                name: "question-answered",
                lines: fixture::ELICITATION.agent_lines(),
                journal: fixture::elicitation_journal(Some(answer)),
            },
            Case {
                name: "question-turn-end",
                lines: fixture::ELICITATION.agent_lines(),
                journal: fixture::elicitation_journal(None),
            },
        ]
    }

    fn data(lines: &[String]) -> Vec<u8> {
        fixture::join(lines)
    }

    fn snapshot_at(case: &Case, count: usize) -> (Snapshot, Journal) {
        let cut = offset(&case.lines, count);
        let mut seen = case.journal.clone();
        seen.entries = case
            .journal
            .entries_up_to(cut)
            .into_iter()
            .cloned()
            .collect();
        let mut builder = TranscriptBuilder::new(&seen, None);
        builder.feed(&data(&case.lines[..count])).unwrap();
        assert_eq!(builder.consumed_offset(), cut);
        (
            Snapshot::new(1_700_000_000, cut, &seen, builder.state().clone()),
            seen,
        )
    }

    #[test]
    fn state_survives_a_json_round_trip_for_every_fixture() {
        for case in cases() {
            let state = replay(&data(&case.lines), &case.journal);
            let back: ChatState =
                serde_json::from_str(&serde_json::to_string(&state).unwrap()).unwrap();
            assert_eq!(back, state, "{}", case.name);
            assert!(
                !state.items.is_empty() || !state.config_options.is_empty(),
                "{}",
                case.name
            );
        }
    }

    #[test]
    fn a_snapshot_at_any_line_boundary_plus_the_rest_of_the_log_equals_a_full_replay() {
        let mut rng = Seeded(7);
        for case in cases() {
            let full = data(&case.lines);
            let expected = replay(&full, &case.journal);
            for count in 1..=case.lines.len() {
                let (taken, _) = snapshot_at(&case, count);
                let stored: Snapshot =
                    serde_json::from_str(&serde_json::to_string(&taken).unwrap()).unwrap();
                assert!(
                    stored.is_consistent(&case.journal),
                    "{} @{count}",
                    case.name
                );
                let mut builder = TranscriptBuilder::resuming(&case.journal, &stored, None);
                assert_eq!(builder.received_bytes(), stored.offset);
                let rest = &full[stored.offset..];
                let mut at = 0;
                while at < rest.len() {
                    let size = rng.range(1, 200).min(rest.len() - at);
                    builder.feed(&rest[at..at + size]).unwrap();
                    at += size;
                }
                builder.finish();
                assert_eq!(
                    builder.state(),
                    &expected,
                    "{} cut after line {count}",
                    case.name
                );
                assert_eq!(builder.received_bytes(), full.len());
            }
        }
    }

    #[test]
    fn journal_entries_added_after_the_snapshot_are_applied_on_resume() {
        let mut case = cases().remove(0);
        let answered = fixture::TURN.index_containing("session/request_permission") + 1;
        let (taken, seen) = snapshot_at(&case, answered);
        assert_eq!(seen.entries.len(), 2);
        case.journal
            .entries
            .push(Entry::new(EntryKind::Prompt, taken.offset).with_text("later"));
        let full = data(&case.lines);
        let builder = TranscriptBuilder::resuming(&case.journal, &taken, None);
        assert!(taken.is_consistent(&case.journal));
        assert!(
            builder
                .state()
                .items
                .iter()
                .any(|i| matches!(&i.kind, ItemKind::User { text, .. } if text == "later"))
        );
        assert_eq!(builder.state().turn, Turn::Working);
        let mut resumed = builder;
        resumed.feed(&full[taken.offset..]).unwrap();
        resumed.finish();
        assert_eq!(resumed.state(), &replay(&full, &case.journal));
    }

    #[test]
    fn a_snapshot_is_refused_when_the_journal_changed_underneath_it() {
        let case = cases().remove(0);
        let (taken, _) = snapshot_at(&case, case.lines.len());
        assert!(taken.is_consistent(&case.journal));

        let mut edited = case.journal.clone();
        edited.entries[0].text = Some("something else".into());
        assert!(!taken.is_consistent(&edited));

        let mut removed = case.journal.clone();
        removed.entries.pop();
        assert!(!taken.is_consistent(&removed));

        let mut future = taken.clone();
        future.version = CURRENT_VERSION + 1;
        assert!(!future.is_consistent(&case.journal));
    }

    // Images through the builder

    fn lines_with_images(png_data: &[u8], jpeg_data: &[u8]) -> Vec<String> {
        let text = |t: &str| {
            update(
                json!({"sessionUpdate": "agent_message_chunk", "messageId": "m1", "content": {"type": "text", "text": t}}),
            )
        };
        let image = |data: &[u8], mime: Option<&str>| {
            let mut block = json!({"type": "image", "data": b64(data)});
            if let Some(m) = mime {
                block["mimeType"] = json!(m);
            }
            update(
                json!({"sessionUpdate": "agent_message_chunk", "messageId": "m1", "content": block}),
            )
        };
        let b = b64(png_data);
        vec![
            text("Looking. "),
            update(
                json!({"sessionUpdate": "tool_call", "toolCallId": "r1", "title": "Read pic.png", "kind": "read", "status": "pending"}),
            ),
            update(json!({
                "sessionUpdate": "tool_call_update", "toolCallId": "r1", "status": "completed", "title": "Read pic.png",
                "content": [{"type": "content", "content": {"type": "image", "data": b, "mimeType": "image/png"}}],
                "rawOutput": [{"type": "image", "source": {"type": "base64", "data": b, "media_type": "image/png"}}],
            })),
            image(jpeg_data, None),
            image(png_data, Some("image/png")),
            text("Done."),
        ]
    }

    #[test]
    fn images_land_in_state_in_order_with_the_text() {
        let lines = lines_with_images(&png(8, 6, 1), &jpeg(8, 6, 2));
        let state = replay(&data(&lines), &Journal::default());
        assert_eq!(state.items.len(), 4);
        let ItemKind::Tool(call) = &state.items[1].kind else {
            panic!()
        };
        assert_eq!(call.images.len(), 1);
        assert_eq!(call.raw_output, None);
        let ItemKind::Images { refs, .. } = &state.items[2].kind else {
            panic!()
        };
        let mimes: Vec<_> = refs.iter().map(|r| r.mime_type.as_str()).collect();
        assert_eq!(mimes, ["image/jpeg", "image/png"]);
        assert!(matches!(state.items[0].kind, ItemKind::Assistant { .. }));
        assert!(matches!(state.items[3].kind, ItemKind::Assistant { .. }));
    }

    #[test]
    fn live_replay_and_every_snapshot_cut_agree_and_missing_files_are_rewritten() {
        let all = lines_with_images(&png(8, 6, 1), &jpeg(8, 6, 2));
        let root = tempfile::tempdir().unwrap();
        let store: Arc<ImageStore> = Arc::new(ImageStore::new(
            root.path().join(format!("c{DIRECTORY_SUFFIX}")),
            root.path().to_path_buf(),
            DEFAULT_BUDGET,
        ));
        let sink = || -> Option<Arc<dyn ImageSink>> { Some(store.clone()) };
        let full = data(&all);
        let expected = replay(&full, &Journal::default());
        for count in 1..=all.len() {
            let cut = offset(&all, count);
            let mut live = TranscriptBuilder::new(&Journal::default(), sink());
            live.feed(&full[..cut]).unwrap();
            let snapshot = Snapshot::new(1, cut, &Journal::default(), live.state().clone());
            let stored: Snapshot =
                serde_json::from_str(&serde_json::to_string(&snapshot).unwrap()).unwrap();
            let mut resumed = TranscriptBuilder::resuming(&Journal::default(), &stored, sink());
            resumed.feed(&full[cut..]).unwrap();
            resumed.finish();
            assert_eq!(resumed.state(), &expected, "cut after {count}");
        }
        store.remove_all();
        let mut again = TranscriptBuilder::new(&Journal::default(), sink());
        again.feed(&full).unwrap();
        assert_eq!(again.state(), &expected);
        for item in &again.state().items {
            if let ItemKind::Images { refs, .. } = &item.kind {
                assert!(refs.iter().all(|r| store.exists(r)));
            }
        }
    }

    #[test]
    fn the_user_prompt_keeps_its_image_ids_and_old_journals_still_decode() {
        let r = ImageRef {
            id: "abc".into(),
            mime_type: "image/png".into(),
            pixel_width: Some(2),
            pixel_height: Some(3),
            byte_count: 9,
        };
        let mut entry = Entry::new(EntryKind::Prompt, 0).with_text("look");
        entry.image_count = 1;
        entry.images = vec![r.clone()];
        let journal = Journal {
            entries: vec![entry],
            ..Journal::default()
        };
        let back: Journal =
            serde_json::from_str(&serde_json::to_string(&journal).unwrap()).unwrap();
        assert_eq!(back, journal);
        let state = replay(b"", &back);
        assert_eq!(
            state
                .items
                .iter()
                .map(|i| i.kind.clone())
                .collect::<Vec<_>>(),
            [ItemKind::User {
                text: "look".into(),
                image_count: 1,
                offset: 0,
                images: vec![r]
            }]
        );
        let legacy: Journal = serde_json::from_str(
            r#"{"entries":[{"kind":"prompt","offset":0,"text":"hi","image_count":2}],"next_request_id":1}"#,
        )
        .unwrap();
        assert!(legacy.entries[0].images.is_empty());
        assert_eq!(legacy.entries[0].image_count, 2);
    }

    #[test]
    fn usage_updates_do_not_disturb_the_stored_cost() {
        let mut state = ChatState::default();
        reduce(
            &mut state,
            ChatEvent::Message(Inbound::Update(Update::Usage {
                used: 1,
                size: 2,
                cost: Some(Cost {
                    amount: 1.0,
                    currency: "USD".into(),
                }),
                model_id: None,
            })),
        );
        reduce(
            &mut state,
            ChatEvent::Message(Inbound::Update(Update::Usage {
                used: 3,
                size: 2,
                cost: None,
                model_id: Some("m".into()),
            })),
        );
        assert_eq!(state.cost.as_ref().unwrap().amount, 1.0);
        assert_eq!(state.context_used, Some(3));
        assert_eq!(state.model_id.as_deref(), Some("m"));
    }
}
