use swash::FontRef;
use tether_core::fonts::FontFace;
use tether_core::resize::GridSize;

use crate::fonts::face_bytes;

pub fn pt_to_px(pt: f32, scale: f32) -> f32 {
    pt * 96.0 / 72.0 * scale
}

pub(crate) struct FaceMetrics {
    pub cell_w: f32,
    pub cell_h: f32,
    pub baseline: f32,
    pub ascent: f32,
    pub stroke: f32,
}

pub(crate) fn face_metrics(font: &FontFace, size_px: f32, line_spacing: f32) -> FaceMetrics {
    let face = FontRef::from_index(face_bytes(font.id).0, 0).expect("bundled font parses");
    let m = face.metrics(&[]).scale(size_px);
    let advance = face
        .glyph_metrics(&[])
        .scale(size_px)
        .advance_width(face.charmap().map('M'));
    let ascent = m.ascent.abs();
    let natural = ascent + m.descent.abs() + m.leading.max(0.0);
    let cell_h = (natural * line_spacing).round().max(1.0);
    FaceMetrics {
        cell_w: advance.round().max(1.0),
        cell_h,
        baseline: ((cell_h - (ascent + m.descent.abs())) / 2.0 + ascent).round(),
        ascent,
        stroke: (size_px / 14.0).round().max(1.0),
    }
}

pub fn cell_metrics(font: &FontFace, size_px: f32, line_spacing: f32) -> (f32, f32) {
    let m = face_metrics(font, size_px, line_spacing);
    (m.cell_w, m.cell_h)
}

pub fn grid_size(
    width: u32,
    height: u32,
    padding_px: u32,
    (cell_w, cell_h): (f32, f32),
) -> GridSize {
    let fit = |avail: u32, cell: f32| {
        ((avail as f32 / cell).floor() as u32).clamp(1, u16::MAX as u32) as u16
    };
    let cols = fit(width.saturating_sub(2 * padding_px), cell_w);
    let rows = fit(height.saturating_sub(2 * padding_px), cell_h);
    GridSize {
        cols,
        rows,
        width_px: (cols as f32 * cell_w) as u32,
        height_px: (rows as f32 * cell_h) as u32,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tether_core::fonts::font_named;

    #[test]
    fn points_scale_with_the_monitor() {
        assert!((pt_to_px(14.0, 1.0) - 18.666_666).abs() < 1e-4);
        assert!((pt_to_px(14.0, 2.0) - 37.333_332).abs() < 1e-4);
    }

    #[test]
    fn cells_double_at_twice_the_size() {
        let font = font_named("cascadia-mono");
        let (w1, h1) = cell_metrics(font, pt_to_px(14.0, 1.0), 1.0);
        let (w2, h2) = cell_metrics(font, pt_to_px(14.0, 2.0), 1.0);
        assert!(w1 >= 8.0 && h1 >= 16.0, "{w1}x{h1}");
        assert!((w2 - 2.0 * w1).abs() <= 1.0 && (h2 - 2.0 * h1).abs() <= 1.0);
    }

    #[test]
    fn line_spacing_stretches_only_the_height() {
        let font = font_named("jetbrains-mono");
        let (w1, h1) = cell_metrics(font, 18.0, 1.0);
        let (w2, h2) = cell_metrics(font, 18.0, 1.5);
        assert_eq!(w1, w2);
        assert!((h2 - 1.5 * h1).abs() <= 1.5);
    }

    #[test]
    fn grid_fits_inside_the_padding() {
        let g = grid_size(800, 600, 8, (9.0, 18.0));
        assert_eq!(
            (g.cols, g.rows, g.width_px, g.height_px),
            (87, 32, 783, 576)
        );
    }

    #[test]
    fn a_window_smaller_than_the_padding_is_still_one_cell() {
        let g = grid_size(10, 10, 24, (9.0, 18.0));
        assert_eq!((g.cols, g.rows), (1, 1));
    }

    #[test]
    fn baseline_sits_inside_the_cell() {
        let m = face_metrics(font_named("cascadia-mono"), 18.0, 1.4);
        assert!(m.baseline > 0.0 && m.baseline < m.cell_h);
        assert!(m.stroke >= 1.0);
    }
}
