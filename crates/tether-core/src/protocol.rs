use serde::{Deserialize, Serialize};

/// A frame received from the server on `/api/ws`.
///
/// `Diff` and `Unknown` are intentionally payload-free: P0 forwards the original
/// JSON text to the WebView rather than re-serializing, so nothing here needs to
/// model `diff`'s nested summary/status. Parsing exists only to *decide* — drop a
/// duplicate `output`, clear the replay cursor on `reset`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ServerFrame {
    Output {
        id: u64,
        chunk: String,
    },
    #[serde(rename_all = "camelCase")]
    Exit {
        #[serde(default)]
        exit_code: Option<i32>,
    },
    Title {
        title: String,
    },
    Activity {
        activity: String,
    },
    Diff,
    Reset,
    Ping,
    #[serde(other)]
    Unknown,
}

/// A frame sent to the server on `/api/ws`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ClientFrame {
    Input { text: String },
    Resize { cols: u16, rows: u16 },
    Focus { focused: bool },
}

impl ClientFrame {
    /// Serializes to the v1 wire shape. Infallible: every variant is a flat
    /// struct of primitives, so `serde_json` cannot fail here.
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("ClientFrame is always serializable")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_output_frame() {
        let frame: ServerFrame =
            serde_json::from_str(r#"{"type":"output","chunk":"hi","id":42}"#).unwrap();
        assert_eq!(
            frame,
            ServerFrame::Output {
                id: 42,
                chunk: "hi".to_string()
            }
        );
    }

    #[test]
    fn parses_exit_frame_with_camel_case_code() {
        let frame: ServerFrame = serde_json::from_str(r#"{"type":"exit","exitCode":130}"#).unwrap();
        assert_eq!(
            frame,
            ServerFrame::Exit {
                exit_code: Some(130)
            }
        );
    }

    #[test]
    fn parses_exit_frame_without_code() {
        let frame: ServerFrame = serde_json::from_str(r#"{"type":"exit"}"#).unwrap();
        assert_eq!(frame, ServerFrame::Exit { exit_code: None });
    }

    #[test]
    fn parses_reset_and_ping() {
        assert_eq!(
            serde_json::from_str::<ServerFrame>(r#"{"type":"reset"}"#).unwrap(),
            ServerFrame::Reset
        );
        assert_eq!(
            serde_json::from_str::<ServerFrame>(r#"{"type":"ping"}"#).unwrap(),
            ServerFrame::Ping
        );
    }

    #[test]
    fn parses_title_and_activity() {
        assert_eq!(
            serde_json::from_str::<ServerFrame>(r#"{"type":"title","title":"vim"}"#).unwrap(),
            ServerFrame::Title {
                title: "vim".to_string()
            }
        );
        assert_eq!(
            serde_json::from_str::<ServerFrame>(r#"{"type":"activity","activity":"working"}"#)
                .unwrap(),
            ServerFrame::Activity {
                activity: "working".to_string()
            }
        );
    }

    // The core must not choke on a frame shape it doesn't model. `diff` carries
    // nested summary/status objects P0 deliberately doesn't parse, and a future
    // server may add frames outright.
    #[test]
    fn tolerates_unmodelled_frames() {
        let diff = r#"{"type":"diff","summary":{"files":[]},"status":{"branch":"main"}}"#;
        assert_eq!(
            serde_json::from_str::<ServerFrame>(diff).unwrap(),
            ServerFrame::Diff
        );
        assert_eq!(
            serde_json::from_str::<ServerFrame>(r#"{"type":"someFutureThing"}"#).unwrap(),
            ServerFrame::Unknown
        );
    }

    #[test]
    fn serializes_client_frames_in_the_v1_shape() {
        assert_eq!(
            ClientFrame::Input {
                text: "ls\r".to_string()
            }
            .to_json(),
            r#"{"type":"input","text":"ls\r"}"#
        );
        assert_eq!(
            ClientFrame::Resize {
                cols: 120,
                rows: 40
            }
            .to_json(),
            r#"{"type":"resize","cols":120,"rows":40}"#
        );
        assert_eq!(
            ClientFrame::Focus { focused: true }.to_json(),
            r#"{"type":"focus","focused":true}"#
        );
    }
}
