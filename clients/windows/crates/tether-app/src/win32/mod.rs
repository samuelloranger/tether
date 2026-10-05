use std::path::PathBuf;
use tether_core::osc::Progress;
use tether_core::paste::ClipboardSnapshot;

pub mod wndproc;
#[cfg(windows)] pub mod aumid;
#[cfg(windows)] pub mod clipboard;
#[cfg(windows)]
pub mod file_dialog;
#[cfg(windows)] pub mod network;
#[cfg(windows)] pub mod shell;
#[cfg(windows)] pub mod taskbar;
#[cfg(windows)] pub mod toast;
#[cfg(windows)] pub mod wic;

pub trait Platform: Send + Sync + 'static {
    fn flash_taskbar(&self);
    fn set_progress(&self, p: Option<&Progress>);
    fn toast(&self, session: &str, title: &str, body: &str);
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
    fn toast(&self, _s: &str, _t: &str, _b: &str) {}
    fn open_url(&self, _u: &str) {}
    fn set_clipboard(&self, _t: &str) {}
    fn read_clipboard(&self) -> ClipboardSnapshot { ClipboardSnapshot::Empty }
    fn bring_to_front(&self) {}
    fn pick_files(&self) -> Vec<PathBuf> { Vec::new() }
}
