use slint::ComponentHandle;
use slint::winit_030::{
    WinitWindowAccessor,
    winit::raw_window_handle::{
        HasDisplayHandle, HasWindowHandle, RawDisplayHandle, RawWindowHandle,
    },
    winit::window::UserAttentionType,
};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tether_core::osc::Progress;
use tether_core::paste::ClipboardSnapshot;

use crate::AppWindow;
use crate::platform::Platform;
use crate::platform::file_dialog;
use crate::platform::linux::{
    clipboard, launcher, notify, session, shell,
    wayland::{self, Wayland},
};

/// Every method except `read_clipboard` runs on the UI thread (`SlintUi` routes them there).
pub struct LinuxPlatform {
    window: slint::Weak<AppWindow>,
    notifier: notify::Notifier,
    // X11 serves the copied text only while a `Clipboard` lives, so one is kept for the process.
    clipboard: Mutex<Option<arboard::Clipboard>>,
    // The newest progress not yet sent: a burst of updates costs one bus job, not one each.
    progress: Arc<Mutex<Option<launcher::LauncherUpdate>>>,
    picking: Arc<AtomicBool>,
    // Set once the window exists; `None` inside means X11, or a compositor without a data device.
    wayland: OnceLock<Option<Wayland>>,
}

impl LinuxPlatform {
    pub fn new(window: slint::Weak<AppWindow>) -> Self {
        session::watch();
        Self {
            window,
            notifier: notify::Notifier::new(),
            clipboard: Mutex::new(None),
            progress: Arc::default(),
            picking: Arc::default(),
            wayland: OnceLock::new(),
        }
    }
}

impl LinuxPlatform {
    fn wayland(&self) -> Option<&Wayland> {
        self.wayland.get()?.as_ref().filter(|wl| wl.alive())
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
        let slot = self.progress.clone();
        let idle = slot.lock().unwrap().replace(update).is_none();
        if idle {
            self.notifier.bus().run(move |conn| {
                let latest = slot.lock().unwrap().take();
                if let Some(u) = latest {
                    launcher::emit(conn, u);
                }
            });
        }
    }
    fn toast(&self, machine: &str, session: &str, title: &str, body: &str) {
        self.notifier.show(machine, session, title, body);
    }
    fn open_url(&self, url: &str) {
        shell::open_url(url);
    }
    fn window_shown(&self) {
        let Some(app) = self.window.upgrade() else {
            return;
        };
        let link = app
            .window()
            .with_winit_window(|w| {
                let RawDisplayHandle::Wayland(d) = w.display_handle().ok()?.as_raw() else {
                    return None;
                };
                let RawWindowHandle::Wayland(s) = w.window_handle().ok()?.as_raw() else {
                    return None;
                };
                // SAFETY: both handles belong to winit's live Wayland window, which outlives the process's event loop.
                unsafe { Wayland::connect(d.display.as_ptr(), s.surface.as_ptr()) }
            })
            .flatten();
        let _ = self.wayland.set(link);
    }
    fn set_clipboard(&self, text: &str) {
        if let Some(wl) = self.wayland() {
            wl.set_text(text);
            return;
        }
        let mut slot = self.clipboard.lock().unwrap();
        if slot.is_none() {
            *slot = arboard::Clipboard::new().ok();
        }
        if let Some(Err(e)) = slot.as_mut().map(|c| c.set_text(text.to_owned())) {
            tracing::debug!("copy failed: {e}");
        }
    }
    fn read_clipboard(&self) -> ClipboardSnapshot {
        if let Some(wl) = self.wayland() {
            return crate::terminal::clip::snapshot(&wayland::Source::new(wl), &std::thread::sleep);
        }
        crate::terminal::clip::snapshot(&clipboard::ArboardSource::default(), &std::thread::sleep)
    }
    fn bring_to_front(&self) {
        if let Some(token) = notify::take_activation_token()
            && self.wayland().is_some_and(|wl| wl.activate(&token))
        {
            return;
        }
        if let Some(app) = self.window.upgrade() {
            app.window().with_winit_window(|w| {
                w.set_minimized(false);
                w.focus_window();
            });
        }
    }
    fn pick_files(&self, done: Box<dyn FnOnce(Vec<PathBuf>)>) {
        let Some(app) = self.window.upgrade() else {
            return done(Vec::new());
        };
        if self.picking.swap(true, Ordering::Relaxed) {
            return;
        }
        let picking = self.picking.clone();
        let spawned = slint::spawn_local(async move {
            let files = file_dialog::pick_files_async(app.window()).await;
            picking.store(false, Ordering::Relaxed);
            done(files);
        });
        if spawned.is_err() {
            self.picking.store(false, Ordering::Relaxed);
        }
    }
}
