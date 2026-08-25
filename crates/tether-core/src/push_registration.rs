use std::collections::BTreeMap;

use futures_util::future::BoxFuture;
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PushResponse {
    pub ok: bool,
    pub status: u16,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PushRequest {
    pub body: String,
    pub headers: BTreeMap<String, String>,
}

pub trait PushRegistrationTarget: Send + Sync {
    fn host_id(&self) -> &str;
    fn post<'a>(
        &'a self,
        path: &'a str,
        request: PushRequest,
    ) -> BoxFuture<'a, Result<PushResponse, String>>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegistrationState {
    pub device_token: String,
    pub secret_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushRegistrationPayload {
    pub device_token: String,
    pub secret_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PushRegistrationResult {
    pub host_id: String,
    pub ok: bool,
    pub status: Option<u16>,
    pub error: Option<String>,
}

/// Normalizes the two APNs token representations to strict lowercase hex.
pub fn normalize_device_token(raw: &str) -> Option<String> {
    let token = raw
        .chars()
        .filter(char::is_ascii_hexdigit)
        .collect::<String>()
        .to_ascii_lowercase();
    (token.len() == 64).then_some(token)
}

pub fn needs_registration(previous: Option<&RegistrationState>, next: &RegistrationState) -> bool {
    previous != Some(next)
}

pub async fn unregister_from_host(target: &dyn PushRegistrationTarget, device_token: &str) -> bool {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Payload<'a> {
        device_token: &'a str,
    }

    target
        .post(
            "/api/push/unregister",
            json_request(&Payload { device_token }),
        )
        .await
        .map(|response| response.ok)
        .unwrap_or(false)
}

pub async fn register_with_hosts(
    targets: &[&dyn PushRegistrationTarget],
    payload: &PushRegistrationPayload,
) -> Vec<PushRegistrationResult> {
    let body = serde_json::to_string(payload).expect("push registration payload is serializable");
    futures_util::future::join_all(targets.iter().map(|target| {
        let host_id = target.host_id().to_string();
        let request = request_with_body(body.clone());
        async move {
            match target.post("/api/push/register", request).await {
                Ok(response) => PushRegistrationResult {
                    host_id,
                    ok: response.ok,
                    status: Some(response.status),
                    error: None,
                },
                Err(error) => PushRegistrationResult {
                    host_id,
                    ok: false,
                    status: None,
                    error: Some(error),
                },
            }
        }
    }))
    .await
}

fn json_request(payload: &impl Serialize) -> PushRequest {
    request_with_body(serde_json::to_string(payload).expect("push payload is serializable"))
}

fn request_with_body(body: String) -> PushRequest {
    PushRequest {
        body,
        headers: BTreeMap::from([("Content-Type".to_string(), "application/json".to_string())]),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;

    const HEX: &str = "a1b2a1b2a1b2a1b2a1b2a1b2a1b2a1b2a1b2a1b2a1b2a1b2a1b2a1b2a1b2a1b2";

    enum Behavior {
        Response(PushResponse),
        Error(String),
        Record(Arc<Mutex<Vec<String>>>),
    }

    struct Target {
        host_id: String,
        behavior: Behavior,
    }

    impl Target {
        fn response(host_id: &str, ok: bool, status: u16) -> Self {
            Self {
                host_id: host_id.to_string(),
                behavior: Behavior::Response(PushResponse { ok, status }),
            }
        }

        fn error(host_id: &str, error: &str) -> Self {
            Self {
                host_id: host_id.to_string(),
                behavior: Behavior::Error(error.to_string()),
            }
        }
    }

    impl PushRegistrationTarget for Target {
        fn host_id(&self) -> &str {
            &self.host_id
        }

        fn post<'a>(
            &'a self,
            path: &'a str,
            request: PushRequest,
        ) -> BoxFuture<'a, Result<PushResponse, String>> {
            Box::pin(async move {
                match &self.behavior {
                    Behavior::Response(response) => Ok(response.clone()),
                    Behavior::Error(error) => Err(error.clone()),
                    Behavior::Record(seen) => {
                        seen.lock()
                            .unwrap()
                            .push(format!("{}:{path}:{}", self.host_id, request.body));
                        Ok(PushResponse {
                            ok: true,
                            status: 200,
                        })
                    }
                }
            })
        }
    }

    fn payload() -> PushRegistrationPayload {
        PushRegistrationPayload {
            device_token: HEX.to_string(),
            secret_key: "k".to_string(),
            label: None,
        }
    }

    #[test]
    fn normalizes_bare_uppercase_and_bracketed_apns_tokens() {
        assert_eq!(normalize_device_token(HEX).as_deref(), Some(HEX));
        assert_eq!(
            normalize_device_token(&HEX.to_uppercase()).as_deref(),
            Some(HEX)
        );
        let spaced = format!("<{} {}>", &HEX[..32], &HEX[32..]);
        assert_eq!(normalize_device_token(&spaced).as_deref(), Some(HEX));
    }

    #[test]
    fn rejects_invalid_device_tokens() {
        for (label, raw) in [
            ("too short", "a1b2"),
            ("empty", ""),
            ("Expo token", "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]"),
        ] {
            assert_eq!(normalize_device_token(raw), None, "{label}");
        }
    }

    #[test]
    fn registers_when_nothing_was_stored() {
        let current = RegistrationState {
            device_token: HEX.to_string(),
            secret_key: "key".to_string(),
        };
        assert!(needs_registration(None, &current));
    }

    #[test]
    fn skips_when_nothing_changed() {
        let current = RegistrationState {
            device_token: HEX.to_string(),
            secret_key: "key".to_string(),
        };
        assert!(!needs_registration(Some(&current), &current));
    }

    #[test]
    fn registers_when_apns_rotates_the_token() {
        let previous = RegistrationState {
            device_token: "b".repeat(64),
            secret_key: "key".to_string(),
        };
        let current = RegistrationState {
            device_token: HEX.to_string(),
            secret_key: "key".to_string(),
        };
        assert!(needs_registration(Some(&previous), &current));
    }

    #[test]
    fn registers_when_the_secret_key_changes() {
        let previous = RegistrationState {
            device_token: HEX.to_string(),
            secret_key: "old".to_string(),
        };
        let current = RegistrationState {
            device_token: HEX.to_string(),
            secret_key: "key".to_string(),
        };
        assert!(needs_registration(Some(&previous), &current));
    }

    #[tokio::test]
    async fn posts_the_payload_to_every_host() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let first = Target {
            host_id: "a".to_string(),
            behavior: Behavior::Record(Arc::clone(&seen)),
        };
        let second = Target::response("b", true, 200);

        let results = register_with_hosts(&[&first, &second], &payload()).await;

        assert!(results.iter().all(|result| result.ok));
        assert_eq!(
            seen.lock().unwrap()[0],
            format!("a:/api/push/register:{{\"deviceToken\":\"{HEX}\",\"secretKey\":\"k\"}}")
        );
    }

    #[tokio::test]
    async fn one_unreachable_host_does_not_prevent_other_registrations() {
        let down = Target::error("down", "Network request failed");
        let up = Target::response("up", true, 200);

        assert_eq!(
            register_with_hosts(&[&down, &up], &payload()).await,
            vec![
                PushRegistrationResult {
                    host_id: "down".to_string(),
                    ok: false,
                    status: None,
                    error: Some("Network request failed".to_string()),
                },
                PushRegistrationResult {
                    host_id: "up".to_string(),
                    ok: true,
                    status: Some(200),
                    error: None,
                },
            ]
        );
    }

    #[tokio::test]
    async fn reports_a_rejecting_host_without_throwing() {
        let old = Target::response("old", false, 404);

        assert_eq!(
            register_with_hosts(&[&old], &payload()).await[0],
            PushRegistrationResult {
                host_id: "old".to_string(),
                ok: false,
                status: Some(404),
                error: None,
            }
        );
    }

    #[tokio::test]
    async fn unregisters_with_the_device_token_before_local_removal() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let target = Target {
            host_id: "a".to_string(),
            behavior: Behavior::Record(Arc::clone(&seen)),
        };

        assert!(unregister_from_host(&target, HEX).await);
        assert_eq!(
            seen.lock().unwrap()[0],
            format!("a:/api/push/unregister:{{\"deviceToken\":\"{HEX}\"}}")
        );
    }

    #[tokio::test]
    async fn unreachable_host_does_not_block_local_removal() {
        let target = Target::error("down", "offline");
        assert!(!unregister_from_host(&target, HEX).await);
    }
}
