use std::collections::HashMap;

use swash::FontRef;
use swash::scale::image::Content;
use swash::scale::{Render, ScaleContext, Source, StrikeWith};
use swash::zeno::Format;
use tether_core::fonts::FontFace;

use crate::fonts::{SYMBOLS, face_bytes, system_fallbacks};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum FaceSlot {
    Primary { bold: bool },
    Symbols,
    System(usize),
}

pub(crate) fn face_data(font: &FontFace, slot: FaceSlot) -> &'static [u8] {
    match slot {
        FaceSlot::Primary { bold: false } => face_bytes(font.id).0,
        FaceSlot::Primary { bold: true } => face_bytes(font.id).1,
        FaceSlot::Symbols => SYMBOLS,
        FaceSlot::System(i) => system_fallbacks()[i],
    }
}

fn glyph_in(data: &[u8], ch: char) -> u16 {
    FontRef::from_index(data, 0).map_or(0, |f| f.charmap().map(ch))
}

pub(crate) fn resolve(font: &FontFace, bold: bool, ch: char) -> (FaceSlot, u16) {
    let primary = FaceSlot::Primary { bold };
    let slots = [primary, FaceSlot::Symbols]
        .into_iter()
        .chain((0..system_fallbacks().len()).map(FaceSlot::System));
    for slot in slots {
        let glyph = glyph_in(face_data(font, slot), ch);
        if glyph != 0 {
            return (slot, glyph);
        }
    }
    (primary, 0)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) struct GlyphKey {
    pub font: &'static str,
    pub slot: FaceSlot,
    pub glyph: u16,
}

pub(crate) struct RasterGlyph {
    pub left: i32,
    pub top: i32,
    pub width: u32,
    pub height: u32,
    pub color: bool,
    pub data: Vec<u8>,
}

pub(crate) struct GlyphAtlas {
    size_px: f32,
    glyphs: HashMap<GlyphKey, Option<RasterGlyph>>,
}

impl GlyphAtlas {
    pub fn new() -> Self {
        GlyphAtlas {
            size_px: 0.0,
            glyphs: HashMap::new(),
        }
    }

    pub fn prepare(&mut self, size_px: f32) {
        if size_px.to_bits() != self.size_px.to_bits() {
            self.glyphs.clear();
            self.size_px = size_px;
        }
    }

    #[allow(dead_code)]
    pub fn len(&self) -> usize {
        self.glyphs.len()
    }

    pub fn get(&mut self, ctx: &mut ScaleContext, key: GlyphKey) -> Option<&RasterGlyph> {
        let size_px = self.size_px;
        self.glyphs
            .entry(key)
            .or_insert_with(|| rasterize(ctx, key, size_px))
            .as_ref()
    }
}

fn rasterize(ctx: &mut ScaleContext, key: GlyphKey, size_px: f32) -> Option<RasterGlyph> {
    let font = tether_core::fonts::font_named(key.font);
    let face = FontRef::from_index(face_data(font, key.slot), 0)?;
    let mut scaler = ctx.builder(face).size(size_px).hint(true).build();
    let image = Render::new(&[
        Source::ColorOutline(0),
        Source::ColorBitmap(StrikeWith::BestFit),
        Source::Outline,
    ])
    .format(Format::Alpha)
    .render(&mut scaler, key.glyph)?;
    Some(RasterGlyph {
        left: image.placement.left,
        top: image.placement.top,
        width: image.placement.width,
        height: image.placement.height,
        color: matches!(image.content, Content::Color),
        data: image.data,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use swash::scale::ScaleContext;
    use tether_core::fonts::font_named;

    #[test]
    fn letters_come_from_the_chosen_face() {
        let font = font_named("cascadia-mono");
        assert!(
            matches!(resolve(font, false, 'A'), (FaceSlot::Primary { bold: false }, g) if g != 0)
        );
        assert!(
            matches!(resolve(font, true, 'A'), (FaceSlot::Primary { bold: true }, g) if g != 0)
        );
    }

    #[test]
    fn a_missing_glyph_falls_back_to_the_symbols_font() {
        let font = font_named("cascadia-mono");
        assert!(matches!(resolve(font, false, '\u{f121}'), (FaceSlot::Symbols, g) if g != 0));
    }

    #[test]
    fn a_glyph_no_font_has_is_notdef_in_the_primary_face() {
        let font = font_named("cascadia-mono");
        assert_eq!(
            resolve(font, false, '\u{10FFFD}'),
            (FaceSlot::Primary { bold: false }, 0)
        );
    }

    #[test]
    fn the_atlas_rasterizes_once_per_size_and_clears_on_a_new_size() {
        let font = font_named("cascadia-mono");
        let mut ctx = ScaleContext::new();
        let mut atlas = GlyphAtlas::new();
        let (slot, glyph) = resolve(font, false, 'M');
        let key = GlyphKey {
            font: font.id,
            slot,
            glyph,
        };

        atlas.prepare(18.0);
        let w18 = atlas.get(&mut ctx, key).unwrap().width;
        atlas.prepare(18.0);
        assert_eq!(atlas.len(), 1);

        atlas.prepare(37.0);
        assert_eq!(atlas.len(), 0);
        let w37 = atlas.get(&mut ctx, key).unwrap().width;
        assert!(w37 > w18 * 3 / 2, "{w18} → {w37}");
    }
}
