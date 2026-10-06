use std::collections::HashMap;
use std::sync::Arc;

use crate::images::ImageView;
use crate::raster::RgbaImage;

const CACHE_ENTRIES: usize = 8;

type Key = (u64, (u32, u32, u32, u32), i32, i32);

/// Scaled copies of the pictures on screen, so a frame that only moves the cursor does not
/// resample them again.
#[derive(Default)]
pub(crate) struct ImageCache {
    scaled: HashMap<Key, Arc<Vec<u8>>>,
}

impl ImageCache {
    pub(crate) fn draw(
        &mut self,
        img: &mut RgbaImage,
        view: &ImageView,
        x: i32,
        y: i32,
        dw: i32,
        dh: i32,
    ) {
        if dw <= 0 || dh <= 0 || x >= img.width as i32 || y >= img.height as i32 {
            return;
        }
        if x + dw <= 0 || y + dh <= 0 {
            return;
        }
        let key = (view.image.id, view.src, dw, dh);
        if !self.scaled.contains_key(&key) {
            if self.scaled.len() >= CACHE_ENTRIES {
                self.scaled.clear();
            }
            self.scaled
                .insert(key, Arc::new(scale(view, dw as u32, dh as u32)));
        }
        let pixels = &self.scaled[&key];
        let (x0, y0) = (x.max(0), y.max(0));
        let (x1, y1) = (
            (x + dw).min(img.width as i32),
            (y + dh).min(img.height as i32),
        );
        for py in y0..y1 {
            for px in x0..x1 {
                let s = (((py - y) * dw + (px - x)) * 4) as usize;
                let alpha = pixels[s + 3] as u32;
                if alpha == 0 {
                    continue;
                }
                let d = ((py as u32 * img.width + px as u32) * 4) as usize;
                for c in 0..3 {
                    let dst = img.pixels[d + c] as u32;
                    img.pixels[d + c] =
                        ((pixels[s + c] as u32 * alpha + dst * (255 - alpha)) / 255) as u8;
                }
            }
        }
    }
}

/// Box-filtered resample of the view's source rectangle to `dw` x `dh`, straight RGBA.
pub(crate) fn scale(view: &ImageView, dw: u32, dh: u32) -> Vec<u8> {
    let image = &view.image;
    let (sx, sy, sw, sh) = view.src;
    let sw = sw.min(image.width.saturating_sub(sx)).max(1);
    let sh = sh.min(image.height.saturating_sub(sy)).max(1);
    let (ratio_x, ratio_y) = (sw as f32 / dw as f32, sh as f32 / dh as f32);
    let taps_x = (ratio_x.ceil() as u32).clamp(1, 4);
    let taps_y = (ratio_y.ceil() as u32).clamp(1, 4);
    let mut out = vec![0u8; (dw * dh * 4) as usize];
    for oy in 0..dh {
        for ox in 0..dw {
            let mut sum = [0u32; 4];
            let mut weight = 0u32;
            for ty in 0..taps_y {
                for tx in 0..taps_x {
                    let fx = (ox as f32 + (tx as f32 + 0.5) / taps_x as f32) * ratio_x;
                    let fy = (oy as f32 + (ty as f32 + 0.5) / taps_y as f32) * ratio_y;
                    let ix = sx + (fx as u32).min(sw - 1);
                    let iy = sy + (fy as u32).min(sh - 1);
                    let i = ((iy * image.width + ix) * 4) as usize;
                    let a = image.rgba[i + 3] as u32;
                    sum[0] += image.rgba[i] as u32 * a;
                    sum[1] += image.rgba[i + 1] as u32 * a;
                    sum[2] += image.rgba[i + 2] as u32 * a;
                    sum[3] += a;
                    weight += 1;
                }
            }
            let o = ((oy * dw + ox) * 4) as usize;
            if let (Some(r), Some(g), Some(b)) = (
                sum[0].checked_div(sum[3]),
                sum[1].checked_div(sum[3]),
                sum[2].checked_div(sum[3]),
            ) {
                out[o] = r as u8;
                out[o + 1] = g as u8;
                out[o + 2] = b as u8;
                out[o + 3] = (sum[3] / weight) as u8;
            }
        }
    }
    out
}
