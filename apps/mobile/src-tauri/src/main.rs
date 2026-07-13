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

    // Reader: forward server frames to the webview.
    let app_read = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(msg) = read.next().await {
            match msg {
                Ok(Message::Text(t)) => {
                    let _ = app_read.emit("ws-message", t);
                }
                Ok(Message::Close(_)) | Err(_) => break,
                _ => {}
            }
        }
        let _ = app_read.emit("ws-closed", ());
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

fn main() {
    tauri::Builder::default()
        .manage(Bridge::default())
        .invoke_handler(tauri::generate_handler![ws_connect, ws_send, ws_close])
        .run(tauri::generate_context!())
        .expect("error while running tether desktop");
}
