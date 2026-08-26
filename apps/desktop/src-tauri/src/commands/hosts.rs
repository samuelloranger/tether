use serde::Serialize;
use tauri::AppHandle;
use tether_core::connection_test::{self, ConnectionTestFailure, ConnectionTestNext};
use tether_core::host_client::HostClient;
use tether_core::host_health::initial_host_health;
use tether_core::host_store::{HostProfile, HostProfileChanges, HostSecrets, NewHostProfile};

use crate::commands::polling::{restart_polling, set_active_host};
use crate::http;
use crate::state::shared_from_app;
use crate::storage::KeyringHostSecrets;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionTestResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub msg: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub needs_setup: Option<bool>,
}

fn failure_result(failure: ConnectionTestFailure) -> ConnectionTestResult {
    ConnectionTestResult {
        ok: false,
        msg: Some(failure.message()),
        needs_setup: Some(failure.needs_setup()),
    }
}

fn ok_result() -> ConnectionTestResult {
    ConnectionTestResult {
        ok: true,
        msg: None,
        needs_setup: None,
    }
}

async fn run_connection_test(
    state_http: &reqwest::Client,
    profile: HostProfile,
    password: &str,
    confirm_password: &str,
) -> ConnectionTestResult {
    let client = HostClient::new(profile, password.to_string());
    let status_req = connection_test::status_request(&client);
    let status = match http::execute(state_http, &status_req).await {
        Ok(response) => response,
        Err(_) => return failure_result(ConnectionTestFailure::Unreachable),
    };
    let next = match connection_test::reduce_status(
        status.status,
        &status.body,
        password,
        confirm_password,
    ) {
        Ok(next) => next,
        Err(failure) => return failure_result(failure),
    };
    match next {
        ConnectionTestNext::Setup => {
            let setup_req = connection_test::setup_request(&client, password);
            let setup = match http::execute(state_http, &setup_req).await {
                Ok(response) => response,
                Err(_) => return failure_result(ConnectionTestFailure::Unreachable),
            };
            if let Err(failure) = connection_test::reduce_setup(setup.status) {
                return failure_result(failure);
            }
            ok_result()
        }
        ConnectionTestNext::Health => {
            let health_req = connection_test::health_request(&client);
            let health = match http::execute(state_http, &health_req).await {
                Ok(response) => response,
                Err(_) => return failure_result(ConnectionTestFailure::Unreachable),
            };
            if let Err(failure) = connection_test::reduce_health(health.status) {
                return failure_result(failure);
            }
            ok_result()
        }
    }
}

#[tauri::command]
pub fn core_hosts_list(app: AppHandle) -> Result<Vec<HostProfile>, String> {
    shared_from_app(&app).list_profiles()
}

/// One-shot migration: if Rust storage has no profiles, seed from the WebView
/// localStorage blob the desktop app used before the core collapse.
#[tauri::command]
pub fn core_hosts_migrate(
    app: AppHandle,
    profiles_json: Option<String>,
) -> Result<Vec<HostProfile>, String> {
    let state = shared_from_app(&app);
    let store = state.hosts.lock().map_err(|error| error.to_string())?;
    let existing = store.list().map_err(|error| error.to_string())?;
    if !existing.is_empty() {
        return Ok(existing);
    }
    if let Some(json) = profiles_json.filter(|value| !value.trim().is_empty()) {
        return store
            .seed_if_empty(&json)
            .map_err(|error| error.to_string());
    }
    Ok(existing)
}

#[tauri::command]
pub async fn core_test_connection(
    app: AppHandle,
    host: String,
    port: String,
    password: String,
    confirm_password: String,
) -> Result<ConnectionTestResult, String> {
    let state = shared_from_app(&app);
    let profile = HostProfile {
        id: "pending".into(),
        name: host.clone(),
        color: "#89b4fa".into(),
        host,
        port,
        identity_name: String::new(),
        order: 0,
    };
    Ok(run_connection_test(&state.http, profile, &password, &confirm_password).await)
}

#[tauri::command]
pub async fn core_hosts_save(
    app: AppHandle,
    id: Option<String>,
    name: String,
    host: String,
    port: String,
    password: String,
    confirm_password: String,
) -> Result<HostProfile, String> {
    let state = shared_from_app(&app);
    let pending = HostProfile {
        id: id.clone().unwrap_or_else(|| "pending".into()),
        name: name.clone(),
        color: "#89b4fa".into(),
        host: host.clone(),
        port: port.clone(),
        identity_name: String::new(),
        order: 0,
    };
    let test = run_connection_test(&state.http, pending, &password, &confirm_password).await;
    if !test.ok {
        return Err(test.msg.unwrap_or_else(|| "Connection failed.".into()));
    }

    let profile = {
        let store = state.hosts.lock().map_err(|error| error.to_string())?;
        if let Some(id) = id {
            store
                .update(
                    &id,
                    HostProfileChanges {
                        name: Some(name),
                        host: Some(host),
                        port: Some(port),
                        ..HostProfileChanges::default()
                    },
                )
                .map_err(|error| error.to_string())?
        } else {
            store
                .create(NewHostProfile {
                    name,
                    color: "#89b4fa".into(),
                    host,
                    port,
                    identity_name: String::new(),
                })
                .map_err(|error| error.to_string())?
        }
    };

    KeyringHostSecrets
        .set(&profile.id, &password)
        .map_err(|error| error.to_string())?;

    {
        let mut health = state.health.lock().unwrap();
        health.insert(profile.id.clone(), initial_host_health());
    }
    set_active_host(&app, Some(profile.id.clone()));
    let _ = restart_polling(&app);
    Ok(profile)
}

#[tauri::command]
pub fn core_hosts_remove(app: AppHandle, host_id: String) -> Result<(), String> {
    let state = shared_from_app(&app);
    {
        let store = state.hosts.lock().map_err(|error| error.to_string())?;
        store.remove(&host_id).map_err(|error| error.to_string())?;
    }
    {
        let mut health = state.health.lock().unwrap();
        health.remove(&host_id);
    }
    {
        let mut active = state.active_host_id.lock().unwrap();
        if active.as_deref() == Some(host_id.as_str()) {
            *active = state
                .list_profiles()
                .ok()
                .and_then(|profiles| profiles.into_iter().next().map(|profile| profile.id));
        }
    }
    let _ = restart_polling(&app);
    Ok(())
}
