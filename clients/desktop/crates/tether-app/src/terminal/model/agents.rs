use super::*;
use tether_core::agents::{
    AgentBoard, AgentState, AgentStatus, Answer, Draft, Held, answer_command, answer_failure,
    badge_label, parse_pending, parse_status,
};
use tether_core::osc::Notification;
use tether_core::throttle::{ToastDecision, wants_toast};

#[derive(Debug, Clone, PartialEq)]
pub struct AgentBadge {
    pub state: AgentState,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum SheetPhase {
    Loading,
    Failed,
    Questions,
    Permission,
}

#[derive(Debug, Clone, PartialEq)]
pub struct OptionView {
    pub label: String,
    pub description: String,
    pub selected: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct QuestionView {
    pub header: String,
    pub text: String,
    pub multi: bool,
    pub options: Vec<OptionView>,
    pub other: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SheetView {
    pub title: String,
    pub body: String,
    pub phase: SheetPhase,
    pub questions: Vec<QuestionView>,
    pub sending: bool,
    pub error: String,
    pub can_send: bool,
}

/// The active session's agent in the header, a reminder when a held prompt was dismissed,
/// and the answer sheet.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct AgentView {
    pub line: String,
    pub state: Option<AgentState>,
    pub banner: Option<String>,
    pub sheet: Option<SheetView>,
}

enum Phase {
    Loading,
    Failed(String),
    Questions(Draft),
    Permission,
}

struct Sheet {
    session: String,
    state: AgentState,
    version: String,
    held: Held,
    message: String,
    phase: Phase,
    sending: bool,
    error: Option<String>,
}

#[derive(Default)]
pub(crate) struct AgentsState {
    board: AgentBoard,
    inflight: bool,
    last_poll: Option<Duration>,
    now_unix: i64,
    /// The prompt (session, version) the user closed: it stays closed until the tab is opened again.
    dismissed: Option<(String, String)>,
    sheet: Option<Sheet>,
}

fn failure_text(e: &ConnectError) -> String {
    format!("{e:?}")
}

fn agent_title(agent: &str) -> String {
    let mut chars = agent.chars();
    match chars.next() {
        Some(c) => c.to_uppercase().chain(chars).collect(),
        None => "Agent".into(),
    }
}

impl TerminalModel {
    pub(crate) fn agents_on_opened(&mut self) {
        self.agents.board.reset();
        self.agents.inflight = false;
        self.agents.last_poll = None;
    }

    pub(crate) fn agents_tick(&mut self, now: Duration, fx: &mut Vec<Effect>) {
        let a = &mut self.agents;
        if self.status != ConnStatus::Connected
            || !a.board.available()
            || a.inflight
            || a.last_poll
                .is_some_and(|at| now.saturating_sub(at) < REFRESH_EVERY)
        {
            return;
        }
        a.last_poll = Some(now);
        a.inflight = true;
        fx.push(Effect::AgentPoll);
    }

    pub(crate) fn on_agent_status(
        &mut self,
        result: Result<String, ConnectError>,
        now_unix: i64,
        now: Duration,
        fx: &mut Vec<Effect>,
    ) {
        self.agents.inflight = false;
        self.agents.now_unix = now_unix;
        match result {
            Err(_) => self.agents.board.failed(now),
            Ok(out) => {
                let alerts = self.agents.board.apply(parse_status(&out), now);
                for status in alerts {
                    self.agent_toast(&status, now, fx);
                }
            }
        }
        self.agents_reconcile(fx);
        fx.push(Effect::Redraw);
    }

    fn agent_toast(&mut self, status: &AgentStatus, now: Duration, fx: &mut Vec<Effect>) {
        let active = self.active_name() == Some(status.session.as_str());
        if !wants_toast(self.focused, active) {
            return;
        }
        let body = if status.message.is_empty() {
            "Needs you".to_string()
        } else {
            status.message.clone()
        };
        let n = Notification {
            title: Some(agent_title(&status.agent)),
            body,
        };
        if let ToastDecision::Show(n) = self.toasts.offer(&status.session, n, now) {
            let body = match n.title {
                Some(t) => format!("{t}\n{}", n.body),
                None => n.body,
            };
            fx.push(Effect::Ui(UiEffect::Toast {
                machine: self.machine.id.to_string(),
                session: status.session.clone(),
                title: format!("{} · {}", self.machine.name, status.session),
                body,
            }));
            if !self.focused {
                fx.push(Effect::Ui(UiEffect::FlashTaskbar));
            }
        }
    }

    /// Keeps the sheet true to the latest read, and opens it for the active tab's held prompt.
    fn agents_reconcile(&mut self, fx: &mut Vec<Effect>) {
        enum Verdict {
            Keep,
            Close,
            Replace(AgentStatus),
        }
        let verdict =
            self.agents
                .sheet
                .as_ref()
                .map(|sheet| match self.agents.board.get(&sheet.session) {
                    Some(s) if s.held == Some(sheet.held) && s.version == sheet.version => {
                        Verdict::Keep
                    }
                    Some(s) if s.held.is_some() => Verdict::Replace(s.clone()),
                    _ => Verdict::Close,
                });
        match verdict {
            Some(Verdict::Replace(newer)) => {
                self.agents.sheet = None;
                self.open_sheet(&newer, fx);
                return;
            }
            Some(Verdict::Close) => self.agents.sheet = None,
            Some(Verdict::Keep) | None => {}
        }
        self.agents_surface(fx);
    }

    fn agents_surface(&mut self, fx: &mut Vec<Effect>) {
        let a = &self.agents;
        if a.sheet.is_some() {
            return;
        }
        let Some(status) = self
            .active_name()
            .and_then(|n| a.board.get(n))
            .filter(|s| s.held.is_some())
            .cloned()
        else {
            return;
        };
        let closed = a
            .dismissed
            .as_ref()
            .is_some_and(|(s, v)| *s == status.session && *v == status.version);
        if !closed {
            self.open_sheet(&status, fx);
        }
    }

    /// Opening a tab surfaces its held prompt again, even one dismissed earlier.
    pub(crate) fn agents_on_activate(&mut self, name: &str, fx: &mut Vec<Effect>) {
        let a = &mut self.agents;
        if a.dismissed.as_ref().is_some_and(|(s, _)| s == name) {
            a.dismissed = None;
        }
        if a.sheet.as_ref().is_some_and(|s| s.session != name) {
            a.sheet = None;
        }
        self.agents_surface(fx);
    }

    fn open_sheet(&mut self, status: &AgentStatus, fx: &mut Vec<Effect>) {
        let Some(held) = status.held else {
            return;
        };
        let phase = match held {
            Held::Question => {
                fx.push(Effect::AgentPending {
                    session: status.session.clone(),
                });
                Phase::Loading
            }
            Held::Permission => Phase::Permission,
        };
        self.agents.sheet = Some(Sheet {
            session: status.session.clone(),
            state: status.state,
            version: status.version.clone(),
            held,
            message: status.message.clone(),
            phase,
            sending: false,
            error: None,
        });
    }

    pub(crate) fn on_agent_pending(
        &mut self,
        session: &str,
        result: Result<String, ConnectError>,
        fx: &mut Vec<Effect>,
    ) {
        let Some(sheet) = self.agents.sheet.as_mut() else {
            return;
        };
        if sheet.session != session || !matches!(sheet.phase, Phase::Loading) {
            return;
        }
        sheet.phase = match result {
            Err(_) => Phase::Failed("Couldn't load the question.".into()),
            Ok(out) => match parse_pending(&out) {
                Some(p) => {
                    sheet.version = p.version;
                    Phase::Questions(Draft::new(p.questions))
                }
                None => Phase::Failed("This question was already answered.".into()),
            },
        };
        fx.push(Effect::Redraw);
    }

    pub(crate) fn on_agent_open(&mut self, fx: &mut Vec<Effect>) {
        let Some(name) = self.active_name().map(str::to_string) else {
            return;
        };
        if self
            .agents
            .sheet
            .as_ref()
            .is_some_and(|s| matches!(s.phase, Phase::Failed(_)) && s.session == name)
        {
            self.agents.sheet = None;
        }
        self.agents.dismissed = None;
        self.agents_surface(fx);
        fx.push(Effect::Redraw);
    }

    pub(crate) fn on_agent_dismiss(&mut self, fx: &mut Vec<Effect>) {
        if let Some(sheet) = self.agents.sheet.take() {
            self.agents.dismissed = Some((sheet.session, sheet.version));
        }
        fx.push(Effect::Redraw);
    }

    pub(crate) fn on_agent_toggle(&mut self, question: usize, option: usize) {
        if let Some(Sheet {
            phase: Phase::Questions(draft),
            sending: false,
            ..
        }) = self.agents.sheet.as_mut()
        {
            draft.toggle(question, option);
        }
    }

    pub(crate) fn on_agent_other(&mut self, question: usize, text: &str) {
        if let Some(Sheet {
            phase: Phase::Questions(draft),
            sending: false,
            ..
        }) = self.agents.sheet.as_mut()
        {
            draft.set_other(question, text);
        }
    }

    pub(crate) fn on_agent_answer(&mut self, answer: Option<Answer>, fx: &mut Vec<Effect>) {
        let Some(sheet) = self.agents.sheet.as_mut() else {
            return;
        };
        if sheet.sending || self.status != ConnStatus::Connected {
            return;
        }
        let answer = match (&sheet.phase, answer) {
            (Phase::Questions(draft), None) => draft.answers().map(Answer::Questions),
            (Phase::Permission, Some(a)) if sheet.held == Held::Permission => Some(a),
            _ => None,
        };
        let command =
            answer.and_then(|a| answer_command(&sheet.session, sheet.state, &sheet.version, &a));
        let Some(command) = command else {
            return;
        };
        sheet.sending = true;
        sheet.error = None;
        fx.push(Effect::AgentAnswer { command });
        fx.push(Effect::Redraw);
    }

    pub(crate) fn on_agent_answered(
        &mut self,
        result: Result<String, ConnectError>,
        fx: &mut Vec<Effect>,
    ) {
        let Some(sheet) = self.agents.sheet.as_mut() else {
            return;
        };
        sheet.sending = false;
        match result {
            Ok(_) => {
                let done = self.agents.sheet.take();
                if let Some(s) = done {
                    self.agents.dismissed = Some((s.session, s.version));
                }
            }
            Err(e) => sheet.error = Some(answer_failure(&failure_text(&e))),
        }
        // Read the new state now, not at the next tick.
        self.agents.last_poll = None;
        fx.push(Effect::Redraw);
    }

    pub(crate) fn agent_badge(&self, session: &str) -> Option<AgentBadge> {
        let s = self.agents.board.get(session)?;
        Some(AgentBadge {
            state: s.state,
            label: badge_label(s, self.agents.now_unix),
        })
    }

    pub(crate) fn agent_view(&self) -> AgentView {
        let a = &self.agents;
        let status = self.active_name().and_then(|n| a.board.get(n));
        let line = status.map_or(String::new(), |s| {
            let word = badge_label(s, a.now_unix);
            match (s.state, s.message.is_empty()) {
                (AgentState::Working, _) | (_, true) => word,
                _ => format!("{word} · {}", s.message),
            }
        });
        let banner = status
            .filter(|s| s.held.is_some() && a.sheet.is_none())
            .map(|s| match s.held {
                Some(Held::Question) => "The agent is asking a question".to_string(),
                _ => "The agent needs permission".to_string(),
            });
        AgentView {
            line,
            state: status.map(|s| s.state),
            banner,
            sheet: a.sheet.as_ref().map(sheet_view),
        }
    }
}

fn sheet_view(sheet: &Sheet) -> SheetView {
    let (title, phase) = match &sheet.phase {
        Phase::Loading => ("Question", SheetPhase::Loading),
        Phase::Failed(_) => ("Question", SheetPhase::Failed),
        Phase::Questions(_) => ("Question", SheetPhase::Questions),
        Phase::Permission => ("Permission", SheetPhase::Permission),
    };
    let questions = match &sheet.phase {
        Phase::Questions(d) => d
            .questions
            .iter()
            .enumerate()
            .map(|(i, q)| QuestionView {
                header: q.header.clone(),
                text: q.question.clone(),
                multi: q.multi_select,
                options: q
                    .options
                    .iter()
                    .enumerate()
                    .map(|(o, opt)| OptionView {
                        label: opt.label.clone(),
                        description: opt.description.clone().unwrap_or_default(),
                        selected: d.is_selected(i, o),
                    })
                    .collect(),
                other: d.other(i).to_string(),
            })
            .collect(),
        _ => Vec::new(),
    };
    let error = match (&sheet.error, &sheet.phase) {
        (Some(e), _) => e.clone(),
        (None, Phase::Failed(m)) => m.clone(),
        _ => String::new(),
    };
    SheetView {
        title: format!("{title} · {}", sheet.session),
        body: sheet.message.clone(),
        phase,
        questions,
        sending: sheet.sending,
        error,
        can_send: matches!(&sheet.phase, Phase::Questions(d) if d.answers().is_some())
            && !sheet.sending,
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{live, t};
    use super::*;
    use crate::terminal::testkit::session;

    fn row(session: &str, state: &str, since: i64, version: &str, held: &str) -> String {
        let pending = if held.is_empty() {
            String::new()
        } else {
            format!(r#","pending":{{"kind":"{held}"}}"#)
        };
        format!(
            r#"{{"session":"{session}","agent":"claude","state":"{state}","since":{since},"version":"{version}","message":"msg {session}"{pending}}}"#
        )
    }

    fn status(rows: &[String]) -> Msg {
        Msg::AgentStatusOut {
            result: Ok(format!("[{}]", rows.join(","))),
            now_unix: 1_000,
        }
    }

    fn model() -> TerminalModel {
        let mut m = live(vec![session("a", 1), session("b", 2)]);
        m.handle(Msg::SelectTab("a".into()), t(3));
        m
    }

    fn toasts(fx: &[Effect]) -> Vec<String> {
        fx.iter()
            .filter_map(|e| match e {
                Effect::Ui(UiEffect::Toast { session, .. }) => Some(session.clone()),
                _ => None,
            })
            .collect()
    }

    fn polls(fx: &[Effect]) -> usize {
        fx.iter().filter(|e| **e == Effect::AgentPoll).count()
    }

    const QUESTION: &str = r#"{"session":"a","state":"waiting","version":"v2","kind":"question","questions":[{"question":"Which?","header":"H","multiSelect":false,"options":[{"label":"x"},{"label":"y"}]}]}"#;

    #[test]
    fn polls_every_ten_seconds_regardless_of_focus_and_never_overlaps() {
        let mut m = model();
        assert_eq!(polls(&m.handle(Msg::Tick, t(100))), 1);
        assert_eq!(polls(&m.handle(Msg::Tick, t(200))), 0);
        m.handle(status(&[]), t(300));
        m.handle(Msg::Focus(false), t(310));
        assert_eq!(polls(&m.handle(Msg::Tick, t(9_000))), 0);
        assert_eq!(polls(&m.handle(Msg::Tick, t(10_200))), 1);
    }

    #[test]
    fn nothing_polls_while_disconnected() {
        let mut m = model();
        m.handle(Msg::Dropped, t(10));
        assert_eq!(polls(&m.handle(Msg::Tick, t(60_000))), 0);
    }

    #[test]
    fn tabs_get_badges_and_the_header_the_active_message() {
        let mut m = model();
        m.handle(Msg::Tick, t(100));
        m.handle(
            status(&[
                row("a", "working", 990, "v1", ""),
                row("b", "waiting", 990, "v2", ""),
            ]),
            t(200),
        );
        let v = m.view();
        let badge = |n: &str| {
            v.tabs
                .iter()
                .find(|t| t.name == n)
                .unwrap()
                .agent
                .clone()
                .unwrap()
        };
        assert_eq!(badge("a").label, "working");
        assert_eq!(badge("b").label, "needs you");
        assert_eq!(v.agent.line, "working");
        m.handle(Msg::SelectTab("b".into()), t(300));
        let v = m.view();
        assert_eq!(v.agent.line, "needs you · msg b");
        assert_eq!(v.agent.state, Some(AgentState::Waiting));
    }

    #[test]
    fn a_done_badge_carries_its_age() {
        let mut m = model();
        m.handle(Msg::Tick, t(100));
        m.handle(status(&[row("b", "done", 700, "v", "")]), t(200));
        let b = m.view().tabs[1].agent.clone().unwrap();
        assert_eq!(b.label, "done 5m");
    }

    #[test]
    fn a_missing_binary_shows_nothing_and_stops_polling() {
        let mut m = model();
        m.handle(Msg::Tick, t(100));
        m.handle(
            Msg::AgentStatusOut {
                result: Ok("__tether_notify_missing\n".into()),
                now_unix: 1,
            },
            t(200),
        );
        let v = m.view();
        assert!(v.tabs.iter().all(|t| t.agent.is_none()));
        assert_eq!(v.agent, AgentView::default());
        assert_eq!(polls(&m.handle(Msg::Tick, t(60_000))), 0);
    }

    #[test]
    fn a_failed_read_leaves_the_terminal_alone() {
        let mut m = model();
        m.handle(Msg::Tick, t(100));
        let fx = m.handle(
            Msg::AgentStatusOut {
                result: Err(ConnectError::Timeout),
                now_unix: 1,
            },
            t(200),
        );
        assert!(toasts(&fx).is_empty());
        assert_eq!(m.view().header.word, "connected");
        assert_eq!(polls(&m.handle(Msg::Tick, t(10_300))), 1);
    }

    #[test]
    fn garbage_output_is_the_same_as_no_agent() {
        let mut m = model();
        m.handle(Msg::Tick, t(100));
        m.handle(
            Msg::AgentStatusOut {
                result: Ok("usage: tether-notify <command>".into()),
                now_unix: 1,
            },
            t(200),
        );
        assert!(m.view().tabs.iter().all(|t| t.agent.is_none()));
    }

    #[test]
    fn a_background_tab_entering_waiting_toasts_once_and_the_first_read_is_silent() {
        let mut m = model();
        m.handle(Msg::Tick, t(100));
        let first = m.handle(status(&[row("b", "waiting", 1, "v1", "")]), t(200));
        assert!(toasts(&first).is_empty());
        m.handle(Msg::Tick, t(10_300));
        m.handle(status(&[row("b", "working", 2, "v2", "")]), t(10_400));
        m.handle(Msg::Tick, t(20_500));
        let fx = m.handle(status(&[row("b", "waiting", 3, "v3", "")]), t(20_600));
        assert_eq!(toasts(&fx), ["b"]);
        assert!(!fx.contains(&Effect::Ui(UiEffect::FlashTaskbar)));
        m.handle(Msg::Tick, t(30_700));
        let again = m.handle(status(&[row("b", "waiting", 3, "v3", "")]), t(30_800));
        assert!(toasts(&again).is_empty());
    }

    #[test]
    fn the_focused_active_tab_gets_no_toast_but_an_unfocused_window_does_and_flashes() {
        let mut m = model();
        m.handle(Msg::Tick, t(100));
        m.handle(status(&[row("a", "working", 1, "v1", "")]), t(200));
        m.handle(Msg::Tick, t(10_300));
        let quiet = m.handle(status(&[row("a", "waiting", 2, "v2", "")]), t(10_400));
        assert!(toasts(&quiet).is_empty());
        m.handle(Msg::Focus(false), t(10_500));
        m.handle(Msg::Tick, t(20_600));
        m.handle(status(&[row("a", "working", 3, "v3", "")]), t(20_700));
        m.handle(Msg::Tick, t(30_800));
        let loud = m.handle(status(&[row("a", "waiting", 4, "v4", "")]), t(30_900));
        assert_eq!(toasts(&loud), ["a"]);
        assert!(loud.contains(&Effect::Ui(UiEffect::FlashTaskbar)));
    }

    #[test]
    fn a_toast_shares_the_per_session_throttle_with_osc_notifications() {
        let mut m = model();
        m.handle(Msg::Tick, t(100));
        m.handle(status(&[row("b", "working", 1, "v1", "")]), t(200));
        m.handle(
            Msg::PtyData {
                name: "b".into(),
                bytes: b"\x1b]9;hi\x07".to_vec(),
            },
            t(10_000),
        );
        m.handle(Msg::Tick, t(10_300));
        let fx = m.handle(status(&[row("b", "waiting", 2, "v2", "")]), t(10_400));
        assert!(toasts(&fx).is_empty());
        assert_eq!(toasts(&m.handle(Msg::Tick, t(15_100))), ["b"]);
    }

    #[test]
    fn a_held_question_on_the_active_tab_opens_the_sheet_and_loads_it() {
        let mut m = model();
        m.handle(Msg::Tick, t(100));
        let fx = m.handle(status(&[row("a", "waiting", 1, "v2", "question")]), t(200));
        assert!(fx.contains(&Effect::AgentPending {
            session: "a".into()
        }));
        assert_eq!(m.view().agent.sheet.unwrap().phase, SheetPhase::Loading);
        m.handle(
            Msg::AgentPendingOut {
                session: "a".into(),
                result: Ok(QUESTION.into()),
            },
            t(300),
        );
        let sheet = m.view().agent.sheet.unwrap();
        assert_eq!(sheet.phase, SheetPhase::Questions);
        assert_eq!(sheet.questions[0].options.len(), 2);
        assert!(!sheet.can_send);
    }

    #[test]
    fn picking_an_option_sends_the_answer_naming_the_version_then_closes() {
        let mut m = model();
        m.handle(Msg::Tick, t(100));
        m.handle(status(&[row("a", "waiting", 1, "v2", "question")]), t(200));
        m.handle(
            Msg::AgentPendingOut {
                session: "a".into(),
                result: Ok(QUESTION.into()),
            },
            t(300),
        );
        m.handle(
            Msg::AgentToggle {
                question: 0,
                option: 1,
            },
            t(310),
        );
        assert!(m.view().agent.sheet.unwrap().can_send);
        let fx = m.handle(Msg::AgentSubmit, t(320));
        let Some(Effect::AgentAnswer { command }) = fx
            .iter()
            .find(|e| matches!(e, Effect::AgentAnswer { .. }))
            .cloned()
        else {
            panic!("{fx:?}");
        };
        assert!(
            command.contains("answer --session 'a' --state 'waiting' --version 'v2' --answers")
        );
        assert!(m.view().agent.sheet.unwrap().sending);
        assert!(
            !m.handle(Msg::AgentSubmit, t(321))
                .iter()
                .any(|e| matches!(e, Effect::AgentAnswer { .. }))
        );
        m.handle(
            Msg::AgentAnswered {
                result: Ok(String::new()),
            },
            t(400),
        );
        assert!(m.view().agent.sheet.is_none());
        // The stale status that still says "held" must not reopen it.
        m.handle(Msg::Tick, t(500));
        m.handle(status(&[row("a", "waiting", 1, "v2", "question")]), t(600));
        assert!(m.view().agent.sheet.is_none());
    }

    #[test]
    fn a_stale_answer_keeps_the_sheet_with_a_sentence() {
        let mut m = model();
        m.handle(Msg::Tick, t(100));
        m.handle(
            status(&[row("a", "waiting", 1, "v2", "permission")]),
            t(200),
        );
        m.handle(Msg::AgentApprove, t(210));
        m.handle(
            Msg::AgentAnswered {
                result: Err(ConnectError::Transport(
                    "the command exited with status 3".into(),
                )),
            },
            t(300),
        );
        let sheet = m.view().agent.sheet.unwrap();
        assert!(sheet.error.contains("moved on"));
        assert!(!sheet.sending);
    }

    #[test]
    fn a_permission_sheet_approves_denies_and_replies() {
        let mut m = model();
        m.handle(Msg::Tick, t(100));
        let fx = m.handle(
            status(&[row("a", "waiting", 1, "v2", "permission")]),
            t(200),
        );
        assert!(!fx.iter().any(|e| matches!(e, Effect::AgentPending { .. })));
        assert_eq!(m.view().agent.sheet.unwrap().phase, SheetPhase::Permission);
        let cmd = |fx: Vec<Effect>| {
            fx.into_iter().find_map(|e| match e {
                Effect::AgentAnswer { command } => Some(command),
                _ => None,
            })
        };
        let deny = cmd(m.handle(Msg::AgentDeny, t(210))).unwrap();
        assert!(deny.contains("--input 'Gw=='"));
        m.handle(
            Msg::AgentAnswered {
                result: Err(ConnectError::Timeout),
            },
            t(220),
        );
        let reply = cmd(m.handle(Msg::AgentReply("go ahead".into()), t(230))).unwrap();
        assert!(reply.ends_with("--submit"));
        assert!(cmd(m.handle(Msg::AgentReply("   ".into()), t(240))).is_none());
    }

    #[test]
    fn a_question_ignores_permission_buttons() {
        let mut m = model();
        m.handle(Msg::Tick, t(100));
        m.handle(status(&[row("a", "waiting", 1, "v2", "question")]), t(200));
        m.handle(
            Msg::AgentPendingOut {
                session: "a".into(),
                result: Ok(QUESTION.into()),
            },
            t(300),
        );
        assert!(
            !m.handle(Msg::AgentApprove, t(310))
                .iter()
                .any(|e| matches!(e, Effect::AgentAnswer { .. }))
        );
    }

    #[test]
    fn dismissing_leaves_a_banner_and_opening_the_tab_again_surfaces_it() {
        let mut m = model();
        m.handle(Msg::Tick, t(100));
        m.handle(
            status(&[row("a", "waiting", 1, "v2", "permission")]),
            t(200),
        );
        m.handle(Msg::AgentDismiss, t(210));
        let v = m.view();
        assert!(v.agent.sheet.is_none());
        assert!(v.agent.banner.is_some());
        m.handle(Msg::Tick, t(10_300));
        m.handle(
            status(&[row("a", "waiting", 1, "v2", "permission")]),
            t(10_400),
        );
        assert!(m.view().agent.sheet.is_none());
        m.handle(Msg::SelectTab("b".into()), t(10_500));
        m.handle(Msg::SelectTab("a".into()), t(10_600));
        assert!(m.view().agent.sheet.is_some());
        m.handle(Msg::AgentDismiss, t(10_700));
        m.handle(Msg::AgentOpen, t(10_800));
        assert!(m.view().agent.sheet.is_some());
    }

    #[test]
    fn a_held_prompt_on_another_tab_surfaces_when_that_tab_opens() {
        let mut m = model();
        m.handle(Msg::Tick, t(100));
        m.handle(
            status(&[row("b", "waiting", 1, "v2", "permission")]),
            t(200),
        );
        assert!(m.view().agent.sheet.is_none());
        assert!(m.view().agent.banner.is_none());
        m.handle(Msg::SelectTab("b".into()), t(300));
        assert_eq!(m.view().agent.sheet.unwrap().phase, SheetPhase::Permission);
        m.handle(Msg::SelectTab("a".into()), t(400));
        assert!(m.view().agent.sheet.is_none());
    }

    #[test]
    fn a_prompt_answered_elsewhere_closes_the_sheet() {
        let mut m = model();
        m.handle(Msg::Tick, t(100));
        m.handle(
            status(&[row("a", "waiting", 1, "v2", "permission")]),
            t(200),
        );
        m.handle(Msg::Tick, t(10_300));
        m.handle(status(&[row("a", "working", 2, "v3", "")]), t(10_400));
        assert!(m.view().agent.sheet.is_none());
        assert!(m.view().agent.banner.is_none());
    }

    #[test]
    fn a_newer_prompt_replaces_the_open_sheet() {
        let mut m = model();
        m.handle(Msg::Tick, t(100));
        m.handle(
            status(&[row("a", "waiting", 1, "v2", "permission")]),
            t(200),
        );
        m.handle(Msg::Tick, t(10_300));
        let fx = m.handle(
            status(&[row("a", "waiting", 2, "v3", "question")]),
            t(10_400),
        );
        assert!(fx.contains(&Effect::AgentPending {
            session: "a".into()
        }));
    }

    #[test]
    fn a_question_gone_before_it_loads_says_so() {
        let mut m = model();
        m.handle(Msg::Tick, t(100));
        m.handle(status(&[row("a", "waiting", 1, "v2", "question")]), t(200));
        m.handle(
            Msg::AgentPendingOut {
                session: "a".into(),
                result: Ok(String::new()),
            },
            t(300),
        );
        let sheet = m.view().agent.sheet.unwrap();
        assert_eq!(sheet.phase, SheetPhase::Failed);
        assert!(sheet.error.contains("already answered"));
    }

    #[test]
    fn a_reconnect_makes_the_next_read_a_baseline_again() {
        let mut m = model();
        m.handle(Msg::Tick, t(100));
        m.handle(status(&[row("b", "working", 1, "v1", "")]), t(200));
        m.handle(Msg::Dropped, t(300));
        m.handle(Msg::Opened, t(400));
        m.handle(Msg::Tick, t(500));
        let fx = m.handle(status(&[row("b", "waiting", 2, "v2", "")]), t(600));
        assert!(toasts(&fx).is_empty());
    }
}
