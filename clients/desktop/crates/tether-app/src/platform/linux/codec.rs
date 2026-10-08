use image::codecs::jpeg::JpegEncoder;

use crate::terminal::files::ImageCodec;

const QUALITY: u8 = 90;

/// Re-encodes the formats a terminal agent cannot read. HEIC and AVIF are not decoded (their
/// decoders need C libraries), so those go out as they are.
pub struct ImageCrateCodec;

impl ImageCodec for ImageCrateCodec {
    fn to_jpeg(&self, bytes: &[u8]) -> Option<Vec<u8>> {
        let rgb = image::load_from_memory(bytes).ok()?.to_rgb8();
        let mut out = Vec::new();
        JpegEncoder::new_with_quality(&mut out, QUALITY)
            .encode_image(&rgb)
            .ok()?;
        Some(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{DynamicImage, ImageFormat, RgbaImage};
    use std::io::Cursor;

    fn encoded(format: ImageFormat) -> Vec<u8> {
        let img =
            DynamicImage::ImageRgba8(RgbaImage::from_pixel(8, 8, image::Rgba([0, 200, 0, 255])));
        let mut out = Cursor::new(Vec::new());
        img.write_to(&mut out, format).unwrap();
        out.into_inner()
    }

    #[test]
    fn bmp_and_tiff_become_jpeg() {
        for format in [ImageFormat::Bmp, ImageFormat::Tiff] {
            let jpeg = ImageCrateCodec.to_jpeg(&encoded(format)).unwrap();
            assert_eq!(&jpeg[..2], b"\xff\xd8");
            let back = image::load_from_memory(&jpeg).unwrap();
            assert_eq!((back.width(), back.height()), (8, 8));
        }
    }

    #[test]
    fn bytes_that_are_not_an_image_are_left_alone() {
        assert!(ImageCrateCodec.to_jpeg(b"not an image").is_none());
    }
}
