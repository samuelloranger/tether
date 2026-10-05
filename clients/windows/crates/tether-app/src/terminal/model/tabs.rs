use super::*;
use tether_core::tabs::CreateOutcome;

impl TerminalModel {
    pub(crate) fn activate(&mut self, name: &str, fx: &mut Vec<Effect>) {
        let Some(strip) = self.strip.as_mut() else {
            return;
        };
        if !strip.tabs.iter().any(|t| t.name == name) {
            return;
        }
        self.view_tick += 1;
        if let Some(evicted) = strip.select(name, self.view_tick) {
            self.close_channel(&evicted, fx);
        }
        self.toasts.forget(name);
        self.open_channel(name, fx);
        let progress = self.tabs.get(name).and_then(|t| t.term.reports().progress);
        fx.push(Effect::Ui(UiEffect::Taskbar(progress)));
        fx.push(Effect::Ui(UiEffect::SetTitle(self.window_title())));
        fx.push(Effect::Redraw);
    }

    pub(crate) fn reattach_all(&mut self, fx: &mut Vec<Effect>) {
        let order = self
            .strip
            .as_ref()
            .map(|s| s.reattach_order())
            .unwrap_or_default();
        for name in order {
            self.open_channel(&name, fx);
        }
    }

    pub(crate) fn merge(
        &mut self,
        sessions: Vec<ZmxSession>,
        _now: Duration,
        fx: &mut Vec<Effect>,
    ) {
        let Some(strip) = self.strip.as_mut() else {
            return;
        };
        // A tab created here stays (`on_host: false`) until zmx reports it.
        let outcome = strip.merge(&sessions);
        for name in &outcome.removed {
            self.close_channel(name, fx);
            self.tabs.remove(name);
        }
        if outcome.active_changed {
            match self.active_name().map(str::to_string) {
                Some(name) => self.activate(&name, fx),
                None => {
                    fx.push(Effect::Ui(UiEffect::Taskbar(None)));
                    fx.push(Effect::Ui(UiEffect::SetTitle(self.window_title())));
                }
            }
        }
        fx.push(Effect::Redraw);
    }

    pub(crate) fn refresh_due(&mut self, now: Duration, fx: &mut Vec<Effect>) {
        if self.focused
            && self.status == ConnStatus::Connected
            && now.saturating_sub(self.last_refresh) >= REFRESH_EVERY
        {
            self.last_refresh = now;
            fx.push(Effect::Ls);
        }
    }

    pub(crate) fn on_focus(&mut self, focused: bool, now: Duration, fx: &mut Vec<Effect>) {
        self.focused = focused;
        if !focused {
            return;
        }
        if let Some(a) = self.active_name().map(str::to_string) {
            self.toasts.forget(&a);
        }
        if self.status == ConnStatus::Connected {
            self.last_refresh = now;
            fx.push(Effect::Ls);
        } else {
            self.redial_now(fx);
        }
    }

    pub(crate) fn on_jump(&mut self, jump: TabJump, fx: &mut Vec<Effect>) {
        let Some(strip) = self.strip.as_ref() else {
            return;
        };
        let target = match jump {
            TabJump::Next => strip.next(),
            TabJump::Prev => strip.prev(),
            TabJump::Position(n) => strip.at_position(n as usize),
            TabJump::Last => strip.last(),
        }
        .map(str::to_string);
        if let Some(name) = target {
            self.activate(&name, fx);
        }
    }

    pub(crate) fn on_new_begin(&mut self) {
        if let Some(strip) = self.strip.as_ref() {
            self.naming = Some(strip.new_session_name());
        }
    }

    pub(crate) fn on_new_commit(&mut self, raw: &str, _now: Duration, fx: &mut Vec<Effect>) {
        self.naming = None;
        let name = raw.trim();
        if name.is_empty() || self.strip.is_none() {
            return;
        }
        if self.strip.as_ref().is_some_and(|s| s.tab(name).is_some()) {
            return self.activate(name, fx);
        }
        self.view_tick += 1;
        let tick = self.view_tick;
        let Some(strip) = self.strip.as_mut() else {
            return;
        };
        let evicted = match strip.create(name, tick) {
            CreateOutcome::Created { evicted } | CreateOutcome::Existing { evicted } => evicted,
        };
        if let Some(e) = evicted {
            self.close_channel(&e, fx);
        }
        // Attaching a name zmx does not know creates the session.
        self.created_here.insert(name.to_string());
        self.open_channel(name, fx);
        fx.push(Effect::Ui(UiEffect::Taskbar(None)));
        fx.push(Effect::Ui(UiEffect::SetTitle(self.window_title())));
        fx.push(Effect::Redraw);
    }

    pub(crate) fn on_kill_confirmed(&mut self, fx: &mut Vec<Effect>) {
        let Some(name) = self.kill_prompt.take() else {
            return;
        };
        let Some(strip) = self.strip.as_mut() else {
            return;
        };
        let step = strip.begin_kill(&name);
        if step.active_changed {
            match step.new_active {
                Some(n) => self.activate(&n, fx),
                None => {
                    fx.push(Effect::Ui(UiEffect::Taskbar(None)));
                    fx.push(Effect::Ui(UiEffect::SetTitle(self.window_title())));
                }
            }
        }
        self.close_channel(&name, fx);
        self.tabs.remove(&name);
        self.created_here.remove(&name);
        fx.push(Effect::Kill { name });
        fx.push(Effect::Redraw);
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{has_attach, live, t};
    use super::*;
    use crate::terminal::testkit::session;

    #[test]
    fn refresh_runs_every_10s_only_while_focused() {
        let mut m = live(vec![session("default", 1)]);
        assert!(!m.handle(Msg::Tick, t(9_000)).contains(&Effect::Ls));
        assert!(m.handle(Msg::Tick, t(10_100)).contains(&Effect::Ls));
        m.handle(Msg::Focus(false), t(10_200));
        assert!(!m.handle(Msg::Tick, t(30_000)).contains(&Effect::Ls));
        assert!(m.handle(Msg::Focus(true), t(30_100)).contains(&Effect::Ls));
    }

    #[test]
    fn a_session_from_elsewhere_gets_a_tab_without_attaching() {
        let mut m = live(vec![session("default", 1)]);
        let fx = m.handle(
            Msg::Ls(Ok(vec![session("default", 1), session("phone", 5)])),
            t(100),
        );
        assert!(!has_attach(&fx, "phone"));
        assert_eq!(m.view().tabs.len(), 2);
    }

    #[test]
    fn a_vanished_active_tab_closes_its_channel_and_the_left_neighbor_takes_over() {
        let mut m = live(vec![session("a", 1), session("b", 2), session("c", 3)]);
        m.handle(Msg::SelectTab("b".into()), t(10));
        let fx = m.handle(Msg::Ls(Ok(vec![session("a", 1), session("c", 3)])), t(20));
        assert!(fx.contains(&Effect::Detach { name: "b".into() }));
        assert!(has_attach(&fx, "a"));
        assert_eq!(m.view().header.session, "a");
    }

    #[test]
    fn new_session_prefills_default_then_session_n() {
        let mut m = live(vec![]);
        m.handle(Msg::NewSessionBegin, t(5));
        assert_eq!(m.view().naming.as_deref(), Some("default"));
        let mut m = live(vec![session("default", 1)]);
        m.handle(Msg::NewSessionBegin, t(5));
        assert_eq!(m.view().naming.as_deref(), Some("session-2"));
    }

    #[test]
    fn committing_a_new_name_attaches_it_and_refreshes_after() {
        let mut m = live(vec![session("default", 1)]);
        m.handle(Msg::NewSessionBegin, t(5));
        let fx = m.handle(Msg::NewSessionCommit("build".into()), t(6));
        assert!(has_attach(&fx, "build"));
        assert_eq!(m.view().naming, None);
        assert!(
            m.handle(
                Msg::Attached {
                    name: "build".into()
                },
                t(7)
            )
            .contains(&Effect::Ls)
        );
    }

    #[test]
    fn new_session_survives_early_refresh() {
        let mut m = live(vec![session("default", 1)]);
        m.handle(Msg::NewSessionCommit("build".into()), t(6));
        let fx = m.handle(Msg::Ls(Ok(vec![session("default", 1)])), t(500));
        assert!(!fx.contains(&Effect::Detach {
            name: "build".into()
        }));
        assert_eq!(m.view().header.session, "build");
        // Once zmx reports it, it is an ordinary tab and leaves when zmx drops it.
        m.handle(
            Msg::Ls(Ok(vec![session("default", 1), session("build", 9)])),
            t(1_000),
        );
        let fx = m.handle(Msg::Ls(Ok(vec![session("default", 1)])), t(2_000));
        assert!(fx.contains(&Effect::Detach {
            name: "build".into()
        }));
    }

    #[test]
    fn an_existing_name_selects_that_tab() {
        let mut m = live(vec![session("default", 1), session("build", 2)]);
        let fx = m.handle(Msg::NewSessionCommit("build".into()), t(6));
        assert!(has_attach(&fx, "build"));
        assert_eq!(m.view().tabs.len(), 2);
    }

    #[test]
    fn empty_or_blank_name_cancels() {
        let mut m = live(vec![session("default", 1)]);
        m.handle(Msg::NewSessionBegin, t(5));
        let fx = m.handle(Msg::NewSessionCommit("   ".into()), t(6));
        assert!(fx.is_empty());
        assert_eq!(m.view().naming, None);
    }

    #[test]
    fn shortcuts_wrap_and_nine_is_last() {
        let mut m = live(vec![session("a", 1), session("b", 2), session("c", 3)]);
        m.handle(Msg::SelectTab("c".into()), t(1));
        m.handle(Msg::TabShortcut(TabJump::Next), t(2));
        assert_eq!(m.view().header.session, "a");
        m.handle(Msg::TabShortcut(TabJump::Prev), t(3));
        assert_eq!(m.view().header.session, "c");
        m.handle(Msg::TabShortcut(TabJump::Position(2)), t(4));
        assert_eq!(m.view().header.session, "b");
        m.handle(Msg::TabShortcut(TabJump::Last), t(5));
        assert_eq!(m.view().header.session, "c");
    }

    #[test]
    fn kill_switches_away_first_then_kills_then_refreshes() {
        let mut m = live(vec![session("a", 1), session("b", 2)]);
        m.handle(Msg::SelectTab("b".into()), t(1));
        m.handle(Msg::KillRequested("b".into()), t(2));
        assert_eq!(m.view().kill_prompt.as_deref(), Some("b"));
        let fx = m.handle(Msg::KillConfirmed, t(3));
        let kill = fx
            .iter()
            .position(|e| *e == Effect::Kill { name: "b".into() })
            .unwrap();
        let switch = fx
            .iter()
            .position(|e| matches!(e, Effect::Ui(UiEffect::SetTitle(s)) if s == "devbox · a"))
            .unwrap();
        assert!(switch < kill);
        assert!(fx.contains(&Effect::Detach { name: "b".into() }));
        assert_eq!(m.handle(Msg::KillDone, t(4)), vec![Effect::Ls]);
    }

    #[test]
    fn killing_the_last_session_leaves_the_empty_state() {
        let mut m = live(vec![session("a", 1)]);
        m.handle(Msg::KillRequested("a".into()), t(2));
        let fx = m.handle(Msg::KillConfirmed, t(3));
        assert!(!fx.iter().any(|e| matches!(e, Effect::Attach { .. })));
        assert!(m.view().empty.is_some());
    }

    #[test]
    fn cancel_leaves_the_session() {
        let mut m = live(vec![session("a", 1)]);
        m.handle(Msg::KillRequested("a".into()), t(2));
        assert!(m.handle(Msg::KillCancelled, t(3)).is_empty());
        assert_eq!(m.view().kill_prompt, None);
    }

    #[test]
    fn the_thirteenth_attach_detaches_the_least_recently_viewed() {
        let sessions: Vec<_> = (0..13).map(|i| session(&format!("s{i:02}"), i)).collect();
        let mut m = live(sessions);
        for i in 0..12 {
            let fx = m.handle(Msg::SelectTab(format!("s{i:02}")), t(10 + i as u64));
            for e in fx {
                if let Effect::Attach { name, .. } = e {
                    m.handle(Msg::Attached { name }, t(10));
                }
            }
        }
        let fx = m.handle(Msg::SelectTab("s12".into()), t(100));
        assert!(fx.iter().any(|e| matches!(e, Effect::Detach { .. })));
        assert!(has_attach(&fx, "s12"));
    }

    #[test]
    fn background_bell_marks_attention_until_viewed() {
        let mut m = live(vec![session("a", 1), session("b", 2)]);
        m.handle(Msg::SelectTab("a".into()), t(1));
        m.handle(Msg::SelectTab("b".into()), t(2));
        m.handle(Msg::Attached { name: "b".into() }, t(2));
        m.handle(Msg::SelectTab("a".into()), t(3));
        m.handle(
            Msg::PtyData {
                name: "b".into(),
                bytes: b"\x07".to_vec(),
            },
            t(4),
        );
        assert!(
            m.view()
                .tabs
                .iter()
                .find(|t| t.name == "b")
                .unwrap()
                .attention
        );
        m.handle(Msg::SelectTab("b".into()), t(5));
        assert!(
            !m.view()
                .tabs
                .iter()
                .find(|t| t.name == "b")
                .unwrap()
                .attention
        );
    }

    #[test]
    fn plain_output_never_marks_a_tab() {
        let mut m = live(vec![session("a", 1), session("b", 2)]);
        m.handle(Msg::SelectTab("b".into()), t(1));
        m.handle(Msg::Attached { name: "b".into() }, t(1));
        m.handle(Msg::SelectTab("a".into()), t(2));
        m.handle(
            Msg::PtyData {
                name: "b".into(),
                bytes: b"12:00:01\r".to_vec(),
            },
            t(3),
        );
        assert!(
            !m.view()
                .tabs
                .iter()
                .find(|t| t.name == "b")
                .unwrap()
                .attention
        );
    }
}
