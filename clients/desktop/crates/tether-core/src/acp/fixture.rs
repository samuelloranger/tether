//! The recorded agent sessions the iOS tests use: `< ` lines are agent to client, `> ` the reverse.

use std::collections::BTreeMap;
use std::ops::Range;

use super::journal::{Entry, EntryKind, Journal};
use super::message::AcpId;
use super::question::QuestionValue;

pub struct Fixture(&'static str);

pub static TURN: Fixture = Fixture(include_str!("fixtures/acp-turn-write.log"));
pub static CONTROLS: Fixture = Fixture(include_str!("fixtures/acp-controls.log"));
pub static LOAD: Fixture = Fixture(include_str!("fixtures/acp-load.log"));
pub static ELICITATION: Fixture = Fixture(include_str!("fixtures/acp-elicitation.log"));

impl Fixture {
    fn lines(&self, prefix: &str) -> Vec<String> {
        self.0
            .split('\n')
            .filter(|l| l.starts_with(prefix))
            .map(|l| l[prefix.len()..].to_string())
            .collect()
    }

    pub fn agent_lines(&self) -> Vec<String> {
        self.lines("< ")
    }

    pub fn client_lines(&self) -> Vec<String> {
        self.lines("> ")
    }

    pub fn index_containing(&self, needle: &str) -> usize {
        self.agent_lines()
            .iter()
            .position(|l| l.contains(needle))
            .unwrap_or_else(|| panic!("no fixture line contains {needle}"))
    }

    pub fn offset_after(&self, count: usize) -> usize {
        self.agent_lines()
            .iter()
            .take(count)
            .map(|l| l.len() + 1)
            .sum()
    }

    /// The first `count` agent lines as the holder's byte log would hold them.
    pub fn log(&self, count: Option<usize>) -> Vec<u8> {
        self.log_with(count, &[])
    }

    pub fn log_with(&self, count: Option<usize>, extra: &[&str]) -> Vec<u8> {
        let mut lines = self.agent_lines();
        lines.truncate(count.unwrap_or(usize::MAX));
        lines.extend(extra.iter().map(|s| s.to_string()));
        join(&lines)
    }

    pub fn log_range(&self, range: Range<usize>) -> Vec<u8> {
        join(&self.agent_lines()[range])
    }
}

pub fn join(lines: &[String]) -> Vec<u8> {
    let mut text = lines.join("\n");
    text.push('\n');
    text.into_bytes()
}

pub const PROMPT_TEXT: &str = "Read hello.txt, then create out.txt containing the word hi. Keep your reply to one short sentence.";

/// The prompt goes out after `session/new` answers.
pub fn turn_prompt_offset() -> usize {
    TURN.offset_after(TURN.index_containing("\"sessionId\":\"sess-1\",\"modes\"") + 1)
}

/// The answer goes out after the permission request arrives.
pub fn turn_answer_offset() -> usize {
    TURN.offset_after(TURN.index_containing("session/request_permission") + 1)
}

pub fn turn_journal() -> Journal {
    Journal {
        session_id: Some("sess-1".into()),
        entries: vec![
            Entry::new(EntryKind::Prompt, turn_prompt_offset()).with_text(PROMPT_TEXT),
            Entry::new(EntryKind::Answer, turn_answer_offset())
                .with_request(AcpId::Int(0))
                .with_option("allow-once"),
        ],
        ..Journal::default()
    }
}

pub fn controls_journal() -> Journal {
    Journal {
        session_id: Some("sess-2".into()),
        next_request_id: 3,
        ..Journal::default()
    }
}

pub fn elicitation_request_line() -> usize {
    ELICITATION.index_containing("elicitation/create")
}

pub fn elicitation_prompt_offset() -> usize {
    ELICITATION.offset_after(ELICITATION.index_containing("\"sessionId\":\"sess-3\",\"modes\"") + 1)
}

pub fn elicitation_answer_offset() -> usize {
    ELICITATION.offset_after(elicitation_request_line() + 1)
}

pub fn elicitation_journal(answer: Option<BTreeMap<String, QuestionValue>>) -> Journal {
    let mut journal = Journal {
        session_id: Some("sess-3".into()),
        entries: vec![
            Entry::new(EntryKind::Prompt, elicitation_prompt_offset()).with_text("Ask me a colour"),
        ],
        ..Journal::default()
    };
    if let Some(content) = answer {
        let mut entry = Entry::new(EntryKind::QuestionAnswer, elicitation_answer_offset())
            .with_request(AcpId::Int(0))
            .with_option("accept");
        entry.content = Some(content);
        journal.entries.push(entry);
    }
    journal
}

pub fn load_response_line() -> usize {
    LOAD.index_containing("\"sessionId\":\"sess-4\",\"modes\"")
}

/// A splitmix generator, so chunking tests are reproducible.
pub struct Seeded(pub u64);

impl Seeded {
    pub fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    pub fn range(&mut self, low: usize, high: usize) -> usize {
        low + (self.next() as usize) % (high - low + 1)
    }
}
