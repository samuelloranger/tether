use std::collections::HashMap;
use std::sync::Mutex;

use crate::replay::ReplayTracker;

/// Holds one [`ReplayTracker`] per session id, retained across connections.
///
/// Interior mutability because Tauri command handlers hold shared state, and
/// because iOS will call this from Swift through an immutable reference.
#[derive(Debug, Default)]
pub struct ReplayStore(Mutex<HashMap<String, ReplayTracker>>);

impl ReplayStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// The `sinceId` for the next connection to this session. Unknown sessions
    /// start at 0, which asks the server for everything it still retains.
    pub fn since_id(&self, session_id: &str) -> u64 {
        self.lock()
            .get(session_id)
            .map(ReplayTracker::since_id)
            .unwrap_or(0)
    }

    /// See [`ReplayTracker::accept_output`]. Creates the tracker on first use.
    pub fn accept_output(&self, session_id: &str, id: u64) -> bool {
        self.lock()
            .entry(session_id.to_string())
            .or_default()
            .accept_output(id)
    }

    /// See [`ReplayTracker::reset`].
    pub fn reset(&self, session_id: &str) {
        self.lock()
            .entry(session_id.to_string())
            .or_default()
            .reset();
    }

    /// Drops a session's cursor entirely — for a killed session, so a later
    /// session reusing the id doesn't skip its own early output.
    pub fn forget(&self, session_id: &str) {
        self.lock().remove(session_id);
    }

    /// A poisoned mutex here means another thread panicked mid-update. The
    /// tracker is two integers with no invariant spanning them, so recovering
    /// the guard is safe and strictly better than propagating a panic into a
    /// Tauri command.
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, ReplayTracker>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
