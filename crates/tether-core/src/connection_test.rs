//! TOFU / password connection test — request planning and response reduction.
//!
//! The shell performs HTTP; this module never networks.

use std::collections::BTreeMap;

use serde_json::Value;

use crate::host_client::{HostClient, HttpRequest};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnectionTestFailure {
    Unavailable,
    EmptyPassword { needs_setup: bool },
    PasswordMismatch,
    AlreadySetUp,
    SetupFailed,
    WrongPassword,
    ServerError { status: u16 },
    Unreachable,
}

impl ConnectionTestFailure {
    pub fn message(&self) -> String {
        match self {
            Self::Unavailable => "Server is unavailable.".to_string(),
            Self::EmptyPassword { needs_setup: true } => {
                "Choose a password for this server.".to_string()
            }
            Self::EmptyPassword { needs_setup: false } => "Enter the server password.".to_string(),
            Self::PasswordMismatch => "Passwords do not match.".to_string(),
            Self::AlreadySetUp => "Already set up. Enter the existing password.".to_string(),
            Self::SetupFailed => "Setup failed — try again.".to_string(),
            Self::WrongPassword => "Wrong password.".to_string(),
            Self::ServerError { status } => format!("Server error ({status})."),
            Self::Unreachable => "Unreachable — check the host and port.".to_string(),
        }
    }

    pub fn needs_setup(&self) -> bool {
        matches!(self, Self::EmptyPassword { needs_setup: true })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionTestNext {
    Setup,
    Health,
}

pub fn status_request(client: &HostClient) -> HttpRequest {
    client.get("/api/status", BTreeMap::new())
}

pub fn setup_request(client: &HostClient, password: &str) -> HttpRequest {
    client.post(
        "/api/setup",
        BTreeMap::from([("Content-Type".to_string(), "application/json".to_string())]),
        Some(serde_json::json!({ "password": password }).to_string()),
    )
}

pub fn health_request(client: &HostClient) -> HttpRequest {
    client.get("/api/health", BTreeMap::new())
}

/// Reduce `/api/status`. On success returns the next step to execute.
pub fn reduce_status(
    status: u16,
    body: &Value,
    password: &str,
    confirm_password: &str,
) -> Result<ConnectionTestNext, ConnectionTestFailure> {
    if !(200..300).contains(&status) {
        return Err(ConnectionTestFailure::Unavailable);
    }
    let needs_setup = body
        .get("needsSetup")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if password.is_empty() {
        return Err(ConnectionTestFailure::EmptyPassword { needs_setup });
    }
    if needs_setup {
        if password != confirm_password {
            return Err(ConnectionTestFailure::PasswordMismatch);
        }
        Ok(ConnectionTestNext::Setup)
    } else {
        Ok(ConnectionTestNext::Health)
    }
}

pub fn reduce_setup(status: u16) -> Result<(), ConnectionTestFailure> {
    if status == 409 {
        return Err(ConnectionTestFailure::AlreadySetUp);
    }
    if !(200..300).contains(&status) {
        return Err(ConnectionTestFailure::SetupFailed);
    }
    Ok(())
}

pub fn reduce_health(status: u16) -> Result<(), ConnectionTestFailure> {
    if status == 401 {
        return Err(ConnectionTestFailure::WrongPassword);
    }
    if !(200..300).contains(&status) {
        return Err(ConnectionTestFailure::ServerError { status });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host_store::HostProfile;

    fn client() -> HostClient {
        HostClient::new(
            HostProfile {
                id: "h".into(),
                name: "h".into(),
                color: "#89b4fa".into(),
                host: "127.0.0.1".into(),
                port: "8085".into(),
                identity_name: String::new(),
                order: 0,
            },
            "secret",
        )
    }

    #[test]
    fn status_routes_to_setup_or_health() {
        let body = serde_json::json!({ "needsSetup": true });
        assert_eq!(
            reduce_status(200, &body, "pw", "pw"),
            Ok(ConnectionTestNext::Setup)
        );
        let body = serde_json::json!({ "needsSetup": false });
        assert_eq!(
            reduce_status(200, &body, "pw", ""),
            Ok(ConnectionTestNext::Health)
        );
    }

    #[test]
    fn empty_password_and_mismatch_fail() {
        let body = serde_json::json!({ "needsSetup": true });
        assert!(matches!(
            reduce_status(200, &body, "", ""),
            Err(ConnectionTestFailure::EmptyPassword { needs_setup: true })
        ));
        assert_eq!(
            reduce_status(200, &body, "a", "b"),
            Err(ConnectionTestFailure::PasswordMismatch)
        );
    }

    #[test]
    fn setup_and_health_reductions_match_shipping_errors() {
        assert_eq!(reduce_setup(409), Err(ConnectionTestFailure::AlreadySetUp));
        assert_eq!(reduce_setup(200), Ok(()));
        assert_eq!(
            reduce_health(401),
            Err(ConnectionTestFailure::WrongPassword)
        );
        assert_eq!(reduce_health(200), Ok(()));
        assert_eq!(
            status_request(&client()).url,
            "http://127.0.0.1:8085/api/status"
        );
    }
}
