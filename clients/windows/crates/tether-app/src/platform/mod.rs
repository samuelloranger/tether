#[cfg(windows)]
mod win;

#[cfg(windows)]
pub use win::{apply_caption, placement_visible, show_error_box, system_uses_light};

#[cfg(not(windows))]
pub fn apply_caption(_hwnd: isize, _dark: bool) {}

#[cfg(not(windows))]
pub fn system_uses_light() -> bool {
    false
}

#[cfg(not(windows))]
pub fn placement_visible(_p: &tether_core::WindowPlacement) -> bool {
    true
}

#[cfg(not(windows))]
pub fn show_error_box(_message: &str) {}

pub fn hwnd_of(window: &slint::Window) -> Option<isize> {
    use slint::winit_030::{
        WinitWindowAccessor,
        winit::raw_window_handle::{HasWindowHandle, RawWindowHandle},
    };
    window
        .with_winit_window(|w| match w.window_handle().ok()?.as_raw() {
            RawWindowHandle::Win32(h) => Some(h.hwnd.get()),
            _ => None,
        })
        .flatten()
}
