// Prevent a console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::mpsc;

// Core-backed transport: tether-core owns the replay cursor and forwards server
// frames verbatim. The frontend listens on conn_id-scoped events so a superseded
// connection's late frames cannot land on a newer socket.
#[derive(Default)]
struct CoreBridge {
    sessions: Mutex<HashMap<String, tether_core::session::SessionHandle>>,
    replay: std::sync::Arc<tether_core::store::ReplayStore>,
}

#[tauri::command]
async fn core_connect(
    app: AppHandle,
    conn_id: String,
    base_ws_url: String,
    password: String,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let (tx, mut rx) = mpsc::unbounded_channel::<tether_core::session::CoreEvent>();
    let replay = app.state::<CoreBridge>().replay.clone();
    let handle = tether_core::session::open_session(
        tether_core::session::SessionConfig {
            base_ws_url,
            password,
            session_id,
            cols,
            rows,
        },
        replay,
        tx,
    )
    .await
    .map_err(|e| e.to_string())?;

    app.state::<CoreBridge>()
        .sessions
        .lock()
        .unwrap()
        .insert(conn_id.clone(), handle);

    let msg_evt = format!("core-message-{conn_id}");
    let close_evt = format!("core-closed-{conn_id}");
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                tether_core::session::CoreEvent::Frame(text) => {
                    let _ = app.emit(&msg_evt, text);
                }
                tether_core::session::CoreEvent::Closed => break,
            }
        }
        app.state::<CoreBridge>()
            .sessions
            .lock()
            .unwrap()
            .remove(&conn_id);
        let _ = app.emit(&close_evt, ());
    });

    Ok(())
}

#[tauri::command]
fn core_send(bridge: State<CoreBridge>, conn_id: String, text: String) -> Result<(), String> {
    let handle = bridge
        .sessions
        .lock()
        .unwrap()
        .get(&conn_id)
        .cloned()
        .ok_or_else(|| format!("no core session for {conn_id}"))?;
    handle.send_raw(text);
    Ok(())
}

#[tauri::command]
fn core_close(bridge: State<CoreBridge>, conn_id: String) {
    if let Some(handle) = bridge.sessions.lock().unwrap().remove(&conn_id) {
        handle.close();
    }
}

#[tauri::command]
fn core_forget(bridge: State<CoreBridge>, session_id: String) {
    bridge.replay.forget(&session_id);
}

fn main() {
    tauri::Builder::default()
        .manage(CoreBridge::default())
        .invoke_handler(tauri::generate_handler![
            core_connect,
            core_send,
            core_close,
            core_forget
        ])
        .run(tauri::generate_context!())
        .expect("error while running tether desktop");
}
