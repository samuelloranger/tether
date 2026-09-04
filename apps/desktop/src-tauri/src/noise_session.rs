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

use serde::Serialize;
use serde_json::Value;

/// A server → client application message, after Noise `open` + JSON parse.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServerMsg {
    /// Terminal output to render. `chunk` is the raw PTY text.
    Output { chunk: String },
    /// The session ended. `exit_code` mirrors the server's `exitCode`.
    Exit { exit_code: i64 },
    /// Any other sealed frame (e.g. `devices.*`) — the terminal pump ignores it.
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
        let msg = decode_server(br#"{"t":"devices.revoked","target":"x","ok":true}"#).unwrap();
        assert_eq!(msg, ServerMsg::Other);
    }

    #[test]
    fn decode_server_rejects_non_json() {
        assert!(decode_server(b"not json at all").is_err());
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
