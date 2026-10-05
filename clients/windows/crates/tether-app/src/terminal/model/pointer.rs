use super::*;
use crate::terminal::geometry::cell_at;
use crate::terminal::mouse::{Button, MouseKind, MouseMsg, encode_mouse, encode_wheel};
use tether_core::keymap::{KeyAction, KeyInput, NamedKey, encode_key};
use tether_core::links::{LinkSpan, detect_links, is_openable, link_at};
use tether_term::{Cell, MouseTracking, SelectKind};

impl TerminalModel {
    /// OSC 8 wins over text that only looks like a link.
    fn link_under(&self, cell: Cell) -> Option<(LinkSpan, bool)> {
        let snap = self
            .active_name()
            .and_then(|n| self.tabs.get(n))?
            .term
            .snapshot();
        if let Some(span) = link_at(&snap.osc8, cell.row, cell.col) {
            return Some((span.clone(), true));
        }
        let detected = detect_links(&snap.row_texts, &snap.wrapped, Some(snap.cols));
        link_at(&detected, cell.row, cell.col).map(|s| (s.clone(), false))
    }

    fn set_hover(&mut self, hover: Option<(LinkSpan, bool, usize)>, fx: &mut Vec<Effect>) {
        let next = hover.as_ref().map(|(s, _, row)| (*row, s.start, s.end));
        if next == self.hover {
            return;
        }
        self.hover = next;
        fx.push(Effect::Ui(UiEffect::Pointer(if next.is_some() {
            PointerShape::Hand
        } else {
            PointerShape::Text
        })));
        fx.push(Effect::Ui(UiEffect::Tooltip(
            hover.and_then(|(s, explicit, _)| explicit.then_some(s.url)),
        )));
        fx.push(Effect::Redraw);
    }

    pub(crate) fn refresh_hover(&mut self, fx: &mut Vec<Effect>) {
        match (self.mods.ctrl, self.pointer.cell) {
            (true, Some(cell)) => {
                let hover = self.link_under(cell).map(|(s, e)| (s, e, cell.row));
                self.set_hover(hover, fx);
            }
            _ if self.hover.is_some() => self.set_hover(None, fx),
            _ => {}
        }
    }

    pub(crate) fn on_mouse(&mut self, m: MouseMsg, fx: &mut Vec<Effect>) {
        let Some(l) = self.layout else {
            return;
        };
        let Some(name) = self.active_name().map(str::to_string) else {
            return;
        };
        let cell = cell_at(&l, m.x_px, m.y_px);
        let prev = self.pointer.cell;
        self.pointer.cell = Some(cell);
        self.mods = m.mods;
        match m.kind {
            MouseKind::Down => self.pointer.held = Some(m.button),
            MouseKind::Up | MouseKind::Cancel => self.pointer.held = None,
            MouseKind::Move => {}
        }
        if m.mods.ctrl {
            let link = self.link_under(cell);
            self.set_hover(link.clone().map(|(s, e)| (s, e, cell.row)), fx);
            if m.kind == MouseKind::Down && m.button == Button::Left {
                if let Some((span, _)) = link.filter(|(s, _)| is_openable(&s.url)) {
                    fx.push(Effect::Ui(UiEffect::OpenUrl(span.url)));
                }
            }
            return;
        } else if self.hover.is_some() {
            self.set_hover(None, fx);
        }
        let Some(tab) = self.tabs.get_mut(&name) else {
            return;
        };
        let mode = tab.term.mouse_mode();
        if mode.tracking != MouseTracking::None && !m.mods.shift {
            if m.kind == MouseKind::Move && prev == Some(cell) {
                return;
            }
            if let Some(bytes) =
                encode_mouse(mode, m.kind, m.button, cell, m.mods, self.pointer.held)
            {
                self.write_active(bytes, fx);
            }
            return;
        }
        match (m.kind, m.button) {
            (MouseKind::Down, Button::Left) => {
                let kind = match self.pointer.clicks.press(m.at_ms, cell) {
                    1 => SelectKind::Simple,
                    2 => SelectKind::Word,
                    _ => SelectKind::Line,
                };
                tab.term.selection_start(cell, kind);
                self.pointer.held = Some(Button::Left);
                fx.push(Effect::Redraw);
            }
            (MouseKind::Move, _) if self.pointer.held == Some(Button::Left) => {
                tab.term.selection_update(cell);
                fx.push(Effect::Redraw);
            }
            (MouseKind::Up | MouseKind::Cancel, Button::Left) => {}
            (MouseKind::Down, Button::Right) => {
                let selected = tab.term.selection_text();
                if let Some((span, _)) = self.link_under(cell) {
                    fx.push(Effect::Ui(UiEffect::Menu(MenuRequest::Link {
                        url: span.url,
                        copy_selection: selected.is_some(),
                    })));
                } else if let Some(text) = selected {
                    fx.push(Effect::Ui(UiEffect::SetClipboard(text)));
                    if let Some(tab) = self.tabs.get_mut(&name) {
                        tab.term.clear_selection();
                    }
                    fx.push(Effect::Redraw);
                } else {
                    fx.push(Effect::Ui(UiEffect::ReadClipboard));
                }
            }
            _ => {}
        }
    }

    pub(crate) fn on_wheel(
        &mut self,
        delta_px: f32,
        mods: Mods,
        x_px: f32,
        y_px: f32,
        fx: &mut Vec<Effect>,
    ) {
        if mods.ctrl {
            if delta_px == 0.0 {
                return;
            }
            self.pointer.ctrl_wheel += delta_px;
            let steps = (self.pointer.ctrl_wheel / 120.0).trunc() as i32;
            if steps == 0 {
                return;
            }
            self.pointer.ctrl_wheel -= steps as f32 * 120.0;
            let step = if steps > 0 {
                FontStep::Bigger
            } else {
                FontStep::Smaller
            };
            for _ in 0..steps.unsigned_abs() {
                fx.push(Effect::Ui(UiEffect::FontStep(step)));
            }
            return;
        }
        let Some(l) = self.layout else {
            return;
        };
        let Some(name) = self.active_name().map(str::to_string) else {
            return;
        };
        self.pointer.wheel_acc += delta_px / l.cell_h;
        let lines = self.pointer.wheel_acc.trunc() as i32;
        if lines == 0 {
            return;
        }
        self.pointer.wheel_acc -= lines as f32;
        let cell = cell_at(&l, x_px, y_px);
        let Some(tab) = self.tabs.get_mut(&name) else {
            return;
        };
        let mode = tab.term.mouse_mode();
        let ctx = tab.term.context();
        let mut out = Vec::new();
        if mode.tracking != MouseTracking::None && !mods.shift {
            for _ in 0..lines.abs() {
                out.extend(encode_wheel(mode, lines > 0, cell, mods));
            }
        } else if ctx.alt_screen {
            let key = KeyInput::Named(if lines > 0 {
                NamedKey::Up
            } else {
                NamedKey::Down
            });
            for _ in 0..lines.abs() {
                if let KeyAction::Send(b) = encode_key(&key, Mods::default(), &ctx) {
                    out.push(b);
                }
            }
        } else {
            tab.term.scroll(lines);
            fx.push(Effect::Redraw);
        }
        for bytes in out {
            self.write_active(bytes, fx);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{live, t};
    use super::*;
    use crate::terminal::mouse::{Button, MouseKind, MouseMsg};
    use crate::terminal::testkit::session;

    const NONE: Mods = Mods {
        shift: false,
        alt: false,
        ctrl: false,
    };
    const CTRL: Mods = Mods {
        shift: false,
        alt: false,
        ctrl: true,
    };
    const SHIFT: Mods = Mods {
        shift: true,
        alt: false,
        ctrl: false,
    };

    fn ready(bytes: &[u8]) -> TerminalModel {
        let mut m = live(vec![session("a", 1)]);
        m.handle(
            Msg::WellResized {
                width_px: 800,
                height_px: 600,
                scale: 1.0,
            },
            t(1),
        );
        m.handle(
            Msg::PtyData {
                name: "a".into(),
                bytes: bytes.to_vec(),
            },
            t(2),
        );
        m
    }

    fn at(m: &TerminalModel, row: usize, col: usize) -> (f32, f32) {
        let l = m.layout().unwrap();
        let top = l.height_px as f32 - l.padding_px as f32 - l.size.rows as f32 * l.cell_h;
        (
            l.padding_px as f32 + (col as f32 + 0.5) * l.cell_w,
            top + (row as f32 + 0.5) * l.cell_h,
        )
    }

    fn mouse(
        m: &mut TerminalModel,
        kind: MouseKind,
        button: Button,
        row: usize,
        col: usize,
        mods: Mods,
        at_ms: u64,
    ) -> Vec<Effect> {
        let (x, y) = at(m, row, col);
        m.handle(
            Msg::Mouse(MouseMsg {
                kind,
                button,
                mods,
                x_px: x,
                y_px: y,
                at_ms,
            }),
            t(at_ms),
        )
    }

    fn writes(fx: &[Effect]) -> Vec<Vec<u8>> {
        fx.iter()
            .filter_map(|e| match e {
                Effect::Write { bytes, .. } => Some(bytes.clone()),
                _ => None,
            })
            .collect()
    }

    fn selection(m: &TerminalModel) -> Option<String> {
        m.tabs["a"].term.selection_text()
    }

    #[test]
    fn drag_selects_locally() {
        let mut m = ready(b"hello world");
        mouse(&mut m, MouseKind::Down, Button::Left, 0, 0, NONE, 10);
        mouse(&mut m, MouseKind::Move, Button::None, 0, 4, NONE, 20);
        mouse(&mut m, MouseKind::Up, Button::Left, 0, 4, NONE, 30);
        assert_eq!(selection(&m).as_deref(), Some("hello"));
    }

    #[test]
    fn double_click_selects_a_word_and_triple_a_line() {
        let mut m = ready(b"hello world");
        mouse(&mut m, MouseKind::Down, Button::Left, 0, 7, NONE, 10);
        mouse(&mut m, MouseKind::Down, Button::Left, 0, 7, NONE, 100);
        assert_eq!(selection(&m).as_deref(), Some("world"));
        mouse(&mut m, MouseKind::Down, Button::Left, 0, 7, NONE, 200);
        assert_eq!(
            selection(&m).map(|s| s.trim_end().to_string()).as_deref(),
            Some("hello world")
        );
    }

    #[test]
    fn reporting_sends_clicks_to_the_program_and_shift_selects_locally() {
        let mut m = ready(b"\x1b[?1000h\x1b[?1006hhello");
        let fx = mouse(&mut m, MouseKind::Down, Button::Left, 0, 1, NONE, 10);
        assert_eq!(writes(&fx), vec![b"\x1b[<0;2;1M".to_vec()]);
        mouse(&mut m, MouseKind::Up, Button::Left, 0, 1, NONE, 20);
        assert_eq!(selection(&m), None);
        let fx = mouse(&mut m, MouseKind::Down, Button::Left, 0, 0, SHIFT, 1_000);
        assert!(writes(&fx).is_empty());
        mouse(&mut m, MouseKind::Move, Button::None, 0, 4, SHIFT, 1_010);
        assert_eq!(selection(&m).as_deref(), Some("hello"));
    }

    #[test]
    fn ctrl_click_opens_a_link_and_is_never_reported() {
        let mut m = ready(b"\x1b[?1000h\x1b[?1006hsee https://example.com/x now");
        let fx = mouse(&mut m, MouseKind::Down, Button::Left, 0, 10, CTRL, 10);
        assert!(fx.contains(&Effect::Ui(UiEffect::OpenUrl(
            "https://example.com/x".into()
        ))));
        assert!(writes(&fx).is_empty());
    }

    #[test]
    fn only_http_https_and_mailto_open() {
        let mut m = ready(b"\x1b]8;;file:///etc/passwd\x07click\x1b]8;;\x07");
        let fx = mouse(&mut m, MouseKind::Down, Button::Left, 0, 1, CTRL, 10);
        assert!(
            !fx.iter()
                .any(|e| matches!(e, Effect::Ui(UiEffect::OpenUrl(_))))
        );
    }

    #[test]
    fn ctrl_hover_shows_a_hand_and_the_osc8_target_and_releasing_ctrl_clears_it() {
        let mut m = ready(b"\x1b]8;;https://a.example/\x07click\x1b]8;;\x07");
        let fx = mouse(&mut m, MouseKind::Move, Button::None, 0, 2, CTRL, 10);
        assert!(fx.contains(&Effect::Ui(UiEffect::Pointer(PointerShape::Hand))));
        assert!(fx.contains(&Effect::Ui(UiEffect::Tooltip(Some(
            "https://a.example/".into()
        )))));
        let fx = m.handle(Msg::Modifiers(NONE), t(20));
        assert!(fx.contains(&Effect::Ui(UiEffect::Pointer(PointerShape::Text))));
        assert!(fx.contains(&Effect::Ui(UiEffect::Tooltip(None))));
    }

    #[test]
    fn pressing_ctrl_over_a_detected_link_underlines_it_without_a_tooltip() {
        let mut m = ready(b"go https://example.com/x");
        mouse(&mut m, MouseKind::Move, Button::None, 0, 8, NONE, 10);
        let fx = m.handle(Msg::Modifiers(CTRL), t(20));
        assert!(fx.contains(&Effect::Ui(UiEffect::Pointer(PointerShape::Hand))));
        assert!(fx.contains(&Effect::Ui(UiEffect::Tooltip(None))));
        assert_eq!(m.hover, Some((0, 3, 24)));
    }

    #[test]
    fn right_click_pastes_without_a_selection_and_copies_with_one() {
        let mut m = ready(b"hello");
        assert!(
            mouse(&mut m, MouseKind::Down, Button::Right, 0, 0, NONE, 10)
                .contains(&Effect::Ui(UiEffect::ReadClipboard))
        );
        mouse(&mut m, MouseKind::Down, Button::Left, 0, 0, NONE, 1_000);
        mouse(&mut m, MouseKind::Move, Button::None, 0, 4, NONE, 1_010);
        mouse(&mut m, MouseKind::Up, Button::Left, 0, 4, NONE, 1_020);
        let fx = mouse(&mut m, MouseKind::Down, Button::Right, 0, 0, NONE, 2_000);
        assert!(fx.contains(&Effect::Ui(UiEffect::SetClipboard("hello".into()))));
        assert_eq!(selection(&m), None);
    }

    #[test]
    fn right_click_on_a_link_offers_copy_link() {
        let mut m = ready(b"go https://example.com/x");
        let fx = mouse(&mut m, MouseKind::Down, Button::Right, 0, 8, NONE, 10);
        assert!(fx.contains(&Effect::Ui(UiEffect::Menu(MenuRequest::Link {
            url: "https://example.com/x".into(),
            copy_selection: false,
        }))));
    }

    #[test]
    fn the_wheel_scrolls_back_and_sends_arrows_on_the_alternate_screen() {
        let mut m = ready(&b"line\r\n".repeat(200));
        let cell_h = m.layout().unwrap().cell_h;
        let (x, y) = at(&m, 0, 0);
        m.handle(
            Msg::Wheel {
                delta_px: 3.0 * cell_h,
                mods: NONE,
                x_px: x,
                y_px: y,
            },
            t(10),
        );
        assert_eq!(m.tabs["a"].term.display_offset(), 3);
        m.handle(
            Msg::PtyData {
                name: "a".into(),
                bytes: b"\x1b[?1049h".to_vec(),
            },
            t(20),
        );
        let fx = m.handle(
            Msg::Wheel {
                delta_px: 2.0 * cell_h,
                mods: NONE,
                x_px: x,
                y_px: y,
            },
            t(30),
        );
        assert_eq!(writes(&fx), vec![b"\x1b[A".to_vec(), b"\x1b[A".to_vec()]);
    }

    #[test]
    fn the_wheel_goes_to_the_program_under_reporting() {
        let mut m = ready(b"\x1b[?1000h\x1b[?1006h");
        let cell_h = m.layout().unwrap().cell_h;
        let (x, y) = at(&m, 0, 0);
        let fx = m.handle(
            Msg::Wheel {
                delta_px: -cell_h,
                mods: NONE,
                x_px: x,
                y_px: y,
            },
            t(10),
        );
        assert_eq!(writes(&fx), vec![b"\x1b[<65;1;1M".to_vec()]);
    }

    #[test]
    fn ctrl_wheel_steps_once_per_120_and_ignores_zero() {
        let mut m = ready(b"");
        let none = m.handle(
            Msg::Wheel {
                delta_px: 0.0,
                mods: CTRL,
                x_px: 10.0,
                y_px: 10.0,
            },
            t(10),
        );
        assert!(
            !none
                .iter()
                .any(|e| matches!(e, Effect::Ui(UiEffect::FontStep(_))))
        );
        let partial = m.handle(
            Msg::Wheel {
                delta_px: 40.0,
                mods: CTRL,
                x_px: 10.0,
                y_px: 10.0,
            },
            t(11),
        );
        assert!(
            !partial
                .iter()
                .any(|e| matches!(e, Effect::Ui(UiEffect::FontStep(_))))
        );
        let fx = m.handle(
            Msg::Wheel {
                delta_px: 80.0,
                mods: CTRL,
                x_px: 10.0,
                y_px: 10.0,
            },
            t(12),
        );
        assert_eq!(
            fx.iter()
                .filter(|e| matches!(e, Effect::Ui(UiEffect::FontStep(FontStep::Bigger))))
                .count(),
            1
        );
    }

    #[test]
    fn ctrl_down_records_the_held_button() {
        let mut m = ready(b"hello world");
        mouse(&mut m, MouseKind::Down, Button::Left, 0, 0, CTRL, 10);
        assert_eq!(m.pointer.held, Some(Button::Left));
    }

    #[test]
    fn cancel_releases_the_button() {
        let mut m = ready(b"hello world");
        mouse(&mut m, MouseKind::Down, Button::Left, 0, 0, NONE, 10);
        let started = selection(&m);
        mouse(&mut m, MouseKind::Cancel, Button::Left, 0, 1, NONE, 20);
        mouse(&mut m, MouseKind::Move, Button::None, 0, 4, NONE, 30);
        assert_eq!(m.pointer.held, None);
        assert_eq!(selection(&m), started);
    }

    #[test]
    fn motion_is_reported_only_when_the_cell_changes() {
        let mut m = ready(b"\x1b[?1002h\x1b[?1006h");
        let fx = mouse(&mut m, MouseKind::Down, Button::Left, 0, 1, NONE, 10);
        assert_eq!(writes(&fx).len(), 1);
        let (x, y) = at(&m, 0, 1);
        let fx = m.handle(
            Msg::Mouse(MouseMsg {
                kind: MouseKind::Move,
                button: Button::None,
                mods: NONE,
                x_px: x + 0.1,
                y_px: y,
                at_ms: 20,
            }),
            t(20),
        );
        assert!(writes(&fx).is_empty());
        let fx = mouse(&mut m, MouseKind::Move, Button::None, 0, 2, NONE, 30);
        assert_eq!(writes(&fx).len(), 1);
    }
}
