use std::collections::{BTreeMap, HashMap};

use serde::Deserialize;
use serde_json::Value;

use crate::host_client::{HostClient, HttpRequest};
use crate::host_health::{host_health_after_failure, host_health_after_response, HostHealth};
use crate::host_store::HostProfile;
use crate::session_cache::SessionCache;
use crate::terminal_session_logic::{SessionKey, SessionRow};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PollResult {
    Success,
    Failure,
    Unauthorized,
}

pub fn health_after_poll(current: HostHealth, result: PollResult) -> HostHealth {
    match result {
        PollResult::Success => host_health_after_response(current, 200),
        PollResult::Unauthorized => host_health_after_response(current, 401),
        PollResult::Failure => host_health_after_failure(current),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RefreshOutcome {
    Success {
        rows: Vec<SessionRow>,
        notify_waiting: bool,
    },
    Unauthorized {
        auth_failed: bool,
    },
    Failure,
}

#[derive(Debug, Deserialize)]
struct RemoteSessionRow {
    id: String,
    status: String,
    #[serde(default)]
    last_output_at: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    auto_title: Option<String>,
    #[serde(default)]
    activity: Option<String>,
}

/// Reduces one completed `/api/sessions` request. Fetching and observer calls
/// remain shell responsibilities; malformed rows cannot enter core state.
/// Each row is stamped with `profile.id` as `host_id`, matching TypeScript's
/// `applyPolledSessions` merge but doing it at reduction time so drawer state
/// is host-qualified before any session-selection logic runs.
pub fn reduce_session_list_response(
    profile: &HostProfile,
    active_host_id: &str,
    status: u16,
    body: &Value,
) -> RefreshOutcome {
    if status == 401 {
        return RefreshOutcome::Unauthorized {
            auth_failed: profile.id == active_host_id,
        };
    }
    if !(200..=299).contains(&status) {
        return RefreshOutcome::Failure;
    }
    let Some(values) = body.as_array() else {
        return RefreshOutcome::Failure;
    };
    let rows = values
        .iter()
        .cloned()
        .map(serde_json::from_value::<RemoteSessionRow>)
        .collect::<Result<Vec<_>, _>>();
    let Ok(rows) = rows else {
        return RefreshOutcome::Failure;
    };
    RefreshOutcome::Success {
        rows: rows
            .into_iter()
            .map(|row| SessionRow {
                host_id: profile.id.clone(),
                id: row.id,
                status: row.status,
                last_output_at: row.last_output_at,
                name: row.name,
                auto_title: row.auto_title,
                activity: row.activity,
            })
            .collect(),
        notify_waiting: profile.id == active_host_id,
    }
}

/// Work known before the shell performs the kill and refresh requests.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KillSessionPlan {
    pub request: HttpRequest,
    key: SessionKey,
    next_session_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KillSessionCompletion {
    pub delete_key: SessionKey,
    pub disconnect_key: SessionKey,
    pub refresh_sessions: bool,
    pub clear_presentation: bool,
    pub switch_to: Option<SessionKey>,
}

/// Plans the kill using a host-qualified key and chooses a fallback only from
/// that host. This intentionally corrects the TypeScript port source, which
/// filters by bare session id and can cross host boundaries when ids collide.
pub fn plan_kill_session(
    client: &HostClient,
    session: &SessionKey,
    drawer_sessions: &[SessionRow],
) -> KillSessionPlan {
    let next_session_id = drawer_sessions
        .iter()
        .find(|row| row.host_id == session.host_id() && row.id != session.session_id())
        .map(|row| row.id.clone())
        .unwrap_or_else(|| "term-1".to_string());
    let request = client.post(
        "/api/sessions/kill",
        BTreeMap::from([("Content-Type".to_string(), "application/json".to_string())]),
        Some(serde_json::json!({ "id": session.session_id() }).to_string()),
    );
    KillSessionPlan {
        request,
        key: session.clone(),
        next_session_id,
    }
}

impl KillSessionPlan {
    /// Must be called after the shell's kill and refresh awaits, with the
    /// active key read at that time.
    pub fn complete(&self, latest_active_key: &SessionKey) -> KillSessionCompletion {
        let remains_active = &self.key == latest_active_key;
        KillSessionCompletion {
            delete_key: self.key.clone(),
            disconnect_key: self.key.clone(),
            refresh_sessions: true,
            clear_presentation: remains_active,
            switch_to: remains_active.then(|| {
                SessionKey::new(self.key.host_id(), &self.next_session_id)
                    .expect("an existing session id and host produce a valid key")
            }),
        }
    }
}

/// Removes one host's resident state and returns the connections the shell
/// must disconnect. Network teardown itself stays outside the core.
pub fn drop_host_sessions<T>(
    host_id: &str,
    connections: &[SessionKey],
    cache: &mut SessionCache<T>,
    rows: &mut Vec<SessionRow>,
    health: &mut HashMap<String, HostHealth>,
) -> Vec<SessionKey> {
    let disconnected = connections
        .iter()
        .filter(|key| key.host_id() == host_id)
        .cloned()
        .collect::<Vec<_>>();
    let cached = cache
        .ids()
        .into_iter()
        .filter_map(|key| key.parse::<SessionKey>().ok())
        .filter(|key| key.host_id() == host_id)
        .collect::<Vec<_>>();
    for key in cached {
        cache.delete(&key.to_string());
    }
    rows.retain(|row| row.host_id != host_id);
    health.remove(host_id);
    disconnected
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
            scheme: None,
        }
    }

    fn row(host_id: &str, id: &str) -> SessionRow {
        SessionRow {
            host_id: host_id.to_string(),
            id: id.to_string(),
            status: "running".to_string(),
            last_output_at: None,
            name: None,
            auto_title: None,
            activity: None,
        }
    }

    fn kill_plan(rows: &[SessionRow]) -> KillSessionPlan {
        let client = HostClient::new(profile("host-1"), "secret");
        plan_kill_session(&client, &"host-1:term-1".parse().unwrap(), rows)
    }

    #[test]
    fn switches_to_the_next_session_when_the_killed_tab_is_still_active() {
        let plan = kill_plan(&[row("host-1", "term-1"), row("host-1", "term-2")]);
        assert_eq!(
            plan.request.url,
            "http://host-1.local:8085/api/sessions/kill"
        );
        assert_eq!(plan.request.body.as_deref(), Some(r#"{"id":"term-1"}"#));
        assert_eq!(
            plan.complete(&"host-1:term-1".parse().unwrap()),
            KillSessionCompletion {
                delete_key: "host-1:term-1".parse().unwrap(),
                disconnect_key: "host-1:term-1".parse().unwrap(),
                refresh_sessions: true,
                clear_presentation: true,
                switch_to: Some("host-1:term-2".parse().unwrap()),
            }
        );
    }

    #[test]
    fn falls_back_to_term_one_when_nothing_remains() {
        let plan = kill_plan(&[row("host-1", "term-1")]);
        assert_eq!(
            plan.complete(&"host-1:term-1".parse().unwrap()).switch_to,
            Some("host-1:term-1".parse().unwrap())
        );
    }

    #[test]
    fn leaves_a_background_kill_alone() {
        let plan = kill_plan(&[row("host-1", "term-1"), row("host-1", "term-2")]);
        let completion = plan.complete(&"host-1:term-2".parse().unwrap());
        assert_eq!(completion.disconnect_key.to_string(), "host-1:term-1");
        assert!(!completion.clear_presentation);
        assert_eq!(completion.switch_to, None);
    }

    #[test]
    fn tab_changes_during_the_kill_request_prevent_switching() {
        let plan = kill_plan(&[row("host-1", "term-1"), row("host-1", "term-2")]);
        let latest_active_key = "host-1:term-2".parse().unwrap();
        assert_eq!(plan.complete(&latest_active_key).switch_to, None);
    }

    #[test]
    fn tab_changes_during_the_refresh_prevent_switching() {
        let plan = kill_plan(&[row("host-1", "term-1"), row("host-1", "term-2")]);
        let latest_active_key = "host-1:term-2".parse().unwrap();
        assert!(!plan.complete(&latest_active_key).clear_presentation);
    }

    #[test]
    fn board_798_same_session_id_on_two_hosts_stays_host_qualified() {
        use crate::tether_app_actions::open_rename;

        let mut host_two = row("host-2", "term-1");
        host_two.name = Some("Other host".to_string());
        let mut host_one = row("host-1", "term-1");
        host_one.name = Some("Studio".to_string());
        let rows = vec![host_two, row("host-1", "term-2"), host_one];

        let client = HostClient::new(profile("host-1"), "secret");
        let active = "host-1:term-1".parse().unwrap();
        let plan = plan_kill_session(&client, &active, &rows);
        assert_eq!(
            plan.complete(&active).switch_to,
            Some("host-1:term-2".parse().unwrap())
        );
        assert_eq!(open_rename(&rows, &active).text, "Studio");
    }

    #[test]
    fn post_kill_fallback_selects_only_from_the_killed_sessions_host() {
        let plan = kill_plan(&[
            row("host-2", "term-1"),
            row("host-2", "term-2"),
            row("host-1", "term-1"),
            row("host-1", "term-3"),
        ]);

        assert_eq!(
            plan.complete(&"host-1:term-1".parse().unwrap()).switch_to,
            Some("host-1:term-3".parse().unwrap())
        );
    }

    #[test]
    fn applies_poll_results_to_the_existing_host_health_policy() {
        assert_eq!(
            health_after_poll(initial_host_health(), PollResult::Success),
            HostHealth::Reachable
        );
        assert_eq!(
            health_after_poll(initial_host_health(), PollResult::Unauthorized),
            HostHealth::Unauthorized
        );
        assert!(matches!(
            health_after_poll(initial_host_health(), PollResult::Failure),
            HostHealth::Unreachable { .. }
        ));
    }

    #[test]
    fn refresh_qualifies_rows_and_notifies_only_for_the_active_host() {
        let body = serde_json::json!([
            { "id": "term-1", "status": "running", "last_output_at": null }
        ]);
        assert_eq!(
            reduce_session_list_response(&profile("host-1"), "host-1", 200, &body),
            RefreshOutcome::Success {
                rows: vec![row("host-1", "term-1")],
                notify_waiting: true,
            }
        );
        assert_eq!(
            reduce_session_list_response(&profile("host-1"), "host-2", 200, &body),
            RefreshOutcome::Success {
                rows: vec![row("host-1", "term-1")],
                notify_waiting: false,
            }
        );
    }

    #[test]
    fn refresh_reports_unauthorized_and_malformed_responses_without_rows() {
        assert_eq!(
            reduce_session_list_response(
                &profile("host-1"),
                "host-1",
                401,
                &serde_json::Value::Null,
            ),
            RefreshOutcome::Unauthorized { auth_failed: true }
        );
        assert_eq!(
            reduce_session_list_response(&profile("host-1"), "host-1", 200, &serde_json::json!({}),),
            RefreshOutcome::Failure
        );
    }

    #[test]
    fn drops_only_the_selected_hosts_connections_cache_rows_and_health() {
        let mut cache = SessionCache::new(3);
        cache.touch("host-1:term-1", || 1);
        cache.touch("host-2:term-1", || 2);
        let mut rows = vec![row("host-1", "term-1"), row("host-2", "term-1")];
        let mut health = std::collections::HashMap::from([
            ("host-1".to_string(), HostHealth::Reachable),
            ("host-2".to_string(), HostHealth::Reachable),
        ]);
        let disconnected = drop_host_sessions(
            "host-1",
            &[
                "host-1:term-1".parse().unwrap(),
                "host-2:term-1".parse().unwrap(),
            ],
            &mut cache,
            &mut rows,
            &mut health,
        );
        assert_eq!(disconnected, vec!["host-1:term-1".parse().unwrap()]);
        assert!(!cache.has("host-1:term-1"));
        assert!(cache.has("host-2:term-1"));
        assert_eq!(rows, vec![row("host-2", "term-1")]);
        assert!(!health.contains_key("host-1"));
        assert!(health.contains_key("host-2"));
    }
}
