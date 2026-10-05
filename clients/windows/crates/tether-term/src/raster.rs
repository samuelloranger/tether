use std::collections::HashMap;

use swash::FontRef;
use swash::scale::ScaleContext;
use swash::shape::ShapeContext;
use tether_core::fonts::FontFace;
use tether_core::prefs::CursorShape;
use tether_core::theme::TerminalTheme;

use crate::glyphs::{FaceSlot, GlyphAtlas, GlyphKey, RasterGlyph, face_data, resolve};
use crate::metrics::{FaceMetrics, face_metrics};
use crate::snapshot::{RenderCell, Snapshot};
use crate::terminal::Cell;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RgbaImage {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
}

impl RgbaImage {
    fn filled(width: u32, height: u32, rgb: u32) -> Self {
        let px = [(rgb >> 16) as u8, (rgb >> 8) as u8, rgb as u8, 255];
        RgbaImage {
            width,
            height,
            pixels: px.repeat((width * height) as usize),
        }
    }

    pub fn pixel(&self, x: u32, y: u32) -> [u8; 4] {
        let i = ((y * self.width + x) * 4) as usize;
        self.pixels[i..i + 4].try_into().unwrap()
    }

    fn fill_rect(&mut self, x: i32, y: i32, w: i32, h: i32, rgb: u32) {
        let (x0, y0) = (x.max(0), y.max(0));
        let (x1, y1) = (
            (x + w).min(self.width as i32),
            (y + h).min(self.height as i32),
        );
        let px = [(rgb >> 16) as u8, (rgb >> 8) as u8, rgb as u8, 255];
        for yy in y0..y1 {
            for xx in x0..x1 {
                let i = ((yy as u32 * self.width + xx as u32) * 4) as usize;
                self.pixels[i..i + 4].copy_from_slice(&px);
            }
        }
    }

    fn draw_glyph(&mut self, glyph: &RasterGlyph, x: i32, y: i32, rgb: u32) {
        let fg = [(rgb >> 16) as u8, (rgb >> 8) as u8, rgb as u8];
        for gy in 0..glyph.height as i32 {
            for gx in 0..glyph.width as i32 {
                let (px, py) = (x + gx, y + gy);
                if px < 0 || py < 0 || px >= self.width as i32 || py >= self.height as i32 {
                    continue;
                }
                let i = ((py as u32 * self.width + px as u32) * 4) as usize;
                let g = (gy as u32 * glyph.width + gx as u32) as usize;
                let (src, alpha) = if glyph.color {
                    let s = &glyph.data[g * 4..g * 4 + 4];
                    ([s[0], s[1], s[2]], s[3] as u32)
                } else {
                    (fg, glyph.data[g] as u32)
                };
                for (c, &channel) in src.iter().enumerate() {
                    let dst = self.pixels[i + c] as u32;
                    self.pixels[i + c] =
                        ((channel as u32 * alpha + dst * (255 - alpha)) / 255) as u8;
                }
            }
        }
    }
}

pub struct RenderStyle<'a> {
    pub theme: &'a TerminalTheme,
    pub font: &'static FontFace,
    pub size_px: f32,
    pub line_spacing: f32,
    pub padding_px: u32,
    pub cursor: CursorShape,
    pub cursor_on: bool,
    pub hover_link: Option<(usize, usize, usize)>,
}

pub struct Rasterizer {
    scale: ScaleContext,
    shape: ShapeContext,
    atlas: GlyphAtlas,
    resolved: HashMap<(&'static str, bool, char), (FaceSlot, u16)>,
}

impl Default for Rasterizer {
    fn default() -> Self {
        Self::new()
    }
}

impl Rasterizer {
    pub fn new() -> Self {
        Rasterizer {
            scale: ScaleContext::new(),
            shape: ShapeContext::new(),
            atlas: GlyphAtlas::new(),
            resolved: HashMap::new(),
        }
    }

    fn lookup(&mut self, font: &'static FontFace, bold: bool, ch: char) -> (FaceSlot, u16) {
        *self
            .resolved
            .entry((font.id, bold, ch))
            .or_insert_with(|| resolve(font, bold, ch))
    }

    pub fn render(
        &mut self,
        snap: &Snapshot,
        style: &RenderStyle,
        width: u32,
        height: u32,
    ) -> RgbaImage {
        self.render_with(snap, style, width, height, style.font.ligatures)
    }

    pub(crate) fn render_with(
        &mut self,
        snap: &Snapshot,
        style: &RenderStyle,
        width: u32,
        height: u32,
        ligatures: bool,
    ) -> RgbaImage {
        self.atlas.prepare(style.size_px);
        let m = face_metrics(style.font, style.size_px, style.line_spacing);
        let mut img = RgbaImage::filled(width, height, style.theme.background);
        let pad = style.padding_px as i32;
        let origin_y = height as i32 - pad - (snap.rows as f32 * m.cell_h) as i32;
        let cell_x = |col: usize| pad + (col as f32 * m.cell_w) as i32;
        let cell_y = |row: usize| origin_y + (row as f32 * m.cell_h) as i32;
        let (cw, chh) = (m.cell_w as i32, m.cell_h as i32);

        for row in 0..snap.rows {
            let y = cell_y(row);
            if y + chh <= 0 {
                continue;
            }
            for col in 0..snap.cols {
                let cell = snap.cell(row, col);
                let (mut fg, mut bg) = (cell.fg, cell.bg);
                if self.block_cursor_at(snap, style, row, col) {
                    (fg, bg) = (style.theme.background, style.theme.cursor);
                }
                let span = if cell.wide { 2 } else { 1 };
                if bg != style.theme.background {
                    img.fill_rect(cell_x(col), y, cw * span, chh, bg);
                }
                if !ligatures && !cell.spacer && cell.ch != ' ' {
                    self.draw_char(
                        &mut img,
                        style.font,
                        cell.bold,
                        cell.ch,
                        cell_x(col),
                        y + m.baseline as i32,
                        fg,
                    );
                    for &mark in &cell.zerowidth {
                        self.draw_char(
                            &mut img,
                            style.font,
                            cell.bold,
                            mark,
                            cell_x(col),
                            y + m.baseline as i32,
                            fg,
                        );
                    }
                }
                let hovered = style
                    .hover_link
                    .is_some_and(|(r, s, e)| r == row && (s..e).contains(&col));
                if cell.underline || hovered {
                    img.fill_rect(
                        cell_x(col),
                        y + m.baseline as i32 + m.stroke as i32,
                        cw * span,
                        m.stroke as i32,
                        fg,
                    );
                }
                if cell.strikeout {
                    let sy = y + m.baseline as i32 - (m.ascent / 3.0) as i32;
                    img.fill_rect(cell_x(col), sy, cw * span, m.stroke as i32, fg);
                }
            }
            if ligatures {
                self.draw_shaped_row(&mut img, snap, style, &m, row, cell_x(0), y);
            }
        }
        self.draw_thin_cursor(&mut img, snap, style, &m, cell_x, cell_y);
        img
    }

    pub(crate) fn shape_run(
        &mut self,
        font: &'static FontFace,
        bold: bool,
        text: &str,
        size_px: f32,
        cell_w: f32,
    ) -> Vec<(usize, u16, f32)> {
        let Some(face) = FontRef::from_index(face_data(font, FaceSlot::Primary { bold }), 0) else {
            return Vec::new();
        };
        let byte_of_char: Vec<usize> = text.char_indices().map(|(byte, _)| byte).collect();
        let mut shaper = self.shape.builder(face).size(size_px).build();
        shaper.add_str(text);
        let mut out = Vec::new();
        shaper.shape_with(|cluster| {
            let index = byte_of_char.partition_point(|&b| b < cluster.source.start as usize);
            let mut inside = 0.0;
            for glyph in cluster.glyphs {
                out.push((index, glyph.id, index as f32 * cell_w + inside + glyph.x));
                inside += glyph.advance;
            }
        });
        out
    }

    fn block_cursor_at(
        &self,
        snap: &Snapshot,
        style: &RenderStyle,
        row: usize,
        col: usize,
    ) -> bool {
        style.cursor_on
            && style.cursor == CursorShape::Block
            && snap.cursor == Some(Cell { row, col })
    }

    fn draw_thin_cursor(
        &self,
        img: &mut RgbaImage,
        snap: &Snapshot,
        style: &RenderStyle,
        m: &FaceMetrics,
        cell_x: impl Fn(usize) -> i32,
        cell_y: impl Fn(usize) -> i32,
    ) {
        let Some(Cell { row, col }) = snap.cursor.filter(|_| style.cursor_on) else {
            return;
        };
        let (x, y, cw, ch) = (cell_x(col), cell_y(row), m.cell_w as i32, m.cell_h as i32);
        let thick = (m.stroke as i32 * 2).max(1);
        match style.cursor {
            CursorShape::Block => {}
            CursorShape::Bar => img.fill_rect(x, y, thick, ch, style.theme.cursor),
            CursorShape::Underline => {
                img.fill_rect(x, y + ch - thick, cw, thick, style.theme.cursor)
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn draw_char(
        &mut self,
        img: &mut RgbaImage,
        font: &'static FontFace,
        bold: bool,
        ch: char,
        x: i32,
        baseline: i32,
        rgb: u32,
    ) {
        let (slot, glyph) = self.lookup(font, bold, ch);
        let key = GlyphKey {
            font: font.id,
            slot,
            glyph,
        };
        if let Some(g) = self.atlas.get(&mut self.scale, key) {
            img.draw_glyph(g, x + g.left, baseline - g.top, rgb);
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn draw_shaped_row(
        &mut self,
        img: &mut RgbaImage,
        snap: &Snapshot,
        style: &RenderStyle,
        m: &FaceMetrics,
        row: usize,
        x0: i32,
        y: i32,
    ) {
        let baseline = y + m.baseline as i32;
        let primary: Vec<bool> = (0..snap.cols)
            .map(|col| {
                let c: &RenderCell = snap.cell(row, col);
                !c.spacer
                    && !c.wide
                    && matches!(
                        self.lookup(style.font, c.bold, c.ch).0,
                        FaceSlot::Primary { .. }
                    )
            })
            .collect();
        let mut col = 0;
        while col < snap.cols {
            let cell = snap.cell(row, col);
            if !primary[col] {
                if !cell.spacer && cell.ch != ' ' {
                    let fg = self.cell_fg(snap, style, row, col);
                    self.draw_char(
                        img,
                        style.font,
                        cell.bold,
                        cell.ch,
                        x0 + (col as f32 * m.cell_w) as i32,
                        baseline,
                        fg,
                    );
                }
                col += 1;
                continue;
            }
            let (start, bold) = (col, cell.bold);
            let mut text = String::new();
            while col < snap.cols && primary[col] && snap.cell(row, col).bold == bold {
                text.push(snap.cell(row, col).ch);
                col += 1;
            }
            let run_x = x0 + (start as f32 * m.cell_w) as i32;
            for (index, glyph, x) in
                self.shape_run(style.font, bold, &text, style.size_px, m.cell_w)
            {
                let c = start + index;
                if snap.cell(row, c).ch == ' ' {
                    continue;
                }
                let fg = self.cell_fg(snap, style, row, c);
                let key = GlyphKey {
                    font: style.font.id,
                    slot: FaceSlot::Primary { bold },
                    glyph,
                };
                if let Some(g) = self.atlas.get(&mut self.scale, key) {
                    img.draw_glyph(g, run_x + x.round() as i32 + g.left, baseline - g.top, fg);
                }
            }
        }
    }

    fn cell_fg(&self, snap: &Snapshot, style: &RenderStyle, row: usize, col: usize) -> u32 {
        if self.block_cursor_at(snap, style, row, col) {
            style.theme.background
        } else {
            snap.cell(row, col).fg
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::metrics::{cell_metrics, pt_to_px};
    use crate::snapshot::Snapshot;
    use crate::terminal::TabTerminal;
    use crate::terminal::tests::size;
    use tether_core::fonts::font_named;
    use tether_core::prefs::CursorShape;
    use tether_core::theme::{TerminalTheme, theme_named};

    fn style<'a>(theme: &'a TerminalTheme, scale: f32) -> RenderStyle<'a> {
        RenderStyle {
            theme,
            font: font_named("cascadia-mono"),
            size_px: pt_to_px(14.0, scale),
            line_spacing: 1.0,
            padding_px: (8.0 * scale) as u32,
            cursor: CursorShape::Block,
            cursor_on: false,
            hover_link: None,
        }
    }

    fn snap(text: &[u8]) -> Snapshot {
        let mut t = TabTerminal::new(size(20, 4), theme_named("tether"));
        t.feed(text);
        t.snapshot()
    }

    fn rgba(rgb: u32) -> [u8; 4] {
        [(rgb >> 16) as u8, (rgb >> 8) as u8, rgb as u8, 255]
    }

    fn cell_has_ink(img: &RgbaImage, x0: u32, y0: u32, w: u32, h: u32, bg: u32) -> bool {
        (y0..y0 + h).any(|y| (x0..x0 + w).any(|x| img.pixel(x, y) != rgba(bg)))
    }

    #[test]
    fn buffer_matches_the_requested_size_at_1x_and_2x() {
        let theme = theme_named("tether");
        let mut r = Rasterizer::new();
        let one = r.render(&snap(b"hi"), &style(theme, 1.0), 300, 120);
        assert_eq!(
            (one.width, one.height, one.pixels.len()),
            (300, 120, 300 * 120 * 4)
        );
        let two = r.render(&snap(b"hi"), &style(theme, 2.0), 600, 240);
        assert_eq!(two.pixels.len(), 600 * 240 * 4);
    }

    #[test]
    fn the_well_is_the_theme_background() {
        let mut r = Rasterizer::new();
        let img = r.render(&snap(b""), &style(theme_named("tether"), 1.0), 300, 120);
        assert_eq!(img.pixel(0, 0), [0x1E, 0x1E, 0x2E, 255]);
        let img = r.render(&snap(b""), &style(theme_named("dracula"), 1.0), 300, 120);
        assert_eq!(img.pixel(299, 119), [0x28, 0x2A, 0x36, 255]);
    }

    #[test]
    fn the_grid_is_bottom_anchored_inside_the_padding() {
        let theme = theme_named("tether");
        let st = RenderStyle {
            cursor_on: true,
            ..style(theme, 1.0)
        };
        let (cw, ch) = cell_metrics(st.font, st.size_px, 1.0);
        let height = (4.0 * ch) as u32 + 2 * st.padding_px + 7;
        let img = Rasterizer::new().render(&snap(b""), &st, 300, height);
        let top = height - st.padding_px - (4.0 * ch) as u32;
        assert_eq!(
            img.pixel(st.padding_px + 1, top + 1),
            rgba(theme.cursor),
            "block cursor at row 0, col 0"
        );
        assert_eq!(
            img.pixel(st.padding_px + 1, top - 1),
            rgba(theme.background)
        );
        assert_eq!(
            img.pixel(st.padding_px - 1, top + 1),
            rgba(theme.background)
        );
        assert!(cw > 0.0);
    }

    #[test]
    fn bar_and_underline_cursors_do_not_fill_the_cell() {
        let theme = theme_named("tether");
        for shape in [CursorShape::Bar, CursorShape::Underline] {
            let st = RenderStyle {
                cursor_on: true,
                cursor: shape,
                padding_px: 0,
                ..style(theme, 1.0)
            };
            let (cw, ch) = cell_metrics(st.font, st.size_px, 1.0);
            let img =
                Rasterizer::new().render(&snap(b""), &st, (20.0 * cw) as u32, (4.0 * ch) as u32);
            let centre = img.pixel((cw / 2.0) as u32 + 1, (ch / 3.0) as u32);
            assert_eq!(centre, rgba(theme.background), "{shape:?}");
        }
    }

    #[test]
    fn glyphs_are_drawn_and_missing_ones_fall_back() {
        let theme = theme_named("tether");
        let st = RenderStyle {
            padding_px: 0,
            ..style(theme, 1.0)
        };
        let (cw, ch) = cell_metrics(st.font, st.size_px, 1.0);
        let (w, h) = ((20.0 * cw) as u32, (4.0 * ch) as u32);
        let img = Rasterizer::new().render(&snap("M\u{f121}".as_bytes()), &st, w, h);
        assert!(
            cell_has_ink(&img, 0, 0, cw as u32, ch as u32, theme.background),
            "M"
        );
        assert!(
            cell_has_ink(&img, cw as u32, 0, cw as u32, ch as u32, theme.background),
            "nerd icon from symbols font"
        );
    }

    #[test]
    fn a_hovered_link_is_underlined() {
        let theme = theme_named("tether");
        let plain = style(theme, 1.0);
        let hovered = RenderStyle {
            hover_link: Some((0, 0, 4)),
            ..style(theme, 1.0)
        };
        let s = snap(b"link");
        let mut r = Rasterizer::new();
        assert_ne!(
            r.render(&s, &plain, 300, 120),
            r.render(&s, &hovered, 300, 120)
        );
    }

    #[test]
    fn a_scale_change_never_reuses_glyphs_of_the_old_size() {
        let theme = theme_named("tether");
        let s = snap(b"scale");
        let mut reused = Rasterizer::new();
        reused.render(&s, &style(theme, 1.0), 300, 120);
        let after = reused.render(&s, &style(theme, 2.0), 600, 240);
        let fresh = Rasterizer::new().render(&s, &style(theme, 2.0), 600, 240);
        assert_eq!(after, fresh);
    }

    #[test]
    fn a_well_smaller_than_the_padding_does_not_panic() {
        let theme = theme_named("tether");
        let st = RenderStyle {
            padding_px: 24,
            ..style(theme, 1.0)
        };
        let img = Rasterizer::new().render(&snap(b"x"), &st, 10, 10);
        assert_eq!(img.pixels.len(), 10 * 10 * 4);
    }

    #[test]
    fn cascadia_code_substitutes_glyphs_for_arrows() {
        let font = font_named("cascadia-code");
        let mut r = Rasterizer::new();
        let (cw, _) = cell_metrics(font, 18.0, 1.0);
        let shaped = r.shape_run(font, false, "=>", 18.0, cw);
        let (_, plain_eq) = crate::glyphs::resolve(font, false, '=');
        let (_, plain_gt) = crate::glyphs::resolve(font, false, '>');
        let ids: Vec<u16> = shaped.iter().map(|g| g.1).collect();
        assert_ne!(ids, [plain_eq, plain_gt]);
    }

    #[test]
    fn only_cascadia_code_draws_ligatures() {
        let theme = theme_named("tether");
        let code = RenderStyle {
            font: font_named("cascadia-code"),
            ..style(theme, 1.0)
        };
        let s = snap(b"a => b");
        let mut r = Rasterizer::new();
        let ligated = r.render(&s, &code, 300, 120);
        let unligated = r.render_with(&s, &code, 300, 120, false);
        assert_ne!(ligated, unligated);
        assert!(!font_named("cascadia-mono").ligatures);
    }

    #[test]
    fn shaped_text_stays_on_the_cell_grid() {
        let font = font_named("cascadia-code");
        let mut r = Rasterizer::new();
        let (cw, _) = cell_metrics(font, 18.0, 1.0);
        let shaped = r.shape_run(font, false, "a=>b-x", 18.0, cw);
        let last = shaped.last().unwrap();
        assert_eq!(last.0, 5);
        assert_eq!(last.2, 5.0 * cw, "the last glyph sits exactly on its cell");
    }
}
