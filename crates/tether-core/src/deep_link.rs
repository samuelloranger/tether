use std::future::Future;
use std::sync::Arc;

use crate::host_store::HostProfile;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionDeepLink {
    pub session_id: String,
    pub identity_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeepLinkResult {
    Matched { host_id: String, session_id: String },
    UnknownHost { identity_name: String },
    Invalid,
    Queued,
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

pub struct DeepLinkHandler<G, O> {
    get_profiles: G,
    on_session: O,
    pending: Option<String>,
}

impl<G, O> DeepLinkHandler<G, O>
where
    G: Fn() -> Option<Vec<HostProfile>>,
    O: FnMut(&str, &str),
{
    pub fn new(get_profiles: G, on_session: O) -> Self {
        Self {
            get_profiles,
            on_session,
            pending: None,
        }
    }

    pub fn handle(&mut self, url: &str) -> DeepLinkResult {
        self.resolve(url)
    }

    pub fn apply_pending(&mut self) -> Option<DeepLinkResult> {
        if self.pending.is_none() || (self.get_profiles)().is_none() {
            return None;
        }
        let url = self.pending.take().expect("pending was checked above");
        Some(self.resolve(&url))
    }

    fn resolve(&mut self, url: &str) -> DeepLinkResult {
        let Some(link) = parse_deep_link(url) else {
            return DeepLinkResult::Invalid;
        };
        let Some(profiles) = (self.get_profiles)() else {
            self.pending = Some(url.to_string());
            return DeepLinkResult::Queued;
        };
        let Some(profile) = profiles
            .iter()
            .find(|profile| profile.identity_name == link.identity_name)
        else {
            return DeepLinkResult::UnknownHost {
                identity_name: link.identity_name,
            };
        };
        (self.on_session)(&profile.id, &link.session_id);
        DeepLinkResult::Matched {
            host_id: profile.id.clone(),
            session_id: link.session_id,
        }
    }
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

pub type OpenUrlListener = Arc<dyn Fn(Vec<String>) + Send + Sync>;

/// Delivers launch-time and runtime URLs through the same caller-owned sink.
pub async fn listen_for_deep_links<G, GF, O, OF, U, H>(
    get_current: G,
    on_open_url: O,
    on_url: H,
) -> U
where
    G: FnOnce() -> GF,
    GF: Future<Output = Option<Vec<String>>>,
    O: FnOnce(OpenUrlListener) -> OF,
    OF: Future<Output = U>,
    H: Fn(String) + Send + Sync + 'static,
{
    let on_url: Arc<dyn Fn(String) + Send + Sync> = Arc::new(on_url);
    if let Some(urls) = get_current().await {
        for url in urls {
            on_url(url);
        }
    }
    let on_runtime_url = Arc::clone(&on_url);
    on_open_url(Arc::new(move |urls| {
        for url in urls {
            on_runtime_url(url);
        }
    }))
    .await
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    fn hosts() -> Vec<HostProfile> {
        vec![HostProfile {
            id: "host-alpha".to_string(),
            name: "Alpha".to_string(),
            color: "#89b4fa".to_string(),
            host: "alpha.local".to_string(),
            port: "8085".to_string(),
            identity_name: "alpha".to_string(),
            order: 0,
            scheme: None,
        }]
    }

    #[test]
    fn parses_a_tether_session_link_and_resolves_its_host_identity() {
        assert_eq!(
            parse_deep_link("tether://session/term-7?host=alpha"),
            Some(SessionDeepLink {
                session_id: "term-7".to_string(),
                identity_name: "alpha".to_string(),
            })
        );
    }

    #[test]
    fn returns_unknown_host_instead_of_silently_dropping_a_valid_link() {
        let mut handler = DeepLinkHandler::new(|| Some(hosts()), |_, _| {});

        assert_eq!(
            handler.handle("tether://session/term-7?host=missing"),
            DeepLinkResult::UnknownHost {
                identity_name: "missing".to_string(),
            }
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

    #[test]
    fn queues_a_link_until_profiles_load_then_applies_it() {
        let profiles = Arc::new(Mutex::new(None));
        let selected = Arc::new(Mutex::new(Vec::<(String, String)>::new()));
        let profiles_for_handler = Arc::clone(&profiles);
        let selected_for_handler = Arc::clone(&selected);
        let mut handler = DeepLinkHandler::new(
            move || profiles_for_handler.lock().unwrap().clone(),
            move |host_id: &str, session_id: &str| {
                selected_for_handler
                    .lock()
                    .unwrap()
                    .push((host_id.to_string(), session_id.to_string()));
            },
        );

        assert_eq!(
            handler.handle("tether://session/term-7?host=alpha"),
            DeepLinkResult::Queued
        );
        *profiles.lock().unwrap() = Some(hosts());
        assert_eq!(
            handler.apply_pending(),
            Some(DeepLinkResult::Matched {
                host_id: "host-alpha".to_string(),
                session_id: "term-7".to_string(),
            })
        );
        assert_eq!(
            *selected.lock().unwrap(),
            vec![("host-alpha".to_string(), "term-7".to_string())]
        );
    }

    #[tokio::test]
    async fn delivers_startup_and_runtime_urls_through_the_same_handler() {
        let listener = Arc::new(Mutex::new(None::<OpenUrlListener>));
        let received = Arc::new(Mutex::new(Vec::<String>::new()));
        let listener_for_open = Arc::clone(&listener);
        let received_for_urls = Arc::clone(&received);

        let unlisten = listen_for_deep_links(
            || async { Some(vec!["tether://session/term-7?host=alpha".to_string()]) },
            move |callback| async move {
                *listener_for_open.lock().unwrap() = Some(callback);
                || {}
            },
            move |url| received_for_urls.lock().unwrap().push(url),
        )
        .await;

        listener.lock().unwrap().as_ref().unwrap()(vec![
            "tether://session/term-8?host=alpha".to_string()
        ]);
        unlisten();

        assert_eq!(
            *received.lock().unwrap(),
            vec![
                "tether://session/term-7?host=alpha".to_string(),
                "tether://session/term-8?host=alpha".to_string(),
            ]
        );
    }
}
