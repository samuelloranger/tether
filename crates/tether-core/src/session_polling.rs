use std::collections::HashSet;

use crate::terminal_session_logic::{InvalidSessionKey, SessionKey, SessionRow};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActiveSessionPersistence {
    pub storage_key: String,
    pub session_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionAdoption {
    pub active_key: SessionKey,
    pub persistence: ActiveSessionPersistence,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionPollingUpdate {
    pub rows: Vec<SessionRow>,
    pub notify_waiting: bool,
    pub adoption: Option<SessionAdoption>,
    pub connect_active: bool,
}

/// One-time adoption/probe bookkeeping shared by all host polling cycles.
#[derive(Debug, Default)]
pub struct SessionPollingState {
    adopted_hosts: HashSet<String>,
    probed_hosts: HashSet<String>,
}

impl SessionPollingState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn has_adopted(&self, host_id: &str) -> bool {
        self.adopted_hosts.contains(host_id)
    }

    pub fn apply_polled_sessions(
        &mut self,
        profile_id: &str,
        mut rows: Vec<SessionRow>,
        active_host_id: &str,
        active_session_id: &str,
        ready: bool,
    ) -> Result<SessionPollingUpdate, InvalidSessionKey> {
        for row in &mut rows {
            row.host_id = profile_id.to_string();
        }
        if profile_id != active_host_id {
            return Ok(SessionPollingUpdate {
                rows,
                notify_waiting: false,
                adoption: None,
                connect_active: false,
            });
        }
        if !self.adopted_hosts.insert(profile_id.to_string()) {
            return Ok(SessionPollingUpdate {
                rows,
                notify_waiting: true,
                adoption: None,
                connect_active: false,
            });
        }

        let running = rows
            .iter()
            .filter(|row| row.status == "running")
            .collect::<Vec<_>>();
        let adoption = if running.iter().any(|row| row.id == active_session_id) {
            None
        } else {
            newest_running(&running)
                .map(|row| {
                    let active_key = SessionKey::new(profile_id, &row.id)?;
                    Ok(SessionAdoption {
                        active_key,
                        persistence: ActiveSessionPersistence {
                            storage_key: active_session_storage_key(profile_id),
                            session_id: row.id.clone(),
                        },
                    })
                })
                .transpose()?
        };

        Ok(SessionPollingUpdate {
            rows,
            notify_waiting: true,
            adoption,
            connect_active: ready,
        })
    }

    pub fn probe_unreachable_active_host(
        &mut self,
        profile_id: &str,
        active_host_id: &str,
        ready: bool,
    ) -> bool {
        if profile_id != active_host_id
            || self.adopted_hosts.contains(profile_id)
            || self.probed_hosts.contains(profile_id)
            || !ready
        {
            return false;
        }
        self.probed_hosts.insert(profile_id.to_string());
        true
    }
}

fn newest_running<'a>(rows: &[&'a SessionRow]) -> Option<&'a SessionRow> {
    let mut newest: Option<&SessionRow> = None;
    for &row in rows {
        let replace = newest.is_none_or(|current| {
            row.last_output_at.as_deref().unwrap_or("")
                > current.last_output_at.as_deref().unwrap_or("")
        });
        if replace {
            newest = Some(row);
        }
    }
    newest
}

pub fn active_session_storage_key(host_id: &str) -> String {
    format!("tether_session_id_{host_id}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: &str, status: &str, last_output_at: Option<&str>) -> SessionRow {
        SessionRow {
            host_id: String::new(),
            id: id.to_string(),
            status: status.to_string(),
            last_output_at: last_output_at.map(str::to_string),
            name: None,
            auto_title: None,
            activity: None,
        }
    }

    #[test]
    fn inactive_host_rows_are_qualified_without_adoption_or_notification() {
        let mut state = SessionPollingState::new();
        let update = state
            .apply_polled_sessions(
                "host-2",
                vec![row("term-1", "running", None)],
                "host-1",
                "term-1",
                true,
            )
            .unwrap();
        assert_eq!(update.rows[0].host_id, "host-2");
        assert!(!update.notify_waiting);
        assert_eq!(update.adoption, None);
        assert!(!update.connect_active);
        assert!(!state.has_adopted("host-2"));
    }

    #[test]
    fn active_host_adopts_the_newest_running_session_once() {
        let mut state = SessionPollingState::new();
        let update = state
            .apply_polled_sessions(
                "host-1",
                vec![
                    row("term-2", "running", Some("2026-08-25T10:00:00Z")),
                    row("term-3", "running", Some("2026-08-25T11:00:00Z")),
                    row("term-4", "exited", Some("2026-08-25T12:00:00Z")),
                ],
                "host-1",
                "term-1",
                true,
            )
            .unwrap();
        assert!(update.notify_waiting);
        assert!(update.connect_active);
        assert_eq!(
            update.adoption,
            Some(SessionAdoption {
                active_key: "host-1:term-3".parse().unwrap(),
                persistence: ActiveSessionPersistence {
                    storage_key: "tether_session_id_host-1".to_string(),
                    session_id: "term-3".to_string(),
                },
            })
        );
        assert!(state.has_adopted("host-1"));

        let second = state
            .apply_polled_sessions(
                "host-1",
                vec![row("term-5", "running", None)],
                "host-1",
                "term-3",
                true,
            )
            .unwrap();
        assert_eq!(second.adoption, None);
        assert!(!second.connect_active);
    }

    #[test]
    fn keeps_the_current_running_session_and_connects_without_persistence() {
        let mut state = SessionPollingState::new();
        let update = state
            .apply_polled_sessions(
                "host-1",
                vec![
                    row("term-1", "running", None),
                    row("term-2", "running", None),
                ],
                "host-1",
                "term-1",
                true,
            )
            .unwrap();
        assert_eq!(update.adoption, None);
        assert!(update.connect_active);
    }

    #[test]
    fn an_empty_host_is_marked_adopted_and_connects_only_when_ready() {
        let mut state = SessionPollingState::new();
        let update = state
            .apply_polled_sessions("host-1", Vec::new(), "host-1", "term-1", false)
            .unwrap();
        assert_eq!(update.adoption, None);
        assert!(!update.connect_active);
        assert!(state.has_adopted("host-1"));
    }

    #[test]
    fn probes_an_unreachable_active_host_once_without_marking_it_adopted() {
        let mut state = SessionPollingState::new();
        assert!(state.probe_unreachable_active_host("host-1", "host-1", true));
        assert!(!state.probe_unreachable_active_host("host-1", "host-1", true));
        assert!(!state.has_adopted("host-1"));
        assert!(!state.probe_unreachable_active_host("host-2", "host-1", true));
    }
}
