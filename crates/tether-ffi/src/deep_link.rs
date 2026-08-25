use std::sync::{Arc, Mutex};

use tether_core::deep_link::{DeepLinkHandler, DeepLinkResult, SessionDeepLink};
use tether_core::host_store::HostProfile;

use crate::host_store::FfiHostProfile;

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct FfiSessionDeepLink {
    pub session_id: String,
    pub identity_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Enum)]
pub enum FfiDeepLinkResult {
    Matched { host_id: String, session_id: String },
    UnknownHost { identity_name: String },
    Invalid,
    Queued,
}

impl From<DeepLinkResult> for FfiDeepLinkResult {
    fn from(result: DeepLinkResult) -> Self {
        match result {
            DeepLinkResult::Matched {
                host_id,
                session_id,
            } => Self::Matched {
                host_id,
                session_id,
            },
            DeepLinkResult::UnknownHost { identity_name } => Self::UnknownHost { identity_name },
            DeepLinkResult::Invalid => Self::Invalid,
            DeepLinkResult::Queued => Self::Queued,
        }
    }
}

impl From<SessionDeepLink> for FfiSessionDeepLink {
    fn from(link: SessionDeepLink) -> Self {
        Self {
            session_id: link.session_id,
            identity_name: link.identity_name,
        }
    }
}

fn to_core_profiles(profiles: Vec<FfiHostProfile>) -> Vec<HostProfile> {
    profiles
        .into_iter()
        .map(|profile| HostProfile {
            id: profile.id,
            name: profile.name,
            color: profile.color,
            host: profile.host,
            port: profile.port,
            identity_name: profile.identity_name,
            order: profile.order as usize,
        })
        .collect()
}

#[uniffi::export]
pub fn parse_session_deep_link(url: String) -> Option<FfiSessionDeepLink> {
    tether_core::deep_link::parse_deep_link(&url).map(Into::into)
}

#[uniffi::export]
pub fn resolve_session_deep_link(url: String, profiles: Vec<FfiHostProfile>) -> FfiDeepLinkResult {
    let core_profiles = to_core_profiles(profiles);
    let mut handler = DeepLinkHandler::new(|| Some(core_profiles.clone()), |_, _| {});
    handler.handle(&url).into()
}

#[uniffi::export(callback_interface)]
pub trait HostProfileProvider: Send + Sync {
    fn profiles(&self) -> Option<Vec<FfiHostProfile>>;
}

#[uniffi::export(callback_interface)]
pub trait DeepLinkSessionCallback: Send + Sync {
    fn on_session(&self, host_id: String, session_id: String);
}

type DeepLinkHandlerInner = DeepLinkHandler<
    Box<dyn Fn() -> Option<Vec<HostProfile>> + Send + Sync>,
    Box<dyn FnMut(&str, &str) + Send>,
>;

#[derive(uniffi::Object)]
pub struct DeepLinkResolver {
    inner: Mutex<DeepLinkHandlerInner>,
}

#[uniffi::export]
impl DeepLinkResolver {
    #[uniffi::constructor]
    pub fn new(
        provider: Box<dyn HostProfileProvider>,
        callback: Box<dyn DeepLinkSessionCallback>,
    ) -> Arc<Self> {
        let provider: Arc<dyn HostProfileProvider> = Arc::from(provider);
        let callback: Arc<dyn DeepLinkSessionCallback> = Arc::from(callback);
        let provider_for_handler = Arc::clone(&provider);
        let callback_for_handler = Arc::clone(&callback);
        let handler = DeepLinkHandler::new(
            Box::new(move || provider_for_handler.profiles().map(to_core_profiles))
                as Box<dyn Fn() -> Option<Vec<HostProfile>> + Send + Sync>,
            Box::new(move |host_id: &str, session_id: &str| {
                callback_for_handler.on_session(host_id.to_string(), session_id.to_string());
            }) as Box<dyn FnMut(&str, &str) + Send>,
        );
        Arc::new(Self {
            inner: Mutex::new(handler),
        })
    }

    pub fn handle(&self, url: String) -> FfiDeepLinkResult {
        self.inner
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .handle(&url)
            .into()
    }

    pub fn apply_pending(&self) -> Option<FfiDeepLinkResult> {
        self.inner
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .apply_pending()
            .map(Into::into)
    }
}
