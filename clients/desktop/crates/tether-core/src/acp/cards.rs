//! Agent-published native cards carried by ordinary MCP tool results.
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::images::ImageRef;

pub const MARKER: &str = "TETHER_CARD_V1\n";
pub const TOOL_NAME: &str = "tether_publish_card";

/// Claude names the tool in `name` and `_meta.claudeCode.toolName`, Codex in its title, and an
/// adapter may mark its own update with `_meta.tether.card`; none of these come from the tool's output.
pub fn is_publisher(object: &serde_json::Map<String, Value>) -> bool {
    let claude = format!("mcp__tether-cards__{TOOL_NAME}");
    let meta = object.get("_meta").and_then(Value::as_object);
    let claude_meta = meta
        .and_then(|m| m.get("claudeCode"))
        .and_then(|c| c.get("toolName"))
        .and_then(Value::as_str);
    object.get("name").and_then(Value::as_str) == Some(claude.as_str())
        || claude_meta == Some(claude.as_str())
        || object.get("title").and_then(Value::as_str)
            == Some(&format!("mcp.tether-cards.{TOOL_NAME}"))
        || meta
            .and_then(|m| m.get("tether"))
            .and_then(|t| t.get("card"))
            .and_then(Value::as_bool)
            == Some(true)
}

pub(crate) fn image_block(value: &Value, depth: u8) -> Option<Value> {
    if depth > 6 {
        return None;
    }
    match value {
        Value::Object(object) => {
            if value["type"] == "image" {
                if value["data"].is_string() {
                    return Some(value.clone());
                }
                if value["source"]["type"] == "base64" {
                    return Some(
                        serde_json::json!({"type":"image", "data":value["source"]["data"], "mimeType":value["source"]["media_type"]}),
                    );
                }
            }
            ["result", "content"]
                .iter()
                .find_map(|k| object.get(*k).and_then(|v| image_block(v, depth + 1)))
        }
        Value::Array(items) => items.iter().find_map(|v| image_block(v, depth + 1)),
        _ => None,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Card {
    pub version: i32,
    pub id: String,
    pub revision: i32,
    pub kind: String,
    pub title: String,
    pub fallback: String,
    pub fetched_at: String,
    pub source: String,
    pub payload: Value,
    #[serde(default)]
    pub image: Option<ImageRef>,
}

fn extract(value: &Value, depth: u8) -> Option<Value> {
    if depth > 6 {
        return None;
    }
    match value {
        Value::String(s) if s.len() <= 256 * 1024 => {
            if let Some(text) = s.strip_prefix(MARKER) {
                return serde_json::from_str(text).ok();
            }
            extract(&serde_json::from_str::<Value>(s).ok()?, depth + 1)
        }
        Value::Array(items) => items.iter().find_map(|v| extract(v, depth + 1)),
        Value::Object(object) => ["rawOutput", "result", "content", "text"]
            .iter()
            .find_map(|key| object.get(*key).and_then(|v| extract(v, depth + 1))),
        _ => None,
    }
}

fn bounded(value: &Value, key: &str, limit: usize) -> bool {
    value
        .get(key)
        .and_then(Value::as_str)
        .is_some_and(|s| !s.is_empty() && s.chars().count() <= limit)
}

impl Card {
    pub fn decode(value: &Value, images: &[ImageRef]) -> Option<Self> {
        let object = extract(value, 0)?;
        if serde_json::to_vec(&object).ok()?.len() > 128 * 1024 {
            return None;
        }
        let mut card: Self = serde_json::from_value(object).ok()?;
        if card.id.is_empty()
            || card.id.chars().count() > 128
            || card.revision <= 0
            || card.title.is_empty()
            || card.title.chars().count() > 200
            || card.fallback.is_empty()
            || card.fallback.chars().count() > 4000
            || card.source.chars().count() > 500
            || card.fetched_at.len() > 80
        {
            return None;
        }
        let p = &card.payload;
        if card.supported() {
            let valid = match card.kind.as_str() {
                "weather" => {
                    bounded(p, "location", 200)
                        && bounded(p, "conditions", 200)
                        && bounded(p, "timeZone", 100)
                        && matches!(p["unit"].as_str(), Some("C" | "F"))
                        && p["hourly"].as_array().is_some_and(|h| {
                            h.len() <= 24
                                && h.iter().all(|v| {
                                    bounded(v, "time", 80)
                                        && bounded(v, "conditions", 200)
                                        && v["precipitation"]
                                            .as_f64()
                                            .is_none_or(|n| (0.0..=100.0).contains(&n))
                                })
                        })
                }
                "docker" => {
                    bounded(p, "host", 200)
                        && p["containers"].as_array().is_some_and(|rows| {
                            rows.len() <= 100
                                && p["total"].as_u64().is_some_and(|t| t >= rows.len() as u64)
                                && rows.iter().all(|v| {
                                    bounded(v, "id", 128)
                                        && bounded(v, "name", 200)
                                        && bounded(v, "state", 100)
                                        && v["cpuPercent"].as_f64().is_none_or(|n| n >= 0.0)
                                        && v["memoryBytes"].as_f64().is_none_or(|n| n >= 0.0)
                                })
                                && rows
                                    .iter()
                                    .filter_map(|v| v["id"].as_str())
                                    .collect::<std::collections::HashSet<_>>()
                                    .len()
                                    == rows.len()
                        })
                }
                "image" => bounded(p, "alt", 1000),
                _ => false,
            };
            if !valid {
                return None;
            }
        }
        card.image = images.first().cloned();
        Some(card)
    }

    pub fn supported(&self) -> bool {
        self.version == 1 && matches!(self.kind.as_str(), "weather" | "image" | "docker")
    }

    pub fn request(&self, action: &str, container_id: &str) -> Option<String> {
        if !self.supported() {
            return None;
        }
        let quote = |v: &Value| v.to_string();
        if action == "refresh" && self.kind == "weather" {
            return Some(format!(
                "Refresh the weather for {}.",
                quote(&self.payload["location"])
            ));
        }
        if self.kind != "docker" {
            return None;
        }
        if action == "refresh" {
            return Some(format!(
                "Refresh the Docker status on host {}.",
                quote(&self.payload["host"])
            ));
        }
        let container = self.container(container_id)?;
        let verb = match action {
            "logs" => "Show recent logs for",
            "restart" => "Restart",
            _ => return None,
        };
        Some(format!(
            "{verb} container {} ({}) on host {}. Update the existing Docker card after checking its current state.",
            quote(&container["name"]),
            quote(&container["id"]),
            quote(&self.payload["host"])
        ))
    }

    pub fn action_requests(&self) -> Vec<String> {
        let mut requests: Vec<String> = self.request("refresh", "").into_iter().collect();
        for c in self.payload["containers"].as_array().into_iter().flatten() {
            if let Some(id) = c["id"].as_str() {
                requests.extend(self.request("logs", id));
                requests.extend(self.request("restart", id));
            }
        }
        requests
    }

    fn container(&self, id: &str) -> Option<&Value> {
        self.payload["containers"]
            .as_array()?
            .iter()
            .find(|v| v["id"].as_str() == Some(id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::journal::{Journal, TranscriptBuilder};
    use crate::acp::reducer::{ChatState, ItemKind};
    use serde_json::json;

    #[test]
    fn a_card_for_a_queued_prompt_follows_that_prompt() {
        use crate::acp::{message::AcpId, reducer::ChatEvent};
        let mut builder = TranscriptBuilder::new(&Journal::default(), None);
        builder.apply(ChatEvent::user_prompt(
            "First request",
            0,
            Some(AcpId::Int(1)),
        ));
        builder.apply(ChatEvent::user_prompt(
            "Show weather",
            0,
            Some(AcpId::Int(2)),
        ));
        builder
            .feed(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"stopReason\":\"end_turn\"}}\n")
            .unwrap();
        builder.feed(&line(&fixtures()[0], false)).unwrap();
        let items = &builder.state().items;
        let user = items
            .iter()
            .position(|i| matches!(&i.kind, ItemKind::User { text, .. } if text == "Show weather"))
            .unwrap();
        let card = items
            .iter()
            .position(|i| matches!(&i.kind, ItemKind::Card(_)))
            .unwrap();
        assert!(card > user);
    }

    #[test]
    fn captured_claude_and_codex_results_include_native_images() {
        let fixtures: std::collections::BTreeMap<String, Value> = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../apple/TetherKit/Tests/TetherKitTests/Fixtures/chat-card-adapter-results.json"))).unwrap();
        for (name, update) in fixtures {
            let line = json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":update}});
            let fields = match crate::acp::message::decode(line.to_string().as_bytes(), None) {
                crate::acp::message::Inbound::Update(
                    crate::acp::message::Update::ToolCallUpdate(fields),
                )
                | crate::acp::message::Inbound::ScopedUpdate(
                    crate::acp::message::Update::ToolCallUpdate(fields),
                    _,
                ) => fields,
                _ => panic!("not a result: {name}"),
            };
            let card = fields.card.unwrap_or_else(|| panic!("no card for {name}"));
            assert_eq!(card.kind, name.split('-').next_back().unwrap(), "{name}");
            if card.kind == "image" {
                assert_eq!(card.image.unwrap().pixel_width, Some(1), "{name}");
            }
        }
    }

    #[test]
    fn pending_actions_survive_state_restore_and_finish_with_their_prompt() {
        let mut builder = TranscriptBuilder::new(&Journal::default(), None);
        builder.feed(&line(&fixtures()[1], false)).unwrap();
        let card = cards(builder.state())[0].clone();
        let request = card.request("restart", "a123").unwrap();
        builder.apply(crate::acp::reducer::ChatEvent::user_prompt(
            &request,
            0,
            Some(crate::acp::message::AcpId::Int(7)),
        ));
        assert!(builder.state().card_action_pending(&card.id));
        let restored: ChatState =
            serde_json::from_slice(&serde_json::to_vec(builder.state()).unwrap()).unwrap();
        assert!(restored.card_action_pending(&card.id));
        builder
            .feed(b"{\"jsonrpc\":\"2.0\",\"id\":7,\"result\":{\"stopReason\":\"end_turn\"}}\n")
            .unwrap();
        assert!(!builder.state().card_action_pending(&card.id));
        assert!(!request.contains("cardId"));
    }

    fn fixtures() -> Vec<Value> {
        serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../apple/TetherKit/Tests/TetherKitTests/Fixtures/chat-cards.json"
        )))
        .unwrap()
    }

    fn line(card: &Value, image: bool) -> Vec<u8> {
        tool_result(card, image, true, &format!("publish-{}", card["id"]))
    }

    fn tool_result(card: &Value, image: bool, publisher: bool, id: &str) -> Vec<u8> {
        let text = format!("{MARKER}{card}");
        let content = if image {
            json!([{"type":"content","content":{"type":"image","mimeType":"image/png","data":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1cAAAAASUVORK5CYII="}}])
        } else {
            json!([])
        };
        let mut update = json!({
            "sessionUpdate":"tool_call_update","toolCallId":id,"status":"completed",
            "rawOutput":{"content":[{"type":"text","text":text}]}, "content":content});
        if publisher {
            update["_meta"] = json!({"tether":{"card":true}});
        }
        let value = json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":update}});
        format!("{value}\n").into_bytes()
    }

    #[test]
    fn a_card_in_another_tools_output_is_not_rendered() {
        let mut builder = TranscriptBuilder::new(&Journal::default(), None);
        builder
            .feed(br#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"tool_call","toolCallId":"bash-1","title":"cat page.html","kind":"execute","status":"pending"}}}
"#)
            .unwrap();
        builder
            .feed(&tool_result(&fixtures()[1], false, false, "bash-1"))
            .unwrap();
        assert!(cards(builder.state()).is_empty());
    }

    #[test]
    fn a_codex_call_named_by_its_title_renders_its_card() {
        let mut builder = TranscriptBuilder::new(&Journal::default(), None);
        builder
            .feed(br#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"tool_call","toolCallId":"mcp-1","title":"mcp.tether-cards.tether_publish_card","kind":"execute","status":"pending"}}}
"#)
            .unwrap();
        builder
            .feed(&tool_result(&fixtures()[0], false, false, "mcp-1"))
            .unwrap();
        assert_eq!(cards(builder.state()).len(), 1);
    }

    fn cards(state: &ChatState) -> Vec<&Card> {
        state
            .items
            .iter()
            .filter_map(|i| match &i.kind {
                ItemKind::Card(c) => Some(c),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn shared_fixtures_decode_and_store_only_image_references() {
        let mut builder = TranscriptBuilder::new(&Journal::default(), None);
        for (i, card) in fixtures().iter().enumerate() {
            builder.feed(&line(card, i == 2)).unwrap();
        }
        let found = cards(builder.state());
        assert_eq!(
            found.iter().map(|c| c.kind.as_str()).collect::<Vec<_>>(),
            ["weather", "docker", "image"]
        );
        assert_eq!(found[2].image.as_ref().unwrap().pixel_width, Some(1));
        assert!(found[1].payload["containers"][1]["cpuPercent"].is_null());
        let snapshot = serde_json::to_vec(builder.state()).unwrap();
        assert_eq!(
            &serde_json::from_slice::<ChatState>(&snapshot).unwrap(),
            builder.state()
        );
    }

    #[test]
    fn revisions_preserve_position_and_bytewise_replay_matches() {
        let mut fixtures = fixtures();
        let mut log: Vec<u8> = fixtures.iter().flat_map(|c| line(c, false)).collect();
        fixtures[0]["revision"] = json!(2);
        fixtures[0]["title"] = json!("Updated weather");
        log.extend(line(&fixtures[0], false));
        fixtures[0]["revision"] = json!(1);
        log.extend(line(&fixtures[0], false));
        let expected = TranscriptBuilder::replay(&log, &Journal::default(), None).unwrap();
        assert_eq!(
            cards(&expected)
                .iter()
                .map(|c| c.revision)
                .collect::<Vec<_>>(),
            [2, 1, 1]
        );
        assert_eq!(cards(&expected)[0].title, "Updated weather");
        let mut builder = TranscriptBuilder::new(&Journal::default(), None);
        for byte in log {
            builder.feed(&[byte]).unwrap();
        }
        assert_eq!(builder.state(), &expected);
    }

    #[test]
    fn unknown_versions_fall_back_and_invalid_payloads_are_ignored() {
        let mut value = fixtures().remove(0);
        value["version"] = json!(99);
        let mut builder = TranscriptBuilder::new(&Journal::default(), None);
        builder.feed(&line(&value, false)).unwrap();
        assert!(!cards(builder.state())[0].supported());
        value["revision"] = json!(-1);
        builder.feed(&line(&value, false)).unwrap();
        value["version"] = json!(1);
        value["revision"] = json!(3);
        value["payload"] = json!({"location":"missing observations"});
        builder.feed(&line(&value, false)).unwrap();
        assert_eq!(cards(builder.state()).len(), 1);
        assert_eq!(cards(builder.state())[0].revision, 1);
    }

    #[test]
    fn actions_are_bound_to_a_known_container_and_never_contain_commands() {
        let value = fixtures().remove(1);
        let card = Card::decode(&Value::String(format!("{MARKER}{value}")), &[]).unwrap();
        assert!(card.request("restart", "wrong-host-container").is_none());
        assert!(card.request("run arbitrary shell", "a123").is_none());
        let request = card.request("restart", "a123").unwrap();
        assert!(request.contains("homelab") && request.contains("a123"));
    }
}
