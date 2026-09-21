#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionDeepLink {
    pub session_id: String,
    pub identity_name: String,
}

pub fn parse_deep_link(url: &str) -> Option<SessionDeepLink> {
    let rest = url.strip_prefix("tether://")?;
    let rest = rest.split('#').next()?;
    let (location, query) = rest.split_once('?')?;
    let session_id = location.strip_prefix("session/")?;
    if session_id.is_empty() {
        return None;
    }
    let identity_name = query.split('&').find_map(|parameter| {
        let (name, value) = parameter.split_once('=')?;
        (name == "host").then(|| decode_query_component(value))?
    })?;
    if identity_name.is_empty() {
        return None;
    }
    Some(SessionDeepLink {
        session_id: session_id.to_string(),
        identity_name,
    })
}

fn decode_query_component(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => decoded.push(b' '),
            b'%' if index + 2 < bytes.len() => {
                let high = hex_value(bytes[index + 1])?;
                let low = hex_value(bytes[index + 2])?;
                decoded.push((high << 4) | low);
                index += 2;
            }
            byte => decoded.push(byte),
        }
        index += 1;
    }
    String::from_utf8(decoded).ok()
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_tether_session_link_and_its_host_identity() {
        assert_eq!(
            parse_deep_link("tether://session/term-7?host=alpha"),
            Some(SessionDeepLink {
                session_id: "term-7".to_string(),
                identity_name: "alpha".to_string(),
            })
        );
    }

    #[test]
    fn decodes_a_percent_encoded_host_identity() {
        assert_eq!(
            parse_deep_link("tether://session/term-7?host=App%20terminal"),
            Some(SessionDeepLink {
                session_id: "term-7".to_string(),
                identity_name: "App terminal".to_string(),
            })
        );
    }

    #[test]
    fn rejects_malformed_urls_without_panicking() {
        for url in [
            "https://session/term-7?host=alpha",
            "tether://session/?host=alpha",
            "tether://session/term-7",
        ] {
            assert_eq!(parse_deep_link(url), None, "{url}");
        }
    }
}
