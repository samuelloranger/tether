use std::ops::RangeInclusive;
use std::sync::Mutex;

use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Direction, Line, Point, Side};
use alacritty_terminal::term::search::{Match, RegexIter, RegexSearch};

use crate::terminal::TabTerminal;

/// Scrollback search. The query is literal; it ignores case unless it has an uppercase
/// letter, the same smart case alacritty's own search uses.
pub(crate) struct Search {
    regex: Mutex<RegexSearch>,
    current: Option<Match>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct SearchCount {
    /// 1-based position of the current match, when one is selected and still on screen.
    pub current: Option<usize>,
    pub total: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SearchHit {
    None,
    Match,
    Current,
}

fn escape(query: &str) -> String {
    let mut out = String::with_capacity(query.len());
    for c in query.chars() {
        if "\\.+*?()|[]{}^$#&-~".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

impl TabTerminal {
    /// An empty query clears the search.
    pub fn search_set(&mut self, query: &str) -> SearchCount {
        self.search = None;
        if query.is_empty() {
            return SearchCount::default();
        }
        let Ok(regex) = RegexSearch::new(&escape(query)) else {
            return SearchCount::default();
        };
        self.search = Some(Search {
            regex: Mutex::new(regex),
            current: None,
        });
        self.search_count()
    }

    /// Lines pushed into the scrollback move the current match up with its text. Once the
    /// scrollback is full nothing grows, so the match is dropped when its text moved away.
    pub(crate) fn search_follow_output(&mut self, pushed: i32) {
        let Some(current) = self.search.as_ref().and_then(|s| s.current.clone()) else {
            return;
        };
        let moved = Point::new(current.start().line - pushed, current.start().column)
            ..=Point::new(current.end().line - pushed, current.end().column);
        let still =
            moved.start().line >= self.term.grid().topmost_line() && self.still_matches(&moved);
        if let Some(search) = self.search.as_mut() {
            search.current = still.then_some(moved);
        }
    }

    fn still_matches(&self, m: &Match) -> bool {
        let Some(search) = self.search.as_ref() else {
            return false;
        };
        let mut regex = search.regex.lock().unwrap();
        let start = Point::new(m.start().line, Column(0));
        let end = Point::new(m.end().line, Column(self.term.grid().columns() - 1));
        RegexIter::new(start, end, Direction::Right, &self.term, &mut regex).any(|x| x == *m)
    }

    pub fn search_clear(&mut self) {
        self.search = None;
    }

    /// `older` steps up into the scrollback; the first step starts from the bottom of the
    /// screen. The view scrolls to show the match.
    pub fn search_step(&mut self, older: bool) -> SearchCount {
        let Some(search) = self.search.as_mut() else {
            return SearchCount::default();
        };
        let grid = self.term.grid();
        let bottom = Point::new(
            Line(grid.screen_lines() as i32 - 1),
            Column(grid.columns() - 1),
        );
        let (direction, origin) = match (&search.current, older) {
            (Some(m), true) => (Direction::Left, before(*m.start(), grid)),
            (Some(m), false) => (Direction::Right, after(*m.end(), grid)),
            (None, true) => (Direction::Left, bottom),
            (None, false) => (Direction::Right, Point::new(grid.topmost_line(), Column(0))),
        };
        let side = if older { Side::Right } else { Side::Left };
        let found = {
            let mut regex = search.regex.lock().unwrap();
            self.term
                .search_next(&mut regex, origin, direction, side, None)
        };
        if let Some(m) = &found {
            self.term.scroll_to_point(*m.start());
        }
        if let Some(search) = self.search.as_mut() {
            search.current = found.or(search.current.clone());
        }
        self.search_count()
    }

    pub fn search_count(&self) -> SearchCount {
        let Some(search) = self.search.as_ref() else {
            return SearchCount::default();
        };
        let grid = self.term.grid();
        let start = Point::new(grid.topmost_line(), Column(0));
        let end = Point::new(grid.bottommost_line(), Column(grid.columns() - 1));
        let mut regex = search.regex.lock().unwrap();
        let mut count = SearchCount::default();
        for m in RegexIter::new(start, end, Direction::Right, &self.term, &mut regex) {
            count.total += 1;
            if search.current.as_ref() == Some(&m) {
                count.current = Some(count.total);
            }
        }
        count
    }

    /// Matches that touch the visible rows, flagged when one is the current match.
    pub(crate) fn visible_matches(&self) -> Vec<(RangeInclusive<Point>, bool)> {
        let Some(search) = self.search.as_ref() else {
            return Vec::new();
        };
        let grid = self.term.grid();
        let offset = grid.display_offset() as i32;
        let start = Point::new(Line(-offset), Column(0));
        let end = Point::new(
            Line(grid.screen_lines() as i32 - 1 - offset),
            Column(grid.columns() - 1),
        );
        let mut regex = search.regex.lock().unwrap();
        RegexIter::new(start, end, Direction::Right, &self.term, &mut regex)
            .map(|m| {
                let current = search.current.as_ref() == Some(&m);
                (m, current)
            })
            .collect()
    }
}

fn before<D: Dimensions>(p: Point, grid: &D) -> Point {
    if p.column.0 > 0 {
        Point::new(p.line, Column(p.column.0 - 1))
    } else if p.line > grid.topmost_line() {
        Point::new(p.line - 1, Column(grid.columns() - 1))
    } else {
        Point::new(grid.bottommost_line(), Column(grid.columns() - 1))
    }
}

fn after<D: Dimensions>(p: Point, grid: &D) -> Point {
    if p.column.0 + 1 < grid.columns() {
        Point::new(p.line, Column(p.column.0 + 1))
    } else if p.line < grid.bottommost_line() {
        Point::new(p.line + 1, Column(0))
    } else {
        Point::new(grid.topmost_line(), Column(0))
    }
}

pub(crate) fn hit_at(matches: &[(Match, bool)], point: Point) -> SearchHit {
    let mut hit = SearchHit::None;
    for (m, current) in matches {
        if m.contains(&point) {
            if *current {
                return SearchHit::Current;
            }
            hit = SearchHit::Match;
        }
    }
    hit
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::terminal::tests::{size, term};

    fn lines(t: &mut TabTerminal, n: usize, word: &str) {
        for i in 0..n {
            t.feed(format!("line {i} {word}\r\n").as_bytes());
        }
    }

    #[test]
    fn literal_queries_escape_regex_syntax() {
        let mut t = term();
        t.feed(b"cost $5.00 (a+b)\r\nnot cost 5x00\r\n");
        assert_eq!(t.search_set("$5.00").total, 1);
        assert_eq!(t.search_set("(a+b)").total, 1);
        assert_eq!(t.search_set("[").total, 0);
    }

    #[test]
    fn lowercase_ignores_case_and_uppercase_does_not() {
        let mut t = term();
        t.feed(b"Error error ERROR\r\n");
        assert_eq!(t.search_set("error").total, 3);
        assert_eq!(t.search_set("Error").total, 1);
    }

    #[test]
    fn stepping_older_walks_up_into_the_scrollback_and_scrolls_to_it() {
        let mut t = TabTerminal::new(size(40, 5), tether_core::theme::theme_named("tether"));
        lines(&mut t, 30, "");
        t.feed(b"needle at the bottom\r\n");
        lines(&mut t, 3, "");
        let total = t.search_set("line 2 ").total;
        assert_eq!(total, 2, "line 2 and line 2 (of the tail)");
        let first = t.search_step(true);
        assert_eq!(first.total, 2);
        assert!(first.current.is_some());
        let second = t.search_step(true);
        assert_ne!(first.current, second.current);
        assert!(t.display_offset() > 0, "an old match scrolls into view");
    }

    #[test]
    fn stepping_wraps_around() {
        let mut t = term();
        t.feed(b"a x\r\nb x\r\n");
        t.search_set("x");
        let a = t.search_step(true).current;
        let b = t.search_step(true).current;
        let c = t.search_step(true).current;
        assert_ne!(a, b);
        assert_eq!(a, c);
    }

    #[test]
    fn visible_matches_mark_the_current_one() {
        let mut t = term();
        t.feed(b"x x\r\n");
        t.search_set("x");
        t.search_step(false);
        let visible = t.visible_matches();
        assert_eq!(visible.len(), 2);
        assert_eq!(visible.iter().filter(|(_, cur)| *cur).count(), 1);
    }

    #[test]
    fn an_empty_query_clears_and_nothing_matches_after_clear() {
        let mut t = term();
        t.feed(b"x\r\n");
        assert_eq!(t.search_set("x").total, 1);
        assert_eq!(t.search_set(""), SearchCount::default());
        t.search_set("x");
        t.search_clear();
        assert!(t.visible_matches().is_empty());
        assert_eq!(t.search_step(true), SearchCount::default());
    }

    #[test]
    fn the_current_match_follows_its_text_as_output_scrolls() {
        let mut t = TabTerminal::new(size(20, 4), tether_core::theme::theme_named("tether"));
        t.feed(b"alpha\r\nbeta\r\n");
        t.search_set("alpha");
        let before = t.search_step(true);
        assert_eq!(before.current, Some(1));
        lines(&mut t, 6, "");
        assert_eq!(t.search_count().current, Some(1));
    }

    #[test]
    fn current_and_other_matches_are_highlighted_in_the_snapshot() {
        let mut t = term();
        t.feed(b"x y x\r\n");
        t.search_set("x");
        t.search_step(false);
        let s = t.snapshot();
        let (a, b, plain) = (s.cell(0, 0).bg, s.cell(0, 4).bg, s.cell(0, 2).bg);
        assert_ne!(a, plain);
        assert_ne!(b, plain);
        assert_ne!(a, b, "the current match stands out from the others");
    }

    #[test]
    fn a_match_wrapped_across_rows_is_found() {
        let mut t = TabTerminal::new(size(10, 5), tether_core::theme::theme_named("tether"));
        t.feed(b"12345678needle\r\n");
        assert_eq!(t.search_set("needle").total, 1);
    }
}
