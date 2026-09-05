//! Workspace file / upload / presentations request descriptors and parsers.
//! HTTP is executed by the shell; this module never touches the network.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

use crate::host_client::{encode_query_value, HostClient, HttpRequest};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceFile {
    pub path: String,
    pub content: String,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum WorkspaceError {
    #[error("{0}")]
    Message(String),
    #[error("unauthorized")]
    Unauthorized,
    #[error("request failed ({0})")]
    HttpStatus(u16),
    #[error("could not decode server response")]
    Decode,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Presentation {
    pub id: String,
    pub title: String,
    pub project: String,
    pub revision: u32,
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

/// URL + auth headers for a multipart upload; the shell attaches the file body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UploadPlan {
    pub url: String,
    pub headers: BTreeMap<String, String>,
}

impl HostClient {
    pub fn workspace_file_request(&self, session_id: &str, path: &str) -> HttpRequest {
        let query = format!("path={}", encode_query_value(path));
        self.get(
            &format!("/api/sessions/{session_id}/file?{query}"),
            BTreeMap::new(),
        )
    }

    pub fn upload_plan(&self, session_id: &str) -> UploadPlan {
        UploadPlan {
            url: self.url(&format!("/api/sessions/{session_id}/upload")),
            headers: self.auth_header(),
        }
    }

    pub fn presentations_list_request(&self) -> HttpRequest {
        self.get("/api/presentations", BTreeMap::new())
    }

    pub fn presentation_close_request(&self, id: &str) -> HttpRequest {
        self.delete(&format!("/api/presentations/{id}"), BTreeMap::new())
    }
}

pub fn parse_workspace_file(status: u16, body: &Value) -> Result<WorkspaceFile, WorkspaceError> {
    if status == 401 {
        return Err(WorkspaceError::Unauthorized);
    }
    if !(200..300).contains(&status) {
        return Err(server_message_or_status(body, status));
    }
    let path = body
        .get("path")
        .and_then(Value::as_str)
        .ok_or(WorkspaceError::Decode)?;
    let content = body
        .get("content")
        .and_then(Value::as_str)
        .ok_or(WorkspaceError::Decode)?;
    Ok(WorkspaceFile {
        path: path.to_string(),
        content: content.to_string(),
    })
}

pub fn parse_upload_response(status: u16, body: &Value) -> Result<String, WorkspaceError> {
    if status == 401 {
        return Err(WorkspaceError::Unauthorized);
    }
    let ok = body.get("ok").and_then(Value::as_bool).unwrap_or(false);
    let path = body.get("path").and_then(Value::as_str);
    if ok {
        if let Some(path) = path {
            return Ok(path.to_string());
        }
    }
    if let Some(error) = body.get("error").and_then(Value::as_str) {
        return Err(WorkspaceError::Message(error.to_string()));
    }
    if !(200..300).contains(&status) {
        return Err(WorkspaceError::HttpStatus(status));
    }
    Err(WorkspaceError::Message("upload failed".into()))
}

pub fn parse_presentations(status: u16, body: &Value) -> Result<Vec<Presentation>, WorkspaceError> {
    if status == 401 {
        return Err(WorkspaceError::Unauthorized);
    }
    if !(200..300).contains(&status) {
        return Err(server_message_or_status(body, status));
    }
    serde_json::from_value(body.clone()).map_err(|_| WorkspaceError::Decode)
}

pub fn parse_presentation_close(status: u16, body: &Value) -> Result<bool, WorkspaceError> {
    if status == 401 {
        return Err(WorkspaceError::Unauthorized);
    }
    if !(200..300).contains(&status) {
        return Err(server_message_or_status(body, status));
    }
    Ok(body.get("ok").and_then(Value::as_bool).unwrap_or(false))
}

fn server_message_or_status(body: &Value, status: u16) -> WorkspaceError {
    if let Some(error) = body.get("error").and_then(Value::as_str) {
        if !error.is_empty() {
            return WorkspaceError::Message(error.to_string());
        }
    }
    WorkspaceError::HttpStatus(status)
}

/// 0-based line index clamped to the content — port of `fileView.ts` `lineOffset`.
pub fn line_offset(content: &str, line: Option<u32>) -> usize {
    let line_count = content.split('\n').count().max(1);
    let target = line.unwrap_or(1).saturating_sub(1) as usize;
    target.min(line_count - 1)
}

/// Quotes a value for insertion into an interactive POSIX shell.
pub fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

pub fn preview_url(base_url: &str, relative: &str) -> String {
    let base = base_url.trim_end_matches('/');
    if relative.starts_with('/') {
        format!("{base}{relative}")
    } else {
        format!("{base}/{relative}")
    }
}

pub fn find_session_preview<'a>(
    presentations: &'a [Presentation],
    session_id: &str,
) -> Option<&'a Presentation> {
    let mut match_preview = None;
    for preview in presentations {
        if preview.session_id.as_deref() == Some(session_id) {
            match_preview = Some(preview);
        }
    }
    match_preview
}

pub fn pick_auto_select_preview<'a>(
    rows: &'a [Presentation],
    seen: &std::collections::HashSet<String>,
    active_id: &str,
) -> Option<&'a Presentation> {
    rows.iter().find(|preview| {
        !seen.contains(&preview.id) && preview.session_id.as_deref() == Some(active_id)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host_client::HttpMethod;
    use crate::host_store::HostProfile;
    use std::collections::HashSet;

    fn profile() -> HostProfile {
        HostProfile {
            id: "host-1".to_string(),
            name: "Studio".to_string(),
            color: "#89b4fa".to_string(),
            host: "studio.local".to_string(),
            port: "8085".to_string(),
            identity_name: "studio".to_string(),
            order: 0,
            scheme: None,
        }
    }

    #[test]
    fn workspace_file_request_encodes_path_and_auths() {
        let client = HostClient::new(profile(), "secret");
        let request = client.workspace_file_request("term-1", "src/a b.ts");
        assert_eq!(request.method, HttpMethod::Get);
        assert_eq!(
            request.url,
            "http://studio.local:8085/api/sessions/term-1/file?path=src%2Fa+b.ts"
        );
        assert_eq!(request.headers["Authorization"], "Bearer secret");
    }

    #[test]
    fn upload_plan_is_post_target_with_auth_only() {
        let client = HostClient::new(profile(), "secret");
        let plan = client.upload_plan("term-1");
        assert_eq!(
            plan.url,
            "http://studio.local:8085/api/sessions/term-1/upload"
        );
        assert_eq!(plan.headers["Authorization"], "Bearer secret");
    }

    #[test]
    fn presentation_close_uses_delete() {
        let client = HostClient::new(profile(), "secret");
        let request = client.presentation_close_request("abc");
        assert_eq!(request.method, HttpMethod::Delete);
        assert_eq!(
            request.url,
            "http://studio.local:8085/api/presentations/abc"
        );
    }

    #[test]
    fn parses_workspace_file_and_upload() {
        let file =
            parse_workspace_file(200, &serde_json::json!({ "path": "a.ts", "content": "hi" }))
                .unwrap();
        assert_eq!(file.path, "a.ts");
        assert_eq!(
            parse_upload_response(200, &serde_json::json!({ "ok": true, "path": "/tmp/x" }))
                .unwrap(),
            "/tmp/x"
        );
        assert!(matches!(
            parse_upload_response(400, &serde_json::json!({ "ok": false, "error": "bad" })),
            Err(WorkspaceError::Message(m)) if m == "bad"
        ));
    }

    #[test]
    fn presentation_helpers_match_mobile() {
        let rows = vec![
            Presentation {
                id: "1".into(),
                title: "a".into(),
                project: "p".into(),
                revision: 0,
                url: "/preview/t/a.html".into(),
                session_id: Some("term-1".into()),
            },
            Presentation {
                id: "2".into(),
                title: "b".into(),
                project: "p".into(),
                revision: 1,
                url: "/preview/t/b.html".into(),
                session_id: Some("term-1".into()),
            },
        ];
        assert_eq!(find_session_preview(&rows, "term-1").unwrap().id, "2");
        let seen = HashSet::from(["1".to_string()]);
        assert_eq!(
            pick_auto_select_preview(&rows, &seen, "term-1").unwrap().id,
            "2"
        );
        assert_eq!(
            preview_url("http://studio.local:8085", "/preview/t/a.html"),
            "http://studio.local:8085/preview/t/a.html"
        );
        assert_eq!(shell_quote("it's"), "'it'\"'\"'s'");
        assert_eq!(line_offset("a\nb\nc", Some(2)), 1);
        assert_eq!(line_offset("a\nb\nc", Some(99)), 2);
    }
}
