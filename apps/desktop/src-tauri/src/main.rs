// Prevent a console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod http;
mod noise_session;
mod noise_store;
mod noise_token;
mod noise_ws;
mod state;
mod storage;

use std::sync::Arc;

use tauri::Manager;

use crate::state::AppState;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
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
            commands::connect::core_send,
            commands::connect::core_close,
            commands::connect::core_forget,
            commands::hosts::core_hosts_list,
            commands::hosts::core_hosts_migrate,
            commands::hosts::core_hosts_remove,
            commands::sessions::core_sessions_kill,
            commands::sessions::core_sessions_rename,
            commands::sessions::core_sessions_list,
            commands::sessions::core_next_term_id,
            commands::polling::core_polling_start,
            commands::polling::core_polling_stop,
            commands::polling::core_polling_restart,
            commands::polling::core_polling_set_active,
            commands::polling::core_host_retry,
            commands::terminal::core_detect_links,
            commands::terminal::core_osc52_decode,
            commands::terminal::core_mouse_cell,
            commands::terminal::core_mouse_encode,
            commands::terminal::core_cache_touch,
            commands::terminal::core_cache_delete,
            commands::terminal::core_cache_ids,
            commands::terminal::open_external,
            commands::git::core_git_summary,
            commands::git::core_git_diff,
            commands::git::core_git_diff_file,
            commands::git::core_git_status,
            commands::git::core_git_log,
            commands::git::core_git_commit_diff,
            commands::git::core_git_stage,
            commands::git::core_git_unstage,
            commands::git::core_git_discard,
            commands::git::core_git_stage_hunk,
            commands::git::core_git_unstage_hunk,
            commands::git::core_git_stage_all,
            commands::git::core_git_unstage_all,
            commands::git::core_git_discard_all,
            commands::git::core_git_commit,
            commands::git::core_git_undo_commit,
            commands::git::core_git_push,
            commands::git::core_diff_parse,
            commands::workspace::core_file_tree_build,
            commands::workspace::core_workspace_dir,
            commands::workspace::core_workspace_file,
            commands::workspace::core_workspace_upload,
            commands::workspace::core_presentations_list,
            commands::workspace::core_presentation_close,
            commands::config::core_config_get,
            commands::config::core_config_patch,
            commands::config::core_admin_update,
            commands::config::core_admin_restart,
            commands::config::core_admin_test_notification,
            commands::config::core_health_version,
            commands::config::core_hosts_update_identity,
            commands::config::core_hosts_update_connection,
            commands::config::core_deep_link_resolve,
            commands::config::core_notify_decide,
            commands::config::core_notify_waiting_edge,
            commands::noise::core_noise_pair,
            commands::noise::core_noise_device_fingerprint,
            commands::noise::core_noise_reconnect,
            commands::noise::core_noise_ping,
            commands::noise::core_noise_devices_list,
            commands::noise::core_noise_revoke,
            commands::noise::core_noise_token,
            commands::noise::core_noise_connect,
            commands::noise::core_noise_send,
            commands::noise::core_noise_close,
            commands::hosts::core_hosts_save_noise,
        ])
        .plugin(tauri_plugin_dialog::init())
        .run(tauri::generate_context!())
        .expect("error while running tether desktop");
}
