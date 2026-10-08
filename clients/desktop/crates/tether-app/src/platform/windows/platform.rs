use slint::ComponentHandle;
use std::path::PathBuf;
use std::sync::OnceLock;
use tether_core::osc::Progress;
use tether_core::paste::ClipboardSnapshot;

use crate::AppWindow;
use crate::platform::Platform;
use crate::platform::windows::{aumid, clipboard, file_dialog, shell, taskbar, toast};

/// Every method except `read_clipboard` runs on the UI thread (`SlintUi` routes them there).
pub struct WindowsPlatform {
    window: slint::Weak<AppWindow>,
    toaster: OnceLock<toast::Toaster>,
}

impl WindowsPlatform {
    pub fn new(window: slint::Weak<AppWindow>) -> Self {
        Self {
            window,
            toaster: OnceLock::new(),
        }
    }

    fn hwnd(&self) -> Option<isize> {
        crate::platform::hwnd_of(self.window.upgrade()?.window())
    }

    fn toaster(&self) -> Option<&toast::Toaster> {
        if self.toaster.get().is_none() {
            let packaged = aumid::is_packaged();
            let shortcut = !packaged && aumid::register_portable();
            if let Some(t) = aumid::toast_identity(packaged, shortcut).and_then(toast::Toaster::new)
            {
                let _ = self.toaster.set(t);
            }
        }
        self.toaster.get()
    }

    /// Call once at startup so the AUMID is set before the first window shows.
    pub fn prepare_identity(&self) {
        let _ = self.toaster();
    }
}

impl Platform for WindowsPlatform {
    fn flash_taskbar(&self) {
        if let Some(h) = self.hwnd() {
            taskbar::flash(h);
        }
    }
    fn set_progress(&self, p: Option<&Progress>) {
        if let Some(h) = self.hwnd() {
            taskbar::set_progress(h, p);
        }
    }
    fn toast(&self, machine: &str, session: &str, title: &str, body: &str) {
        if let Some(t) = self.toaster() {
            t.show(machine, session, title, body);
        }
    }
    fn open_url(&self, url: &str) {
        shell::open_url(url);
    }
    fn set_clipboard(&self, text: &str) {
        // arboard (already an M5 dependency) owns the clipboard properly and retries a held one.
        if let Err(e) = arboard::Clipboard::new().and_then(|mut c| c.set_text(text.to_owned())) {
            tracing::debug!("copy failed: {e}");
        }
    }
    fn read_clipboard(&self) -> ClipboardSnapshot {
        crate::terminal::clip::snapshot(&clipboard::WinClipboard, &std::thread::sleep)
    }
    fn bring_to_front(&self) {
        if let Some(h) = self.hwnd() {
            shell::bring_to_front(h);
        }
    }
    fn pick_files(&self) -> Vec<PathBuf> {
        self.window
            .upgrade()
            .map(|app| file_dialog::pick_files(app.window()))
            .unwrap_or_default()
    }
}
