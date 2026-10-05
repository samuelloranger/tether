use std::sync::{Arc, Mutex};

use alacritty_terminal::event::{Event, EventListener, WindowSize};
use alacritty_terminal::grid::{Dimensions, Scroll};
use alacritty_terminal::index::{Column, Line, Point, Side};
use alacritty_terminal::selection::{Selection, SelectionType};
use alacritty_terminal::term::{Config, Osc52, Term, TermMode};
use alacritty_terminal::vte::ansi::{Processor, StdSyncHandler};
use tether_core::keymap::KeyContext;
use tether_core::osc::{Notification, OscEvent, OscScanner, ReportEvent, TabReports};
use tether_core::resize::GridSize;
use tether_core::theme::TerminalTheme;

use crate::palette;

pub const SCROLLBACK: usize = 10_000;
const TITLE_LIMIT: usize = 128;

#[derive(Debug, Clone, PartialEq)]
pub enum TermEvent {
    Reply(Vec<u8>),
    Title(Option<String>),
    Bell,
    Clipboard(String),
    Notify(Notification),
    ProgressChanged,
    CwdChanged,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cell {
    pub row: usize,
    pub col: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SelectKind {
    Simple,
    Word,
    Line,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseTracking {
    None,
    Click,
    Drag,
    Motion,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MouseMode {
    pub tracking: MouseTracking,
    pub sgr: bool,
}

#[derive(Clone, Default)]
pub(crate) struct Collector(Arc<Mutex<Vec<Event>>>);

impl EventListener for Collector {
    fn send_event(&self, event: Event) {
        self.0.lock().unwrap().push(event);
    }
}

pub(crate) struct Dims {
    cols: usize,
    rows: usize,
}

impl From<GridSize> for Dims {
    fn from(s: GridSize) -> Self {
        Dims {
            cols: s.cols.max(1) as usize,
            rows: s.rows.max(1) as usize,
        }
    }
}

impl Dimensions for Dims {
    fn total_lines(&self) -> usize {
        self.rows
    }
    fn screen_lines(&self) -> usize {
        self.rows
    }
    fn columns(&self) -> usize {
        self.cols
    }
}

pub struct TabTerminal {
    pub(crate) term: Term<Collector>,
    parser: Processor<StdSyncHandler>,
    events: Collector,
    pub(crate) theme: TerminalTheme,
    size: GridSize,
    scanner: OscScanner,
    reports: TabReports,
}

impl TabTerminal {
    pub fn new(size: GridSize, theme: &TerminalTheme) -> Self {
        let events = Collector::default();
        let config = Config {
            scrolling_history: SCROLLBACK,
            osc52: Osc52::Disabled,
            ..Config::default()
        };
        let term = Term::new(config, &Dims::from(size), events.clone());
        TabTerminal {
            term,
            parser: Processor::new(),
            events,
            theme: theme.clone(),
            size,
            scanner: OscScanner::new(),
            reports: TabReports::default(),
        }
    }

    pub fn feed(&mut self, bytes: &[u8]) -> Vec<TermEvent> {
        let osc = self.scanner.feed(bytes);
        self.parser.advance(&mut self.term, bytes);
        let mut out = self.drain();
        for event in &osc {
            out.extend(self.apply_report(event));
        }
        out
    }

    pub fn set_theme(&mut self, theme: &TerminalTheme) {
        self.theme = theme.clone();
    }

    pub fn reports(&self) -> &TabReports {
        &self.reports
    }

    pub fn sync_deadline(&self) -> Option<std::time::Instant> {
        self.parser.sync_timeout().sync_timeout()
    }

    pub fn flush_sync(&mut self) -> Vec<TermEvent> {
        self.parser.stop_sync(&mut self.term);
        self.drain()
    }

    pub fn context(&self) -> KeyContext {
        let mode = *self.term.mode();
        KeyContext {
            app_cursor: mode.contains(TermMode::APP_CURSOR),
            app_keypad: mode.contains(TermMode::APP_KEYPAD),
            alt_screen: mode.contains(TermMode::ALT_SCREEN),
            mouse_reporting: mode.intersects(TermMode::MOUSE_MODE),
            has_selection: self.selection_text().is_some(),
        }
    }

    pub fn bracketed_paste(&self) -> bool {
        self.term.mode().contains(TermMode::BRACKETED_PASTE)
    }

    pub fn mouse_mode(&self) -> MouseMode {
        let mode = *self.term.mode();
        let tracking = if mode.contains(TermMode::MOUSE_MOTION) {
            MouseTracking::Motion
        } else if mode.contains(TermMode::MOUSE_DRAG) {
            MouseTracking::Drag
        } else if mode.contains(TermMode::MOUSE_REPORT_CLICK) {
            MouseTracking::Click
        } else {
            MouseTracking::None
        };
        MouseMode {
            tracking,
            sgr: mode.contains(TermMode::SGR_MOUSE),
        }
    }

    pub fn resize(&mut self, size: GridSize) {
        self.size = size;
        self.term.resize(Dims::from(size));
    }

    pub fn scroll(&mut self, lines: i32) {
        self.term.scroll_display(Scroll::Delta(lines));
    }

    pub fn scroll_to_bottom(&mut self) {
        self.term.scroll_display(Scroll::Bottom);
    }

    pub fn display_offset(&self) -> usize {
        self.term.grid().display_offset()
    }

    pub fn selection_start(&mut self, cell: Cell, kind: SelectKind) {
        let ty = match kind {
            SelectKind::Simple => SelectionType::Simple,
            SelectKind::Word => SelectionType::Semantic,
            SelectKind::Line => SelectionType::Lines,
        };
        self.term.selection = Some(Selection::new(ty, self.point(cell), Side::Left));
    }

    pub fn selection_update(&mut self, cell: Cell) {
        let point = self.point(cell);
        if let Some(selection) = self.term.selection.as_mut() {
            selection.update(point, Side::Right);
        }
    }

    pub fn selection_text(&self) -> Option<String> {
        self.term.selection_to_string().filter(|s| !s.is_empty())
    }

    pub fn clear_selection(&mut self) {
        self.term.selection = None;
    }

    pub(crate) fn point(&self, cell: Cell) -> Point {
        let offset = self.display_offset() as i32;
        Point::new(Line(cell.row as i32 - offset), Column(cell.col))
    }

    pub(crate) fn drain(&mut self) -> Vec<TermEvent> {
        let events = std::mem::take(&mut *self.events.0.lock().unwrap());
        events
            .into_iter()
            .filter_map(|event| match event {
                Event::PtyWrite(text) => Some(TermEvent::Reply(text.into_bytes())),
                Event::ColorRequest(index, format) => {
                    let rgb = palette::indexed(&self.theme, self.term.colors(), index);
                    Some(TermEvent::Reply(format(palette::to_rgb(rgb)).into_bytes()))
                }
                Event::TextAreaSizeRequest(format) => {
                    Some(TermEvent::Reply(format(self.window_size()).into_bytes()))
                }
                Event::Title(title) => Some(TermEvent::Title(clean_title(&title))),
                Event::ResetTitle => Some(TermEvent::Title(None)),
                Event::Bell => Some(TermEvent::Bell),
                _ => None,
            })
            .collect()
    }

    fn apply_report(&mut self, event: &OscEvent) -> Vec<TermEvent> {
        let cwd_before = self.reports.cwd.clone();
        let mut out = Vec::new();
        match self.reports.apply(event) {
            Some(ReportEvent::Notify(n)) => out.push(TermEvent::Notify(n)),
            Some(ReportEvent::Clipboard(text)) => out.push(TermEvent::Clipboard(text)),
            Some(ReportEvent::ProgressChanged) => out.push(TermEvent::ProgressChanged),
            Some(ReportEvent::CwdChanged) => {}
            None => {}
        }
        if self.reports.cwd != cwd_before {
            out.push(TermEvent::CwdChanged);
        }
        out
    }

    fn window_size(&self) -> WindowSize {
        let cols = self.size.cols.max(1);
        let rows = self.size.rows.max(1);
        WindowSize {
            num_lines: rows,
            num_cols: cols,
            cell_width: (self.size.width_px / cols as u32) as u16,
            cell_height: (self.size.height_px / rows as u32) as u16,
        }
    }
}

fn clean_title(raw: &str) -> Option<String> {
    let kept: String = raw
        .chars()
        .filter(|c| !c.is_control() && !is_format(*c))
        .collect();
    let text = kept.trim();
    (!text.is_empty()).then(|| text.chars().take(TITLE_LIMIT).collect())
}

fn is_format(c: char) -> bool {
    matches!(
        c,
        '\u{00AD}'
            | '\u{061C}'
            | '\u{200B}'..='\u{200F}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2060}'..='\u{2069}'
            | '\u{FEFF}'
    )
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use tether_core::theme::theme_named;

    pub(crate) fn size(cols: u16, rows: u16) -> GridSize {
        GridSize {
            cols,
            rows,
            width_px: cols as u32 * 9,
            height_px: rows as u32 * 18,
        }
    }

    pub(crate) fn term() -> TabTerminal {
        TabTerminal::new(size(80, 24), theme_named("tether"))
    }

    pub(crate) fn replies(events: &[TermEvent]) -> Vec<String> {
        events
            .iter()
            .filter_map(|e| match e {
                TermEvent::Reply(b) => Some(String::from_utf8(b.clone()).unwrap()),
                _ => None,
            })
            .collect()
    }

    fn titles(events: &[TermEvent]) -> Vec<Option<String>> {
        events
            .iter()
            .filter_map(|e| match e {
                TermEvent::Title(t) => Some(t.clone()),
                _ => None,
            })
            .collect()
    }

    fn notifications(events: &[TermEvent]) -> Vec<Notification> {
        events
            .iter()
            .filter_map(|e| match e {
                TermEvent::Notify(n) => Some(n.clone()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn osc_10_11_12_answer_the_theme() {
        let mut t = term();
        assert_eq!(
            replies(&t.feed(b"\x1b]11;?\x07")),
            ["\x1b]11;rgb:1e1e/1e1e/2e2e\x07"]
        );
        assert_eq!(
            replies(&t.feed(b"\x1b]10;?\x07")),
            ["\x1b]10;rgb:cccc/cccc/cccc\x07"]
        );
        assert_eq!(
            replies(&t.feed(b"\x1b]12;?\x1b\\")),
            ["\x1b]12;rgb:ffff/ffff/ffff\x1b\\"]
        );
    }

    #[test]
    fn osc_4_answers_the_palette_entry() {
        let mut t = term();
        assert_eq!(
            replies(&t.feed(b"\x1b]4;1;?\x07")),
            ["\x1b]4;1;rgb:f3f3/8b8b/a8a8\x07"]
        );
    }

    #[test]
    fn a_theme_change_answers_with_the_new_background() {
        let mut t = term();
        t.set_theme(theme_named("dracula"));
        assert_eq!(
            replies(&t.feed(b"\x1b]11;?\x07")),
            ["\x1b]11;rgb:2828/2a2a/3636\x07"]
        );
    }

    #[test]
    fn device_attributes_and_cursor_position_are_answered() {
        let mut t = term();
        assert_eq!(replies(&t.feed(b"\x1b[c")), ["\x1b[?6c"]);
        let da2 = replies(&t.feed(b"\x1b[>c"));
        assert!(
            da2[0].starts_with("\x1b[>0;") && da2[0].ends_with(";1c"),
            "{da2:?}"
        );
        assert_eq!(replies(&t.feed(b"ab\x1b[6n")), ["\x1b[1;3R"]);
    }

    #[test]
    fn window_size_reports_are_answered_and_21t_is_not() {
        let mut t = term();
        assert_eq!(replies(&t.feed(b"\x1b[18t")), ["\x1b[8;24;80t"]);
        assert_eq!(replies(&t.feed(b"\x1b[14t")), ["\x1b[4;432;720t"]);
        assert!(replies(&t.feed(b"\x1b]2;secret\x07\x1b[21t")).is_empty());
    }

    #[test]
    fn a_query_split_across_reads_is_answered_once() {
        let mut t = term();
        assert!(replies(&t.feed(b"\x1b]11")).is_empty());
        assert_eq!(
            replies(&t.feed(b";?\x07")),
            ["\x1b]11;rgb:1e1e/1e1e/2e2e\x07"]
        );
    }

    #[test]
    fn title_push_and_pop() {
        let mut t = term();
        let events = t.feed(b"\x1b]2;one\x07\x1b[22t\x1b]2;two\x07\x1b[23t");
        assert_eq!(
            titles(&events),
            [Some("one".into()), Some("two".into()), Some("one".into())]
        );
    }

    #[test]
    fn titles_lose_control_and_bidi_characters_and_cap_at_128() {
        let mut t = term();
        let events = t.feed("\x1b]2;a\u{202E}b\u{200B}c\x07".as_bytes());
        assert_eq!(titles(&events), [Some("abc".into())]);
        let long = format!("\x1b]2;{}\x07", "x".repeat(300));
        assert_eq!(
            titles(&t.feed(long.as_bytes()))[0]
                .as_ref()
                .unwrap()
                .chars()
                .count(),
            128
        );
        assert_eq!(titles(&t.feed(b"\x1b]2;   \x07")), [None]);
    }

    #[test]
    fn bel_is_reported() {
        let mut t = term();
        assert!(t.feed(b"\x07").contains(&TermEvent::Bell));
    }

    #[test]
    fn osc_9_and_777_become_notifications() {
        let mut t = term();
        let n = notifications(&t.feed(b"\x1b]9;Build done\x07"));
        assert_eq!(n.len(), 1);
        assert_eq!(n[0].body, "Build done");
        let n = notifications(&t.feed(b"\x1b]777;notify;Claude;Needs you\x07"));
        assert_eq!(n[0].title.as_deref(), Some("Claude"));
        assert_eq!(n[0].body, "Needs you");
    }

    #[test]
    fn osc_9_4_is_progress_never_a_notification() {
        let mut t = term();
        let events = t.feed(b"\x1b]9;4;1;50\x07");
        assert!(notifications(&events).is_empty());
        assert!(events.contains(&TermEvent::ProgressChanged));
        assert_eq!(t.reports().progress.as_ref().unwrap().percent, 50);
    }

    #[test]
    fn a_notification_split_across_reads_arrives_once() {
        let mut t = term();
        assert!(notifications(&t.feed(b"\x1b]9;hel")).is_empty());
        assert_eq!(notifications(&t.feed(b"lo\x07"))[0].body, "hello");
    }

    #[test]
    fn osc_52_copies_once_even_split() {
        let mut t = term();
        let mut events = t.feed(b"\x1b]52;c;aGVs");
        events.extend(t.feed(b"bG8=\x07"));
        let copies: Vec<_> = events
            .iter()
            .filter(|e| matches!(e, TermEvent::Clipboard(_)))
            .collect();
        assert_eq!(copies, [&TermEvent::Clipboard("hello".into())]);
    }

    #[test]
    fn osc_7_reports_the_directory() {
        let mut t = term();
        assert!(
            t.feed(b"\x1b]7;file://box/home/sam/src\x07")
                .contains(&TermEvent::CwdChanged)
        );
        assert_eq!(t.reports().cwd.as_deref(), Some("/home/sam/src"));
        assert!(
            !t.feed(b"\x1b]7;file://box/home/sam/src\x07")
                .contains(&TermEvent::CwdChanged)
        );
    }

    #[test]
    fn palette_overrides_survive_a_theme_change_until_reset() {
        let mut t = term();
        t.feed(b"\x1b]4;1;rgb:ff/00/00\x07");
        t.set_theme(theme_named("dracula"));
        assert_eq!(
            replies(&t.feed(b"\x1b]4;1;?\x07")),
            ["\x1b]4;1;rgb:ffff/0000/0000\x07"]
        );
        t.feed(b"\x1b]104;1\x07");
        assert_eq!(
            replies(&t.feed(b"\x1b]4;1;?\x07")),
            ["\x1b]4;1;rgb:ffff/5555/5555\x07"]
        );
    }

    #[test]
    fn osc_110_resets_a_dynamic_foreground() {
        let mut t = term();
        t.feed(b"\x1b]10;rgb:12/34/56\x07");
        assert_eq!(
            replies(&t.feed(b"\x1b]10;?\x07")),
            ["\x1b]10;rgb:1212/3434/5656\x07"]
        );
        t.feed(b"\x1b]110\x07");
        assert_eq!(
            replies(&t.feed(b"\x1b]10;?\x07")),
            ["\x1b]10;rgb:cccc/cccc/cccc\x07"]
        );
    }

    #[test]
    fn an_unfinished_synchronized_update_can_be_flushed() {
        let mut t = term();
        assert!(replies(&t.feed(b"\x1b[?2026h\x1b]11;?\x07")).is_empty());
        assert!(t.sync_deadline().is_some());
        assert_eq!(replies(&t.flush_sync()), ["\x1b]11;rgb:1e1e/1e1e/2e2e\x07"]);
        assert!(t.sync_deadline().is_none());
    }

    #[test]
    fn modes_feed_the_key_context() {
        let mut t = term();
        let c = t.context();
        assert!(
            !c.app_cursor
                && !c.app_keypad
                && !c.alt_screen
                && !c.mouse_reporting
                && !c.has_selection
        );
        t.feed(b"\x1b[?1h\x1b=\x1b[?1049h\x1b[?1000h");
        let c = t.context();
        assert!(c.app_cursor && c.app_keypad && c.alt_screen && c.mouse_reporting);
    }

    #[test]
    fn mouse_tracking_levels_and_sgr() {
        let mut t = term();
        assert_eq!(
            t.mouse_mode(),
            MouseMode {
                tracking: MouseTracking::None,
                sgr: false
            }
        );
        t.feed(b"\x1b[?1000h");
        assert_eq!(t.mouse_mode().tracking, MouseTracking::Click);
        t.feed(b"\x1b[?1002h");
        assert_eq!(t.mouse_mode().tracking, MouseTracking::Drag);
        t.feed(b"\x1b[?1003h\x1b[?1006h");
        assert_eq!(
            t.mouse_mode(),
            MouseMode {
                tracking: MouseTracking::Motion,
                sgr: true
            }
        );
    }

    #[test]
    fn bracketed_paste_follows_2004() {
        let mut t = term();
        assert!(!t.bracketed_paste());
        t.feed(b"\x1b[?2004h");
        assert!(t.bracketed_paste());
    }

    #[test]
    fn resize_changes_the_reported_size() {
        let mut t = term();
        t.resize(size(40, 10));
        assert_eq!(replies(&t.feed(b"\x1b[18t")), ["\x1b[8;10;40t"]);
    }

    #[test]
    fn scrollback_is_capped_at_ten_thousand_lines() {
        let mut t = term();
        t.feed("x\r\n".repeat(SCROLLBACK + 500).as_bytes());
        t.scroll(5);
        assert_eq!(t.display_offset(), 5);
        t.scroll(i32::MAX / 2);
        assert_eq!(t.display_offset(), SCROLLBACK);
        t.scroll_to_bottom();
        assert_eq!(t.display_offset(), 0);
    }

    #[test]
    fn drag_word_and_line_selection() {
        let mut t = term();
        t.feed(b"hello world");
        t.selection_start(Cell { row: 0, col: 0 }, SelectKind::Simple);
        assert!(
            t.selection_text().is_none(),
            "a click alone selects nothing"
        );
        t.selection_update(Cell { row: 0, col: 4 });
        assert_eq!(t.selection_text().as_deref(), Some("hello"));
        assert!(t.context().has_selection);
        t.selection_start(Cell { row: 0, col: 7 }, SelectKind::Word);
        assert_eq!(t.selection_text().as_deref(), Some("world"));
        t.selection_start(Cell { row: 0, col: 3 }, SelectKind::Line);
        assert_eq!(t.selection_text().unwrap().trim_end(), "hello world");
        t.clear_selection();
        assert!(!t.context().has_selection);
    }
}
