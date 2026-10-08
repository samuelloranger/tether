use std::path::PathBuf;
use tether_core::osc::Progress;
use tether_core::paste::ClipboardSnapshot;

// Its pure logic is tested everywhere but only called on Windows.
#[cfg_attr(not(windows), allow(dead_code))]
pub mod windows;

#[cfg(windows)]
pub use windows::{apply_caption, placement_visible, show_error_box, system_uses_light};

#[cfg(not(windows))]
pub fn apply_caption(_hwnd: isize, _background: u32, _dark: bool) {}

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

pub trait Platform: Send + Sync + 'static {
    fn flash_taskbar(&self);
    fn set_progress(&self, p: Option<&Progress>);
    fn toast(&self, machine: &str, session: &str, title: &str, body: &str);
    fn open_url(&self, url: &str);
    fn set_clipboard(&self, text: &str);
    /// Blocking; called off the UI thread.
    fn read_clipboard(&self) -> ClipboardSnapshot;
    fn bring_to_front(&self);
    /// Modal; called on the UI thread.
    fn pick_files(&self) -> Vec<PathBuf>;
}

pub struct NullPlatform;

impl Platform for NullPlatform {
    fn flash_taskbar(&self) {}
    fn set_progress(&self, _p: Option<&Progress>) {}
    fn toast(&self, _m: &str, _s: &str, _t: &str, _b: &str) {}
    fn open_url(&self, _u: &str) {}
    fn set_clipboard(&self, _t: &str) {}
    fn read_clipboard(&self) -> ClipboardSnapshot {
        ClipboardSnapshot::Empty
    }
    fn bring_to_front(&self) {}
    fn pick_files(&self) -> Vec<PathBuf> {
        Vec::new()
    }
}
