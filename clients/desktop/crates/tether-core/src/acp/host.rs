//! The `tether acp` commands a chat runs over ssh exec, and the parsers for what they print.
//! Every argument is quoted with `shell_quote`, so nothing the agent or a chat name holds is
//! parsed by a shell.

use std::collections::HashMap;

use rand_core::{OsRng, RngCore};
use serde::Deserialize;
use serde_json::Value;

use super::agent::{self, AgentProfile, CLAUDE};
use super::format::folder_name;
use super::journal::Journal;
use super::message::AcpId;
use crate::zmx::shell_quote;

macro_rules! tether_acp {
    () => {
        "PATH=\"$HOME/.local/bin:$PATH\" tether acp"
    };
}

/// `tether acp`, with the user's bin folder on the path: a non-interactive ssh exec does not
/// read the login profile that usually puts it there.
pub const TETHER: &str = tether_acp!();

/// Pinned: the transcript reducer is written against this adapter's output, so a host never
/// picks up a newer one on its own.
pub const ADAPTER_PACKAGE: &str = "@agentclientprotocol/claude-agent-acp";
pub const ADAPTER_VERSION: &str = "0.95.0";

pub fn spawn_command() -> String {
    CLAUDE.spawn.to_string()
}

/// `spawn` names the agent to start; it is only given when the host has none for the name, and a
/// resume leaves it off so a lost holder never starts a fresh agent under a journal that names
/// the old session. `client` names this client to a holder that takes several, so the others see what it sends.
pub fn attach_command(
    name: &str,
    cwd: &str,
    spawn: Option<&AgentProfile>,
    from: usize,
    client: Option<&str>,
) -> String {
    let mut command = format!("{TETHER} attach {} --from {from}", shell_quote(name));
    if let Some(client) = client {
        command += &format!(" --client {}", shell_quote(client));
    }
    if let Some(agent) = spawn {
        command += &format!(
            " --spawn {} --cwd {}",
            shell_quote(agent.spawn),
            shell_quote(cwd)
        );
    }
    command
}

pub const LIST: &str = concat!(tether_acp!(), " ls");
/// One JSON line per chat with what is happening in it. A host that predates it prints an
/// "unknown command" line, which the listing reads as unsupported (stderr is folded in for that).
pub const STATUS: &str = concat!(tether_acp!(), " status 2>&1");
/// For the chat list screen, which has to show why a host that cannot list says nothing.
pub const LIST_WITH_ERRORS: &str = concat!(tether_acp!(), " ls 2>&1");
pub const HOME: &str = "printf %s \"$HOME\"";

/// Earlier conversations of `agent` in `cwd`, newest first, as JSON lines. Runs the adapter
/// briefly on the host. The host lists Claude's without being told which agent.
pub fn sessions_command(cwd: &str, limit: usize, agent: &AgentProfile) -> String {
    let which = if agent == &CLAUDE {
        String::new()
    } else {
        format!(" --agent-cmd {}", shell_quote(agent.spawn))
    };
    format!(
        "{TETHER} sessions {} --limit {limit}{which} 2>&1",
        shell_quote(cwd)
    )
}

pub fn kill_command(name: &str) -> String {
    format!("{TETHER} kill {}", shell_quote(name))
}

/// What the host's holder recorded as answered while no client was attached; a host without
/// the command prints nothing useful, so stderr is dropped.
pub fn answers_command(name: &str) -> String {
    format!("{TETHER} answers {} 2>/dev/null", shell_quote(name))
}

/// One answer to a held request. `request_id_text` is the JSON-RPC id as JSON text (`7`, or
/// `"abc"`), as the holder writes it.
pub fn answer_command(name: &str, request_id_text: &str, option_id: &str) -> String {
    format!(
        "{TETHER} answer {} --request {} --option {}",
        shell_quote(name),
        shell_quote(request_id_text),
        shell_quote(option_id)
    )
}

/// `tether acp answers` output: `{requestId: optionId | "cancelled"}`. Anything that isn't
/// that object gives nothing.
pub fn parse_answers(output: &str) -> HashMap<AcpId, String> {
    let Some(line) = output.split('\n').rfind(|l| l.starts_with('{')) else {
        return HashMap::new();
    };
    let Ok(map) = serde_json::from_str::<HashMap<String, String>>(line) else {
        return HashMap::new();
    };
    map.into_iter()
        .filter(|(_, v)| !v.is_empty())
        .map(|(k, v)| (id_from_json_text(&k), v))
        .collect()
}

/// The inverse of how the holder writes a JSON-RPC id as text: `7`, or `"abc"`.
pub fn id_from_json_text(text: &str) -> AcpId {
    if let Ok(n) = text.parse::<i64>() {
        return AcpId::Int(n);
    }
    if let Ok(s) = serde_json::from_str::<String>(text) {
        return AcpId::Str(s);
    }
    AcpId::Str(text.to_string())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostTurn {
    Idle,
    Working,
    Waiting,
}

/// A chat as the host lists it. `created` is the host session's start in unix seconds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatSummary {
    pub name: String,
    pub is_running: bool,
    pub log_bytes: usize,
    pub cwd: String,
    pub created: i64,
    pub spawn: String,
    /// From `acp status`; a host without it leaves these at their defaults.
    pub turn: HostTurn,
    pub host_title: Option<String>,
    pub has_status: bool,
    /// The chat's holder lets several clients attach at once.
    pub multi_client: bool,
    /// Background commands the holder counts as running, from `acp status`.
    pub tasks: u32,
}

impl ChatSummary {
    pub fn new(name: &str, cwd: &str) -> Self {
        Self {
            name: name.to_string(),
            is_running: true,
            log_bytes: 0,
            cwd: cwd.to_string(),
            created: 0,
            spawn: String::new(),
            turn: HostTurn::Idle,
            host_title: None,
            has_status: false,
            multi_client: false,
            tasks: 0,
        }
    }

    /// The folder name; a chat started in the home directory or the root has no better label.
    pub fn title(&self) -> String {
        folder_name(&self.cwd)
    }
}

fn is_newline(c: char) -> bool {
    matches!(
        c,
        '\n' | '\r' | '\u{0B}' | '\u{0C}' | '\u{85}' | '\u{2028}' | '\u{2029}'
    )
}

fn lines_of(output: &str) -> impl Iterator<Item = &str> {
    output.split(is_newline).filter(|l| !l.is_empty())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Listing {
    pub chats: Vec<ChatSummary>,
    pub skipped: Vec<String>,
}

/// `name<TAB>state<TAB>logBytes<TAB>cwd<TAB>createdUnix<TAB>spawn`, one chat per line.
pub fn parse_listing(output: &str) -> Listing {
    let mut chats = Vec::new();
    let mut skipped = Vec::new();
    for line in lines_of(output) {
        let fields: Vec<&str> = line.splitn(6, '\t').collect();
        let parsed = (|| {
            if fields.len() < 5 || fields[0].is_empty() {
                return None;
            }
            if fields[1] != "running" && fields[1] != "ended" {
                return None;
            }
            let bytes = fields[2].parse::<usize>().ok()?;
            let created = fields[4].parse::<f64>().ok().filter(|c| c.is_finite())?;
            Some(ChatSummary {
                name: fields[0].to_string(),
                is_running: fields[1] == "running",
                log_bytes: bytes,
                cwd: fields[3].to_string(),
                created: created as i64,
                spawn: fields.get(5).copied().unwrap_or("").to_string(),
                turn: HostTurn::Idle,
                host_title: None,
                has_status: false,
                multi_client: false,
                tasks: 0,
            })
        })();
        match parsed {
            Some(chat) => chats.push(chat),
            None => skipped.push(line.to_string()),
        }
    }
    chats.sort_by_key(|c| std::cmp::Reverse(c.created));
    Listing { chats, skipped }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusListing {
    pub chats: Vec<ChatSummary>,
    pub unsupported: bool,
}

/// `acp status`: one JSON object per chat. A host whose tether predates the command prints an
/// error line instead, which reads as `unsupported` so the caller falls back to `acp ls`.
pub fn parse_status(output: &str) -> StatusListing {
    let mut chats = Vec::new();
    let mut stray = false;
    for raw in lines_of(output) {
        let line = raw.trim_matches(|c| c == ' ' || c == '\t');
        if line.is_empty() {
            continue;
        }
        match status_chat(line) {
            Some(chat) => chats.push(chat),
            None => stray = true,
        }
    }
    chats.sort_by_key(|c| std::cmp::Reverse(c.created));
    let unsupported = chats.is_empty() && stray;
    StatusListing { chats, unsupported }
}

fn number_int(v: Option<&Value>) -> Option<i64> {
    let n = v?.as_number()?;
    n.as_i64().or_else(|| n.as_f64().map(|f| f as i64))
}

fn status_chat(line: &str) -> Option<ChatSummary> {
    let Value::Object(object) = serde_json::from_str::<Value>(line).ok()? else {
        return None;
    };
    let name = object.get("name")?.as_str().filter(|n| !n.is_empty())?;
    let state = object.get("state")?.as_str()?;
    if state != "running" && state != "ended" {
        return None;
    }
    let title = object
        .get("title")
        .and_then(Value::as_str)
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty());
    let turn = match object.get("turn").and_then(Value::as_str) {
        Some("working") => HostTurn::Working,
        Some("waiting") => HostTurn::Waiting,
        _ => HostTurn::Idle,
    };
    Some(ChatSummary {
        name: name.to_string(),
        is_running: state == "running",
        log_bytes: number_int(object.get("logBytes")).unwrap_or(0).max(0) as usize,
        cwd: object
            .get("cwd")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        created: number_int(object.get("created")).unwrap_or(0),
        spawn: object
            .get("spawn")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        turn,
        host_title: title,
        has_status: true,
        multi_client: object.get("multiClient").and_then(Value::as_bool) == Some(true),
        tasks: number_int(object.get("tasks"))
            .unwrap_or(0)
            .clamp(0, u32::MAX as i64) as u32,
    })
}

/// The state a drawer row shows. `Running` is what a host without `acp status` can say.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DrawerChatState {
    Working,
    Waiting,
    /// Idle, with background commands still running: the tag counts them.
    Tasks,
    Idle,
    Running,
    Ended,
}

impl DrawerChatState {
    pub fn of(chat: &ChatSummary) -> Self {
        if !chat.is_running {
            Self::Ended
        } else if !chat.has_status {
            Self::Running
        } else {
            match chat.turn {
                HostTurn::Working => Self::Working,
                HostTurn::Waiting => Self::Waiting,
                HostTurn::Idle if chat.tasks > 0 => Self::Tasks,
                HostTurn::Idle => Self::Idle,
            }
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Working => "working",
            Self::Waiting => "needs you",
            Self::Tasks => "tasks",
            Self::Idle => "idle",
            Self::Running => "running",
            Self::Ended => "ended",
        }
    }
}

/// One chat as the terminal screen's drawer lists it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DrawerChatRow {
    pub name: String,
    pub title: String,
    pub subtitle: String,
    pub state: DrawerChatState,
    pub cwd: String,
    pub tasks: u32,
    /// `None` is an agent this build does not know.
    pub agent: Option<&'static AgentProfile>,
}

impl DrawerChatRow {
    /// The word the row shows: the state, or the count of running background commands.
    pub fn tag(&self) -> String {
        match (self.state, self.tasks) {
            (DrawerChatState::Tasks, 1) => "1 task".into(),
            (DrawerChatState::Tasks, n) => format!("{n} tasks"),
            (state, _) => state.label().into(),
        }
    }

    pub fn is_running(&self) -> bool {
        self.state != DrawerChatState::Ended
    }

    pub fn state_label(&self) -> &'static str {
        self.state.label()
    }
}

/// The host's title, else the stored agent title, else the folder name. The subtitle is the
/// folder, or the path above it when the folder is already the title; a chat with another agent
/// than Claude leads it with the agent's name. `local_agents` holds the agent key this device
/// recorded for the chats it started.
pub fn drawer_rows(
    chats: &[ChatSummary],
    titles: &HashMap<String, String>,
    local_agents: &HashMap<String, String>,
) -> Vec<DrawerChatRow> {
    chats
        .iter()
        .map(|chat| {
            let folder = folder_name(&chat.cwd);
            let stored = titles.get(&chat.name).filter(|t| !t.is_empty());
            let title = chat
                .host_title
                .clone()
                .or_else(|| stored.cloned())
                .unwrap_or_else(|| folder.clone());
            let subtitle = if title == folder {
                super::format::parent_path(&chat.cwd).unwrap_or_else(|| chat.cwd.clone())
            } else {
                folder
            };
            let agent = agent::resolve(
                local_agents.get(&chat.name).map(String::as_str),
                &chat.spawn,
            );
            let subtitle = if agent == Some(&CLAUDE) {
                subtitle
            } else {
                format!("{} \u{b7} {subtitle}", agent::label(agent))
            };
            DrawerChatRow {
                name: chat.name.clone(),
                title,
                subtitle,
                state: DrawerChatState::of(chat),
                cwd: chat.cwd.clone(),
                tasks: chat.tasks,
                agent,
            }
        })
        .collect()
}

/// A chat other than the open one is waiting on an answer; the drawer button says so because
/// its banner would sit out of sight behind the open chat.
pub fn others_waiting(chats: &[ChatSummary], open: Option<&str>) -> bool {
    chats.iter().any(|c| {
        c.is_running && c.has_status && c.turn == HostTurn::Waiting && Some(c.name.as_str()) != open
    })
}

/// An earlier conversation the agent has stored for a folder, from `acp sessions`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SavedSession {
    pub session_id: String,
    pub title: String,
    /// Unix seconds, fractions dropped.
    pub updated_at: Option<i64>,
    pub cwd: String,
}

impl SavedSession {
    pub fn display_title(&self) -> &str {
        if self.title.is_empty() {
            "Untitled conversation"
        } else {
            &self.title
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SavedSessions {
    pub sessions: Vec<SavedSession>,
    pub failure: Option<String>,
}

/// `acp sessions`: one JSON object per conversation, newest first. Stray lines are what the
/// host printed on failure (its stderr is folded in), so with no conversation parsed they
/// become the reason.
pub fn parse_saved_sessions(output: &str) -> SavedSessions {
    let mut sessions = Vec::new();
    let mut stray: Vec<String> = Vec::new();
    for raw in lines_of(output) {
        let line = raw.trim_matches(|c| c == ' ' || c == '\t');
        if line.is_empty() {
            continue;
        }
        let parsed = serde_json::from_str::<Value>(line).ok().and_then(|v| {
            let object = v.as_object()?;
            let id = object
                .get("sessionId")?
                .as_str()
                .filter(|s| !s.is_empty())?;
            Some(SavedSession {
                session_id: id.to_string(),
                title: object
                    .get("title")
                    .and_then(Value::as_str)
                    .map(|t| t.trim().to_string())
                    .unwrap_or_default(),
                updated_at: object
                    .get("updatedAt")
                    .and_then(Value::as_str)
                    .and_then(parse_iso8601),
                cwd: object
                    .get("cwd")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
            })
        });
        match parsed {
            Some(s) => sessions.push(s),
            None => stray.push(line.to_string()),
        }
    }
    match (sessions.is_empty(), stray.first()) {
        (true, Some(first)) => SavedSessions {
            sessions: Vec::new(),
            failure: Some(explain_saved_sessions(first)),
        },
        _ => SavedSessions {
            sessions,
            failure: None,
        },
    }
}

pub fn explain_saved_sessions(line: &str) -> String {
    let lower = line.to_lowercase();
    if lower.contains("unknown acp command")
        || lower.contains("not found")
        || lower.contains("usage")
    {
        return "This host's tether is too old to list earlier conversations. Update it.".into();
    }
    let trimmed = line.replace("tether: ", "");
    if trimmed.chars().count() > 160 {
        format!("{}\u{2026}", trimmed.chars().take(160).collect::<String>())
    } else {
        trimmed
    }
}

/// `2027-01-15T08:00:00Z`, with or without fractional seconds, `Z` or `+hh:mm`, as unix seconds.
pub fn parse_iso8601(text: &str) -> Option<i64> {
    let b = text.as_bytes();
    let num = |from: usize, len: usize| -> Option<i64> {
        let digits = b.get(from..from + len)?;
        if !digits.iter().all(u8::is_ascii_digit) {
            return None;
        }
        std::str::from_utf8(digits).ok()?.parse().ok()
    };
    let sep = |at: usize, want: u8| (b.get(at) == Some(&want)).then_some(());
    let (year, month, day) = (num(0, 4)?, num(5, 2)?, num(8, 2)?);
    sep(4, b'-')?;
    sep(7, b'-')?;
    sep(10, b'T')?;
    let (hour, minute, second) = (num(11, 2)?, num(14, 2)?, num(17, 2)?);
    sep(13, b':')?;
    sep(16, b':')?;
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }
    let mut at = 19;
    if b.get(at) == Some(&b'.') {
        at += 1;
        let start = at;
        while b.get(at).is_some_and(u8::is_ascii_digit) {
            at += 1;
        }
        if at == start {
            return None;
        }
    }
    let offset = match b.get(at)? {
        b'Z' if at + 1 == b.len() => 0,
        sign @ (b'+' | b'-') if at + 6 == b.len() => {
            sep(at + 3, b':')?;
            let (h, m) = (num(at + 1, 2)?, num(at + 4, 2)?);
            if h > 23 || m > 59 {
                return None;
            }
            let seconds = h * 3600 + m * 60;
            if *sign == b'+' { seconds } else { -seconds }
        }
        _ => return None,
    };
    Some(days_from_civil(year, month, day) * 86_400 + hour * 3600 + minute * 60 + second - offset)
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Inside this window the conversation may still be open in a terminal on the host.
pub const RECENT_WINDOW: i64 = 10 * 60;
pub const RECENT_NOTE: &str = "Updated minutes ago: it may still be open in a terminal";

pub fn is_recent(updated_at: Option<i64>, now: i64) -> bool {
    updated_at.is_some_and(|t| now - t < RECENT_WINDOW)
}

/// "5 min ago", "2 h ago", "3 d ago", and past two weeks the date as "Jan 15" (UTC).
pub fn continue_relative(updated_at: Option<i64>, now: i64) -> String {
    let Some(updated) = updated_at else {
        return String::new();
    };
    let seconds = (now - updated).max(0);
    match seconds {
        0..=59 => "just now".to_string(),
        60..=3599 => format!("{} min ago", seconds / 60),
        3600..=86_399 => format!("{} h ago", seconds / 3600),
        86_400..=1_209_599 => format!("{} d ago", seconds / 86_400),
        _ => {
            const MONTHS: [&str; 12] = [
                "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
            ];
            let (_, month, day) = civil_from_days(updated.div_euclid(86_400));
            format!("{} {day}", MONTHS[(month - 1) as usize])
        }
    }
}

/// `session/new` needs an absolute path, so a typed `~` is resolved against the host's home.
pub fn expand_cwd(text: &str, home: &str) -> String {
    let mut path = text.trim().to_string();
    if path.is_empty() || path == "~" {
        return home.to_string();
    }
    if let Some(rest) = path.strip_prefix('~')
        && rest.starts_with('/')
    {
        path = format!("{home}{rest}");
    }
    while path.chars().count() > 1 && path.ends_with('/') {
        path.pop();
    }
    path
}

pub fn needs_home(text: &str) -> bool {
    let path = text.trim();
    path.is_empty() || path == "~" || path.starts_with("~/")
}

/// A chat this client has a session id for resumes. Any other joins the session another client
/// started when its holder takes several clients, and can only be read when it does not.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenMode {
    Resume,
    Join,
    ReadOnly,
}

/// A chat this client began but never got a session for (a signed-out agent) has sent
/// requests, so it reopens as live and asks again; a chat it never touched stays read only.
pub fn open_mode(journal: &Journal, multi_client: bool) -> OpenMode {
    match (
        journal.session_id.is_none() && journal.next_request_id <= 1,
        multi_client,
    ) {
        (false, _) => OpenMode::Resume,
        (true, true) => OpenMode::Join,
        (true, false) => OpenMode::ReadOnly,
    }
}

/// Names this client in the log of a holder that takes several; ten of `[a-z0-9]`.
pub fn new_client_id() -> String {
    random_alnum(10)
}

/// "chat-" and six of `[a-z0-9]`.
pub fn new_chat_name() -> String {
    format!("chat-{}", random_alnum(6))
}

fn random_alnum(len: usize) -> String {
    const LETTERS: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    let mut out = String::new();
    let mut rng = OsRng;
    while out.len() < len {
        let mut byte = [0u8; 1];
        rng.fill_bytes(&mut byte);
        // 252 is the largest multiple of 36 that fits a byte: the rest would bias the pick.
        if byte[0] < 252 {
            out.push(LETTERS[(byte[0] % 36) as usize] as char);
        }
    }
    out
}

/// The lowest `tether version` protocol this client works with; bump with the host tool's `protocol`.
pub const REQUIRED_PROTOCOL: i64 = 1;
/// From this protocol a new chat's holder lets several clients attach (`attach --client`).
pub const MULTI_CLIENT_PROTOCOL: i64 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostProblem {
    TetherMissing,
    TetherForeign,
    TetherOutdated,
    NodeMissing,
    OpencodeMissing,
}

/// A POSIX script run through `sh -c` so the host's login shell (fish, say) does not matter.
/// It reports on stdout. The `tether` found may be the retired v4 server, so the probe is
/// time-boxed and judged by its JSON.
pub const HOST_CHECK_SCRIPT: &str = concat!(
    "PATH=\"$HOME/.local/bin:$PATH\"; export PATH",
    "; ",
    "T=\"\"; if command -v timeout >/dev/null 2>&1; then T=\"timeout 5\"; fi",
    "; ",
    "if command -v tether >/dev/null 2>&1; then echo tether=found; ",
    "echo \"version=$($T tether version --json </dev/null 2>/dev/null | head -n 1)\"; ",
    "else echo tether=missing; fi",
    "; ",
    "if command -v npx >/dev/null 2>&1; then echo node=ok; else echo node=missing; fi",
    "; ",
    "if command -v opencode >/dev/null 2>&1 || [ -x \"$HOME/.opencode/bin/opencode\" ] ",
    "|| PATH=\"$HOME/.opencode/bin:$PATH\" $T \"${SHELL:-sh}\" -lc \"command -v opencode\" </dev/null >/dev/null 2>&1; ",
    "then echo opencode=ok; else echo opencode=missing; fi",
);

pub fn host_check_command() -> String {
    format!("sh -c {}", shell_quote(HOST_CHECK_SCRIPT))
}

#[derive(Deserialize)]
struct Version {
    name: Option<String>,
    protocol: Option<i64>,
}

/// A line the host did not report is not a problem: only what it said counts.
pub fn host_problems(output: &str) -> Vec<HostProblem> {
    let mut found = Vec::new();
    let lines: Vec<&str> = lines_of(output)
        .map(|l| l.trim_matches(|c| c == ' ' || c == '\t'))
        .collect();
    if lines.contains(&"tether=missing") {
        found.push(HostProblem::TetherMissing);
    } else if lines.contains(&"tether=found") {
        let json = lines
            .iter()
            .find_map(|l| l.strip_prefix("version="))
            .unwrap_or("");
        let version = serde_json::from_str::<Version>(json).ok();
        if version.as_ref().and_then(|v| v.name.as_deref()) != Some("tether") {
            found.push(HostProblem::TetherForeign);
        } else if version.and_then(|v| v.protocol).unwrap_or(0) < REQUIRED_PROTOCOL {
            found.push(HostProblem::TetherOutdated);
        }
    }
    if lines.contains(&"node=missing") {
        found.push(HostProblem::NodeMissing);
    }
    if lines.contains(&"opencode=missing") {
        found.push(HostProblem::OpencodeMissing);
    }
    found
}

/// Node serves the npx-run agents; opencode and Copilot are their own binaries.
pub fn host_problems_for(output: &str, agent: &AgentProfile) -> Vec<HostProblem> {
    let opencode = agent.key == agent::OPENCODE.key;
    host_problems(output)
        .into_iter()
        .filter(|p| match p {
            HostProblem::OpencodeMissing => opencode,
            HostProblem::NodeMissing => agent.needs_node,
            _ => true,
        })
        .collect()
}

/// Whether the host's `tether` starts holders that take several clients.
pub fn host_multi_client(output: &str) -> bool {
    lines_of(output)
        .filter_map(|l| l.trim().strip_prefix("version="))
        .filter_map(|json| serde_json::from_str::<Version>(json).ok())
        .any(|v| {
            v.name.as_deref() == Some("tether") && v.protocol.unwrap_or(0) >= MULTI_CLIENT_PROTOCOL
        })
}

pub fn host_problem_message(problems: &[HostProblem], host: &str) -> Option<String> {
    if problems.is_empty() {
        return None;
    }
    let mut parts: Vec<String> = Vec::new();
    if problems.contains(&HostProblem::TetherMissing) {
        parts.push(format!(
            "Install tether on {host} (install.sh). tether-notify is now called tether."
        ));
    } else if problems.contains(&HostProblem::TetherForeign) {
        parts.push(format!(
            "Another program named tether is installed on {host} (the old Tether server). Run install.sh there to replace it."
        ));
    } else if problems.contains(&HostProblem::TetherOutdated) {
        parts.push(format!("Update tether on {host} (install.sh)."));
    }
    if problems.contains(&HostProblem::NodeMissing) {
        parts.push(format!("Node.js is required on {host}."));
    }
    if problems.contains(&HostProblem::OpencodeMissing) {
        parts.push(format!(
            "Install opencode on {host} (opencode.ai), or check it is on the PATH of a login shell."
        ));
    }
    Some(parts.join(" "))
}

/// The chat list's reason for a host that cannot list: a missing or too-old tether gets plain words.
pub fn explain_list_line(line: &str, host: Option<&str>) -> String {
    let lower = line.to_lowercase();
    if lower.contains("not found") || lower.contains("unknown command") || lower.contains("usage") {
        let update = host
            .map(|h| format!("Update tether on {h}. "))
            .unwrap_or_default();
        return format!(
            "{update}This host's tether is missing or too old for chat. Reinstall it, then pull to refresh."
        );
    }
    line.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attach_command_spawns_only_for_a_new_chat() {
        assert_eq!(
            attach_command("chat-ab12", "/home/sam/my app", Some(&CLAUDE), 0, None),
            "PATH=\"$HOME/.local/bin:$PATH\" tether acp attach 'chat-ab12' --from 0 --spawn 'npx -y @agentclientprotocol/claude-agent-acp@0.95.0' --cwd '/home/sam/my app'"
        );
        assert_eq!(
            attach_command("chat-ab12", "/x", None, 0, None),
            "PATH=\"$HOME/.local/bin:$PATH\" tether acp attach 'chat-ab12' --from 0"
        );
        assert!(attach_command("c", "/x", None, 4096, None).ends_with("--from 4096"));
        assert_eq!(
            attach_command("chat-ab12", "/x", None, 0, Some("k3x9")),
            "PATH=\"$HOME/.local/bin:$PATH\" tether acp attach 'chat-ab12' --from 0 --client 'k3x9'"
        );
    }

    #[test]
    fn the_spawn_command_is_pinned_to_an_explicit_adapter_version() {
        assert_eq!(
            spawn_command(),
            "npx -y @agentclientprotocol/claude-agent-acp@0.95.0"
        );
        assert_eq!(ADAPTER_VERSION, "0.95.0");
        let command = attach_command("c", "/x", Some(&CLAUDE), 0, None);
        assert!(command.contains("--spawn 'npx -y @agentclientprotocol/claude-agent-acp@0.95.0'"));
        assert!(!attach_command("c", "/x", None, 0, None).contains("npx"));
    }

    #[test]
    fn shell_metacharacters_in_a_name_or_folder_are_quoted() {
        let command = attach_command("a'b", "/x; rm -rf /", Some(&CLAUDE), 0, None);
        assert!(command.contains("'a'\"'\"'b'"));
        assert!(command.contains("'/x; rm -rf /'"));
        assert_eq!(
            kill_command("chat-1"),
            "PATH=\"$HOME/.local/bin:$PATH\" tether acp kill 'chat-1'"
        );
    }

    #[test]
    fn the_fixed_commands() {
        assert_eq!(LIST, "PATH=\"$HOME/.local/bin:$PATH\" tether acp ls");
        assert_eq!(
            LIST_WITH_ERRORS,
            "PATH=\"$HOME/.local/bin:$PATH\" tether acp ls 2>&1"
        );
        assert_eq!(HOME, "printf %s \"$HOME\"");
        assert!(
            STATUS.ends_with("acp status 2>&1"),
            "stderr is folded in so an old host can be told apart"
        );
    }

    #[test]
    fn the_sessions_command_quotes_a_hostile_folder_and_folds_stderr_in() {
        let command = sessions_command("/tmp/it's $(rm -rf ~)", 20, &CLAUDE);
        assert!(command.contains(" sessions '/tmp/it'\"'\"'s $(rm -rf ~)' --limit 20"));
        assert!(command.ends_with("2>&1"));
    }

    #[test]
    fn the_sessions_command_names_the_agent_unless_it_is_claude() {
        let claude = sessions_command("/x", 20, &CLAUDE);
        assert_eq!(
            claude,
            "PATH=\"$HOME/.local/bin:$PATH\" tether acp sessions '/x' --limit 20 2>&1"
        );
        assert!(!claude.contains("--agent-cmd"));
        assert_eq!(
            sessions_command("/x", 20, &agent::CODEX),
            "PATH=\"$HOME/.local/bin:$PATH\" tether acp sessions '/x' --limit 20 --agent-cmd 'npx -y @agentclientprotocol/codex-acp@2.3.0' 2>&1"
        );
        assert!(
            sessions_command("/x", 5, &agent::OPENCODE)
                .contains(r#"--agent-cmd 'PATH="$HOME/.opencode/bin:$PATH" opencode acp' 2>&1"#)
        );
    }

    #[test]
    fn attach_spawns_the_picked_agent() {
        let command = attach_command("c", "/x", Some(&agent::OPENCODE), 0, None);
        assert!(
            command
                .contains(r#"--spawn 'PATH="$HOME/.opencode/bin:$PATH" opencode acp' --cwd '/x'"#)
        );
        let command = attach_command("c", "/x", Some(&agent::CODEX), 0, None);
        assert!(command.contains("--spawn 'npx -y @agentclientprotocol/codex-acp@2.3.0'"));
    }

    #[test]
    fn status_lines_carry_the_agents_spawn_command() {
        let line =
            r#"{"name":"c1","state":"running","spawn":"opencode acp","logBytes":3,"cwd":"/x"}"#;
        let listing = parse_status(line);
        assert_eq!(listing.chats[0].spawn, "opencode acp");
        let old = parse_status(r#"{"name":"c2","state":"running"}"#);
        assert_eq!(old.chats[0].spawn, "");
    }

    #[test]
    fn drawer_rows_name_a_chats_agent_from_the_local_record_then_the_hosts_spawn() {
        let mut codex = ChatSummary::new("c1", "/srv/app");
        codex.spawn = agent::CODEX.spawn.to_string();
        let plain = ChatSummary::new("c2", "/srv/api");
        let mut local = ChatSummary::new("c3", "/srv/docs");
        local.spawn = String::new();
        let mut unknown = ChatSummary::new("c4", "/srv/x");
        unknown.spawn = "mystery --acp".into();
        let rows = drawer_rows(
            &[codex, plain, local, unknown],
            &HashMap::new(),
            &HashMap::from([("c3".to_string(), "opencode".to_string())]),
        );
        let agents: Vec<_> = rows.iter().map(|r| agent::key(r.agent)).collect();
        assert_eq!(agents, ["codex", "claude", "opencode", ""]);
        assert_eq!(rows[0].subtitle, "Codex \u{b7} /srv");
        assert_eq!(rows[1].subtitle, "/srv");
        assert_eq!(rows[2].subtitle, "opencode \u{b7} /srv");
        assert_eq!(rows[3].subtitle, "Agent \u{b7} /srv");
    }

    #[test]
    fn answer_commands_quote_every_value() {
        assert_eq!(
            answers_command("a b;c"),
            "PATH=\"$HOME/.local/bin:$PATH\" tether acp answers 'a b;c' 2>/dev/null"
        );
        assert_eq!(
            answer_command("chat x", "\"a b\"", "opt'1"),
            "PATH=\"$HOME/.local/bin:$PATH\" tether acp answer 'chat x' --request '\"a b\"' --option 'opt'\"'\"'1'"
        );
    }

    #[test]
    fn answers_output_maps_request_ids_and_ignores_garbage() {
        assert_eq!(
            parse_answers("motd\n{\"0\":\"allow-once\",\"\\\"abc\\\"\":\"cancelled\"}\n"),
            HashMap::from([
                (AcpId::Int(0), "allow-once".to_string()),
                (AcpId::Str("abc".into()), "cancelled".to_string())
            ])
        );
        assert!(parse_answers("{}").is_empty());
        assert!(parse_answers("Usage: acp answers").is_empty());
        assert!(parse_answers("{\"0\": 5}").is_empty());
        assert!(parse_answers("").is_empty());
        assert_eq!(id_from_json_text("bare"), AcpId::Str("bare".into()));
    }

    #[test]
    fn listing_parses_tab_separated_lines_newest_first() {
        let output = "chat-old\tended\t120\t/srv/api\t1700000000\tnpx -y agent\nchat-new\trunning\t9000\t/home/sam/site\t1700005000\tnpx -y agent --flag";
        let listing = parse_listing(output);
        let names: Vec<_> = listing.chats.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["chat-new", "chat-old"]);
        assert!(listing.chats[0].is_running);
        assert_eq!(listing.chats[0].log_bytes, 9000);
        assert_eq!(listing.chats[0].title(), "site");
        assert_eq!(listing.chats[0].spawn, "npx -y agent --flag");
        assert_eq!(listing.chats[0].created, 1_700_005_000);
        assert!(!listing.chats[1].is_running);
        assert!(listing.skipped.is_empty());
    }

    #[test]
    fn listing_keeps_a_chat_with_no_spawn_field_and_skips_garbage() {
        let listing = parse_listing(
            "c\trunning\t1\t/x\t5\nzsh: command not found: tether\nc2\tpaused\t1\t/x\t5\n",
        );
        assert_eq!(listing.chats.len(), 1);
        assert_eq!(listing.chats[0].name, "c");
        assert_eq!(listing.chats[0].spawn, "");
        assert_eq!(listing.skipped.len(), 2);
        assert!(parse_listing("").chats.is_empty());
        let crlf = parse_listing("c\trunning\t1\t/x\t5\r\nd\tended\t2\t/y\t6\r\n");
        assert_eq!(crlf.chats.len(), 2);
    }

    const WORKING: &str = r#"{"name":"chat-a","state":"running","turn":"working","title":"","cwd":"/srv/api","created":300,"logBytes":10,"endedReason":""}"#;
    const WAITING: &str = r#"{"name":"chat-b","state":"running","turn":"waiting","title":"Migrate the docs","cwd":"/srv/docs","created":200,"logBytes":10,"endedReason":""}"#;
    const ENDED: &str = r#"{"name":"chat-c","state":"ended","turn":"idle","title":"","cwd":"/srv/app","created":100,"logBytes":10,"endedReason":"agent exited"}"#;

    fn all_status() -> Vec<ChatSummary> {
        parse_status(&[ENDED, WORKING, WAITING].join("\n")).chats
    }

    #[test]
    fn status_tasks_default_to_zero_and_an_idle_chat_with_tasks_is_tagged() {
        let idle = r#"{"name":"chat-d","state":"running","turn":"idle","title":"","cwd":"/srv/x","created":50,"logBytes":1,"tasks":2}"#;
        let one = r#"{"name":"chat-e","state":"running","turn":"idle","title":"","cwd":"/srv/y","created":40,"logBytes":1,"tasks":1}"#;
        let busy = r#"{"name":"chat-f","state":"running","turn":"working","title":"","cwd":"/srv/z","created":30,"logBytes":1,"tasks":3}"#;
        let chats = parse_status(&[WORKING, idle, one, busy].join("\n")).chats;
        let tasks: Vec<_> = chats.iter().map(|c| c.tasks).collect();
        assert_eq!(tasks, [0, 2, 1, 3]);
        let rows = drawer_rows(&chats, &HashMap::new(), &HashMap::new());
        let tags: Vec<_> = rows.iter().map(DrawerChatRow::tag).collect();
        assert_eq!(tags, ["working", "2 tasks", "1 task", "working"]);
        assert!(!others_waiting(&chats, None));
    }

    #[test]
    fn status_lines_become_summaries_newest_first() {
        let result = parse_status(&[ENDED, WORKING, WAITING].join("\n"));
        assert!(!result.unsupported);
        let names: Vec<_> = result.chats.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["chat-a", "chat-b", "chat-c"]);
        let turns: Vec<_> = result.chats.iter().map(|c| c.turn).collect();
        assert_eq!(
            turns,
            [HostTurn::Working, HostTurn::Waiting, HostTurn::Idle]
        );
        let running: Vec<_> = result.chats.iter().map(|c| c.is_running).collect();
        assert_eq!(running, [true, true, false]);
        assert_eq!(
            result.chats[1].host_title.as_deref(),
            Some("Migrate the docs")
        );
        assert_eq!(result.chats[0].host_title, None);
        assert!(result.chats.iter().all(|c| c.has_status));
        assert_eq!(result.chats[0].cwd, "/srv/api");
        assert_eq!(result.chats[0].created, 300);
        assert_eq!(result.chats[0].log_bytes, 10);
    }

    #[test]
    fn an_old_host_reads_as_unsupported_but_a_host_with_no_chats_does_not() {
        assert!(parse_status("tether: unknown acp command \"status\"").unsupported);
        assert!(parse_status("sh: tether: command not found").unsupported);
        assert!(!parse_status("").unsupported);
        assert!(!parse_status("\n").unsupported);
        assert!(parse_status("").chats.is_empty());
    }

    #[test]
    fn a_stray_line_beside_real_ones_is_ignored() {
        let result = parse_status(&format!("warning: something\n{WORKING}"));
        assert!(!result.unsupported);
        assert_eq!(result.chats.len(), 1);
        assert_eq!(result.chats[0].name, "chat-a");
    }

    #[test]
    fn a_missing_turn_reads_as_idle_and_an_unknown_state_is_skipped() {
        let bare = r#"{"name":"chat-d","state":"running","cwd":"/x","created":1}"#;
        let odd = r#"{"name":"chat-e","state":"paused","turn":"idle","cwd":"/x","created":1}"#;
        let result = parse_status(&format!("{bare}\n{odd}"));
        assert_eq!(result.chats.len(), 1);
        assert_eq!(result.chats[0].name, "chat-d");
        assert_eq!(result.chats[0].turn, HostTurn::Idle);
    }

    #[test]
    fn rows_carry_the_state_and_the_host_title_wins_over_the_stored_one() {
        let chats = parse_status(&[WORKING, WAITING, ENDED].join("\n")).chats;
        let titles = HashMap::from([
            ("chat-a".to_string(), "Stored title".to_string()),
            ("chat-b".to_string(), "Stored title".to_string()),
        ]);
        let rows = drawer_rows(&chats, &titles, &HashMap::new());
        let states: Vec<_> = rows.iter().map(|r| r.state).collect();
        assert_eq!(
            states,
            [
                DrawerChatState::Working,
                DrawerChatState::Waiting,
                DrawerChatState::Ended
            ]
        );
        let labels: Vec<_> = rows.iter().map(|r| r.state_label()).collect();
        assert_eq!(labels, ["working", "needs you", "ended"]);
        assert_eq!(rows[0].title, "Stored title");
        assert_eq!(rows[1].title, "Migrate the docs");
        assert_eq!(rows[2].title, "app");
    }

    #[test]
    fn a_running_chat_with_no_status_shows_running_and_an_idle_one_shows_idle() {
        let mut legacy = ChatSummary::new("l", "/x");
        legacy.created = 1;
        assert_eq!(DrawerChatState::of(&legacy), DrawerChatState::Running);
        let mut idle = legacy.clone();
        idle.has_status = true;
        assert_eq!(DrawerChatState::of(&idle), DrawerChatState::Idle);
        assert_eq!(DrawerChatState::Idle.label(), "idle");
        let mut gone = idle;
        gone.is_running = false;
        assert_eq!(DrawerChatState::of(&gone), DrawerChatState::Ended);
    }

    #[test]
    fn the_drawer_button_flags_a_waiting_chat_other_than_the_open_one() {
        let chats = all_status();
        assert!(others_waiting(&chats, None));
        assert!(others_waiting(&chats, Some("chat-a")));
        assert!(!others_waiting(&chats, Some("chat-b")));
        assert!(!others_waiting(&[], None));
        let mut ended = parse_status(WAITING).chats.remove(0);
        ended.is_running = false;
        assert!(
            !others_waiting(&[ended], None),
            "an ended chat does not flag the button"
        );
    }

    fn chat(name: &str, cwd: &str, running: bool) -> ChatSummary {
        ChatSummary {
            is_running: running,
            created: 1,
            spawn: CLAUDE.spawn.into(),
            log_bytes: 1,
            ..ChatSummary::new(name, cwd)
        }
    }

    #[test]
    fn a_stored_title_wins_and_the_folder_becomes_the_subtitle() {
        let rows = drawer_rows(
            &[
                chat("chat-a", "/srv/api-server", true),
                chat("chat-b", "/srv/app", false),
            ],
            &HashMap::from([("chat-a".to_string(), "Add retry to fetchJSON".to_string())]),
            &HashMap::new(),
        );
        assert_eq!(rows[0].title, "Add retry to fetchJSON");
        assert_eq!(rows[0].subtitle, "api-server");
        assert_eq!(rows[0].state_label(), "running");
        assert!(rows[0].is_running());
        assert_eq!(rows[1].title, "app");
        assert_eq!(rows[1].subtitle, "/srv");
        assert_eq!(rows[1].state_label(), "ended");
        assert!(!rows[1].is_running());
    }

    #[test]
    fn a_chat_in_home_falls_back_to_a_readable_title() {
        let rows = drawer_rows(
            &[chat("c", "/", true)],
            &HashMap::from([("c".to_string(), String::new())]),
            &HashMap::new(),
        );
        assert_eq!(rows[0].title, "/");
        assert_eq!(rows[0].subtitle, "/");
    }

    fn session_line(id: &str, title: &str, updated: &str) -> String {
        format!(
            r#"{{"sessionId":"{id}","title":"{title}","updatedAt":"{updated}","cwd":"/srv/api"}}"#
        )
    }

    #[test]
    fn saved_sessions_parse_with_and_without_fractional_seconds() {
        let output = [
            session_line("s-1", "Add retry", "2027-01-15T08:00:00.123Z"),
            session_line("s-2", "", "2027-01-14T08:00:00Z"),
        ]
        .join("\n");
        let result = parse_saved_sessions(&output);
        assert_eq!(result.failure, None);
        let ids: Vec<_> = result
            .sessions
            .iter()
            .map(|s| s.session_id.as_str())
            .collect();
        assert_eq!(ids, ["s-1", "s-2"]);
        assert_eq!(result.sessions[0].display_title(), "Add retry");
        assert_eq!(result.sessions[1].display_title(), "Untitled conversation");
        assert_eq!(
            result.sessions[0].updated_at.unwrap() - result.sessions[1].updated_at.unwrap(),
            86_400
        );
    }

    #[test]
    fn iso_dates_handle_offsets_and_reject_junk() {
        assert_eq!(parse_iso8601("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_iso8601("2000-03-01T00:00:00Z"), Some(951_868_800));
        assert_eq!(parse_iso8601("1970-01-01T01:00:00+01:00"), Some(0));
        assert_eq!(parse_iso8601("1969-12-31T23:30:00-00:30"), Some(0));
        for bad in [
            "",
            "2027-01-15",
            "2027-01-15 08:00:00Z",
            "2027-13-15T08:00:00Z",
            "2027-01-15T08:00:00",
            "2027-01-15T08:00:00.Z",
            "nope",
        ] {
            assert_eq!(parse_iso8601(bad), None, "{bad}");
        }
    }

    #[test]
    fn no_output_is_an_empty_list_and_a_failure_line_is_the_reason() {
        assert_eq!(
            parse_saved_sessions(""),
            SavedSessions {
                sessions: vec![],
                failure: None
            }
        );
        let failed = parse_saved_sessions("tether: agent exited before listing sessions");
        assert_eq!(
            failed.failure.as_deref(),
            Some("agent exited before listing sessions")
        );
        assert!(failed.sessions.is_empty());
        assert!(
            parse_saved_sessions("tether: unknown acp command \"sessions\"")
                .failure
                .unwrap()
                .contains("Update it")
        );
        let long = parse_saved_sessions(&"x".repeat(200));
        assert_eq!(long.failure.unwrap().chars().count(), 161);
    }

    #[test]
    fn a_stray_line_beside_sessions_is_not_a_failure() {
        let result = parse_saved_sessions(&format!(
            "npm warn something\n{}",
            session_line("s-1", "x", "2027-01-15T08:00:00Z")
        ));
        assert_eq!(result.failure, None);
        assert_eq!(result.sessions.len(), 1);
    }

    const NOW: i64 = 1_800_000_000;

    #[test]
    fn a_conversation_updated_within_ten_minutes_gets_the_caution() {
        assert!(is_recent(Some(NOW - 60), NOW));
        assert!(is_recent(Some(NOW - 599), NOW));
        assert!(!is_recent(Some(NOW - 601), NOW));
        assert!(!is_recent(None, NOW));
        assert!(RECENT_NOTE.starts_with("Updated minutes ago"));
    }

    #[test]
    fn relative_times_read_naturally() {
        let ago = |s: i64| continue_relative(Some(NOW - s), NOW);
        assert_eq!(ago(10), "just now");
        assert_eq!(ago(300), "5 min ago");
        assert_eq!(ago(7300), "2 h ago");
        assert_eq!(ago(86_400 * 3), "3 d ago");
        assert_eq!(continue_relative(None, NOW), "");
        let old = parse_iso8601("2027-01-15T08:00:00Z").unwrap();
        assert_eq!(continue_relative(Some(old), old + 86_400 * 20), "Jan 15");
    }

    #[test]
    fn cwd_expands_tilde_against_the_host_home() {
        assert_eq!(expand_cwd("~", "/home/sam"), "/home/sam");
        assert_eq!(expand_cwd("  ", "/home/sam"), "/home/sam");
        assert_eq!(expand_cwd("~/code/app/", "/home/sam"), "/home/sam/code/app");
        assert_eq!(expand_cwd("/srv/api", "/home/sam"), "/srv/api");
        assert_eq!(expand_cwd("/", "/home/sam"), "/");
        assert!(needs_home("~/x"));
        assert!(!needs_home("/srv"));
        assert!(needs_home(""));
    }

    #[test]
    fn a_chat_without_a_local_session_joins_a_shared_holder_and_reads_an_old_one() {
        assert_eq!(open_mode(&Journal::default(), false), OpenMode::ReadOnly);
        assert_eq!(open_mode(&Journal::default(), true), OpenMode::Join);
        let journal = Journal {
            session_id: Some("s".into()),
            ..Journal::default()
        };
        assert_eq!(open_mode(&journal, true), OpenMode::Resume);
        let asked = Journal {
            next_request_id: 3,
            ..Journal::default()
        };
        assert_eq!(open_mode(&asked, false), OpenMode::Resume);
    }

    #[test]
    fn a_new_chat_name_is_chat_and_six_lowercase_alphanumerics() {
        let a = new_chat_name();
        assert!(a.starts_with("chat-"));
        assert_eq!(a.len(), 11);
        assert!(
            a[5..]
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        );
        assert_ne!(a, new_chat_name());
    }

    const OURS: &str = "tether=found\nversion={\"name\":\"tether\",\"version\":\"v6.1.0\",\"protocol\":1}\nnode=ok\n";

    #[test]
    fn the_command_runs_a_quoted_posix_script_whatever_the_login_shell() {
        assert!(
            !HOST_CHECK_SCRIPT.contains('\''),
            "the script must survive single-quote wrapping"
        );
        assert_eq!(
            host_check_command(),
            format!("sh -c {}", shell_quote(HOST_CHECK_SCRIPT))
        );
        assert!(HOST_CHECK_SCRIPT.contains("command -v npx"));
        assert!(HOST_CHECK_SCRIPT.contains("tether version --json"));
        assert!(HOST_CHECK_SCRIPT.contains("timeout 5"));
        assert!(HOST_CHECK_SCRIPT.starts_with("PATH=\"$HOME/.local/bin:$PATH\"; export PATH"));
        assert_eq!(
            HOST_CHECK_SCRIPT,
            [
                "PATH=\"$HOME/.local/bin:$PATH\"; export PATH",
                "T=\"\"; if command -v timeout >/dev/null 2>&1; then T=\"timeout 5\"; fi",
                "if command -v tether >/dev/null 2>&1; then echo tether=found; echo \"version=$($T tether version --json </dev/null 2>/dev/null | head -n 1)\"; else echo tether=missing; fi",
                "if command -v npx >/dev/null 2>&1; then echo node=ok; else echo node=missing; fi",
                "if command -v opencode >/dev/null 2>&1 || [ -x \"$HOME/.opencode/bin/opencode\" ] || PATH=\"$HOME/.opencode/bin:$PATH\" $T \"${SHELL:-sh}\" -lc \"command -v opencode\" </dev/null >/dev/null 2>&1; then echo opencode=ok; else echo opencode=missing; fi",
            ]
            .join("; ")
        );
    }

    #[test]
    fn a_protocol_two_host_starts_shared_holders() {
        assert!(!host_multi_client(OURS));
        assert!(host_multi_client(
            "tether=found\nversion={\"name\":\"tether\",\"version\":\"v6.2.0\",\"protocol\":2}\nnode=ok\n"
        ));
        assert!(!host_multi_client("tether=missing\n"));
        let listing = parse_status(concat!(
            r#"{"name":"chat-a","state":"running","cwd":"/w","created":2,"multiClient":true}"#,
            "\n",
            r#"{"name":"chat-b","state":"running","cwd":"/w","created":1}"#,
        ));
        assert!(listing.chats[0].multi_client);
        assert!(
            !listing.chats[1].multi_client,
            "a holder from an older tether"
        );
    }

    #[test]
    fn the_report_parses_into_problems() {
        use HostProblem::*;
        assert_eq!(host_problems(OURS), []);
        assert_eq!(
            host_problems(
                "tether=found\nversion={\"name\":\"tether\",\"version\":\"dev\",\"protocol\":7}\nnode=ok"
            ),
            [],
            "a newer protocol is fine"
        );
        assert_eq!(host_problems("tether=missing\nnode=ok\n"), [TetherMissing]);
        assert_eq!(
            host_problems("tether=found\nversion=\nnode=ok\n"),
            [TetherForeign],
            "no JSON: the retired v4 server"
        );
        assert_eq!(
            host_problems(
                "tether=found\nversion=tether \u{2014} persistent remote-shell server (v4.9)\nnode=ok\n"
            ),
            [TetherForeign]
        );
        assert_eq!(
            host_problems("tether=found\nversion={\"name\":\"other\",\"protocol\":9}\n"),
            [TetherForeign],
            "valid JSON for another tool is still not ours"
        );
        assert_eq!(
            host_problems(
                "tether=found\nversion={\"name\":\"tether\",\"version\":\"x\",\"protocol\":0}\nnode=missing\n"
            ),
            [TetherOutdated, NodeMissing]
        );
        assert_eq!(
            host_problems("tether=found\nversion={\"name\":\"tether\",\"version\":\"x\"}\n"),
            [TetherOutdated],
            "no protocol number reads as too old"
        );
        assert_eq!(host_problems("node=missing"), [NodeMissing]);
        assert_eq!(
            host_problems_for("node=missing", &agent::CODEX),
            [NodeMissing]
        );
        assert!(host_problems_for("node=missing", &agent::COPILOT).is_empty());
        assert_eq!(
            host_problems_for("tether=missing\nnode=missing", &agent::OPENCODE),
            [TetherMissing]
        );
        assert_eq!(host_problems("  tether=missing \r\n"), [TetherMissing]);
        assert_eq!(
            host_problems(""),
            [],
            "a host that said nothing is not blamed"
        );
        assert_eq!(host_problems(&format!("welcome back!\n{OURS}")), []);
    }

    #[test]
    fn the_report_judges_only_what_the_picked_agent_needs() {
        use HostProblem::*;
        let missing = format!("{OURS}opencode=missing\n");
        assert_eq!(host_problems(&missing), [OpencodeMissing]);
        assert_eq!(
            host_problems_for(&missing, &agent::OPENCODE),
            [OpencodeMissing]
        );
        assert_eq!(host_problems_for(&missing, &agent::CLAUDE), []);
        assert_eq!(host_problems_for(&missing, &agent::CODEX), []);
        let no_node = "node=missing\nopencode=ok\n";
        assert_eq!(host_problems_for(no_node, &agent::CODEX), [NodeMissing]);
        assert_eq!(host_problems_for(no_node, &agent::OPENCODE), []);
        assert_eq!(host_problems(&format!("{OURS}opencode=ok\n")), []);
        assert!(HOST_CHECK_SCRIPT.contains("$HOME/.opencode/bin/opencode"));
        assert!(HOST_CHECK_SCRIPT.contains(r#"-lc "command -v opencode""#));
        assert!(!HOST_CHECK_SCRIPT.contains('\''));
    }

    #[test]
    fn each_problem_has_a_plain_message_naming_the_host() {
        use HostProblem::*;
        assert_eq!(host_problem_message(&[], "box"), None);
        let msg = |p: &[HostProblem]| host_problem_message(p, "box").unwrap();
        assert_eq!(
            msg(&[TetherMissing]),
            "Install tether on box (install.sh). tether-notify is now called tether."
        );
        assert_eq!(
            msg(&[TetherForeign]),
            "Another program named tether is installed on box (the old Tether server). Run install.sh there to replace it."
        );
        assert_eq!(msg(&[TetherOutdated]), "Update tether on box (install.sh).");
        assert_eq!(msg(&[NodeMissing]), "Node.js is required on box.");
        assert_eq!(
            msg(&[OpencodeMissing]),
            "Install opencode on box (opencode.ai), or check it is on the PATH of a login shell."
        );
        assert_eq!(
            msg(&[TetherMissing, NodeMissing]),
            "Install tether on box (install.sh). tether-notify is now called tether. Node.js is required on box."
        );
    }

    #[test]
    fn a_host_with_a_too_old_tether_explains_itself_in_the_list() {
        let message = explain_list_line("tether: unknown command \"acp\"", Some("box"));
        assert!(message.starts_with("Update tether on box."));
        assert!(explain_list_line("usage: ...", None).starts_with("This host's tether is missing"));
        assert_eq!(
            explain_list_line("something else", Some("box")),
            "something else"
        );
    }
}
