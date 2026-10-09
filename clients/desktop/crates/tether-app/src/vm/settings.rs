use tether_core::{CursorShape, TerminalPrefs, UpdateChannel, font_named, theme_named};

pub fn cursor_index(shape: CursorShape) -> i32 {
    match shape {
        CursorShape::Block => 0,
        CursorShape::Bar => 1,
        CursorShape::Underline => 2,
    }
}

pub fn cursor_from_index(i: i32) -> CursorShape {
    match i {
        1 => CursorShape::Bar,
        2 => CursorShape::Underline,
        _ => CursorShape::Block,
    }
}

pub fn channel_index(channel: UpdateChannel) -> i32 {
    match channel {
        UpdateChannel::Stable => 0,
        UpdateChannel::Edge => 1,
    }
}

pub fn channel_from_index(i: i32) -> UpdateChannel {
    match i {
        1 => UpdateChannel::Edge,
        _ => UpdateChannel::Stable,
    }
}

pub fn size_label(p: &TerminalPrefs) -> String {
    format!("{} pt", p.size_pt.round() as i32)
}

pub fn spacing_label(p: &TerminalPrefs) -> String {
    format!("{:.2}×", p.line_spacing)
}

pub fn padding_label(p: &TerminalPrefs) -> String {
    format!("{} pt", p.padding_pt.round() as i32)
}

pub fn scheme_label(p: &TerminalPrefs) -> String {
    theme_named(&p.scheme).name.clone()
}

pub fn font_label(p: &TerminalPrefs) -> &'static str {
    font_named(&p.font).name
}

pub fn step_size(p: &mut TerminalPrefs, delta: i32) {
    if delta > 0 {
        p.bigger();
    } else if delta < 0 {
        p.smaller();
    }
}

pub fn set_spacing(p: &mut TerminalPrefs, raw: f32) {
    p.line_spacing = (raw * 20.0).round() / 20.0;
    *p = p.clone().clamped();
}

pub fn step_padding(p: &mut TerminalPrefs, delta: i32) {
    p.padding_pt += 2.0 * delta as f32;
    *p = p.clone().clamped();
}

#[cfg(test)]
mod tests {
    use super::*;
    use tether_core::Preferences;

    fn prefs() -> TerminalPrefs {
        Preferences::default().terminal
    }

    #[test]
    fn channel_segment_maps_both_ways() {
        for c in [UpdateChannel::Stable, UpdateChannel::Edge] {
            assert_eq!(channel_from_index(channel_index(c)), c);
        }
        assert_eq!(channel_from_index(7), UpdateChannel::Stable);
    }

    #[test]
    fn default_labels() {
        let p = prefs();
        assert_eq!(size_label(&p), "14 pt");
        assert_eq!(spacing_label(&p), "1.00×");
        assert_eq!(padding_label(&p), "8 pt");
        assert_eq!(scheme_label(&p), "Tether");
        assert_eq!(font_label(&p), "Cascadia Mono");
    }

    #[test]
    fn size_steps_by_one_and_stops_at_the_ends() {
        let mut p = prefs();
        step_size(&mut p, 1);
        assert_eq!(size_label(&p), "15 pt");
        p.size_pt = 24.0;
        step_size(&mut p, 1);
        assert_eq!(p.size_pt, 24.0);
        p.size_pt = 8.0;
        step_size(&mut p, -1);
        assert_eq!(p.size_pt, 8.0);
    }

    #[test]
    fn spacing_snaps_to_twentieths_and_clamps() {
        let mut p = prefs();
        set_spacing(&mut p, 1.234);
        assert_eq!(spacing_label(&p), "1.25×");
        set_spacing(&mut p, 1.7);
        assert_eq!(spacing_label(&p), "1.60×");
        set_spacing(&mut p, 0.9);
        assert_eq!(spacing_label(&p), "1.00×");
    }

    #[test]
    fn padding_steps_by_two_and_clamps() {
        let mut p = prefs();
        step_padding(&mut p, 1);
        assert_eq!(padding_label(&p), "10 pt");
        p.padding_pt = 24.0;
        step_padding(&mut p, 1);
        assert_eq!(p.padding_pt, 24.0);
        p.padding_pt = 0.0;
        step_padding(&mut p, -1);
        assert_eq!(p.padding_pt, 0.0);
    }

    #[test]
    fn unknown_ids_label_as_the_fallbacks() {
        let mut p = prefs();
        p.scheme = "gone".into();
        p.font = "menlo".into();
        assert_eq!(scheme_label(&p), "Tether");
        assert_eq!(font_label(&p), "Cascadia Mono");
    }

    #[test]
    fn segment_indices_round_trip() {
        for c in [CursorShape::Block, CursorShape::Bar, CursorShape::Underline] {
            assert_eq!(cursor_from_index(cursor_index(c)), c);
        }
    }
}
