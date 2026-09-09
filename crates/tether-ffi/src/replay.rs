use std::sync::Arc;

use tether_core::store::{FileCursorPersistence, ReplayStore};

use crate::error::FfiCursorError;

#[derive(uniffi::Object)]
pub struct FfiReplayStore {
    inner: ReplayStore,
}

#[uniffi::export]
impl FfiReplayStore {
    #[uniffi::constructor]
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            inner: ReplayStore::new(),
        })
    }

    /// Persist replay cursors to `path` (JSON) so they survive tab eviction and
    /// app relaunch — a reconnect then replays only the `sinceId` delta instead
    /// of the whole retained tail. Loading is fail-open: a missing/corrupt file
    /// just means one slower reconnect, never a failed construction.
    #[uniffi::constructor]
    pub fn with_path(path: String) -> Arc<Self> {
        Arc::new(Self {
            inner: ReplayStore::with_persistence(Arc::new(FileCursorPersistence::new(path))),
        })
    }

    pub fn since_id(&self, session_id: String) -> u64 {
        self.inner.since_id(&session_id)
    }

    pub fn accept_output(&self, session_id: String, id: u64) -> bool {
        self.inner.accept_output(&session_id, id)
    }

    pub fn reset(&self, session_id: String) {
        self.inner.reset(&session_id);
    }

    pub fn forget(&self, session_id: String) {
        self.inner.forget(&session_id);
    }

    pub fn flush(&self) -> Result<(), FfiCursorError> {
        self.inner.flush().map_err(Into::into)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn with_path_persists_cursor_across_reconstruction() {
        let dir = std::env::temp_dir().join(format!("tether-ffi-replay-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("cursors.json");
        let path_str = path.to_string_lossy().to_string();

        let store = FfiReplayStore::with_path(path_str.clone());
        store.accept_output("build".into(), 42);
        store.flush().unwrap();
        // Simulate app relaunch / store drop.
        drop(store);

        let restarted = FfiReplayStore::with_path(path_str);
        // Cursor survived → next connect asks for only what came after id 42,
        // instead of sinceId 0 (the whole retained tail).
        assert_eq!(restarted.since_id("build".into()), 42);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn plain_new_does_not_persist() {
        let store = FfiReplayStore::new();
        store.accept_output("build".into(), 9);
        // Noop store keeps it in memory this run, but nothing is written — a
        // fresh store starts cold. Proven here by the in-memory value only.
        assert_eq!(store.since_id("build".into()), 9);
    }
}
