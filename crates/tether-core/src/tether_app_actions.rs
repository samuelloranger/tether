use std::collections::BTreeMap;

use crate::host_client::{HostClient, HostIdentity, HttpRequest};
use crate::host_store::HostProfile;
use crate::terminal_session_logic::{InvalidSessionKey, SessionKey, SessionRow};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnippetUpdate {
    pub snippets: Vec<String>,
    pub draft: String,
}

pub fn add_snippet(draft: &str, snippets: &[String]) -> Option<SnippetUpdate> {
    let snippet = draft.trim();
    if snippet.is_empty() {
        return None;
    }
    let mut next = snippets.to_vec();
    next.push(snippet.to_string());
    Some(SnippetUpdate {
        snippets: next,
        draft: String::new(),
    })
}

pub fn remove_snippet(snippets: &[String], index: usize) -> Vec<String> {
    snippets
        .iter()
        .enumerate()
        .filter(|(item_index, _)| *item_index != index)
        .map(|(_, snippet)| snippet.clone())
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SendSnippetPlan {
    pub close_modal: bool,
    pub text: String,
}

pub fn send_snippet(snippet: &str) -> SendSnippetPlan {
    SendSnippetPlan {
        close_modal: true,
        text: snippet.to_string(),
    }
}

/// Ordered shell effects from app actions. Keeping them as data preserves the
/// TypeScript call order without pulling dialogs, storage, or async callbacks
/// into the core.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TetherEffect {
    ResetForEndpointChange,
    ResetHostHealth(String),
    UnregisterPush(String),
    RemoveHostSessions(String),
    RemoveConfiguredHost(String),
    CloseDiff,
    CloseFile,
    ActivateHost(String),
    SwitchTerminal(SessionKey),
    SetActivePresentation(Option<String>),
    CreateTerminal,
}

pub fn save_app_config_effects(
    address_changed: bool,
    was_ready: bool,
    configured_active_host_id: Option<&str>,
) -> Vec<TetherEffect> {
    let mut effects = Vec::new();
    if address_changed && was_ready {
        effects.push(TetherEffect::ResetForEndpointChange);
    }
    if let Some(host_id) = configured_active_host_id {
        effects.push(TetherEffect::ResetHostHealth(host_id.to_string()));
    }
    effects
}

pub fn remove_host_effects(host_id: &str) -> Vec<TetherEffect> {
    vec![
        TetherEffect::UnregisterPush(host_id.to_string()),
        TetherEffect::RemoveHostSessions(host_id.to_string()),
        TetherEffect::RemoveConfiguredHost(host_id.to_string()),
    ]
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SaveHostConnectionPlan {
    pub host_id: String,
    pub host: String,
    pub port: String,
    pub reset_sessions_and_health: bool,
}

pub fn save_host_connection_plan(
    profiles: &[HostProfile],
    host_id: &str,
    host: &str,
    port: &str,
) -> Option<SaveHostConnectionPlan> {
    let current = profiles.iter().find(|profile| profile.id == host_id)?;
    Some(SaveHostConnectionPlan {
        host_id: host_id.to_string(),
        host: host.to_string(),
        port: port.to_string(),
        reset_sessions_and_health: current.host != host || current.port != port,
    })
}

pub fn switch_to(host_id: &str, session_id: &str) -> Result<Vec<TetherEffect>, InvalidSessionKey> {
    Ok(vec![
        TetherEffect::CloseDiff,
        TetherEffect::ActivateHost(host_id.to_string()),
        TetherEffect::SwitchTerminal(SessionKey::new(host_id, session_id)?),
    ])
}

pub fn new_terminal() -> Vec<TetherEffect> {
    vec![
        TetherEffect::SetActivePresentation(None),
        TetherEffect::CreateTerminal,
    ]
}

pub fn select_terminal(
    host_id: &str,
    session_id: &str,
) -> Result<Vec<TetherEffect>, InvalidSessionKey> {
    let mut effects = vec![TetherEffect::SetActivePresentation(None)];
    effects.extend(switch_to(host_id, session_id)?);
    Ok(effects)
}

pub fn select_presentation(id: &str) -> Vec<TetherEffect> {
    vec![
        TetherEffect::CloseFile,
        TetherEffect::CloseDiff,
        TetherEffect::SetActivePresentation(Some(id.to_string())),
    ]
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenRenamePlan {
    pub text: String,
    pub close_menu: bool,
    pub open_modal: bool,
}

/// Prefills rename by host-qualified identity. This intentionally corrects the
/// TypeScript source's bare-id lookup, which can select another host's name
/// because every host begins with the same `term-N` ids.
pub fn open_rename(rows: &[SessionRow], active_session: &SessionKey) -> OpenRenamePlan {
    let text = rows
        .iter()
        .find(|row| {
            row.host_id == active_session.host_id() && row.id == active_session.session_id()
        })
        .and_then(|row| row.name.clone())
        .unwrap_or_default();
    OpenRenamePlan {
        text,
        close_menu: true,
        open_modal: true,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FailureNotice {
    pub title: String,
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenamePlan {
    pub close_modal: bool,
    pub request: HttpRequest,
    pub refresh_after_success: bool,
    pub failure: FailureNotice,
}

/// Builds the rename request from a host-qualified key. TypeScript reads
/// `deps.activeId` (bare) and relies on `activeClient` for host scope; the core
/// requires `SessionKey` so rename cannot target another host's colliding id.
pub fn submit_rename(client: &HostClient, session: &SessionKey, rename_text: &str) -> RenamePlan {
    RenamePlan {
        close_modal: true,
        request: client.post(
            "/api/sessions/rename",
            BTreeMap::from([("content-type".to_string(), "application/json".to_string())]),
            Some(
                serde_json::json!({ "id": session.session_id(), "name": rename_text.trim() })
                    .to_string(),
            ),
        ),
        refresh_after_success: true,
        failure: FailureNotice {
            title: "Rename failed".to_string(),
            body: String::new(),
        },
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HardResetPlan {
    pub reset_terminal_before_request: bool,
    pub request: HttpRequest,
    pub restart_after_success: bool,
    pub failure: FailureNotice,
}

/// Hard-reset payload uses the session id half of the key; host routing stays
/// on `client`, matching TypeScript's `deps.activeId` + `activeClient` split.
pub fn hard_reset_session(
    client: &HostClient,
    session: &SessionKey,
    confirmed: bool,
) -> Option<HardResetPlan> {
    confirmed.then(|| HardResetPlan {
        reset_terminal_before_request: true,
        request: client.post(
            "/api/sessions/kill",
            BTreeMap::from([("Content-Type".to_string(), "application/json".to_string())]),
            Some(serde_json::json!({ "id": session.session_id() }).to_string()),
        ),
        restart_after_success: true,
        failure: FailureNotice {
            title: "Error".to_string(),
            body: "Failed to kill session on the server".to_string(),
        },
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdentityUpdate {
    pub host_id: String,
    pub identity: HostIdentity,
}

pub fn save_server_identity(
    server_settings_host_id: Option<&str>,
    identity: HostIdentity,
) -> Option<IdentityUpdate> {
    server_settings_host_id.map(|host_id| IdentityUpdate {
        host_id: host_id.to_string(),
        identity,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TitleBarStatus {
    Connected,
    Connecting,
    AuthFailed,
    Offline,
}

pub fn title_bar_status(connection_status: &str) -> TitleBarStatus {
    match connection_status {
        "connected" => TitleBarStatus::Connected,
        "connecting" => TitleBarStatus::Connecting,
        "auth-failed" => TitleBarStatus::AuthFailed,
        _ => TitleBarStatus::Offline,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile() -> HostProfile {
        HostProfile {
            id: "host-1".to_string(),
            name: "Studio".to_string(),
            color: "#89b4fa".to_string(),
            host: "studio.local".to_string(),
            port: "8085".to_string(),
            identity_name: "studio".to_string(),
            order: 0,
        }
    }

    fn client() -> HostClient {
        HostClient::new(profile(), "secret")
    }

    fn row(id: &str, name: Option<&str>) -> SessionRow {
        SessionRow {
            host_id: "host-1".to_string(),
            id: id.to_string(),
            status: "running".to_string(),
            last_output_at: None,
            name: name.map(str::to_string),
            auto_title: None,
            activity: None,
        }
    }

    #[test]
    fn snippet_actions_trim_add_remove_and_send() {
        assert_eq!(
            add_snippet("  cargo test  ", &["ls".to_string()]),
            Some(SnippetUpdate {
                snippets: vec!["ls".to_string(), "cargo test".to_string()],
                draft: String::new()
            })
        );
        assert_eq!(add_snippet("   ", &[]), None);
        assert_eq!(
            remove_snippet(&["a".to_string(), "b".to_string()], 0),
            vec!["b"]
        );
        assert_eq!(
            send_snippet("pwd"),
            SendSnippetPlan {
                close_modal: true,
                text: "pwd".to_string()
            }
        );
    }

    #[test]
    fn saving_app_config_resets_only_the_affected_state() {
        assert_eq!(
            save_app_config_effects(true, true, Some("host-1")),
            vec![
                TetherEffect::ResetForEndpointChange,
                TetherEffect::ResetHostHealth("host-1".to_string()),
            ]
        );
        assert_eq!(
            save_app_config_effects(true, false, None),
            Vec::<TetherEffect>::new()
        );
    }

    #[test]
    fn removing_a_host_preserves_the_async_operation_order() {
        assert_eq!(
            remove_host_effects("host-1"),
            vec![
                TetherEffect::UnregisterPush("host-1".to_string()),
                TetherEffect::RemoveHostSessions("host-1".to_string()),
                TetherEffect::RemoveConfiguredHost("host-1".to_string()),
            ]
        );
    }

    #[test]
    fn host_connection_changes_reset_sessions_only_for_endpoint_changes() {
        assert_eq!(
            save_host_connection_plan(&[profile()], "host-1", "other.local", "8085"),
            Some(SaveHostConnectionPlan {
                host_id: "host-1".to_string(),
                host: "other.local".to_string(),
                port: "8085".to_string(),
                reset_sessions_and_health: true,
            })
        );
        assert!(
            !save_host_connection_plan(&[profile()], "host-1", "studio.local", "8085")
                .unwrap()
                .reset_sessions_and_health
        );
        assert_eq!(
            save_host_connection_plan(&[profile()], "missing", "x", "1"),
            None
        );
    }

    #[test]
    fn navigation_actions_close_conflicting_surfaces_in_order() {
        assert_eq!(
            switch_to("host-1", "term-2").unwrap(),
            vec![
                TetherEffect::CloseDiff,
                TetherEffect::ActivateHost("host-1".to_string()),
                TetherEffect::SwitchTerminal("host-1:term-2".parse().unwrap()),
            ]
        );
        assert_eq!(
            new_terminal(),
            vec![
                TetherEffect::SetActivePresentation(None),
                TetherEffect::CreateTerminal
            ]
        );
        assert_eq!(
            select_terminal("host-1", "term-2").unwrap()[0],
            TetherEffect::SetActivePresentation(None)
        );
        assert_eq!(
            select_presentation("slides"),
            vec![
                TetherEffect::CloseFile,
                TetherEffect::CloseDiff,
                TetherEffect::SetActivePresentation(Some("slides".to_string())),
            ]
        );
    }

    #[test]
    fn open_rename_uses_the_active_sessions_name_or_an_empty_string() {
        assert_eq!(
            open_rename(
                &[row("term-1", Some("Build"))],
                &"host-1:term-1".parse().unwrap(),
            ),
            OpenRenamePlan {
                text: "Build".to_string(),
                close_menu: true,
                open_modal: true
            }
        );
        assert_eq!(open_rename(&[], &"host-1:term-1".parse().unwrap()).text, "");
    }

    #[test]
    fn rename_prefill_selects_the_active_host_when_session_ids_collide() {
        let rows = [
            SessionRow {
                host_id: "host-2".to_string(),
                ..row("term-1", Some("Wrong host"))
            },
            row("term-1", Some("Right host")),
        ];

        assert_eq!(
            open_rename(&rows, &"host-1:term-1".parse().unwrap()).text,
            "Right host"
        );
    }

    #[test]
    fn rename_and_hard_reset_build_the_shipping_request_payloads() {
        let session = "host-1:term-1".parse::<SessionKey>().unwrap();
        let rename = submit_rename(&client(), &session, "  Build  ");
        assert!(rename.close_modal);
        assert_eq!(
            rename.request.body.as_deref(),
            Some(r#"{"id":"term-1","name":"Build"}"#)
        );
        assert_eq!(rename.failure.title, "Rename failed");

        assert_eq!(hard_reset_session(&client(), &session, false), None);
        let reset = hard_reset_session(&client(), &session, true).unwrap();
        assert!(reset.reset_terminal_before_request);
        assert!(reset.restart_after_success);
        assert_eq!(reset.request.body.as_deref(), Some(r#"{"id":"term-1"}"#));
        assert_eq!(reset.failure.body, "Failed to kill session on the server");
    }

    #[test]
    fn server_identity_and_title_bar_status_are_reduced_without_callbacks() {
        let identity = HostIdentity {
            name: "Studio".to_string(),
            color: "#cba6f7".to_string(),
        };
        assert_eq!(
            save_server_identity(Some("host-1"), identity.clone()),
            Some(IdentityUpdate {
                host_id: "host-1".to_string(),
                identity
            })
        );
        assert_eq!(
            save_server_identity(
                None,
                HostIdentity {
                    name: String::new(),
                    color: String::new()
                }
            ),
            None
        );
        assert_eq!(title_bar_status("connected"), TitleBarStatus::Connected);
        assert_eq!(title_bar_status("connecting"), TitleBarStatus::Connecting);
        assert_eq!(title_bar_status("auth-failed"), TitleBarStatus::AuthFailed);
        assert_eq!(title_bar_status("disconnected"), TitleBarStatus::Offline);
        assert_eq!(title_bar_status("future-status"), TitleBarStatus::Offline);
    }
}
