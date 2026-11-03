//! The agents a chat can run: one profile each, and the rules that tell which agent a chat runs.
//! Every agent speaks ACP through the same host holder; only the spawn command, the options worth
//! remembering and a few words differ.

/// What differs between the agents a chat can start.
#[derive(Debug, PartialEq, Eq)]
pub struct AgentProfile {
    pub key: &'static str,
    pub label: &'static str,
    /// The command the holder spawns (`attach --spawn`).
    pub spawn: &'static str,
    /// Found in the spawn command of a chat started with another version of the same agent.
    marker: &'static str,
    /// The option ids a new chat starts with the user's last choice for, in the order they are
    /// applied: the model first, because the levels on offer depend on it.
    pub remembered: [&'static str; 3],
    /// What to run in a terminal on the host to sign in.
    sign_in_command: &'static str,
    /// Runs through npx, so the host needs Node.js.
    pub needs_node: bool,
}

/// Pinned: the transcript reducer is written against this adapter's output, so a host never
/// picks up a newer one on its own.
pub const CLAUDE: AgentProfile = AgentProfile {
    key: "claude",
    label: "Claude",
    spawn: "npx -y @agentclientprotocol/claude-agent-acp@0.95.0",
    marker: "claude-agent-acp",
    remembered: ["model", "effort", "mode"],
    sign_in_command: "claude",
    needs_node: true,
};

pub const CODEX: AgentProfile = AgentProfile {
    key: "codex",
    label: "Codex",
    spawn: "npx -y @agentclientprotocol/codex-acp@2.3.0",
    marker: "codex-acp",
    remembered: ["model", "reasoning_effort", "mode"],
    sign_in_command: "codex login",
    needs_node: true,
};

pub const OPENCODE: AgentProfile = AgentProfile {
    key: "opencode",
    label: "opencode",
    spawn: "PATH=\"$HOME/.opencode/bin:$PATH\" opencode acp",
    marker: "opencode acp",
    remembered: ["model", "effort", "mode"],
    sign_in_command: "opencode auth login",
    needs_node: false,
};

/// The Copilot CLI speaks ACP itself; a host holder asks it for `assistant.idle` to end turns it
/// holds open for a running shell.
pub const COPILOT: AgentProfile = AgentProfile {
    key: "copilot",
    label: "Copilot",
    spawn: "copilot --acp",
    marker: "copilot --acp",
    remembered: ["model", "reasoning_effort", "mode"],
    sign_in_command: "copilot login",
    needs_node: false,
};

/// Google Antigravity runs behind an npm supervisor that fetches and hardens the official
/// `agy_acp_server` binary.
pub const ANTIGRAVITY: AgentProfile = AgentProfile {
    key: "antigravity",
    label: "Antigravity",
    spawn: "npx -y @simonepri/refined-antigravity-acp@1.6.3 --yes",
    marker: "refined-antigravity-acp",
    remembered: ["model", "effort", "mode"],
    sign_in_command: "agy",
    needs_node: true,
};

/// In the order the New chat picker lists them.
pub const HERMES: AgentProfile = AgentProfile {
    key: "hermes",
    label: "Hermes",
    spawn: "tether hermes",
    marker: "tether hermes",
    remembered: ["model", "mode", ""],
    sign_in_command: "hermes model",
    needs_node: false,
};

pub const ALL: [&AgentProfile; 6] = [&CLAUDE, &CODEX, &OPENCODE, &COPILOT, &ANTIGRAVITY, &HERMES];

pub fn hermes_conversation_name(scope: &str) -> String {
    let hash = scope.bytes().fold(14_695_981_039_346_656_037_u64, |h, b| {
        (h ^ u64::from(b)).wrapping_mul(1_099_511_628_211)
    });
    format!("hermes-{hash:x}")
}

/// What a chat with an agent this build does not know is called.
pub const GENERIC_LABEL: &str = "Agent";

pub fn by_key(key: &str) -> Option<&'static AgentProfile> {
    ALL.into_iter().find(|p| p.key == key)
}

/// The profile for a holder's spawn command: an exact match, else the agent's marker anywhere in it.
pub fn for_spawn(spawn: &str) -> Option<&'static AgentProfile> {
    let spawn = spawn.trim();
    if spawn.contains("antigravity-acp") || spawn.contains("agy_acp_server") {
        return Some(&ANTIGRAVITY);
    }
    ALL.into_iter()
        .find(|p| p.spawn == spawn)
        .or_else(|| ALL.into_iter().find(|p| spawn.contains(p.marker)))
}

/// Which agent a chat runs: what this device recorded when it started the chat, else the spawn
/// command the host reports, else Claude (older chats and hosts say nothing). `None` is an agent
/// this build does not know.
pub fn resolve(local_key: Option<&str>, status_spawn: &str) -> Option<&'static AgentProfile> {
    if let Some(profile) = local_key.and_then(by_key) {
        return Some(profile);
    }
    if status_spawn.trim().is_empty() {
        return Some(&CLAUDE);
    }
    for_spawn(status_spawn)
}

/// The option ids remembered for an agent key; nothing for an agent that is not known.
pub fn remembered_ids(key: &str) -> &'static [&'static str] {
    by_key(key).map_or(&[], |p| &p.remembered)
}

pub fn label(agent: Option<&AgentProfile>) -> &'static str {
    agent.map_or(GENERIC_LABEL, |p| p.label)
}

pub fn key(agent: Option<&AgentProfile>) -> &'static str {
    agent.map_or("", |p| p.key)
}

/// The line under a chat that cannot send because its agent has no login.
pub fn sign_in_message(agent: Option<&AgentProfile>, host: &str) -> String {
    match agent {
        Some(p) => format!(
            "{} isn't signed in on {host}. Open a terminal there and run {} to sign in.",
            p.label, p.sign_in_command
        ),
        None => {
            format!("The agent isn't signed in on {host}. Open a terminal there and sign in.")
        }
    }
}

/// Claude's own spinner words belong to Claude chats; every other agent shows the fallback words.
pub fn spinner_verbs<'a>(agent: Option<&AgentProfile>, claude_verbs: &'a [String]) -> &'a [String] {
    if agent == Some(&CLAUDE) {
        claude_verbs
    } else {
        &[]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::host;

    #[test]
    fn antigravity_profile_definition_and_resolution() {
        assert_eq!(by_key("antigravity"), Some(&ANTIGRAVITY));
        assert_eq!(
            for_spawn("npx -y @simonepri/refined-antigravity-acp@1.6.3 --yes"),
            Some(&ANTIGRAVITY)
        );
        assert_eq!(
            for_spawn("npx -y @simonepri/refined-antigravity-acp"),
            Some(&ANTIGRAVITY)
        );
        assert_eq!(for_spawn("antigravity-acp"), Some(&ANTIGRAVITY));
        assert_eq!(for_spawn("/path/to/agy_acp_server.par"), Some(&ANTIGRAVITY));
        assert!(by_key("antigravity").unwrap().needs_node);
        assert_eq!(ANTIGRAVITY.remembered, ["model", "effort", "mode"]);
        assert!(
            host::host_problems_for("node=missing", &ANTIGRAVITY)
                .contains(&host::HostProblem::NodeMissing)
        );
    }

    #[test]
    fn antigravity_sign_in_message() {
        assert!(sign_in_message(Some(&ANTIGRAVITY), "devbox").contains("run agy to sign in"));
    }

    #[test]
    fn hermes_is_one_scoped_conversation_without_node() {
        assert_eq!(for_spawn("tether hermes"), Some(&HERMES));
        assert!(!for_spawn("tether hermes").unwrap().needs_node);
        assert_eq!(
            hermes_conversation_name("server:22"),
            "hermes-6d10ccc02fbceea4"
        );
        assert_ne!(
            hermes_conversation_name("server:22"),
            hermes_conversation_name("server:2222")
        );
        assert!(super::super::host::host_problems_for("node=missing", &HERMES).is_empty());
        assert_eq!(
            super::super::host::host_problems_for("hermes=missing", &HERMES),
            vec![super::super::host::HostProblem::HermesMissing]
        );
    }

    #[test]
    fn the_claude_profile_is_the_pinned_adapter() {
        assert_eq!(
            CLAUDE.spawn,
            format!("npx -y {}@{}", host::ADAPTER_PACKAGE, host::ADAPTER_VERSION)
        );
    }

    #[test]
    fn a_spawn_command_finds_its_profile_exactly_or_by_marker() {
        assert_eq!(for_spawn(CODEX.spawn), Some(&CODEX));
        assert_eq!(for_spawn(OPENCODE.spawn), Some(&OPENCODE));
        assert_eq!(
            OPENCODE.spawn,
            r#"PATH="$HOME/.opencode/bin:$PATH" opencode acp"#
        );
        assert_eq!(for_spawn("opencode acp"), Some(&OPENCODE));
        assert_eq!(
            for_spawn("npx -y @agentclientprotocol/codex-acp@9.9.9"),
            Some(&CODEX)
        );
        assert_eq!(
            for_spawn("npx -y @agentclientprotocol/claude-agent-acp@0.1.0"),
            Some(&CLAUDE)
        );
        assert_eq!(
            for_spawn("/usr/local/bin/opencode acp --pure"),
            Some(&OPENCODE)
        );
        assert_eq!(for_spawn(COPILOT.spawn), Some(&COPILOT));
        assert_eq!(
            for_spawn("/home/me/.local/bin/copilot --acp --allow-all-tools"),
            Some(&COPILOT)
        );
        assert_eq!(for_spawn("some-other-agent --acp"), None);
        assert_eq!(for_spawn(""), None);
    }

    #[test]
    fn a_chat_runs_the_agent_this_device_recorded_then_the_hosts_report_then_claude() {
        assert_eq!(resolve(Some("codex"), CLAUDE.spawn), Some(&CODEX));
        assert_eq!(resolve(None, OPENCODE.spawn), Some(&OPENCODE));
        assert_eq!(resolve(None, ""), Some(&CLAUDE));
        assert_eq!(resolve(Some("codex"), ""), Some(&CODEX));
        assert_eq!(resolve(Some("not-an-agent"), CODEX.spawn), Some(&CODEX));
        assert_eq!(resolve(Some("not-an-agent"), ""), Some(&CLAUDE));
        assert_eq!(resolve(None, "mystery --acp"), None);
    }

    #[test]
    fn each_agent_remembers_its_own_option_ids() {
        assert_eq!(remembered_ids("claude"), ["model", "effort", "mode"]);
        assert_eq!(
            remembered_ids("codex"),
            ["model", "reasoning_effort", "mode"]
        );
        assert_eq!(remembered_ids("opencode"), ["model", "effort", "mode"]);
        assert_eq!(
            remembered_ids("copilot"),
            ["model", "reasoning_effort", "mode"]
        );
        assert_eq!(remembered_ids("antigravity"), ["model", "effort", "mode"]);
        assert!(remembered_ids("other").is_empty());
    }

    #[test]
    fn the_sign_in_text_names_the_agents_own_command() {
        assert_eq!(
            sign_in_message(Some(&CLAUDE), "devbox"),
            "Claude isn't signed in on devbox. Open a terminal there and run claude to sign in."
        );
        assert!(sign_in_message(Some(&CODEX), "devbox").contains("run codex login to sign in"));
        assert!(
            sign_in_message(Some(&OPENCODE), "devbox")
                .contains("run opencode auth login to sign in")
        );
        assert!(sign_in_message(Some(&COPILOT), "devbox").contains("run copilot login to sign in"));
        assert!(sign_in_message(None, "devbox").starts_with("The agent isn't signed in"));
    }

    #[test]
    fn only_claude_chats_use_claudes_spinner_words() {
        let words = vec!["Accomplishing".to_string()];
        assert_eq!(spinner_verbs(Some(&CLAUDE), &words), words.as_slice());
        assert!(spinner_verbs(Some(&CODEX), &words).is_empty());
        assert!(spinner_verbs(Some(&OPENCODE), &words).is_empty());
        assert!(spinner_verbs(Some(&COPILOT), &words).is_empty());
        assert!(spinner_verbs(None, &words).is_empty());
    }

    #[test]
    fn labels_fall_back_to_a_generic_word() {
        assert_eq!(label(Some(&CODEX)), "Codex");
        assert_eq!(label(None), "Agent");
    }
}
