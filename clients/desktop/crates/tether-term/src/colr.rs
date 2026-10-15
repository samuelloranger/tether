//! COLRv1 colour glyphs. swash paints COLRv0 only, and some systems' only emoji font is COLRv1.

use skrifa::color::{
    Brush, ColorGlyphFormat, ColorPainter, ColorStop, CompositeMode, Extend, Transform as Affine,
};
use skrifa::instance::{LocationRef, Size};
use skrifa::metrics::BoundingBox;
use skrifa::outline::{DrawSettings, OutlinePen};
use skrifa::raw::types::Point;
use skrifa::{FontRef, GlyphId, MetadataProvider};
use tiny_skia::{
    BlendMode, Color, FillRule, FilterQuality, GradientStop, LinearGradient, Mask, Paint, Path,
    PathBuilder, Pixmap, PixmapPaint, RadialGradient, Rect, Shader, SpreadMode, SweepGradient,
    Transform,
};

use crate::glyphs::RasterGlyph;

pub(crate) fn has_colr_v1(data: &[u8], glyph: u16) -> bool {
    FontRef::from_index(data, 0).is_ok_and(|font| {
        font.color_glyphs()
            .get_with_format(GlyphId::new(glyph.into()), ColorGlyphFormat::ColrV1)
            .is_some()
    })
}

/// None when the glyph has no COLRv1 paint, so the caller can fall back to swash.
pub(crate) fn rasterize(data: &[u8], glyph: u16, size_px: f32) -> Option<RasterGlyph> {
    let font = FontRef::from_index(data, 0).ok()?;
    let color = font
        .color_glyphs()
        .get_with_format(GlyphId::new(glyph.into()), ColorGlyphFormat::ColrV1)?;
    let location = LocationRef::default();
    let size = Size::new(size_px);
    let bounds = color
        .bounding_box(location, size)
        .or_else(|| font.metrics(size, location).bounds)?;
    let left = bounds.x_min.floor();
    let top = bounds.y_max.ceil();
    // A broken clip box must not allocate a huge canvas.
    let limit = (size_px * 4.0).max(1.0);
    let width = (bounds.x_max.ceil() - left).clamp(1.0, limit) as u32;
    let height = (top - bounds.y_min.floor()).clamp(1.0, limit) as u32;

    let upem = font.metrics(Size::unscaled(), location).units_per_em.max(1) as f32;
    let scale = size_px / upem;
    let mut painter = Painter {
        font: &font,
        palette: font
            .color_palettes()
            .get(0)
            .map(|p| p.colors().to_vec())
            .unwrap_or_default(),
        transforms: vec![Transform::from_row(scale, 0.0, 0.0, -scale, -left, top)],
        clips: Vec::new(),
        layers: vec![Pixmap::new(width, height)?],
    };
    color.paint(location, &mut painter).ok()?;
    let canvas = painter.layers.into_iter().next()?;
    let data = canvas
        .pixels()
        .iter()
        .flat_map(|p| {
            let c = p.demultiply();
            [c.red(), c.green(), c.blue(), c.alpha()]
        })
        .collect();
    Some(RasterGlyph {
        left: left as i32,
        top: top as i32,
        width,
        height,
        color: true,
        data,
    })
}

struct Painter<'a> {
    font: &'a FontRef<'a>,
    palette: Vec<skrifa::color::Color>,
    transforms: Vec<Transform>,
    clips: Vec<Mask>,
    layers: Vec<Pixmap>,
}

impl Painter<'_> {
    fn transform(&self) -> Transform {
        *self.transforms.last().unwrap_or(&Transform::identity())
    }

    fn canvas_size(&self) -> (u32, u32) {
        self.layers
            .first()
            .map_or((1, 1), |p| (p.width(), p.height()))
    }

    fn push_clip_path(&mut self, path: Option<Path>) {
        let (w, h) = self.canvas_size();
        let transform = self.transform();
        let mut mask = match self.clips.last() {
            Some(clip) => clip.clone(),
            None => {
                let mut all = Mask::new(w, h).expect("canvas size is non-zero");
                all.invert();
                all
            }
        };
        match path {
            Some(path) => mask.intersect_path(&path, FillRule::Winding, true, transform),
            None => mask.clear(),
        }
        self.clips.push(mask);
    }

    fn color(&self, palette_index: u16, alpha: f32) -> Color {
        // 0xFFFF is the text colour; a cached glyph has none, so emoji fonts that use it get black.
        let (r, g, b, a) = self
            .palette
            .get(palette_index as usize)
            .map_or((0, 0, 0, 255), |c| (c.red, c.green, c.blue, c.alpha));
        Color::from_rgba8(r, g, b, (a as f32 * alpha.clamp(0.0, 1.0)).round() as u8)
    }

    fn stops(&self, stops: &[ColorStop]) -> Vec<Stop> {
        stops
            .iter()
            .map(|s| (s.offset, self.color(s.palette_index, s.alpha)))
            .collect()
    }

    fn shader(&self, brush: Brush<'_>) -> Option<Shader<'static>> {
        let transform = self.transform();
        let point = |p: Point<f32>| tiny_skia::Point::from_xy(p.x, p.y);
        match brush {
            Brush::Solid {
                palette_index,
                alpha,
            } => Some(Shader::SolidColor(self.color(palette_index, alpha))),
            Brush::LinearGradient {
                p0,
                p1,
                color_stops,
                extend,
            } => single_stop(self, color_stops).or_else(|| {
                LinearGradient::new(
                    point(p0),
                    point(p1),
                    gradient(self.stops(color_stops)),
                    spread(extend),
                    transform,
                )
            }),
            Brush::RadialGradient {
                c0,
                r0,
                c1,
                r1,
                color_stops,
                extend,
            } => single_stop(self, color_stops).or_else(|| {
                let (c0, r0, c1, r1, stops) =
                    non_negative_radii(c0, r0, c1, r1, self.stops(color_stops))?;
                RadialGradient::new(
                    point(c0),
                    r0,
                    point(c1),
                    r1,
                    gradient(stops),
                    spread(extend),
                    transform,
                )
            }),
            Brush::SweepGradient {
                c0,
                start_angle,
                end_angle,
                color_stops,
                extend,
            } => single_stop(self, color_stops).or_else(|| {
                SweepGradient::new(
                    point(c0),
                    start_angle,
                    end_angle,
                    gradient(self.stops(color_stops)),
                    spread(extend),
                    transform,
                )
            }),
        }
    }
}

fn single_stop(painter: &Painter, stops: &[ColorStop]) -> Option<Shader<'static>> {
    match stops {
        [] => Some(Shader::SolidColor(Color::TRANSPARENT)),
        [only] => Some(Shader::SolidColor(
            painter.color(only.palette_index, only.alpha),
        )),
        _ => None,
    }
}

type Stop = (f32, Color);
type Radial = (Point<f32>, f32, Point<f32>, f32, Vec<Stop>);

fn gradient(stops: Vec<Stop>) -> Vec<GradientStop> {
    stops
        .into_iter()
        .map(|(offset, color)| GradientStop::new(offset, color))
        .collect()
}

/// The stop normalisation can leave one radius negative; the part of the colour line below
/// radius zero is not drawn, so the gradient is cut where the radius crosses zero.
fn non_negative_radii(
    c0: Point<f32>,
    r0: f32,
    c1: Point<f32>,
    r1: f32,
    stops: Vec<Stop>,
) -> Option<Radial> {
    if r0 >= 0.0 && r1 >= 0.0 {
        return Some((c0, r0, c1, r1, stops));
    }
    if r0 < 0.0 && r1 < 0.0 {
        return None;
    }
    let t = r0 / (r0 - r1);
    let at = Point::new(c0.x + (c1.x - c0.x) * t, c0.y + (c1.y - c0.y) * t);
    let cut = color_at(&stops, t);
    if r0 < 0.0 {
        let mut kept = vec![(0.0, cut)];
        kept.extend(
            stops
                .iter()
                .filter(|(o, _)| *o > t)
                .map(|(o, c)| ((o - t) / (1.0 - t), *c)),
        );
        Some((at, 0.0, c1, r1, kept))
    } else {
        let mut kept: Vec<Stop> = stops
            .iter()
            .filter(|(o, _)| *o < t)
            .map(|(o, c)| (o / t, *c))
            .collect();
        kept.push((1.0, cut));
        Some((c0, r0, at, 0.0, kept))
    }
}

fn color_at(stops: &[Stop], t: f32) -> Color {
    let after = stops.iter().position(|(o, _)| *o >= t);
    let (a, b) = match after {
        Some(0) => (stops[0], stops[0]),
        Some(i) => (stops[i - 1], stops[i]),
        None => match stops.last() {
            Some(last) => (*last, *last),
            None => return Color::TRANSPARENT,
        },
    };
    let span = b.0 - a.0;
    let k = if span > 0.0 { (t - a.0) / span } else { 0.0 };
    let mix = |x: f32, y: f32| x + (y - x) * k;
    Color::from_rgba(
        mix(a.1.red(), b.1.red()),
        mix(a.1.green(), b.1.green()),
        mix(a.1.blue(), b.1.blue()),
        mix(a.1.alpha(), b.1.alpha()),
    )
    .unwrap_or(Color::TRANSPARENT)
}

fn spread(extend: Extend) -> SpreadMode {
    match extend {
        Extend::Repeat => SpreadMode::Repeat,
        Extend::Reflect => SpreadMode::Reflect,
        _ => SpreadMode::Pad,
    }
}

fn blend(mode: CompositeMode) -> BlendMode {
    match mode {
        CompositeMode::Clear => BlendMode::Clear,
        CompositeMode::Src => BlendMode::Source,
        CompositeMode::Dest => BlendMode::Destination,
        CompositeMode::DestOver => BlendMode::DestinationOver,
        CompositeMode::SrcIn => BlendMode::SourceIn,
        CompositeMode::DestIn => BlendMode::DestinationIn,
        CompositeMode::SrcOut => BlendMode::SourceOut,
        CompositeMode::DestOut => BlendMode::DestinationOut,
        CompositeMode::SrcAtop => BlendMode::SourceAtop,
        CompositeMode::DestAtop => BlendMode::DestinationAtop,
        CompositeMode::Xor => BlendMode::Xor,
        CompositeMode::Plus => BlendMode::Plus,
        CompositeMode::Screen => BlendMode::Screen,
        CompositeMode::Overlay => BlendMode::Overlay,
        CompositeMode::Darken => BlendMode::Darken,
        CompositeMode::Lighten => BlendMode::Lighten,
        CompositeMode::ColorDodge => BlendMode::ColorDodge,
        CompositeMode::ColorBurn => BlendMode::ColorBurn,
        CompositeMode::HardLight => BlendMode::HardLight,
        CompositeMode::SoftLight => BlendMode::SoftLight,
        CompositeMode::Difference => BlendMode::Difference,
        CompositeMode::Exclusion => BlendMode::Exclusion,
        CompositeMode::Multiply => BlendMode::Multiply,
        CompositeMode::HslHue => BlendMode::Hue,
        CompositeMode::HslSaturation => BlendMode::Saturation,
        CompositeMode::HslColor => BlendMode::Color,
        CompositeMode::HslLuminosity => BlendMode::Luminosity,
        _ => BlendMode::SourceOver,
    }
}

fn affine(t: Affine) -> Transform {
    Transform::from_row(t.xx, t.yx, t.xy, t.yy, t.dx, t.dy)
}

struct Outline(PathBuilder);

impl OutlinePen for Outline {
    fn move_to(&mut self, x: f32, y: f32) {
        self.0.move_to(x, y);
    }
    fn line_to(&mut self, x: f32, y: f32) {
        self.0.line_to(x, y);
    }
    fn quad_to(&mut self, cx0: f32, cy0: f32, x: f32, y: f32) {
        self.0.quad_to(cx0, cy0, x, y);
    }
    fn curve_to(&mut self, cx0: f32, cy0: f32, cx1: f32, cy1: f32, x: f32, y: f32) {
        self.0.cubic_to(cx0, cy0, cx1, cy1, x, y);
    }
    fn close(&mut self) {
        self.0.close();
    }
}

impl ColorPainter for Painter<'_> {
    fn push_transform(&mut self, transform: Affine) {
        let next = self.transform().pre_concat(affine(transform));
        self.transforms.push(next);
    }

    fn pop_transform(&mut self) {
        if self.transforms.len() > 1 {
            self.transforms.pop();
        }
    }

    fn push_clip_glyph(&mut self, glyph_id: GlyphId) {
        let path = self
            .font
            .outline_glyphs()
            .get(glyph_id)
            .and_then(|outline| {
                let mut pen = Outline(PathBuilder::new());
                outline
                    .draw(
                        DrawSettings::unhinted(Size::unscaled(), LocationRef::default()),
                        &mut pen,
                    )
                    .ok()?;
                pen.0.finish()
            });
        self.push_clip_path(path);
    }

    fn push_clip_box(&mut self, clip_box: BoundingBox) {
        let rect = Rect::from_ltrb(
            clip_box.x_min,
            clip_box.y_min,
            clip_box.x_max,
            clip_box.y_max,
        );
        self.push_clip_path(rect.map(PathBuilder::from_rect));
    }

    fn pop_clip(&mut self) {
        self.clips.pop();
    }

    fn fill(&mut self, brush: Brush<'_>) {
        let Some(shader) = self.shader(brush) else {
            return;
        };
        let (w, h) = self.canvas_size();
        let Some(rect) = Rect::from_xywh(0.0, 0.0, w as f32, h as f32) else {
            return;
        };
        let paint = Paint {
            shader,
            anti_alias: true,
            ..Paint::default()
        };
        let clip = self.clips.last();
        if let Some(layer) = self.layers.last_mut() {
            layer.fill_rect(rect, &paint, Transform::identity(), clip);
        }
    }

    fn push_layer(&mut self, _: CompositeMode) {
        let (w, h) = self.canvas_size();
        if let Some(layer) = Pixmap::new(w, h) {
            self.layers.push(layer);
        }
    }

    fn pop_layer_with_mode(&mut self, mode: CompositeMode) {
        if self.layers.len() < 2 {
            return;
        }
        let Some(top) = self.layers.pop() else {
            return;
        };
        let paint = PixmapPaint {
            blend_mode: blend(mode),
            opacity: 1.0,
            quality: FilterQuality::Nearest,
        };
        let clip = self.clips.last();
        if let Some(below) = self.layers.last_mut() {
            below.draw_pixmap(0, 0, top.as_ref(), &paint, Transform::identity(), clip);
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) static COLR_V1_EMOJI: &[u8] = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/NotoColorEmoji-COLRv1-subset.ttf"
    ));

    fn glyph(ch: char) -> u16 {
        swash::FontRef::from_index(COLR_V1_EMOJI, 0)
            .unwrap()
            .charmap()
            .map(ch)
    }

    fn pixel(r: &RasterGlyph, x: u32, y: u32) -> [u8; 4] {
        let i = ((y * r.width + x) * 4) as usize;
        r.data[i..i + 4].try_into().unwrap()
    }

    #[test]
    fn swash_cannot_draw_the_fixture_so_it_tests_the_colr_v1_path() {
        let font = swash::FontRef::from_index(COLR_V1_EMOJI, 0).unwrap();
        let mut ctx = swash::scale::ScaleContext::new();
        let mut scaler = ctx.builder(font).size(32.0).build();
        let image = swash::scale::Render::new(&[
            swash::scale::Source::ColorOutline(0),
            swash::scale::Source::ColorBitmap(swash::scale::StrikeWith::BestFit),
        ])
        .render(&mut scaler, glyph('\u{1f600}'));
        assert!(image.is_none_or(|i| i.data.iter().all(|b| *b == 0)));
    }

    #[test]
    fn a_colr_v1_emoji_paints_in_colour_around_the_baseline() {
        let g = glyph('\u{1f600}');
        assert!(has_colr_v1(COLR_V1_EMOJI, g));
        let r = rasterize(COLR_V1_EMOJI, g, 32.0).expect("paints");
        assert!(r.color);
        assert!((28..=48).contains(&r.width), "width {}", r.width);
        assert!((28..=48).contains(&r.height), "height {}", r.height);
        assert!(r.top > 16 && r.top < r.height as i32, "top {}", r.top);
        // The face is yellow in the middle and transparent in the corner.
        let [red, green, blue, alpha] = pixel(&r, r.width / 2, r.height / 4);
        assert_eq!(alpha, 255);
        assert!(
            red > 200 && green > 120 && blue < 100,
            "{red} {green} {blue}"
        );
        assert_eq!(pixel(&r, 0, 0)[3], 0);
    }

    #[test]
    fn the_heart_is_red() {
        let r = rasterize(COLR_V1_EMOJI, glyph('\u{2764}'), 32.0).expect("paints");
        let [red, green, blue, alpha] = pixel(&r, r.width / 2, r.height / 2);
        assert_eq!(alpha, 255);
        assert!(red > 180 && green < 80 && blue < 80, "{red} {green} {blue}");
    }

    #[test]
    fn plain_glyphs_and_other_fonts_are_left_to_swash() {
        assert!(!has_colr_v1(crate::fonts::SYMBOLS, 1));
        assert!(rasterize(crate::fonts::SYMBOLS, 1, 32.0).is_none());
        assert!(rasterize(b"not a font", 1, 32.0).is_none());
    }

    #[test]
    fn a_negative_start_radius_is_cut_where_it_crosses_zero() {
        let stops = vec![(0.0, Color::BLACK), (1.0, Color::WHITE)];
        let (c0, r0, _, r1, kept) = non_negative_radii(
            Point::new(0.0, 0.0),
            -10.0,
            Point::new(30.0, 0.0),
            20.0,
            stops.clone(),
        )
        .unwrap();
        assert_eq!((r0, r1), (0.0, 20.0));
        assert!((c0.x - 10.0).abs() < 1e-4);
        assert_eq!(kept.len(), 2);
        assert_eq!(kept[0].0, 0.0);
        assert!((kept[0].1.red() - 1.0 / 3.0).abs() < 1e-4);
        assert_eq!(kept[1], (1.0, Color::WHITE));
        assert!(
            non_negative_radii(
                Point::new(0.0, 0.0),
                -1.0,
                Point::new(1.0, 0.0),
                -2.0,
                stops
            )
            .is_none()
        );
    }
}
