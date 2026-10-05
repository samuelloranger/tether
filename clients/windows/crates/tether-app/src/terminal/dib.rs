#[cfg(test)]
mod tests {
    use super::*;

    fn header(size: u32, w: i32, h: i32, bpp: u16, compression: u32) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend(size.to_le_bytes()); v.extend(w.to_le_bytes()); v.extend(h.to_le_bytes());
        v.extend(1u16.to_le_bytes()); v.extend(bpp.to_le_bytes()); v.extend(compression.to_le_bytes());
        v.extend([0u8; 20]);
        v.resize(size as usize, 0);
        v
    }

    fn decode(png: &[u8]) -> image::RgbaImage {
        image::load_from_memory_with_format(png, image::ImageFormat::Png).unwrap().to_rgba8()
    }

    #[test]
    fn bottom_up_24_bit_comes_out_upright() {
        let mut d = header(40, 1, 2, 24, 0);
        // Rows are stored bottom first, BGR, each padded to 4 bytes.
        d.extend([0, 0, 255, 0]);   // bottom row: red
        d.extend([255, 0, 0, 0]);   // top row: blue
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
        assert_eq!(decode(&dib_to_png(&d).unwrap()).get_pixel(0, 0).0, [30, 20, 10, 255]);
    }

    #[test]
    fn v5_bitfields_keep_alpha() {
        let mut d = header(124, 1, 1, 32, 3);
        d[40..44].copy_from_slice(&0x00FF0000u32.to_le_bytes());
        d[44..48].copy_from_slice(&0x0000FF00u32.to_le_bytes());
        d[48..52].copy_from_slice(&0x000000FFu32.to_le_bytes());
        d[52..56].copy_from_slice(&0xFF000000u32.to_le_bytes());
        d.extend(0x80_10_20_30u32.to_le_bytes());
        assert_eq!(decode(&dib_to_png(&d).unwrap()).get_pixel(0, 0).0, [0x10, 0x20, 0x30, 0x80]);
    }

    #[test]
    fn info_header_bitfields_read_the_masks_after_it() {
        let mut d = header(40, 1, 1, 32, 3);
        d.extend(0x00FF0000u32.to_le_bytes()); d.extend(0x0000FF00u32.to_le_bytes()); d.extend(0x000000FFu32.to_le_bytes());
        d.extend(0x00_10_20_30u32.to_le_bytes());
        assert_eq!(decode(&dib_to_png(&d).unwrap()).get_pixel(0, 0).0, [0x10, 0x20, 0x30, 0xFF]);
    }

    #[test]
    fn palettes_and_truncation_are_refused() {
        assert_eq!(dib_to_png(&header(40, 1, 1, 8, 0)), Err(DibError::Unsupported(8, 0)));
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
