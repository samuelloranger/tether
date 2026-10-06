use tether_core::fonts::{FontFace, font_named};
use tether_core::prefs::CursorShape;
use tether_core::resize::GridSize;
use tether_core::theme::{TerminalTheme, theme_named};
use tether_term::{Cell, cell_metrics, grid_size, pt_to_px};

#[derive(Debug, Clone, PartialEq)]
pub struct TermStyle {
    pub theme: &'static TerminalTheme,
    pub font: &'static FontFace,
    pub size_pt: f32,
    pub line_spacing: f32,
    pub padding_pt: f32,
    pub cursor: CursorShape,
    pub blink: bool,
}

impl Default for TermStyle {
    fn default() -> Self {
        Self {
            theme: theme_named("tether"),
            font: font_named("cascadia-mono"),
            size_pt: 14.0,
            line_spacing: 1.0,
            padding_pt: 8.0,
            cursor: CursorShape::Block,
            blink: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Layout {
    pub size: GridSize,
    pub padding_px: u32,
    pub cell_w: f32,
    pub cell_h: f32,
    pub size_px: f32,
    pub width_px: u32,
    pub height_px: u32,
}

/// Points convert at the monitor's scale, so 14 pt is the same physical size at 100 % and 200 %.
/// Cell size and padding are rounded at the scaled pixel size, exactly as the rasterizer draws them.
pub fn layout(width_px: u32, height_px: u32, scale: f32, style: &TermStyle) -> Layout {
    let size_px = pt_to_px(style.size_pt, scale);
    let padding_px = pt_to_px(style.padding_pt, scale).round() as u32;
    let (cell_w, cell_h) = cell_metrics(style.font, size_px, style.line_spacing);
    let size = grid_size(width_px, height_px, padding_px, (cell_w, cell_h));
    Layout {
        size,
        padding_px,
        cell_w,
        cell_h,
        size_px,
        width_px,
        height_px,
    }
}

/// The grid is bottom-anchored: its last row ends at `height − padding`.
pub fn cell_at(l: &Layout, x_px: f32, y_px: f32) -> Cell {
    let top = l.height_px as f32 - l.padding_px as f32 - l.size.rows as f32 * l.cell_h;
    let max_col = l.size.cols.saturating_sub(1) as f32;
    let max_row = l.size.rows.saturating_sub(1) as f32;
    let col = ((x_px - l.padding_px as f32) / l.cell_w)
        .floor()
        .clamp(0.0, max_col);
    let row = ((y_px - top) / l.cell_h).floor().clamp(0.0, max_row);
    Cell {
        row: row as usize,
        col: col as usize,
    }
}

impl TermStyle {
    /// Unknown ids fall back (Tether, Cascadia Mono) inside `theme_named` / `font_named`.
    pub fn from_prefs(p: &tether_core::prefs::TerminalPrefs) -> Self {
        let p = p.clone().clamped();
        Self {
            theme: theme_named(&p.scheme),
            font: font_named(&p.font),
            size_pt: p.size_pt,
            line_spacing: p.line_spacing,
            padding_pt: p.padding_pt,
            cursor: p.cursor,
            blink: p.blink,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn points_scale_with_the_monitor() {
        let s = TermStyle::default();
        let one = layout(1600, 1000, 1.0, &s);
        let two = layout(3200, 2000, 2.0, &s);
        assert!((two.size_px - 2.0 * one.size_px).abs() < 0.01);
        assert_ne!(one.size.width_px, two.size.width_px);
    }

    #[test]
    fn pointer_maps_to_cells_from_the_bottom() {
        let l = Layout {
            size: GridSize {
                cols: 10,
                rows: 5,
                width_px: 100,
                height_px: 100,
            },
            padding_px: 8,
            cell_w: 10.0,
            cell_h: 20.0,
            size_px: 14.0,
            width_px: 200,
            height_px: 300,
        };
        // Grid bottom at 300 - 8 = 292, so its top is at 192.
        assert_eq!(cell_at(&l, 8.0, 192.0), Cell { row: 0, col: 0 });
        assert_eq!(cell_at(&l, 27.0, 291.0), Cell { row: 4, col: 1 });
        // Points outside the grid clamp onto its edge cells.
        assert_eq!(cell_at(&l, 0.0, 0.0), Cell { row: 0, col: 0 });
        assert_eq!(cell_at(&l, 999.0, 999.0), Cell { row: 4, col: 9 });
    }

    #[test]
    fn the_grid_fits_the_well_and_hit_testing_matches_the_rasterizer() {
        for (font, pt, scale) in [
            ("cascadia-mono", 17.0, 1.25),
            ("jetbrains-mono", 14.0, 1.5),
            ("cascadia-mono", 14.0, 1.0),
            ("jetbrains-mono", 11.0, 1.75),
            ("cascadia-mono", 14.0, 2.0),
        ] {
            let style = TermStyle {
                font: font_named(font),
                size_pt: pt,
                ..TermStyle::default()
            };
            let (w, h) = ((1280.0 * scale) as u32, (800.0 * scale) as u32);
            let l = layout(w, h, scale, &style);
            let (rw, rh) = cell_metrics(style.font, l.size_px, style.line_spacing);
            assert_eq!((l.cell_w, l.cell_h), (rw, rh), "{font} {pt} @{scale}");
            let pad = l.padding_px;
            assert!(l.size.cols as f32 * l.cell_w <= (w - 2 * pad) as f32);
            assert!(l.size.rows as f32 * l.cell_h <= (h - 2 * pad) as f32);
            let top = h as i32 - pad as i32 - (l.size.rows as f32 * rh) as i32;
            for col in [
                0usize,
                1,
                l.size.cols as usize / 2,
                l.size.cols as usize - 1,
            ] {
                let x0 = pad as i32 + (col as f32 * rw) as i32;
                for (x, c) in [(x0, col), (x0 + rw as i32 - 1, col)] {
                    let cell = cell_at(&l, x as f32, top as f32);
                    assert_eq!(cell.col, c, "{font} {pt} @{scale} x={x}");
                }
            }
            for row in [0usize, 1, l.size.rows as usize - 1] {
                let y0 = top + (row as f32 * rh) as i32;
                for y in [y0, y0 + rh as i32 - 1] {
                    let cell = cell_at(&l, pad as f32, y as f32);
                    assert_eq!(cell.row, row, "{font} {pt} @{scale} y={y}");
                }
            }
        }
    }
}
