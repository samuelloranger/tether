//! The app's chrome colours, from the chosen terminal theme. iOS derives the same palettes
//! (`ChromePalette.swift`); a golden file both test suites read keeps them identical.

use crate::theme::TerminalTheme;

/// Every chrome token, as 0xRRGGBB.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChromePalette {
    pub background: u32,
    pub surface: u32,
    pub surface_hover: u32,
    pub raised: u32,
    pub input: u32,
    pub border: u32,
    pub text: u32,
    pub text_secondary: u32,
    pub text_faint: u32,
    pub placeholder: u32,
    pub accent: u32,
    pub on_accent: u32,
    pub success: u32,
    pub warning: u32,
    pub danger: u32,
    pub on_danger: u32,
    pub well: u32,
}

/// Aurora dark, Tether's own look.
pub const TETHER: ChromePalette = ChromePalette {
    background: 0x08080E,
    surface: 0x12121D,
    surface_hover: 0x161624,
    raised: 0x191926,
    input: 0x0B0B13,
    border: 0x232333,
    text: 0xEDEEF6,
    text_secondary: 0x9797AC,
    text_faint: 0x8B8BA3,
    placeholder: 0x5C5C73,
    accent: 0x7C8CF8,
    on_accent: 0x08080E,
    success: 0x6EE7A8,
    warning: 0xF2B34C,
    danger: 0xFF7050,
    on_danger: 0x1A0A07,
    well: 0x1E1E2E,
};

/// Aurora light.
pub const TETHER_LIGHT: ChromePalette = ChromePalette {
    background: 0xF1F1F6,
    surface: 0xFFFFFF,
    surface_hover: 0xF7F7FB,
    raised: 0xE9E9F2,
    input: 0xFFFFFF,
    border: 0xDCDCE6,
    text: 0x14141B,
    text_secondary: 0x5C5C6C,
    text_faint: 0x8A8A9C,
    placeholder: 0xA3A3B3,
    accent: 0x4353D0,
    on_accent: 0xFFFFFF,
    success: 0x1C7A4F,
    warning: 0x8A5A00,
    danger: 0xC4381C,
    on_danger: 0xFFFFFF,
    well: 0xFBFBFD,
};

impl TerminalTheme {
    pub fn chrome(&self) -> ChromePalette {
        match self.id.as_str() {
            "tether" => TETHER,
            "tether-light" => TETHER_LIGHT,
            _ => derive(self),
        }
    }
}

fn channel(c: u32, shift: u32) -> f64 {
    ((c >> shift) & 0xFF) as f64
}

/// Per sRGB channel, rounded half away from zero.
pub fn mix(a: u32, b: u32, t: f64) -> u32 {
    [16, 8, 0].iter().fold(0, |out, &shift| {
        let (x, y) = (channel(a, shift), channel(b, shift));
        out | (((x + (y - x) * t).round() as u32) << shift)
    })
}

fn luminance(c: u32) -> f64 {
    let linear = |v: f64| {
        let v = v / 255.0;
        if v <= 0.04045 {
            v / 12.92
        } else {
            ((v + 0.055) / 1.055).powf(2.4)
        }
    };
    0.2126 * linear(channel(c, 16))
        + 0.7152 * linear(channel(c, 8))
        + 0.0722 * linear(channel(c, 0))
}

/// The WCAG 2 contrast ratio.
pub fn contrast(a: u32, b: u32) -> f64 {
    let (la, lb) = (luminance(a), luminance(b));
    (la.max(lb) + 0.05) / (la.min(lb) + 0.05)
}

/// `c`, or the first 5 % step toward `toward` that reaches `ratio` against `against`.
fn lift(c: u32, against: u32, toward: u32, ratio: f64) -> u32 {
    if contrast(c, against) >= ratio {
        return c;
    }
    let mut out = c;
    for k in 1..=20 {
        out = mix(c, toward, k as f64 * 0.05);
        if contrast(out, against) >= ratio {
            break;
        }
    }
    out
}

/// Text lifts toward the foreground; a theme whose own foreground is too faint for the
/// ratio carries on toward black or white.
fn lift_text(c: u32, against: u32, fg: u32, pole: u32, ratio: f64) -> u32 {
    let toward_fg = lift(c, against, fg, ratio);
    if contrast(toward_fg, against) >= ratio {
        toward_fg
    } else {
        lift(toward_fg, against, pole, ratio)
    }
}

pub fn derive(theme: &TerminalTheme) -> ChromePalette {
    let (bg, fg, ansi) = (theme.background, theme.foreground, &theme.ansi);
    // Toward black or white a state colour keeps its hue; toward a tinted foreground,
    // a light theme's three state colours drift into one.
    let pole = if theme.is_light() { 0x000000 } else { 0xFFFFFF };
    let surface = mix(bg, fg, 0.05);
    let blue = if contrast(ansi[4], bg) >= contrast(ansi[12], bg) {
        ansi[4]
    } else {
        ansi[12]
    };
    let accent = lift(blue, bg, pole, 4.5);
    let danger = lift(ansi[1], bg, pole, 4.5);
    let on = |c: u32| {
        if contrast(bg, c) >= contrast(fg, c) {
            bg
        } else {
            fg
        }
    };
    ChromePalette {
        background: bg,
        surface,
        surface_hover: mix(bg, fg, 0.075),
        raised: mix(bg, fg, 0.10),
        input: mix(bg, fg, 0.03),
        border: mix(bg, fg, 0.16),
        text: fg,
        text_secondary: lift_text(mix(fg, bg, 0.35), surface, fg, pole, 4.5),
        text_faint: lift_text(mix(fg, bg, 0.55), surface, fg, pole, 3.0),
        placeholder: mix(fg, bg, 0.62),
        accent,
        on_accent: on(accent),
        success: lift(ansi[2], bg, pole, 4.5),
        warning: lift(ansi[3], bg, pole, 4.5),
        danger,
        on_danger: on(danger),
        well: bg,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::{catalog, theme_named};

    const GOLDEN: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../apple/TetherKit/Tests/TetherKitTests/Fixtures/ChromePalettes.golden.json"
    );

    fn tokens(p: &ChromePalette) -> [(&'static str, u32); 17] {
        [
            ("background", p.background),
            ("surface", p.surface),
            ("surfaceHover", p.surface_hover),
            ("raised", p.raised),
            ("input", p.input),
            ("border", p.border),
            ("text", p.text),
            ("textSecondary", p.text_secondary),
            ("textFaint", p.text_faint),
            ("placeholder", p.placeholder),
            ("accent", p.accent),
            ("onAccent", p.on_accent),
            ("success", p.success),
            ("warning", p.warning),
            ("danger", p.danger),
            ("onDanger", p.on_danger),
            ("well", p.well),
        ]
    }

    /// One theme per line, so a formula change reads as a per-theme diff.
    fn golden() -> String {
        let lines: Vec<String> = catalog()
            .iter()
            .map(|theme| {
                let fields: Vec<String> = tokens(&theme.chrome())
                    .iter()
                    .map(|(name, value)| format!("\"{name}\": \"{value:06X}\""))
                    .collect();
                format!(
                    "{{\"id\": \"{}\", \"tokens\": {{{}}}}}",
                    theme.id,
                    fields.join(", ")
                )
            })
            .collect();
        format!("[\n{}\n]\n", lines.join(",\n"))
    }

    /// `UPDATE_GOLDEN=1 cargo test -p tether-core chrome` rewrites the file after a deliberate
    /// formula change; the Swift suite then has to agree with it.
    #[test]
    fn matches_golden() {
        let expected = golden();
        if std::env::var_os("UPDATE_GOLDEN").is_some() {
            std::fs::write(GOLDEN, &expected).unwrap();
            return;
        }
        let on_disk =
            std::fs::read_to_string(GOLDEN).expect("golden file missing: run with UPDATE_GOLDEN=1");
        assert!(on_disk == expected, "chrome palettes differ from {GOLDEN}");
    }

    #[test]
    fn tether_and_tether_light_are_aurora() {
        assert_eq!(theme_named("tether").chrome(), TETHER);
        assert_eq!(theme_named("tether-light").chrome(), TETHER_LIGHT);
        assert_eq!(TETHER.accent, 0x7C8CF8);
        assert_eq!(TETHER_LIGHT.accent, 0x4353D0);
    }

    #[test]
    fn derived_palettes_keep_text_and_states_legible() {
        for theme in catalog().iter().filter(|t| !t.id.starts_with("tether")) {
            let p = theme.chrome();
            let id = &theme.id;
            assert!(
                contrast(p.text_secondary, p.surface) >= 4.5,
                "{id} secondary"
            );
            assert!(contrast(p.text_faint, p.surface) >= 3.0, "{id} faint");
            for (name, c) in [
                ("accent", p.accent),
                ("success", p.success),
                ("warning", p.warning),
                ("danger", p.danger),
            ] {
                assert!(contrast(c, p.background) >= 4.5, "{id} {name}");
            }
            assert_eq!(p.background, theme.background);
            assert_eq!(p.well, theme.background);
        }
    }

    #[test]
    fn a_state_colour_lifts_toward_black_on_a_light_theme() {
        let latte = theme_named("catppuccin-latte");
        let p = latte.chrome();
        assert_ne!(p.warning, latte.ansi[3]);
        assert!(luminance(p.warning) < luminance(latte.ansi[3]));
    }

    #[test]
    fn mix_rounds_half_away_from_zero() {
        assert_eq!(mix(0x000000, 0x010101, 0.5), 0x010101);
        assert_eq!(mix(0x102030, 0x102030, 0.7), 0x102030);
    }

    #[test]
    fn unknown_ids_get_tethers_chrome() {
        assert_eq!(theme_named("no-such-theme").chrome(), TETHER);
    }
}
