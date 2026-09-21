use tether_core::deep_link::SessionDeepLink;

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct FfiSessionDeepLink {
    pub session_id: String,
    pub identity_name: String,
}

impl From<SessionDeepLink> for FfiSessionDeepLink {
    fn from(link: SessionDeepLink) -> Self {
        Self {
            session_id: link.session_id,
            identity_name: link.identity_name,
        }
    }
}

#[uniffi::export]
pub fn parse_session_deep_link(url: String) -> Option<FfiSessionDeepLink> {
    tether_core::deep_link::parse_deep_link(&url).map(Into::into)
}
