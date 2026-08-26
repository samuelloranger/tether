use std::collections::BTreeMap;
use std::fmt;

use serde_json::Value;
use thiserror::Error;

use crate::host_store::HostProfile;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HttpMethod {
    Get,
    Post,
    Patch,
}

/// Complete shell-executable request description. Constructing it performs no
/// networking and keeps runtime ownership outside the core.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpRequest {
    pub method: HttpMethod,
    pub url: String,
    pub headers: BTreeMap<String, String>,
    pub body: Option<String>,
}

#[derive(Clone)]
pub struct HostClient {
    pub profile: HostProfile,
    password: String,
}

impl fmt::Debug for HostClient {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("HostClient")
            .field("profile", &self.profile)
            .field("password", &"[redacted]")
            .finish()
    }
}

impl HostClient {
    pub fn new(profile: HostProfile, password: impl Into<String>) -> Self {
        Self {
            profile,
            password: password.into(),
        }
    }

    pub fn base_url(&self) -> String {
        format!("http://{}:{}", self.profile.host, self.profile.port)
    }

    pub fn auth_header(&self) -> BTreeMap<String, String> {
        BTreeMap::from([(
            "Authorization".to_string(),
            format!("Bearer {}", self.password),
        )])
    }

    pub fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base_url())
    }

    pub fn get(&self, path: &str, headers: BTreeMap<String, String>) -> HttpRequest {
        self.request(HttpMethod::Get, path, headers, None)
    }

    pub fn post(
        &self,
        path: &str,
        headers: BTreeMap<String, String>,
        body: Option<String>,
    ) -> HttpRequest {
        self.request(HttpMethod::Post, path, headers, body)
    }

    pub fn patch(
        &self,
        path: &str,
        headers: BTreeMap<String, String>,
        body: Option<String>,
    ) -> HttpRequest {
        self.request(HttpMethod::Patch, path, headers, body)
    }

    pub fn identity_request(&self) -> HttpRequest {
        self.get("/api/config", BTreeMap::new())
    }

    pub fn socket_url<'a>(
        &self,
        path: &str,
        params: impl IntoIterator<Item = (&'a str, &'a str)>,
    ) -> String {
        let query = params
            .into_iter()
            .map(|(key, value)| {
                format!("{}={}", encode_query_value(key), encode_query_value(value))
            })
            .collect::<Vec<_>>()
            .join("&");
        let suffix = if query.is_empty() {
            String::new()
        } else {
            format!("?{query}")
        };
        format!(
            "ws://{}:{}{path}{suffix}",
            self.profile.host, self.profile.port
        )
    }

    fn request(
        &self,
        method: HttpMethod,
        path: &str,
        mut headers: BTreeMap<String, String>,
        body: Option<String>,
    ) -> HttpRequest {
        headers.retain(|name, _| !name.eq_ignore_ascii_case("authorization"));
        headers.extend(self.auth_header());
        HttpRequest {
            method,
            url: self.url(path),
            headers,
            body,
        }
    }
}

fn encode_query_value(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => {
                encoded.push(byte as char);
            }
            b' ' => encoded.push('+'),
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostIdentity {
    pub name: String,
    pub color: String,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum HostIdentityError {
    #[error("host configuration has no valid identity")]
    Invalid,
}

pub fn parse_host_identity(config: &Value) -> Result<HostIdentity, HostIdentityError> {
    let identity = config.get("identity").ok_or(HostIdentityError::Invalid)?;
    let name = identity
        .get("name")
        .and_then(Value::as_str)
        .ok_or(HostIdentityError::Invalid)?;
    let color = identity
        .get("color")
        .and_then(Value::as_str)
        .ok_or(HostIdentityError::Invalid)?;
    Ok(HostIdentity {
        name: name.to_string(),
        color: color.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;

    fn profile() -> HostProfile {
        HostProfile {
            id: "host-1".to_string(),
            name: "Studio Mac".to_string(),
            color: "#89b4fa".to_string(),
            host: "studio.local".to_string(),
            port: "8085".to_string(),
            identity_name: "studio".to_string(),
            order: 0,
        }
    }

    #[test]
    fn builds_http_and_websocket_urls_without_putting_the_password_in_them() {
        let client = HostClient::new(profile(), "not-in-a-url");
        assert_eq!(
            client.url("/api/sessions?status=running"),
            "http://studio.local:8085/api/sessions?status=running"
        );
        assert_eq!(
            client.socket_url("/api/ws", [("sessionId", "term-1"), ("sinceId", "2")]),
            "ws://studio.local:8085/api/ws?sessionId=term-1&sinceId=2"
        );
        assert!(!client.url("/api/sessions").contains("not-in-a-url"));
    }

    #[test]
    fn percent_encodes_websocket_query_values() {
        let client = HostClient::new(profile(), "secret");
        assert_eq!(
            client.socket_url("/api/ws", [("sessionId", "a b&cols=1")]),
            "ws://studio.local:8085/api/ws?sessionId=a+b%26cols%3D1"
        );
    }

    #[test]
    fn adds_authorization_to_get_post_and_identity_requests() {
        let client = HostClient::new(profile(), "secret");
        let get = client.get("/api/sessions", BTreeMap::new());
        let post = client.post(
            "/api/rename",
            BTreeMap::from([("Content-Type".to_string(), "application/json".to_string())]),
            Some(r#"{"name":"new"}"#.to_string()),
        );
        let identity = client.identity_request();

        for request in [&get, &post, &identity] {
            assert_eq!(
                request.headers.get("Authorization").map(String::as_str),
                Some("Bearer secret")
            );
        }
        assert_eq!(post.method, HttpMethod::Post);
        assert_eq!(post.body.as_deref(), Some(r#"{"name":"new"}"#));
    }

    #[test]
    fn authorization_overrides_a_caller_supplied_value() {
        let client = HostClient::new(profile(), "secret");
        let request = client.get(
            "/api/sessions",
            BTreeMap::from([("Authorization".to_string(), "wrong".to_string())]),
        );
        assert_eq!(request.headers["Authorization"], "Bearer secret");
    }

    #[test]
    fn parses_a_valid_host_identity_and_rejects_invalid_shapes() {
        assert_eq!(
            parse_host_identity(&serde_json::json!({
                "identity": { "name": "Studio", "color": "#cba6f7" }
            })),
            Ok(HostIdentity {
                name: "Studio".to_string(),
                color: "#cba6f7".to_string(),
            })
        );
        assert_eq!(
            parse_host_identity(&serde_json::json!({ "identity": { "name": "Studio" } })),
            Err(HostIdentityError::Invalid)
        );
    }
}
