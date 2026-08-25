use std::collections::HashMap;
#[cfg(unix)]
use std::fs::File;
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::num::NonZeroU64;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::replay::ReplayTracker;

const CURSOR_FORMAT_VERSION: u32 = 1;

#[derive(Debug, Serialize, Deserialize)]
struct CursorFile {
    version: u32,
    cursors: HashMap<String, u64>,
}

#[derive(Debug, Error)]
pub enum CursorPersistenceError {
    #[error("cursor file I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("cursor serialization failed: {0}")]
    Json(#[from] serde_json::Error),
}

/// Minimal persistence seam for the complete set of replay cursors.
pub trait CursorPersistence: std::fmt::Debug + Send + Sync {
    fn load_all(&self) -> Result<HashMap<String, u64>, CursorPersistenceError>;
    fn save_all(&self, cursors: &HashMap<String, u64>) -> Result<(), CursorPersistenceError>;
}

/// Zero-allocation adapter used by the default in-memory store.
#[derive(Debug, Default)]
pub struct NoopCursorPersistence;

impl CursorPersistence for NoopCursorPersistence {
    fn load_all(&self) -> Result<HashMap<String, u64>, CursorPersistenceError> {
        Ok(HashMap::new())
    }

    fn save_all(&self, _cursors: &HashMap<String, u64>) -> Result<(), CursorPersistenceError> {
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CursorFlushPolicy {
    max_advances: NonZeroU64,
    max_interval: Duration,
}

impl CursorFlushPolicy {
    /// Configures the synchronous durability bound evaluated on accepted
    /// output. No timer or runtime is required; elapsed time is checked only
    /// when the cursor advances.
    pub fn new(max_advances: NonZeroU64, max_interval: Duration) -> Self {
        Self {
            max_advances,
            max_interval,
        }
    }
}

impl Default for CursorFlushPolicy {
    /// Persists after 128 accepted output frames or five seconds, whichever is
    /// observed first. This caps crash loss below 128 frames without imposing
    /// an fsync on every terminal frame; explicit [`ReplayStore::flush`] still
    /// handles graceful shutdown.
    fn default() -> Self {
        Self::new(
            NonZeroU64::new(128).expect("128 is non-zero"),
            Duration::from_secs(5),
        )
    }
}

#[derive(Debug)]
pub struct FileCursorPersistence {
    path: PathBuf,
    io_lock: Mutex<()>,
}

impl FileCursorPersistence {
    pub fn new(path: impl AsRef<Path>) -> Self {
        Self {
            path: path.as_ref().to_path_buf(),
            io_lock: Mutex::new(()),
        }
    }
}

impl CursorPersistence for FileCursorPersistence {
    fn load_all(&self) -> Result<HashMap<String, u64>, CursorPersistenceError> {
        let _guard = self
            .io_lock
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        match load_cursor_file(&self.path)? {
            Some(cursors) => Ok(cursors),
            None => Ok(load_cursor_file(&backup_path(&self.path))?.unwrap_or_default()),
        }
    }

    fn save_all(&self, cursors: &HashMap<String, u64>) -> Result<(), CursorPersistenceError> {
        let _guard = self
            .io_lock
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let parent = usable_parent(&self.path);
        fs::create_dir_all(parent)?;
        let temp = appended_path(&self.path, ".tmp");
        let backup = backup_path(&self.path);
        let payload = CursorFile {
            version: CURSOR_FORMAT_VERSION,
            cursors: cursors.clone(),
        };

        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&temp)?;
        serde_json::to_writer(&mut file, &payload)?;
        file.flush()?;
        file.sync_all()?;
        drop(file);

        if backup.exists() {
            fs::remove_file(&backup)?;
        }
        if self.path.exists() {
            fs::rename(&self.path, &backup)?;
        }
        if let Err(error) = fs::rename(&temp, &self.path) {
            if !self.path.exists() && backup.exists() {
                let _ = fs::rename(&backup, &self.path);
            }
            return Err(error.into());
        }
        sync_directory(parent)?;
        Ok(())
    }
}

fn load_cursor_file(path: &Path) -> Result<Option<HashMap<String, u64>>, CursorPersistenceError> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let Ok(file) = serde_json::from_slice::<CursorFile>(&bytes) else {
        return Ok(Some(HashMap::new()));
    };
    if file.version != CURSOR_FORMAT_VERSION {
        return Ok(Some(HashMap::new()));
    }
    Ok(Some(file.cursors))
}

fn backup_path(path: &Path) -> PathBuf {
    appended_path(path, ".bak")
}

fn appended_path(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(suffix);
    PathBuf::from(name)
}

fn usable_parent(path: &Path) -> &Path {
    path.parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."))
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> std::io::Result<()> {
    File::open(path)?.sync_all()
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

/// Holds one [`ReplayTracker`] per session id, retained across connections.
///
/// Interior mutability because Tauri command handlers hold shared state, and
/// because iOS will call this from Swift through an immutable reference.
#[derive(Debug)]
pub struct ReplayStore(Mutex<ReplayStoreState>);

#[derive(Debug)]
struct ReplayStoreState {
    trackers: HashMap<String, ReplayTracker>,
    persistence: PersistenceMode,
}

#[derive(Debug)]
enum PersistenceMode {
    Noop(NoopCursorPersistence),
    Configured {
        adapter: Arc<dyn CursorPersistence>,
        policy: CursorFlushPolicy,
        advances_since_flush: u64,
        last_flush_attempt: Instant,
    },
}

impl Default for ReplayStore {
    fn default() -> Self {
        Self(Mutex::new(ReplayStoreState {
            trackers: HashMap::new(),
            persistence: PersistenceMode::Noop(NoopCursorPersistence),
        }))
    }
}

impl ReplayStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_persistence(persistence: Arc<dyn CursorPersistence>) -> Self {
        Self::with_persistence_policy(persistence, CursorFlushPolicy::default())
    }

    pub fn with_persistence_policy(
        persistence: Arc<dyn CursorPersistence>,
        policy: CursorFlushPolicy,
    ) -> Self {
        // Loading is deliberately fail-open. A lost cursor causes a slower
        // reconnect; refusing to construct the store breaks every connection.
        let trackers = persistence
            .load_all()
            .unwrap_or_default()
            .into_iter()
            .map(|(session_id, cursor)| (session_id, ReplayTracker::from_since_id(cursor)))
            .collect();
        Self(Mutex::new(ReplayStoreState {
            trackers,
            persistence: PersistenceMode::Configured {
                adapter: persistence,
                policy,
                advances_since_flush: 0,
                last_flush_attempt: Instant::now(),
            },
        }))
    }

    pub fn flush(&self) -> Result<(), CursorPersistenceError> {
        flush_state(&mut self.lock())
    }

    /// The `sinceId` for the next connection to this session. Unknown sessions
    /// start at 0, which asks the server for everything it still retains.
    pub fn since_id(&self, session_id: &str) -> u64 {
        self.lock()
            .trackers
            .get(session_id)
            .map(ReplayTracker::since_id)
            .unwrap_or(0)
    }

    /// See [`ReplayTracker::accept_output`]. Creates the tracker on first use.
    pub fn accept_output(&self, session_id: &str, id: u64) -> bool {
        let mut state = self.lock();
        let accepted = state
            .trackers
            .entry(session_id.to_string())
            .or_default()
            .accept_output(id);
        if accepted {
            maybe_auto_flush(&mut state);
        }
        accepted
    }

    /// See [`ReplayTracker::reset`].
    pub fn reset(&self, session_id: &str) {
        let mut state = self.lock();
        state
            .trackers
            .entry(session_id.to_string())
            .or_default()
            .reset();
        // Resets are rare and must not resurrect a stale cursor after restart.
        let _ = flush_state(&mut state);
    }

    /// Drops a session's cursor entirely — for a killed session, so a later
    /// session reusing the id doesn't skip its own early output.
    pub fn forget(&self, session_id: &str) {
        let mut state = self.lock();
        if state.trackers.remove(session_id).is_some() {
            // Session ids may be reused, so forgetting is persisted eagerly.
            let _ = flush_state(&mut state);
        }
    }

    /// A poisoned mutex here means another thread panicked mid-update. The
    /// tracker is two integers with no invariant spanning them, so recovering
    /// the guard is safe and strictly better than propagating a panic into a
    /// Tauri command.
    fn lock(&self) -> std::sync::MutexGuard<'_, ReplayStoreState> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
}

fn maybe_auto_flush(state: &mut ReplayStoreState) {
    if matches!(state.persistence, PersistenceMode::Noop(_)) {
        return;
    }
    let now = Instant::now();
    let due = match &mut state.persistence {
        PersistenceMode::Noop(_) => unreachable!("no-op persistence returned above"),
        PersistenceMode::Configured {
            policy,
            advances_since_flush,
            last_flush_attempt,
            ..
        } => {
            *advances_since_flush = advances_since_flush.saturating_add(1);
            *advances_since_flush >= policy.max_advances.get()
                || now.duration_since(*last_flush_attempt) >= policy.max_interval
        }
    };
    if !due {
        return;
    }

    let cursors = cursor_snapshot(&state.trackers);
    if let PersistenceMode::Configured {
        adapter,
        advances_since_flush,
        last_flush_attempt,
        ..
    } = &mut state.persistence
    {
        // Auto-flush errors cannot break the live session. Treat this as an
        // attempt so a bad disk does not turn every output frame into an fsync;
        // explicit `flush` still exposes the error to the shell.
        *advances_since_flush = 0;
        *last_flush_attempt = now;
        let _ = adapter.save_all(&cursors);
    }
}

fn flush_state(state: &mut ReplayStoreState) -> Result<(), CursorPersistenceError> {
    if matches!(state.persistence, PersistenceMode::Noop(_)) {
        return Ok(());
    }
    let cursors = cursor_snapshot(&state.trackers);
    match &mut state.persistence {
        PersistenceMode::Noop(_) => unreachable!("no-op persistence returned above"),
        PersistenceMode::Configured {
            adapter,
            advances_since_flush,
            last_flush_attempt,
            ..
        } => {
            adapter.save_all(&cursors)?;
            *advances_since_flush = 0;
            *last_flush_attempt = Instant::now();
            Ok(())
        }
    }
}

fn cursor_snapshot(trackers: &HashMap<String, ReplayTracker>) -> HashMap<String, u64> {
    trackers
        .iter()
        .map(|(session_id, tracker)| (session_id.clone(), tracker.since_id()))
        .collect()
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::num::NonZeroU64;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::thread;
    use std::time::Duration;

    use super::*;

    #[derive(Debug, Default)]
    struct MemoryCursorPersistence {
        cursors: Mutex<HashMap<String, u64>>,
        saves: AtomicUsize,
    }

    impl CursorPersistence for MemoryCursorPersistence {
        fn load_all(&self) -> Result<HashMap<String, u64>, CursorPersistenceError> {
            Ok(self.cursors.lock().unwrap().clone())
        }

        fn save_all(&self, cursors: &HashMap<String, u64>) -> Result<(), CursorPersistenceError> {
            *self.cursors.lock().unwrap() = cursors.clone();
            self.saves.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            static NEXT_ID: AtomicU64 = AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "tether-core-cursors-{}-{}",
                std::process::id(),
                NEXT_ID.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn file(&self) -> PathBuf {
            self.0.join("cursors.json")
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn count_policy(max_advances: u64) -> CursorFlushPolicy {
        CursorFlushPolicy::new(
            NonZeroU64::new(max_advances).unwrap(),
            Duration::from_secs(60 * 60),
        )
    }

    #[test]
    fn unknown_sessions_start_at_zero() {
        let store = ReplayStore::new();
        assert_eq!(store.since_id("nope"), 0);
    }

    // The point of the whole spike: a session's cursor survives the connection
    // that produced it, so the TS reconnect doesn't have to carry sinceId.
    #[test]
    fn retains_the_cursor_across_connections() {
        let store = ReplayStore::new();
        assert!(store.accept_output("build", 12));
        assert_eq!(store.since_id("build"), 12);
        // ...connection drops, a new one opens, same store:
        assert_eq!(store.since_id("build"), 12);
        assert!(!store.accept_output("build", 12));
        assert!(store.accept_output("build", 13));
        assert_eq!(store.since_id("build"), 13);
    }

    #[test]
    fn keeps_sessions_independent() {
        let store = ReplayStore::new();
        store.accept_output("a", 5);
        store.accept_output("b", 99);
        assert_eq!(store.since_id("a"), 5);
        assert_eq!(store.since_id("b"), 99);
    }

    #[test]
    fn reset_clears_only_the_named_session() {
        let store = ReplayStore::new();
        store.accept_output("a", 5);
        store.accept_output("b", 99);
        store.reset("a");
        assert_eq!(store.since_id("a"), 0);
        assert_eq!(store.since_id("b"), 99);
    }

    // A killed session must not leave its cursor behind: a later session
    // reusing the id would silently skip its own early output.
    #[test]
    fn forget_drops_the_session_entirely() {
        let store = ReplayStore::new();
        store.accept_output("a", 5);
        store.forget("a");
        assert_eq!(store.since_id("a"), 0);
    }

    #[test]
    fn automatically_flushes_when_the_advance_bound_is_reached() {
        let persistence = Arc::new(MemoryCursorPersistence::default());
        let store = ReplayStore::with_persistence_policy(persistence.clone(), count_policy(3));

        store.accept_output("build", 1);
        store.accept_output("build", 2);
        assert_eq!(persistence.saves.load(Ordering::SeqCst), 0);
        store.accept_output("build", 3);

        assert_eq!(persistence.saves.load(Ordering::SeqCst), 1);
        assert_eq!(persistence.load_all().unwrap().get("build"), Some(&3));
    }

    #[test]
    fn automatically_flushes_after_the_elapsed_time_bound() {
        let persistence = Arc::new(MemoryCursorPersistence::default());
        let policy = CursorFlushPolicy::new(NonZeroU64::new(100).unwrap(), Duration::ZERO);
        let store = ReplayStore::with_persistence_policy(persistence.clone(), policy);

        store.accept_output("build", 1);

        assert_eq!(persistence.saves.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn dropping_without_an_explicit_flush_loses_less_than_one_advance_bound() {
        let persistence = Arc::new(MemoryCursorPersistence::default());
        {
            let store = ReplayStore::with_persistence_policy(persistence.clone(), count_policy(3));
            for id in 1..=5 {
                store.accept_output("build", id);
            }
        }

        let restarted = ReplayStore::with_persistence_policy(persistence.clone(), count_policy(3));
        assert_eq!(restarted.since_id("build"), 3);
        assert!(5 - restarted.since_id("build") < 3);
    }

    #[test]
    fn reset_is_persisted_immediately_so_a_restart_cannot_restore_a_stale_cursor() {
        let persistence = Arc::new(MemoryCursorPersistence::default());
        {
            let store =
                ReplayStore::with_persistence_policy(persistence.clone(), count_policy(100));
            store.accept_output("build", 42);
            store.flush().unwrap();
            store.reset("build");
        }

        let restarted =
            ReplayStore::with_persistence_policy(persistence.clone(), count_policy(100));
        assert_eq!(restarted.since_id("build"), 0);
    }

    #[test]
    fn forget_is_persisted_immediately_so_reused_session_ids_start_at_zero() {
        let persistence = Arc::new(MemoryCursorPersistence::default());
        {
            let store =
                ReplayStore::with_persistence_policy(persistence.clone(), count_policy(100));
            store.accept_output("build", 42);
            store.flush().unwrap();
            store.forget("build");
        }

        let restarted =
            ReplayStore::with_persistence_policy(persistence.clone(), count_policy(100));
        assert_eq!(restarted.since_id("build"), 0);
    }

    #[test]
    fn file_persistence_round_trips_through_a_real_temp_file() {
        let directory = TestDirectory::new();
        let path = directory.file();
        {
            let store = ReplayStore::with_persistence(Arc::new(FileCursorPersistence::new(&path)));
            store.accept_output("build", 42);
            store.flush().unwrap();
        }

        let restarted = ReplayStore::with_persistence(Arc::new(FileCursorPersistence::new(&path)));
        assert_eq!(restarted.since_id("build"), 42);
        assert!(!restarted.accept_output("build", 42));
    }

    #[test]
    fn missing_file_is_an_empty_first_run_and_flush_creates_it() {
        let directory = TestDirectory::new();
        let path = directory.file();
        let store = ReplayStore::with_persistence(Arc::new(FileCursorPersistence::new(&path)));

        assert_eq!(store.since_id("build"), 0);
        store.accept_output("build", 1);
        store.flush().unwrap();
        assert!(path.exists());
    }

    #[test]
    fn corrupt_file_recovers_to_zero_without_panicking() {
        let directory = TestDirectory::new();
        let path = directory.file();
        fs::write(&path, b"not json").unwrap();

        let store = ReplayStore::with_persistence(Arc::new(FileCursorPersistence::new(&path)));

        assert_eq!(store.since_id("build"), 0);
        assert!(store.accept_output("build", 1));
    }

    #[test]
    fn future_file_version_recovers_to_zero() {
        let directory = TestDirectory::new();
        let path = directory.file();
        fs::write(&path, br#"{"version":999,"cursors":{"build":42}}"#).unwrap();

        let store = ReplayStore::with_persistence(Arc::new(FileCursorPersistence::new(&path)));

        assert_eq!(store.since_id("build"), 0);
    }

    #[test]
    fn concurrent_access_keeps_every_session_cursor_restartable() {
        let directory = TestDirectory::new();
        let path = directory.file();
        let store = Arc::new(ReplayStore::with_persistence_policy(
            Arc::new(FileCursorPersistence::new(&path)),
            count_policy(7),
        ));
        let threads = (0..8)
            .map(|worker| {
                let store = Arc::clone(&store);
                thread::spawn(move || {
                    let session = format!("session-{worker}");
                    for id in 1..=100 {
                        store.accept_output(&session, id);
                        if id % 19 == 0 {
                            store.flush().unwrap();
                        }
                    }
                })
            })
            .collect::<Vec<_>>();
        for thread in threads {
            thread.join().unwrap();
        }
        store.flush().unwrap();
        drop(store);

        let restarted = ReplayStore::with_persistence(Arc::new(FileCursorPersistence::new(&path)));
        for worker in 0..8 {
            assert_eq!(restarted.since_id(&format!("session-{worker}")), 100);
        }
    }
}
