pub mod aumid;
#[cfg(windows)]
pub mod clipboard;
#[cfg(windows)]
pub mod file_dialog;
pub mod network;
#[cfg(windows)]
pub mod platform;
pub mod shell;
#[cfg(windows)]
mod system;
pub mod taskbar;
pub mod toast;
#[cfg(windows)]
pub mod wic;
pub mod wndproc;
#[cfg(windows)]
pub use system::{apply_caption, placement_visible, show_error_box, system_uses_light};
