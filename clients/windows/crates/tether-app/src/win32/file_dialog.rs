use std::path::PathBuf;

use slint::winit_030::WinitWindowAccessor;

pub fn pick_files(window: &slint::Window) -> Vec<PathBuf> {
    let dialog = rfd::FileDialog::new().set_title("Send file");
    let dialog = window
        .with_winit_window(|w| dialog.clone().set_parent(w))
        .unwrap_or(dialog);
    dialog.pick_files().unwrap_or_default()
}
