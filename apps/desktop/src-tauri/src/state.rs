use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use tauri::AppHandle;
use tether_core::host_health::HostHealth;
use tether_core::host_polling::HostPolling;
use tether_core::host_store::HostProfile;

use crate::http;
use crate::storage::{new_host_store, DesktopHostStore};

pub struct CoreBridge {
    pub sessions: Mutex<HashMap<String, tether_core::session::SessionHandle>>,
    pub replay: Arc<tether_core::store::ReplayStore>,
}

impl Default for CoreBridge {
    fn default() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            replay: Arc::new(tether_core::store::ReplayStore::default()),
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
