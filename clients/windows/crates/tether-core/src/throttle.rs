use std::collections::{BTreeMap, HashMap};
use std::time::Duration;

use crate::osc::Notification;

/// The iOS `BellThrottle` window: `yes $'\a'` must not flash without end.
pub const BELL_WINDOW: Duration = Duration::from_millis(200);
pub const TOAST_WINDOW: Duration = Duration::from_secs(5);

#[derive(Debug, Default)]
pub struct BellThrottle {
    last: Option<Duration>,
}

impl BellThrottle {
    pub fn should_ring(&mut self, now: Duration) -> bool {
        if self.last.is_some_and(|last| now.saturating_sub(last) < BELL_WINDOW) {
            return false;
        }
        self.last = Some(now);
        true
    }
}

pub fn wants_toast(window_focused: bool, is_active_tab: bool) -> bool {
    !(window_focused && is_active_tab)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToastDecision {
    Show(Notification),
    Pending,
}

#[derive(Debug, Default)]
pub struct ToastThrottle {
    last_shown: HashMap<String, Duration>,
    pending: BTreeMap<String, Notification>,
}

impl ToastThrottle {
    pub fn offer(&mut self, session: &str, n: Notification, now: Duration) -> ToastDecision {
        if self
            .last_shown
            .get(session)
            .is_some_and(|&t| now.saturating_sub(t) < TOAST_WINDOW)
        {
            self.pending.insert(session.to_owned(), n);
            return ToastDecision::Pending;
        }
        self.last_shown.insert(session.to_owned(), now);
        self.pending.remove(session);
        ToastDecision::Show(n)
    }

    pub fn poll(&mut self, now: Duration) -> Vec<(String, Notification)> {
        let due: Vec<String> = self
            .pending
            .keys()
            .filter(|s| {
                self.last_shown
                    .get(*s)
                    .is_none_or(|&t| now.saturating_sub(t) >= TOAST_WINDOW)
            })
            .cloned()
            .collect();
        due.into_iter()
            .filter_map(|s| {
                let n = self.pending.remove(&s)?;
                self.last_shown.insert(s.clone(), now);
                Some((s, n))
            })
            .collect()
    }

    pub fn forget(&mut self, session: &str) {
        self.pending.remove(session);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(v: u64) -> Duration {
        Duration::from_millis(v)
    }

    fn n(body: &str) -> Notification {
        Notification {
            title: None,
            body: body.into(),
        }
    }

    #[test]
    fn a_bell_burst_rings_once_per_200ms() {
        let mut b = BellThrottle::default();
        assert!(b.should_ring(ms(1000)));
        assert!(!b.should_ring(ms(1100)));
        assert!(!b.should_ring(ms(1199)));
        assert!(b.should_ring(ms(1200)));
    }

    #[test]
    fn no_toast_only_for_the_focused_active_tab() {
        assert!(!wants_toast(true, true));
        assert!(wants_toast(true, false));
        assert!(wants_toast(false, true));
        assert!(wants_toast(false, false));
    }

    #[test]
    fn one_toast_per_session_per_five_seconds_latest_pending_wins() {
        let mut t = ToastThrottle::default();
        assert_eq!(t.offer("a", n("1"), ms(0)), ToastDecision::Show(n("1")));
        assert_eq!(
            t.offer("b", n("other"), ms(10)),
            ToastDecision::Show(n("other"))
        );
        assert_eq!(t.offer("a", n("2"), ms(1000)), ToastDecision::Pending);
        assert_eq!(t.offer("a", n("3"), ms(2000)), ToastDecision::Pending);
        assert!(t.poll(ms(4999)).is_empty());
        assert_eq!(t.poll(ms(5000)), vec![("a".to_string(), n("3"))]);
        assert!(t.poll(ms(6000)).is_empty());
        assert_eq!(t.offer("a", n("4"), ms(6000)), ToastDecision::Pending);
        assert_eq!(t.offer("a", n("5"), ms(10_000)), ToastDecision::Show(n("5")));
    }

    #[test]
    fn viewing_the_tab_drops_its_pending_toast() {
        let mut t = ToastThrottle::default();
        t.offer("a", n("1"), ms(0));
        t.offer("a", n("2"), ms(100));
        t.forget("a");
        assert!(t.poll(ms(9000)).is_empty());
    }
}
