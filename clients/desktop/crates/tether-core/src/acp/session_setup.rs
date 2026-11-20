//! What a chat asks the agent for when it opens a session: the capabilities the agent
//! advertised, the fork point of a native branch, extra folders and the HTTP MCP servers.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

/// What `initialize` said the agent can do. Persisted in the journal so a chat whose agent is
/// gone (an ended one) can still decide whether it may be resumed. A key's presence means
/// supported.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentCaps {
    #[serde(default)]
    pub fork: bool,
    #[serde(default)]
    pub resume: bool,
    #[serde(default)]
    pub delete: bool,
    #[serde(default)]
    pub additional_directories: bool,
    #[serde(default)]
    pub mcp_http: bool,
}

impl AgentCaps {
    /// `capabilities` is the `agentCapabilities` object of the `initialize` result.
    pub fn from_agent_capabilities(capabilities: &Map<String, Value>) -> Self {
        let session = capabilities
            .get("sessionCapabilities")
            .and_then(Value::as_object);
        let has = |key: &str| {
            session
                .and_then(|s| s.get(key))
                .is_some_and(|v| !v.is_null())
        };
        Self {
            fork: has("fork"),
            resume: has("resume"),
            delete: has("delete"),
            additional_directories: has("additionalDirectories"),
            mcp_http: capabilities
                .get("mcpCapabilities")
                .and_then(|m| m.get("http"))
                .and_then(Value::as_bool)
                .unwrap_or(false),
        }
    }
}

/// The conversation a branch continues from: the source chat's agent session, and the last
/// assistant message before the chosen prompt (the fork point; `None` copies everything).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ForkSource {
    pub session_id: String,
    #[serde(default)]
    pub message_id: Option<String>,
}

impl ForkSource {
    /// The adapter's fork-point hook; without it the fork copies the whole conversation.
    pub fn meta(&self) -> Option<Value> {
        self.message_id
            .as_ref()
            .map(|id| json!({"jetbrains": {"air": {"fork": {"version": 1, "messageId": id}}}}))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct McpHeader {
    pub name: String,
    pub value: String,
}

/// A saved HTTP MCP server. The headers can hold tokens, so the list lives in the secret store.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct McpServer {
    pub name: String,
    pub url: String,
    #[serde(default)]
    pub headers: Vec<McpHeader>,
}

impl McpServer {
    pub fn wire(&self) -> Value {
        json!({
            "type": "http",
            "name": self.name,
            "url": self.url,
            "headers": self.headers.iter().map(|h| json!({"name": h.name, "value": h.value})).collect::<Vec<_>>(),
        })
    }

    /// Name non-empty and unique among `existing`, URL http(s).
    pub fn validate(&self, existing: &[McpServer]) -> Result<(), &'static str> {
        let name = self.name.trim();
        if name.is_empty() {
            return Err("Give the server a name.");
        }
        if existing.iter().any(|s| s.name.eq_ignore_ascii_case(name)) {
            return Err("A server with that name already exists.");
        }
        let url = self.url.trim();
        let rest = url
            .strip_prefix("https://")
            .or_else(|| url.strip_prefix("http://"));
        if rest.is_none_or(|r| r.is_empty() || r.contains(char::is_whitespace)) {
            return Err("The URL must start with http:// or https://.");
        }
        Ok(())
    }
}

/// One `Name: value` per line; blank lines are skipped.
pub fn parse_header_lines(text: &str) -> Result<Vec<McpHeader>, String> {
    let mut headers = Vec::new();
    for line in text.lines().map(str::trim).filter(|l| !l.is_empty()) {
        match line.split_once(':') {
            Some((name, value))
                if !name.trim().is_empty() && !name.trim().contains(char::is_whitespace) =>
            {
                headers.push(McpHeader {
                    name: name.trim().to_string(),
                    value: value.trim().to_string(),
                });
            }
            _ => return Err(format!("\"{line}\" is not a header; write Name: value.")),
        }
    }
    Ok(headers)
}

/// The saved servers a chat chose, in the order it chose them; a name no longer saved is skipped.
pub fn resolve_servers(saved: &[McpServer], names: &[String]) -> Vec<McpServer> {
    names
        .iter()
        .filter_map(|n| saved.iter().find(|s| &s.name == n).cloned())
        .collect()
}

/// Everything `session/new`, `load`, `fork` and `resume` share.
pub struct Setup<'a> {
    pub cwd: &'a str,
    pub additional_directories: &'a [String],
    pub servers: &'a [McpServer],
    pub caps: AgentCaps,
}

impl Setup<'_> {
    /// `additionalDirectories` only when the agent advertised it, `mcpServers` empty unless it
    /// takes HTTP servers.
    pub fn params(&self) -> Map<String, Value> {
        let mut params = Map::new();
        params.insert("cwd".into(), json!(self.cwd));
        let servers: Vec<Value> = if self.caps.mcp_http {
            self.servers.iter().map(McpServer::wire).collect()
        } else {
            Vec::new()
        };
        params.insert("mcpServers".into(), Value::Array(servers));
        if self.caps.additional_directories && !self.additional_directories.is_empty() {
            params.insert(
                "additionalDirectories".into(),
                json!(self.additional_directories),
            );
        }
        params
    }

    /// The chat asked for servers the agent cannot use.
    pub fn drops_servers(&self) -> bool {
        !self.servers.is_empty() && !self.caps.mcp_http
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server(name: &str, url: &str) -> McpServer {
        McpServer {
            name: name.into(),
            url: url.into(),
            headers: vec![McpHeader {
                name: "Authorization".into(),
                value: "Bearer t".into(),
            }],
        }
    }

    #[test]
    fn capabilities_read_the_presence_of_each_key() {
        let init = json!({
            "sessionCapabilities": {"additionalDirectories": {}, "close": {}, "delete": {}, "fork": {}, "list": {}, "resume": {}},
            "mcpCapabilities": {"http": true, "sse": true},
        });
        let caps = AgentCaps::from_agent_capabilities(init.as_object().unwrap());
        assert_eq!(
            caps,
            AgentCaps {
                fork: true,
                resume: true,
                delete: true,
                additional_directories: true,
                mcp_http: true
            }
        );
        let bare = json!({"loadSession": true});
        assert_eq!(
            AgentCaps::from_agent_capabilities(bare.as_object().unwrap()),
            AgentCaps::default()
        );
        let some = json!({"sessionCapabilities": {"list": {}, "fork": null}, "mcpCapabilities": {"http": false}});
        assert_eq!(
            AgentCaps::from_agent_capabilities(some.as_object().unwrap()),
            AgentCaps::default()
        );
    }

    #[test]
    fn the_fork_point_rides_in_the_air_meta_only_with_a_message_id() {
        let with = ForkSource {
            session_id: "s".into(),
            message_id: Some("m1".into()),
        };
        assert_eq!(
            with.meta().unwrap(),
            json!({"jetbrains": {"air": {"fork": {"version": 1, "messageId": "m1"}}}})
        );
        assert!(
            ForkSource {
                session_id: "s".into(),
                message_id: None
            }
            .meta()
            .is_none()
        );
    }

    #[test]
    fn params_gate_folders_and_servers_on_the_advertised_capabilities() {
        let dirs = vec!["/a".to_string()];
        let servers = vec![server("docs", "https://x.test/mcp")];
        let full = AgentCaps {
            additional_directories: true,
            mcp_http: true,
            ..AgentCaps::default()
        };
        let p = Setup {
            cwd: "/w",
            additional_directories: &dirs,
            servers: &servers,
            caps: full,
        }
        .params();
        assert_eq!(p["additionalDirectories"], json!(["/a"]));
        assert_eq!(
            p["mcpServers"],
            json!([{"type": "http", "name": "docs", "url": "https://x.test/mcp",
                "headers": [{"name": "Authorization", "value": "Bearer t"}]}])
        );
        let none = Setup {
            cwd: "/w",
            additional_directories: &dirs,
            servers: &servers,
            caps: AgentCaps::default(),
        };
        let p = none.params();
        assert!(!p.contains_key("additionalDirectories"));
        assert_eq!(p["mcpServers"], json!([]));
        assert!(none.drops_servers());
    }

    #[test]
    fn server_validation_and_header_lines() {
        let saved = vec![server("docs", "https://x.test")];
        assert!(server("", "https://x.test").validate(&saved).is_err());
        assert!(server("Docs", "https://x.test").validate(&saved).is_err());
        assert!(server("a", "ftp://x.test").validate(&saved).is_err());
        assert!(server("a", "https://").validate(&saved).is_err());
        assert!(
            server("a", "http://localhost:3000/mcp")
                .validate(&saved)
                .is_ok()
        );
        let h = parse_header_lines("Authorization: Bearer a:b\n\n X-Key : v ").unwrap();
        assert_eq!(h[0].value, "Bearer a:b");
        assert_eq!(h[1].name, "X-Key");
        assert!(parse_header_lines("nonsense").is_err());
        assert!(parse_header_lines(": v").is_err());
    }

    #[test]
    fn resolving_keeps_the_chosen_order_and_skips_deleted_servers() {
        let saved = vec![server("a", "http://a"), server("b", "http://b")];
        let names = vec!["b".to_string(), "gone".to_string(), "a".to_string()];
        let out = resolve_servers(&saved, &names);
        assert_eq!(
            out.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
            ["b", "a"]
        );
    }
}
