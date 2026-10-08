use std::cell::RefCell;
use std::path::PathBuf;

use arboard::Clipboard;
use image::{ExtendedColorType, ImageEncoder, codecs::png::PngEncoder};

use crate::terminal::clip::ClipboardSource;

/// One read of the clipboard through arboard. It speaks X11 selections, which XWayland bridges.
#[derive(Default)]
pub struct ArboardSource {
    cb: RefCell<Option<Clipboard>>,
    files: RefCell<Option<Option<Vec<PathBuf>>>>,
}

impl ArboardSource {
    fn file_list(&self) -> Option<Vec<PathBuf>> {
        self.files
            .borrow_mut()
            .get_or_insert_with(|| {
                let mut cb = self.cb.borrow_mut();
                cb.as_mut()?.get().file_list().ok()
            })
            .clone()
    }
}

impl ClipboardSource for ArboardSource {
    fn open(&self) -> bool {
        match Clipboard::new() {
            Ok(c) => {
                *self.cb.borrow_mut() = Some(c);
                true
            }
            Err(e) => {
                tracing::debug!("clipboard unavailable: {e}");
                false
            }
        }
    }
    fn close(&self) {
        self.cb.borrow_mut().take();
    }

    /// File managers put the copied paths on the clipboard as text too; that is a file drop, not a paste.
    fn text(&self) -> Option<String> {
        if self.file_list().is_some_and(|f| !f.is_empty()) {
            return None;
        }
        self.cb.borrow_mut().as_mut()?.get_text().ok()
    }

    fn files(&self) -> Option<Vec<PathBuf>> {
        self.file_list()
    }

    fn png(&self) -> Option<Vec<u8>> {
        let img = self.cb.borrow_mut().as_mut()?.get_image().ok()?;
        rgba_to_png(&img.bytes, img.width as u32, img.height as u32)
    }
}

pub fn rgba_to_png(rgba: &[u8], width: u32, height: u32) -> Option<Vec<u8>> {
    // The encoder asserts on a short buffer instead of returning an error.
    if rgba.len() as u64 != u64::from(width) * u64::from(height) * 4 {
        return None;
    }
    let mut out = Vec::new();
    PngEncoder::new(&mut out)
        .write_image(rgba, width, height, ExtendedColorType::Rgba8)
        .ok()?;
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rgba_pixels_become_a_png() {
        let png = rgba_to_png(&[255, 0, 0, 255], 1, 1).unwrap();
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        let back = image::load_from_memory(&png).unwrap().to_rgba8();
        assert_eq!(back.get_pixel(0, 0).0, [255, 0, 0, 255]);
    }

    #[test]
    fn mismatched_pixel_data_is_no_image() {
        assert!(rgba_to_png(&[1, 2, 3], 4, 4).is_none());
    }
}
