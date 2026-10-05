use super::*;
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
        _name: &str,
        _ev: TermEvent,
        _active: bool,
        _now: Duration,
        _fx: &mut Vec<Effect>,
    ) {
    }
}
