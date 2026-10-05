use std::io::Cursor;

use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::{ExtendedColorType, ImageEncoder};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DibError {
    Truncated,
    Unsupported(u16, u32),
    TooLarge,
}

const BI_RGB: u32 = 0;
const BI_BITFIELDS: u32 = 3;

fn u32_at(d: &[u8], at: usize) -> Result<u32, DibError> {
    d.get(at..at + 4)
        .map(|b| u32::from_le_bytes(b.try_into().unwrap()))
        .ok_or(DibError::Truncated)
}

fn channel(px: u32, mask: u32) -> u8 {
    if mask == 0 {
        return 0;
    }
    let v = (px & mask) >> mask.trailing_zeros();
    let max = mask >> mask.trailing_zeros();
    ((v * 255 + max / 2) / max) as u8
}

/// `CF_DIB` / `CF_DIBV5` (BITMAPINFOHEADER or V4/V5, 24 or 32 bpp) to a lossless PNG with alpha.
pub fn dib_to_png(d: &[u8]) -> Result<Vec<u8>, DibError> {
    let size = u32_at(d, 0)? as usize;
    let width = u32_at(d, 4)? as i32;
    let height = u32_at(d, 8)? as i32;
    let bpp = d
        .get(14..16)
        .map(|b| u16::from_le_bytes([b[0], b[1]]))
        .ok_or(DibError::Truncated)?;
    let compression = u32_at(d, 16)?;
    let colors_used = u32_at(d, 32)? as usize;
    if !(bpp == 24 && compression == BI_RGB
        || bpp == 32 && (compression == BI_RGB || compression == BI_BITFIELDS))
    {
        return Err(DibError::Unsupported(bpp, compression));
    }
    let (masks, mut offset) = if compression == BI_BITFIELDS {
        if size >= 56 {
            (
                [
                    u32_at(d, 40)?,
                    u32_at(d, 44)?,
                    u32_at(d, 48)?,
                    u32_at(d, 52)?,
                ],
                size,
            )
        } else {
            (
                [
                    u32_at(d, size)?,
                    u32_at(d, size + 4)?,
                    u32_at(d, size + 8)?,
                    0,
                ],
                size + 12,
            )
        }
    } else {
        (
            [
                0x00FF0000,
                0x0000FF00,
                0x000000FF,
                if bpp == 32 { 0xFF000000 } else { 0 },
            ],
            size,
        )
    };
    offset += colors_used * 4;
    let (w, h) = (
        width.unsigned_abs() as usize,
        height.unsigned_abs() as usize,
    );
    const MAX_DIM: usize = 16384;
    if w > MAX_DIM || h > MAX_DIM {
        return Err(DibError::TooLarge);
    }
    let bpp = bpp as usize;
    let stride = (w.checked_mul(bpp).ok_or(DibError::TooLarge)?).div_ceil(32) * 4;
    let bytes = stride.checked_mul(h).ok_or(DibError::TooLarge)?;
    let pixels = d.get(offset..offset + bytes).ok_or(DibError::Truncated)?;
    let rgba_len = w
        .checked_mul(h)
        .and_then(|n| n.checked_mul(4))
        .ok_or(DibError::TooLarge)?;
    let mut rgba = vec![0u8; rgba_len];
    for y in 0..h {
        let src_row = if height > 0 { h - 1 - y } else { y };
        let row = &pixels[src_row * stride..src_row * stride + stride];
        for x in 0..w {
            let out = &mut rgba[(y * w + x) * 4..(y * w + x) * 4 + 4];
            if bpp == 24 {
                out.copy_from_slice(&[row[x * 3 + 2], row[x * 3 + 1], row[x * 3], 255]);
            } else {
                let px = u32::from_le_bytes(row[x * 4..x * 4 + 4].try_into().unwrap());
                out.copy_from_slice(&[
                    channel(px, masks[0]),
                    channel(px, masks[1]),
                    channel(px, masks[2]),
                    channel(px, masks[3]),
                ]);
            }
        }
    }
    if bpp == 32 && (masks[3] == 0 || rgba.chunks_exact(4).all(|p| p[3] == 0)) {
        for p in rgba.chunks_exact_mut(4) {
            p[3] = 255;
        }
    }
    let mut png = Vec::new();
    PngEncoder::new_with_quality(
        Cursor::new(&mut png),
        CompressionType::Fast,
        FilterType::Adaptive,
    )
    .write_image(&rgba, w as u32, h as u32, ExtendedColorType::Rgba8)
    .map_err(|_| DibError::Truncated)?;
    Ok(png)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header(size: u32, w: i32, h: i32, bpp: u16, compression: u32) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend(size.to_le_bytes());
        v.extend(w.to_le_bytes());
        v.extend(h.to_le_bytes());
        v.extend(1u16.to_le_bytes());
        v.extend(bpp.to_le_bytes());
        v.extend(compression.to_le_bytes());
        v.extend([0u8; 20]);
        v.resize(size as usize, 0);
        v
    }

    fn decode(png: &[u8]) -> image::RgbaImage {
        image::load_from_memory_with_format(png, image::ImageFormat::Png)
            .unwrap()
            .to_rgba8()
    }

    #[test]
    fn bottom_up_24_bit_comes_out_upright() {
        let mut d = header(40, 1, 2, 24, 0);
        d.extend([0, 0, 255, 0]);
        d.extend([255, 0, 0, 0]);
        let img = decode(&dib_to_png(&d).unwrap());
        assert_eq!(img.get_pixel(0, 0).0, [0, 0, 255, 255]);
        assert_eq!(img.get_pixel(0, 1).0, [255, 0, 0, 255]);
    }

    #[test]
    fn top_down_is_read_as_is() {
        let mut d = header(40, 1, -2, 24, 0);
        d.extend([255, 0, 0, 0]);
        d.extend([0, 0, 255, 0]);
        let img = decode(&dib_to_png(&d).unwrap());
        assert_eq!(img.get_pixel(0, 0).0, [0, 0, 255, 255]);
    }

    #[test]
    fn rgb32_with_zero_alpha_everywhere_is_opaque() {
        let mut d = header(40, 1, 1, 32, 0);
        d.extend([10, 20, 30, 0]);
        assert_eq!(
            decode(&dib_to_png(&d).unwrap()).get_pixel(0, 0).0,
            [30, 20, 10, 255]
        );
    }

    #[test]
    fn v5_bitfields_keep_alpha() {
        let mut d = header(124, 1, 1, 32, 3);
        d[40..44].copy_from_slice(&0x00FF0000u32.to_le_bytes());
        d[44..48].copy_from_slice(&0x0000FF00u32.to_le_bytes());
        d[48..52].copy_from_slice(&0x000000FFu32.to_le_bytes());
        d[52..56].copy_from_slice(&0xFF000000u32.to_le_bytes());
        d.extend(0x80_10_20_30u32.to_le_bytes());
        assert_eq!(
            decode(&dib_to_png(&d).unwrap()).get_pixel(0, 0).0,
            [0x10, 0x20, 0x30, 0x80]
        );
    }

    #[test]
    fn info_header_bitfields_read_the_masks_after_it() {
        let mut d = header(40, 1, 1, 32, 3);
        d.extend(0x00FF0000u32.to_le_bytes());
        d.extend(0x0000FF00u32.to_le_bytes());
        d.extend(0x000000FFu32.to_le_bytes());
        d.extend(0x00_10_20_30u32.to_le_bytes());
        assert_eq!(
            decode(&dib_to_png(&d).unwrap()).get_pixel(0, 0).0,
            [0x10, 0x20, 0x30, 0xFF]
        );
    }

    #[test]
    fn a_huge_dimension_is_refused() {
        assert_eq!(
            dib_to_png(&header(40, 100_000, 1, 32, 0)),
            Err(DibError::TooLarge)
        );
        assert_eq!(
            dib_to_png(&header(40, 1, 100_000, 32, 0)),
            Err(DibError::TooLarge)
        );
    }

    #[test]
    fn palettes_and_truncation_are_refused() {
        assert_eq!(
            dib_to_png(&header(40, 1, 1, 8, 0)),
            Err(DibError::Unsupported(8, 0))
        );
        let mut d = header(40, 4, 4, 32, 0);
        d.extend([0u8; 10]);
        assert_eq!(dib_to_png(&d), Err(DibError::Truncated));
        assert_eq!(dib_to_png(&[1, 2, 3]), Err(DibError::Truncated));
    }

    #[test]
    fn converts_8k_dib_and_checks_limit() {
        let (w, h) = (7680i32, 4320i32);
        let mut d = header(40, w, h, 32, 0);
        d.resize(d.len() + (w * h * 4) as usize, 0x40);
        let png = dib_to_png(&d).unwrap();
        let img = decode(&png);
        assert_eq!((img.width(), img.height()), (7680, 4320));
        assert!(tether_core::upload::preflight(false, png.len() as u64).is_ok());
    }
}
