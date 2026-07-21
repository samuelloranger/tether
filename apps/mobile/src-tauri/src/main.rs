// Prevent a console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::sync::Mutex;

use futures_util::{SinkExt, StreamExt};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::mpsc;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

// The desktop client's WebSockets live on the Rust side so they can send the
// `Authorization` header (a browser WebSocket can't). The webview talks to them
// via `invoke` (ws_connect/ws_send/ws_close, all keyed by `conn_id`) and receives
// frames as `ws-message-<conn_id>` / `ws-closed-<conn_id>` events. Multiple
// connections can be live at once — one per tab the mobile/desktop app keeps
// synced in the background.
enum Outgoing {
    Text(String),
    Close,
}

#[derive(Default)]
struct Bridge(Mutex<HashMap<String, mpsc::UnboundedSender<Outgoing>>>);

impl Bridge {
    fn get(&self, conn_id: &str) -> Option<mpsc::UnboundedSender<Outgoing>> {
        self.0.lock().unwrap().get(conn_id).cloned()
    }
    fn insert(&self, conn_id: String, tx: mpsc::UnboundedSender<Outgoing>) {
        self.0.lock().unwrap().insert(conn_id, tx);
    }
    fn remove(&self, conn_id: &str) -> Option<mpsc::UnboundedSender<Outgoing>> {
        self.0.lock().unwrap().remove(conn_id)
    }
}

#[tauri::command]
async fn ws_connect(
    app: AppHandle,
    conn_id: String,
    url: String,
    password: String,
) -> Result<(), String> {
    let mut req = url.into_client_request().map_err(|e| e.to_string())?;
    req.headers_mut().insert(
        "Authorization",
        format!("Bearer {password}")
            .parse()
            .map_err(|_| "invalid authorization header".to_string())?,
    );

    let (ws, _resp) = connect_async(req).await.map_err(|e| e.to_string())?;
    let (mut write, mut read) = ws.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Outgoing>();
    app.state::<Bridge>().insert(conn_id.clone(), tx);

    // Reader: forward server frames to the webview. Events are scoped by conn_id
    // so a superseded connection's late frames/close can't hit a newer socket.
    // Also drops this conn_id's entry from the Bridge map once the socket ends,
    // so a naturally-closed (server-side) connection doesn't linger.
    let app_read = app.clone();
    let msg_evt = format!("ws-message-{conn_id}");
    let close_evt = format!("ws-closed-{conn_id}");
    let close_conn_id = conn_id.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(msg) = read.next().await {
            match msg {
                Ok(Message::Text(t)) => {
                    let _ = app_read.emit(&msg_evt, t);
                }
                Ok(Message::Close(_)) | Err(_) => break,
                _ => {}
            }
        }
        app_read.state::<Bridge>().remove(&close_conn_id);
        let _ = app_read.emit(&close_evt, ());
    });

    // Writer: drain the channel into the socket.
    tauri::async_runtime::spawn(async move {
        while let Some(out) = rx.recv().await {
            match out {
                Outgoing::Text(t) => {
                    if write.send(Message::Text(t)).await.is_err() {
                        break;
                    }
                }
                Outgoing::Close => {
                    let _ = write.close().await;
                    break;
                }
            }
        }
    });

    Ok(())
}

#[tauri::command]
fn ws_send(state: State<'_, Bridge>, conn_id: String, text: String) -> Result<(), String> {
    match state.get(&conn_id) {
        Some(tx) => tx.send(Outgoing::Text(text)).map_err(|e| e.to_string()),
        None => Err("not connected".into()),
    }
}

#[tauri::command]
fn ws_close(state: State<'_, Bridge>, conn_id: String) {
    if let Some(tx) = state.remove(&conn_id) {
        let _ = tx.send(Outgoing::Close);
    }
}

// Whether this install can self-update. The Tauri updater can replace the
// macOS/Windows bundles and the Linux AppImage, but NOT a package-managed
// (.deb/.rpm) install — those must update via apt/dnf. On Linux we treat only an
// AppImage run (APPIMAGE env set) as updatable so we don't offer a doomed update.
#[tauri::command]
fn is_updatable() -> bool {
    #[cfg(target_os = "linux")]
    {
        std::env::var("APPIMAGE").is_ok()
    }
    #[cfg(not(target_os = "linux"))]
    {
        true
    }
}

// Desktop password storage backed by the OS keychain (macOS Keychain, Windows
// Credential Manager, Linux Secret Service via the `keyring` crate). Falls back
// to localStorage on the TypeScript side (secureConfig.web.ts) if any of these
// fail — e.g. no Secret Service daemon running on a minimal Linux desktop.
fn secure_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new("tether-desktop", "server-password").map_err(|e| e.to_string())
}

#[tauri::command]
fn secure_get_password() -> Result<Option<String>, String> {
    match secure_entry()?.get_password() {
        Ok(pw) => Ok(Some(pw)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn secure_set_password(password: String) -> Result<(), String> {
    secure_entry()?.set_password(&password).map_err(|e| e.to_string())
}

#[tauri::command]
fn secure_clear_password() -> Result<(), String> {
    match secure_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// Open a URL in the system browser. The opener plugin's open_url spawns
// xdg-open with THIS process's environment — inside an AppImage that includes
// the runtime-injected library paths (LD_LIBRARY_PATH, GDK/GIO/GST module
// paths pointing into the mounted AppDir), which crash the spawned browser on
// startup while the detached spawn still reports success. Strip those vars on
// Linux before spawning so the browser launches against the host's own libs.
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
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

// NOTE: the webview CSP is left null (see tauri.conf.json). This shell loads
// only the local bundled frontend — no remote page loads — so its XSS surface is
// minimal, and a strict CSP breaks react-native-web's runtime-injected
// stylesheets/fonts under webkit2gtk (blank/unstyled UI). Revisit if we ever
// render remote or untrusted HTML.
fn main() {
    // The AppImage's linuxdeploy AppRun force-exports GDK_BACKEND=x11 (an old
    // workaround for a WebKit-on-Wayland crash, resolved by the newer bundled
    // WebKit). Under XWayland, GTK doesn't draw its client-side titlebar, so the
    // window controls (close/min/max) render invisibly (tauri#13142). In a
    // Wayland session, prefer Wayland so the titlebar appears, but retain X11
    // as a fallback when the Wayland socket/backend is unavailable.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WAYLAND_DISPLAY").is_some() {
        std::env::set_var("GDK_BACKEND", "wayland,x11");
    }

    tauri::Builder::default()
        // Persist window size/position/maximized state across launches.
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        // Self-update: check GitHub releases, verify the signature, relaunch.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // Native OS dialogs (message/confirm) — replaces WebKitGTK's "JavaScript"
        // titled window.alert/confirm.
        .plugin(tauri_plugin_dialog::init())
        // Open the release page in the system browser for package-managed
        // (deb/rpm) installs that can't self-update.
        .plugin(tauri_plugin_opener::init())
        .manage(Bridge::default())
        .invoke_handler(tauri::generate_handler![
            ws_connect,
            ws_send,
            ws_close,
            is_updatable,
            secure_get_password,
            secure_set_password,
            secure_clear_password,
            open_external
        ])
        .run(tauri::generate_context!())
        .expect("error while running tether desktop");
}
