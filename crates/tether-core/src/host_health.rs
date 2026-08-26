use std::num::NonZeroU32;

/// Reachability state for one host.
///
/// Keeping the failure count inside `Unreachable` prevents callers from
/// constructing the nonsensical "unreachable with zero failures" state that
/// TypeScript's separate fields allowed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostHealth {
    Unknown,
    Reachable,
    Unreachable { failures: NonZeroU32 },
    Unauthorized,
}

pub fn initial_host_health() -> HostHealth {
    HostHealth::Unknown
}

pub fn host_health_after_failure(health: HostHealth) -> HostHealth {
    match health {
        HostHealth::Unauthorized => HostHealth::Unauthorized,
        HostHealth::Unreachable { failures } => HostHealth::Unreachable {
            failures: NonZeroU32::new(failures.get().saturating_add(1))
                .expect("a positive saturating increment stays positive"),
        },
        HostHealth::Unknown | HostHealth::Reachable => HostHealth::Unreachable {
            failures: NonZeroU32::MIN,
        },
    }
}

pub fn host_health_after_response(health: HostHealth, status: u16) -> HostHealth {
    match status {
        200..=299 => HostHealth::Reachable,
        401 => HostHealth::Unauthorized,
        _ => host_health_after_failure(health),
    }
}

pub fn should_poll_host(health: HostHealth) -> bool {
    health != HostHealth::Unauthorized
}

pub fn next_host_poll_delay(health: HostHealth, normal_interval_ms: u64) -> Option<u64> {
    match health {
        HostHealth::Unauthorized => None,
        HostHealth::Unreachable { failures } => {
            let exponent = failures.get().saturating_sub(1).min(4);
            Some((2_000 * (1_u64 << exponent)).min(30_000))
        }
        HostHealth::Unknown | HostHealth::Reachable => Some(normal_interval_ms),
    }
}

/// Wire-stable label matching the TypeScript `HostHealthStatus` union.
pub fn host_health_status_label(health: HostHealth) -> &'static str {
    match health {
        HostHealth::Unknown => "unknown",
        HostHealth::Reachable => "reachable",
        HostHealth::Unreachable { .. } => "unreachable",
        HostHealth::Unauthorized => "unauthorized",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transitions_unknown_and_unreachable_hosts_to_reachable_after_a_successful_response() {
        assert_eq!(
            host_health_after_response(initial_host_health(), 200),
            HostHealth::Reachable
        );
        assert_eq!(
            host_health_after_response(
                HostHealth::Unreachable {
                    failures: NonZeroU32::new(3).unwrap(),
                },
                204,
            ),
            HostHealth::Reachable
        );
    }

    #[test]
    fn marks_a_401_unauthorized_and_stops_future_polling() {
        let health = host_health_after_response(initial_host_health(), 401);
        assert_eq!(health, HostHealth::Unauthorized);
        assert!(!should_poll_host(health));
        assert_eq!(next_host_poll_delay(health, 4_000), None);
    }

    #[test]
    fn marks_non_auth_failures_unreachable_with_backoff_capped_at_30_seconds() {
        let mut health = host_health_after_failure(initial_host_health());
        assert_eq!(
            health,
            HostHealth::Unreachable {
                failures: NonZeroU32::new(1).unwrap(),
            }
        );
        assert_eq!(next_host_poll_delay(health, 4_000), Some(2_000));
        health = host_health_after_failure(health);
        assert_eq!(next_host_poll_delay(health, 4_000), Some(4_000));
        for _ in 0..10 {
            health = host_health_after_failure(health);
        }
        assert_eq!(next_host_poll_delay(health, 4_000), Some(30_000));
    }

    #[test]
    fn treats_non_401_responses_as_unreachable_and_resets_backoff_on_success() {
        let unreachable = host_health_after_response(
            HostHealth::Unreachable {
                failures: NonZeroU32::new(2).unwrap(),
            },
            503,
        );
        assert_eq!(
            unreachable,
            HostHealth::Unreachable {
                failures: NonZeroU32::new(3).unwrap(),
            }
        );
        let reachable = host_health_after_response(unreachable, 200);
        assert_eq!(reachable, HostHealth::Reachable);
        assert_eq!(next_host_poll_delay(reachable, 15_000), Some(15_000));
    }
}
