use std::path::Path;

use serde::Serialize;
use tauri::AppHandle;
use tether_core::file_tree::{build_file_tree, FileStat, FileTreeNode};
use tether_core::host_client::HostClient;
use tether_core::host_store::HostSecrets;
use tether_core::workspace::{
    parse_presentation_close, parse_presentations, parse_upload_response, parse_workspace_file,
    Presentation, WorkspaceFile,
};

use crate::http;
use crate::state::shared_from_app;
use crate::storage::KeyringHostSecrets;

fn client_for(host_id: &str, profile_host: &str, profile_port: &str) -> Result<HostClient, String> {
    let password = KeyringHostSecrets
        .get(host_id)
        .map_err(|error| error.to_string())?
        .unwrap_or_default();
    Ok(HostClient::new(
        tether_core::host_store::HostProfile {
            id: host_id.to_string(),
            name: String::new(),
            color: String::new(),
            host: profile_host.to_string(),
            port: profile_port.to_string(),
            identity_name: String::new(),
            order: 0,
        },
        password,
    ))
}

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

#[tauri::command]
pub async fn core_workspace_file(
    app: AppHandle,
    host_id: String,
    session_id: String,
    path: String,
    line: Option<u32>,
    column: Option<u32>,
) -> Result<WorkspaceFileView, String> {
    let profile = profile_for(&app, &host_id)?;
    let client = client_for(&host_id, &profile.host, &profile.port)?;
    let request = client.workspace_file_request(&session_id, &path);
    let response = http::execute(&shared_from_app(&app).http, &request).await?;
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
    let profile = profile_for(&app, &host_id)?;
    let client = client_for(&host_id, &profile.host, &profile.port)?;
    let plan = client.upload_plan(&session_id);
    let path = Path::new(&file_path);
    let filename = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "invalid filename".to_string())?
        .to_string();
    let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
    let response =
        http::execute_upload(&shared_from_app(&app).http, &plan, bytes, &filename).await?;
    parse_upload_response(response.status, &response.body).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn core_presentations_list(
    app: AppHandle,
    host_id: String,
) -> Result<Vec<Presentation>, String> {
    let profile = profile_for(&app, &host_id)?;
    let client = client_for(&host_id, &profile.host, &profile.port)?;
    let request = client.presentations_list_request();
    let response = http::execute(&shared_from_app(&app).http, &request).await?;
    parse_presentations(response.status, &response.body).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn core_presentation_close(
    app: AppHandle,
    host_id: String,
    id: String,
) -> Result<bool, String> {
    let profile = profile_for(&app, &host_id)?;
    let client = client_for(&host_id, &profile.host, &profile.port)?;
    let request = client.presentation_close_request(&id);
    let response = http::execute(&shared_from_app(&app).http, &request).await?;
    parse_presentation_close(response.status, &response.body).map_err(|e| e.to_string())
}
