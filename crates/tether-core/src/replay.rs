/// Tracks how far a client has consumed a session's log so a reconnect replays
/// only what it missed, and an overlapping replay is not applied twice.
///
/// Ported from `apps/mobile/src/tether/terminalSessionLogic.ts`. Pure and
/// sync — no I/O, no async, no platform types.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReplayTracker {
    since_id: u64,
    last_applied_id: u64,
}

impl ReplayTracker {
    /// Restores both cursors together so a persisted frame is also rejected as
    /// a duplicate after process restart.
    pub(crate) fn from_since_id(since_id: u64) -> Self {
        Self {
            since_id,
            last_applied_id: since_id,
        }
    }

    /// The `sinceId` to send on the next connection.
    pub fn since_id(&self) -> u64 {
        self.since_id
    }

    /// Returns true if this output frame is new and should be applied. A frame
    /// at or below the last applied id is a replay overlap and is dropped
    /// without moving the cursor.
    pub fn accept_output(&mut self, id: u64) -> bool {
        if id <= self.last_applied_id {
            return false;
        }
        self.last_applied_id = id;
        self.since_id = id;
        true
    }

    /// Clears the cursor after a server `reset` — the client's history has a
    /// hole, so the next connection must ask for everything still retained.
    pub fn reset(&mut self) {
        self.since_id = 0;
        self.last_applied_id = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starts_from_zero() {
        let tracker = ReplayTracker::default();
        assert_eq!(tracker.since_id(), 0);
    }

    #[test]
    fn accepts_advancing_ids_and_advances_the_cursor() {
        let mut tracker = ReplayTracker::default();
        assert!(tracker.accept_output(1));
        assert_eq!(tracker.since_id(), 1);
        assert!(tracker.accept_output(7));
        assert_eq!(tracker.since_id(), 7);
    }

    // A replay overlapping what the client already applied must not be written
    // to the emulator twice — that is what `lastAppliedId` guards in the TS.
    #[test]
    fn rejects_duplicate_and_stale_ids_without_moving_the_cursor() {
        let mut tracker = ReplayTracker::default();
        assert!(tracker.accept_output(5));
        assert!(!tracker.accept_output(5));
        assert!(!tracker.accept_output(3));
        assert_eq!(tracker.since_id(), 5);
    }

    // A server `reset` means the client's history has a hole; the cursor must
    // rewind to 0 so the next connection asks for everything retained.
    #[test]
    fn reset_rewinds_the_cursor_and_reopens_earlier_ids() {
        let mut tracker = ReplayTracker::default();
        tracker.accept_output(9);
        tracker.reset();
        assert_eq!(tracker.since_id(), 0);
        assert!(tracker.accept_output(4));
        assert_eq!(tracker.since_id(), 4);
    }
}
