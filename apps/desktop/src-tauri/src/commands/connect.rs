use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, Manager, State};
use tether_core::session::{open_session, CoreEvent, SessionConfig};
use tether_core::terminal_session_logic::{backoff_delay, retry_after_close};
use tokio::sync::mpsc::{self, UnboundedReceiver};

use crate::state::SharedState;

/// A connection that has lived at least this long is considered healthy, so its
/// retry counter resets — a socket that dropped after a good run reconnects
/// immediately rather than inheriting the previous outage's backoff.
///
/// `pub(crate)` so the Noise pump (`commands::noise`) reuses the exact same
/// backoff policy as this password path.
pub(crate) const HEALTHY_MS: u64 = 10_000;

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Cheap [0,1) jitter source for `backoff_delay`. The subsecond nanos of the
/// wall clock are more than random enough to spread reconnect storms; the crate
/// deliberately avoids a rand dependency.
///
/// `pub(crate)` so the Noise pump reuses the same jitter source.
pub(crate) fn random_unit() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as f64 / 1_000_000_000.0)
        .unwrap_or(0.0)
}

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
    let state = app.state::<SharedState>();
    let replay = state.bridge.replay.clone();
    let cfg = SessionConfig {
        base_ws_url,
        password,
        session_id,
        cols,
        rows,
    };

    // The first connect stays synchronous: if the host is unreachable right now
    // the command errors, exactly as before. Only *drops after a good open* are
    // reconnected.
    let (tx, rx) = mpsc::unbounded_channel::<CoreEvent>();
    let handle = open_session(cfg.clone(), replay.clone(), tx)
        .await
        .map_err(|error| error.to_string())?;

    let cancel = Arc::new(AtomicBool::new(false));
    state
        .bridge
        .sessions
        .lock()
        .unwrap()
        .insert(conn_id.clone(), handle);
    state
        .bridge
        .cancels
        .lock()
        .unwrap()
        .insert(conn_id.clone(), cancel.clone());

    let msg_evt = format!("core-message-{conn_id}");
    let close_evt = format!("core-closed-{conn_id}");
    let status_evt = format!("core-status-{conn_id}");

    tauri::async_runtime::spawn(async move {
        let state = app.state::<SharedState>();
        let mut rx: UnboundedReceiver<CoreEvent> = rx;
        let mut retry: u32 = 0;
        let mut opened_at = now_ms();

        'outer: loop {
            // Forward frames from the current socket until it closes or its
            // channel drops.
            while let Some(event) = rx.recv().await {
                match event {
                    CoreEvent::Frame(text) => {
                        let _ = app.emit(&msg_evt, text);
                    }
                    CoreEvent::Closed => break,
                }
            }

            // The socket ended. If the user asked to close, we're done.
            if cancel.load(Ordering::SeqCst) {
                break 'outer;
            }

            // Unexpected drop (server restart / network blip) → reconnect with
            // backoff, resuming from the shared replay cursor so the server
            // replays whatever we missed.
            retry = retry_after_close(retry, opened_at, now_ms(), HEALTHY_MS);
            let _ = app.emit(&status_evt, "reconnecting");

            let reconnected = loop {
                if cancel.load(Ordering::SeqCst) {
                    break None;
                }
                let delay = backoff_delay(retry, random_unit());
                tokio::time::sleep(Duration::from_millis(delay)).await;
                if cancel.load(Ordering::SeqCst) {
                    break None;
                }
                let (ntx, nrx) = mpsc::unbounded_channel::<CoreEvent>();
                match open_session(cfg.clone(), replay.clone(), ntx).await {
                    Ok(new_handle) => break Some((new_handle, nrx)),
                    Err(_) => {
                        retry = retry.saturating_add(1);
                        continue;
                    }
                }
            };

            match reconnected {
                Some((new_handle, nrx)) => {
                    // Swap the stored handle so `core_send` (which reads it fresh
                    // each call) writes to the new socket.
                    state
                        .bridge
                        .sessions
                        .lock()
                        .unwrap()
                        .insert(conn_id.clone(), new_handle);
                    rx = nrx;
                    opened_at = now_ms();
                    let _ = app.emit(&status_evt, "connected");
                    continue 'outer;
                }
                None => break 'outer,
            }
        }

        state.bridge.sessions.lock().unwrap().remove(&conn_id);
        state.bridge.cancels.lock().unwrap().remove(&conn_id);
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
    // Signal the reconnect loop first so it stops retrying instead of racing to
    // re-open the socket we're about to close.
    if let Some(cancel) = state.bridge.cancels.lock().unwrap().get(&conn_id) {
        cancel.store(true, Ordering::SeqCst);
    }
    if let Some(handle) = state.bridge.sessions.lock().unwrap().remove(&conn_id) {
        handle.close();
    }
}

#[tauri::command]
pub fn core_forget(state: State<SharedState>, session_id: String) {
    state.bridge.replay.forget(&session_id);
}
