pub mod bus;
pub mod clipboard;
pub mod codec;
pub mod launcher;
pub mod network;
pub mod notify;
pub mod placement;
pub mod platform;
pub mod session;
pub mod shell;
mod system;
pub mod wayland;

pub use system::{show_error_box, system_uses_light};

use crate::terminal::model::Msg;

/// Everything the D-Bus and netlink threads report goes through the UI thread, like the Windows callbacks.
pub(crate) fn deliver(msg: Msg) {
    let _ = slint::invoke_from_event_loop(move || {
        if let Some(send) = crate::terminal::glue::current() {
            send(msg);
        }
    });
}
