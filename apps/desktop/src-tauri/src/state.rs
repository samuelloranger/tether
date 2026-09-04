use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use tauri::AppHandle;
use tether_core::host_health::HostHealth;
use tether_core::host_polling::HostPolling;
use tether_core::host_store::HostProfile;
use tether_core::session_cache::SessionCache;
use tokio::sync::mpsc::UnboundedSender;

use crate::http;
use crate::noise_token::CachedToken;
use crate::storage::{new_host_store, DesktopHostStore};

/// Per-connection handle for a live Noise terminal session. Mirrors the password
/// path's `sessions`/`cancels` pair, but folded into one value: `core_noise_send`
/// pushes plaintext WS-JSON onto `outgoing` (the pump translates + seals it), and
/// `core_noise_close` sets `cancel` and drops the handle so the pump's outgoing
/// receiver closes and it tears down.
#[derive(Clone)]
pub struct NoiseHandle {
    pub outgoing: UnboundedSender<String>,
    pub cancel: Arc<AtomicBool>,
}

pub struct CoreBridge {
    pub sessions: Mutex<HashMap<String, tether_core::session::SessionHandle>>,
    /// Per-connection cancel flag. Set by `core_close` so the reconnect loop
    /// (which re-opens the socket after an unexpected drop) knows the drop was
    /// the user's intent and stops retrying instead of racing to reconnect.
    pub cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
    pub replay: Arc<tether_core::store::ReplayStore>,
    /// Live Noise terminal sessions, keyed by `conn_id`. Sibling to `sessions`
    /// so the two transports never collide.
    pub noise_sessions: Mutex<HashMap<String, NoiseHandle>>,
}

impl Default for CoreBridge {
    fn default() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            cancels: Mutex::new(HashMap::new()),
            replay: Arc::new(tether_core::store::ReplayStore::default()),
            noise_sessions: Mutex::new(HashMap::new()),
        }
    }
}

pub struct AppState {
    pub bridge: CoreBridge,
    pub hosts: Mutex<DesktopHostStore>,
    pub health: Mutex<HashMap<String, HostHealth>>,
    pub polling: Mutex<HostPolling>,
    pub active_host_id: Mutex<Option<String>>,
    pub poll_generation: AtomicU64,
    pub http: reqwest::Client,
    pub session_cache: Mutex<SessionCache<()>>,
    /// Per-host Noise REST bearers. Password hosts never touch this map.
    pub noise_tokens: Mutex<HashMap<String, CachedToken>>,
}

impl AppState {
    pub fn new(storage_path: std::path::PathBuf) -> Self {
        Self {
            bridge: CoreBridge::default(),
            hosts: Mutex::new(new_host_store(storage_path)),
            health: Mutex::new(HashMap::new()),
            polling: Mutex::new(HostPolling::new()),
            active_host_id: Mutex::new(None),
            poll_generation: AtomicU64::new(0),
            http: http::http_client(),
            session_cache: Mutex::new(SessionCache::default()),
            noise_tokens: Mutex::new(HashMap::new()),
        }
    }

    pub fn bump_poll_generation(&self) -> u64 {
        self.poll_generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub fn current_poll_generation(&self) -> u64 {
        self.poll_generation.load(Ordering::SeqCst)
    }

    pub fn list_profiles(&self) -> Result<Vec<HostProfile>, String> {
        self.hosts
            .lock()
            .map_err(|error| error.to_string())?
            .list()
            .map_err(|error| error.to_string())
    }
}

/// Shared handle so polling tasks can read state without fighting Tauri's State lifetime.
pub type SharedState = Arc<AppState>;

pub fn shared_from_app(app: &AppHandle) -> SharedState {
    use tauri::Manager;
    app.state::<SharedState>().inner().clone()
}
