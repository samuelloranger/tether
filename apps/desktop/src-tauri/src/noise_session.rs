//! Client session-protocol codec for the desktop Noise terminal.
//!
//! The desktop terminal frontend speaks the server's WS-JSON directly
//! (`{"type":"input",…}` / `{"type":"output",…}`). A Noise session speaks a
//! different, sealed shape (`{"t":"input",…}` / `{"t":"output",…}`). This module
//! is the pure translation layer between the two — no I/O, no crypto — so it can
//! be unit-tested on its own. The pump in `commands/noise.rs` wires it to the
//! Noise `seal`/`open` and the Tauri event bus.
//!
//! Directions:
//! - Outbound (frontend → Noise): [`translate_frontend`] parses one WS-JSON line
//!   and produces the plaintext bytes to `seal` onto the channel, or `None` when
//!   the message is dropped (`focus`, or anything unrecognized).
//! - Inbound (Noise → frontend): [`decode_server`] parses one opened plaintext
//!   frame into a [`ServerMsg`]; [`encode_frontend_output`] renders the WS-JSON
//!   `output` line the frontend consumes, stamping the synthesized numeric id.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// One paired device, as the server reports it in a `devices` reply. The serde
/// field renames match the wire EXACTLY (`pairedAt`/`lastSeenAt`/`lastAddress`/
/// `isSelf` are camelCase), so this both decodes the reply AND re-serializes to
/// the same camelCase JSON the React side reads back over the Tauri boundary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub id: String,
    pub label: String,
    pub fingerprint: String,
    pub paired_at: String,
    pub last_seen_at: Option<String>,
    pub last_address: Option<String>,
    pub is_self: bool,
}

/// A server → client application message, after Noise `open` + JSON parse.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServerMsg {
    /// Terminal output to render. `chunk` is the raw PTY text.
    Output { chunk: String },
    /// The session ended. `exit_code` mirrors the server's `exitCode`.
    Exit { exit_code: i64 },
    /// The device roster, in reply to `devices.list`.
    Devices(Vec<DeviceInfo>),
    /// The verdict of a `devices.revoke`, matched to its `target`.
    DevicesRevoked {
        target: String,
        ok: bool,
        error: Option<String>,
    },
    /// A minted per-device REST bearer, in reply to `auth.token`.
    AuthToken { token: String, expires_at: String },
    /// Any other sealed frame — the terminal pump ignores it.
    Other,
}

/// Serialized shape of a client → server `start`.
#[derive(Serialize)]
struct StartMsg<'a> {
    t: &'a str,
    id: &'a str,
    cols: u16,
    rows: u16,
}

/// Serialized shape of a client → server `input`.
#[derive(Serialize)]
struct InputMsg<'a> {
    t: &'a str,
    id: &'a str,
    text: &'a str,
}

/// Serialized shape of a client → server `resize`.
#[derive(Serialize)]
struct ResizeMsg<'a> {
    t: &'a str,
    id: &'a str,
    cols: u16,
    rows: u16,
}

/// Serialized shape of the WS-JSON `output` line the frontend consumes.
#[derive(Serialize)]
struct FrontendOutput<'a> {
    #[serde(rename = "type")]
    ty: &'a str,
    id: u64,
    chunk: &'a str,
}

/// Encode the session-opening `{"t":"start",…}` plaintext to seal on connect.
pub fn encode_start(session_id: &str, cols: u16, rows: u16) -> Vec<u8> {
    serde_json::to_vec(&StartMsg {
        t: "start",
        id: session_id,
        cols,
        rows,
    })
    .expect("start serializes")
}

/// Encode an `{"t":"input",…}` plaintext.
pub fn encode_input(session_id: &str, text: &str) -> Vec<u8> {
    serde_json::to_vec(&InputMsg {
        t: "input",
        id: session_id,
        text,
    })
    .expect("input serializes")
}

/// Encode a `{"t":"devices.list"}` plaintext — request the paired-device roster.
pub fn encode_devices_list() -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({ "t": "devices.list" }))
        .expect("devices.list serializes")
}

/// Encode a `{"t":"devices.revoke","target":…}` plaintext. `target` should be
/// the exact device `id` from a prior `devices` reply (the server also resolves
/// a label or fingerprint-prefix, but the id is unambiguous).
pub fn encode_devices_revoke(target: &str) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({ "t": "devices.revoke", "target": target }))
        .expect("devices.revoke serializes")
}

/// Encode a `{"t":"auth.token"}` plaintext — request a per-device REST bearer.
pub fn encode_auth_token_request() -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({ "t": "auth.token" })).expect("auth.token serializes")
}

/// Encode a `{"t":"resize",…}` plaintext.
pub fn encode_resize(session_id: &str, cols: u16, rows: u16) -> Vec<u8> {
    serde_json::to_vec(&ResizeMsg {
        t: "resize",
        id: session_id,
        cols,
        rows,
    })
    .expect("resize serializes")
}

/// Translate one WS-JSON line from the frontend into the plaintext bytes to
/// `seal` onto the Noise channel. Returns `None` for `focus` and anything
/// unrecognized (dropped, per the mapping rules).
///
/// - `{"type":"input","text":…}`   → `{"t":"input","id":session,"text":…}`
/// - `{"type":"resize","cols","rows"}` → `{"t":"resize","id":session,"cols","rows"}`
/// - `{"type":"focus",…}`          → dropped
pub fn translate_frontend(session_id: &str, ws_json: &str) -> Option<Vec<u8>> {
    let value: Value = serde_json::from_str(ws_json).ok()?;
    match value.get("type").and_then(Value::as_str)? {
        "input" => {
            let text = value.get("text").and_then(Value::as_str).unwrap_or("");
            Some(encode_input(session_id, text))
        }
        "resize" => {
            let cols = value.get("cols").and_then(Value::as_u64).unwrap_or(80) as u16;
            let rows = value.get("rows").and_then(Value::as_u64).unwrap_or(24) as u16;
            Some(encode_resize(session_id, cols, rows))
        }
        // "focus" and any other type are dropped.
        _ => None,
    }
}

/// Decode one opened plaintext frame from the server into a [`ServerMsg`].
/// Unknown message types decode as [`ServerMsg::Other`] so the pump can ignore
/// them without tearing down. Returns `Err` only when the bytes aren't JSON.
pub fn decode_server(plaintext: &[u8]) -> Result<ServerMsg, serde_json::Error> {
    let value: Value = serde_json::from_slice(plaintext)?;
    Ok(match value.get("t").and_then(Value::as_str) {
        Some("output") => ServerMsg::Output {
            chunk: value
                .get("chunk")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
        },
        Some("exit") => ServerMsg::Exit {
            exit_code: value.get("exitCode").and_then(Value::as_i64).unwrap_or(0),
        },
        Some("devices") => {
            let items = value
                .get("items")
                .cloned()
                .unwrap_or_else(|| Value::Array(vec![]));
            ServerMsg::Devices(serde_json::from_value(items)?)
        }
        Some("devices.revoked") => ServerMsg::DevicesRevoked {
            target: value
                .get("target")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            ok: value.get("ok").and_then(Value::as_bool).unwrap_or(false),
            error: value
                .get("error")
                .and_then(Value::as_str)
                .map(str::to_string),
        },
        Some("auth.token") => ServerMsg::AuthToken {
            token: value
                .get("token")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            expires_at: value
                .get("expiresAt")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
        },
        _ => ServerMsg::Other,
    })
}

/// Render the WS-JSON `output` line the frontend consumes, stamping the
/// synthesized monotonic id (the Noise `id` is a session string, not a numeric
/// replay cursor — a counter is correct here).
pub fn encode_frontend_output(id: u64, chunk: &str) -> String {
    serde_json::to_string(&FrontendOutput {
        ty: "output",
        id,
        chunk,
    })
    .expect("frontend output serializes")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn start_round_trips_to_the_noise_shape() {
        let bytes = encode_start("sess-1", 120, 40);
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            value,
            json!({"t":"start","id":"sess-1","cols":120,"rows":40})
        );
    }

    #[test]
    fn input_round_trips_to_the_noise_shape() {
        let bytes = encode_input("sess-1", "ls -la\r");
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value, json!({"t":"input","id":"sess-1","text":"ls -la\r"}));
    }

    #[test]
    fn resize_round_trips_to_the_noise_shape() {
        let bytes = encode_resize("sess-1", 80, 24);
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            value,
            json!({"t":"resize","id":"sess-1","cols":80,"rows":24})
        );
    }

    #[test]
    fn frontend_input_translates_to_sealed_input() {
        let bytes = translate_frontend("sess-1", r#"{"type":"input","text":"echo hi\n"}"#).unwrap();
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value, json!({"t":"input","id":"sess-1","text":"echo hi\n"}));
    }

    #[test]
    fn frontend_resize_translates_to_sealed_resize() {
        let bytes =
            translate_frontend("sess-1", r#"{"type":"resize","cols":132,"rows":50}"#).unwrap();
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            value,
            json!({"t":"resize","id":"sess-1","cols":132,"rows":50})
        );
    }

    #[test]
    fn frontend_focus_is_dropped() {
        assert!(translate_frontend("sess-1", r#"{"type":"focus","focused":true}"#).is_none());
    }

    #[test]
    fn frontend_unknown_and_garbage_are_dropped() {
        assert!(translate_frontend("sess-1", r#"{"type":"title","title":"x"}"#).is_none());
        assert!(translate_frontend("sess-1", "not json").is_none());
        assert!(translate_frontend("sess-1", r#"{"no":"type"}"#).is_none());
    }

    #[test]
    fn decode_server_output() {
        let msg = decode_server(br#"{"t":"output","chunk":"hello","id":"sess-1"}"#).unwrap();
        assert_eq!(
            msg,
            ServerMsg::Output {
                chunk: "hello".to_string()
            }
        );
    }

    #[test]
    fn decode_server_exit_carries_the_code() {
        let msg = decode_server(br#"{"t":"exit","id":"sess-1","exitCode":137}"#).unwrap();
        assert_eq!(msg, ServerMsg::Exit { exit_code: 137 });
    }

    #[test]
    fn decode_server_exit_zero() {
        let msg = decode_server(br#"{"t":"exit","id":"sess-1","exitCode":0}"#).unwrap();
        assert_eq!(msg, ServerMsg::Exit { exit_code: 0 });
    }

    #[test]
    fn decode_server_unknown_type_is_other() {
        let msg = decode_server(br#"{"t":"reset","id":"sess-1"}"#).unwrap();
        assert_eq!(msg, ServerMsg::Other);
    }

    #[test]
    fn devices_list_encodes_to_the_noise_shape() {
        let value: Value = serde_json::from_slice(&encode_devices_list()).unwrap();
        assert_eq!(value, json!({ "t": "devices.list" }));
    }

    #[test]
    fn devices_revoke_encodes_the_target() {
        let value: Value = serde_json::from_slice(&encode_devices_revoke("dev-7")).unwrap();
        assert_eq!(value, json!({ "t": "devices.revoke", "target": "dev-7" }));
    }

    #[test]
    fn decode_server_devices_roster() {
        // Two devices: one fully populated, one with null lastSeenAt/lastAddress
        // and isSelf true — exercising every Option + the bool.
        let bytes = br#"{"t":"devices","items":[
            {"id":"a","label":"homelab","fingerprint":"ab:cd","pairedAt":"2026-01-01T00:00:00Z","lastSeenAt":"2026-02-02T00:00:00Z","lastAddress":"192.168.1.2","isSelf":false},
            {"id":"b","label":"this phone","fingerprint":"ef:01","pairedAt":"2026-01-03T00:00:00Z","lastSeenAt":null,"lastAddress":null,"isSelf":true}
        ]}"#;
        let msg = decode_server(bytes).unwrap();
        assert_eq!(
            msg,
            ServerMsg::Devices(vec![
                DeviceInfo {
                    id: "a".to_string(),
                    label: "homelab".to_string(),
                    fingerprint: "ab:cd".to_string(),
                    paired_at: "2026-01-01T00:00:00Z".to_string(),
                    last_seen_at: Some("2026-02-02T00:00:00Z".to_string()),
                    last_address: Some("192.168.1.2".to_string()),
                    is_self: false,
                },
                DeviceInfo {
                    id: "b".to_string(),
                    label: "this phone".to_string(),
                    fingerprint: "ef:01".to_string(),
                    paired_at: "2026-01-03T00:00:00Z".to_string(),
                    last_seen_at: None,
                    last_address: None,
                    is_self: true,
                },
            ])
        );
    }

    #[test]
    fn device_info_reencodes_to_camelcase() {
        // The JSON handed back to the webview must keep the wire's camelCase keys.
        let device = DeviceInfo {
            id: "a".to_string(),
            label: "homelab".to_string(),
            fingerprint: "ab:cd".to_string(),
            paired_at: "2026-01-01T00:00:00Z".to_string(),
            last_seen_at: None,
            last_address: None,
            is_self: true,
        };
        let value = serde_json::to_value(&device).unwrap();
        assert_eq!(
            value,
            json!({
                "id": "a",
                "label": "homelab",
                "fingerprint": "ab:cd",
                "pairedAt": "2026-01-01T00:00:00Z",
                "lastSeenAt": null,
                "lastAddress": null,
                "isSelf": true
            })
        );
    }

    #[test]
    fn decode_server_devices_revoked_ok() {
        let msg = decode_server(br#"{"t":"devices.revoked","target":"dev-7","ok":true}"#).unwrap();
        assert_eq!(
            msg,
            ServerMsg::DevicesRevoked {
                target: "dev-7".to_string(),
                ok: true,
                error: None,
            }
        );
    }

    #[test]
    fn decode_server_devices_revoked_error() {
        let msg =
            decode_server(br#"{"t":"devices.revoked","target":"x","ok":false,"error":"nope"}"#)
                .unwrap();
        assert_eq!(
            msg,
            ServerMsg::DevicesRevoked {
                target: "x".to_string(),
                ok: false,
                error: Some("nope".to_string()),
            }
        );
    }

    #[test]
    fn decode_server_rejects_non_json() {
        assert!(decode_server(b"not json at all").is_err());
    }

    #[test]
    fn auth_token_request_encodes_to_the_noise_shape() {
        let value: Value = serde_json::from_slice(&encode_auth_token_request()).unwrap();
        assert_eq!(value, json!({ "t": "auth.token" }));
    }

    #[test]
    fn decode_server_auth_token() {
        let msg = decode_server(
            br#"{"t":"auth.token","token":"tok-abc","expiresAt":"2026-09-05T00:00:00.000Z"}"#,
        )
        .unwrap();
        assert_eq!(
            msg,
            ServerMsg::AuthToken {
                token: "tok-abc".to_string(),
                expires_at: "2026-09-05T00:00:00.000Z".to_string(),
            }
        );
    }

    #[test]
    fn frontend_output_stamps_the_synthetic_id() {
        let line = encode_frontend_output(7, "abc");
        let value: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(value, json!({"type":"output","id":7,"chunk":"abc"}));
    }

    #[test]
    fn output_decode_then_reencode_preserves_chunk() {
        // The exact inbound→outbound path the pump runs.
        let ServerMsg::Output { chunk } =
            decode_server(br#"{"t":"output","chunk":"drwxr-xr-x\r\n","id":"s"}"#).unwrap()
        else {
            panic!("expected output");
        };
        let line = encode_frontend_output(1, &chunk);
        let value: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(
            value,
            json!({"type":"output","id":1,"chunk":"drwxr-xr-x\r\n"})
        );
    }
}
