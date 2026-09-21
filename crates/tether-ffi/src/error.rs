use thiserror::Error;

#[derive(Debug, Error, uniffi::Error)]
pub enum FfiCursorError {
    #[error("cursor persistence failed: {message}")]
    Persistence { message: String },
}

impl From<tether_core::store::CursorPersistenceError> for FfiCursorError {
    fn from(error: tether_core::store::CursorPersistenceError) -> Self {
        Self::Persistence {
            message: error.to_string(),
        }
    }
}
