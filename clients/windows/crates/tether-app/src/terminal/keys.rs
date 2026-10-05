#[cfg(test)]
mod tests {
    use super::*;
    use slint::winit_030::winit::keyboard::{Key, KeyCode, KeyLocation, NamedKey as W, PhysicalKey, SmolStr};
    use tether_core::keymap::{KeyInput, NamedKey, NumpadKey};

    fn ch(s: &str) -> Key { Key::Character(SmolStr::new(s)) }
    fn code(c: KeyCode) -> PhysicalKey { PhysicalKey::Code(c) }

    #[test]
    fn ctrl_letter_keeps_the_unmodified_char_and_drops_the_control_text() {
        let got = translate(&ch("a"), &ch("a"), Some("\u{1}"), code(KeyCode::KeyA), KeyLocation::Standard);
        assert_eq!(got, Some(KeyInput::Char { unmodified: 'a', produced: None, digit: None }));
    }

    #[test]
    fn altgr_on_canadian_french_produces_the_symbol() {
        let got = translate(&ch("@"), &ch("2"), Some("@"), code(KeyCode::Digit2), KeyLocation::Standard);
        assert_eq!(got, Some(KeyInput::Char { unmodified: '2', produced: Some("@".into()), digit: Some(2) }));
    }

    #[test]
    fn azerty_top_row_reports_its_digit() {
        let got = translate(&ch("&"), &ch("&"), Some("&"), code(KeyCode::Digit1), KeyLocation::Standard);
        assert_eq!(got, Some(KeyInput::Char { unmodified: '&', produced: Some("&".into()), digit: Some(1) }));
    }

    #[test]
    fn named_keys_map_to_the_table() {
        let named = |k: W| translate(&Key::Named(k), &Key::Named(k), None, code(KeyCode::F10), KeyLocation::Standard);
        assert_eq!(named(W::F10), Some(KeyInput::Named(NamedKey::F(10))));
        assert_eq!(named(W::ArrowLeft), Some(KeyInput::Named(NamedKey::Left)));
        assert_eq!(named(W::PageUp), Some(KeyInput::Named(NamedKey::PageUp)));
        assert_eq!(named(W::Space), Some(KeyInput::Named(NamedKey::Space)));
        assert_eq!(named(W::Enter), Some(KeyInput::Named(NamedKey::Enter)));
        assert_eq!(named(W::Escape), Some(KeyInput::Named(NamedKey::Escape)));
    }

    #[test]
    fn numpad_keys_carry_their_location() {
        let five = translate(&ch("5"), &ch("5"), Some("5"), code(KeyCode::Numpad5), KeyLocation::Numpad);
        assert_eq!(five, Some(KeyInput::Named(NamedKey::Numpad(NumpadKey::Digit(5)))));
        let enter = translate(&Key::Named(W::Enter), &Key::Named(W::Enter), Some("\r"), code(KeyCode::NumpadEnter), KeyLocation::Numpad);
        assert_eq!(enter, Some(KeyInput::Named(NamedKey::Numpad(NumpadKey::Enter))));
        let plus = translate(&ch("+"), &ch("+"), Some("+"), code(KeyCode::NumpadAdd), KeyLocation::Numpad);
        assert_eq!(plus, Some(KeyInput::Named(NamedKey::Numpad(NumpadKey::Add))));
    }

    #[test]
    fn dead_keys_and_bare_modifiers_are_not_keys() {
        assert_eq!(translate(&Key::Dead(Some('^')), &Key::Dead(Some('^')), None, code(KeyCode::BracketLeft), KeyLocation::Standard), None);
        assert_eq!(translate(&Key::Named(W::Shift), &Key::Named(W::Shift), None, code(KeyCode::ShiftLeft), KeyLocation::Left), None);
        assert_eq!(translate(&Key::Named(W::Alt), &Key::Named(W::Alt), None, code(KeyCode::AltLeft), KeyLocation::Left), None);
    }
}
