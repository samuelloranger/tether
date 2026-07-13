// Prevent a console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;

use futures_util::{SinkExt, StreamExt};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::mpsc;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

// The desktop client's WebSocket lives on the Rust side so it can send the
// `Authorization` header (a browser WebSocket can't). The webview talks to it via
// `invoke` (ws_connect/ws_send/ws_close) and receives frames as `ws-message` /
// `ws-closed` events. One active connection at a time — mirrors the mobile app,
// where only the active tab holds a live socket.
enum Outgoing {
    Text(String),
    Close,
}

#[derive(Default)]
struct Bridge(Mutex<Option<mpsc::UnboundedSender<Outgoing>>>);

impl Bridge {
    fn take(&self) -> Option<mpsc::UnboundedSender<Outgoing>> {
        self.0.lock().unwrap().take()
    }
    fn get(&self) -> Option<mpsc::UnboundedSender<Outgoing>> {
        self.0.lock().unwrap().clone()
    }
}

#[tauri::command]
async fn ws_connect(
    app: AppHandle,
    conn_id: String,
    url: String,
    password: String,
) -> Result<(), String> {
    // Close any existing connection first.
    if let Some(old) = app.state::<Bridge>().take() {
        let _ = old.send(Outgoing::Close);
    }

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
    *app.state::<Bridge>().0.lock().unwrap() = Some(tx);

    // Reader: forward server frames to the webview. Events are scoped by conn_id
    // so a superseded connection's late frames/close can't hit a newer socket.
    let app_read = app.clone();
    let msg_evt = format!("ws-message-{conn_id}");
    let close_evt = format!("ws-closed-{conn_id}");
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
fn ws_send(state: State<'_, Bridge>, text: String) -> Result<(), String> {
    match state.get() {
        Some(tx) => tx.send(Outgoing::Text(text)).map_err(|e| e.to_string()),
        None => Err("not connected".into()),
    }
}

#[tauri::command]
fn ws_close(state: State<'_, Bridge>) {
    if let Some(tx) = state.take() {
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
            is_updatable
        ])
        .run(tauri::generate_context!())
        .expect("error while running tether desktop");
}
