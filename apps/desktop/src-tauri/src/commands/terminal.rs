use serde::{Deserialize, Serialize};
use tauri::State;
use tether_core::links::{compute_link_spans, LinkSpan};
use tether_core::pty_input::{
    cell_from_point, encode_mouse_kind, parse_osc52, CellPos, MouseMode, PixelRect,
};
use tether_core::session_cache::SessionCache;

use crate::state::SharedState;

fn cache(state: &SharedState) -> std::sync::MutexGuard<'_, SessionCache<()>> {
    state
        .session_cache
        .lock()
        .unwrap_or_else(|error| error.into_inner())
}

#[tauri::command]
pub fn core_detect_links(texts: Vec<String>, wrapped: Vec<bool>) -> Vec<Vec<LinkSpan>> {
    compute_link_spans(&texts, &wrapped)
}

#[tauri::command]
pub fn core_osc52_decode(data: String) -> Option<String> {
    parse_osc52(&data)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MouseCell {
    pub col: u32,
    pub row: u32,
}

impl From<CellPos> for MouseCell {
    fn from(pos: CellPos) -> Self {
        Self {
            col: pos.col,
            row: pos.row,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MouseCellArgs {
    pub x: f64,
    pub y: f64,
    pub left: f64,
    pub top: f64,
    pub width: f64,
    pub height: f64,
    pub cols: u32,
    pub rows: u32,
}

#[tauri::command]
pub fn core_mouse_cell(args: MouseCellArgs) -> MouseCell {
    cell_from_point(
        args.x,
        args.y,
        PixelRect {
            left: args.left,
            top: args.top,
            width: args.width,
            height: args.height,
        },
        args.cols,
        args.rows,
    )
    .into()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MouseEncodeArgs {
    pub kind: String,
    pub col: u32,
    pub row: u32,
    pub mode: String,
    pub sgr: bool,
    pub btn: u32,
    pub mods: u32,
}

#[tauri::command]
pub fn core_mouse_encode(args: MouseEncodeArgs) -> Vec<String> {
    encode_mouse_kind(
        &args.kind,
        args.col,
        args.row,
        MouseMode::parse(&args.mode),
        args.sgr,
        args.btn,
        args.mods,
    )
}

#[tauri::command]
pub fn core_cache_touch(state: State<SharedState>, id: String) -> Option<String> {
    cache(&state).touch(id, || ()).map(|evicted| evicted.id)
}

#[tauri::command]
pub fn core_cache_delete(state: State<SharedState>, id: String) {
    cache(&state).delete(&id);
}

#[tauri::command]
pub fn core_cache_ids(state: State<SharedState>) -> Vec<String> {
    cache(&state)
        .ids()
        .into_iter()
        .map(str::to_string)
        .collect()
}

/// Open an http(s) URL in the system browser.
///
/// On Linux AppImage builds the opener plugin would spawn `xdg-open` with the
/// runtime's injected library paths, which crash the browser while still
/// reporting success. Strip those vars before spawning, matching the old
/// mobile Tauri shell.
#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("only http(s) urls can be opened".into());
    }
    #[cfg(target_os = "linux")]
    {
        use std::process::{Command, Stdio};
        const APPIMAGE_VARS: [&str; 10] = [
            "APPDIR",
            "APPIMAGE",
            "LD_LIBRARY_PATH",
            "LD_PRELOAD",
            "GDK_PIXBUF_MODULE_FILE",
            "GDK_PIXBUF_MODULEDIR",
            "GIO_MODULE_DIR",
            "GST_PLUGIN_SYSTEM_PATH",
            "GST_PLUGIN_SYSTEM_PATH_1_0",
            "GTK_PATH",
        ];
        let mut cmd = Command::new("xdg-open");
        cmd.arg(&url)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        if std::env::var_os("APPIMAGE").is_some() {
            for var in APPIMAGE_VARS {
                cmd.env_remove(var);
            }
        }
        cmd.spawn().map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(target_os = "linux"))]
    {
        tauri_plugin_opener::open_url(&url, None::<&str>).map_err(|e| e.to_string())
    }
}
