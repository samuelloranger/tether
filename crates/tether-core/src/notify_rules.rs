//! Desktop OS-notification trigger rules.
//!
//! Ported from the behaviour in `apps/mobile/src/activity.ts` (`newlyWaiting`)
//! and `apps/mobile/src/tether/terminalSessionLogic.ts` (`maybeNotify`). The
//! mobile `desktopNotify.ts` module is only a send shim — the *rules* live here.

use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionActivity {
    Working,
    Waiting,
    Idle,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActivityRow {
    pub id: String,
    pub status: SessionStatus,
    pub activity: Option<SessionActivity>,
    pub name: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionStatus {
    Running,
    Stopped,
}

/// Emulator-side edges that can deserve a desktop notification.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmulatorNotifyEdge {
    pub notify_fired: bool,
    pub bell_fired: bool,
    pub osc_title: String,
    pub osc_body: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DesktopNotify {
    Osc { title: String, body: String },
    Bell { title: String, body: String },
}

/// Decide whether an OSC-notify / bell edge should surface as an OS notification.
///
/// Always returns `None` when notifications are disabled, or when the session is
/// both active and focused (the user can already see the terminal). OSC edges
/// win over bell when both fire in the same tick.
pub fn desktop_notify_for_edge(
    edge: &EmulatorNotifyEdge,
    notifications_enabled: bool,
    session_is_active: bool,
    window_focused: bool,
) -> Option<DesktopNotify> {
    if !notifications_enabled || (session_is_active && window_focused) {
        return None;
    }
    if edge.notify_fired {
        let title = if edge.osc_title.is_empty() {
            edge.label.clone()
        } else {
            edge.osc_title.clone()
        };
        let body = if edge.osc_body.is_empty() {
            "Needs your input".to_string()
        } else {
            edge.osc_body.clone()
        };
        return Some(DesktopNotify::Osc { title, body });
    }
    if edge.bell_fired {
        return Some(DesktopNotify::Bell {
            title: edge.label.clone(),
            body: "Terminal bell".to_string(),
        });
    }
    None
}

/// Background sessions that just flipped to `waiting`.
///
/// Only fires on a working/idle/unknown → waiting edge, so a still-waiting
/// session does not re-notify on every poll. The active session is always
/// excluded — its alerts belong to the focus-aware emulator path.
pub fn newly_waiting(
    prev: &HashMap<String, Option<SessionActivity>>,
    rows: &[ActivityRow],
    active_id: Option<&str>,
) -> Vec<ActivityRow> {
    rows.iter()
        .filter(|row| {
            if row.status != SessionStatus::Running
                || row.activity != Some(SessionActivity::Waiting)
            {
                return false;
            }
            if prev.get(&row.id).copied().flatten() == Some(SessionActivity::Waiting) {
                return false;
            }
            if active_id == Some(row.id.as_str()) {
                return false;
            }
            true
        })
        .cloned()
        .collect()
}

/// Single-session waiting edge (WS `activity` frame path).
pub fn waiting_edge_deserves_notify(
    prev: Option<SessionActivity>,
    next: Option<SessionActivity>,
    is_active: bool,
) -> bool {
    next == Some(SessionActivity::Waiting) && prev != Some(SessionActivity::Waiting) && !is_active
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edge(notify: bool, bell: bool) -> EmulatorNotifyEdge {
        EmulatorNotifyEdge {
            notify_fired: notify,
            bell_fired: bell,
            osc_title: "Done".into(),
            osc_body: "Build finished".into(),
            label: "Build".into(),
        }
    }

    #[test]
    fn suppresses_active_focused_session_but_still_classifies_as_none() {
        assert_eq!(
            desktop_notify_for_edge(&edge(true, false), true, true, true),
            None
        );
    }

    #[test]
    fn fires_osc_then_bell_once_each_for_background_session() {
        assert_eq!(
            desktop_notify_for_edge(&edge(true, false), true, false, true),
            Some(DesktopNotify::Osc {
                title: "Done".into(),
                body: "Build finished".into(),
            })
        );
        assert_eq!(
            desktop_notify_for_edge(&edge(false, true), true, false, true),
            Some(DesktopNotify::Bell {
                title: "Build".into(),
                body: "Terminal bell".into(),
            })
        );
    }

    #[test]
    fn disabled_notifications_never_fire() {
        assert_eq!(
            desktop_notify_for_edge(&edge(true, true), false, false, false),
            None
        );
    }

    #[test]
    fn newly_waiting_only_on_edge_and_never_for_active() {
        let mut prev = HashMap::new();
        prev.insert("term-1".into(), Some(SessionActivity::Working));
        prev.insert("term-2".into(), Some(SessionActivity::Waiting));
        let rows = vec![
            ActivityRow {
                id: "term-1".into(),
                status: SessionStatus::Running,
                activity: Some(SessionActivity::Waiting),
                name: None,
            },
            ActivityRow {
                id: "term-2".into(),
                status: SessionStatus::Running,
                activity: Some(SessionActivity::Waiting),
                name: None,
            },
            ActivityRow {
                id: "term-3".into(),
                status: SessionStatus::Running,
                activity: Some(SessionActivity::Waiting),
                name: Some("bg".into()),
            },
        ];
        let fired = newly_waiting(&prev, &rows, Some("term-3"));
        assert_eq!(fired.len(), 1);
        assert_eq!(fired[0].id, "term-1");
    }

    #[test]
    fn waiting_edge_skips_active_and_repeats() {
        assert!(waiting_edge_deserves_notify(
            Some(SessionActivity::Working),
            Some(SessionActivity::Waiting),
            false
        ));
        assert!(!waiting_edge_deserves_notify(
            Some(SessionActivity::Working),
            Some(SessionActivity::Waiting),
            true
        ));
        assert!(!waiting_edge_deserves_notify(
            Some(SessionActivity::Waiting),
            Some(SessionActivity::Waiting),
            false
        ));
    }
}
