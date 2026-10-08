use slint::ComponentHandle;
use slint::winit_030::{WinitWindowAccessor, winit::window::UserAttentionType};
use std::path::PathBuf;
use std::sync::Mutex;
use tether_core::osc::Progress;
use tether_core::paste::ClipboardSnapshot;

use crate::AppWindow;
use crate::platform::Platform;
use crate::platform::file_dialog;
use crate::platform::linux::{clipboard, launcher, notify, shell};

/// Every method except `read_clipboard` runs on the UI thread (`SlintUi` routes them there).
pub struct LinuxPlatform {
    window: slint::Weak<AppWindow>,
    notifier: notify::Notifier,
    // X11 serves the copied text only while a `Clipboard` lives, so one is kept for the process.
    clipboard: Mutex<Option<arboard::Clipboard>>,
}

impl LinuxPlatform {
    pub fn new(window: slint::Weak<AppWindow>) -> Self {
        Self {
            window,
            notifier: notify::Notifier::new(),
            clipboard: Mutex::new(None),
        }
    }
}

impl Platform for LinuxPlatform {
    fn flash_taskbar(&self) {
        if let Some(app) = self.window.upgrade() {
            app.window().with_winit_window(|w| {
                w.request_user_attention(Some(UserAttentionType::Informational));
            });
        }
    }
    fn set_progress(&self, p: Option<&Progress>) {
        let update = launcher::launcher_update(p);
        self.notifier
            .bus()
            .run(move |conn| launcher::emit(conn, update));
    }
    fn toast(&self, machine: &str, session: &str, title: &str, body: &str) {
        self.notifier.show(machine, session, title, body);
    }
    fn open_url(&self, url: &str) {
        shell::open_url(url);
    }
    fn set_clipboard(&self, text: &str) {
        let mut slot = self.clipboard.lock().unwrap();
        if slot.is_none() {
            *slot = arboard::Clipboard::new().ok();
        }
        if let Some(Err(e)) = slot.as_mut().map(|c| c.set_text(text.to_owned())) {
            tracing::debug!("copy failed: {e}");
        }
    }
    fn read_clipboard(&self) -> ClipboardSnapshot {
        crate::terminal::clip::snapshot(&clipboard::ArboardSource::default(), &std::thread::sleep)
    }
    fn bring_to_front(&self) {
        if let Some(app) = self.window.upgrade() {
            app.window().with_winit_window(|w| {
                w.set_minimized(false);
                w.focus_window();
            });
        }
    }
    fn pick_files(&self) -> Vec<PathBuf> {
        self.window
            .upgrade()
            .map(|app| file_dialog::pick_files(app.window()))
            .unwrap_or_default()
    }
}
