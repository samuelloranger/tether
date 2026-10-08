use slint::winit_030::winit::keyboard::{
    Key, KeyCode, KeyLocation, ModifiersState, NamedKey as W, PhysicalKey,
};
use tether_core::keymap::{KeyInput, Mods, NamedKey, NumpadKey};

pub fn mods_of(state: ModifiersState) -> Mods {
    Mods {
        shift: state.shift_key(),
        alt: state.alt_key(),
        ctrl: state.control_key(),
    }
}

static APP_KEYPAD: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn set_app_keypad(on: bool) {
    APP_KEYPAD.store(on, std::sync::atomic::Ordering::Relaxed);
}

pub fn app_keypad() -> bool {
    APP_KEYPAD.load(std::sync::atomic::Ordering::Relaxed)
}

fn digit_of(physical: PhysicalKey) -> Option<u8> {
    let PhysicalKey::Code(code) = physical else {
        return None;
    };
    let d = match code {
        KeyCode::Digit0 => 0,
        KeyCode::Digit1 => 1,
        KeyCode::Digit2 => 2,
        KeyCode::Digit3 => 3,
        KeyCode::Digit4 => 4,
        KeyCode::Digit5 => 5,
        KeyCode::Digit6 => 6,
        KeyCode::Digit7 => 7,
        KeyCode::Digit8 => 8,
        KeyCode::Digit9 => 9,
        _ => return None,
    };
    Some(d)
}

fn numpad(c: char) -> Option<NumpadKey> {
    Some(match c {
        '0'..='9' => NumpadKey::Digit(c as u8 - b'0'),
        '.' | ',' => NumpadKey::Decimal,
        '+' => NumpadKey::Add,
        '-' => NumpadKey::Subtract,
        '*' => NumpadKey::Multiply,
        '/' => NumpadKey::Divide,
        _ => return None,
    })
}

/// `unmodified` and `text` are winit's `key_without_modifiers()` and
/// `text_with_all_modifiers()`. Dead keys and IME arrive as text later, never through here.
pub fn translate(
    logical: &Key,
    unmodified: &Key,
    text: Option<&str>,
    physical: PhysicalKey,
    location: KeyLocation,
    mods: tether_core::keymap::Mods,
    app_keypad: bool,
) -> Option<KeyInput> {
    if let Key::Named(W::Space) = logical {
        // A dead key followed by Space composes its own character (^, ', `) and winit still reports Space.
        if let Some(t) =
            text.filter(|t| *t != " " && !t.is_empty() && !t.chars().any(char::is_control))
        {
            return Some(KeyInput::Char {
                unmodified: t.chars().next()?,
                produced: Some(t.to_string()),
                digit: None,
            });
        }
    }
    if let Key::Named(n) = logical {
        let key = match n {
            W::ArrowUp => NamedKey::Up,
            W::ArrowDown => NamedKey::Down,
            W::ArrowLeft => NamedKey::Left,
            W::ArrowRight => NamedKey::Right,
            W::Home => NamedKey::Home,
            W::End => NamedKey::End,
            W::Insert => NamedKey::Insert,
            W::Delete => NamedKey::Delete,
            W::PageUp => NamedKey::PageUp,
            W::PageDown => NamedKey::PageDown,
            W::Tab => NamedKey::Tab,
            W::Backspace => NamedKey::Backspace,
            W::Escape => NamedKey::Escape,
            W::Space => NamedKey::Space,
            W::Enter if location == KeyLocation::Numpad => {
                if app_keypad || !(mods.ctrl || mods.alt) {
                    NamedKey::Numpad(NumpadKey::Enter)
                } else {
                    return text
                        .filter(|t| !t.is_empty() && !t.chars().any(char::is_control))
                        .map(|t| KeyInput::Char {
                            unmodified: '\r',
                            produced: Some(t.to_string()),
                            digit: None,
                        });
                }
            }
            W::Enter => NamedKey::Enter,
            W::F1 => NamedKey::F(1),
            W::F2 => NamedKey::F(2),
            W::F3 => NamedKey::F(3),
            W::F4 => NamedKey::F(4),
            W::F5 => NamedKey::F(5),
            W::F6 => NamedKey::F(6),
            W::F7 => NamedKey::F(7),
            W::F8 => NamedKey::F(8),
            W::F9 => NamedKey::F(9),
            W::F10 => NamedKey::F(10),
            W::F11 => NamedKey::F(11),
            W::F12 => NamedKey::F(12),
            _ => return None,
        };
        return Some(KeyInput::Named(key));
    }
    let Key::Character(base) = unmodified else {
        return None;
    };
    let unmodified = base.chars().next()?;
    let named_numpad = app_keypad || !(mods.ctrl || mods.alt);
    if location == KeyLocation::Numpad
        && named_numpad
        && let Some(k) = numpad(unmodified)
    {
        return Some(KeyInput::Named(NamedKey::Numpad(k)));
    }
    let produced = text
        .filter(|t| !t.is_empty() && !t.chars().any(char::is_control))
        .map(str::to_string);
    Some(KeyInput::Char {
        unmodified,
        produced,
        digit: digit_of(physical),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use slint::winit_030::winit::keyboard::{
        Key, KeyCode, KeyLocation, NamedKey as W, PhysicalKey, SmolStr,
    };
    use tether_core::keymap::{KeyInput, Mods, NamedKey, NumpadKey};

    fn ch(s: &str) -> Key {
        Key::Character(SmolStr::new(s))
    }
    fn code(c: KeyCode) -> PhysicalKey {
        PhysicalKey::Code(c)
    }
    fn plain(
        logical: &Key,
        unmodified: &Key,
        text: Option<&str>,
        physical: PhysicalKey,
        location: KeyLocation,
    ) -> Option<KeyInput> {
        translate(
            logical,
            unmodified,
            text,
            physical,
            location,
            Mods::default(),
            false,
        )
    }

    #[test]
    fn ctrl_letter_keeps_the_unmodified_char_and_drops_the_control_text() {
        let got = plain(
            &ch("a"),
            &ch("a"),
            Some("\u{1}"),
            code(KeyCode::KeyA),
            KeyLocation::Standard,
        );
        assert_eq!(
            got,
            Some(KeyInput::Char {
                unmodified: 'a',
                produced: None,
                digit: None
            })
        );
    }

    #[test]
    fn altgr_on_canadian_french_produces_the_symbol() {
        let got = plain(
            &ch("@"),
            &ch("2"),
            Some("@"),
            code(KeyCode::Digit2),
            KeyLocation::Standard,
        );
        assert_eq!(
            got,
            Some(KeyInput::Char {
                unmodified: '2',
                produced: Some("@".into()),
                digit: Some(2)
            })
        );
    }

    #[test]
    fn azerty_top_row_reports_its_digit() {
        let got = plain(
            &ch("&"),
            &ch("&"),
            Some("&"),
            code(KeyCode::Digit1),
            KeyLocation::Standard,
        );
        assert_eq!(
            got,
            Some(KeyInput::Char {
                unmodified: '&',
                produced: Some("&".into()),
                digit: Some(1)
            })
        );
    }

    #[test]
    fn named_keys_map_to_the_table() {
        let named = |k: W| {
            plain(
                &Key::Named(k),
                &Key::Named(k),
                None,
                code(KeyCode::F10),
                KeyLocation::Standard,
            )
        };
        assert_eq!(named(W::F10), Some(KeyInput::Named(NamedKey::F(10))));
        assert_eq!(named(W::ArrowLeft), Some(KeyInput::Named(NamedKey::Left)));
        assert_eq!(named(W::PageUp), Some(KeyInput::Named(NamedKey::PageUp)));
        assert_eq!(named(W::Space), Some(KeyInput::Named(NamedKey::Space)));
        assert_eq!(named(W::Enter), Some(KeyInput::Named(NamedKey::Enter)));
        assert_eq!(named(W::Escape), Some(KeyInput::Named(NamedKey::Escape)));
    }

    #[test]
    fn numpad_keys_carry_their_location() {
        let five = plain(
            &ch("5"),
            &ch("5"),
            Some("5"),
            code(KeyCode::Numpad5),
            KeyLocation::Numpad,
        );
        assert_eq!(
            five,
            Some(KeyInput::Named(NamedKey::Numpad(NumpadKey::Digit(5))))
        );
        let enter = plain(
            &Key::Named(W::Enter),
            &Key::Named(W::Enter),
            Some("\r"),
            code(KeyCode::NumpadEnter),
            KeyLocation::Numpad,
        );
        assert_eq!(
            enter,
            Some(KeyInput::Named(NamedKey::Numpad(NumpadKey::Enter)))
        );
        let plus = plain(
            &ch("+"),
            &ch("+"),
            Some("+"),
            code(KeyCode::NumpadAdd),
            KeyLocation::Numpad,
        );
        assert_eq!(
            plus,
            Some(KeyInput::Named(NamedKey::Numpad(NumpadKey::Add)))
        );
    }

    #[test]
    fn altgr_numpad_decimal_sends_the_produced_comma() {
        let got = translate(
            &ch(","),
            &ch("."),
            Some(","),
            code(KeyCode::NumpadDecimal),
            KeyLocation::Numpad,
            Mods {
                shift: false,
                alt: true,
                ctrl: true,
            },
            false,
        );
        assert_eq!(
            got,
            Some(KeyInput::Char {
                unmodified: '.',
                produced: Some(",".into()),
                digit: None,
            })
        );
        let app = translate(
            &ch(","),
            &ch("."),
            Some(","),
            code(KeyCode::NumpadDecimal),
            KeyLocation::Numpad,
            Mods {
                shift: false,
                alt: true,
                ctrl: true,
            },
            true,
        );
        assert_eq!(
            app,
            Some(KeyInput::Named(NamedKey::Numpad(NumpadKey::Decimal)))
        );
    }

    #[test]
    fn dead_keys_and_bare_modifiers_are_not_keys() {
        assert_eq!(
            plain(
                &Key::Dead(Some('^')),
                &Key::Dead(Some('^')),
                None,
                code(KeyCode::BracketLeft),
                KeyLocation::Standard
            ),
            None
        );
        assert_eq!(
            plain(
                &Key::Named(W::Shift),
                &Key::Named(W::Shift),
                None,
                code(KeyCode::ShiftLeft),
                KeyLocation::Left
            ),
            None
        );
        assert_eq!(
            plain(
                &Key::Named(W::Alt),
                &Key::Named(W::Alt),
                None,
                code(KeyCode::AltLeft),
                KeyLocation::Left
            ),
            None
        );
    }

    #[test]
    fn a_dead_key_then_space_sends_the_composed_character() {
        let space = |text: Option<&str>, mods: Mods| {
            translate(
                &Key::Named(W::Space),
                &Key::Named(W::Space),
                text,
                code(KeyCode::Space),
                KeyLocation::Standard,
                mods,
                false,
            )
        };
        for c in ["^", "'", "`", "~"] {
            assert_eq!(
                space(Some(c), Mods::default()),
                Some(KeyInput::Char {
                    unmodified: c.chars().next().unwrap(),
                    produced: Some(c.to_string()),
                    digit: None
                })
            );
        }
        assert_eq!(
            space(Some(" "), Mods::default()),
            Some(KeyInput::Named(NamedKey::Space))
        );
        assert_eq!(
            space(None, Mods::default()),
            Some(KeyInput::Named(NamedKey::Space))
        );
        let ctrl = Mods {
            ctrl: true,
            ..Mods::default()
        };
        assert_eq!(
            space(Some("\0"), ctrl),
            Some(KeyInput::Named(NamedKey::Space))
        );
        assert_eq!(
            space(Some(" "), ctrl),
            Some(KeyInput::Named(NamedKey::Space))
        );
    }

    fn sent(input: Option<KeyInput>, mods: Mods) -> Option<Vec<u8>> {
        use tether_core::keymap::{KeyAction, KeyContext, encode_key};
        match encode_key(&input?, mods, &KeyContext::default()) {
            KeyAction::Send(b) => Some(b),
            _ => None,
        }
    }

    #[test]
    fn a_dead_key_press_types_nothing_and_its_composed_result_types_once() {
        let dead = plain(
            &Key::Dead(Some('^')),
            &ch("["),
            None,
            code(KeyCode::BracketLeft),
            KeyLocation::Standard,
        );
        assert_eq!(sent(dead, Mods::default()), None);
        let composed = plain(
            &ch("ê"),
            &ch("e"),
            Some("ê"),
            code(KeyCode::KeyE),
            KeyLocation::Standard,
        );
        assert_eq!(
            sent(composed, Mods::default()),
            Some("ê".as_bytes().to_vec())
        );
    }

    #[test]
    fn altgr_symbols_are_plain_text_when_the_platform_reports_no_modifier() {
        let euro = plain(
            &ch("€"),
            &ch("e"),
            Some("€"),
            code(KeyCode::KeyE),
            KeyLocation::Standard,
        );
        assert_eq!(sent(euro, Mods::default()), Some("€".as_bytes().to_vec()));
    }

    #[test]
    fn alt_with_a_compose_capable_key_prefixes_escape() {
        let alt = Mods {
            alt: true,
            ..Mods::default()
        };
        let got = translate(
            &ch("q"),
            &ch("q"),
            Some("q"),
            code(KeyCode::KeyA),
            KeyLocation::Standard,
            alt,
            false,
        );
        assert_eq!(sent(got, alt), Some(b"\x1bq".to_vec()));
    }
}
