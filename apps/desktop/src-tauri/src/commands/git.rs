use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;
use tether_core::diff_model::{
    annotate_hunk_indices, pair_diff_rows, parse_diff_lines, visible_diff_lines, DiffLine,
    SideBySideRow,
};
use tether_core::git_api::{self, DiffPayload, GitLogEntry};
use tether_core::git_status::RepoStatus;
use tether_core::host_client::{HostClient, HttpRequest};

use crate::commands::noise::{execute_authed, execute_bytes_authed};
use crate::state::{shared_from_app, AppState};

fn profile_for(
    state: &AppState,
    host_id: &str,
) -> Result<tether_core::host_store::HostProfile, String> {
    state
        .list_profiles()?
        .into_iter()
        .find(|profile| profile.id == host_id)
        .ok_or_else(|| format!("unknown host {host_id}"))
}

async fn exec_json(
    app: &AppHandle,
    host_id: &str,
    build: impl Fn(&HostClient) -> HttpRequest,
) -> Result<(u16, Value), String> {
    let state = shared_from_app(app);
    let profile = profile_for(&state, host_id)?;
    let response = execute_authed(&state, &profile, build).await?;
    Ok((response.status, response.body))
}

#[tauri::command]
pub async fn core_git_summary(
    app: AppHandle,
    host_id: String,
    session_id: String,
) -> Result<tether_core::diff_model::DiffSummary, String> {
    let (status, body) = exec_json(&app, &host_id, |client| {
        git_api::diff_summary_request(client, &session_id)
    })
    .await?;
    git_api::parse_diff_summary_response(status, &body).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn core_git_diff(
    app: AppHandle,
    host_id: String,
    session_id: String,
    path: Option<String>,
    mode: Option<String>,
) -> Result<DiffPayload, String> {
    let (status, body) = exec_json(&app, &host_id, |client| {
        git_api::diff_request(client, &session_id, path.as_deref(), mode.as_deref())
    })
    .await?;
    git_api::parse_diff_payload(status, &body).map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffFileBytes {
    pub base64: String,
    pub content_type: String,
}

#[tauri::command]
pub async fn core_git_diff_file(
    app: AppHandle,
    host_id: String,
    session_id: String,
    path: String,
    side: String,
) -> Result<Option<DiffFileBytes>, String> {
    let state = shared_from_app(&app);
    let profile = profile_for(&state, &host_id)?;
    let response = execute_bytes_authed(&state, &profile, |client| {
        git_api::diff_file_request(client, &session_id, &path, &side)
    })
    .await?;
    if response.status == 404 {
        return Ok(None);
    }
    if !(200..300).contains(&response.status) {
        if let Ok(text) = std::str::from_utf8(&response.body) {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(text) {
                if let Some(message) = value.get("error").and_then(|v| v.as_str()) {
                    return Err(message.to_string());
                }
            }
        }
        return Err(format!("diff file failed ({})", response.status));
    }
    Ok(Some(DiffFileBytes {
        base64: BASE64.encode(&response.body),
        content_type: response
            .content_type
            .unwrap_or_else(|| "application/octet-stream".into()),
    }))
}

#[tauri::command]
pub async fn core_git_status(
    app: AppHandle,
    host_id: String,
    session_id: String,
) -> Result<RepoStatus, String> {
    let (status, body) = exec_json(&app, &host_id, |client| {
        git_api::git_status_request(client, &session_id)
    })
    .await?;
    git_api::parse_git_status_response(status, &body).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn core_git_log(
    app: AppHandle,
    host_id: String,
    session_id: String,
    limit: Option<u32>,
) -> Result<Vec<GitLogEntry>, String> {
    let (status, body) = exec_json(&app, &host_id, |client| {
        git_api::git_log_request(client, &session_id, limit.unwrap_or(50))
    })
    .await?;
    git_api::parse_git_log_response(status, &body).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn core_git_commit_diff(
    app: AppHandle,
    host_id: String,
    session_id: String,
    sha: String,
    path: Option<String>,
) -> Result<DiffPayload, String> {
    let (status, body) = exec_json(&app, &host_id, |client| {
        git_api::git_commit_diff_request(client, &session_id, &sha, path.as_deref())
    })
    .await?;
    git_api::parse_diff_payload(status, &body).map_err(|e| e.to_string())
}

async fn run_ok(
    app: &AppHandle,
    host_id: &str,
    build: impl Fn(&HostClient) -> HttpRequest,
) -> Result<(), String> {
    let (status, body) = exec_json(app, host_id, build).await?;
    git_api::parse_ok_response(status, &body).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn core_git_stage(
    app: AppHandle,
    host_id: String,
    session_id: String,
    path: String,
) -> Result<(), String> {
    run_ok(&app, &host_id, |client| {
        git_api::stage_request(client, &session_id, &path)
    })
    .await
}

#[tauri::command]
pub async fn core_git_unstage(
    app: AppHandle,
    host_id: String,
    session_id: String,
    path: String,
) -> Result<(), String> {
    run_ok(&app, &host_id, |client| {
        git_api::unstage_request(client, &session_id, &path)
    })
    .await
}

#[tauri::command]
pub async fn core_git_discard(
    app: AppHandle,
    host_id: String,
    session_id: String,
    path: String,
) -> Result<(), String> {
    run_ok(&app, &host_id, |client| {
        git_api::discard_request(client, &session_id, &path)
    })
    .await
}

#[tauri::command]
pub async fn core_git_stage_hunk(
    app: AppHandle,
    host_id: String,
    session_id: String,
    path: String,
    hunk_index: u32,
) -> Result<(), String> {
    run_ok(&app, &host_id, |client| {
        git_api::stage_hunk_request(client, &session_id, &path, hunk_index)
    })
    .await
}

#[tauri::command]
pub async fn core_git_unstage_hunk(
    app: AppHandle,
    host_id: String,
    session_id: String,
    path: String,
    hunk_index: u32,
) -> Result<(), String> {
    run_ok(&app, &host_id, |client| {
        git_api::unstage_hunk_request(client, &session_id, &path, hunk_index)
    })
    .await
}

#[tauri::command]
pub async fn core_git_stage_all(
    app: AppHandle,
    host_id: String,
    session_id: String,
) -> Result<(), String> {
    run_ok(&app, &host_id, |client| {
        git_api::stage_all_request(client, &session_id)
    })
    .await
}

#[tauri::command]
pub async fn core_git_unstage_all(
    app: AppHandle,
    host_id: String,
    session_id: String,
) -> Result<(), String> {
    run_ok(&app, &host_id, |client| {
        git_api::unstage_all_request(client, &session_id)
    })
    .await
}

#[tauri::command]
pub async fn core_git_discard_all(
    app: AppHandle,
    host_id: String,
    session_id: String,
) -> Result<(), String> {
    run_ok(&app, &host_id, |client| {
        git_api::discard_all_request(client, &session_id)
    })
    .await
}

#[tauri::command]
pub async fn core_git_commit(
    app: AppHandle,
    host_id: String,
    session_id: String,
    message: String,
    amend: bool,
) -> Result<(), String> {
    run_ok(&app, &host_id, |client| {
        git_api::commit_request(client, &session_id, &message, amend)
    })
    .await
}

#[tauri::command]
pub async fn core_git_undo_commit(
    app: AppHandle,
    host_id: String,
    session_id: String,
) -> Result<(), String> {
    run_ok(&app, &host_id, |client| {
        git_api::undo_commit_request(client, &session_id)
    })
    .await
}

#[tauri::command]
pub async fn core_git_push(
    app: AppHandle,
    host_id: String,
    session_id: String,
) -> Result<(), String> {
    run_ok(&app, &host_id, |client| {
        git_api::push_request(client, &session_id)
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedDiffView {
    pub lines: Vec<DiffLine>,
    pub hunk_indices: Vec<Option<u32>>,
    pub rows: Vec<SideBySideRow>,
}

/// Local (no network) parse used by the desktop diff viewer.
#[tauri::command]
pub fn core_diff_parse(diff: String) -> ParsedDiffView {
    let parsed = parse_diff_lines(&diff);
    let hunk_indices = annotate_hunk_indices(&parsed);
    let lines = visible_diff_lines(&parsed);
    let visible_indices: Vec<Option<u32>> = parsed
        .iter()
        .zip(hunk_indices.iter())
        .filter(|(line, _)| {
            line.kind != tether_core::diff_model::DiffLineKind::Meta
                || tether_core::diff_model::is_hunk_header_line(&line.text)
        })
        .map(|(_, idx)| *idx)
        .collect();
    let rows = pair_diff_rows(&lines);
    ParsedDiffView {
        lines,
        hunk_indices: visible_indices,
        rows,
    }
}
