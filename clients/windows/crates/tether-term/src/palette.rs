use alacritty_terminal::term::color::{COUNT, Colors};
use alacritty_terminal::vte::ansi::{Color, Rgb};
use tether_core::theme::TerminalTheme;

pub(crate) fn rgb_u32(c: Rgb) -> u32 {
    (c.r as u32) << 16 | (c.g as u32) << 8 | c.b as u32
}

pub(crate) fn to_rgb(v: u32) -> Rgb {
    Rgb {
        r: (v >> 16) as u8,
        g: (v >> 8) as u8,
        b: v as u8,
    }
}

pub(crate) fn dim(v: u32) -> u32 {
    let f = |shift: u32| ((v >> shift & 0xFF) * 2 / 3) << shift;
    f(16) | f(8) | f(0)
}

/// `a` over `b` at `t` (0..=1), per channel.
pub(crate) fn mix(a: u32, b: u32, t: f32) -> u32 {
    let ch = |shift: u32| {
        let (x, y) = (((a >> shift) & 0xff) as f32, ((b >> shift) & 0xff) as f32);
        ((x * t + y * (1.0 - t)).round() as u32) << shift
    };
    (a & 0xff00_0000) | ch(16) | ch(8) | ch(0)
}

pub(crate) fn theme_color(theme: &TerminalTheme, index: usize) -> u32 {
    match index {
        0..16 => theme.ansi[index],
        16..232 => {
            let i = index - 16;
            let level = |n: usize| if n == 0 { 0 } else { (n * 40 + 55) as u32 };
            level(i / 36) << 16 | level(i / 6 % 6) << 8 | level(i % 6)
        }
        232..256 => {
            let g = (8 + 10 * (index - 232)) as u32;
            g << 16 | g << 8 | g
        }
        256 | 267 => theme.foreground,
        257 => theme.background,
        258 => theme.cursor,
        259..267 => dim(theme.ansi[index - 259]),
        _ => dim(theme.foreground),
    }
}

pub(crate) fn indexed(theme: &TerminalTheme, colors: &Colors, index: usize) -> u32 {
    if index >= COUNT {
        return theme.foreground;
    }
    colors[index]
        .map(rgb_u32)
        .unwrap_or_else(|| theme_color(theme, index))
}

pub(crate) fn resolve(theme: &TerminalTheme, colors: &Colors, color: Color) -> u32 {
    match color {
        Color::Spec(rgb) => rgb_u32(rgb),
        Color::Indexed(i) => indexed(theme, colors, i as usize),
        Color::Named(name) => indexed(theme, colors, name as usize),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alacritty_terminal::term::color::Colors;
    use alacritty_terminal::vte::ansi::{Color, NamedColor, Rgb};
    use tether_core::theme::theme_named;

    #[test]
    fn ansi_and_dynamic_entries_come_from_the_theme() {
        let t = theme_named("tether");
        assert_eq!(theme_color(t, 1), 0xF38BA8);
        assert_eq!(theme_color(t, 256), 0xCCCCCC);
        assert_eq!(theme_color(t, 257), 0x1E1E2E);
        assert_eq!(theme_color(t, 258), 0xFFFFFF);
    }

    #[test]
    fn cube_and_gray_ramp_follow_xterm() {
        let t = theme_named("tether");
        assert_eq!(theme_color(t, 16), 0x000000);
        assert_eq!(theme_color(t, 196), 0xFF0000);
        assert_eq!(theme_color(t, 231), 0xFFFFFF);
        assert_eq!(theme_color(t, 232), 0x080808);
        assert_eq!(theme_color(t, 244), 0x808080);
    }

    #[test]
    fn dim_is_two_thirds() {
        assert_eq!(dim(0x969696), 0x646464);
        let t = theme_named("tether");
        assert_eq!(theme_color(t, NamedColor::DimRed as usize), dim(0xF38BA8));
    }

    #[test]
    fn a_program_override_wins_over_the_theme() {
        let t = theme_named("tether");
        let mut colors = Colors::default();
        colors[1] = Some(Rgb {
            r: 0xff,
            g: 0,
            b: 0,
        });
        assert_eq!(indexed(t, &colors, 1), 0xFF0000);
        assert_eq!(resolve(t, &colors, Color::Named(NamedColor::Red)), 0xFF0000);
        assert_eq!(resolve(t, &colors, Color::Indexed(2)), 0xA6E3A1);
    }

    #[test]
    fn truecolor_passes_through() {
        let t = theme_named("tether");
        let rgb = Rgb { r: 1, g: 2, b: 3 };
        assert_eq!(resolve(t, &Colors::default(), Color::Spec(rgb)), 0x010203);
        assert_eq!(to_rgb(0x010203), rgb);
    }
}
