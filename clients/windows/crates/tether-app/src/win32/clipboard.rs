use std::path::PathBuf;

use windows::Win32::Foundation::HGLOBAL;
use windows::Win32::System::DataExchange::{
    CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
    RegisterClipboardFormatW,
};
use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
use windows::Win32::System::Ole::{CF_DIB, CF_DIBV5, CF_HDROP, CF_UNICODETEXT};
use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};
use windows::core::w;

use crate::terminal::clip::ClipboardSource;

pub struct WinClipboard;

fn global_bytes(format: u32) -> Option<Vec<u8>> {
    unsafe {
        IsClipboardFormatAvailable(format).ok()?;
        let h = GetClipboardData(format).ok()?;
        let g = HGLOBAL(h.0);
        let p = GlobalLock(g) as *const u8;
        if p.is_null() {
            return None;
        }
        let bytes = std::slice::from_raw_parts(p, GlobalSize(g)).to_vec();
        let _ = GlobalUnlock(g);
        Some(bytes)
    }
}

impl ClipboardSource for WinClipboard {
    fn open(&self) -> bool {
        unsafe { OpenClipboard(None).is_ok() }
    }
    fn close(&self) {
        unsafe {
            let _ = CloseClipboard();
        }
    }

    fn text(&self) -> Option<String> {
        let bytes = global_bytes(CF_UNICODETEXT.0 as u32)?;
        let wide: Vec<u16> = bytes
            .as_chunks::<2>()
            .0
            .iter()
            .map(|c| u16::from_le_bytes(*c))
            .take_while(|&c| c != 0)
            .collect();
        Some(String::from_utf16_lossy(&wide))
    }

    fn files(&self) -> Option<Vec<PathBuf>> {
        unsafe {
            IsClipboardFormatAvailable(CF_HDROP.0 as u32).ok()?;
            let drop = HDROP(GetClipboardData(CF_HDROP.0 as u32).ok()?.0);
            let count = DragQueryFileW(drop, u32::MAX, None);
            let files = (0..count)
                .map(|i| {
                    let len = DragQueryFileW(drop, i, None) as usize;
                    let mut buf = vec![0u16; len + 1];
                    DragQueryFileW(drop, i, Some(&mut buf));
                    PathBuf::from(String::from_utf16_lossy(&buf[..len]))
                })
                .collect();
            Some(files)
        }
    }

    fn png(&self) -> Option<Vec<u8>> {
        let format = unsafe { RegisterClipboardFormatW(w!("PNG")) };
        global_bytes(format)
    }
    fn dibv5(&self) -> Option<Vec<u8>> {
        global_bytes(CF_DIBV5.0 as u32)
    }
    fn dib(&self) -> Option<Vec<u8>> {
        global_bytes(CF_DIB.0 as u32)
    }
}
