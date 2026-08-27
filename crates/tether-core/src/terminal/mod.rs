//! Terminal grid parser for iOS rendering.
//!
//! The visible grid is exported as a packed TGRD buffer (see `tether-ffi`). Desktop
//! never enables this module — it forwards raw PTY bytes to xterm.js instead.

mod alacritty;

pub use alacritty::AlacrittyParser;

use crate::pty_input::MouseMode;

/// Attribute bits in a TGRD cell — must match `crates/tether-ffi/src/grid_snapshot.rs`.
pub const GRID_ATTR_BOLD: u32 = 1 << 0;
pub const GRID_ATTR_ITALIC: u32 = 1 << 1;
pub const GRID_ATTR_UNDERLINE: u32 = 1 << 2;
pub const GRID_ATTR_INVERSE: u32 = 1 << 3;
pub const GRID_ATTR_DIM: u32 = 1 << 4;
pub const GRID_ATTR_STRIKETHROUGH: u32 = 1 << 5;

/// One cell in the visible viewport.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TerminalCell {
    pub codepoint: u32,
    pub fg: u32,
    pub bg: u32,
    pub attrs: u32,
}

/// Header fields carried alongside the cell array.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalSnapshot {
    pub cols: u16,
    pub rows: u16,
    pub cursor_col: u16,
    pub cursor_row: u16,
    pub generation: u64,
    pub cursor_visible: bool,
    pub cells: Vec<TerminalCell>,
}

/// Parser backend for the iOS terminal surface.
///
/// `AlacrittyParser` is the v1 implementation. A future `libghostty` backend would
/// implement the same trait and map its grid into [`TerminalSnapshot`] without
/// touching callers or the TGRD encoder in `tether-ffi`.
pub trait TerminalParser {
    /// Ingest raw PTY output bytes.
    fn feed(&mut self, bytes: &[u8]);

    /// Resize the visible viewport. Reflows the grid when widening/narrowing.
    fn resize(&mut self, cols: u16, rows: u16);

    /// Scroll the viewport into scrollback (`lines > 0`) or back toward the live
    /// screen (`lines < 0`). No-op on the alternate screen.
    fn scroll_viewport(&mut self, lines: i32);

    /// Whether the program has enabled bracketed paste (DECSET 2004). A paste
    /// must then be wrapped in `ESC[200~` / `ESC[201~` so the program can tell
    /// pasted text from typing — without it, shells run every newline in the
    /// clipboard as a command.
    fn bracketed_paste(&self) -> bool;

    /// Active mouse tracking mode (DECSET 1000/1002/1003), for client input.
    fn mouse_mode(&self) -> MouseMode;

    /// Whether SGR mouse encoding (DECSET 1006) is on.
    fn mouse_sgr(&self) -> bool;

    /// Monotonic counter over visible-grid changes. Unchanged when a feed leaves
    /// the viewport identical — the iOS shell uses this to skip redraws.
    fn generation(&self) -> u64;

    /// Copy the current visible grid and cursor state.
    fn snapshot(&self) -> TerminalSnapshot;
}
