use std::path::PathBuf;

use slint::winit_030::WinitWindowAccessor;

#[cfg(windows)]
pub fn pick_files(window: &slint::Window) -> Vec<PathBuf> {
    let dialog = rfd::FileDialog::new().set_title("Send file");
    let dialog = window
        .with_winit_window(|w| dialog.clone().set_parent(w))
        .unwrap_or(dialog);
    dialog.pick_files().unwrap_or_default()
}

/// rfd's synchronous portal dialog blocks its thread, which would freeze the window while it is
/// open, so this one is awaited from the UI thread's event loop.
#[cfg(target_os = "linux")]
pub async fn pick_files_async(window: &slint::Window) -> Vec<PathBuf> {
    let dialog = rfd::AsyncFileDialog::new().set_title("Send file");
    let dialog = window
        .with_winit_window(|w| dialog.clone().set_parent(w))
        .unwrap_or(dialog);
    dialog
        .pick_files()
        .await
        .map(|files| files.into_iter().map(|f| f.path().to_path_buf()).collect())
        .unwrap_or_default()
}
