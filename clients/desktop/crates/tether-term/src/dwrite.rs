//! Per-character font fallback from DirectWrite, the lookup Windows' own text stack uses.

use std::cell::RefCell;
use std::ffi::{OsString, c_void};
use std::os::windows::ffi::OsStringExt;
use std::path::PathBuf;

use windows::Win32::Globalization::GetUserDefaultLocaleName;
use windows::Win32::Graphics::DirectWrite::{
    DWRITE_FACTORY_TYPE_SHARED, DWRITE_FONT_STRETCH_NORMAL, DWRITE_FONT_STYLE_NORMAL,
    DWRITE_FONT_WEIGHT_REGULAR, DWRITE_READING_DIRECTION, DWRITE_READING_DIRECTION_LEFT_TO_RIGHT,
    DWriteCreateFactory, IDWriteFactory, IDWriteFactory2, IDWriteFont, IDWriteFontCollection,
    IDWriteFontFallback, IDWriteFontFile, IDWriteLocalFontFileLoader, IDWriteNumberSubstitution,
    IDWriteTextAnalysisSource, IDWriteTextAnalysisSource_Impl,
};
use windows::core::{Interface, OutRef, implement};

struct System {
    collection: IDWriteFontCollection,
    fallback: IDWriteFontFallback,
    /// NUL-terminated, as `GetLocaleName` hands it out.
    locale: Vec<u16>,
}

impl System {
    fn new() -> Option<Self> {
        unsafe {
            let factory = DWriteCreateFactory::<IDWriteFactory>(DWRITE_FACTORY_TYPE_SHARED).ok()?;
            let mut collection = None;
            factory
                .GetSystemFontCollection(&mut collection, false)
                .ok()?;
            let fallback = factory
                .cast::<IDWriteFactory2>()
                .ok()?
                .GetSystemFontFallback()
                .ok()?;
            let mut locale = vec![0u16; 85];
            let len = GetUserDefaultLocaleName(&mut locale);
            locale.truncate(len.max(1) as usize);
            *locale.last_mut()? = 0;
            Some(Self {
                collection: collection?,
                fallback,
                locale,
            })
        }
    }

    fn cover(&self, ch: char) -> Option<(PathBuf, u32)> {
        let mut buf = [0u16; 2];
        let text = ch.encode_utf16(&mut buf);
        let source: IDWriteTextAnalysisSource = TextSource {
            text,
            locale: &self.locale,
        }
        .into();
        let mut mapped_len = 0;
        let mut mapped = None;
        unsafe {
            self.fallback
                .MapCharacters(
                    &source,
                    0,
                    text.len() as u32,
                    &self.collection,
                    None,
                    DWRITE_FONT_WEIGHT_REGULAR,
                    DWRITE_FONT_STYLE_NORMAL,
                    DWRITE_FONT_STRETCH_NORMAL,
                    &mut mapped_len,
                    &mut mapped,
                    &mut 1.0,
                )
                .ok()?;
        }
        face_key(&mapped?)
    }
}

/// The file behind a system font and the face's index in it. Fonts that are not a single
/// local file are skipped.
fn face_key(font: &IDWriteFont) -> Option<(PathBuf, u32)> {
    unsafe {
        let face = font.CreateFontFace().ok()?;
        let mut file: Option<IDWriteFontFile> = None;
        face.GetFiles(&mut 1, Some(&mut file)).ok()?;
        let file = file?;
        let mut key: *mut c_void = std::ptr::null_mut();
        let mut key_size = 0;
        file.GetReferenceKey(&mut key, &mut key_size).ok()?;
        let loader: IDWriteLocalFontFileLoader = file.GetLoader().ok()?.cast().ok()?;
        let len = loader.GetFilePathLengthFromKey(key, key_size).ok()?;
        let mut path = vec![0u16; len as usize + 1];
        loader.GetFilePathFromKey(key, key_size, &mut path).ok()?;
        path.truncate(len as usize);
        Some((PathBuf::from(OsString::from_wide(&path)), face.GetIndex()))
    }
}

thread_local! {
    // DirectWrite's COM objects are not shared across threads.
    static SYSTEM: RefCell<Option<Option<System>>> = const { RefCell::new(None) };
}

/// The face Windows would draw `ch` with, for the user's locale.
pub(crate) fn cover(ch: char) -> Option<(PathBuf, u32)> {
    SYSTEM.with(|system| {
        system
            .borrow_mut()
            .get_or_insert_with(System::new)
            .as_ref()?
            .cover(ch)
    })
}

#[implement(IDWriteTextAnalysisSource)]
struct TextSource<'a> {
    text: &'a [u16],
    locale: &'a [u16],
}

impl IDWriteTextAnalysisSource_Impl for TextSource_Impl<'_> {
    fn GetLocaleName(
        &self,
        position: u32,
        length: *mut u32,
        locale: *mut *mut u16,
    ) -> windows::core::Result<()> {
        unsafe {
            *length = (self.text.len() as u32).saturating_sub(position);
            *locale = self.locale.as_ptr().cast_mut();
        }
        Ok(())
    }

    fn GetNumberSubstitution(
        &self,
        position: u32,
        length: *mut u32,
        substitution: OutRef<'_, IDWriteNumberSubstitution>,
    ) -> windows::core::Result<()> {
        substitution.write(None)?;
        unsafe {
            *length = (self.text.len() as u32).saturating_sub(position);
        }
        Ok(())
    }

    fn GetParagraphReadingDirection(&self) -> DWRITE_READING_DIRECTION {
        DWRITE_READING_DIRECTION_LEFT_TO_RIGHT
    }

    fn GetTextAtPosition(
        &self,
        position: u32,
        text: *mut *mut u16,
        length: *mut u32,
    ) -> windows::core::Result<()> {
        let rest = self.text.get(position as usize..).unwrap_or_default();
        unsafe {
            *length = rest.len() as u32;
            *text = rest.as_ptr().cast_mut();
        }
        Ok(())
    }

    fn GetTextBeforePosition(
        &self,
        position: u32,
        text: *mut *mut u16,
        length: *mut u32,
    ) -> windows::core::Result<()> {
        let before = self.text.get(..position as usize).unwrap_or_default();
        unsafe {
            *length = before.len() as u32;
            *text = before.as_ptr().cast_mut();
        }
        Ok(())
    }
}
