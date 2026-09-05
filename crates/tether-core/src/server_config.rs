//! Request builders and response parsers for `/api/config` and `/api/admin/*`.
//! No networking — the shell executes the descriptors.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

use crate::host_client::{HostClient, HttpRequest};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerConfig {
    pub push: PushConfig,
    #[serde(default)]
    pub push_devices: u32,
    pub triggers: TriggersConfig,
    pub long_job_seconds: u32,
    pub identity: IdentityConfig,
    pub session: SessionConfig,
    /// Read-only TLS report from GET /api/config. Not sent on PATCH.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tls: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PushConfig {
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TriggersConfig {
    pub waiting: bool,
    /// Absent on a server older than v2.9 — off rather than a parse failure.
    #[serde(default)]
    pub done: bool,
    pub osc_notify: bool,
    pub exit: bool,
    pub long_job: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IdentityConfig {
    pub name: String,
    pub color: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionConfig {
    pub default_shell: String,
    pub default_cwd: String,
    pub scrollback_rows: u32,
    pub silence_ms: u32,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerConfigPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub push: Option<PushConfigPartial>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub triggers: Option<TriggersConfigPartial>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub long_job_seconds: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identity: Option<IdentityConfigPartial>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<SessionConfigPartial>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PushConfigPartial {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TriggersConfigPartial {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub waiting: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub done: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub osc_notify: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub long_job: Option<bool>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct IdentityConfigPartial {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionConfigPartial {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_shell: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scrollback_rows: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub silence_ms: Option<u32>,
}

impl ServerConfigPatch {
    /// True when this patch includes an `identity` key (even if empty).
    /// Callers must gate host-profile rename on this — not on every successful save.
    pub fn contains_identity(&self) -> bool {
        self.identity.is_some()
    }
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum ServerConfigError {
    #[error("invalid server config response")]
    Invalid,
    #[error("{0}")]
    Api(String),
}

fn json_headers() -> BTreeMap<String, String> {
    BTreeMap::from([("Content-Type".to_string(), "application/json".to_string())])
}

pub fn get_config_request(client: &HostClient) -> HttpRequest {
    client.get("/api/config", BTreeMap::new())
}

pub fn patch_config_request(client: &HostClient, patch: &ServerConfigPatch) -> HttpRequest {
    let body = serde_json::to_string(patch).expect("ServerConfigPatch serializes");
    client.patch("/api/config", json_headers(), Some(body))
}

pub fn parse_config_response(status: u16, body: &Value) -> Result<ServerConfig, ServerConfigError> {
    if !(200..300).contains(&status) {
        return Err(api_error(body, status));
    }
    serde_json::from_value(body.clone()).map_err(|_| ServerConfigError::Invalid)
}

pub fn health_version_request(client: &HostClient) -> HttpRequest {
    client.get("/api/health", BTreeMap::new())
}

pub fn parse_health_version(
    status: u16,
    body: &Value,
) -> Result<Option<String>, ServerConfigError> {
    if !(200..300).contains(&status) {
        return Err(api_error(body, status));
    }
    Ok(body
        .get("version")
        .and_then(Value::as_str)
        .map(str::to_string))
}

pub fn update_server_request(client: &HostClient) -> HttpRequest {
    client.post("/api/admin/update", json_headers(), Some("{}".to_string()))
}

pub fn restart_server_request(client: &HostClient) -> HttpRequest {
    client.post(
        "/api/admin/restart",
        json_headers(),
        Some("{}".to_string()),
    )
}

/// Test notification — token auth only; no password in the body.
pub fn test_notification_request(client: &HostClient) -> HttpRequest {
    client.post(
        "/api/admin/test-notification",
        json_headers(),
        Some("{}".to_string()),
    )
}

pub fn parse_admin_ok(status: u16, body: &Value) -> Result<(), ServerConfigError> {
    if !(200..300).contains(&status) {
        return Err(api_error(body, status));
    }
    Ok(())
}

fn api_error(body: &Value, status: u16) -> ServerConfigError {
    let message = body
        .get("error")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| format!("Request failed ({status})"));
    ServerConfigError::Api(message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host_store::HostProfile;
    use serde_json::json;

    fn client() -> HostClient {
        HostClient::new(
            HostProfile {
                id: "h1".into(),
                name: "Studio".into(),
                color: "#89b4fa".into(),
                host: "studio.local".into(),
                port: "8085".into(),
                identity_name: "studio".into(),
                order: 0,
            },
            "secret-token",
        )
    }

    #[test]
    fn get_config_is_authed_get() {
        let req = get_config_request(&client());
        assert_eq!(req.url, "http://studio.local:8085/api/config");
        assert_eq!(req.headers["Authorization"], "Bearer secret-token");
        assert!(req.body.is_none());
    }

    #[test]
    fn patch_config_uses_patch_and_omits_empty_sections() {
        let patch = ServerConfigPatch {
            push: Some(PushConfigPartial {
                enabled: Some(false),
            }),
            ..Default::default()
        };
        assert!(!patch.contains_identity());
        let req = patch_config_request(&client(), &patch);
        assert_eq!(req.method, crate::host_client::HttpMethod::Patch);
        assert_eq!(req.body.as_deref(), Some(r#"{"push":{"enabled":false}}"#));
    }

    #[test]
    fn identity_gate_is_true_only_when_identity_key_present() {
        let with_identity = ServerConfigPatch {
            identity: Some(IdentityConfigPartial {
                name: Some("Devbox".into()),
                color: None,
            }),
            ..Default::default()
        };
        assert!(with_identity.contains_identity());
        assert!(!ServerConfigPatch::default().contains_identity());
    }

    #[test]
    fn update_and_restart_are_token_authed_posts_with_empty_json_body() {
        for (req, path) in [
            (update_server_request(&client()), "/api/admin/update"),
            (restart_server_request(&client()), "/api/admin/restart"),
        ] {
            assert!(req.url.ends_with(path));
            assert_eq!(req.body.as_deref(), Some("{}"));
            assert!(!req.body.as_deref().unwrap().contains("current"));
        }
    }

    #[test]
    fn test_notification_has_empty_json_body_and_no_password() {
        let req = test_notification_request(&client());
        assert!(req.url.ends_with("/api/admin/test-notification"));
        assert_eq!(req.body.as_deref(), Some("{}"));
        assert!(!req.body.as_deref().unwrap().contains("current"));
    }

    #[test]
    fn parses_config_and_rejects_error_bodies() {
        let ok = parse_config_response(
            200,
            &json!({
                "push": { "enabled": true },
                "pushDevices": 1,
                "triggers": { "waiting": true, "oscNotify": true, "exit": true, "longJob": false },
                "longJobSeconds": 300,
                "identity": { "name": "Studio", "color": "#89b4fa" },
                "session": {
                    "defaultShell": "zsh",
                    "defaultCwd": "/work",
                    "scrollbackRows": 2000,
                    "silenceMs": 15000
                }
            }),
        )
        .unwrap();
        assert_eq!(ok.identity.name, "Studio");
        assert_eq!(ok.push_devices, 1);
        assert!(!ok.triggers.long_job);

        assert!(matches!(
            parse_config_response(400, &json!({ "error": "bad" })),
            Err(ServerConfigError::Api(msg)) if msg == "bad"
        ));
    }

    #[test]
    fn done_trigger_defaults_off_on_an_older_server() {
        let json = r##"{
            "push": { "enabled": true },
            "triggers": { "waiting": true, "oscNotify": true, "exit": true, "longJob": false },
            "longJobSeconds": 300,
            "identity": { "name": "Homelab", "color": "#f9e2af" },
            "session": {
                "defaultShell": "bash", "defaultCwd": "/home/sam",
                "scrollbackRows": 2000, "silenceMs": 15000
            }
        }"##;
        let cfg: ServerConfig = serde_json::from_str(json).unwrap();
        assert!(!cfg.triggers.done);
    }

    #[test]
    fn done_trigger_round_trips_when_the_server_sends_it() {
        let json = r#"{ "waiting": true, "done": true, "oscNotify": false,
                        "exit": true, "longJob": true }"#;
        let triggers: TriggersConfig = serde_json::from_str(json).unwrap();
        assert!(triggers.done);
        assert!(serde_json::to_string(&triggers)
            .unwrap()
            .contains("\"done\":true"));
    }
}
