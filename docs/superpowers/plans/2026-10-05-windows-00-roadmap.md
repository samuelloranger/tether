# Tether for Windows — Implementation Roadmap

> **For the implementer:** Work through the tasks in order. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the native Windows client described in `clients/windows/SPEC.md`: a Rust + Slint SSH-to-`zmx` client with one tab per session, Home/keys/settings, file and image send, toasts and taskbar progress.

**Architecture:** A Cargo workspace in `clients/windows/` with four crates. `tether-core` holds every rule as pure, host-free logic; `tether-ssh` implements core's `Transport` with `russh`; `tether-term` wraps `alacritty_terminal` and rasterizes its grid to RGBA with `swash`; `tether-app` is the Slint window plus Win32 glue. The three library crates build and test on Linux; only `tether-app` needs Windows.

**Tech Stack:** Rust stable (edition 2024), tokio, russh, alacritty_terminal, swash, Slint (Fluent style, GPLv3), `windows` crate, serde/serde_json, uuid, zeroize, ssh-key, sha2, base64, image (PNG encode), tracing.

**Spec:** `clients/windows/SPEC.md` (screen map: `clients/windows/design-preview/index.html`; visual tokens: `DESIGN.md`).

This file is the index and the cross-crate contract. Each milestone has its own plan, and each produces software that builds and passes its tests on its own.

| # | Plan | Delivers | Depends on |
|---|---|---|---|
| M1 | `2026-10-05-windows-m1-core-foundation.md` | Workspace, CI job, atomic JSON store, secret stores (memory + DPAPI), profiles, key vault logic, form hints, preferences, theme catalog, font ids, host-key pins | — |
| M2 | `2026-10-05-windows-m2-core-session-rules.md` | `zmx` parsing and commands, tab strip rules, OSC scanner and reports, throttles, links, key table, paste encoding, clipboard decision, upload rules and send queue, resize debounce, lock grace, connection sequence and reconnect policy over the `Transport` trait | M1 |
| M3 | `2026-10-05-windows-m3-ssh.md` | `russh` transport: dial, pin-before-auth, key/password/agent auth, keepalive after auth, many PTY channels on one connection, exec, SCP sink, in-process test server | M1, M2 (traits) |
| M4 | `2026-10-05-windows-m4-term.md` | Per-tab `alacritty_terminal` wrapper with replies, palette overrides, selection, scrollback; bundled fonts (incl. Cascadia); `swash` glyph atlas and RGBA rasterizer | M1, M2 |
| M5 | `2026-10-05-windows-m5-app-shell.md` | Slint window, tokens, title bar, Home (machines + keys), server/key forms, confirms, Settings, color scheme and font pages, preview, persistence | M1, M4 (preview) |
| M6 | `2026-10-05-windows-m6-app-terminal.md` | Terminal page: connect/refused/couldn't-connect, tabs, input, mouse, selection, links, resize, reconnect, sleep/lock/network, file and image send, toasts, taskbar, CI + MSIX/zip packaging | all |

M3 and M4 can run in parallel after M2. M5 can start after M1 + M4's font task.

## Global Constraints

- Everything lives under `clients/windows/`. Do not touch `clients/apple/` except to read assets from it. Do not add a server, Noise, WebSocket, or web client (`CLAUDE.md`).
- Target Windows 10 22H2 and Windows 11, x64. Rust stable, edition 2024. `cargo fmt --check` and `cargo clippy --workspace --all-targets -- -D warnings` must pass.
- `tether-core`, `tether-ssh`, `tether-term` must build and test on Linux (`#[cfg(windows)]` gates any Win32 code in them).
- Comments: minimal — only a non-obvious why or a gotcha. Tests colocated (`#[cfg(test)] mod tests` in the same file, or `tests/` for integration). Live SSH tests opt in with `TETHER_LIVE_SSH=1` and skip otherwise.
- The `zmx` binary is `~/.local/bin/zmx`. Attach is typed into the login shell: `~/.local/bin/zmx attach '<name>'\n` (POSIX single-quote escaping, `'` → `'"'"'`). Kill: `~/.local/bin/zmx kill '<name>' --force`.
- Host-key fingerprint: SHA-256 of the host key blob, lowercase hex, colon-separated (`aa:bb:…`, 32 bytes). Pinned before auth. A mismatch is never retried and never overridable.
- Key fingerprint shown on cards: `SHA256:` + unpadded standard base64 of SHA-256 of the public key blob.
- Accent `#7C8CF8`; scene `#08080E` night / `#F1F1F6` light; terminal well (Tether theme bg) `#1E1E2E`; warning `#F2B34C`, success `#6EE7A8`, danger `#FF7050` (light column in `DESIGN.md`).
- Data dir `%LOCALAPPDATA%\Tether\`: `profiles.json`, `keys.json`, `preferences.json`, `hostkeys.json`, `secrets\<account>.bin`. Writes are temp file + rename. Secret accounts: `key-<uuid>`, `host-password-<uuid>`. DPAPI current-user with the app's entropy bytes; never Credential Manager.
- Theme catalog: `clients/apple/TetherKit/Sources/TetherKit/Resources/TerminalThemes.json` embedded with `include_str!`, Tether theme first (constant copied from iOS `TerminalTheme.tether`). Fonts from `clients/apple/TetherKit/Sources/TetherKit/Resources/Fonts/` embedded with `include_bytes!`; Cascadia Mono/Code (regular + bold, SIL OFL, from `microsoft/cascadia-code` releases) are added under `clients/windows/assets/fonts/` with their license.
- Terminal defaults on Windows: Cascadia Mono, 14 pt, 1.00×, padding 8, Block, no blink. Ranges: size 8–24 step 1; spacing 1.00–1.60 step 0.05; padding 0–24 step 2.
- User-facing copy is verbatim from the spec. Never paraphrase a sentence the spec quotes.

## Cross-crate contract

Every milestone plan uses exactly these names. A task that needs something not listed here adds it in its own crate and documents it in its **Produces** block.

### `tether-core` (M1)

```rust
// store.rs
pub struct DataDir { root: PathBuf }
impl DataDir {
    pub fn new(root: impl Into<PathBuf>) -> Self;
    pub fn default_windows() -> io::Result<Self>;            // %LOCALAPPDATA%\Tether
    pub fn root(&self) -> &Path;
    pub fn load<T: DeserializeOwned + Default>(&self, file: &str) -> io::Result<T>; // NotFound → Ok(Default); other read errors retry 3× ~50ms then Err; corrupt → rename to <file>.corrupt-<unix> then Ok(Default), rename failure → Err
    pub fn save<T: Serialize>(&self, file: &str, value: &T) -> io::Result<()>; // temp + rename
}
// secrets.rs
pub trait SecretStore: Send + Sync {
    fn get(&self, account: &str) -> Result<Option<Zeroizing<Vec<u8>>>, SecretError>;
    fn set(&self, account: &str, secret: &[u8]) -> Result<(), SecretError>;
    fn delete(&self, account: &str) -> Result<(), SecretError>; // absent is Ok
}
pub struct MemorySecretStore;      // Mutex<HashMap>
#[cfg(windows)] pub struct DpapiSecretStore; // DpapiSecretStore::new(dir: &DataDir)
pub fn key_account(id: Uuid) -> String;       // "key-<uuid>"
pub fn password_account(id: Uuid) -> String;  // "host-password-<uuid>"
// profiles.rs
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Auth { Password, Agent, Key { id: Uuid }, #[serde(other)] Unknown }
pub struct Machine { pub id: Uuid, pub name: String, pub host: String, pub port: u16, pub user: String, pub auth: Auth }
pub struct Profiles { pub machines: Vec<Machine> }   // file "profiles.json"
// keys.rs
pub enum KeyOrigin { Generated, Imported, Pasted }   // serde lowercase
pub struct KeyRecord { pub id: Uuid, pub name: String, pub algorithm: String, pub public_line: String, pub fingerprint: String, pub origin: KeyOrigin, pub created: i64 }
pub struct KeyRecords { pub keys: Vec<KeyRecord> }  // file "keys.json"
pub fn generate_ed25519(name: &str, now: i64) -> (KeyRecord, Zeroizing<String> /* PKCS#8 PEM */);
pub fn derive_public_line(private_pem: &str) -> Result<String, KeyError>;
pub fn is_encrypted(private_pem: &str) -> bool;
pub fn algorithm_of(public_line: &str) -> Option<&str>;
pub fn fingerprint(public_line: &str) -> Option<String>;         // "SHA256:…"
pub fn fingerprint_digest(public_line: &str) -> Option<[u8; 32]>;
pub fn randomart(digest: &[u8]) -> [[u8; 17]; 9];
// hints.rs
pub enum AuthChoice { Key(Option<Uuid>), Agent, Password }
pub struct ServerForm { pub name: String, pub host: String, pub port: String, pub user: String, pub auth: AuthChoice, pub password: String, pub has_saved_password: bool }
impl ServerForm { pub fn hint(&self) -> Option<&'static str>; pub fn port_value(&self) -> u16; }
pub struct KeyForm { pub name: String, pub private: String, pub public: String }
impl KeyForm { pub fn hint(&self) -> Option<&'static str>; }
pub fn generate_hint(name: &str) -> Option<&'static str>;
// edit.rs
pub enum PasswordAction { Keep, Set(Zeroizing<String>), Delete }
pub fn apply_server_form(existing: Option<&Machine>, form: &ServerForm) -> (Machine, PasswordAction);
// prefs.rs
pub enum ThemeMode { System, Dark, Light }
pub enum CursorShape { Block, Bar, Underline }
pub struct TerminalPrefs { pub scheme: String, pub font: String, pub size_pt: f32, pub line_spacing: f32, pub padding_pt: f32, pub cursor: CursorShape, pub blink: bool }
pub struct WindowPlacement { pub x: i32, pub y: i32, pub width: u32, pub height: u32, pub maximized: bool }
pub struct Preferences { pub theme_mode: ThemeMode, pub terminal: TerminalPrefs, pub window: Option<WindowPlacement> } // file "preferences.json"
impl Preferences { pub fn load(dir: &DataDir) -> io::Result<Self>; pub fn save(&self, dir: &DataDir) -> io::Result<()>; }
impl TerminalPrefs { pub fn clamped(self) -> Self; pub fn bigger(&mut self); pub fn smaller(&mut self); pub fn reset_size(&mut self); }
// theme.rs
pub struct TerminalTheme { pub id: String, pub name: String, pub background: u32, pub foreground: u32, pub cursor: u32, pub selection: Option<u32>, pub ansi: [u32; 16] } // 0xRRGGBB
pub fn catalog() -> &'static [TerminalTheme];
pub fn theme_named(id: &str) -> &'static TerminalTheme;
impl TerminalTheme { pub fn is_light(&self) -> bool; }
// fonts.rs
pub struct FontFace { pub id: &'static str, pub name: &'static str, pub ligatures: bool }
pub const FONTS: [FontFace; 7];
pub fn font_named(id: &str) -> &'static FontFace;
// hostkey.rs
pub trait HostKeyStore: Send + Sync { fn pinned(&self, host: &str, port: u16) -> Option<String>; fn pin(&self, host: &str, port: u16, fingerprint: &str); }
pub struct JsonHostKeys;        // JsonHostKeys::new(DataDir) -> io::Result<Self> — "hostkeys.json", key "host:port"
pub struct MemoryHostKeys;
pub enum HostKeyDecision { Pinned, Matched, Mismatch { expected: String, got: String } }
pub fn hex_fingerprint(sha256: &[u8; 32]) -> String;
pub fn verify_host_key(fingerprint: &str, host: &str, port: u16, store: &dyn HostKeyStore) -> HostKeyDecision;
```

### `tether-core` (M2)

```rust
// zmx.rs
pub const ZMX: &str = "~/.local/bin/zmx";
pub struct ZmxSession { pub name: String, pub pid: i64, pub clients: i64, pub created: i64, pub cwd: String }
pub fn parse_ls(output: &str) -> Vec<ZmxSession>;
pub fn shell_quote(s: &str) -> String;
pub fn ls_command() -> String; pub fn attach_command(name: &str) -> String; pub fn kill_command(name: &str) -> String;
impl ZmxSession { pub fn display_cwd(&self) -> &str; pub fn cwd_leaf(&self) -> Option<&str>; }
// tabs.rs
pub const ATTACH_CAP: usize = 12;
pub struct Tab { pub name: String, pub created: i64, pub cwd_leaf: Option<String>, pub attached: bool, pub attention: bool, pub last_viewed: u64, pub progress: Option<Progress> }
pub struct TabStrip { pub tabs: Vec<Tab>, pub active: Option<String> }
pub struct MergeOutcome { pub added: Vec<String>, pub removed: Vec<String>, pub active_changed: bool }
impl TabStrip {
    pub fn from_sessions(sessions: &[ZmxSession]) -> Self;  // ordered by created; active = first_tab rule
    pub fn from_ls_failure() -> Self;                         // one "default" tab, active
    pub fn merge(&mut self, sessions: &[ZmxSession]) -> MergeOutcome;
    pub fn select(&mut self, name: &str, view_tick: u64) -> Option<String /* evicted to detach */>;
    pub fn next(&self) -> Option<&str>; pub fn prev(&self) -> Option<&str>;
    pub fn at_position(&self, one_based: usize) -> Option<&str>; pub fn last(&self) -> Option<&str>;
    pub fn new_session_name(&self) -> String;
    pub fn begin_kill(&mut self, name: &str) -> Option<String /* newly active */>;
    pub fn reattach_order(&self) -> Vec<String>;            // attached tabs, active first
    pub fn mark_attention(&mut self, name: &str);
}
pub fn first_tab(sessions: &[ZmxSession]) -> Option<String>;
// osc.rs
pub enum OscEvent { Osc { code: String, body: Vec<u8> }, Reset }
pub struct OscScanner;  // OscScanner::new(); fn feed(&mut self, bytes: &[u8]) -> Vec<OscEvent>  (chunk-split safe)
pub enum ProgressState { Normal, Error, Indeterminate, Paused }
pub struct Progress { pub state: ProgressState, pub percent: u8 }
pub struct Notification { pub title: Option<String>, pub body: String }
pub enum ReportEvent { Notify(Notification), Clipboard(String), ProgressChanged }
pub struct TabReports { pub title: Option<String>, pub cwd: Option<String>, pub progress: Option<Progress> }
impl TabReports { pub fn apply(&mut self, ev: &OscEvent) -> Option<ReportEvent>; }
// throttle.rs
pub struct BellThrottle;          // 200 ms; fn should_ring(&mut self, now: Duration) -> bool
pub struct ToastThrottle;         // 5 s per session; fn offer(&mut self, session: &str, now: Duration) -> ToastDecision { Show, ReplacePending, Drop }
pub fn wants_toast(window_focused: bool, is_active_tab: bool) -> bool;
// links.rs
pub struct LinkSpan { pub start: usize, pub end: usize, pub url: String }
pub fn detect_links(texts: &[String], wrapped: &[bool], cols: Option<usize>) -> Vec<Vec<LinkSpan>>;
pub fn merge_links(explicit: Vec<Vec<LinkSpan>>, detected: Vec<Vec<LinkSpan>>) -> Vec<Vec<LinkSpan>>;
pub fn link_at(spans: &[Vec<LinkSpan>], row: usize, col: usize) -> Option<&LinkSpan>;
pub fn is_openable(url: &str) -> bool;   // http, https, mailto
// keymap.rs
pub struct Mods { pub shift: bool, pub alt: bool, pub ctrl: bool }
pub enum NamedKey { Up, Down, Left, Right, Home, End, Insert, Delete, PageUp, PageDown, F(u8), Tab, Enter, Backspace, Escape, Space, Numpad(NumpadKey) }
pub enum KeyInput { Named(NamedKey), Char { unmodified: char, produced: Option<String> } }
pub struct KeyContext { pub app_cursor: bool, pub app_keypad: bool, pub alt_screen: bool, pub mouse_reporting: bool, pub has_selection: bool }
pub enum TetherCommand { Paste, Copy, FontBigger, FontSmaller, FontReset, NextTab, PrevTab, TabAt(u8), LastTab, NewTab, ScrollPageUp, ScrollPageDown }
pub enum KeyAction { Send(Vec<u8>), Tether(TetherCommand), Ignore }
pub fn encode_key(input: &KeyInput, mods: Mods, ctx: &KeyContext) -> KeyAction;
// paste.rs
pub fn paste_bytes(text: &str, bracketed: bool) -> Vec<u8>;
pub enum ClipboardSnapshot { Text(String), Image(Vec<u8> /* PNG */), Files(Vec<PathBuf>), Empty }
pub enum PasteAction { PasteText(String), UploadImage { name: String, png: Vec<u8> }, SendFiles(Vec<PathBuf>), Nothing }
pub fn paste_action(clip: ClipboardSnapshot, now_unix: i64) -> PasteAction;
// upload.rs
pub const BYTE_LIMIT: u64 = 200 * 1024 * 1024;
pub const UPLOADS_COMMAND: &str;  pub fn uploads_directory(output: &str) -> Option<String>;
pub fn remote_path(dir: Option<&str>, filename: &str) -> String;
pub fn rejection_reason(bytes: u64) -> Option<String>;
pub const FOLDER_REFUSAL: &str = "Tether sends files, not folders.";
pub fn jpeg_name(name: &str) -> Option<String>;
pub struct SendQueue;  // SendQueue::new(files: Vec<PendingFile>, target_tab: String); next(), on_sent(remote) -> Vec<u8> paste, on_failed(reason), capsule() -> Option<String>
// resize.rs
pub struct ResizeDebouncer;  // SETTLE = 150 ms; fn on_size(&mut self, size: GridSize, now: Duration); fn poll(&mut self, now: Duration) -> Option<GridSize>
pub struct GridSize { pub cols: u16, pub rows: u16, pub width_px: u32, pub height_px: u32 }
// lock.rs
pub struct LockGrace;  // GRACE = 15 s; on_lock(now), on_unlock() -> LockAction, poll(now) -> LockAction { None, DetachAll, ReattachAll }
// connect.rs
pub enum Credential { Key(Zeroizing<String>), Password(Zeroizing<String>), Agent }
pub enum ConnectError { HostKeyChanged { expected: String, got: String }, AuthRejected, KeyMissing, AgentNotRunning, AgentNoKey, Timeout, Transport(String) }
impl ConnectError { pub fn sentence(&self) -> String; pub fn retryable(&self) -> bool; }
pub trait Transport: Send + Sync {
    type Conn: Connection;
    fn dial(&self, host: &str, port: u16, timeout: Duration) -> impl Future<Output = Result<Self::Conn, ConnectError>> + Send;
    fn sleep(&self, d: Duration) -> impl Future<Output = ()> + Send;
}
pub trait Connection: Send {
    fn host_key_sha256(&self) -> [u8; 32];
    fn authenticate(&mut self, user: &str, cred: Credential) -> impl Future<Output = Result<(), ConnectError>> + Send;
    fn start_keepalive(&mut self, every: Duration);
    fn exec(&self, command: &str) -> impl Future<Output = Result<String, ConnectError>> + Send;
}
pub struct ConnectRequest { pub machine: Machine }
pub async fn connect<T: Transport>(t: &T, req: &ConnectRequest, hostkeys: &dyn HostKeyStore, secrets: &dyn SecretStore) -> Result<T::Conn, ConnectError>;
pub const RECONNECT_BACKOFF: [Duration; 3] = [1 s, 2 s, 4 s];
```

### `tether-ssh` (M3)

```rust
pub struct RusshTransport;            // RusshTransport::new(runtime: tokio::runtime::Handle)
pub struct RusshConnection;           // impl tether_core::Connection
impl RusshConnection {
    pub async fn open_pty(&self, size: GridSize) -> Result<PtyChannel, ConnectError>;
    pub async fn scp_send(&self, remote_path: &str, bytes: &[u8]) -> Result<(), ConnectError>;
    pub fn is_closed(&self) -> bool;
    pub async fn close(&self);
}
pub struct PtyChannel { pub writer: PtyWriter, pub events: tokio::sync::mpsc::Receiver<PtyEvent> }
#[derive(Clone)] pub struct PtyWriter;  // async fn write(&self, bytes: &[u8]); async fn resize(&self, size: GridSize); async fn close(&self)
pub enum PtyEvent { Data(Vec<u8>), Closed }
pub enum ConnectionEvent { Dropped }   // RusshConnection::events() -> broadcast::Receiver<ConnectionEvent>
```

### `tether-term` (M4)

```rust
pub struct TabTerminal;   // one per tab
impl TabTerminal {
    pub fn new(size: GridSize, theme: &TerminalTheme) -> Self;   // scrollback 10_000
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<TermEvent>;
    pub fn resize(&mut self, size: GridSize);
    pub fn set_theme(&mut self, theme: &TerminalTheme);          // keeps OSC 4 overrides
    pub fn context(&self) -> KeyContext;                         // modes + has_selection
    pub fn bracketed_paste(&self) -> bool;
    pub fn mouse_mode(&self) -> MouseMode;                       // None | Click | Drag | Motion, sgr: bool
    pub fn scroll(&mut self, lines: i32);
    pub fn selection_start(&mut self, cell: Cell, kind: SelectKind); pub fn selection_update(&mut self, cell: Cell);
    pub fn selection_text(&self) -> Option<String>; pub fn clear_selection(&mut self);
    pub fn snapshot(&self) -> Snapshot;                          // cells, cursor, selection, row texts, wrapped flags, osc8 spans
    pub fn reports(&self) -> &TabReports;
}
pub enum TermEvent { Reply(Vec<u8>), Title(Option<String>), Bell, Clipboard(String), Notify(Notification), ProgressChanged, CwdChanged }
pub struct RenderStyle<'a> { pub theme: &'a TerminalTheme, pub font: &'static FontFace, pub size_px: f32, pub line_spacing: f32, pub padding_px: u32, pub cursor: CursorShape, pub cursor_on: bool, pub hover_link: Option<(usize, usize, usize)> }
pub struct Rasterizer;    // Rasterizer::new(); fn render(&mut self, snap: &Snapshot, style: &RenderStyle, width: u32, height: u32) -> RgbaImage
pub fn cell_metrics(font: &FontFace, size_px: f32, line_spacing: f32) -> (f32, f32);
pub fn grid_size(width: u32, height: u32, padding_px: u32, metrics: (f32, f32)) -> GridSize;
pub fn pt_to_px(pt: f32, scale: f32) -> f32;   // pt * 96/72 * scale
pub fn face_bytes(id: &str) -> (&'static [u8], &'static [u8]);  // regular, bold
```

## Review Focus

Inputs the spec implies but no task's happy-path test covers; each has a pinned test in the named milestone.

1. **A corrupt or hand-edited JSON file in `%LOCALAPPDATA%\Tether\`** — the app must still start, keep the bad file aside as `<file>.corrupt-<unix>` and never silently overwrite the user's machines on the next save. (M1 Task 2.)
2. **PTY output split anywhere** — a UTF-8 sequence, an `ESC ]` OSC, or an OSC 52 payload cut across two reads must parse the same as one read. (M2 OSC scanner task, M4 feed task.)
3. **Session names that need quoting** — `it's`, a space, `$(rm -rf ~)`, unicode — must attach/kill exactly that session and never run anything. (M2 zmx task, M3 exec test.)
4. **The window moved to a monitor with another scale factor** — font size in pt stays the same physical size, the glyph atlas re-keys, and the PTY gets one resize after the settle, not a storm. (M4 rasterizer task, M6 resize task.)
5. **A clipboard another app holds open, or a very large screenshot** — `OpenClipboard` failure retries a few times over ~100 ms, then pastes nothing (no crash, no partial paste); a huge DIB is encoded off the UI thread and still passes the 200 MB check after encoding. (M6 clipboard task.)

## Execution order

1. M1 → M2 (sequential; core everything depends on).
2. M3 and M4 in parallel.
3. M5, then M6.
4. Review after each milestone lands (against the spec, this contract, and that milestone's tests), and a whole-branch review after M6.

## Notes for the implementer

- The repo-root `.gitignore` ignores `docs/`. Commit plan edits with `git add -f`; the code under `clients/windows/` is not affected.
- The milestone plans extend this contract. Where a plan's **Produces** block differs from the contract above (e.g. M2's `KillStep`, `ToastThrottle::offer(session, Notification, now)`, `KeyInput::Char { digit }`; M3's `AgentConnector`; M4's `flush_sync`, `RenderCell`, `RgbaImage`), the plan wins; later plans already use the plan's names.
- Two `ssh-key` versions in the build is expected: M1 pins the stable `ssh-key 0.6` set for key parsing in core, and `russh 0.64.1` brings its own. Nothing crosses that boundary but PEM text (`tether-ssh` re-decodes with `russh::keys::decode_secret_key`), so no types have to interoperate. Do not "unify" them by moving core to the release-candidate crypto crates.
- `russh` is built without its default `aws-lc-rs` backend (`default-features = false, features = ["ring", "rsa", "flate2"]`), which would need CMake and NASM on Windows.
- `alacritty_terminal 0.26` needs Rust 1.85+.
