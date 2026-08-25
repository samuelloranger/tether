use std::sync::Arc;

use tether_core::store::ReplayStore;

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
