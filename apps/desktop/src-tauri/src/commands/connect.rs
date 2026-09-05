use std::sync::atomic::Ordering;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::State;

use crate::state::SharedState;

/// A connection that has lived at least this long is considered healthy, so its
/// retry counter resets — a socket that dropped after a good run reconnects
/// immediately rather than inheriting the previous outage's backoff.
///
/// `pub(crate)` so the Noise pump (`commands::noise`) reuses the same backoff.
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
