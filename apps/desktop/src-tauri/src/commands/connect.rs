use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::mpsc;

use crate::state::SharedState;

#[tauri::command]
pub async fn core_connect(
    app: AppHandle,
    conn_id: String,
    base_ws_url: String,
    password: String,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let (tx, mut rx) = mpsc::unbounded_channel::<tether_core::session::CoreEvent>();
    let state = app.state::<SharedState>();
    let replay = state.bridge.replay.clone();
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
    .map_err(|error| error.to_string())?;

    state
        .bridge
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
        app.state::<SharedState>()
            .bridge
            .sessions
            .lock()
            .unwrap()
            .remove(&conn_id);
        let _ = app.emit(&close_evt, ());
    });

    Ok(())
}

#[tauri::command]
pub fn core_send(state: State<SharedState>, conn_id: String, text: String) -> Result<(), String> {
    let handle = state
        .bridge
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
pub fn core_close(state: State<SharedState>, conn_id: String) {
    if let Some(handle) = state.bridge.sessions.lock().unwrap().remove(&conn_id) {
        handle.close();
    }
}

#[tauri::command]
pub fn core_forget(state: State<SharedState>, session_id: String) {
    state.bridge.replay.forget(&session_id);
}
