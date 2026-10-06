use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Line, Point};
use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::vte::ansi::CursorShape as TermCursorShape;
use tether_core::links::LinkSpan;

use crate::images::{ImageView, is_tag};
use crate::palette;
use crate::search::SearchHit;
use crate::terminal::{Cell, TabTerminal};

#[derive(Debug, Clone, PartialEq)]
pub struct RenderCell {
    pub ch: char,
    pub zerowidth: Vec<char>,
    pub fg: u32,
    pub bg: u32,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub strikeout: bool,
    pub wide: bool,
    pub spacer: bool,
    pub selected: bool,
}

#[derive(Debug, Clone)]
pub struct Snapshot {
    pub cols: usize,
    pub rows: usize,
    pub cells: Vec<RenderCell>,
    pub cursor: Option<Cell>,
    pub row_texts: Vec<String>,
    pub wrapped: Vec<bool>,
    pub osc8: Vec<Vec<LinkSpan>>,
    pub display_offset: usize,
    pub background: u32,
    pub images: Vec<ImageView>,
}

impl Snapshot {
    pub fn cell(&self, row: usize, col: usize) -> &RenderCell {
        &self.cells[row * self.cols + col]
    }
}

impl TabTerminal {
    pub fn snapshot(&self) -> Snapshot {
        let grid = self.term.grid();
        let (cols, rows) = (grid.columns(), grid.screen_lines());
        let offset = grid.display_offset();
        let colors = self.term.colors();
        let theme = &self.theme;
        let selection = self
            .term
            .selection
            .as_ref()
            .and_then(|s| s.to_range(&self.term));

        let matches = self.visible_matches();
        let mut cells = Vec::with_capacity(cols * rows);
        let mut row_texts = Vec::with_capacity(rows);
        let mut wrapped = Vec::with_capacity(rows);
        let mut osc8 = Vec::with_capacity(rows);

        for r in 0..rows {
            let line = Line(r as i32 - offset as i32);
            let row = &grid[line];
            let mut text = String::with_capacity(cols);
            let mut spans: Vec<LinkSpan> = Vec::new();
            for c in 0..cols {
                let cell = &row[Column(c)];
                let flags = cell.flags;
                let spacer =
                    flags.intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER);
                let mut fg = palette::resolve(theme, colors, cell.fg);
                let mut bg = palette::resolve(theme, colors, cell.bg);
                if flags.contains(Flags::DIM) {
                    fg = palette::dim(fg);
                }
                if flags.contains(Flags::INVERSE) {
                    std::mem::swap(&mut fg, &mut bg);
                }
                if flags.contains(Flags::HIDDEN) {
                    fg = bg;
                }
                let selected = selection
                    .as_ref()
                    .is_some_and(|s| s.contains(Point::new(line, Column(c))));
                if !matches.is_empty() {
                    let found = palette::theme_color(theme, 3);
                    match crate::search::hit_at(&matches, Point::new(line, Column(c))) {
                        SearchHit::Current => (fg, bg) = (theme.background, found),
                        SearchHit::Match => bg = palette::mix(found, theme.background, 0.35),
                        SearchHit::None => {}
                    }
                }
                if selected {
                    match theme.selection {
                        Some(sel) => bg = sel,
                        None => (fg, bg) = (theme.background, theme.foreground),
                    }
                }
                // alacritty keeps a tab as '\t' in the cell it lands on; it draws as blank.
                let ch = if spacer || cell.c.is_control() {
                    ' '
                } else {
                    cell.c
                };
                text.push(ch);
                if let Some(link) = cell.hyperlink() {
                    match spans.last_mut() {
                        Some(last) if last.end == c && last.url == link.uri() => last.end = c + 1,
                        _ => spans.push(LinkSpan {
                            start: c,
                            end: c + 1,
                            url: link.uri().to_owned(),
                        }),
                    }
                }
                cells.push(RenderCell {
                    ch,
                    zerowidth: cell
                        .zerowidth()
                        .map(|z| z.iter().copied().filter(|c| !is_tag(*c)).collect())
                        .unwrap_or_default(),
                    fg,
                    bg,
                    bold: flags.contains(Flags::BOLD),
                    italic: flags.contains(Flags::ITALIC),
                    underline: flags.intersects(Flags::ALL_UNDERLINES),
                    strikeout: flags.contains(Flags::STRIKEOUT),
                    wide: flags.contains(Flags::WIDE_CHAR),
                    spacer,
                    selected,
                });
            }
            wrapped.push(row[Column(cols - 1)].flags.contains(Flags::WRAPLINE));
            row_texts.push(text);
            osc8.push(spans);
        }

        let cursor = {
            let rc = self.term.renderable_content().cursor;
            let row = rc.point.line.0 + offset as i32;
            (rc.shape != TermCursorShape::Hidden && (0..rows as i32).contains(&row)).then_some(
                Cell {
                    row: row as usize,
                    col: rc.point.column.0,
                },
            )
        };

        Snapshot {
            cols,
            rows,
            cells,
            cursor,
            row_texts,
            wrapped,
            osc8,
            display_offset: offset,
            background: theme.background,
            images: self.image_views(),
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::terminal::tests::{size, term};
    use crate::terminal::{Cell, SelectKind, TabTerminal};
    use tether_core::theme::theme_named;

    #[test]
    fn plain_text_uses_the_theme_defaults() {
        let mut t = term();
        t.feed(b"hello");
        let s = t.snapshot();
        assert_eq!((s.cols, s.rows, s.cells.len()), (80, 24, 80 * 24));
        assert!(s.row_texts[0].starts_with("hello"));
        assert_eq!(s.cell(0, 0).ch, 'h');
        assert_eq!((s.cell(0, 0).fg, s.cell(0, 0).bg), (0xCCCCCC, 0x1E1E2E));
        assert_eq!(s.background, 0x1E1E2E);
    }

    #[test]
    fn sgr_colors_resolve() {
        let mut t = term();
        t.feed(b"\x1b[31mR\x1b[38;2;1;2;3mT\x1b[0;7mI\x1b[0;8mH\x1b[0;1mB");
        let s = t.snapshot();
        assert_eq!(s.cell(0, 0).fg, 0xF38BA8);
        assert_eq!(s.cell(0, 1).fg, 0x010203);
        assert_eq!((s.cell(0, 2).fg, s.cell(0, 2).bg), (0x1E1E2E, 0xCCCCCC));
        assert_eq!(s.cell(0, 3).fg, s.cell(0, 3).bg);
        assert!(s.cell(0, 4).bold);
    }

    #[test]
    fn an_osc_4_override_colors_the_cells() {
        let mut t = term();
        t.feed(b"\x1b]4;1;rgb:ff/00/00\x07\x1b[31mX");
        assert_eq!(t.snapshot().cell(0, 0).fg, 0xFF0000);
    }

    #[test]
    fn utf8_split_across_reads_is_one_character() {
        let mut t = term();
        t.feed(&[0xC3]);
        t.feed(&[0xA9]);
        assert_eq!(t.snapshot().cell(0, 0).ch, 'é');
    }

    #[test]
    fn wide_characters_take_two_cells() {
        let mut t = term();
        t.feed("界x".as_bytes());
        let s = t.snapshot();
        assert!(s.cell(0, 0).wide);
        assert!(s.cell(0, 1).spacer);
        assert!(s.row_texts[0].starts_with("界 x"));
    }

    #[test]
    fn soft_wraps_are_flagged() {
        let mut t = TabTerminal::new(size(10, 4), theme_named("tether"));
        t.feed(&[b'a'; 15]);
        let s = t.snapshot();
        assert!(s.wrapped[0]);
        assert!(!s.wrapped[1]);
    }

    #[test]
    fn osc_8_links_become_spans() {
        let mut t = term();
        t.feed(b"\x1b]8;;https://example.com\x07link\x1b]8;;\x07 x");
        let s = t.snapshot();
        assert_eq!(s.osc8[0].len(), 1);
        let span = &s.osc8[0][0];
        assert_eq!(
            (span.start, span.end, span.url.as_str()),
            (0, 4, "https://example.com")
        );
        assert!(s.osc8[1].is_empty());
    }

    #[test]
    fn cursor_hides_with_25l_and_when_scrolled_away() {
        let mut t = term();
        t.feed(b"ab");
        assert_eq!(t.snapshot().cursor, Some(Cell { row: 0, col: 2 }));
        t.feed(b"\x1b[?25l");
        assert_eq!(t.snapshot().cursor, None);
        t.feed(b"\x1b[?25h");
        t.feed("x\r\n".repeat(40).as_bytes());
        t.scroll(10);
        assert_eq!(t.snapshot().cursor, None);
    }

    #[test]
    fn a_tab_draws_as_a_blank_cell() {
        let mut t = crate::terminal::tests::term();
        t.feed(b"a\tb\r\n");
        let s = t.snapshot();
        assert!(
            s.row_texts[0].starts_with("a       b"),
            "{:?}",
            s.row_texts[0]
        );
        assert!((0..s.cols).all(|c| !s.cell(0, c).ch.is_control()));
    }

    #[test]
    fn selected_cells_swap_when_the_theme_has_no_selection_color() {
        let mut t = term();
        t.feed(b"hello");
        t.selection_start(Cell { row: 0, col: 0 }, SelectKind::Simple);
        t.selection_update(Cell { row: 0, col: 1 });
        let s = t.snapshot();
        assert!(s.cell(0, 0).selected && !s.cell(0, 2).selected);
        assert_eq!((s.cell(0, 0).fg, s.cell(0, 0).bg), (0x1E1E2E, 0xCCCCCC));
    }
}
