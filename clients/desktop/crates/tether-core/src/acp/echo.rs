//! Lines other clients sent, echoed into the log by a holder that takes several clients
//! (`_tether/client`): their prompts, stops and answers become the events this client's own
//! would, so every attached device shows the same conversation.

use std::collections::BTreeMap;

use serde_json::Value;

use super::message::parse_id;
use super::question::{QuestionAction, QuestionValue};
use super::reducer::ChatEvent;

pub const METHOD: &str = "_tether/client";

/// What another client's line changes on screen. Requests that change nothing visible (the
/// handshake, a mode change whose result the agent reports itself) give no event.
pub fn events(message: &Value, at_offset: usize) -> Vec<ChatEvent> {
    let Some(line) = message.as_object() else {
        return Vec::new();
    };
    let id = parse_id(line.get("id"));
    match line.get("method").and_then(Value::as_str) {
        Some("session/prompt") => {
            let blocks = line
                .get("params")
                .and_then(|p| p.get("prompt"))
                .and_then(Value::as_array);
            let mut text = String::new();
            let mut image_count = 0;
            for block in blocks.into_iter().flatten() {
                if block
                    .get("_meta")
                    .and_then(|m| m.get("tether/branchContext"))
                    .and_then(Value::as_bool)
                    == Some(true)
                {
                    continue;
                }
                match block.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        text.push_str(block.get("text").and_then(Value::as_str).unwrap_or(""))
                    }
                    Some("image") => image_count += 1,
                    _ => {}
                }
            }
            vec![ChatEvent::UserPrompt {
                text,
                image_count,
                at_offset,
                request_id: id,
                images: Vec::new(),
            }]
        }
        Some("session/cancel") => vec![ChatEvent::CancelRequested],
        Some(_) => Vec::new(),
        None => {
            let (Some(request_id), Some(result)) = (id, line.get("result")) else {
                return Vec::new();
            };
            if let Some(outcome) = result.get("outcome") {
                let option_id = match outcome.get("outcome").and_then(Value::as_str) {
                    Some("selected") => outcome.get("optionId").and_then(Value::as_str),
                    Some("cancelled") => Some("cancelled"),
                    _ => None,
                };
                return option_id
                    .map(|o| ChatEvent::PermissionAnswered {
                        request_id,
                        option_id: o.to_string(),
                    })
                    .into_iter()
                    .collect();
            }
            let Some(action) = result
                .get("action")
                .and_then(Value::as_str)
                .and_then(QuestionAction::parse)
            else {
                return Vec::new();
            };
            let content: BTreeMap<String, QuestionValue> = result
                .get("content")
                .and_then(Value::as_object)
                .map(|c| {
                    c.iter()
                        .filter_map(|(k, v)| Some((k.clone(), value(v)?)))
                        .collect()
                })
                .unwrap_or_default();
            vec![ChatEvent::QuestionAnswered {
                request_id,
                action,
                content,
            }]
        }
    }
}

fn value(v: &Value) -> Option<QuestionValue> {
    match v {
        Value::String(s) => Some(QuestionValue::Text(s.clone())),
        Value::Bool(b) => Some(QuestionValue::Flag(*b)),
        Value::Number(n) => Some(QuestionValue::Text(super::question::number_text(n))),
        Value::Array(items) => items
            .iter()
            .map(|i| i.as_str().map(str::to_string))
            .collect::<Option<Vec<_>>>()
            .map(QuestionValue::List),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::acp::message::AcpId;

    #[test]
    fn copied_context_is_hidden_only_when_explicitly_marked() {
        let line = json!({"id":1,"method":"session/prompt","params":{"prompt":[{"type":"text","text":"earlier secret context","_meta":{"tether/branchContext":true}},{"type":"text","text":"edited prompt"}]}});
        assert!(
            matches!(&events(&line,0)[..],[ChatEvent::UserPrompt{text,..}] if text=="edited prompt")
        );
    }

    #[test]
    fn a_prompt_becomes_the_users_message_with_its_request_id() {
        let line = json!({"jsonrpc": "2.0", "id": "ab-4", "method": "session/prompt",
            "params": {"sessionId": "s", "prompt": [
                {"type": "image", "mimeType": "image/png", "data": "AA=="},
                {"type": "text", "text": "Look at this"}]}});
        assert_eq!(
            events(&line, 120),
            [ChatEvent::UserPrompt {
                text: "Look at this".into(),
                image_count: 1,
                at_offset: 120,
                request_id: Some(AcpId::Str("ab-4".into())),
                images: Vec::new(),
            }]
        );
    }

    #[test]
    fn answers_resolve_the_card_they_answer() {
        let allow = json!({"jsonrpc": "2.0", "id": 7,
            "result": {"outcome": {"outcome": "selected", "optionId": "allow"}}});
        assert_eq!(
            events(&allow, 0),
            [ChatEvent::PermissionAnswered {
                request_id: AcpId::Int(7),
                option_id: "allow".into()
            }]
        );
        let cancelled =
            json!({"jsonrpc": "2.0", "id": 7, "result": {"outcome": {"outcome": "cancelled"}}});
        assert!(matches!(&events(&cancelled, 0)[..],
            [ChatEvent::PermissionAnswered { option_id, .. }] if option_id == "cancelled"));
        let accept = json!({"jsonrpc": "2.0", "id": 2,
            "result": {"action": "accept", "content": {"color": "green", "more": ["a", "b"], "ok": true}}});
        let [
            ChatEvent::QuestionAnswered {
                action, content, ..
            },
        ] = &events(&accept, 0)[..]
        else {
            panic!("one question answer");
        };
        assert_eq!(*action, QuestionAction::Accept);
        assert_eq!(content["color"], QuestionValue::Text("green".into()));
        assert_eq!(
            content["more"],
            QuestionValue::List(vec!["a".into(), "b".into()])
        );
        assert_eq!(content["ok"], QuestionValue::Flag(true));
    }

    #[test]
    fn a_stop_stops_and_the_handshake_changes_nothing() {
        let cancel =
            json!({"jsonrpc": "2.0", "method": "session/cancel", "params": {"sessionId": "s"}});
        assert_eq!(events(&cancel, 0), [ChatEvent::CancelRequested]);
        let init = json!({"jsonrpc": "2.0", "id": "ab-1", "method": "initialize", "params": {}});
        assert!(events(&init, 0).is_empty());
        assert!(events(&json!("not a line"), 0).is_empty());
    }
}
