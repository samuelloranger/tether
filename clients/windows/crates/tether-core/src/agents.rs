//! Agent state per zmx session, as `tether-notify status` reports it, and the answers for
//! what the Claude Code mod holds (`tether-notify pending` / `answer`). Pure: no network.

use std::collections::{BTreeMap, HashMap};
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::Value;

use crate::zmx::{shell_quote, valid_session_name};

pub const NOTIFY: &str = "~/.local/bin/tether-notify";
pub const MISSING: &str = "__tether_notify_missing";
/// A status read older than this is no longer shown.
pub const STALE_AFTER: Duration = Duration::from_secs(30);
/// The longest reply sent from here; well inside a remote shell's argument limit once encoded.
pub const MAX_REPLY: usize = 2000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentState {
    Working,
    Waiting,
    Done,
}

impl AgentState {
    fn parse(s: &str) -> Option<Self> {
        match s {
            "working" => Some(Self::Working),
            "waiting" => Some(Self::Waiting),
            "done" => Some(Self::Done),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Working => "working",
            Self::Waiting => "waiting",
            Self::Done => "done",
        }
    }
}

/// What the Claude Code mod holds for a client in a session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Held {
    Question,
    Permission,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentStatus {
    pub session: String,
    pub agent: String,
    pub state: AgentState,
    pub since: i64,
    pub updated: i64,
    pub message: String,
    pub link: String,
    pub held: Option<Held>,
    /// New on every state change; an answer must name it.
    pub version: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StatusRead {
    Rows(Vec<AgentStatus>),
    /// No `tether-notify` on the host.
    Missing,
    /// Output that is not a status array: an older binary without `status`.
    Unusable,
}

/// Runs `tether-notify status`, or prints a marker when the binary is not there.
pub fn status_command() -> String {
    format!("if [ -x {NOTIFY} ]; then {NOTIFY} status 2>/dev/null; else echo {MISSING}; fi")
}

pub fn parse_status(output: &str) -> StatusRead {
    if output.lines().any(|l| l.trim() == MISSING) {
        return StatusRead::Missing;
    }
    match array_rows(output) {
        Some(rows) => StatusRead::Rows(rows.iter().filter_map(status_row).collect()),
        None => StatusRead::Unusable,
    }
}

/// The JSON array in `output`: the whole text, else the last line that is one, so a login
/// banner ahead of it does not hide the rows.
fn array_rows(output: &str) -> Option<Vec<Value>> {
    let whole = output.trim();
    if let Ok(Value::Array(rows)) = serde_json::from_str(whole) {
        return Some(rows);
    }
    whole.lines().rev().find_map(|line| {
        let line = line.trim();
        if !line.starts_with('[') {
            return None;
        }
        match serde_json::from_str(line) {
            Ok(Value::Array(rows)) => Some(rows),
            _ => None,
        }
    })
}

fn status_row(row: &Value) -> Option<AgentStatus> {
    let text = |key: &str| {
        row.get(key)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned()
    };
    let number = |key: &str| row.get(key).and_then(Value::as_f64).map_or(0, |n| n as i64);
    let session = text("session");
    if session.is_empty() {
        return None;
    }
    let held = match row
        .get("pending")
        .and_then(|p| p.get("kind"))
        .and_then(Value::as_str)
    {
        Some("question") => Some(Held::Question),
        Some("permission") => Some(Held::Permission),
        _ => None,
    };
    Some(AgentStatus {
        session,
        agent: text("agent"),
        state: AgentState::parse(row.get("state").and_then(Value::as_str)?)?,
        since: number("since"),
        updated: number("updated"),
        message: text("message"),
        link: text("link"),
        held,
        version: text("version"),
    })
}

pub fn age_label(since: i64, now: i64) -> String {
    let seconds = (now - since).max(0);
    match seconds {
        0..60 => "now".into(),
        60..3600 => format!("{}m", seconds / 60),
        3600..86400 => format!("{}h", seconds / 3600),
        _ => format!("{}d", seconds / 86400),
    }
}

/// "working" / "needs you" / "done 5m": always words, colour only reinforces them.
pub fn badge_label(status: &AgentStatus, now_unix: i64) -> String {
    match status.state {
        AgentState::Working => "working".into(),
        AgentState::Waiting => "needs you".into(),
        AgentState::Done => format!("done {}", age_label(status.since, now_unix)),
    }
}

/// The last good read of every session's agent state, and what changed since the one before.
#[derive(Debug, Default)]
pub struct AgentBoard {
    statuses: HashMap<String, AgentStatus>,
    baseline: bool,
    unavailable: bool,
    last_read: Option<Duration>,
}

impl AgentBoard {
    /// A fresh connection: the next read is a baseline again, never an alert.
    pub fn reset(&mut self) {
        *self = Self::default();
    }

    /// False once the host has no usable `tether-notify`: polling stops until a reconnect.
    pub fn available(&self) -> bool {
        !self.unavailable
    }

    pub fn get(&self, session: &str) -> Option<&AgentStatus> {
        self.statuses.get(session)
    }

    /// Sessions that entered `waiting` (or got a new prompt while waiting) since the last
    /// read. The first read after a reset alerts nothing.
    pub fn apply(&mut self, read: StatusRead, now: Duration) -> Vec<AgentStatus> {
        let rows = match read {
            StatusRead::Rows(rows) => rows,
            StatusRead::Missing | StatusRead::Unusable => {
                self.unavailable = true;
                self.statuses.clear();
                return Vec::new();
            }
        };
        let alerts = if self.baseline {
            rows.iter()
                .filter(|s| s.state == AgentState::Waiting)
                .filter(|s| {
                    self.statuses.get(&s.session).is_none_or(|before| {
                        before.state != s.state
                            || before.since != s.since
                            || before.version != s.version
                    })
                })
                .cloned()
                .collect()
        } else {
            Vec::new()
        };
        self.statuses = rows.into_iter().map(|s| (s.session.clone(), s)).collect();
        self.baseline = true;
        self.last_read = Some(now);
        alerts
    }

    /// A failed exec keeps the last read for a while, then drops it rather than show it as live.
    pub fn failed(&mut self, now: Duration) {
        if self
            .last_read
            .is_some_and(|at| now.saturating_sub(at) > STALE_AFTER)
        {
            self.statuses.clear();
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
pub struct QuestionOption {
    pub label: String,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
pub struct Question {
    pub question: String,
    #[serde(default)]
    pub header: String,
    #[serde(default, rename = "multiSelect")]
    pub multi_select: bool,
    #[serde(default)]
    pub options: Vec<QuestionOption>,
}

/// The held questions, and the state and version an answer to them must name.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
pub struct Pending {
    pub session: String,
    pub state: String,
    pub version: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub questions: Vec<Question>,
}

pub fn pending_command(session: &str) -> Option<String> {
    valid_session_name(session)
        .then(|| format!("{NOTIFY} pending --session {}", shell_quote(session)))
}

/// `None` when the output is not a held question: gone, or answered since the status read.
pub fn parse_pending(output: &str) -> Option<Pending> {
    let line = output.lines().rev().find(|l| l.trim().starts_with('{'))?;
    let pending: Pending = serde_json::from_str(line.trim()).ok()?;
    (pending.kind == "question"
        && !pending.questions.is_empty()
        && !pending.version.is_empty()
        && pending.questions.iter().all(|q| !q.question.is_empty()))
    .then_some(pending)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Answer {
    /// A held question's answers, keyed by question text.
    Questions(BTreeMap<String, String>),
    Approve,
    Deny,
    Reply(String),
}

/// `tether-notify answer` checks the agent is still in `state`/`version` before it acts, so
/// an old click cannot answer a newer prompt. Nothing typed is parsed by the remote shell.
pub fn answer_command(
    session: &str,
    state: AgentState,
    version: &str,
    answer: &Answer,
) -> Option<String> {
    if !valid_session_name(session) || version.is_empty() {
        return None;
    }
    let input = |bytes: &str| format!("--input {}", shell_quote(&STANDARD.encode(bytes)));
    let tail = match answer {
        Answer::Questions(answers) if answers.is_empty() => return None,
        Answer::Questions(answers) => format!(
            "--answers {}",
            shell_quote(&STANDARD.encode(serde_json::to_string(answers).ok()?))
        ),
        Answer::Approve => input("\r"),
        Answer::Deny => input("\u{1b}"),
        Answer::Reply(text) => {
            let line = single_line(text);
            if line.is_empty() || line.chars().count() > MAX_REPLY {
                return None;
            }
            format!("{} --submit", input(&line))
        }
    };
    Some(format!(
        "{NOTIFY} answer --session {} --state {} --version {} {tail}",
        shell_quote(session),
        shell_quote(state.as_str()),
        shell_quote(version),
    ))
}

/// A newline mid-reply would submit it early.
fn single_line(text: &str) -> String {
    text.split(['\n', '\r'])
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// `answer` exits 3 when the agent has moved on, and 4 when it typed but could not submit.
pub fn answer_failure(error: &str) -> String {
    if error.contains("status 3") {
        "The agent has moved on; nothing was sent.".into()
    } else if error.contains("status 4") {
        "Typed, but the agent moved on before Return.".into()
    } else {
        "Couldn't send the answer.".into()
    }
}

/// The answer sheet's picks in progress. A multi-select answer joins its labels in option
/// order with ", ", as Claude Code's own dialog reports one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Draft {
    pub questions: Vec<Question>,
    selected: Vec<Vec<bool>>,
    other: Vec<String>,
}

impl Draft {
    pub fn new(questions: Vec<Question>) -> Self {
        let selected = questions
            .iter()
            .map(|q| vec![false; q.options.len()])
            .collect();
        let other = vec![String::new(); questions.len()];
        Self {
            questions,
            selected,
            other,
        }
    }

    pub fn is_selected(&self, question: usize, option: usize) -> bool {
        self.selected
            .get(question)
            .and_then(|s| s.get(option))
            .copied()
            .unwrap_or(false)
    }

    pub fn other(&self, question: usize) -> &str {
        self.other.get(question).map_or("", String::as_str)
    }

    pub fn toggle(&mut self, question: usize, option: usize) {
        let Some(q) = self.questions.get(question) else {
            return;
        };
        let Some(picks) = self.selected.get_mut(question) else {
            return;
        };
        if option >= picks.len() {
            return;
        }
        if q.multi_select {
            picks[option] = !picks[option];
        } else {
            picks.iter_mut().for_each(|p| *p = false);
            picks[option] = true;
            self.other[question].clear();
        }
    }

    /// On a single-choice question the typed answer stands in for a pick.
    pub fn set_other(&mut self, question: usize, text: &str) {
        let Some(q) = self.questions.get(question) else {
            return;
        };
        self.other[question] = text.to_owned();
        if !q.multi_select && !text.trim().is_empty() {
            self.selected[question].iter_mut().for_each(|p| *p = false);
        }
    }

    /// Every question's answer keyed by its text, or `None` while one is unanswered.
    pub fn answers(&self) -> Option<BTreeMap<String, String>> {
        let mut out = BTreeMap::new();
        for (i, q) in self.questions.iter().enumerate() {
            let picks: Vec<&str> = q
                .options
                .iter()
                .zip(&self.selected[i])
                .filter(|(_, on)| **on)
                .map(|(o, _)| o.label.as_str())
                .collect();
            let typed = self.other[i].trim();
            let parts: Vec<&str> = match (typed.is_empty(), q.multi_select) {
                (true, _) => picks,
                (false, true) => picks.into_iter().chain([typed]).collect(),
                (false, false) => vec![typed],
            };
            if parts.is_empty() {
                return None;
            }
            out.insert(q.question.clone(), parts.join(", "));
        }
        Some(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(session: &str, state: &str, since: i64, version: &str) -> String {
        format!(
            r#"{{"session":"{session}","agent":"claude","state":"{state}","since":{since},"updated":{since},"version":"{version}","message":"m","link":"l"}}"#
        )
    }

    fn rows(read: StatusRead) -> Vec<AgentStatus> {
        match read {
            StatusRead::Rows(r) => r,
            other => panic!("{other:?}"),
        }
    }

    fn q(text: &str, multi: bool, labels: &[&str]) -> Question {
        Question {
            question: text.into(),
            header: "H".into(),
            multi_select: multi,
            options: labels
                .iter()
                .map(|l| QuestionOption {
                    label: (*l).into(),
                    description: None,
                })
                .collect(),
        }
    }

    #[test]
    fn parses_rows_with_held_and_version() {
        let out = format!(
            r#"[{},{{"session":"b","state":"waiting","since":5,"pending":{{"kind":"question"}},"version":"v9"}},{{"session":"c","state":"waiting","pending":{{"kind":"permission"}}}}]"#,
            row("a", "working", 10, "v1")
        );
        let r = rows(parse_status(&out));
        assert_eq!(r.len(), 3);
        assert_eq!(r[0].state, AgentState::Working);
        assert_eq!(r[0].message, "m");
        assert_eq!(r[1].held, Some(Held::Question));
        assert_eq!(r[1].version, "v9");
        assert_eq!(r[2].held, Some(Held::Permission));
    }

    #[test]
    fn malformed_rows_are_skipped_not_fatal() {
        let out = format!(
            r#"[{}, 7, {{"state":"done"}}, {{"session":"","state":"done"}}, {{"session":"x","state":"sleeping"}}, {{"session":"y","state":"done"}}]"#,
            row("a", "done", 1, "v")
        );
        let r = rows(parse_status(&out));
        assert_eq!(
            r.iter().map(|s| s.session.as_str()).collect::<Vec<_>>(),
            ["a", "y"]
        );
    }

    #[test]
    fn a_banner_ahead_of_the_array_is_ignored() {
        let out = format!("welcome\n[{}]\n", row("a", "done", 1, "v"));
        assert_eq!(rows(parse_status(&out)).len(), 1);
        assert_eq!(rows(parse_status("[]\n")), vec![]);
    }

    #[test]
    fn missing_and_unusable_outputs_are_told_apart() {
        assert_eq!(parse_status(&format!("{MISSING}\n")), StatusRead::Missing);
        assert_eq!(parse_status(""), StatusRead::Unusable);
        assert_eq!(parse_status("usage: tether-notify"), StatusRead::Unusable);
        assert_eq!(parse_status("[not json"), StatusRead::Unusable);
        assert_eq!(parse_status("{\"session\":\"a\"}"), StatusRead::Unusable);
    }

    #[test]
    fn the_status_command_checks_the_binary_first() {
        let c = status_command();
        assert!(c.starts_with("if [ -x ~/.local/bin/tether-notify ]"));
        assert!(c.contains(MISSING));
    }

    #[test]
    fn age_labels_round_down() {
        assert_eq!(age_label(100, 130), "now");
        assert_eq!(age_label(100, 100 + 300), "5m");
        assert_eq!(age_label(100, 100 + 7200), "2h");
        assert_eq!(age_label(100, 100 + 3 * 86400), "3d");
        assert_eq!(age_label(500, 100), "now");
    }

    #[test]
    fn badges_use_words() {
        let s = |state| AgentStatus {
            session: "a".into(),
            agent: String::new(),
            state,
            since: 0,
            updated: 0,
            message: String::new(),
            link: String::new(),
            held: None,
            version: String::new(),
        };
        assert_eq!(badge_label(&s(AgentState::Working), 0), "working");
        assert_eq!(badge_label(&s(AgentState::Waiting), 0), "needs you");
        assert_eq!(badge_label(&s(AgentState::Done), 600), "done 10m");
    }

    fn at(s: u64) -> Duration {
        Duration::from_secs(s)
    }

    fn read(rows: &[(&str, &str, i64, &str)]) -> StatusRead {
        let body = rows
            .iter()
            .map(|(s, st, since, v)| row(s, st, *since, v))
            .collect::<Vec<_>>()
            .join(",");
        parse_status(&format!("[{body}]"))
    }

    #[test]
    fn the_first_read_is_a_baseline_never_an_alert() {
        let mut b = AgentBoard::default();
        assert!(
            b.apply(read(&[("a", "waiting", 1, "v1")]), at(0))
                .is_empty()
        );
        assert_eq!(b.get("a").unwrap().state, AgentState::Waiting);
    }

    #[test]
    fn entering_waiting_alerts_once() {
        let mut b = AgentBoard::default();
        b.apply(read(&[("a", "working", 1, "v1")]), at(0));
        let alerts = b.apply(read(&[("a", "waiting", 2, "v2")]), at(10));
        assert_eq!(alerts.len(), 1);
        assert_eq!(alerts[0].session, "a");
        assert!(
            b.apply(read(&[("a", "waiting", 2, "v2")]), at(20))
                .is_empty()
        );
    }

    #[test]
    fn a_new_prompt_while_waiting_alerts_again_and_working_or_done_never_do() {
        let mut b = AgentBoard::default();
        b.apply(read(&[("a", "waiting", 2, "v2")]), at(0));
        assert_eq!(b.apply(read(&[("a", "waiting", 2, "v3")]), at(10)).len(), 1);
        assert!(
            b.apply(read(&[("a", "working", 3, "v4")]), at(20))
                .is_empty()
        );
        assert!(b.apply(read(&[("a", "done", 4, "v5")]), at(30)).is_empty());
    }

    #[test]
    fn a_session_appearing_already_waiting_alerts() {
        let mut b = AgentBoard::default();
        b.apply(read(&[("a", "working", 1, "v1")]), at(0));
        let alerts = b.apply(
            read(&[("a", "working", 1, "v1"), ("b", "waiting", 2, "v")]),
            at(10),
        );
        assert_eq!(alerts[0].session, "b");
    }

    #[test]
    fn a_reset_makes_the_next_read_a_baseline() {
        let mut b = AgentBoard::default();
        b.apply(read(&[("a", "working", 1, "v1")]), at(0));
        b.reset();
        assert!(
            b.apply(read(&[("a", "waiting", 2, "v2")]), at(10))
                .is_empty()
        );
    }

    #[test]
    fn a_missing_binary_stops_polling_and_clears_badges() {
        let mut b = AgentBoard::default();
        b.apply(read(&[("a", "working", 1, "v1")]), at(0));
        b.apply(StatusRead::Missing, at(10));
        assert!(!b.available());
        assert!(b.get("a").is_none());
        b.reset();
        assert!(b.available());
    }

    #[test]
    fn a_failed_read_keeps_badges_for_thirty_seconds() {
        let mut b = AgentBoard::default();
        b.apply(read(&[("a", "working", 1, "v1")]), at(0));
        b.failed(at(25));
        assert!(b.get("a").is_some());
        b.failed(at(31));
        assert!(b.get("a").is_none());
        assert!(b.available());
    }

    #[test]
    fn parses_a_pending_question_and_refuses_anything_else() {
        let out = r#"{"session":"a","state":"waiting","version":"v7","kind":"question","questions":[{"question":"Which?","header":"Pick","multiSelect":true,"options":[{"label":"x","description":"d"},{"label":"y"}]}]}"#;
        let p = parse_pending(&format!("{out}\n")).unwrap();
        assert_eq!(p.version, "v7");
        assert!(p.questions[0].multi_select);
        assert_eq!(p.questions[0].options[0].description.as_deref(), Some("d"));
        assert_eq!(p.questions[0].options[1].description, None);
        assert!(parse_pending("").is_none());
        assert!(parse_pending("garbage").is_none());
        assert!(
            parse_pending(r#"{"session":"a","state":"waiting","version":"v","kind":"permission","questions":[]}"#)
                .is_none()
        );
        assert!(
            parse_pending(r#"{"session":"a","state":"waiting","version":"","kind":"question","questions":[{"question":"q"}]}"#)
                .is_none()
        );
    }

    #[test]
    fn pending_quotes_the_session_and_refuses_a_bad_name() {
        assert_eq!(
            pending_command("it's").unwrap(),
            "~/.local/bin/tether-notify pending --session 'it'\"'\"'s'"
        );
        assert!(pending_command("-x").is_none());
        assert!(pending_command("a\nb").is_none());
    }

    #[test]
    fn answers_are_base64_arguments_never_shell_text() {
        let mut a = BTreeMap::new();
        a.insert("Which?".to_string(), "x, y".to_string());
        let c = answer_command("s", AgentState::Waiting, "v1", &Answer::Questions(a)).unwrap();
        let b64 = STANDARD.encode(r#"{"Which?":"x, y"}"#);
        assert_eq!(
            c,
            format!(
                "~/.local/bin/tether-notify answer --session 's' --state 'waiting' --version 'v1' --answers '{b64}'"
            )
        );
        let approve = answer_command("s", AgentState::Waiting, "v1", &Answer::Approve).unwrap();
        assert!(approve.ends_with(&format!("--input '{}'", STANDARD.encode("\r"))));
        let deny = answer_command("s", AgentState::Waiting, "v1", &Answer::Deny).unwrap();
        assert!(deny.ends_with(&format!("--input '{}'", STANDARD.encode("\u{1b}"))));
    }

    #[test]
    fn a_reply_is_one_line_and_submitted() {
        let c = answer_command(
            "s",
            AgentState::Waiting,
            "v1",
            &Answer::Reply("  go on\nplease $(x) ".into()),
        )
        .unwrap();
        assert!(c.ends_with(&format!(
            "--input '{}' --submit",
            STANDARD.encode("go on please $(x)")
        )));
        for bad in ["", "  \n ", &"x".repeat(MAX_REPLY + 1)] {
            assert!(
                answer_command("s", AgentState::Waiting, "v1", &Answer::Reply(bad.into()))
                    .is_none()
            );
        }
    }

    #[test]
    fn an_answer_needs_a_valid_session_a_version_and_something_to_say() {
        let approve =
            |s: &str, v: &str| answer_command(s, AgentState::Waiting, v, &Answer::Approve);
        assert!(approve("-s", "v").is_none());
        assert!(approve("a\u{7}b", "v").is_none());
        assert!(approve("s", "").is_none());
        assert!(
            answer_command(
                "s",
                AgentState::Waiting,
                "v",
                &Answer::Questions(BTreeMap::new())
            )
            .is_none()
        );
    }

    #[test]
    fn exit_codes_become_sentences() {
        let e = "the command exited with status 3";
        assert!(answer_failure(e).contains("moved on"));
        assert!(answer_failure("the command exited with status 4").contains("Return"));
        assert_eq!(answer_failure("timed out"), "Couldn't send the answer.");
    }

    #[test]
    fn single_choice_replaces_the_pick_and_typing_replaces_both() {
        let mut d = Draft::new(vec![q("Which?", false, &["a", "b"])]);
        assert!(d.answers().is_none());
        d.toggle(0, 0);
        d.toggle(0, 1);
        assert!(!d.is_selected(0, 0) && d.is_selected(0, 1));
        assert_eq!(d.answers().unwrap()["Which?"], "b");
        d.set_other(0, " mine ");
        assert!(!d.is_selected(0, 1));
        assert_eq!(d.answers().unwrap()["Which?"], "mine");
        d.toggle(0, 0);
        assert_eq!(d.other(0), "");
        assert_eq!(d.answers().unwrap()["Which?"], "a");
    }

    #[test]
    fn multi_select_joins_in_option_order_and_appends_typed_text() {
        let mut d = Draft::new(vec![q("Which?", true, &["a", "b", "c"])]);
        d.toggle(0, 2);
        d.toggle(0, 0);
        assert_eq!(d.answers().unwrap()["Which?"], "a, c");
        d.toggle(0, 0);
        d.set_other(0, "extra");
        assert_eq!(d.answers().unwrap()["Which?"], "c, extra");
        d.toggle(0, 2);
        d.set_other(0, "");
        assert!(d.answers().is_none());
    }

    #[test]
    fn every_question_must_be_answered() {
        let mut d = Draft::new(vec![q("A?", false, &["x"]), q("B?", false, &["y"])]);
        d.toggle(0, 0);
        assert!(d.answers().is_none());
        d.toggle(1, 0);
        assert_eq!(d.answers().unwrap().len(), 2);
        d.toggle(9, 0);
        d.set_other(9, "x");
        d.toggle(0, 9);
    }
}
