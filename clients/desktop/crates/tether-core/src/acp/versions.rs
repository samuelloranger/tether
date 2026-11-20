//! Host-managed agent versions: the `tether acp versions | update | options` commands, what they
//! print, and what this device remembers per host (whether it manages versions, and which update
//! notices the user waved off). Nothing here updates anything: only the Update button does.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::agent::AgentProfile;
use super::host::TETHER;
use super::message::{ConfigOption, parse_config_options};
use crate::zmx::shell_quote;

/// `update` can run `npm install`; the host gives up on its own, this is only the ssh deadline.
pub const UPDATE_DEADLINE_SECS: u64 = 6 * 60;
/// The host allows an adapter 45 s to answer `options`.
pub const OPTIONS_DEADLINE_SECS: u64 = 60;
pub const VERSIONS_DEADLINE_SECS: u64 = 30;

/// `|| true` keeps stdout of a failing command: an exec that exits non-zero loses it.
pub fn versions_command() -> String {
    format!("{TETHER} versions 2>&1 || true")
}

/// `cli`: the host's own agent CLI, updated by the CLI's updater; else the ACP adapter chats run.
pub fn update_command(agent: &AgentProfile, kind: Kind) -> String {
    let cli = if kind == Kind::Cli { " --cli" } else { "" };
    format!("{TETHER} update {}{cli} 2>&1 || true", agent.key)
}

/// What a version line is about: the adapter a chat spawns, or the agent CLI installed on the host.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Kind {
    #[default]
    Adapter,
    Cli,
}

impl Kind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Adapter => "adapter",
            Self::Cli => "cli",
        }
    }

    pub fn from_index(i: i32) -> Self {
        if i == 1 { Self::Cli } else { Self::Adapter }
    }

    pub fn index(self) -> i32 {
        self as i32
    }
}

fn cli_label(agent: &str) -> String {
    match agent {
        "claude" => "Claude Code CLI".into(),
        "codex" => "Codex CLI".into(),
        other => format!("{other} CLI"),
    }
}

pub fn options_command(cwd: &str, agent: &AgentProfile, managed: bool) -> String {
    format!(
        "{TETHER} options {} --agent-cmd {} 2>&1 || true",
        shell_quote(cwd),
        shell_quote(agent.spawn_for(managed))
    )
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct AgentVersion {
    pub kind: Kind,
    pub agent: String,
    pub version: String,
    /// The engine the adapter bundles, e.g. `Codex 0.164.0`.
    pub engine: String,
    pub latest: String,
    pub update_available: bool,
    /// A CLI's own updater, which the user runs when `runnable` is false.
    pub command: String,
    pub runnable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Versions {
    /// `None` when the output says nothing either way (a failed read): the stored answer stands.
    pub supported: Option<bool>,
    pub agents: Vec<AgentVersion>,
}

impl Versions {
    pub fn get(&self, kind: Kind, agent: &str) -> Option<&AgentVersion> {
        self.agents
            .iter()
            .find(|a| a.kind == kind && a.agent == agent)
    }
}

fn json_lines(output: &str) -> impl Iterator<Item = Value> + '_ {
    output
        .lines()
        .map(str::trim)
        .filter(|l| l.starts_with('{'))
        .filter_map(|l| serde_json::from_str(l).ok())
}

fn text(v: &Value, key: &str) -> String {
    v.get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// A host too old for the command prints `unknown acp command "versions"` or a usage line.
pub fn parse_versions(output: &str) -> Versions {
    let agents: Vec<AgentVersion> = json_lines(output)
        .filter(|v| v.get("agent").is_some())
        .map(|v| AgentVersion {
            // A host from before the CLI lines has adapters only, and says no kind.
            kind: if text(&v, "kind") == "cli" {
                Kind::Cli
            } else {
                Kind::Adapter
            },
            agent: text(&v, "agent"),
            version: text(&v, "version"),
            engine: text(&v, "engine"),
            latest: text(&v, "latest"),
            update_available: v
                .get("updateAvailable")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            command: text(&v, "command"),
            runnable: v.get("runnable").and_then(Value::as_bool).unwrap_or(false),
        })
        .collect();
    if !agents.is_empty() {
        return Versions {
            supported: Some(true),
            agents,
        };
    }
    let lower = output.to_lowercase();
    let old = lower.contains("unknown acp command")
        || lower.contains("usage:")
        || lower.contains("unknown command");
    Versions {
        supported: old.then_some(false),
        agents: Vec::new(),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Updated {
    pub from: String,
    pub to: String,
}

impl Updated {
    pub fn sentence(&self) -> String {
        if self.from == self.to {
            format!("Already on {}", self.to)
        } else {
            format!("Updated to {}", self.to)
        }
    }
}

/// `{"agent","from","to"}` on success; anything else is the error text to show.
pub fn parse_update(output: &str) -> Result<Updated, String> {
    if let Some(v) = json_lines(output).find(|v| v.get("to").is_some()) {
        return Ok(Updated {
            from: text(&v, "from"),
            to: text(&v, "to"),
        });
    }
    let first = output.lines().map(str::trim).find(|l| !l.is_empty());
    Err(match first {
        None => "The host didn't confirm the update.".into(),
        Some(line) => {
            let line = line.replace("tether: ", "");
            if line.chars().count() > 160 {
                format!("{}\u{2026}", line.chars().take(160).collect::<String>())
            } else {
                line
            }
        }
    })
}

/// The options a new session of the agent starts with; `None` for anything but the host's
/// `{"configOptions":[…]}` line, so a failure keeps what the dialog already shows.
pub fn parse_options(output: &str) -> Option<Vec<ConfigOption>> {
    json_lines(output).find_map(|v| match v {
        Value::Object(o) => parse_config_options(&o),
        _ => None,
    })
}

/// What the dialog says under the agent picker for an update waiting.
pub fn update_line(profile: &AgentProfile, v: &AgentVersion) -> String {
    if v.kind == Kind::Cli {
        return format!(
            "{} {} available \u{b7} you have {}",
            cli_label(&v.agent),
            v.latest,
            v.version
        );
    }
    let engine = if v.engine.is_empty() {
        String::new()
    } else {
        format!(" ({})", v.engine)
    };
    format!(
        "{} adapter {} available \u{b7} you have {}{engine}",
        profile.label, v.latest, v.version
    )
}

/// Per host (`host:port`): whether it manages agent versions, and the update notices dismissed.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct ManagedState {
    supported: BTreeMap<String, bool>,
    /// host → `kind:agent` → the `latest` version the user said Not now to.
    dismissed: BTreeMap<String, BTreeMap<String, String>>,
}

impl ManagedState {
    pub fn supported(&self, host: &str) -> Option<bool> {
        self.supported.get(host).copied()
    }

    /// True when the stored answer changed and is to be saved.
    pub fn set_supported(&mut self, host: &str, supported: bool) -> bool {
        self.supported.insert(host.to_string(), supported) != Some(supported)
    }

    pub fn is_dismissed(&self, host: &str, kind: Kind, agent: &str, version: &str) -> bool {
        self.dismissed
            .get(host)
            .and_then(|h| h.get(&format!("{}:{agent}", kind.as_str())))
            .is_some_and(|v| v == version)
    }

    pub fn dismiss(&mut self, host: &str, kind: Kind, agent: &str, version: &str) -> bool {
        let slot = self
            .dismissed
            .entry(host.to_string())
            .or_default()
            .entry(format!("{}:{agent}", kind.as_str()))
            .or_default();
        let changed = slot != version;
        *slot = version.to_string();
        changed
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::agent::{CLAUDE, CODEX};

    const CODEX_LINE: &str = r#"{"agent":"codex","package":"@agentclientprotocol/codex-acp","version":"2.3.0","managed":false,"engine":"Codex 0.164.0","latest":"2.8.0","checkedAt":1,"updateAvailable":true}"#;
    const CLAUDE_LINE: &str = r#"{"kind":"adapter","agent":"claude","package":"p","version":"0.95.0","managed":true,"engine":"Claude Code 2.1.309","previous":"0.94.0","latest":"0.95.0","updateAvailable":false,"error":"offline"}"#;

    const CLI_LINE: &str = r#"{"kind":"cli","agent":"claude","package":"@anthropic-ai/claude-code","version":"2.1.327","latest":"2.1.329","updateAvailable":true,"command":"claude update","runnable":true}"#;
    const CODEX_CLI_LINE: &str = r#"{"kind":"cli","agent":"codex","version":"0.164.0","latest":"0.170.0","updateAvailable":true,"command":"npm install -g @openai/codex@latest","runnable":false}"#;

    #[test]
    fn cli_and_adapter_lines_of_one_agent_stay_apart() {
        let v = parse_versions(&format!("{CLAUDE_LINE}\n{CLI_LINE}\n{CODEX_CLI_LINE}\n"));
        let adapter = v.get(Kind::Adapter, "claude").unwrap();
        assert_eq!(adapter.version, "0.95.0");
        assert!(!adapter.update_available);
        let cli = v.get(Kind::Cli, "claude").unwrap();
        assert_eq!(cli.version, "2.1.327");
        assert!(cli.update_available && cli.runnable);
        assert_eq!(cli.command, "claude update");
        let codex = v.get(Kind::Cli, "codex").unwrap();
        assert!(!codex.runnable);
        assert_eq!(codex.command, "npm install -g @openai/codex@latest");
        assert!(v.get(Kind::Adapter, "codex").is_none());
        assert_eq!(
            update_line(&CLAUDE, cli),
            "Claude Code CLI 2.1.329 available \u{b7} you have 2.1.327"
        );
        assert_eq!(cli_label("opencode"), "opencode CLI");
        assert_eq!(cli_label("copilot"), "copilot CLI");
    }

    #[test]
    fn versions_read_one_line_per_agent() {
        let v = parse_versions(&format!("{CLAUDE_LINE}\n{CODEX_LINE}\n"));
        assert_eq!(v.supported, Some(true));
        let codex = v.get(Kind::Adapter, "codex").unwrap();
        assert_eq!(codex.version, "2.3.0");
        assert_eq!(codex.latest, "2.8.0");
        assert_eq!(codex.engine, "Codex 0.164.0");
        assert!(codex.update_available);
        assert!(!v.get(Kind::Adapter, "claude").unwrap().update_available);
        assert!(v.get(Kind::Adapter, "opencode").is_none());
    }

    #[test]
    fn an_old_host_is_told_apart_from_a_failed_read() {
        for old in [
            "unknown acp command \"versions\"\n",
            "usage: tether acp <command>\n",
            "tether: unknown command versions",
        ] {
            assert_eq!(parse_versions(old).supported, Some(false), "{old}");
        }
        assert_eq!(parse_versions("").supported, None);
        assert_eq!(parse_versions("npm ERR! network").supported, None);
    }

    #[test]
    fn update_reports_the_new_version_or_the_error_text() {
        let ok =
            parse_update("{\"agent\":\"codex\",\"from\":\"2.3.0\",\"to\":\"2.8.0\"}\n").unwrap();
        assert_eq!(ok.sentence(), "Updated to 2.8.0");
        assert_eq!(
            Updated {
                from: "2.8.0".into(),
                to: "2.8.0".into()
            }
            .sentence(),
            "Already on 2.8.0"
        );
        assert_eq!(
            parse_update("tether: npm install failed\nmore").unwrap_err(),
            "npm install failed"
        );
        assert_eq!(
            parse_update("").unwrap_err(),
            "The host didn't confirm the update."
        );
        assert!(
            parse_update(&"x".repeat(300))
                .unwrap_err()
                .ends_with('\u{2026}')
        );
    }

    #[test]
    fn options_come_from_the_config_options_line_only() {
        let line = r#"{"configOptions":[{"id":"model","name":"Model","type":"select","currentValue":"a","options":[{"value":"a","name":"A"},{"value":"b","name":"B"}]}]}"#;
        let options = parse_options(&format!("noise\n{line}\n")).unwrap();
        assert_eq!(options.len(), 1);
        assert_eq!(options[0].id, "model");
        assert_eq!(options[0].choices.len(), 2);
        assert!(parse_options("agent exited before starting a session").is_none());
        assert!(parse_options("{\"other\":1}").is_none());
    }

    #[test]
    fn commands_spawn_the_managed_agent_only_on_a_supporting_host() {
        assert_eq!(
            versions_command(),
            "PATH=\"$HOME/.local/bin:$PATH\" tether acp versions 2>&1 || true"
        );
        assert!(update_command(&CODEX, Kind::Adapter).contains(" update codex 2>&1"));
        assert!(update_command(&CODEX, Kind::Cli).contains(" update codex --cli 2>&1"));
        assert!(
            options_command("/x y", &CODEX, true)
                .contains("options '/x y' --agent-cmd 'tether acp agent codex' 2>&1")
        );
        assert!(options_command("/x", &CLAUDE, false).contains("claude-agent-acp@"));
    }

    #[test]
    fn the_update_line_names_the_adapter_and_the_engine() {
        let v = parse_versions(CODEX_LINE).agents.remove(0);
        assert_eq!(
            update_line(&CODEX, &v),
            "Codex adapter 2.8.0 available \u{b7} you have 2.3.0 (Codex 0.164.0)"
        );
    }

    #[test]
    fn dismissal_is_per_host_kind_agent_and_version() {
        let mut s = ManagedState::default();
        let a = Kind::Adapter;
        assert!(!s.is_dismissed("h:22", a, "codex", "2.8.0"));
        assert!(s.dismiss("h:22", a, "codex", "2.8.0"));
        assert!(!s.dismiss("h:22", a, "codex", "2.8.0"));
        assert!(s.is_dismissed("h:22", a, "codex", "2.8.0"));
        assert!(!s.is_dismissed("h:22", a, "codex", "2.9.0"));
        assert!(!s.is_dismissed("h:22", Kind::Cli, "codex", "2.8.0"));
        assert!(!s.is_dismissed("h:22", a, "claude", "2.8.0"));
        assert!(!s.is_dismissed("other:22", a, "codex", "2.8.0"));
    }

    #[test]
    fn support_is_stored_per_host_and_round_trips() {
        let mut s = ManagedState::default();
        assert_eq!(s.supported("h:22"), None);
        assert!(s.set_supported("h:22", true));
        assert!(!s.set_supported("h:22", true));
        s.dismiss("h:22", Kind::Cli, "codex", "2.8.0");
        let back: ManagedState = serde_json::from_str(&serde_json::to_string(&s).unwrap()).unwrap();
        assert_eq!(back, s);
        assert_eq!(
            serde_json::from_str::<ManagedState>("{}").unwrap(),
            ManagedState::default()
        );
    }
}
