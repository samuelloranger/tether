//! [`TerminalParser`] backed by `alacritty_terminal`.
//!
//! Chosen for v1 because it is pure Rust, cross-compiles to iOS, and is battle-tested.
//! The trait boundary keeps a future `libghostty-vt` swap isolated to this file.

use alacritty_terminal::event::VoidListener;
use alacritty_terminal::grid::{Dimensions, Scroll};
use alacritty_terminal::index::{Column, Line, Point};
use alacritty_terminal::term::cell::{Cell, Flags};
use alacritty_terminal::term::color::Colors;
use alacritty_terminal::term::{point_to_viewport, Config, Term, TermMode};
use alacritty_terminal::vte::ansi::{Color, CursorShape, NamedColor, Processor, Rgb};
use unicode_normalization::UnicodeNormalization;

use crate::pty_input::MouseMode;

use super::{
    TerminalCell, TerminalParser, TerminalSnapshot, GRID_ATTR_BOLD, GRID_ATTR_DIM,
    GRID_ATTR_INVERSE, GRID_ATTR_ITALIC, GRID_ATTR_STRIKETHROUGH, GRID_ATTR_UNDERLINE,
};

const DEFAULT_SCROLLBACK: usize = 10_000;

/// Default palette for resolving indexed and named colors at snapshot time.
#[derive(Debug, Clone, Copy)]
struct TerminalTheme {
    foreground: u32,
    background: u32,
    black: u32,
    red: u32,
    green: u32,
    yellow: u32,
    blue: u32,
    magenta: u32,
    cyan: u32,
    white: u32,
    bright_black: u32,
    bright_red: u32,
    bright_green: u32,
    bright_yellow: u32,
    bright_blue: u32,
    bright_magenta: u32,
    bright_cyan: u32,
    bright_white: u32,
}

impl Default for TerminalTheme {
    fn default() -> Self {
        Self {
            foreground: argb(0xff, 0xcc, 0xcc, 0xcc),
            background: argb(0xff, 0x1e, 0x1e, 0x2e),
            black: argb(0xff, 0x1e, 0x1e, 0x2e),
            red: argb(0xff, 0xf3, 0x8b, 0xa8),
            green: argb(0xff, 0xa6, 0xe3, 0xa1),
            yellow: argb(0xff, 0xf9, 0xe2, 0xaf),
            blue: argb(0xff, 0x89, 0xb4, 0xfa),
            magenta: argb(0xff, 0xcb, 0xa6, 0xf7),
            cyan: argb(0xff, 0x94, 0xe2, 0xd5),
            white: argb(0xff, 0xcd, 0xd6, 0xf4),
            bright_black: argb(0xff, 0x58, 0x58, 0x72),
            bright_red: argb(0xff, 0xf3, 0x8b, 0xa8),
            bright_green: argb(0xff, 0xa6, 0xe3, 0xa1),
            bright_yellow: argb(0xff, 0xf9, 0xe2, 0xaf),
            bright_blue: argb(0xff, 0x89, 0xb4, 0xfa),
            bright_magenta: argb(0xff, 0xcb, 0xa6, 0xf7),
            bright_cyan: argb(0xff, 0x94, 0xe2, 0xd5),
            bright_white: argb(0xff, 0xff, 0xff, 0xff),
        }
    }
}

struct TermDimensions {
    cols: usize,
    rows: usize,
    scrollback: usize,
}

impl Dimensions for TermDimensions {
    fn total_lines(&self) -> usize {
        self.rows + self.scrollback
    }

    fn screen_lines(&self) -> usize {
        self.rows
    }

    fn columns(&self) -> usize {
        self.cols
    }
}

/// VT parser backed by Alacritty's grid model.
pub struct AlacrittyParser {
    term: Term<VoidListener>,
    processor: Processor,
    cols: u16,
    rows: u16,
    scrollback: usize,
    theme: TerminalTheme,
    generation: u64,
    visible_digest: Vec<u8>,
}

impl AlacrittyParser {
    pub fn new(cols: u16, rows: u16) -> Self {
        Self::with_scrollback(cols, rows, DEFAULT_SCROLLBACK)
    }

    pub fn with_scrollback(cols: u16, rows: u16, scrollback: usize) -> Self {
        let config = Config {
            scrolling_history: scrollback,
            ..Config::default()
        };
        let dimensions = TermDimensions {
            cols: cols as usize,
            rows: rows as usize,
            scrollback,
        };
        let term = Term::new(config, &dimensions, VoidListener);
        let mut parser = Self {
            term,
            processor: Processor::new(),
            cols,
            rows,
            scrollback,
            theme: TerminalTheme::default(),
            generation: 0,
            visible_digest: Vec::new(),
        };
        parser.visible_digest = parser.compute_visible_digest();
        parser
    }

    fn maybe_bump_generation(&mut self, before: Vec<u8>) {
        let after = self.compute_visible_digest();
        if after != before {
            self.generation = self.generation.saturating_add(1);
            self.visible_digest = after;
        }
    }

    fn compute_visible_digest(&self) -> Vec<u8> {
        let view = self.extract_view();
        pack_digest(&view)
    }

    fn extract_view(&self) -> TerminalSnapshot {
        let cols = self.term.columns();
        let rows = self.term.screen_lines();
        let colors = self.term.colors();
        let renderable = self.term.renderable_content();
        let display_offset = renderable.display_offset;

        let cell_count = cols * rows;
        let mut cells = vec![empty_cell(&self.theme); cell_count];

        for indexed in renderable.display_iter {
            let Some(viewpoint) = point_to_viewport(display_offset, indexed.point) else {
                continue;
            };
            let row = viewpoint.line;
            let col = viewpoint.column.0;
            if row >= rows || col >= cols {
                continue;
            }
            cells[row * cols + col] = map_cell(indexed.cell, colors, &self.theme);
        }

        let cursor_visible = renderable.mode.contains(TermMode::SHOW_CURSOR)
            && renderable.cursor.shape != CursorShape::Hidden;
        let (cursor_row, cursor_col) =
            cursor_viewport(display_offset, renderable.cursor.point, rows, cols);

        TerminalSnapshot {
            cols: cols as u16,
            rows: rows as u16,
            cursor_col,
            cursor_row,
            generation: self.generation,
            cursor_visible,
            cells,
        }
    }
}

impl TerminalParser for AlacrittyParser {
    fn feed(&mut self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        let before = self.visible_digest.clone();
        self.processor.advance(&mut self.term, bytes);
        self.maybe_bump_generation(before);
    }

    fn resize(&mut self, cols: u16, rows: u16) {
        if cols == self.cols && rows == self.rows {
            return;
        }
        let before = self.visible_digest.clone();
        // Exact-width line + LF leaves a blank spacer row with WRAPLINE set.
        // Alacritty's column reflow can then invent leading spaces on the next
        // content row. Strip WRAPLINE from visually blank rows before any
        // column change (grow or shrink→grow cycles).
        if cols != self.cols {
            clear_spurious_wraplines(&mut self.term);
        }
        let dimensions = TermDimensions {
            cols: cols as usize,
            rows: rows as usize,
            scrollback: self.scrollback,
        };
        self.term.resize(dimensions);
        self.cols = cols;
        self.rows = rows;
        self.maybe_bump_generation(before);
    }

    fn scroll_viewport(&mut self, lines: i32) {
        if lines == 0 {
            return;
        }
        let before = self.visible_digest.clone();
        self.term.scroll_display(Scroll::Delta(lines));
        self.maybe_bump_generation(before);
    }

    fn bracketed_paste(&self) -> bool {
        self.term.mode().contains(TermMode::BRACKETED_PASTE)
    }

    fn mouse_mode(&self) -> MouseMode {
        mouse_mode_from_term(self.term.mode())
    }

    fn mouse_sgr(&self) -> bool {
        self.term.mode().contains(TermMode::SGR_MOUSE)
    }

    fn generation(&self) -> u64 {
        self.generation
    }

    fn snapshot(&self) -> TerminalSnapshot {
        self.extract_view()
    }
}

/// Map Alacritty's mouse TermMode bits onto our MouseMode vocabulary.
///
/// Alacritty does not expose classic X10 (mode 9) as a distinct flag — click-only
/// tracking is DECSET 1000 (`MOUSE_REPORT_CLICK`) → `Normal`.
fn mouse_mode_from_term(mode: &TermMode) -> MouseMode {
    if mode.contains(TermMode::MOUSE_MOTION) {
        MouseMode::Any
    } else if mode.contains(TermMode::MOUSE_DRAG) {
        MouseMode::Button
    } else if mode.contains(TermMode::MOUSE_REPORT_CLICK) {
        MouseMode::Normal
    } else {
        MouseMode::Off
    }
}

/// Drop WRAPLINE on rows that have no visible content.
///
/// Exact-width output + LF leaves a blank spacer row with WRAPLINE set. Alacritty's
/// column-grow reflow then joins that spacer to the next content row, inventing
/// leading spaces equal to the old width. Real soft-wraps always have glyphs on
/// the WRAPLINE row, so they are left alone.
fn clear_spurious_wraplines(term: &mut Term<VoidListener>) {
    let cols = term.columns();
    if cols == 0 {
        return;
    }
    let last_col = Column(cols - 1);
    let history = term.grid().history_size() as i32;
    let screen = term.screen_lines() as i32;
    let top = -history;
    let last = screen - 1;
    for line_no in top..=last {
        let line = Line(line_no);
        if !term.grid()[line][last_col].flags.contains(Flags::WRAPLINE) {
            continue;
        }
        if row_is_visually_blank(&term.grid()[line]) {
            term.grid_mut()[line][last_col].flags.remove(Flags::WRAPLINE);
        }
    }
}

fn row_is_visually_blank(row: &alacritty_terminal::grid::Row<Cell>) -> bool {
    row.into_iter().all(|cell| cell.c == ' ' || cell.c == '\0')
}

fn empty_cell(theme: &TerminalTheme) -> TerminalCell {
    TerminalCell {
        codepoint: b' ' as u32,
        fg: theme.foreground,
        bg: theme.background,
        attrs: 0,
    }
}

fn map_cell(cell: &Cell, colors: &Colors, theme: &TerminalTheme) -> TerminalCell {
    let codepoint = if cell
        .flags
        .intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER)
    {
        b' ' as u32
    } else {
        cell_codepoint(cell)
    };

    let mut attrs = 0_u32;
    if cell.flags.contains(Flags::BOLD) {
        attrs |= GRID_ATTR_BOLD;
    }
    if cell.flags.contains(Flags::ITALIC) {
        attrs |= GRID_ATTR_ITALIC;
    }
    if cell.flags.intersects(Flags::ALL_UNDERLINES) {
        attrs |= GRID_ATTR_UNDERLINE;
    }
    if cell.flags.contains(Flags::INVERSE) {
        attrs |= GRID_ATTR_INVERSE;
    }
    if cell.flags.contains(Flags::DIM) {
        attrs |= GRID_ATTR_DIM;
    }
    if cell.flags.contains(Flags::STRIKEOUT) {
        attrs |= GRID_ATTR_STRIKETHROUGH;
    }

    TerminalCell {
        codepoint,
        fg: resolve_color(cell.fg, colors, theme),
        bg: resolve_color(cell.bg, colors, theme),
        attrs,
    }
}

/// Base char plus combining marks, NFC-composed into one codepoint when possible.
fn cell_codepoint(cell: &Cell) -> u32 {
    let Some(marks) = cell.zerowidth().filter(|m| !m.is_empty()) else {
        return u32::from(cell.c);
    };
    let mut raw = String::with_capacity(marks.len() + 1);
    raw.push(cell.c);
    for mark in marks {
        raw.push(*mark);
    }
    let composed: String = raw.nfc().collect();
    composed
        .chars()
        .next()
        .map(u32::from)
        .unwrap_or_else(|| u32::from(cell.c))
}

fn cursor_viewport(display_offset: usize, point: Point, rows: usize, cols: usize) -> (u16, u16) {
    if let Some(view) = point_to_viewport(display_offset, point) {
        let row = view.line.min(rows.saturating_sub(1));
        let col = view.column.0.min(cols.saturating_sub(1));
        (row as u16, col as u16)
    } else {
        (
            point.line.0.max(0) as u16,
            point.column.0.min(cols.saturating_sub(1)) as u16,
        )
    }
}

fn resolve_color(color: Color, colors: &Colors, theme: &TerminalTheme) -> u32 {
    match color {
        Color::Named(named) => {
            let rgb = colors[named].unwrap_or_else(|| default_named_rgb(named, theme));
            argb(0xff, rgb.r, rgb.g, rgb.b)
        }
        Color::Spec(Rgb { r, g, b }) => argb(0xff, r, g, b),
        Color::Indexed(index) => {
            if let Some(rgb) = colors[index as usize] {
                argb(0xff, rgb.r, rgb.g, rgb.b)
            } else {
                indexed_color(index, colors, theme)
            }
        }
    }
}

fn indexed_color(index: u8, colors: &Colors, theme: &TerminalTheme) -> u32 {
    match index {
        0..=15 => {
            let named = match index {
                0 => NamedColor::Black,
                1 => NamedColor::Red,
                2 => NamedColor::Green,
                3 => NamedColor::Yellow,
                4 => NamedColor::Blue,
                5 => NamedColor::Magenta,
                6 => NamedColor::Cyan,
                7 => NamedColor::White,
                8 => NamedColor::BrightBlack,
                9 => NamedColor::BrightRed,
                10 => NamedColor::BrightGreen,
                11 => NamedColor::BrightYellow,
                12 => NamedColor::BrightBlue,
                13 => NamedColor::BrightMagenta,
                14 => NamedColor::BrightCyan,
                15 => NamedColor::BrightWhite,
                _ => NamedColor::White,
            };
            let rgb = colors[named].unwrap_or_else(|| default_named_rgb(named, theme));
            argb(0xff, rgb.r, rgb.g, rgb.b)
        }
        16..=231 => {
            let index = index - 16;
            let r = (index / 36) * 51;
            let g = ((index / 6) % 6) * 51;
            let b = (index % 6) * 51;
            argb(0xff, r, g, b)
        }
        232..=255 => {
            let gray = u32::from(index - 232) * 10 + 8;
            argb(0xff, gray as u8, gray as u8, gray as u8)
        }
    }
}

fn default_named_rgb(named: NamedColor, theme: &TerminalTheme) -> Rgb {
    let rgb = |value: u32| -> Rgb {
        Rgb {
            r: ((value >> 16) & 0xff) as u8,
            g: ((value >> 8) & 0xff) as u8,
            b: (value & 0xff) as u8,
        }
    };

    match named {
        NamedColor::Black => rgb(theme.black),
        NamedColor::Red => rgb(theme.red),
        NamedColor::Green => rgb(theme.green),
        NamedColor::Yellow => rgb(theme.yellow),
        NamedColor::Blue => rgb(theme.blue),
        NamedColor::Magenta => rgb(theme.magenta),
        NamedColor::Cyan => rgb(theme.cyan),
        NamedColor::White => rgb(theme.white),
        NamedColor::BrightBlack => rgb(theme.bright_black),
        NamedColor::BrightRed => rgb(theme.bright_red),
        NamedColor::BrightGreen => rgb(theme.bright_green),
        NamedColor::BrightYellow => rgb(theme.bright_yellow),
        NamedColor::BrightBlue => rgb(theme.bright_blue),
        NamedColor::BrightMagenta => rgb(theme.bright_magenta),
        NamedColor::BrightCyan => rgb(theme.bright_cyan),
        NamedColor::BrightWhite => rgb(theme.bright_white),
        NamedColor::Foreground | NamedColor::BrightForeground => rgb(theme.foreground),
        NamedColor::Background => rgb(theme.background),
        NamedColor::Cursor => rgb(theme.foreground),
        NamedColor::DimBlack => rgb(dim(theme.black)),
        NamedColor::DimRed => rgb(dim(theme.red)),
        NamedColor::DimGreen => rgb(dim(theme.green)),
        NamedColor::DimYellow => rgb(dim(theme.yellow)),
        NamedColor::DimBlue => rgb(dim(theme.blue)),
        NamedColor::DimMagenta => rgb(dim(theme.magenta)),
        NamedColor::DimCyan => rgb(dim(theme.cyan)),
        NamedColor::DimWhite => rgb(dim(theme.white)),
        NamedColor::DimForeground => rgb(dim(theme.foreground)),
    }
}

fn dim(color: u32) -> u32 {
    let r = ((color >> 16) & 0xff) as u16 * 128 / 255;
    let g = ((color >> 8) & 0xff) as u16 * 128 / 255;
    let b = (color & 0xff) as u16 * 128 / 255;
    argb(0xff, r as u8, g as u8, b as u8)
}

fn argb(a: u8, r: u8, g: u8, b: u8) -> u32 {
    u32::from(a) << 24 | u32::from(r) << 16 | u32::from(g) << 8 | u32::from(b)
}

fn pack_digest(snapshot: &TerminalSnapshot) -> Vec<u8> {
    // FNV-1a over the visible state — equality only, not a cryptographic hash.
    // Cheaper than packing every cell into the digest buffer on every feed.
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    let mut mix = |value: u64| {
        hash ^= value;
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    };
    mix(u64::from(snapshot.cols));
    mix(u64::from(snapshot.rows));
    mix(u64::from(snapshot.cursor_col));
    mix(u64::from(snapshot.cursor_row));
    mix(u64::from(snapshot.cursor_visible));
    for cell in &snapshot.cells {
        mix(u64::from(cell.codepoint));
        mix(u64::from(cell.fg));
        mix(u64::from(cell.bg));
        mix(u64::from(cell.attrs));
    }
    hash.to_le_bytes().to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pty_input::MouseMode;
    use crate::terminal::TerminalParser;

    fn cell_text(snapshot: &TerminalSnapshot, row: usize) -> String {
        let cols = snapshot.cols as usize;
        snapshot.cells[row * cols..(row + 1) * cols]
            .iter()
            .map(|cell| char::from_u32(cell.codepoint).unwrap_or(' '))
            .collect::<String>()
            .trim_end()
            .to_string()
    }

    #[test]
    fn bracketed_paste_tracks_decset_2004() {
        let mut parser = AlacrittyParser::new(20, 5);
        assert!(!parser.bracketed_paste());
        parser.feed(b"\x1b[?2004h");
        assert!(parser.bracketed_paste());
        parser.feed(b"\x1b[?2004l");
        assert!(!parser.bracketed_paste());
    }

    #[test]
    fn plain_text_lands_on_row_zero() {
        let mut parser = AlacrittyParser::new(20, 5);
        parser.feed(b"hello");
        let snapshot = parser.snapshot();
        assert_eq!(cell_text(&snapshot, 0), "hello");
    }

    #[test]
    fn truecolor_sgr_sets_foreground() {
        let mut parser = AlacrittyParser::new(20, 5);
        parser.feed(b"\x1b[38;2;255;0;0mR\x1b[0m");
        let snapshot = parser.snapshot();
        let red = snapshot.cells.first().expect("first cell");
        assert_eq!(red.codepoint, b'R' as u32);
        assert_eq!(red.fg, argb(0xff, 0xff, 0x00, 0x00));
    }

    #[test]
    fn bold_and_wide_char_occupy_two_columns() {
        let mut parser = AlacrittyParser::new(20, 5);
        parser.feed("\x1b[1mAB\x1b[0m\u{4f60}".as_bytes());
        let snapshot = parser.snapshot();
        assert_eq!(snapshot.cells[0].codepoint, b'A' as u32);
        assert_eq!(snapshot.cells[0].attrs & GRID_ATTR_BOLD, GRID_ATTR_BOLD);
        assert_eq!(snapshot.cells[1].codepoint, b'B' as u32);
        assert_eq!(snapshot.cells[2].codepoint, '\u{4f60}' as u32);
        assert_eq!(snapshot.cells[3].codepoint, b' ' as u32);
    }

    #[test]
    fn combining_mark_nfc_composes_into_one_codepoint() {
        let mut parser = AlacrittyParser::new(20, 5);
        parser.feed("e\u{0301}".as_bytes());
        let snapshot = parser.snapshot();
        assert_eq!(snapshot.cells[0].codepoint, 'é' as u32);
        assert_eq!(snapshot.cells[1].codepoint, b' ' as u32);
        assert_eq!(cell_text(&snapshot, 0), "é");
    }

    #[test]
    fn mouse_mode_tracks_decset_1000_family() {
        let mut parser = AlacrittyParser::new(20, 5);
        assert_eq!(parser.mouse_mode(), MouseMode::Off);
        assert!(!parser.mouse_sgr());
        parser.feed(b"\x1b[?1000h");
        assert_eq!(parser.mouse_mode(), MouseMode::Normal);
        parser.feed(b"\x1b[?1002h");
        assert_eq!(parser.mouse_mode(), MouseMode::Button);
        parser.feed(b"\x1b[?1003h");
        assert_eq!(parser.mouse_mode(), MouseMode::Any);
        parser.feed(b"\x1b[?1006h");
        assert!(parser.mouse_sgr());
        parser.feed(b"\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l");
        assert_eq!(parser.mouse_mode(), MouseMode::Off);
        assert!(!parser.mouse_sgr());
    }

    #[test]
    fn generation_increments_when_visible_grid_changes() {
        let mut parser = AlacrittyParser::new(20, 5);
        assert_eq!(parser.generation(), 0);
        parser.feed(b"x");
        assert_eq!(parser.generation(), 1);
        parser.feed(b"y");
        assert_eq!(parser.generation(), 2);
    }

    #[test]
    fn generation_does_not_increment_on_no_op_feed() {
        let mut parser = AlacrittyParser::new(20, 5);
        parser.feed(b"hi");
        assert_eq!(parser.generation(), 1);
        parser.feed(b"\x07");
        assert_eq!(parser.generation(), 1);
        parser.feed(b"\x1b[?25h");
        assert_eq!(parser.generation(), 1);
        parser.feed(&[]);
        assert_eq!(parser.generation(), 1);
    }

    #[test]
    fn cursor_visibility_change_bumps_generation() {
        let mut parser = AlacrittyParser::new(20, 5);
        parser.feed(b"hi\x1b[?25l");
        let hidden = parser.generation();
        assert!(hidden >= 1);
        assert!(!parser.snapshot().cursor_visible);
        parser.feed(b"\x1b[?25h");
        assert_eq!(parser.generation(), hidden + 1);
        assert!(parser.snapshot().cursor_visible);
    }

    #[test]
    fn soft_wrapped_lines_rejoin_when_columns_grow() {
        let mut parser = AlacrittyParser::new(20, 8);
        parser.feed(b"abcdefghijKLMNOPQRST");
        parser.feed(b"uvwxyz0123456789XXXX");
        assert_eq!(cell_text(&parser.snapshot(), 0), "abcdefghijKLMNOPQRST");
        assert_eq!(cell_text(&parser.snapshot(), 1), "uvwxyz0123456789XXXX");
        parser.resize(40, 8);
        assert_eq!(
            cell_text(&parser.snapshot(), 0),
            "abcdefghijKLMNOPQRSTuvwxyz0123456789XXXX"
        );
        assert_eq!(cell_text(&parser.snapshot(), 1), "");
    }

    /// Exact-width line + LF leaves WRAPLINE on the full row and a blank row
    /// beneath it. Alacritty's grow reflow then shoves the next content row to
    /// the right by the old width — the iOS "spaces on resize" screenshot.
    #[test]
    fn exact_width_line_plus_lf_does_not_right_shift_on_grow() {
        let mut parser = AlacrittyParser::new(20, 10);
        parser.feed(b"abcdefghijKLMNOPQRST\n");
        parser.feed(b"uvwxyz0123456789XXXX\n");
        parser.resize(40, 10);
        let snapshot = parser.snapshot();
        let cols = snapshot.cols as usize;
        for r in 0..3 {
            let raw: String = snapshot.cells[r * cols..(r + 1) * cols]
                .iter()
                .map(|c| char::from_u32(c.codepoint).unwrap_or('?'))
                .collect();
            if raw.trim().is_empty() {
                continue;
            }
            let leading = raw.chars().take_while(|c| *c == ' ').count();
            assert_eq!(
                leading, 0,
                "row {r} acquired leading spaces on grow: [{raw}]"
            );
        }
        // Content must stay left-aligned (order may compress the blank LF row).
        let joined: String = (0..3)
            .map(|r| cell_text(&snapshot, r))
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("|");
        assert!(
            joined.contains("abcdefghijKLMNOPQRST"),
            "missing first line in {joined}"
        );
        assert!(
            joined.contains("uvwxyz0123456789XXXX"),
            "missing second line in {joined}"
        );
    }
}
