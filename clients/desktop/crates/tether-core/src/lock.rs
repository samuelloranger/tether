use std::time::Duration;

/// iOS `backgroundGrace`: a short lock keeps the attach; a long one tells the
/// Claude Code mod nobody is watching.
pub const LOCK_GRACE: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LockAction {
    None,
    DetachAll,
    ReattachAll,
}

#[derive(Debug, Default)]
pub struct LockGrace {
    locked_at: Option<Duration>,
    detached: bool,
}

impl LockGrace {
    pub fn on_lock(&mut self, now: Duration) {
        self.locked_at.get_or_insert(now);
    }

    pub fn poll(&mut self, now: Duration) -> LockAction {
        match self.locked_at {
            Some(at) if !self.detached && now.saturating_sub(at) >= LOCK_GRACE => {
                self.detached = true;
                LockAction::DetachAll
            }
            _ => LockAction::None,
        }
    }

    pub fn on_unlock(&mut self) -> LockAction {
        let action = if self.detached {
            LockAction::ReattachAll
        } else {
            LockAction::None
        };
        *self = Self::default();
        action
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: u64) -> Duration {
        Duration::from_secs(v)
    }

    #[test]
    fn detach_after_the_grace_not_before() {
        let mut l = LockGrace::default();
        l.on_lock(s(100));
        assert_eq!(l.poll(s(114)), LockAction::None);
        assert_eq!(l.poll(s(115)), LockAction::DetachAll);
        assert_eq!(l.poll(s(200)), LockAction::None);
        assert_eq!(l.on_unlock(), LockAction::ReattachAll);
        assert_eq!(l.poll(s(300)), LockAction::None);
    }

    #[test]
    fn unlock_inside_the_grace_changes_nothing() {
        let mut l = LockGrace::default();
        l.on_lock(s(0));
        assert_eq!(l.on_unlock(), LockAction::None);
        assert_eq!(l.poll(s(60)), LockAction::None);
    }

    #[test]
    fn a_second_lock_event_does_not_restart_the_grace() {
        let mut l = LockGrace::default();
        l.on_lock(s(0));
        l.on_lock(s(10));
        assert_eq!(l.poll(s(15)), LockAction::DetachAll);
    }
}
