use serde_json::Value;

/// Extracts the navigation link carried by an APNs notification response.
///
/// The payload is attacker-influenced if a configured host is compromised,
/// and this is the one place that data reaches navigation. Only the app's own
/// `tether://` scheme may cross that seam.
pub fn link_from_notification_response(response: Option<&Value>) -> Option<&str> {
    response?
        .get("notification")?
        .get("request")?
        .get("content")?
        .get("data")?
        .get("link")?
        .as_str()
        .filter(|link| !link.is_empty() && link.starts_with("tether://"))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn response(data: Value) -> Value {
        json!({ "notification": { "request": { "content": { "data": data } } } })
    }

    #[test]
    fn extracts_the_session_link_a_tap_should_follow() {
        let input = response(json!({ "link": "tether://session/a?host=alpha" }));
        assert_eq!(
            link_from_notification_response(Some(&input)),
            Some("tether://session/a?host=alpha")
        );
    }

    #[test]
    fn returns_none_for_missing_or_malformed_link_data() {
        let no_data = response(Value::Null);
        let no_link = response(json!({ "other": "x" }));
        let empty_link = response(json!({ "link": "" }));
        let numeric_link = response(json!({ "link": 42 }));
        let cases = [
            ("null response", None),
            // JavaScript's distinct `undefined` also becomes `None` at this
            // stronger Rust interface; both original cases remain explicit.
            ("undefined response", None),
            ("no data", Some(&no_data)),
            ("data without link", Some(&no_link)),
            ("empty link", Some(&empty_link)),
            ("non-string link", Some(&numeric_link)),
        ];

        for (label, input) in cases {
            assert_eq!(link_from_notification_response(input), None, "{label}");
        }
    }

    #[test]
    fn refuses_non_tether_schemes_from_host_influenced_payloads() {
        for link in [
            "https://evil.example/steal",
            "javascript:alert(1)",
            "//evil.example",
            "tether-evil://session/a",
        ] {
            let input = response(json!({ "link": link }));
            assert_eq!(
                link_from_notification_response(Some(&input)),
                None,
                "{link}"
            );
        }
    }
}
