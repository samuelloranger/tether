use super::*;
use tether_core::connect::RECONNECT_BACKOFF;
use tether_core::lock::LockAction;
use tether_core::upload::CAPSULE_LINGER;

impl TerminalModel {
    pub(crate) fn on_dropped(&mut self, fx: &mut Vec<Effect>) {
        if self.status != ConnStatus::Connected {
            return;
        }
        self.begin_reconnect();
        fx.push(Effect::DropConnection);
        self.schedule(fx);
        fx.push(Effect::Redraw);
    }

    /// The page, the strip, and every grid stay. Only the channels go.
    fn begin_reconnect(&mut self) {
        self.status = ConnStatus::Reconnecting;
        self.channels.clear();
        self.attempt = 0;
        self.opening = false;
    }

    fn schedule(&mut self, fx: &mut Vec<Effect>) {
        self.generation += 1;
        fx.push(Effect::ScheduleRedial {
            after: RECONNECT_BACKOFF[self.attempt],
            generation: self.generation,
        });
    }

    fn cancel_pending_redial(&mut self) {
        // A newer generation turns any pending timer into a no-op.
        self.generation += 1;
    }

    fn open_now(&mut self, fx: &mut Vec<Effect>) {
        if self.opening {
            return;
        }
        self.opening = true;
        fx.push(Effect::Open);
    }

    pub(crate) fn on_redial_due(&mut self, generation: u64, fx: &mut Vec<Effect>) {
        if generation != self.generation || self.status != ConnStatus::Reconnecting {
            return;
        }
        self.attempt += 1;
        self.open_now(fx);
    }

    pub(crate) fn on_redial_failed(&mut self, err: ConnectError, fx: &mut Vec<Effect>) {
        if let ConnectError::HostKeyChanged { expected, got } = err {
            self.status = ConnStatus::Disconnected;
            self.screen = Screen::Refused { expected, got };
            fx.push(Effect::Close);
            fx.push(Effect::Ui(UiEffect::Navigate(self.screen.clone())));
            return;
        }
        if err.retryable()
            && self.status == ConnStatus::Reconnecting
            && self.attempt < RECONNECT_BACKOFF.len()
        {
            self.schedule(fx);
        } else {
            self.status = ConnStatus::Disconnected;
        }
        fx.push(Effect::Redraw);
    }

    /// Focus, network back, resume: try now instead of waiting out the backoff.
    pub(crate) fn redial_now(&mut self, fx: &mut Vec<Effect>) {
        match self.status {
            ConnStatus::Reconnecting => {
                self.cancel_pending_redial();
                self.open_now(fx);
            }
            ConnStatus::Disconnected
                if self.strip.is_some() && matches!(self.screen, Screen::Terminal) =>
            {
                // One attempt; on failure it is back to disconnected, not a fresh 1/2/4 s cycle.
                self.status = ConnStatus::Reconnecting;
                self.attempt = RECONNECT_BACKOFF.len();
                self.open_now(fx);
            }
            _ => {}
        }
    }

    /// A socket that slept through a suspend often still looks open, and the keepalives
    /// would take 30 s to notice. Drop it and redial now.
    pub(crate) fn force_redial(&mut self, fx: &mut Vec<Effect>) {
        if self.status == ConnStatus::Connected {
            self.begin_reconnect();
            fx.push(Effect::DropConnection);
            self.cancel_pending_redial();
            self.open_now(fx);
        } else {
            self.redial_now(fx);
        }
    }

    pub(crate) fn on_network(&mut self, online: bool, route_changed: bool, fx: &mut Vec<Effect>) {
        if !online {
            return;
        }
        if self.status == ConnStatus::Connected {
            if route_changed {
                self.force_redial(fx);
            }
        } else {
            self.redial_now(fx);
        }
    }

    pub(crate) fn on_reconnect_clicked(&mut self, fx: &mut Vec<Effect>) {
        if self.status != ConnStatus::Disconnected {
            return;
        }
        self.status = ConnStatus::Reconnecting;
        self.attempt = 0;
        self.open_now(fx);
    }

    pub(crate) fn on_unlock(&mut self, fx: &mut Vec<Effect>) {
        // Inside the grace, `on_unlock` just cancels the pending detach.
        let _ = self.lock.on_unlock();
        if self.lock_detached {
            self.lock_detached = false;
            self.reattach_all(fx);
        }
    }

    pub(crate) fn on_tick(&mut self, now: Duration, fx: &mut Vec<Effect>) {
        self.refresh_due(now, fx);
        self.tick_sync(now, fx);
        self.tick_resize(now, fx);
        self.tick_toasts(now, fx);
        if self.lock.poll(now) == LockAction::DetachAll {
            // The strip keeps these tabs logically attached; unlock opens them again.
            let names = self
                .strip
                .as_ref()
                .map(|s| s.reattach_order())
                .unwrap_or_default();
            for name in names {
                self.close_channel(&name, fx);
            }
            self.lock_detached = true;
        }
        if self
            .capsule_shown
            .is_some_and(|shown| now.saturating_sub(shown) >= CAPSULE_LINGER)
        {
            self.capsule_shown = None;
            self.send = None;
        }
    }

    /// The frame timer: end synchronized updates past their deadline, and blink the cursor.
    pub(crate) fn tick_sync(&mut self, now: Duration, fx: &mut Vec<Effect>) {
        let wall = std::time::Instant::now();
        let due: Vec<String> = self
            .tabs
            .iter()
            .filter(|(_, t)| t.term.sync_deadline().is_some_and(|d| wall >= d))
            .map(|(n, _)| n.clone())
            .collect();
        for name in due {
            let active = self.active_name() == Some(name.as_str());
            let events = self
                .tabs
                .get_mut(&name)
                .map(|t| t.term.flush_sync())
                .unwrap_or_default();
            for ev in events {
                self.on_term_event(&name, ev, active, now, fx);
            }
            if active {
                fx.push(Effect::Redraw);
            }
        }
        if self.style.blink && now.saturating_sub(self.blink_at) >= crate::terminal::frame::BLINK {
            self.blink_at = now;
            self.blink_on = !self.blink_on;
            fx.push(Effect::Redraw);
        }
    }
    pub(crate) fn tick_resize(&mut self, now: Duration, fx: &mut Vec<Effect>) {
        if let Some(size) = self.resize.poll(now) {
            fx.push(Effect::ResizeAll(size));
        }
    }
    pub(crate) fn tick_toasts(&mut self, now: Duration, fx: &mut Vec<Effect>) {
        self.toast_due(now, fx);
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{has_attach, live, t};
    use super::*;
    use crate::terminal::testkit::session;
    use tether_core::keymap::{KeyInput, Mods};

    fn redial(fx: &[Effect]) -> Option<(Duration, u64)> {
        fx.iter().find_map(|e| match e {
            Effect::ScheduleRedial { after, generation } => Some((*after, *generation)),
            _ => None,
        })
    }

    #[test]
    fn a_drop_keeps_the_tabs_and_backs_off_1_2_4() {
        let mut m = live(vec![session("a", 1), session("b", 2)]);
        let fx = m.handle(Msg::Dropped, t(100));
        assert!(fx.contains(&Effect::DropConnection));
        assert_eq!(m.view().header.word, "reconnecting");
        assert_eq!(m.view().tabs.len(), 2);
        let (after, g) = redial(&fx).unwrap();
        assert_eq!(after, Duration::from_secs(1));
        assert_eq!(
            m.handle(Msg::RedialDue { generation: g }, t(1_100)),
            vec![Effect::Open]
        );
        let (after, g) =
            redial(&m.handle(Msg::OpenFailed(ConnectError::Timeout), t(1_200))).unwrap();
        assert_eq!(after, Duration::from_secs(2));
        m.handle(Msg::RedialDue { generation: g }, t(3_200));
        let (after, g) =
            redial(&m.handle(Msg::OpenFailed(ConnectError::Timeout), t(3_300))).unwrap();
        assert_eq!(after, Duration::from_secs(4));
        m.handle(Msg::RedialDue { generation: g }, t(7_300));
        let fx = m.handle(Msg::OpenFailed(ConnectError::Timeout), t(7_400));
        assert!(redial(&fx).is_none());
        assert_eq!(m.view().header.word, "disconnected");
        assert_eq!(m.view().capsule, Some(CapsuleView::Disconnected));
    }

    #[test]
    fn reconnect_reattaches_every_attached_tab_active_first_on_fresh_channels() {
        let mut m = live(vec![session("a", 1), session("b", 2)]);
        m.handle(Msg::SelectTab("a".into()), t(10));
        m.handle(Msg::Attached { name: "a".into() }, t(10));
        m.handle(Msg::Dropped, t(100));
        let fx = m.handle(Msg::Opened, t(1_200));
        let attaches: Vec<_> = fx
            .iter()
            .filter_map(|e| match e {
                Effect::Attach { name, .. } => Some(name.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(attaches, ["a", "b"]);
        assert_eq!(m.view().header.word, "connected");
    }

    #[test]
    fn input_is_dropped_while_reconnecting() {
        let mut m = live(vec![session("a", 1)]);
        m.handle(Msg::Dropped, t(100));
        let key = KeyInput::Char {
            unmodified: 'x',
            produced: Some("x".into()),
            digit: None,
        };
        let fx = m.handle(
            Msg::Key {
                input: key,
                mods: Mods::default(),
            },
            t(200),
        );
        assert!(!fx.iter().any(|e| matches!(e, Effect::Write { .. })));
    }

    #[test]
    fn focus_and_network_back_redial_now_and_cancel_the_timer() {
        let mut m = live(vec![session("a", 1)]);
        let (_, g) = redial(&m.handle(Msg::Dropped, t(100))).unwrap();
        assert_eq!(
            m.handle(
                Msg::Network {
                    online: true,
                    route_changed: false,
                },
                t(200)
            ),
            vec![Effect::Open]
        );
        assert!(
            m.handle(Msg::RedialDue { generation: g }, t(1_100))
                .is_empty()
        );
        m.handle(Msg::OpenFailed(ConnectError::Timeout), t(1_200));
        m.handle(Msg::Focus(false), t(1_300));
        assert!(m.handle(Msg::Focus(true), t(1_400)).contains(&Effect::Open));
    }

    #[test]
    fn a_trigger_does_not_open_twice() {
        let mut m = live(vec![session("a", 1)]);
        m.handle(Msg::Dropped, t(100));
        assert_eq!(m.handle(Msg::Resumed, t(200)), vec![Effect::Open]);
        assert!(
            m.handle(
                Msg::Network {
                    online: true,
                    route_changed: false,
                },
                t(300)
            )
            .is_empty()
        );
    }

    #[test]
    fn resume_drops_and_redials_at_once() {
        let mut m = live(vec![session("a", 1)]);
        let fx = m.handle(Msg::Resumed, t(100));
        assert_eq!(fx[..2], [Effect::DropConnection, Effect::Open]);
        assert_eq!(m.view().header.word, "reconnecting");
    }

    #[test]
    fn a_route_change_redials_but_a_same_route_blip_does_not() {
        let mut m = live(vec![session("a", 1)]);
        assert!(
            m.handle(
                Msg::Network {
                    online: true,
                    route_changed: false,
                },
                t(100)
            )
            .is_empty()
        );
        assert!(
            m.handle(
                Msg::Network {
                    online: true,
                    route_changed: true,
                },
                t(200)
            )
            .contains(&Effect::DropConnection)
        );
    }

    #[test]
    fn a_mismatch_on_redial_lands_on_refused() {
        let mut m = live(vec![session("a", 1)]);
        m.handle(Msg::Dropped, t(100));
        let fx = m.handle(
            Msg::OpenFailed(ConnectError::HostKeyChanged {
                expected: "a".into(),
                got: "b".into(),
            }),
            t(1_200),
        );
        assert!(fx.contains(&Effect::Close));
        assert!(matches!(m.view().screen, Screen::Refused { .. }));
    }

    #[test]
    fn auth_failure_on_redial_does_not_retry() {
        let mut m = live(vec![session("a", 1)]);
        m.handle(Msg::Dropped, t(100));
        let fx = m.handle(Msg::OpenFailed(ConnectError::AuthRejected), t(1_200));
        assert!(redial(&fx).is_none());
        assert_eq!(m.view().header.word, "disconnected");
    }

    #[test]
    fn reconnect_button_from_disconnected() {
        let mut m = live(vec![session("a", 1)]);
        m.handle(Msg::Dropped, t(0));
        for g in 1..=3 {
            m.handle(Msg::RedialDue { generation: g }, t(10));
            m.handle(Msg::OpenFailed(ConnectError::Timeout), t(20));
        }
        assert_eq!(m.view().header.word, "disconnected");
        assert_eq!(m.handle(Msg::Reconnect, t(30)), vec![Effect::Open]);
        assert_eq!(m.view().header.word, "reconnecting");
    }

    #[test]
    fn lock_detaches_after_15s_not_before_and_unlock_reattaches() {
        let mut m = live(vec![session("a", 1), session("b", 2)]);
        m.handle(Msg::SelectTab("a".into()), t(1));
        m.handle(Msg::Attached { name: "a".into() }, t(1));
        m.handle(Msg::Locked, t(1_000));
        assert!(
            !m.handle(Msg::Tick, t(15_900))
                .iter()
                .any(|e| matches!(e, Effect::Detach { .. }))
        );
        let fx = m.handle(Msg::Tick, t(16_100));
        assert!(fx.contains(&Effect::Detach { name: "a".into() }));
        assert!(fx.contains(&Effect::Detach { name: "b".into() }));
        let fx = m.handle(Msg::Unlocked, t(30_000));
        assert!(has_attach(&fx, "a") && has_attach(&fx, "b"));
    }

    #[test]
    fn unlock_inside_the_grace_detaches_nothing() {
        let mut m = live(vec![session("a", 1)]);
        m.handle(Msg::Locked, t(1_000));
        assert!(m.handle(Msg::Unlocked, t(5_000)).is_empty());
        assert!(
            !m.handle(Msg::Tick, t(20_000))
                .iter()
                .any(|e| matches!(e, Effect::Detach { .. }))
        );
    }
}
