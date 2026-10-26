use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::images::{ImageRef, ImageSink, prepare_base64};
use super::question::{ElicitationRequest, number_text, schema_fields};
use super::tooldetail::looks_like_blob;

/// A JSON-RPC id: the agent's requests use either a number or a string.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(untagged)]
pub enum AcpId {
    Int(i64),
    Str(String),
}

impl AcpId {
    pub fn to_json(&self) -> Value {
        match self {
            Self::Int(v) => Value::from(*v),
            Self::Str(v) => Value::String(v.clone()),
        }
    }

    /// `int(5)` / `string("x")`: the iOS client's description, which orders adopted host answers
    /// and feeds the snapshot digest.
    pub fn describe(&self) -> String {
        match self {
            Self::Int(v) => format!("int({v})"),
            Self::Str(v) => format!("string({v:?})"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolKind {
    Read,
    Edit,
    Delete,
    Move,
    Search,
    Execute,
    Think,
    Fetch,
    SwitchMode,
    Other,
}

impl ToolKind {
    pub fn parse(text: &str) -> Option<Self> {
        Some(match text {
            "read" => Self::Read,
            "edit" => Self::Edit,
            "delete" => Self::Delete,
            "move" => Self::Move,
            "search" => Self::Search,
            "execute" => Self::Execute,
            "think" => Self::Think,
            "fetch" => Self::Fetch,
            "switch_mode" => Self::SwitchMode,
            "other" => Self::Other,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolStatus {
    Pending,
    InProgress,
    Completed,
    Failed,
}

impl ToolStatus {
    pub fn parse(text: &str) -> Option<Self> {
        Some(match text {
            "pending" => Self::Pending,
            "in_progress" => Self::InProgress,
            "completed" => Self::Completed,
            "failed" => Self::Failed,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AcpDiff {
    pub path: String,
    pub old_text: Option<String>,
    pub new_text: String,
}

/// A tool call as the agent sent it; every field but the id is optional because
/// `tool_call_update` carries only what changed.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolFields {
    pub id: String,
    pub title: Option<String>,
    pub kind: Option<ToolKind>,
    pub status: Option<ToolStatus>,
    pub diff: Option<AcpDiff>,
    pub text: Option<String>,
    pub raw_output: Option<String>,
    /// Image blocks of the call's content, already handed to the image store.
    pub images: Option<Vec<ImageRef>>,
    /// `_meta.claudeCode.toolName`, which tells a subagent launch ("Agent", older "Task") from any other call.
    pub tool_name: Option<String>,
    /// `_meta.claudeCode.parentToolUseId`: set on a subagent's own tool calls.
    pub parent_id: Option<String>,
    /// Scalar fields of `rawInput`, stringified; a subagent launch fills them in progressively.
    pub input: Option<BTreeMap<String, String>>,
}

impl ToolFields {
    pub fn new(id: &str) -> Self {
        Self {
            id: id.to_string(),
            ..Self::default()
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlanEntry {
    pub content: String,
    pub status: String,
    pub priority: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PermissionOption {
    pub option_id: String,
    pub name: String,
    pub kind: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermissionRequest {
    pub tool: ToolFields,
    pub options: Vec<PermissionOption>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConfigChoice {
    pub value: String,
    pub name: String,
    pub description: String,
}

/// A select-type session setting such as mode, model or effort; `current_value` is one of the choices' values.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConfigOption {
    pub id: String,
    pub name: String,
    pub description: String,
    pub category: Option<String>,
    pub current_value: String,
    pub choices: Vec<ConfigChoice>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Command {
    pub name: String,
    pub description: String,
    /// Present when the command takes arguments.
    pub hint: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Cost {
    pub amount: f64,
    pub currency: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Update {
    AgentMessage {
        text: String,
        message_id: Option<String>,
    },
    AgentImage {
        image: ImageRef,
        message_id: Option<String>,
    },
    AgentThought {
        text: String,
    },
    UserMessage {
        text: String,
        message_id: Option<String>,
    },
    ToolCall(ToolFields),
    ToolCallUpdate(ToolFields),
    Plan(Vec<PlanEntry>),
    CurrentMode(String),
    SessionInfo {
        title: Option<String>,
    },
    Usage {
        used: i64,
        size: i64,
        cost: Option<Cost>,
        model_id: Option<String>,
    },
    ConfigOptions(Vec<ConfigOption>),
    Commands(Vec<Command>),
    Unknown {
        kind: String,
    },
}

/// Responses carry no method, so one struct holds whichever fields the result had.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AcpResult {
    pub load_session: Option<bool>,
    pub session_id: Option<String>,
    pub stop_reason: Option<String>,
    pub config_options: Option<Vec<ConfigOption>>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Inbound {
    Response {
        id: AcpId,
        result: AcpResult,
    },
    ErrorResponse {
        id: Option<AcpId>,
        code: i64,
        message: String,
    },
    Update(Update),
    PermissionRequest {
        id: AcpId,
        request: PermissionRequest,
    },
    Elicitation {
        id: AcpId,
        request: ElicitationRequest,
    },
    /// The adapter's `_auth/status_update`: whether the host's agent has a login. Sent at session start and
    /// again when a queued prompt begins.
    AuthStatus {
        signed_in: bool,
    },
    /// A line another client attached to the same holder sent (`_tether/client`).
    ClientEcho {
        client: String,
        message: Value,
    },
    Unknown {
        method: Option<String>,
    },
}

type Json = Map<String, Value>;

/// Rebuilds every object with its keys in sorted order, whatever order the map keeps.
pub(crate) fn sorted(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let mut out = Map::new();
            for k in keys {
                out.insert(k.clone(), sorted(&map[k]));
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.iter().map(sorted).collect()),
        other => other.clone(),
    }
}

fn int(value: Option<&Value>) -> Option<i64> {
    let n = value?.as_number()?;
    if let Some(i) = n.as_i64() {
        return Some(i);
    }
    let f = n.as_f64()?;
    (f.fract() == 0.0 && f.abs() < 9.0e15).then_some(f as i64)
}

fn string(value: Option<&Value>) -> Option<String> {
    value?.as_str().map(str::to_string)
}

fn object(value: Option<&Value>) -> Option<&Json> {
    value?.as_object()
}

fn objects(value: Option<&Value>) -> Option<Vec<&Json>> {
    let items = value?.as_array()?;
    items.iter().map(Value::as_object).collect()
}

/// Total: any input, however malformed, decodes to something. One bad line must not end the stream.
/// Image bytes in the line go to `images` (when given) and only references come out.
pub fn decode(line: &[u8], images: Option<&dyn ImageSink>) -> Inbound {
    let Ok(Value::Object(object_)) = serde_json::from_slice::<Value>(line) else {
        return Inbound::Unknown { method: None };
    };
    let id = parse_id(object_.get("id"));
    if let Some(method) = object_.get("method").and_then(Value::as_str) {
        let empty = Map::new();
        let params = object(object_.get("params")).unwrap_or(&empty);
        if let Some(id) = id {
            if method == "session/request_permission"
                && let Some(request) = permission(params)
            {
                return Inbound::PermissionRequest { id, request };
            }
            if method == "elicitation/create" {
                return Inbound::Elicitation {
                    id,
                    request: elicitation(params),
                };
            }
            return Inbound::Unknown {
                method: Some(method.to_string()),
            };
        }
        if method == "session/update"
            && let Some(update) = object(params.get("update"))
        {
            return Inbound::Update(decode_update(update, images));
        }
        if method == super::echo::METHOD
            && let Some(client) = params.get("client").and_then(Value::as_str)
            && let Some(message) = params.get("message")
        {
            return Inbound::ClientEcho {
                client: client.to_string(),
                message: message.clone(),
            };
        }
        if method == "_auth/status_update"
            && let Some(kind) = object(params.get("authStatus"))
                .and_then(|s| s.get("kind"))
                .and_then(Value::as_str)
        {
            return Inbound::AuthStatus {
                signed_in: kind != "none",
            };
        }
        return Inbound::Unknown {
            method: Some(method.to_string()),
        };
    }
    if let Some(error) = object(object_.get("error")) {
        return Inbound::ErrorResponse {
            id,
            code: int(error.get("code")).unwrap_or(0),
            message: string(error.get("message")).unwrap_or_default(),
        };
    }
    if let Some(id) = id
        && let Some(result) = object_.get("result")
    {
        let empty = Map::new();
        return Inbound::Response {
            id,
            result: decode_result(object(Some(result)).unwrap_or(&empty)),
        };
    }
    Inbound::Unknown { method: None }
}

pub(crate) fn parse_id(value: Option<&Value>) -> Option<AcpId> {
    match value? {
        Value::String(s) => Some(AcpId::Str(s.clone())),
        Value::Number(_) => int(value).map(AcpId::Int),
        _ => None,
    }
}

fn decode_result(result: &Json) -> AcpResult {
    let capabilities = object(result.get("agentCapabilities"));
    AcpResult {
        load_session: capabilities
            .and_then(|c| c.get("loadSession"))
            .and_then(Value::as_bool),
        session_id: string(result.get("sessionId")),
        stop_reason: string(result.get("stopReason")),
        config_options: objects(result.get("configOptions")).map(|o| config_options(&o)),
    }
}

fn decode_update(update: &Json, images: Option<&dyn ImageSink>) -> Update {
    let kind = string(update.get("sessionUpdate")).unwrap_or_default();
    let unknown = || Update::Unknown { kind: kind.clone() };
    match kind.as_str() {
        "agent_message_chunk" => {
            if let Some(block) = object(update.get("content"))
                && block.get("type").and_then(Value::as_str) == Some("image")
            {
                return match image_ref(block, images) {
                    Some(image) => Update::AgentImage {
                        image,
                        message_id: string(update.get("messageId")),
                    },
                    None => unknown(),
                };
            }
            match content_text(update.get("content")) {
                Some(text) => Update::AgentMessage {
                    text,
                    message_id: string(update.get("messageId")),
                },
                None => unknown(),
            }
        }
        "agent_thought_chunk" => match content_text(update.get("content")) {
            Some(text) => Update::AgentThought { text },
            None => unknown(),
        },
        "user_message_chunk" => match content_text(update.get("content")) {
            Some(text) => Update::UserMessage {
                text,
                message_id: string(update.get("messageId")),
            },
            None => unknown(),
        },
        "tool_call" | "tool_call_update" => match tool_fields(update, images, true) {
            Some(fields) if kind == "tool_call" => Update::ToolCall(fields),
            Some(fields) => Update::ToolCallUpdate(fields),
            None => unknown(),
        },
        "plan" => {
            let entries = update
                .get("entries")
                .and_then(Value::as_array)
                .and_then(|a| a.iter().map(Value::as_object).collect::<Option<Vec<_>>>())
                .unwrap_or_default();
            Update::Plan(
                entries
                    .into_iter()
                    .map(|e| PlanEntry {
                        content: string(e.get("content")).unwrap_or_default(),
                        status: string(e.get("status")).unwrap_or_else(|| "pending".into()),
                        priority: string(e.get("priority")).unwrap_or_else(|| "medium".into()),
                    })
                    .collect(),
            )
        }
        "current_mode_update" => match string(update.get("currentModeId")) {
            Some(mode) => Update::CurrentMode(mode),
            None => unknown(),
        },
        "session_info_update" => Update::SessionInfo {
            title: string(update.get("title")),
        },
        "usage_update" => {
            let (Some(used), Some(size)) = (int(update.get("used")), int(update.get("size")))
            else {
                return unknown();
            };
            let cost = object(update.get("cost")).and_then(|raw| {
                let amount = raw.get("amount")?.as_f64()?;
                Some(Cost {
                    amount,
                    currency: string(raw.get("currency")).unwrap_or_else(|| "USD".into()),
                })
            });
            let model_id = object(update.get("_meta")).and_then(|m| string(m.get("_claude/model")));
            Update::Usage {
                used,
                size,
                cost,
                model_id,
            }
        }
        "config_option_update" => match objects(update.get("configOptions")) {
            Some(raw) => Update::ConfigOptions(config_options(&raw)),
            None => unknown(),
        },
        "available_commands_update" => match objects(update.get("availableCommands")) {
            Some(raw) => Update::Commands(
                raw.into_iter()
                    .filter_map(|command| {
                        let name = string(command.get("name")).filter(|n| !n.is_empty())?;
                        let hint = object(command.get("input")).and_then(|i| string(i.get("hint")));
                        Some(Command {
                            name,
                            description: string(command.get("description")).unwrap_or_default(),
                            hint,
                        })
                    })
                    .collect(),
            ),
            None => unknown(),
        },
        _ => unknown(),
    }
}

fn config_options(raw: &[&Json]) -> Vec<ConfigOption> {
    raw.iter()
        .filter_map(|option| {
            if option.get("type").map_or(Some("select"), Value::as_str) != Some("select") {
                return None;
            }
            let id = string(option.get("id"))?;
            let current = string(option.get("currentValue"))?;
            let choices = option
                .get("options")
                .and_then(Value::as_array)
                .and_then(|a| a.iter().map(Value::as_object).collect::<Option<Vec<_>>>())
                .unwrap_or_default()
                .into_iter()
                .filter_map(|choice| {
                    let value = string(choice.get("value"))?;
                    Some(ConfigChoice {
                        name: string(choice.get("name")).unwrap_or_else(|| value.clone()),
                        description: string(choice.get("description")).unwrap_or_default(),
                        value,
                    })
                })
                .collect();
            Some(ConfigOption {
                name: string(option.get("name")).unwrap_or_else(|| id.clone()),
                description: string(option.get("description")).unwrap_or_default(),
                category: string(option.get("category")),
                current_value: current,
                choices,
                id,
            })
        })
        .collect()
}

fn content_text(value: Option<&Value>) -> Option<String> {
    let block = object(value)?;
    if block.get("type").and_then(Value::as_str) != Some("text") {
        return None;
    }
    string(block.get("text"))
}

/// A block that is not an image, not base64, or too large is skipped; the stream carries on.
fn image_ref(block: &Json, sink: Option<&dyn ImageSink>) -> Option<ImageRef> {
    let encoded = block.get("data")?.as_str()?;
    let prepared = prepare_base64(encoded, block.get("mimeType").and_then(Value::as_str))?;
    if let Some(sink) = sink {
        sink.write(&prepared.data, &prepared.r);
    }
    Some(prepared.r)
}

/// An image result as raw output (or its JSON text): the content already carries the picture.
fn is_image_payload(value: &Value) -> bool {
    match value {
        Value::Array(items) => items.iter().any(is_image_payload),
        Value::Object(o) => {
            o.get("type").and_then(Value::as_str) == Some("image")
                || object(o.get("source"))
                    .and_then(|s| s.get("type"))
                    .and_then(Value::as_str)
                    == Some("base64")
        }
        _ => false,
    }
}

fn scalar_input(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.clone()),
        Value::Bool(b) => Some(b.to_string()),
        Value::Number(n) => Some(number_text(n)),
        _ => None,
    }
}

fn tool_fields(
    object_: &Json,
    sink: Option<&dyn ImageSink>,
    collect_images: bool,
) -> Option<ToolFields> {
    let mut fields = ToolFields::new(object_.get("toolCallId")?.as_str()?);
    fields.title = string(object_.get("title"));
    let meta = object(object_.get("_meta")).and_then(|m| object(m.get("claudeCode")));
    fields.tool_name = meta.and_then(|m| string(m.get("toolName")));
    fields.parent_id = meta.and_then(|m| string(m.get("parentToolUseId")));
    if let Some(input) = object(object_.get("rawInput")) {
        let scalars: BTreeMap<String, String> = input
            .iter()
            .filter_map(|(k, v)| scalar_input(v).map(|s| (k.clone(), s)))
            .collect();
        if !scalars.is_empty() {
            fields.input = Some(scalars);
        }
    }
    fields.kind = object_.get("kind").map(|v| {
        v.as_str()
            .and_then(ToolKind::parse)
            .unwrap_or(ToolKind::Other)
    });
    fields.status = object_
        .get("status")
        .and_then(Value::as_str)
        .and_then(ToolStatus::parse);
    let mut texts: Vec<String> = Vec::new();
    let mut refs: Vec<ImageRef> = Vec::new();
    for item in objects_lossy(object_.get("content")) {
        match item.get("type").and_then(Value::as_str) {
            Some("diff") => {
                fields.diff = Some(AcpDiff {
                    path: string(item.get("path")).unwrap_or_default(),
                    old_text: string(item.get("oldText")),
                    new_text: string(item.get("newText")).unwrap_or_default(),
                });
            }
            Some("content") => {
                if let Some(text) = content_text(item.get("content")) {
                    if !looks_like_blob(&text) {
                        texts.push(text);
                    }
                } else if collect_images
                    && let Some(block) = object(item.get("content"))
                    && block.get("type").and_then(Value::as_str) == Some("image")
                    && let Some(r) = image_ref(block, sink)
                {
                    refs.push(r);
                }
            }
            _ => {}
        }
    }
    if !texts.is_empty() {
        fields.text = Some(texts.join("\n"));
    }
    if !refs.is_empty() {
        fields.images = Some(refs);
    }
    match object_.get("rawOutput") {
        Some(Value::String(text)) => {
            if !looks_like_blob(text) {
                fields.raw_output = Some(text.clone());
            }
        }
        Some(other @ (Value::Array(_) | Value::Object(_))) if !is_image_payload(other) => {
            fields.raw_output = serde_json::to_string(&sorted(other)).ok();
        }
        _ => {}
    }
    Some(fields)
}

/// `[JSON]` cast: a content array with any non-object entry is ignored whole.
fn objects_lossy(value: Option<&Value>) -> Vec<&Json> {
    objects(value).unwrap_or_default()
}

/// A malformed form still becomes a question the user can decline: the agent waits for a reply either way.
fn elicitation(params: &Json) -> ElicitationRequest {
    let message = string(params.get("message")).unwrap_or_default();
    ElicitationRequest {
        tool_call_id: string(params.get("toolCallId")),
        message: if message.is_empty() {
            "The agent has a question.".to_string()
        } else {
            message
        },
        fields: schema_fields(params.get("requestedSchema").unwrap_or(&Value::Null)),
    }
}

fn permission(params: &Json) -> Option<PermissionRequest> {
    let call = object(params.get("toolCall"))?;
    let tool = tool_fields(call, None, false)?;
    let options = objects_lossy(params.get("options"))
        .into_iter()
        .filter_map(|option| {
            let id = string(option.get("optionId"))?;
            Some(PermissionOption {
                name: string(option.get("name")).unwrap_or_else(|| id.clone()),
                kind: string(option.get("kind")).unwrap_or_default(),
                option_id: id,
            })
        })
        .collect();
    Some(PermissionRequest { tool, options })
}

#[cfg(test)]
mod tests {
    use super::super::fixture;
    use super::super::images::testimg::{b64, jpeg, png};
    use super::super::images::{DEFAULT_BUDGET, DIRECTORY_SUFFIX, ImageStore};
    use super::*;
    use serde_json::json;

    pub(crate) fn update(body: Value) -> String {
        sorted_string(
            &json!({"jsonrpc": "2.0", "method": "session/update", "params": {"update": body}}),
        )
    }

    fn sorted_string(v: &Value) -> String {
        serde_json::to_string(&sorted(v)).unwrap()
    }

    fn dec(line: &str) -> Inbound {
        decode(line.as_bytes(), None)
    }

    fn dec_value(v: Value) -> Inbound {
        decode(&serde_json::to_vec(&v).unwrap(), None)
    }

    fn read_result(data: &[u8], id: &str) -> String {
        let b = b64(data);
        update(json!({
            "sessionUpdate": "tool_call_update", "toolCallId": id, "status": "completed", "title": "Read pic.png",
            "content": [{"type": "content", "content": {"type": "image", "data": b, "mimeType": "image/png"}}],
            "rawOutput": [{"type": "image", "source": {"type": "base64", "data": b, "media_type": "image/png"}}],
            "_meta": {"claudeCode": {"toolName": "Read",
                "toolResponse": {"type": "image", "file": {"base64": b, "type": "image/png", "originalSize": data.len()}}}},
        }))
    }

    fn agent_image(data: &[u8], mime: Option<&str>) -> String {
        let mut block = json!({"type": "image", "data": b64(data)});
        if let Some(m) = mime {
            block["mimeType"] = json!(m);
        }
        update(json!({"sessionUpdate": "agent_message_chunk", "messageId": "m1", "content": block}))
    }

    #[test]
    fn ids_round_trip_as_numbers_or_strings() {
        assert_eq!(serde_json::to_string(&AcpId::Int(3)).unwrap(), "3");
        assert_eq!(
            serde_json::to_string(&AcpId::Str("a".into())).unwrap(),
            "\"a\""
        );
        assert_eq!(serde_json::from_str::<AcpId>("7").unwrap(), AcpId::Int(7));
        assert_eq!(
            serde_json::from_str::<AcpId>("\"r\"").unwrap(),
            AcpId::Str("r".into())
        );
        assert_eq!(AcpId::Int(5).describe(), "int(5)");
        assert_eq!(AcpId::Str("x".into()).describe(), "string(\"x\")");
    }

    #[test]
    fn garbage_decodes_to_unknown() {
        for line in [
            "",
            "not json",
            "[1,2]",
            "42",
            "{\"id\":1}",
            "{\"jsonrpc\":\"2.0\"}",
        ] {
            assert_eq!(dec(line), Inbound::Unknown { method: None }, "{line}");
        }
        assert_eq!(
            dec("{\"method\":\"foo/bar\",\"params\":{}}"),
            Inbound::Unknown {
                method: Some("foo/bar".into())
            }
        );
    }

    #[test]
    fn responses_errors_and_auth_status() {
        assert_eq!(
            dec("{\"id\":3,\"result\":{\"stopReason\":\"end_turn\"}}"),
            Inbound::Response {
                id: AcpId::Int(3),
                result: AcpResult {
                    stop_reason: Some("end_turn".into()),
                    ..AcpResult::default()
                }
            }
        );
        assert_eq!(
            dec("{\"id\":\"x\",\"error\":{\"code\":-32602,\"message\":\"bad\"}}"),
            Inbound::ErrorResponse {
                id: Some(AcpId::Str("x".into())),
                code: -32602,
                message: "bad".into()
            }
        );
        assert_eq!(
            dec("{\"error\":{}}"),
            Inbound::ErrorResponse {
                id: None,
                code: 0,
                message: String::new()
            }
        );
        let status = |kind: &str| {
            dec_value(
                json!({"method": "_auth/status_update", "params": {"authStatus": {"kind": kind}}}),
            )
        };
        assert_eq!(status("none"), Inbound::AuthStatus { signed_in: false });
        assert_eq!(status("oauth"), Inbound::AuthStatus { signed_in: true });
    }

    #[test]
    fn the_recorded_turn_decodes_without_dropping_a_line() {
        for line in fixture::TURN.agent_lines() {
            let m = dec(&line);
            if let Inbound::Unknown { method } = &m {
                panic!("{line}: {method:?}");
            }
            if let Inbound::Update(Update::Unknown { kind }) = &m {
                panic!("{line}: {kind}");
            }
        }
    }

    #[test]
    fn the_initialize_response_reports_load_session() {
        let line = &fixture::TURN.agent_lines()[0];
        let Inbound::Response { id, result } = dec(line) else {
            panic!()
        };
        assert_eq!(id, AcpId::Int(1));
        assert_eq!(result.load_session, Some(true));
    }

    #[test]
    fn a_tool_calls_scalar_input_keeps_numbers_and_booleans() {
        let line = update(json!({
            "sessionUpdate": "tool_call", "toolCallId": "t", "kind": "frob",
            "rawInput": {"a": "x", "n": 3, "f": 1.5, "b": true, "nested": {"z": 1}, "nothing": null},
        }));
        let Inbound::Update(Update::ToolCall(fields)) = dec(&line) else {
            panic!()
        };
        let input = fields.input.unwrap();
        assert_eq!(input["a"], "x");
        assert_eq!(input["n"], "3");
        assert_eq!(input["f"], "1.5");
        assert_eq!(input["b"], "true");
        assert_eq!(input.len(), 4);
        assert_eq!(fields.kind, Some(ToolKind::Other));
    }

    #[test]
    fn raw_output_objects_are_kept_as_sorted_json() {
        let line = update(json!({
            "sessionUpdate": "tool_call_update", "toolCallId": "t",
            "rawOutput": {"b": 1, "a": {"d": 1, "c": "x/y"}},
        }));
        let Inbound::Update(Update::ToolCallUpdate(fields)) = dec(&line) else {
            panic!()
        };
        assert_eq!(
            fields.raw_output.unwrap(),
            r#"{"a":{"c":"x/y","d":1},"b":1}"#
        );
    }

    #[test]
    fn available_commands_keep_hints_and_drop_nameless_entries() {
        let line = update(
            json!({"sessionUpdate": "available_commands_update", "availableCommands": [
                {"name": "context", "description": "d", "input": null},
                {"name": "", "description": "x"},
                {"name": "plan", "input": {"hint": "what"}},
            ]}),
        );
        let Inbound::Update(Update::Commands(commands)) = dec(&line) else {
            panic!()
        };
        assert_eq!(
            commands,
            [
                Command {
                    name: "context".into(),
                    description: "d".into(),
                    hint: None
                },
                Command {
                    name: "plan".into(),
                    description: String::new(),
                    hint: Some("what".into())
                },
            ]
        );
    }

    #[test]
    fn usage_needs_integers_and_carries_cost_and_model() {
        let line = update(
            json!({"sessionUpdate": "usage_update", "used": 5, "size": 10,
            "cost": {"amount": 0.5}, "_meta": {"_claude/model": "m"}}),
        );
        assert_eq!(
            dec(&line),
            Inbound::Update(Update::Usage {
                used: 5,
                size: 10,
                cost: Some(Cost {
                    amount: 0.5,
                    currency: "USD".into()
                }),
                model_id: Some("m".into())
            })
        );
        let bad = update(json!({"sessionUpdate": "usage_update", "used": "5", "size": 10}));
        assert_eq!(
            dec(&bad),
            Inbound::Update(Update::Unknown {
                kind: "usage_update".into()
            })
        );
    }

    fn elicitation_request(properties: Value, id: Value) -> Inbound {
        dec_value(json!({
            "jsonrpc": "2.0", "id": id, "method": "elicitation/create",
            "params": {"mode": "form", "sessionId": "s", "toolCallId": "t1", "message": "Pick",
                "requestedSchema": {"type": "object", "properties": properties}},
        }))
    }

    #[test]
    fn the_recorded_request_decodes_to_one_single_select_with_an_other_companion() {
        let lines = fixture::ELICITATION.agent_lines();
        let line = &lines[fixture::ELICITATION.index_containing("elicitation/create")];
        let Inbound::Elicitation { id, request } = dec(line) else {
            panic!()
        };
        assert_eq!(id, AcpId::Int(0));
        assert_eq!(
            request.tool_call_id.as_deref(),
            Some("toolu_018YwX7H4Ke3gQSGdDrZaV2s")
        );
        assert_eq!(request.message, "Which colour do you prefer?");
        assert_eq!(request.fields.len(), 1);
        let field = &request.fields[0];
        assert_eq!(field.name, "question_0");
        assert_eq!(field.title, "Colour");
        let values: Vec<_> = field.choices().iter().map(|c| c.value.as_str()).collect();
        assert_eq!(values, ["red", "green", "blue"]);
        let descriptions: Vec<_> = field
            .choices()
            .iter()
            .map(|c| c.description.as_str())
            .collect();
        assert_eq!(descriptions, ["Red", "Green", "Blue"]);
        assert!(!field.required);
        let custom = field.custom.as_ref().unwrap();
        assert_eq!(
            (custom.name.as_str(), custom.title.as_str()),
            ("question_0_custom", "Other")
        );
        assert!(matches!(
            field.kind,
            super::super::question::FieldKind::Single(_)
        ));
    }

    #[test]
    fn the_recorded_elicitation_log_is_decoded_without_dropping_any_line() {
        for line in fixture::ELICITATION.agent_lines() {
            if matches!(dec(&line), Inbound::Unknown { .. }) && !line.contains("session/update") {
                panic!("{line}");
            }
        }
    }

    #[test]
    fn the_recorded_initialize_advertises_the_form_capability() {
        let line = &fixture::ELICITATION.client_lines()[0];
        let v: Value = serde_json::from_str(line).unwrap();
        assert_eq!(
            v["params"]["clientCapabilities"]["elicitation"],
            json!({"form": {}})
        );
    }

    #[test]
    fn a_malformed_request_still_becomes_a_question_the_user_can_decline() {
        for params in [
            json!({}),
            json!({"message": 4}),
            json!({"requestedSchema": "no"}),
            json!({"requestedSchema": {"properties": 3}}),
        ] {
            let m = dec_value(
                json!({"jsonrpc": "2.0", "id": "r-1", "method": "elicitation/create", "params": params}),
            );
            let Inbound::Elicitation { id, request } = m else {
                panic!("{params}")
            };
            assert_eq!(id, AcpId::Str("r-1".into()));
            assert_eq!(request.message, "The agent has a question.");
            assert!(request.fields.is_empty());
        }
        assert_eq!(
            dec_value(json!({"jsonrpc": "2.0", "method": "elicitation/create", "params": {}})),
            Inbound::Unknown {
                method: Some("elicitation/create".into())
            },
            "a notification has nothing to reply to"
        );
        let _ = elicitation_request(json!({}), json!(1));
    }

    #[test]
    fn a_read_of_an_image_yields_a_reference_and_no_raw_output() {
        let root = tempfile::tempdir().unwrap();
        let store = ImageStore::new(
            root.path().join(format!("c{DIRECTORY_SUFFIX}")),
            root.path().to_path_buf(),
            DEFAULT_BUDGET,
        );
        let data = png(8, 6, 1);
        let Inbound::Update(Update::ToolCallUpdate(fields)) =
            decode(read_result(&data, "r1").as_bytes(), Some(&store))
        else {
            panic!()
        };
        let refs = fields.images.unwrap();
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].mime_type, "image/png");
        assert_eq!(
            (refs[0].pixel_width, refs[0].pixel_height),
            (Some(8), Some(6))
        );
        assert_eq!(refs[0].byte_count, data.len());
        assert_eq!(fields.raw_output, None);
        assert_eq!(fields.text, None);
        assert_eq!(std::fs::read(store.path(&refs[0])).unwrap(), data);
    }

    #[test]
    fn the_reference_is_the_same_with_or_without_a_store() {
        let data = png(8, 6, 2);
        let root = tempfile::tempdir().unwrap();
        let store = ImageStore::new(
            root.path().join(format!("c{DIRECTORY_SUFFIX}")),
            root.path().to_path_buf(),
            DEFAULT_BUDGET,
        );
        let line = read_result(&data, "r1");
        assert_eq!(dec(&line), decode(line.as_bytes(), Some(&store)));
    }

    #[test]
    fn a_missing_mime_type_is_sniffed_and_a_wrong_one_loses_to_the_bytes() {
        for (data, mime) in [(png(8, 6, 0), "image/png"), (jpeg(8, 6, 0), "image/jpeg")] {
            let Inbound::Update(Update::AgentImage { image, .. }) = dec(&agent_image(&data, None))
            else {
                panic!()
            };
            assert_eq!(image.mime_type, mime);
        }
        let Inbound::Update(Update::AgentImage { image, .. }) =
            dec(&agent_image(&jpeg(8, 6, 0), Some("image/png")))
        else {
            panic!()
        };
        assert_eq!(image.mime_type, "image/jpeg");
    }

    #[test]
    fn bad_base64_or_non_image_bytes_are_ignored_not_thrown() {
        let unknown = Inbound::Update(Update::Unknown {
            kind: "agent_message_chunk".into(),
        });
        let bad = update(json!({"sessionUpdate": "agent_message_chunk",
            "content": {"type": "image", "data": "%%%%", "mimeType": "image/png"}}));
        assert_eq!(dec(&bad), unknown);
        let not_image = update(json!({"sessionUpdate": "agent_message_chunk",
            "content": {"type": "image", "data": b64(b"not an image at all"), "mimeType": "image/png"}}));
        assert_eq!(dec(&not_image), unknown);
        let mixed = update(
            json!({"sessionUpdate": "tool_call_update", "toolCallId": "t", "status": "completed",
            "content": [
                {"type": "content", "content": {"type": "image", "data": "!!", "mimeType": "image/png"}},
                {"type": "content", "content": {"type": "text", "text": "kept"}},
            ]}),
        );
        let Inbound::Update(Update::ToolCallUpdate(fields)) = dec(&mixed) else {
            panic!()
        };
        assert_eq!(fields.images, None);
        assert_eq!(fields.text.as_deref(), Some("kept"));
    }

    #[test]
    fn the_same_picture_twice_shares_one_file_and_one_id() {
        let root = tempfile::tempdir().unwrap();
        let store = ImageStore::new(
            root.path().join(format!("c{DIRECTORY_SUFFIX}")),
            root.path().to_path_buf(),
            DEFAULT_BUDGET,
        );
        let data = png(8, 6, 3);
        decode(
            agent_image(&data, Some("image/png")).as_bytes(),
            Some(&store),
        );
        decode(read_result(&data, "r1").as_bytes(), Some(&store));
        assert_eq!(std::fs::read_dir(store.directory()).unwrap().count(), 1);
    }

    #[test]
    fn a_raw_output_that_is_image_json_is_never_kept() {
        let as_text = format!(
            "[{{\"source\":{{\"data\":\"{}\"}},\"type\":\"image\"}}]",
            b64(&png(8, 6, 0)).repeat(40)
        );
        let line = update(
            json!({"sessionUpdate": "tool_call_update", "toolCallId": "t", "rawOutput": as_text}),
        );
        let Inbound::Update(Update::ToolCallUpdate(fields)) = dec(&line) else {
            panic!()
        };
        assert_eq!(fields.raw_output, None);
    }

    #[test]
    fn an_image_block_in_a_permission_request_is_not_stored() {
        let root = tempfile::tempdir().unwrap();
        let store = ImageStore::new(
            root.path().join(format!("c{DIRECTORY_SUFFIX}")),
            root.path().to_path_buf(),
            DEFAULT_BUDGET,
        );
        let request = json!({"jsonrpc": "2.0", "id": 1, "method": "session/request_permission", "params": {
            "toolCall": {"toolCallId": "t", "content": [{"type": "content", "content": {"type": "image", "data": b64(&png(2, 2, 0))}}]},
            "options": [{"optionId": "a", "name": "Allow", "kind": "allow_once"}],
        }});
        let m = decode(&serde_json::to_vec(&request).unwrap(), Some(&store));
        assert!(matches!(m, Inbound::PermissionRequest { .. }));
        assert!(!store.directory().exists());
    }
}
