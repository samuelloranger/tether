//! Debug builds only: a canned chat for screenshots, shown without an agent behind it.

use tether_core::acp::message::{AcpId, ConfigChoice, ConfigOption, decode};
use tether_core::acp::reducer::{ChatEvent, ChatState, reduce};

fn line(state: &mut ChatState, text: &str) {
    reduce(state, ChatEvent::Message(decode(text.as_bytes(), None)));
}

fn update(state: &mut ChatState, body: &str) {
    line(
        state,
        &format!(
            r#"{{"jsonrpc":"2.0","method":"session/update","params":{{"sessionId":"s","update":{body}}}}}"#
        ),
    );
}

fn background(state: &mut ChatState, id: &str, command: &str) {
    update(
        state,
        &format!(
            r#"{{"sessionUpdate":"tool_call","toolCallId":"{id}","title":"{command}","kind":"execute","_meta":{{"terminal_info":{{"terminal_id":"{id}"}}}}}}"#
        ),
    );
    update(
        state,
        &format!(
            r#"{{"sessionUpdate":"tool_call_update","toolCallId":"{id}","status":"completed","_meta":{{"claudeCode":{{"toolResponse":{{"backgroundTaskId":"bg-{id}"}}}},"terminal_output":{{"terminal_id":"{id}","data":"Command running in background."}}}}}}"#
        ),
    );
}

pub fn state() -> ChatState {
    let mut s = ChatState::default();
    line(
        &mut s,
        r#"{"jsonrpc":"2.0","id":2,"result":{"sessionId":"s","modes":{"currentModeId":"default","availableModes":[]}}}"#,
    );
    reduce(
        &mut s,
        ChatEvent::user_prompt(
            "Start the dev server and the test watcher, then tell me when they are up.",
            0,
            Some(AcpId::Int(3)),
        ),
    );
    background(&mut s, "t1", "bun run dev --port 3000");
    background(&mut s, "t2", "bun test --watch packages/core");
    update(
        &mut s,
        r#"{"sessionUpdate":"agent_message_chunk","messageId":"m1","content":{"type":"text","text":"Both are running in the background. I will report when either one stops."}}"#,
    );
    update(
        &mut s,
        r#"{"sessionUpdate":"notice","severity":"warning","title":"Rate limit close","description":"80% of the five-hour window used"}"#,
    );
    update(
        &mut s,
        r#"{"sessionUpdate":"notice","severity":"info","title":"Model switched","description":"Continuing on the smaller model"}"#,
    );
    update(
        &mut s,
        r#"{"sessionUpdate":"compaction_update","compactionId":"c1","status":"in_progress"}"#,
    );
    update(
        &mut s,
        r#"{"sessionUpdate":"compaction_update","compactionId":"c1","status":"completed","summary":[{"type":"text","text":"1. Primary Request and Intent:\n   Start the dev server and the test watcher.\n\n2. Current State:\n   Both run in the background; nothing else is pending."}]}"#,
    );
    line(
        &mut s,
        r#"{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}"#,
    );
    s
}

fn option(id: &str, name: &str, current: &str, choices: &[(&str, &str)]) -> ConfigOption {
    ConfigOption {
        id: id.into(),
        name: name.into(),
        description: String::new(),
        category: None,
        current_value: current.into(),
        choices: choices
            .iter()
            .map(|(value, name)| ConfigChoice {
                value: (*value).into(),
                name: (*name).into(),
                description: String::new(),
            })
            .collect(),
    }
}

/// What each agent offered in its last session, for the New chat dialog's menus.
pub fn options(agent: &str) -> Vec<ConfigOption> {
    match agent {
        "codex" => vec![
            option(
                "model",
                "Model",
                "gpt-5-codex",
                &[("gpt-5-codex", "gpt-5-codex"), ("gpt-5", "gpt-5")],
            ),
            option(
                "reasoning_effort",
                "Reasoning effort",
                "medium",
                &[("low", "Low"), ("medium", "Medium"), ("high", "High")],
            ),
            option(
                "mode",
                "Mode",
                "agent",
                &[("read-only", "Read only"), ("agent", "Agent")],
            ),
        ],
        "opencode" => vec![
            option("model", "Model", "a", &[("a", "Model A"), ("b", "Model B")]),
            option(
                "effort",
                "Effort",
                "high",
                &[("low", "Low"), ("high", "High")],
            ),
            option(
                "mode",
                "Mode",
                "build",
                &[("build", "Build"), ("plan", "Plan")],
            ),
        ],
        _ => vec![
            option(
                "model",
                "Model",
                "opus",
                &[("opus", "Opus"), ("sonnet", "Sonnet")],
            ),
            option(
                "effort",
                "Effort",
                "high",
                &[("medium", "Medium"), ("high", "High")],
            ),
            option(
                "mode",
                "Mode",
                "default",
                &[("default", "Ask"), ("plan", "Plan")],
            ),
        ],
    }
}
