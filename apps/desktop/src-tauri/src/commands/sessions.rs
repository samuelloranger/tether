use serde::Deserialize;
use serde_json::Value;
use tauri::AppHandle;
use tether_core::host_client::HostClient;
use tether_core::host_store::HostSecrets;
use tether_core::session_cache::next_term_id;
use tether_core::session_host_ops::{
    plan_kill_session, reduce_session_list_response, RefreshOutcome,
};
use tether_core::terminal_session_logic::{SessionKey, SessionRow};
use tether_core::tether_app_actions::submit_rename;

use crate::commands::polling::{drawer_session, restart_polling};
use crate::http;
use crate::state::shared_from_app;
use crate::storage::KeyringHostSecrets;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrawerSessionRef {
    pub host_id: String,
    pub id: String,
}

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
pub fn core_next_term_id(existing: Vec<String>) -> String {
    next_term_id(existing.iter().map(String::as_str))
}

#[tauri::command]
pub async fn core_sessions_kill(
    app: AppHandle,
    host_id: String,
    session_id: String,
    active_host_id: Option<String>,
    active_session_id: Option<String>,
    drawer_sessions: Vec<DrawerSessionRef>,
) -> Result<Option<String>, String> {
    let profile = profile_for(&app, &host_id)?;
    let client = client_for(&host_id, &profile.host, &profile.port)?;
    let key = SessionKey::new(&host_id, &session_id).map_err(|error| error.to_string())?;
    let rows: Vec<SessionRow> = drawer_sessions
        .into_iter()
        .map(|row| SessionRow {
            host_id: row.host_id,
            id: row.id,
            status: String::new(),
            last_output_at: None,
            name: None,
            auto_title: None,
            activity: None,
        })
        .collect();
    let plan = plan_kill_session(&client, &key, &rows);
    let _ = http::execute(&shared_from_app(&app).http, &plan.request).await;
    let latest = match (active_host_id.as_deref(), active_session_id.as_deref()) {
        (Some(host), Some(session)) => {
            SessionKey::new(host, session).unwrap_or_else(|_| key.clone())
        }
        _ => key.clone(),
    };
    let completion = plan.complete(&latest);
    let _ = restart_polling(&app);
    Ok(completion
        .switch_to
        .map(|next| next.session_id().to_string()))
}

#[tauri::command]
pub async fn core_sessions_rename(
    app: AppHandle,
    host_id: String,
    session_id: String,
    name: String,
) -> Result<(), String> {
    let profile = profile_for(&app, &host_id)?;
    let client = client_for(&host_id, &profile.host, &profile.port)?;
    let key = SessionKey::new(&host_id, &session_id).map_err(|error| error.to_string())?;
    let plan = submit_rename(&client, &key, &name);
    let response = http::execute(&shared_from_app(&app).http, &plan.request).await?;
    if !(200..300).contains(&response.status) {
        return Err(format!("rename failed ({})", response.status));
    }
    Ok(())
}

/// One host's `/api/sessions`, fetched now rather than read off the poll.
///
/// Two callers need the list to be fresh rather than whatever the drawer last
/// saw. A cold launch must know which remembered session is still *running*
/// before it opens a socket, because opening one calls `startSession` on the
/// server and would resurrect a terminal the user killed. And allocating the
/// next `term-N` off a host the drawer has never loaded would pick `term-1`,
/// which `/api/sessions/start` answers with the EXISTING session of that id —
/// so the button would silently attach to a running shell instead of making one.
#[tauri::command]
pub async fn core_sessions_list(app: AppHandle, host_id: String) -> Result<Vec<Value>, String> {
    let profile = profile_for(&app, &host_id)?;
    let client = client_for(&host_id, &profile.host, &profile.port)?;
    let request = client.get("/api/sessions", Default::default());
    let response = http::execute(&shared_from_app(&app).http, &request).await?;
    match reduce_session_list_response(&profile, &host_id, response.status, &response.body) {
        RefreshOutcome::Success { rows, .. } => Ok(rows.iter().map(drawer_session).collect()),
        RefreshOutcome::Unauthorized { .. } => Err("unauthorized".to_string()),
        _ => Err("session list failed".to_string()),
    }
}
