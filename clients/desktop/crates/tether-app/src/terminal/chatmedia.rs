//! Pictures for the chat: what a message sends (the iOS `ChatImageEncoder` rules) and what the
//! transcript shows (thumbnails decoded off the UI thread).

use std::io::Cursor;
use std::path::Path;
use std::sync::Arc;

use base64::Engine;
use image::{DynamicImage, GenericImageView, ImageFormat, imageops::FilterType};
use tether_core::acp::images::ImageAttachment;

use crate::terminal::model::chat::Pixels;

pub const MAX_EDGE: u32 = 1568;
pub const MAX_ENCODED_BYTES: usize = 5 * 1024 * 1024;
const JPEG_QUALITY: u8 = 80;
/// The file read before decoding; anything past this is not a picture someone pastes into a chat.
const MAX_SOURCE_BYTES: u64 = 64 * 1024 * 1024;
pub const THUMB_EDGE: u32 = 640;
pub const CHIP_EDGE: u32 = 160;
pub const FULL_EDGE: u32 = 4096;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EncodeError {
    NotAnImage,
    TooLarge,
    Failed,
}

impl EncodeError {
    pub fn message(&self) -> &'static str {
        match self {
            Self::TooLarge => "That image is too large to send.",
            Self::NotAnImage => "That file isn't an image.",
            Self::Failed => "Couldn't prepare that image.",
        }
    }
}

fn pixels(img: &DynamicImage, edge: u32) -> Arc<Pixels> {
    let scaled = if img.width().max(img.height()) > edge {
        img.resize(edge, edge, FilterType::Triangle)
    } else {
        img.clone()
    };
    let rgba = scaled.to_rgba8();
    Arc::new(Pixels {
        width: rgba.width(),
        height: rgba.height(),
        rgba: rgba.into_raw(),
    })
}

pub fn read_source(path: &Path) -> Result<Vec<u8>, EncodeError> {
    let meta = std::fs::metadata(path).map_err(|_| EncodeError::NotAnImage)?;
    if !meta.is_file() {
        return Err(EncodeError::NotAnImage);
    }
    if meta.len() > MAX_SOURCE_BYTES {
        return Err(EncodeError::TooLarge);
    }
    std::fs::read(path).map_err(|_| EncodeError::Failed)
}

/// Fits the longest edge into 1568 px; a picture with any translucent pixel stays PNG, the rest
/// becomes JPEG on white, as on iOS. The chip is the composer's thumbnail.
pub fn encode(bytes: &[u8]) -> Result<(ImageAttachment, Arc<Pixels>), EncodeError> {
    let img = image::load_from_memory(bytes).map_err(|_| EncodeError::NotAnImage)?;
    if img.width() == 0 || img.height() == 0 {
        return Err(EncodeError::NotAnImage);
    }
    let fitted = if img.width().max(img.height()) > MAX_EDGE {
        img.resize(MAX_EDGE, MAX_EDGE, FilterType::Lanczos3)
    } else {
        img
    };
    let rgba = fitted.to_rgba8();
    let translucent = rgba.pixels().any(|p| p.0[3] != 255);
    let mut out = Vec::new();
    let mime = if translucent {
        DynamicImage::ImageRgba8(rgba)
            .write_to(&mut Cursor::new(&mut out), ImageFormat::Png)
            .map_err(|_| EncodeError::Failed)?;
        "image/png"
    } else {
        let rgb = DynamicImage::ImageRgba8(rgba).to_rgb8();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, JPEG_QUALITY)
            .encode_image(&rgb)
            .map_err(|_| EncodeError::Failed)?;
        "image/jpeg"
    };
    if out.len() > MAX_ENCODED_BYTES {
        return Err(EncodeError::TooLarge);
    }
    let chip = pixels(&fitted, CHIP_EDGE);
    Ok((
        ImageAttachment {
            mime_type: mime.to_string(),
            data: base64::engine::general_purpose::STANDARD.encode(&out),
        },
        chip,
    ))
}

/// A stored picture scaled to fit `edge`; nothing for a file that is gone or does not decode.
pub fn thumbnail(path: &Path, edge: u32) -> Option<Arc<Pixels>> {
    let bytes = std::fs::read(path).ok()?;
    let img = image::load_from_memory(&bytes).ok()?;
    let (w, h) = img.dimensions();
    (w > 0 && h > 0).then(|| pixels(&img, edge))
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgba, RgbaImage};

    fn png(width: u32, height: u32, alpha: u8) -> Vec<u8> {
        let img = RgbaImage::from_pixel(width, height, Rgba([200, 30, 30, alpha]));
        let mut out = Vec::new();
        DynamicImage::ImageRgba8(img)
            .write_to(&mut Cursor::new(&mut out), ImageFormat::Png)
            .unwrap();
        out
    }

    fn decoded(a: &ImageAttachment) -> DynamicImage {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&a.data)
            .unwrap();
        image::load_from_memory(&bytes).unwrap()
    }

    #[test]
    fn an_opaque_picture_becomes_jpeg() {
        let (a, chip) = encode(&png(40, 30, 255)).unwrap();
        assert_eq!(a.mime_type, "image/jpeg");
        assert_eq!(decoded(&a).dimensions(), (40, 30));
        assert_eq!((chip.width, chip.height), (40, 30));
    }

    #[test]
    fn a_translucent_picture_stays_png() {
        let (a, _) = encode(&png(10, 10, 128)).unwrap();
        assert_eq!(a.mime_type, "image/png");
    }

    #[test]
    fn the_longest_edge_fits_1568() {
        let (a, chip) = encode(&png(3136, 1000, 255)).unwrap();
        assert_eq!(decoded(&a).dimensions(), (1568, 500));
        assert_eq!(chip.width, CHIP_EDGE);
    }

    #[test]
    fn text_is_not_an_image() {
        assert_eq!(encode(b"hello").unwrap_err(), EncodeError::NotAnImage);
        assert_eq!(
            EncodeError::NotAnImage.message(),
            "That file isn't an image."
        );
    }

    #[test]
    fn a_thumbnail_fits_its_edge_and_a_missing_file_has_none() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("p.png");
        std::fs::write(&path, png(1280, 640, 255)).unwrap();
        let t = thumbnail(&path, THUMB_EDGE).unwrap();
        assert_eq!((t.width, t.height), (640, 320));
        assert_eq!(t.rgba.len(), 640 * 320 * 4);
        assert!(thumbnail(&dir.path().join("gone"), THUMB_EDGE).is_none());
    }

    #[test]
    fn a_folder_is_not_an_image() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            read_source(dir.path()).unwrap_err(),
            EncodeError::NotAnImage
        );
    }
}
