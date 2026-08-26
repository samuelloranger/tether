use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tether_core::host_client::HostClient;
use tether_core::host_health::{host_health_status_label, initial_host_health, HostHealth};
use tether_core::host_polling::poll_host_sessions;
use tether_core::host_polling::HostPollInput;
use tether_core::host_store::HostProfile;
use tether_core::host_store::HostSecrets;
use tether_core::session_host_ops::{
    health_after_poll, reduce_session_list_response, PollResult, RefreshOutcome,
};
use tether_core::terminal_session_logic::SessionRow;

use crate::http;
use crate::state::{shared_from_app, SharedState};
use crate::storage::KeyringHostSecrets;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthEvent {
    host_id: String,
    status: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionsEvent {
    host_id: String,
    sessions: Vec<Value>,
}

fn drawer_session(row: &SessionRow) -> Value {
    json!({
        "hostId": row.host_id,
        "id": row.id,
        "status": row.status,
        "last_output_at": row.last_output_at,
        "name": row.name,
        "auto_title": row.auto_title,
        "activity": row.activity,
    })
}

fn emit_health(app: &AppHandle, host_id: &str, health: HostHealth) {
    let _ = app.emit(
        "core-host-health",
        HealthEvent {
            host_id: host_id.to_string(),
            status: host_health_status_label(health).to_string(),
        },
    );
}

fn emit_sessions(app: &AppHandle, host_id: &str, rows: &[SessionRow]) {
    let _ = app.emit(
        "core-sessions",
        SessionsEvent {
            host_id: host_id.to_string(),
            sessions: rows.iter().map(drawer_session).collect(),
        },
    );
}

async fn poll_one_host(app: AppHandle, profile: HostProfile, generation: u64) {
    let state = shared_from_app(&app);
    if state.current_poll_generation() != generation {
        return;
    }

    let previous_health = {
        let mut health = state.health.lock().unwrap();
        *health
            .entry(profile.id.clone())
            .or_insert_with(initial_host_health)
    };

    let password = match KeyringHostSecrets.get(&profile.id) {
        Ok(Some(password)) => password,
        _ => {
            finish_poll(
                &app,
                &state,
                &profile,
                previous_health,
                PollResult::Failure,
                None,
                generation,
            );
            return;
        }
    };

    let client = HostClient::new(profile.clone(), password);
    let request = client.get("/api/sessions", Default::default());
    let input = match http::execute(&state.http, &request).await {
        Ok(response) => HostPollInput::Http {
            status: response.status,
            body: response.body,
        },
        Err(_) => HostPollInput::NetworkFailure,
    };

    if state.current_poll_generation() != generation {
        return;
    }

    let outcome = poll_host_sessions([(profile.clone(), input)])
        .into_iter()
        .next()
        .expect("one input yields one outcome");

    let rows = match outcome.result {
        PollResult::Success => {
            let active = state
                .active_host_id
                .lock()
                .unwrap()
                .clone()
                .unwrap_or_default();
            let body = Value::Array(outcome.sessions.unwrap_or_default());
            match reduce_session_list_response(&profile, &active, 200, &body) {
                RefreshOutcome::Success { rows, .. } => Some(rows),
                _ => None,
            }
        }
        _ => None,
    };

    finish_poll(
        &app,
        &state,
        &profile,
        previous_health,
        outcome.result,
        rows,
        generation,
    );
}

fn finish_poll(
    app: &AppHandle,
    state: &SharedState,
    profile: &HostProfile,
    previous_health: HostHealth,
    result: PollResult,
    rows: Option<Vec<SessionRow>>,
    generation: u64,
) {
    let next_health = {
        let mut health = state.health.lock().unwrap();
        let next = health_after_poll(previous_health, result);
        health.insert(profile.id.clone(), next);
        next
    };
    emit_health(app, &profile.id, next_health);

    if let Some(rows) = rows {
        emit_sessions(app, &profile.id, &rows);
    }

    let active_host_id = state.active_host_id.lock().unwrap().clone();
    let scheduled = {
        let mut polling = state.polling.lock().unwrap();
        polling.schedule_after(profile, active_host_id.as_deref(), previous_health, result)
    };

    let Some(scheduled) = scheduled else {
        return;
    };
    let app = app.clone();
    let profile = profile.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(scheduled.delay_ms)).await;
        let state = shared_from_app(&app);
        if state.current_poll_generation() != generation {
            return;
        }
        if state.polling.lock().unwrap().is_stopped() {
            return;
        }
        poll_one_host(app, profile, generation).await;
    });
}

pub fn start_polling(app: &AppHandle) -> Result<(), String> {
    let state = shared_from_app(app);
    let generation = state.bump_poll_generation();
    let profiles = state.list_profiles()?;
    {
        let mut polling = state.polling.lock().unwrap();
        let _ = polling.start(&profiles);
    }
    for profile in profiles {
        {
            let mut health = state.health.lock().unwrap();
            let entry = health
                .entry(profile.id.clone())
                .or_insert_with(initial_host_health);
            emit_health(app, &profile.id, *entry);
        }
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            poll_one_host(app, profile, generation).await;
        });
    }
    Ok(())
}

pub fn stop_polling(app: &AppHandle) {
    let state = shared_from_app(app);
    state.bump_poll_generation();
    state.polling.lock().unwrap().stop();
}

pub fn restart_polling(app: &AppHandle) -> Result<(), String> {
    stop_polling(app);
    start_polling(app)
}

pub fn set_active_host(app: &AppHandle, host_id: Option<String>) {
    let state = shared_from_app(app);
    *state.active_host_id.lock().unwrap() = host_id;
}

pub fn reset_host_health(app: &AppHandle, host_id: &str) {
    let state = shared_from_app(app);
    {
        let mut map = state.health.lock().unwrap();
        map.insert(host_id.to_string(), initial_host_health());
    }
    emit_health(app, host_id, initial_host_health());
}

#[tauri::command]
pub fn core_polling_start(app: AppHandle) -> Result<(), String> {
    start_polling(&app)
}

#[tauri::command]
pub fn core_polling_stop(app: AppHandle) {
    stop_polling(&app);
}

#[tauri::command]
pub fn core_polling_restart(app: AppHandle) -> Result<(), String> {
    restart_polling(&app)
}

#[tauri::command]
pub fn core_polling_set_active(app: AppHandle, host_id: Option<String>) {
    set_active_host(&app, host_id);
}

#[tauri::command]
pub fn core_host_retry(app: AppHandle, host_id: String) -> Result<(), String> {
    reset_host_health(&app, &host_id);
    restart_polling(&app)
}
