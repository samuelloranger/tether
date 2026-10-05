use super::*;
use crate::terminal::geometry::{layout, TermStyle};
use crate::terminal::mouse::MouseMsg;

impl TerminalModel {
    pub(crate) fn on_modifiers(&mut self, _mods: Mods, _fx: &mut Vec<Effect>) {}
    pub(crate) fn on_key(
        &mut self,
        _input: &KeyInput,
        _mods: Mods,
        _now: Duration,
        _fx: &mut Vec<Effect>,
    ) {
    }
    pub(crate) fn on_paste(
        &mut self,
        _clip: ClipboardSnapshot,
        _now_unix: i64,
        _fx: &mut Vec<Effect>,
    ) {
    }
    pub(crate) fn on_mouse(&mut self, _m: MouseMsg, _fx: &mut Vec<Effect>) {}
    pub(crate) fn on_wheel(
        &mut self,
        _delta_px: f32,
        _mods: Mods,
        _x_px: f32,
        _y_px: f32,
        _fx: &mut Vec<Effect>,
    ) {
    }

    pub(crate) fn on_well_resized(
        &mut self,
        w: u32,
        h: u32,
        scale: f32,
        now: Duration,
        fx: &mut Vec<Effect>,
    ) {
        self.well_px = Some((w, h, scale));
        self.relayout(now, fx);
    }

    pub(crate) fn on_style(&mut self, style: TermStyle, now: Duration, fx: &mut Vec<Effect>) {
        if !std::ptr::eq(style.theme, self.style.theme) {
            // M4 keeps each tab's OSC 4 overrides across a theme change.
            for tab in self.tabs.values_mut() {
                tab.term.set_theme(style.theme);
            }
        }
        self.style = style;
        self.relayout(now, fx);
    }

    /// Every grid redraws at the new size at once. The PTYs hear about it once the
    /// size has been quiet for the settle window, so a drag doesn't cause a SIGWINCH storm.
    fn relayout(&mut self, now: Duration, fx: &mut Vec<Effect>) {
        if let Some((w, h, scale)) = self.well_px {
            let l = layout(w, h, scale, &self.style);
            self.layout = Some(l);
            if l.size != self.size {
                self.size = l.size;
                for tab in self.tabs.values_mut() {
                    tab.term.resize(l.size);
                }
                self.resize.on_size(l.size, now);
            }
        }
        fx.push(Effect::Redraw);
    }
}

#[cfg(test)]
mod resize_tests {
    use super::super::tests::{live, t};
    use super::*;
    use crate::terminal::testkit::session;
    use tether_core::resize::GridSize;

    fn resizes(fx: &[Effect]) -> Vec<GridSize> {
        fx.iter()
            .filter_map(|e| match e {
                Effect::ResizeAll(s) => Some(*s),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn resize_steps_redraw_locally_and_resize_the_pty_once() {
        let mut m = live(vec![session("a", 1)]);
        for (i, w) in [1000u32, 1040, 1080, 1120].iter().enumerate() {
            let fx = m.handle(
                Msg::WellResized {
                    width_px: *w,
                    height_px: 700,
                    scale: 1.0,
                },
                t(30 * i as u64),
            );
            assert!(fx.contains(&Effect::Redraw));
            assert!(resizes(&fx).is_empty());
        }
        assert!(resizes(&m.handle(Msg::Tick, t(200))).is_empty());
        let sent = resizes(&m.handle(Msg::Tick, t(260)));
        assert_eq!(sent, vec![m.layout().unwrap().size]);
        assert!(resizes(&m.handle(Msg::Tick, t(400))).is_empty());
    }

    #[test]
    fn scale_change_recomputes_px_and_resizes_once() {
        let mut m = live(vec![session("a", 1)]);
        m.handle(
            Msg::WellResized {
                width_px: 1600,
                height_px: 1000,
                scale: 1.0,
            },
            t(0),
        );
        m.handle(Msg::Tick, t(200));
        let before = m.layout().unwrap();
        // Moving to a 200% monitor reports the new scale and then the new size, in quick steps.
        m.handle(
            Msg::WellResized {
                width_px: 1600,
                height_px: 1000,
                scale: 2.0,
            },
            t(1_000),
        );
        m.handle(
            Msg::WellResized {
                width_px: 3200,
                height_px: 2000,
                scale: 2.0,
            },
            t(1_020),
        );
        let after = m.layout().unwrap();
        assert!((after.size_px - 2.0 * before.size_px).abs() < 0.01);
        let mut sent = Vec::new();
        for ms in (1_050..1_600).step_by(50) {
            sent.extend(resizes(&m.handle(Msg::Tick, t(ms))));
        }
        assert_eq!(sent, vec![after.size]);
    }

    #[test]
    fn a_bigger_font_resizes_after_the_settle() {
        let mut m = live(vec![session("a", 1)]);
        m.handle(
            Msg::WellResized {
                width_px: 1600,
                height_px: 1000,
                scale: 1.0,
            },
            t(0),
        );
        m.handle(Msg::Tick, t(200));
        let cols = m.layout().unwrap().size.cols;
        let mut style = TermStyle::default();
        style.size_pt = 20.0;
        m.handle(Msg::StyleChanged(style), t(1_000));
        assert!(m.layout().unwrap().size.cols < cols);
        assert_eq!(resizes(&m.handle(Msg::Tick, t(1_200))).len(), 1);
    }

    #[test]
    fn a_theme_change_redraws_without_a_resize() {
        let mut m = live(vec![session("a", 1)]);
        m.handle(
            Msg::WellResized {
                width_px: 1600,
                height_px: 1000,
                scale: 1.0,
            },
            t(0),
        );
        m.handle(Msg::Tick, t(200));
        let mut style = TermStyle::default();
        style.theme = tether_core::theme::theme_named("dracula");
        let fx = m.handle(Msg::StyleChanged(style), t(1_000));
        assert!(fx.contains(&Effect::Redraw));
        assert!(resizes(&m.handle(Msg::Tick, t(1_300))).is_empty());
    }

    #[test]
    fn a_new_channel_opens_at_the_current_size() {
        let mut m = live(vec![session("a", 1), session("b", 2)]);
        m.handle(
            Msg::WellResized {
                width_px: 1600,
                height_px: 1000,
                scale: 1.0,
            },
            t(0),
        );
        let size = m.layout().unwrap().size;
        let fx = m.handle(Msg::SelectTab("a".into()), t(10));
        assert!(fx.iter().any(|e| matches!(e, Effect::Attach { size: s, .. } if *s == size)));
    }
}
