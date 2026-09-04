//! Server settings and the admin actions. The destructive admin routes
//! (`update`, `restart`) are exercised only for their refusal path — running
//! them for real would replace or stop the binary under test.

mod support;

use std::collections::BTreeMap;

use serde_json::json;
use support::Server;
use tether_core::server_config::{
    self, IdentityConfigPartial, ServerConfigPatch, SessionConfigPartial, TriggersConfigPartial,
};

#[tokio::test]
async fn reads_the_config_including_its_read_only_fields() {
    let server = Server::start().await;
    let client = server.client();
    let (status, body) = server
        .exec(&server_config::get_config_request(&client))
        .await;
    let config = server_config::parse_config_response(status, &body)
        .unwrap_or_else(|e| panic!("config did not parse: {e} / {body}"));

    assert!(
        !config.session.default_shell.is_empty(),
        "a default shell should always be reported"
    );
    assert!(
        !config.session.default_cwd.is_empty(),
        "a default cwd should always be reported"
    );
    // GET reports these; PATCH must not accept them.
    assert_eq!(config.push_devices, 0, "a fresh server has no push devices");
    assert!(
        body.get("tls").is_some(),
        "the TLS report is missing from {body}"
    );
}

#[tokio::test]
async fn patches_settings_and_persists_them() {
    let server = Server::start().await;
    let client = server.client();

    let patch = ServerConfigPatch {
        triggers: Some(TriggersConfigPartial {
            waiting: Some(false),
            ..Default::default()
        }),
        identity: Some(IdentityConfigPartial {
            name: Some("e2e-host".to_string()),
            ..Default::default()
        }),
        session: Some(SessionConfigPartial {
            scrollback_rows: Some(4321),
            ..Default::default()
        }),
        long_job_seconds: Some(99),
        ..Default::default()
    };
    let (status, body) = server
        .exec(&server_config::patch_config_request(&client, &patch))
        .await;
    assert_eq!(status, 200, "patch failed: {body}");

    let (status, body) = server
        .exec(&server_config::get_config_request(&client))
        .await;
    let config = server_config::parse_config_response(status, &body).expect("config parses");
    assert!(
        !config.triggers.waiting,
        "the waiting trigger did not persist"
    );
    assert_eq!(config.identity.name, "e2e-host");
    assert_eq!(config.session.scrollback_rows, 4321);
    assert_eq!(config.long_job_seconds, 99);
}

/// The config is zod-typed on the server. A patch that violates the schema must
/// be refused whole, not partially applied.
#[tokio::test]
async fn refuses_an_invalid_patch_without_applying_any_of_it() {
    let server = Server::start().await;
    let client = server.client();
    let (_, before) = server
        .exec(&server_config::get_config_request(&client))
        .await;

    let (status, body) = server
        .exec(
            &client.patch(
                "/api/config",
                BTreeMap::from([("Content-Type".to_string(), "application/json".to_string())]),
                // An empty defaultCwd violates `min(1)`; the identity change rides along.
                Some(
                    json!({ "identity": { "name": "should-not-stick" },
                        "session": { "defaultCwd": "" } })
                    .to_string(),
                ),
            ),
        )
        .await;
    assert!(
        status >= 400,
        "an invalid patch was accepted: {status} {body}"
    );

    let (_, after) = server
        .exec(&server_config::get_config_request(&client))
        .await;
    assert_eq!(
        before["identity"], after["identity"],
        "a rejected patch still changed the identity"
    );
}

// The password-change and password-gated admin-refusal e2e tests were removed
// with the password itself: auth is now a per-device bearer token (see
// `support::Server::mint_token`), there is no `/api/admin/password`, and
// `update`/`restart` no longer take a body password. Bearer verification and
// revocation are covered by the server's own unit suite.

/// Test notification with no registered device must fail in a way the Settings
/// screen can show: a coded error with a sentence for the user, not a bare 500.
#[tokio::test]
async fn test_notification_explains_itself_with_no_devices_registered() {
    let server = Server::start().await;
    let client = server.client();
    let (status, body) = server
        .exec(&server_config::test_notification_request(&client))
        .await;
    assert_eq!(status, 502, "unexpected status: {body}");
    assert_eq!(body["code"], "notification_delivery_failed");
    assert!(
        body["error"]
            .as_str()
            .is_some_and(|e| e.contains("registered")),
        "the error gives the user nothing to act on: {body}"
    );
}

#[tokio::test]
async fn reports_its_version() {
    let server = Server::start().await;
    let client = server.client();
    let (status, body) = server
        .exec(&server_config::health_version_request(&client))
        .await;
    let version = server_config::parse_health_version(status, &body)
        .unwrap_or_else(|e| panic!("version did not parse: {e} / {body}"));
    assert!(
        version.is_some_and(|v| !v.is_empty()),
        "the server reported no version: {body}"
    );
}
