use thiserror::Error;

#[derive(Debug, Error, uniffi::Error)]
pub enum FfiHostStoreError {
    #[error("storage operation failed: {message}")]
    Storage { message: String },
    #[error("secret operation failed: {message}")]
    Secret { message: String },
    #[error("unknown host profile: {id}")]
    UnknownProfile { id: String },
    #[error("migrated host password could not be read back")]
    PasswordVerification,
    #[error("migrated host profile could not be read back")]
    ProfileVerification,
}

impl From<tether_core::host_store::HostStoreError> for FfiHostStoreError {
    fn from(error: tether_core::host_store::HostStoreError) -> Self {
        match error {
            tether_core::host_store::HostStoreError::Storage(message) => Self::Storage { message },
            tether_core::host_store::HostStoreError::Secret(message) => Self::Secret { message },
            tether_core::host_store::HostStoreError::UnknownProfile(id) => {
                Self::UnknownProfile { id }
            }
            tether_core::host_store::HostStoreError::PasswordVerification => {
                Self::PasswordVerification
            }
            tether_core::host_store::HostStoreError::ProfileVerification => {
                Self::ProfileVerification
            }
        }
    }
}

impl From<FfiHostStoreError> for tether_core::host_store::HostStoreError {
    fn from(error: FfiHostStoreError) -> Self {
        match error {
            FfiHostStoreError::Storage { message } => Self::Storage(message),
            FfiHostStoreError::Secret { message } => Self::Secret(message),
            FfiHostStoreError::UnknownProfile { id } => Self::UnknownProfile(id),
            FfiHostStoreError::PasswordVerification => Self::PasswordVerification,
            FfiHostStoreError::ProfileVerification => Self::ProfileVerification,
        }
    }
}

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

impl From<uniffi::UnexpectedUniFFICallbackError> for FfiHostStoreError {
    fn from(_: uniffi::UnexpectedUniFFICallbackError) -> Self {
        Self::Storage {
            message: "callback raised unexpectedly".to_string(),
        }
    }
}
