use tether_core::host_health::{
    host_health_after_failure, host_health_after_response, initial_host_health,
    next_host_poll_delay, should_poll_host, HostHealth,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum FfiHostHealth {
    Unknown,
    Reachable,
    Unreachable { failures: u32 },
    Unauthorized,
}

impl From<HostHealth> for FfiHostHealth {
    fn from(health: HostHealth) -> Self {
        match health {
            HostHealth::Unknown => Self::Unknown,
            HostHealth::Reachable => Self::Reachable,
            HostHealth::Unreachable { failures } => Self::Unreachable {
                failures: failures.get(),
            },
            HostHealth::Unauthorized => Self::Unauthorized,
        }
    }
}

impl From<FfiHostHealth> for HostHealth {
    fn from(health: FfiHostHealth) -> Self {
        match health {
            FfiHostHealth::Unknown => Self::Unknown,
            FfiHostHealth::Reachable => Self::Reachable,
            FfiHostHealth::Unreachable { failures } => Self::Unreachable {
                failures: std::num::NonZeroU32::new(failures.max(1)).expect("failures >= 1"),
            },
            FfiHostHealth::Unauthorized => Self::Unauthorized,
        }
    }
}

#[uniffi::export]
pub fn ffi_initial_host_health() -> FfiHostHealth {
    initial_host_health().into()
}

#[uniffi::export]
pub fn ffi_host_health_after_failure(health: FfiHostHealth) -> FfiHostHealth {
    host_health_after_failure(health.into()).into()
}

#[uniffi::export]
pub fn ffi_host_health_after_response(health: FfiHostHealth, status: u16) -> FfiHostHealth {
    host_health_after_response(health.into(), status).into()
}

#[uniffi::export]
pub fn ffi_should_poll_host(health: FfiHostHealth) -> bool {
    should_poll_host(health.into())
}

#[uniffi::export]
pub fn ffi_next_host_poll_delay(health: FfiHostHealth, normal_interval_ms: u64) -> Option<u64> {
    next_host_poll_delay(health.into(), normal_interval_ms)
}
