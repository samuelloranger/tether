use super::*;
use tether_core::osc::Notification;
use tether_term::TermEvent;

impl TerminalModel {
    pub(crate) fn on_pty_data(
        &mut self,
        name: &str,
        bytes: &[u8],
        now: Duration,
        fx: &mut Vec<Effect>,
    ) {
        let Some(tab) = self.tabs.get_mut(name) else {
            return;
        };
        let events = tab.term.feed(bytes);
        let active = self.active_name() == Some(name);
        for ev in events {
            self.on_term_event(name, ev, active, now, fx);
        }
        if active {
            fx.push(Effect::Redraw);
        }
    }

    pub(crate) fn on_term_event(
        &mut self,
        name: &str,
        ev: TermEvent,
        active: bool,
        now: Duration,
        fx: &mut Vec<Effect>,
    ) {
        match ev {
            TermEvent::Bell => {
                let rang = self
                    .tabs
                    .get_mut(name)
                    .map(|t| t.bell.should_ring(now))
                    .unwrap_or(false);
                if !rang {
                    return;
                }
                if active {
                    fx.push(Effect::Ui(UiEffect::LampFlash));
                } else if let Some(strip) = self.strip.as_mut() {
                    strip.mark_attention(name);
                }
                if !self.focused {
                    fx.push(Effect::Ui(UiEffect::FlashTaskbar));
                }
            }
            TermEvent::Reply(bytes) => {
                if self.is_live(name) {
                    fx.push(Effect::Write {
                        name: name.to_string(),
                        bytes,
                    });
                }
            }
            _ => self.on_report_event(name, ev, active, now, fx),
        }
    }

    pub(crate) fn on_report_event(
        &mut self,
        name: &str,
        ev: TermEvent,
        active: bool,
        now: Duration,
        fx: &mut Vec<Effect>,
    ) {
        use tether_core::throttle::{ToastDecision, wants_toast};

        match ev {
            TermEvent::Title(title) => {
                if let Some(tab) = self.tabs.get_mut(name) {
                    tab.osc_title = title;
                }
                if active {
                    fx.push(Effect::Ui(UiEffect::SetTitle(self.window_title())));
                }
            }
            TermEvent::Clipboard(text) => {
                if self.focused {
                    fx.push(Effect::Ui(UiEffect::SetClipboard(text)));
                }
            }
            TermEvent::Notify(n) => {
                if !active {
                    if let Some(strip) = self.strip.as_mut() {
                        strip.mark_attention(name);
                    }
                }
                if wants_toast(self.focused, active) {
                    if let ToastDecision::Show(n) = self.toasts.offer(name, n, now) {
                        self.push_toast(name, n, fx);
                    }
                }
            }
            TermEvent::ProgressChanged => {
                if active {
                    let p = self.tabs.get(name).and_then(|t| t.term.reports().progress);
                    fx.push(Effect::Ui(UiEffect::Taskbar(p)));
                }
            }
            TermEvent::CwdChanged | TermEvent::Bell | TermEvent::Reply(_) => {}
        }
    }

    fn push_toast(&self, session: &str, n: Notification, fx: &mut Vec<Effect>) {
        let body = match n.title {
            Some(t) if !t.is_empty() => format!("{t}\n{}", n.body),
            _ => n.body,
        };
        fx.push(Effect::Ui(UiEffect::Toast {
            machine: self.machine.id.to_string(),
            session: session.into(),
            title: format!("{} · {}", self.machine.name, session),
            body,
        }));
    }

    pub(crate) fn toast_due(&mut self, now: Duration, fx: &mut Vec<Effect>) {
        use tether_core::throttle::wants_toast;

        for (session, n) in self.toasts.poll(now) {
            let active = self.active_name() == Some(session.as_str());
            if wants_toast(self.focused, active) {
                self.push_toast(&session, n, fx);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{live, t};
    use super::*;
    use crate::terminal::testkit::session;
    use tether_core::osc::{Progress, ProgressState};

    fn two() -> TerminalModel {
        let mut m = live(vec![session("a", 1), session("b", 2)]);
        m.handle(Msg::Attached { name: "b".into() }, t(1));
        m.handle(Msg::SelectTab("a".into()), t(2));
        m.handle(Msg::Attached { name: "a".into() }, t(2));
        m
    }

    fn feed(m: &mut TerminalModel, tab: &str, bytes: &[u8], ms: u64) -> Vec<Effect> {
        m.handle(
            Msg::PtyData {
                name: tab.into(),
                bytes: bytes.to_vec(),
            },
            t(ms),
        )
    }

    fn toasts(fx: &[Effect]) -> Vec<(String, String, String)> {
        fx.iter()
            .filter_map(|e| match e {
                Effect::Ui(UiEffect::Toast {
                    session,
                    title,
                    body,
                    ..
                }) => Some((session.clone(), title.clone(), body.clone())),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn the_osc_title_follows_the_active_tab_only() {
        let mut m = two();
        let fx = feed(&mut m, "a", b"\x1b]2;vim README\x07", 10);
        assert!(fx.contains(&Effect::Ui(UiEffect::SetTitle(
            "devbox · a · vim README".into()
        ))));
        let fx = feed(&mut m, "b", b"\x1b]2;htop\x07", 11);
        assert!(
            !fx.iter()
                .any(|e| matches!(e, Effect::Ui(UiEffect::SetTitle(_))))
        );
        let fx = m.handle(Msg::SelectTab("b".into()), t(12));
        assert!(fx.contains(&Effect::Ui(UiEffect::SetTitle("devbox · b · htop".into()))));
    }

    #[test]
    fn osc52_copies_only_while_the_window_has_focus() {
        let mut m = two();
        assert!(
            feed(&mut m, "a", b"\x1b]52;c;aGVsbG8=\x07", 10)
                .contains(&Effect::Ui(UiEffect::SetClipboard("hello".into())))
        );
        m.handle(Msg::Focus(false), t(11));
        assert!(
            !feed(&mut m, "a", b"\x1b]52;c;aGVsbG8=\x07", 12)
                .iter()
                .any(|e| matches!(e, Effect::Ui(UiEffect::SetClipboard(_))))
        );
    }

    #[test]
    fn a_background_notification_toasts_and_marks_the_tab() {
        let mut m = two();
        let fx = feed(&mut m, "b", b"\x1b]9;build done\x07", 10);
        assert_eq!(
            toasts(&fx),
            vec![("b".into(), "devbox · b".into(), "build done".into())]
        );
        assert!(
            m.view()
                .tabs
                .iter()
                .find(|t| t.name == "b")
                .unwrap()
                .attention
        );
    }

    #[test]
    fn osc777_carries_its_title_into_the_body() {
        let mut m = two();
        let fx = feed(&mut m, "b", b"\x1b]777;notify;Claude;Needs you\x07", 10);
        assert_eq!(toasts(&fx)[0].2, "Claude\nNeeds you");
    }

    #[test]
    fn osc_9_4_is_progress_never_a_toast() {
        let mut m = two();
        let fx = feed(&mut m, "a", b"\x1b]9;4;1;50\x07", 10);
        assert!(toasts(&fx).is_empty());
        assert!(fx.contains(&Effect::Ui(UiEffect::Taskbar(Some(Progress {
            state: ProgressState::Normal,
            percent: 50
        })))));
    }

    #[test]
    fn the_focused_active_tab_gets_no_toast_but_an_unfocused_one_does() {
        let mut m = two();
        assert!(toasts(&feed(&mut m, "a", b"\x1b]9;hi\x07", 10)).is_empty());
        m.handle(Msg::Focus(false), t(11));
        assert_eq!(toasts(&feed(&mut m, "a", b"\x1b]9;hi\x07", 12)).len(), 1);
    }

    #[test]
    fn toasts_throttle_per_session_and_the_latest_pending_one_wins() {
        let mut m = two();
        assert_eq!(toasts(&feed(&mut m, "b", b"\x1b]9;one\x07", 0)).len(), 1);
        assert!(toasts(&feed(&mut m, "b", b"\x1b]9;two\x07", 1_000)).is_empty());
        assert!(toasts(&feed(&mut m, "b", b"\x1b]9;three\x07", 2_000)).is_empty());
        assert!(toasts(&m.handle(Msg::Tick, t(4_900))).is_empty());
        let later = toasts(&m.handle(Msg::Tick, t(5_100)));
        assert_eq!(
            later,
            vec![("b".into(), "devbox · b".into(), "three".into())]
        );
    }

    #[test]
    fn viewing_the_tab_drops_its_pending_toast() {
        let mut m = two();
        feed(&mut m, "b", b"\x1b]9;one\x07", 0);
        feed(&mut m, "b", b"\x1b]9;two\x07", 1_000);
        m.handle(Msg::SelectTab("b".into()), t(2_000));
        assert!(toasts(&m.handle(Msg::Tick, t(6_000))).is_empty());
    }

    #[test]
    fn progress_drives_the_taskbar_and_a_prompt_clears_it() {
        let mut m = two();
        assert!(
            feed(&mut m, "a", b"\x1b]9;4;2;30\x07", 10).contains(&Effect::Ui(UiEffect::Taskbar(
                Some(Progress {
                    state: ProgressState::Error,
                    percent: 30
                })
            )))
        );
        assert!(
            feed(&mut m, "a", b"\x1b]133;A\x07", 11).contains(&Effect::Ui(UiEffect::Taskbar(None)))
        );
    }

    #[test]
    fn background_progress_stays_on_its_tab() {
        let mut m = two();
        let fx = feed(&mut m, "b", b"\x1b]9;4;1;70\x07", 10);
        assert!(
            !fx.iter()
                .any(|e| matches!(e, Effect::Ui(UiEffect::Taskbar(_))))
        );
        assert_eq!(
            m.view()
                .tabs
                .iter()
                .find(|t| t.name == "b")
                .unwrap()
                .progress,
            Some(Progress {
                state: ProgressState::Normal,
                percent: 70
            })
        );
        assert!(
            m.handle(Msg::SelectTab("b".into()), t(11))
                .contains(&Effect::Ui(UiEffect::Taskbar(Some(Progress {
                    state: ProgressState::Normal,
                    percent: 70
                }))))
        );
    }

    #[test]
    fn a_bell_burst_rings_once_and_flashes_the_taskbar_when_unfocused() {
        let mut m = two();
        m.handle(Msg::Focus(false), t(5));
        let fx = feed(&mut m, "a", b"\x07\x07\x07", 10);
        assert_eq!(
            fx.iter()
                .filter(|e| **e == Effect::Ui(UiEffect::LampFlash))
                .count(),
            1
        );
        assert!(fx.contains(&Effect::Ui(UiEffect::FlashTaskbar)));
        assert!(!feed(&mut m, "a", b"\x07", 100).contains(&Effect::Ui(UiEffect::LampFlash)));
        assert!(feed(&mut m, "a", b"\x07", 400).contains(&Effect::Ui(UiEffect::LampFlash)));
    }

    #[test]
    fn a_toast_click_brings_the_window_forward_on_that_tab() {
        let mut m = two();
        let fx = m.handle(
            Msg::ToastClicked {
                machine: m.machine.id.to_string(),
                name: "b".into(),
            },
            t(10),
        );
        assert!(fx.contains(&Effect::Ui(UiEffect::BringToFront)));
        assert_eq!(m.view().header.session, "b");
        let fx = m.handle(
            Msg::ToastClicked {
                machine: "other-machine".into(),
                name: "a".into(),
            },
            t(11),
        );
        assert!(fx.contains(&Effect::Ui(UiEffect::BringToFront)));
        assert_eq!(m.view().header.session, "b");
    }
}
