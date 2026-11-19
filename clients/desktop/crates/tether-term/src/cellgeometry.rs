//! Cell-anchored drawing for the characters a terminal must draw itself: box
//! drawing, block elements, braille, Powerline separators and legacy-computing
//! blocks.
//!
//! Font glyphs for these do not fill the cell box — their ink bounds and the
//! cell advance disagree — so line art shows seams between cells and stripes
//! between rows. Everything here draws against the actual cell rectangle
//! instead. Stroke widths, the sextant and partial-block mappings and the
//! antialiasing ramp follow Alacritty's builtin font (Apache-2.0,
//! alacritty/src/renderer/text/builtin_font.rs); the per-codepoint arm
//! weights match the iOS client's TerminalBoxDrawing so both clients draw the
//! same lines. Left to the font: shades U+2591–2593 and the rest of the
//! legacy-computing block beyond the sextants and partial blocks handled here
//! (U+1FB3C–U+1FB7F, U+1FB80–U+1FB81, U+1FB8C–U+1FBFF).

use crate::raster::RgbaImage;

/// Every codepoint `draw` paints. Exactly the set `draw` handles: this gates
/// the shaping bypass too, so a character listed here must never fall back to
/// the font path.
pub(crate) fn draws(ch: char) -> bool {
    let cp = ch as u32;
    matches!(cp,
        0x2500..=0x257f        // box drawing
        | 0x2580..=0x259f      // block elements, minus the shades below
        | 0x2800..=0x28ff      // braille
        | 0xe0b0..=0xe0bf      // powerline separators
        | 0x1fb00..=0x1fb3b    // legacy-computing sextants
        | 0x1fb82..=0x1fb8b)   // legacy upper/right partial blocks
        && !(0x2591..=0x2593).contains(&cp)
}

/// Draws `ch` into the cell rectangle at (`x`, `y`) sized `w` × `h` in `rgb`.
/// False when the character is not ours and the font should draw it instead.
pub(crate) fn draw(
    img: &mut RgbaImage,
    ch: char,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    rgb: u32,
) -> bool {
    if !draws(ch) || w < 1 || h < 1 {
        return false;
    }
    let mut cell = Cell {
        img,
        x,
        y,
        w,
        h,
        rgb,
    };
    let cp = ch as u32;
    match cp {
        0x2504..=0x250b | 0x254c..=0x254f => dashed(&mut cell, cp),
        0x256d..=0x2570 => arc(&mut cell, cp),
        0x2571..=0x2573 => diagonals(&mut cell, cp),
        0x2500..=0x2503 | 0x250c..=0x256c | 0x2574..=0x257f => arms(&mut cell, cp),
        0x2580..=0x259f => blocks(&mut cell, cp),
        0x2800..=0x28ff => braille(&mut cell, cp),
        0xe0b0..=0xe0bf => powerline(&mut cell, cp),
        0x1fb00..=0x1fb3b => sextants(&mut cell, cp),
        0x1fb82..=0x1fb8b => partial_block(&mut cell, cp),
        _ => return false,
    }
    true
}

/// One cell rectangle on the image, with cell-relative drawing helpers.
struct Cell<'a> {
    img: &'a mut RgbaImage,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    rgb: u32,
}

impl Cell<'_> {
    fn wf(&self) -> f32 {
        self.w as f32
    }

    fn hf(&self) -> f32 {
        self.h as f32
    }

    fn cx(&self) -> f32 {
        self.wf() / 2.0
    }

    fn cy(&self) -> f32 {
        self.hf() / 2.0
    }

    /// Alacritty's rounding: truncate both edges, so a bar centred on a
    /// half-pixel covers the same pixels on both neighbouring cells. Endpoints
    /// are normalized, so an arm may run from either direction.
    fn rect(&mut self, x0: f32, y0: f32, x1: f32, y1: f32) {
        let clamp = |v: f32, hi: i32| v.max(0.0).min(hi as f32);
        let (x0, x1) = if x0 <= x1 { (x0, x1) } else { (x1, x0) };
        let (y0, y1) = if y0 <= y1 { (y0, y1) } else { (y1, y0) };
        let (x0, y0) = (clamp(x0, self.w), clamp(y0, self.h));
        let (x1, y1) = (clamp(x1, self.w), clamp(y1, self.h));
        if x1 <= x0 || y1 <= y0 {
            return;
        }
        let (sx, sy) = (x0 as i32, y0 as i32);
        let (ex, ey) = (x1 as i32, y1 as i32);
        self.img
            .fill_rect(self.x + sx, self.y + sy, ex - sx, ey - sy, self.rgb);
    }

    /// A horizontal bar of thickness `t` centred on `y`, from `x0` to `x1`.
    fn hbar(&mut self, y: f32, x0: f32, x1: f32, t: f32) {
        self.rect(x0, y - t / 2.0, x1, y + t / 2.0);
    }

    /// A vertical bar of thickness `t` centred on `x`, from `y0` to `y1`.
    fn vbar(&mut self, x: f32, y0: f32, y1: f32, t: f32) {
        self.rect(x - t / 2.0, y0, x + t / 2.0, y1);
    }

    /// Alpha-blends one pixel; used by the antialiased strokes.
    fn blend(&mut self, px: i32, py: i32, alpha: u8) {
        self.img
            .blend_pixel(self.x + px, self.y + py, self.rgb, alpha);
    }
}

/// Line width for a light stroke: one eighth of the cell, at least one pixel.
fn stroke(w: i32) -> f32 {
    ((w as f32 / 8.0).round() as i32).max(1) as f32
}

/// Antialiasing coverage for a stroke of thickness `t` at distance `d`.
fn ramp(d: f32, t: f32) -> f32 {
    let half = t / 2.0;
    if d <= half {
        1.0
    } else if d < half + 1.0 {
        (half + 1.0 - d).clamp(0.0, 1.0)
    } else {
        0.0
    }
}

// Box drawing: one entry per codepoint, (up, right, down, left) with weight
// 0 none, 1 light, 2 heavy, 3 double. Dashes (2504-250B, 254C-254F), arcs
// (256D-2570) and diagonals (2571-2573) are drawn apart and absent here.
// Transcribed from the iOS client's TerminalBoxDrawing so both clients draw
// the same junctions.
fn arms_of(cp: u32) -> Option<(u8, u8, u8, u8)> {
    Some(match cp {
        0x2500 => (0, 1, 0, 1),
        0x2501 => (0, 2, 0, 2),
        0x2502 => (1, 0, 1, 0),
        0x2503 => (2, 0, 2, 0),
        0x250c => (0, 1, 1, 0),
        0x250d => (0, 2, 1, 0),
        0x250e => (0, 1, 2, 0),
        0x250f => (0, 2, 2, 0),
        0x2510 => (0, 0, 1, 1),
        0x2511 => (0, 0, 1, 2),
        0x2512 => (0, 0, 2, 1),
        0x2513 => (0, 0, 2, 2),
        0x2514 => (1, 1, 0, 0),
        0x2515 => (1, 2, 0, 0),
        0x2516 => (2, 1, 0, 0),
        0x2517 => (2, 2, 0, 0),
        0x2518 => (1, 0, 0, 1),
        0x2519 => (1, 0, 0, 2),
        0x251a => (2, 0, 0, 1),
        0x251b => (2, 0, 0, 2),
        0x251c => (1, 1, 1, 0),
        0x251d => (1, 2, 1, 0),
        0x251e => (2, 1, 1, 0),
        0x251f => (1, 1, 2, 0),
        0x2520 => (2, 1, 2, 0),
        0x2521 => (2, 2, 1, 0),
        0x2522 => (1, 2, 2, 0),
        0x2523 => (2, 2, 2, 0),
        0x2524 => (1, 0, 1, 1),
        0x2525 => (1, 0, 1, 2),
        0x2526 => (2, 0, 1, 1),
        0x2527 => (1, 0, 2, 1),
        0x2528 => (2, 0, 2, 1),
        0x2529 => (2, 0, 1, 2),
        0x252a => (1, 0, 2, 2),
        0x252b => (2, 0, 2, 2),
        0x252c => (0, 1, 1, 1),
        0x252d => (0, 1, 1, 2),
        0x252e => (0, 2, 1, 1),
        0x252f => (0, 2, 1, 2),
        0x2530 => (0, 1, 2, 1),
        0x2531 => (0, 1, 2, 2),
        0x2532 => (0, 2, 2, 1),
        0x2533 => (0, 2, 2, 2),
        0x2534 => (1, 1, 0, 1),
        0x2535 => (1, 1, 0, 2),
        0x2536 => (1, 2, 0, 1),
        0x2537 => (1, 2, 0, 2),
        0x2538 => (2, 1, 0, 1),
        0x2539 => (2, 1, 0, 2),
        0x253a => (2, 2, 0, 1),
        0x253b => (2, 2, 0, 2),
        0x253c => (1, 1, 1, 1),
        0x253d => (1, 1, 1, 2),
        0x253e => (1, 2, 1, 1),
        0x253f => (1, 2, 1, 2),
        0x2540 => (2, 1, 1, 1),
        0x2541 => (1, 1, 2, 1),
        0x2542 => (2, 1, 2, 1),
        0x2543 => (2, 1, 1, 2),
        0x2544 => (2, 2, 1, 1),
        0x2545 => (1, 1, 2, 2),
        0x2546 => (1, 2, 2, 1),
        0x2547 => (2, 2, 1, 2),
        0x2548 => (1, 2, 2, 2),
        0x2549 => (2, 1, 2, 2),
        0x254a => (2, 2, 2, 1),
        0x254b => (2, 2, 2, 2),
        0x2550 => (0, 3, 0, 3),
        0x2551 => (3, 0, 3, 0),
        0x2552 => (0, 3, 1, 0),
        0x2553 => (0, 1, 3, 0),
        0x2554 => (0, 3, 3, 0),
        0x2555 => (0, 0, 1, 3),
        0x2556 => (0, 0, 3, 1),
        0x2557 => (0, 0, 3, 3),
        0x2558 => (1, 3, 0, 0),
        0x2559 => (3, 1, 0, 0),
        0x255a => (3, 3, 0, 0),
        0x255b => (1, 0, 0, 3),
        0x255c => (3, 0, 0, 1),
        0x255d => (3, 0, 0, 3),
        0x255e => (1, 3, 1, 0),
        0x255f => (3, 1, 3, 0),
        0x2560 => (3, 3, 3, 0),
        0x2561 => (1, 0, 1, 3),
        0x2562 => (3, 0, 3, 1),
        0x2563 => (3, 0, 3, 3),
        0x2564 => (0, 3, 1, 3),
        0x2565 => (0, 1, 3, 1),
        0x2566 => (0, 3, 3, 3),
        0x2567 => (1, 3, 0, 3),
        0x2568 => (3, 1, 0, 1),
        0x2569 => (3, 3, 0, 3),
        0x256a => (1, 3, 1, 3),
        0x256b => (3, 1, 3, 1),
        0x256c => (3, 3, 3, 3),
        0x2574 => (0, 0, 0, 1),
        0x2575 => (1, 0, 0, 0),
        0x2576 => (0, 1, 0, 0),
        0x2577 => (0, 0, 1, 0),
        0x2578 => (0, 0, 0, 2),
        0x2579 => (2, 0, 0, 0),
        0x257a => (0, 2, 0, 0),
        0x257b => (0, 0, 2, 0),
        0x257c => (0, 2, 0, 1),
        0x257d => (1, 0, 2, 0),
        0x257e => (0, 1, 0, 2),
        0x257f => (2, 0, 1, 0),
        _ => return None,
    })
}

/// Where a single or heavy arm starts. Against a double line across it, a
/// tee's stem meets the near line (╤), a corner's reaches the far one (╒), and
/// a crossing runs through both (╪).
fn single_start(
    center: f32,
    sign: f32,
    across: (u8, u8),
    opposite: u8,
    extent: f32,
    gap: f32,
    light: f32,
) -> f32 {
    if across.0 != 3 && across.1 != 3 {
        return center - sign * extent;
    }
    let tee = across.0 != 0 && across.1 != 0 && opposite == 0;
    if tee {
        center + sign * (gap - light / 2.0)
    } else {
        center - sign * (gap + light / 2.0)
    }
}

fn arms(cell: &mut Cell, cp: u32) {
    let Some((up, right, down, left)) = arms_of(cp) else {
        return;
    };
    let light = stroke(cell.w);
    let weight = |w: u8| match w {
        2 => light * 2.0,
        _ => light,
    };
    let (cx, cy) = (cell.cx(), cell.cy());
    let gap = light;
    let half = |w: u8| match w {
        0 => 0.0,
        3 => gap + light / 2.0,
        w => weight(w) / 2.0,
    };
    // How far a horizontal arm reaches from the centre, and likewise vertical.
    let vertical = half(up).max(half(down));
    let horizontal = half(left).max(half(right));

    for toward_right in [true, false] {
        let w = if toward_right { right } else { left };
        if w == 0 {
            continue;
        }
        let end = if toward_right { cell.wf() } else { 0.0 };
        let sign = if toward_right { 1.0 } else { -1.0 };
        if w == 3 {
            // Each of the two lines stops at the stem on its own side, so
            // corners and tees close.
            for (offset, perpendicular, other) in [(-gap, up, down), (gap, down, up)] {
                let start = if perpendicular != 0 {
                    cx + sign
                        * if perpendicular == 3 {
                            gap - light / 2.0
                        } else {
                            half(perpendicular)
                        }
                } else if other != 0 {
                    cx - sign
                        * if other == 3 {
                            gap + light / 2.0
                        } else {
                            half(other)
                        }
                } else {
                    cx
                };
                cell.hbar(cy + offset, start, end, light);
            }
        } else {
            let across = (up, down);
            let opposite = if toward_right { left } else { right };
            let start = single_start(cx, sign, across, opposite, vertical, gap, light);
            cell.hbar(cy, start, end, weight(w));
        }
    }
    for toward_down in [true, false] {
        let w = if toward_down { down } else { up };
        if w == 0 {
            continue;
        }
        let end = if toward_down { cell.hf() } else { 0.0 };
        let sign = if toward_down { 1.0 } else { -1.0 };
        if w == 3 {
            for (offset, perpendicular, other) in [(-gap, left, right), (gap, right, left)] {
                let start = if perpendicular != 0 {
                    cy + sign
                        * if perpendicular == 3 {
                            gap - light / 2.0
                        } else {
                            half(perpendicular)
                        }
                } else if other != 0 {
                    cy - sign
                        * if other == 3 {
                            gap + light / 2.0
                        } else {
                            half(other)
                        }
                } else {
                    cy
                };
                cell.vbar(cx + offset, start, end, light);
            }
        } else {
            let across = (left, right);
            let opposite = if toward_down { up } else { down };
            let start = single_start(cy, sign, across, opposite, horizontal, gap, light);
            cell.vbar(cx, start, end, weight(w));
        }
    }
}

fn dashed(cell: &mut Cell, cp: u32) {
    let index = if cp >= 0x254c {
        cp - 0x254c
    } else {
        cp - 0x2504
    };
    let horizontal = index % 4 < 2;
    let heavy = index % 2 == 1;
    let segments = if cp >= 0x254c {
        2
    } else if index < 4 {
        3
    } else {
        4
    };
    let light = stroke(cell.w);
    let thickness = if heavy { light * 2.0 } else { light };
    let length = if horizontal { cell.wf() } else { cell.hf() };
    let step = length / segments as f32;
    let dash = step * 0.6;
    for segment in 0..segments {
        let start = segment as f32 * step + (step - dash) / 2.0;
        if horizontal {
            cell.hbar(cell.cy(), start, start + dash, thickness);
        } else {
            cell.vbar(cell.cx(), start, start + dash, thickness);
        }
    }
}

fn arc(cell: &mut Cell, cp: u32) {
    // ╭ down+right, ╮ down+left, ╯ up+left, ╰ up+right: the arc is inscribed
    // in the corner the arms point at, so it meets each arm's line tangentially.
    let (dx, dy) = match cp {
        0x256d => (1.0, 1.0),
        0x256e => (-1.0, 1.0),
        0x256f => (-1.0, -1.0),
        _ => (1.0, -1.0), // 0x2570
    };
    let light = stroke(cell.w);
    let (wf, hf) = (cell.wf(), cell.hf());
    let (cx, cy) = (cell.cx(), cell.cy());
    let r = wf.min(hf) / 2.0;
    let (acx, acy) = (cx + dx * r, cy + dy * r);
    // Arm stubs from the cell edge to the arc's tangent points.
    if dy > 0.0 {
        cell.vbar(cx, cy + r, hf, light);
    } else {
        cell.vbar(cx, 0.0, cy - r, light);
    }
    if dx > 0.0 {
        cell.hbar(cy, cx + r, wf, light);
    } else {
        cell.hbar(cy, 0.0, cx - r, light);
    }
    // The quarter arc itself, antialiased by distance from the circle and
    // restricted to the quadrant between the two tangent points.
    let (lo, hi) = (r - light / 2.0, r + light / 2.0);
    for iy in 0..cell.h {
        for ix in 0..cell.w {
            let (px, py) = (ix as f32 + 0.5, iy as f32 + 0.5);
            if (acx - px) * dx < 0.0 || (acy - py) * dy < 0.0 {
                continue;
            }
            let d = (px - acx).hypot(py - acy);
            let a = if d < lo - 1.0 {
                0.0
            } else if d < lo {
                d - (lo - 1.0)
            } else if d < hi {
                1.0
            } else if d < hi + 1.0 {
                hi + 1.0 - d
            } else {
                0.0
            };
            if a > 0.0 {
                cell.blend(ix, iy, (a * 255.0) as u8);
            }
        }
    }
}

fn diagonals(cell: &mut Cell, cp: u32) {
    // ╱, ╲, ╳ as full corner-to-corner strokes.
    let light = stroke(cell.w);
    if cp != 0x2572 {
        aa_line(cell, 0.0, cell.hf(), cell.wf(), 0.0, light);
    }
    if cp != 0x2571 {
        aa_line(cell, 0.0, 0.0, cell.wf(), cell.hf(), light);
    }
}

/// A line from (`x0`, `y0`) to (`x1`, `y1`) stroked with `t`, antialiased by
/// distance. Pixel centres are sampled, so a one-pixel stroke stays one pixel.
fn aa_line(cell: &mut Cell, x0: f32, y0: f32, x1: f32, y1: f32, t: f32) {
    let (dx, dy) = (x1 - x0, y1 - y0);
    let len2 = dx * dx + dy * dy;
    if len2 <= f32::EPSILON {
        return;
    }
    for iy in 0..cell.h {
        for ix in 0..cell.w {
            let (px, py) = (ix as f32 + 0.5, iy as f32 + 0.5);
            let u = (((px - x0) * dx + (py - y0) * dy) / len2).clamp(0.0, 1.0);
            let d = (px - x0 - u * dx).hypot(py - y0 - u * dy);
            let a = ramp(d, t);
            if a > 0.0 {
                cell.blend(ix, iy, (a * 255.0) as u8);
            }
        }
    }
}

/// Block elements U+2580–259F, drawn in integer cell fractions exactly as
/// they always were, so neighbouring cells tile without seams.
fn blocks(cell: &mut Cell, cp: u32) {
    let (w, h) = (cell.w, cell.h);
    let rgb = cell.rgb;
    let rect = |c: &mut Cell, left: i32, top: i32, right: i32, bottom: i32| {
        c.img
            .fill_rect(c.x + left, c.y + top, right - left, bottom - top, rgb);
    };
    match cp {
        0x2580 => rect(cell, 0, 0, w, h / 2),
        0x2581..=0x2588 => rect(cell, 0, h * (0x2588 - cp) as i32 / 8, w, h),
        0x2589..=0x258f => rect(cell, 0, 0, w * (0x2590 - cp) as i32 / 8, h),
        0x2590 => rect(cell, w / 2, 0, w, h),
        0x2594 => rect(cell, 0, 0, w, (h / 8).max(1)),
        0x2595 => rect(cell, w * 7 / 8, 0, w, h),
        _ => {
            // Quadrants U+2596–259F: upper-left, upper-right, lower-left,
            // lower-right.
            let bits = match cp {
                0x2596 => 0b0010,
                0x2597 => 0b0001,
                0x2598 => 0b1000,
                0x2599 => 0b1011,
                0x259a => 0b1001,
                0x259b => 0b1110,
                0x259c => 0b1101,
                0x259d => 0b0100,
                0x259e => 0b0110,
                _ => 0b0111, // 0x259f
            };
            if bits & 0b1000 != 0 {
                rect(cell, 0, 0, w / 2, h / 2);
            }
            if bits & 0b0100 != 0 {
                rect(cell, w / 2, 0, w, h / 2);
            }
            if bits & 0b0010 != 0 {
                rect(cell, 0, h / 2, w / 2, h);
            }
            if bits & 0b0001 != 0 {
                rect(cell, w / 2, h / 2, w, h);
            }
        }
    }
}

/// Braille U+2800–28FF: a 2×4 grid of dots. Dots 1–3 run down the left
/// column, dots 4–6 down the right, dot 7 sits bottom-left and dot 8
/// bottom-right; codepoint bit n−1 is dot n.
fn braille(cell: &mut Cell, cp: u32) {
    let bits = (cp - 0x2800) as u8;
    let (wf, hf) = (cell.wf(), cell.hf());
    let (rx, ry) = ((wf / 2.0 * 0.35).max(1.0), (hf / 4.0 * 0.35).max(1.0));
    for row in 0..4u32 {
        for col in 0..2u32 {
            let bit = match (col, row) {
                (0, 3) => 6,       // dot 7
                (1, 3) => 7,       // dot 8
                (1, _) => row + 3, // dots 4–6
                _ => row,          // dots 1–3
            };
            if bits & (1 << bit) == 0 {
                continue;
            }
            let x = wf * (col as f32 * 0.5 + 0.25);
            let y = hf * (row as f32 * 0.25 + 0.125);
            let y0 = (y - ry).floor().max(0.0) as i32;
            let y1 = (y + ry).ceil().min(hf) as i32;
            for iy in y0..y1 {
                let dy = iy as f32 + 0.5 - y;
                let scale = 1.0 - (dy / ry).powi(2);
                if scale <= 0.0 {
                    continue;
                }
                let half = (rx * scale.sqrt()).max(0.5);
                cell.rect(x - half, iy as f32, x + half, iy as f32 + 1.0);
            }
        }
    }
}

/// Which of the six sub-cells each sextant fills, transcribed from
/// Alacritty's builtin font: 1 top-left, 2 top-right, 4 middle-left,
/// 8 middle-right, 16 bottom-left, 32 bottom-right.
fn sextant_bits(cp: u32) -> u8 {
    let top_left = matches!(
        cp,
        0x1fb00
            | 0x1fb02
            | 0x1fb04
            | 0x1fb06
            | 0x1fb08
            | 0x1fb0a
            | 0x1fb0c
            | 0x1fb0e
            | 0x1fb10
            | 0x1fb12
            | 0x1fb15
            | 0x1fb17
            | 0x1fb19
            | 0x1fb1b
            | 0x1fb1d
            | 0x1fb1f
            | 0x1fb21
            | 0x1fb23
            | 0x1fb25
            | 0x1fb27
            | 0x1fb28
            | 0x1fb2a
            | 0x1fb2c
            | 0x1fb2e
            | 0x1fb30
            | 0x1fb32
            | 0x1fb34
            | 0x1fb36
            | 0x1fb38
            | 0x1fb3a
    );
    let top_right = matches!(
        cp,
        0x1fb01
            | 0x1fb02
            | 0x1fb05
            | 0x1fb06
            | 0x1fb09
            | 0x1fb0a
            | 0x1fb0d
            | 0x1fb0e
            | 0x1fb11
            | 0x1fb12
            | 0x1fb14
            | 0x1fb15
            | 0x1fb18
            | 0x1fb19
            | 0x1fb1c
            | 0x1fb1d
            | 0x1fb20
            | 0x1fb21
            | 0x1fb24
            | 0x1fb25
            | 0x1fb28
            | 0x1fb2b
            | 0x1fb2c
            | 0x1fb2f
            | 0x1fb30
            | 0x1fb33
            | 0x1fb34
            | 0x1fb37
            | 0x1fb38
            | 0x1fb3b
    );
    let mid_left = matches!(
        cp,
        0x1fb03
            | 0x1fb04
            | 0x1fb05
            | 0x1fb06
            | 0x1fb0b
            | 0x1fb0c
            | 0x1fb0d
            | 0x1fb0e
            | 0x1fb13
            | 0x1fb14
            | 0x1fb15
            | 0x1fb1a
            | 0x1fb1b
            | 0x1fb1c
            | 0x1fb1d
            | 0x1fb22
            | 0x1fb23
            | 0x1fb24
            | 0x1fb25
            | 0x1fb29
            | 0x1fb2a
            | 0x1fb2b
            | 0x1fb2c
            | 0x1fb31
            | 0x1fb32
            | 0x1fb33
            | 0x1fb34
            | 0x1fb39
            | 0x1fb3a
            | 0x1fb3b
    );
    let mid_right = matches!(
        cp,
        0x1fb07
            | 0x1fb08
            | 0x1fb09
            | 0x1fb0a
            | 0x1fb0b
            | 0x1fb0c
            | 0x1fb0d
            | 0x1fb0e
            | 0x1fb16
            | 0x1fb17
            | 0x1fb18
            | 0x1fb19
            | 0x1fb1a
            | 0x1fb1b
            | 0x1fb1c
            | 0x1fb1d
            | 0x1fb26
            | 0x1fb27
            | 0x1fb28
            | 0x1fb29
            | 0x1fb2a
            | 0x1fb2b
            | 0x1fb2c
            | 0x1fb35
            | 0x1fb36
            | 0x1fb37
            | 0x1fb38
            | 0x1fb39
            | 0x1fb3a
            | 0x1fb3b
    );
    let bottom_left = matches!(
        cp,
        0x1fb0f
            | 0x1fb10
            | 0x1fb11
            | 0x1fb12
            | 0x1fb13
            | 0x1fb14
            | 0x1fb15
            | 0x1fb16
            | 0x1fb17
            | 0x1fb18
            | 0x1fb19
            | 0x1fb1a
            | 0x1fb1b
            | 0x1fb1c
            | 0x1fb1d
            | 0x1fb2d
            | 0x1fb2e
            | 0x1fb2f
            | 0x1fb30
            | 0x1fb31
            | 0x1fb32
            | 0x1fb33
            | 0x1fb34
            | 0x1fb35
            | 0x1fb36
            | 0x1fb37
            | 0x1fb38
            | 0x1fb39
            | 0x1fb3a
            | 0x1fb3b
    );
    let bottom_right = matches!(cp, 0x1fb1e..=0x1fb3b);
    (top_left as u8)
        | (top_right as u8) << 1
        | (mid_left as u8) << 2
        | (mid_right as u8) << 3
        | (bottom_left as u8) << 4
        | (bottom_right as u8) << 5
}

/// Sextants U+1FB00–1FB3B: the cell in two columns and three rows.
fn sextants(cell: &mut Cell, cp: u32) {
    let bits = sextant_bits(cp);
    if bits == 0 {
        return;
    }
    let (wf, hf) = (cell.wf(), cell.hf());
    let xc = (wf / 2.0).round().max(1.0);
    let third = (hf / 3.0).round().max(1.0);
    if bits & 1 != 0 {
        cell.rect(0.0, 0.0, xc, third);
    }
    if bits & 2 != 0 {
        cell.rect(xc, 0.0, wf, third);
    }
    if bits & 4 != 0 {
        cell.rect(0.0, third, xc, 2.0 * third);
    }
    if bits & 8 != 0 {
        cell.rect(xc, third, wf, 2.0 * third);
    }
    if bits & 16 != 0 {
        cell.rect(0.0, 2.0 * third, xc, hf);
    }
    if bits & 32 != 0 {
        cell.rect(xc, 2.0 * third, wf, hf);
    }
}

/// U+1FB82–1FB8B: the top n eighths, then the right n eighths.
fn partial_block(cell: &mut Cell, cp: u32) {
    let (wf, hf) = (cell.wf(), cell.hf());
    if cp <= 0x1fb86 {
        let n = [2.0, 3.0, 5.0, 6.0, 7.0][(cp - 0x1fb82) as usize];
        let height = (hf * n / 8.0).round().max(1.0);
        cell.rect(0.0, 0.0, wf, height);
    } else {
        let n = [2.0, 3.0, 5.0, 6.0, 7.0][(cp - 0x1fb87) as usize];
        let width = (wf * n / 8.0).round().max(1.0);
        cell.rect(wf - width, 0.0, wf, hf);
    }
}

/// Powerline separators U+E0B0–E0BF, drawn against the cell so segments in
/// adjacent cells meet at any line spacing.
fn powerline(cell: &mut Cell, cp: u32) {
    let light = stroke(cell.w);
    let (wf, hf) = (cell.wf(), cell.hf());
    let cy = cell.cy();
    match cp {
        // Right- and left-pointing triangles and arrowheads.
        0xe0b0..=0xe0b3 => {
            let right = cp == 0xe0b0 || cp == 0xe0b1;
            let (base, tip) = if right { (0.0, wf) } else { (wf, 0.0) };
            if cp.is_multiple_of(2) {
                // Solid triangle: each row reaches as far as its widest point,
                // so the apex row touches the far edge.
                for iy in 0..cell.h {
                    let y_far = (cy).clamp(iy as f32, iy as f32 + 1.0);
                    let t = 1.0 - (y_far - cy).abs() * 2.0 / hf;
                    let x = base + (tip - base) * t;
                    if right {
                        cell.rect(base, iy as f32, x, iy as f32 + 1.0);
                    } else {
                        cell.rect(x, iy as f32, base, iy as f32 + 1.0);
                    }
                }
            } else {
                // Arrowhead: the same triangle as two strokes, without the base.
                aa_line(cell, base, 0.0, tip, cy, light);
                aa_line(cell, base, hf, tip, cy, light);
            }
        }
        // Half-ellipse caps bulging out of the segment, solid or outlined.
        0xe0b4..=0xe0b7 => {
            let right = cp == 0xe0b4 || cp == 0xe0b5;
            // The solid branch only squares `a`, so the left cap takes −w to
            // keep its outline inside the cell: base − w·cos spans [0, w].
            let (base, a) = if right { (0.0, wf) } else { (wf, -wf) };
            let b = hf / 2.0;
            if cp.is_multiple_of(2) {
                for ix in 0..cell.w {
                    let u = (ix as f32 + 0.5 - base) / a;
                    let half = b * (1.0 - u * u).max(0.0).sqrt();
                    cell.rect(ix as f32, cy - half, ix as f32 + 1.0, cy + half);
                }
            } else {
                let steps = cell.w.max(cell.h) * 2;
                for i in 0..=steps {
                    let t = -std::f32::consts::FRAC_PI_2
                        + std::f32::consts::PI * i as f32 / steps as f32;
                    // Both endpoints stay a half stroke inside the cell, so the
                    // outline's ends draw the same amount top and bottom.
                    let py = (cy + b * t.sin()).clamp(light / 2.0, hf - light / 2.0);
                    let px = base + a * t.cos();
                    cell.rect(
                        px - light / 2.0,
                        py - light / 2.0,
                        px + light / 2.0,
                        py + light / 2.0,
                    );
                }
            }
        }
        // Corner triangles: ◣, ◢, ◤, ◥.
        0xe0b8 | 0xe0ba | 0xe0bc | 0xe0be => {
            for iy in 0..cell.h {
                let y = iy as f32 + 0.5;
                let (x0, x1) = match cp {
                    // Below the main diagonal.
                    0xe0b8 => (0.0, (y * wf / hf - 0.5).max(0.0)),
                    // Below the anti-diagonal.
                    0xe0ba => ((wf - y * wf / hf + 0.5).min(wf), wf),
                    // Above the anti-diagonal.
                    0xe0bc => (0.0, (wf - y * wf / hf + 0.5).max(0.0)),
                    // Above the main diagonal.
                    _ => ((y * wf / hf - 0.5).min(wf), wf),
                };
                cell.rect(x0, iy as f32, x1, iy as f32 + 1.0);
            }
        }
        // Slash separators: ╱- and ╲-shaped strokes spanning the cell.
        0xe0b9 | 0xe0bf => aa_line(cell, 0.0, 0.0, wf, hf, light),
        0xe0bb | 0xe0bd => aa_line(cell, 0.0, hf, wf, 0.0, light),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::metrics::{cell_metrics, pt_to_px};
    use crate::raster::{Rasterizer, RenderStyle};
    use crate::snapshot::Snapshot;
    use crate::terminal::TabTerminal;
    use crate::terminal::tests::size;
    use tether_core::fonts::font_named;
    use tether_core::prefs::CursorShape;
    use tether_core::theme::{TerminalTheme, theme_named};

    fn style<'a>(theme: &'a TerminalTheme) -> RenderStyle<'a> {
        RenderStyle {
            theme,
            font: font_named("cascadia-mono"),
            size_px: pt_to_px(14.0, 1.0),
            line_spacing: 1.0,
            padding_px: 0,
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

    struct Grid {
        img: crate::raster::RgbaImage,
        cw: f32,
        ch: f32,
        theme: &'static TerminalTheme,
    }

    /// Renders `text` at the top of a 20×4 grid whose height is exactly four
    /// rows, so cell (row, col) starts at pixel ((col·cw) as i32, (row·ch) as i32).
    fn grid(text: &str) -> Grid {
        let theme: &'static TerminalTheme = theme_named("tether");
        let st = style(theme);
        let (cw, ch) = cell_metrics(st.font, st.size_px, 1.0);
        let img = Rasterizer::new().render(
            &snap(text.as_bytes()),
            &st,
            (20.0 * cw) as u32,
            (4.0 * ch) as u32,
        );
        Grid { img, cw, ch, theme }
    }

    impl Grid {
        fn x(&self, col: usize) -> u32 {
            (col as f32 * self.cw) as u32
        }

        fn y(&self, row: usize) -> u32 {
            (row as f32 * self.ch) as u32
        }

        fn cw(&self) -> u32 {
            self.cw as u32
        }

        fn ch(&self) -> u32 {
            self.ch as u32
        }

        fn px(&self, x: u32, y: u32) -> [u8; 4] {
            self.img
                .pixel(x.min(self.img.width - 1), y.min(self.img.height - 1))
        }

        fn fg(&self, x: u32, y: u32) -> bool {
            self.px(x, y) == rgba(self.theme.foreground)
        }

        fn has_ink(&self, x0: u32, y0: u32, x1: u32, y1: u32) -> bool {
            (y0..y1).any(|y| (x0..x1).any(|x| self.px(x, y) != rgba(self.theme.background)))
        }
    }

    #[test]
    fn the_handled_set_is_exactly_the_ranges_we_draw() {
        let handled = || {
            (0x2500..=0x257f)
                .chain(0x2580..=0x259f)
                .chain(0x2800..=0x28ff)
                .chain(0xe0b0..=0xe0bf)
                .chain(0x1fb00..=0x1fb3b)
                .chain(0x1fb82..=0x1fb8b)
                .filter_map(char::from_u32)
                .filter(|c| draws(*c))
        };
        assert_eq!(handled().count(), 499);
        // The font still draws shades, other symbols and the diagonal sextants.
        for ch in ['a', '\u{2591}', '\u{25a0}', '\u{1fb3c}', '\u{1fb90}'] {
            assert!(!draws(ch), "{ch} should stay with the font");
        }
    }

    #[test]
    fn every_handled_codepoint_draws_ink() {
        let chars: Vec<char> = (0x2500..=0x257f)
            .chain(0x2580..=0x259f)
            .chain(0x2800..=0x28ff)
            .chain(0xe0b0..=0xe0bf)
            .chain(0x1fb00..=0x1fb3b)
            .chain(0x1fb82..=0x1fb8b)
            .filter_map(char::from_u32)
            .collect();
        let mut r = Rasterizer::new();
        let theme: &'static TerminalTheme = theme_named("tether");
        let st = style(theme);
        let (cw, ch) = cell_metrics(st.font, st.size_px, 1.0);
        for batch in chars.chunks(80) {
            let text: String = batch.iter().collect();
            let img = r.render(
                &snap(text.as_bytes()),
                &st,
                (20.0 * cw) as u32,
                (4.0 * ch) as u32,
            );
            for (index, chp) in batch.iter().enumerate() {
                // U+2800 is braille blank: no dots is the glyph.
                if *chp as u32 == 0x2800 {
                    continue;
                }
                let (row, col) = (index / 20, index % 20);
                let (x, y) = ((col as f32 * cw) as u32, (row as f32 * ch) as u32);
                let ink = (y..y + ch as u32).any(|yy| {
                    (x..x + cw as u32).any(|xx| img.pixel(xx, yy) != rgba(theme.background))
                });
                assert!(ink, "U+{:04X} draws nothing", *chp as u32);
            }
        }
    }

    #[test]
    fn horizontal_lines_join_across_cells() {
        for text in ["──", "━━", "══"] {
            let g = grid(text);
            // Find the line's row in the first cell, then demand it unbroken
            // across both cells.
            let rows: Vec<u32> = (0..g.ch())
                .filter(|y| (0..g.cw()).any(|x| g.fg(x, *y)))
                .collect();
            assert!(!rows.is_empty(), "{text} draws nothing");
            assert!(rows.len() <= 3, "{text} draws too much");
            for y in rows {
                for x in 0..(2 * g.cw()) {
                    assert!(g.fg(x, y), "{text}: seam at x={x}");
                }
            }
        }
    }

    #[test]
    fn vertical_lines_join_across_rows() {
        for text in ["│\r\n│", "┃\r\n┃", "║\r\n║"] {
            let g = grid(text);
            let cols: Vec<u32> = (0..g.cw())
                .filter(|x| (0..g.ch()).any(|y| g.fg(*x, y)))
                .collect();
            assert!(!cols.is_empty(), "{text} draws nothing");
            for x in cols {
                for y in 0..(2 * g.ch()) {
                    assert!(g.fg(x, y), "{text}: seam at y={y}");
                }
            }
        }
    }

    #[test]
    fn box_corners_join_the_lines_next_to_them() {
        let g = grid("┌─┐\r\n│ │\r\n└─┘");
        // The top line runs from ┌'s centre to ┐'s centre without a break;
        // each corner's own half-cell outside that span is correctly empty.
        let rows: Vec<u32> = (0..g.ch()).filter(|y| g.fg(g.x(1) + 1, *y)).collect();
        assert_eq!(rows.len(), 1, "the ─ row");
        let y = rows[0];
        let cx = g.cw() / 2;
        for x in g.x(0) + cx..g.x(2) + cx + 1 {
            assert!(g.fg(x, y), "top row breaks at x={x}");
        }
        // The sides: each corner's vertical arm lands in the same column as the
        // │ line below or above it, including at the row boundary.
        let mid = (g.ch() as f32 / 2.0) as u32;
        let col_x: u32 = (0..g.cw()).find(|x| g.fg(*x, mid + g.ch())).unwrap();
        for row in 0..2 {
            assert!(g.fg(col_x, g.y(row) + g.ch() - 1), "row {row} bottom edge");
            if row > 0 {
                assert!(g.fg(col_x, g.y(row)), "row {row} top edge");
            }
        }
        // The line ends at └: its up arm inks the top edge, and the bottom
        // edge below it stays empty.
        assert!(g.fg(col_x, g.y(2)), "row 2 top edge");
    }

    #[test]
    fn double_lines_leave_a_gap_between_their_two_lines() {
        let g = grid("═");
        let mid_col = g.x(0) + g.cw() / 2;
        let rows: Vec<u32> = (0..g.ch()).filter(|y| g.fg(mid_col, *y)).collect();
        assert_eq!(rows.len(), 2, "two lines, found {rows:?}");
        assert!(rows[1] - rows[0] >= 2, "the lines are separated");
    }

    #[test]
    fn heavy_lines_are_wider_than_light_ones() {
        let g = grid("─━");
        let count = |col: usize| {
            (0..g.ch())
                .filter(|y| g.fg(g.x(col) + g.cw() / 2, *y))
                .count()
        };
        assert_eq!(count(0), 1, "light is one row");
        assert!(count(1) >= 2, "heavy spans at least two rows");
    }

    #[test]
    fn arcs_curve_the_corner_and_leave_it_opposite_empty() {
        // ╭: arms go down and right; the upper-left of the cell stays empty.
        let g = grid("╭");
        let (x0, y0) = (g.x(0), g.y(0));
        let (cw, ch) = (g.cw(), g.ch());
        assert!(g.has_ink(x0, y0 + ch * 2 / 3, x0 + cw, y0 + ch), "down arm");
        assert!(
            g.has_ink(x0 + cw - 2, y0 + ch / 3, x0 + cw, y0 + ch * 2 / 3),
            "arc reaches the right edge"
        );
        assert!(
            !g.has_ink(x0, y0, x0 + cw * 2 / 3, y0 + ch / 3),
            "the corner opposite the arms stays empty"
        );
    }

    #[test]
    fn diagonals_reach_both_corners_of_the_cell() {
        let g = grid("╱");
        let (x0, y0, cw, ch) = (g.x(0), g.y(0), g.cw(), g.ch());
        assert!(g.has_ink(x0, y0 + ch - 2, x0 + 2, y0 + ch), "bottom left");
        assert!(g.has_ink(x0 + cw - 2, y0, x0 + cw, y0 + 2), "top right");
        assert!(!g.has_ink(x0, y0, x0 + 2, y0 + 2), "top left is empty");
        assert!(
            !g.has_ink(x0 + cw - 2, y0 + ch - 2, x0 + cw, y0 + ch),
            "bottom right is empty"
        );
    }

    #[test]
    fn braille_dots_fill_only_their_own_sub_cell() {
        // ⠁ dot 1, ⣿ all dots, ⠈ dot 4 (top of the right column), ⡀ dot 7
        // (bottom of the left column).
        let g = grid("⠁⣿⠈⡀");
        let probe = |col: u32, rrow: u32, ccol: u32| {
            let (x, y) = (g.x(col as usize), g.y(0));
            let (cw, ch) = (g.cw(), g.ch());
            let half = cw / 2;
            let quarter = ch / 4;
            // The bands partition the cell exactly, so a probe never reads into
            // the next cell over.
            let (rx0, rx1) = (x + ccol * half, (x + (ccol + 1) * half).min(x + cw));
            let (ry0, ry1) = (y + rrow * quarter, (y + (rrow + 1) * quarter).min(y + ch));
            g.has_ink(rx0, ry0, rx1, ry1)
        };
        for row in 0..4u32 {
            for col in 0..2u32 {
                assert!(probe(1, row, col), "⣿ dot {row}{col}");
                assert_eq!(
                    probe(0, row, col),
                    row == 0 && col == 0,
                    "⠁ must only light dot 1 (row {row}, col {col})"
                );
                assert_eq!(
                    probe(2, row, col),
                    row == 0 && col == 1,
                    "⠈ must only light dot 4 (row {row}, col {col})"
                );
                assert_eq!(
                    probe(3, row, col),
                    row == 3 && col == 0,
                    "⡀ must only light dot 7 (row {row}, col {col})"
                );
            }
        }
    }

    #[test]
    fn sextants_fill_exactly_their_sub_cells() {
        // 1FB00 is the top-left sextant only; 1FB05 is top-right + middle-left;
        // 1FB3B is everything except the top-left.
        let g = grid("🬀🬅🬻");
        let probe = |col: u32, rrow: u32, ccol: u32| {
            let (x, y) = (g.x(col as usize), g.y(0));
            let (cw, ch) = (g.cw(), g.ch());
            let split = (cw as f32 / 2.0).round().max(1.0) as u32;
            let third = (ch as f32 / 3.0).round().max(1.0) as u32;
            // The bands partition the cell exactly, so a probe never reads into
            // the next cell over.
            let (rx0, rx1) = (x + ccol * split, (x + (ccol + 1) * split).min(x + cw));
            let (ry0, ry1) = (y + rrow * third, (y + (rrow + 1) * third).min(y + ch));
            g.has_ink(rx0, ry0, rx1, ry1)
        };
        for rrow in 0..3u32 {
            for ccol in 0..2u32 {
                assert_eq!(probe(0, rrow, ccol), rrow == 0 && ccol == 0, "1FB00");
                assert_eq!(
                    probe(1, rrow, ccol),
                    (rrow == 0 && ccol == 1) || (rrow == 1 && ccol == 0),
                    "1FB05"
                );
                assert_eq!(probe(2, rrow, ccol), !(rrow == 0 && ccol == 0), "1FB3B");
            }
        }
    }

    #[test]
    fn legacy_partial_blocks_fill_from_the_top_or_the_right() {
        let g = grid("\u{1fb82}\u{1fb8b}");
        let (cw, ch) = (g.cw(), g.ch());
        // Top two eighths: ink in the top quarter, none in the lower half.
        assert!(g.has_ink(g.x(0), g.y(0), g.x(0) + cw, g.y(0) + ch / 4));
        assert!(!g.has_ink(g.x(0), g.y(0) + ch / 2, g.x(0) + cw, g.y(0) + ch));
        // Right seven eighths: the right column is full, the left is empty.
        assert!(g.has_ink(g.x(1) + cw - 1, g.y(0), g.x(1) + cw, g.y(0) + ch));
        assert!(!g.has_ink(g.x(1), g.y(0), g.x(1) + 1, g.y(0) + ch));
    }

    #[test]
    fn powerline_triangles_point_across_the_cell() {
        let g = grid("\u{e0b0}\u{e0b2}");
        let (cw, ch) = (g.cw(), g.ch());
        let mid = ch / 2;
        // E0B0 points right: full at the base, empty at the far corners.
        assert!(g.fg(g.x(0), mid), "base column at mid height");
        assert!(g.fg(g.x(0) + cw - 1, mid), "tip reaches the right edge");
        assert!(!g.fg(g.x(0) + cw - 1, 1), "top right corner empty");
        assert!(!g.fg(g.x(0) + cw - 1, ch - 2), "bottom right corner empty");
        // E0B2 mirrors it.
        assert!(g.fg(g.x(1) + cw - 1, mid), "base column at mid height");
        assert!(g.fg(g.x(1), mid), "tip reaches the left edge");
        assert!(!g.fg(g.x(1), 1), "top left corner empty");
        assert!(!g.fg(g.x(1), ch - 2), "bottom left corner empty");
    }

    #[test]
    fn powerline_corner_triangles_fill_their_own_corner() {
        // ◣, ◢, ◤, ◥: ink in the named corner only.
        let g = grid("\u{e0b8}\u{e0ba}\u{e0bc}\u{e0be}");
        let (cw, ch) = (g.cw(), g.ch());
        let corner = |col: usize, x0: u32, y0: u32| {
            let (x, y) = (g.x(col), g.y(0));
            g.has_ink(x + x0, y + y0, x + x0 + 2, y + y0 + 2)
        };
        assert!(corner(0, 0, ch - 2), "◣ bottom left");
        assert!(!corner(0, cw - 2, 0), "◣ top right empty");
        assert!(corner(1, cw - 2, ch - 2), "◢ bottom right");
        assert!(!corner(1, 0, 0), "◢ top left empty");
        assert!(corner(2, 0, 0), "◤ top left");
        assert!(!corner(2, cw - 2, ch - 2), "◤ bottom right empty");
        assert!(corner(3, cw - 2, 0), "◥ top right");
        assert!(!corner(3, 0, ch - 2), "◥ bottom left empty");
    }

    #[test]
    fn powerline_caps_round_the_segment_end() {
        let g = grid("\u{e0b4}\u{e0b6}");
        let (cw, ch) = (g.cw(), g.ch());
        // The solid right cap: full height at its base (left edge), tip at the
        // right edge only at mid height, corners empty.
        assert!(g.fg(g.x(0), 1) && g.fg(g.x(0), ch - 2), "base column full");
        assert!(g.has_ink(
            g.x(0) + cw - 2,
            g.y(0) + ch / 2,
            g.x(0) + cw,
            g.y(0) + ch / 2 + 1
        ));
        assert!(!g.has_ink(g.x(0) + cw - 1, g.y(0), g.x(0) + cw, g.y(0) + 1));
        // The left cap mirrors it.
        assert!(g.fg(g.x(1) + cw - 1, 1) && g.fg(g.x(1) + cw - 1, ch - 2));
        assert!(!g.has_ink(g.x(1), g.y(0), g.x(1) + 1, g.y(0) + 1));
    }

    #[test]
    fn outlined_powerline_caps_bulge_outward() {
        // E0B5 bulges into the right half at mid height, E0B7 mirrors it into
        // the left half; with a thin stroke the apex pixel itself truncates,
        // so the probe is the half the curve lives in.
        let g = grid("\u{e0b5}\u{e0b7}");
        let (cw, ch) = (g.cw(), g.ch());
        let (lo, hi) = (ch / 2 - 5, ch / 2 + 5);
        assert!(
            g.has_ink(g.x(0) + cw / 2, lo, g.x(0) + cw, hi),
            "E0B5 ink lives in the right half"
        );
        assert!(
            !g.has_ink(g.x(0), lo, g.x(0) + cw / 2, hi),
            "E0B5 left half is empty at mid height"
        );
        assert!(
            g.has_ink(g.x(1), lo, g.x(1) + cw / 2, hi),
            "E0B7 ink lives in the left half"
        );
        assert!(
            !g.has_ink(g.x(1) + cw / 2, lo, g.x(1) + cw, hi),
            "E0B7 right half is empty at mid height"
        );
    }
}
