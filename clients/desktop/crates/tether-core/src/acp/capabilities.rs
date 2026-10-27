//! Background commands, agent-started turns, notices and compaction, driven by recorded traffic.

use serde_json::{Value, json};

use super::fixture::{self, Fixture};
use super::message::{AcpId, Inbound, decode};
use super::reducer::{ChatEvent, ChatState, CompactionStatus, ItemKind, Turn, reduce};

fn line(state: &mut ChatState, text: &str) {
    reduce(state, ChatEvent::Message(decode(text.as_bytes(), None)));
}

fn prompt(state: &mut ChatState, text: &str, id: i64) {
    reduce(state, ChatEvent::user_prompt(text, 0, Some(AcpId::Int(id))));
}

fn update(state: &mut ChatState, body: Value) {
    let line = json!({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": "s", "update": body}});
    reduce(
        state,
        ChatEvent::Message(decode(line.to_string().as_bytes(), None)),
    );
}

/// Plays the agent lines through `until` (exclusive), sending each prompt right after the
/// session is established or the previous prompt answered.
fn play(fx: &Fixture, prompts: &[&str], until: usize, state: &mut ChatState) {
    let lines = fx.agent_lines();
    let mut next = 0;
    for (i, l) in lines.iter().take(until).enumerate() {
        line(state, l);
        let answered_prompt = l.contains("\"stopReason\"");
        if (i == 1 || answered_prompt) && next < prompts.len() {
            prompt(state, prompts[next], 3 + next as i64);
            next += 1;
        }
    }
}

fn index_of(fx: &Fixture, needle: &str) -> usize {
    fx.index_containing(needle)
}

fn bg_state(until_needle: &str, inclusive: bool) -> ChatState {
    let mut state = ChatState::default();
    let until = index_of(&fixture::BG, until_needle) + usize::from(inclusive);
    play(&fixture::BG, &["run it"], until, &mut state);
    state
}

#[test]
fn a_backgrounded_command_runs_until_its_terminal_exits() {
    let state = bg_state("\"id\":3,\"result\"", true);
    assert_eq!(state.turn, Turn::Idle);
    let running = state.background_commands();
    assert_eq!(running.len(), 1);
    assert_eq!(running[0].title, "sleep 25; echo probe-finished");
    assert_eq!(running[0].background_task_id.as_deref(), Some("bu187x5oe"));
    let text = running[0].text.as_deref().unwrap();
    assert!(text.starts_with("```console\nCommand running in background"));
    assert!(text.ends_with("\n```"));

    let ended = bg_state("terminal_exit", true);
    assert!(ended.background_commands().is_empty());
    assert_eq!(ended.turn, Turn::Idle);
}

#[test]
fn the_report_the_agent_starts_makes_the_turn_work_until_its_cost_arrives() {
    let working = bg_state("\"text\":\"finished\"", true);
    assert_eq!(working.turn, Turn::Working);
    let idle = bg_state("task-notification", true);
    assert_eq!(idle.turn, Turn::Idle);
    let last = idle.items.last().unwrap();
    assert!(matches!(&last.kind, ItemKind::Assistant { text, .. } if text == "finished"));
}

#[test]
fn a_terminal_exit_alone_does_not_start_a_turn() {
    let state = bg_state("terminal_exit", true);
    assert_eq!(state.turn, Turn::Idle);
}

#[test]
fn stop_ends_an_agent_started_turn_and_a_prompt_takes_it_over() {
    let mut state = bg_state("\"text\":\"finished\"", true);
    reduce(&mut state, ChatEvent::CancelRequested);
    assert_eq!(state.turn, Turn::Idle);

    let mut state = bg_state("\"text\":\"finished\"", true);
    prompt(&mut state, "next", 9);
    line(
        &mut state,
        r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"usage_update","used":1,"size":2,"cost":{"amount":0.1,"currency":"USD"}}}}"#,
    );
    assert_eq!(state.turn, Turn::Working);
    assert!(state.queued_item_ids.is_empty());
    line(
        &mut state,
        r#"{"jsonrpc":"2.0","id":9,"result":{"stopReason":"end_turn"}}"#,
    );
    assert_eq!(state.turn, Turn::Idle);
}

#[test]
fn replayed_history_does_not_start_a_turn_and_the_load_answer_ends_every_command() {
    let mut state = ChatState::default();
    update(
        &mut state,
        json!({"sessionUpdate": "tool_call", "toolCallId": "t1", "title": "sleep 9", "kind": "execute",
            "_meta": {"terminal_info": {"terminal_id": "t1"}, "claudeCode": {"toolResponse": {"backgroundTaskId": "b1"}}}}),
    );
    update(
        &mut state,
        json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "old"}}),
    );
    assert_eq!(state.turn, Turn::Idle);
    assert_eq!(state.background_commands().len(), 1);
    line(
        &mut state,
        r#"{"jsonrpc":"2.0","id":2,"result":{"modes":{"currentModeId":"default","availableModes":[]}}}"#,
    );
    assert!(state.background_commands().is_empty());
    update(
        &mut state,
        json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "live"}}),
    );
    assert_eq!(state.turn, Turn::Working);
}

#[test]
fn a_failed_load_ends_the_wait_so_later_output_is_live() {
    let mut state = ChatState::default();
    line(
        &mut state,
        r#"{"jsonrpc":"2.0","id":2,"error":{"code":-32002,"message":"Resource not found"}}"#,
    );
    update(
        &mut state,
        json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "hi"}}),
    );
    assert_eq!(state.turn, Turn::Working);
}

#[test]
fn a_command_without_terminal_metadata_never_shows_as_running() {
    let mut state = ChatState::default();
    update(
        &mut state,
        json!({"sessionUpdate": "tool_call", "toolCallId": "t1", "title": "sleep 9", "kind": "execute",
            "_meta": {"claudeCode": {"toolResponse": {"backgroundTaskId": "b1"}}}}),
    );
    assert!(state.background_commands().is_empty());
}

#[test]
fn terminal_output_renders_like_the_old_text_block_and_deltas_append() {
    let mut state = ChatState::default();
    update(
        &mut state,
        json!({"sessionUpdate": "tool_call", "toolCallId": "t1", "title": "ls", "kind": "execute"}),
    );
    update(
        &mut state,
        json!({"sessionUpdate": "tool_call_update", "toolCallId": "t1",
            "_meta": {"terminal_output": {"terminal_id": "t1", "data": "a\n"}}}),
    );
    update(
        &mut state,
        json!({"sessionUpdate": "tool_call_update", "toolCallId": "t1",
            "_meta": {"terminal_output_delta": {"terminal_id": "t1", "data": "b\n\n"}}}),
    );
    update(
        &mut state,
        json!({"sessionUpdate": "tool_call_update", "toolCallId": "t1",
            "_meta": {"terminal_output_delta": {"terminal_id": "t1", "data": "  \n"}}}),
    );
    let ItemKind::Tool(call) = &state.items[0].kind else {
        panic!("a tool row")
    };
    assert_eq!(call.text.as_deref(), Some("```console\na\nb\n```"));
}

#[test]
fn old_format_bash_output_still_parses_from_the_content_text() {
    let mut state = ChatState::default();
    update(
        &mut state,
        json!({"sessionUpdate": "tool_call", "toolCallId": "t1", "title": "ls", "kind": "execute",
            "content": [{"type": "content", "content": {"type": "text", "text": "```console\nfile\n```"}}]}),
    );
    let ItemKind::Tool(call) = &state.items[0].kind else {
        panic!("a tool row")
    };
    assert_eq!(call.text.as_deref(), Some("```console\nfile\n```"));
}

#[test]
fn a_notice_is_its_own_row_with_its_severity() {
    let mut state = ChatState::default();
    update(
        &mut state,
        json!({"sessionUpdate": "agent_message_chunk", "messageId": "m", "content": {"type": "text", "text": "hi"}}),
    );
    update(
        &mut state,
        json!({"sessionUpdate": "notice", "severity": "warning", "title": "Rate limited", "description": "Retrying in 5 s"}),
    );
    update(
        &mut state,
        json!({"sessionUpdate": "notice", "title": "Plain"}),
    );
    update(
        &mut state,
        json!({"sessionUpdate": "agent_message_chunk", "messageId": "m", "content": {"type": "text", "text": "!"}}),
    );
    let kinds: Vec<_> = state.items.iter().map(|i| &i.kind).collect();
    assert!(matches!(kinds[0], ItemKind::Assistant { text, .. } if text == "hi"));
    assert_eq!(
        kinds[1],
        &ItemKind::AgentNotice {
            severity: Some("warning".into()),
            title: "Rate limited".into(),
            description: Some("Retrying in 5 s".into()),
        }
    );
    assert_eq!(
        kinds[2],
        &ItemKind::AgentNotice {
            severity: None,
            title: "Plain".into(),
            description: None,
        }
    );
    assert!(matches!(kinds[3], ItemKind::Assistant { text, .. } if text == "!"));
}

#[test]
fn a_recorded_compaction_is_one_completed_item_with_its_summary_and_no_second_divider() {
    let mut state = ChatState::default();
    let total = fixture::COMPACT.agent_lines().len();
    play(
        &fixture::COMPACT,
        &["Reply with the word hi.", "/compact"],
        total,
        &mut state,
    );
    assert_eq!(state.turn, Turn::Idle);
    let compactions: Vec<_> = state
        .items
        .iter()
        .filter_map(|i| match &i.kind {
            ItemKind::Compaction {
                status, summary, ..
            } => Some((*status, summary.clone())),
            _ => None,
        })
        .collect();
    assert_eq!(compactions.len(), 1);
    assert_eq!(compactions[0].0, CompactionStatus::Completed);
    assert!(
        compactions[0]
            .1
            .starts_with("1. Primary Request and Intent")
    );
    assert!(
        !state
            .items
            .iter()
            .any(|i| matches!(i.kind, ItemKind::Divider(_)))
    );
}

#[test]
fn compaction_summary_chunks_append_and_the_final_update_keeps_them() {
    let mut state = ChatState::default();
    let id = "c1";
    update(
        &mut state,
        json!({"sessionUpdate": "compaction_update", "compactionId": id, "status": "in_progress"}),
    );
    update(
        &mut state,
        json!({"sessionUpdate": "compaction_summary_chunk", "compactionId": id, "content": {"type": "text", "text": "one "}}),
    );
    update(
        &mut state,
        json!({"sessionUpdate": "compaction_summary_chunk", "compactionId": id, "content": {"type": "text", "text": "two"}}),
    );
    update(
        &mut state,
        json!({"sessionUpdate": "compaction_update", "compactionId": id, "status": "completed"}),
    );
    assert_eq!(state.items.len(), 1);
    assert_eq!(
        state.items[0].kind,
        ItemKind::Compaction {
            compaction_id: id.into(),
            status: CompactionStatus::Completed,
            summary: "one two".into(),
        }
    );
}

#[test]
fn a_compact_prompt_without_compaction_updates_keeps_the_old_divider() {
    let mut state = ChatState::default();
    prompt(&mut state, "/compact", 3);
    line(
        &mut state,
        r#"{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}"#,
    );
    assert!(
        state
            .items
            .iter()
            .any(|i| i.kind == ItemKind::Divider("Context compacted".into()))
    );
}

#[test]
fn a_snapshot_from_before_these_fields_decodes() {
    let mut state = ChatState::default();
    update(
        &mut state,
        json!({"sessionUpdate": "tool_call", "toolCallId": "t1", "title": "ls", "kind": "execute"}),
    );
    let mut value = serde_json::to_value(&state).unwrap();
    value.as_object_mut().unwrap().remove("agent_started");
    value.as_object_mut().unwrap().remove("awaiting_session");
    let call = value["items"][0]["kind"]["Tool"].as_object_mut().unwrap();
    for key in [
        "has_terminal",
        "background_task_id",
        "terminal_exited",
        "terminal_data",
    ] {
        call.remove(key);
    }
    let back: ChatState = serde_json::from_value(value).unwrap();
    assert_eq!(back.items.len(), 1);
    let mut back = back;
    update(
        &mut back,
        json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "x"}}),
    );
    assert_eq!(
        back.turn,
        Turn::Working,
        "a resumed chat is past its session answer"
    );
}

#[test]
fn unknown_garbage_still_decodes() {
    assert!(matches!(decode(b"{}", None), Inbound::Unknown { .. }));
}
