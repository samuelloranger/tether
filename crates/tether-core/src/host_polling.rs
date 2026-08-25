use std::collections::BTreeMap;

use serde_json::Value;

use crate::host_health::{next_host_poll_delay, HostHealth};
use crate::host_store::HostProfile;
use crate::session_host_ops::{health_after_poll, PollResult};

const ACTIVE_POLL_INTERVAL_MS: u64 = 4_000;
const BACKGROUND_POLL_INTERVAL_MS: u64 = 15_000;

pub fn session_poll_interval(is_active_host: bool) -> u64 {
    if is_active_host {
        ACTIVE_POLL_INTERVAL_MS
    } else {
        BACKGROUND_POLL_INTERVAL_MS
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum HostPollInput {
    NetworkFailure,
    Http { status: u16, body: Value },
}

#[derive(Debug, Clone, PartialEq)]
pub struct HostPollOutcome {
    pub profile: HostProfile,
    pub result: PollResult,
    pub sessions: Option<Vec<Value>>,
}

/// Classifies each host independently. This is the portable equivalent of the
/// TypeScript `Promise.all` containment boundary: every input always produces
/// its own outcome and cannot reject the batch.
pub fn poll_host_sessions(
    inputs: impl IntoIterator<Item = (HostProfile, HostPollInput)>,
) -> Vec<HostPollOutcome> {
    inputs
        .into_iter()
        .map(|(profile, input)| {
            let (result, sessions) = match input {
                HostPollInput::NetworkFailure => (PollResult::Failure, None),
                HostPollInput::Http { status: 401, .. } => (PollResult::Unauthorized, None),
                HostPollInput::Http { status, body } if (200..=299).contains(&status) => {
                    match body.as_array() {
                        Some(sessions) => (PollResult::Success, Some(sessions.clone())),
                        None => (PollResult::Failure, None),
                    }
                }
                HostPollInput::Http { .. } => (PollResult::Failure, None),
            };
            HostPollOutcome {
                profile,
                result,
                sessions,
            }
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScheduledHostPoll {
    pub host_id: String,
    pub delay_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostPollRequest {
    pub host_id: String,
    pub path: &'static str,
}

/// Timer-free per-host scheduling state. The shell turns returned instructions
/// into timers and feeds completed results back through `schedule_after`.
#[derive(Debug, Default)]
pub struct HostPolling {
    stopped: bool,
    scheduled: BTreeMap<String, u64>,
}

impl HostPolling {
    pub fn new() -> Self {
        Self::default()
    }

    /// Starts a polling cycle by returning one initial request per profile.
    /// The shell executes these descriptions and feeds each result back into
    /// [`Self::schedule_after`]; no runtime or task is owned here.
    pub fn start(&mut self, profiles: &[HostProfile]) -> Vec<HostPollRequest> {
        self.stopped = false;
        profiles
            .iter()
            .map(|profile| HostPollRequest {
                host_id: profile.id.clone(),
                path: "/api/sessions",
            })
            .collect()
    }

    pub fn stop(&mut self) {
        self.stopped = true;
        self.scheduled.clear();
    }

    pub fn is_stopped(&self) -> bool {
        self.stopped
    }

    pub fn schedule_after(
        &mut self,
        profile: &HostProfile,
        active_host_id: Option<&str>,
        previous_health: HostHealth,
        result: PollResult,
    ) -> Option<ScheduledHostPoll> {
        if self.stopped {
            return None;
        }
        let health = health_after_poll(previous_health, result);
        let normal_interval = session_poll_interval(active_host_id == Some(profile.id.as_str()));
        let Some(delay_ms) = next_host_poll_delay(health, normal_interval) else {
            self.scheduled.remove(&profile.id);
            return None;
        };
        self.scheduled.insert(profile.id.clone(), delay_ms);
        Some(ScheduledHostPoll {
            host_id: profile.id.clone(),
            delay_ms,
        })
    }

    pub fn scheduled_host_ids(&self) -> Vec<&str> {
        self.scheduled.keys().map(String::as_str).collect()
    }
}

#[cfg(test)]
mod tests {
    use crate::host_health::initial_host_health;

    use super::*;

    fn profile(id: &str) -> HostProfile {
        HostProfile {
            id: id.to_string(),
            name: id.to_string(),
            color: "#89b4fa".to_string(),
            host: format!("{id}.local"),
            port: "8085".to_string(),
            identity_name: id.to_string(),
            order: 0,
        }
    }

    #[test]
    fn uses_the_active_and_background_polling_cadences() {
        assert_eq!(session_poll_interval(true), 4_000);
        assert_eq!(session_poll_interval(false), 15_000);
    }

    #[test]
    fn schedules_each_host_independently_with_its_current_cadence() {
        let mut polling = HostPolling::new();
        let profiles = [profile("background"), profile("active")];
        assert_eq!(
            polling.start(&profiles),
            vec![
                HostPollRequest {
                    host_id: "background".to_string(),
                    path: "/api/sessions",
                },
                HostPollRequest {
                    host_id: "active".to_string(),
                    path: "/api/sessions",
                },
            ]
        );
        let scheduled = profiles
            .into_iter()
            .filter_map(|profile| {
                polling.schedule_after(
                    &profile,
                    Some("active"),
                    initial_host_health(),
                    PollResult::Success,
                )
            })
            .map(|poll| poll.delay_ms)
            .collect::<Vec<_>>();
        assert_eq!(scheduled, vec![15_000, 4_000]);
    }

    #[test]
    fn contains_one_host_failure_while_another_returns_sessions() {
        let outcomes = poll_host_sessions([
            (profile("offline"), HostPollInput::NetworkFailure),
            (
                profile("online"),
                HostPollInput::Http {
                    status: 200,
                    body: serde_json::json!([{ "id": "term-1" }]),
                },
            ),
        ]);
        assert_eq!(outcomes[0].result, PollResult::Failure);
        assert_eq!(outcomes[0].sessions, None);
        assert_eq!(outcomes[1].result, PollResult::Success);
        assert_eq!(outcomes[1].sessions.as_ref().unwrap()[0]["id"], "term-1");
    }

    #[test]
    fn reports_401_without_attempting_to_parse_sessions() {
        let outcomes = poll_host_sessions([(
            profile("locked"),
            HostPollInput::Http {
                status: 401,
                body: serde_json::json!({ "not": "sessions" }),
            },
        )]);
        assert_eq!(outcomes[0].result, PollResult::Unauthorized);
        assert_eq!(outcomes[0].sessions, None);
    }

    #[test]
    fn backs_off_a_dead_host_instead_of_using_its_normal_cadence() {
        let mut polling = HostPolling::new();
        let scheduled = polling
            .schedule_after(
                &profile("offline"),
                Some("offline"),
                initial_host_health(),
                PollResult::Failure,
            )
            .unwrap();
        assert_eq!(scheduled.delay_ms, 2_000);
    }

    #[test]
    fn unauthorized_hosts_are_not_rescheduled_and_stop_clears_bookkeeping() {
        let mut polling = HostPolling::new();
        assert_eq!(
            polling.schedule_after(
                &profile("locked"),
                Some("locked"),
                initial_host_health(),
                PollResult::Unauthorized,
            ),
            None
        );
        polling.schedule_after(
            &profile("online"),
            Some("online"),
            initial_host_health(),
            PollResult::Success,
        );
        assert_eq!(polling.scheduled_host_ids(), vec!["online"]);
        polling.stop();
        assert!(polling.scheduled_host_ids().is_empty());
        assert!(polling.is_stopped());
    }
}
