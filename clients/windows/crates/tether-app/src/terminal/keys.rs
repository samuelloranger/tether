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
) -> Option<KeyInput> {
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
            W::Enter if location == KeyLocation::Numpad => NamedKey::Numpad(NumpadKey::Enter),
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
    if location == KeyLocation::Numpad {
        if let Some(k) = numpad(unmodified) {
            return Some(KeyInput::Named(NamedKey::Numpad(k)));
        }
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
    use tether_core::keymap::{KeyInput, NamedKey, NumpadKey};

    fn ch(s: &str) -> Key {
        Key::Character(SmolStr::new(s))
    }
    fn code(c: KeyCode) -> PhysicalKey {
        PhysicalKey::Code(c)
    }

    #[test]
    fn ctrl_letter_keeps_the_unmodified_char_and_drops_the_control_text() {
        let got = translate(
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
        let got = translate(
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
        let got = translate(
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
            translate(
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
        let five = translate(
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
        let enter = translate(
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
        let plus = translate(
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
    fn dead_keys_and_bare_modifiers_are_not_keys() {
        assert_eq!(
            translate(
                &Key::Dead(Some('^')),
                &Key::Dead(Some('^')),
                None,
                code(KeyCode::BracketLeft),
                KeyLocation::Standard
            ),
            None
        );
        assert_eq!(
            translate(
                &Key::Named(W::Shift),
                &Key::Named(W::Shift),
                None,
                code(KeyCode::ShiftLeft),
                KeyLocation::Left
            ),
            None
        );
        assert_eq!(
            translate(
                &Key::Named(W::Alt),
                &Key::Named(W::Alt),
                None,
                code(KeyCode::AltLeft),
                KeyLocation::Left
            ),
            None
        );
    }
}
