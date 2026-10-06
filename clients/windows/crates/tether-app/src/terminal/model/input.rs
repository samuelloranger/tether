use super::send::SendSource;
use super::*;
use crate::terminal::geometry::{TermStyle, layout};
use tether_core::keymap::{KeyAction, TetherCommand, encode_key};
use tether_core::paste::{PasteAction, paste_action, paste_bytes};

impl TerminalModel {
    pub(crate) fn on_modifiers(&mut self, mods: Mods, fx: &mut Vec<Effect>) {
        self.mods = mods;
        self.refresh_hover(fx);
    }

    pub(crate) fn on_key(
        &mut self,
        input: &KeyInput,
        mods: Mods,
        now: Duration,
        fx: &mut Vec<Effect>,
    ) {
        if self.overlay_open() {
            return;
        }
        self.dismiss_finished_capsule();
        let ctx = self
            .active_name()
            .and_then(|n| self.tabs.get(n))
            .map(|t| t.term.context())
            .unwrap_or_default();
        match encode_key(input, mods, &ctx) {
            KeyAction::Send(bytes) => {
                self.blink_on = true;
                self.blink_at = now;
                let name = self.active_name().map(str::to_string);
                if let Some(tab) = name.as_deref().and_then(|n| self.tabs.get_mut(n)) {
                    tab.term.clear_selection();
                }
                self.snap_active_to_bottom();
                self.write_active(bytes, fx);
                fx.push(Effect::Ui(UiEffect::AllowIme));
                fx.push(Effect::Redraw);
            }
            KeyAction::Tether(cmd) => self.on_command(cmd, mods, fx),
            KeyAction::Ignore => {}
        }
    }

    pub(crate) fn on_command(&mut self, cmd: TetherCommand, mods: Mods, fx: &mut Vec<Effect>) {
        let active = self.active_name().map(str::to_string);
        match cmd {
            TetherCommand::Paste => fx.push(Effect::Ui(UiEffect::ReadClipboard)),
            TetherCommand::Copy => {
                let Some(tab) = active.and_then(|n| self.tabs.get_mut(&n)) else {
                    return;
                };
                if let Some(text) = tab.term.selection_text() {
                    fx.push(Effect::Ui(UiEffect::SetClipboard(text)));
                    if mods.ctrl && !mods.shift {
                        tab.term.clear_selection();
                        fx.push(Effect::Redraw);
                    }
                }
            }
            TetherCommand::FontBigger => fx.push(Effect::Ui(UiEffect::FontStep(FontStep::Bigger))),
            TetherCommand::FontSmaller => {
                fx.push(Effect::Ui(UiEffect::FontStep(FontStep::Smaller)))
            }
            TetherCommand::FontReset => fx.push(Effect::Ui(UiEffect::FontStep(FontStep::Reset))),
            TetherCommand::NextTab => self.on_jump(TabJump::Next, fx),
            TetherCommand::PrevTab => self.on_jump(TabJump::Prev, fx),
            TetherCommand::TabAt(n) => self.on_jump(TabJump::Position(n), fx),
            TetherCommand::LastTab => self.on_jump(TabJump::Last, fx),
            TetherCommand::NewTab => self.on_new_begin(),
            TetherCommand::Snippets => self.on_palette_open(),
            TetherCommand::History => self.on_history_open(fx),
            TetherCommand::ScrollPageUp | TetherCommand::ScrollPageDown => {
                let rows = self.size.rows as i32;
                let Some(tab) = active.and_then(|n| self.tabs.get_mut(&n)) else {
                    return;
                };
                tab.term.scroll(if cmd == TetherCommand::ScrollPageUp {
                    rows
                } else {
                    -rows
                });
                fx.push(Effect::Redraw);
            }
        }
    }

    pub(crate) fn dismiss_finished_capsule(&mut self) {
        if self.capsule_shown.is_some() {
            self.capsule_shown = None;
            self.send = None;
        }
    }

    pub(crate) fn snap_active_to_bottom(&mut self) {
        if let Some(name) = self.active_name().map(str::to_string)
            && let Some(tab) = self.tabs.get_mut(&name)
        {
            tab.term.scroll_to_bottom();
        }
    }

    pub(crate) fn on_paste(
        &mut self,
        clip: ClipboardSnapshot,
        now_unix: i64,
        fx: &mut Vec<Effect>,
    ) {
        match paste_action(clip, now_unix) {
            PasteAction::PasteText(text) => {
                let Some(name) = self.active_name().map(str::to_string) else {
                    return;
                };
                let Some(tab) = self.tabs.get_mut(&name) else {
                    return;
                };
                let bytes = paste_bytes(&text, tab.term.bracketed_paste());
                tab.term.scroll_to_bottom();
                self.write_active(bytes, fx);
            }
            PasteAction::UploadImage { name, png } => {
                self.start_send(vec![SendSource::Bytes { name, data: png }], fx);
            }
            PasteAction::SendFiles(paths) => self.on_send_files(paths, fx),
            PasteAction::Nothing => {}
        }
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
        m.handle(
            Msg::StyleChanged(TermStyle {
                size_pt: 20.0,
                ..Default::default()
            }),
            t(1_000),
        );
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
        let fx = m.handle(
            Msg::StyleChanged(TermStyle {
                theme: tether_core::theme::theme_named("dracula"),
                ..Default::default()
            }),
            t(1_000),
        );
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
        assert!(
            fx.iter()
                .any(|e| matches!(e, Effect::Attach { size: s, .. } if *s == size))
        );
    }
}

#[cfg(test)]
mod key_tests {
    use super::super::tests::{live, t};
    use super::*;
    use crate::terminal::testkit::session;
    use tether_core::keymap::{KeyInput, Mods, NamedKey};
    use tether_term::{Cell, SelectKind};

    fn ch(c: char, produced: Option<&str>) -> KeyInput {
        KeyInput::Char {
            unmodified: c,
            produced: produced.map(Into::into),
            digit: None,
        }
    }
    fn digit(d: u8, c: char) -> KeyInput {
        KeyInput::Char {
            unmodified: c,
            produced: Some(c.to_string()),
            digit: Some(d),
        }
    }
    const CTRL: Mods = Mods {
        shift: false,
        alt: false,
        ctrl: true,
    };
    const CTRL_SHIFT: Mods = Mods {
        shift: true,
        alt: false,
        ctrl: true,
    };
    const SHIFT: Mods = Mods {
        shift: true,
        alt: false,
        ctrl: false,
    };

    fn writes(fx: &[Effect]) -> Vec<Vec<u8>> {
        fx.iter()
            .filter_map(|e| match e {
                Effect::Write { bytes, .. } => Some(bytes.clone()),
                _ => None,
            })
            .collect()
    }

    fn select_hello(m: &mut TerminalModel) {
        m.handle(
            Msg::PtyData {
                name: "a".into(),
                bytes: b"hello".to_vec(),
            },
            t(5),
        );
        let tab = m.tabs.get_mut("a").unwrap();
        tab.term
            .selection_start(Cell { row: 0, col: 0 }, SelectKind::Simple);
        tab.term.selection_update(Cell { row: 0, col: 4 });
    }

    #[test]
    fn typing_writes_to_the_active_tab() {
        let mut m = live(vec![session("a", 1)]);
        assert_eq!(
            writes(&m.handle(
                Msg::Key {
                    input: ch('a', Some("a")),
                    mods: Mods::default()
                },
                t(10)
            )),
            vec![b"a".to_vec()]
        );
    }

    #[test]
    fn ctrl_v_reads_the_clipboard_and_never_sends_0x16() {
        let mut m = live(vec![session("a", 1)]);
        for mods in [CTRL, CTRL_SHIFT] {
            let fx = m.handle(
                Msg::Key {
                    input: ch('v', None),
                    mods,
                },
                t(10),
            );
            assert!(fx.contains(&Effect::Ui(UiEffect::ReadClipboard)));
            assert!(writes(&fx).is_empty());
        }
        let fx = m.handle(
            Msg::Key {
                input: KeyInput::Named(NamedKey::Insert),
                mods: SHIFT,
            },
            t(11),
        );
        assert!(fx.contains(&Effect::Ui(UiEffect::ReadClipboard)));
    }

    #[test]
    fn ctrl_c_copies_and_clears_with_a_selection_and_interrupts_without() {
        let mut m = live(vec![session("a", 1)]);
        select_hello(&mut m);
        let fx = m.handle(
            Msg::Key {
                input: ch('c', None),
                mods: CTRL,
            },
            t(10),
        );
        assert!(fx.contains(&Effect::Ui(UiEffect::SetClipboard("hello".into()))));
        assert!(writes(&fx).is_empty());
        let fx = m.handle(
            Msg::Key {
                input: ch('c', None),
                mods: CTRL,
            },
            t(11),
        );
        assert_eq!(writes(&fx), vec![vec![0x03]]);
    }

    #[test]
    fn ctrl_shift_c_copies_and_keeps_the_selection() {
        let mut m = live(vec![session("a", 1)]);
        select_hello(&mut m);
        m.handle(
            Msg::Key {
                input: ch('c', Some("C")),
                mods: CTRL_SHIFT,
            },
            t(10),
        );
        assert_eq!(m.tabs["a"].term.selection_text().as_deref(), Some("hello"));
    }

    #[test]
    fn ctrl_q_reaches_the_pty() {
        let mut m = live(vec![session("a", 1)]);
        assert_eq!(
            writes(&m.handle(
                Msg::Key {
                    input: ch('q', None),
                    mods: CTRL
                },
                t(10)
            )),
            vec![vec![0x11]]
        );
    }

    #[test]
    fn font_shortcuts_step_the_size() {
        let mut m = live(vec![session("a", 1)]);
        assert!(
            m.handle(
                Msg::Key {
                    input: ch('=', Some("=")),
                    mods: CTRL
                },
                t(10)
            )
            .contains(&Effect::Ui(UiEffect::FontStep(FontStep::Bigger)))
        );
        assert!(
            m.handle(
                Msg::Key {
                    input: ch('-', Some("-")),
                    mods: CTRL
                },
                t(11)
            )
            .contains(&Effect::Ui(UiEffect::FontStep(FontStep::Smaller)))
        );
        assert!(
            m.handle(
                Msg::Key {
                    input: digit(0, '0'),
                    mods: CTRL
                },
                t(12)
            )
            .contains(&Effect::Ui(UiEffect::FontStep(FontStep::Reset)))
        );
    }

    #[test]
    fn tab_shortcuts_switch_and_open_the_name_field() {
        let mut m = live(vec![session("a", 1), session("b", 2), session("c", 3)]);
        m.handle(
            Msg::Key {
                input: digit(1, '&'),
                mods: CTRL_SHIFT,
            },
            t(10),
        );
        assert_eq!(m.view().header.session, "a");
        m.handle(
            Msg::Key {
                input: digit(9, 'ç'),
                mods: CTRL_SHIFT,
            },
            t(11),
        );
        assert_eq!(m.view().header.session, "c");
        m.handle(
            Msg::Key {
                input: KeyInput::Named(NamedKey::Tab),
                mods: CTRL,
            },
            t(12),
        );
        assert_eq!(m.view().header.session, "a");
        m.handle(
            Msg::Key {
                input: ch('t', Some("T")),
                mods: CTRL_SHIFT,
            },
            t(13),
        );
        assert_eq!(m.view().naming.as_deref(), Some("session-4"));
    }

    #[test]
    fn ctrl_shift_t_works_on_an_empty_host() {
        let mut m = live(vec![]);
        m.handle(
            Msg::Key {
                input: ch('t', Some("T")),
                mods: CTRL_SHIFT,
            },
            t(10),
        );
        assert_eq!(m.view().naming.as_deref(), Some("default"));
    }

    #[test]
    fn shift_page_up_scrolls_locally_and_typing_snaps_back() {
        let mut m = live(vec![session("a", 1)]);
        m.handle(
            Msg::PtyData {
                name: "a".into(),
                bytes: b"line\r\n".repeat(200),
            },
            t(5),
        );
        let fx = m.handle(
            Msg::Key {
                input: KeyInput::Named(NamedKey::PageUp),
                mods: SHIFT,
            },
            t(10),
        );
        assert!(writes(&fx).is_empty());
        assert!(m.tabs["a"].term.display_offset() > 0);
        m.handle(
            Msg::Key {
                input: ch('x', Some("x")),
                mods: Mods::default(),
            },
            t(11),
        );
        assert_eq!(m.tabs["a"].term.display_offset(), 0);
    }

    #[test]
    fn sending_a_key_clears_the_selection() {
        let mut m = live(vec![session("a", 1)]);
        m.handle(
            Msg::PtyData {
                name: "a".into(),
                bytes: b"hello".to_vec(),
            },
            t(3),
        );
        {
            let tab = m.tabs.get_mut("a").unwrap();
            tab.term
                .selection_start(Cell { row: 0, col: 0 }, SelectKind::Simple);
            tab.term.selection_update(Cell { row: 0, col: 4 });
            assert!(tab.term.selection_text().is_some());
        }
        let fx = m.handle(
            Msg::Key {
                input: ch('x', Some("x")),
                mods: Mods::default(),
            },
            t(4),
        );
        assert_eq!(m.tabs["a"].term.selection_text(), None);
        assert!(fx.contains(&Effect::Ui(UiEffect::AllowIme)));
    }

    #[test]
    fn ime_commits_utf8() {
        let mut m = live(vec![session("a", 1)]);
        assert_eq!(
            writes(&m.handle(Msg::Ime("日本".into()), t(10))),
            vec!["日本".as_bytes().to_vec()]
        );
    }
}

#[cfg(test)]
mod paste_tests {
    use super::super::tests::{live, t};
    use super::*;
    use crate::terminal::model::send::{SendJob, SendSource};
    use crate::terminal::testkit::session;
    use std::path::PathBuf;

    fn writes(fx: &[Effect]) -> Vec<Vec<u8>> {
        fx.iter()
            .filter_map(|e| match e {
                Effect::Write { bytes, .. } => Some(bytes.clone()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn text_pastes_with_cr_newlines() {
        let mut m = live(vec![session("a", 1)]);
        let fx = m.handle(
            Msg::Paste {
                clip: ClipboardSnapshot::Text("a\nb".into()),
                now_unix: 0,
            },
            t(10),
        );
        assert_eq!(writes(&fx), vec![b"a\rb".to_vec()]);
    }

    #[test]
    fn text_pastes_bracketed_when_the_program_asked() {
        let mut m = live(vec![session("a", 1)]);
        m.handle(
            Msg::PtyData {
                name: "a".into(),
                bytes: b"\x1b[?2004h".to_vec(),
            },
            t(5),
        );
        let fx = m.handle(
            Msg::Paste {
                clip: ClipboardSnapshot::Text("x\x1b[201~y".into()),
                now_unix: 0,
            },
            t(10),
        );
        assert_eq!(writes(&fx), vec![b"\x1b[200~xy\x1b[201~".to_vec()]);
    }

    #[test]
    fn an_image_becomes_an_upload_named_by_the_time() {
        let mut m = live(vec![session("a", 1)]);
        let fx = m.handle(
            Msg::Paste {
                clip: ClipboardSnapshot::Image(vec![1, 2]),
                now_unix: 1_791_082_819,
            },
            t(10),
        );
        let job = fx
            .iter()
            .find_map(|e| match e {
                Effect::StartSend(j) => Some(j.clone()),
                _ => None,
            })
            .unwrap();
        assert_eq!(
            job.sources,
            vec![SendSource::Bytes {
                name: "paste-1791082819.png".into(),
                data: vec![1, 2]
            }]
        );
        assert!(writes(&fx).is_empty());
    }

    #[test]
    fn copied_files_are_sent_like_a_drop() {
        let mut m = live(vec![session("a", 1)]);
        let fx = m.handle(
            Msg::Paste {
                clip: ClipboardSnapshot::Files(vec![PathBuf::from("a.txt")]),
                now_unix: 0,
            },
            t(10),
        );
        assert!(fx.iter().any(|e| matches!(
            e,
            Effect::StartSend(SendJob { sources, .. })
                if sources == &vec![SendSource::Path("a.txt".into())]
        )));
    }

    #[test]
    fn the_fallback_directory_is_the_sessions_cwd() {
        let mut m = live(vec![session("a", 1)]);
        let fx = m.handle(Msg::SendFiles(vec![PathBuf::from("a.txt")]), t(10));
        let job = fx
            .iter()
            .find_map(|e| match e {
                Effect::StartSend(j) => Some(j.clone()),
                _ => None,
            })
            .unwrap();
        assert_eq!(job.fallback_dir.as_deref(), Some("/home/sam/a"));
    }

    #[test]
    fn an_empty_clipboard_pastes_nothing() {
        let mut m = live(vec![session("a", 1)]);
        assert!(
            m.handle(
                Msg::Paste {
                    clip: ClipboardSnapshot::Empty,
                    now_unix: 0,
                },
                t(10),
            )
            .is_empty()
        );
    }
}
