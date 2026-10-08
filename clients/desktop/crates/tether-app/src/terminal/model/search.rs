use super::*;
use tether_term::SearchCount;

const RECOUNT_EVERY: Duration = Duration::from_secs(1);

#[derive(Debug, Clone, Default)]
pub(crate) struct SearchBar {
    pub query: String,
    pub count: SearchCount,
    /// The tab the query was last applied to: switching tabs re-applies it.
    tab: Option<String>,
    counted_at: Duration,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchView {
    pub query: String,
    pub label: String,
}

pub(crate) fn label(query: &str, count: SearchCount) -> String {
    match (query.is_empty(), count.total, count.current) {
        (true, _, _) => String::new(),
        (false, 0, _) => "No matches".into(),
        (false, total, Some(at)) => format!("{at} of {total}"),
        (false, 1, None) => "1 match".into(),
        (false, total, None) => format!("{total} matches"),
    }
}

impl TerminalModel {
    pub(crate) fn on_search_open(&mut self, fx: &mut Vec<Effect>) {
        if self.search.is_none() {
            self.search = Some(SearchBar::default());
        }
        fx.push(Effect::Ui(UiEffect::FocusSearch));
    }

    pub(crate) fn on_search_query(&mut self, query: String, now: Duration, fx: &mut Vec<Effect>) {
        let Some(bar) = self.search.as_mut() else {
            return;
        };
        bar.query = query;
        bar.tab = None;
        self.sync_search(now);
        fx.push(Effect::Redraw);
    }

    pub(crate) fn on_search_step(&mut self, older: bool, now: Duration, fx: &mut Vec<Effect>) {
        self.sync_search(now);
        let active = self.active_name().map(str::to_string);
        let (Some(bar), Some(tab)) = (
            self.search.as_mut(),
            active.and_then(|n| self.tabs.get_mut(&n)),
        ) else {
            return;
        };
        bar.count = tab.term.search_step(older);
        bar.counted_at = now;
        fx.push(Effect::Redraw);
    }

    pub(crate) fn on_search_close(&mut self, fx: &mut Vec<Effect>) {
        if self.search.take().is_none() {
            return;
        }
        for tab in self.tabs.values_mut() {
            tab.term.search_clear();
        }
        self.snap_active_to_bottom();
        fx.push(Effect::Redraw);
    }

    /// Keeps the open search on the active tab and its count fresh as output arrives.
    pub(crate) fn sync_search(&mut self, now: Duration) {
        let active = self.active_name().map(str::to_string);
        let Some(bar) = self.search.as_mut() else {
            return;
        };
        let Some(name) = active else {
            bar.count = SearchCount::default();
            return;
        };
        if bar.tab.as_deref() != Some(name.as_str()) {
            for (n, tab) in self.tabs.iter_mut() {
                if *n != name {
                    tab.term.search_clear();
                }
            }
            if let Some(tab) = self.tabs.get_mut(&name) {
                bar.count = tab.term.search_set(&bar.query);
                bar.counted_at = now;
                bar.tab = Some(name);
            }
        } else if now.saturating_sub(bar.counted_at) >= RECOUNT_EVERY
            && let Some(tab) = self.tabs.get(&name)
        {
            bar.count = tab.term.search_count();
            bar.counted_at = now;
        }
    }

    pub(crate) fn search_view(&self) -> Option<SearchView> {
        self.search.as_ref().map(|bar| SearchView {
            query: bar.query.clone(),
            label: label(&bar.query, bar.count),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{live, t};
    use super::*;
    use crate::terminal::testkit::session;
    use tether_core::keymap::KeyInput;

    fn writes(fx: &[Effect]) -> Vec<Vec<u8>> {
        fx.iter()
            .filter_map(|e| match e {
                Effect::Write { bytes, .. } => Some(bytes.clone()),
                _ => None,
            })
            .collect()
    }

    fn feed(m: &mut TerminalModel, name: &str, text: &str) {
        m.handle(
            Msg::PtyData {
                name: name.into(),
                bytes: text.as_bytes().to_vec(),
            },
            t(1),
        );
    }

    #[test]
    fn labels_read_like_a_find_bar() {
        let c = |current, total| SearchCount { current, total };
        assert_eq!(label("", c(None, 0)), "");
        assert_eq!(label("x", c(None, 0)), "No matches");
        assert_eq!(label("x", c(None, 1)), "1 match");
        assert_eq!(label("x", c(None, 4)), "4 matches");
        assert_eq!(label("x", c(Some(2), 4)), "2 of 4");
    }

    #[test]
    fn ctrl_shift_f_opens_the_bar_and_focuses_it() {
        let mut m = live(vec![session("default", 1)]);
        let fx = m.handle(
            Msg::Key {
                input: KeyInput::Char {
                    unmodified: 'f',
                    produced: None,
                    digit: None,
                },
                mods: Mods {
                    shift: true,
                    alt: false,
                    ctrl: true,
                },
            },
            t(2),
        );
        assert!(fx.contains(&Effect::Ui(UiEffect::FocusSearch)));
        assert!(m.view().search.is_some());
        assert!(writes(&fx).is_empty(), "the shortcut never reaches the PTY");
    }

    #[test]
    fn typing_a_query_counts_and_stepping_selects() {
        let mut m = live(vec![session("default", 1)]);
        feed(&mut m, "default", "foo bar foo\r\n");
        m.handle(Msg::SearchOpen, t(2));
        m.handle(Msg::SearchQuery("foo".into()), t(3));
        assert_eq!(m.view().search.unwrap().label, "2 matches");
        m.handle(Msg::SearchStep { older: true }, t(4));
        assert_eq!(m.view().search.unwrap().label, "2 of 2");
    }

    #[test]
    fn switching_tabs_applies_the_query_to_the_new_tab() {
        let mut m = live(vec![session("default", 1), session("b", 2)]);
        feed(&mut m, "default", "needle\r\n");
        m.handle(Msg::SearchOpen, t(2));
        m.handle(Msg::SearchQuery("needle".into()), t(3));
        assert_eq!(m.view().search.unwrap().label, "1 match");
        m.handle(Msg::SelectTab("b".into()), t(4));
        assert_eq!(m.view().search.unwrap().label, "No matches");
    }

    #[test]
    fn closing_clears_highlights_and_the_bar() {
        let mut m = live(vec![session("default", 1)]);
        feed(&mut m, "default", "x\r\n");
        m.handle(Msg::SearchOpen, t(2));
        m.handle(Msg::SearchQuery("x".into()), t(3));
        m.handle(Msg::SearchClose, t(4));
        assert!(m.view().search.is_none());
        let tab = m.tabs.get("default").unwrap();
        assert_eq!(tab.term.search_count(), SearchCount::default());
    }
}
