//! Background `Workflow` runs, as `tether acp workflows --session <id> --json` reports them. ACP
//! says nothing after the launch; the host reads a run's progress and end from Claude Code's own
//! session files. Port of the iOS client's `ChatWorkflows`: parsing, the tracker, the polling
//! decision and the strip and sheet text, all without I/O. Times are Unix seconds.

use std::collections::HashMap;
use std::time::Duration;

use serde_json::{Map, Value};

use super::message::ToolStatus;
use super::reducer::ToolCall;
use crate::zmx::shell_quote;

/// The adapter's name for the tool, from `_meta.claudeCode.toolName`.
pub const TOOL_NAME: &str = "Workflow";
pub const POLL_INTERVAL: Duration = Duration::from_secs(5);
/// Answers unchanged this long slow the polling down; any change brings it back.
pub const SLOW_AFTER: Duration = Duration::from_secs(120);
pub const SLOW_FACTOR: u32 = 6;
/// Answers that may lack a just-launched call before the host is taken not to know it.
pub const MAX_MISSES: u32 = 6;
/// How long a run with no end notice may be silent before the app says so.
pub const QUIET_AFTER: i64 = 600;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunStatus {
    Running,
    Completed,
    /// Anything else Claude Code reports (failed, killed, ...), as written.
    Ended(String),
}

/// `Stopped`: the run ended and this agent never reported a result.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentState {
    Running,
    Done,
    Stopped,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Agent {
    pub label: String,
    pub state: AgentState,
    pub started_at: Option<i64>,
    pub ended_at: Option<i64>,
    pub activity: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Phase {
    pub title: String,
    pub agents: Vec<Agent>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Run {
    pub tool_call_id: String,
    pub run_id: String,
    pub title: String,
    pub description: Option<String>,
    pub status: RunStatus,
    pub started_at: Option<i64>,
    pub ended_at: Option<i64>,
    /// The newest write to the run's files on the host; `None` from a host that does not say.
    pub last_activity_at: Option<i64>,
    pub summary: Option<String>,
    pub phases: Vec<Phase>,
}

impl Run {
    pub fn is_running(&self) -> bool {
        self.status == RunStatus::Running
    }

    pub fn agents(&self) -> impl Iterator<Item = &Agent> {
        self.phases.iter().flat_map(|p| p.agents.iter())
    }

    pub fn done_count(&self) -> usize {
        self.agents()
            .filter(|a| a.state == AgentState::Done)
            .count()
    }

    pub fn total_count(&self) -> usize {
        self.agents().count()
    }

    pub fn running_count(&self) -> usize {
        self.agents()
            .filter(|a| a.state == AgentState::Running)
            .count()
    }

    /// The phase to name on the strip: the first with an agent still running, else the last with
    /// agents, else the first listed.
    pub fn current_phase(&self) -> Option<&Phase> {
        self.phases
            .iter()
            .find(|p| p.agents.iter().any(|a| a.state == AgentState::Running))
            .or_else(|| self.phases.iter().rev().find(|p| !p.agents.is_empty()))
            .or(self.phases.first())
    }
}

/// "no activity for 12m" for a running run whose files have not been written for a while. The
/// run is still not called done: only the host's end notice says that.
pub fn quiet(run: &Run, now: i64) -> Option<String> {
    if !run.is_running() {
        return None;
    }
    let silent = now - run.last_activity_at?;
    (silent >= QUIET_AFTER).then(|| format!("no activity for {}m", silent / 60))
}

/// "<title> · <phase> · 1/2 agents"; a part with nothing to say is left out. A quiet run names
/// how long it has been quiet instead of its phase.
pub fn strip_text(run: &Run, now: i64) -> String {
    let mut parts = vec![run.title.clone()];
    if let Some(quiet) = quiet(run, now) {
        parts.push(quiet);
    } else if let Some(phase) = run.current_phase().map(|p| p.title.as_str())
        && !phase.is_empty()
    {
        parts.push(phase.to_string());
    }
    if run.total_count() > 0 {
        parts.push(format!("{}/{} agents", run.done_count(), run.total_count()));
    }
    parts.join(" \u{00B7} ")
}

/// "45s", "3m 05s", "1h 02m".
pub fn elapsed(seconds: i64) -> String {
    let total = seconds.max(0);
    if total < 60 {
        format!("{total}s")
    } else if total < 3600 {
        format!("{}m {:02}s", total / 60, total % 60)
    } else {
        format!("{}h {:02}m", total / 3600, total % 3600 / 60)
    }
}

/// How long an agent has run, or ran; `None` when the host gave no start, and for a stopped
/// agent with no end.
pub fn agent_elapsed(agent: &Agent, now: i64) -> Option<String> {
    let start = agent.started_at?;
    if agent.state == AgentState::Running {
        return Some(elapsed(now - start));
    }
    agent.ended_at.map(|end| elapsed(end - start))
}

pub fn run_elapsed(run: &Run, now: i64) -> Option<String> {
    let start = run.started_at?;
    let end = if run.is_running() {
        now
    } else {
        run.ended_at.unwrap_or(now)
    };
    Some(elapsed(end - start))
}

/// "completed" reads as done; other words are shown as the host wrote them.
pub fn status_word(run: &Run) -> String {
    match &run.status {
        RunStatus::Running => "running".into(),
        RunStatus::Completed => "done".into(),
        RunStatus::Ended(word) => word.clone(),
    }
}

pub fn agent_state_word(state: AgentState) -> &'static str {
    match state {
        AgentState::Running => "running",
        AgentState::Done => "done",
        AgentState::Stopped => "stopped",
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Listing {
    pub runs: Vec<Run>,
    /// The host answered with its unknown-command or usage text: it has no such command.
    pub unsupported: bool,
    /// Output that is neither runs nor that text (a dropped connection, a shell error): one failed poll.
    pub failed: bool,
}

pub fn is_unknown_command(output: &str) -> bool {
    let lower = output.to_lowercase();
    lower.contains("unknown acp command")
        || lower.contains("unknown command")
        || lower.contains("usage:")
}

/// `2>&1` folds the host's error text in, which is how an old `tether` reads as unsupported.
pub fn command(session_id: &str) -> String {
    format!(
        "{} workflows --session {} --json 2>&1",
        super::host::TETHER,
        shell_quote(session_id)
    )
}

pub fn parse(output: &str) -> Listing {
    let mut runs = Vec::new();
    let mut stray = false;
    for raw in output.split(['\n', '\r']) {
        let line = raw.trim_matches([' ', '\t']);
        if line.is_empty() {
            continue;
        }
        match parse_run(line) {
            Some(run) => runs.push(run),
            None => stray = true,
        }
    }
    let unrecognised = runs.is_empty() && stray;
    let unknown = is_unknown_command(output);
    Listing {
        runs,
        unsupported: unrecognised && unknown,
        failed: unrecognised && !unknown,
    }
}

fn time(object: &Map<String, Value>, key: &str) -> Option<i64> {
    let seconds = object.get(key)?.as_f64()?;
    (seconds > 0.0).then_some(seconds as i64)
}

fn text(object: &Map<String, Value>, key: &str) -> Option<String> {
    let value = object.get(key)?.as_str()?.trim();
    (!value.is_empty()).then(|| value.to_string())
}

fn parse_run(line: &str) -> Option<Run> {
    let Value::Object(object) = serde_json::from_str::<Value>(line).ok()? else {
        return None;
    };
    let non_empty = |key: &str| {
        object
            .get(key)
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
    };
    let call = non_empty("toolCallId")?;
    let run_id = non_empty("runId")?;
    let status = non_empty("status")?;
    let running = status == "running";
    let phases = object
        .get("phases")
        .and_then(Value::as_array)
        .map(|phases| {
            phases
                .iter()
                .filter_map(Value::as_object)
                .map(|phase| Phase {
                    title: phase
                        .get("title")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    agents: phase
                        .get("agents")
                        .and_then(Value::as_array)
                        .map(|agents| {
                            agents
                                .iter()
                                .filter_map(Value::as_object)
                                .map(|agent| parse_agent(agent, running))
                                .collect()
                        })
                        .unwrap_or_default(),
                })
                .collect()
        })
        .unwrap_or_default();
    Some(Run {
        tool_call_id: call.to_string(),
        run_id: run_id.to_string(),
        title: text(&object, "title").unwrap_or_else(|| "Workflow".into()),
        description: text(&object, "description"),
        status: match status {
            "running" => RunStatus::Running,
            "completed" => RunStatus::Completed,
            other => RunStatus::Ended(other.to_string()),
        },
        started_at: time(&object, "startedAt"),
        ended_at: time(&object, "endedAt"),
        last_activity_at: time(&object, "lastActivityAt"),
        summary: text(&object, "summary"),
        phases,
    })
}

/// An agent the host calls anything but done or stopped is running while the run is, and
/// stopped once it is not.
fn parse_agent(agent: &Map<String, Value>, run_running: bool) -> Agent {
    Agent {
        label: agent
            .get("label")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        state: match agent.get("state").and_then(Value::as_str) {
            Some("done") => AgentState::Done,
            Some("stopped") => AgentState::Stopped,
            _ if run_running => AgentState::Running,
            _ => AgentState::Stopped,
        },
        started_at: time(agent, "startedAt"),
        ended_at: time(agent, "endedAt"),
        activity: agent
            .get("activity")
            .and_then(Value::as_str)
            .filter(|a| !a.is_empty())
            .map(String::from),
    }
}

/// How a Workflow tool row reads once the host has spoken.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RowStatus {
    Running,
    Done,
    Failed,
}

/// What the chat knows of its Workflow runs, and whether it is worth asking the host again.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tracker {
    runs: Vec<Run>,
    /// False once the host answered like one without the command: nothing is asked again.
    supported: bool,
    misses: HashMap<String, u32>,
    changed_at: Option<Duration>,
}

impl Default for Tracker {
    fn default() -> Self {
        Self {
            runs: Vec::new(),
            supported: true,
            misses: HashMap::new(),
            changed_at: None,
        }
    }
}

impl Tracker {
    pub fn runs(&self) -> &[Run] {
        &self.runs
    }

    pub fn supported(&self) -> bool {
        self.supported
    }

    pub fn running(&self) -> Vec<&Run> {
        self.runs.iter().filter(|r| r.is_running()).collect()
    }

    pub fn run_for_call(&self, id: &str) -> Option<&Run> {
        self.runs.iter().find(|r| r.tool_call_id == id)
    }

    /// Replaces what the tracker knows, as a poll's answer would. Debug builds' sample chats.
    #[cfg(debug_assertions)]
    pub fn set_runs(&mut self, runs: Vec<Run>) {
        self.runs = runs;
    }

    /// The wait before the next ask: `base`, or six times that once answers have not changed for two minutes.
    pub fn interval(&self, base: Duration, now: Duration) -> Duration {
        match self.changed_at {
            Some(at) if now.saturating_sub(at) >= SLOW_AFTER => base * SLOW_FACTOR,
            _ => base,
        }
    }

    /// `output` is `None` when the host could not be asked; nothing changes then, and neither
    /// does it for output that is not a listing, except that the host's unknown-command text ends
    /// the asking.
    pub fn apply(&mut self, output: Option<&str>, calls: &[&ToolCall], now: Duration) {
        let Some(output) = output else { return };
        let listing = parse(output);
        if listing.unsupported {
            self.supported = false;
            self.runs.clear();
            return;
        }
        if listing.failed {
            return;
        }
        if listing.runs != self.runs || self.changed_at.is_none() {
            self.changed_at = Some(now);
        }
        self.runs = listing.runs;
        for call in calls {
            let missed = self.run_for_call(&call.id).is_none();
            let count = self.misses.get(&call.id).copied().unwrap_or(0);
            self.misses
                .insert(call.id.clone(), if missed { count + 1 } else { 0 });
        }
    }

    /// True while a Workflow call is not known to be over: its run is running, or the host has not
    /// listed it yet (a launch can show here before the host's file does).
    pub fn needs_polling(&self, calls: &[&ToolCall]) -> bool {
        if !self.supported {
            return false;
        }
        calls.iter().any(|call| {
            if !call.is_workflow || call.status == ToolStatus::Failed {
                return false;
            }
            match self.run_for_call(&call.id) {
                Some(run) => run.is_running(),
                None => self.misses.get(&call.id).copied().unwrap_or(0) < MAX_MISSES,
            }
        })
    }

    pub fn row_status(&self, id: &str) -> Option<RowStatus> {
        if !self.supported {
            return None;
        }
        Some(match self.run_for_call(id)?.status {
            RunStatus::Running => RowStatus::Running,
            RunStatus::Completed => RowStatus::Done,
            RunStatus::Ended(_) => RowStatus::Failed,
        })
    }

    /// The status a Workflow row shows: running until the host reports its end, then done or
    /// failed. A call the host does not list keeps what ACP said.
    pub fn display_status(&self, call: &ToolCall) -> ToolStatus {
        if !call.is_workflow {
            return call.status;
        }
        match self.row_status(&call.id) {
            Some(RowStatus::Running) => ToolStatus::InProgress,
            Some(RowStatus::Done) => ToolStatus::Completed,
            Some(RowStatus::Failed) => ToolStatus::Failed,
            None => call.status,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::message::ToolFields;
    use super::*;

    const T0: Duration = Duration::from_secs(1000);

    const PHASES: &str = r#"[{"title":"Scan","agents":[{"label":"a","state":"done","startedAt":1000,"endedAt":1060},{"label":"b","state":"running","startedAt":1010,"activity":"Bash: ls"}]},{"title":"Merge","agents":[]}]"#;

    fn run_line(call: &str, status: &str, summary: Option<&str>, phases: &str) -> String {
        let tail = summary
            .map(|s| format!(r#","summary":"{s}","endedAt":1100"#))
            .unwrap_or_default();
        format!(
            r#"{{"toolCallId":"{call}","runId":"wf_x","title":"review","status":"{status}","startedAt":990,"agents":{{"total":2,"running":1,"done":1}},"phases":{phases}{tail}}}"#
        )
    }

    fn running() -> String {
        run_line("toolu_1", "running", None, PHASES)
    }

    fn call(id: &str, name: Option<&str>, status: ToolStatus) -> ToolCall {
        ToolCall::new(&ToolFields {
            title: Some("Workflow".into()),
            status: Some(status),
            tool_name: name.map(String::from),
            ..ToolFields::new(id)
        })
    }

    fn wf() -> ToolCall {
        call("toolu_1", Some("Workflow"), ToolStatus::Completed)
    }

    fn first(output: &str) -> Run {
        parse(output).runs.remove(0)
    }

    // Parsing

    #[test]
    fn a_run_line_parses_with_phases_agents_and_times() {
        let result = parse(&running());
        assert!(!result.unsupported);
        let run = &result.runs[0];
        assert_eq!(run.tool_call_id, "toolu_1");
        assert_eq!(run.title, "review");
        assert_eq!(run.status, RunStatus::Running);
        assert_eq!(run.started_at, Some(990));
        let titles: Vec<_> = run.phases.iter().map(|p| p.title.as_str()).collect();
        assert_eq!(titles, ["Scan", "Merge"]);
        let states: Vec<_> = run.phases[0].agents.iter().map(|a| a.state).collect();
        assert_eq!(states, [AgentState::Done, AgentState::Running]);
        assert_eq!(
            run.phases[0].agents[1].activity.as_deref(),
            Some("Bash: ls")
        );
        assert_eq!(run.phases[0].agents[0].ended_at, Some(1060));
        assert_eq!((run.done_count(), run.total_count()), (1, 2));
    }

    #[test]
    fn an_ended_run_keeps_the_status_word_and_summary() {
        let done = first(&run_line("toolu_1", "completed", Some("All good"), PHASES));
        assert_eq!(done.status, RunStatus::Completed);
        assert_eq!(done.summary.as_deref(), Some("All good"));
        assert_eq!(status_word(&done), "done");
        let killed = first(&run_line("toolu_1", "killed", None, PHASES));
        assert_eq!(killed.status, RunStatus::Ended("killed".into()));
        assert_eq!(status_word(&killed), "killed");
    }

    #[test]
    fn an_old_host_reads_as_unsupported_but_no_runs_does_not() {
        assert!(parse(r#"tether: unknown acp command "workflows""#).unsupported);
        assert!(
            parse("tether: usage: acp attach|answer|answers|ls|status|sessions|kill").unsupported
        );
        assert!(!parse("").unsupported);
        assert!(!parse("\n").unsupported);
        assert!(!parse(&format!("note\n{}", running())).unsupported);
    }

    #[test]
    fn a_transient_failure_is_a_failed_poll_not_an_old_host() {
        for text in [
            "ssh: connect to host failed",
            "sh: tether: command not found",
            "Killed",
            "tether: open x: permission denied",
        ] {
            let result = parse(text);
            assert!(!result.unsupported, "{text}");
            assert!(result.failed, "{text}");
        }
        assert!(!parse("").failed);
        assert!(!parse(&running()).failed);
    }

    #[test]
    fn the_command_quotes_the_session_id() {
        let command = command("a b'c");
        assert!(command.contains("tether acp workflows --session "));
        assert!(!command.contains("--session a b'c"));
        assert!(command.ends_with("--json 2>&1"));
    }

    // Strip text

    #[test]
    fn the_strip_names_the_title_phase_and_agent_count() {
        assert_eq!(
            strip_text(&first(&running()), 0),
            "review \u{00B7} Scan \u{00B7} 1/2 agents"
        );
    }

    #[test]
    fn the_phase_is_the_first_with_an_unfinished_agent_else_the_last_with_agents() {
        let all_done = r#"[{"title":"A","agents":[{"label":"x","state":"done"}]},{"title":"B","agents":[{"label":"y","state":"done"}]},{"title":"C","agents":[]}]"#;
        let run = first(&run_line("toolu_1", "running", None, all_done));
        assert_eq!(run.current_phase().map(|p| p.title.as_str()), Some("B"));
        let bare = first(&run_line("toolu_1", "running", None, "[]"));
        assert_eq!(strip_text(&bare, 0), "review");
    }

    #[test]
    fn elapsed_reads_compactly_and_a_finished_agent_stops_counting() {
        assert_eq!(elapsed(45), "45s");
        assert_eq!(elapsed(185), "3m 05s");
        assert_eq!(elapsed(3720), "1h 02m");
        assert_eq!(elapsed(-3), "0s");
        let agent = |state, started_at, ended_at| Agent {
            label: "a".into(),
            state,
            started_at,
            ended_at,
            activity: None,
        };
        let done = agent(AgentState::Done, Some(1000), Some(1060));
        let running = agent(AgentState::Running, Some(1000), None);
        assert_eq!(agent_elapsed(&done, 1500).as_deref(), Some("1m 00s"));
        assert_eq!(agent_elapsed(&running, 1500).as_deref(), Some("8m 20s"));
        assert_eq!(
            agent_elapsed(&agent(AgentState::Running, None, None), 1000),
            None
        );
        let mut stopped = running.clone();
        stopped.state = AgentState::Stopped;
        assert_eq!(
            agent_elapsed(&stopped, 1500),
            None,
            "a stopped agent with no end does not keep counting"
        );
        stopped.ended_at = Some(1030);
        assert_eq!(agent_elapsed(&stopped, 1500).as_deref(), Some("30s"));
    }

    #[test]
    fn the_run_clock_stops_at_its_end() {
        let mut run = first(&run_line("toolu_1", "completed", Some("ok"), PHASES));
        assert_eq!(run_elapsed(&run, 5000).as_deref(), Some("1m 50s"));
        run.status = RunStatus::Running;
        assert_eq!(run_elapsed(&run, 1000).as_deref(), Some("10s"));
    }

    #[test]
    fn agents_of_an_ended_run_are_stopped_and_not_counted_as_running() {
        let phases = r#"[{"title":"A","agents":[{"label":"x","state":"done"},{"label":"y","state":"stopped"},{"label":"z","state":"running"}]}]"#;
        let ended = first(&run_line("toolu_1", "killed", None, phases));
        let states: Vec<_> = ended.agents().map(|a| a.state).collect();
        assert_eq!(
            states,
            [AgentState::Done, AgentState::Stopped, AgentState::Stopped]
        );
        assert_eq!(ended.running_count(), 0);
        assert_eq!((ended.done_count(), ended.total_count()), (1, 3));
        let live = first(&run_line("toolu_1", "running", None, phases));
        let states: Vec<_> = live.agents().map(|a| a.state).collect();
        assert_eq!(
            states,
            [AgentState::Done, AgentState::Stopped, AgentState::Running]
        );
        assert_eq!(live.running_count(), 1);
    }

    #[test]
    fn a_run_with_no_end_notice_says_how_long_it_has_been_quiet_but_is_not_done() {
        let now = 100_000;
        let mut run = first(&running());
        assert_eq!(quiet(&run, now), None, "no host timestamp, nothing to say");
        run.last_activity_at = Some(now - 599);
        assert_eq!(quiet(&run, now), None);
        run.last_activity_at = Some(now - 12 * 60 - 5);
        assert_eq!(quiet(&run, now).as_deref(), Some("no activity for 12m"));
        assert_eq!(
            strip_text(&run, now),
            "review \u{00B7} no activity for 12m \u{00B7} 1/2 agents"
        );
        assert_eq!(status_word(&run), "running");
        assert!(run.is_running());
        run.status = RunStatus::Completed;
        assert_eq!(
            quiet(&run, now),
            None,
            "an ended run is not quiet, it is over"
        );
    }

    #[test]
    fn last_activity_is_read_from_the_host() {
        let line = running().replace(
            r#""status":"running""#,
            r#""status":"running","lastActivityAt":1234"#,
        );
        assert_eq!(first(&line).last_activity_at, Some(1234));
    }

    // Tool calls

    #[test]
    fn only_the_workflow_tool_is_marked() {
        assert!(wf().is_workflow);
        assert!(!call("t", Some("Bash"), ToolStatus::Completed).is_workflow);
        assert!(!call("t", None, ToolStatus::Completed).is_workflow);
    }

    #[test]
    fn a_snapshot_from_before_the_mark_still_decodes() {
        let mut value = serde_json::to_value(wf()).unwrap();
        value.as_object_mut().unwrap().remove("is_workflow");
        let decoded: ToolCall = serde_json::from_value(value).unwrap();
        assert!(!decoded.is_workflow);
    }

    // Tracker

    #[test]
    fn polling_continues_while_a_run_runs_and_stops_when_it_ends() {
        let mut tracker = Tracker::default();
        let call = wf();
        let calls = [&call];
        assert!(tracker.needs_polling(&calls));
        tracker.apply(Some(&running()), &calls, T0);
        assert!(tracker.needs_polling(&calls));
        assert_eq!(tracker.running().len(), 1);
        let ended = run_line("toolu_1", "completed", Some("ok"), PHASES);
        tracker.apply(Some(&ended), &calls, T0);
        assert!(!tracker.needs_polling(&calls));
        assert!(tracker.running().is_empty());
    }

    #[test]
    fn polling_slows_after_two_quiet_minutes_and_speeds_up_on_any_change() {
        let mut tracker = Tracker::default();
        let call = wf();
        let calls = [&call];
        let base = POLL_INTERVAL;
        let at = |s: u64| T0 + Duration::from_secs(s);
        assert_eq!(tracker.interval(base, T0), base);
        tracker.apply(Some(&running()), &calls, T0);
        assert_eq!(tracker.interval(base, at(119)), base);
        assert_eq!(tracker.interval(base, at(121)), Duration::from_secs(30));
        tracker.apply(Some(&running()), &calls, at(125));
        assert_eq!(
            tracker.interval(base, at(130)),
            Duration::from_secs(30),
            "the same answer is not a change"
        );
        tracker.apply(None, &calls, at(135));
        tracker.apply(Some("ssh: connect failed"), &calls, at(140));
        assert_eq!(
            tracker.interval(base, at(145)),
            Duration::from_secs(30),
            "a failed poll is not a change either"
        );
        let moved = run_line(
            "toolu_1",
            "running",
            None,
            r#"[{"title":"Merge","agents":[{"label":"c","state":"running"}]}]"#,
        );
        tracker.apply(Some(&moved), &calls, at(150));
        assert_eq!(tracker.interval(base, at(155)), base);
        assert_eq!(
            tracker.interval(base, at(150 + 121)),
            Duration::from_secs(30)
        );
    }

    #[test]
    fn a_transient_failure_does_not_stop_the_polling() {
        let mut tracker = Tracker::default();
        let call = wf();
        let calls = [&call];
        tracker.apply(Some("ssh: connection reset"), &calls, T0);
        assert!(tracker.supported());
        assert!(tracker.needs_polling(&calls));
        tracker.apply(Some(&running()), &calls, T0);
        tracker.apply(Some("Killed"), &calls, T0);
        assert_eq!(tracker.runs().len(), 1, "the last good answer stands");
    }

    #[test]
    fn no_workflow_call_means_no_polling() {
        let bash = call("t", Some("Bash"), ToolStatus::Completed);
        assert!(!Tracker::default().needs_polling(&[&bash]));
        assert!(!Tracker::default().needs_polling(&[]));
    }

    #[test]
    fn a_failed_launch_is_not_polled_for() {
        let failed = call("toolu_1", Some("Workflow"), ToolStatus::Failed);
        assert!(!Tracker::default().needs_polling(&[&failed]));
    }

    #[test]
    fn a_call_the_host_never_lists_stops_after_a_few_answers() {
        let mut tracker = Tracker::default();
        let call = wf();
        let calls = [&call];
        for _ in 0..MAX_MISSES {
            assert!(tracker.needs_polling(&calls));
            tracker.apply(Some(""), &calls, T0);
        }
        assert!(!tracker.needs_polling(&calls));
    }

    #[test]
    fn an_old_host_stops_the_polling_for_good_and_rows_keep_the_acp_status() {
        let mut tracker = Tracker::default();
        let call = wf();
        let calls = [&call];
        tracker.apply(
            Some(r#"tether: unknown acp command "workflows""#),
            &calls,
            T0,
        );
        assert!(!tracker.supported());
        assert!(!tracker.needs_polling(&calls));
        assert_eq!(tracker.row_status("toolu_1"), None);
        assert_eq!(tracker.display_status(&call), ToolStatus::Completed);
    }

    #[test]
    fn a_failed_ask_changes_nothing() {
        let mut tracker = Tracker::default();
        let call = wf();
        let calls = [&call];
        tracker.apply(Some(&running()), &calls, T0);
        tracker.apply(None, &calls, T0);
        assert_eq!(tracker.runs().len(), 1);
        assert!(tracker.supported());
    }

    #[test]
    fn the_workflow_row_runs_until_the_host_reports_the_end() {
        let mut tracker = Tracker::default();
        let call = wf();
        let bash = self::call("toolu_2", Some("Bash"), ToolStatus::Completed);
        let calls = [&call];
        assert_eq!(tracker.display_status(&call), ToolStatus::Completed);
        tracker.apply(Some(&running()), &calls, T0);
        assert_eq!(tracker.display_status(&call), ToolStatus::InProgress);
        assert_eq!(tracker.display_status(&bash), ToolStatus::Completed);
        let done = run_line("toolu_1", "completed", Some("ok"), PHASES);
        tracker.apply(Some(&done), &calls, T0);
        assert_eq!(tracker.display_status(&call), ToolStatus::Completed);
        let failed = run_line("toolu_1", "failed", Some("no"), PHASES);
        tracker.apply(Some(&failed), &calls, T0);
        assert_eq!(tracker.display_status(&call), ToolStatus::Failed);
    }
}
