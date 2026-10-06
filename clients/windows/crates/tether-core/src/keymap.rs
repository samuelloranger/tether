use std::str;

const ESC: u8 = 0x1b;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Mods {
    pub shift: bool,
    pub alt: bool,
    pub ctrl: bool,
}

impl Mods {
    /// The xterm modifier parameter: 1 + Shift 1 + Alt 2 + Ctrl 4.
    pub fn param(self) -> u8 {
        1 + self.shift as u8 + 2 * self.alt as u8 + 4 * self.ctrl as u8
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NumpadKey {
    Digit(u8),
    Decimal,
    Add,
    Subtract,
    Multiply,
    Divide,
    Enter,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NamedKey {
    Up,
    Down,
    Left,
    Right,
    Home,
    End,
    Insert,
    Delete,
    PageUp,
    PageDown,
    F(u8),
    Tab,
    Enter,
    Backspace,
    Escape,
    Space,
    Numpad(NumpadKey),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyInput {
    Named(NamedKey),
    Char {
        unmodified: char,
        produced: Option<String>,
        digit: Option<u8>,
    },
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct KeyContext {
    pub app_cursor: bool,
    pub app_keypad: bool,
    pub alt_screen: bool,
    pub mouse_reporting: bool,
    pub has_selection: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TetherCommand {
    Paste,
    Copy,
    FontBigger,
    FontSmaller,
    FontReset,
    NextTab,
    PrevTab,
    TabAt(u8),
    LastTab,
    NewTab,
    Find,
    ScrollPageUp,
    ScrollPageDown,
    Snippets,
    History,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyAction {
    Send(Vec<u8>),
    Tether(TetherCommand),
    Ignore,
}

pub fn encode_key(input: &KeyInput, mods: Mods, ctx: &KeyContext) -> KeyAction {
    match input {
        KeyInput::Named(key) => encode_named(*key, mods, ctx),
        KeyInput::Char {
            unmodified,
            produced,
            digit,
        } => encode_char(*unmodified, produced.as_deref(), *digit, mods, ctx),
    }
}

fn csi_final(f: char, m: u8) -> Vec<u8> {
    if m == 1 {
        format!("\x1b[{f}")
    } else {
        format!("\x1b[1;{m}{f}")
    }
    .into_bytes()
}

fn cursor(f: char, m: u8, application: bool) -> Vec<u8> {
    if m == 1 && application {
        format!("\x1bO{f}").into_bytes()
    } else {
        csi_final(f, m)
    }
}

fn tilde(n: u8, m: u8) -> Vec<u8> {
    if m == 1 {
        format!("\x1b[{n}~")
    } else {
        format!("\x1b[{n};{m}~")
    }
    .into_bytes()
}

fn with_alt(alt: bool, byte: u8) -> Vec<u8> {
    if alt { vec![ESC, byte] } else { vec![byte] }
}

fn encode_named(key: NamedKey, mods: Mods, ctx: &KeyContext) -> KeyAction {
    let m = mods.param();
    let only_shift = mods
        == Mods {
            shift: true,
            ..Mods::default()
        };
    let bytes = match key {
        NamedKey::Up => cursor('A', m, ctx.app_cursor),
        NamedKey::Down => cursor('B', m, ctx.app_cursor),
        NamedKey::Right => cursor('C', m, ctx.app_cursor),
        NamedKey::Left => cursor('D', m, ctx.app_cursor),
        NamedKey::Home => cursor('H', m, ctx.app_cursor),
        NamedKey::End => cursor('F', m, ctx.app_cursor),
        NamedKey::Insert if only_shift => return KeyAction::Tether(TetherCommand::Paste),
        NamedKey::Insert => tilde(2, m),
        NamedKey::Delete => tilde(3, m),
        NamedKey::PageUp | NamedKey::PageDown
            if only_shift && !ctx.alt_screen && !ctx.mouse_reporting =>
        {
            let cmd = if key == NamedKey::PageUp {
                TetherCommand::ScrollPageUp
            } else {
                TetherCommand::ScrollPageDown
            };
            return KeyAction::Tether(cmd);
        }
        NamedKey::PageUp => tilde(5, m),
        NamedKey::PageDown => tilde(6, m),
        NamedKey::F(n @ 1..=4) => {
            let f = ['P', 'Q', 'R', 'S'][n as usize - 1];
            if m == 1 {
                format!("\x1bO{f}").into_bytes()
            } else {
                csi_final(f, m)
            }
        }
        NamedKey::F(n @ 5..=12) => tilde([15, 17, 18, 19, 20, 21, 23, 24][n as usize - 5], m),
        NamedKey::F(_) => return KeyAction::Ignore,
        NamedKey::Tab => match (mods.ctrl, mods.shift) {
            (true, false) => return KeyAction::Tether(TetherCommand::NextTab),
            (true, true) => return KeyAction::Tether(TetherCommand::PrevTab),
            (false, true) => b"\x1b[Z".to_vec(),
            (false, false) => vec![0x09],
        },
        // Claude Code and readline-style prompts take ESC CR as a newline without submitting.
        NamedKey::Enter if mods.alt || mods.shift => vec![ESC, b'\r'],
        NamedKey::Enter => vec![b'\r'],
        NamedKey::Backspace => with_alt(mods.alt, if mods.ctrl { 0x08 } else { 0x7f }),
        NamedKey::Escape => vec![ESC],
        NamedKey::Space => with_alt(mods.alt, if mods.ctrl { 0x00 } else { b' ' }),
        NamedKey::Numpad(k) => numpad(k, ctx.app_keypad),
    };
    KeyAction::Send(bytes)
}

fn numpad(key: NumpadKey, application: bool) -> Vec<u8> {
    let (plain, ss3) = match key {
        NumpadKey::Digit(d) => ((b'0' + d.min(9)) as char, (b'p' + d.min(9)) as char),
        NumpadKey::Decimal => ('.', 'n'),
        NumpadKey::Add => ('+', 'k'),
        NumpadKey::Subtract => ('-', 'm'),
        NumpadKey::Multiply => ('*', 'j'),
        NumpadKey::Divide => ('/', 'o'),
        NumpadKey::Enter => ('\r', 'M'),
    };
    if application {
        format!("\x1bO{ss3}").into_bytes()
    } else {
        plain.to_string().into_bytes()
    }
}

fn is_printable(text: &str) -> bool {
    !text.is_empty() && !text.chars().any(char::is_control)
}

pub(crate) fn ctrl_fold(c: char) -> Option<u8> {
    match c.to_ascii_uppercase() {
        u @ '@'..='_' => Some(u as u8 & 0x1f),
        '/' => Some(0x1f),
        _ => None,
    }
}

fn single_char(text: &str) -> Option<char> {
    let mut chars = text.chars();
    let c = chars.next()?;
    chars.next().is_none().then_some(c)
}

fn shortcut(
    unmodified: char,
    digit: Option<u8>,
    shift: bool,
    ctx: &KeyContext,
) -> Option<TetherCommand> {
    let c = unmodified.to_ascii_lowercase();
    match (c, digit, shift) {
        ('v', _, _) => Some(TetherCommand::Paste),
        ('c', _, true) => Some(TetherCommand::Copy),
        ('c', _, false) if ctx.has_selection => Some(TetherCommand::Copy),
        ('t', _, true) => Some(TetherCommand::NewTab),
        ('f', _, true) => Some(TetherCommand::Find),
        ('p', _, true) => Some(TetherCommand::Snippets),
        ('h', _, true) => Some(TetherCommand::History),
        (_, Some(d @ 1..=8), true) => Some(TetherCommand::TabAt(d)),
        (_, Some(9), true) => Some(TetherCommand::LastTab),
        ('=' | '+', _, false) => Some(TetherCommand::FontBigger),
        ('-', _, false) => Some(TetherCommand::FontSmaller),
        (_, Some(0), false) | ('0', _, false) => Some(TetherCommand::FontReset),
        _ => None,
    }
}

fn encode_char(
    unmodified: char,
    produced: Option<&str>,
    digit: Option<u8>,
    mods: Mods,
    ctx: &KeyContext,
) -> KeyAction {
    // AltGr arrives as Ctrl+Alt: a character the layout made from it is text.
    if mods.ctrl
        && mods.alt
        && let Some(text) = produced.filter(|t| is_printable(t))
    {
        return KeyAction::Send(text.as_bytes().to_vec());
    }
    if mods.ctrl
        && !mods.alt
        && let Some(cmd) = shortcut(unmodified, digit, mods.shift, ctx)
    {
        return KeyAction::Tether(cmd);
    }
    if mods.ctrl {
        let folded = ctrl_fold(unmodified)
            .or_else(|| {
                produced
                    .and_then(single_char)
                    .filter(|c| (*c as u32) < 0x20)
                    .map(|c| c as u8)
            })
            .or_else(|| produced.and_then(single_char).and_then(ctrl_fold));
        return match folded {
            Some(byte) => KeyAction::Send(with_alt(mods.alt, byte)),
            None if !mods.alt => produced
                .filter(|t| is_printable(t))
                .map_or(KeyAction::Ignore, |t| {
                    KeyAction::Send(t.as_bytes().to_vec())
                }),
            None => KeyAction::Ignore,
        };
    }
    if mods.alt {
        let text = produced
            .filter(|t| is_printable(t))
            .map_or_else(|| unmodified.to_string(), str::to_owned);
        let mut bytes = vec![ESC];
        bytes.extend_from_slice(text.as_bytes());
        return KeyAction::Send(bytes);
    }
    produced
        .filter(|t| is_printable(t))
        .map_or(KeyAction::Ignore, |t| {
            KeyAction::Send(t.as_bytes().to_vec())
        })
}

#[cfg(test)]
mod named_tests {
    use super::*;

    const NONE: Mods = Mods {
        shift: false,
        alt: false,
        ctrl: false,
    };
    const SHIFT: Mods = Mods {
        shift: true,
        alt: false,
        ctrl: false,
    };
    const ALT: Mods = Mods {
        shift: false,
        alt: true,
        ctrl: false,
    };
    const CTRL: Mods = Mods {
        shift: false,
        alt: false,
        ctrl: true,
    };
    const CTRL_SHIFT: Mods = Mods {
        shift: true,
        alt: false,
        ctrl: true,
    };

    fn send(k: NamedKey, m: Mods, ctx: &KeyContext) -> Vec<u8> {
        match encode_key(&KeyInput::Named(k), m, ctx) {
            KeyAction::Send(b) => b,
            other => panic!("{k:?} {m:?} gave {other:?}"),
        }
    }

    fn normal() -> KeyContext {
        KeyContext::default()
    }

    fn app() -> KeyContext {
        KeyContext {
            app_cursor: true,
            app_keypad: true,
            ..Default::default()
        }
    }

    #[test]
    fn modifier_parameter() {
        assert_eq!(NONE.param(), 1);
        assert_eq!(SHIFT.param(), 2);
        assert_eq!(ALT.param(), 3);
        assert_eq!(CTRL.param(), 5);
        assert_eq!(
            Mods {
                shift: true,
                alt: true,
                ctrl: true
            }
            .param(),
            8
        );
    }

    #[test]
    fn cursor_keys_in_normal_and_application_mode() {
        for (k, f) in [
            (NamedKey::Up, 'A'),
            (NamedKey::Down, 'B'),
            (NamedKey::Right, 'C'),
            (NamedKey::Left, 'D'),
            (NamedKey::Home, 'H'),
            (NamedKey::End, 'F'),
        ] {
            assert_eq!(send(k, NONE, &normal()), format!("\x1b[{f}").into_bytes());
            assert_eq!(send(k, NONE, &app()), format!("\x1bO{f}").into_bytes());
            assert_eq!(
                send(k, CTRL, &normal()),
                format!("\x1b[1;5{f}").into_bytes()
            );
            assert_eq!(send(k, CTRL, &app()), format!("\x1b[1;5{f}").into_bytes());
            assert_eq!(
                send(k, SHIFT, &normal()),
                format!("\x1b[1;2{f}").into_bytes()
            );
        }
    }

    #[test]
    fn tilde_keys_take_the_modifier_as_a_second_parameter() {
        assert_eq!(send(NamedKey::Insert, NONE, &normal()), b"\x1b[2~");
        assert_eq!(send(NamedKey::Delete, NONE, &normal()), b"\x1b[3~");
        assert_eq!(send(NamedKey::Delete, CTRL, &normal()), b"\x1b[3;5~");
        assert_eq!(send(NamedKey::PageUp, NONE, &normal()), b"\x1b[5~");
        assert_eq!(send(NamedKey::PageDown, ALT, &normal()), b"\x1b[6;3~");
        assert_eq!(send(NamedKey::PageUp, CTRL, &normal()), b"\x1b[5;5~");
    }

    #[test]
    fn function_keys() {
        assert_eq!(send(NamedKey::F(1), NONE, &normal()), b"\x1bOP");
        assert_eq!(send(NamedKey::F(4), NONE, &normal()), b"\x1bOS");
        assert_eq!(send(NamedKey::F(2), SHIFT, &normal()), b"\x1b[1;2Q");
        let codes = [15, 17, 18, 19, 20, 21, 23, 24];
        for (i, code) in codes.iter().enumerate() {
            let f = 5 + i as u8;
            assert_eq!(
                send(NamedKey::F(f), NONE, &normal()),
                format!("\x1b[{code}~").into_bytes()
            );
            assert_eq!(
                send(NamedKey::F(f), CTRL, &normal()),
                format!("\x1b[{code};5~").into_bytes()
            );
        }
        assert_eq!(send(NamedKey::F(10), NONE, &normal()), b"\x1b[21~");
        assert_eq!(
            encode_key(&KeyInput::Named(NamedKey::F(13)), NONE, &normal()),
            KeyAction::Ignore
        );
    }

    #[test]
    fn tab_enter_backspace_escape_space() {
        assert_eq!(send(NamedKey::Tab, NONE, &normal()), b"\x09");
        assert_eq!(send(NamedKey::Tab, SHIFT, &normal()), b"\x1b[Z");
        assert_eq!(send(NamedKey::Enter, NONE, &normal()), b"\r");
        assert_eq!(send(NamedKey::Enter, SHIFT, &normal()), b"\x1b\r");
        assert_eq!(send(NamedKey::Enter, ALT, &normal()), b"\x1b\r");
        assert_eq!(send(NamedKey::Backspace, NONE, &normal()), b"\x7f");
        assert_eq!(send(NamedKey::Backspace, CTRL, &normal()), b"\x08");
        assert_eq!(send(NamedKey::Backspace, ALT, &normal()), b"\x1b\x7f");
        assert_eq!(send(NamedKey::Escape, NONE, &normal()), b"\x1b");
        assert_eq!(send(NamedKey::Space, NONE, &normal()), b" ");
        assert_eq!(send(NamedKey::Space, CTRL, &normal()), b"\x00");
        assert_eq!(send(NamedKey::Space, ALT, &normal()), b"\x1b ");
    }

    #[test]
    fn numpad_in_normal_and_application_keypad_mode() {
        use NumpadKey::*;
        let cases = [
            (Digit(0), "0", "p"),
            (Digit(9), "9", "y"),
            (Decimal, ".", "n"),
            (Add, "+", "k"),
            (Subtract, "-", "m"),
            (Multiply, "*", "j"),
            (Divide, "/", "o"),
        ];
        for (k, plain, ss3) in cases {
            assert_eq!(send(NamedKey::Numpad(k), NONE, &normal()), plain.as_bytes());
            assert_eq!(
                send(NamedKey::Numpad(k), NONE, &app()),
                format!("\x1bO{ss3}").into_bytes()
            );
        }
        assert_eq!(send(NamedKey::Numpad(Enter), NONE, &normal()), b"\r");
        assert_eq!(send(NamedKey::Numpad(Enter), NONE, &app()), b"\x1bOM");
    }

    #[test]
    fn tether_keeps_tab_switching_paste_and_scrollback_keys() {
        let k = |key, m, ctx: &KeyContext| encode_key(&KeyInput::Named(key), m, ctx);
        assert_eq!(
            k(NamedKey::Tab, CTRL, &normal()),
            KeyAction::Tether(TetherCommand::NextTab)
        );
        assert_eq!(
            k(NamedKey::Tab, CTRL_SHIFT, &normal()),
            KeyAction::Tether(TetherCommand::PrevTab)
        );
        assert_eq!(
            k(NamedKey::Insert, SHIFT, &normal()),
            KeyAction::Tether(TetherCommand::Paste)
        );
        assert_eq!(
            k(NamedKey::PageUp, SHIFT, &normal()),
            KeyAction::Tether(TetherCommand::ScrollPageUp)
        );
        assert_eq!(
            k(NamedKey::PageDown, SHIFT, &normal()),
            KeyAction::Tether(TetherCommand::ScrollPageDown)
        );
        let alt_screen = KeyContext {
            alt_screen: true,
            ..Default::default()
        };
        assert_eq!(
            k(NamedKey::PageUp, SHIFT, &alt_screen),
            KeyAction::Send(b"\x1b[5;2~".to_vec())
        );
        let mouse = KeyContext {
            mouse_reporting: true,
            ..Default::default()
        };
        assert_eq!(
            k(NamedKey::PageDown, SHIFT, &mouse),
            KeyAction::Send(b"\x1b[6;2~".to_vec())
        );
    }
}

#[cfg(test)]
mod char_tests {
    use super::*;

    fn ch(unmodified: char, produced: Option<&str>) -> KeyInput {
        KeyInput::Char {
            unmodified,
            produced: produced.map(Into::into),
            digit: None,
        }
    }

    fn digit(d: u8, unmodified: char, produced: Option<&str>) -> KeyInput {
        KeyInput::Char {
            unmodified,
            produced: produced.map(Into::into),
            digit: Some(d),
        }
    }

    fn m(shift: bool, alt: bool, ctrl: bool) -> Mods {
        Mods { shift, alt, ctrl }
    }

    fn enc(input: KeyInput, mods: Mods) -> KeyAction {
        encode_key(&input, mods, &KeyContext::default())
    }

    fn sent(bytes: &[u8]) -> KeyAction {
        KeyAction::Send(bytes.to_vec())
    }

    #[test]
    fn plain_and_shifted_text_is_what_the_layout_produced() {
        assert_eq!(enc(ch('a', Some("a")), m(false, false, false)), sent(b"a"));
        assert_eq!(enc(ch('a', Some("A")), m(true, false, false)), sent(b"A"));
        assert_eq!(
            enc(ch('e', Some("é")), m(false, false, false)),
            sent("é".as_bytes())
        );
        assert_eq!(
            enc(ch('a', None), m(false, false, false)),
            KeyAction::Ignore
        );
    }

    #[test]
    fn ctrl_folds_letters_and_at_through_underscore() {
        let ctrl = m(false, false, true);
        assert_eq!(enc(ch('a', None), ctrl), sent(b"\x01"));
        assert_eq!(enc(ch('z', None), ctrl), sent(b"\x1a"));
        assert_eq!(enc(ch('q', None), ctrl), sent(b"\x11"));
        assert_eq!(enc(ch('w', None), ctrl), sent(b"\x17"));
        assert_eq!(enc(ch('t', None), ctrl), sent(b"\x14"));
        assert_eq!(enc(ch('[', None), ctrl), sent(b"\x1b"));
        assert_eq!(enc(ch('\\', None), ctrl), sent(b"\x1c"));
        assert_eq!(enc(ch(']', None), ctrl), sent(b"\x1d"));
        assert_eq!(enc(ch('/', None), ctrl), sent(b"\x1f"));
        assert_eq!(
            enc(ch('6', Some("\u{1e}")), m(true, false, true)),
            sent(b"\x1e")
        );
        assert_eq!(
            enc(ch('-', Some("\u{1f}")), m(true, false, true)),
            sent(b"\x1f")
        );
        assert_eq!(enc(ch('1', None), ctrl), KeyAction::Ignore);
    }

    #[test]
    fn alt_is_an_escape_prefix_and_ctrl_alt_does_both() {
        assert_eq!(
            enc(ch('b', Some("b")), m(false, true, false)),
            sent(b"\x1bb")
        );
        assert_eq!(
            enc(ch('b', Some("B")), m(true, true, false)),
            sent(b"\x1bB")
        );
        assert_eq!(enc(ch('.', None), m(false, true, false)), sent(b"\x1b."));
        assert_eq!(enc(ch('a', None), m(false, true, true)), sent(b"\x1b\x01"));
    }

    #[test]
    fn altgr_text_wins_on_canadian_french() {
        let altgr = m(false, true, true);
        assert_eq!(enc(digit(2, '2', Some("@")), altgr), sent(b"@"));
        assert_eq!(enc(digit(7, '7', Some("|")), altgr), sent(b"|"));
        assert_eq!(enc(ch('^', Some("[")), altgr), sent(b"["));
        assert_eq!(enc(ch('e', Some("€")), altgr), sent("€".as_bytes()));
        assert_eq!(enc(ch('v', Some("v")), altgr), sent(b"v"));
    }

    #[test]
    fn folding_uses_the_unmodified_layout_char_not_the_physical_key() {
        // AZERTY: the key at QWERTY's A produces 'q'.
        assert_eq!(enc(ch('q', None), m(false, false, true)), sent(b"\x11"));
    }

    #[test]
    fn paste_and_copy_shortcuts() {
        let ctrl = m(false, false, true);
        let ctrl_shift = m(true, false, true);
        assert_eq!(
            enc(ch('v', None), ctrl),
            KeyAction::Tether(TetherCommand::Paste)
        );
        assert_eq!(
            enc(ch('v', None), ctrl_shift),
            KeyAction::Tether(TetherCommand::Paste)
        );
        assert_eq!(
            enc(ch('c', None), ctrl_shift),
            KeyAction::Tether(TetherCommand::Copy)
        );
        assert_eq!(enc(ch('c', None), ctrl), sent(b"\x03"));
        let selected = KeyContext {
            has_selection: true,
            ..Default::default()
        };
        assert_eq!(
            encode_key(&ch('c', None), ctrl, &selected),
            KeyAction::Tether(TetherCommand::Copy)
        );
    }

    #[test]
    fn font_size_and_tab_shortcuts() {
        let ctrl = m(false, false, true);
        let ctrl_shift = m(true, false, true);
        assert_eq!(
            enc(ch('=', None), ctrl),
            KeyAction::Tether(TetherCommand::FontBigger)
        );
        assert_eq!(
            enc(ch('+', None), ctrl),
            KeyAction::Tether(TetherCommand::FontBigger)
        );
        assert_eq!(
            enc(ch('-', None), ctrl),
            KeyAction::Tether(TetherCommand::FontSmaller)
        );
        assert_eq!(
            enc(digit(0, 'à', None), ctrl),
            KeyAction::Tether(TetherCommand::FontReset)
        );
        assert_eq!(
            enc(ch('t', None), ctrl_shift),
            KeyAction::Tether(TetherCommand::NewTab)
        );
        assert_eq!(
            enc(ch('f', None), ctrl_shift),
            KeyAction::Tether(TetherCommand::Find)
        );
        assert_ne!(
            enc(ch('f', None), ctrl),
            KeyAction::Tether(TetherCommand::Find),
            "Ctrl+F stays with the shell"
        );
        assert_eq!(
            enc(digit(1, '&', None), ctrl_shift),
            KeyAction::Tether(TetherCommand::TabAt(1))
        );
        assert_eq!(
            enc(digit(8, '8', None), ctrl_shift),
            KeyAction::Tether(TetherCommand::TabAt(8))
        );
        assert_eq!(
            enc(digit(9, '9', None), ctrl_shift),
            KeyAction::Tether(TetherCommand::LastTab)
        );
    }

    #[test]
    fn keys_tether_keeps_never_reach_the_pty() {
        let ctrl = m(false, false, true);
        for input in [
            ch('v', None),
            ch('=', None),
            ch('-', None),
            digit(0, '0', None),
        ] {
            assert!(matches!(enc(input, ctrl), KeyAction::Tether(_)));
        }
        assert_ne!(enc(ch('v', None), ctrl), sent(b"\x16"));
    }
    #[test]
    fn snippets_and_history_take_ctrl_shift_only() {
        let ctrl = m(false, false, true);
        let ctrl_shift = m(true, false, true);
        assert_eq!(
            enc(ch('p', None), ctrl_shift),
            KeyAction::Tether(TetherCommand::Snippets)
        );
        assert_eq!(
            enc(ch('h', None), ctrl_shift),
            KeyAction::Tether(TetherCommand::History)
        );
        assert_eq!(enc(ch('p', None), ctrl), sent(b"\x10"));
        assert_eq!(enc(ch('h', None), ctrl), sent(b"\x08"));
    }
}
