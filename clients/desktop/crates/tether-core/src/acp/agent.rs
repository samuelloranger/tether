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
};

pub const CODEX: AgentProfile = AgentProfile {
    key: "codex",
    label: "Codex",
    spawn: "npx -y @agentclientprotocol/codex-acp@2.3.0",
    marker: "codex-acp",
    remembered: ["model", "reasoning_effort", "mode"],
    sign_in_command: "codex login",
};

pub const OPENCODE: AgentProfile = AgentProfile {
    key: "opencode",
    label: "opencode",
    spawn: "PATH=\"$HOME/.opencode/bin:$PATH\" opencode acp",
    marker: "opencode acp",
    remembered: ["model", "effort", "mode"],
    sign_in_command: "opencode auth login",
};

/// In the order the New chat picker lists them.
pub const ALL: [&AgentProfile; 3] = [&CLAUDE, &CODEX, &OPENCODE];

/// What a chat with an agent this build does not know is called.
pub const GENERIC_LABEL: &str = "Agent";

pub fn by_key(key: &str) -> Option<&'static AgentProfile> {
    ALL.into_iter().find(|p| p.key == key)
}

/// The profile for a holder's spawn command: an exact match, else the agent's marker anywhere in it.
pub fn for_spawn(spawn: &str) -> Option<&'static AgentProfile> {
    let spawn = spawn.trim();
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
        assert!(sign_in_message(None, "devbox").starts_with("The agent isn't signed in"));
    }

    #[test]
    fn only_claude_chats_use_claudes_spinner_words() {
        let words = vec!["Accomplishing".to_string()];
        assert_eq!(spinner_verbs(Some(&CLAUDE), &words), words.as_slice());
        assert!(spinner_verbs(Some(&CODEX), &words).is_empty());
        assert!(spinner_verbs(Some(&OPENCODE), &words).is_empty());
        assert!(spinner_verbs(None, &words).is_empty());
    }

    #[test]
    fn labels_fall_back_to_a_generic_word() {
        assert_eq!(label(Some(&CODEX)), "Codex");
        assert_eq!(label(None), "Agent");
    }
}
