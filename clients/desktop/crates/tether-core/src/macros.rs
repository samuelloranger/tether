//! Snippet text with escapes for the bytes a settings field can't hold. Same rules as the iOS
//! `MacroText`: `\r` and `\n` send Return (terminals expect CR), `\t` Tab, `\e` Esc, `\cX`
//! Ctrl-X (`\c?` is DEL), `\xHH` one ASCII byte, `\\` a backslash. Any other backslash is kept.

use crate::keymap::ctrl_fold;

pub fn expand(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            out.push(ch);
            continue;
        }
        let mut ahead = chars.clone();
        match ahead.next() {
            Some('r' | 'n') => {
                out.push('\r');
                chars = ahead;
            }
            Some('t') => {
                out.push('\t');
                chars = ahead;
            }
            Some('e') => {
                out.push('\u{1b}');
                chars = ahead;
            }
            Some('\\') => {
                out.push('\\');
                chars = ahead;
            }
            Some('c') => match ahead.next() {
                Some('?') => {
                    out.push('\u{7f}');
                    chars = ahead;
                }
                Some(target) => match ctrl_fold(target) {
                    Some(byte) => {
                        out.push(byte as char);
                        chars = ahead;
                    }
                    None => out.push(ch),
                },
                None => out.push(ch),
            },
            Some('x') => {
                let digits: String = ahead.by_ref().take(2).collect();
                match u8::from_str_radix(&digits, 16) {
                    Ok(v) if digits.len() == 2 && v < 0x80 => {
                        out.push(v as char);
                        chars = ahead;
                    }
                    _ => out.push(ch),
                }
            }
            _ => out.push(ch),
        }
    }
    out
}

/// The bytes with control characters made visible, for the editor and the palette.
pub fn visible(bytes: &str) -> String {
    bytes
        .chars()
        .map(|c| match c as u32 {
            0x0d => "⏎".to_string(),
            0x09 => "⇥".to_string(),
            0x1b => "⎋".to_string(),
            0x7f => "^?".to_string(),
            v @ 0..0x20 => format!("^{}", (v as u8 + 0x40) as char),
            _ => c.to_string(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn return_tab_escape_and_backslash() {
        assert_eq!(expand(r"ls\n"), "ls\r");
        assert_eq!(expand(r"a\rb"), "a\rb");
        assert_eq!(expand(r"a\tb"), "a\tb");
        assert_eq!(expand(r"\e[A"), "\u{1b}[A");
        assert_eq!(expand(r"a\\n"), "a\\n");
    }

    #[test]
    fn control_letters_and_del() {
        assert_eq!(expand(r"\cC"), "\u{3}");
        assert_eq!(expand(r"\cd"), "\u{4}");
        assert_eq!(expand(r"\c["), "\u{1b}");
        assert_eq!(expand(r"\c?"), "\u{7f}");
    }

    #[test]
    fn hex_is_one_ascii_byte() {
        assert_eq!(expand(r"\x41\x7f"), "A\u{7f}");
        assert_eq!(expand(r"\x80"), r"\x80");
        assert_eq!(expand(r"\x4"), r"\x4");
        assert_eq!(expand(r"\xZZ"), r"\xZZ");
    }

    #[test]
    fn unknown_and_trailing_escapes_stay_as_typed() {
        assert_eq!(expand(r"\q"), r"\q");
        assert_eq!(expand(r"\c"), r"\c");
        assert_eq!(expand(r"\c1"), r"\c1");
        assert_eq!(expand("end\\"), "end\\");
        assert_eq!(expand("日本\\n"), "日本\r");
    }

    #[test]
    fn visible_marks_control_bytes() {
        assert_eq!(visible("ls\r"), "ls⏎");
        assert_eq!(visible("\u{3}\u{1b}\t\u{7f}"), "^C⎋⇥^?");
        assert_eq!(visible("plain"), "plain");
    }
}
