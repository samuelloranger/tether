use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tether_core::host_client::HostClient;
use tether_core::host_store::{HostProfile, HostProfileChanges, HostSecrets};
use tether_core::server_config::{self, ServerConfig, ServerConfigPatch};

use crate::commands::noise::execute_authed;
use crate::state::shared_from_app;
use crate::storage::KeyringHostSecrets;

fn profile_for(app: &AppHandle, host_id: &str) -> Result<HostProfile, String> {
    shared_from_app(app)
        .list_profiles()?
        .into_iter()
        .find(|profile| profile.id == host_id)
        .ok_or_else(|| format!("unknown host {host_id}"))
}

async fn exec_config(
    app: &AppHandle,
    host_id: &str,
    build: impl Fn(&HostClient) -> tether_core::host_client::HttpRequest,
) -> Result<crate::http::HttpResponse, String> {
    let state = shared_from_app(app);
    let profile = profile_for(app, host_id)?;
    execute_authed(&state, &profile, build).await
}

#[tauri::command]
pub async fn core_config_get(app: AppHandle, host_id: String) -> Result<ServerConfig, String> {
    let response = exec_config(&app, &host_id, server_config::get_config_request).await?;
    server_config::parse_config_response(response.status, &response.body).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn core_config_patch(
    app: AppHandle,
    host_id: String,
    patch: ServerConfigPatch,
) -> Result<ServerConfig, String> {
    let response = exec_config(&app, &host_id, |client| {
        server_config::patch_config_request(client, &patch)
    })
    .await?;
    server_config::parse_config_response(response.status, &response.body).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn core_admin_change_password(
    app: AppHandle,
    host_id: String,
    current: String,
    next: String,
) -> Result<(), String> {
    let response = exec_config(&app, &host_id, |client| {
        server_config::change_password_request(client, &current, &next)
    })
    .await?;
    server_config::parse_admin_ok(response.status, &response.body).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn core_admin_update(
    app: AppHandle,
    host_id: String,
    current: String,
) -> Result<(), String> {
    let response = exec_config(&app, &host_id, |client| {
        server_config::update_server_request(client, &current)
    })
    .await?;
    server_config::parse_admin_ok(response.status, &response.body).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn core_admin_restart(
    app: AppHandle,
    host_id: String,
    current: String,
) -> Result<(), String> {
    let response = exec_config(&app, &host_id, |client| {
        server_config::restart_server_request(client, &current)
    })
    .await?;
    server_config::parse_admin_ok(response.status, &response.body).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn core_admin_test_notification(app: AppHandle, host_id: String) -> Result<(), String> {
    let response = exec_config(&app, &host_id, server_config::test_notification_request).await?;
    server_config::parse_admin_ok(response.status, &response.body).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn core_health_version(
    app: AppHandle,
    host_id: String,
) -> Result<Option<String>, String> {
    let response = exec_config(&app, &host_id, server_config::health_version_request).await?;
    server_config::parse_health_version(response.status, &response.body).map_err(|e| e.to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityUpdate {
    pub name: String,
    pub color: String,
}

/// Update local host profile name/color/identityName from a server identity.
/// Call only when the config PATCH actually contained an `identity` key.
#[tauri::command]
pub fn core_hosts_update_identity(
    app: AppHandle,
    host_id: String,
    identity: IdentityUpdate,
) -> Result<HostProfile, String> {
    let state = shared_from_app(&app);
    let store = state.hosts.lock().map_err(|error| error.to_string())?;
    store
        .update(
            &host_id,
            HostProfileChanges {
                name: Some(identity.name.clone()),
                color: Some(identity.color),
                identity_name: Some(identity.name),
                ..HostProfileChanges::default()
            },
        )
        .map_err(|error| error.to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionUpdate {
    pub host: String,
    pub port: String,
    pub replacement_password: Option<String>,
}

#[tauri::command]
pub fn core_hosts_update_connection(
    app: AppHandle,
    host_id: String,
    update: ConnectionUpdate,
) -> Result<HostProfile, String> {
    let state = shared_from_app(&app);
    let profile = {
        let store = state.hosts.lock().map_err(|error| error.to_string())?;
        store
            .update(
                &host_id,
                HostProfileChanges {
                    host: Some(update.host),
                    port: Some(update.port),
                    ..HostProfileChanges::default()
                },
            )
            .map_err(|error| error.to_string())?
    };
    if let Some(password) = update.replacement_password.filter(|p| !p.is_empty()) {
        KeyringHostSecrets
            .set(&host_id, &password)
            .map_err(|error| error.to_string())?;
    }
    Ok(profile)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum DeepLinkCommandResult {
    Matched { host_id: String, session_id: String },
    UnknownHost { identity_name: String },
    Invalid,
}

/// Thin wrapper over `tether_core::deep_link::parse_deep_link` + host lookup.
#[tauri::command]
pub fn core_deep_link_resolve(
    app: AppHandle,
    url: String,
) -> Result<DeepLinkCommandResult, String> {
    let Some(link) = tether_core::deep_link::parse_deep_link(&url) else {
        return Ok(DeepLinkCommandResult::Invalid);
    };
    let profiles = shared_from_app(&app).list_profiles()?;
    let Some(profile) = profiles
        .into_iter()
        .find(|profile| profile.identity_name == link.identity_name)
    else {
        return Ok(DeepLinkCommandResult::UnknownHost {
            identity_name: link.identity_name,
        });
    };
    Ok(DeepLinkCommandResult::Matched {
        host_id: profile.id,
        session_id: link.session_id,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotifyDecision {
    pub should_notify: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotifyEdgeInput {
    pub notify_fired: bool,
    pub bell_fired: bool,
    pub osc_title: String,
    pub osc_body: String,
    pub label: String,
    pub notifications_enabled: bool,
    pub session_is_active: bool,
    pub window_focused: bool,
}

#[tauri::command]
pub fn core_notify_waiting_edge(
    prev_activity: Option<String>,
    next_activity: Option<String>,
    is_active: bool,
) -> bool {
    use tether_core::notify_rules::{waiting_edge_deserves_notify, SessionActivity};
    fn parse(value: Option<String>) -> Option<SessionActivity> {
        match value.as_deref() {
            Some("working") => Some(SessionActivity::Working),
            Some("waiting") => Some(SessionActivity::Waiting),
            Some("done") => Some(SessionActivity::Done),
            Some("idle") => Some(SessionActivity::Idle),
            _ => None,
        }
    }
    waiting_edge_deserves_notify(parse(prev_activity), parse(next_activity), is_active)
}

#[tauri::command]
pub fn core_notify_decide(edge: NotifyEdgeInput) -> NotifyDecision {
    use tether_core::notify_rules::{desktop_notify_for_edge, DesktopNotify, EmulatorNotifyEdge};
    let decision = desktop_notify_for_edge(
        &EmulatorNotifyEdge {
            notify_fired: edge.notify_fired,
            bell_fired: edge.bell_fired,
            osc_title: edge.osc_title,
            osc_body: edge.osc_body,
            label: edge.label,
        },
        edge.notifications_enabled,
        edge.session_is_active,
        edge.window_focused,
    );
    match decision {
        Some(DesktopNotify::Osc { title, body }) | Some(DesktopNotify::Bell { title, body }) => {
            NotifyDecision {
                should_notify: true,
                title: Some(title),
                body: Some(body),
            }
        }
        None => NotifyDecision {
            should_notify: false,
            title: None,
            body: None,
        },
    }
}
