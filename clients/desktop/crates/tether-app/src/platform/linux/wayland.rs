//! The part of the desktop only the app's own Wayland connection can do: a clipboard (GNOME's
//! compositor has no data-control protocol, so no client may read the selection while unfocused)
//! and activating the window with a token. It shares winit's `wl_display` and runs its own event
//! queue on one thread, the way GTK and Qt do.

use std::ffi::c_void;
use std::io::Read;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use smithay_client_toolkit::data_device_manager::{
    DataDeviceManagerState, WritePipe,
    data_device::{DataDevice, DataDeviceHandler},
    data_offer::{DataOfferHandler, DragOffer},
    data_source::{CopyPasteSource, DataSourceHandler},
};
use smithay_client_toolkit::delegate_data_device;
use smithay_client_toolkit::reexports::client::{
    Connection, Dispatch, Proxy, QueueHandle,
    backend::{Backend, ObjectId},
    globals::{GlobalListContents, registry_queue_init},
    protocol::{
        wl_data_device::WlDataDevice,
        wl_data_device_manager::DndAction,
        wl_data_source::WlDataSource,
        wl_keyboard::{self, WlKeyboard},
        wl_pointer::{self, WlPointer},
        wl_registry::WlRegistry,
        wl_seat::{self, WlSeat},
        wl_surface::WlSurface,
    },
};
use smithay_client_toolkit::reexports::protocols::xdg::activation::v1::client::xdg_activation_v1::XdgActivationV1;

const TEXT_MIMES: [&str; 5] = [
    "text/plain;charset=utf-8",
    "text/plain",
    "UTF8_STRING",
    "STRING",
    "TEXT",
];
const IMAGE_MIMES: [&str; 4] = ["image/png", "image/jpeg", "image/bmp", "image/tiff"];
const READ_LIMIT: u64 = 64 * 1024 * 1024;
const READ_TIMEOUT: Duration = Duration::from_secs(5);

struct Shared {
    conn: Connection,
    qh: QueueHandle<State>,
    manager: DataDeviceManagerState,
    device: DataDevice,
    activation: Option<XdgActivationV1>,
    /// The last input serial the compositor sent this client; a selection request needs a recent one.
    serial: AtomicU32,
    text: Mutex<String>,
    source: Mutex<Option<CopyPasteSource>>,
    alive: AtomicBool,
}

pub struct Wayland {
    shared: Arc<Shared>,
    surface: WlSurface,
}

impl Wayland {
    /// # Safety
    /// `display` and `surface` are winit's `wl_display` and the window's `wl_surface`, which
    /// outlive this value (the window lives as long as the process).
    pub unsafe fn connect(display: *mut c_void, surface: *mut c_void) -> Option<Self> {
        let backend = unsafe { Backend::from_foreign_display(display.cast()) };
        let conn = Connection::from_backend(backend);
        let (globals, mut queue) = registry_queue_init::<State>(&conn).ok()?;
        let qh = queue.handle();
        let manager = DataDeviceManagerState::bind(&globals, &qh).ok()?;
        let seat: WlSeat = globals.bind(&qh, 1..=7, ()).ok()?;
        let activation: Option<XdgActivationV1> = globals.bind(&qh, 1..=1, ()).ok();
        let device = manager.get_data_device(&qh, &seat);
        let shared = Arc::new(Shared {
            conn: conn.clone(),
            qh,
            manager,
            device,
            activation,
            serial: AtomicU32::new(0),
            text: Mutex::new(String::new()),
            source: Mutex::new(None),
            alive: AtomicBool::new(true),
        });
        let mut state = State {
            shared: shared.clone(),
            keyboard: None,
            pointer: None,
        };
        let id = unsafe { ObjectId::from_ptr(WlSurface::interface(), surface.cast()) }.ok()?;
        let surface = WlSurface::from_id(&conn, id).ok()?;
        queue.roundtrip(&mut state).ok()?;
        std::thread::Builder::new()
            .name("wayland-clipboard".into())
            .spawn(move || {
                while queue.blocking_dispatch(&mut state).is_ok() {}
                state.shared.alive.store(false, Ordering::Relaxed);
            })
            .ok()?;
        Some(Self { shared, surface })
    }

    pub fn alive(&self) -> bool {
        self.shared.alive.load(Ordering::Relaxed)
    }

    pub fn set_text(&self, text: &str) {
        let s = &self.shared;
        *s.text.lock().unwrap() = text.to_owned();
        let source = s.manager.create_copy_paste_source(&s.qh, TEXT_MIMES);
        source.set_selection(&s.device, s.serial.load(Ordering::Relaxed));
        *s.source.lock().unwrap() = Some(source);
        let _ = s.conn.flush();
    }

    /// Hands focus to the window with a token a notification daemon passed along. False when the
    /// compositor has no `xdg_activation_v1`.
    pub fn activate(&self, token: &str) -> bool {
        let Some(a) = &self.shared.activation else {
            return false;
        };
        a.activate(token.to_owned(), &self.surface);
        self.shared.conn.flush().is_ok()
    }

    fn mimes(&self) -> Vec<String> {
        self.shared
            .device
            .data()
            .selection_offer()
            .map(|o| o.with_mime_types(<[String]>::to_vec))
            .unwrap_or_default()
    }

    fn read(&self, mime: &str) -> Option<Vec<u8>> {
        let offer = self.shared.device.data().selection_offer()?;
        let pipe = offer.receive(mime.to_owned()).ok()?;
        self.shared.conn.flush().ok()?;
        read_limited(pipe)
    }
}

/// One paste's worth of the clipboard, read through the focused window's data device.
pub struct Source<'a> {
    pub wl: &'a Wayland,
    pub files: std::cell::RefCell<Option<Option<Vec<PathBuf>>>>,
}

impl<'a> Source<'a> {
    pub fn new(wl: &'a Wayland) -> Self {
        Self {
            wl,
            files: Default::default(),
        }
    }

    fn file_list(&self) -> Option<Vec<PathBuf>> {
        self.files
            .borrow_mut()
            .get_or_insert_with(|| {
                let mimes = self.wl.mimes();
                let has = |m: &str| mimes.iter().any(|x| x == m);
                let list = if has("text/uri-list") {
                    parse_uri_list(&String::from_utf8_lossy(&self.wl.read("text/uri-list")?))
                } else if has("x-special/gnome-copied-files") {
                    let raw = self.wl.read("x-special/gnome-copied-files")?;
                    parse_uri_list(&String::from_utf8_lossy(&raw))
                } else {
                    return None;
                };
                Some(list).filter(|l| !l.is_empty())
            })
            .clone()
    }
}

impl crate::terminal::clip::ClipboardSource for Source<'_> {
    fn open(&self) -> bool {
        self.wl.alive()
    }
    fn close(&self) {}

    fn text(&self) -> Option<String> {
        if self.file_list().is_some() {
            return None;
        }
        let mimes = self.wl.mimes();
        let mime = pick(&mimes, &TEXT_MIMES)?;
        String::from_utf8(self.wl.read(mime)?).ok()
    }

    fn files(&self) -> Option<Vec<PathBuf>> {
        self.file_list()
    }

    fn png(&self) -> Option<Vec<u8>> {
        let mimes = self.wl.mimes();
        let mime = pick(&mimes, &IMAGE_MIMES)?;
        let bytes = self.wl.read(mime)?;
        if mime == "image/png" {
            return Some(bytes);
        }
        let img = image::load_from_memory(&bytes).ok()?.to_rgba8();
        super::clipboard::rgba_to_png(img.as_raw(), img.width(), img.height())
    }
}

/// The first of `wanted` the offer lists.
fn pick<'a>(offered: &[String], wanted: &[&'a str]) -> Option<&'a str> {
    wanted
        .iter()
        .copied()
        .find(|w| offered.iter().any(|o| o == w))
}

fn read_limited(mut pipe: impl Read + std::os::fd::AsFd) -> Option<Vec<u8>> {
    use nix::poll::{PollFd, PollFlags, PollTimeout, poll};
    let deadline = Instant::now() + READ_TIMEOUT;
    let mut out = Vec::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return None;
        }
        let ms = u16::try_from(left.as_millis()).unwrap_or(u16::MAX);
        let mut fds = [PollFd::new(pipe.as_fd(), PollFlags::POLLIN)];
        if poll(&mut fds, PollTimeout::from(ms)).ok()? == 0 {
            return None;
        }
        match pipe.read(&mut buf) {
            Ok(0) => return Some(out),
            Ok(n) => {
                out.extend_from_slice(&buf[..n]);
                if out.len() as u64 > READ_LIMIT {
                    return None;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(_) => return None,
        }
    }
}

/// `file://` lines of a `text/uri-list` (or GNOME's `x-special/gnome-copied-files`, whose first
/// line is the `copy` or `cut` verb). Comments and other schemes are ignored.
pub fn parse_uri_list(raw: &str) -> Vec<PathBuf> {
    raw.lines()
        .filter_map(|line| {
            let rest = line.trim().strip_prefix("file://")?;
            // An authority is empty or `localhost`; the path starts at the next slash.
            let path = &rest[rest.find('/')?..];
            Some(PathBuf::from(percent_decode(path)))
        })
        .collect()
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let hex = |c: u8| (c as char).to_digit(16);
        if b[i] == b'%'
            && let (Some(h), Some(l)) = (
                b.get(i + 1).and_then(|c| hex(*c)),
                b.get(i + 2).and_then(|c| hex(*c)),
            )
        {
            out.push((h * 16 + l) as u8);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

struct State {
    shared: Arc<Shared>,
    keyboard: Option<WlKeyboard>,
    pointer: Option<WlPointer>,
}

impl State {
    fn note(&self, serial: u32) {
        self.shared.serial.store(serial, Ordering::Relaxed);
    }
}

impl Dispatch<WlRegistry, GlobalListContents> for State {
    fn event(
        _: &mut Self,
        _: &WlRegistry,
        _: <WlRegistry as Proxy>::Event,
        _: &GlobalListContents,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}

impl Dispatch<XdgActivationV1, ()> for State {
    fn event(
        _: &mut Self,
        _: &XdgActivationV1,
        _: <XdgActivationV1 as Proxy>::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}

impl Dispatch<WlSeat, ()> for State {
    fn event(
        state: &mut Self,
        seat: &WlSeat,
        event: wl_seat::Event,
        _: &(),
        _: &Connection,
        qh: &QueueHandle<Self>,
    ) {
        let wl_seat::Event::Capabilities {
            capabilities: smithay_client_toolkit::reexports::client::WEnum::Value(caps),
        } = event
        else {
            return;
        };
        // A device can come and go (a docking station, a remote session), and a released one sends nothing.
        if caps.contains(wl_seat::Capability::Keyboard) {
            state
                .keyboard
                .get_or_insert_with(|| seat.get_keyboard(qh, ()));
        } else if let Some(k) = state.keyboard.take() {
            k.release();
        }
        if caps.contains(wl_seat::Capability::Pointer) {
            state
                .pointer
                .get_or_insert_with(|| seat.get_pointer(qh, ()));
        } else if let Some(p) = state.pointer.take() {
            p.release();
        }
    }
}

impl Dispatch<WlKeyboard, ()> for State {
    fn event(
        state: &mut Self,
        _: &WlKeyboard,
        event: wl_keyboard::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        match event {
            wl_keyboard::Event::Enter { serial, .. } | wl_keyboard::Event::Key { serial, .. } => {
                state.note(serial)
            }
            _ => {}
        }
    }
}

impl Dispatch<WlPointer, ()> for State {
    fn event(
        state: &mut Self,
        _: &WlPointer,
        event: wl_pointer::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        match event {
            wl_pointer::Event::Enter { serial, .. } | wl_pointer::Event::Button { serial, .. } => {
                state.note(serial)
            }
            _ => {}
        }
    }
}

impl DataDeviceHandler for State {
    fn enter(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        _: &WlDataDevice,
        _: f64,
        _: f64,
        _: &WlSurface,
    ) {
    }
    fn leave(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &WlDataDevice) {}
    fn motion(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &WlDataDevice, _: f64, _: f64) {}
    fn selection(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &WlDataDevice) {}
    fn drop_performed(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &WlDataDevice) {}
}

impl DataOfferHandler for State {
    fn source_actions(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        _: &mut DragOffer,
        _: DndAction,
    ) {
    }
    fn selected_action(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        _: &mut DragOffer,
        _: DndAction,
    ) {
    }
}

impl DataSourceHandler for State {
    fn accept_mime(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        _: &WlDataSource,
        _: Option<String>,
    ) {
    }

    fn send_request(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        _: &WlDataSource,
        mime: String,
        fd: WritePipe,
    ) {
        if !TEXT_MIMES.contains(&mime.as_str()) {
            return;
        }
        let text = self.shared.text.lock().unwrap().clone();
        // A reader that never drains the pipe must not stall the event queue.
        let _ = std::thread::Builder::new()
            .name("clipboard-send".into())
            .spawn(move || {
                use std::io::Write;
                let mut fd = fd;
                let _ = fd.write_all(text.as_bytes());
            });
    }

    fn cancelled(&mut self, _: &Connection, _: &QueueHandle<Self>, source: &WlDataSource) {
        let mut slot = self.shared.source.lock().unwrap();
        if slot.as_ref().is_some_and(|s| s.inner() == source) {
            *slot = None;
        }
    }

    fn dnd_dropped(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &WlDataSource) {}
    fn dnd_finished(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &WlDataSource) {}
    fn action(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &WlDataSource, _: DndAction) {}
}

delegate_data_device!(State);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_uri_list_is_its_local_files() {
        let raw = "# a comment\r\nfile:///home/u/a%20b.txt\r\nfile://localhost/tmp/c\r\nhttps://x/y\r\n\r\n";
        assert_eq!(
            parse_uri_list(raw),
            [PathBuf::from("/home/u/a b.txt"), PathBuf::from("/tmp/c")]
        );
    }

    #[test]
    fn gnome_copied_files_drops_the_verb_line() {
        assert_eq!(
            parse_uri_list("copy\nfile:///tmp/%C3%A9.png"),
            [PathBuf::from("/tmp/é.png")]
        );
    }

    #[test]
    fn a_bad_escape_stays_literal() {
        assert_eq!(parse_uri_list("file:///a%zz%4"), [PathBuf::from("/a%zz%4")]);
    }

    #[test]
    fn the_first_wanted_mime_the_offer_has_wins() {
        let offered = ["STRING".to_string(), "text/plain".to_string()];
        assert_eq!(pick(&offered, &TEXT_MIMES), Some("text/plain"));
        assert_eq!(pick(&[], &TEXT_MIMES), None);
    }
}
