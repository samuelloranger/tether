// Prevent a console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod http;
mod state;
mod storage;

use std::sync::Arc;

use tauri::Manager;

use crate::state::AppState;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .map_err(|error| error.to_string())?;
            std::fs::create_dir_all(&data_dir).map_err(|error| error.to_string())?;
            let storage_path = data_dir.join("host_storage.json");
            app.manage(Arc::new(AppState::new(storage_path)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::connect::core_connect,
            commands::connect::core_send,
            commands::connect::core_close,
            commands::connect::core_forget,
            commands::hosts::core_hosts_list,
            commands::hosts::core_hosts_migrate,
            commands::hosts::core_hosts_save,
            commands::hosts::core_hosts_remove,
            commands::hosts::core_test_connection,
            commands::sessions::core_sessions_kill,
            commands::sessions::core_sessions_rename,
            commands::sessions::core_next_term_id,
            commands::polling::core_polling_start,
            commands::polling::core_polling_stop,
            commands::polling::core_polling_restart,
            commands::polling::core_polling_set_active,
            commands::polling::core_host_retry,
            commands::secrets::secure_get_password,
            commands::secrets::secure_set_password,
            commands::secrets::secure_clear_password,
            commands::secrets::secure_get_legacy_password,
            commands::secrets::secure_clear_legacy_password,
            commands::config::core_config_get,
            commands::config::core_config_patch,
            commands::config::core_admin_change_password,
            commands::config::core_admin_update,
            commands::config::core_admin_restart,
            commands::config::core_admin_test_notification,
            commands::config::core_health_version,
            commands::config::core_hosts_update_identity,
            commands::config::core_hosts_update_connection,
            commands::config::core_deep_link_resolve,
            commands::config::core_notify_decide,
            commands::config::core_notify_waiting_edge,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tether desktop");
}
