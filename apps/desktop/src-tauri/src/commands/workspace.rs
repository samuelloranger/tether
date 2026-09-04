use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::AppHandle;
use tether_core::file_tree::{build_file_tree, FileStat, FileTreeNode};
use tether_core::host_client::encode_query_value;
use tether_core::workspace::{
    parse_presentation_close, parse_presentations, parse_upload_response, parse_workspace_file,
    Presentation, WorkspaceFile,
};

use crate::commands::noise::{execute_authed, execute_upload_authed};
use crate::state::shared_from_app;

fn profile_for(
    app: &AppHandle,
    host_id: &str,
) -> Result<tether_core::host_store::HostProfile, String> {
    shared_from_app(app)
        .list_profiles()?
        .into_iter()
        .find(|profile| profile.id == host_id)
        .ok_or_else(|| format!("unknown host {host_id}"))
}

#[tauri::command]
pub fn core_file_tree_build(files: Vec<FileStat>) -> Vec<FileTreeNode> {
    build_file_tree(&files)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFileView {
    pub path: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceDirEntryView {
    pub name: String,
    pub kind: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceDirListingView {
    pub path: String,
    pub entries: Vec<WorkspaceDirEntryView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
}

fn parse_workspace_dir(status: u16, body: &Value) -> Result<WorkspaceDirListingView, String> {
    if status == 401 {
        return Err("unauthorized".into());
    }
    if !(200..300).contains(&status) {
        if let Some(error) = body.get("error").and_then(Value::as_str) {
            if !error.is_empty() {
                return Err(error.to_string());
            }
        }
        return Err(format!("request failed ({status})"));
    }
    let path = body
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| "could not decode server response".to_string())?;
    let entries_value = body
        .get("entries")
        .ok_or_else(|| "could not decode server response".to_string())?;
    let entries: Vec<WorkspaceDirEntryView> = serde_json::from_value(entries_value.clone())
        .map_err(|_| "could not decode server response".to_string())?;
    let truncated = body
        .get("truncated")
        .and_then(Value::as_bool)
        .filter(|value| *value)
        .map(|_| true);
    Ok(WorkspaceDirListingView {
        path: path.to_string(),
        entries,
        truncated,
    })
}

#[tauri::command]
pub async fn core_workspace_dir(
    app: AppHandle,
    host_id: String,
    session_id: String,
    path: String,
) -> Result<WorkspaceDirListingView, String> {
    let state = shared_from_app(&app);
    let profile = profile_for(&app, &host_id)?;
    let query = format!("path={}", encode_query_value(&path));
    let response = execute_authed(&state, &profile, |client| {
        client.get(
            &format!("/api/sessions/{session_id}/dir?{query}"),
            BTreeMap::new(),
        )
    })
    .await?;
    parse_workspace_dir(response.status, &response.body)
}

#[tauri::command]
pub async fn core_workspace_file(
    app: AppHandle,
    host_id: String,
    session_id: String,
    path: String,
    line: Option<u32>,
    column: Option<u32>,
) -> Result<WorkspaceFileView, String> {
    let state = shared_from_app(&app);
    let profile = profile_for(&app, &host_id)?;
    let response = execute_authed(&state, &profile, |client| {
        client.workspace_file_request(&session_id, &path)
    })
    .await?;
    let file: WorkspaceFile =
        parse_workspace_file(response.status, &response.body).map_err(|e| e.to_string())?;
    Ok(WorkspaceFileView {
        path: file.path,
        content: file.content,
        line,
        column,
    })
}

#[tauri::command]
pub async fn core_workspace_upload(
    app: AppHandle,
    host_id: String,
    session_id: String,
    file_path: String,
) -> Result<String, String> {
    let state = shared_from_app(&app);
    let profile = profile_for(&app, &host_id)?;
    let path = Path::new(&file_path);
    let filename = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "invalid filename".to_string())?
        .to_string();
    let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
    let response = execute_upload_authed(
        &state,
        &profile,
        |client| client.upload_plan(&session_id),
        bytes,
        &filename,
    )
    .await?;
    parse_upload_response(response.status, &response.body).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn core_presentations_list(
    app: AppHandle,
    host_id: String,
) -> Result<Vec<Presentation>, String> {
    let state = shared_from_app(&app);
    let profile = profile_for(&app, &host_id)?;
    let response = execute_authed(&state, &profile, |client| {
        client.presentations_list_request()
    })
    .await?;
    parse_presentations(response.status, &response.body).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn core_presentation_close(
    app: AppHandle,
    host_id: String,
    id: String,
) -> Result<bool, String> {
    let state = shared_from_app(&app);
    let profile = profile_for(&app, &host_id)?;
    let response = execute_authed(&state, &profile, |client| {
        client.presentation_close_request(&id)
    })
    .await?;
    parse_presentation_close(response.status, &response.body).map_err(|e| e.to_string())
}
