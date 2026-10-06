//! `zmx history`: a session's earlier output as plain text, shown read-only.

use crate::zmx::{ZMX, shell_quote, valid_session_name};

/// Roughly what a read-only text view can hold without stalling.
pub const MAX_BYTES: usize = 256 << 10;

pub fn history_command(name: &str) -> Option<String> {
    valid_session_name(name).then(|| format!("{ZMX} history {}", shell_quote(name)))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct History {
    pub text: String,
    /// The start was cut to fit `MAX_BYTES`.
    pub truncated: bool,
}

impl History {
    pub fn is_empty(&self) -> bool {
        self.text.is_empty()
    }
}

/// Escape sequences and control bytes out, CRLF to LF, trailing blank space off, and the
/// oldest lines dropped when the text is over `MAX_BYTES`.
pub fn clean(raw: &str) -> History {
    let plain = strip_escapes(raw);
    let mut text = plain
        .lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n");
    text.truncate(text.trim_end().len());
    let leading = text.len() - text.trim_start_matches('\n').len();
    text.drain(..leading);
    let mut truncated = false;
    if text.len() > MAX_BYTES {
        let mut cut = text.len() - MAX_BYTES;
        while !text.is_char_boundary(cut) {
            cut += 1;
        }
        // Start on a whole line.
        if let Some(nl) = text[cut..].find('\n') {
            cut += nl + 1;
        }
        text.drain(..cut);
        truncated = true;
    }
    History { text, truncated }
}

fn strip_escapes(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\u{1b}' => skip_sequence(&mut chars),
            '\n' | '\t' => out.push(c),
            '\r' => {
                // CRLF is a line end; a lone CR only moved the cursor.
                if chars.peek() == Some(&'\n') {
                    continue;
                }
            }
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    out
}

fn skip_sequence(chars: &mut std::iter::Peekable<std::str::Chars<'_>>) {
    match chars.next() {
        Some('[') => {
            for c in chars.by_ref() {
                if ('\u{40}'..='\u{7e}').contains(&c) {
                    break;
                }
            }
        }
        Some(']' | 'P' | '_' | '^' | 'X') => {
            while let Some(c) = chars.next() {
                if c == '\u{7}' || (c == '\u{1b}' && chars.next_if_eq(&'\\').is_some()) {
                    break;
                }
            }
        }
        // A charset or similar: intermediates, then one final byte.
        Some(c) if ('\u{20}'..='\u{2f}').contains(&c) => {
            while chars
                .next_if(|n| ('\u{20}'..='\u{2f}').contains(n))
                .is_some()
            {}
            chars.next();
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_is_quoted_and_needs_a_valid_name() {
        assert_eq!(
            history_command("build").as_deref(),
            Some("~/.local/bin/zmx history 'build'")
        );
        assert_eq!(
            history_command("it's $(x)").as_deref(),
            Some(r#"~/.local/bin/zmx history 'it'"'"'s $(x)'"#)
        );
        for bad in ["", "a\nb", "-rf", "a\u{1b}b"] {
            assert_eq!(history_command(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn colors_titles_and_charsets_are_stripped() {
        let raw = "\x1b[1;31mred\x1b[0m text\n\x1b]0;title\x07next\x1b]8;;https://x\x1b\\link\n\x1b(Bplain\x1b[?25h\n";
        assert_eq!(clean(raw).text, "red text\nnextlink\nplain");
    }

    #[test]
    fn line_endings_and_control_bytes() {
        assert_eq!(clean("a\r\nb\rc\x07\x00d\te\r\n").text, "a\nbcd\te");
    }

    #[test]
    fn blank_edges_go_and_inner_blank_lines_stay() {
        assert_eq!(clean("\n\n  one  \n\n two\n\n   \n").text, "  one\n\n two");
        assert!(clean("\n \x1b[0m\n").is_empty());
        assert!(clean("").is_empty());
    }

    #[test]
    fn a_stray_escape_does_not_eat_the_rest() {
        assert_eq!(clean("a\x1b").text, "a");
        assert_eq!(clean("a\x1b[").text, "a");
        assert_eq!(clean("a\x1bMb").text, "ab");
    }

    #[test]
    fn long_history_keeps_the_newest_whole_lines() {
        let line = format!("{}\n", "x".repeat(99));
        let raw = format!("OLDEST\n{}NEWEST", line.repeat(MAX_BYTES / 100 + 50));
        let h = clean(&raw);
        assert!(h.truncated);
        assert!(h.text.len() <= MAX_BYTES);
        assert!(h.text.ends_with("NEWEST"));
        assert!(!h.text.contains("OLDEST"));
        assert!(h.text.starts_with('x'));
        assert!(!clean("short").truncated);
    }

    #[test]
    fn truncation_respects_multibyte_characters() {
        let raw = "日本語の行\n".repeat(MAX_BYTES / 4);
        let h = clean(&raw);
        assert!(h.truncated);
        assert!(h.text.chars().all(|c| c != '\u{fffd}'));
        assert!(h.text.starts_with("日本語の行"));
    }
}
