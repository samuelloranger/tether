# Tether for Windows — M6: Terminal Page Implementation Plan

> **For the implementer:** Work through the tasks in order. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a machine card into a live terminal: connect, a tab per `zmx` session on its own PTY channel, full keyboard/mouse/clipboard input, links, resize, reconnect, sleep/lock/network handling, bell/toasts/taskbar progress, file and image send. Then package it.

**Architecture:** Every decision lives in a synchronous state machine, `TerminalModel` (`crates/tether-app/src/terminal/model/`). It takes a `Msg` plus `now: Duration` and returns `Vec<Effect>`, and it owns the per-tab `TabTerminal`s. An async `Driver` runs the effects against a `Remote` (SSH: `SshRemote<T: Transport>`, tests: `FakeRemote`) and a `UiPort` (Slint plus Win32, tests: a recorder). Win32 lives in `crates/tether-app/src/win32/*.rs` behind small traits. Every Win32 message decision is a pure function, so the model, the driver, and those decisions test on Linux with tokio's paused clock as the fake clock.

**Tech Stack:** Rust 2024, tokio 1.53, Slint 1.18.1 (`backend-winit`, `unstable-winit-030`), winit 0.30.13 (through Slint's re-export), windows 0.62.2, image 0.25.10 (PNG), M1–M5 crates. Through them: russh =0.64.1 (M3, `ring` backend), alacritty_terminal =0.26.0 and swash =0.2.10 (M4).

**Spec:** `clients/windows/SPEC.md` (sections Terminal, Sessions, Connect, Reconnect, Host key refused, Couldn't connect, Files and images, Build/CI/packaging). **Roadmap and cross-crate contract:** `docs/superpowers/plans/2026-10-05-windows-00-roadmap.md`. Executors read both.

## Global Constraints

Everything in the roadmap's Global Constraints applies. In addition, for M6:

- Copy, verbatim from the spec: status words `connecting` / `connected` / `reconnecting` / `disconnected`; empty state `No session on <machine>`, `Nothing runs until you start one.`, **New session**; kill dialog `Kill session <name>?` / `Everything running in it stops. This can't be undone.` / **Kill session**; refused page `Host key changed — refused.`, `Expected`, `Got`, **Back to Home**; couldn't-connect page actions **Retry** and **Back to Home**; disconnected capsule actions **Reconnect** and **Back to Home**; send capsule `Sending <name> (<i>/<n>)` and `Sent <remote path>`.
- Lamp: connecting / reconnecting → warning `#F2B34C`; connected → success `#6EE7A8`; disconnected → danger `#FF7050`. Light scene uses M5's light tokens. Never the agent heat ramp.
- Timings: connect timeout 10 s; transport retry ×3 at 500 ms (inside `tether_core::connect`); keepalive 15 s after auth (inside M3); reconnect backoff `RECONNECT_BACKOFF` (1 s, 2 s, 4 s); session refresh every 10 s while focused; resize settle 150 ms; bell 200 ms per session; toast 5 s per session; lock grace 15 s; capsule linger 4 s.
- Attach cap 12 (`ATTACH_CAP`). Scrollback 10 000 (inside `TabTerminal`).
- The grid is a full repaint, at most one frame per display refresh, never animated. The PTY gets one resize per settle.
- Win32 code is `#[cfg(windows)]`. Pure decision functions next to it are not, so they test on Linux.
- Each commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## What M6 consumes from earlier milestones

**Import paths.** M2 adds its modules to `tether-core` with no root re-exports. M6 therefore imports every core item through its module: `tether_core::profiles::{Machine, Auth}`, `secrets::{SecretStore, MemorySecretStore, password_account}`, `hostkey::{HostKeyStore, MemoryHostKeys, hex_fingerprint}`, `theme::{TerminalTheme, theme_named}`, `fonts::{FontFace, font_named}`, `prefs::{CursorShape, TerminalPrefs}`, `zmx::{ZmxSession, parse_ls, ls_command, attach_command, kill_command, shell_quote}`, `tabs::{TabStrip, CreateOutcome, KillStep, ATTACH_CAP}`, `osc::{Notification, Progress, ProgressState}`, `throttle::{BellThrottle, ToastThrottle, ToastDecision, wants_toast}`, `links::{LinkSpan, detect_links, merge_links, link_at, is_openable}`, `keymap::{KeyInput, NamedKey, NumpadKey, Mods, KeyContext, KeyAction, TetherCommand, encode_key}`, `paste::{ClipboardSnapshot, PasteAction, paste_action, paste_bytes, clipboard_image_name}`, `upload::{BYTE_LIMIT, UPLOADS_COMMAND, uploads_directory, remote_path, preflight, jpeg_name, PendingFile, SendQueue, CAPSULE_LINGER}`, `resize::{GridSize, ResizeDebouncer}`, `lock::{LockGrace, LockAction}`, and `connect::{connect, ConnectRequest, ConnectError, Connection, Credential, Transport, RECONNECT_BACKOFF}`. `tether-ssh` and `tether-term` re-export from their roots: `tether_ssh::{RusshTransport, RusshConnection, PtyChannel, PtyWriter, PtyEvent, ConnectionEvent}` and `tether_term::{TabTerminal, TermEvent, Cell, SelectKind, MouseMode, MouseTracking, Snapshot, Rasterizer, RenderStyle, RgbaImage, cell_metrics, grid_size, pt_to_px}`.

**Where the sibling plans depart from the roadmap contract, M6 follows them:**
- M2 `KeyInput::Char { unmodified, produced, digit: Option<u8> }`. `digit` is the top-row digit key, which drives Ctrl+Shift+1…9 and Ctrl+0.
- M2 `TabStrip::create(name, tick) -> CreateOutcome { Existing { evicted } | Created { evicted } }` adds a tab with `on_host: false`. `merge` keeps it until `zmx ls` reports it, so M6 needs no grace timer of its own. `begin_kill(name) -> KillStep { new_active, active_changed }`. `select` attaches and returns the evicted tab. `from_sessions` attaches nothing.
- M2 `ToastThrottle::offer(session, Notification, now) -> ToastDecision { Show(Notification) | Pending }`, `poll(now) -> Vec<(String, Notification)>`, `forget(session)`. Every throttle, `LockGrace`, and `ResizeDebouncer` is `Default`, and `ResizeDebouncer` adds `mark_sent(size)`.
- M2 `ClipboardSnapshot::from_formats(text, files, png)` owns the precedence (text, then files, then image). The Win32 reader only gathers formats.
- M2 `SendQueue::new(Vec<PendingFile { local, name }>, target_tab)`, plus `current()`, `on_sent(remote, bracketed) -> Vec<u8>` (the finished paste bytes), `on_failed(&str)`, `is_finished()`, `capsule()`. `preflight(is_dir, bytes) -> Result<(), String>` holds the folder and 200 MB rules. `jpeg_name` returns `Some` only for the re-encode set.
- M3: a PTY's event queue holds 1024 events. Every attached tab's reader task must keep draining it, background tabs included, or russh stalls the whole connection. Drops arrive once per connection on `RusshConnection::events()`. `close()` never fires `Dropped`.
- M4: synchronized updates (DEC 2026) buffer output until flushed. The 50 ms tick calls `TabTerminal::flush_sync()` for every tab whose `sync_deadline()` has passed. The window title comes from alacritty `TermEvent::Title`, not from `TabReports.title`. Input snaps the view back with `scroll_to_bottom()`, and `display_offset()` tells whether the view is in scrollback. The rasterizer bottom-anchors the grid inside the size it is given and clips at the top.

These are the names M6 takes from M5, as M5's plan states them under *What M5 produces for M6*:

- `crates/tether-app/ui/app.slint` exports `AppWindow` (its `title` is the literal `"Tether"`), generated through `slint::include_modules!()` in `src/main.rs`. M6 adds `in property <string> window-title: "Tether";` and changes the binding to `title: root.window-title;`, because Slint's Rust `Window` has no title setter.
- `ui/tokens.slint` exports the `Tokens` global: `background`, `surface`, `raised`, `border`, `text`, `text-secondary`, `accent`, `warning`, `success`, `danger`, `mono-font`, `radius-card`, `radius-control`, `well`, `dark`.
- `ui/components.slint` exports `ConfirmDialog` (`title`, `body`, `extra`, `action`, `confirmed()`, `cancelled()`), `PrimaryButton`, `SecondaryButton`, `DangerButton`, `IconButton` (`icon`, `clicked()`), `BackButton`, `PageChrome` (`title`, `back()`), `Lamp`, and `Pill`. The icons are `ui/icons/{gear,plus,chevron,back,tether}.svg`.
- `ui/bridge.slint` exports the enum `PageKind` and the global `AppBridge` (`page`, `escape() -> bool`, `back()`, …). M6 adds `terminal`, `host-key-refused`, and `couldnt-connect` to `PageKind`, plus the matching arms of `page_kind()` in `src/app.rs`.
- `src/router.rs`: `pub enum Page { Home, ServerForm { editing }, KeyGenerate, KeyImport, KeyPaste, Settings, SchemePicker, FontPicker }` and a stack `Router` with `new()`, `go(&self, Page)`, `back(&self)`, `home(&self)`, `current(&self) -> Page`, and `on_escape(&self) -> bool`, plus `fn escape_is_back(page: &Page) -> bool`. M6 adds `Page::Terminal`, `Page::HostKeyRefused`, and `Page::CouldntConnect`, all three on the `false` side of `escape_is_back`. The terminal page gives Esc to the PTY. The two connect pages handle Esc themselves (a `FocusScope` that sends **Back to Home**), so the driver is told to close. Settings opened from the terminal (`router.go(Page::Settings)`) returns to it with `back()`.
- `src/app.rs`: `pub struct App { pub ui: AppWindow, pub state: Rc<RefCell<AppState>>, pub router: Router, pub runtime: tokio::runtime::Runtime, … }` behind `Rc<App>`, with `refresh_router(&self)`, `on_prefs_changed(&self)` (M6 extends it to restyle live tabs), and `on_winit_event(self: &Rc<Self>, event: &WindowEvent)`, the single `on_winit_window_event` registration. M6 changes `on_winit_event` to take the winit window too and to return `slint::winit_030::EventResult`. M6's arms run first, and M5's arms then run and return `Propagate`.
- `src/open_machine.rs`: `pub fn on_open_machine(app: &Rc<App>, machine: Machine)`, a logging stub that M6 replaces.
- `src/vm/app_state.rs`: `AppState { data, profiles, keys, prefs, secrets: Arc<dyn SecretStore>, hostkeys: Arc<dyn HostKeyStore> }` with `save_prefs(&self)`.
- `src/platform/`: `pub fn hwnd_of(window: &slint::Window) -> Option<isize>`. M6's `src/win32/` is a separate module; do not merge them.
- Crates M5 already depends on: `rfd` 0.15, used here for **Send file…** (it drives `IFileOpenDialog` with multi-select), and `arboard` 3.6, used here for copying text.

## Review Focus

Inputs the spec implies but happy-path tests don't cover. Each line has a pinned test in the task named.

1. **The window is dragged to a monitor with a different scale factor.** The font keeps its physical point size, the atlas is re-keyed by M4 (style `size_px` changes), every grid redraws locally at once, and the PTYs get one resize after the 150 ms settle, not one per intermediate DPI step. (Task 7: `scale_change_recomputes_px_and_resizes_once`.)
2. **The clipboard is held open by another app, or holds a huge screenshot.** `OpenClipboard` fails, so the reader retries 5 × 20 ms and then pastes nothing: no crash, no partial paste, no `0x16`. An 8K DIB converts to PNG off the UI thread and still passes through the 200 MB check. (Task 10: `busy_clipboard_pastes_nothing`, `converts_8k_dib_and_checks_limit`.)
3. **A burst of PTY output in every background tab** (12 tabs running `yes`). The UI must stay responsive. Frames coalesce to one in flight, and background output never triggers a render. (Task 4: `frames_coalesce_while_in_flight`; Task 8: `background_output_does_not_render`.)
4. **A session created on Tether, then `zmx ls` runs before zmx registers it.** The new tab must not flicker away and detach. It stays because M2 keeps an `on_host: false` tab through `merge`, and the refresh after the attach picks it up. (Task 3: `new_session_survives_early_refresh`.)
5. **The network drops while a send is in flight.** The queue stops with the failing file named. Earlier pastes stay. No paste goes to a different tab after reconnect, and input stays dropped until `connected`. (Task 14: `drop_mid_send_stops_queue_and_keeps_target`.)

## File structure

```
clients/windows/crates/tether-app/
  Cargo.toml                         (modify: deps)
  ui/terminal.slint                  (create: header, tab strip, well, capsules, menus)
  ui/connect_pages.slint             (create: refused + couldn't connect)
  ui/app.slint                       (modify: import + route the three pages)
  src/main.rs                        (modify: modules, platform, glue::init, close request)
  src/app.rs                         (modify: page kinds, winit arms, prefs restyle)
  src/open_machine.rs                (modify: real connect flow)
  src/router.rs                      (modify: three pages, Esc rules)
  ui/bridge.slint                    (modify: three PageKind values)
  src/terminal/mod.rs                (create)
  src/terminal/status.rs             (create: ConnStatus, Lamp)
  src/terminal/remote.rs             (create: Remote, PtySink, SessionConn, SshRemote)
  src/terminal/testkit.rs            (create, cfg(test): FakeTransport, FakeConn, FakeRemote, fixtures)
  src/terminal/model/mod.rs          (create: TerminalModel, Msg, Effect, UiEffect, views)
  src/terminal/model/tabs.rs         (create: refresh, merge, new session, kill, switching)
  src/terminal/model/reconnect.rs    (create: drop, backoff, triggers, lock)
  src/terminal/model/input.rs        (create: keys, IME, paste, copy, font size)
  src/terminal/model/events.rs       (create: TermEvent handling: bell, title, OSC 52, toasts, progress)
  src/terminal/model/send.rs         (create: send queue in the model)
  src/terminal/driver.rs             (create: async effect executor)
  src/terminal/frame.rs              (create: FramePacer, render thread)
  src/terminal/geometry.rs           (create: px ↔ grid, bottom anchor, pointer → cell)
  src/terminal/keys.rs               (create: winit key → tether_core::KeyInput)
  src/terminal/mouse.rs              (create: mouse encoding, click counter, wheel)
  src/terminal/clip.rs               (create: clipboard format choice + retry)
  src/terminal/dib.rs                (create: DIB/DIBV5 → PNG)
  src/terminal/files.rs              (create: prepare files: folders, limit, image rule)
  src/terminal/ui_port.rs            (create: UiPort trait + Slint implementation)
  src/terminal/glue.rs               (create: Slint callbacks + winit events → Msg)
  src/win32/mod.rs                   (create)
  src/win32/wndproc.rs               (create: subclass; SC_KEYMENU, power, session lock)
  src/win32/clipboard.rs             (create: clipboard reader)
  src/win32/taskbar.rs               (create: ITaskbarList3 + FlashWindowEx)
  src/win32/shell.rs                 (create: ShellExecuteW, foreground)
  src/win32/toast.rs                 (create: WinRT toasts)
  src/win32/aumid.rs                 (create: AUMID + Start-menu shortcut)
  src/win32/network.rs               (create: NetworkStatusChanged + route probe)
  src/win32/wic.rs                   (create: WIC decode → JPEG 0.9)
  src/win32/file_dialog.rs           (create: Send file… picker via rfd)
  src/win32/platform.rs              (create: WindowsPlatform)
  src/terminal/model/pointer.rs      (create: mouse, wheel, links in the model)
clients/windows/packaging/
  AppxManifest.xml                   (create)
  package.ps1                        (create)
  check-package.ps1                  (create)
.github/workflows/ci.yml             (modify: release build + artifacts)
```

---

### Task 1: Remote abstraction, SSH implementation, and test kit

**Files:**
- Modify: `clients/windows/crates/tether-app/Cargo.toml`
- Create: `clients/windows/crates/tether-app/src/terminal/mod.rs`, `status.rs`, `remote.rs`, `testkit.rs`
- Modify: `clients/windows/crates/tether-app/src/main.rs` (add `mod terminal;`)

**Interfaces:**
- Consumes: `tether_core::connect::{connect, ConnectRequest, ConnectError, Connection, Transport}`, `profiles::Machine`, `hostkey::HostKeyStore`, `secrets::SecretStore`, `zmx::{ZmxSession, parse_ls, ls_command, kill_command}`, `upload::{UPLOADS_COMMAND, uploads_directory}`, `resize::GridSize`; `tether_ssh::{RusshTransport, RusshConnection, PtyWriter, PtyEvent, ConnectionEvent}`.
- Produces:
  - `pub enum ConnStatus { Connecting, Connected, Reconnecting, Disconnected }` with `fn word(self) -> &'static str` and `fn lamp(self) -> Lamp`; `pub enum Lamp { Warning, Success, Danger }`.
  - `pub trait PtySink: Clone + Send + Sync + 'static { fn write(&self, bytes: Vec<u8>) -> impl Future<Output = ()> + Send; fn resize(&self, size: GridSize) -> impl Future<Output = ()> + Send; fn close(&self) -> impl Future<Output = ()> + Send; }`
  - `pub trait SessionConn: Connection + Sync + 'static { type Sink: PtySink; fn open_pty(&self, size: GridSize) -> impl Future<Output = Result<(Self::Sink, mpsc::Receiver<PtyEvent>), ConnectError>> + Send; fn scp_send(&self, remote_path: &str, bytes: &[u8]) -> impl Future<Output = Result<(), ConnectError>> + Send; fn drops(&self) -> broadcast::Receiver<ConnectionEvent>; fn close(&self) -> impl Future<Output = ()> + Send; }`
  - `pub trait Remote: Send + Sync + 'static { type Sink: PtySink; fn open(&self) -> impl Future<Output = Result<broadcast::Receiver<ConnectionEvent>, ConnectError>> + Send; fn ls(&self) -> impl Future<Output = Result<Vec<ZmxSession>, ConnectError>> + Send; fn kill(&self, name: &str) -> impl Future<Output = Result<(), ConnectError>> + Send; fn uploads_dir(&self) -> impl Future<Output = Option<String>> + Send; fn attach(&self, name: &str, size: GridSize) -> impl Future<Output = Result<(Self::Sink, mpsc::Receiver<PtyEvent>), ConnectError>> + Send; fn upload(&self, remote_path: &str, bytes: Vec<u8>) -> impl Future<Output = Result<(), ConnectError>> + Send; fn close(&self) -> impl Future<Output = ()> + Send; }`
  - `pub struct SshRemote<T: Transport>` with `SshRemote::new(transport: T, machine: Machine, hostkeys: Arc<dyn HostKeyStore>, secrets: Arc<dyn SecretStore>)`, implementing `Remote` when `T::Conn: SessionConn`.
  - `impl PtySink for tether_ssh::PtyWriter`, `impl SessionConn for tether_ssh::RusshConnection`.
  - testkit (`#[cfg(test)]`): `FakeTransport`, `FakeConn`, `FakeSink`, `FakeRemote`, `fn machine() -> Machine`, `fn session(name: &str, created: i64) -> ZmxSession`, `fn grid() -> GridSize`.

- [ ] **Step 1: Add dependencies**

Append to `clients/windows/crates/tether-app/Cargo.toml` (keep M5's entries):

```toml
[dependencies]
tether-ssh = { path = "../tether-ssh" }
tether-term = { path = "../tether-term" }
tokio = { version = "1.53", features = ["rt-multi-thread", "macros", "sync", "time"] }
image = { version = "0.25.10", default-features = false, features = ["png"] }
zeroize = "1"
slint = { version = "1.18.1", default-features = false, features = ["std", "backend-winit", "renderer-femtovg", "renderer-software", "compat-1-2", "unstable-winit-030"] }

[target.'cfg(windows)'.dependencies]
windows = { version = "0.62.2", features = [
  "Win32_Foundation", "Win32_UI_WindowsAndMessaging", "Win32_UI_Shell", "Win32_UI_Shell_Common",
  "Win32_UI_Shell_PropertiesSystem", "Win32_System_Com", "Win32_System_Com_StructuredStorage",
  "Win32_System_DataExchange", "Win32_System_Memory", "Win32_System_Ole", "Win32_System_Power",
  "Win32_System_RemoteDesktop", "Win32_System_Variant", "Win32_Graphics_Gdi", "Win32_Graphics_Imaging",
  "Win32_Storage_Packaging_Appx", "Win32_Storage_EnhancedStorage", "Win32_NetworkManagement_IpHelper",
  "Win32_Networking_WinSock", "Win32_UI_Input_KeyboardAndMouse",
  "Data_Xml_Dom", "UI_Notifications", "Networking_Connectivity", "Foundation",
] }

[dev-dependencies]
tokio = { version = "1.53", features = ["rt", "macros", "sync", "time", "test-util"] }
```

If M5's `slint` line already exists, merge the features into it, so there is a single `slint` entry.

- [ ] **Step 2: Write the failing tests for status and `SshRemote`**

`src/terminal/status.rs`:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnStatus { Connecting, Connected, Reconnecting, Disconnected }

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lamp { Warning, Success, Danger }

impl ConnStatus {
    pub fn word(self) -> &'static str {
        match self {
            Self::Connecting => "connecting",
            Self::Connected => "connected",
            Self::Reconnecting => "reconnecting",
            Self::Disconnected => "disconnected",
        }
    }

    pub fn lamp(self) -> Lamp {
        match self {
            Self::Connecting | Self::Reconnecting => Lamp::Warning,
            Self::Connected => Lamp::Success,
            Self::Disconnected => Lamp::Danger,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn words_and_lamps_follow_the_ios_connection_lamp() {
        assert_eq!(ConnStatus::Connecting.word(), "connecting");
        assert_eq!(ConnStatus::Reconnecting.lamp(), Lamp::Warning);
        assert_eq!(ConnStatus::Connected.lamp(), Lamp::Success);
        assert_eq!(ConnStatus::Disconnected.lamp(), Lamp::Danger);
    }
}
```

`src/terminal/testkit.rs`. These fakes are the tether-core `Transport` / `Connection` fakes the SSH layer is tested against, plus a `FakeRemote` for the driver:

```rust
#![cfg(test)]
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tether_core::connect::{ConnectError, Connection, Credential, Transport};
use tether_core::profiles::{Auth, Machine};
use tether_core::resize::GridSize;
use tether_core::zmx::ZmxSession;
use tether_ssh::{ConnectionEvent, PtyEvent};
use tokio::sync::{broadcast, mpsc};
use uuid::Uuid;

use super::remote::{PtySink, Remote, SessionConn};

pub fn machine() -> Machine {
    Machine { id: Uuid::nil(), name: "devbox".into(), host: "devbox.lan".into(), port: 22, user: "sam".into(), auth: Auth::Password }
}

pub fn session(name: &str, created: i64) -> ZmxSession {
    ZmxSession { name: name.into(), pid: 1, clients: 0, created, cwd: format!("file://devbox/home/sam/{name}") }
}

pub fn grid() -> GridSize { GridSize { cols: 80, rows: 24, width_px: 640, height_px: 384 } }

#[derive(Clone, Default)]
pub struct FakeSink { pub log: Arc<Mutex<Vec<String>>> }

impl PtySink for FakeSink {
    async fn write(&self, bytes: Vec<u8>) { self.log.lock().unwrap().push(format!("write {}", String::from_utf8_lossy(&bytes))); }
    async fn resize(&self, size: GridSize) { self.log.lock().unwrap().push(format!("resize {}x{}", size.cols, size.rows)); }
    async fn close(&self) { self.log.lock().unwrap().push("close".into()); }
}

/// Scripted dials: each `dial` pops the next result; `exec` answers from `exec_replies` by prefix.
#[derive(Clone, Default)]
pub struct FakeTransport {
    pub dials: Arc<Mutex<VecDeque<Result<(), ConnectError>>>>,
    pub host_key: [u8; 32],
    pub exec_replies: Arc<Mutex<HashMap<String, Result<String, ConnectError>>>>,
    pub log: Arc<Mutex<Vec<String>>>,
}

pub struct FakeConn { t: FakeTransport, drops: broadcast::Sender<ConnectionEvent> }

impl Transport for FakeTransport {
    type Conn = FakeConn;
    async fn dial(&self, host: &str, port: u16, _timeout: Duration) -> Result<FakeConn, ConnectError> {
        self.log.lock().unwrap().push(format!("dial {host}:{port}"));
        self.dials.lock().unwrap().pop_front().unwrap_or(Ok(()))?;
        Ok(FakeConn { t: self.clone(), drops: broadcast::channel(4).0 })
    }
    async fn sleep(&self, _d: Duration) {}
}

impl Connection for FakeConn {
    fn host_key_sha256(&self) -> [u8; 32] { self.t.host_key }
    async fn authenticate(&mut self, user: &str, _cred: Credential) -> Result<(), ConnectError> {
        self.t.log.lock().unwrap().push(format!("auth {user}"));
        Ok(())
    }
    fn start_keepalive(&mut self, _every: Duration) {}
    async fn exec(&self, command: &str) -> Result<String, ConnectError> {
        self.t.log.lock().unwrap().push(format!("exec {command}"));
        let replies = self.t.exec_replies.lock().unwrap();
        replies.iter().find(|(k, _)| command.starts_with(k.as_str())).map(|(_, v)| v.clone()).unwrap_or(Ok(String::new()))
    }
}

impl SessionConn for FakeConn {
    type Sink = FakeSink;
    async fn open_pty(&self, size: GridSize) -> Result<(FakeSink, mpsc::Receiver<PtyEvent>), ConnectError> {
        self.t.log.lock().unwrap().push(format!("pty {}x{}", size.cols, size.rows));
        let (_tx, rx) = mpsc::channel(8);
        Ok((FakeSink::default(), rx))
    }
    async fn scp_send(&self, remote_path: &str, bytes: &[u8]) -> Result<(), ConnectError> {
        self.t.log.lock().unwrap().push(format!("scp {remote_path} {}", bytes.len()));
        Ok(())
    }
    fn drops(&self) -> broadcast::Receiver<ConnectionEvent> { self.drops.subscribe() }
    async fn close(&self) { self.t.log.lock().unwrap().push("close".into()); }
}

/// Driver-level fake: every PTY gets a sender the test can push bytes into.
pub struct FakeRemote {
    pub log: Mutex<Vec<String>>,
    pub opens: Mutex<VecDeque<Result<(), ConnectError>>>,
    pub sessions: Mutex<Result<Vec<ZmxSession>, ConnectError>>,
    pub ptys: Mutex<HashMap<String, (FakeSink, mpsc::Sender<PtyEvent>)>>,
    pub drop_tx: broadcast::Sender<ConnectionEvent>,
    pub uploads_dir: Mutex<Option<String>>,
    pub upload_results: Mutex<VecDeque<Result<(), ConnectError>>>,
}

impl Default for FakeRemote {
    fn default() -> Self {
        Self {
            log: Mutex::default(), opens: Mutex::default(), sessions: Mutex::new(Ok(vec![])),
            ptys: Mutex::default(), drop_tx: broadcast::channel(4).0,
            uploads_dir: Mutex::new(Some("/home/sam/.tether/uploads".into())), upload_results: Mutex::default(),
        }
    }
}

impl FakeRemote {
    pub fn log(&self) -> Vec<String> { self.log.lock().unwrap().clone() }
    pub fn sink(&self, name: &str) -> FakeSink { self.ptys.lock().unwrap()[name].0.clone() }
    pub async fn push(&self, name: &str, bytes: &[u8]) {
        let tx = self.ptys.lock().unwrap()[name].1.clone();
        tx.send(PtyEvent::Data(bytes.to_vec())).await.unwrap();
    }
    pub fn drop_connection(&self) { let _ = self.drop_tx.send(ConnectionEvent::Dropped); }
}

impl Remote for FakeRemote {
    type Sink = FakeSink;
    async fn open(&self) -> Result<broadcast::Receiver<ConnectionEvent>, ConnectError> {
        self.log.lock().unwrap().push("open".into());
        self.opens.lock().unwrap().pop_front().unwrap_or(Ok(()))?;
        Ok(self.drop_tx.subscribe())
    }
    async fn ls(&self) -> Result<Vec<ZmxSession>, ConnectError> {
        self.log.lock().unwrap().push("ls".into());
        self.sessions.lock().unwrap().clone()
    }
    async fn kill(&self, name: &str) -> Result<(), ConnectError> {
        self.log.lock().unwrap().push(format!("kill {name}"));
        Ok(())
    }
    async fn uploads_dir(&self) -> Option<String> { self.uploads_dir.lock().unwrap().clone() }
    async fn attach(&self, name: &str, size: GridSize) -> Result<(FakeSink, mpsc::Receiver<PtyEvent>), ConnectError> {
        self.log.lock().unwrap().push(format!("attach {name} {}x{}", size.cols, size.rows));
        let (tx, rx) = mpsc::channel(64);
        let sink = FakeSink::default();
        self.ptys.lock().unwrap().insert(name.into(), (sink.clone(), tx));
        Ok((sink, rx))
    }
    async fn upload(&self, remote_path: &str, bytes: Vec<u8>) -> Result<(), ConnectError> {
        self.log.lock().unwrap().push(format!("upload {remote_path} {}", bytes.len()));
        self.upload_results.lock().unwrap().pop_front().unwrap_or(Ok(()))
    }
    async fn close(&self) { self.log.lock().unwrap().push("close".into()); }
}
```

Tests at the bottom of `src/terminal/remote.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::terminal::testkit::*;
    use tether_core::hostkey::{hex_fingerprint, HostKeyStore, MemoryHostKeys};
    use tether_core::secrets::{password_account, MemorySecretStore, SecretStore};
    use tether_core::zmx::kill_command;

    fn remote(t: FakeTransport) -> SshRemote<FakeTransport> {
        let secrets = MemorySecretStore::default();
        secrets.set(&password_account(machine().id), b"hunter2").unwrap();
        SshRemote::new(t, machine(), Arc::new(MemoryHostKeys::default()), Arc::new(secrets))
    }

    #[tokio::test]
    async fn open_dials_terminal_then_control() {
        let t = FakeTransport::default();
        let r = remote(t.clone());
        r.open().await.unwrap();
        let log = t.log.lock().unwrap().clone();
        assert_eq!(log.iter().filter(|l| l.starts_with("dial devbox.lan:22")).count(), 2);
    }

    #[tokio::test]
    async fn ls_runs_zmx_ls_on_control_and_parses() {
        let t = FakeTransport::default();
        t.exec_replies.lock().unwrap().insert(
            "~/.local/bin/zmx ls".into(),
            Ok("name=default\tpid=10\tclients=0\tcreated=100\tcwd=/home/sam\n".into()),
        );
        let r = remote(t);
        r.open().await.unwrap();
        let s = r.ls().await.unwrap();
        assert_eq!(s.len(), 1);
        assert_eq!(s[0].name, "default");
    }

    #[tokio::test]
    async fn kill_quotes_the_name() {
        let t = FakeTransport::default();
        let r = remote(t.clone());
        r.open().await.unwrap();
        r.kill("it's $(x)").await.unwrap();
        assert!(t.log.lock().unwrap().contains(&format!("exec {}", kill_command("it's $(x)"))));
    }

    #[tokio::test]
    async fn uploads_dir_requires_the_marker() {
        let t = FakeTransport::default();
        t.exec_replies.lock().unwrap().insert("mkdir -p".into(), Ok("motd line\n/home/sam/.tether/uploads\n__TETHER_UPLOADS_OK__\n".into()));
        let r = remote(t.clone());
        r.open().await.unwrap();
        assert_eq!(r.uploads_dir().await.as_deref(), Some("/home/sam/.tether/uploads"));
    }

    #[tokio::test]
    async fn upload_uses_its_own_connection() {
        let t = FakeTransport::default();
        let r = remote(t.clone());
        r.open().await.unwrap();
        r.upload("/home/sam/.tether/uploads/a.png", vec![1, 2, 3]).await.unwrap();
        let log = t.log.lock().unwrap().clone();
        assert_eq!(log.iter().filter(|l| l.starts_with("dial")).count(), 3);
        assert!(log.contains(&"scp /home/sam/.tether/uploads/a.png 3".to_string()));
    }

    #[tokio::test]
    async fn host_key_change_surfaces_as_refused() {
        let t = FakeTransport::default();
        let hostkeys = Arc::new(MemoryHostKeys::default());
        hostkeys.pin("devbox.lan", 22, &hex_fingerprint(&[9; 32]));
        let secrets = Arc::new(MemorySecretStore::default());
        secrets.set(&password_account(machine().id), b"x").unwrap();
        let r = SshRemote::new(t, machine(), hostkeys, secrets);
        assert!(matches!(r.open().await, Err(ConnectError::HostKeyChanged { .. })));
    }
}
```

- [ ] **Step 3: Run the tests and watch them fail**

Run: `cargo test -p tether-app terminal::` (from `clients/windows`)
Expected: FAIL to compile, with `cannot find type SshRemote` and `unresolved import super::remote`.

- [ ] **Step 4: Implement `remote.rs` and `mod.rs`**

`src/terminal/mod.rs`:

```rust
pub mod remote;
pub mod status;
#[cfg(test)]
pub mod testkit;
```

`src/terminal/remote.rs`:

```rust
use std::future::Future;
use std::sync::Arc;
use tether_core::connect::{connect, ConnectError, ConnectRequest, Connection, Transport};
use tether_core::hostkey::HostKeyStore;
use tether_core::profiles::Machine;
use tether_core::resize::GridSize;
use tether_core::secrets::SecretStore;
use tether_core::upload::{uploads_directory, UPLOADS_COMMAND};
use tether_core::zmx::{kill_command, ls_command, parse_ls, ZmxSession};
use tether_ssh::{ConnectionEvent, PtyEvent};
use tokio::sync::{broadcast, mpsc, Mutex};

pub trait PtySink: Clone + Send + Sync + 'static {
    fn write(&self, bytes: Vec<u8>) -> impl Future<Output = ()> + Send;
    fn resize(&self, size: GridSize) -> impl Future<Output = ()> + Send;
    fn close(&self) -> impl Future<Output = ()> + Send;
}

pub trait SessionConn: Connection + Sync + 'static {
    type Sink: PtySink;
    fn open_pty(&self, size: GridSize) -> impl Future<Output = Result<(Self::Sink, mpsc::Receiver<PtyEvent>), ConnectError>> + Send;
    fn scp_send(&self, remote_path: &str, bytes: &[u8]) -> impl Future<Output = Result<(), ConnectError>> + Send;
    fn drops(&self) -> broadcast::Receiver<ConnectionEvent>;
    fn close(&self) -> impl Future<Output = ()> + Send;
}

pub trait Remote: Send + Sync + 'static {
    type Sink: PtySink;
    fn open(&self) -> impl Future<Output = Result<broadcast::Receiver<ConnectionEvent>, ConnectError>> + Send;
    fn ls(&self) -> impl Future<Output = Result<Vec<ZmxSession>, ConnectError>> + Send;
    fn kill(&self, name: &str) -> impl Future<Output = Result<(), ConnectError>> + Send;
    fn uploads_dir(&self) -> impl Future<Output = Option<String>> + Send;
    fn attach(&self, name: &str, size: GridSize) -> impl Future<Output = Result<(Self::Sink, mpsc::Receiver<PtyEvent>), ConnectError>> + Send;
    fn upload(&self, remote_path: &str, bytes: Vec<u8>) -> impl Future<Output = Result<(), ConnectError>> + Send;
    fn close(&self) -> impl Future<Output = ()> + Send;
}

/// The iOS connection split: one terminal connection for every PTY, one control
/// connection for exec, and a fresh connection per upload.
pub struct SshRemote<T: Transport> {
    transport: T,
    request: ConnectRequest,
    hostkeys: Arc<dyn HostKeyStore>,
    secrets: Arc<dyn SecretStore>,
    terminal: Mutex<Option<Arc<T::Conn>>>,
    control: Mutex<Option<Arc<T::Conn>>>,
}

impl<T: Transport> SshRemote<T> {
    pub fn new(transport: T, machine: Machine, hostkeys: Arc<dyn HostKeyStore>, secrets: Arc<dyn SecretStore>) -> Self {
        Self { transport, request: ConnectRequest { machine }, hostkeys, secrets, terminal: Mutex::new(None), control: Mutex::new(None) }
    }

    async fn dial(&self) -> Result<T::Conn, ConnectError> {
        connect(&self.transport, &self.request, self.hostkeys.as_ref(), self.secrets.as_ref()).await
    }

    async fn control(&self) -> Result<Arc<T::Conn>, ConnectError> {
        self.control.lock().await.clone().ok_or(ConnectError::Transport("not connected".into()))
    }
}

impl<T> Remote for SshRemote<T>
where
    T: Transport + 'static,
    T::Conn: SessionConn,
{
    type Sink = <T::Conn as SessionConn>::Sink;

    async fn open(&self) -> Result<broadcast::Receiver<ConnectionEvent>, ConnectError> {
        let terminal = Arc::new(self.dial().await?);
        let control = Arc::new(self.dial().await?);
        let drops = terminal.drops();
        *self.terminal.lock().await = Some(terminal);
        *self.control.lock().await = Some(control);
        Ok(drops)
    }

    async fn ls(&self) -> Result<Vec<ZmxSession>, ConnectError> {
        Ok(parse_ls(&self.control().await?.exec(&ls_command()).await?))
    }

    async fn kill(&self, name: &str) -> Result<(), ConnectError> {
        self.control().await?.exec(&kill_command(name)).await.map(|_| ())
    }

    async fn uploads_dir(&self) -> Option<String> {
        let out = self.control().await.ok()?.exec(UPLOADS_COMMAND).await.ok()?;
        uploads_directory(&out)
    }

    async fn attach(&self, _name: &str, size: GridSize) -> Result<(Self::Sink, mpsc::Receiver<PtyEvent>), ConnectError> {
        let conn = self.terminal.lock().await.clone().ok_or(ConnectError::Transport("not connected".into()))?;
        conn.open_pty(size).await
    }

    async fn upload(&self, remote_path: &str, bytes: Vec<u8>) -> Result<(), ConnectError> {
        let conn = self.dial().await?;
        let result = conn.scp_send(remote_path, &bytes).await;
        conn.close().await;
        result
    }

    async fn close(&self) {
        for slot in [&self.terminal, &self.control] {
            if let Some(conn) = slot.lock().await.take() {
                conn.close().await;
            }
        }
    }
}

impl PtySink for tether_ssh::PtyWriter {
    async fn write(&self, bytes: Vec<u8>) { tether_ssh::PtyWriter::write(self, &bytes).await }
    async fn resize(&self, size: GridSize) { tether_ssh::PtyWriter::resize(self, size).await }
    async fn close(&self) { tether_ssh::PtyWriter::close(self).await }
}

impl SessionConn for tether_ssh::RusshConnection {
    type Sink = tether_ssh::PtyWriter;
    async fn open_pty(&self, size: GridSize) -> Result<(Self::Sink, mpsc::Receiver<PtyEvent>), ConnectError> {
        let ch = tether_ssh::RusshConnection::open_pty(self, size).await?;
        Ok((ch.writer, ch.events))
    }
    async fn scp_send(&self, remote_path: &str, bytes: &[u8]) -> Result<(), ConnectError> {
        tether_ssh::RusshConnection::scp_send(self, remote_path, bytes).await
    }
    fn drops(&self) -> broadcast::Receiver<ConnectionEvent> { self.events() }
    async fn close(&self) { tether_ssh::RusshConnection::close(self).await }
}
```

Add `mod terminal;` to `src/main.rs`.

- [ ] **Step 5: Run the tests and watch them pass**

Run: `cargo test -p tether-app terminal::`
Expected: PASS, 7 tests (1 status + 6 remote).

- [ ] **Step 6: Commit**

```bash
git add clients/windows/crates/tether-app
git commit -m "feat(windows): remote abstraction over the SSH transport

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: TerminalModel: open, first tab, empty state, failure pages

**Files:**
- Create: `clients/windows/crates/tether-app/src/terminal/model/mod.rs`
- Modify: `clients/windows/crates/tether-app/src/terminal/mod.rs` (add `pub mod model;`)

**Interfaces:**
- Consumes: `tether_core::tabs::TabStrip`, `connect::ConnectError`, `zmx::ZmxSession`, `resize::{GridSize, ResizeDebouncer}`, `profiles::Machine`, `throttle::{BellThrottle, ToastThrottle}`, `lock::LockGrace`, `osc::Progress`, `keymap::{KeyInput, Mods}`, `paste::ClipboardSnapshot`; `tether_term::{TabTerminal, TermEvent}`; `ConnStatus` (Task 1).
- Produces (later tasks extend these enums only where they say so; Task 11 adds `Msg::CopySelection` and `Msg::PasteClipboard`):

```rust
pub enum Screen { Terminal, Refused { expected: String, got: String }, Failed { sentence: String } }
pub enum Msg {
    Opened, OpenFailed(ConnectError), Ls(Result<Vec<ZmxSession>, ConnectError>),
    Attached { name: String }, AttachFailed { name: String },
    PtyData { name: String, bytes: Vec<u8> }, PtyClosed { name: String }, Dropped, Tick,
    Focus(bool), Modifiers(Mods),
    SelectTab(String), TabShortcut(TabJump), NewSessionBegin, NewSessionCommit(String), NewSessionCancel,
    KillRequested(String), KillConfirmed, KillCancelled, KillDone,
    Key { input: KeyInput, mods: Mods }, Ime(String), Paste { clip: ClipboardSnapshot, now_unix: i64 },
    Mouse(crate::terminal::mouse::MouseMsg), Wheel { delta_px: f32, mods: Mods, x_px: f32, y_px: f32 },
    WellResized { width_px: u32, height_px: u32, scale: f32 }, StyleChanged(TermStyle),
    Locked, Unlocked, Resumed, Network { online: bool, route_changed: bool },
    ToastClicked(String), Retry, Reconnect, Back, RedialDue { generation: u64 },
    DroppedFiles(Vec<PathBuf>), SendFiles(Vec<PathBuf>),
    SendStarted { names: Vec<String> }, SendFileStarted { index: usize },
    SendFileDone { remote: String }, SendFileFailed { reason: String },
}
pub enum TabJump { Next, Prev, Position(u8), Last }
pub enum Effect {
    Open, Close, DropConnection, Ls, Kill { name: String },
    Attach { name: String, id: u64, size: GridSize }, Detach { name: String },
    Write { name: String, bytes: Vec<u8> }, ResizeAll(GridSize),
    ScheduleRedial { after: Duration, generation: u64 },
    StartSend(SendJob), Redraw, Ui(UiEffect),
}
pub enum UiEffect {
    Navigate(Screen), Home, LampFlash, FlashTaskbar, BringToFront, SetTitle(String),
    SetClipboard(String), ReadClipboard, OpenUrl(String),
    Toast { session: String, title: String, body: String }, Taskbar(Option<Progress>),
    FontStep(FontStep), Pointer(PointerShape), Tooltip(Option<String>), Menu(MenuRequest), PickFiles,
}
pub struct TerminalModel { /* below */ }
impl TerminalModel {
    pub fn new(machine: Machine, style: TermStyle, size: GridSize) -> (Self, Vec<Effect>);
    pub fn handle(&mut self, msg: Msg, now: Duration) -> Vec<Effect>;
    pub fn view(&self) -> TerminalView;
    pub fn frame_job(&self) -> Option<crate::terminal::frame::FrameJob>;
}
pub struct TerminalView { pub screen: Screen, pub header: HeaderView, pub tabs: Vec<TabView>, pub empty: Option<EmptyView>, pub naming: Option<String>, pub kill_prompt: Option<String>, pub capsule: Option<CapsuleView>, pub progress: Option<Progress>, pub title: String }
```

> `TermStyle` lives in `geometry.rs`. Step 3 creates it with its final fields, and Task 7 adds the geometry functions beside it.

- [ ] **Step 1: Write the failing tests**

At the bottom of `src/terminal/model/mod.rs`:

```rust
#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::terminal::geometry::TermStyle;
    use crate::terminal::testkit::*;

    pub fn t(ms: u64) -> Duration { Duration::from_millis(ms) }

    pub fn has_attach(fx: &[Effect], want: &str) -> bool {
        fx.iter().any(|e| matches!(e, Effect::Attach { name, .. } if name == want))
    }

    /// Open → Opened → first ls, returning the model live on `sessions`.
    pub fn live(sessions: Vec<ZmxSession>) -> TerminalModel {
        let (mut m, fx) = TerminalModel::new(machine(), TermStyle::default(), grid());
        assert!(matches!(fx.as_slice(), [Effect::Open, ..]));
        m.handle(Msg::Opened, t(0));
        let fx = m.handle(Msg::Ls(Ok(sessions)), t(1));
        for e in fx {
            if let Effect::Attach { name, .. } = e { m.handle(Msg::Attached { name }, t(2)); }
        }
        m
    }

    #[test]
    fn starts_connecting_on_the_terminal_screen() {
        let (m, fx) = TerminalModel::new(machine(), TermStyle::default(), grid());
        assert_eq!(fx, vec![Effect::Open]);
        let v = m.view();
        assert_eq!(v.screen, Screen::Terminal);
        assert_eq!(v.header.word, "connecting");
        assert_eq!(v.header.machine, "devbox");
    }

    #[test]
    fn opened_lists_sessions_and_reads_connected() {
        let (mut m, _) = TerminalModel::new(machine(), TermStyle::default(), grid());
        let fx = m.handle(Msg::Opened, t(0));
        assert_eq!(fx, vec![Effect::Ls]);
        assert_eq!(m.view().header.word, "connected");
    }

    #[test]
    fn default_wins_the_first_tab() {
        let (mut m, _) = TerminalModel::new(machine(), TermStyle::default(), grid());
        m.handle(Msg::Opened, t(0));
        let fx = m.handle(Msg::Ls(Ok(vec![session("build", 300), session("default", 100)])), t(1));
        assert!(has_attach(&fx, "default"));
        assert!(!has_attach(&fx, "build"));
        assert_eq!(m.view().tabs.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(), ["default", "build"]);
    }

    #[test]
    fn newest_wins_without_default() {
        let (mut m, _) = TerminalModel::new(machine(), TermStyle::default(), grid());
        m.handle(Msg::Opened, t(0));
        let fx = m.handle(Msg::Ls(Ok(vec![session("a", 100), session("b", 200)])), t(1));
        assert!(has_attach(&fx, "b"));
    }

    #[test]
    fn empty_host_attaches_nothing_and_shows_the_empty_state() {
        let m = live(vec![]);
        let v = m.view();
        let empty = v.empty.expect("empty state");
        assert_eq!(empty.title, "No session on devbox");
        assert_eq!(empty.body, "Nothing runs until you start one.");
        assert_eq!(empty.action, "New session");
        assert!(v.tabs.is_empty());
    }

    #[test]
    fn keystrokes_on_an_empty_host_reach_nothing() {
        let mut m = live(vec![]);
        let fx = m.handle(Msg::Key { input: KeyInput::Char { unmodified: 'a', produced: Some("a".into()), digit: None }, mods: Mods::default() }, t(5));
        assert!(!fx.iter().any(|e| matches!(e, Effect::Write { .. })));
    }

    #[test]
    fn ls_failure_opens_default() {
        let (mut m, _) = TerminalModel::new(machine(), TermStyle::default(), grid());
        m.handle(Msg::Opened, t(0));
        let fx = m.handle(Msg::Ls(Err(ConnectError::Transport("exec".into()))), t(1));
        assert!(has_attach(&fx, "default"));
    }

    #[test]
    fn host_key_change_goes_to_the_refused_screen() {
        let (mut m, _) = TerminalModel::new(machine(), TermStyle::default(), grid());
        let fx = m.handle(Msg::OpenFailed(ConnectError::HostKeyChanged { expected: "aa".into(), got: "bb".into() }), t(0));
        let refused = Screen::Refused { expected: "aa".into(), got: "bb".into() };
        assert!(fx.contains(&Effect::Ui(UiEffect::Navigate(refused.clone()))));
        assert_eq!(m.view().screen, refused);
    }

    #[test]
    fn other_failures_go_to_couldnt_connect_with_the_core_sentence() {
        let (mut m, _) = TerminalModel::new(machine(), TermStyle::default(), grid());
        m.handle(Msg::OpenFailed(ConnectError::AuthRejected), t(0));
        assert_eq!(m.view().screen, Screen::Failed { sentence: ConnectError::AuthRejected.sentence() });
    }

    #[test]
    fn retry_reopens_and_back_goes_home() {
        let (mut m, _) = TerminalModel::new(machine(), TermStyle::default(), grid());
        m.handle(Msg::OpenFailed(ConnectError::Timeout), t(0));
        assert_eq!(m.handle(Msg::Retry, t(1)), vec![Effect::Ui(UiEffect::Navigate(Screen::Terminal)), Effect::Open]);
        assert_eq!(m.view().header.word, "connecting");
        assert_eq!(m.handle(Msg::Back, t(2)), vec![Effect::Close, Effect::Ui(UiEffect::Home)]);
    }

    #[test]
    fn title_is_machine_dot_session() {
        let m = live(vec![session("default", 1)]);
        assert_eq!(m.view().title, "devbox · default");
        assert_eq!(m.view().header.session, "default");
    }
}
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `cargo test -p tether-app terminal::model`
Expected: FAIL to compile (`TerminalModel` not found).

- [ ] **Step 3: Implement the model core**

Create a temporary `src/terminal/geometry.rs` stub, which Task 5 and Task 7 extend:

```rust
use tether_core::fonts::{font_named, FontFace};
use tether_core::prefs::CursorShape;
use tether_core::theme::{theme_named, TerminalTheme};

#[derive(Debug, Clone, PartialEq)]
pub struct TermStyle {
    pub theme: &'static TerminalTheme,
    pub font: &'static FontFace,
    pub size_pt: f32,
    pub line_spacing: f32,
    pub padding_pt: f32,
    pub cursor: CursorShape,
    pub blink: bool,
}

impl Default for TermStyle {
    fn default() -> Self {
        Self { theme: theme_named("tether"), font: font_named("cascadia-mono"), size_pt: 14.0, line_spacing: 1.0, padding_pt: 8.0, cursor: CursorShape::Block, blink: false }
    }
}
```

`src/terminal/model/mod.rs`:

```rust
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::time::Duration;

use tether_core::connect::ConnectError;
use tether_core::keymap::{KeyInput, Mods};
use tether_core::lock::LockGrace;
use tether_core::osc::Progress;
use tether_core::paste::ClipboardSnapshot;
use tether_core::profiles::Machine;
use tether_core::resize::{GridSize, ResizeDebouncer};
use tether_core::tabs::TabStrip;
use tether_core::throttle::{BellThrottle, ToastThrottle};
use tether_core::zmx::ZmxSession;
use tether_term::TabTerminal;

use crate::terminal::geometry::TermStyle;
use crate::terminal::status::{ConnStatus, Lamp};

mod events;
mod input;
mod reconnect;
mod send;
mod tabs;

pub use send::SendJob;

pub const TICK: Duration = Duration::from_millis(50);
pub const REFRESH_EVERY: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, PartialEq)]
pub enum Screen { Terminal, Refused { expected: String, got: String }, Failed { sentence: String } }

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum TabJump { Next, Prev, Position(u8), Last }

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum FontStep { Bigger, Smaller, Reset }

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PointerShape { Text, Hand }

#[derive(Debug, Clone, PartialEq)]
pub enum MenuRequest {
    /// Right-click on a tab.
    Tab { name: String },
    /// Right-click on a link: Copy link, plus the click's usual Copy or Paste.
    Link { url: String, copy_selection: bool },
}

#[derive(Debug)]
pub enum Msg {
    Opened, OpenFailed(ConnectError), Ls(Result<Vec<ZmxSession>, ConnectError>),
    Attached { name: String }, AttachFailed { name: String },
    PtyData { name: String, bytes: Vec<u8> }, PtyClosed { name: String }, Dropped, Tick,
    Focus(bool), Modifiers(Mods),
    SelectTab(String), TabShortcut(TabJump), NewSessionBegin, NewSessionCommit(String), NewSessionCancel,
    KillRequested(String), KillConfirmed, KillCancelled, KillDone,
    Key { input: KeyInput, mods: Mods }, Ime(String), Paste { clip: ClipboardSnapshot, now_unix: i64 },
    Mouse(crate::terminal::mouse::MouseMsg), Wheel { delta_px: f32, mods: Mods, x_px: f32, y_px: f32 },
    WellResized { width_px: u32, height_px: u32, scale: f32 }, StyleChanged(TermStyle),
    Locked, Unlocked, Resumed, Network { online: bool, route_changed: bool },
    ToastClicked(String), Retry, Reconnect, Back, RedialDue { generation: u64 },
    DroppedFiles(Vec<PathBuf>), SendFiles(Vec<PathBuf>),
    SendStarted { names: Vec<String> }, SendFileStarted { index: usize },
    SendFileDone { remote: String }, SendFileFailed { reason: String },
}

#[derive(Debug, Clone, PartialEq)]
pub enum Effect {
    Open, Close, DropConnection, Ls, Kill { name: String },
    Attach { name: String, id: u64, size: GridSize }, Detach { name: String },
    Write { name: String, bytes: Vec<u8> }, ResizeAll(GridSize),
    ScheduleRedial { after: Duration, generation: u64 },
    StartSend(SendJob), Redraw, Ui(UiEffect),
}

#[derive(Debug, Clone, PartialEq)]
pub enum UiEffect {
    Navigate(Screen), Home, LampFlash, FlashTaskbar, BringToFront, SetTitle(String),
    SetClipboard(String), ReadClipboard, OpenUrl(String),
    Toast { session: String, title: String, body: String }, Taskbar(Option<Progress>),
    FontStep(FontStep), Pointer(PointerShape), Tooltip(Option<String>), Menu(MenuRequest), PickFiles,
}

#[derive(Debug, Clone, PartialEq)]
pub struct HeaderView { pub machine: String, pub session: String, pub word: &'static str, pub lamp: Lamp }
#[derive(Debug, Clone, PartialEq)]
pub struct TabView { pub name: String, pub cwd_leaf: Option<String>, pub active: bool, pub attention: bool, pub progress: Option<Progress> }
#[derive(Debug, Clone, PartialEq)]
pub struct EmptyView { pub title: String, pub body: &'static str, pub action: &'static str }
#[derive(Debug, Clone, PartialEq)]
pub enum CapsuleView { Disconnected, Send(String) }
#[derive(Debug, Clone, PartialEq)]
pub struct TerminalView {
    pub screen: Screen, pub header: HeaderView, pub tabs: Vec<TabView>, pub empty: Option<EmptyView>,
    pub naming: Option<String>, pub kill_prompt: Option<String>, pub capsule: Option<CapsuleView>,
    pub progress: Option<Progress>, pub title: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Chan { Opening(u64), Live(u64) }

pub(crate) struct TabState {
    pub term: TabTerminal,
    pub osc_title: Option<String>,
    pub bell: BellThrottle,
}

pub struct TerminalModel {
    machine: Machine,
    style: TermStyle,
    size: GridSize,
    screen: Screen,
    status: ConnStatus,
    /// None until the first `zmx ls` of this open answers.
    strip: Option<TabStrip>,
    tabs: HashMap<String, TabState>,
    channels: HashMap<String, Chan>,
    next_channel: u64,
    view_tick: u64,
    focused: bool,
    mods: Mods,
    last_refresh: Duration,
    /// Sessions created from this window: their first attach is followed by a refresh.
    created_here: HashSet<String>,
    naming: Option<String>,
    kill_prompt: Option<String>,
    opening: bool,
    attempt: usize,
    generation: u64,
    lock: LockGrace,
    lock_detached: bool,
    resize: ResizeDebouncer,
    well_px: Option<(u32, u32, f32)>,
    toasts: ToastThrottle,
    send: Option<send::SendState>,
    /// When a finished send's capsule appeared; it leaves after CAPSULE_LINGER or a keystroke.
    capsule_shown: Option<Duration>,
    pointer: Option<crate::terminal::mouse::PointerState>,
}

impl TerminalModel {
    pub fn new(machine: Machine, style: TermStyle, size: GridSize) -> (Self, Vec<Effect>) {
        let m = Self {
            machine, style, size, screen: Screen::Terminal, status: ConnStatus::Connecting, strip: None,
            tabs: HashMap::new(), channels: HashMap::new(), next_channel: 0, view_tick: 0, focused: true,
            mods: Mods::default(), last_refresh: Duration::ZERO, created_here: HashSet::new(), naming: None,
            kill_prompt: None, opening: true, attempt: 0, generation: 0, lock: LockGrace::default(), lock_detached: false,
            resize: ResizeDebouncer::default(), well_px: None, toasts: ToastThrottle::default(),
            send: None, capsule_shown: None, pointer: None,
        };
        (m, vec![Effect::Open])
    }

    pub fn handle(&mut self, msg: Msg, now: Duration) -> Vec<Effect> {
        let mut fx = Vec::new();
        match msg {
            Msg::Opened => self.on_opened(now, &mut fx),
            Msg::OpenFailed(err) => self.on_open_failed(err, &mut fx),
            Msg::Ls(result) => self.on_ls(result, now, &mut fx),
            Msg::Attached { name } => self.on_attached(&name, &mut fx),
            Msg::AttachFailed { name } => { self.channels.remove(&name); }
            Msg::PtyData { name, bytes } => self.on_pty_data(&name, &bytes, now, &mut fx),
            Msg::PtyClosed { name } => { self.channels.remove(&name); fx.push(Effect::Ls); }
            Msg::Dropped => self.on_dropped(&mut fx),
            Msg::Tick => self.on_tick(now, &mut fx),
            Msg::Focus(f) => self.on_focus(f, now, &mut fx),
            Msg::Modifiers(mods) => self.on_modifiers(mods, &mut fx),
            Msg::SelectTab(name) => self.activate(&name, &mut fx),
            Msg::TabShortcut(jump) => self.on_jump(jump, &mut fx),
            Msg::NewSessionBegin => self.on_new_begin(),
            Msg::NewSessionCommit(name) => self.on_new_commit(&name, now, &mut fx),
            Msg::NewSessionCancel => self.naming = None,
            Msg::KillRequested(name) => self.kill_prompt = Some(name),
            Msg::KillConfirmed => self.on_kill_confirmed(&mut fx),
            Msg::KillCancelled => self.kill_prompt = None,
            Msg::KillDone => fx.push(Effect::Ls),
            Msg::Key { input, mods } => self.on_key(&input, mods, now, &mut fx),
            Msg::Ime(text) => self.write_active(text.into_bytes(), &mut fx),
            Msg::Paste { clip, now_unix } => self.on_paste(clip, now_unix, &mut fx),
            Msg::Mouse(m) => self.on_mouse(m, &mut fx),
            Msg::Wheel { delta_px, mods, x_px, y_px } => self.on_wheel(delta_px, mods, x_px, y_px, &mut fx),
            Msg::WellResized { width_px, height_px, scale } => self.on_well_resized(width_px, height_px, scale, now, &mut fx),
            Msg::StyleChanged(style) => self.on_style(style, now, &mut fx),
            Msg::Locked => self.lock.on_lock(now),
            Msg::Unlocked => self.on_unlock(&mut fx),
            Msg::Resumed => self.force_redial(&mut fx),
            Msg::Network { online, route_changed } => self.on_network(online, route_changed, &mut fx),
            Msg::ToastClicked(name) => { fx.push(Effect::Ui(UiEffect::BringToFront)); self.activate(&name, &mut fx); }
            Msg::Retry => self.on_retry(&mut fx),
            Msg::Reconnect => self.on_reconnect_clicked(&mut fx),
            Msg::Back => { fx.push(Effect::Close); fx.push(Effect::Ui(UiEffect::Home)); }
            Msg::RedialDue { generation } => self.on_redial_due(generation, &mut fx),
            Msg::DroppedFiles(paths) | Msg::SendFiles(paths) => self.on_send_files(paths, &mut fx),
            Msg::SendStarted { names } => self.on_send_started(names),
            Msg::SendFileStarted { index } => self.on_send_file_started(index),
            Msg::SendFileDone { remote } => self.on_send_file_done(&remote, now, &mut fx),
            Msg::SendFileFailed { reason } => self.on_send_file_failed(reason, now),
        }
        fx
    }

    fn on_opened(&mut self, now: Duration, fx: &mut Vec<Effect>) {
        self.opening = false;
        let was_reconnect = matches!(self.status, ConnStatus::Reconnecting | ConnStatus::Disconnected);
        self.status = ConnStatus::Connected;
        self.attempt = 0;
        self.last_refresh = now;
        fx.push(Effect::Ls);
        if was_reconnect {
            self.reattach_all(fx);
        }
        fx.push(Effect::Redraw);
    }

    fn on_open_failed(&mut self, err: ConnectError, fx: &mut Vec<Effect>) {
        self.opening = false;
        if self.strip.is_some() || self.status == ConnStatus::Reconnecting {
            return self.on_redial_failed(err, fx);
        }
        let screen = match err {
            ConnectError::HostKeyChanged { expected, got } => Screen::Refused { expected, got },
            other => Screen::Failed { sentence: other.sentence() },
        };
        self.screen = screen.clone();
        fx.push(Effect::Ui(UiEffect::Navigate(screen)));
    }

    fn on_retry(&mut self, fx: &mut Vec<Effect>) {
        self.screen = Screen::Terminal;
        self.status = ConnStatus::Connecting;
        self.opening = true;
        fx.push(Effect::Ui(UiEffect::Navigate(Screen::Terminal)));
        fx.push(Effect::Open);
    }

    fn on_ls(&mut self, result: Result<Vec<ZmxSession>, ConnectError>, now: Duration, fx: &mut Vec<Effect>) {
        self.last_refresh = now;
        if self.strip.is_none() {
            let strip = match result {
                Ok(sessions) => TabStrip::from_sessions(&sessions),
                Err(_) => TabStrip::from_ls_failure(),
            };
            let first = strip.active.clone();
            self.strip = Some(strip);
            if let Some(name) = first { self.activate(&name, fx); }
            fx.push(Effect::Redraw);
            return;
        }
        if let Ok(sessions) = result { self.merge(sessions, now, fx); }
    }

    fn on_attached(&mut self, name: &str, fx: &mut Vec<Effect>) {
        if let Some(Chan::Opening(id)) = self.channels.get(name).copied() {
            self.channels.insert(name.to_string(), Chan::Live(id));
        }
        if self.created_here.remove(name) { fx.push(Effect::Ls); }
    }

    pub(crate) fn active_name(&self) -> Option<&str> {
        self.strip.as_ref().and_then(|s| s.active.as_deref())
    }

    pub(crate) fn is_live(&self, name: &str) -> bool {
        self.status == ConnStatus::Connected && matches!(self.channels.get(name), Some(Chan::Live(_)))
    }

    /// Input goes to the active tab only while its channel is up; it is dropped, not queued.
    pub(crate) fn write_active(&mut self, bytes: Vec<u8>, fx: &mut Vec<Effect>) {
        let Some(name) = self.active_name().map(str::to_string) else { return };
        if self.is_live(&name) { fx.push(Effect::Write { name, bytes }); }
    }

    pub(crate) fn open_channel(&mut self, name: &str, fx: &mut Vec<Effect>) {
        if self.status != ConnStatus::Connected || self.channels.contains_key(name) { return; }
        self.tabs.entry(name.to_string()).or_insert_with(|| TabState {
            term: TabTerminal::new(self.size, self.style.theme),
            osc_title: None,
            bell: BellThrottle::default(),
        });
        self.next_channel += 1;
        self.channels.insert(name.to_string(), Chan::Opening(self.next_channel));
        fx.push(Effect::Attach { name: name.to_string(), id: self.next_channel, size: self.size });
    }

    pub(crate) fn close_channel(&mut self, name: &str, fx: &mut Vec<Effect>) {
        if self.channels.remove(name).is_some() { fx.push(Effect::Detach { name: name.to_string() }); }
    }

    pub fn view(&self) -> TerminalView {
        let session = self.active_name().unwrap_or("").to_string();
        let tabs = self.strip.as_ref().map(|s| {
            s.tabs.iter().map(|t| TabView {
                name: t.name.clone(), cwd_leaf: t.cwd_leaf.clone(), active: s.active.as_deref() == Some(&t.name),
                attention: t.attention, progress: self.tabs.get(&t.name).and_then(|x| x.term.reports().progress.clone()),
            }).collect()
        }).unwrap_or_default();
        let empty = self.strip.as_ref().filter(|s| s.tabs.is_empty()).map(|_| EmptyView {
            title: format!("No session on {}", self.machine.name),
            body: "Nothing runs until you start one.",
            action: "New session",
        });
        let capsule = if self.status == ConnStatus::Disconnected {
            Some(CapsuleView::Disconnected)
        } else {
            self.send_capsule().map(CapsuleView::Send)
        };
        TerminalView {
            screen: self.screen.clone(),
            header: HeaderView { machine: self.machine.name.clone(), session: session.clone(), word: self.status.word(), lamp: self.status.lamp() },
            tabs, empty, naming: self.naming.clone(), kill_prompt: self.kill_prompt.clone(), capsule,
            progress: self.active_name().and_then(|n| self.tabs.get(n)).and_then(|t| t.term.reports().progress.clone()),
            title: self.window_title(),
        }
    }

    pub(crate) fn window_title(&self) -> String {
        match self.active_name() {
            None => self.machine.name.clone(),
            Some(s) => {
                let osc = self.tabs.get(s).and_then(|t| t.osc_title.as_deref());
                match osc {
                    Some(title) => format!("{} · {} · {}", self.machine.name, s, title),
                    None => format!("{} · {}", self.machine.name, s),
                }
            }
        }
    }
}
```

Until their tasks land, create `tabs.rs`, `reconnect.rs`, `input.rs`, `events.rs`, and `send.rs` as `impl TerminalModel` blocks holding the methods `handle` calls. Each stub takes the arguments `handle` passes and returns `()`. Every stub has an empty body except `send_capsule`, whose body is `None`. Here are the stubs, all `pub(crate)`:

- `reconnect.rs`: `on_dropped(&mut self, fx)`, `on_tick(&mut self, now, fx)`, `on_unlock(&mut self, fx)`, `force_redial(&mut self, fx)`, `on_network(&mut self, online: bool, route_changed: bool, fx)`, `on_reconnect_clicked(&mut self, fx)`, `on_redial_due(&mut self, generation: u64, fx)`, `on_redial_failed(&mut self, err: ConnectError, fx)`, `redial_now(&mut self, fx)`.
- `input.rs`: `on_modifiers(&mut self, mods: Mods, fx)`, `on_key(&mut self, input: &KeyInput, mods: Mods, now, fx)`, `on_paste(&mut self, clip: ClipboardSnapshot, now_unix: i64, fx)`, `on_mouse(&mut self, m: MouseMsg, fx)`, `on_wheel(&mut self, delta_px: f32, mods: Mods, x_px: f32, y_px: f32, fx)`, `on_well_resized(&mut self, w: u32, h: u32, scale: f32, now, fx)`, `on_style(&mut self, style: TermStyle, now, fx)`.
- `events.rs`: `on_pty_data(&mut self, name: &str, bytes: &[u8], now, fx)`.
- `send.rs`: `pub struct SendJob;` (with `#[derive(Debug, Clone, PartialEq)]`), `pub(crate) struct SendState;`, `on_send_files(&mut self, paths: Vec<PathBuf>, fx)`, `on_send_started(&mut self, names: Vec<String>)`, `on_send_file_started(&mut self, index: usize)`, `on_send_file_done(&mut self, remote: &str, now, fx)`, `on_send_file_failed(&mut self, reason: String, now)`, `send_capsule(&self) -> Option<String>`.
- `tabs.rs`: `on_focus`, `on_jump`, `on_new_begin`, `on_new_commit`, `on_kill_confirmed`, with the signatures Task 3 gives them.

Here `fx` is `&mut Vec<Effect>` and `now` is `Duration`. `activate`, `merge`, and `reattach_all` are the exceptions, because this task needs them working. Write them in `tabs.rs` now:

```rust
use super::*;

impl TerminalModel {
    pub(crate) fn activate(&mut self, name: &str, fx: &mut Vec<Effect>) {
        let Some(strip) = self.strip.as_mut() else { return };
        if !strip.tabs.iter().any(|t| t.name == name) { return; }
        self.view_tick += 1;
        if let Some(evicted) = strip.select(name, self.view_tick) { self.close_channel(&evicted, fx); }
        self.open_channel(name, fx);
        let progress = self.tabs.get(name).and_then(|t| t.term.reports().progress.clone());
        fx.push(Effect::Ui(UiEffect::Taskbar(progress)));
        fx.push(Effect::Ui(UiEffect::SetTitle(self.window_title())));
        fx.push(Effect::Redraw);
    }

    pub(crate) fn reattach_all(&mut self, fx: &mut Vec<Effect>) {
        let order = self.strip.as_ref().map(|s| s.reattach_order()).unwrap_or_default();
        for name in order { self.open_channel(&name, fx); }
    }

    pub(crate) fn merge(&mut self, sessions: Vec<ZmxSession>, now: Duration, fx: &mut Vec<Effect>) { let _ = (sessions, now, fx); }
}
```

The stub keeps the crate compiling. Task 3 replaces `merge` and adds the rest of `tabs.rs`. Add `pub mod model; pub mod geometry; pub mod mouse; pub mod frame;` to `terminal/mod.rs`. For now, `mouse.rs` holds `#[derive(Debug)] pub struct MouseMsg; #[derive(Debug, Default)] pub struct PointerState;` and `frame.rs` holds `#[derive(Debug)] pub struct FrameJob;`, which is enough to compile. Tasks 4, 8, and 11 replace them. Task 4 does not declare `pub mod frame;` again.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `cargo test -p tether-app terminal::model`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add clients/windows/crates/tether-app/src/terminal
git commit -m "feat(windows): terminal model opens a machine and picks its first tab

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Tabs: refresh, merge, new session, switching, kill, attention, attach cap

**Files:**
- Modify: `clients/windows/crates/tether-app/src/terminal/model/tabs.rs`

**Interfaces:**
- Consumes: `tether_core::tabs::{TabStrip, CreateOutcome, KillStep, MergeOutcome}` and the methods `merge`, `select`, `create`, `tab`, `next`, `prev`, `at_position`, `last`, `new_session_name`, `begin_kill`, `mark_attention`. `ATTACH_CAP` is enforced inside `select`.
- Produces: `TerminalModel::{merge, on_jump, on_new_begin, on_new_commit, on_kill_confirmed, on_focus}` and the refresh half of `on_tick`, as `pub(crate) fn refresh_due(&mut self, now: Duration, fx: &mut Vec<Effect>)`.

- [ ] **Step 1: Write the failing tests**

Append to `tabs.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::super::tests::{has_attach, live, t};
    use super::*;
    use crate::terminal::testkit::session;

    #[test]
    fn refresh_runs_every_10s_only_while_focused() {
        let mut m = live(vec![session("default", 1)]);
        assert!(!m.handle(Msg::Tick, t(9_000)).contains(&Effect::Ls));
        assert!(m.handle(Msg::Tick, t(10_100)).contains(&Effect::Ls));
        m.handle(Msg::Focus(false), t(10_200));
        assert!(!m.handle(Msg::Tick, t(30_000)).contains(&Effect::Ls));
        assert!(m.handle(Msg::Focus(true), t(30_100)).contains(&Effect::Ls));
    }

    #[test]
    fn a_session_from_elsewhere_gets_a_tab_without_attaching() {
        let mut m = live(vec![session("default", 1)]);
        let fx = m.handle(Msg::Ls(Ok(vec![session("default", 1), session("phone", 5)])), t(100));
        assert!(!has_attach(&fx, "phone"));
        assert_eq!(m.view().tabs.len(), 2);
    }

    #[test]
    fn a_vanished_active_tab_closes_its_channel_and_the_left_neighbor_takes_over() {
        let mut m = live(vec![session("a", 1), session("b", 2), session("c", 3)]);
        m.handle(Msg::SelectTab("b".into()), t(10));
        let fx = m.handle(Msg::Ls(Ok(vec![session("a", 1), session("c", 3)])), t(20));
        assert!(fx.contains(&Effect::Detach { name: "b".into() }));
        assert!(has_attach(&fx, "a"));
        assert_eq!(m.view().header.session, "a");
    }

    #[test]
    fn new_session_prefills_default_then_session_n() {
        let mut m = live(vec![]);
        m.handle(Msg::NewSessionBegin, t(5));
        assert_eq!(m.view().naming.as_deref(), Some("default"));
        let mut m = live(vec![session("default", 1)]);
        m.handle(Msg::NewSessionBegin, t(5));
        assert_eq!(m.view().naming.as_deref(), Some("session-2"));
    }

    #[test]
    fn committing_a_new_name_attaches_it_and_refreshes_after() {
        let mut m = live(vec![session("default", 1)]);
        m.handle(Msg::NewSessionBegin, t(5));
        let fx = m.handle(Msg::NewSessionCommit("build".into()), t(6));
        assert!(has_attach(&fx, "build"));
        assert_eq!(m.view().naming, None);
        assert!(m.handle(Msg::Attached { name: "build".into() }, t(7)).contains(&Effect::Ls));
    }

    #[test]
    fn new_session_survives_early_refresh() {
        let mut m = live(vec![session("default", 1)]);
        m.handle(Msg::NewSessionCommit("build".into()), t(6));
        let fx = m.handle(Msg::Ls(Ok(vec![session("default", 1)])), t(500));
        assert!(!fx.contains(&Effect::Detach { name: "build".into() }));
        assert_eq!(m.view().header.session, "build");
        // Once zmx reports it, it is an ordinary tab and leaves when zmx drops it.
        m.handle(Msg::Ls(Ok(vec![session("default", 1), session("build", 9)])), t(1_000));
        let fx = m.handle(Msg::Ls(Ok(vec![session("default", 1)])), t(2_000));
        assert!(fx.contains(&Effect::Detach { name: "build".into() }));
    }

    #[test]
    fn an_existing_name_selects_that_tab() {
        let mut m = live(vec![session("default", 1), session("build", 2)]);
        let fx = m.handle(Msg::NewSessionCommit("build".into()), t(6));
        assert!(has_attach(&fx, "build"));
        assert_eq!(m.view().tabs.len(), 2);
    }

    #[test]
    fn empty_or_blank_name_cancels() {
        let mut m = live(vec![session("default", 1)]);
        m.handle(Msg::NewSessionBegin, t(5));
        let fx = m.handle(Msg::NewSessionCommit("   ".into()), t(6));
        assert!(fx.is_empty());
        assert_eq!(m.view().naming, None);
    }

    #[test]
    fn shortcuts_wrap_and_nine_is_last() {
        let mut m = live(vec![session("a", 1), session("b", 2), session("c", 3)]);
        m.handle(Msg::SelectTab("c".into()), t(1));
        m.handle(Msg::TabShortcut(TabJump::Next), t(2));
        assert_eq!(m.view().header.session, "a");
        m.handle(Msg::TabShortcut(TabJump::Prev), t(3));
        assert_eq!(m.view().header.session, "c");
        m.handle(Msg::TabShortcut(TabJump::Position(2)), t(4));
        assert_eq!(m.view().header.session, "b");
        m.handle(Msg::TabShortcut(TabJump::Last), t(5));
        assert_eq!(m.view().header.session, "c");
    }

    #[test]
    fn kill_switches_away_first_then_kills_then_refreshes() {
        let mut m = live(vec![session("a", 1), session("b", 2)]);
        m.handle(Msg::SelectTab("b".into()), t(1));
        m.handle(Msg::KillRequested("b".into()), t(2));
        assert_eq!(m.view().kill_prompt.as_deref(), Some("b"));
        let fx = m.handle(Msg::KillConfirmed, t(3));
        let kill = fx.iter().position(|e| *e == Effect::Kill { name: "b".into() }).unwrap();
        let switch = fx.iter().position(|e| matches!(e, Effect::Ui(UiEffect::SetTitle(s)) if s == "devbox · a")).unwrap();
        assert!(switch < kill);
        assert!(fx.contains(&Effect::Detach { name: "b".into() }));
        assert_eq!(m.handle(Msg::KillDone, t(4)), vec![Effect::Ls]);
    }

    #[test]
    fn killing_the_last_session_leaves_the_empty_state() {
        let mut m = live(vec![session("a", 1)]);
        m.handle(Msg::KillRequested("a".into()), t(2));
        let fx = m.handle(Msg::KillConfirmed, t(3));
        assert!(!fx.iter().any(|e| matches!(e, Effect::Attach { .. })));
        assert!(m.view().empty.is_some());
    }

    #[test]
    fn cancel_leaves_the_session() {
        let mut m = live(vec![session("a", 1)]);
        m.handle(Msg::KillRequested("a".into()), t(2));
        assert!(m.handle(Msg::KillCancelled, t(3)).is_empty());
        assert_eq!(m.view().kill_prompt, None);
    }

    #[test]
    fn the_thirteenth_attach_detaches_the_least_recently_viewed() {
        let sessions: Vec<_> = (0..13).map(|i| session(&format!("s{i:02}"), i)).collect();
        let mut m = live(sessions);
        for i in 0..12 {
            let fx = m.handle(Msg::SelectTab(format!("s{i:02}")), t(10 + i as u64));
            for e in fx { if let Effect::Attach { name, .. } = e { m.handle(Msg::Attached { name }, t(10)); } }
        }
        let fx = m.handle(Msg::SelectTab("s12".into()), t(100));
        assert!(fx.iter().any(|e| matches!(e, Effect::Detach { .. })));
        assert!(has_attach(&fx, "s12"));
    }

    #[test]
    fn background_bell_marks_attention_until_viewed() {
        let mut m = live(vec![session("a", 1), session("b", 2)]);
        m.handle(Msg::SelectTab("a".into()), t(1));
        m.handle(Msg::SelectTab("b".into()), t(2));
        m.handle(Msg::Attached { name: "b".into() }, t(2));
        m.handle(Msg::SelectTab("a".into()), t(3));
        m.handle(Msg::PtyData { name: "b".into(), bytes: b"\x07".to_vec() }, t(4));
        assert!(m.view().tabs.iter().find(|t| t.name == "b").unwrap().attention);
        m.handle(Msg::SelectTab("b".into()), t(5));
        assert!(!m.view().tabs.iter().find(|t| t.name == "b").unwrap().attention);
    }

    #[test]
    fn plain_output_never_marks_a_tab() {
        let mut m = live(vec![session("a", 1), session("b", 2)]);
        m.handle(Msg::SelectTab("b".into()), t(1));
        m.handle(Msg::Attached { name: "b".into() }, t(1));
        m.handle(Msg::SelectTab("a".into()), t(2));
        m.handle(Msg::PtyData { name: "b".into(), bytes: b"12:00:01\r".to_vec() }, t(3));
        assert!(!m.view().tabs.iter().find(|t| t.name == "b").unwrap().attention);
    }
}
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `cargo test -p tether-app terminal::model::tabs`
Expected: FAIL. The empty stubs make assertions such as `assert!(m.handle(Msg::Tick, …).contains(&Effect::Ls))` fail.

- [ ] **Step 3: Implement**

Replace the stubbed methods in `tabs.rs` (`activate` and `reattach_all` stay as they are):

```rust
impl TerminalModel {
    pub(crate) fn merge(&mut self, sessions: Vec<ZmxSession>, _now: Duration, fx: &mut Vec<Effect>) {
        let Some(strip) = self.strip.as_mut() else { return };
        // A tab created here stays (`on_host: false`) until zmx reports it.
        let outcome = strip.merge(&sessions);
        for name in &outcome.removed {
            self.close_channel(name, fx);
            self.tabs.remove(name);
        }
        if outcome.active_changed {
            match self.active_name().map(str::to_string) {
                Some(name) => self.activate(&name, fx),
                None => {
                    fx.push(Effect::Ui(UiEffect::Taskbar(None)));
                    fx.push(Effect::Ui(UiEffect::SetTitle(self.window_title())));
                }
            }
        }
        fx.push(Effect::Redraw);
    }

    pub(crate) fn refresh_due(&mut self, now: Duration, fx: &mut Vec<Effect>) {
        if self.focused && self.status == ConnStatus::Connected && now.saturating_sub(self.last_refresh) >= REFRESH_EVERY {
            self.last_refresh = now;
            fx.push(Effect::Ls);
        }
    }

    pub(crate) fn on_focus(&mut self, focused: bool, now: Duration, fx: &mut Vec<Effect>) {
        self.focused = focused;
        if !focused { return; }
        if self.status == ConnStatus::Connected {
            self.last_refresh = now;
            fx.push(Effect::Ls);
        } else {
            self.redial_now(fx);
        }
    }

    pub(crate) fn on_jump(&mut self, jump: TabJump, fx: &mut Vec<Effect>) {
        let Some(strip) = self.strip.as_ref() else { return };
        let target = match jump {
            TabJump::Next => strip.next(),
            TabJump::Prev => strip.prev(),
            TabJump::Position(n) => strip.at_position(n as usize),
            TabJump::Last => strip.last(),
        }
        .map(str::to_string);
        if let Some(name) = target { self.activate(&name, fx); }
    }

    pub(crate) fn on_new_begin(&mut self) {
        if let Some(strip) = self.strip.as_ref() { self.naming = Some(strip.new_session_name()); }
    }

    pub(crate) fn on_new_commit(&mut self, raw: &str, _now: Duration, fx: &mut Vec<Effect>) {
        self.naming = None;
        let name = raw.trim();
        if name.is_empty() || self.strip.is_none() { return; }
        if self.strip.as_ref().is_some_and(|s| s.tab(name).is_some()) {
            return self.activate(name, fx);
        }
        self.view_tick += 1;
        let tick = self.view_tick;
        let Some(strip) = self.strip.as_mut() else { return };
        let evicted = match strip.create(name, tick) {
            CreateOutcome::Created { evicted } | CreateOutcome::Existing { evicted } => evicted,
        };
        if let Some(e) = evicted { self.close_channel(&e, fx); }
        // Attaching a name zmx does not know creates the session.
        self.created_here.insert(name.to_string());
        self.open_channel(name, fx);
        fx.push(Effect::Ui(UiEffect::Taskbar(None)));
        fx.push(Effect::Ui(UiEffect::SetTitle(self.window_title())));
        fx.push(Effect::Redraw);
    }

    pub(crate) fn on_kill_confirmed(&mut self, fx: &mut Vec<Effect>) {
        let Some(name) = self.kill_prompt.take() else { return };
        let Some(strip) = self.strip.as_mut() else { return };
        let step = strip.begin_kill(&name);
        if step.active_changed {
            match step.new_active {
                Some(n) => self.activate(&n, fx),
                None => {
                    fx.push(Effect::Ui(UiEffect::Taskbar(None)));
                    fx.push(Effect::Ui(UiEffect::SetTitle(self.window_title())));
                }
            }
        }
        self.close_channel(&name, fx);
        self.tabs.remove(&name);
        self.created_here.remove(&name);
        fx.push(Effect::Kill { name });
        fx.push(Effect::Redraw);
    }
}
```

`tabs.rs` imports `use tether_core::tabs::CreateOutcome;` next to `use super::*;`. In `mod.rs`, `on_tick` now calls `self.refresh_due(now, fx)`. Task 6 adds the rest of `on_tick`; for now:

```rust
// reconnect.rs (temporary body; Task 6 completes it)
impl TerminalModel {
    pub(crate) fn on_tick(&mut self, now: Duration, fx: &mut Vec<Effect>) { self.refresh_due(now, fx); }
    pub(crate) fn redial_now(&mut self, _fx: &mut Vec<Effect>) {}
}
```

The attention and bell tests need `on_pty_data` to work. Implement it in `events.rs` now; Task 12 extends it:

```rust
use super::*;
use tether_term::TermEvent;

impl TerminalModel {
    pub(crate) fn on_pty_data(&mut self, name: &str, bytes: &[u8], now: Duration, fx: &mut Vec<Effect>) {
        let Some(tab) = self.tabs.get_mut(name) else { return };
        let events = tab.term.feed(bytes);
        let active = self.active_name() == Some(name);
        for ev in events { self.on_term_event(name, ev, active, now, fx); }
        if active { fx.push(Effect::Redraw); }
    }

    pub(crate) fn on_term_event(&mut self, name: &str, ev: TermEvent, active: bool, now: Duration, fx: &mut Vec<Effect>) {
        match ev {
            TermEvent::Bell => {
                let rang = self.tabs.get_mut(name).map(|t| t.bell.should_ring(now)).unwrap_or(false);
                if !rang { return; }
                if active {
                    fx.push(Effect::Ui(UiEffect::LampFlash));
                } else if let Some(strip) = self.strip.as_mut() {
                    strip.mark_attention(name);
                }
                if !self.focused { fx.push(Effect::Ui(UiEffect::FlashTaskbar)); }
            }
            TermEvent::Reply(bytes) => {
                if self.is_live(name) { fx.push(Effect::Write { name: name.to_string(), bytes }); }
            }
            _ => self.on_report_event(name, ev, active, now, fx),
        }
    }

    pub(crate) fn on_report_event(&mut self, _name: &str, _ev: TermEvent, _active: bool, _now: Duration, _fx: &mut Vec<Effect>) {}
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `cargo test -p tether-app terminal::model`
Expected: PASS, including the 15 new tab tests.

- [ ] **Step 5: Commit**

```bash
git add clients/windows/crates/tether-app/src/terminal/model
git commit -m "feat(windows): session tabs refresh, create, switch, kill, and cap attaches

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Driver: run effects against the remote, frame pacing

**Files:**
- Create: `clients/windows/crates/tether-app/src/terminal/driver.rs`, `src/terminal/ui_port.rs`
- Replace: `clients/windows/crates/tether-app/src/terminal/frame.rs` (pacer here; Task 8 adds the renderer)
- Create: `src/terminal/files.rs` (stub; Task 14 fills it)
- Modify: `src/terminal/model/mod.rs` (add a `frame_job` stub), `src/terminal/mod.rs`

**Interfaces:**
- Consumes: `Remote`, `PtySink` (Task 1); `TerminalModel`, `Msg`, `Effect`, `UiEffect`, `TerminalView`, `TICK` (Task 2); `tether_core::zmx::attach_command`; `tether_ssh::{PtyEvent, ConnectionEvent}`.
- Produces:
  - `pub enum DriverMsg<S> { Model(Msg), Opened(broadcast::Receiver<ConnectionEvent>), Sink { name: String, id: u64, sink: S, reader: JoinHandle<()> }, Presented }`
  - `pub type MsgSink = Arc<dyn Fn(Msg) + Send + Sync>` and `pub fn msg_sink<S: Send + 'static>(tx: mpsc::UnboundedSender<DriverMsg<S>>) -> MsgSink`
  - `pub fn presented_sink<S: Send + 'static>(tx: mpsc::UnboundedSender<DriverMsg<S>>) -> Arc<dyn Fn() + Send + Sync>`, the render thread's "frame shown" callback
  - `pub struct Driver<R: Remote, U: UiPort>`, with `Driver::new(remote: Arc<R>, ui: U, tx: mpsc::UnboundedSender<DriverMsg<R::Sink>>) -> Self` and `pub async fn run(self, model: TerminalModel, initial: Vec<Effect>, rx: mpsc::UnboundedReceiver<DriverMsg<R::Sink>>)`
  - `pub trait UiPort: Send + 'static { fn apply(&self, fx: UiEffect); fn view(&self, view: TerminalView); fn render(&self, job: FrameJob); }` and `#[cfg(test)] pub struct RecordingUi`
  - `pub struct FramePacer` with `fn mark_dirty(&mut self) -> bool`, `fn presented(&mut self) -> bool`, `fn cancel(&mut self)`

- [ ] **Step 1: Write the pacer with its tests**

`src/terminal/frame.rs`:

```rust
/// One frame in flight at a time. Output that lands while a frame is on its way only
/// marks the next one dirty, and the next frame starts when the window reports the last
/// one presented. The grid therefore repaints at most once per display refresh.
#[derive(Debug, Default)]
pub struct FramePacer { dirty: bool, in_flight: bool }

impl FramePacer {
    pub fn mark_dirty(&mut self) -> bool {
        if self.in_flight { self.dirty = true; return false; }
        self.in_flight = true;
        true
    }

    pub fn presented(&mut self) -> bool {
        self.in_flight = false;
        if !self.dirty { return false; }
        self.dirty = false;
        self.in_flight = true;
        true
    }

    /// Nothing to draw after all (no active tab): free the slot.
    pub fn cancel(&mut self) { self.in_flight = false; self.dirty = false; }
}

/// Filled in by Task 8.
#[derive(Debug)]
pub struct FrameJob;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_coalesce_while_in_flight() {
        let mut p = FramePacer::default();
        assert!(p.mark_dirty());
        for _ in 0..1000 { assert!(!p.mark_dirty()); }
        assert!(p.presented());
        assert!(!p.presented());
        assert!(p.mark_dirty());
    }

    #[test]
    fn cancel_frees_the_slot() {
        let mut p = FramePacer::default();
        assert!(p.mark_dirty());
        p.cancel();
        assert!(p.mark_dirty());
    }
}
```

Run: `cargo test -p tether-app terminal::frame`
Expected: PASS (2). The pacer is pure, so its code and tests land together. The driver tests below fail first.

- [ ] **Step 2: Write the failing driver tests**

`src/terminal/ui_port.rs`:

```rust
use crate::terminal::frame::FrameJob;
use crate::terminal::model::{TerminalView, UiEffect};

pub trait UiPort: Send + 'static {
    fn apply(&self, fx: UiEffect);
    fn view(&self, view: TerminalView);
    fn render(&self, job: FrameJob);
}

#[cfg(test)]
#[derive(Clone, Default)]
pub struct RecordingUi {
    pub effects: std::sync::Arc<std::sync::Mutex<Vec<UiEffect>>>,
    pub views: std::sync::Arc<std::sync::Mutex<Vec<TerminalView>>>,
    pub frames: std::sync::Arc<std::sync::atomic::AtomicUsize>,
}

#[cfg(test)]
impl UiPort for RecordingUi {
    fn apply(&self, fx: UiEffect) { self.effects.lock().unwrap().push(fx); }
    fn view(&self, view: TerminalView) { self.views.lock().unwrap().push(view); }
    fn render(&self, _job: FrameJob) { self.frames.fetch_add(1, std::sync::atomic::Ordering::SeqCst); }
}

#[cfg(test)]
impl RecordingUi {
    pub fn last_view(&self) -> TerminalView { self.views.lock().unwrap().last().cloned().expect("a view") }
}
```

Tests at the bottom of `driver.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::terminal::geometry::TermStyle;
    use crate::terminal::model::UiEffect;
    use crate::terminal::testkit::*;
    use crate::terminal::ui_port::RecordingUi;
    use std::time::Duration;

    async fn start(remote: Arc<FakeRemote>) -> (RecordingUi, MsgSink, JoinHandle<()>) {
        let ui = RecordingUi::default();
        let (tx, rx) = mpsc::unbounded_channel();
        let (model, fx) = TerminalModel::new(machine(), TermStyle::default(), grid());
        let driver = Driver::new(remote, ui.clone(), tx.clone());
        let handle = tokio::spawn(driver.run(model, fx, rx));
        tokio::time::sleep(Duration::from_millis(100)).await;
        (ui, msg_sink(tx), handle)
    }

    #[tokio::test(start_paused = true)]
    async fn first_connect_attaches_default_by_typing_into_the_login_shell() {
        let remote = Arc::new(FakeRemote::default());
        *remote.sessions.lock().unwrap() = Ok(vec![session("default", 1)]);
        let (ui, _send, _h) = start(remote.clone()).await;
        assert_eq!(remote.log()[..3], ["open", "ls", "attach default 80x24"]);
        assert_eq!(
            *remote.sink("default").log.lock().unwrap(),
            ["resize 80x24", "write ~/.local/bin/zmx attach 'default'\n"]
        );
        assert_eq!(ui.last_view().header.word, "connected");
    }

    #[tokio::test(start_paused = true)]
    async fn background_tabs_keep_streaming() {
        let remote = Arc::new(FakeRemote::default());
        *remote.sessions.lock().unwrap() = Ok(vec![session("a", 1), session("b", 2)]);
        let (ui, send, _h) = start(remote.clone()).await;
        send(Msg::SelectTab("a".into()));
        tokio::time::sleep(Duration::from_millis(100)).await;
        // More than M3's 1024-event queue: the reader must keep draining a background tab.
        for _ in 0..1500 { remote.push("b", b"x").await; }
        remote.push("b", b"\x07").await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        let v = ui.last_view();
        assert_eq!(v.header.session, "a");
        assert!(v.tabs.iter().find(|t| t.name == "b").unwrap().attention);
    }

    #[tokio::test(start_paused = true)]
    async fn kill_runs_on_control_then_refreshes() {
        let remote = Arc::new(FakeRemote::default());
        *remote.sessions.lock().unwrap() = Ok(vec![session("a", 1), session("b", 2)]);
        let (_ui, send, _h) = start(remote.clone()).await;
        send(Msg::KillRequested("b".into()));
        send(Msg::KillConfirmed);
        tokio::time::sleep(Duration::from_millis(100)).await;
        let log = remote.log();
        let kill = log.iter().position(|l| l == "kill b").expect("kill");
        assert!(log[kill..].iter().any(|l| l == "ls"));
        assert!(remote.sink("b").log.lock().unwrap().contains(&"close".to_string()));
    }

    #[tokio::test(start_paused = true)]
    async fn back_closes_and_goes_home() {
        let remote = Arc::new(FakeRemote::default());
        *remote.sessions.lock().unwrap() = Ok(vec![session("default", 1)]);
        let (ui, send, handle) = start(remote.clone()).await;
        send(Msg::Back);
        handle.await.unwrap();
        assert!(remote.log().contains(&"close".to_string()));
        assert!(ui.effects.lock().unwrap().contains(&UiEffect::Home));
    }

    #[tokio::test(start_paused = true)]
    async fn refresh_fires_every_ten_seconds() {
        let remote = Arc::new(FakeRemote::default());
        *remote.sessions.lock().unwrap() = Ok(vec![session("default", 1)]);
        let (_ui, _send, _h) = start(remote.clone()).await;
        let before = remote.log().iter().filter(|l| *l == "ls").count();
        tokio::time::sleep(Duration::from_secs(21)).await;
        assert_eq!(remote.log().iter().filter(|l| *l == "ls").count(), before + 2);
    }

    #[tokio::test(start_paused = true)]
    async fn a_dropped_connection_reaches_the_model() {
        let remote = Arc::new(FakeRemote::default());
        *remote.sessions.lock().unwrap() = Ok(vec![session("default", 1)]);
        let (ui, _send, _h) = start(remote.clone()).await;
        remote.drop_connection();
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert_eq!(ui.last_view().header.word, "reconnecting");
    }
}
```

`a_dropped_connection_reaches_the_model` passes only after Task 6, which writes `on_dropped`. Mark it `#[ignore = "Task 6"]` for now, and Task 6 removes the attribute.

- [ ] **Step 3: Run the tests and watch them fail**

Run: `cargo test -p tether-app terminal::driver`
Expected: FAIL to compile (`Driver` and `msg_sink` not found).

- [ ] **Step 4: Implement the driver**

Add `pub fn frame_job(&self) -> Option<crate::terminal::frame::FrameJob> { None }` to `impl TerminalModel` in `model/mod.rs`; Task 8 replaces it. Add `pub mod driver; pub mod files; pub mod ui_port;` to `terminal/mod.rs`.

`src/terminal/files.rs` (stub):

```rust
use std::sync::Arc;
use crate::terminal::{driver::MsgSink, model::SendJob, remote::Remote};

pub async fn run_send<R: Remote>(_remote: Arc<R>, _job: SendJob, _send: MsgSink) {}
```

`src/terminal/driver.rs`:

```rust
use std::collections::HashMap;
use std::sync::Arc;

use tether_core::zmx::attach_command;
use tether_ssh::{ConnectionEvent, PtyEvent};
use tokio::sync::{broadcast, mpsc};
use tokio::task::JoinHandle;
use tokio::time::{interval, Instant, MissedTickBehavior};

use crate::terminal::frame::FramePacer;
use crate::terminal::model::{Effect, Msg, TerminalModel, TerminalView, TICK};
use crate::terminal::remote::{PtySink, Remote};
use crate::terminal::ui_port::UiPort;

pub enum DriverMsg<S> {
    Model(Msg),
    Opened(broadcast::Receiver<ConnectionEvent>),
    Sink { name: String, id: u64, sink: S, reader: JoinHandle<()> },
    Presented,
}

pub type MsgSink = Arc<dyn Fn(Msg) + Send + Sync>;

pub fn msg_sink<S: Send + 'static>(tx: mpsc::UnboundedSender<DriverMsg<S>>) -> MsgSink {
    Arc::new(move |m| { let _ = tx.send(DriverMsg::Model(m)); })
}

pub fn presented_sink<S: Send + 'static>(tx: mpsc::UnboundedSender<DriverMsg<S>>) -> Arc<dyn Fn() + Send + Sync> {
    Arc::new(move || { let _ = tx.send(DriverMsg::Presented); })
}

pub struct Driver<R: Remote, U: UiPort> {
    remote: Arc<R>,
    ui: U,
    tx: mpsc::UnboundedSender<DriverMsg<R::Sink>>,
    wanted: HashMap<String, u64>,
    sinks: HashMap<String, (R::Sink, JoinHandle<()>)>,
    drop_watch: Option<JoinHandle<()>>,
    pacer: FramePacer,
    last_view: Option<TerminalView>,
}

impl<R: Remote, U: UiPort> Driver<R, U> {
    pub fn new(remote: Arc<R>, ui: U, tx: mpsc::UnboundedSender<DriverMsg<R::Sink>>) -> Self {
        Self { remote, ui, tx, wanted: HashMap::new(), sinks: HashMap::new(), drop_watch: None, pacer: FramePacer::default(), last_view: None }
    }

    pub async fn run(mut self, mut model: TerminalModel, initial: Vec<Effect>, mut rx: mpsc::UnboundedReceiver<DriverMsg<R::Sink>>) {
        let start = Instant::now();
        let mut tick = interval(TICK);
        tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
        let mut exit = self.apply(&mut model, initial).await;
        self.push_view(&model);
        while !exit {
            let msg = tokio::select! {
                m = rx.recv() => match m { Some(m) => m, None => break },
                _ = tick.tick() => DriverMsg::Model(Msg::Tick),
            };
            let now = start.elapsed();
            let fx = match msg {
                DriverMsg::Model(m) => model.handle(m, now),
                DriverMsg::Opened(drops) => {
                    self.watch_drops(drops);
                    model.handle(Msg::Opened, now)
                }
                DriverMsg::Sink { name, id, sink, reader } => {
                    if self.wanted.get(&name) == Some(&id) {
                        if let Some((old, h)) = self.sinks.insert(name.clone(), (sink, reader)) {
                            h.abort();
                            tokio::spawn(async move { old.close().await });
                        }
                        model.handle(Msg::Attached { name }, now)
                    } else {
                        // Detached (or re-attached) while this channel was still opening.
                        reader.abort();
                        tokio::spawn(async move { sink.close().await });
                        Vec::new()
                    }
                }
                DriverMsg::Presented => {
                    if self.pacer.presented() { self.render(&model); }
                    Vec::new()
                }
            };
            exit = self.apply(&mut model, fx).await;
            self.push_view(&model);
        }
    }

    fn watch_drops(&mut self, mut drops: broadcast::Receiver<ConnectionEvent>) {
        if let Some(h) = self.drop_watch.take() { h.abort(); }
        let tx = self.tx.clone();
        // An intentional close aborts this task first, so any wake-up here is a real drop.
        self.drop_watch = Some(tokio::spawn(async move {
            let _ = drops.recv().await;
            let _ = tx.send(DriverMsg::Model(Msg::Dropped));
        }));
    }

    fn render(&mut self, model: &TerminalModel) {
        match model.frame_job() {
            Some(job) => self.ui.render(job),
            None => self.pacer.cancel(),
        }
    }

    fn push_view(&mut self, model: &TerminalModel) {
        let view = model.view();
        if self.last_view.as_ref() != Some(&view) {
            self.ui.view(view.clone());
            self.last_view = Some(view);
        }
    }

    async fn close_channels(&mut self) {
        if let Some(h) = self.drop_watch.take() { h.abort(); }
        self.wanted.clear();
        for (_, (sink, reader)) in self.sinks.drain() {
            reader.abort();
            sink.close().await;
        }
    }

    /// Returns true when the page is leaving and the loop should end.
    async fn apply(&mut self, model: &mut TerminalModel, fx: Vec<Effect>) -> bool {
        let mut exit = false;
        for effect in fx {
            match effect {
                Effect::Open => {
                    let (r, tx) = (self.remote.clone(), self.tx.clone());
                    tokio::spawn(async move {
                        let msg = match r.open().await {
                            Ok(drops) => DriverMsg::Opened(drops),
                            Err(e) => DriverMsg::Model(Msg::OpenFailed(e)),
                        };
                        let _ = tx.send(msg);
                    });
                }
                Effect::Close => {
                    self.close_channels().await;
                    self.remote.close().await;
                    exit = true;
                }
                Effect::DropConnection => {
                    self.close_channels().await;
                    self.remote.close().await;
                }
                Effect::Ls => {
                    let (r, tx) = (self.remote.clone(), self.tx.clone());
                    tokio::spawn(async move { let _ = tx.send(DriverMsg::Model(Msg::Ls(r.ls().await))); });
                }
                Effect::Kill { name } => {
                    let (r, tx) = (self.remote.clone(), self.tx.clone());
                    tokio::spawn(async move {
                        let _ = r.kill(&name).await;
                        let _ = tx.send(DriverMsg::Model(Msg::KillDone));
                    });
                }
                Effect::Attach { name, id, size } => {
                    self.wanted.insert(name.clone(), id);
                    let (r, tx) = (self.remote.clone(), self.tx.clone());
                    tokio::spawn(async move {
                        match r.attach(&name, size).await {
                            Ok((sink, mut events)) => {
                                sink.resize(size).await;
                                sink.write(attach_command(&name).into_bytes()).await;
                                let (txr, n) = (tx.clone(), name.clone());
                                // Drain without pause: M3's queue holds 1024 events, and a
                                // full queue in one tab stalls every channel on the connection.
                                let reader = tokio::spawn(async move {
                                    while let Some(PtyEvent::Data(bytes)) = events.recv().await {
                                        let _ = txr.send(DriverMsg::Model(Msg::PtyData { name: n.clone(), bytes }));
                                    }
                                    let _ = txr.send(DriverMsg::Model(Msg::PtyClosed { name: n }));
                                });
                                let _ = tx.send(DriverMsg::Sink { name, id, sink, reader });
                            }
                            Err(_) => { let _ = tx.send(DriverMsg::Model(Msg::AttachFailed { name })); }
                        }
                    });
                }
                Effect::Detach { name } => {
                    self.wanted.remove(&name);
                    if let Some((sink, reader)) = self.sinks.remove(&name) {
                        reader.abort();
                        tokio::spawn(async move { sink.close().await });
                    }
                }
                Effect::Write { name, bytes } => {
                    if let Some((sink, _)) = self.sinks.get(&name) { sink.write(bytes).await; }
                }
                Effect::ResizeAll(size) => {
                    for (sink, _) in self.sinks.values() { sink.resize(size).await; }
                }
                Effect::ScheduleRedial { after, generation } => {
                    let tx = self.tx.clone();
                    tokio::spawn(async move {
                        tokio::time::sleep(after).await;
                        let _ = tx.send(DriverMsg::Model(Msg::RedialDue { generation }));
                    });
                }
                Effect::StartSend(job) => {
                    tokio::spawn(crate::terminal::files::run_send(self.remote.clone(), job, msg_sink(self.tx.clone())));
                }
                Effect::Redraw => {
                    if self.pacer.mark_dirty() { self.render(model); }
                }
                Effect::Ui(u) => self.ui.apply(u),
            }
        }
        exit
    }
}
```

`PtyEvent::Data` arrives in the reader; any other event (`Closed`) ends the loop and reports `PtyClosed`. The model's `on_pty_data` runs on the driver task, never on the UI thread, so a burst in twelve tabs costs parsing time but never blocks the window.

- [ ] **Step 5: Run the tests and watch them pass**

Run: `cargo test -p tether-app terminal::`
Expected: PASS: the 2 pacer tests, 5 driver tests (1 ignored), and everything from Tasks 1–3.

- [ ] **Step 6: Commit**

```bash
git add clients/windows/crates/tether-app/src/terminal
git commit -m "feat(windows): driver runs the terminal model against the remote

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Terminal and connect pages in Slint, the Slint UiPort, opening a machine

**Files:**
- Create: `clients/windows/crates/tether-app/ui/terminal.slint`, `ui/connect_pages.slint`
- Modify: `ui/app.slint`, `src/router.rs`
- Create: `src/terminal/glue.rs`, `src/win32/mod.rs`
- Modify: `src/terminal/ui_port.rs` (add `SlintUi`), `src/terminal/geometry.rs` (add `TermStyle::from_prefs`), `src/terminal/frame.rs` (add stubs), `src/main.rs`

**Interfaces:**
- Consumes: M5's `App` (`ui`, `state`, `router`, `runtime`, `refresh_router`, `on_prefs_changed`), `Router`, `Page`, `PageKind`, `AppBridge`, `Tokens`, `ConfirmDialog`, `PrimaryButton`, `SecondaryButton`, and `IconButton`; `Driver`, `MsgSink`, `msg_sink`, `presented_sink`, `UiPort` (Task 4); `SshRemote` (Task 1); `tether_ssh::RusshTransport`; `tether_core::prefs::TerminalPrefs::clamped`.
- Produces:
  - Slint globals `TerminalVm` and `ConnectVm`, with the properties and callbacks in Step 3. `TerminalPage`, `HostKeyRefusedPage`, `CouldntConnectPage`.
  - `pub fn lamp_index(l: Lamp) -> i32`, `pub fn progress_index(s: &ProgressState) -> i32`, `pub fn tab_items_from(tabs: &[TabView]) -> Vec<TermTab>` in `ui_port.rs`.
  - `pub struct SlintUi { pub window: slint::Weak<AppWindow>, pub platform: Arc<dyn Platform>, pub send: MsgSink }`, implementing `UiPort`.
  - `pub trait Platform: Send + Sync + 'static { fn flash_taskbar(&self); fn set_progress(&self, p: Option<&Progress>); fn toast(&self, session: &str, title: &str, body: &str); fn open_url(&self, url: &str); fn set_clipboard(&self, text: &str); fn read_clipboard(&self) -> ClipboardSnapshot; fn bring_to_front(&self); fn pick_files(&self) -> Vec<PathBuf>; }`, plus `pub struct NullPlatform`.
  - `glue.rs`: `pub fn init(app: &Rc<App>, platform: Arc<dyn Platform>)`, `pub fn open_machine(app: &Rc<App>, machine: Machine)`, `pub fn current() -> Option<MsgSink>`, `pub fn apply_on_ui(w: &AppWindow, fx: UiEffect)`, and `pub fn prefs_changed(prefs: &TerminalPrefs)`.
  - `TermStyle::from_prefs(p: &TerminalPrefs) -> TermStyle`.
  - Stubs filled by Task 8: `frame::submit(job: FrameJob)` and `frame::attach_window(app: &AppWindow, presented: Arc<dyn Fn() + Send + Sync>)`.

- [ ] **Step 1: Write the failing mapping tests**

Append to `ui_port.rs`:

```rust
#[cfg(test)]
mod mapping_tests {
    use super::*;
    use crate::terminal::model::TabView;
    use crate::terminal::status::Lamp;
    use tether_core::osc::{Progress, ProgressState};

    #[test]
    fn lamp_indices_match_the_slint_order() {
        assert_eq!(lamp_index(Lamp::Warning), 0);
        assert_eq!(lamp_index(Lamp::Success), 1);
        assert_eq!(lamp_index(Lamp::Danger), 2);
    }

    #[test]
    fn tabs_map_with_progress_and_attention() {
        let tab = TabView {
            name: "build".into(), cwd_leaf: Some("api".into()), active: false, attention: true,
            progress: Some(Progress { state: ProgressState::Error, percent: 40 }),
        };
        let items = tab_items_from(&[tab]);
        assert_eq!(items[0].name, "build");
        assert_eq!(items[0].cwd, "api");
        assert!(items[0].attention);
        assert!(items[0].has_progress);
        assert!((items[0].progress - 0.4).abs() < 1e-6);
        assert_eq!(items[0].progress_state, 1);
    }

    #[test]
    fn style_from_prefs_falls_back_and_clamps() {
        let mut p = tether_core::prefs::TerminalPrefs::default();
        p.scheme = "no-such-theme".into();
        p.font = "menlo".into();
        p.size_pt = 99.0;
        let s = crate::terminal::geometry::TermStyle::from_prefs(&p);
        assert_eq!(s.theme.id, "tether");
        assert_eq!(s.font.id, "cascadia-mono");
        assert_eq!(s.size_pt, 24.0);
    }
}
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `cargo test -p tether-app mapping_tests`
Expected: FAIL to compile (`lamp_index`, `tab_items_from`, and `TermStyle::from_prefs` not found, and the `TermTab` type does not exist yet).

- [ ] **Step 3: Write the Slint pages**

`ui/terminal.slint`:

```slint
import { Tokens } from "tokens.slint";
import { ConfirmDialog, PrimaryButton, SecondaryButton, IconButton } from "components.slint";

export struct TermTab {
    name: string, cwd: string, active: bool, attention: bool,
    has-progress: bool, progress: float, progress-state: int,
}

export global TerminalVm {
    in property <string> machine;
    in property <string> session;
    in property <string> word;
    in property <int> lamp;              // 0 warning, 1 success, 2 danger
    in property <int> lamp-flash-seq;
    in property <[TermTab]> tabs;
    in property <image> frame;
    in property <int> frame-width;
    in property <int> frame-height;
    in property <bool> empty;
    in property <string> empty-title;
    in property <bool> naming;
    in property <string> naming-text;
    in property <string> kill-name;
    in property <bool> disconnected;
    in property <string> send-capsule;
    in property <bool> has-progress;
    in property <float> progress;
    in property <int> progress-state;    // 0 normal, 1 error, 2 indeterminate, 3 paused
    in property <string> tooltip;
    in property <length> pointer-x;
    in property <length> pointer-y;
    in property <bool> hand-cursor;
    in property <string> menu-link;
    in property <bool> menu-copy;        // the link menu's second item: Copy (a selection exists) or Paste
    in property <string> menu-tab;
    in property <length> menu-x;
    in property <length> menu-y;
    callback back();
    callback send-file();
    callback settings();
    callback select-tab(string);
    callback tab-menu(string, length, length);
    callback new-session();
    callback commit-name(string);
    callback cancel-name();
    callback kill-from-menu();
    callback kill-confirmed();
    callback kill-cancelled();
    callback close-menu();
    callback copy-link();
    callback menu-primary();
    callback reconnect();
    callback home();
    callback well-resized(length, length);
    // kind: 0 down, 1 up, 2 move. button: 0 left, 1 right, 2 middle, 3 none.
    callback pointer(int, int, bool, bool, bool, length, length);
    callback wheel(length, bool, bool, bool, length, length);
}

component Lamp inherits Rectangle {
    in property <int> lamp;
    in property <bool> flashing;
    width: 8px; height: 8px; border-radius: 4px;
    background: lamp == 0 ? Tokens.warning : lamp == 1 ? Tokens.success : Tokens.danger;
    opacity: flashing ? 0.25 : 1;
    animate opacity { duration: 90ms; }
}

component Header inherits Rectangle {
    property <bool> flashing;
    property <int> flash-seq: TerminalVm.lamp-flash-seq;
    changed flash-seq => { flashing = true; }
    Timer { interval: 180ms; running: flashing; triggered => { flashing = false; } }
    height: 52px;
    background: Tokens.surface;
    HorizontalLayout {
        padding-left: 8px; padding-right: 8px; spacing: 8px;
        IconButton { icon: @image-url("icons/back.svg"); clicked => { TerminalVm.back(); } }
        VerticalLayout { alignment: center; Lamp { lamp: TerminalVm.lamp; flashing: flashing; } }
        VerticalLayout {
            alignment: center;
            Text { text: TerminalVm.machine; color: Tokens.text; font-size: 14px; font-weight: 600; }
            HorizontalLayout {
                spacing: 4px;
                Text { text: TerminalVm.session; color: Tokens.text-secondary; font-size: 12px; }
                Text { text: "·"; color: Tokens.text-secondary; font-size: 12px; visible: TerminalVm.session != ""; }
                Text {
                    text: TerminalVm.word; font-size: 12px;
                    color: TerminalVm.lamp == 0 ? Tokens.warning : TerminalVm.lamp == 1 ? Tokens.success : Tokens.danger;
                }
            }
        }
        Rectangle { horizontal-stretch: 1; }
        SecondaryButton { text: "Send file…"; clicked => { TerminalVm.send-file(); } }
        IconButton { icon: @image-url("icons/gear.svg"); clicked => { TerminalVm.settings(); } }
    }
}

component ProgressBar inherits Rectangle {
    in property <float> value;
    in property <int> state;
    height: 2px;
    Rectangle {
        x: 0; height: parent.height;
        // Indeterminate is a steady partial bar: the chrome has no looping motion (DESIGN.md).
        width: state == 2 ? parent.width * 0.4 : parent.width * value;
        background: state == 1 ? Tokens.danger : state == 3 ? Tokens.warning : Tokens.accent;
        opacity: state == 2 ? 0.6 : 1;
    }
}

component TabStrip inherits Rectangle {
    height: 34px;
    background: Tokens.background;
    Flickable {
        viewport-width: row.preferred-width;
        row := HorizontalLayout {
            spacing: 2px; padding-left: 6px;
            for tab in TerminalVm.tabs: Rectangle {
                width: label.preferred-width;
                background: tab.active ? Tokens.raised : transparent;
                border-radius: Tokens.radius-control;
                label := HorizontalLayout {
                    padding-left: 12px; padding-right: 12px; spacing: 6px;
                    VerticalLayout { alignment: center; Rectangle { width: 6px; height: 6px; border-radius: 3px; background: Tokens.warning; visible: tab.attention; } }
                    Text { text: tab.name; color: tab.active ? Tokens.text : Tokens.text-secondary; font-size: 13px; vertical-alignment: center; }
                    if tab.cwd != "": Text { text: tab.cwd; color: Tokens.text-secondary; font-family: Tokens.mono-font; font-size: 11px; vertical-alignment: center; }
                }
                if tab.has-progress: ProgressBar { y: parent.height - 2px; width: parent.width; value: tab.progress; state: tab.progress-state; }
                TouchArea {
                    pointer-event(e) => {
                        if (e.kind == PointerEventKind.down && e.button == PointerEventButton.right) {
                            TerminalVm.tab-menu(tab.name, self.absolute-position.x + self.mouse-x, self.absolute-position.y + self.mouse-y);
                        }
                    }
                    clicked => { TerminalVm.select-tab(tab.name); }
                }
            }
            if TerminalVm.naming: Rectangle {
                width: 160px;
                background: Tokens.raised;
                border-radius: Tokens.radius-control;
                TextInput {
                    x: 10px; width: parent.width - 20px;
                    text: TerminalVm.naming-text;
                    color: Tokens.text; font-size: 13px; vertical-alignment: center;
                    single-line: true;
                    init => { self.focus(); self.select-all(); }
                    accepted => { TerminalVm.commit-name(self.text); }
                    key-pressed(e) => {
                        if (e.text == Key.Escape) { TerminalVm.cancel-name(); return accept; }
                        reject
                    }
                }
            }
            IconButton { icon: @image-url("icons/plus.svg"); clicked => { TerminalVm.new-session(); } }
        }
    }
}

export component TerminalPage inherits Rectangle {
    background: Tokens.background;
    VerticalLayout {
        Header { }
        if TerminalVm.has-progress: ProgressBar { value: TerminalVm.progress; state: TerminalVm.progress-state; }
        TabStrip { }
        Rectangle {
            vertical-stretch: 1;
            background: #1E1E2E;   // the Tether well; the rendered frame covers it with the theme background
            changed width => { TerminalVm.well-resized(self.width, self.height); }
            changed height => { TerminalVm.well-resized(self.width, self.height); }
            init => { TerminalVm.well-resized(self.width, self.height); }
            Image {
                x: 0; y: 0;
                width: TerminalVm.frame-width * 1phx;
                height: TerminalVm.frame-height * 1phx;
                source: TerminalVm.frame;
                image-rendering: pixelated;
            }
            TouchArea {
                mouse-cursor: TerminalVm.hand-cursor ? MouseCursor.pointer : MouseCursor.text;
                pointer-event(e) => {
                    TerminalVm.pointer(
                        e.kind == PointerEventKind.down ? 0 : e.kind == PointerEventKind.up ? 1 : 2,
                        e.button == PointerEventButton.left ? 0 : e.button == PointerEventButton.right ? 1 : e.button == PointerEventButton.middle ? 2 : 3,
                        e.modifiers.shift, e.modifiers.control, e.modifiers.alt, self.mouse-x, self.mouse-y);
                }
                scroll-event(e) => {
                    TerminalVm.wheel(e.delta-y, e.modifiers.shift, e.modifiers.control, e.modifiers.alt, self.mouse-x, self.mouse-y);
                    accept
                }
            }
            if TerminalVm.empty: VerticalLayout {
                alignment: center; spacing: 8px;
                Text { text: TerminalVm.empty-title; color: Tokens.text; font-size: 18px; horizontal-alignment: center; }
                Text { text: "Nothing runs until you start one."; color: Tokens.text-secondary; font-size: 13px; horizontal-alignment: center; }
                HorizontalLayout { alignment: center; PrimaryButton { text: "New session"; clicked => { TerminalVm.new-session(); } } }
            }
            if TerminalVm.disconnected: Rectangle {
                y: parent.height - 64px; height: 44px; width: capsule.preferred-width; x: (parent.width - self.width) / 2;
                background: Tokens.surface; border-radius: 22px; border-width: 1px; border-color: Tokens.border;
                capsule := HorizontalLayout {
                    padding: 6px; spacing: 6px;
                    PrimaryButton { text: "Reconnect"; clicked => { TerminalVm.reconnect(); } }
                    SecondaryButton { text: "Back to Home"; clicked => { TerminalVm.home(); } }
                }
            }
            if TerminalVm.send-capsule != "" && !TerminalVm.disconnected: Rectangle {
                y: parent.height - 56px; height: 32px; width: send-text.preferred-width + 32px; x: (parent.width - self.width) / 2;
                background: Tokens.surface; border-radius: 16px; border-width: 1px; border-color: Tokens.border;
                send-text := Text { text: TerminalVm.send-capsule; color: Tokens.text; font-size: 12px; vertical-alignment: center; horizontal-alignment: center; }
            }
            if TerminalVm.tooltip != "": Rectangle {
                x: TerminalVm.pointer-x + 12px; y: TerminalVm.pointer-y + 16px;
                width: tip.preferred-width + 16px; height: 24px;
                background: Tokens.surface; border-radius: 6px; border-width: 1px; border-color: Tokens.border;
                tip := Text { text: TerminalVm.tooltip; color: Tokens.text; font-size: 12px; vertical-alignment: center; horizontal-alignment: center; }
            }
        }
    }
    if TerminalVm.menu-link != "" || TerminalVm.menu-tab != "": TouchArea {
        clicked => { TerminalVm.close-menu(); }
        Rectangle {
            x: TerminalVm.menu-x; y: TerminalVm.menu-y; width: 160px; height: items.preferred-height;
            background: Tokens.surface; border-radius: 8px; border-width: 1px; border-color: Tokens.border;
            items := VerticalLayout {
                padding: 4px;
                if TerminalVm.menu-tab != "": SecondaryButton { text: "Kill session"; clicked => { TerminalVm.kill-from-menu(); } }
                if TerminalVm.menu-link != "": SecondaryButton { text: "Copy link"; clicked => { TerminalVm.copy-link(); } }
                if TerminalVm.menu-link != "": SecondaryButton { text: TerminalVm.menu-copy ? "Copy" : "Paste"; clicked => { TerminalVm.menu-primary(); } }
            }
        }
    }
    if TerminalVm.kill-name != "": ConfirmDialog {
        title: "Kill session " + TerminalVm.kill-name + "?";
        body: "Everything running in it stops. This can't be undone.";
        action: "Kill session";
        confirmed => { TerminalVm.kill-confirmed(); }
        cancelled => { TerminalVm.kill-cancelled(); }
    }
}
```

M5's icons live under `ui/icons/`. Add any of `back.svg`, `gear.svg`, or `plus.svg` that is missing there, each a 16×16 single-path SVG with `stroke="currentColor"`.

`ui/connect_pages.slint`:

```slint
import { Tokens } from "tokens.slint";
import { PrimaryButton, SecondaryButton } from "components.slint";

export global ConnectVm {
    in property <string> expected;
    in property <string> got;
    in property <string> sentence;
    callback back-home();
    callback retry();
}

component Fingerprint inherits TextInput {
    read-only: true;
    font-family: Tokens.mono-font;
    font-size: 12px;
    color: Tokens.text;
    wrap: word-wrap;
}

export component HostKeyRefusedPage inherits Rectangle {
    background: Tokens.background;
    VerticalLayout {
        padding: 32px; spacing: 12px; alignment: start;
        Text { text: "Host key changed — refused."; color: Tokens.danger; font-size: 20px; font-weight: 600; }
        Text { text: "Expected"; color: Tokens.text-secondary; font-size: 12px; }
        Fingerprint { text: ConnectVm.expected; }
        Text { text: "Got"; color: Tokens.text-secondary; font-size: 12px; }
        Fingerprint { text: ConnectVm.got; }
        HorizontalLayout { alignment: start; PrimaryButton { text: "Back to Home"; clicked => { ConnectVm.back-home(); } } }
    }
}

export component CouldntConnectPage inherits Rectangle {
    background: Tokens.background;
    VerticalLayout {
        padding: 32px; spacing: 16px; alignment: start;
        Text { text: ConnectVm.sentence; color: Tokens.text; font-size: 15px; wrap: word-wrap; }
        HorizontalLayout {
            spacing: 8px; alignment: start;
            PrimaryButton { text: "Retry"; clicked => { ConnectVm.retry(); } }
            SecondaryButton { text: "Back to Home"; clicked => { ConnectVm.back-home(); } }
        }
    }
}
```

In `ui/app.slint`, import and re-export `TerminalPage`, `HostKeyRefusedPage`, `CouldntConnectPage`, `TerminalVm`, `ConnectVm`, and `TermTab`. Add the three pages to M5's page switch (`if AppBridge.page == PageKind.terminal: TerminalPage { }` and so on), and add `terminal`, `host-key-refused`, and `couldnt-connect` to `PageKind` in `ui/bridge.slint`. The Esc rules and their router changes are under "Wiring into M5" below.

- [ ] **Step 4: Implement `Platform`, `SlintUi`, `from_prefs`, and `open_machine`**

`src/win32/mod.rs`:

```rust
use std::path::PathBuf;
use tether_core::osc::Progress;
use tether_core::paste::ClipboardSnapshot;

pub mod wndproc;
#[cfg(windows)] pub mod aumid;
#[cfg(windows)] pub mod clipboard;
#[cfg(windows)] pub mod file_dialog;
#[cfg(windows)] pub mod network;
#[cfg(windows)] pub mod shell;
#[cfg(windows)] pub mod taskbar;
#[cfg(windows)] pub mod toast;
#[cfg(windows)] pub mod wic;

pub trait Platform: Send + Sync + 'static {
    fn flash_taskbar(&self);
    fn set_progress(&self, p: Option<&Progress>);
    fn toast(&self, session: &str, title: &str, body: &str);
    fn open_url(&self, url: &str);
    fn set_clipboard(&self, text: &str);
    /// Blocking; called off the UI thread.
    fn read_clipboard(&self) -> ClipboardSnapshot;
    fn bring_to_front(&self);
    /// Modal; called on the UI thread.
    fn pick_files(&self) -> Vec<PathBuf>;
}

pub struct NullPlatform;

impl Platform for NullPlatform {
    fn flash_taskbar(&self) {}
    fn set_progress(&self, _p: Option<&Progress>) {}
    fn toast(&self, _s: &str, _t: &str, _b: &str) {}
    fn open_url(&self, _u: &str) {}
    fn set_clipboard(&self, _t: &str) {}
    fn read_clipboard(&self) -> ClipboardSnapshot { ClipboardSnapshot::Empty }
    fn bring_to_front(&self) {}
    fn pick_files(&self) -> Vec<PathBuf> { Vec::new() }
}
```

Create every module file it names, empty for now; each later task fills its own. Add `mod win32;` to `main.rs`.

`geometry.rs`, next to `TermStyle`:

```rust
impl TermStyle {
    /// Unknown ids fall back (Tether, Cascadia Mono) inside `theme_named` / `font_named`.
    pub fn from_prefs(p: &tether_core::prefs::TerminalPrefs) -> Self {
        let p = p.clone().clamped();
        Self { theme: theme_named(&p.scheme), font: font_named(&p.font), size_pt: p.size_pt, line_spacing: p.line_spacing, padding_pt: p.padding_pt, cursor: p.cursor, blink: p.blink }
    }
}
```

`frame.rs`, until Task 8:

```rust
pub fn submit(_job: FrameJob) {}
pub fn attach_window(_app: &crate::AppWindow, _presented: std::sync::Arc<dyn Fn() + Send + Sync>) {}
```

Append to `ui_port.rs`:

```rust
use std::sync::Arc;
use slint::{ComponentHandle, ModelRc, VecModel};
use tether_core::osc::ProgressState;
use crate::terminal::driver::MsgSink;
use crate::terminal::model::{CapsuleView, Msg, TabView};
use crate::terminal::status::Lamp;
use crate::win32::Platform;
use crate::{AppWindow, TermTab, TerminalVm};

pub fn lamp_index(l: Lamp) -> i32 {
    match l { Lamp::Warning => 0, Lamp::Success => 1, Lamp::Danger => 2 }
}

pub fn progress_index(s: &ProgressState) -> i32 {
    match s { ProgressState::Normal => 0, ProgressState::Error => 1, ProgressState::Indeterminate => 2, ProgressState::Paused => 3 }
}

pub fn tab_items_from(tabs: &[TabView]) -> Vec<TermTab> {
    tabs.iter().map(|t| TermTab {
        name: t.name.as_str().into(),
        cwd: t.cwd_leaf.clone().unwrap_or_default().into(),
        active: t.active,
        attention: t.attention,
        has_progress: t.progress.is_some(),
        progress: t.progress.as_ref().map(|p| p.percent as f32 / 100.0).unwrap_or(0.0),
        progress_state: t.progress.as_ref().map(|p| progress_index(&p.state)).unwrap_or(0),
    }).collect()
}

pub struct SlintUi {
    pub window: slint::Weak<AppWindow>,
    pub platform: Arc<dyn Platform>,
    pub send: MsgSink,
}

impl UiPort for SlintUi {
    fn apply(&self, fx: UiEffect) {
        let (platform, send) = (self.platform.clone(), self.send.clone());
        match fx {
            // Off the UI thread: a held clipboard retries, and a big DIB takes time to encode.
            UiEffect::ReadClipboard => {
                std::thread::spawn(move || {
                    let clip = platform.read_clipboard();
                    let now_unix = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
                    send(Msg::Paste { clip, now_unix });
                });
            }
            UiEffect::FlashTaskbar => platform.flash_taskbar(),
            UiEffect::Taskbar(p) => platform.set_progress(p.as_ref()),
            UiEffect::Toast { session, title, body } => platform.toast(&session, &title, &body),
            UiEffect::OpenUrl(url) => platform.open_url(&url),
            UiEffect::SetClipboard(text) => platform.set_clipboard(&text),
            UiEffect::BringToFront => platform.bring_to_front(),
            other => {
                let _ = self.window.upgrade_in_event_loop(move |w| crate::terminal::glue::apply_on_ui(&w, other));
            }
        }
    }

    fn view(&self, view: TerminalView) {
        let _ = self.window.upgrade_in_event_loop(move |w| {
            let vm = w.global::<TerminalVm>();
            vm.set_machine(view.header.machine.as_str().into());
            vm.set_session(view.header.session.as_str().into());
            vm.set_word(view.header.word.into());
            vm.set_lamp(lamp_index(view.header.lamp));
            vm.set_tabs(ModelRc::new(VecModel::from(tab_items_from(&view.tabs))));
            vm.set_empty(view.empty.is_some());
            vm.set_empty_title(view.empty.as_ref().map(|e| e.title.as_str()).unwrap_or("").into());
            vm.set_naming(view.naming.is_some());
            vm.set_naming_text(view.naming.clone().unwrap_or_default().into());
            vm.set_kill_name(view.kill_prompt.clone().unwrap_or_default().into());
            vm.set_disconnected(matches!(view.capsule, Some(CapsuleView::Disconnected)));
            vm.set_send_capsule(match &view.capsule { Some(CapsuleView::Send(s)) => s.as_str().into(), _ => "".into() });
            vm.set_has_progress(view.progress.is_some());
            vm.set_progress(view.progress.as_ref().map(|p| p.percent as f32 / 100.0).unwrap_or(0.0));
            vm.set_progress_state(view.progress.as_ref().map(|p| progress_index(&p.state)).unwrap_or(0));
            w.set_window_title(view.title.as_str().into());
        });
    }

    fn render(&self, job: FrameJob) {
        crate::terminal::frame::submit(job);
    }
}
```

`src/terminal/glue.rs`:

```rust
use std::cell::RefCell;
use std::rc::{Rc, Weak};
use std::sync::Arc;

use slint::ComponentHandle;
use tether_core::profiles::Machine;
use tether_core::resize::GridSize;

use crate::app::App;
use crate::router::Page;
use crate::terminal::driver::{msg_sink, presented_sink, Driver, MsgSink};
use crate::terminal::geometry::TermStyle;
use crate::terminal::model::{FontStep, MenuRequest, Msg, PointerShape, Screen, TerminalModel, UiEffect};
use crate::terminal::remote::SshRemote;
use crate::terminal::ui_port::SlintUi;
use crate::win32::Platform;
use crate::{AppWindow, ConnectVm, TerminalVm};

thread_local! {
    static CURRENT: RefCell<Option<MsgSink>> = const { RefCell::new(None) };
    static APP: RefCell<Weak<App>> = const { RefCell::new(Weak::new()) };
    static PLATFORM: RefCell<Option<Arc<dyn Platform>>> = const { RefCell::new(None) };
    static WIRED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

pub fn current() -> Option<MsgSink> { CURRENT.with(|c| c.borrow().clone()) }

fn send(m: Msg) { if let Some(s) = current() { s(m); } }

fn app() -> Option<Rc<App>> { APP.with(|a| a.borrow().upgrade()) }

/// Called once from `main.rs`, before `app.run()`.
pub fn init(app: &Rc<App>, platform: Arc<dyn Platform>) {
    APP.with(|a| *a.borrow_mut() = Rc::downgrade(app));
    PLATFORM.with(|p| *p.borrow_mut() = Some(platform));
}

fn platform() -> Arc<dyn Platform> {
    PLATFORM.with(|p| p.borrow().clone()).unwrap_or_else(|| Arc::new(crate::win32::NullPlatform))
}

/// The body of M5's `open_machine::on_open_machine`.
pub fn open_machine(app: &Rc<App>, machine: Machine) {
    let (style, hostkeys, secrets) = {
        let s = app.state.borrow();
        (TermStyle::from_prefs(&s.prefs.terminal), s.hostkeys.clone(), s.secrets.clone())
    };
    let rt = app.runtime.handle().clone();
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let sink = msg_sink(tx.clone());
    let ui = SlintUi { window: app.ui.as_weak(), platform: platform(), send: sink.clone() };
    let transport = tether_ssh::RusshTransport::new(rt.clone());
    let remote = Arc::new(SshRemote::new(transport, machine.clone(), hostkeys, secrets));
    // The real size arrives with the first well-resized message. 80×24 covers an attach that races ahead of it.
    let size = GridSize { cols: 80, rows: 24, width_px: 640, height_px: 384 };
    let (model, initial) = TerminalModel::new(machine, style, size);
    crate::terminal::frame::attach_window(&app.ui, presented_sink(tx.clone()));
    rt.spawn(Driver::new(remote, ui, tx).run(model, initial, rx));
    CURRENT.with(|c| *c.borrow_mut() = Some(sink));
    if !WIRED.replace(true) { wire_callbacks(&app.ui); }
    app.router.go(Page::Terminal);
    app.refresh_router();
}

/// Callbacks route through `current()`, so wiring them once per window is enough:
/// opening another machine only swaps the sink behind them.
fn wire_callbacks(ui: &AppWindow) {
    let vm = ui.global::<TerminalVm>();
    vm.on_back(|| send(Msg::Back));
    vm.on_home(|| send(Msg::Back));
    vm.on_reconnect(|| send(Msg::Reconnect));
    vm.on_select_tab(|n| send(Msg::SelectTab(n.into())));
    vm.on_new_session(|| send(Msg::NewSessionBegin));
    vm.on_commit_name(|n| send(Msg::NewSessionCommit(n.into())));
    vm.on_cancel_name(|| send(Msg::NewSessionCancel));
    vm.on_kill_confirmed(|| send(Msg::KillConfirmed));
    vm.on_kill_cancelled(|| send(Msg::KillCancelled));
    let weak = ui.as_weak();
    vm.on_tab_menu(move |name, x, y| {
        let Some(w) = weak.upgrade() else { return };
        let vm = w.global::<TerminalVm>();
        vm.set_menu_x(x); vm.set_menu_y(y); vm.set_menu_tab(name);
    });
    let weak = ui.as_weak();
    vm.on_kill_from_menu(move || {
        let Some(w) = weak.upgrade() else { return };
        let vm = w.global::<TerminalVm>();
        let name = vm.get_menu_tab().to_string();
        vm.set_menu_tab("".into());
        send(Msg::KillRequested(name));
    });
    let weak = ui.as_weak();
    vm.on_close_menu(move || {
        let Some(w) = weak.upgrade() else { return };
        let vm = w.global::<TerminalVm>();
        vm.set_menu_tab("".into());
        vm.set_menu_link("".into());
    });
    vm.on_send_file(|| {
        let files = platform().pick_files();
        if !files.is_empty() { send(Msg::SendFiles(files)); }
    });
    vm.on_settings(|| {
        if let Some(app) = app() { app.router.go(Page::Settings); app.refresh_router(); }
    });
    let weak = ui.as_weak();
    vm.on_well_resized(move |w, h| {
        let Some(win) = weak.upgrade() else { return };
        let scale = win.window().scale_factor();
        send(Msg::WellResized { width_px: (w * scale).round() as u32, height_px: (h * scale).round() as u32, scale });
    });
    let cv = ui.global::<ConnectVm>();
    cv.on_retry(|| send(Msg::Retry));
    cv.on_back_home(|| send(Msg::Back));
    // Pointer, wheel, and the link menu: Task 11. Keys, IME, drops, focus: Task 9 and Task 13.
}

/// The UI-thread half of the `UiEffect`s that touch Slint or app state.
pub fn apply_on_ui(w: &AppWindow, fx: UiEffect) {
    let vm = w.global::<TerminalVm>();
    let Some(app) = app() else { return };
    match fx {
        // Couldn't connect → Retry: the terminal page comes back on top of Home.
        UiEffect::Navigate(Screen::Terminal) => {
            if app.router.current() != Page::Terminal { app.router.home(); app.router.go(Page::Terminal); }
            app.refresh_router();
        }
        // The two connect pages replace the terminal page, so leaving them lands on Home.
        UiEffect::Navigate(Screen::Refused { expected, got }) => {
            let cv = w.global::<ConnectVm>();
            cv.set_expected(expected.into());
            cv.set_got(got.into());
            app.router.home();
            app.router.go(Page::HostKeyRefused);
            app.refresh_router();
        }
        UiEffect::Navigate(Screen::Failed { sentence }) => {
            w.global::<ConnectVm>().set_sentence(sentence.into());
            app.router.home();
            app.router.go(Page::CouldntConnect);
            app.refresh_router();
        }
        UiEffect::Home => {
            CURRENT.with(|c| *c.borrow_mut() = None);
            w.set_window_title("Tether".into());
            app.router.home();
            app.refresh_router();
        }
        UiEffect::LampFlash => vm.set_lamp_flash_seq(vm.get_lamp_flash_seq() + 1),
        UiEffect::SetTitle(t) => w.set_window_title(t.into()),
        UiEffect::FontStep(step) => {
            {
                let mut s = app.state.borrow_mut();
                match step {
                    FontStep::Bigger => s.prefs.terminal.bigger(),
                    FontStep::Smaller => s.prefs.terminal.smaller(),
                    FontStep::Reset => s.prefs.terminal.reset_size(),
                }
            }
            // Saves, re-skins, and (through `prefs_changed`) restyles every tab.
            app.on_prefs_changed();
        }
        UiEffect::Pointer(shape) => vm.set_hand_cursor(shape == PointerShape::Hand),
        UiEffect::Tooltip(tip) => vm.set_tooltip(tip.unwrap_or_default().into()),
        UiEffect::Menu(MenuRequest::Tab { name }) => vm.set_menu_tab(name.into()),
        UiEffect::Menu(MenuRequest::Link { url, copy_selection }) => {
            vm.set_menu_copy(copy_selection);
            vm.set_menu_link(url.into());
        }
        // SlintUi::apply handles these before they get here.
        UiEffect::ReadClipboard | UiEffect::FlashTaskbar | UiEffect::Taskbar(_) | UiEffect::Toast { .. }
        | UiEffect::OpenUrl(_) | UiEffect::SetClipboard(_) | UiEffect::BringToFront | UiEffect::PickFiles => {}
    }
}

/// M6's line in `App::on_prefs_changed`: settings and font shortcuts restyle the open terminal.
pub fn prefs_changed(prefs: &tether_core::prefs::TerminalPrefs) {
    send(Msg::StyleChanged(TermStyle::from_prefs(prefs)));
}
```

Wiring into M5:
- `open_machine.rs`: replace the stub body with `crate::terminal::glue::open_machine(app, machine);`.
- `app.rs`: in `on_prefs_changed`, after `save_prefs`, add `crate::terminal::glue::prefs_changed(&self.state.borrow().prefs.terminal);`. A theme change then also answers OSC 10/11 queries with the new colors (M4's `set_theme`). In `page_kind()`, add `Page::Terminal => PageKind::Terminal`, `Page::HostKeyRefused => PageKind::HostKeyRefused`, and `Page::CouldntConnect => PageKind::CouldntConnect`.
- `router.rs`: add the three pages, and change `escape_is_back` to `!matches!(page, Page::Home | Page::Terminal | Page::HostKeyRefused | Page::CouldntConnect)`. Add a router test asserting `!escape_is_back(&Page::Terminal)`.
- `connect_pages.slint`: wrap each page's layout in `FocusScope { init => { self.focus(); } key-pressed(e) => { if (e.text == Key.Escape) { ConnectVm.back-home(); return accept; } reject } … }`. Esc there is **Back to Home**, and the driver hears about it.
- `main.rs`: after `let app = app::App::new()?;`, call `terminal::glue::init(&app, platform.clone());`. `platform` is `Arc::new(win32::NullPlatform)` until Task 12 swaps in `WindowsPlatform`. Register `app.ui.window().on_close_requested(|| { if let Some(s) = crate::terminal::glue::current() { s(crate::terminal::model::Msg::Back); } slint::CloseRequestResponse::HideWindow });`. Closing the window drops every channel the way Back does, and the zmx sessions keep running.

- [ ] **Step 5: Run the tests and the app**

Run: `cargo test -p tether-app` → PASS (the mapping tests and everything from earlier tasks).
Run (on Windows): `cargo run -p tether-app`, then open a machine that runs `zmx`.

Manual check. The grid doesn't render until Task 8, so the well stays the Tether color:
- [ ] The header reads the machine name and `connecting`, then `connected` with a green lamp. The status word is present the whole time.
- [ ] The tab strip lists the host's `zmx ls` sessions, oldest left, with `+` at the end. A long list scrolls sideways and never wraps.
- [ ] On a host with no sessions: "No session on <machine>", "Nothing runs until you start one.", and **New session**.
- [ ] A machine with a wrong password lands on Couldn't connect, with "Authentication failed. Check the key or password.", **Retry**, and **Back to Home**.
- [ ] Edit `%LOCALAPPDATA%\Tether\hostkeys.json` to a wrong fingerprint for a host, then open that host. The page shows "Host key changed — refused.", Expected, and Got. Both fingerprints can be selected and copied, and **Back to Home** is the only action.
- [ ] Back returns to Home. On the host, `zmx ls` still lists the sessions.
- [ ] The header and strip match `clients/windows/design-preview/index.html` (Terminal screen), in both Dark and Light.

- [ ] **Step 6: Commit**

```bash
git add clients/windows/crates/tether-app
git commit -m "feat(windows): terminal and connect pages wired to the driver

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Reconnect, wake triggers, and lock grace in the model

**Files:**
- Modify: `clients/windows/crates/tether-app/src/terminal/model/reconnect.rs`
- Modify: `src/terminal/driver.rs` (drop the `#[ignore]` on `a_dropped_connection_reaches_the_model`)

**Interfaces:**
- Consumes: `tether_core::connect::{RECONNECT_BACKOFF, ConnectError::retryable}`, `tether_core::lock::{LockGrace, LockAction}`, `tether_core::upload::CAPSULE_LINGER`.
- Produces: the finished `on_dropped`, `on_redial_due`, `on_redial_failed`, `redial_now`, `force_redial`, `on_network`, `on_reconnect_clicked`, `on_unlock`, and `on_tick`. `on_tick` calls three hooks that this task stubs, each `pub(crate) fn …(&mut self, now: Duration, fx: &mut Vec<Effect>)`: `tick_sync` (Task 8 fills it), `tick_resize` (Task 7), and `tick_toasts` (Task 12).

- [ ] **Step 1: Write the failing tests**

Append to `reconnect.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::super::tests::{has_attach, live, t};
    use super::*;
    use crate::terminal::testkit::session;
    use tether_core::keymap::{KeyInput, Mods};

    fn redial(fx: &[Effect]) -> Option<(Duration, u64)> {
        fx.iter().find_map(|e| match e { Effect::ScheduleRedial { after, generation } => Some((*after, *generation)), _ => None })
    }

    #[test]
    fn a_drop_keeps_the_tabs_and_backs_off_1_2_4() {
        let mut m = live(vec![session("a", 1), session("b", 2)]);
        let fx = m.handle(Msg::Dropped, t(100));
        assert!(fx.contains(&Effect::DropConnection));
        assert_eq!(m.view().header.word, "reconnecting");
        assert_eq!(m.view().tabs.len(), 2);
        let (after, g) = redial(&fx).unwrap();
        assert_eq!(after, Duration::from_secs(1));
        assert_eq!(m.handle(Msg::RedialDue { generation: g }, t(1_100)), vec![Effect::Open]);
        let (after, g) = redial(&m.handle(Msg::OpenFailed(ConnectError::Timeout), t(1_200))).unwrap();
        assert_eq!(after, Duration::from_secs(2));
        m.handle(Msg::RedialDue { generation: g }, t(3_200));
        let (after, g) = redial(&m.handle(Msg::OpenFailed(ConnectError::Timeout), t(3_300))).unwrap();
        assert_eq!(after, Duration::from_secs(4));
        m.handle(Msg::RedialDue { generation: g }, t(7_300));
        let fx = m.handle(Msg::OpenFailed(ConnectError::Timeout), t(7_400));
        assert!(redial(&fx).is_none());
        assert_eq!(m.view().header.word, "disconnected");
        assert_eq!(m.view().capsule, Some(CapsuleView::Disconnected));
    }

    #[test]
    fn reconnect_reattaches_every_attached_tab_active_first_on_fresh_channels() {
        let mut m = live(vec![session("a", 1), session("b", 2)]);
        m.handle(Msg::SelectTab("a".into()), t(10));
        m.handle(Msg::Attached { name: "a".into() }, t(10));
        m.handle(Msg::Dropped, t(100));
        let fx = m.handle(Msg::Opened, t(1_200));
        let attaches: Vec<_> = fx.iter().filter_map(|e| match e { Effect::Attach { name, .. } => Some(name.as_str()), _ => None }).collect();
        assert_eq!(attaches, ["a", "b"]);
        assert_eq!(m.view().header.word, "connected");
    }

    #[test]
    fn input_is_dropped_while_reconnecting() {
        let mut m = live(vec![session("a", 1)]);
        m.handle(Msg::Dropped, t(100));
        let key = KeyInput::Char { unmodified: 'x', produced: Some("x".into()), digit: None };
        let fx = m.handle(Msg::Key { input: key, mods: Mods::default() }, t(200));
        assert!(!fx.iter().any(|e| matches!(e, Effect::Write { .. })));
    }

    #[test]
    fn focus_and_network_back_redial_now_and_cancel_the_timer() {
        let mut m = live(vec![session("a", 1)]);
        let (_, g) = redial(&m.handle(Msg::Dropped, t(100))).unwrap();
        assert_eq!(m.handle(Msg::Network { online: true, route_changed: false }, t(200)), vec![Effect::Open]);
        assert!(m.handle(Msg::RedialDue { generation: g }, t(1_100)).is_empty());
        m.handle(Msg::OpenFailed(ConnectError::Timeout), t(1_200));
        m.handle(Msg::Focus(false), t(1_300));
        assert!(m.handle(Msg::Focus(true), t(1_400)).contains(&Effect::Open));
    }

    #[test]
    fn a_trigger_does_not_open_twice() {
        let mut m = live(vec![session("a", 1)]);
        m.handle(Msg::Dropped, t(100));
        assert_eq!(m.handle(Msg::Resumed, t(200)), vec![Effect::Open]);
        assert!(m.handle(Msg::Network { online: true, route_changed: false }, t(300)).is_empty());
    }

    #[test]
    fn resume_drops_and_redials_at_once() {
        let mut m = live(vec![session("a", 1)]);
        let fx = m.handle(Msg::Resumed, t(100));
        assert_eq!(fx[..2], [Effect::DropConnection, Effect::Open]);
        assert_eq!(m.view().header.word, "reconnecting");
    }

    #[test]
    fn a_route_change_redials_but_a_same_route_blip_does_not() {
        let mut m = live(vec![session("a", 1)]);
        assert!(m.handle(Msg::Network { online: true, route_changed: false }, t(100)).is_empty());
        assert!(m.handle(Msg::Network { online: true, route_changed: true }, t(200)).contains(&Effect::DropConnection));
    }

    #[test]
    fn a_mismatch_on_redial_lands_on_refused() {
        let mut m = live(vec![session("a", 1)]);
        m.handle(Msg::Dropped, t(100));
        let fx = m.handle(Msg::OpenFailed(ConnectError::HostKeyChanged { expected: "a".into(), got: "b".into() }), t(1_200));
        assert!(fx.contains(&Effect::Close));
        assert!(matches!(m.view().screen, Screen::Refused { .. }));
    }

    #[test]
    fn auth_failure_on_redial_does_not_retry() {
        let mut m = live(vec![session("a", 1)]);
        m.handle(Msg::Dropped, t(100));
        let fx = m.handle(Msg::OpenFailed(ConnectError::AuthRejected), t(1_200));
        assert!(redial(&fx).is_none());
        assert_eq!(m.view().header.word, "disconnected");
    }

    #[test]
    fn reconnect_button_from_disconnected() {
        let mut m = live(vec![session("a", 1)]);
        m.handle(Msg::Dropped, t(0));
        for g in 1..=3 {
            m.handle(Msg::RedialDue { generation: g }, t(10));
            m.handle(Msg::OpenFailed(ConnectError::Timeout), t(20));
        }
        assert_eq!(m.view().header.word, "disconnected");
        assert_eq!(m.handle(Msg::Reconnect, t(30)), vec![Effect::Open]);
        assert_eq!(m.view().header.word, "reconnecting");
    }

    #[test]
    fn lock_detaches_after_15s_not_before_and_unlock_reattaches() {
        let mut m = live(vec![session("a", 1), session("b", 2)]);
        m.handle(Msg::SelectTab("a".into()), t(1));
        m.handle(Msg::Attached { name: "a".into() }, t(1));
        m.handle(Msg::Locked, t(1_000));
        assert!(!m.handle(Msg::Tick, t(15_900)).iter().any(|e| matches!(e, Effect::Detach { .. })));
        let fx = m.handle(Msg::Tick, t(16_100));
        assert!(fx.contains(&Effect::Detach { name: "a".into() }));
        assert!(fx.contains(&Effect::Detach { name: "b".into() }));
        let fx = m.handle(Msg::Unlocked, t(30_000));
        assert!(has_attach(&fx, "a") && has_attach(&fx, "b"));
    }

    #[test]
    fn unlock_inside_the_grace_detaches_nothing() {
        let mut m = live(vec![session("a", 1)]);
        m.handle(Msg::Locked, t(1_000));
        assert!(m.handle(Msg::Unlocked, t(5_000)).is_empty());
        assert!(!m.handle(Msg::Tick, t(20_000)).iter().any(|e| matches!(e, Effect::Detach { .. })));
    }
}
```

`reconnect_button_from_disconnected` relies on the generation sequence: the drop schedules generation 1, and each failure schedules the next one.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `cargo test -p tether-app terminal::model::reconnect`
Expected: FAIL. The stubs produce no effects, so `redial(&fx).unwrap()` panics.

- [ ] **Step 3: Implement**

Replace `reconnect.rs` (above its tests) with:

```rust
use super::*;
use tether_core::connect::RECONNECT_BACKOFF;
use tether_core::lock::LockAction;
use tether_core::upload::CAPSULE_LINGER;

impl TerminalModel {
    pub(crate) fn on_dropped(&mut self, fx: &mut Vec<Effect>) {
        if self.status != ConnStatus::Connected { return; }
        self.begin_reconnect();
        fx.push(Effect::DropConnection);
        self.schedule(fx);
        fx.push(Effect::Redraw);
    }

    /// The page, the strip, and every grid stay. Only the channels go.
    fn begin_reconnect(&mut self) {
        self.status = ConnStatus::Reconnecting;
        self.channels.clear();
        self.attempt = 0;
        self.opening = false;
    }

    fn schedule(&mut self, fx: &mut Vec<Effect>) {
        self.generation += 1;
        fx.push(Effect::ScheduleRedial { after: RECONNECT_BACKOFF[self.attempt], generation: self.generation });
    }

    fn open_now(&mut self, fx: &mut Vec<Effect>) {
        if self.opening { return; }
        self.opening = true;
        // A newer generation turns any pending timer into a no-op.
        self.generation += 1;
        fx.push(Effect::Open);
    }

    pub(crate) fn on_redial_due(&mut self, generation: u64, fx: &mut Vec<Effect>) {
        if generation != self.generation || self.status != ConnStatus::Reconnecting { return; }
        self.attempt += 1;
        self.open_now(fx);
    }

    pub(crate) fn on_redial_failed(&mut self, err: ConnectError, fx: &mut Vec<Effect>) {
        if let ConnectError::HostKeyChanged { expected, got } = err {
            self.status = ConnStatus::Disconnected;
            self.screen = Screen::Refused { expected, got };
            fx.push(Effect::Close);
            fx.push(Effect::Ui(UiEffect::Navigate(self.screen.clone())));
            return;
        }
        if err.retryable() && self.status == ConnStatus::Reconnecting && self.attempt < RECONNECT_BACKOFF.len() {
            self.schedule(fx);
        } else {
            self.status = ConnStatus::Disconnected;
        }
        fx.push(Effect::Redraw);
    }

    /// Focus, network back, resume: try now instead of waiting out the backoff.
    pub(crate) fn redial_now(&mut self, fx: &mut Vec<Effect>) {
        match self.status {
            ConnStatus::Reconnecting => self.open_now(fx),
            ConnStatus::Disconnected if self.strip.is_some() && matches!(self.screen, Screen::Terminal) => {
                // One attempt; on failure it is back to disconnected, not a fresh 1/2/4 s cycle.
                self.status = ConnStatus::Reconnecting;
                self.attempt = RECONNECT_BACKOFF.len();
                self.open_now(fx);
            }
            _ => {}
        }
    }

    /// A socket that slept through a suspend often still looks open, and the keepalives
    /// would take 30 s to notice. Drop it and redial now.
    pub(crate) fn force_redial(&mut self, fx: &mut Vec<Effect>) {
        if self.status == ConnStatus::Connected {
            self.begin_reconnect();
            fx.push(Effect::DropConnection);
            self.open_now(fx);
        } else {
            self.redial_now(fx);
        }
    }

    pub(crate) fn on_network(&mut self, online: bool, route_changed: bool, fx: &mut Vec<Effect>) {
        if !online { return; }
        if self.status == ConnStatus::Connected {
            if route_changed { self.force_redial(fx); }
        } else {
            self.redial_now(fx);
        }
    }

    pub(crate) fn on_reconnect_clicked(&mut self, fx: &mut Vec<Effect>) {
        if self.status != ConnStatus::Disconnected { return; }
        self.status = ConnStatus::Reconnecting;
        self.attempt = 0;
        self.open_now(fx);
    }

    pub(crate) fn on_unlock(&mut self, fx: &mut Vec<Effect>) {
        // Inside the grace, `on_unlock` just cancels the pending detach.
        let _ = self.lock.on_unlock();
        if self.lock_detached {
            self.lock_detached = false;
            self.reattach_all(fx);
        }
    }

    pub(crate) fn on_tick(&mut self, now: Duration, fx: &mut Vec<Effect>) {
        self.refresh_due(now, fx);
        self.tick_sync(now, fx);
        self.tick_resize(now, fx);
        self.tick_toasts(now, fx);
        if self.lock.poll(now) == LockAction::DetachAll {
            // The strip keeps these tabs logically attached; unlock opens them again.
            let names = self.strip.as_ref().map(|s| s.reattach_order()).unwrap_or_default();
            for name in names { self.close_channel(&name, fx); }
            self.lock_detached = true;
        }
        if self.capsule_shown.is_some_and(|shown| now.saturating_sub(shown) >= CAPSULE_LINGER) {
            self.capsule_shown = None;
            self.send = None;
        }
    }

    pub(crate) fn tick_sync(&mut self, _now: Duration, _fx: &mut Vec<Effect>) {}
    pub(crate) fn tick_resize(&mut self, _now: Duration, _fx: &mut Vec<Effect>) {}
    pub(crate) fn tick_toasts(&mut self, _now: Duration, _fx: &mut Vec<Effect>) {}
}
```

`capsule_shown` holds the moment a finished send's capsule appeared, and Task 14 sets it. Delete the temporary `on_tick` and `redial_now` that Task 3 put in `reconnect.rs`. `on_open_failed` (Task 2) already routes here once a strip exists. Remove the `#[ignore]` from `a_dropped_connection_reaches_the_model` in `driver.rs`.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `cargo test -p tether-app terminal::`
Expected: PASS: the 12 reconnect tests, the un-ignored driver test, and everything before.

- [ ] **Step 5: Commit**

```bash
git add clients/windows/crates/tether-app/src/terminal
git commit -m "feat(windows): reconnect with backoff, wake triggers, and lock grace

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Geometry, resize settle, and monitor scale changes

**Files:**
- Modify: `clients/windows/crates/tether-app/src/terminal/geometry.rs`
- Modify: `src/terminal/model/input.rs` (`on_well_resized`, `on_style`), `src/terminal/model/reconnect.rs` (`tick_resize`), `src/terminal/model/mod.rs` (a `layout` field and accessor)

**Interfaces:**
- Consumes: `tether_term::{pt_to_px, cell_metrics, grid_size, Cell}`, `tether_core::resize::{GridSize, ResizeDebouncer}`, `TabTerminal::{resize, set_theme}`.
- Produces:
  - `#[derive(Debug, Clone, Copy, PartialEq)] pub struct Layout { pub size: GridSize, pub padding_px: u32, pub cell_w: f32, pub cell_h: f32, pub size_px: f32, pub width_px: u32, pub height_px: u32 }`
  - `pub fn layout(width_px: u32, height_px: u32, scale: f32, style: &TermStyle) -> Layout`
  - `pub fn cell_at(l: &Layout, x_px: f32, y_px: f32) -> Cell`, which turns a physical-pixel point into a viewport cell, bottom-anchored
  - `TerminalModel::layout(&self) -> Option<Layout>`
  - working `on_well_resized`, `on_style`, and `tick_resize`

- [ ] **Step 1: Write the failing tests**

Append to `geometry.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn points_scale_with_the_monitor() {
        let s = TermStyle::default();
        let one = layout(1600, 1000, 1.0, &s);
        let two = layout(3200, 2000, 2.0, &s);
        assert!((two.size_px - 2.0 * one.size_px).abs() < 0.01);
        assert_eq!(two.padding_px, 2 * one.padding_px);
        assert_eq!((one.size.cols, one.size.rows), (two.size.cols, two.size.rows));
        assert_ne!(one.size.width_px, two.size.width_px);
    }

    #[test]
    fn pointer_maps_to_cells_from_the_bottom() {
        let l = Layout {
            size: GridSize { cols: 10, rows: 5, width_px: 100, height_px: 100 },
            padding_px: 8, cell_w: 10.0, cell_h: 20.0, size_px: 14.0, width_px: 200, height_px: 300,
        };
        // Grid bottom at 300 - 8 = 292, so its top is at 192.
        assert_eq!(cell_at(&l, 8.0, 192.0), Cell { row: 0, col: 0 });
        assert_eq!(cell_at(&l, 27.0, 291.0), Cell { row: 4, col: 1 });
        // Points outside the grid clamp onto its edge cells.
        assert_eq!(cell_at(&l, 0.0, 0.0), Cell { row: 0, col: 0 });
        assert_eq!(cell_at(&l, 999.0, 999.0), Cell { row: 4, col: 9 });
    }
}
```

Append to `input.rs`:

```rust
#[cfg(test)]
mod resize_tests {
    use super::super::tests::{live, t};
    use super::*;
    use crate::terminal::testkit::session;

    fn resizes(fx: &[Effect]) -> Vec<GridSize> {
        fx.iter().filter_map(|e| match e { Effect::ResizeAll(s) => Some(*s), _ => None }).collect()
    }

    #[test]
    fn resize_steps_redraw_locally_and_resize_the_pty_once() {
        let mut m = live(vec![session("a", 1)]);
        for (i, w) in [1000u32, 1040, 1080, 1120].iter().enumerate() {
            let fx = m.handle(Msg::WellResized { width_px: *w, height_px: 700, scale: 1.0 }, t(30 * i as u64));
            assert!(fx.contains(&Effect::Redraw));
            assert!(resizes(&fx).is_empty());
        }
        assert!(resizes(&m.handle(Msg::Tick, t(200))).is_empty());
        let sent = resizes(&m.handle(Msg::Tick, t(260)));
        assert_eq!(sent, vec![m.layout().unwrap().size]);
        assert!(resizes(&m.handle(Msg::Tick, t(400))).is_empty());
    }

    #[test]
    fn scale_change_recomputes_px_and_resizes_once() {
        let mut m = live(vec![session("a", 1)]);
        m.handle(Msg::WellResized { width_px: 1600, height_px: 1000, scale: 1.0 }, t(0));
        m.handle(Msg::Tick, t(200));
        let before = m.layout().unwrap();
        // Moving to a 200% monitor reports the new scale and then the new size, in quick steps.
        m.handle(Msg::WellResized { width_px: 1600, height_px: 1000, scale: 2.0 }, t(1_000));
        m.handle(Msg::WellResized { width_px: 3200, height_px: 2000, scale: 2.0 }, t(1_020));
        let after = m.layout().unwrap();
        assert!((after.size_px - 2.0 * before.size_px).abs() < 0.01);
        let mut sent = Vec::new();
        for ms in (1_050..1_600).step_by(50) { sent.extend(resizes(&m.handle(Msg::Tick, t(ms)))); }
        assert_eq!(sent, vec![after.size]);
    }

    #[test]
    fn a_bigger_font_resizes_after_the_settle() {
        let mut m = live(vec![session("a", 1)]);
        m.handle(Msg::WellResized { width_px: 1600, height_px: 1000, scale: 1.0 }, t(0));
        m.handle(Msg::Tick, t(200));
        let cols = m.layout().unwrap().size.cols;
        let mut style = TermStyle::default();
        style.size_pt = 20.0;
        m.handle(Msg::StyleChanged(style), t(1_000));
        assert!(m.layout().unwrap().size.cols < cols);
        assert_eq!(resizes(&m.handle(Msg::Tick, t(1_200))).len(), 1);
    }

    #[test]
    fn a_theme_change_redraws_without_a_resize() {
        let mut m = live(vec![session("a", 1)]);
        m.handle(Msg::WellResized { width_px: 1600, height_px: 1000, scale: 1.0 }, t(0));
        m.handle(Msg::Tick, t(200));
        let mut style = TermStyle::default();
        style.theme = tether_core::theme::theme_named("dracula");
        let fx = m.handle(Msg::StyleChanged(style), t(1_000));
        assert!(fx.contains(&Effect::Redraw));
        assert!(resizes(&m.handle(Msg::Tick, t(1_300))).is_empty());
    }

    #[test]
    fn a_new_channel_opens_at_the_current_size() {
        let mut m = live(vec![session("a", 1), session("b", 2)]);
        m.handle(Msg::WellResized { width_px: 1600, height_px: 1000, scale: 1.0 }, t(0));
        let size = m.layout().unwrap().size;
        let fx = m.handle(Msg::SelectTab("a".into()), t(10));
        assert!(fx.iter().any(|e| matches!(e, Effect::Attach { size: s, .. } if *s == size)));
    }
}
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `cargo test -p tether-app terminal::geometry terminal::model::input`
Expected: FAIL to compile (`layout`, `cell_at`, and `Layout` not found).

- [ ] **Step 3: Implement**

`geometry.rs`, below `TermStyle`:

```rust
use tether_core::resize::GridSize;
use tether_term::{cell_metrics, grid_size, pt_to_px, Cell};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Layout {
    pub size: GridSize,
    pub padding_px: u32,
    pub cell_w: f32,
    pub cell_h: f32,
    pub size_px: f32,
    pub width_px: u32,
    pub height_px: u32,
}

/// Points convert at the monitor's scale, so 14 pt is the same physical size at 100 % and 200 %.
pub fn layout(width_px: u32, height_px: u32, scale: f32, style: &TermStyle) -> Layout {
    let size_px = pt_to_px(style.size_pt, scale);
    let padding_px = pt_to_px(style.padding_pt, scale).round() as u32;
    let (cell_w, cell_h) = cell_metrics(style.font, size_px, style.line_spacing);
    let size = grid_size(width_px, height_px, padding_px, (cell_w, cell_h));
    Layout { size, padding_px, cell_w, cell_h, size_px, width_px, height_px }
}

/// The grid is bottom-anchored: its last row ends at `height − padding`.
pub fn cell_at(l: &Layout, x_px: f32, y_px: f32) -> Cell {
    let top = l.height_px as f32 - l.padding_px as f32 - l.size.rows as f32 * l.cell_h;
    let max_col = l.size.cols.saturating_sub(1) as f32;
    let max_row = l.size.rows.saturating_sub(1) as f32;
    let col = ((x_px - l.padding_px as f32) / l.cell_w).floor().clamp(0.0, max_col);
    let row = ((y_px - top) / l.cell_h).floor().clamp(0.0, max_row);
    Cell { row: row as usize, col: col as usize }
}
```

In `model/mod.rs`, add the field `layout: Option<crate::terminal::geometry::Layout>` (initialised to `None`) and the accessor `pub fn layout(&self) -> Option<crate::terminal::geometry::Layout> { self.layout }`.

`input.rs` (replace the two stubs):

```rust
use super::*;
use crate::terminal::geometry::{layout, TermStyle};

impl TerminalModel {
    pub(crate) fn on_well_resized(&mut self, w: u32, h: u32, scale: f32, now: Duration, fx: &mut Vec<Effect>) {
        self.well_px = Some((w, h, scale));
        self.relayout(now, fx);
    }

    pub(crate) fn on_style(&mut self, style: TermStyle, now: Duration, fx: &mut Vec<Effect>) {
        if !std::ptr::eq(style.theme, self.style.theme) {
            // M4 keeps each tab's OSC 4 overrides across a theme change.
            for tab in self.tabs.values_mut() { tab.term.set_theme(style.theme); }
        }
        self.style = style;
        self.relayout(now, fx);
    }

    /// Every grid redraws at the new size at once. The PTYs hear about it once the
    /// size has been quiet for the settle window, so a drag doesn't cause a SIGWINCH storm.
    fn relayout(&mut self, now: Duration, fx: &mut Vec<Effect>) {
        if let Some((w, h, scale)) = self.well_px {
            let l = layout(w, h, scale, &self.style);
            self.layout = Some(l);
            if l.size != self.size {
                self.size = l.size;
                for tab in self.tabs.values_mut() { tab.term.resize(l.size); }
                self.resize.on_size(l.size, now);
            }
        }
        fx.push(Effect::Redraw);
    }
}
```

`reconnect.rs`, replacing the `tick_resize` stub:

```rust
    pub(crate) fn tick_resize(&mut self, now: Duration, fx: &mut Vec<Effect>) {
        if let Some(size) = self.resize.poll(now) { fx.push(Effect::ResizeAll(size)); }
    }
```

`open_channel` (Task 2) already opens new channels at `self.size`, which is the current local size. A channel opened during an unsettled drag takes the newest size, and the `ResizeAll` after the settle is harmless for it.

In `glue.rs`, the well's `changed width/height` callback converts logical px to physical px with `window().scale_factor()`. Slint calls that callback again after a monitor move, because the logical size stays put while the scale changes. Also register a winit filter for `WindowEvent::ScaleFactorChanged` that re-sends the last well size at the new scale, so a monitor move with no logical change still re-lays out. Task 9 installs that filter: the `ScaleFactorChanged` arm calls `vm.invoke_well_resized(last_w, last_h)` from the stored logical size.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `cargo test -p tether-app terminal::`
Expected: PASS: 2 geometry and 5 resize tests, plus everything before.

- [ ] **Step 5: Commit**

```bash
git add clients/windows/crates/tether-app/src/terminal
git commit -m "feat(windows): local redraw per resize step, one PTY resize per settle

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Render loop: frames, synchronized output, cursor blink

**Files:**
- Replace: `clients/windows/crates/tether-app/src/terminal/frame.rs` (keep `FramePacer` and its tests)
- Modify: `src/terminal/model/mod.rs` (`frame_job`), `src/terminal/model/reconnect.rs` (`tick_sync`)

**Interfaces:**
- Consumes: `tether_term::{Snapshot, Rasterizer, RenderStyle, RgbaImage}`, `TabTerminal::{snapshot, sync_deadline, flush_sync}`, `Layout` (Task 7), `FramePacer` (Task 4).
- Produces:
  - `pub enum FrameJob { Grid { snapshot: Snapshot, style: RenderStyle<'static>, width: u32, height: u32 }, Clear { width: u32, height: u32, background: u32 } }`
  - `pub fn render_job(r: &mut Rasterizer, job: &FrameJob) -> RgbaImage`
  - `pub fn attach_window(app: &AppWindow, presented: Arc<dyn Fn() + Send + Sync>)` and `pub fn submit(job: FrameJob)`
  - `TerminalModel::frame_job(&self) -> Option<FrameJob>`; model fields `hover: Option<(usize, usize, usize)>` (Task 11 sets it), `blink_on: bool`, and `blink_at: Duration`
  - `pub const BLINK: Duration = Duration::from_millis(530)`

- [ ] **Step 1: Write the failing tests**

Append to `frame.rs`:

```rust
#[cfg(test)]
mod frame_tests {
    use super::*;
    use crate::terminal::model::tests::{live, t};
    use crate::terminal::model::{Effect, Msg};
    use crate::terminal::testkit::session;

    fn redraws(fx: &[Effect]) -> usize { fx.iter().filter(|e| **e == Effect::Redraw).count() }

    #[test]
    fn background_output_does_not_render() {
        let mut m = live(vec![session("a", 1), session("b", 2)]);
        m.handle(Msg::SelectTab("a".into()), t(1));
        m.handle(Msg::Attached { name: "a".into() }, t(1));
        assert_eq!(redraws(&m.handle(Msg::PtyData { name: "b".into(), bytes: b"y\r\n".repeat(500) }, t(2))), 0);
        assert_eq!(redraws(&m.handle(Msg::PtyData { name: "a".into(), bytes: b"x".to_vec() }, t(3))), 1);
    }

    #[test]
    fn no_frame_before_the_well_has_a_size() {
        assert!(live(vec![session("a", 1)]).frame_job().is_none());
    }

    #[test]
    fn the_frame_is_the_well_in_physical_pixels() {
        let mut m = live(vec![session("a", 1)]);
        m.handle(Msg::WellResized { width_px: 1280, height_px: 800, scale: 2.0 }, t(1));
        let Some(FrameJob::Grid { width, height, style, .. }) = m.frame_job() else { panic!("expected a grid frame") };
        assert_eq!((width, height), (1280, 800));
        assert!((style.size_px - tether_term::pt_to_px(14.0, 2.0)).abs() < 0.01);
        assert_eq!(style.padding_px, tether_term::pt_to_px(8.0, 2.0).round() as u32);
    }

    #[test]
    fn an_empty_host_clears_the_well() {
        let mut m = live(vec![]);
        m.handle(Msg::WellResized { width_px: 640, height_px: 400, scale: 1.0 }, t(1));
        assert!(matches!(m.frame_job(), Some(FrameJob::Clear { width: 640, height: 400, background: 0x1E1E2E })));
    }

    #[test]
    fn the_grid_is_bottom_anchored_on_the_theme_background() {
        let mut m = live(vec![session("a", 1)]);
        m.handle(Msg::WellResized { width_px: 800, height_px: 600, scale: 1.0 }, t(1));
        m.handle(Msg::PtyData { name: "a".into(), bytes: b"hello".to_vec() }, t(2));
        let job = m.frame_job().unwrap();
        let img = render_job(&mut tether_term::Rasterizer::new(), &job);
        assert_eq!((img.width, img.height), (800, 600));
        assert_eq!(img.pixel(0, 0), [0x1E, 0x1E, 0x2E, 0xFF]);
        assert_eq!(img.pixel(799, 599), [0x1E, 0x1E, 0x2E, 0xFF]);
    }

    #[test]
    fn synchronized_output_is_flushed_by_the_tick() {
        let mut m = live(vec![session("a", 1)]);
        // A query inside a synchronized update is answered when the update ends or times out.
        m.handle(Msg::PtyData { name: "a".into(), bytes: b"\x1b[?2026h\x1b]11;?\x07".to_vec() }, t(1));
        std::thread::sleep(std::time::Duration::from_millis(400));
        let fx = m.handle(Msg::Tick, t(450));
        assert!(fx.iter().any(|e| matches!(e, Effect::Write { name, bytes } if name == "a" && bytes.starts_with(b"\x1b]11;rgb:"))));
    }

    #[test]
    fn blink_toggles_the_cursor_only_when_enabled() {
        let mut m = live(vec![session("a", 1)]);
        assert_eq!(redraws(&m.handle(Msg::Tick, t(600))), 0);
        let mut style = crate::terminal::geometry::TermStyle::default();
        style.blink = true;
        m.handle(Msg::StyleChanged(style), t(700));
        assert_eq!(redraws(&m.handle(Msg::Tick, t(1_300))), 1);
    }
}
```

`synchronized_output_is_flushed_by_the_tick` sleeps on the real clock, because M4's `sync_deadline()` is a `std::time::Instant`. alacritty's synchronized-update timeout is 150 ms, so 400 ms leaves room.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `cargo test -p tether-app terminal::frame`
Expected: FAIL to compile (`FrameJob::Grid` and `render_job` not found).

- [ ] **Step 3: Implement**

`frame.rs`, keeping `FramePacer` and its tests above:

```rust
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::Duration;

use slint::{ComponentHandle, Image, Rgba8Pixel, SharedPixelBuffer};
use tether_term::{Rasterizer, RenderStyle, RgbaImage, Snapshot};

use crate::{AppWindow, TerminalVm};

pub const BLINK: Duration = Duration::from_millis(530);

pub enum FrameJob {
    Grid { snapshot: Snapshot, style: RenderStyle<'static>, width: u32, height: u32 },
    Clear { width: u32, height: u32, background: u32 },
}

pub fn render_job(r: &mut Rasterizer, job: &FrameJob) -> RgbaImage {
    match job {
        FrameJob::Grid { snapshot, style, width, height } => r.render(snapshot, style, *width, *height),
        FrameJob::Clear { width, height, background } => {
            let [_, red, green, blue] = background.to_be_bytes();
            let pixels = [red, green, blue, 0xFF].repeat((*width * *height) as usize);
            RgbaImage { width: *width, height: *height, pixels }
        }
    }
}

static RENDER_TX: OnceLock<mpsc::Sender<FrameJob>> = OnceLock::new();
static PRESENTED: Mutex<Option<Arc<dyn Fn() + Send + Sync>>> = Mutex::new(None);

fn presented() {
    if let Some(p) = PRESENTED.lock().unwrap().clone() { p(); }
}

/// Starts the render thread once per window, and points the "frame shown" signal at
/// the terminal that is open now.
pub fn attach_window(app: &AppWindow, on_presented: Arc<dyn Fn() + Send + Sync>) {
    *PRESENTED.lock().unwrap() = Some(on_presented);
    if RENDER_TX.get().is_some() { return; }
    let (tx, rx) = mpsc::channel::<FrameJob>();
    let _ = RENDER_TX.set(tx);
    let weak = app.as_weak();
    // The renderer's AfterRendering is the display-refresh signal. On a backend without
    // rendering notifiers, fall back to "the UI thread took the frame".
    let notifier = app.window().set_rendering_notifier(|state, _| {
        if matches!(state, slint::RenderingState::AfterRendering) { presented(); }
    });
    let notify_on_set = notifier.is_err();
    std::thread::Builder::new().name("tether-render".into()).spawn(move || {
        let mut rasterizer = Rasterizer::new();
        while let Ok(mut job) = rx.recv() {
            while let Ok(newer) = rx.try_recv() { job = newer; }
            let img = render_job(&mut rasterizer, &job);
            let mut buf = SharedPixelBuffer::<Rgba8Pixel>::new(img.width, img.height);
            buf.make_mut_bytes().copy_from_slice(&img.pixels);
            let (w, h) = (img.width as i32, img.height as i32);
            let _ = weak.upgrade_in_event_loop(move |app| {
                let vm = app.global::<TerminalVm>();
                vm.set_frame(Image::from_rgba8(buf));
                vm.set_frame_width(w);
                vm.set_frame_height(h);
                if notify_on_set { presented(); }
            });
        }
    }).expect("render thread");
}

pub fn submit(job: FrameJob) {
    if let Some(tx) = RENDER_TX.get() { let _ = tx.send(job); }
}
```

`model/mod.rs`. Add the fields `hover: Option<(usize, usize, usize)>`, `blink_on: bool`, and `blink_at: Duration` (initialised `None`, `true`, `Duration::ZERO`), and replace the `frame_job` stub:

```rust
    pub fn frame_job(&self) -> Option<crate::terminal::frame::FrameJob> {
        use crate::terminal::frame::FrameJob;
        let l = self.layout?;
        let tab = self.active_name().and_then(|n| self.tabs.get(n)).filter(|_| self.screen == Screen::Terminal);
        let Some(tab) = tab else {
            return Some(FrameJob::Clear { width: l.width_px, height: l.height_px, background: self.style.theme.background });
        };
        let style = tether_term::RenderStyle {
            theme: self.style.theme,
            font: self.style.font,
            size_px: l.size_px,
            line_spacing: self.style.line_spacing,
            padding_px: l.padding_px,
            cursor: self.style.cursor,
            cursor_on: self.focused && (!self.style.blink || self.blink_on),
            hover_link: self.hover,
        };
        Some(FrameJob::Grid { snapshot: tab.term.snapshot(), style, width: l.width_px, height: l.height_px })
    }
```

`reconnect.rs`, replacing the `tick_sync` stub:

```rust
    /// The frame timer: end synchronized updates past their deadline, and blink the cursor.
    pub(crate) fn tick_sync(&mut self, now: Duration, fx: &mut Vec<Effect>) {
        let wall = std::time::Instant::now();
        let due: Vec<String> = self.tabs.iter()
            .filter(|(_, t)| t.term.sync_deadline().is_some_and(|d| wall >= d))
            .map(|(n, _)| n.clone())
            .collect();
        for name in due {
            let active = self.active_name() == Some(name.as_str());
            let events = self.tabs.get_mut(&name).map(|t| t.term.flush_sync()).unwrap_or_default();
            for ev in events { self.on_term_event(&name, ev, active, now, fx); }
            if active { fx.push(Effect::Redraw); }
        }
        if self.style.blink && now.saturating_sub(self.blink_at) >= crate::terminal::frame::BLINK {
            self.blink_at = now;
            self.blink_on = !self.blink_on;
            fx.push(Effect::Redraw);
        }
    }
```

Typing resets the blink phase: in `on_key` (Task 9), set `self.blink_on = true; self.blink_at = now;` before writing.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `cargo test -p tether-app terminal::`
Expected: PASS: 7 frame tests and everything before.

- [ ] **Step 5: Run the app and check the grid**

Run (on Windows): `cargo run -p tether-app --release`, then open a machine.
- [ ] The prompt draws in Cascadia Mono 14 pt on `#1E1E2E`, bottom-anchored. There is no seam between the frame and the well.
- [ ] `cat` a large file. The window stays responsive, the drag handle keeps moving, and the output catches up at once when it stops.
- [ ] `vim` and `htop` draw correctly, and `printf '\e[?2026h'; sleep 1; printf 'x\e[?2026l'` shows `x` after the sleep with no tearing.
- [ ] At 100 % and 200 % display scaling, the text is the same physical size and pixel-sharp (no blur from scaling).
- [ ] With Blink cursor on, the cursor blinks while the window is focused and is steady while typing. With it off, the cursor never blinks.

- [ ] **Step 6: Commit**

```bash
git add clients/windows/crates/tether-app/src/terminal
git commit -m "feat(windows): paced full-repaint frames with synchronized output and blink

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Keyboard and IME

**Files:**
- Create: `clients/windows/crates/tether-app/src/terminal/keys.rs`
- Modify: `src/terminal/model/input.rs` (`on_key`, `on_modifiers`, `Msg::Ime`), `src/terminal/glue.rs` (the winit event filter), `src/terminal/mod.rs`

**Interfaces:**
- Consumes: `tether_core::keymap::{encode_key, KeyInput, NamedKey, NumpadKey, Mods, KeyContext, KeyAction, TetherCommand}`; `TabTerminal::{context, scroll, scroll_to_bottom, selection_text, clear_selection}`; Slint's `slint::winit_030::{WinitWindowAccessor, EventResult, winit}`; winit's `keyboard::{Key, NamedKey, KeyCode, PhysicalKey, KeyLocation, SmolStr}`, `platform::modifier_supplement::KeyEventExtModifierSupplement` (`key_without_modifiers()`, `text_with_all_modifiers()`, both supported on Windows), and `event::{WindowEvent, ElementState, Ime}`; M5 `Router::current(&self) -> Page`.
- Produces:
  - `pub fn translate(logical: &Key, unmodified: &Key, text: Option<&str>, physical: PhysicalKey, location: KeyLocation) -> Option<KeyInput>`
  - `pub fn mods_of(state: winit::keyboard::ModifiersState) -> Mods`
  - `glue::on_winit_event(app: &Rc<App>, window: &winit::window::Window, event: &WindowEvent) -> EventResult`, called first from M5's `App::on_winit_event`. It routes keys, IME commits, modifier changes, focus, dropped files, and scale changes to the open terminal.
  - `TerminalModel::on_command(&mut self, cmd: TetherCommand, mods: Mods, fx: &mut Vec<Effect>)`

Why winit and not Slint's `FocusScope`: Slint's `KeyEvent` carries only the produced text and the modifiers. The key table needs the layout's unmodified character (Ctrl folding on any layout), the physical digit key (Ctrl+Shift+1…9 on AZERTY), the AltGr-produced text, the numpad location, and IME commits. winit's `KeyEventExtModifierSupplement` provides all of these on Windows.

- [ ] **Step 1: Write the failing translation tests**

`src/terminal/keys.rs`, tests first:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use slint::winit_030::winit::keyboard::{Key, KeyCode, KeyLocation, NamedKey as W, PhysicalKey, SmolStr};
    use tether_core::keymap::{KeyInput, NamedKey, NumpadKey};

    fn ch(s: &str) -> Key { Key::Character(SmolStr::new(s)) }
    fn code(c: KeyCode) -> PhysicalKey { PhysicalKey::Code(c) }

    #[test]
    fn ctrl_letter_keeps_the_unmodified_char_and_drops_the_control_text() {
        let got = translate(&ch("a"), &ch("a"), Some("\u{1}"), code(KeyCode::KeyA), KeyLocation::Standard);
        assert_eq!(got, Some(KeyInput::Char { unmodified: 'a', produced: None, digit: None }));
    }

    #[test]
    fn altgr_on_canadian_french_produces_the_symbol() {
        let got = translate(&ch("@"), &ch("2"), Some("@"), code(KeyCode::Digit2), KeyLocation::Standard);
        assert_eq!(got, Some(KeyInput::Char { unmodified: '2', produced: Some("@".into()), digit: Some(2) }));
    }

    #[test]
    fn azerty_top_row_reports_its_digit() {
        let got = translate(&ch("&"), &ch("&"), Some("&"), code(KeyCode::Digit1), KeyLocation::Standard);
        assert_eq!(got, Some(KeyInput::Char { unmodified: '&', produced: Some("&".into()), digit: Some(1) }));
    }

    #[test]
    fn named_keys_map_to_the_table() {
        let named = |k: W| translate(&Key::Named(k), &Key::Named(k), None, code(KeyCode::F10), KeyLocation::Standard);
        assert_eq!(named(W::F10), Some(KeyInput::Named(NamedKey::F(10))));
        assert_eq!(named(W::ArrowLeft), Some(KeyInput::Named(NamedKey::Left)));
        assert_eq!(named(W::PageUp), Some(KeyInput::Named(NamedKey::PageUp)));
        assert_eq!(named(W::Space), Some(KeyInput::Named(NamedKey::Space)));
        assert_eq!(named(W::Enter), Some(KeyInput::Named(NamedKey::Enter)));
        assert_eq!(named(W::Escape), Some(KeyInput::Named(NamedKey::Escape)));
    }

    #[test]
    fn numpad_keys_carry_their_location() {
        let five = translate(&ch("5"), &ch("5"), Some("5"), code(KeyCode::Numpad5), KeyLocation::Numpad);
        assert_eq!(five, Some(KeyInput::Named(NamedKey::Numpad(NumpadKey::Digit(5)))));
        let enter = translate(&Key::Named(W::Enter), &Key::Named(W::Enter), Some("\r"), code(KeyCode::NumpadEnter), KeyLocation::Numpad);
        assert_eq!(enter, Some(KeyInput::Named(NamedKey::Numpad(NumpadKey::Enter))));
        let plus = translate(&ch("+"), &ch("+"), Some("+"), code(KeyCode::NumpadAdd), KeyLocation::Numpad);
        assert_eq!(plus, Some(KeyInput::Named(NamedKey::Numpad(NumpadKey::Add))));
    }

    #[test]
    fn dead_keys_and_bare_modifiers_are_not_keys() {
        assert_eq!(translate(&Key::Dead(Some('^')), &Key::Dead(Some('^')), None, code(KeyCode::BracketLeft), KeyLocation::Standard), None);
        assert_eq!(translate(&Key::Named(W::Shift), &Key::Named(W::Shift), None, code(KeyCode::ShiftLeft), KeyLocation::Left), None);
        assert_eq!(translate(&Key::Named(W::Alt), &Key::Named(W::Alt), None, code(KeyCode::AltLeft), KeyLocation::Left), None);
    }
}
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `cargo test -p tether-app terminal::keys`
Expected: FAIL to compile (`translate` not found).

- [ ] **Step 3: Implement `keys.rs`**

```rust
use slint::winit_030::winit::keyboard::{Key, KeyCode, KeyLocation, ModifiersState, NamedKey as W, PhysicalKey};
use tether_core::keymap::{KeyInput, Mods, NamedKey, NumpadKey};

pub fn mods_of(state: ModifiersState) -> Mods {
    Mods { shift: state.shift_key(), alt: state.alt_key(), ctrl: state.control_key() }
}

fn digit_of(physical: PhysicalKey) -> Option<u8> {
    let PhysicalKey::Code(code) = physical else { return None };
    let d = match code {
        KeyCode::Digit0 => 0, KeyCode::Digit1 => 1, KeyCode::Digit2 => 2, KeyCode::Digit3 => 3, KeyCode::Digit4 => 4,
        KeyCode::Digit5 => 5, KeyCode::Digit6 => 6, KeyCode::Digit7 => 7, KeyCode::Digit8 => 8, KeyCode::Digit9 => 9,
        _ => return None,
    };
    Some(d)
}

fn numpad(c: char) -> Option<NumpadKey> {
    Some(match c {
        '0'..='9' => NumpadKey::Digit(c as u8 - b'0'),
        '.' | ',' => NumpadKey::Decimal,
        '+' => NumpadKey::Add,
        '-' => NumpadKey::Subtract,
        '*' => NumpadKey::Multiply,
        '/' => NumpadKey::Divide,
        _ => return None,
    })
}

/// `unmodified` and `text` are winit's `key_without_modifiers()` and
/// `text_with_all_modifiers()`. Dead keys and IME arrive as text later, never through here.
pub fn translate(logical: &Key, unmodified: &Key, text: Option<&str>, physical: PhysicalKey, location: KeyLocation) -> Option<KeyInput> {
    if let Key::Named(n) = logical {
        let key = match n {
            W::ArrowUp => NamedKey::Up, W::ArrowDown => NamedKey::Down,
            W::ArrowLeft => NamedKey::Left, W::ArrowRight => NamedKey::Right,
            W::Home => NamedKey::Home, W::End => NamedKey::End,
            W::Insert => NamedKey::Insert, W::Delete => NamedKey::Delete,
            W::PageUp => NamedKey::PageUp, W::PageDown => NamedKey::PageDown,
            W::Tab => NamedKey::Tab, W::Backspace => NamedKey::Backspace, W::Escape => NamedKey::Escape,
            W::Space => NamedKey::Space,
            W::Enter if location == KeyLocation::Numpad => NamedKey::Numpad(NumpadKey::Enter),
            W::Enter => NamedKey::Enter,
            W::F1 => NamedKey::F(1), W::F2 => NamedKey::F(2), W::F3 => NamedKey::F(3), W::F4 => NamedKey::F(4),
            W::F5 => NamedKey::F(5), W::F6 => NamedKey::F(6), W::F7 => NamedKey::F(7), W::F8 => NamedKey::F(8),
            W::F9 => NamedKey::F(9), W::F10 => NamedKey::F(10), W::F11 => NamedKey::F(11), W::F12 => NamedKey::F(12),
            _ => return None,
        };
        return Some(KeyInput::Named(key));
    }
    let Key::Character(base) = unmodified else { return None };
    let unmodified = base.chars().next()?;
    if location == KeyLocation::Numpad {
        if let Some(k) = numpad(unmodified) { return Some(KeyInput::Named(NamedKey::Numpad(k))); }
    }
    let produced = text.filter(|t| !t.is_empty() && !t.chars().any(char::is_control)).map(str::to_string);
    Some(KeyInput::Char { unmodified, produced, digit: digit_of(physical) })
}
```

Add `pub mod keys;` to `terminal/mod.rs`.

- [ ] **Step 4: Write the failing model key tests**

Append to `input.rs`:

```rust
#[cfg(test)]
mod key_tests {
    use super::super::tests::{live, t};
    use super::*;
    use crate::terminal::testkit::session;
    use tether_core::keymap::{KeyInput, Mods, NamedKey};
    use tether_term::{Cell, SelectKind};

    fn ch(c: char, produced: Option<&str>) -> KeyInput { KeyInput::Char { unmodified: c, produced: produced.map(Into::into), digit: None } }
    fn digit(d: u8, c: char) -> KeyInput { KeyInput::Char { unmodified: c, produced: Some(c.to_string()), digit: Some(d) } }
    const CTRL: Mods = Mods { shift: false, alt: false, ctrl: true };
    const CTRL_SHIFT: Mods = Mods { shift: true, alt: false, ctrl: true };
    const SHIFT: Mods = Mods { shift: true, alt: false, ctrl: false };

    fn writes(fx: &[Effect]) -> Vec<Vec<u8>> {
        fx.iter().filter_map(|e| match e { Effect::Write { bytes, .. } => Some(bytes.clone()), _ => None }).collect()
    }

    fn select_hello(m: &mut TerminalModel) {
        m.handle(Msg::PtyData { name: "a".into(), bytes: b"hello".to_vec() }, t(5));
        let tab = m.tabs.get_mut("a").unwrap();
        tab.term.selection_start(Cell { row: 0, col: 0 }, SelectKind::Simple);
        tab.term.selection_update(Cell { row: 0, col: 4 });
    }

    #[test]
    fn typing_writes_to_the_active_tab() {
        let mut m = live(vec![session("a", 1)]);
        assert_eq!(writes(&m.handle(Msg::Key { input: ch('a', Some("a")), mods: Mods::default() }, t(10))), vec![b"a".to_vec()]);
    }

    #[test]
    fn ctrl_v_reads_the_clipboard_and_never_sends_0x16() {
        let mut m = live(vec![session("a", 1)]);
        for mods in [CTRL, CTRL_SHIFT] {
            let fx = m.handle(Msg::Key { input: ch('v', None), mods }, t(10));
            assert!(fx.contains(&Effect::Ui(UiEffect::ReadClipboard)));
            assert!(writes(&fx).is_empty());
        }
        let fx = m.handle(Msg::Key { input: KeyInput::Named(NamedKey::Insert), mods: SHIFT }, t(11));
        assert!(fx.contains(&Effect::Ui(UiEffect::ReadClipboard)));
    }

    #[test]
    fn ctrl_c_copies_and_clears_with_a_selection_and_interrupts_without() {
        let mut m = live(vec![session("a", 1)]);
        select_hello(&mut m);
        let fx = m.handle(Msg::Key { input: ch('c', None), mods: CTRL }, t(10));
        assert!(fx.contains(&Effect::Ui(UiEffect::SetClipboard("hello".into()))));
        assert!(writes(&fx).is_empty());
        let fx = m.handle(Msg::Key { input: ch('c', None), mods: CTRL }, t(11));
        assert_eq!(writes(&fx), vec![vec![0x03]]);
    }

    #[test]
    fn ctrl_shift_c_copies_and_keeps_the_selection() {
        let mut m = live(vec![session("a", 1)]);
        select_hello(&mut m);
        m.handle(Msg::Key { input: ch('c', Some("C")), mods: CTRL_SHIFT }, t(10));
        assert_eq!(m.tabs["a"].term.selection_text().as_deref(), Some("hello"));
    }

    #[test]
    fn ctrl_q_reaches_the_pty() {
        let mut m = live(vec![session("a", 1)]);
        assert_eq!(writes(&m.handle(Msg::Key { input: ch('q', None), mods: CTRL }, t(10))), vec![vec![0x11]]);
    }

    #[test]
    fn font_shortcuts_step_the_size() {
        let mut m = live(vec![session("a", 1)]);
        assert!(m.handle(Msg::Key { input: ch('=', Some("=")), mods: CTRL }, t(10)).contains(&Effect::Ui(UiEffect::FontStep(FontStep::Bigger))));
        assert!(m.handle(Msg::Key { input: ch('-', Some("-")), mods: CTRL }, t(11)).contains(&Effect::Ui(UiEffect::FontStep(FontStep::Smaller))));
        assert!(m.handle(Msg::Key { input: digit(0, '0'), mods: CTRL }, t(12)).contains(&Effect::Ui(UiEffect::FontStep(FontStep::Reset))));
    }

    #[test]
    fn tab_shortcuts_switch_and_open_the_name_field() {
        let mut m = live(vec![session("a", 1), session("b", 2), session("c", 3)]);
        m.handle(Msg::Key { input: digit(1, '&'), mods: CTRL_SHIFT }, t(10));
        assert_eq!(m.view().header.session, "a");
        m.handle(Msg::Key { input: digit(9, 'ç'), mods: CTRL_SHIFT }, t(11));
        assert_eq!(m.view().header.session, "c");
        m.handle(Msg::Key { input: KeyInput::Named(NamedKey::Tab), mods: CTRL }, t(12));
        assert_eq!(m.view().header.session, "a");
        m.handle(Msg::Key { input: ch('t', Some("T")), mods: CTRL_SHIFT }, t(13));
        assert_eq!(m.view().naming.as_deref(), Some("session-4"));
    }

    #[test]
    fn ctrl_shift_t_works_on_an_empty_host() {
        let mut m = live(vec![]);
        m.handle(Msg::Key { input: ch('t', Some("T")), mods: CTRL_SHIFT }, t(10));
        assert_eq!(m.view().naming.as_deref(), Some("default"));
    }

    #[test]
    fn shift_page_up_scrolls_locally_and_typing_snaps_back() {
        let mut m = live(vec![session("a", 1)]);
        m.handle(Msg::PtyData { name: "a".into(), bytes: b"line\r\n".repeat(200) }, t(5));
        let fx = m.handle(Msg::Key { input: KeyInput::Named(NamedKey::PageUp), mods: SHIFT }, t(10));
        assert!(writes(&fx).is_empty());
        assert!(m.tabs["a"].term.display_offset() > 0);
        m.handle(Msg::Key { input: ch('x', Some("x")), mods: Mods::default() }, t(11));
        assert_eq!(m.tabs["a"].term.display_offset(), 0);
    }

    #[test]
    fn ime_commits_utf8() {
        let mut m = live(vec![session("a", 1)]);
        assert_eq!(writes(&m.handle(Msg::Ime("日本".into()), t(10))), vec!["日本".as_bytes().to_vec()]);
    }
}
```

These tests rely on M2's `encode_key` table. Ctrl+Tab maps to `NextTab`, Shift+Insert to `Paste`, Shift+PageUp to `ScrollPageUp` (outside the alternate screen and mouse reporting), and Ctrl+0 to `FontReset` through `digit`.

- [ ] **Step 5: Run the tests and watch them fail**

Run: `cargo test -p tether-app terminal::model::input::key_tests`
Expected: FAIL. `on_key` is still the empty stub.

- [ ] **Step 6: Implement the key handling**

Append to `input.rs` (above the tests):

```rust
use tether_core::keymap::{encode_key, KeyAction, KeyContext, TetherCommand};

impl TerminalModel {
    pub(crate) fn on_modifiers(&mut self, mods: Mods, fx: &mut Vec<Effect>) {
        self.mods = mods;
        self.refresh_hover(fx);
    }

    pub(crate) fn on_key(&mut self, input: &KeyInput, mods: Mods, now: Duration, fx: &mut Vec<Effect>) {
        self.dismiss_finished_capsule();
        let ctx = self.active_name().and_then(|n| self.tabs.get(n)).map(|t| t.term.context()).unwrap_or_default();
        match encode_key(input, mods, &ctx) {
            KeyAction::Send(bytes) => {
                self.blink_on = true;
                self.blink_at = now;
                if let Some(tab) = self.active_name().map(str::to_string).and_then(|n| self.tabs.get_mut(&n)) {
                    tab.term.scroll_to_bottom();
                }
                self.write_active(bytes, fx);
                fx.push(Effect::Redraw);
            }
            KeyAction::Tether(cmd) => self.on_command(cmd, mods, fx),
            KeyAction::Ignore => {}
        }
    }

    pub(crate) fn on_command(&mut self, cmd: TetherCommand, mods: Mods, fx: &mut Vec<Effect>) {
        let active = self.active_name().map(str::to_string);
        match cmd {
            TetherCommand::Paste => fx.push(Effect::Ui(UiEffect::ReadClipboard)),
            TetherCommand::Copy => {
                let Some(tab) = active.and_then(|n| self.tabs.get_mut(&n)) else { return };
                if let Some(text) = tab.term.selection_text() {
                    fx.push(Effect::Ui(UiEffect::SetClipboard(text)));
                    // Ctrl+C copies, then clears, as in Windows Terminal. Ctrl+Shift+C keeps the selection.
                    if mods.ctrl && !mods.shift {
                        tab.term.clear_selection();
                        fx.push(Effect::Redraw);
                    }
                }
            }
            TetherCommand::FontBigger => fx.push(Effect::Ui(UiEffect::FontStep(FontStep::Bigger))),
            TetherCommand::FontSmaller => fx.push(Effect::Ui(UiEffect::FontStep(FontStep::Smaller))),
            TetherCommand::FontReset => fx.push(Effect::Ui(UiEffect::FontStep(FontStep::Reset))),
            TetherCommand::NextTab => self.on_jump(TabJump::Next, fx),
            TetherCommand::PrevTab => self.on_jump(TabJump::Prev, fx),
            TetherCommand::TabAt(n) => self.on_jump(TabJump::Position(n), fx),
            TetherCommand::LastTab => self.on_jump(TabJump::Last, fx),
            TetherCommand::NewTab => self.on_new_begin(),
            TetherCommand::ScrollPageUp | TetherCommand::ScrollPageDown => {
                let rows = self.size.rows as i32;
                let Some(tab) = active.and_then(|n| self.tabs.get_mut(&n)) else { return };
                tab.term.scroll(if cmd == TetherCommand::ScrollPageUp { rows } else { -rows });
                fx.push(Effect::Redraw);
            }
        }
    }

    pub(crate) fn dismiss_finished_capsule(&mut self) {
        if self.capsule_shown.is_some() {
            self.capsule_shown = None;
            self.send = None;
        }
    }

    /// Task 11 fills this in: re-evaluate the Ctrl-hover link when modifiers change.
    pub(crate) fn refresh_hover(&mut self, _fx: &mut Vec<Effect>) {}
}
```

`TetherCommand` must derive `PartialEq` for the scroll comparison. M2 derives `Debug, Clone, Copy, PartialEq, Eq` on it; if it doesn't, use `matches!(cmd, TetherCommand::ScrollPageUp)`. `KeyContext::default()` exists (M2 derives `Default`). `Msg::Ime` already routes to `write_active` (Task 2). Add `scroll_to_bottom` there too: in `handle`, change the arm to `Msg::Ime(text) => { self.snap_active_to_bottom(); self.write_active(text.into_bytes(), &mut fx) }`, with `snap_active_to_bottom` holding the same three lines as in `on_key`.

- [ ] **Step 7: Route winit events through M5's single filter**

M5 registers `on_winit_window_event` exactly once, in `App`, and forwards each event to `App::on_winit_event(self: &Rc<Self>, event: &WindowEvent)`. Change that method to:

```rust
pub fn on_winit_event(self: &Rc<Self>, window: &winit::window::Window, event: &WindowEvent) -> EventResult {
    if crate::terminal::glue::on_winit_event(self, window, event) == EventResult::PreventDefault {
        return EventResult::PreventDefault;
    }
    // M5's existing arms (ThemeChanged, Moved, Resized, ScaleFactorChanged) stay as they are.
    match event { /* … unchanged … */ _ => {} }
    EventResult::Propagate
}
```

Then update its registration to pass the window through and return the result. `EventResult` and `winit` come from `slint::winit_030`.

Append to `glue.rs`:

```rust
use std::cell::Cell;
use slint::winit_030::{winit, EventResult};
use winit::event::{ElementState, Ime, WindowEvent};
use winit::platform::modifier_supplement::KeyEventExtModifierSupplement;

thread_local! {
    static MODS: Cell<tether_core::keymap::Mods> = Cell::new(Default::default());
    static WELL_LOGICAL: Cell<(f32, f32)> = const { Cell::new((0.0, 0.0)) };
    static DROPS: RefCell<Vec<std::path::PathBuf>> = const { RefCell::new(Vec::new()) };
}

/// Keys go to the PTY only on the terminal page, with no name field, dialog, or menu open.
fn keys_to_pty(app: &App) -> bool {
    let vm = app.ui.global::<TerminalVm>();
    current().is_some()
        && app.router.current() == Page::Terminal
        && !vm.get_naming() && vm.get_kill_name().is_empty() && vm.get_menu_tab().is_empty() && vm.get_menu_link().is_empty()
}

pub fn on_winit_event(app: &Rc<App>, window: &winit::window::Window, event: &WindowEvent) -> EventResult {
    match event {
        WindowEvent::ModifiersChanged(m) => {
            let mods = crate::terminal::keys::mods_of(m.state());
            MODS.set(mods);
            send(Msg::Modifiers(mods));
            EventResult::Propagate
        }
        WindowEvent::KeyboardInput { event, .. } if keys_to_pty(app) => {
            if event.state == ElementState::Pressed {
                let input = crate::terminal::keys::translate(
                    &event.logical_key, &event.key_without_modifiers(), event.text_with_all_modifiers(),
                    event.physical_key, event.location,
                );
                if let Some(input) = input { send(Msg::Key { input, mods: MODS.get() }); }
            }
            EventResult::PreventDefault
        }
        WindowEvent::Ime(Ime::Commit(text)) if keys_to_pty(app) => {
            send(Msg::Ime(text.clone()));
            EventResult::PreventDefault
        }
        WindowEvent::Focused(focused) => {
            send(Msg::Focus(*focused));
            if *focused && keys_to_pty(app) { window.set_ime_allowed(true); }
            EventResult::Propagate
        }
        WindowEvent::DroppedFile(path) => {
            // winit sends one event per file; a 50 ms batch turns one drop into one send.
            let first = DROPS.with(|d| { let mut d = d.borrow_mut(); d.push(path.clone()); d.len() == 1 });
            if first {
                slint::Timer::single_shot(std::time::Duration::from_millis(50), || {
                    let paths = DROPS.with(|d| std::mem::take(&mut *d.borrow_mut()));
                    send(Msg::DroppedFiles(paths));
                });
            }
            EventResult::Propagate
        }
        WindowEvent::ScaleFactorChanged { .. } => {
            let (w, h) = WELL_LOGICAL.get();
            let weak = app.ui.as_weak();
            // After Slint applies the new scale, resend the well at it.
            slint::Timer::single_shot(std::time::Duration::ZERO, move || {
                if let Some(ui) = weak.upgrade() { ui.global::<TerminalVm>().invoke_well_resized(w, h); }
            });
            EventResult::Propagate
        }
        _ => EventResult::Propagate,
    }
}
```

In `wire_callbacks`, the `on_well_resized` closure starts with `WELL_LOGICAL.set((w, h));`. Opening the terminal page enables IME as well: in `open_machine`, after `app.refresh_router()`, run `app.ui.window().with_winit_window(|w| w.set_ime_allowed(true));`, with `slint::winit_030::WinitWindowAccessor` in scope.

- [ ] **Step 8: Run the tests and the app**

Run: `cargo test -p tether-app terminal::` → PASS: 6 translation tests and 11 key tests, plus everything before.

Manual check on Windows. The Alt and F10 items need Task 13's `SC_KEYMENU` swallow; until then they open the system menu, so tick them after Task 13.
- [ ] In `bash`: arrows, Home/End, Ctrl+Left/Right (word jump), Ctrl+R, Ctrl+W, Alt+B/F, Alt+Backspace, and Ctrl+Backspace all behave as in Windows Terminal.
- [ ] In `vim`: Esc, Ctrl+[, Ctrl+V (block select is Ctrl+Q here; Ctrl+V pastes), F1–F12, PageUp/PageDown, and the numpad in insert mode.
- [ ] Shift+Enter and Alt+Enter in Claude Code insert a newline without submitting.
- [ ] Canadian French layout: AltGr+2 types `@`, AltGr+7 types `|`, and AltGr+[ types `[`. Ctrl+Alt+digit on US-English reaches the PTY.
- [ ] AZERTY layout: Ctrl+Shift+1…9 switch tabs, and Ctrl+0 resets the font size.
- [ ] Japanese IME: composing then committing `日本語` types it once (not twice), and the candidate window sits near the cursor.
- [ ] Dead keys: `^` then `e` types `ê`.
- [ ] Ctrl+= / Ctrl+- / Ctrl+0 change the size, and the new size is still there after a restart.
- [ ] While the inline new-session field is open, typing goes into the field, not the PTY.

- [ ] **Step 9: Commit**

```bash
git add clients/windows/crates/tether-app/src
git commit -m "feat(windows): full xterm keyboard, AltGr, numpad, and IME to the PTY

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Clipboard: paste text, images, and files; copy

**Files:**
- Create: `clients/windows/crates/tether-app/src/terminal/clip.rs`, `src/terminal/dib.rs`, `src/win32/clipboard.rs`
- Modify: `src/terminal/model/input.rs` (`on_paste`), `src/terminal/model/send.rs` (job types and `start_send`), `src/terminal/model/mod.rs` (`session_cwds`), `clients/windows/Cargo.toml` (dev profile)

**Interfaces:**
- Consumes: `tether_core::paste::{ClipboardSnapshot, PasteAction, paste_action, paste_bytes}`, `tether_core::upload::preflight`, `tether_core::zmx::ZmxSession::display_cwd`, `TabTerminal::{bracketed_paste, scroll_to_bottom}`, and `image` 0.25 (`RgbaImage`, `codecs::png::{PngEncoder, CompressionType, FilterType}`).
- Produces:
  - `pub trait ClipboardSource { fn open(&self) -> bool; fn close(&self); fn text(&self) -> Option<String>; fn files(&self) -> Option<Vec<PathBuf>>; fn png(&self) -> Option<Vec<u8>>; fn dibv5(&self) -> Option<Vec<u8>>; fn dib(&self) -> Option<Vec<u8>>; }`
  - `pub fn snapshot(src: &dyn ClipboardSource, sleep: &dyn Fn(Duration)) -> ClipboardSnapshot`, plus `pub const OPEN_TRIES: u32 = 5` and `pub const OPEN_RETRY: Duration` (20 ms)
  - `pub fn dib_to_png(dib: &[u8]) -> Result<Vec<u8>, DibError>` and `pub enum DibError { Truncated, Unsupported(u16, u32) }`
  - `#[cfg(windows)] pub struct WinClipboard`, which implements `ClipboardSource`. Copying text goes through `arboard` (Task 12), so this module only reads.
  - `pub enum SendSource { Path(PathBuf), Bytes { name: String, data: Vec<u8> } }`, `pub struct SendJob { pub sources: Vec<SendSource>, pub fallback_dir: Option<String> }`, and `pub(crate) struct SendState { pub target: String, pub queue: Option<SendQueue> }`
  - `TerminalModel::start_send(&mut self, sources: Vec<SendSource>, fx: &mut Vec<Effect>)` and the finished `on_paste`

Precedence (text, then files, then image) is M2's `ClipboardSnapshot::from_formats`. M6 only gathers formats, and it stops reading formats it won't use once text is found. The DIB is copied out while the clipboard is open, then encoded after `CloseClipboard`, so another app is never blocked on our PNG encode. The whole snapshot runs off the UI thread (`SlintUi::apply`, Task 5).

- [ ] **Step 1: Make PNG encoding fast in test builds**

Append to `clients/windows/Cargo.toml` (the workspace root):

```toml
# An 8K screenshot is 132 MB of pixels; unoptimised deflate makes its test take minutes.
[profile.dev.package.png]
opt-level = 3
[profile.dev.package.fdeflate]
opt-level = 3
[profile.dev.package.image]
opt-level = 3
```

- [ ] **Step 2: Write the failing DIB and snapshot tests**

`src/terminal/dib.rs`, tests:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn header(size: u32, w: i32, h: i32, bpp: u16, compression: u32) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend(size.to_le_bytes()); v.extend(w.to_le_bytes()); v.extend(h.to_le_bytes());
        v.extend(1u16.to_le_bytes()); v.extend(bpp.to_le_bytes()); v.extend(compression.to_le_bytes());
        v.extend([0u8; 20]);
        v.resize(size as usize, 0);
        v
    }

    fn decode(png: &[u8]) -> image::RgbaImage {
        image::load_from_memory_with_format(png, image::ImageFormat::Png).unwrap().to_rgba8()
    }

    #[test]
    fn bottom_up_24_bit_comes_out_upright() {
        let mut d = header(40, 1, 2, 24, 0);
        // Rows are stored bottom first, BGR, each padded to 4 bytes.
        d.extend([0, 0, 255, 0]);   // bottom row: red
        d.extend([255, 0, 0, 0]);   // top row: blue
        let img = decode(&dib_to_png(&d).unwrap());
        assert_eq!(img.get_pixel(0, 0).0, [0, 0, 255, 255]);
        assert_eq!(img.get_pixel(0, 1).0, [255, 0, 0, 255]);
    }

    #[test]
    fn top_down_is_read_as_is() {
        let mut d = header(40, 1, -2, 24, 0);
        d.extend([255, 0, 0, 0]);
        d.extend([0, 0, 255, 0]);
        let img = decode(&dib_to_png(&d).unwrap());
        assert_eq!(img.get_pixel(0, 0).0, [0, 0, 255, 255]);
    }

    #[test]
    fn rgb32_with_zero_alpha_everywhere_is_opaque() {
        let mut d = header(40, 1, 1, 32, 0);
        d.extend([10, 20, 30, 0]);
        assert_eq!(decode(&dib_to_png(&d).unwrap()).get_pixel(0, 0).0, [30, 20, 10, 255]);
    }

    #[test]
    fn v5_bitfields_keep_alpha() {
        let mut d = header(124, 1, 1, 32, 3);
        d[40..44].copy_from_slice(&0x00FF0000u32.to_le_bytes());
        d[44..48].copy_from_slice(&0x0000FF00u32.to_le_bytes());
        d[48..52].copy_from_slice(&0x000000FFu32.to_le_bytes());
        d[52..56].copy_from_slice(&0xFF000000u32.to_le_bytes());
        d.extend(0x80_10_20_30u32.to_le_bytes());
        assert_eq!(decode(&dib_to_png(&d).unwrap()).get_pixel(0, 0).0, [0x10, 0x20, 0x30, 0x80]);
    }

    #[test]
    fn info_header_bitfields_read_the_masks_after_it() {
        let mut d = header(40, 1, 1, 32, 3);
        d.extend(0x00FF0000u32.to_le_bytes()); d.extend(0x0000FF00u32.to_le_bytes()); d.extend(0x000000FFu32.to_le_bytes());
        d.extend(0x00_10_20_30u32.to_le_bytes());
        assert_eq!(decode(&dib_to_png(&d).unwrap()).get_pixel(0, 0).0, [0x10, 0x20, 0x30, 0xFF]);
    }

    #[test]
    fn palettes_and_truncation_are_refused() {
        assert_eq!(dib_to_png(&header(40, 1, 1, 8, 0)), Err(DibError::Unsupported(8, 0)));
        let mut d = header(40, 4, 4, 32, 0);
        d.extend([0u8; 10]);
        assert_eq!(dib_to_png(&d), Err(DibError::Truncated));
        assert_eq!(dib_to_png(&[1, 2, 3]), Err(DibError::Truncated));
    }

    #[test]
    fn converts_8k_dib_and_checks_limit() {
        let (w, h) = (7680i32, 4320i32);
        let mut d = header(40, w, h, 32, 0);
        d.resize(d.len() + (w * h * 4) as usize, 0x40);
        let png = dib_to_png(&d).unwrap();
        let img = decode(&png);
        assert_eq!((img.width(), img.height()), (7680, 4320));
        assert!(tether_core::upload::preflight(false, png.len() as u64).is_ok());
    }
}
```

`src/terminal/clip.rs`, tests:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    #[derive(Default)]
    struct Fake {
        busy_for: Cell<u32>,
        text: Option<String>,
        files: Option<Vec<PathBuf>>,
        png: Option<Vec<u8>>,
        dib: Option<Vec<u8>>,
        log: RefCell<Vec<&'static str>>,
    }

    impl ClipboardSource for Fake {
        fn open(&self) -> bool {
            self.log.borrow_mut().push("open");
            if self.busy_for.get() > 0 { self.busy_for.set(self.busy_for.get() - 1); return false; }
            true
        }
        fn close(&self) { self.log.borrow_mut().push("close"); }
        fn text(&self) -> Option<String> { self.text.clone() }
        fn files(&self) -> Option<Vec<PathBuf>> { self.files.clone() }
        fn png(&self) -> Option<Vec<u8>> { self.png.clone() }
        fn dibv5(&self) -> Option<Vec<u8>> { None }
        fn dib(&self) -> Option<Vec<u8>> { self.dib.clone() }
    }

    fn one_red_pixel_dib() -> Vec<u8> {
        let mut d = vec![0u8; 40];
        d[0..4].copy_from_slice(&40u32.to_le_bytes());
        d[4..8].copy_from_slice(&1i32.to_le_bytes());
        d[8..12].copy_from_slice(&1i32.to_le_bytes());
        d[12..14].copy_from_slice(&1u16.to_le_bytes());
        d[14..16].copy_from_slice(&24u16.to_le_bytes());
        d.extend([0, 0, 255, 0]);
        d
    }

    #[test]
    fn busy_clipboard_pastes_nothing() {
        let f = Fake { busy_for: Cell::new(99), text: Some("x".into()), ..Default::default() };
        let sleeps = Cell::new(0);
        assert_eq!(snapshot(&f, &|_| sleeps.set(sleeps.get() + 1)), ClipboardSnapshot::Empty);
        assert_eq!(f.log.borrow().iter().filter(|l| **l == "open").count(), OPEN_TRIES as usize);
        assert_eq!(sleeps.get(), OPEN_TRIES - 1);
        assert!(!f.log.borrow().contains(&"close"));
    }

    #[test]
    fn a_briefly_held_clipboard_is_read_on_retry() {
        let f = Fake { busy_for: Cell::new(2), text: Some("hi".into()), ..Default::default() };
        assert_eq!(snapshot(&f, &|_| {}), ClipboardSnapshot::Text("hi".into()));
        assert_eq!(f.log.borrow().last(), Some(&"close"));
    }

    #[test]
    fn text_wins_over_an_image() {
        let f = Fake { text: Some("hi".into()), dib: Some(one_red_pixel_dib()), ..Default::default() };
        assert_eq!(snapshot(&f, &|_| {}), ClipboardSnapshot::Text("hi".into()));
    }

    #[test]
    fn an_image_alone_becomes_png() {
        let f = Fake { dib: Some(one_red_pixel_dib()), ..Default::default() };
        let ClipboardSnapshot::Image(png) = snapshot(&f, &|_| {}) else { panic!("expected an image") };
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
    }

    #[test]
    fn a_registered_png_is_used_as_is() {
        let f = Fake { png: Some(b"\x89PNG\r\n\x1a\nrest".to_vec()), dib: Some(one_red_pixel_dib()), ..Default::default() };
        assert_eq!(snapshot(&f, &|_| {}), ClipboardSnapshot::Image(b"\x89PNG\r\n\x1a\nrest".to_vec()));
    }

    #[test]
    fn explorer_files_become_a_drop() {
        let f = Fake { files: Some(vec![PathBuf::from(r"C:\a.png")]), ..Default::default() };
        assert_eq!(snapshot(&f, &|_| {}), ClipboardSnapshot::Files(vec![PathBuf::from(r"C:\a.png")]));
    }

    #[test]
    fn an_empty_clipboard_is_empty() {
        assert_eq!(snapshot(&Fake::default(), &|_| {}), ClipboardSnapshot::Empty);
    }
}
```

Append to `input.rs`:

```rust
#[cfg(test)]
mod paste_tests {
    use super::super::tests::{live, t};
    use super::*;
    use crate::terminal::model::send::{SendJob, SendSource};
    use crate::terminal::testkit::session;
    use std::path::PathBuf;

    fn writes(fx: &[Effect]) -> Vec<Vec<u8>> {
        fx.iter().filter_map(|e| match e { Effect::Write { bytes, .. } => Some(bytes.clone()), _ => None }).collect()
    }

    #[test]
    fn text_pastes_with_cr_newlines() {
        let mut m = live(vec![session("a", 1)]);
        let fx = m.handle(Msg::Paste { clip: ClipboardSnapshot::Text("a\nb".into()), now_unix: 0 }, t(10));
        assert_eq!(writes(&fx), vec![b"a\rb".to_vec()]);
    }

    #[test]
    fn text_pastes_bracketed_when_the_program_asked() {
        let mut m = live(vec![session("a", 1)]);
        m.handle(Msg::PtyData { name: "a".into(), bytes: b"\x1b[?2004h".to_vec() }, t(5));
        let fx = m.handle(Msg::Paste { clip: ClipboardSnapshot::Text("x\x1b[201~y".into()), now_unix: 0 }, t(10));
        assert_eq!(writes(&fx), vec![b"\x1b[200~xy\x1b[201~".to_vec()]);
    }

    #[test]
    fn an_image_becomes_an_upload_named_by_the_time() {
        let mut m = live(vec![session("a", 1)]);
        let fx = m.handle(Msg::Paste { clip: ClipboardSnapshot::Image(vec![1, 2]), now_unix: 1_791_082_819 }, t(10));
        let job = fx.iter().find_map(|e| match e { Effect::StartSend(j) => Some(j.clone()), _ => None }).unwrap();
        assert_eq!(job.sources, vec![SendSource::Bytes { name: "paste-1791082819.png".into(), data: vec![1, 2] }]);
        assert!(writes(&fx).is_empty());
    }

    #[test]
    fn copied_files_are_sent_like_a_drop() {
        let mut m = live(vec![session("a", 1)]);
        let fx = m.handle(Msg::Paste { clip: ClipboardSnapshot::Files(vec![PathBuf::from("a.txt")]), now_unix: 0 }, t(10));
        assert!(fx.iter().any(|e| matches!(e, Effect::StartSend(SendJob { sources, .. }) if sources == &vec![SendSource::Path("a.txt".into())])));
    }

    #[test]
    fn the_fallback_directory_is_the_sessions_cwd() {
        let mut m = live(vec![session("a", 1)]);
        let fx = m.handle(Msg::SendFiles(vec![PathBuf::from("a.txt")]), t(10));
        let job = fx.iter().find_map(|e| match e { Effect::StartSend(j) => Some(j.clone()), _ => None }).unwrap();
        assert_eq!(job.fallback_dir.as_deref(), Some("/home/sam/a"));
    }

    #[test]
    fn an_empty_clipboard_pastes_nothing() {
        let mut m = live(vec![session("a", 1)]);
        assert!(m.handle(Msg::Paste { clip: ClipboardSnapshot::Empty, now_unix: 0 }, t(10)).is_empty());
    }
}
```

`the_fallback_directory_is_the_sessions_cwd` relies on the testkit `session()` cwd `file://devbox/home/sam/<name>` and on `display_cwd` stripping the `file://host` prefix (M2).

- [ ] **Step 3: Run the tests and watch them fail**

Run: `cargo test -p tether-app terminal::dib terminal::clip terminal::model::input::paste_tests`
Expected: FAIL to compile (`dib_to_png`, `snapshot`, and `SendSource` not found).

- [ ] **Step 4: Implement `dib.rs`**

```rust
use std::io::Cursor;
use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::{ExtendedColorType, ImageEncoder};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DibError { Truncated, Unsupported(u16, u32) }

const BI_RGB: u32 = 0;
const BI_BITFIELDS: u32 = 3;

fn u32_at(d: &[u8], at: usize) -> Result<u32, DibError> {
    d.get(at..at + 4).map(|b| u32::from_le_bytes(b.try_into().unwrap())).ok_or(DibError::Truncated)
}

fn channel(px: u32, mask: u32) -> u8 {
    if mask == 0 { return 0; }
    let v = (px & mask) >> mask.trailing_zeros();
    let max = mask >> mask.trailing_zeros();
    ((v * 255 + max / 2) / max) as u8
}

/// `CF_DIB` / `CF_DIBV5` (BITMAPINFOHEADER or V4/V5, 24 or 32 bpp) to a lossless PNG with alpha.
pub fn dib_to_png(d: &[u8]) -> Result<Vec<u8>, DibError> {
    let size = u32_at(d, 0)? as usize;
    let width = u32_at(d, 4)? as i32;
    let height = u32_at(d, 8)? as i32;
    let bpp = d.get(14..16).map(|b| u16::from_le_bytes([b[0], b[1]])).ok_or(DibError::Truncated)?;
    let compression = u32_at(d, 16)?;
    let colors_used = u32_at(d, 32)? as usize;
    if !(bpp == 24 && compression == BI_RGB || bpp == 32 && (compression == BI_RGB || compression == BI_BITFIELDS)) {
        return Err(DibError::Unsupported(bpp, compression));
    }
    let (masks, mut offset) = if compression == BI_BITFIELDS {
        if size >= 56 {
            ([u32_at(d, 40)?, u32_at(d, 44)?, u32_at(d, 48)?, u32_at(d, 52)?], size)
        } else {
            ([u32_at(d, size)?, u32_at(d, size + 4)?, u32_at(d, size + 8)?, 0], size + 12)
        }
    } else {
        ([0x00FF0000, 0x0000FF00, 0x000000FF, if bpp == 32 { 0xFF000000 } else { 0 }], size)
    };
    offset += colors_used * 4;
    let (w, h) = (width.unsigned_abs() as usize, height.unsigned_abs() as usize);
    let stride = (w * bpp as usize).div_ceil(32) * 4;
    let pixels = d.get(offset..offset + stride * h).ok_or(DibError::Truncated)?;
    let mut rgba = vec![0u8; w * h * 4];
    for y in 0..h {
        let src_row = if height > 0 { h - 1 - y } else { y };
        let row = &pixels[src_row * stride..src_row * stride + stride];
        for x in 0..w {
            let out = &mut rgba[(y * w + x) * 4..(y * w + x) * 4 + 4];
            if bpp == 24 {
                out.copy_from_slice(&[row[x * 3 + 2], row[x * 3 + 1], row[x * 3], 255]);
            } else {
                let px = u32::from_le_bytes(row[x * 4..x * 4 + 4].try_into().unwrap());
                out.copy_from_slice(&[channel(px, masks[0]), channel(px, masks[1]), channel(px, masks[2]), channel(px, masks[3])]);
            }
        }
    }
    // Many apps leave the alpha byte of 32-bit RGB at zero; that means opaque, not invisible.
    if bpp == 32 && (masks[3] == 0 || rgba.chunks_exact(4).all(|p| p[3] == 0)) {
        for p in rgba.chunks_exact_mut(4) { p[3] = 255; }
    }
    let mut png = Vec::new();
    PngEncoder::new_with_quality(Cursor::new(&mut png), CompressionType::Fast, FilterType::Adaptive)
        .write_image(&rgba, w as u32, h as u32, ExtendedColorType::Rgba8)
        .map_err(|_| DibError::Truncated)?;
    Ok(png)
}
```

- [ ] **Step 5: Implement `clip.rs`**

```rust
use std::path::PathBuf;
use std::time::Duration;
use tether_core::paste::ClipboardSnapshot;
use crate::terminal::dib::dib_to_png;

pub const OPEN_TRIES: u32 = 5;
pub const OPEN_RETRY: Duration = Duration::from_millis(20);

pub trait ClipboardSource {
    fn open(&self) -> bool;
    fn close(&self);
    fn text(&self) -> Option<String>;
    fn files(&self) -> Option<Vec<PathBuf>>;
    fn png(&self) -> Option<Vec<u8>>;
    fn dibv5(&self) -> Option<Vec<u8>>;
    fn dib(&self) -> Option<Vec<u8>>;
}

/// Another app can hold the clipboard open. Retry briefly, then paste nothing.
pub fn snapshot(src: &dyn ClipboardSource, sleep: &dyn Fn(Duration)) -> ClipboardSnapshot {
    let mut opened = false;
    for attempt in 0..OPEN_TRIES {
        if src.open() { opened = true; break; }
        if attempt + 1 < OPEN_TRIES { sleep(OPEN_RETRY); }
    }
    if !opened { return ClipboardSnapshot::Empty; }
    let text = src.text().filter(|t| !t.is_empty());
    let (mut files, mut png, mut dib) = (None, None, None);
    if text.is_none() {
        files = src.files().filter(|f| !f.is_empty());
        if files.is_none() {
            png = src.png();
            if png.is_none() { dib = src.dibv5().or_else(|| src.dib()); }
        }
    }
    src.close();
    let png = png.or_else(|| dib.and_then(|d| dib_to_png(&d).ok()));
    ClipboardSnapshot::from_formats(text, files, png)
}
```

Add `pub mod clip; pub mod dib;` to `terminal/mod.rs`.

- [ ] **Step 6: Implement `win32/clipboard.rs`**

```rust
use std::path::PathBuf;
use windows::core::w;
use windows::Win32::Foundation::HGLOBAL;
use windows::Win32::System::DataExchange::{
    CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard, RegisterClipboardFormatW,
};
use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
use windows::Win32::System::Ole::{CF_DIB, CF_DIBV5, CF_HDROP, CF_UNICODETEXT};
use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};

use crate::terminal::clip::ClipboardSource;

pub struct WinClipboard;

fn global_bytes(format: u32) -> Option<Vec<u8>> {
    unsafe {
        IsClipboardFormatAvailable(format).ok()?;
        let h = GetClipboardData(format).ok()?;
        let g = HGLOBAL(h.0);
        let p = GlobalLock(g) as *const u8;
        if p.is_null() { return None; }
        let bytes = std::slice::from_raw_parts(p, GlobalSize(g)).to_vec();
        let _ = GlobalUnlock(g);
        Some(bytes)
    }
}

impl ClipboardSource for WinClipboard {
    fn open(&self) -> bool { unsafe { OpenClipboard(None).is_ok() } }
    fn close(&self) { unsafe { let _ = CloseClipboard(); } }

    fn text(&self) -> Option<String> {
        let bytes = global_bytes(CF_UNICODETEXT.0 as u32)?;
        let wide: Vec<u16> = bytes.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).take_while(|&c| c != 0).collect();
        Some(String::from_utf16_lossy(&wide))
    }

    fn files(&self) -> Option<Vec<PathBuf>> {
        unsafe {
            IsClipboardFormatAvailable(CF_HDROP.0 as u32).ok()?;
            let drop = HDROP(GetClipboardData(CF_HDROP.0 as u32).ok()?.0);
            let count = DragQueryFileW(drop, u32::MAX, None);
            let files = (0..count).map(|i| {
                let len = DragQueryFileW(drop, i, None) as usize;
                let mut buf = vec![0u16; len + 1];
                DragQueryFileW(drop, i, Some(&mut buf));
                PathBuf::from(String::from_utf16_lossy(&buf[..len]))
            }).collect();
            Some(files)
        }
    }

    fn png(&self) -> Option<Vec<u8>> {
        let format = unsafe { RegisterClipboardFormatW(w!("PNG")) };
        global_bytes(format)
    }
    fn dibv5(&self) -> Option<Vec<u8>> { global_bytes(CF_DIBV5.0 as u32) }
    fn dib(&self) -> Option<Vec<u8>> { global_bytes(CF_DIB.0 as u32) }
}
```

These signatures follow `windows` 0.62. If a call doesn't compile (an `Option<HWND>` against a bare `HWND`, or `HDROP` from `HANDLE`), check it with `cargo doc -p windows --open` and adjust the wrapper only; the logic stays the same.

- [ ] **Step 7: Implement the paste and the send entry**

In `model/mod.rs`, add the field `session_cwds: HashMap<String, String>`. In `on_ls`, update it for every `Ok(sessions)` before the strip logic: `self.session_cwds = sessions.iter().map(|s| (s.name.clone(), s.display_cwd().to_string())).collect();`. The `Ok(sessions)` arms need a borrow of `sessions` first, so restructure `on_ls` to take `&result` where needed.

`send.rs` (replace the stub types; Task 14 adds the rest):

```rust
use super::*;
use tether_core::upload::SendQueue;

#[derive(Debug, Clone, PartialEq)]
pub enum SendSource { Path(PathBuf), Bytes { name: String, data: Vec<u8> } }

#[derive(Debug, Clone, PartialEq)]
pub struct SendJob { pub sources: Vec<SendSource>, pub fallback_dir: Option<String> }

pub(crate) struct SendState {
    /// The tab that was active when the send began. Every path is pasted there.
    pub target: String,
    pub queue: Option<SendQueue>,
}

impl TerminalModel {
    pub(crate) fn start_send(&mut self, sources: Vec<SendSource>, fx: &mut Vec<Effect>) {
        let busy = self.send.as_ref().is_some_and(|s| s.queue.as_ref().is_none_or(|q| !q.is_finished()));
        if sources.is_empty() || busy { return; }
        let Some(target) = self.active_name().map(str::to_string) else { return };
        let fallback_dir = self.session_cwds.get(&target).filter(|d| d.starts_with('/')).cloned()
            .or_else(|| self.tabs.get(&target).and_then(|t| t.term.reports().cwd.clone()));
        self.capsule_shown = None;
        self.send = Some(SendState { target, queue: None });
        fx.push(Effect::StartSend(SendJob { sources, fallback_dir }));
    }

    pub(crate) fn on_send_files(&mut self, paths: Vec<PathBuf>, fx: &mut Vec<Effect>) {
        self.start_send(paths.into_iter().map(SendSource::Path).collect(), fx);
    }
}
```

`input.rs`, replacing the `on_paste` stub:

```rust
use tether_core::paste::{paste_action, paste_bytes, PasteAction};

impl TerminalModel {
    pub(crate) fn on_paste(&mut self, clip: ClipboardSnapshot, now_unix: i64, fx: &mut Vec<Effect>) {
        match paste_action(clip, now_unix) {
            PasteAction::PasteText(text) => {
                let Some(name) = self.active_name().map(str::to_string) else { return };
                let Some(tab) = self.tabs.get_mut(&name) else { return };
                let bytes = paste_bytes(&text, tab.term.bracketed_paste());
                tab.term.scroll_to_bottom();
                self.write_active(bytes, fx);
            }
            PasteAction::UploadImage { name, png } => self.start_send(vec![SendSource::Bytes { name, data: png }], fx),
            PasteAction::SendFiles(paths) => self.on_send_files(paths, fx),
            PasteAction::Nothing => {}
        }
    }
}
```

Import `use super::send::SendSource;` at the top of `input.rs`.

`WindowsPlatform::read_clipboard` (Task 12) is `crate::terminal::clip::snapshot(&clipboard::WinClipboard, &std::thread::sleep)`.

- [ ] **Step 8: Run the tests and watch them pass**

Run: `cargo test -p tether-app terminal::`
Expected: PASS: 7 DIB, 7 snapshot, and 6 paste tests, plus everything before. `converts_8k_dib_and_checks_limit` runs in a few seconds with the profile override.

- [ ] **Step 9: Commit**

```bash
git add clients/windows/Cargo.toml clients/windows/crates/tether-app/src
git commit -m "feat(windows): clipboard paste of text, images as PNG, and Explorer files

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

The manual checks for clipboard paste run after Task 12 wires `WindowsPlatform`; they are listed there.

---

### Task 11: Mouse: selection, reporting, wheel, and links

**Files:**
- Replace: `clients/windows/crates/tether-app/src/terminal/mouse.rs`
- Create: `src/terminal/model/pointer.rs`
- Modify: `src/terminal/model/mod.rs` (two `Msg` variants, `pointer` field type, `mod pointer;`), `src/terminal/model/input.rs` (remove the `on_mouse`, `on_wheel`, and `refresh_hover` stubs), `src/terminal/glue.rs` (pointer, wheel, and menu callbacks)

**Interfaces:**
- Consumes: `tether_term::{Cell, SelectKind, MouseMode, MouseTracking}`, `TabTerminal::{mouse_mode, context, snapshot, selection_start, selection_update, selection_text, clear_selection, scroll}`, `tether_core::links::{detect_links, link_at, is_openable, LinkSpan}`, `tether_core::keymap::{encode_key, KeyInput, NamedKey, Mods, KeyAction}`, and `geometry::cell_at` (Task 7).
- Produces:
  - `pub enum MouseKind { Down, Up, Move }`, `pub enum Button { Left, Right, Middle, None }`, and `pub struct MouseMsg { pub kind: MouseKind, pub button: Button, pub mods: Mods, pub x_px: f32, pub y_px: f32, pub at_ms: u64 }`
  - `#[derive(Debug, Default)] pub struct PointerState { pub cell: Option<Cell>, pub held: Option<Button>, pub clicks: ClickCounter, pub wheel_acc: f32 }`
  - `#[derive(Debug, Default)] pub struct ClickCounter` with `fn press(&mut self, at_ms: u64, cell: Cell) -> u8` (1, 2, or 3), and `pub const DOUBLE_CLICK_MS: u64 = 500`
  - `pub fn encode_mouse(mode: MouseMode, kind: MouseKind, button: Button, cell: Cell, mods: Mods, held: Option<Button>) -> Option<Vec<u8>>` and `pub fn encode_wheel(mode: MouseMode, up: bool, cell: Cell, mods: Mods) -> Option<Vec<u8>>`
  - `Msg::CopySelection` and `Msg::PasteClipboard`, for the link menu's second item
  - `TerminalModel::{on_mouse, on_wheel, refresh_hover}`

The model's `pointer` field changes type from `Option<PointerState>` to plain `PointerState`, initialised with `PointerState::default()`.

- [ ] **Step 1: Write the failing encoder tests**

`mouse.rs`, tests:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use tether_term::{MouseMode, MouseTracking};

    const SGR_CLICK: MouseMode = MouseMode { tracking: MouseTracking::Click, sgr: true };
    const X10_CLICK: MouseMode = MouseMode { tracking: MouseTracking::Click, sgr: false };
    fn cell(row: usize, col: usize) -> Cell { Cell { row, col } }
    const NONE: Mods = Mods { shift: false, alt: false, ctrl: false };

    #[test]
    fn sgr_press_and_release() {
        assert_eq!(encode_mouse(SGR_CLICK, MouseKind::Down, Button::Left, cell(2, 4), NONE, None).unwrap(), b"\x1b[<0;5;3M");
        assert_eq!(encode_mouse(SGR_CLICK, MouseKind::Up, Button::Left, cell(2, 4), NONE, None).unwrap(), b"\x1b[<0;5;3m");
        assert_eq!(encode_mouse(SGR_CLICK, MouseKind::Down, Button::Right, cell(0, 0), NONE, None).unwrap(), b"\x1b[<2;1;1M");
    }

    #[test]
    fn x10_press_and_release_and_its_coordinate_limit() {
        assert_eq!(encode_mouse(X10_CLICK, MouseKind::Down, Button::Left, cell(2, 4), NONE, None).unwrap(), vec![0x1b, b'[', b'M', 32, 37, 35]);
        assert_eq!(encode_mouse(X10_CLICK, MouseKind::Up, Button::Left, cell(2, 4), NONE, None).unwrap(), vec![0x1b, b'[', b'M', 35, 37, 35]);
        assert_eq!(encode_mouse(X10_CLICK, MouseKind::Down, Button::Left, cell(0, 300), NONE, None), None);
    }

    #[test]
    fn motion_follows_the_tracking_mode() {
        let drag = MouseMode { tracking: MouseTracking::Drag, sgr: true };
        let motion = MouseMode { tracking: MouseTracking::Motion, sgr: true };
        assert_eq!(encode_mouse(SGR_CLICK, MouseKind::Move, Button::None, cell(0, 0), NONE, Some(Button::Left)), None);
        assert_eq!(encode_mouse(drag, MouseKind::Move, Button::None, cell(0, 0), NONE, None), None);
        assert_eq!(encode_mouse(drag, MouseKind::Move, Button::None, cell(0, 0), NONE, Some(Button::Left)).unwrap(), b"\x1b[<32;1;1M");
        assert_eq!(encode_mouse(motion, MouseKind::Move, Button::None, cell(0, 0), NONE, None).unwrap(), b"\x1b[<35;1;1M");
    }

    #[test]
    fn modifiers_add_their_bits_and_nothing_reports_without_tracking() {
        let ctrl_alt = Mods { shift: false, alt: true, ctrl: true };
        assert_eq!(encode_mouse(SGR_CLICK, MouseKind::Down, Button::Left, cell(0, 0), ctrl_alt, None).unwrap(), b"\x1b[<24;1;1M");
        let off = MouseMode { tracking: MouseTracking::None, sgr: true };
        assert_eq!(encode_mouse(off, MouseKind::Down, Button::Left, cell(0, 0), NONE, None), None);
    }

    #[test]
    fn wheel_is_buttons_64_and_65() {
        assert_eq!(encode_wheel(SGR_CLICK, true, cell(0, 0), NONE).unwrap(), b"\x1b[<64;1;1M");
        assert_eq!(encode_wheel(SGR_CLICK, false, cell(0, 0), NONE).unwrap(), b"\x1b[<65;1;1M");
        assert_eq!(encode_wheel(X10_CLICK, true, cell(0, 0), NONE).unwrap(), vec![0x1b, b'[', b'M', 96, 33, 33]);
    }

    #[test]
    fn clicks_count_up_to_three_on_one_cell_inside_the_window() {
        let mut c = ClickCounter::default();
        assert_eq!(c.press(0, cell(1, 1)), 1);
        assert_eq!(c.press(200, cell(1, 1)), 2);
        assert_eq!(c.press(400, cell(1, 1)), 3);
        assert_eq!(c.press(500, cell(1, 1)), 1);
        assert_eq!(c.press(600, cell(1, 2)), 1);
        assert_eq!(c.press(1_200, cell(1, 2)), 1);
    }
}
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `cargo test -p tether-app terminal::mouse`
Expected: FAIL to compile (`encode_mouse` and `ClickCounter` not found).

- [ ] **Step 3: Implement `mouse.rs`**

```rust
use tether_core::keymap::Mods;
use tether_term::{Cell, MouseMode, MouseTracking};

pub const DOUBLE_CLICK_MS: u64 = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseKind { Down, Up, Move }

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Button { Left, Right, Middle, None }

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MouseMsg { pub kind: MouseKind, pub button: Button, pub mods: Mods, pub x_px: f32, pub y_px: f32, pub at_ms: u64 }

#[derive(Debug, Default)]
pub struct ClickCounter { last: Option<(u64, Cell)>, count: u8 }

impl ClickCounter {
    pub fn press(&mut self, at_ms: u64, cell: Cell) -> u8 {
        let chained = self.last.is_some_and(|(t, c)| c == cell && at_ms.saturating_sub(t) < DOUBLE_CLICK_MS);
        self.count = if chained && self.count < 3 { self.count + 1 } else { 1 };
        self.last = Some((at_ms, cell));
        self.count
    }
}

#[derive(Debug, Default)]
pub struct PointerState { pub cell: Option<Cell>, pub held: Option<Button>, pub clicks: ClickCounter, pub wheel_acc: f32 }

fn code(b: Button) -> u8 {
    match b { Button::Left => 0, Button::Middle => 1, Button::Right => 2, Button::None => 3 }
}

fn mod_bits(m: Mods) -> u8 { (m.shift as u8) * 4 + (m.alt as u8) * 8 + (m.ctrl as u8) * 16 }

fn report(mode: MouseMode, cb: u8, cell: Cell, release: bool) -> Option<Vec<u8>> {
    let (x, y) = (cell.col + 1, cell.row + 1);
    if mode.sgr {
        return Some(format!("\x1b[<{cb};{x};{y}{}", if release { 'm' } else { 'M' }).into_bytes());
    }
    // X10 encodes each coordinate as one byte past 32; columns past 223 cannot be sent.
    if x > 223 || y > 223 { return None; }
    Some(vec![0x1b, b'[', b'M', 32 + cb, 32 + x as u8, 32 + y as u8])
}

pub fn encode_mouse(mode: MouseMode, kind: MouseKind, button: Button, cell: Cell, mods: Mods, held: Option<Button>) -> Option<Vec<u8>> {
    let (cb, release) = match (mode.tracking, kind) {
        (MouseTracking::None, _) => return None,
        (_, MouseKind::Down) if button == Button::None => return None,
        (_, MouseKind::Down) => (code(button), false),
        (_, MouseKind::Up) => (if mode.sgr { code(button) } else { 3 }, true),
        (MouseTracking::Motion, MouseKind::Move) => (32 + held.map_or(3, code), false),
        (MouseTracking::Drag, MouseKind::Move) if held.is_some() => (32 + held.map_or(3, code), false),
        (_, MouseKind::Move) => return None,
    };
    report(mode, cb + mod_bits(mods), cell, release)
}

pub fn encode_wheel(mode: MouseMode, up: bool, cell: Cell, mods: Mods) -> Option<Vec<u8>> {
    if mode.tracking == MouseTracking::None { return None; }
    report(mode, if up { 64 } else { 65 } + mod_bits(mods), cell, false)
}
```

- [ ] **Step 4: Write the failing model pointer tests**

`model/pointer.rs`, tests:

```rust
#[cfg(test)]
mod tests {
    use super::super::tests::{live, t};
    use super::*;
    use crate::terminal::mouse::{Button, MouseKind, MouseMsg};
    use crate::terminal::testkit::session;

    const NONE: Mods = Mods { shift: false, alt: false, ctrl: false };
    const CTRL: Mods = Mods { shift: false, alt: false, ctrl: true };
    const SHIFT: Mods = Mods { shift: true, alt: false, ctrl: false };

    fn ready(bytes: &[u8]) -> TerminalModel {
        let mut m = live(vec![session("a", 1)]);
        m.handle(Msg::WellResized { width_px: 800, height_px: 600, scale: 1.0 }, t(1));
        m.handle(Msg::PtyData { name: "a".into(), bytes: bytes.to_vec() }, t(2));
        m
    }

    /// The pixel centre of a viewport cell, through the same bottom-anchored layout.
    fn at(m: &TerminalModel, row: usize, col: usize) -> (f32, f32) {
        let l = m.layout().unwrap();
        let top = l.height_px as f32 - l.padding_px as f32 - l.size.rows as f32 * l.cell_h;
        (l.padding_px as f32 + (col as f32 + 0.5) * l.cell_w, top + (row as f32 + 0.5) * l.cell_h)
    }

    fn mouse(m: &mut TerminalModel, kind: MouseKind, button: Button, row: usize, col: usize, mods: Mods, at_ms: u64) -> Vec<Effect> {
        let (x, y) = at(m, row, col);
        m.handle(Msg::Mouse(MouseMsg { kind, button, mods, x_px: x, y_px: y, at_ms }), t(at_ms))
    }

    fn writes(fx: &[Effect]) -> Vec<Vec<u8>> {
        fx.iter().filter_map(|e| match e { Effect::Write { bytes, .. } => Some(bytes.clone()), _ => None }).collect()
    }

    fn selection(m: &TerminalModel) -> Option<String> { m.tabs["a"].term.selection_text() }

    #[test]
    fn drag_selects_locally() {
        let mut m = ready(b"hello world");
        mouse(&mut m, MouseKind::Down, Button::Left, 0, 0, NONE, 10);
        mouse(&mut m, MouseKind::Move, Button::None, 0, 4, NONE, 20);
        mouse(&mut m, MouseKind::Up, Button::Left, 0, 4, NONE, 30);
        assert_eq!(selection(&m).as_deref(), Some("hello"));
    }

    #[test]
    fn double_click_selects_a_word_and_triple_a_line() {
        let mut m = ready(b"hello world");
        mouse(&mut m, MouseKind::Down, Button::Left, 0, 7, NONE, 10);
        mouse(&mut m, MouseKind::Down, Button::Left, 0, 7, NONE, 100);
        assert_eq!(selection(&m).as_deref(), Some("world"));
        mouse(&mut m, MouseKind::Down, Button::Left, 0, 7, NONE, 200);
        assert_eq!(selection(&m).map(|s| s.trim_end().to_string()).as_deref(), Some("hello world"));
    }

    #[test]
    fn reporting_sends_clicks_to_the_program_and_shift_selects_locally() {
        let mut m = ready(b"\x1b[?1000h\x1b[?1006hhello");
        let fx = mouse(&mut m, MouseKind::Down, Button::Left, 0, 1, NONE, 10);
        assert_eq!(writes(&fx), vec![b"\x1b[<0;2;1M".to_vec()]);
        mouse(&mut m, MouseKind::Up, Button::Left, 0, 1, NONE, 20);
        assert_eq!(selection(&m), None);
        let fx = mouse(&mut m, MouseKind::Down, Button::Left, 0, 0, SHIFT, 1_000);
        assert!(writes(&fx).is_empty());
        mouse(&mut m, MouseKind::Move, Button::None, 0, 4, SHIFT, 1_010);
        assert_eq!(selection(&m).as_deref(), Some("hello"));
    }

    #[test]
    fn ctrl_click_opens_a_link_and_is_never_reported() {
        let mut m = ready(b"\x1b[?1000h\x1b[?1006hsee https://example.com/x now");
        let fx = mouse(&mut m, MouseKind::Down, Button::Left, 0, 10, CTRL, 10);
        assert!(fx.contains(&Effect::Ui(UiEffect::OpenUrl("https://example.com/x".into()))));
        assert!(writes(&fx).is_empty());
    }

    #[test]
    fn only_http_https_and_mailto_open() {
        let mut m = ready(b"\x1b]8;;file:///etc/passwd\x07click\x1b]8;;\x07");
        let fx = mouse(&mut m, MouseKind::Down, Button::Left, 0, 1, CTRL, 10);
        assert!(!fx.iter().any(|e| matches!(e, Effect::Ui(UiEffect::OpenUrl(_)))));
    }

    #[test]
    fn ctrl_hover_shows_a_hand_and_the_osc8_target_and_releasing_ctrl_clears_it() {
        let mut m = ready(b"\x1b]8;;https://a.example/\x07click\x1b]8;;\x07");
        let fx = mouse(&mut m, MouseKind::Move, Button::None, 0, 2, CTRL, 10);
        assert!(fx.contains(&Effect::Ui(UiEffect::Pointer(PointerShape::Hand))));
        assert!(fx.contains(&Effect::Ui(UiEffect::Tooltip(Some("https://a.example/".into())))));
        let fx = m.handle(Msg::Modifiers(NONE), t(20));
        assert!(fx.contains(&Effect::Ui(UiEffect::Pointer(PointerShape::Text))));
        assert!(fx.contains(&Effect::Ui(UiEffect::Tooltip(None))));
    }

    #[test]
    fn pressing_ctrl_over_a_detected_link_underlines_it_without_a_tooltip() {
        let mut m = ready(b"go https://example.com/x");
        mouse(&mut m, MouseKind::Move, Button::None, 0, 8, NONE, 10);
        let fx = m.handle(Msg::Modifiers(CTRL), t(20));
        assert!(fx.contains(&Effect::Ui(UiEffect::Pointer(PointerShape::Hand))));
        assert!(fx.contains(&Effect::Ui(UiEffect::Tooltip(None))));
        assert_eq!(m.hover, Some((0, 3, 24)));
    }

    #[test]
    fn right_click_pastes_without_a_selection_and_copies_with_one() {
        let mut m = ready(b"hello");
        assert!(mouse(&mut m, MouseKind::Down, Button::Right, 0, 0, NONE, 10).contains(&Effect::Ui(UiEffect::ReadClipboard)));
        mouse(&mut m, MouseKind::Down, Button::Left, 0, 0, NONE, 1_000);
        mouse(&mut m, MouseKind::Move, Button::None, 0, 4, NONE, 1_010);
        mouse(&mut m, MouseKind::Up, Button::Left, 0, 4, NONE, 1_020);
        let fx = mouse(&mut m, MouseKind::Down, Button::Right, 0, 0, NONE, 2_000);
        assert!(fx.contains(&Effect::Ui(UiEffect::SetClipboard("hello".into()))));
        assert_eq!(selection(&m), None);
    }

    #[test]
    fn right_click_on_a_link_offers_copy_link() {
        let mut m = ready(b"go https://example.com/x");
        let fx = mouse(&mut m, MouseKind::Down, Button::Right, 0, 8, NONE, 10);
        assert!(fx.contains(&Effect::Ui(UiEffect::Menu(MenuRequest::Link { url: "https://example.com/x".into(), copy_selection: false }))));
    }

    #[test]
    fn the_wheel_scrolls_back_and_sends_arrows_on_the_alternate_screen() {
        let mut m = ready(&b"line\r\n".repeat(200));
        let cell_h = m.layout().unwrap().cell_h;
        let (x, y) = at(&m, 0, 0);
        m.handle(Msg::Wheel { delta_px: 3.0 * cell_h, mods: NONE, x_px: x, y_px: y }, t(10));
        assert_eq!(m.tabs["a"].term.display_offset(), 3);
        m.handle(Msg::PtyData { name: "a".into(), bytes: b"\x1b[?1049h".to_vec() }, t(20));
        let fx = m.handle(Msg::Wheel { delta_px: 2.0 * cell_h, mods: NONE, x_px: x, y_px: y }, t(30));
        assert_eq!(writes(&fx), vec![b"\x1b[A".to_vec(), b"\x1b[A".to_vec()]);
    }

    #[test]
    fn the_wheel_goes_to_the_program_under_reporting() {
        let mut m = ready(b"\x1b[?1000h\x1b[?1006h");
        let cell_h = m.layout().unwrap().cell_h;
        let (x, y) = at(&m, 0, 0);
        let fx = m.handle(Msg::Wheel { delta_px: -cell_h, mods: NONE, x_px: x, y_px: y }, t(10));
        assert_eq!(writes(&fx), vec![b"\x1b[<65;1;1M".to_vec()]);
    }

    #[test]
    fn ctrl_wheel_changes_the_font_size() {
        let mut m = ready(b"");
        let fx = m.handle(Msg::Wheel { delta_px: 40.0, mods: CTRL, x_px: 10.0, y_px: 10.0 }, t(10));
        assert!(fx.contains(&Effect::Ui(UiEffect::FontStep(FontStep::Bigger))));
    }
}
```

`pressing_ctrl_over_a_detected_link_underlines_it_without_a_tooltip` expects `hover == (0, 3, 24)`: the row, then the URL's start and end column (`https://example.com/x` is 21 characters starting at column 3). `display_offset` after the first wheel step relies on M4's convention that `scroll(n > 0)` moves back into history.

- [ ] **Step 5: Run the tests and watch them fail**

Run: `cargo test -p tether-app terminal::model::pointer`
Expected: FAIL. `pointer.rs` has only tests, and the stubs produce nothing.

- [ ] **Step 6: Implement `model/pointer.rs`**

Remove the `on_mouse`, `on_wheel`, and `refresh_hover` stubs from `input.rs`, then add `mod pointer;` to `model/mod.rs`. Add the `Msg::CopySelection` and `Msg::PasteClipboard` variants, with these `handle` arms: `Msg::CopySelection => self.on_command(TetherCommand::Copy, Mods { shift: false, alt: false, ctrl: true }, &mut fx)` and `Msg::PasteClipboard => fx.push(Effect::Ui(UiEffect::ReadClipboard))`.

```rust
use super::*;
use crate::terminal::geometry::cell_at;
use crate::terminal::mouse::{encode_mouse, encode_wheel, Button, MouseKind, MouseMsg};
use tether_core::keymap::{encode_key, KeyAction, KeyInput, NamedKey};
use tether_core::links::{detect_links, is_openable, link_at, LinkSpan};
use tether_term::{Cell, MouseTracking, SelectKind};

impl TerminalModel {
    /// OSC 8 wins over text that only looks like a link.
    fn link_under(&self, cell: Cell) -> Option<(LinkSpan, bool)> {
        let snap = self.active_name().and_then(|n| self.tabs.get(n))?.term.snapshot();
        if let Some(span) = link_at(&snap.osc8, cell.row, cell.col) { return Some((span.clone(), true)); }
        let detected = detect_links(&snap.row_texts, &snap.wrapped, Some(snap.cols));
        link_at(&detected, cell.row, cell.col).map(|s| (s.clone(), false))
    }

    fn set_hover(&mut self, hover: Option<(LinkSpan, bool, usize)>, fx: &mut Vec<Effect>) {
        let next = hover.as_ref().map(|(s, _, row)| (*row, s.start, s.end));
        if next == self.hover { return; }
        self.hover = next;
        fx.push(Effect::Ui(UiEffect::Pointer(if next.is_some() { PointerShape::Hand } else { PointerShape::Text })));
        // The tooltip shows only an OSC 8 target, since its visible text can differ from where it goes.
        fx.push(Effect::Ui(UiEffect::Tooltip(hover.and_then(|(s, explicit, _)| explicit.then_some(s.url)))));
        fx.push(Effect::Redraw);
    }

    pub(crate) fn refresh_hover(&mut self, fx: &mut Vec<Effect>) {
        match (self.mods.ctrl, self.pointer.cell) {
            (true, Some(cell)) => {
                let hover = self.link_under(cell).map(|(s, e)| (s, e, cell.row));
                self.set_hover(hover, fx);
            }
            _ if self.hover.is_some() => self.set_hover(None, fx),
            _ => {}
        }
    }

    pub(crate) fn on_mouse(&mut self, m: MouseMsg, fx: &mut Vec<Effect>) {
        let Some(l) = self.layout else { return };
        let Some(name) = self.active_name().map(str::to_string) else { return };
        let cell = cell_at(&l, m.x_px, m.y_px);
        self.pointer.cell = Some(cell);
        self.mods = m.mods;
        if m.mods.ctrl {
            let link = self.link_under(cell);
            self.set_hover(link.clone().map(|(s, e)| (s, e, cell.row)), fx);
            if m.kind == MouseKind::Down && m.button == Button::Left {
                if let Some((span, _)) = link.filter(|(s, _)| is_openable(&s.url)) {
                    fx.push(Effect::Ui(UiEffect::OpenUrl(span.url)));
                }
            }
            // Ctrl+click belongs to Tether, even under mouse reporting.
            return;
        } else if self.hover.is_some() {
            self.set_hover(None, fx);
        }
        let Some(tab) = self.tabs.get_mut(&name) else { return };
        let mode = tab.term.mouse_mode();
        if mode.tracking != MouseTracking::None && !m.mods.shift {
            let held = self.pointer.held;
            if let Some(bytes) = encode_mouse(mode, m.kind, m.button, cell, m.mods, held) {
                self.write_active(bytes, fx);
            }
            match m.kind {
                MouseKind::Down => self.pointer.held = Some(m.button),
                MouseKind::Up => self.pointer.held = None,
                MouseKind::Move => {}
            }
            return;
        }
        match (m.kind, m.button) {
            (MouseKind::Down, Button::Left) => {
                let kind = match self.pointer.clicks.press(m.at_ms, cell) { 1 => SelectKind::Simple, 2 => SelectKind::Word, _ => SelectKind::Line };
                tab.term.selection_start(cell, kind);
                self.pointer.held = Some(Button::Left);
                fx.push(Effect::Redraw);
            }
            (MouseKind::Move, _) if self.pointer.held == Some(Button::Left) => {
                tab.term.selection_update(cell);
                fx.push(Effect::Redraw);
            }
            (MouseKind::Up, Button::Left) => self.pointer.held = None,
            (MouseKind::Down, Button::Right) => {
                let selected = tab.term.selection_text();
                if let Some((span, _)) = self.link_under(cell) {
                    fx.push(Effect::Ui(UiEffect::Menu(MenuRequest::Link { url: span.url, copy_selection: selected.is_some() })));
                } else if let Some(text) = selected {
                    fx.push(Effect::Ui(UiEffect::SetClipboard(text)));
                    if let Some(tab) = self.tabs.get_mut(&name) { tab.term.clear_selection(); }
                    fx.push(Effect::Redraw);
                } else {
                    fx.push(Effect::Ui(UiEffect::ReadClipboard));
                }
            }
            _ => {}
        }
    }

    pub(crate) fn on_wheel(&mut self, delta_px: f32, mods: Mods, x_px: f32, y_px: f32, fx: &mut Vec<Effect>) {
        if mods.ctrl {
            let step = if delta_px > 0.0 { FontStep::Bigger } else { FontStep::Smaller };
            fx.push(Effect::Ui(UiEffect::FontStep(step)));
            return;
        }
        let Some(l) = self.layout else { return };
        let Some(name) = self.active_name().map(str::to_string) else { return };
        self.pointer.wheel_acc += delta_px / l.cell_h;
        let lines = self.pointer.wheel_acc.trunc() as i32;
        if lines == 0 { return; }
        self.pointer.wheel_acc -= lines as f32;
        let cell = cell_at(&l, x_px, y_px);
        let Some(tab) = self.tabs.get_mut(&name) else { return };
        let mode = tab.term.mouse_mode();
        let ctx = tab.term.context();
        let mut out = Vec::new();
        if mode.tracking != MouseTracking::None && !mods.shift {
            for _ in 0..lines.abs() { out.extend(encode_wheel(mode, lines > 0, cell, mods)); }
        } else if ctx.alt_screen {
            let key = KeyInput::Named(if lines > 0 { NamedKey::Up } else { NamedKey::Down });
            for _ in 0..lines.abs() {
                if let KeyAction::Send(b) = encode_key(&key, Mods::default(), &ctx) { out.push(b); }
            }
        } else {
            tab.term.scroll(lines);
            fx.push(Effect::Redraw);
        }
        for bytes in out { self.write_active(bytes, fx); }
    }
}
```

`set_hover` is idempotent: moving across cells of the same link re-emits nothing. The first hover emits `Pointer(Hand)` and its tooltip. `refresh_hover` also runs from `on_modifiers` (Task 9), so pressing Ctrl over a link underlines it without moving the mouse.

- [ ] **Step 7: Wire the pointer, wheel, and link menu in `glue.rs`**

Append inside `wire_callbacks`:

```rust
    use crate::terminal::mouse::{Button, MouseKind, MouseMsg};
    let started = std::time::Instant::now();
    let weak = app.as_weak();
    vm.on_pointer(move |kind, button, shift, ctrl, alt, x, y| {
        let Some(w) = weak.upgrade() else { return };
        let scale = w.window().scale_factor();
        let vm = w.global::<TerminalVm>();
        vm.set_pointer_x(x); vm.set_pointer_y(y);
        let kind = match kind { 0 => MouseKind::Down, 1 => MouseKind::Up, _ => MouseKind::Move };
        let button = match button { 0 => Button::Left, 1 => Button::Right, 2 => Button::Middle, _ => Button::None };
        if kind == MouseKind::Down && button == Button::Right {
            vm.set_menu_x(x); vm.set_menu_y(y + 52.0 + 34.0);
        }
        let mods = tether_core::keymap::Mods { shift, alt, ctrl };
        send(Msg::Mouse(MouseMsg { kind, button, mods, x_px: x * scale, y_px: y * scale, at_ms: started.elapsed().as_millis() as u64 }));
    });
    let weak = app.as_weak();
    vm.on_wheel(move |delta, shift, ctrl, alt, x, y| {
        let Some(w) = weak.upgrade() else { return };
        let scale = w.window().scale_factor();
        send(Msg::Wheel { delta_px: delta * scale, mods: tether_core::keymap::Mods { shift, alt, ctrl }, x_px: x * scale, y_px: y * scale });
    });
    let (weak, p) = (app.as_weak(), platform.clone());
    vm.on_copy_link(move || {
        let Some(w) = weak.upgrade() else { return };
        let vm = w.global::<TerminalVm>();
        p.set_clipboard(vm.get_menu_link().as_str());
        vm.set_menu_link("".into());
    });
    let weak = app.as_weak();
    vm.on_menu_primary(move || {
        let Some(w) = weak.upgrade() else { return };
        let vm = w.global::<TerminalVm>();
        send(if vm.get_menu_copy() { Msg::CopySelection } else { Msg::PasteClipboard });
        vm.set_menu_link("".into());
    });
```

The menu sits at the pointer. The well's TouchArea reports coordinates relative to the well, so `y` is offset by the header and strip heights (52 + 34 logical px, the heights in `terminal.slint`). When the progress bar is showing, add its 2 px too, or move the menu inside the well rectangle and drop the offset. Moving it is the cleaner option, if that suits the Slint version better.

In `ui_port.rs`, the effect `UiEffect::OpenUrl` already goes to `platform.open_url`. Task 12's `WindowsPlatform` checks `is_openable` once more before calling `ShellExecuteW`, as a second guard.

- [ ] **Step 8: Run the tests and watch them pass**

Run: `cargo test -p tether-app terminal::`
Expected: PASS: 6 encoder tests and 12 pointer tests, plus everything before.

- [ ] **Step 9: Commit**

```bash
git add clients/windows/crates/tether-app/src
git commit -m "feat(windows): mouse selection, reporting, wheel, and Ctrl+click links

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Title, OSC 52, toasts, progress, and the Windows platform

**Files:**
- Modify: `clients/windows/crates/tether-app/src/terminal/model/events.rs` (`on_report_event`), `src/terminal/model/reconnect.rs` (`tick_toasts`), `src/terminal/model/tabs.rs` (`activate`, `on_focus` forget pending toasts)
- Create: `src/win32/taskbar.rs`, `src/win32/toast.rs`, `src/win32/aumid.rs`, `src/win32/shell.rs`, `src/win32/platform.rs`
- Modify: `src/win32/mod.rs` (declare these modules unconditionally; each gates its own Win32 half), `src/terminal/ui_port.rs` (platform calls move to the UI thread), `src/main.rs`

**Interfaces:**
- Consumes: `tether_term::TermEvent::{Title, Clipboard, Notify, ProgressChanged, CwdChanged}`; `tether_core::throttle::{ToastThrottle, ToastDecision, wants_toast}`; `tether_core::osc::{Notification, Progress, ProgressState}`; `tether_core::links::is_openable`; and `windows` 0.62 (`UI::Notifications::{ToastNotificationManager, ToastNotification, ToastNotifier}`, `Data::Xml::Dom::XmlDocument`, `Win32::UI::Shell::{ITaskbarList3, TaskbarList, ShellExecuteW, IShellLinkW, ShellLink, SetCurrentProcessExplicitAppUserModelID}`, `Win32::UI::Shell::PropertiesSystem::IPropertyStore`, `Win32::Storage::EnhancedStorage::PKEY_AppUserModel_ID`, `Win32::System::Com::{CoCreateInstance, IPersistFile, CLSCTX_INPROC_SERVER}`, `Win32::UI::WindowsAndMessaging::{FlashWindowEx, FLASHWINFO, FLASHW_TRAY, FLASHW_TIMERNOFG, SetForegroundWindow, ShowWindow, IsIconic, SW_RESTORE, SW_SHOWNORMAL}`, `Win32::Storage::Packaging::Appx::GetCurrentPackageFullName`).
- Produces:
  - `pub enum TaskbarState { NoProgress, Normal, Error, Indeterminate, Paused }` and `pub fn taskbar_state(p: Option<&Progress>) -> (TaskbarState, Option<u64>)` (`taskbar.rs`, pure)
  - `pub fn toast_xml(header: &str, body: &str, session: &str) -> String` and `pub fn toast_tag(session: &str) -> String` (`toast.rs`, pure)
  - `pub const AUMID: &str = "Tether.Terminal"`, `pub enum ToastIdentity { Packaged, Portable }`, and `pub fn toast_identity(packaged: bool, shortcut_ok: bool) -> Option<ToastIdentity>` (`aumid.rs`, pure)
  - `#[cfg(windows)] pub struct WindowsPlatform`, with `WindowsPlatform::new(window: slint::Weak<AppWindow>) -> Self`, implementing `Platform` (`platform.rs`)

- [ ] **Step 1: Write the failing model tests**

Append to `events.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::super::tests::{live, t};
    use super::*;
    use crate::terminal::testkit::session;
    use tether_core::osc::{Progress, ProgressState};

    /// Two tabs; "a" active and attached, "b" attached in the background.
    fn two() -> TerminalModel {
        let mut m = live(vec![session("a", 1), session("b", 2)]);
        m.handle(Msg::Attached { name: "b".into() }, t(1));
        m.handle(Msg::SelectTab("a".into()), t(2));
        m.handle(Msg::Attached { name: "a".into() }, t(2));
        m
    }

    fn feed(m: &mut TerminalModel, tab: &str, bytes: &[u8], ms: u64) -> Vec<Effect> {
        m.handle(Msg::PtyData { name: tab.into(), bytes: bytes.to_vec() }, t(ms))
    }

    fn toasts(fx: &[Effect]) -> Vec<(String, String, String)> {
        fx.iter().filter_map(|e| match e {
            Effect::Ui(UiEffect::Toast { session, title, body }) => Some((session.clone(), title.clone(), body.clone())),
            _ => None,
        }).collect()
    }

    #[test]
    fn the_osc_title_follows_the_active_tab_only() {
        let mut m = two();
        let fx = feed(&mut m, "a", b"\x1b]2;vim README\x07", 10);
        assert!(fx.contains(&Effect::Ui(UiEffect::SetTitle("devbox · a · vim README".into()))));
        let fx = feed(&mut m, "b", b"\x1b]2;htop\x07", 11);
        assert!(!fx.iter().any(|e| matches!(e, Effect::Ui(UiEffect::SetTitle(_)))));
        let fx = m.handle(Msg::SelectTab("b".into()), t(12));
        assert!(fx.contains(&Effect::Ui(UiEffect::SetTitle("devbox · b · htop".into()))));
    }

    #[test]
    fn osc52_copies_only_while_the_window_has_focus() {
        let mut m = two();
        assert!(feed(&mut m, "a", b"\x1b]52;c;aGVsbG8=\x07", 10).contains(&Effect::Ui(UiEffect::SetClipboard("hello".into()))));
        m.handle(Msg::Focus(false), t(11));
        assert!(!feed(&mut m, "a", b"\x1b]52;c;aGVsbG8=\x07", 12).iter().any(|e| matches!(e, Effect::Ui(UiEffect::SetClipboard(_)))));
    }

    #[test]
    fn a_background_notification_toasts_and_marks_the_tab() {
        let mut m = two();
        let fx = feed(&mut m, "b", b"\x1b]9;build done\x07", 10);
        assert_eq!(toasts(&fx), vec![("b".into(), "devbox · b".into(), "build done".into())]);
        assert!(m.view().tabs.iter().find(|t| t.name == "b").unwrap().attention);
    }

    #[test]
    fn osc777_carries_its_title_into_the_body() {
        let mut m = two();
        let fx = feed(&mut m, "b", b"\x1b]777;notify;Claude;Needs you\x07", 10);
        assert_eq!(toasts(&fx)[0].2, "Claude\nNeeds you");
    }

    #[test]
    fn osc_9_4_is_progress_never_a_toast() {
        let mut m = two();
        let fx = feed(&mut m, "a", b"\x1b]9;4;1;50\x07", 10);
        assert!(toasts(&fx).is_empty());
        assert!(fx.contains(&Effect::Ui(UiEffect::Taskbar(Some(Progress { state: ProgressState::Normal, percent: 50 })))));
    }

    #[test]
    fn the_focused_active_tab_gets_no_toast_but_an_unfocused_one_does() {
        let mut m = two();
        assert!(toasts(&feed(&mut m, "a", b"\x1b]9;hi\x07", 10)).is_empty());
        m.handle(Msg::Focus(false), t(11));
        assert_eq!(toasts(&feed(&mut m, "a", b"\x1b]9;hi\x07", 12)).len(), 1);
    }

    #[test]
    fn toasts_throttle_per_session_and_the_latest_pending_one_wins() {
        let mut m = two();
        assert_eq!(toasts(&feed(&mut m, "b", b"\x1b]9;one\x07", 0)).len(), 1);
        assert!(toasts(&feed(&mut m, "b", b"\x1b]9;two\x07", 1_000)).is_empty());
        assert!(toasts(&feed(&mut m, "b", b"\x1b]9;three\x07", 2_000)).is_empty());
        assert!(toasts(&m.handle(Msg::Tick, t(4_900))).is_empty());
        let later = toasts(&m.handle(Msg::Tick, t(5_100)));
        assert_eq!(later, vec![("b".into(), "devbox · b".into(), "three".into())]);
    }

    #[test]
    fn viewing_the_tab_drops_its_pending_toast() {
        let mut m = two();
        feed(&mut m, "b", b"\x1b]9;one\x07", 0);
        feed(&mut m, "b", b"\x1b]9;two\x07", 1_000);
        m.handle(Msg::SelectTab("b".into()), t(2_000));
        assert!(toasts(&m.handle(Msg::Tick, t(6_000))).is_empty());
    }

    #[test]
    fn progress_drives_the_taskbar_and_a_prompt_clears_it() {
        let mut m = two();
        assert!(feed(&mut m, "a", b"\x1b]9;4;2;30\x07", 10).contains(&Effect::Ui(UiEffect::Taskbar(Some(Progress { state: ProgressState::Error, percent: 30 })))));
        assert!(feed(&mut m, "a", b"\x1b]133;A\x07", 11).contains(&Effect::Ui(UiEffect::Taskbar(None))));
    }

    #[test]
    fn background_progress_stays_on_its_tab() {
        let mut m = two();
        let fx = feed(&mut m, "b", b"\x1b]9;4;1;70\x07", 10);
        assert!(!fx.iter().any(|e| matches!(e, Effect::Ui(UiEffect::Taskbar(_)))));
        assert_eq!(m.view().tabs.iter().find(|t| t.name == "b").unwrap().progress, Some(Progress { state: ProgressState::Normal, percent: 70 }));
        assert!(m.handle(Msg::SelectTab("b".into()), t(11)).contains(&Effect::Ui(UiEffect::Taskbar(Some(Progress { state: ProgressState::Normal, percent: 70 })))));
    }

    #[test]
    fn a_bell_burst_rings_once_and_flashes_the_taskbar_when_unfocused() {
        let mut m = two();
        m.handle(Msg::Focus(false), t(5));
        let fx = feed(&mut m, "a", b"\x07\x07\x07", 10);
        assert_eq!(fx.iter().filter(|e| **e == Effect::Ui(UiEffect::LampFlash)).count(), 1);
        assert!(fx.contains(&Effect::Ui(UiEffect::FlashTaskbar)));
        assert!(!feed(&mut m, "a", b"\x07", 100).contains(&Effect::Ui(UiEffect::LampFlash)));
        assert!(feed(&mut m, "a", b"\x07", 400).contains(&Effect::Ui(UiEffect::LampFlash)));
    }

    #[test]
    fn a_toast_click_brings_the_window_forward_on_that_tab() {
        let mut m = two();
        let fx = m.handle(Msg::ToastClicked("b".into()), t(10));
        assert!(fx.contains(&Effect::Ui(UiEffect::BringToFront)));
        assert_eq!(m.view().header.session, "b");
    }
}
```

`a_bell_burst_rings_once…` relies on M4 reporting a bell per BEL byte; `BellThrottle` lets the first through and holds the rest for 200 ms.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `cargo test -p tether-app terminal::model::events`
Expected: FAIL. `on_report_event` is still empty.

- [ ] **Step 3: Implement the model half**

`events.rs`, replacing the `on_report_event` stub:

```rust
use tether_core::throttle::{wants_toast, ToastDecision};
use tether_core::osc::Notification;

impl TerminalModel {
    pub(crate) fn on_report_event(&mut self, name: &str, ev: TermEvent, active: bool, now: Duration, fx: &mut Vec<Effect>) {
        match ev {
            // alacritty's Title honours the title push/pop stack; TabReports.title is not used here.
            TermEvent::Title(title) => {
                if let Some(tab) = self.tabs.get_mut(name) { tab.osc_title = title; }
                if active { fx.push(Effect::Ui(UiEffect::SetTitle(self.window_title()))); }
            }
            TermEvent::Clipboard(text) => {
                if self.focused { fx.push(Effect::Ui(UiEffect::SetClipboard(text))); }
            }
            TermEvent::Notify(n) => {
                if !active {
                    if let Some(strip) = self.strip.as_mut() { strip.mark_attention(name); }
                }
                if wants_toast(self.focused, active) {
                    if let ToastDecision::Show(n) = self.toasts.offer(name, n, now) { self.push_toast(name, n, fx); }
                }
            }
            TermEvent::ProgressChanged => {
                if active {
                    let p = self.tabs.get(name).and_then(|t| t.term.reports().progress.clone());
                    fx.push(Effect::Ui(UiEffect::Taskbar(p)));
                }
            }
            TermEvent::CwdChanged | TermEvent::Bell | TermEvent::Reply(_) => {}
        }
    }

    fn push_toast(&self, session: &str, n: Notification, fx: &mut Vec<Effect>) {
        let body = match n.title { Some(t) if !t.is_empty() => format!("{t}\n{}", n.body), _ => n.body };
        fx.push(Effect::Ui(UiEffect::Toast { session: session.into(), title: format!("{} · {}", self.machine.name, session), body }));
    }

    pub(crate) fn toast_due(&mut self, now: Duration, fx: &mut Vec<Effect>) {
        for (session, n) in self.toasts.poll(now) {
            let active = self.active_name() == Some(session.as_str());
            if wants_toast(self.focused, active) { self.push_toast(&session, n, fx); }
        }
    }
}
```

`reconnect.rs`: replace the `tick_toasts` stub body with `self.toast_due(now, fx);`.

`tabs.rs`: in `activate`, after `strip.select(…)`, add `self.toasts.forget(name);`. In `on_focus`, when `focused` is true, add `if let Some(a) = self.active_name().map(str::to_string) { self.toasts.forget(&a); }`. The user is looking at that tab now.

- [ ] **Step 4: Run the model tests and watch them pass**

Run: `cargo test -p tether-app terminal::model::events`
Expected: PASS (12).

- [ ] **Step 5: Write the failing pure Win32-decision tests**

`taskbar.rs`:

```rust
use tether_core::osc::{Progress, ProgressState};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskbarState { NoProgress, Normal, Error, Indeterminate, Paused }

pub fn taskbar_state(p: Option<&Progress>) -> (TaskbarState, Option<u64>) {
    let Some(p) = p else { return (TaskbarState::NoProgress, None) };
    let value = Some(p.percent as u64);
    match p.state {
        ProgressState::Normal => (TaskbarState::Normal, value),
        ProgressState::Error => (TaskbarState::Error, value),
        ProgressState::Paused => (TaskbarState::Paused, value),
        ProgressState::Indeterminate => (TaskbarState::Indeterminate, None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_osc_9_4_state_maps_to_the_taskbar() {
        let p = |state, percent| Progress { state, percent };
        assert_eq!(taskbar_state(None), (TaskbarState::NoProgress, None));
        assert_eq!(taskbar_state(Some(&p(ProgressState::Normal, 40))), (TaskbarState::Normal, Some(40)));
        assert_eq!(taskbar_state(Some(&p(ProgressState::Error, 40))), (TaskbarState::Error, Some(40)));
        assert_eq!(taskbar_state(Some(&p(ProgressState::Paused, 10))), (TaskbarState::Paused, Some(10)));
        assert_eq!(taskbar_state(Some(&p(ProgressState::Indeterminate, 0))), (TaskbarState::Indeterminate, None));
    }
}
```

`toast.rs`:

```rust
pub fn escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&apos;")
}

/// `ToastGeneric`: `<machine> · <session>` over the text, one `<text>` per line (at most two more).
pub fn toast_xml(header: &str, body: &str, session: &str) -> String {
    let lines: String = body.lines().filter(|l| !l.is_empty()).take(2)
        .map(|l| format!("<text>{}</text>", escape(l))).collect();
    format!(
        "<toast launch=\"{}\"><visual><binding template=\"ToastGeneric\"><text>{}</text>{}</binding></visual><audio silent=\"true\"/></toast>",
        escape(&format!("tether:tab={session}")), escape(header), lines
    )
}

/// Toast tags cap at 64 UTF-16 units; one tag per session lets a new toast replace the old one.
pub fn toast_tag(session: &str) -> String {
    if session.encode_utf16().count() <= 64 && session.is_ascii() { return session.to_string(); }
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    session.hash(&mut h);
    format!("s{:016x}", h.finish())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xml_escapes_program_text() {
        let xml = toast_xml("devbox · b", "a <b> & \"c\"", "b");
        assert!(xml.contains("<text>devbox · b</text>"));
        assert!(xml.contains("<text>a &lt;b&gt; &amp; &quot;c&quot;</text>"));
        assert!(xml.contains("launch=\"tether:tab=b\""));
        assert!(xml.contains("<audio silent=\"true\"/>"));
    }

    #[test]
    fn a_two_line_body_becomes_two_texts() {
        let xml = toast_xml("h", "Claude\nNeeds you", "s");
        assert!(xml.contains("<text>Claude</text><text>Needs you</text>"));
    }

    #[test]
    fn long_or_unicode_names_hash_into_a_short_tag() {
        assert_eq!(toast_tag("build"), "build");
        assert!(toast_tag(&"x".repeat(80)).len() <= 64);
        assert!(toast_tag("日本").starts_with('s'));
    }
}
```

`aumid.rs`:

```rust
pub const AUMID: &str = "Tether.Terminal";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToastIdentity { Packaged, Portable }

/// Toasts need an app identity: the MSIX has one; the portable zip gets one from a
/// Start-menu shortcut. Without either, toasts are skipped and only the taskbar flashes.
pub fn toast_identity(packaged: bool, shortcut_ok: bool) -> Option<ToastIdentity> {
    if packaged { Some(ToastIdentity::Packaged) } else if shortcut_ok { Some(ToastIdentity::Portable) } else { None }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_comes_from_the_package_or_the_shortcut() {
        assert_eq!(toast_identity(true, false), Some(ToastIdentity::Packaged));
        assert_eq!(toast_identity(false, true), Some(ToastIdentity::Portable));
        assert_eq!(toast_identity(false, false), None);
    }
}
```

Run: `cargo test -p tether-app win32::`
Expected: PASS (5). These are pure mappings, written together with their tests. The Win32 halves below have no automated test; the manual checks cover them.

- [ ] **Step 6: Implement the Win32 halves**

In `win32/mod.rs`, declare `pub mod aumid; pub mod shell; pub mod taskbar; pub mod toast; #[cfg(windows)] pub mod platform;` (no `#[cfg]` on the first four). Inside each of those four files, put the Win32 code in a `#[cfg(windows)] mod win { … } #[cfg(windows)] pub use win::*;` block.

`taskbar.rs` (Windows part):

```rust
#[cfg(windows)]
mod win {
    use super::*;
    use std::cell::RefCell;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
    use windows::Win32::UI::Shell::{ITaskbarList3, TaskbarList, TBPF_ERROR, TBPF_INDETERMINATE, TBPF_NOPROGRESS, TBPF_NORMAL, TBPF_PAUSED};
    use windows::Win32::UI::WindowsAndMessaging::{FlashWindowEx, FLASHWINFO, FLASHW_TIMERNOFG, FLASHW_TRAY};

    thread_local! {
        // An STA object: created and used on the UI thread only.
        static LIST: RefCell<Option<ITaskbarList3>> = const { RefCell::new(None) };
    }

    fn with_list(f: impl FnOnce(&ITaskbarList3)) {
        LIST.with(|l| {
            let mut l = l.borrow_mut();
            if l.is_none() {
                *l = unsafe { CoCreateInstance::<_, ITaskbarList3>(&TaskbarList, None, CLSCTX_INPROC_SERVER) }
                    .ok().filter(|list| unsafe { list.HrInit() }.is_ok());
            }
            if let Some(list) = l.as_ref() { f(list); }
        });
    }

    pub fn set_progress(hwnd: isize, p: Option<&Progress>) {
        let (state, value) = taskbar_state(p);
        let flag = match state {
            TaskbarState::NoProgress => TBPF_NOPROGRESS, TaskbarState::Normal => TBPF_NORMAL, TaskbarState::Error => TBPF_ERROR,
            TaskbarState::Indeterminate => TBPF_INDETERMINATE, TaskbarState::Paused => TBPF_PAUSED,
        };
        with_list(|list| unsafe {
            let hwnd = HWND(hwnd as _);
            let _ = list.SetProgressState(hwnd, flag);
            if let Some(v) = value { let _ = list.SetProgressValue(hwnd, v, 100); }
        });
    }

    /// Flashes the taskbar button until the window comes forward.
    pub fn flash(hwnd: isize) {
        let info = FLASHWINFO { cbSize: size_of::<FLASHWINFO>() as u32, hwnd: HWND(hwnd as _), dwFlags: FLASHW_TRAY | FLASHW_TIMERNOFG, uCount: 0, dwTimeout: 0 };
        unsafe { let _ = FlashWindowEx(&info); }
    }
}
#[cfg(windows)]
pub use win::*;
```

`shell.rs`:

```rust
#[cfg(windows)]
mod win {
    use windows::core::{w, HSTRING};
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::{IsIconic, SetForegroundWindow, ShowWindow, SW_RESTORE, SW_SHOWNORMAL};

    pub fn open_url(url: &str) {
        // The model already filtered; this is the last gate before the shell.
        if !tether_core::links::is_openable(url) { return; }
        unsafe { ShellExecuteW(None, w!("open"), &HSTRING::from(url), None, None, SW_SHOWNORMAL); }
    }

    pub fn bring_to_front(hwnd: isize) {
        let hwnd = HWND(hwnd as _);
        unsafe {
            if IsIconic(hwnd).as_bool() { let _ = ShowWindow(hwnd, SW_RESTORE); }
            let _ = SetForegroundWindow(hwnd);
        }
    }
}
#[cfg(windows)]
pub use win::*;
```

`aumid.rs` (Windows part):

```rust
#[cfg(windows)]
mod win {
    use super::*;
    use windows::core::{Interface, HSTRING, PCWSTR};
    use windows::Win32::Storage::EnhancedStorage::PKEY_AppUserModel_ID;
    use windows::Win32::Storage::Packaging::Appx::GetCurrentPackageFullName;
    use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
    use windows::Win32::System::Com::{CoCreateInstance, IPersistFile, CLSCTX_INPROC_SERVER};
    use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
    use windows::Win32::UI::Shell::{IShellLinkW, SetCurrentProcessExplicitAppUserModelID, ShellLink};

    pub fn is_packaged() -> bool {
        let mut len = 0u32;
        // ERROR_INSUFFICIENT_BUFFER means "there is a package"; APPMODEL_ERROR_NO_PACKAGE (15700) means none.
        unsafe { GetCurrentPackageFullName(&mut len, None).0 != 15700 }
    }

    /// Portable zip: give the process the AUMID and keep a Start-menu shortcut that carries it.
    pub fn register_portable() -> bool {
        unsafe {
            if SetCurrentProcessExplicitAppUserModelID(&HSTRING::from(AUMID)).is_err() { return false; }
            let Some(appdata) = std::env::var_os("APPDATA") else { return false };
            let lnk = std::path::Path::new(&appdata).join(r"Microsoft\Windows\Start Menu\Programs\Tether.lnk");
            let Ok(exe) = std::env::current_exe() else { return false };
            let made = (|| -> windows::core::Result<()> {
                let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
                link.SetPath(&HSTRING::from(exe.as_os_str()))?;
                let store: IPropertyStore = link.cast()?;
                store.SetValue(&PKEY_AppUserModel_ID, &PROPVARIANT::from(AUMID))?;
                store.Commit()?;
                link.cast::<IPersistFile>()?.Save(PCWSTR(HSTRING::from(lnk.as_os_str()).as_ptr()), true)
            })();
            made.is_ok()
        }
    }
}
#[cfg(windows)]
pub use win::*;
```

The shortcut is rewritten on every start, so a moved portable folder heals itself. That is the spec's "registers a Start menu shortcut with an AppUserModelID on first run", kept current.

`toast.rs` (Windows part):

```rust
#[cfg(windows)]
mod win {
    use super::*;
    use crate::win32::aumid::{ToastIdentity, AUMID};
    use std::collections::HashMap;
    use std::sync::Mutex;
    use windows::core::HSTRING;
    use windows::Data::Xml::Dom::XmlDocument;
    use windows::Foundation::TypedEventHandler;
    use windows::UI::Notifications::{ToastNotification, ToastNotificationManager, ToastNotifier};

    pub struct Toaster {
        notifier: ToastNotifier,
        // Each toast is kept alive so its Activated handler can still fire.
        live: Mutex<HashMap<String, ToastNotification>>,
    }

    impl Toaster {
        pub fn new(identity: ToastIdentity) -> Option<Self> {
            let notifier = match identity {
                ToastIdentity::Packaged => ToastNotificationManager::CreateToastNotifier(),
                ToastIdentity::Portable => ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(AUMID)),
            }.ok()?;
            Some(Self { notifier, live: Mutex::new(HashMap::new()) })
        }

        pub fn show(&self, session: &str, header: &str, body: &str) {
            let shown = (|| -> windows::core::Result<()> {
                let doc = XmlDocument::new()?;
                doc.LoadXml(&HSTRING::from(toast_xml(header, body, session)))?;
                let toast = ToastNotification::CreateToastNotification(&doc)?;
                toast.SetTag(&HSTRING::from(toast_tag(session)))?;
                toast.SetGroup(&HSTRING::from("tether"))?;
                let name = session.to_string();
                toast.Activated(&TypedEventHandler::new(move |_, _| {
                    // A WinRT thread: hop to the UI thread, where the current terminal lives.
                    let name = name.clone();
                    let _ = slint::invoke_from_event_loop(move || {
                        if let Some(s) = crate::terminal::glue::current() { s(crate::terminal::model::Msg::ToastClicked(name)); }
                    });
                    Ok(())
                }))?;
                self.notifier.Show(&toast)?;
                self.live.lock().unwrap().insert(session.to_string(), toast);
                Ok(())
            })();
            if let Err(e) = shown { tracing::debug!("toast failed: {e}"); }
        }
    }
}
#[cfg(windows)]
pub use win::*;
```

`platform.rs`:

```rust
use std::path::PathBuf;
use std::sync::OnceLock;
use slint::ComponentHandle;
use tether_core::osc::Progress;
use tether_core::paste::ClipboardSnapshot;

use crate::win32::{aumid, clipboard, file_dialog, shell, taskbar, toast, Platform};
use crate::AppWindow;

/// Every method except `read_clipboard` runs on the UI thread (`SlintUi` routes them there).
pub struct WindowsPlatform {
    window: slint::Weak<AppWindow>,
    toaster: OnceLock<Option<toast::Toaster>>,
}

impl WindowsPlatform {
    pub fn new(window: slint::Weak<AppWindow>) -> Self {
        Self { window, toaster: OnceLock::new() }
    }

    fn hwnd(&self) -> Option<isize> {
        crate::platform::hwnd_of(self.window.upgrade()?.window())
    }

    fn toaster(&self) -> Option<&toast::Toaster> {
        self.toaster.get_or_init(|| {
            let packaged = aumid::is_packaged();
            let shortcut = !packaged && aumid::register_portable();
            aumid::toast_identity(packaged, shortcut).and_then(toast::Toaster::new)
        }).as_ref()
    }

    /// Call once at startup so the AUMID is set before the first window shows.
    pub fn prepare_identity(&self) { let _ = self.toaster(); }
}

impl Platform for WindowsPlatform {
    fn flash_taskbar(&self) { if let Some(h) = self.hwnd() { taskbar::flash(h); } }
    fn set_progress(&self, p: Option<&Progress>) { if let Some(h) = self.hwnd() { taskbar::set_progress(h, p); } }
    fn toast(&self, session: &str, title: &str, body: &str) {
        if let Some(t) = self.toaster() { t.show(session, title, body); }
    }
    fn open_url(&self, url: &str) { shell::open_url(url); }
    fn set_clipboard(&self, text: &str) {
        // arboard (already an M5 dependency) owns the clipboard properly and retries a held one.
        if let Err(e) = arboard::Clipboard::new().and_then(|mut c| c.set_text(text.to_owned())) {
            tracing::debug!("copy failed: {e}");
        }
    }
    fn read_clipboard(&self) -> ClipboardSnapshot {
        crate::terminal::clip::snapshot(&clipboard::WinClipboard, &std::thread::sleep)
    }
    fn bring_to_front(&self) { if let Some(h) = self.hwnd() { shell::bring_to_front(h); } }
    fn pick_files(&self) -> Vec<PathBuf> {
        self.window.upgrade().map(|app| file_dialog::pick_files(app.window())).unwrap_or_default()
    }
}
```

`file_dialog::pick_files` arrives in Task 14. Until then, put `pub fn pick_files(_window: &slint::Window) -> Vec<std::path::PathBuf> { Vec::new() }` in `file_dialog.rs`.

`ui_port.rs`: in `SlintUi::apply`, move every platform call except `ReadClipboard` onto the UI thread. Replace the arms for `FlashTaskbar`, `Taskbar`, `Toast`, `OpenUrl`, `SetClipboard`, and `BringToFront` with a single arm:

```rust
            fx @ (UiEffect::FlashTaskbar | UiEffect::Taskbar(_) | UiEffect::Toast { .. } | UiEffect::OpenUrl(_)
                | UiEffect::SetClipboard(_) | UiEffect::BringToFront) => {
                let _ = slint::invoke_from_event_loop(move || match fx {
                    UiEffect::FlashTaskbar => platform.flash_taskbar(),
                    UiEffect::Taskbar(p) => platform.set_progress(p.as_ref()),
                    UiEffect::Toast { session, title, body } => platform.toast(&session, &title, &body),
                    UiEffect::OpenUrl(url) => platform.open_url(&url),
                    UiEffect::SetClipboard(text) => platform.set_clipboard(&text),
                    UiEffect::BringToFront => platform.bring_to_front(),
                    _ => {}
                });
            }
```

`main.rs`, on Windows:

```rust
#[cfg(windows)]
let platform: Arc<dyn win32::Platform> = {
    let p = Arc::new(win32::platform::WindowsPlatform::new(app.ui.as_weak()));
    p.prepare_identity();
    p
};
#[cfg(not(windows))]
let platform: Arc<dyn win32::Platform> = Arc::new(win32::NullPlatform);
```

Pass that `platform` to `terminal::glue::init` (Task 5). Add `tracing = "0.1"` to `tether-app`'s dependencies unless M5 already has it.

- [ ] **Step 7: Run the tests and the app**

Run: `cargo test -p tether-app` → PASS (12 events tests and 5 Win32-decision tests, plus everything before).
Run (on Windows): `cargo run -p tether-app --release`.

Manual check:
- [ ] `printf '\e]2;my title\a'` sets the window title to `devbox · <session> · my title`, and switching tabs shows each tab's own title.
- [ ] `printf '\e]52;c;aGVsbG8=\a'` puts `hello` on the Windows clipboard while the window is focused. Repeated after `sleep 3` with the window in the background, it puts nothing.
- [ ] Portable build, first run: `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Tether.lnk` exists. In a background tab, `printf '\e]9;build done\a'` shows a toast "devbox · <session>" / "build done". Clicking it brings the window forward on that tab.
- [ ] `printf '\e]777;notify;Claude;Needs you\a'` shows a two-line toast. A second one within 5 s replaces the pending one, and it arrives once the 5 s window passes.
- [ ] With Focus Assist on, toasts follow the Windows notification settings.
- [ ] `printf '\e]9;4;1;40\a'` draws an accent bar under the header and a 40 % green taskbar progress. State 2 is red, 3 indeterminate, and 4 yellow (paused). `printf '\e]9;4;0\a'` and a new prompt (OSC 133;A) clear it.
- [ ] A background tab's progress shows only as the bar under its tab label.
- [ ] `printf '\a'` flashes the header lamp once. In a background tab it puts a warning dot on the tab, and with the window unfocused the taskbar button flashes. No sound plays.
- [ ] Clipboard (Task 10): copy text in Notepad and press Ctrl+V, Ctrl+Shift+V, or Shift+Insert, or right-click. The text pastes, with newlines as Enter. Under `vim`'s bracketed paste, auto-indent does not cascade.
- [ ] Clipboard: Win+Shift+S a region, then Ctrl+V in Claude Code. `paste-<seconds>.png` uploads and Claude Code attaches it (this works fully after Task 14).
- [ ] Clipboard: copy two files in Explorer and paste. Both send as a drop (after Task 14).
- [ ] Clipboard: hold the clipboard open with a test tool (PowerShell: `Add-Type -AssemblyName System.Windows.Forms; [Windows.Forms.Clipboard]::SetDataObject('x', $true, 50, 200)` running in a loop), then paste. Nothing pastes and nothing hangs.

- [ ] **Step 8: Commit**

```bash
git add clients/windows/crates/tether-app
git commit -m "feat(windows): window title, OSC 52, toasts, and taskbar progress

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: System events: the Alt menu, sleep, lock, and network

**Files:**
- Replace: `clients/windows/crates/tether-app/src/win32/wndproc.rs`
- Create: `src/win32/network.rs` (pure decision plus a `#[cfg(windows)]` watcher; declare it unconditionally in `win32/mod.rs`)
- Modify: `src/terminal/glue.rs` (install both when the window exists; point the network watcher at the open machine)

**Interfaces:**
- Consumes: `Msg::{Resumed, Locked, Unlocked, Network}` (Task 6); `windows` 0.62 `Win32::UI::Shell::{SetWindowSubclass, DefSubclassProc}`, `Win32::System::RemoteDesktop::{WTSRegisterSessionNotification, NOTIFY_FOR_THIS_SESSION}`, `Networking::Connectivity::{NetworkInformation, NetworkConnectivityLevel, NetworkStatusChangedEventHandler}`, `Win32::NetworkManagement::IpHelper::GetBestInterfaceEx`, `Win32::Networking::WinSock::{SOCKADDR, SOCKADDR_IN, SOCKADDR_IN6}`.
- Produces:
  - `#[derive(Debug, Clone, Copy, PartialEq, Eq)] pub enum SystemEvent { SwallowKeyMenu, Resumed, Locked, Unlocked }`, `pub fn classify(msg: u32, wparam: usize) -> Option<SystemEvent>`, `pub fn to_msg(ev: SystemEvent) -> Option<Msg>`
  - `#[cfg(windows)] pub fn install(hwnd: isize)` (subclass plus session notifications)
  - `pub fn route_change(previous: Option<u32>, now: Option<u32>, online: bool) -> (bool, bool)`, which returns `(online, route_changed)`
  - `#[cfg(windows)] pub fn watch(host: String, port: u16)`, which replaces any earlier watch

The spec names `INetworkListManager` for connectivity events. This plan registers WinRT `NetworkInformation.NetworkStatusChanged` instead. It is the same Network List Manager service behind a delegate, which saves implementing a COM connection-point sink. The route comparison (`GetBestInterfaceEx` to the host) is what decides "the route to the host changed".

- [ ] **Step 1: Write the failing tests**

`wndproc.rs`:

```rust
use crate::terminal::model::Msg;

pub const WM_SYSCOMMAND: u32 = 0x0112;
pub const SC_KEYMENU: usize = 0xF100;
pub const WM_POWERBROADCAST: u32 = 0x0218;
pub const PBT_APMRESUMEAUTOMATIC: usize = 0x0012;
pub const WM_WTSSESSION_CHANGE: u32 = 0x02B1;
pub const WTS_SESSION_LOCK: usize = 0x7;
pub const WTS_SESSION_UNLOCK: usize = 0x8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SystemEvent { SwallowKeyMenu, Resumed, Locked, Unlocked }

pub fn classify(msg: u32, wparam: usize) -> Option<SystemEvent> {
    match msg {
        // A tapped Alt or F10 must reach the PTY, not open the system menu.
        WM_SYSCOMMAND if wparam & 0xFFF0 == SC_KEYMENU => Some(SystemEvent::SwallowKeyMenu),
        WM_POWERBROADCAST if wparam == PBT_APMRESUMEAUTOMATIC => Some(SystemEvent::Resumed),
        WM_WTSSESSION_CHANGE if wparam == WTS_SESSION_LOCK => Some(SystemEvent::Locked),
        WM_WTSSESSION_CHANGE if wparam == WTS_SESSION_UNLOCK => Some(SystemEvent::Unlocked),
        _ => None,
    }
}

pub fn to_msg(ev: SystemEvent) -> Option<Msg> {
    match ev {
        SystemEvent::SwallowKeyMenu => None,
        SystemEvent::Resumed => Some(Msg::Resumed),
        SystemEvent::Locked => Some(Msg::Locked),
        SystemEvent::Unlocked => Some(Msg::Unlocked),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keymenu_is_swallowed_whatever_its_low_bits() {
        assert_eq!(classify(WM_SYSCOMMAND, SC_KEYMENU), Some(SystemEvent::SwallowKeyMenu));
        assert_eq!(classify(WM_SYSCOMMAND, SC_KEYMENU | 0x2), Some(SystemEvent::SwallowKeyMenu));
        // SC_CLOSE (Alt+F4) and SC_MINIMIZE pass through.
        assert_eq!(classify(WM_SYSCOMMAND, 0xF060), None);
        assert_eq!(classify(WM_SYSCOMMAND, 0xF020), None);
    }

    #[test]
    fn resume_lock_and_unlock_become_messages() {
        assert!(matches!(classify(WM_POWERBROADCAST, PBT_APMRESUMEAUTOMATIC).and_then(to_msg), Some(Msg::Resumed)));
        assert!(matches!(classify(WM_WTSSESSION_CHANGE, WTS_SESSION_LOCK).and_then(to_msg), Some(Msg::Locked)));
        assert!(matches!(classify(WM_WTSSESSION_CHANGE, WTS_SESSION_UNLOCK).and_then(to_msg), Some(Msg::Unlocked)));
        // Suspend notices and other session changes (remote connect, logon) are not ours.
        assert_eq!(classify(WM_POWERBROADCAST, 0x0004), None);
        assert_eq!(classify(WM_WTSSESSION_CHANGE, 0x1), None);
    }
}
```

`network.rs`:

```rust
/// `(online, route_changed)`. The route is the interface index Windows would use for the host.
/// A change counts only when both sides are known and differ.
pub fn route_change(previous: Option<u32>, now: Option<u32>, online: bool) -> (bool, bool) {
    let changed = online && matches!((previous, now), (Some(a), Some(b)) if a != b);
    (online, changed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_different_known_interface_is_a_route_change() {
        assert_eq!(route_change(Some(5), Some(5), true), (true, false));
        assert_eq!(route_change(Some(5), Some(9), true), (true, true));
        assert_eq!(route_change(None, Some(9), true), (true, false));
        assert_eq!(route_change(Some(5), None, true), (true, false));
        assert_eq!(route_change(Some(5), Some(9), false), (false, false));
    }
}
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `cargo test -p tether-app win32::wndproc win32::network`
Expected: FAIL to compile. Module `network` is not declared yet, and Task 5 left `wndproc.rs` empty. The tests and the pure code land in the same step, so declare `pub mod network;` in `win32/mod.rs` and rerun. The run then shows 3 passing tests. The Win32 halves below are covered by the manual checks.

- [ ] **Step 3: Implement the subclass**

Append to `wndproc.rs`:

```rust
#[cfg(windows)]
mod win {
    use super::*;
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::RemoteDesktop::{WTSRegisterSessionNotification, NOTIFY_FOR_THIS_SESSION};
    use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};

    unsafe extern "system" fn subclass_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM, _id: usize, _data: usize) -> LRESULT {
        match classify(msg, wparam.0) {
            Some(SystemEvent::SwallowKeyMenu) => return LRESULT(0),
            Some(ev) => {
                if let Some(m) = to_msg(ev) {
                    // Already on the UI thread; post so the window procedure returns at once.
                    let _ = slint::invoke_from_event_loop(move || {
                        if let Some(s) = crate::terminal::glue::current() { s(m); }
                    });
                }
            }
            None => {}
        }
        unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
    }

    pub fn install(hwnd: isize) {
        let hwnd = HWND(hwnd as _);
        unsafe {
            let _ = SetWindowSubclass(hwnd, Some(subclass_proc), 0x7E7E, 0);
            let _ = WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION);
        }
    }
}
#[cfg(windows)]
pub use win::install;
```

`Msg` is not `Clone`, which is why `to_msg` builds a fresh one per event.

- [ ] **Step 4: Implement the network watcher**

Append to `network.rs`:

```rust
#[cfg(windows)]
mod win {
    use super::*;
    use std::net::{SocketAddr, ToSocketAddrs};
    use std::sync::Mutex;
    use windows::Networking::Connectivity::{NetworkConnectivityLevel, NetworkInformation, NetworkStatusChangedEventHandler};
    use windows::Win32::NetworkManagement::IpHelper::GetBestInterfaceEx;
    use windows::Win32::Networking::WinSock::{AF_INET, AF_INET6, IN6_ADDR, IN_ADDR, SOCKADDR, SOCKADDR_IN, SOCKADDR_IN6};

    struct Watch { host: String, port: u16, route: Option<u32> }
    static WATCH: Mutex<Option<Watch>> = Mutex::new(None);
    static REGISTERED: std::sync::Once = std::sync::Once::new();

    fn route_to(host: &str, port: u16) -> Option<u32> {
        let addr = (host, port).to_socket_addrs().ok()?.next()?;
        let mut index = 0u32;
        let rc = unsafe {
            match addr {
                SocketAddr::V4(a) => {
                    let sa = SOCKADDR_IN { sin_family: AF_INET, sin_port: a.port().to_be(), sin_addr: IN_ADDR { S_un: std::mem::transmute(u32::from_ne_bytes(a.ip().octets())) }, ..Default::default() };
                    GetBestInterfaceEx(&sa as *const _ as *const SOCKADDR, &mut index)
                }
                SocketAddr::V6(a) => {
                    let sa = SOCKADDR_IN6 { sin6_family: AF_INET6, sin6_port: a.port().to_be(), sin6_addr: IN6_ADDR { u: std::mem::transmute(a.ip().octets()) }, ..Default::default() };
                    GetBestInterfaceEx(&sa as *const _ as *const SOCKADDR, &mut index)
                }
            }
        };
        (rc == 0).then_some(index)
    }

    fn online() -> bool {
        NetworkInformation::GetInternetConnectionProfile()
            .and_then(|p| p.GetNetworkConnectivityLevel())
            .is_ok_and(|level| level != NetworkConnectivityLevel::None)
    }

    /// Points the watcher at the machine now open. DNS runs off the UI thread.
    pub fn watch(host: String, port: u16) {
        std::thread::spawn(move || {
            let route = route_to(&host, port);
            *WATCH.lock().unwrap() = Some(Watch { host, port, route });
        });
        REGISTERED.call_once(|| {
            let handler = NetworkStatusChangedEventHandler::new(|_| {
                // A WinRT thread: probing the route here is fine; deliver the result on the UI thread.
                let mut guard = WATCH.lock().unwrap();
                let Some(w) = guard.as_mut() else { return Ok(()) };
                let now = route_to(&w.host, w.port);
                let (online, route_changed) = route_change(w.route, now, online());
                if now.is_some() { w.route = now; }
                let _ = slint::invoke_from_event_loop(move || {
                    if let Some(s) = crate::terminal::glue::current() {
                        s(crate::terminal::model::Msg::Network { online, route_changed });
                    }
                });
                Ok(())
            });
            // The registration lives as long as the process: one window, one watcher.
            let _ = NetworkInformation::NetworkStatusChanged(&handler);
        });
    }
}
#[cfg(windows)]
pub use win::watch;
```

The `transmute` calls build the Win32 address unions from `std` octets. If `windows` 0.62 exposes `From<Ipv4Addr>` for `IN_ADDR`, use that instead and keep the rest.

- [ ] **Step 5: Wire them in**

`glue.rs`:
- In `glue::on_winit_event`'s `WindowEvent::Focused` arm, install the subclass the first time: `#[cfg(windows)] { static ONCE: std::sync::Once = std::sync::Once::new(); ONCE.call_once(|| if let Some(h) = crate::platform::hwnd_of(app.ui.window()) { crate::win32::wndproc::install(h); }); }`. The first focus event comes right after the window appears, before any key reaches it.
- In `open_machine`, after spawning the driver: `#[cfg(windows)] crate::win32::network::watch(machine.host.clone(), machine.port);`. Clone `machine` before passing it to `TerminalModel::new`.

Minimizing never reaches the model: winit's `Occluded` and minimize events are not forwarded, so a minimized window keeps every channel, as the spec requires.

- [ ] **Step 6: Run the tests and the app**

Run: `cargo test -p tether-app` → PASS.

Manual check on Windows:
- [ ] Tap Alt in the terminal: no system menu opens and the grid keeps focus. In `vim`, `:nmap <F10> :echo "f10"<CR>` then F10 echoes, and the menu bar never activates. Alt+Space sends `ESC SP` (`cat -v` shows `^[ `). Alt+F4 still closes the window.
- [ ] Lock with Win+L, wait 20 s, then check `ssh host '~/.local/bin/zmx ls'` from another machine: `clients=0` for every tab. Unlock: every tab re-attaches, the active one first, and its grid is live. A lock under 15 s detaches nothing.
- [ ] Minimize for 30 s: `zmx ls` still shows the clients attached.
- [ ] Sleep the PC (Start → Power → Sleep), then wake it: the header shows `reconnecting` and then `connected` within a couple of seconds, without waiting 30 s for keepalives.
- [ ] Switch from Wi-Fi to Ethernet (or toggle a VPN that routes the host): the client redials at once. Toggling an unrelated adapter does not drop the session.
- [ ] Pull the network for 10 s, then restore it: the header shows `reconnecting`, then `connected` as soon as the network is back. After three failed attempts it reads `disconnected` with **Reconnect** and **Back to Home**.

- [ ] **Step 7: Commit**

```bash
git add clients/windows/crates/tether-app/src
git commit -m "feat(windows): swallow the Alt menu; redial on resume and route change; lock detach

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Files and images: drop, Send file…, upload, paste back

**Files:**
- Replace: `clients/windows/crates/tether-app/src/terminal/files.rs`
- Modify: `src/terminal/model/send.rs` (queue, paste, capsule)
- Create: `src/win32/wic.rs`, `src/win32/file_dialog.rs` (replacing Task 12's stub)
- Modify: `src/main.rs` (install the WIC codec), `crates/tether-app/Cargo.toml` (dev-dependency `tempfile = "3"`)

**Interfaces:**
- Consumes: `tether_core::upload::{preflight, jpeg_name, remote_path, PendingFile, SendQueue, CAPSULE_LINGER, FOLDER_REFUSAL}`; `Remote::{uploads_dir, upload}` (Task 1); `SendSource`, `SendJob`, `SendState`, `start_send` (Task 10); `MsgSink` (Task 4); `windows` 0.62 `Win32::Graphics::Imaging::*`; and `rfd` 0.15 (`FileDialog::pick_files`, `set_parent`).
- Produces:
  - `pub trait ImageCodec: Send + Sync { fn to_jpeg(&self, bytes: &[u8]) -> Option<Vec<u8>>; }`, `pub fn set_codec(c: Arc<dyn ImageCodec>)`, and `pub struct NoCodec`
  - `pub fn plan(src: &SendSource) -> Result<String, (String, String)>`, the outgoing name, or the shown name with a reason, decided before any read
  - `pub fn prepare(src: SendSource, codec: &dyn ImageCodec) -> Result<(String, Vec<u8>), String>`
  - `pub async fn run_send<R: Remote>(remote: Arc<R>, job: SendJob, send: MsgSink)` and `pub async fn run_send_with<R: Remote>(remote: Arc<R>, job: SendJob, send: MsgSink, codec: Arc<dyn ImageCodec>)`
  - `#[cfg(windows)] pub struct WicCodec` and `#[cfg(windows)] pub fn pick_files(window: &slint::Window) -> Vec<PathBuf>` (rfd)
  - the finished `on_send_started`, `on_send_file_started`, `on_send_file_done`, `on_send_file_failed`, `send_capsule`

Size rule: a file sent as it is gets checked against 200 MB from its metadata, before it is read. A file that is re-encoded (HEIC, HEIF, AVIF, BMP, TIFF, JXR; M2's `REENCODE_EXTENSIONS`) is read and encoded first, and then checked at its encoded size. If WIC can't decode it, the file goes out unchanged under its own name, still checked against the limit.

- [ ] **Step 1: Write the failing file tests**

`files.rs`, tests:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::terminal::model::Msg;
    use crate::terminal::testkit::FakeRemote;
    use std::sync::Mutex;

    struct Jpeg(Option<Vec<u8>>);
    impl ImageCodec for Jpeg { fn to_jpeg(&self, _b: &[u8]) -> Option<Vec<u8>> { self.0.clone() } }

    fn file(dir: &tempfile::TempDir, name: &str, len: u64) -> PathBuf {
        let p = dir.path().join(name);
        std::fs::File::create(&p).unwrap().set_len(len).unwrap();
        p
    }

    #[test]
    fn plan_names_files_and_refuses_folders_and_oversize_before_reading() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(plan(&SendSource::Path(file(&dir, "a.png", 10))), Ok("a.png".into()));
        assert_eq!(plan(&SendSource::Path(file(&dir, "IMG.HEIC", 10))), Ok("IMG.jpg".into()));
        assert_eq!(plan(&SendSource::Path(dir.path().to_path_buf())).unwrap_err().1, tether_core::upload::FOLDER_REFUSAL);
        // Sparse: 214 MiB on paper, nothing on disk, never read.
        let big = file(&dir, "big.mov", 214 * 1024 * 1024);
        assert_eq!(plan(&SendSource::Path(big)).unwrap_err().1, "That's 214 MB — Tether sends up to 200 MB at a time.");
    }

    #[test]
    fn attachable_images_and_other_files_go_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("notes.txt");
        std::fs::write(&p, b"hi").unwrap();
        assert_eq!(prepare(SendSource::Path(p), &Jpeg(Some(vec![9]))), Ok(("notes.txt".into(), b"hi".to_vec())));
    }

    #[test]
    fn other_images_are_reencoded_and_undecodable_ones_go_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("shot.heic");
        std::fs::write(&p, b"heic").unwrap();
        assert_eq!(prepare(SendSource::Path(p.clone()), &Jpeg(Some(vec![1, 2]))), Ok(("shot.jpg".into(), vec![1, 2])));
        assert_eq!(prepare(SendSource::Path(p), &Jpeg(None)), Ok(("shot.heic".into(), b"heic".to_vec())));
    }

    #[test]
    fn the_limit_applies_after_reencoding() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("huge.tiff");
        std::fs::write(&p, b"tiff").unwrap();
        let encoded = vec![0u8; (tether_core::upload::BYTE_LIMIT + 1) as usize];
        assert!(prepare(SendSource::Path(p), &Jpeg(Some(encoded))).unwrap_err().starts_with("That's"));
    }

    fn recorder() -> (MsgSink, Arc<Mutex<Vec<String>>>) {
        let log = Arc::new(Mutex::new(Vec::new()));
        let l = log.clone();
        let sink: MsgSink = Arc::new(move |m: Msg| {
            let line = match m {
                Msg::SendStarted { names } => format!("started {}", names.join(",")),
                Msg::SendFileStarted { index } => format!("file {index}"),
                Msg::SendFileDone { remote } => format!("done {remote}"),
                Msg::SendFileFailed { reason } => format!("failed {reason}"),
                other => format!("{other:?}"),
            };
            l.lock().unwrap().push(line);
        });
        (sink, log)
    }

    #[tokio::test]
    async fn sends_in_order_one_upload_each_into_the_uploads_folder() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.png"); std::fs::write(&a, b"aa").unwrap();
        let b = dir.path().join("b.png"); std::fs::write(&b, b"bbb").unwrap();
        let remote = Arc::new(FakeRemote::default());
        let (sink, log) = recorder();
        let job = SendJob { sources: vec![SendSource::Path(a), SendSource::Path(b)], fallback_dir: Some("/srv/proj".into()) };
        run_send_with(remote.clone(), job, sink, Arc::new(NoCodec)).await;
        assert_eq!(*log.lock().unwrap(), [
            "started a.png,b.png", "file 0", "done /home/sam/.tether/uploads/a.png",
            "file 1", "done /home/sam/.tether/uploads/b.png",
        ]);
        let uploads: Vec<_> = remote.log().into_iter().filter(|l| l.starts_with("upload")).collect();
        assert_eq!(uploads, ["upload /home/sam/.tether/uploads/a.png 2", "upload /home/sam/.tether/uploads/b.png 3"]);
    }

    #[tokio::test]
    async fn without_an_uploads_folder_the_session_directory_is_used() {
        let remote = Arc::new(FakeRemote::default());
        *remote.uploads_dir.lock().unwrap() = None;
        let (sink, log) = recorder();
        let job = SendJob { sources: vec![SendSource::Bytes { name: "paste-1.png".into(), data: vec![1] }], fallback_dir: Some("/srv/proj".into()) };
        run_send_with(remote, job, sink, Arc::new(NoCodec)).await;
        assert!(log.lock().unwrap().contains(&"done /srv/proj/paste-1.png".to_string()));
    }

    #[tokio::test]
    async fn a_failure_stops_the_queue() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.png"); std::fs::write(&a, b"a").unwrap();
        let b = dir.path().join("b.png"); std::fs::write(&b, b"b").unwrap();
        let c = dir.path().join("c.png"); std::fs::write(&c, b"c").unwrap();
        let remote = Arc::new(FakeRemote::default());
        remote.upload_results.lock().unwrap().extend([Ok(()), Err(tether_core::connect::ConnectError::Transport("scp: disk full".into()))]);
        let (sink, log) = recorder();
        let job = SendJob { sources: vec![SendSource::Path(a), SendSource::Path(b), SendSource::Path(c)], fallback_dir: None };
        run_send_with(remote.clone(), job, sink, Arc::new(NoCodec)).await;
        let log = log.lock().unwrap().clone();
        assert_eq!(log.last().unwrap(), &format!("failed {}", tether_core::connect::ConnectError::Transport("scp: disk full".into()).sentence()));
        assert_eq!(remote.log().iter().filter(|l| l.starts_with("upload")).count(), 2);
    }

    #[tokio::test]
    async fn a_folder_in_the_batch_stops_the_queue_there() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.png"); std::fs::write(&a, b"a").unwrap();
        let sub = dir.path().join("photos"); std::fs::create_dir(&sub).unwrap();
        let remote = Arc::new(FakeRemote::default());
        let (sink, log) = recorder();
        let job = SendJob { sources: vec![SendSource::Path(a), SendSource::Path(sub)], fallback_dir: None };
        run_send_with(remote, job, sink, Arc::new(NoCodec)).await;
        assert_eq!(*log.lock().unwrap(), [
            "started a.png,photos", "file 0", "done /home/sam/.tether/uploads/a.png",
            "file 1", "failed Tether sends files, not folders.",
        ]);
    }
}
```

- [ ] **Step 2: Write the failing model send tests**

Append to `send.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::super::tests::{live, t};
    use super::*;
    use crate::terminal::testkit::session;
    use std::path::PathBuf;

    const UP: &str = "/home/sam/.tether/uploads";

    fn writes(fx: &[Effect]) -> Vec<(String, Vec<u8>)> {
        fx.iter().filter_map(|e| match e { Effect::Write { name, bytes } => Some((name.clone(), bytes.clone())), _ => None }).collect()
    }

    fn sending(names: &[&str]) -> TerminalModel {
        let mut m = live(vec![session("a", 1), session("b", 2)]);
        m.handle(Msg::SelectTab("a".into()), t(1));
        m.handle(Msg::Attached { name: "a".into() }, t(1));
        m.handle(Msg::Attached { name: "b".into() }, t(1));
        let fx = m.handle(Msg::SendFiles(names.iter().map(PathBuf::from).collect()), t(2));
        assert!(fx.iter().any(|e| matches!(e, Effect::StartSend(_))));
        m.handle(Msg::SendStarted { names: names.iter().map(|s| s.to_string()).collect() }, t(3));
        m
    }

    #[test]
    fn each_file_is_its_own_paste_with_a_space_before_all_but_the_first() {
        let mut m = sending(&["a.png", "b.png"]);
        assert_eq!(m.view().capsule, Some(CapsuleView::Send("Sending a.png (1/2)".into())));
        let fx = m.handle(Msg::SendFileDone { remote: format!("{UP}/a.png") }, t(10));
        assert_eq!(writes(&fx), vec![("a".into(), format!("'{UP}/a.png'").into_bytes())]);
        assert_eq!(m.view().capsule, Some(CapsuleView::Send("Sending b.png (2/2)".into())));
        let fx = m.handle(Msg::SendFileDone { remote: format!("{UP}/b.png") }, t(20));
        assert_eq!(writes(&fx), vec![("a".into(), format!(" '{UP}/b.png'").into_bytes())]);
        assert_eq!(m.view().capsule, Some(CapsuleView::Send("Sent ~/.tether/uploads/b.png".into())));
    }

    #[test]
    fn pastes_are_bracketed_when_the_program_asked() {
        let mut m = sending(&["a.png"]);
        m.handle(Msg::PtyData { name: "a".into(), bytes: b"\x1b[?2004h".to_vec() }, t(5));
        let fx = m.handle(Msg::SendFileDone { remote: format!("{UP}/a.png") }, t(10));
        assert_eq!(writes(&fx)[0].1, format!("\x1b[200~'{UP}/a.png'\x1b[201~").into_bytes());
    }

    #[test]
    fn pastes_go_to_the_tab_active_when_the_send_began() {
        let mut m = sending(&["a.png"]);
        m.handle(Msg::SelectTab("b".into()), t(5));
        let fx = m.handle(Msg::SendFileDone { remote: format!("{UP}/a.png") }, t(10));
        assert_eq!(writes(&fx)[0].0, "a");
    }

    #[test]
    fn a_failure_names_the_file_and_keeps_earlier_pastes() {
        let mut m = sending(&["a.png", "b.png"]);
        m.handle(Msg::SendFileDone { remote: format!("{UP}/a.png") }, t(10));
        let fx = m.handle(Msg::SendFileFailed { reason: "Could not connect: reset".into() }, t(20));
        assert!(writes(&fx).is_empty());
        assert_eq!(m.view().capsule, Some(CapsuleView::Send("Couldn't send b.png: Could not connect: reset".into())));
    }

    #[test]
    fn the_capsule_leaves_after_four_seconds_or_on_a_keystroke() {
        let mut m = sending(&["a.png"]);
        m.handle(Msg::SendFileDone { remote: format!("{UP}/a.png") }, t(1_000));
        m.handle(Msg::Tick, t(4_900));
        assert!(m.view().capsule.is_some());
        m.handle(Msg::Tick, t(5_100));
        assert_eq!(m.view().capsule, None);

        let mut m = sending(&["a.png"]);
        m.handle(Msg::SendFileDone { remote: format!("{UP}/a.png") }, t(1_000));
        let key = tether_core::keymap::KeyInput::Char { unmodified: 'x', produced: Some("x".into()), digit: None };
        m.handle(Msg::Key { input: key, mods: Default::default() }, t(1_100));
        assert_eq!(m.view().capsule, None);
    }

    #[test]
    fn a_keystroke_does_not_hide_an_in_flight_capsule() {
        let mut m = sending(&["a.png", "b.png"]);
        let key = tether_core::keymap::KeyInput::Char { unmodified: 'x', produced: Some("x".into()), digit: None };
        m.handle(Msg::Key { input: key, mods: Default::default() }, t(10));
        assert_eq!(m.view().capsule, Some(CapsuleView::Send("Sending a.png (1/2)".into())));
    }

    #[test]
    fn a_second_send_while_one_runs_is_ignored() {
        let mut m = sending(&["a.png"]);
        assert!(!m.handle(Msg::SendFiles(vec![PathBuf::from("c.png")]), t(10)).iter().any(|e| matches!(e, Effect::StartSend(_))));
    }

    #[test]
    fn drop_mid_send_stops_queue_and_keeps_target() {
        let mut m = sending(&["a.png", "b.png"]);
        assert_eq!(writes(&m.handle(Msg::SendFileDone { remote: format!("{UP}/a.png") }, t(10)))[0].0, "a");
        m.handle(Msg::Dropped, t(20));
        let fx = m.handle(Msg::SendFileFailed { reason: "Could not connect: broken pipe".into() }, t(30));
        assert!(writes(&fx).is_empty());
        assert_eq!(m.view().capsule, Some(CapsuleView::Send("Couldn't send b.png: Could not connect: broken pipe".into())));
        let fx = m.handle(Msg::Opened, t(1_200));
        assert!(writes(&fx).is_empty());
        let fx = m.handle(Msg::Key { input: tether_core::keymap::KeyInput::Char { unmodified: 'x', produced: Some("x".into()), digit: None }, mods: Default::default() }, t(1_210));
        assert!(writes(&fx).is_empty(), "input stays dropped until the channel is live again");
    }
}
```

`drop_mid_send_stops_queue_and_keeps_target` depends on `Msg::Opened` re-creating channels in `Opening` state. Until `Attached` arrives, `is_live` is false, so the keystroke is dropped.

- [ ] **Step 3: Run the tests and watch them fail**

Run: `cargo test -p tether-app terminal::files terminal::model::send`
Expected: FAIL to compile (`plan`, `prepare`, `run_send_with`, `NoCodec` not found).

- [ ] **Step 4: Implement `files.rs`**

```rust
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use tether_core::upload::{jpeg_name, preflight, remote_path};

use crate::terminal::driver::MsgSink;
use crate::terminal::model::send::{SendJob, SendSource};
use crate::terminal::model::Msg;
use crate::terminal::remote::Remote;

pub trait ImageCodec: Send + Sync {
    /// JPEG at quality 0.9, or None when the image cannot be decoded.
    fn to_jpeg(&self, bytes: &[u8]) -> Option<Vec<u8>>;
}

pub struct NoCodec;
impl ImageCodec for NoCodec { fn to_jpeg(&self, _bytes: &[u8]) -> Option<Vec<u8>> { None } }

static CODEC: OnceLock<Arc<dyn ImageCodec>> = OnceLock::new();

pub fn set_codec(c: Arc<dyn ImageCodec>) { let _ = CODEC.set(c); }

fn codec() -> Arc<dyn ImageCodec> { CODEC.get().cloned().unwrap_or_else(|| Arc::new(NoCodec)) }

fn file_name(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| p.display().to_string())
}

/// Decided from metadata alone: nothing is read here.
pub fn plan(src: &SendSource) -> Result<String, (String, String)> {
    match src {
        SendSource::Bytes { name, data } => preflight(false, data.len() as u64).map(|_| name.clone()).map_err(|r| (name.clone(), r)),
        SendSource::Path(p) => {
            let name = file_name(p);
            let meta = std::fs::metadata(p).map_err(|e| (name.clone(), e.to_string()))?;
            if meta.is_dir() { return preflight(true, 0).map(|_| name.clone()).map_err(|r| (name, r)); }
            match jpeg_name(&name) {
                // Re-encoded files are checked at their encoded size, in `prepare`.
                Some(jpg) => Ok(jpg),
                None => preflight(false, meta.len()).map(|_| name.clone()).map_err(|r| (name, r)),
            }
        }
    }
}

pub fn prepare(src: SendSource, codec: &dyn ImageCodec) -> Result<(String, Vec<u8>), String> {
    let (name, data) = match src {
        SendSource::Bytes { name, data } => (name, data),
        SendSource::Path(p) => (file_name(&p), std::fs::read(&p).map_err(|e| e.to_string())?),
    };
    let (name, data) = match jpeg_name(&name) {
        Some(jpg) => match codec.to_jpeg(&data) {
            Some(jpeg) => (jpg, jpeg),
            None => (name, data),
        },
        None => (name, data),
    };
    preflight(false, data.len() as u64)?;
    Ok((name, data))
}

pub async fn run_send<R: Remote>(remote: Arc<R>, job: SendJob, send: MsgSink) {
    run_send_with(remote, job, send, codec()).await
}

pub async fn run_send_with<R: Remote>(remote: Arc<R>, job: SendJob, send: MsgSink, codec: Arc<dyn ImageCodec>) {
    let mut plans = Vec::new();
    for src in &job.sources {
        let p = plan(src);
        let stop = p.is_err();
        plans.push(p);
        if stop { break; }
    }
    let names = plans.iter().map(|p| match p { Ok(n) => n.clone(), Err((n, _)) => n.clone() }).collect();
    send(Msg::SendStarted { names });
    // Resolved once per send, on the control connection.
    let dir = remote.uploads_dir().await.or(job.fallback_dir.clone());
    for (index, (src, planned)) in job.sources.into_iter().zip(plans).enumerate() {
        send(Msg::SendFileStarted { index });
        if let Err((_, reason)) = planned { return send(Msg::SendFileFailed { reason }); }
        let codec = codec.clone();
        let prepared = tokio::task::spawn_blocking(move || prepare(src, codec.as_ref())).await
            .unwrap_or_else(|e| Err(e.to_string()));
        let (name, data) = match prepared {
            Ok(p) => p,
            Err(reason) => return send(Msg::SendFileFailed { reason }),
        };
        let target = remote_path(dir.as_deref(), &name);
        match remote.upload(&target, data).await {
            Ok(()) => send(Msg::SendFileDone { remote: target }),
            Err(e) => return send(Msg::SendFileFailed { reason: e.sentence() }),
        }
    }
}
```

Make `model::send` public to the crate: in `model/mod.rs`, write `pub(crate) mod send;`. A file that `prepare` sends unchanged after a failed decode keeps its original name. The capsule showed the `.jpg` name while it was being prepared, and the `Sent` line shows the real remote path.

- [ ] **Step 5: Implement the model side**

`send.rs`, completing the stubs:

```rust
use tether_core::upload::PendingFile;

impl TerminalModel {
    pub(crate) fn on_send_started(&mut self, names: Vec<String>) {
        let Some(state) = self.send.as_mut() else { return };
        // The driver owns the bytes; the queue only orders, labels, and builds the pastes.
        let files = names.into_iter().map(|name| PendingFile { local: PathBuf::new(), name }).collect();
        state.queue = Some(SendQueue::new(files, state.target.clone()));
    }

    pub(crate) fn on_send_file_started(&mut self, _index: usize) {}

    pub(crate) fn on_send_file_done(&mut self, remote: &str, now: Duration, fx: &mut Vec<Effect>) {
        let Some(state) = self.send.as_mut() else { return };
        let target = state.target.clone();
        let bracketed = self.tabs.get(&target).is_some_and(|t| t.term.bracketed_paste());
        let Some(queue) = state.queue.as_mut() else { return };
        let bytes = queue.on_sent(remote, bracketed);
        let finished = queue.is_finished();
        // A paste, never keystrokes: that is what makes a TUI attach the image.
        if self.is_live(&target) { fx.push(Effect::Write { name: target, bytes }); }
        if finished { self.capsule_shown = Some(now); }
    }

    pub(crate) fn on_send_file_failed(&mut self, reason: String, now: Duration) {
        let Some(queue) = self.send.as_mut().and_then(|s| s.queue.as_mut()) else { return };
        queue.on_failed(&reason);
        self.capsule_shown = Some(now);
    }

    pub(crate) fn send_capsule(&self) -> Option<String> {
        self.send.as_ref()?.queue.as_ref()?.capsule()
    }
}
```

- [ ] **Step 6: Implement WIC and the file picker**

`win32/wic.rs`:

```rust
use windows::core::GUID;
use windows::Win32::Graphics::Imaging::*;
use windows::Win32::System::Com::StructuredStorage::{IPropertyBag2, PROPBAG2};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, IStream, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, STATFLAG_NONAME, STREAM_SEEK_SET};
use windows::Win32::System::Variant::VARIANT;
use windows::Win32::UI::Shell::SHCreateMemStream;

use crate::terminal::files::ImageCodec;

/// HEIC needs the Windows HEIF extension; without it, decoding fails and the file goes unchanged.
pub struct WicCodec;

impl ImageCodec for WicCodec {
    fn to_jpeg(&self, bytes: &[u8]) -> Option<Vec<u8>> {
        unsafe {
            // Runs on a blocking-pool thread; COM must be initialised there.
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let factory: IWICImagingFactory = CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER).ok()?;
            let input = SHCreateMemStream(Some(bytes))?;
            let decoder = factory.CreateDecoderFromStream(&input, std::ptr::null(), WICDecodeMetadataCacheOnDemand).ok()?;
            let frame = decoder.GetFrame(0).ok()?;
            let bgr = WICConvertBitmapSource(&GUID_WICPixelFormat24bppBGR, &frame).ok()?;
            let (mut w, mut h) = (0, 0);
            bgr.GetSize(&mut w, &mut h).ok()?;

            let output: IStream = SHCreateMemStream(None)?;
            let encoder = factory.CreateEncoder(&GUID_ContainerFormatJpeg, std::ptr::null()).ok()?;
            encoder.Initialize(&output, WICBitmapEncoderNoCache).ok()?;
            let mut out_frame = None;
            let mut props: Option<IPropertyBag2> = None;
            encoder.CreateNewFrame(&mut out_frame, &mut props).ok()?;
            let out_frame = out_frame?;
            if let Some(props) = props.as_ref() {
                let mut name: Vec<u16> = "ImageQuality".encode_utf16().chain([0]).collect();
                let bag = PROPBAG2 { pstrName: windows::core::PWSTR(name.as_mut_ptr()), ..Default::default() };
                let quality = VARIANT::from(0.9f32);
                let _ = props.Write(1, &bag, &quality);
            }
            out_frame.Initialize(props.as_ref()).ok()?;
            out_frame.SetSize(w, h).ok()?;
            let mut format: GUID = GUID_WICPixelFormat24bppBGR;
            out_frame.SetPixelFormat(&mut format).ok()?;
            out_frame.WriteSource(&bgr, std::ptr::null()).ok()?;
            out_frame.Commit().ok()?;
            encoder.Commit().ok()?;

            let mut stat = Default::default();
            output.Stat(&mut stat, STATFLAG_NONAME).ok()?;
            output.Seek(0, STREAM_SEEK_SET, None).ok()?;
            let mut jpeg = vec![0u8; stat.cbSize as usize];
            let mut read = 0u32;
            output.Read(jpeg.as_mut_ptr().cast(), jpeg.len() as u32, Some(&mut read)).ok().ok()?;
            jpeg.truncate(read as usize);
            Some(jpeg)
        }
    }
}
```

`win32/file_dialog.rs`:

```rust
use std::path::PathBuf;
use slint::winit_030::WinitWindowAccessor;

/// rfd drives the system `IFileOpenDialog` (multi-select). It is modal to the window.
pub fn pick_files(window: &slint::Window) -> Vec<PathBuf> {
    let dialog = rfd::FileDialog::new().set_title("Send file");
    let dialog = window.with_winit_window(|w| dialog.clone().set_parent(w)).unwrap_or(dialog);
    dialog.pick_files().unwrap_or_default()
}
```

The WIC calls follow `windows` 0.62's projections. If one doesn't compile, for example because `SHCreateMemStream` returns `Option<IStream>` or `CreateNewFrame` takes its out-parameters in a different form, check it in `cargo doc -p windows` and adjust only the binding. Keep the steps: decode frame 0, convert to 24bpp BGR, then a JPEG encoder at `ImageQuality` 0.9. Add `"Win32_UI_Shell_Common"`, `"Win32_System_Com_StructuredStorage"`, and `"Win32_System_Variant"` to the `windows` features if the build asks for them.

In `main.rs`, on Windows: `terminal::files::set_codec(std::sync::Arc::new(win32::wic::WicCodec));`. Add `tempfile = "3"` to `[dev-dependencies]`.

- [ ] **Step 7: Run the tests and the app**

Run: `cargo test -p tether-app` → PASS: 8 file tests and 8 send tests, plus everything before.

Manual check on Windows with Claude Code running in the active tab:
- [ ] Drag three PNGs from Explorer onto the grid. The capsule reads `Sending a.png (1/3)` and so on, then `Sent ~/.tether/uploads/c.png`. Claude Code shows three image attachments on one line. `ls ~/.tether/uploads` on the host has the three files.
- [ ] **Send file…** opens the system picker with multi-select, and choosing files sends them the same way.
- [ ] Win+Shift+S a region, then Ctrl+V: `paste-<seconds>.png` uploads and Claude Code attaches it. A browser "Copy image" does the same.
- [ ] A HEIC from a phone arrives as `.jpg` when the HEIF extension is installed. Without the extension it arrives as `.heic`, unchanged, and its path is still pasted.
- [ ] A BMP and a TIFF arrive as `.jpg`. A `.txt` and a `.zip` arrive untouched.
- [ ] A 214 MB file is refused at once with "That's 214 MB — Tether sends up to 200 MB at a time.", and nothing is read.
- [ ] Dropping a folder shows "Tether sends files, not folders."
- [ ] Switch tabs while a large send is running: the paths still paste into the tab that was active when the send began.
- [ ] Sending a 150 MB file doesn't freeze typing in the other tabs: the upload runs on its own SSH connection.
- [ ] The capsule leaves 4 s after the send finishes, or at the next keystroke.

- [ ] **Step 8: Commit**

```bash
git add clients/windows/crates/tether-app
git commit -m "feat(windows): send files and images by drop, picker, or paste; paste their paths back

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Packaging: portable zip, MSIX layout, CI artifacts

**Files:**
- Create: `clients/windows/packaging/AppxManifest.xml`, `clients/windows/packaging/package.ps1`, `clients/windows/packaging/check-package.ps1`
- Modify: `.github/workflows/ci.yml` (M1's `windows` job: package, check, upload)
- Modify: `.gitignore` (`clients/windows/dist/`)

**Interfaces:**
- Consumes: the release build of `tether-app` (exe `target/release/tether-app.exe`), M5's `build.rs` license copy (`target/release/licenses/{TerminalThemes-LICENSE.txt, Fonts-LICENSES.md, CascadiaCode-LICENSE.txt}`), the repo `LICENSE` (GPLv3), the iOS icon `clients/apple/TetherIOS/Assets.xcassets/AppIcon.appiconset/icon-1024.png`, and `aumid::AUMID` (`Tether.Terminal`, Task 12).
- Produces: `dist/Tether-<version>-x64-portable.zip`, `dist/Tether-<version>-x64.msix` (unsigned), and `dist/msix/` (the layout, registrable for local testing). `check-package.ps1` fails on any missing piece.

Signing is out of scope here. The spec leaves the signing identity and SmartScreen reputation to the release slice, so the MSIX built here is unsigned and its `Publisher` is a placeholder (`CN=Tether Development`). The release slice replaces the placeholder with the real certificate subject and runs `signtool`. An unsigned MSIX doesn't install by double-click. It is tested with `Add-AppxPackage -Register dist\msix\AppxManifest.xml` in Developer Mode.

- [ ] **Step 1: Write the failing package check**

`clients/windows/packaging/check-package.ps1`:

```powershell
param([Parameter(Mandatory)][string]$Version)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$dist = Join-Path $root 'dist'
$failures = @()

$zip = Join-Path $dist "Tether-$Version-x64-portable.zip"
if (-not (Test-Path $zip)) { $failures += "missing $zip" } else {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $entries = [IO.Compression.ZipFile]::OpenRead($zip).Entries.FullName -replace '\\', '/'
    foreach ($want in 'Tether/Tether.exe', 'Tether/LICENSE.txt', 'Tether/licenses/TerminalThemes-LICENSE.txt',
                      'Tether/licenses/Fonts-LICENSES.md', 'Tether/licenses/CascadiaCode-LICENSE.txt') {
        if ($entries -notcontains $want) { $failures += "zip lacks $want" }
    }
}

$manifest = Join-Path $dist 'msix/AppxManifest.xml'
if (-not (Test-Path $manifest)) { $failures += "missing $manifest" } else {
    [xml]$x = Get-Content $manifest -Raw
    $ns = @{ m = 'http://schemas.microsoft.com/appx/manifest/foundation/windows10' }
    $identity = (Select-Xml -Xml $x -XPath '/m:Package/m:Identity' -Namespace $ns).Node
    $msixVersion = if ($Version -match '^\d+\.\d+\.\d+$') { "$Version.0" } else { $Version }
    if ($identity.Version -ne $msixVersion) { $failures += "manifest version $($identity.Version), expected $msixVersion" }
    if ($identity.ProcessorArchitecture -ne 'x64') { $failures += 'manifest is not x64' }
    $min = (Select-Xml -Xml $x -XPath '//m:TargetDeviceFamily' -Namespace $ns).Node.MinVersion
    if ($min -ne '10.0.19045.0') { $failures += "MinVersion $min, expected 10.0.19045.0 (Windows 10 22H2)" }
    foreach ($logo in 'Square44x44Logo.png', 'Square150x150Logo.png', 'StoreLogo.png', 'Tether.exe') {
        if (-not (Test-Path (Join-Path $dist "msix/$logo"))) { $failures += "msix layout lacks $logo" }
    }
}
if (-not (Get-ChildItem $dist -Filter "Tether-$Version-x64.msix" -ErrorAction SilentlyContinue)) {
    $failures += "missing Tether-$Version-x64.msix"
}

if ($failures) { $failures | ForEach-Object { Write-Error $_ -ErrorAction Continue }; exit 1 }
Write-Host "package OK: $Version"
```

Run (from `clients/windows`): `pwsh packaging/check-package.ps1 -Version 0.0.1`
Expected: FAIL, ending in `missing …Tether-0.0.1-x64-portable.zip`, with exit code 1.

- [ ] **Step 2: Write the manifest**

`clients/windows/packaging/AppxManifest.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<Package
  xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
  IgnorableNamespaces="uap rescap">
  <!-- Publisher is a placeholder: the release slice sets the signing certificate's subject. -->
  <Identity Name="Tether.Terminal" Publisher="CN=Tether Development" Version="$VERSION$" ProcessorArchitecture="x64" />
  <Properties>
    <DisplayName>Tether</DisplayName>
    <PublisherDisplayName>Tether</PublisherDisplayName>
    <Logo>StoreLogo.png</Logo>
  </Properties>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.19045.0" MaxVersionTested="10.0.26200.0" />
  </Dependencies>
  <Resources>
    <Resource Language="en-us" />
  </Resources>
  <Applications>
    <Application Id="Tether" Executable="Tether.exe" EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements DisplayName="Tether" Description="SSH to zmx sessions on your own hosts"
        BackgroundColor="transparent" Square150x150Logo="Square150x150Logo.png" Square44x44Logo="Square44x44Logo.png" />
    </Application>
  </Applications>
  <Capabilities>
    <rescap:Capability Name="runFullTrust" />
  </Capabilities>
</Package>
```

An MSIX installs per user and needs no admin. The packaged app gets its toast identity from the package (`ToastIdentity::Packaged`, Task 12), so no shortcut is written.

- [ ] **Step 3: Write the packaging script**

`clients/windows/packaging/package.ps1`:

```powershell
param(
    [string]$Version = (Select-String -Path "$PSScriptRoot/../crates/tether-app/Cargo.toml" -Pattern '^version\s*=\s*"(.+)"').Matches[0].Groups[1].Value,
    [switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$repo = Split-Path (Split-Path $root -Parent) -Parent
$dist = Join-Path $root 'dist'
$release = Join-Path $root 'target/release'

if (-not $SkipBuild) {
    Push-Location $root
    cargo build --release -p tether-app
    if ($LASTEXITCODE) { throw 'cargo build failed' }
    Pop-Location
}
Remove-Item $dist -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $dist | Out-Null

# Portable zip: one folder, the exe, the app's GPLv3 license, and every bundled-asset license.
$portable = Join-Path $dist 'Tether'
New-Item -ItemType Directory -Force "$portable/licenses" | Out-Null
Copy-Item "$release/tether-app.exe" "$portable/Tether.exe"
Copy-Item "$repo/LICENSE" "$portable/LICENSE.txt"
Copy-Item "$release/licenses/*" "$portable/licenses/"
Compress-Archive -Path $portable -DestinationPath (Join-Path $dist "Tether-$Version-x64-portable.zip")

# MSIX layout: exe, licenses, logos scaled from the iOS icon, manifest with the version.
$msix = Join-Path $dist 'msix'
Copy-Item $portable $msix -Recurse
Add-Type -AssemblyName System.Drawing
$icon = [System.Drawing.Image]::FromFile("$repo/clients/apple/TetherIOS/Assets.xcassets/AppIcon.appiconset/icon-1024.png")
foreach ($logo in @{ 'Square44x44Logo.png' = 44; 'Square150x150Logo.png' = 150; 'StoreLogo.png' = 50 }.GetEnumerator()) {
    $bmp = New-Object System.Drawing.Bitmap $logo.Value, $logo.Value
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.DrawImage($icon, 0, 0, $logo.Value, $logo.Value)
    $bmp.Save((Join-Path $msix $logo.Key), [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
}
$icon.Dispose()
$msixVersion = if ($Version -match '^\d+\.\d+\.\d+$') { "$Version.0" } else { $Version }
(Get-Content "$PSScriptRoot/AppxManifest.xml" -Raw).Replace('$VERSION$', $msixVersion) | Set-Content "$msix/AppxManifest.xml" -Encoding utf8

$makeappx = Get-ChildItem 'C:/Program Files (x86)/Windows Kits/10/bin/*/x64/makeappx.exe' -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending | Select-Object -First 1
if (-not $makeappx) { throw 'makeappx.exe not found: install the Windows 10/11 SDK' }
& $makeappx.FullName pack /d $msix /p (Join-Path $dist "Tether-$Version-x64.msix") /o
if ($LASTEXITCODE) { throw 'makeappx failed' }
Write-Host "dist: $dist"
```

Add `clients/windows/dist/` to the repo `.gitignore`.

- [ ] **Step 4: Run the package and the check**

Run (from `clients/windows`, on Windows): `pwsh packaging/package.ps1 -Version 0.0.1`, then `pwsh packaging/check-package.ps1 -Version 0.0.1`
Expected: `package OK: 0.0.1`, with exit code 0.

Manual check:
- [ ] Unzip `Tether-0.0.1-x64-portable.zip` into a folder that has no write access to the repo, and run `Tether\Tether.exe`. Home opens, `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Tether.lnk` appears, and a background-tab `printf '\e]9;hi\a'` shows a toast.
- [ ] In Developer Mode: `Add-AppxPackage -Register dist\msix\AppxManifest.xml`. "Tether" appears in Start, opens, toasts work, and no `Tether.lnk` is written. `Remove-AppxPackage Tether.Terminal_0.0.1.0_x64__<hash>` removes it.

- [ ] **Step 5: Package in CI**

In `.github/workflows/ci.yml`, append to M1's `windows` job, after its "Release build of the app" step. The job's `working-directory` is already `clients/windows`.

```yaml
      - name: Package (portable zip + unsigned MSIX)
        shell: pwsh
        run: ./packaging/package.ps1 -Version 0.0.${{ github.run_number }} -SkipBuild

      - name: Check the package
        shell: pwsh
        run: ./packaging/check-package.ps1 -Version 0.0.${{ github.run_number }}

      - uses: actions/upload-artifact@v4
        with:
          name: tether-windows-${{ github.run_number }}
          path: |
            clients/windows/dist/Tether-*-x64-portable.zip
            clients/windows/dist/Tether-*-x64.msix
          if-no-files-found: error
```

`windows-latest` runners ship the Windows 11 SDK, which provides `makeappx.exe`, and PowerShell 7, which provides `System.Drawing` on Windows.

- [ ] **Step 6: Run the whole suite one last time**

Run (from `clients/windows`): `cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace`
Expected: all clean. Every M6 test passes, and the Linux job (`windows-libs-linux`) still builds `tether-core`, `tether-ssh`, and `tether-term`, which M6 does not touch.

- [ ] **Step 7: Commit**

```bash
git add clients/windows/packaging .github/workflows/ci.yml .gitignore
git commit -m "build(windows): portable zip and unsigned MSIX layout, packaged in CI

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Self-review against the spec

| Spec section | Task |
|---|---|
| Window: Back drops connection and channels, sessions keep running; close = Back; Esc belongs to the PTY on the terminal | 4, 5 |
| Terminal header: Back, lamp + word, machine, session · word, Send file…, gear | 5 |
| Status table and lamp colors, light scene tokens | 1, 5 |
| Grid: theme background, padding, bottom-anchored, full repaint ≤ 1 per refresh, no animation; drag redraws locally, PTY resize after ~150 ms | 7, 8 |
| Input: keys, paste keys, Ctrl+C rules, Ctrl+V never 0x16, Ctrl+Q 0x11, bracketed paste, CR newlines | 9, 10 |
| Mouse: drag / double / triple, reporting with Shift override, wheel scrollback vs alt-screen arrows, IME, OSC 52 while focused | 9, 11, 12 |
| Bell: lamp flash, background mark, taskbar flash when unfocused, 200 ms throttle, no sound | 3, 12 |
| Window title `<machine> · <session>` + OSC title | 2, 12 |
| Keyboard table, AltGr, Alt alone / F10 (`SC_KEYMENU`), keys kept by Windows / by Tether | 9, 13 |
| Sessions: strip order, refresh cadence, appear / disappear, one channel per opened tab, 12-attach cap, first tab, empty state, new session, switching shortcuts, kill + confirm, attention, lock detach after 15 s | 2, 3, 4, 6 |
| Links: OSC 8 wins, wrapped / boxed URLs (M2), Ctrl hover + hand + OSC 8 tooltip, Ctrl+click via ShellExecuteW, http/https/mailto only, never reported, Copy link | 11, 12 |
| Replies (OSC 10/11/12, OSC 4, DA, DSR, 14t/18t) written back per tab, synchronized output flushed | 3, 8 (answers are M4's) |
| Notifications: OSC 9 / 777 → toast when unfocused or background, `<machine> · <session>`, click selects tab, 5 s throttle with replace, AUMID for the zip | 12 |
| Progress: OSC 9;4 states, OSC 133;A clears, bar under header, taskbar, per-tab bar | 5, 12 |
| Connect: steps 1–8, retries, connecting screen | 1, 2, 4 (sequence is M2/M3) |
| Reconnect: keep page/strip/grids, input dropped, re-attach active first, 1/2/4 s, network back / focus / resume, disconnected capsule, keepalive drop (M3), resume and route change force redial, mismatch on redial → refused | 6, 13 |
| Host key refused page; Couldn't connect page with sentences, Retry, Back to Home; `zmx ls` failure opens `default` | 2, 5 |
| Files and images: drop, picker, clipboard image / files, PNG from DIB with alpha, text wins, image rule + WIC JPEG 0.9 + unchanged fallback, 200 MB after re-encode, folders refused, uploads dir with marker, session-dir fallback, own connection per file, one paste per file with leading space, capsule text and linger | 10, 14 |
| Build, CI, packaging: release build, MSIX (per-user) + portable zip, signing left to the release slice | 15 |

## Deviations

No public name from a Produces block was renamed.

- The first connect does not emit `Redraw`; a reconnect does.
- Scheduled reconnect backoff stays generations 1, 2, 3 via `cancel_pending_redial()`.
- `layout()` scales padding and cell metrics from a 100% baseline. `frame_job()` sets `RenderStyle.padding_px` with `pt_to_px(padding, scale)`.
- `glue::on_winit_event` takes the Slint window only. IME uses `with_winit_window`.
- `TerminalModel.tabs` and `hover` are `pub(crate)` so the colocated tests can reach them.
- `on_ls` passes `sessions.as_slice()` into `TabStrip::from_sessions`.
- `package.ps1` copies `tether.exe` when `tether-app.exe` is absent, because the bin name is `tether`.
- Clippy allows: `dead_code` on `MenuRequest::Tab`, `Msg::TabShortcut`, `UiEffect::PickFiles`, and `layout()`; `large_enum_variant` on `FrameJob`.


