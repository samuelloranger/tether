use tether_core::{TerminalPrefs, font_named, resize::GridSize, theme_named};
use tether_term::{Rasterizer, RenderStyle, RgbaImage, TabTerminal, cell_metrics, pt_to_px};

pub const SAMPLE: &[u8] = b"\x1b[32mme@devbox\x1b[0m \x1b[34m~\x1b[0m $ ls\r\nsrc  README.md\r\n\x1b[32mme@devbox\x1b[0m \x1b[34m~\x1b[0m $ ";
pub const COLS: u16 = 22;
pub const ROWS: u16 = 3;

pub fn geometry(prefs: &TerminalPrefs, scale: f32) -> GridSize {
    let font = font_named(&prefs.font);
    let size_px = pt_to_px(prefs.size_pt, scale);
    let (cell_w, cell_h) = cell_metrics(font, size_px, prefs.line_spacing);
    let pad_total = (2.0 * pt_to_px(prefs.padding_pt, scale)).round() as u32;
    GridSize {
        cols: COLS,
        rows: ROWS,
        width_px: (cell_w * f32::from(COLS)).ceil() as u32 + pad_total,
        height_px: (cell_h * f32::from(ROWS)).ceil() as u32 + pad_total,
    }
}

pub struct Preview {
    rasterizer: Rasterizer,
}

impl Default for Preview {
    fn default() -> Self {
        Self::new()
    }
}

impl Preview {
    pub fn new() -> Self {
        Self {
            rasterizer: Rasterizer::new(),
        }
    }

    pub fn render(&mut self, prefs: &TerminalPrefs, scale: f32, cursor_on: bool) -> RgbaImage {
        let theme = theme_named(&prefs.scheme);
        let size = geometry(prefs, scale);
        let mut term = TabTerminal::new(size, theme);
        term.feed(SAMPLE);
        let style = RenderStyle {
            theme,
            font: font_named(&prefs.font),
            size_px: pt_to_px(prefs.size_pt, scale),
            line_spacing: prefs.line_spacing,
            padding_px: pt_to_px(prefs.padding_pt, scale).round() as u32,
            cursor: prefs.cursor,
            cursor_on,
            hover_link: None,
        };
        self.rasterizer
            .render(&term.snapshot(), &style, size.width_px, size.height_px)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tether_core::Preferences;

    fn prefs() -> TerminalPrefs {
        Preferences::default().terminal
    }

    #[test]
    fn image_matches_the_geometry() {
        let p = prefs();
        let g = geometry(&p, 1.0);
        let img = Preview::new().render(&p, 1.0, true);
        assert_eq!((img.width, img.height), (g.width_px, g.height_px));
        assert_eq!((g.cols, g.rows), (COLS, ROWS));
    }

    #[test]
    fn padding_shows_the_theme_background() {
        let img = Preview::new().render(&prefs(), 1.0, true);
        assert_eq!(img.pixel(0, 0), [0x1E, 0x1E, 0x2E, 255]);
        let mut latte = prefs();
        latte.scheme = "catppuccin-latte".into();
        assert_eq!(
            Preview::new().render(&latte, 1.0, true).pixel(0, 0),
            [0xEF, 0xF1, 0xF5, 255]
        );
    }

    #[test]
    fn the_sample_text_is_drawn() {
        let img = Preview::new().render(&prefs(), 1.0, false);
        let bg = img.pixel(0, 0);
        let drawn = (0..img.height)
            .flat_map(|y| (0..img.width).map(move |x| (x, y)))
            .any(|(x, y)| img.pixel(x, y) != bg);
        assert!(drawn);
    }

    #[test]
    fn twice_the_scale_is_twice_the_size() {
        let p = prefs();
        let (one, two) = (geometry(&p, 1.0), geometry(&p, 2.0));
        assert!((two.width_px as i64 - 2 * one.width_px as i64).abs() <= 2);
        assert!((two.height_px as i64 - 2 * one.height_px as i64).abs() <= 2);
    }

    #[test]
    fn a_bigger_font_makes_a_bigger_preview() {
        let mut big = prefs();
        big.size_pt = 24.0;
        assert!(geometry(&big, 1.0).width_px > geometry(&prefs(), 1.0).width_px);
    }

    #[test]
    fn an_unknown_font_renders_with_the_fallback() {
        let mut p = prefs();
        p.font = "menlo".into();
        let img = Preview::new().render(&p, 1.0, true);
        assert_eq!((img.width, img.height), {
            let g = geometry(&prefs(), 1.0);
            (g.width_px, g.height_px)
        });
    }
}
