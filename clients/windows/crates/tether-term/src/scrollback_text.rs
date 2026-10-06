use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Point};

use crate::terminal::TabTerminal;

impl TabTerminal {
    /// The scrollback and the screen as plain text, oldest line first: the local stand-in
    /// when `zmx history` has nothing.
    pub fn scrollback_text(&self) -> String {
        let start = Point::new(self.term.topmost_line(), Column(0));
        let end = Point::new(self.term.bottommost_line(), self.term.last_column());
        self.term.bounds_to_string(start, end)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tether_core::resize::GridSize;
    use tether_core::theme::theme_named;

    #[test]
    fn lines_that_scrolled_off_are_included_in_order() {
        let size = GridSize {
            cols: 20,
            rows: 3,
            width_px: 160,
            height_px: 48,
        };
        let mut t = TabTerminal::new(size, theme_named("tether"));
        for n in 1..=8 {
            t.feed(format!("line {n}\r\n").as_bytes());
        }
        let text = t.scrollback_text();
        let lines: Vec<&str> = text.lines().map(str::trim_end).collect();
        assert_eq!(lines[0], "line 1");
        assert!(lines.contains(&"line 6"));
        assert!(lines.contains(&"line 8"));
    }
}
