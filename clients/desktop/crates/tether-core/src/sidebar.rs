//! The window's sidebar: its rows, terminals then chats, and the keys that walk them.

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum TabJump {
    Next,
    Prev,
    Position(u8),
    Last,
}

pub const SIDEBAR_WIDTH: f32 = 248.0;
pub const MIN_CONTENT_WIDTH: f32 = 420.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Shown {
    Docked,
    Hidden,
    /// Over the content, in a window too narrow to dock it.
    Overlay,
}

pub fn visibility(pref_open: bool, overlay_requested: bool, window_width: f32) -> Shown {
    let narrow = window_width - SIDEBAR_WIDTH < MIN_CONTENT_WIDTH;
    match (narrow, pref_open, overlay_requested) {
        (false, true, _) => Shown::Docked,
        (_, _, true) => Shown::Overlay,
        _ => Shown::Hidden,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Row {
    Terminal(String),
    Chat(String),
}

pub fn rows(terminals: &[String], chats: &[String]) -> Vec<Row> {
    terminals
        .iter()
        .cloned()
        .map(Row::Terminal)
        .chain(chats.iter().cloned().map(Row::Chat))
        .collect()
}

pub fn jump(rows: &[Row], active: Option<&Row>, jump: TabJump) -> Option<Row> {
    let len = rows.len();
    if len == 0 {
        return None;
    }
    let at = active.and_then(|a| rows.iter().position(|r| r == a));
    let index = match jump {
        TabJump::Next => at.map_or(0, |i| (i + 1) % len),
        TabJump::Prev => at.map_or(len - 1, |i| (i + len - 1) % len),
        TabJump::Position(n) => usize::from(n).checked_sub(1).filter(|&i| i < len)?,
        TabJump::Last => len - 1,
    };
    rows.get(index).cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn list() -> Vec<Row> {
        rows(&["a".into(), "b".into()], &["c".into()])
    }

    fn t(n: &str) -> Row {
        Row::Terminal(n.into())
    }

    fn c(n: &str) -> Row {
        Row::Chat(n.into())
    }

    #[test]
    fn visibility_docks_when_open_and_wide_enough() {
        for (open, overlay, width, want) in [
            (true, false, 1200.0, Shown::Docked),
            (false, false, 1200.0, Shown::Hidden),
            (true, false, 640.0, Shown::Hidden),
            (true, true, 640.0, Shown::Overlay),
            (false, true, 640.0, Shown::Overlay),
            (false, true, 1200.0, Shown::Overlay),
            (true, false, 668.0, Shown::Docked),
            (true, false, 667.0, Shown::Hidden),
        ] {
            assert_eq!(
                visibility(open, overlay, width),
                want,
                "{open} {overlay} {width}"
            );
        }
    }

    #[test]
    fn rows_list_terminals_then_chats() {
        assert_eq!(list(), [t("a"), t("b"), c("c")]);
    }

    #[test]
    fn next_and_prev_wrap_across_the_two_sections() {
        let rows = list();
        assert_eq!(jump(&rows, Some(&t("b")), TabJump::Next), Some(c("c")));
        assert_eq!(jump(&rows, Some(&c("c")), TabJump::Next), Some(t("a")));
        assert_eq!(jump(&rows, Some(&t("a")), TabJump::Prev), Some(c("c")));
        assert_eq!(jump(&rows, None, TabJump::Next), Some(t("a")));
        assert_eq!(jump(&rows, None, TabJump::Prev), Some(c("c")));
    }

    #[test]
    fn positions_count_down_the_whole_list() {
        let rows = list();
        assert_eq!(jump(&rows, None, TabJump::Position(3)), Some(c("c")));
        assert_eq!(jump(&rows, None, TabJump::Position(4)), None);
        assert_eq!(jump(&rows, None, TabJump::Position(0)), None);
        assert_eq!(jump(&rows, Some(&t("a")), TabJump::Last), Some(c("c")));
    }

    #[test]
    fn jumps_on_an_empty_list_do_nothing() {
        for j in [
            TabJump::Next,
            TabJump::Prev,
            TabJump::Position(1),
            TabJump::Last,
        ] {
            assert_eq!(jump(&[], None, j), None);
            assert_eq!(jump(&[], Some(&t("gone")), j), None);
        }
    }
}
