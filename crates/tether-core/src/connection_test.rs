//! Connection test — request planning and response reduction.
//!
//! The shell performs HTTP; this module never networks.

use std::collections::BTreeMap;

use crate::host_client::{HostClient, HttpRequest};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnectionTestFailure {
    Unavailable,
    WrongPassword,
    ServerError { status: u16 },
    Unreachable,
}

impl ConnectionTestFailure {
    pub fn message(&self) -> String {
        match self {
            Self::Unavailable => "Server is unavailable.".to_string(),
            Self::WrongPassword => "Wrong password.".to_string(),
            Self::ServerError { status } => format!("Server error ({status})."),
            Self::Unreachable => "Unreachable — check the host and port.".to_string(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionTestNext {
    Health,
}

pub fn status_request(client: &HostClient) -> HttpRequest {
    client.get("/api/status", BTreeMap::new())
}

pub fn health_request(client: &HostClient) -> HttpRequest {
    client.get("/api/health", BTreeMap::new())
}

/// Reduce `/api/status`. On success the next step is a health probe.
pub fn reduce_status(status: u16) -> Result<ConnectionTestNext, ConnectionTestFailure> {
    if !(200..300).contains(&status) {
        return Err(ConnectionTestFailure::Unavailable);
    }
    Ok(ConnectionTestNext::Health)
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
    fn status_routes_to_health() {
        assert_eq!(reduce_status(200), Ok(ConnectionTestNext::Health));
        assert_eq!(reduce_status(503), Err(ConnectionTestFailure::Unavailable));
    }

    #[test]
    fn health_reductions_match_shipping_errors() {
        assert_eq!(
            reduce_health(401),
            Err(ConnectionTestFailure::WrongPassword)
        );
        assert_eq!(reduce_health(200), Ok(()));
        assert_eq!(
            status_request(&client()).url,
            "http://127.0.0.1:8085/api/status"
        );
        assert_eq!(
            health_request(&client()).url,
            "http://127.0.0.1:8085/api/health"
        );
    }
}
