//! Git HTTP request descriptors and response parsers.
//!
//! Networking stays in the Tauri shell (`apps/desktop/src-tauri/src/http.rs`);
//! this module only builds `HttpRequest` values and decodes JSON bodies.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

use crate::diff_model::DiffSummary;
use crate::git_status::{parse_repo_status, RepoStatus};
use crate::host_client::{HostClient, HttpRequest};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLogEntry {
    pub sha: String,
    pub short_sha: String,
    pub author: String,
    pub date: String,
    pub subject: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiffPayload {
    pub diff: String,
    pub truncated: bool,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum GitApiError {
    #[error("{0}")]
    Message(String),
    #[error("request failed ({0})")]
    Status(u16),
    #[error("malformed response")]
    Malformed,
}

fn json_headers() -> BTreeMap<String, String> {
    BTreeMap::from([("Content-Type".to_string(), "application/json".to_string())])
}

fn encode_query(params: &[(&str, &str)]) -> String {
    params
        .iter()
        .map(|(key, value)| {
            let mut encoded = String::new();
            for byte in value.bytes() {
                match byte {
                    b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => {
                        encoded.push(byte as char);
                    }
                    b' ' => encoded.push('+'),
                    _ => encoded.push_str(&format!("%{byte:02X}")),
                }
            }
            format!("{key}={encoded}")
        })
        .collect::<Vec<_>>()
        .join("&")
}

fn session_path(session_id: &str, suffix: &str) -> String {
    format!("/api/sessions/{session_id}{suffix}")
}

pub fn diff_summary_request(client: &HostClient, session_id: &str) -> HttpRequest {
    client.get(&session_path(session_id, "/diff/summary"), BTreeMap::new())
}

pub fn diff_request(
    client: &HostClient,
    session_id: &str,
    path: Option<&str>,
    mode: Option<&str>,
) -> HttpRequest {
    let mut params = Vec::new();
    if let Some(path) = path {
        params.push(("path", path));
    }
    if let Some(mode) = mode {
        params.push(("mode", mode));
    }
    let query = if params.is_empty() {
        String::new()
    } else {
        format!("?{}", encode_query(&params))
    };
    client.get(
        &format!("{}{query}", session_path(session_id, "/diff")),
        BTreeMap::new(),
    )
}

pub fn diff_file_request(
    client: &HostClient,
    session_id: &str,
    path: &str,
    side: &str,
) -> HttpRequest {
    let query = encode_query(&[("path", path), ("side", side)]);
    client.get(
        &format!("{}?{query}", session_path(session_id, "/diff/file")),
        BTreeMap::new(),
    )
}

pub fn git_status_request(client: &HostClient, session_id: &str) -> HttpRequest {
    client.get(&session_path(session_id, "/git/status"), BTreeMap::new())
}

pub fn git_log_request(client: &HostClient, session_id: &str, limit: u32) -> HttpRequest {
    let path = format!("{}?limit={limit}", session_path(session_id, "/git/log"));
    client.get(&path, BTreeMap::new())
}

pub fn git_commit_diff_request(
    client: &HostClient,
    session_id: &str,
    sha: &str,
    path: Option<&str>,
) -> HttpRequest {
    let base = session_path(session_id, &format!("/git/commit/{sha}/diff"));
    let url_path = if let Some(path) = path {
        format!("{base}?{}", encode_query(&[("path", path)]))
    } else {
        base
    };
    client.get(&url_path, BTreeMap::new())
}

pub fn git_post_request(
    client: &HostClient,
    session_id: &str,
    route: &str,
    body: Option<Value>,
) -> HttpRequest {
    let path = session_path(session_id, &format!("/git/{route}"));
    let body = body.map(|value| value.to_string());
    client.post(&path, json_headers(), body)
}

pub fn stage_request(client: &HostClient, session_id: &str, path: &str) -> HttpRequest {
    git_post_request(
        client,
        session_id,
        "stage",
        Some(serde_json::json!({ "path": path })),
    )
}

pub fn unstage_request(client: &HostClient, session_id: &str, path: &str) -> HttpRequest {
    git_post_request(
        client,
        session_id,
        "unstage",
        Some(serde_json::json!({ "path": path })),
    )
}

pub fn discard_request(client: &HostClient, session_id: &str, path: &str) -> HttpRequest {
    git_post_request(
        client,
        session_id,
        "discard",
        Some(serde_json::json!({ "path": path })),
    )
}

pub fn stage_hunk_request(
    client: &HostClient,
    session_id: &str,
    path: &str,
    hunk_index: u32,
) -> HttpRequest {
    git_post_request(
        client,
        session_id,
        "stage-hunk",
        Some(serde_json::json!({ "path": path, "hunkIndex": hunk_index })),
    )
}

pub fn unstage_hunk_request(
    client: &HostClient,
    session_id: &str,
    path: &str,
    hunk_index: u32,
) -> HttpRequest {
    git_post_request(
        client,
        session_id,
        "unstage-hunk",
        Some(serde_json::json!({ "path": path, "hunkIndex": hunk_index })),
    )
}

pub fn stage_all_request(client: &HostClient, session_id: &str) -> HttpRequest {
    git_post_request(client, session_id, "stage-all", None)
}

pub fn unstage_all_request(client: &HostClient, session_id: &str) -> HttpRequest {
    git_post_request(client, session_id, "unstage-all", None)
}

pub fn discard_all_request(client: &HostClient, session_id: &str) -> HttpRequest {
    git_post_request(client, session_id, "discard-all", None)
}

pub fn commit_request(
    client: &HostClient,
    session_id: &str,
    message: &str,
    amend: bool,
) -> HttpRequest {
    git_post_request(
        client,
        session_id,
        "commit",
        Some(serde_json::json!({ "message": message, "amend": amend })),
    )
}

pub fn undo_commit_request(client: &HostClient, session_id: &str) -> HttpRequest {
    git_post_request(client, session_id, "undo-commit", None)
}

pub fn push_request(client: &HostClient, session_id: &str) -> HttpRequest {
    git_post_request(client, session_id, "push", None)
}

fn error_from_body(status: u16, body: &Value) -> GitApiError {
    if let Some(message) = body.get("error").and_then(Value::as_str) {
        GitApiError::Message(message.to_string())
    } else {
        GitApiError::Status(status)
    }
}

pub fn parse_ok_response(status: u16, body: &Value) -> Result<(), GitApiError> {
    if (200..300).contains(&status) {
        Ok(())
    } else {
        Err(error_from_body(status, body))
    }
}

pub fn parse_diff_summary_response(status: u16, body: &Value) -> Result<DiffSummary, GitApiError> {
    if !(200..300).contains(&status) {
        return Err(error_from_body(status, body));
    }
    serde_json::from_value(body.clone()).map_err(|_| GitApiError::Malformed)
}

pub fn parse_diff_payload(status: u16, body: &Value) -> Result<DiffPayload, GitApiError> {
    if !(200..300).contains(&status) {
        return Err(error_from_body(status, body));
    }
    let diff = body
        .get("diff")
        .and_then(Value::as_str)
        .ok_or(GitApiError::Malformed)?
        .to_string();
    let truncated = body
        .get("truncated")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    Ok(DiffPayload { diff, truncated })
}

pub fn parse_git_status_response(status: u16, body: &Value) -> Result<RepoStatus, GitApiError> {
    if !(200..300).contains(&status) {
        return Err(error_from_body(status, body));
    }
    parse_repo_status(body).ok_or(GitApiError::Malformed)
}

pub fn parse_git_log_response(status: u16, body: &Value) -> Result<Vec<GitLogEntry>, GitApiError> {
    if !(200..300).contains(&status) {
        return Err(error_from_body(status, body));
    }
    serde_json::from_value(body.clone()).map_err(|_| GitApiError::Malformed)
}

/// Ensure request builders produce the expected paths (no network).
#[cfg(test)]
mod tests {
    use super::*;
    use crate::host_client::HttpMethod;
    use crate::host_store::HostProfile;

    fn client() -> HostClient {
        HostClient::new(
            HostProfile {
                id: "h1".into(),
                name: "Local".into(),
                color: "#fff".into(),
                host: "127.0.0.1".into(),
                port: "8085".into(),
                identity_name: "local".into(),
                order: 0,
                scheme: None,
            },
            "secret",
        )
    }

    #[test]
    fn builds_diff_and_git_paths() {
        let c = client();
        assert!(diff_summary_request(&c, "term-1")
            .url
            .ends_with("/api/sessions/term-1/diff/summary"));
        let staged = diff_request(&c, "term-1", Some("a.ts"), Some("staged"));
        assert!(staged.url.contains("path=a.ts"));
        assert!(staged.url.contains("mode=staged"));
        assert_eq!(stage_request(&c, "term-1", "a.ts").method, HttpMethod::Post);
        assert!(commit_request(&c, "term-1", "msg", false)
            .body
            .as_deref()
            .unwrap()
            .contains("\"message\":\"msg\""));
    }

    #[test]
    fn parses_diff_summary_and_log() {
        let summary = parse_diff_summary_response(
            200,
            &serde_json::json!({
                "files": [{
                    "path": "a.ts",
                    "insertions": 1,
                    "deletions": 0,
                    "binary": false,
                    "staged": true
                }]
            }),
        )
        .unwrap();
        assert_eq!(summary.files.len(), 1);
        assert_eq!(summary.files[0].staged, Some(true));

        let log = parse_git_log_response(
            200,
            &serde_json::json!([{
                "sha": "abc123",
                "shortSha": "abc",
                "author": "sam",
                "date": "2026-01-01T00:00:00Z",
                "subject": "init"
            }]),
        )
        .unwrap();
        assert_eq!(log[0].short_sha, "abc");
    }
}
