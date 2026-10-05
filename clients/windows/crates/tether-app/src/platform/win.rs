use std::ffi::c_void;

use tether_core::WindowPlacement;
use windows::{
    Win32::{
        Foundation::{COLORREF, HWND, RECT},
        Graphics::{
            Dwm::{DWMWA_CAPTION_COLOR, DWMWA_USE_IMMERSIVE_DARK_MODE, DwmSetWindowAttribute},
            Gdi::{MONITOR_DEFAULTTONULL, MonitorFromRect},
        },
        System::Registry::{HKEY_CURRENT_USER, RRF_RT_REG_DWORD, RegGetValueW},
    },
    core::w,
};

use crate::vm::scene::caption_colorref;

pub fn apply_caption(hwnd: isize, dark: bool) {
    let hwnd = HWND(hwnd as *mut c_void);
    let dark_mode = i32::from(dark);
    let caption = COLORREF(caption_colorref(dark));
    unsafe {
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_USE_IMMERSIVE_DARK_MODE,
            &dark_mode as *const i32 as *const c_void,
            size_of::<i32>() as u32,
        );
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_CAPTION_COLOR,
            &caption as *const COLORREF as *const c_void,
            size_of::<COLORREF>() as u32,
        );
    }
}

pub fn system_uses_light() -> bool {
    let mut value: u32 = 0;
    let mut size = size_of::<u32>() as u32;
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            w!("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize"),
            w!("AppsUseLightTheme"),
            RRF_RT_REG_DWORD,
            None,
            Some(&mut value as *mut u32 as *mut c_void),
            Some(&mut size),
        )
    };
    status.is_ok() && value == 1
}

pub fn placement_visible(p: &WindowPlacement) -> bool {
    let strip = RECT {
        left: p.x,
        top: p.y,
        right: p.x + p.width as i32,
        bottom: p.y + 40,
    };
    !unsafe { MonitorFromRect(&strip, MONITOR_DEFAULTTONULL) }.is_invalid()
}
