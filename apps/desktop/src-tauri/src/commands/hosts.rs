use tauri::AppHandle;
use tether_core::host_health::initial_host_health;
use tether_core::host_store::{HostProfile, NewHostProfile};

use crate::commands::polling::{restart_polling, set_active_host};
use crate::state::shared_from_app;

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

/// Persist a Noise-only host profile. Pairing (`core_noise_pair`) is the trust
/// step; this only records the profile.
#[tauri::command]
pub fn core_hosts_save_noise(
    app: AppHandle,
    name: String,
    host: String,
    port: String,
) -> Result<HostProfile, String> {
    let state = shared_from_app(&app);
    let profile = {
        let store = state.hosts.lock().map_err(|error| error.to_string())?;
        store
            .create(NewHostProfile {
                name,
                color: "#89b4fa".into(),
                host,
                port,
                identity_name: String::new(),
            })
            .map_err(|error| error.to_string())?
    };

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
