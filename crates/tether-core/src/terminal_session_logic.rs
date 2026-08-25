use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::protocol::{ClientFrame, ServerFrame};
use crate::session_cache::SessionCache;
use crate::store::ReplayStore;

pub const HEALTHY_CONNECTION_MS: u64 = 10_000;

/// Host-qualified identity for a terminal session. A bare session id cannot be
/// used accidentally where multi-host state requires the composite key.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SessionKey {
    host_id: String,
    session_id: String,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
#[error("invalid session key: {0}")]
pub struct InvalidSessionKey(String);

impl SessionKey {
    pub fn new(
        host_id: impl Into<String>,
        session_id: impl Into<String>,
    ) -> Result<Self, InvalidSessionKey> {
        let host_id = host_id.into();
        let session_id = session_id.into();
        if host_id.is_empty() || host_id.contains(':') || session_id.is_empty() {
            return Err(InvalidSessionKey(format!("{host_id}:{session_id}")));
        }
        Ok(Self {
            host_id,
            session_id,
        })
    }

    pub fn host_id(&self) -> &str {
        &self.host_id
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }
}

impl fmt::Display for SessionKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}:{}", self.host_id, self.session_id)
    }
}

impl FromStr for SessionKey {
    type Err = InvalidSessionKey;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        let (host_id, session_id) = value
            .split_once(':')
            .ok_or_else(|| InvalidSessionKey(value.to_string()))?;
        Self::new(host_id, session_id).map_err(|_| InvalidSessionKey(value.to_string()))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionStatus {
    Connecting,
    Connected,
    Disconnected,
    AuthFailed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionSwitchAction {
    None,
    Hydrate,
    Connect,
}

pub fn session_switch_action(
    active: &SessionKey,
    target: &SessionKey,
    target_is_resident: bool,
) -> SessionSwitchAction {
    if active == target {
        SessionSwitchAction::None
    } else if target_is_resident {
        SessionSwitchAction::Hydrate
    } else {
        SessionSwitchAction::Connect
    }
}

pub fn status_after_close(
    active: &SessionKey,
    closed: &SessionKey,
    current: ConnectionStatus,
) -> ConnectionStatus {
    if active == closed {
        ConnectionStatus::Disconnected
    } else {
        current
    }
}

pub fn focus_frame(focused: bool) -> ClientFrame {
    ClientFrame::Focus { focused }
}

/// Exponential reconnect delay with jitter in the upper half of the band.
pub fn backoff_delay(attempt: u32, random_unit: f64) -> u64 {
    let exponent = attempt.min(5);
    let base = (1_000_u64 * (1_u64 << exponent)).min(30_000);
    let jitter = (random_unit.clamp(0.0, 1.0) * (base / 2) as f64).floor() as u64;
    base / 2 + jitter.min(base / 2 - 1)
}

pub fn retry_after_close(retry: u32, opened_at_ms: u64, now_ms: u64, healthy_ms: u64) -> u32 {
    let lived_ms = if opened_at_ms > 0 {
        now_ms.saturating_sub(opened_at_ms)
    } else {
        0
    };
    if opened_at_ms > 0 && lived_ms >= healthy_ms {
        0
    } else {
        retry
    }
}

pub fn is_current_generation(current: u64, candidate: u64) -> bool {
    current == candidate
}

/// Runtime-free instruction for a shell timer. It deliberately carries no
/// `HostClient`, forcing the shell to resolve the current client when it fires.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReconnectPlan {
    pub session: SessionKey,
    pub delay_ms: u64,
}

pub fn reconnect_plan(ready: bool, session: SessionKey, delay_ms: u64) -> Option<ReconnectPlan> {
    ready.then_some(ReconnectPlan { session, delay_ms })
}

pub fn resident_session_cache<T>() -> SessionCache<T> {
    SessionCache::default()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRow {
    pub host_id: String,
    pub id: String,
    pub status: String,
    pub last_output_at: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub auto_title: Option<String>,
    #[serde(default)]
    pub activity: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalTarget {
    ActivePage,
    BackgroundEmulator,
}

/// Shell work produced by a server frame. The `DiffAvailable` variant is the
/// Tier-2 stub: parsing repository status remains with the later git-model port.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FrameEffect {
    Output {
        target: TerminalTarget,
        chunk: String,
    },
    Title {
        session: SessionKey,
        title: String,
    },
    Activity {
        session: SessionKey,
        activity: String,
    },
    DiffAvailable {
        active: bool,
    },
    Reset {
        hydrate_active: bool,
    },
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NotificationCursor {
    pub last_bell_count: u64,
    pub last_notify_count: u64,
}

/// Dispatches a typed server frame and reuses the canonical per-session replay
/// store. No `sinceId` or `lastAppliedId` state is duplicated in this module.
pub fn dispatch_server_frame(
    replay: &ReplayStore,
    session: &SessionKey,
    active: &SessionKey,
    frame: ServerFrame,
    notifications: &mut NotificationCursor,
) -> Option<FrameEffect> {
    let target = if session == active {
        TerminalTarget::ActivePage
    } else {
        TerminalTarget::BackgroundEmulator
    };
    match frame {
        ServerFrame::Output { id, chunk } => replay
            .accept_output(&session.to_string(), id)
            .then_some(FrameEffect::Output { target, chunk }),
        ServerFrame::Exit { exit_code } => {
            let code = exit_code
                .map(|code| format!(" with code {code}"))
                .unwrap_or_default();
            Some(FrameEffect::Output {
                target,
                chunk: format!("\r\n\x1b[31m[Process exited{code}]\x1b[0m\r\n"),
            })
        }
        ServerFrame::Title { title } => Some(FrameEffect::Title {
            session: session.clone(),
            title,
        }),
        ServerFrame::Activity { activity } => Some(FrameEffect::Activity {
            session: session.clone(),
            activity,
        }),
        ServerFrame::Diff => Some(FrameEffect::DiffAvailable {
            active: session == active,
        }),
        ServerFrame::Reset => {
            replay.reset(&session.to_string());
            *notifications = NotificationCursor::default();
            Some(FrameEffect::Reset {
                hydrate_active: session == active,
            })
        }
        ServerFrame::Ping | ServerFrame::Unknown => None,
    }
}

/// Applies host-qualified title/activity effects and returns the waiting row
/// emitted by an activity edge.
pub fn apply_session_metadata(rows: &mut [SessionRow], effect: &FrameEffect) -> Vec<SessionRow> {
    match effect {
        FrameEffect::Title { session, title } => {
            if let Some(row) = matching_row(rows, session) {
                row.auto_title = Some(title.clone());
            }
            Vec::new()
        }
        FrameEffect::Activity { session, activity } => {
            if let Some(row) = matching_row(rows, session) {
                row.activity = Some(activity.clone());
            }
            vec![SessionRow {
                host_id: session.host_id.clone(),
                id: session.session_id.clone(),
                status: "running".to_string(),
                last_output_at: None,
                name: None,
                auto_title: None,
                activity: Some(activity.clone()),
            }]
        }
        _ => Vec::new(),
    }
}

fn matching_row<'a>(
    rows: &'a mut [SessionRow],
    session: &SessionKey,
) -> Option<&'a mut SessionRow> {
    rows.iter_mut()
        .find(|row| row.host_id == session.host_id && row.id == session.session_id)
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NotificationContent {
    pub title: String,
    pub body: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TerminalNotificationState {
    pub bell_count: u64,
    pub notify_count: u64,
    pub last_notify: NotificationContent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NotificationContext<'a> {
    pub is_active: bool,
    pub window_focused: bool,
    pub notifications_enabled: bool,
    pub is_desktop: bool,
    pub label: &'a str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DesktopNotification {
    pub title: String,
    pub body: String,
}

/// Consumes bell/OSC edges before applying visibility and platform policy.
pub fn maybe_notification(
    cursor: &mut NotificationCursor,
    terminal: &TerminalNotificationState,
    context: &NotificationContext<'_>,
) -> Option<DesktopNotification> {
    let notify_fired = terminal.notify_count > cursor.last_notify_count;
    let bell_fired = terminal.bell_count > cursor.last_bell_count;
    cursor.last_notify_count = terminal.notify_count;
    cursor.last_bell_count = terminal.bell_count;

    if !context.is_desktop
        || !context.notifications_enabled
        || (context.is_active && context.window_focused)
    {
        return None;
    }
    if notify_fired {
        return Some(DesktopNotification {
            title: non_empty_or(&terminal.last_notify.title, context.label),
            body: non_empty_or(&terminal.last_notify.body, "Needs your input"),
        });
    }
    bell_fired.then(|| DesktopNotification {
        title: context.label.to_string(),
        body: "Terminal bell".to_string(),
    })
}

fn non_empty_or(value: &str, fallback: &str) -> String {
    if value.is_empty() {
        fallback.to_string()
    } else {
        value.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(host_id: &str, session_id: &str) -> SessionKey {
        SessionKey::new(host_id, session_id).unwrap()
    }

    fn row(host_id: &str, session_id: &str) -> SessionRow {
        SessionRow {
            host_id: host_id.to_string(),
            id: session_id.to_string(),
            status: "running".to_string(),
            last_output_at: None,
            name: None,
            auto_title: None,
            activity: None,
        }
    }

    #[test]
    fn backoff_grows_through_the_capped_retry_window() {
        let delays = (0..10)
            .map(|attempt| backoff_delay(attempt, 0.0))
            .collect::<Vec<_>>();
        assert_eq!(
            delays,
            vec![500, 1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 15_000, 15_000, 15_000]
        );
    }

    #[test]
    fn backoff_jitter_stays_in_the_upper_half_of_the_capped_band() {
        assert_eq!(backoff_delay(5, 0.0), 15_000);
        assert_eq!(backoff_delay(5, 0.999_999), 29_999);
        assert_eq!(backoff_delay(99, 0.999_999), 29_999);
    }

    #[test]
    fn short_lived_and_never_opened_connections_keep_the_retry_count() {
        assert_eq!(
            retry_after_close(4, 99_800, 100_000, HEALTHY_CONNECTION_MS),
            4
        );
        assert_eq!(retry_after_close(3, 0, 100_000, HEALTHY_CONNECTION_MS), 3);
    }

    #[test]
    fn healthy_connections_reset_the_retry_count() {
        assert_eq!(
            retry_after_close(4, 90_000, 100_000, HEALTHY_CONNECTION_MS),
            0
        );
        assert_eq!(
            retry_after_close(4, 40_000, 100_000, HEALTHY_CONNECTION_MS),
            0
        );
    }

    #[test]
    fn flapping_connections_reach_the_backoff_cap() {
        let mut retry = 0;
        let delays = (0..8)
            .map(|_| {
                retry = retry_after_close(retry, 1_000, 1_200, HEALTHY_CONNECTION_MS);
                let delay = backoff_delay(retry, 0.0);
                retry += 1;
                delay
            })
            .collect::<Vec<_>>();
        assert_eq!(
            delays,
            vec![500, 1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 15_000]
        );
    }

    #[test]
    fn superseded_generations_cannot_apply_work() {
        assert!(!is_current_generation(2, 1));
        assert!(is_current_generation(2, 2));
    }

    #[test]
    fn reconnect_plans_do_not_capture_a_stale_host_client() {
        let session = key("host-1", "term-1");
        assert_eq!(
            reconnect_plan(true, session.clone(), 1_000),
            Some(ReconnectPlan {
                session,
                delay_ms: 1_000,
            })
        );
        assert_eq!(reconnect_plan(false, key("host-1", "term-1"), 1_000), None);
    }

    #[test]
    fn host_qualified_session_keys_keep_same_named_sessions_distinct() {
        let studio = key("studio", "term-1");
        let laptop = key("laptop", "term-1");
        assert_eq!(studio.to_string(), "studio:term-1");
        assert_eq!(laptop.to_string(), "laptop:term-1");
        assert_ne!(studio, laptop);
        assert_eq!("laptop:term-1".parse::<SessionKey>().unwrap(), laptop);
        assert!("missing-host".parse::<SessionKey>().is_err());
    }

    #[test]
    fn resident_sessions_share_one_global_cap_across_hosts() {
        let mut cache = resident_session_cache();
        for session in [
            key("studio", "term-1"),
            key("laptop", "term-1"),
            key("studio", "term-2"),
        ] {
            assert_eq!(cache.touch(session.to_string(), || ()), None);
        }
        let evicted = cache
            .touch(key("laptop", "term-2").to_string(), || ())
            .unwrap();
        assert_eq!(evicted.id, "studio:term-1");
        assert!(cache.has("laptop:term-1"));
    }

    #[test]
    fn switching_and_close_status_follow_residency_and_active_key() {
        let studio = key("studio", "term-1");
        let laptop = key("laptop", "term-1");
        assert_eq!(
            session_switch_action(&studio, &laptop, true),
            SessionSwitchAction::Hydrate
        );
        assert_eq!(
            status_after_close(&studio, &laptop, ConnectionStatus::Connected),
            ConnectionStatus::Connected
        );
        assert_eq!(
            status_after_close(&studio, &studio, ConnectionStatus::Connected),
            ConnectionStatus::Disconnected
        );
    }

    #[test]
    fn focus_frames_reflect_mount_background_and_foreground() {
        assert_eq!(
            [focus_frame(true), focus_frame(false), focus_frame(true)],
            [
                ClientFrame::Focus { focused: true },
                ClientFrame::Focus { focused: false },
                ClientFrame::Focus { focused: true },
            ]
        );
    }

    #[test]
    fn new_output_is_applied_once_and_replayed_ids_are_dropped() {
        let store = ReplayStore::new();
        let session = key("host-1", "term-1");
        let mut notifications = NotificationCursor::default();
        let first = dispatch_server_frame(
            &store,
            &session,
            &session,
            ServerFrame::Output {
                id: 4,
                chunk: "hello".to_string(),
            },
            &mut notifications,
        );
        let duplicate = dispatch_server_frame(
            &store,
            &session,
            &session,
            ServerFrame::Output {
                id: 4,
                chunk: "again".to_string(),
            },
            &mut notifications,
        );
        assert_eq!(store.since_id(&session.to_string()), 4);
        assert_eq!(
            first,
            Some(FrameEffect::Output {
                target: TerminalTarget::ActivePage,
                chunk: "hello".to_string(),
            })
        );
        assert_eq!(duplicate, None);
    }

    #[test]
    fn background_output_targets_the_shell_emulator() {
        let store = ReplayStore::new();
        let session = key("host-1", "term-1");
        assert_eq!(
            dispatch_server_frame(
                &store,
                &session,
                &key("host-1", "term-2"),
                ServerFrame::Output {
                    id: 1,
                    chunk: "bg".to_string()
                },
                &mut NotificationCursor::default(),
            ),
            Some(FrameEffect::Output {
                target: TerminalTarget::BackgroundEmulator,
                chunk: "bg".to_string(),
            })
        );
    }

    #[test]
    fn diff_is_stubbed_as_availability_without_porting_the_git_model() {
        let session = key("host-1", "term-1");
        assert_eq!(
            dispatch_server_frame(
                &ReplayStore::new(),
                &session,
                &session,
                ServerFrame::Diff,
                &mut NotificationCursor::default(),
            ),
            Some(FrameEffect::DiffAvailable { active: true })
        );
    }

    #[test]
    fn exit_markers_target_the_active_page_or_background_emulator() {
        let session = key("host-1", "term-1");
        let active = dispatch_server_frame(
            &ReplayStore::new(),
            &session,
            &session,
            ServerFrame::Exit {
                exit_code: Some(17),
            },
            &mut NotificationCursor::default(),
        );
        let background = dispatch_server_frame(
            &ReplayStore::new(),
            &session,
            &key("host-1", "term-2"),
            ServerFrame::Exit { exit_code: Some(1) },
            &mut NotificationCursor::default(),
        );
        assert_eq!(
            active,
            Some(FrameEffect::Output {
                target: TerminalTarget::ActivePage,
                chunk: "\r\n\x1b[31m[Process exited with code 17]\x1b[0m\r\n".to_string(),
            })
        );
        assert_eq!(
            background,
            Some(FrameEffect::Output {
                target: TerminalTarget::BackgroundEmulator,
                chunk: "\r\n\x1b[31m[Process exited with code 1]\x1b[0m\r\n".to_string(),
            })
        );
    }

    #[test]
    fn title_and_activity_updates_are_scoped_to_the_originating_host() {
        let session = key("host-1", "term-1");
        let mut rows = vec![row("host-1", "term-1"), row("host-2", "term-1")];
        rows[1].auto_title = Some("other".to_string());
        rows[1].activity = Some("idle".to_string());

        let title = dispatch_server_frame(
            &ReplayStore::new(),
            &session,
            &session,
            ServerFrame::Title {
                title: "build".to_string(),
            },
            &mut NotificationCursor::default(),
        )
        .unwrap();
        assert!(apply_session_metadata(&mut rows, &title).is_empty());
        let activity = dispatch_server_frame(
            &ReplayStore::new(),
            &session,
            &session,
            ServerFrame::Activity {
                activity: "waiting".to_string(),
            },
            &mut NotificationCursor::default(),
        )
        .unwrap();
        let waiting = apply_session_metadata(&mut rows, &activity);

        assert_eq!(rows[0].auto_title.as_deref(), Some("build"));
        assert_eq!(rows[0].activity.as_deref(), Some("waiting"));
        assert_eq!(rows[1].auto_title.as_deref(), Some("other"));
        assert_eq!(rows[1].activity.as_deref(), Some("idle"));
        assert_eq!(
            waiting,
            vec![SessionRow {
                activity: Some("waiting".to_string()),
                ..row("host-1", "term-1")
            }]
        );
    }

    #[test]
    fn reset_rewinds_replay_and_notification_cursors_and_repaints_the_active_terminal() {
        let store = ReplayStore::new();
        let session = key("host-1", "term-1");
        assert!(store.accept_output(&session.to_string(), 9));
        let mut notifications = NotificationCursor {
            last_bell_count: 3,
            last_notify_count: 2,
        };
        let effect = dispatch_server_frame(
            &store,
            &session,
            &session,
            ServerFrame::Reset,
            &mut notifications,
        );
        assert_eq!(store.since_id(&session.to_string()), 0);
        assert_eq!(notifications, NotificationCursor::default());
        assert_eq!(
            effect,
            Some(FrameEffect::Reset {
                hydrate_active: true
            })
        );
    }

    #[test]
    fn suppressed_notification_edges_are_still_consumed() {
        let mut cursor = NotificationCursor::default();
        let terminal = TerminalNotificationState {
            bell_count: 0,
            notify_count: 1,
            last_notify: NotificationContent {
                title: "Done".to_string(),
                body: "Build finished".to_string(),
            },
        };
        assert_eq!(
            maybe_notification(
                &mut cursor,
                &terminal,
                &NotificationContext {
                    is_active: true,
                    window_focused: true,
                    notifications_enabled: true,
                    is_desktop: true,
                    label: "term-1"
                },
            ),
            None
        );
        assert_eq!(
            maybe_notification(
                &mut cursor,
                &terminal,
                &NotificationContext {
                    is_active: false,
                    window_focused: false,
                    notifications_enabled: true,
                    is_desktop: true,
                    label: "term-1"
                },
            ),
            None
        );
        assert_eq!(cursor.last_notify_count, 1);
    }

    #[test]
    fn notifies_once_for_each_new_notify_and_bell_edge() {
        let mut cursor = NotificationCursor::default();
        let context = NotificationContext {
            is_active: false,
            window_focused: true,
            notifications_enabled: true,
            is_desktop: true,
            label: "Build",
        };
        let mut terminal = TerminalNotificationState {
            bell_count: 0,
            notify_count: 1,
            last_notify: NotificationContent {
                title: "Done".to_string(),
                body: "Build finished".to_string(),
            },
        };
        assert_eq!(
            maybe_notification(&mut cursor, &terminal, &context),
            Some(DesktopNotification {
                title: "Done".to_string(),
                body: "Build finished".to_string()
            })
        );
        assert_eq!(maybe_notification(&mut cursor, &terminal, &context), None);
        terminal.bell_count = 1;
        assert_eq!(
            maybe_notification(&mut cursor, &terminal, &context),
            Some(DesktopNotification {
                title: "Build".to_string(),
                body: "Terminal bell".to_string()
            })
        );
        assert_eq!(maybe_notification(&mut cursor, &terminal, &context), None);
    }
}
