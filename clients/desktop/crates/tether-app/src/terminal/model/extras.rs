//! Session history and the snippet palette: two overlays on the active tab.

use std::sync::Arc;

use tether_core::connect::ConnectError;
use tether_core::history::{self, History};
use tether_core::snippets::{Snippet, filter_items};

use super::*;

#[derive(Debug, Clone, PartialEq)]
pub enum HistoryBody {
    Loading,
    Empty,
    Text {
        text: Arc<str>,
        truncated: bool,
        /// From this window's own scrollback, because the host had nothing.
        local: bool,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct HistoryView {
    pub session: String,
    pub body: HistoryBody,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PaletteRow {
    pub name: String,
    pub preview: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PaletteView {
    pub rows: Vec<PaletteRow>,
    pub selected: usize,
    pub has_snippets: bool,
}

struct HistoryState {
    id: u64,
    session: String,
    body: HistoryBody,
}

struct PaletteState {
    query: String,
    selected: usize,
}

#[derive(Default)]
pub(crate) struct Extras {
    history_seq: u64,
    history: Option<HistoryState>,
    snippets: Vec<Snippet>,
    palette: Option<PaletteState>,
}

fn text_body(h: History, local: bool) -> HistoryBody {
    HistoryBody::Text {
        text: h.text.into(),
        truncated: h.truncated,
        local,
    }
}

impl TerminalModel {
    pub(crate) fn on_history_open(&mut self, fx: &mut Vec<Effect>) {
        let Some(name) = self.active_name().map(str::to_string) else {
            return;
        };
        self.extras.palette = None;
        self.extras.history_seq += 1;
        let id = self.extras.history_seq;
        self.extras.history = Some(HistoryState {
            id,
            session: name.clone(),
            body: HistoryBody::Loading,
        });
        if self.is_live(&name) {
            fx.push(Effect::History { name, id });
        } else {
            self.on_history_loaded(id, Err(ConnectError::Transport("offline".into())));
        }
    }

    pub(crate) fn on_history_loaded(&mut self, id: u64, result: Result<String, ConnectError>) {
        let local = |model: &Self, session: &str| {
            let text = model
                .tabs
                .get(session)
                .map(|t| t.term.scrollback_text())
                .unwrap_or_default();
            history::clean(&text)
        };
        let Some(session) = self
            .extras
            .history
            .as_ref()
            .filter(|h| h.id == id)
            .map(|h| h.session.clone())
        else {
            return;
        };
        // iOS falls back the same way: the host's transcript, else what this window saw.
        let body = match result.map(|raw| history::clean(&raw)) {
            Ok(h) if !h.is_empty() => text_body(h, false),
            _ => {
                let h = local(self, &session);
                if h.is_empty() {
                    HistoryBody::Empty
                } else {
                    text_body(h, true)
                }
            }
        };
        if let Some(state) = self.extras.history.as_mut() {
            state.body = body;
        }
    }

    pub(crate) fn on_history_copy(&mut self, fx: &mut Vec<Effect>) {
        if let Some(HistoryState {
            body: HistoryBody::Text { text, .. },
            ..
        }) = &self.extras.history
        {
            fx.push(Effect::Ui(UiEffect::SetClipboard(text.to_string())));
        }
    }

    pub(crate) fn on_history_close(&mut self, fx: &mut Vec<Effect>) {
        if self.extras.history.take().is_some() {
            fx.push(Effect::Ui(UiEffect::AllowIme));
        }
    }

    pub(crate) fn history_view(&self) -> Option<HistoryView> {
        self.extras.history.as_ref().map(|h| HistoryView {
            session: h.session.clone(),
            body: h.body.clone(),
        })
    }

    pub(crate) fn on_snippets_changed(&mut self, snippets: Vec<Snippet>) {
        self.extras.snippets = snippets;
        self.clamp_palette();
    }

    pub(crate) fn on_palette_open(&mut self) {
        let live = self.active_name().is_some_and(|n| self.is_live(n));
        if live && self.extras.history.is_none() {
            self.extras.palette = Some(PaletteState {
                query: String::new(),
                selected: 0,
            });
        }
    }

    pub(crate) fn on_palette_query(&mut self, query: String) {
        if let Some(p) = self.extras.palette.as_mut() {
            p.query = query;
            p.selected = 0;
        }
    }

    pub(crate) fn on_palette_move(&mut self, delta: i32) {
        let count = self.palette_matches().len() as i32;
        if let Some(p) = self.extras.palette.as_mut()
            && count > 0
        {
            p.selected = (p.selected as i32 + delta).clamp(0, count - 1) as usize;
        }
    }

    /// `index` is a row the user clicked; `None` is Enter on the highlighted one.
    pub(crate) fn on_palette_choose(&mut self, index: Option<usize>, fx: &mut Vec<Effect>) {
        let Some(state) = self.extras.palette.as_ref() else {
            return;
        };
        let pick = index.unwrap_or(state.selected);
        let Some(bytes) = self.palette_matches().get(pick).map(|s| s.bytes()) else {
            return;
        };
        self.extras.palette = None;
        self.snap_active_to_bottom();
        self.write_active(bytes, fx);
        fx.push(Effect::Ui(UiEffect::AllowIme));
        fx.push(Effect::Redraw);
    }

    pub(crate) fn on_palette_close(&mut self, fx: &mut Vec<Effect>) {
        if self.extras.palette.take().is_some() {
            fx.push(Effect::Ui(UiEffect::AllowIme));
        }
    }

    fn palette_matches(&self) -> Vec<&Snippet> {
        let query = self
            .extras
            .palette
            .as_ref()
            .map(|p| p.query.as_str())
            .unwrap_or("");
        filter_items(&self.extras.snippets, query)
    }

    fn clamp_palette(&mut self) {
        let count = self.palette_matches().len();
        if let Some(p) = self.extras.palette.as_mut() {
            p.selected = p.selected.min(count.saturating_sub(1));
        }
    }

    pub(crate) fn palette_view(&self) -> Option<PaletteView> {
        let p = self.extras.palette.as_ref()?;
        Some(PaletteView {
            rows: self
                .palette_matches()
                .into_iter()
                .map(|s| PaletteRow {
                    name: s.name.clone(),
                    preview: s.preview(),
                })
                .collect(),
            selected: p.selected,
            has_snippets: !self.extras.snippets.is_empty(),
        })
    }

    pub(crate) fn overlay_open(&self) -> bool {
        self.extras.history.is_some() || self.extras.palette.is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{live, t};
    use super::*;
    use crate::terminal::testkit::session;
    use uuid::Uuid;

    fn snip(name: &str, text: &str) -> Snippet {
        Snippet {
            id: Uuid::new_v4(),
            name: name.into(),
            text: text.into(),
        }
    }

    fn written(fx: &[Effect]) -> Vec<Vec<u8>> {
        fx.iter()
            .filter_map(|e| match e {
                Effect::Write { bytes, .. } => Some(bytes.clone()),
                _ => None,
            })
            .collect()
    }

    fn with_snippets() -> TerminalModel {
        let mut m = live(vec![session("a", 1)]);
        m.handle(
            Msg::SnippetsChanged(vec![
                snip("Git status", r"git status\n"),
                snip("Interrupt", r"\cC"),
                snip("Greet", "echo hi"),
            ]),
            t(3),
        );
        m
    }

    #[test]
    fn history_asks_the_host_for_the_active_session() {
        let mut m = live(vec![session("a", 1)]);
        let fx = m.handle(Msg::HistoryOpen, t(5));
        assert!(fx.contains(&Effect::History {
            name: "a".into(),
            id: 1
        }));
        let v = m.view().history.unwrap();
        assert_eq!((v.session.as_str(), v.body), ("a", HistoryBody::Loading));
    }

    #[test]
    fn host_text_is_cleaned_and_shown() {
        let mut m = live(vec![session("a", 1)]);
        m.handle(Msg::HistoryOpen, t(5));
        m.handle(
            Msg::HistoryLoaded {
                id: 1,
                result: Ok("\x1b[32mone\x1b[0m\r\ntwo\r\n\r\n".into()),
            },
            t(6),
        );
        match m.view().history.unwrap().body {
            HistoryBody::Text {
                text,
                truncated,
                local,
            } => {
                assert_eq!(&*text, "one\ntwo");
                assert!(!truncated && !local);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn empty_or_failed_host_history_falls_back_to_this_windows_scrollback() {
        for result in [
            Ok("   \n".to_string()),
            Err(ConnectError::Transport("down".into())),
        ] {
            let mut m = live(vec![session("a", 1)]);
            m.handle(
                Msg::PtyData {
                    name: "a".into(),
                    bytes: b"local line\r\n".to_vec(),
                },
                t(4),
            );
            m.handle(Msg::HistoryOpen, t(5));
            m.handle(Msg::HistoryLoaded { id: 1, result }, t(6));
            match m.view().history.unwrap().body {
                HistoryBody::Text { text, local, .. } => {
                    assert!(local);
                    assert!(text.contains("local line"));
                }
                other => panic!("{other:?}"),
            }
        }
    }

    #[test]
    fn nothing_anywhere_reads_empty_and_a_stale_answer_is_ignored() {
        let mut m = live(vec![session("a", 1)]);
        m.handle(Msg::HistoryOpen, t(5));
        m.handle(Msg::HistoryOpen, t(6));
        m.handle(
            Msg::HistoryLoaded {
                id: 1,
                result: Ok("old".into()),
            },
            t(7),
        );
        assert_eq!(m.view().history.unwrap().body, HistoryBody::Loading);
        m.handle(
            Msg::HistoryLoaded {
                id: 2,
                result: Ok("".into()),
            },
            t(8),
        );
        assert_eq!(m.view().history.unwrap().body, HistoryBody::Empty);
    }

    #[test]
    fn copy_sends_the_text_and_close_removes_the_overlay() {
        let mut m = live(vec![session("a", 1)]);
        m.handle(Msg::HistoryOpen, t(5));
        m.handle(
            Msg::HistoryLoaded {
                id: 1,
                result: Ok("hello".into()),
            },
            t(6),
        );
        let fx = m.handle(Msg::HistoryCopy, t(7));
        assert!(fx.contains(&Effect::Ui(UiEffect::SetClipboard("hello".into()))));
        m.handle(Msg::HistoryClose, t(8));
        assert!(m.view().history.is_none());
        assert!(m.handle(Msg::HistoryCopy, t(9)).is_empty());
    }

    #[test]
    fn history_without_a_live_session_uses_local_text_and_asks_nothing() {
        let (mut m, _) = TerminalModel::new(
            crate::terminal::testkit::machine(),
            Default::default(),
            crate::terminal::testkit::grid(),
        );
        let fx = m.handle(Msg::HistoryOpen, t(1));
        assert!(fx.is_empty());
        assert!(m.view().history.is_none());
    }

    #[test]
    fn the_palette_lists_filters_and_types_the_choice() {
        let mut m = with_snippets();
        m.handle(Msg::PaletteOpen, t(4));
        let v = m.view().palette.unwrap();
        assert_eq!(v.rows.len(), 3);
        assert_eq!(v.rows[0].preview, "git status⏎");
        m.handle(Msg::PaletteQuery("int".into()), t(5));
        let v = m.view().palette.unwrap();
        assert_eq!(
            v.rows.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(),
            ["Interrupt"]
        );
        let fx = m.handle(Msg::PaletteChoose(None), t(6));
        assert_eq!(written(&fx), vec![vec![3u8]]);
        assert!(m.view().palette.is_none());
    }

    #[test]
    fn arrows_move_within_the_list_and_enter_sends_the_highlighted_row() {
        let mut m = with_snippets();
        m.handle(Msg::PaletteOpen, t(4));
        m.handle(Msg::PaletteMove(1), t(5));
        m.handle(Msg::PaletteMove(1), t(5));
        m.handle(Msg::PaletteMove(1), t(5));
        assert_eq!(m.view().palette.unwrap().selected, 2);
        m.handle(Msg::PaletteMove(-1), t(5));
        let fx = m.handle(Msg::PaletteChoose(None), t(6));
        assert_eq!(written(&fx), vec![vec![3u8]]);
    }

    #[test]
    fn a_clicked_row_is_sent_as_typed_text_not_a_bracketed_paste() {
        let mut m = with_snippets();
        m.handle(Msg::PaletteOpen, t(4));
        let fx = m.handle(Msg::PaletteChoose(Some(0)), t(5));
        assert_eq!(written(&fx), vec![b"git status\r".to_vec()]);
    }

    #[test]
    fn no_match_or_no_session_sends_nothing_and_escape_closes() {
        let mut m = with_snippets();
        m.handle(Msg::PaletteOpen, t(4));
        m.handle(Msg::PaletteQuery("zzz".into()), t(5));
        assert!(m.view().palette.unwrap().rows.is_empty());
        assert!(written(&m.handle(Msg::PaletteChoose(None), t(6))).is_empty());
        assert!(m.view().palette.is_some());
        m.handle(Msg::PaletteClose, t(7));
        assert!(m.view().palette.is_none());

        let (mut off, _) = TerminalModel::new(
            crate::terminal::testkit::machine(),
            Default::default(),
            crate::terminal::testkit::grid(),
        );
        off.handle(Msg::SnippetsChanged(vec![snip("a", "b")]), t(1));
        off.handle(Msg::PaletteOpen, t(2));
        assert!(off.view().palette.is_none());
    }

    #[test]
    fn editing_the_list_while_open_keeps_the_selection_in_range() {
        let mut m = with_snippets();
        m.handle(Msg::PaletteOpen, t(4));
        m.handle(Msg::PaletteMove(2), t(5));
        m.handle(Msg::SnippetsChanged(vec![snip("only", "x")]), t(6));
        assert_eq!(m.view().palette.unwrap().selected, 0);
    }

    #[test]
    fn the_two_overlays_exclude_each_other() {
        let mut m = with_snippets();
        m.handle(Msg::PaletteOpen, t(4));
        m.handle(Msg::HistoryOpen, t(5));
        let v = m.view();
        assert!(v.history.is_some() && v.palette.is_none());
        m.handle(Msg::PaletteOpen, t(6));
        assert!(m.view().palette.is_none());
    }
}
