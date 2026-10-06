# M5 — App Shell (Slint window, Home, forms, Settings) Implementation Plan

> **For the implementer:** Work through the tasks in order. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `tether-app` into the Tether window: Win32-painted title bar, Home (Machines and Keys), the server and key forms, destructive confirms, Settings with a live preview, and the color scheme and font pages — everything in the spec except the terminal page, which M6 adds.

**Architecture:** Every decision lives in plain Rust view-models under `crates/tether-app/src/vm/` and in `src/router.rs`, each with unit tests that run without a window. The `.slint` files are declarative: they bind to `global` bridge singletons (`AppBridge`, `HomeBridge`, …) and call their callbacks. `src/app.rs` owns the state (`Rc<RefCell<AppState>>`), the router, the tokio runtime, and pushes view-model output into the bridges after every change. Win32 glue (caption color, system theme, monitor check) is in `src/platform/`, gated on `cfg(windows)` with no-op stubs elsewhere.

**Tech Stack:** Rust 2024, Slint **1.18.1** (`backend-winit`, `unstable-winit-030`, Fluent style via `slint-build`), winit 0.30 through `slint::winit_030`, `windows` 0.62.2 (DWM, GDI, Registry), tokio 1.53, chrono 0.4 (card dates), rfd 0.15 (file picker), arboard 3.6 (copy text), tracing, `tether-core` (M1/M2), `tether-term` (M4).

**Spec:** `clients/windows/SPEC.md` — sections *Window*, *Home*, *Settings*. Screen map: `clients/windows/design-preview/index.html` (every pixel value below comes from its CSS). Tokens: `DESIGN.md` and iOS `TetherColors.swift`. Roadmap and cross-crate contract: `docs/superpowers/plans/2026-10-05-windows-00-roadmap.md`.

## Global Constraints

- Work under `clients/windows/`; run every `cargo` command from there. Never edit `clients/apple/` (read assets only).
- Rust edition 2024. `cargo fmt --all --check` and `cargo clippy --workspace --all-targets -- -D warnings` pass at the end of every task.
- Comments: minimal — only a non-obvious why or a gotcha.
- Copy is verbatim from the spec. Strings this plan quotes are the spec's; do not reword them.
- Accent `#7C8CF8` (light `#4353D0`); scene `#08080E` night / `#F1F1F6` light; terminal well `#1E1E2E`. Slint's default blue never replaces the accent: no std-widget `primary` buttons, all buttons are the custom ones in `ui/components.slint`.
- Night is the default scene: theme mode defaults to Dark (as on iOS). Theme: System (follows Windows `AppsUseLightTheme`, live), Dark, Light.
- Window: caption "Tether"; minimum client size 640 × 420; size, position and maximized state persist in `preferences.json`.
- Forms are pages with Back. Only Remove machine and Delete key are dialogs. Esc is Back on every page M5 owns (M6 makes the terminal the exception).
- Terminal ranges: size 8–24 pt step 1 (default 14); spacing 1.00×–1.60× step 0.05; padding 0–24 pt step 2 (default 8); cursor Block/Bar/Underline; blink off.
- Every preference change is saved at once through `Preferences::save`; every vault change through `DataDir::save` + the secret store.
- Licenses ship with the app: `TerminalThemes-LICENSE.txt`, the iOS `Fonts/LICENSES.md`, and Cascadia's `CascadiaCode-LICENSE.txt` are copied to `licenses\` next to the exe.

## Review Focus

Inputs the spec implies but its happy paths don't exercise. Each has a pinned test in the task named.

1. **A saved window position on a monitor that is gone** (laptop undocked, projector unplugged). The window must open on a visible monitor at the default size, not off-screen with no way to grab it. → Task 4, `offscreen_placement_is_dropped`.
2. **A save that fails** (`%LOCALAPPDATA%\Tether` read-only, disk full). The page stays open, the hint reads `Couldn't save: <reason>`, no ghost card appears, and a password is not deleted for a profile change that never landed. → Task 2, `failed_save_changes_nothing`, `failed_save_keeps_the_password`.
3. **Editing a machine whose key was deleted.** The picker must show no key and the hint must read "Choose a key to save it" — never a silent save of the dangling key id. → Task 7, `missing_key_is_not_preselected`.
4. **Load private key file… on the wrong file** (a 2 GB ISO, a binary `.ppk`). Nothing is read past 64 KiB, nothing is filled, the UI doesn't hang. → Task 8, `huge_or_binary_files_load_nothing`.
5. **A color-scheme search that is whitespace, mixed case, or matches nothing.** Whitespace lists everything; case is ignored; no match is an empty list and leaves the active scheme alone. → Task 11, `search_ignores_case_and_whitespace`.

## What M5 consumes

From M1 (`tether_core`): `DataDir`, `SecretStore`, `SecretError`, `MemorySecretStore`, `DpapiSecretStore` (cfg windows), `key_account`, `password_account`, `Auth`, `Machine`, `Profiles` (`get`, `add`, `replace`, `remove`, `using_key`), `Machine::{auth_label, summary, key_missing}`, `profiles::{machines_subtitle, keys_subtitle, used_by_line, delete_key_warning, PROFILES_FILE}`, `KeyOrigin` (+ `label()`), `KeyRecord`, `KeyRecords` (`get`, `add`, `remove`), `keys::{KEYS_FILE, import_record, normalize_pem}`, `generate_ed25519`, `fingerprint_digest`, `short_fingerprint`, `randomart`, `AuthChoice`, `ServerForm` (`new_add`, `from_machine`, `hint`, `port_value`), `KeyForm` (`hint`), `generate_hint`, `hints::PASSWORD_PLACEHOLDER_EDIT`, `PasswordAction`, `apply_server_form`, `ThemeMode`, `CursorShape`, `TerminalPrefs` (`clamped`, `bigger`, `smaller`, `reset_size`), `WindowPlacement`, `Preferences` (`load`, `save`), `prefs::{MIN_CLIENT_WIDTH, MIN_CLIENT_HEIGHT}`, `TerminalTheme`, `catalog`, `theme_named`, `FONTS`, `FontFace`, `font_named`, `HostKeyStore`, `JsonHostKeys`.

From M2: `tether_core::resize::GridSize { cols: u16, rows: u16, width_px: u32, height_px: u32 }`.

From M4 (`tether_term`): `TabTerminal::{new, feed, snapshot}`, `Rasterizer::{new, render}`, `RenderStyle { theme, font, size_px, line_spacing, padding_px, cursor, cursor_on, hover_link }`, `RgbaImage { width, height, pixels }` (+ `pixel(x, y)`), `cell_metrics`, `pt_to_px`. M4 Task 1 adds `assets/fonts/CascadiaMono-{Regular,Bold}.ttf`, `CascadiaCode-{Regular,Bold}.ttf`, `CascadiaCode-LICENSE.txt`.

## What M5 produces for M6

M6 relies on these exact names (its plan lists them under *What M6 consumes*):

- `crates/tether-app/ui/app.slint` exports `AppWindow`; `src/main.rs` calls `slint::include_modules!()`.
- `ui/tokens.slint` exports global `Tokens` with at least `background`, `surface`, `raised`, `border`, `text`, `text-secondary`, `accent`, `warning`, `success`, `danger`, `mono-font`, `radius-card`, `radius-control` (plus `dark`, `input`, `text-faint`, `on-accent`, `on-danger`, `surface-hover`, `well`, `ui-font`, `radius-button`).
- `ui/components.slint` exports `ConfirmDialog` (`title`, `body`, `extra`, `action`, `confirmed()`, `cancelled()`), `PrimaryButton`, `SecondaryButton`, `DangerButton`, `IconButton` (`icon`, `clicked()`), `BackButton`, `PageChrome` (`title`, `back()`), `Field`, `AreaField`, `Segment`, `Lamp`, `Pill`.
- `ui/bridge.slint` exports enum `PageKind` and global `AppBridge` (`page`, `dialog-open`, dialog strings, `escape() -> bool`, `back()`, `dialog-confirmed()`, `dialog-cancelled()`). M6 adds `terminal`, `host-key-refused`, `couldnt-connect` to `PageKind`.
- `src/router.rs`: `pub enum Page { Home, ServerForm { editing: Option<Uuid> }, KeyGenerate, KeyImport, KeyPaste, Settings, SchemePicker, FontPicker }`, `pub enum Dialog { RemoveMachine(Uuid), DeleteKey(Uuid) }`, `Router::{new, go(&self, Page), back(&self), home(&self), current(&self) -> Page, dialog, open_dialog, close_dialog, on_escape(&self) -> bool}` and `fn escape_is_back(page: &Page) -> bool` (M6 adds `Page::Terminal` to the `false` arm).
- `src/vm/app_state.rs`: `pub struct AppState { pub data: DataDir, pub profiles: Profiles, pub keys: KeyRecords, pub prefs: Preferences, pub secrets: Arc<dyn SecretStore>, pub hostkeys: Arc<dyn HostKeyStore> }` with `save_prefs(&self)` (logs, returns `()`), held as `Rc<RefCell<AppState>>`.
- `src/open_machine.rs`: `pub fn on_open_machine(app: &Rc<App>, machine: Machine)` — a logging stub M6 replaces.
- `src/app.rs`: `pub struct App` with `pub ui: AppWindow`, `pub state: Rc<RefCell<AppState>>`, `pub router: Router`, `pub runtime: tokio::runtime::Runtime`; `App::on_prefs_changed(&self)` (M6 extends it to restyle live tabs) and `App::on_winit_event(self: &Rc<Self>, event: &WindowEvent)` — the **single** `on_winit_window_event` registration; M6 adds its arms there instead of registering a second filter.
- `src/platform/`: `hwnd_of`, `apply_caption`, `system_uses_light`, `placement_visible`. M6's `src/win32/` is a separate module; do not merge them.

## File structure

```
clients/windows/crates/tether-app/
  Cargo.toml                  modify: Slint, windows, tokio, chrono, rfd, arboard, tracing
  build.rs                    create: Fluent style, license copy
  ui/app.slint                create: AppWindow, font imports, page switch, Esc, dialog
  ui/tokens.slint             create: Tokens global (night + light columns)
  ui/bridge.slint             create: PageKind + one global bridge per page
  ui/components.slint         create: buttons, fields, segment, lamp, pill, dialog, page chrome
  ui/home.slint               create: HomePage, machine card, key card, empty states
  ui/forms.slint              create: ServerFormPage, KeyGeneratePage, KeyMaterialPage
  ui/settings.slint           create: SettingsPage + preview box
  ui/pickers.slint            create: SchemePickerPage, FontPickerPage
  ui/icons/{gear,plus,chevron,back,tether}.svg   create
  src/main.rs                 modify: modules, backend selection, run
  src/app.rs                  create: App — state, router, runtime, bridge wiring, refresh
  src/router.rs               create: Page, Dialog, Router
  src/open_machine.rs         create: stub M6 replaces
  src/preview.rs              create: Settings preview through tether-term
  src/platform/mod.rs         create: cfg(windows) dispatch + stubs
  src/platform/windows.rs     create: DWM caption, registry theme, MonitorFromRect
  src/vm/mod.rs               create
  src/vm/scene.rs             create: dark/light resolution, COLORREF
  src/vm/app_state.rs         create: load + every persisted mutation
  src/vm/placement.rs         create: restore/capture window placement
  src/vm/home.rs              create: cards, dialog copy, randomart pixels
  src/vm/server_form.rs       create: Add/Edit server form state
  src/vm/key_forms.rs         create: generate/import/paste state, key file loading
  src/vm/settings.rs          create: labels and steppers
  src/vm/pickers.rs           create: scheme rows, font rows
```

---

### Task 1: Crate scaffold, tokens, scene resolution

**Files:**
- Modify: `clients/windows/crates/tether-app/Cargo.toml`, `clients/windows/crates/tether-app/src/main.rs`
- Create: `build.rs`, `ui/app.slint`, `ui/tokens.slint`, `ui/bridge.slint`, `ui/icons/*.svg`, `src/vm/mod.rs`, `src/vm/scene.rs`
- Test: `src/vm/scene.rs` (colocated)

**Interfaces:**
- Consumes: `tether_core::ThemeMode`.
- Produces: `vm::scene::{is_dark(mode: ThemeMode, system_light: bool) -> bool, colorref(rgb: u32) -> u32, caption_colorref(dark: bool) -> u32, NIGHT_BACKGROUND: u32, LIGHT_BACKGROUND: u32}`; Slint `Tokens`, `PageKind`, `AppBridge`, `AppWindow`.

- [ ] **Step 1: Write the failing test**

`src/vm/mod.rs`:

```rust
pub mod scene;
```

`src/vm/scene.rs`:

```rust
use tether_core::ThemeMode;

pub const NIGHT_BACKGROUND: u32 = 0x08080E;
pub const LIGHT_BACKGROUND: u32 = 0xF1F1F6;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_resolves_against_the_system() {
        assert!(is_dark(ThemeMode::Dark, true));
        assert!(!is_dark(ThemeMode::Light, false));
        assert!(is_dark(ThemeMode::System, false));
        assert!(!is_dark(ThemeMode::System, true));
    }

    #[test]
    fn colorref_is_bgr() {
        assert_eq!(colorref(0x112233), 0x332211);
        assert_eq!(caption_colorref(true), 0x0E0808);
        assert_eq!(caption_colorref(false), 0xF6F1F1);
    }
}
```

Replace `src/main.rs` with:

```rust
mod vm;

fn main() {}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p tether-app scene`
Expected: FAIL — `cannot find function is_dark`.

- [ ] **Step 3: Implement the scene functions**

Append to `src/vm/scene.rs` above the tests:

```rust
pub fn is_dark(mode: ThemeMode, system_light: bool) -> bool {
    match mode {
        ThemeMode::Dark => true,
        ThemeMode::Light => false,
        ThemeMode::System => !system_light,
    }
}

/// DWM wants 0x00BBGGRR.
pub fn colorref(rgb: u32) -> u32 {
    let (r, g, b) = ((rgb >> 16) & 0xFF, (rgb >> 8) & 0xFF, rgb & 0xFF);
    (b << 16) | (g << 8) | r
}

pub fn caption_colorref(dark: bool) -> u32 {
    colorref(if dark { NIGHT_BACKGROUND } else { LIGHT_BACKGROUND })
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p tether-app scene`
Expected: PASS (2 tests).

- [ ] **Step 5: Add dependencies and the build script**

`clients/windows/crates/tether-app/Cargo.toml` (keep the M1 `[package]` and `[[bin]]` sections; replace `[dependencies]`, add the rest):

```toml
[dependencies]
tether-core.workspace = true
tether-term = { path = "../tether-term" }
slint = { version = "1.18.1", default-features = false, features = ["std", "backend-winit", "renderer-femtovg", "renderer-software", "compat-1-2", "unstable-winit-030"] }
tokio = { version = "1.53", features = ["rt-multi-thread", "macros", "sync", "time"] }
uuid.workspace = true
zeroize.workspace = true
thiserror.workspace = true
chrono = { version = "0.4", default-features = false, features = ["clock", "std"] }
rfd = "0.15"
arboard = { version = "3.6", default-features = false }
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["fmt"] }

[target.'cfg(windows)'.dependencies]
windows = { version = "0.62.2", features = [
  "Win32_Foundation", "Win32_Graphics_Dwm", "Win32_Graphics_Gdi", "Win32_System_Registry",
] }

[build-dependencies]
slint-build = "1.18.1"

[dev-dependencies]
tempfile.workspace = true
```

`clients/windows/crates/tether-app/build.rs`:

```rust
use std::{env, fs, path::PathBuf};

fn main() {
    let config = slint_build::CompilerConfiguration::new().with_style("fluent".into());
    slint_build::compile_with_config("ui/app.slint", config).expect("compile ui/app.slint");
    copy_licenses();
}

fn copy_licenses() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let windows = manifest.join("../..");
    let apple = windows.join("../apple/TetherKit/Sources/TetherKit/Resources");
    let sources = [
        (apple.join("TerminalThemes-LICENSE.txt"), "TerminalThemes-LICENSE.txt"),
        (apple.join("Fonts/LICENSES.md"), "Fonts-LICENSES.md"),
        (windows.join("assets/fonts/CascadiaCode-LICENSE.txt"), "CascadiaCode-LICENSE.txt"),
    ];
    // OUT_DIR is target/<profile>/build/tether-app-<hash>/out; the exe sits in target/<profile>.
    let out = PathBuf::from(env::var("OUT_DIR").unwrap());
    let licenses = out.ancestors().nth(3).unwrap().join("licenses");
    fs::create_dir_all(&licenses).unwrap();
    for (from, name) in sources {
        println!("cargo:rerun-if-changed={}", from.display());
        fs::copy(&from, licenses.join(name)).unwrap_or_else(|e| panic!("{}: {e}", from.display()));
    }
}
```

- [ ] **Step 6: Write the tokens, the bridge, the icons, and an empty window**

`ui/tokens.slint` (night column = `DESIGN.md` / design preview; light column = iOS `TetherColors` light values):

```slint
export global Tokens {
    in property <bool> dark: true;
    out property <color> background: dark ? #08080e : #f1f1f6;
    out property <color> surface: dark ? #12121d : #ffffff;
    out property <color> surface-hover: dark ? #161624 : #f7f7fb;
    out property <color> raised: dark ? #191926 : #e9e9f2;
    out property <color> input: dark ? #0b0b13 : #ffffff;
    out property <color> border: dark ? #232333 : #dcdce6;
    out property <color> text: dark ? #edeef6 : #14141b;
    out property <color> text-secondary: dark ? #9797ac : #5c5c6c;
    out property <color> text-faint: dark ? #8b8ba3 : #8a8a9c;
    out property <color> accent: dark ? #7c8cf8 : #4353d0;
    out property <color> on-accent: dark ? #08080e : #ffffff;
    out property <color> success: dark ? #6ee7a8 : #1c7a4f;
    out property <color> warning: dark ? #f2b34c : #8a5a00;
    out property <color> danger: dark ? #ff7050 : #c4381c;
    out property <color> on-danger: dark ? #1a0a07 : #ffffff;
    // Fixed, not scene-dependent: it must equal the Tether theme's cell background.
    out property <color> well: #1e1e2e;
    out property <string> ui-font: "Segoe UI Variable Text";
    out property <string> mono-font: "Cascadia Mono";
    out property <length> radius-card: 16px;
    out property <length> radius-control: 11px;
    out property <length> radius-button: 12px;
}
```

`ui/bridge.slint`:

```slint
export enum PageKind { home, server-form, key-generate, key-import, key-paste, settings, scheme-picker, font-picker }

export global AppBridge {
    in property <PageKind> page: PageKind.home;
    in property <bool> dialog-open;
    in property <string> dialog-title;
    in property <string> dialog-body;
    in property <string> dialog-extra;
    in property <string> dialog-action;
    callback escape() -> bool;
    callback back();
    callback dialog-confirmed();
    callback dialog-cancelled();
}
```

`ui/icons/gear.svg`:

```xml
<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="2.1" stroke="#000" stroke-width="1.4"/><path d="M8 1.6v1.7M8 12.7v1.7M1.6 8h1.7M12.7 8h1.7M3.4 3.4l1.2 1.2M11.4 11.4l1.2 1.2M12.6 3.4l-1.2 1.2M4.6 11.4l-1.2 1.2" stroke="#000" stroke-width="1.3" stroke-linecap="round"/></svg>
```

`ui/icons/plus.svg`:

```xml
<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 2.2v9.6M2.2 7h9.6" stroke="#000" stroke-width="1.5" stroke-linecap="round"/></svg>
```

`ui/icons/chevron.svg`:

```xml
<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M4.5 2.5 8 6 4.5 9.5" stroke="#000" stroke-width="1.4" stroke-linecap="round"/></svg>
```

`ui/icons/back.svg`:

```xml
<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M7.5 2.5 4 6l3.5 3.5" stroke="#000" stroke-width="1.4" stroke-linecap="round"/></svg>
```

`ui/icons/tether.svg` (empty-state mark):

```xml
<svg xmlns="http://www.w3.org/2000/svg" width="46" height="46" viewBox="0 0 46 46" fill="none"><path d="M10 32 23 12l13 20" stroke="#000" stroke-width="1.4" stroke-linejoin="round" stroke-dasharray="2.2 2.4"/><circle cx="10" cy="32" r="3" stroke="#000" stroke-width="1.4"/><circle cx="23" cy="12" r="3" stroke="#000" stroke-width="1.4"/><circle cx="36" cy="32" r="3" stroke="#000" stroke-width="1.4"/></svg>
```

Icons are drawn black and recolored with `colorize` at the use site.

`ui/app.slint` (fonts are registered by importing the files; paths are relative to this file):

```slint
import { Palette } from "std-widgets.slint";
import { Tokens } from "tokens.slint";
import { PageKind, AppBridge } from "bridge.slint";

import "../../../assets/fonts/CascadiaMono-Regular.ttf";
import "../../../assets/fonts/CascadiaMono-Bold.ttf";
import "../../../assets/fonts/CascadiaCode-Regular.ttf";
import "../../../assets/fonts/CascadiaCode-Bold.ttf";
import "../../../../apple/TetherKit/Sources/TetherKit/Resources/Fonts/JetBrainsMono-Regular.ttf";
import "../../../../apple/TetherKit/Sources/TetherKit/Resources/Fonts/JetBrainsMono-Bold.ttf";
import "../../../../apple/TetherKit/Sources/TetherKit/Resources/Fonts/MonaspaceNeon-Regular.otf";
import "../../../../apple/TetherKit/Sources/TetherKit/Resources/Fonts/MonaspaceNeon-Bold.otf";
import "../../../../apple/TetherKit/Sources/TetherKit/Resources/Fonts/MonaspaceRadon-Regular.otf";
import "../../../../apple/TetherKit/Sources/TetherKit/Resources/Fonts/MonaspaceRadon-Bold.otf";
import "../../../../apple/TetherKit/Sources/TetherKit/Resources/Fonts/MapleMono-Regular.ttf";
import "../../../../apple/TetherKit/Sources/TetherKit/Resources/Fonts/MapleMono-Bold.ttf";
import "../../../../apple/TetherKit/Sources/TetherKit/Resources/Fonts/ComicMono.ttf";
import "../../../../apple/TetherKit/Sources/TetherKit/Resources/Fonts/ComicMono-Bold.ttf";

export { Tokens } from "tokens.slint";
export { PageKind, AppBridge } from "bridge.slint";

export component AppWindow inherits Window {
    title: "Tether";
    min-width: 640px;
    min-height: 420px;
    preferred-width: 1040px;
    preferred-height: 680px;
    background: Tokens.background;
    default-font-family: Tokens.ui-font;

    property <bool> dark-scene: Tokens.dark;
    init => { Palette.color-scheme = Tokens.dark ? ColorScheme.dark : ColorScheme.light; }
    changed dark-scene => { Palette.color-scheme = self.dark-scene ? ColorScheme.dark : ColorScheme.light; }

    forward-focus: keys;
    keys := FocusScope {
        key-pressed(event) => {
            if (event.text == Key.Escape && AppBridge.escape()) { return accept; }
            reject
        }
    }
}
```

`src/main.rs`:

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

slint::include_modules!();

mod vm;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();
    slint::BackendSelector::new().backend_name("winit".into()).select()?;
    let ui = AppWindow::new()?;
    ui.global::<Tokens>().set_dark(true);
    ui.run()?;
    Ok(())
}
```

- [ ] **Step 7: Build and look at it**

Run: `cargo run -p tether-app`
Expected: a 1040 × 680 window titled "Tether", background `#08080E`; it cannot be dragged smaller than 640 × 420; `target\debug\licenses\` holds the three license files. Close it.

- [ ] **Step 8: Lint and commit**

Run: `cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings && cargo test -p tether-app`
Expected: clean; 2 tests pass.

```bash
git add clients/windows/crates/tether-app
git commit -m "feat(windows): Slint window scaffold with Tether tokens

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: AppState — load and every persisted mutation

**Files:**
- Create: `src/vm/app_state.rs`
- Modify: `src/vm/mod.rs`
- Test: `src/vm/app_state.rs` (colocated)

**Interfaces:**
- Consumes: `DataDir::{new, load, save}`, `Profiles`, `KeyRecords`, `Preferences::{load, save}`, `SecretStore`, `HostKeyStore`, `apply_server_form`, `PasswordAction`, `generate_ed25519`, `keys::{import_record, normalize_pem, KEYS_FILE}`, `profiles::PROFILES_FILE`, `key_account`, `password_account`.
- Produces:
  - `pub struct AppState { pub data: DataDir, pub profiles: Profiles, pub keys: KeyRecords, pub prefs: Preferences, pub secrets: Arc<dyn SecretStore>, pub hostkeys: Arc<dyn HostKeyStore> }`
  - `#[derive(Debug, thiserror::Error)] pub enum AppError { #[error("{0}")] Io(#[from] io::Error), #[error("{0}")] Secret(#[from] SecretError) }` and `pub fn save_failed_hint(e: &AppError) -> String` → `"Couldn't save: <e>"`.
  - `impl AppState { pub fn load(data: DataDir, secrets: Arc<dyn SecretStore>, hostkeys: Arc<dyn HostKeyStore>) -> Result<Self, AppError>; pub fn save_prefs(&self); pub fn has_saved_password(&self, id: Uuid) -> bool; pub fn save_server(&mut self, editing: Option<Uuid>, form: &ServerForm) -> Result<Uuid, AppError>; pub fn remove_machine(&mut self, id: Uuid) -> Result<(), AppError>; pub fn generate_key(&mut self, name: &str, now: i64) -> Result<Uuid, AppError>; pub fn save_imported_key(&mut self, form: &KeyForm, origin: KeyOrigin, now: i64) -> Result<Uuid, AppError>; pub fn delete_key(&mut self, id: Uuid) -> Result<(), AppError> }`
  - `pub fn unix_now() -> i64`.

- [ ] **Step 1: Write the failing tests**

`src/vm/mod.rs`:

```rust
pub mod app_state;
pub mod scene;
```

`src/vm/app_state.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use tether_core::{AuthChoice, HostKeyStore, MemoryHostKeys, MemorySecretStore};

    fn state(dir: &std::path::Path) -> (AppState, Arc<MemorySecretStore>, Arc<MemoryHostKeys>) {
        let secrets = Arc::new(MemorySecretStore::default());
        let hostkeys = Arc::new(MemoryHostKeys::default());
        let s = AppState::load(DataDir::new(dir), secrets.clone(), hostkeys.clone()).unwrap();
        (s, secrets, hostkeys)
    }

    fn form(auth: AuthChoice, password: &str) -> ServerForm {
        ServerForm {
            name: "devbox".into(),
            host: " 192.0.2.10 ".into(),
            port: "22".into(),
            user: "dev".into(),
            auth,
            password: password.into(),
            has_saved_password: false,
        }
    }

    #[test]
    fn add_server_persists_and_stores_the_password() {
        let dir = tempfile::tempdir().unwrap();
        let (mut s, secrets, _) = state(dir.path());
        let id = s.save_server(None, &form(AuthChoice::Password, "hunter2")).unwrap();
        assert_eq!(s.profiles.machines[0].host, "192.0.2.10");
        assert_eq!(secrets.get(&password_account(id)).unwrap().unwrap().as_slice(), b"hunter2");
        let (reloaded, _, _) = state(dir.path());
        assert_eq!(reloaded.profiles.machines.len(), 1);
        assert!(s.has_saved_password(id));
    }

    #[test]
    fn edit_keeps_order_and_leaving_password_deletes_it() {
        let dir = tempfile::tempdir().unwrap();
        let (mut s, secrets, _) = state(dir.path());
        let a = s.save_server(None, &form(AuthChoice::Password, "pw")).unwrap();
        let mut second = form(AuthChoice::Agent, "");
        second.name = "vps".into();
        s.save_server(None, &second).unwrap();
        let mut edit = form(AuthChoice::Agent, "");
        edit.has_saved_password = true;
        s.save_server(Some(a), &edit).unwrap();
        assert_eq!(s.profiles.machines[0].id, a);
        assert_eq!(s.profiles.machines[1].name, "vps");
        assert!(secrets.get(&password_account(a)).unwrap().is_none());
    }

    #[test]
    fn empty_password_on_edit_keeps_the_saved_one() {
        let dir = tempfile::tempdir().unwrap();
        let (mut s, secrets, _) = state(dir.path());
        let a = s.save_server(None, &form(AuthChoice::Password, "pw")).unwrap();
        let mut edit = form(AuthChoice::Password, "");
        edit.has_saved_password = true;
        s.save_server(Some(a), &edit).unwrap();
        assert_eq!(secrets.get(&password_account(a)).unwrap().unwrap().as_slice(), b"pw");
    }

    #[test]
    fn remove_machine_forgets_password_but_keeps_the_pin() {
        let dir = tempfile::tempdir().unwrap();
        let (mut s, secrets, hostkeys) = state(dir.path());
        let a = s.save_server(None, &form(AuthChoice::Password, "pw")).unwrap();
        hostkeys.pin("192.0.2.10", 22, "aa:bb");
        s.remove_machine(a).unwrap();
        assert!(s.profiles.machines.is_empty());
        assert!(secrets.get(&password_account(a)).unwrap().is_none());
        assert_eq!(hostkeys.pinned("192.0.2.10", 22).as_deref(), Some("aa:bb"));
    }

    #[test]
    fn generate_then_delete_key_leaves_machine_with_key_missing() {
        let dir = tempfile::tempdir().unwrap();
        let (mut s, secrets, _) = state(dir.path());
        let k = s.generate_key(" desktop ", 1_791_000_000).unwrap();
        assert_eq!(s.keys.keys[0].name, "desktop");
        assert!(secrets.get(&key_account(k)).unwrap().unwrap().starts_with(b"-----BEGIN PRIVATE KEY-----"));
        let m = s.save_server(None, &form(AuthChoice::Key(Some(k)), "")).unwrap();
        s.delete_key(k).unwrap();
        assert!(s.keys.keys.is_empty());
        assert!(secrets.get(&key_account(k)).unwrap().is_none());
        assert!(s.profiles.get(m).unwrap().key_missing(&s.keys));
        let (reloaded, _, _) = state(dir.path());
        assert!(reloaded.keys.keys.is_empty());
    }

    #[test]
    fn imported_key_keeps_its_origin_and_normalized_pem() {
        let dir = tempfile::tempdir().unwrap();
        let (mut s, secrets, _) = state(dir.path());
        let form = KeyForm {
            name: "work".into(),
            private: "-----BEGIN OPENSSH PRIVATE KEY-----\r\nabc\r\n-----END OPENSSH PRIVATE KEY-----\r\n".into(),
            public: "  ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBq work  ".into(),
        };
        let id = s.save_imported_key(&form, KeyOrigin::Pasted, 5).unwrap();
        let rec = s.keys.get(id).unwrap();
        assert_eq!(rec.origin, KeyOrigin::Pasted);
        assert_eq!(rec.public_line, "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBq work");
        let pem = secrets.get(&key_account(id)).unwrap().unwrap();
        assert!(!pem.contains(&b'\r'));
    }

    #[test]
    fn failed_save_changes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let (mut s, _, _) = state(dir.path());
        // A file where the data directory should be: every write under it fails.
        let blocker = dir.path().join("not-a-dir");
        std::fs::write(&blocker, b"x").unwrap();
        s.data = DataDir::new(&blocker);
        let err = s.save_server(None, &form(AuthChoice::Agent, "")).unwrap_err();
        assert!(s.profiles.machines.is_empty());
        assert!(save_failed_hint(&err).starts_with("Couldn't save: "));
        assert!(s.generate_key("k", 1).is_err());
        assert!(s.keys.keys.is_empty());
    }

    #[test]
    fn failed_save_keeps_the_password() {
        let dir = tempfile::tempdir().unwrap();
        let (mut s, secrets, _) = state(dir.path());
        let a = s.save_server(None, &form(AuthChoice::Password, "pw")).unwrap();
        let blocker = dir.path().join("blocked");
        std::fs::write(&blocker, b"x").unwrap();
        s.data = DataDir::new(&blocker);
        let mut edit = form(AuthChoice::Agent, "");
        edit.has_saved_password = true;
        assert!(s.save_server(Some(a), &edit).is_err());
        assert_eq!(secrets.get(&password_account(a)).unwrap().unwrap().as_slice(), b"pw");
        assert_eq!(s.profiles.get(a).unwrap().auth, tether_core::Auth::Password);
    }
}
```

The test public line is not a valid key; `import_record` only reads its tokens. If M1's `import_record` rejects it, replace the line with the contents of `crates/tether-core/fixtures/keys/ed25519_openssh.pub`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p tether-app app_state`
Expected: FAIL — `cannot find type AppState`.

- [ ] **Step 3: Implement**

Prepend to `src/vm/app_state.rs`:

```rust
use std::{
    io,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use tether_core::{
    DataDir, HostKeyStore, KeyForm, KeyOrigin, KeyRecords, PasswordAction, Preferences, Profiles, SecretError,
    SecretStore, ServerForm, apply_server_form, generate_ed25519, key_account,
    keys::{KEYS_FILE, import_record, normalize_pem},
    password_account,
    profiles::PROFILES_FILE,
};
use uuid::Uuid;

pub struct AppState {
    pub data: DataDir,
    pub profiles: Profiles,
    pub keys: KeyRecords,
    pub prefs: Preferences,
    pub secrets: Arc<dyn SecretStore>,
    pub hostkeys: Arc<dyn HostKeyStore>,
}

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    Io(#[from] io::Error),
    #[error("{0}")]
    Secret(#[from] SecretError),
}

pub fn save_failed_hint(e: &AppError) -> String {
    format!("Couldn't save: {e}")
}

pub fn unix_now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64)
}

impl AppState {
    pub fn load(data: DataDir, secrets: Arc<dyn SecretStore>, hostkeys: Arc<dyn HostKeyStore>) -> Result<Self, AppError> {
        Ok(Self {
            profiles: data.load(PROFILES_FILE)?,
            keys: data.load(KEYS_FILE)?,
            prefs: Preferences::load(&data)?,
            data,
            secrets,
            hostkeys,
        })
    }

    pub fn save_prefs(&self) {
        if let Err(e) = self.prefs.save(&self.data) {
            tracing::warn!("saving preferences failed: {e}");
        }
    }

    pub fn has_saved_password(&self, id: Uuid) -> bool {
        matches!(self.secrets.get(&password_account(id)), Ok(Some(_)))
    }

    /// The new list is written before the in-memory one changes, and a password is only
    /// deleted once the profile that stopped using it is on disk.
    pub fn save_server(&mut self, editing: Option<Uuid>, form: &ServerForm) -> Result<Uuid, AppError> {
        let existing = editing.and_then(|id| self.profiles.get(id)).cloned();
        let (machine, action) = apply_server_form(existing.as_ref(), form);
        let id = machine.id;
        if let PasswordAction::Set(pw) = &action {
            self.secrets.set(&password_account(id), pw.as_bytes())?;
        }
        let mut next = self.profiles.clone();
        if existing.is_some() {
            next.replace(machine);
        } else {
            next.add(machine);
        }
        self.data.save(PROFILES_FILE, &next)?;
        self.profiles = next;
        if matches!(action, PasswordAction::Delete) {
            self.secrets.delete(&password_account(id))?;
        }
        Ok(id)
    }

    pub fn remove_machine(&mut self, id: Uuid) -> Result<(), AppError> {
        let mut next = self.profiles.clone();
        next.remove(id);
        self.data.save(PROFILES_FILE, &next)?;
        self.profiles = next;
        self.secrets.delete(&password_account(id))?;
        Ok(())
    }

    pub fn generate_key(&mut self, name: &str, now: i64) -> Result<Uuid, AppError> {
        let (record, pem) = generate_ed25519(name.trim(), now);
        self.add_key(record, pem.as_bytes())
    }

    pub fn save_imported_key(&mut self, form: &KeyForm, origin: KeyOrigin, now: i64) -> Result<Uuid, AppError> {
        let record = import_record(form.name.trim(), &form.public, origin, now);
        self.add_key(record, normalize_pem(&form.private).as_bytes())
    }

    fn add_key(&mut self, record: tether_core::KeyRecord, secret: &[u8]) -> Result<Uuid, AppError> {
        let id = record.id;
        let mut next = self.keys.clone();
        next.add(record);
        self.data.save(KEYS_FILE, &next)?;
        if let Err(e) = self.secrets.set(&key_account(id), secret) {
            let _ = self.data.save(KEYS_FILE, &self.keys);
            return Err(e.into());
        }
        self.keys = next;
        Ok(id)
    }

    pub fn delete_key(&mut self, id: Uuid) -> Result<(), AppError> {
        let mut next = self.keys.clone();
        next.remove(id);
        self.data.save(KEYS_FILE, &next)?;
        self.keys = next;
        self.secrets.delete(&key_account(id))?;
        Ok(())
    }
}
```

`Profiles`, `KeyRecords` derive `Clone` in M1. If `MemoryHostKeys` is not re-exported at the crate root, import it as `tether_core::hostkey::MemoryHostKeys`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p tether-app app_state`
Expected: PASS (8 tests).

- [ ] **Step 5: Lint and commit**

Run: `cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings`

```bash
git add clients/windows/crates/tether-app/src/vm
git commit -m "feat(windows): app state with persisted machine and key changes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Router, components, and the App controller

**Files:**
- Create: `src/router.rs`, `src/app.rs`, `src/open_machine.rs`, `ui/components.slint`
- Modify: `src/main.rs`, `ui/app.slint`
- Test: `src/router.rs` (colocated)

**Interfaces:**
- Consumes: `AppState` (Task 2), `AppBridge`, `PageKind`, `Tokens` (Task 1), `DataDir::default_windows`, `DpapiSecretStore::new(&DataDir)`, `JsonHostKeys::new(DataDir)`.
- Produces:
  - `router::{Page, Dialog, Router, escape_is_back}` as listed under *What M5 produces for M6*.
  - `app::App { pub ui: AppWindow, pub state: Rc<RefCell<AppState>>, pub router: Router, pub runtime: tokio::runtime::Runtime, … }` with `App::new() -> Result<Rc<App>, Box<dyn Error>>`, `App::run(self: &Rc<Self>) -> Result<(), slint::PlatformError>`, `App::refresh(&self)` (pushes every bridge), `App::refresh_router(&self)`, `App::on_prefs_changed(&self)`.
  - `open_machine::on_open_machine(app: &Rc<App>, machine: Machine)`.
  - Slint components listed under *What M5 produces for M6*.

- [ ] **Step 1: Write the failing tests**

`src/router.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starts_home_and_back_never_pops_home() {
        let r = Router::new();
        assert_eq!(r.current(), Page::Home);
        r.back();
        assert_eq!(r.current(), Page::Home);
    }

    #[test]
    fn settings_returns_to_where_it_was_opened() {
        let r = Router::new();
        r.go(Page::Settings);
        r.go(Page::SchemePicker);
        r.back();
        assert_eq!(r.current(), Page::Settings);
        r.back();
        assert_eq!(r.current(), Page::Home);
    }

    #[test]
    fn escape_closes_a_dialog_first_then_goes_back() {
        let r = Router::new();
        r.go(Page::ServerForm { editing: None });
        r.open_dialog(Dialog::RemoveMachine(Uuid::nil()));
        assert!(r.on_escape());
        assert_eq!(r.dialog(), None);
        assert_eq!(r.current(), Page::ServerForm { editing: None });
        assert!(r.on_escape());
        assert_eq!(r.current(), Page::Home);
    }

    #[test]
    fn escape_on_home_is_not_handled() {
        let r = Router::new();
        assert!(!r.on_escape());
    }

    #[test]
    fn navigating_dismisses_a_dialog_and_home_clears_the_stack() {
        let r = Router::new();
        r.go(Page::Settings);
        r.open_dialog(Dialog::DeleteKey(Uuid::nil()));
        r.go(Page::FontPicker);
        assert_eq!(r.dialog(), None);
        r.home();
        assert_eq!(r.current(), Page::Home);
        r.back();
        assert_eq!(r.current(), Page::Home);
    }
}
```

Add `mod router;` to `src/main.rs`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p tether-app router`
Expected: FAIL — `cannot find type Router`.

- [ ] **Step 3: Implement the router**

Prepend to `src/router.rs`:

```rust
use std::cell::{Cell, RefCell};

use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Page {
    Home,
    ServerForm { editing: Option<Uuid> },
    KeyGenerate,
    KeyImport,
    KeyPaste,
    Settings,
    SchemePicker,
    FontPicker,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dialog {
    RemoveMachine(Uuid),
    DeleteKey(Uuid),
}

/// Pages that Esc leaves. M6 adds `Page::Terminal` to the `false` side: there Esc is the PTY's.
pub fn escape_is_back(page: &Page) -> bool {
    !matches!(page, Page::Home)
}

pub struct Router {
    stack: RefCell<Vec<Page>>,
    dialog: Cell<Option<Dialog>>,
}

impl Default for Router {
    fn default() -> Self {
        Self::new()
    }
}

impl Router {
    pub fn new() -> Self {
        Self { stack: RefCell::new(vec![Page::Home]), dialog: Cell::new(None) }
    }

    pub fn current(&self) -> Page {
        self.stack.borrow().last().cloned().unwrap_or(Page::Home)
    }

    pub fn go(&self, page: Page) {
        self.dialog.set(None);
        self.stack.borrow_mut().push(page);
    }

    pub fn back(&self) {
        self.dialog.set(None);
        let mut stack = self.stack.borrow_mut();
        if stack.len() > 1 {
            stack.pop();
        }
    }

    pub fn home(&self) {
        self.dialog.set(None);
        self.stack.borrow_mut().truncate(1);
    }

    pub fn dialog(&self) -> Option<Dialog> {
        self.dialog.get()
    }

    pub fn open_dialog(&self, dialog: Dialog) {
        self.dialog.set(Some(dialog));
    }

    pub fn close_dialog(&self) {
        self.dialog.set(None);
    }

    pub fn on_escape(&self) -> bool {
        if self.dialog.take().is_some() {
            return true;
        }
        if escape_is_back(&self.current()) {
            self.back();
            return true;
        }
        false
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p tether-app router`
Expected: PASS (5 tests).

- [ ] **Step 5: Write the shared components**

`ui/components.slint`:

```slint
import { Tokens } from "tokens.slint";

component ButtonBase inherits Rectangle {
    in property <string> text;
    in property <bool> enabled: true;
    in property <color> fill;
    in property <color> ink;
    in property <bool> outlined: false;
    callback clicked();
    min-height: 44px;
    min-width: label.preferred-width + 36px;
    border-radius: Tokens.radius-button;
    background: !root.enabled ? Tokens.raised : touch.pressed ? root.fill.darker(0.08) : touch.has-hover ? root.fill.brighter(0.06) : root.fill;
    border-width: focus.has-focus ? 2px : root.outlined ? 1px : 0px;
    border-color: focus.has-focus ? Tokens.accent : Tokens.border;
    focus := FocusScope {
        width: 100%;
        height: 100%;
        enabled: root.enabled;
        key-pressed(event) => {
            if (event.text == Key.Return || event.text == " ") { root.clicked(); return accept; }
            reject
        }
    }
    touch := TouchArea {
        width: 100%;
        height: 100%;
        enabled: root.enabled;
        mouse-cursor: root.enabled ? pointer : default;
        clicked => { focus.focus(); root.clicked(); }
    }
    label := Text {
        width: 100%;
        height: 100%;
        text: root.text;
        color: root.enabled ? root.ink : Tokens.text-faint;
        font-size: 14px;
        font-weight: 650;
        horizontal-alignment: center;
        vertical-alignment: center;
    }
}

export component PrimaryButton inherits ButtonBase {
    fill: Tokens.accent;
    ink: Tokens.on-accent;
}

export component SecondaryButton inherits ButtonBase {
    fill: Tokens.raised;
    ink: Tokens.text;
    outlined: true;
}

export component DangerButton inherits ButtonBase {
    fill: Tokens.danger;
    ink: Tokens.on-danger;
}

export component IconButton inherits Rectangle {
    in property <image> icon;
    callback clicked();
    width: 34px;
    height: 34px;
    border-radius: 9px;
    background: touch.has-hover ? Tokens.raised.brighter(0.15) : Tokens.raised;
    border-width: focus.has-focus ? 2px : 1px;
    border-color: focus.has-focus ? Tokens.accent : Tokens.border;
    focus := FocusScope {
        key-pressed(event) => {
            if (event.text == Key.Return || event.text == " ") { root.clicked(); return accept; }
            reject
        }
    }
    touch := TouchArea { mouse-cursor: pointer; clicked => { focus.focus(); root.clicked(); } }
    Image {
        source: root.icon;
        colorize: Tokens.accent;
        width: 16px;
        height: 16px;
        x: (parent.width - self.width) / 2;
        y: (parent.height - self.height) / 2;
    }
}

export component BackButton inherits Rectangle {
    in property <string> text: "Back";
    callback clicked();
    height: 34px;
    width: row.preferred-width;
    border-radius: 9px;
    background: touch.has-hover ? Tokens.raised.brighter(0.15) : Tokens.raised;
    border-width: focus.has-focus ? 2px : 1px;
    border-color: focus.has-focus ? Tokens.accent : Tokens.border;
    focus := FocusScope {
        key-pressed(event) => {
            if (event.text == Key.Return || event.text == " ") { root.clicked(); return accept; }
            reject
        }
    }
    touch := TouchArea { mouse-cursor: pointer; clicked => { focus.focus(); root.clicked(); } }
    row := HorizontalLayout {
        padding-left: 8px;
        padding-right: 12px;
        spacing: 4px;
        Image { source: @image-url("icons/back.svg"); colorize: Tokens.text-secondary; width: 12px; height: 12px; y: (parent.height - self.height) / 2; }
        Text { text: root.text; color: Tokens.text-secondary; font-size: 13px; font-weight: 600; vertical-alignment: center; }
    }
}

export component Lamp inherits Rectangle {
    in property <color> lamp: Tokens.accent;
    in property <bool> dim: false;
    width: 11px;
    height: 11px;
    border-radius: 5.5px;
    background: root.lamp;
    opacity: root.dim ? 0.6 : 1.0;
}

export component Pill inherits Rectangle {
    in property <string> text;
    height: label.preferred-height + 4px;
    width: label.preferred-width + 16px;
    border-radius: self.height / 2;
    border-width: 1px;
    border-color: Tokens.border;
    background: Tokens.dark ? #ffffff0a : #0000000a;
    label := Text {
        x: 8px;
        y: 2px;
        text: root.text;
        font-family: Tokens.mono-font;
        font-size: 11px;
        font-weight: 650;
        color: Tokens.text-faint;
    }
}

export component OriginTag inherits Rectangle {
    in property <string> text;
    height: label.preferred-height + 4px;
    width: label.preferred-width + 12px;
    border-radius: 6px;
    background: Tokens.accent.with-alpha(0.12);
    label := Text {
        x: 6px;
        y: 2px;
        text: root.text;
        font-family: Tokens.mono-font;
        font-size: 11px;
        font-weight: 700;
        color: Tokens.accent;
    }
}

export component Segment inherits Rectangle {
    in property <[string]> options;
    in-out property <int> selected;
    // Home's Machines/Keys tabs are a raised segment; form segments fill with the accent.
    in property <bool> raised-style: false;
    callback changed(int);
    background: Tokens.input;
    border-width: focus.has-focus ? 2px : 1px;
    border-color: focus.has-focus ? Tokens.accent : Tokens.border;
    border-radius: root.raised-style ? 12px : 11px;
    height: root.raised-style ? 42px : 38px;
    focus := FocusScope {
        key-pressed(event) => {
            if (event.text == Key.LeftArrow && root.selected > 0) {
                root.selected -= 1;
                root.changed(root.selected);
                return accept;
            }
            if (event.text == Key.RightArrow && root.selected < root.options.length - 1) {
                root.selected += 1;
                root.changed(root.selected);
                return accept;
            }
            reject
        }
    }
    HorizontalLayout {
        padding: 3px;
        spacing: 3px;
        for option[i] in root.options: Rectangle {
            horizontal-stretch: 1;
            border-radius: root.raised-style ? 9px : 8px;
            background: i == root.selected ? (root.raised-style ? Tokens.raised : Tokens.accent) : transparent;
            Text {
                width: 100%;
                height: 100%;
                text: option;
                font-size: root.raised-style ? 13px : 12.5px;
                font-weight: 650;
                horizontal-alignment: center;
                vertical-alignment: center;
                color: i == root.selected ? (root.raised-style ? Tokens.text : Tokens.on-accent) : Tokens.text-secondary;
            }
            TouchArea {
                mouse-cursor: pointer;
                clicked => {
                    focus.focus();
                    root.selected = i;
                    root.changed(i);
                }
            }
        }
    }
}

export component Field inherits VerticalLayout {
    in property <string> label;
    in-out property <string> text;
    in property <string> placeholder;
    in property <bool> password: false;
    in property <bool> mono: false;
    callback edited(string);
    forward-focus: input;
    spacing: 5px;
    if root.label != "": Text { text: root.label; font-size: 12px; font-weight: 600; color: Tokens.text-secondary; }
    Rectangle {
        height: 40px;
        background: Tokens.input;
        border-radius: Tokens.radius-control;
        border-width: 1px;
        border-color: input.has-focus ? Tokens.accent : Tokens.border;
        input := TextInput {
            x: 12px;
            width: parent.width - 24px;
            height: parent.height;
            vertical-alignment: center;
            single-line: true;
            text <=> root.text;
            input-type: root.password ? InputType.password : InputType.text;
            color: Tokens.text;
            font-family: root.mono ? Tokens.mono-font : Tokens.ui-font;
            font-size: 14px;
            selection-background-color: #7c8cf859;
            edited => { root.edited(self.text); }
        }
        if root.text == "" && root.placeholder != "": Text {
            x: 12px;
            height: parent.height;
            vertical-alignment: center;
            text: root.placeholder;
            color: Tokens.text-faint;
            font-size: 14px;
        }
    }
}

export component AreaField inherits VerticalLayout {
    in property <string> label;
    in-out property <string> text;
    in property <string> placeholder;
    callback edited(string);
    forward-focus: area;
    spacing: 5px;
    Text { text: root.label; font-size: 12px; font-weight: 600; color: Tokens.text-secondary; }
    Rectangle {
        height: 104px;
        clip: true;
        background: Tokens.input;
        border-radius: Tokens.radius-control;
        border-width: 1px;
        border-color: area.has-focus ? Tokens.accent : Tokens.border;
        Flickable {
            x: 12px;
            y: 10px;
            width: parent.width - 24px;
            height: parent.height - 20px;
            viewport-height: max(self.height, area.preferred-height);
            area := TextInput {
                width: parent.width;
                single-line: false;
                wrap: char-wrap;
                text <=> root.text;
                color: Tokens.text;
                font-family: Tokens.mono-font;
                font-size: 12px;
                selection-background-color: #7c8cf859;
                edited => { root.edited(self.text); }
            }
        }
        if root.text == "" && root.placeholder != "": Text {
            x: 12px;
            y: 10px;
            text: root.placeholder;
            color: Tokens.text-faint;
            font-family: Tokens.mono-font;
            font-size: 12px;
        }
    }
}

export component Note inherits Rectangle {
    in property <string> text;
    height: label.preferred-height + 20px;
    border-radius: 9px;
    border-width: 1px;
    border-color: Tokens.success.with-alpha(0.28);
    label := Text {
        x: 12px;
        y: 10px;
        width: parent.width - 24px;
        text: root.text;
        wrap: word-wrap;
        font-family: Tokens.mono-font;
        font-size: 11.5px;
        color: Tokens.text-faint;
    }
}

export component Hint inherits Text {
    horizontal-alignment: center;
    wrap: word-wrap;
    color: Tokens.text-faint;
    font-size: 12px;
}

export component Aurora inherits Rectangle {
    y: -140px;
    height: 340px;
    background: @radial-gradient(circle, Tokens.accent.with-alpha(Tokens.dark ? 0.28 : 0.16) 0%, Tokens.accent.with-alpha(0) 58%);
}

export component PageChrome inherits Rectangle {
    in property <string> title;
    in property <length> column-width: 480px;
    callback back();
    background: Tokens.background;
    VerticalLayout {
        padding-top: 22px;
        HorizontalLayout {
            alignment: center;
            vertical-stretch: 0;
            HorizontalLayout {
                width: min(root.column-width, root.width - 48px);
                spacing: 12px;
                alignment: start;
                BackButton { clicked => { root.back(); } }
                Text { text: root.title; font-size: 26px; font-weight: 700; color: Tokens.text; vertical-alignment: center; }
            }
        }
        // Pages put a ScrollView or a top-aligned layout here; it gets the rest of the height.
        HorizontalLayout {
            alignment: center;
            padding-top: 8px;
            vertical-stretch: 1;
            VerticalLayout {
                width: min(root.column-width, root.width - 48px);
                @children
            }
        }
    }
}

export component ConfirmDialog inherits Rectangle {
    in property <string> title;
    in property <string> body;
    in property <string> extra;
    in property <string> action;
    callback confirmed();
    callback cancelled();
    // rgba(8, 8, 14, 0.62)
    background: #08080e9e;
    TouchArea { }
    card := Rectangle {
        width: min(420px, root.width - 48px);
        height: col.preferred-height;
        x: (parent.width - self.width) / 2;
        y: (parent.height - self.height) / 2;
        background: Tokens.surface;
        border-radius: 16px;
        border-width: 1px;
        border-color: Tokens.border;
        drop-shadow-blur: 50px;
        drop-shadow-offset-y: 18px;
        drop-shadow-color: #00000059;
        col := VerticalLayout {
            padding: 20px;
            padding-bottom: 16px;
            spacing: 8px;
            Text { text: root.title; wrap: word-wrap; font-size: 18px; font-weight: 650; color: Tokens.text; }
            Text { text: root.body; wrap: word-wrap; font-size: 14px; color: Tokens.text-secondary; }
            if root.extra != "": Text { text: root.extra; wrap: word-wrap; font-size: 14px; color: Tokens.text-secondary; }
            HorizontalLayout {
                alignment: end;
                spacing: 8px;
                padding-top: 8px;
                cancel := SecondaryButton { text: "Cancel"; clicked => { root.cancelled(); } }
                DangerButton { text: root.action; clicked => { root.confirmed(); } }
            }
        }
    }
    init => { cancel.focus(); }
}
```

`cancel.focus()` targets the button's inner `FocusScope` through `forward-focus`; add `forward-focus: focus;` to `ButtonBase` if Slint reports the component as not focusable.

- [ ] **Step 6: Route pages and the dialog in `ui/app.slint`**

Add imports at the top of `ui/app.slint`:

```slint
import { ConfirmDialog } from "components.slint";
```

Replace the `keys := FocusScope { … }` block with:

```slint
    keys := FocusScope {
        key-pressed(event) => {
            if (event.text == Key.Escape && AppBridge.escape()) { return accept; }
            reject
        }
        Rectangle { background: Tokens.background; }
        if AppBridge.dialog-open: ConfirmDialog {
            title: AppBridge.dialog-title;
            body: AppBridge.dialog-body;
            extra: AppBridge.dialog-extra;
            action: AppBridge.dialog-action;
            confirmed => { AppBridge.dialog-confirmed(); }
            cancelled => { AppBridge.dialog-cancelled(); }
        }
    }
```

Each later task inserts its page as `if AppBridge.page == PageKind.<kind>: <Page> { }` **before** the `ConfirmDialog` line so the dialog draws on top.

- [ ] **Step 7: Write the App controller**

`src/open_machine.rs`:

```rust
use std::rc::Rc;

use tether_core::Machine;

use crate::app::App;

/// M6 replaces this body with the connect flow.
pub fn on_open_machine(_app: &Rc<App>, machine: Machine) {
    tracing::info!(machine = %machine.name, "open requested");
}
```

`src/app.rs`:

```rust
use std::{cell::RefCell, error::Error, rc::Rc, sync::Arc};

use slint::ComponentHandle;
use tether_core::{DataDir, JsonHostKeys, SecretStore};

use crate::{
    AppBridge, AppWindow, PageKind, Tokens,
    router::{Page, Router},
    vm::{app_state::AppState, scene},
};

pub struct App {
    pub ui: AppWindow,
    pub state: Rc<RefCell<AppState>>,
    pub router: Router,
    pub runtime: tokio::runtime::Runtime,
    pub(crate) system_light: std::cell::Cell<bool>,
}

fn page_kind(page: &Page) -> PageKind {
    match page {
        Page::Home => PageKind::Home,
        Page::ServerForm { .. } => PageKind::ServerForm,
        Page::KeyGenerate => PageKind::KeyGenerate,
        Page::KeyImport => PageKind::KeyImport,
        Page::KeyPaste => PageKind::KeyPaste,
        Page::Settings => PageKind::Settings,
        Page::SchemePicker => PageKind::SchemePicker,
        Page::FontPicker => PageKind::FontPicker,
    }
}

fn secret_store(data: &DataDir) -> Arc<dyn SecretStore> {
    #[cfg(windows)]
    {
        Arc::new(tether_core::DpapiSecretStore::new(data))
    }
    #[cfg(not(windows))]
    {
        let _ = data;
        Arc::new(tether_core::MemorySecretStore::default())
    }
}

impl App {
    pub fn new() -> Result<Rc<Self>, Box<dyn Error>> {
        let data = DataDir::default_windows()?;
        let secrets = secret_store(&data);
        let hostkeys = Arc::new(JsonHostKeys::new(DataDir::new(data.root()))?);
        let state = AppState::load(data, secrets, hostkeys)?;
        let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build()?;
        let app = Rc::new(Self {
            ui: AppWindow::new()?,
            state: Rc::new(RefCell::new(state)),
            router: Router::new(),
            runtime,
            system_light: std::cell::Cell::new(false),
        });
        app.install();
        app.refresh();
        Ok(app)
    }

    fn install(self: &Rc<Self>) {
        let bridge = self.ui.global::<AppBridge>();
        let weak = Rc::downgrade(self);
        bridge.on_escape(move || {
            let Some(app) = weak.upgrade() else { return false };
            let handled = app.router.on_escape();
            app.refresh_router();
            handled
        });
        let weak = Rc::downgrade(self);
        bridge.on_back(move || {
            if let Some(app) = weak.upgrade() {
                app.router.back();
                app.refresh_router();
            }
        });
        let weak = Rc::downgrade(self);
        bridge.on_dialog_cancelled(move || {
            if let Some(app) = weak.upgrade() {
                app.router.close_dialog();
                app.refresh_router();
            }
        });
    }

    pub fn run(self: &Rc<Self>) -> Result<(), slint::PlatformError> {
        self.ui.run()
    }

    pub fn refresh(&self) {
        self.refresh_scene();
        self.refresh_router();
    }

    pub fn refresh_scene(&self) {
        let mode = self.state.borrow().prefs.theme_mode;
        self.ui.global::<Tokens>().set_dark(scene::is_dark(mode, self.system_light.get()));
    }

    pub fn refresh_router(&self) {
        let bridge = self.ui.global::<AppBridge>();
        bridge.set_page(page_kind(&self.router.current()));
        bridge.set_dialog_open(self.router.dialog().is_some());
    }

    /// M6 extends this to restyle the live tabs.
    pub fn on_prefs_changed(&self) {
        self.state.borrow().save_prefs();
        self.refresh_scene();
    }
}
```

`src/main.rs`:

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

slint::include_modules!();

mod app;
mod open_machine;
mod router;
mod vm;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();
    slint::BackendSelector::new().backend_name("winit".into()).select()?;
    let app = app::App::new()?;
    app.run()?;
    Ok(())
}
```

`slint::include_modules!()` turns `PageKind.server-form` into `PageKind::ServerForm` and `AppBridge.dialog-open` into `set_dialog_open`.

- [ ] **Step 8: Build, run, lint**

Run: `cargo run -p tether-app`
Expected: the night window opens; Esc does nothing on Home. Close it.

Run: `cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings && cargo test -p tether-app`
Expected: clean; all tests pass.

- [ ] **Step 9: Commit**

```bash
git add clients/windows/crates/tether-app
git commit -m "feat(windows): router, shared components, and app controller

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 4: Title bar, live system theme, window placement

**Files:**
- Create: `src/platform/mod.rs`, `src/platform/win.rs`, `src/vm/placement.rs`
- Modify: `src/vm/mod.rs`, `src/app.rs`, `src/main.rs`
- Test: `src/vm/placement.rs` (colocated); manual check for the Win32 calls

**Interfaces:**
- Consumes: `WindowPlacement { x: i32, y: i32, width: u32, height: u32, maximized: bool }`, `prefs::{MIN_CLIENT_WIDTH, MIN_CLIENT_HEIGHT}` (both `u32`), `vm::scene::caption_colorref`.
- Produces:
  - `vm::placement::{restore(saved: Option<&WindowPlacement>, visible: impl Fn(&WindowPlacement) -> bool) -> Option<WindowPlacement>, capture(bounds: WindowPlacement, minimized: bool, previous: Option<&WindowPlacement>) -> Option<WindowPlacement>}`
  - `platform::{hwnd_of(window: &slint::Window) -> Option<isize>, apply_caption(hwnd: isize, dark: bool), system_uses_light() -> bool, placement_visible(p: &WindowPlacement) -> bool}`
  - `App::on_winit_event(self: &Rc<Self>, event: &WindowEvent)` — the one winit filter. Arms: `ThemeChanged`, `Moved`, `Resized` (Task 10 adds `ScaleFactorChanged`; M6 adds its own).

- [ ] **Step 1: Write the failing tests**

Add `pub mod placement;` to `src/vm/mod.rs`.

`src/vm/placement.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn p(x: i32, y: i32, width: u32, height: u32, maximized: bool) -> WindowPlacement {
        WindowPlacement { x, y, width, height, maximized }
    }

    #[test]
    fn nothing_saved_restores_nothing() {
        assert_eq!(restore(None, |_| true), None);
    }

    #[test]
    fn visible_placement_is_kept() {
        let saved = p(100, 80, 1200, 800, true);
        assert_eq!(restore(Some(&saved), |_| true), Some(saved));
    }

    #[test]
    fn offscreen_placement_is_dropped() {
        let saved = p(4000, 200, 1200, 800, false);
        assert_eq!(restore(Some(&saved), |_| false), None);
    }

    #[test]
    fn a_tiny_saved_size_grows_to_the_minimum() {
        let restored = restore(Some(&p(0, 0, 100, 50, false)), |_| true).unwrap();
        assert_eq!((restored.width, restored.height), (MIN_CLIENT_WIDTH, MIN_CLIENT_HEIGHT));
    }

    #[test]
    fn maximized_close_keeps_the_normal_bounds() {
        let normal = p(100, 80, 1200, 800, false);
        let got = capture(p(0, 0, 2560, 1400, true), false, Some(&normal)).unwrap();
        assert_eq!(got, p(100, 80, 1200, 800, true));
    }

    #[test]
    fn minimized_close_keeps_the_previous_placement() {
        // Windows reports a minimized window at (-32000, -32000).
        let normal = p(100, 80, 1200, 800, false);
        assert_eq!(capture(p(-32000, -32000, 160, 28, false), true, Some(&normal)), Some(normal));
        assert_eq!(capture(p(-32000, -32000, 160, 28, false), true, None), None);
    }

    #[test]
    fn normal_close_saves_the_bounds() {
        let now = p(10, 20, 900, 600, false);
        assert_eq!(capture(now.clone(), false, None), Some(now));
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p tether-app placement`
Expected: FAIL — `cannot find function restore`.

- [ ] **Step 3: Implement placement**

Prepend to `src/vm/placement.rs`:

```rust
use tether_core::{
    WindowPlacement,
    prefs::{MIN_CLIENT_HEIGHT, MIN_CLIENT_WIDTH},
};

pub fn restore(saved: Option<&WindowPlacement>, visible: impl Fn(&WindowPlacement) -> bool) -> Option<WindowPlacement> {
    let mut p = saved?.clone();
    p.width = p.width.max(MIN_CLIENT_WIDTH);
    p.height = p.height.max(MIN_CLIENT_HEIGHT);
    visible(&p).then_some(p)
}

/// A maximized window keeps the bounds it will restore to; a minimized one reports
/// placeholder coordinates, so the last real placement stands.
pub fn capture(
    bounds: WindowPlacement,
    minimized: bool,
    previous: Option<&WindowPlacement>,
) -> Option<WindowPlacement> {
    if minimized {
        return previous.cloned();
    }
    if bounds.maximized {
        if let Some(prev) = previous {
            return Some(WindowPlacement { maximized: true, ..prev.clone() });
        }
    }
    Some(bounds)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p tether-app placement`
Expected: PASS (7 tests).

- [ ] **Step 5: Write the Win32 glue**

`src/platform/mod.rs`:

```rust
#[cfg(windows)]
mod win;

#[cfg(windows)]
pub use win::{apply_caption, placement_visible, system_uses_light};

#[cfg(not(windows))]
pub fn apply_caption(_hwnd: isize, _dark: bool) {}

#[cfg(not(windows))]
pub fn system_uses_light() -> bool {
    false
}

#[cfg(not(windows))]
pub fn placement_visible(_p: &tether_core::WindowPlacement) -> bool {
    true
}

pub fn hwnd_of(window: &slint::Window) -> Option<isize> {
    use slint::winit_030::{
        WinitWindowAccessor,
        winit::raw_window_handle::{HasWindowHandle, RawWindowHandle},
    };
    window
        .with_winit_window(|w| match w.window_handle().ok()?.as_raw() {
            RawWindowHandle::Win32(h) => Some(h.hwnd.get()),
            _ => None,
        })
        .flatten()
}
```

`src/platform/win.rs`:

```rust
use std::ffi::c_void;

use tether_core::WindowPlacement;
use windows::{
    Win32::{
        Foundation::{COLORREF, HWND, RECT},
        Graphics::{
            Dwm::{DWMWA_CAPTION_COLOR, DWMWA_USE_IMMERSIVE_DARK_MODE, DwmSetWindowAttribute},
            Gdi::{MONITOR_DEFAULTTONULL, MonitorFromRect},
        },
        System::Registry::{HKEY_CURRENT_USER, RRF_RT_REG_DWORD, RegGetValueW},
    },
    core::w,
};

use crate::vm::scene::caption_colorref;

pub fn apply_caption(hwnd: isize, dark: bool) {
    let hwnd = HWND(hwnd as *mut c_void);
    let dark_mode = i32::from(dark);
    let caption = COLORREF(caption_colorref(dark));
    // Windows 10 honours only the dark-mode flag; the caption-color call fails there and is ignored.
    unsafe {
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_USE_IMMERSIVE_DARK_MODE,
            &dark_mode as *const i32 as *const c_void,
            size_of::<i32>() as u32,
        );
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_CAPTION_COLOR,
            &caption as *const COLORREF as *const c_void,
            size_of::<COLORREF>() as u32,
        );
    }
}

pub fn system_uses_light() -> bool {
    let mut value: u32 = 0;
    let mut size = size_of::<u32>() as u32;
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            w!("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize"),
            w!("AppsUseLightTheme"),
            RRF_RT_REG_DWORD,
            None,
            Some(&mut value as *mut u32 as *mut c_void),
            Some(&mut size),
        )
    };
    status.is_ok() && value == 1
}

/// The title strip has to be on a monitor, or the window cannot be grabbed and moved back.
pub fn placement_visible(p: &WindowPlacement) -> bool {
    let strip = RECT { left: p.x, top: p.y, right: p.x + p.width as i32, bottom: p.y + 40 };
    !unsafe { MonitorFromRect(&strip, MONITOR_DEFAULTTONULL) }.is_invalid()
}
```

Add `mod platform;` to `src/main.rs`.

- [ ] **Step 6: Wire it into `App`**

In `src/app.rs`, add to the imports:

```rust
use slint::winit_030::{EventResult, WinitWindowAccessor, winit::event::WindowEvent};
use tether_core::WindowPlacement;

use crate::{platform, vm::placement};
```

Add a field to `App`:

```rust
    last_normal: RefCell<Option<WindowPlacement>>,
```

and initialize it in `App::new` with `last_normal: RefCell::new(None),`. In `App::new`, before `app.install()`:

```rust
        app.system_light.set(platform::system_uses_light());
        app.restore_placement();
```

Replace `refresh_scene` and `run`, and add the new methods:

```rust
    pub fn refresh_scene(&self) {
        let mode = self.state.borrow().prefs.theme_mode;
        let dark = scene::is_dark(mode, self.system_light.get());
        self.ui.global::<Tokens>().set_dark(dark);
        if let Some(hwnd) = platform::hwnd_of(self.ui.window()) {
            platform::apply_caption(hwnd, dark);
        }
    }

    pub fn run(self: &Rc<Self>) -> Result<(), slint::PlatformError> {
        let weak = Rc::downgrade(self);
        self.ui.window().on_winit_window_event(move |_, event| {
            if let Some(app) = weak.upgrade() {
                app.on_winit_event(event);
            }
            EventResult::Propagate
        });
        let weak = Rc::downgrade(self);
        self.ui.window().on_close_requested(move || {
            if let Some(app) = weak.upgrade() {
                app.capture_placement();
            }
            slint::CloseRequestResponse::HideWindow
        });
        let weak = Rc::downgrade(self);
        // The HWND exists only once winit has created the window.
        slint::spawn_local(async move {
            let Some(app) = weak.upgrade() else { return };
            if app.ui.window().winit_window().await.is_ok() {
                app.refresh_scene();
            }
        })
        .ok();
        self.ui.run()
    }

    pub fn on_winit_event(self: &Rc<Self>, event: &WindowEvent) {
        match event {
            WindowEvent::ThemeChanged(_) => {
                self.system_light.set(platform::system_uses_light());
                self.refresh_scene();
            }
            WindowEvent::Moved(_) | WindowEvent::Resized(_) => self.remember_normal_bounds(),
            _ => {}
        }
    }

    fn current_bounds(&self) -> WindowPlacement {
        let w = self.ui.window();
        let (pos, size) = (w.position(), w.size());
        WindowPlacement { x: pos.x, y: pos.y, width: size.width, height: size.height, maximized: w.is_maximized() }
    }

    fn remember_normal_bounds(&self) {
        let w = self.ui.window();
        if !w.is_maximized() && !w.is_minimized() {
            *self.last_normal.borrow_mut() = Some(self.current_bounds());
        }
    }

    fn restore_placement(&self) {
        let saved = self.state.borrow().prefs.window.clone();
        let Some(p) = placement::restore(saved.as_ref(), platform::placement_visible) else { return };
        let w = self.ui.window();
        w.set_size(slint::PhysicalSize::new(p.width, p.height));
        w.set_position(slint::PhysicalPosition::new(p.x, p.y));
        w.set_maximized(p.maximized);
        *self.last_normal.borrow_mut() = Some(WindowPlacement { maximized: false, ..p });
    }

    fn capture_placement(&self) {
        let previous = self.last_normal.borrow().clone().or_else(|| self.state.borrow().prefs.window.clone());
        let next = placement::capture(self.current_bounds(), self.ui.window().is_minimized(), previous.as_ref());
        let mut state = self.state.borrow_mut();
        state.prefs.window = next;
        state.save_prefs();
    }
```

`winit` reports `ThemeChanged` on Windows when the app-mode setting changes (it handles `WM_SETTINGCHANGE` / `ImmersiveColorSet` for windows that follow the system theme). If manual check 2 below shows no live change, subclass nothing: instead poll `system_uses_light()` from a 2 s `slint::Timer` while `theme_mode == System` and call `refresh_scene()` when it flips.

- [ ] **Step 7: Check it on Windows**

Run: `cargo run -p tether-app` and check each:
1. Windows 11: the title bar is `#08080E` and meets the client area with no seam; caption reads "Tether".
2. With Tether's Settings → Appearance set to System, switch Windows Settings → Personalization → Colors → "Choose your mode" between Light and Dark: the window background and caption follow each switch live (caption `#F1F1F6` in Light).
3. Resize and move the window, close it, reopen: same size and position. Maximize, close, reopen: opens maximized; un-maximize returns to the earlier bounds. Minimize, close from the taskbar, reopen: the earlier bounds, not off-screen.
4. Quit, edit `%LOCALAPPDATA%\Tether\preferences.json` so `window.x` is `9000`, reopen: the window appears on screen at the default size.
5. Windows 10 (a VM is fine): the caption is the dark system caption in night and the light one in light.

- [ ] **Step 8: Lint and commit**

Run: `cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings && cargo test -p tether-app`

```bash
git add clients/windows/crates/tether-app
git commit -m "feat(windows): painted title bar, live system theme, saved placement

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Home view-model — cards, dialog copy, randomart

**Files:**
- Create: `src/vm/home.rs`
- Modify: `src/vm/mod.rs`
- Test: `src/vm/home.rs` (colocated)

**Interfaces:**
- Consumes: `Profiles` (+ `using_key`), `KeyRecords`, `Machine::{auth_label, key_missing}`, `KeyOrigin::label`, `profiles::{machines_subtitle, keys_subtitle, used_by_line, delete_key_warning}`, `short_fingerprint`, `fingerprint_digest`, `randomart`.
- Produces:
  - `pub enum HomeTab { Machines, Keys }` with `index(self) -> i32`, `from_index(i32) -> Self`.
  - `pub fn subtitle(tab: HomeTab, profiles: &Profiles, keys: &KeyRecords) -> String`
  - `pub struct MachineCardVm { pub id: Uuid, pub name: String, pub address: String, pub auth: String, pub key_missing: bool }`, `pub fn machine_cards(profiles: &Profiles, keys: &KeyRecords) -> Vec<MachineCardVm>`
  - `pub struct KeyCardVm { pub id: Uuid, pub name: String, pub origin: &'static str, pub meta: String, pub fingerprint: String, pub usage: String, pub public_line: String }`, `pub fn key_cards(keys: &KeyRecords, profiles: &Profiles, date_of: impl Fn(i64) -> NaiveDate) -> Vec<KeyCardVm>`
  - `pub fn created_label(date: NaiveDate) -> String`, `pub fn local_date(unix: i64) -> NaiveDate`
  - `pub struct DialogCopy { pub title: String, pub body: &'static str, pub extra: Option<String>, pub action: &'static str }`, `pub fn remove_machine_copy(m: &Machine) -> DialogCopy`, `pub fn delete_key_copy(k: &KeyRecord, profiles: &Profiles) -> DialogCopy`
  - `pub const ART_CELL: u32 = 8; ART_GAP: u32 = 2; ART_WIDTH: u32 = 168; ART_HEIGHT: u32 = 88;`, `pub fn art_color(count: u8, dark: bool) -> Option<[u8; 4]>`, `pub fn randomart_rgba(public_line: &str, dark: bool) -> Vec<u8>`

- [ ] **Step 1: Write the failing tests**

Add `pub mod home;` to `src/vm/mod.rs`.

`src/vm/home.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use tether_core::{Auth, KeyOrigin};

    const PUBLIC: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILq/BDv7Gp/1wzBMF+DvEX6mWJIR0N8VwBDoNiyMcRfz work";

    fn key(id: u128, name: &str) -> KeyRecord {
        KeyRecord {
            id: Uuid::from_u128(id),
            name: name.into(),
            algorithm: "ssh-ed25519".into(),
            public_line: PUBLIC.into(),
            fingerprint: "SHA256:Lq/BDv7Gp1wzBMF+DvEX6mWJIR0N8VwBDoNiyMcRfzA".into(),
            origin: KeyOrigin::Generated,
            created: 0,
        }
    }

    fn machine(id: u128, name: &str, auth: Auth) -> Machine {
        Machine { id: Uuid::from_u128(id), name: name.into(), host: "192.0.2.10".into(), port: 22, user: "dev".into(), auth }
    }

    #[test]
    fn subtitle_follows_the_tab() {
        let profiles = Profiles { machines: vec![machine(1, "devbox", Auth::Agent), machine(2, "vps", Auth::Password)] };
        let keys = KeyRecords { keys: vec![key(9, "id_ed25519")] };
        assert_eq!(subtitle(HomeTab::Machines, &profiles, &keys), "2 machines");
        assert_eq!(subtitle(HomeTab::Keys, &profiles, &keys), "1 key · on this PC");
        assert_eq!(subtitle(HomeTab::Machines, &Profiles::default(), &keys), "no machines yet");
    }

    #[test]
    fn machine_card_splits_address_and_auth() {
        let keys = KeyRecords { keys: vec![key(9, "id_ed25519")] };
        let profiles = Profiles {
            machines: vec![
                machine(1, "devbox", Auth::Key { id: Uuid::from_u128(9) }),
                machine(2, "old", Auth::Key { id: Uuid::from_u128(8) }),
            ],
        };
        let cards = machine_cards(&profiles, &keys);
        assert_eq!(cards[0].address, "dev@192.0.2.10:22");
        assert_eq!(cards[0].auth, "id_ed25519");
        assert!(!cards[0].key_missing);
        assert_eq!(cards[1].auth, "key missing");
        assert!(cards[1].key_missing);
    }

    #[test]
    fn key_card_lines() {
        let keys = KeyRecords { keys: vec![key(9, "id_ed25519")] };
        let profiles = Profiles { machines: vec![machine(1, "devbox", Auth::Key { id: Uuid::from_u128(9) })] };
        let card = &key_cards(&keys, &profiles, |_| NaiveDate::from_ymd_opt(2026, 10, 5).unwrap())[0];
        assert_eq!(card.origin, "generated");
        assert_eq!(card.meta, "ssh-ed25519 · created Oct 5");
        assert_eq!(card.fingerprint, "SHA256:Lq/BDv7G…McRfzA");
        assert_eq!(card.usage, "used by devbox");
        let unused = &key_cards(&keys, &Profiles::default(), |_| NaiveDate::default())[0];
        assert_eq!(unused.usage, "not used yet");
    }

    #[test]
    fn remove_machine_dialog_copy() {
        let copy = remove_machine_copy(&machine(1, "devbox", Auth::Agent));
        assert_eq!(copy.title, "Remove devbox?");
        assert_eq!(copy.body, "Its sessions keep running on the host — only this PC forgets it.");
        assert_eq!(copy.extra, None);
        assert_eq!(copy.action, "Remove machine");
    }

    #[test]
    fn delete_key_dialog_names_the_machines_that_lose_it() {
        let k = key(9, "id_ed25519");
        let profiles = Profiles { machines: vec![machine(1, "devbox", Auth::Key { id: k.id })] };
        let copy = delete_key_copy(&k, &profiles);
        assert_eq!(copy.title, "Delete key id_ed25519?");
        assert_eq!(copy.body, "The private key is erased from this PC and cannot be recovered.");
        assert_eq!(copy.extra.as_deref(), Some("devbox won't be able to sign in until it gets another key."));
        assert_eq!(copy.action, "Delete key");
        assert_eq!(delete_key_copy(&k, &Profiles::default()).extra, None);
    }

    #[test]
    fn art_colors_follow_the_ios_ramp() {
        assert_eq!(art_color(0, true), None);
        assert_eq!(art_color(1, true), Some([0x7C, 0x8C, 0xF8, 89]));
        assert_eq!(art_color(4, true), Some([0x7C, 0x8C, 0xF8, 255]));
        assert_eq!(art_color(7, true), Some([0x6E, 0xE7, 0xA8, 255]));
        assert_eq!(art_color(12, true), Some([0xF2, 0xB3, 0x4C, 255]));
        assert_eq!(art_color(15, true), Some([0x7C, 0x8C, 0xF8, 255]));
        assert_eq!(art_color(16, true), Some([0xFF, 0x70, 0x50, 255]));
        assert_eq!(art_color(4, false), Some([0x43, 0x53, 0xD0, 255]));
    }

    #[test]
    fn randomart_buffer_has_the_end_cell_in_danger() {
        let px = randomart_rgba(PUBLIC, true);
        assert_eq!(px.len(), (ART_WIDTH * ART_HEIGHT * 4) as usize);
        let field = randomart(&fingerprint_digest(PUBLIC).unwrap());
        let (row, col) = (0..9).flat_map(|r| (0..17).map(move |c| (r, c))).find(|&(r, c)| field[r][c] == 16).unwrap();
        let (x, y) = (col as u32 * (ART_CELL + ART_GAP), row as u32 * (ART_CELL + ART_GAP));
        let at = ((y * ART_WIDTH + x) * 4) as usize;
        assert_eq!(&px[at..at + 4], &[0xFF, 0x70, 0x50, 255]);
        // Gaps stay transparent so the well color behind the image shows through.
        let gap = (ART_CELL * 4) as usize;
        assert_eq!(px[gap + 3], 0);
    }

    #[test]
    fn unparsable_public_line_draws_an_empty_field() {
        assert!(randomart_rgba("not a key", true).iter().all(|&b| b == 0));
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p tether-app vm::home`
Expected: FAIL — unresolved names.

- [ ] **Step 3: Implement**

Prepend to `src/vm/home.rs`:

```rust
use chrono::{DateTime, Local, NaiveDate};
use tether_core::{
    KeyRecord, KeyRecords, Machine, Profiles, fingerprint_digest,
    profiles::{delete_key_warning, keys_subtitle, machines_subtitle, used_by_line},
    randomart, short_fingerprint,
};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HomeTab {
    Machines,
    Keys,
}

impl HomeTab {
    pub fn index(self) -> i32 {
        match self {
            HomeTab::Machines => 0,
            HomeTab::Keys => 1,
        }
    }

    pub fn from_index(i: i32) -> Self {
        if i == 1 { HomeTab::Keys } else { HomeTab::Machines }
    }
}

pub fn subtitle(tab: HomeTab, profiles: &Profiles, keys: &KeyRecords) -> String {
    match tab {
        HomeTab::Machines => machines_subtitle(profiles.machines.len()),
        HomeTab::Keys => keys_subtitle(keys.keys.len()),
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct MachineCardVm {
    pub id: Uuid,
    pub name: String,
    pub address: String,
    pub auth: String,
    pub key_missing: bool,
}

pub fn machine_cards(profiles: &Profiles, keys: &KeyRecords) -> Vec<MachineCardVm> {
    profiles
        .machines
        .iter()
        .map(|m| MachineCardVm {
            id: m.id,
            name: m.name.clone(),
            address: format!("{}@{}:{}", m.user, m.host, m.port),
            auth: m.auth_label(keys),
            key_missing: m.key_missing(keys),
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq)]
pub struct KeyCardVm {
    pub id: Uuid,
    pub name: String,
    pub origin: &'static str,
    pub meta: String,
    pub fingerprint: String,
    pub usage: String,
    pub public_line: String,
}

pub fn created_label(date: NaiveDate) -> String {
    format!("created {}", date.format("%b %-d"))
}

pub fn local_date(unix: i64) -> NaiveDate {
    DateTime::from_timestamp(unix, 0).map(|t| t.with_timezone(&Local).date_naive()).unwrap_or_default()
}

pub fn key_cards(keys: &KeyRecords, profiles: &Profiles, date_of: impl Fn(i64) -> NaiveDate) -> Vec<KeyCardVm> {
    keys.keys
        .iter()
        .map(|k| KeyCardVm {
            id: k.id,
            name: k.name.clone(),
            origin: k.origin.label(),
            meta: format!("{} · {}", k.algorithm, created_label(date_of(k.created))),
            fingerprint: short_fingerprint(&k.fingerprint),
            usage: used_by_line(&profiles.using_key(k.id)),
            public_line: k.public_line.clone(),
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq)]
pub struct DialogCopy {
    pub title: String,
    pub body: &'static str,
    pub extra: Option<String>,
    pub action: &'static str,
}

pub fn remove_machine_copy(m: &Machine) -> DialogCopy {
    DialogCopy {
        title: format!("Remove {}?", m.name),
        body: "Its sessions keep running on the host — only this PC forgets it.",
        extra: None,
        action: "Remove machine",
    }
}

pub fn delete_key_copy(k: &KeyRecord, profiles: &Profiles) -> DialogCopy {
    DialogCopy {
        title: format!("Delete key {}?", k.name),
        body: "The private key is erased from this PC and cannot be recovered.",
        extra: delete_key_warning(&profiles.using_key(k.id)),
        action: "Delete key",
    }
}

pub const ART_CELL: u32 = 8;
pub const ART_GAP: u32 = 2;
pub const ART_WIDTH: u32 = 17 * ART_CELL + 16 * ART_GAP;
pub const ART_HEIGHT: u32 = 9 * ART_CELL + 8 * ART_GAP;

/// The iOS key card's ramp (`RandomartGridView.color`).
pub fn art_color(count: u8, dark: bool) -> Option<[u8; 4]> {
    let accent = if dark { [0x7C, 0x8C, 0xF8] } else { [0x43, 0x53, 0xD0] };
    let success = if dark { [0x6E, 0xE7, 0xA8] } else { [0x1C, 0x7A, 0x4F] };
    let warning = if dark { [0xF2, 0xB3, 0x4C] } else { [0x8A, 0x5A, 0x00] };
    let danger = if dark { [0xFF, 0x70, 0x50] } else { [0xC4, 0x38, 0x1C] };
    let (rgb, alpha) = match count {
        0 => return None,
        1..=2 => (accent, 89),
        3..=5 => (accent, 255),
        6..=9 => (success, 255),
        10..=14 => (warning, 255),
        15 => (accent, 255),
        _ => (danger, 255),
    };
    Some([rgb[0], rgb[1], rgb[2], alpha])
}

pub fn randomart_rgba(public_line: &str, dark: bool) -> Vec<u8> {
    let mut px = vec![0u8; (ART_WIDTH * ART_HEIGHT * 4) as usize];
    let Some(digest) = fingerprint_digest(public_line) else { return px };
    for (row, counts) in randomart(&digest).iter().enumerate() {
        for (col, &count) in counts.iter().enumerate() {
            let Some(color) = art_color(count, dark) else { continue };
            let (x0, y0) = (col as u32 * (ART_CELL + ART_GAP), row as u32 * (ART_CELL + ART_GAP));
            for y in y0..y0 + ART_CELL {
                for x in x0..x0 + ART_CELL {
                    let at = ((y * ART_WIDTH + x) * 4) as usize;
                    px[at..at + 4].copy_from_slice(&color);
                }
            }
        }
    }
    px
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p tether-app vm::home`
Expected: PASS (8 tests).

- [ ] **Step 5: Lint and commit**

Run: `cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings`

```bash
git add clients/windows/crates/tether-app/src/vm
git commit -m "feat(windows): home view-model for machine and key cards

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Home page — machines, keys, confirms

**Files:**
- Create: `ui/home.slint`
- Modify: `ui/bridge.slint`, `ui/app.slint`, `src/app.rs`
- Test: manual (all decisions are in Task 5's tested view-model)

**Interfaces:**
- Consumes: `vm::home::*` (Task 5), `Router`, `Dialog` (Task 3), `AppState::{remove_machine, delete_key}` (Task 2), `open_machine::on_open_machine`.
- Produces:
  - Slint structs `MachineCard { id, name, address, auth, key-missing }`, `KeyCard { id, name, origin, meta, fingerprint, usage, art: image }`; global `HomeBridge` (below).
  - `App` fields `home_tab: Cell<HomeTab>`; methods `refresh_home(&self)`, `open_settings(&self)`, `open_server_form(&self, editing: Option<Uuid>)`, `open_key_page(&self, page: Page)` (Tasks 7–9 fill the last three in).

- [ ] **Step 1: Add the Home bridge**

Append to `ui/bridge.slint`:

```slint
export struct MachineCard {
    id: string,
    name: string,
    address: string,
    auth: string,
    key-missing: bool,
}

export struct KeyCard {
    id: string,
    name: string,
    origin: string,
    meta: string,
    fingerprint: string,
    usage: string,
    art: image,
}

export global HomeBridge {
    in-out property <int> tab;
    in property <string> subtitle;
    in property <[MachineCard]> machines;
    in property <[KeyCard]> keys;
    callback tab-changed(int);
    callback add-machine();
    callback open-settings();
    callback open-machine(string);
    callback edit-machine(string);
    callback remove-machine(string);
    callback copy-public-key(string);
    callback delete-key(string);
    callback generate-key();
    callback import-key();
    callback paste-key();
}
```

- [ ] **Step 2: Write the Home page**

`ui/home.slint`:

```slint
import { ListView } from "std-widgets.slint";
import { Tokens } from "tokens.slint";
import { HomeBridge, MachineCard, KeyCard } from "bridge.slint";
import { Aurora, IconButton, Lamp, OriginTag, Pill, PrimaryButton, SecondaryButton, Segment } from "components.slint";

component MachineCardView inherits Rectangle {
    in property <MachineCard> card;
    callback open();
    callback edit();
    callback remove();
    height: body.preferred-height;
    border-radius: Tokens.radius-card;
    background: touch.has-hover ? Tokens.surface-hover : Tokens.surface;
    border-width: focus.has-focus ? 2px : 1px;
    border-color: focus.has-focus ? Tokens.accent : Tokens.border;
    // Right-click, or the Menu key while the card has focus.
    ContextMenuArea {
        width: 100%;
        height: 100%;
        Menu {
            MenuItem { title: "Edit"; activated => { root.edit(); } }
            MenuItem { title: "Remove"; activated => { root.remove(); } }
        }
        focus := FocusScope {
            width: 100%;
            height: 100%;
            key-pressed(event) => {
                if (event.text == Key.Return) { root.open(); return accept; }
                reject
            }
            touch := TouchArea {
                mouse-cursor: pointer;
                clicked => { focus.focus(); root.open(); }
            }
        }
    }
    body := VerticalLayout {
        padding-left: 14px;
        padding-right: 14px;
        padding-top: 13px;
        padding-bottom: 13px;
        spacing: 8px;
        HorizontalLayout {
            spacing: 8px;
            VerticalLayout { alignment: center; Lamp { dim: true; } }
            Text { text: root.card.name; font-size: 16px; font-weight: 650; color: Tokens.text; vertical-alignment: center; overflow: elide; }
            Rectangle { horizontal-stretch: 1; }
            VerticalLayout { alignment: center; Pill { text: "saved"; } }
        }
        HorizontalLayout {
            spacing: 6px;
            alignment: start;
            Text { text: root.card.address; font-family: Tokens.mono-font; font-size: 12.5px; color: Tokens.text-secondary; overflow: elide; }
            Text { text: "· " + root.card.auth; font-family: Tokens.mono-font; font-size: 12.5px; color: Tokens.text-faint; }
        }
        HorizontalLayout {
            alignment: end;
            spacing: 4px;
            Text { text: "Open"; color: Tokens.accent; font-size: 12px; font-weight: 650; }
            VerticalLayout {
                alignment: center;
                Image { source: @image-url("icons/chevron.svg"); colorize: Tokens.accent; width: 12px; height: 12px; }
            }
        }
    }
}

component KeyCardView inherits Rectangle {
    in property <KeyCard> card;
    callback copy();
    callback delete();
    height: body.preferred-height;
    border-radius: Tokens.radius-card;
    background: Tokens.surface;
    border-width: focus.has-focus ? 2px : 1px;
    border-color: focus.has-focus ? Tokens.accent : Tokens.border;
    focus := FocusScope {
        width: 100%;
        height: 100%;
        key-pressed(event) => {
            if (event.text == Key.Delete) { root.delete(); return accept; }
            reject
        }
    }
    TouchArea {
        width: 100%;
        height: 100%;
        clicked => { focus.focus(); }
        pointer-event(event) => {
            if (event.button == PointerEventButton.right && event.kind == PointerEventKind.up) {
                focus.focus();
                root.delete();
            }
        }
    }
    body := HorizontalLayout {
        padding: 13px;
        padding-left: 14px;
        spacing: 13px;
        alignment: start;
        VerticalLayout {
            alignment: start;
            Rectangle {
                width: 78px;
                height: 50px;
                background: Tokens.well;
                border-radius: 8px;
                border-width: 1px;
                border-color: Tokens.border;
                Image {
                    x: 4px;
                    y: 4px;
                    width: parent.width - 8px;
                    height: parent.height - 8px;
                    source: root.card.art;
                    image-fit: fill;
                }
            }
        }
        VerticalLayout {
            spacing: 4px;
            alignment: start;
            HorizontalLayout {
                spacing: 7px;
                alignment: start;
                Text { text: root.card.name; font-size: 15px; font-weight: 650; color: Tokens.text; }
                VerticalLayout { alignment: center; OriginTag { text: root.card.origin; } }
            }
            Text { text: root.card.meta; font-family: Tokens.mono-font; font-size: 12.5px; color: Tokens.text-faint; }
            Text { text: root.card.fingerprint; font-family: Tokens.mono-font; font-size: 12.5px; color: Tokens.text-secondary; }
            Text { text: root.card.usage; font-family: Tokens.mono-font; font-size: 12.5px; color: Tokens.text-faint; }
            HorizontalLayout {
                alignment: start;
                padding-top: 3px;
                Rectangle {
                    width: link.preferred-width;
                    height: link.preferred-height;
                    link := Text { text: "Copy public key"; color: Tokens.accent; font-size: 12.5px; font-weight: 650; }
                    TouchArea { mouse-cursor: pointer; clicked => { root.copy(); } }
                }
            }
        }
    }
}

component MachinesEmpty inherits VerticalLayout {
    alignment: center;
    spacing: 8px;
    padding-bottom: 40px;
    HorizontalLayout {
        alignment: center;
        Image { source: @image-url("icons/tether.svg"); colorize: Tokens.accent; width: 46px; height: 46px; }
    }
    Text { text: "No machines tethered yet"; font-size: 20px; font-weight: 650; color: Tokens.text; horizontal-alignment: center; }
    Text {
        text: "Add a server to open a shell that stays alive between visits.";
        font-size: 14px;
        color: Tokens.text-secondary;
        horizontal-alignment: center;
        wrap: word-wrap;
    }
    HorizontalLayout {
        alignment: center;
        padding-top: 8px;
        PrimaryButton { text: "Add a server"; clicked => { HomeBridge.add-machine(); } }
    }
}

export component HomePage inherits Rectangle {
    background: Tokens.background;
    clip: true;
    Aurora { }
    HorizontalLayout {
        alignment: center;
        VerticalLayout {
            width: min(560px, root.width - 48px);
            HorizontalLayout {
                padding-top: 22px;
                padding-bottom: 8px;
                spacing: 8px;
                VerticalLayout {
                    alignment: end;
                    spacing: 5px;
                    Text { text: "Home"; font-size: 32px; font-weight: 700; color: Tokens.text; }
                    Text { text: HomeBridge.subtitle; font-family: Tokens.mono-font; font-size: 12px; color: Tokens.text-faint; }
                }
                Rectangle { horizontal-stretch: 1; }
                VerticalLayout {
                    alignment: end;
                    IconButton { icon: @image-url("icons/gear.svg"); clicked => { HomeBridge.open-settings(); } }
                }
                VerticalLayout {
                    alignment: end;
                    IconButton { icon: @image-url("icons/plus.svg"); clicked => { HomeBridge.add-machine(); } }
                }
            }
            VerticalLayout {
                padding-top: 10px;
                padding-bottom: 12px;
                Segment {
                    raised-style: true;
                    options: ["Machines", "Keys"];
                    selected <=> HomeBridge.tab;
                    changed(i) => { HomeBridge.tab-changed(i); }
                }
            }
            if HomeBridge.tab == 0 && HomeBridge.machines.length > 0: ListView {
                vertical-stretch: 1;
                for card in HomeBridge.machines: VerticalLayout {
                    padding-bottom: 10px;
                    MachineCardView {
                        card: card;
                        open => { HomeBridge.open-machine(card.id); }
                        edit => { HomeBridge.edit-machine(card.id); }
                        remove => { HomeBridge.remove-machine(card.id); }
                    }
                }
            }
            if HomeBridge.tab == 0 && HomeBridge.machines.length == 0: MachinesEmpty { vertical-stretch: 1; }
            if HomeBridge.tab == 1 && HomeBridge.keys.length > 0: ListView {
                vertical-stretch: 1;
                for card in HomeBridge.keys: VerticalLayout {
                    padding-bottom: 10px;
                    KeyCardView {
                        card: card;
                        copy => { HomeBridge.copy-public-key(card.id); }
                        delete => { HomeBridge.delete-key(card.id); }
                    }
                }
            }
            if HomeBridge.tab == 1 && HomeBridge.keys.length == 0: Text {
                vertical-stretch: 1;
                text: "No keys yet. Generate one, or paste an existing key.";
                horizontal-alignment: center;
                vertical-alignment: center;
                wrap: word-wrap;
                font-size: 14px;
                color: Tokens.text-secondary;
            }
            if HomeBridge.tab == 1: HorizontalLayout {
                spacing: 9px;
                padding-top: 10px;
                padding-bottom: 16px;
                PrimaryButton { horizontal-stretch: 1; text: "Generate"; clicked => { HomeBridge.generate-key(); } }
                SecondaryButton { horizontal-stretch: 1; text: "Import"; clicked => { HomeBridge.import-key(); } }
                SecondaryButton { horizontal-stretch: 1; text: "Paste"; clicked => { HomeBridge.paste-key(); } }
            }
        }
    }
}
```

- [ ] **Step 3: Route it**

In `ui/app.slint` add `import { HomePage } from "home.slint";`, extend the bridge export to `export { PageKind, AppBridge, HomeBridge, MachineCard, KeyCard } from "bridge.slint";`, and insert before the `ConfirmDialog` line:

```slint
        if AppBridge.page == PageKind.home: HomePage { }
```

- [ ] **Step 4: Wire Home into `App`**

In `src/app.rs`, extend the imports:

```rust
use std::cell::Cell;

use slint::{Model, ModelRc, SharedPixelBuffer, SharedString, VecModel};
use uuid::Uuid;

use crate::{
    HomeBridge, KeyCard, MachineCard,
    open_machine::on_open_machine,
    router::Dialog,
    vm::home::{self, HomeTab},
};
```

Add the field `home_tab: Cell<HomeTab>,` to `App` (initialized `Cell::new(HomeTab::Machines)`).

Add these methods to `impl App`:

```rust
    fn parse_id(id: &SharedString) -> Option<Uuid> {
        Uuid::parse_str(id).ok()
    }

    fn art_image(public_line: &str, dark: bool) -> slint::Image {
        let px = home::randomart_rgba(public_line, dark);
        slint::Image::from_rgba8(SharedPixelBuffer::clone_from_slice(&px, home::ART_WIDTH, home::ART_HEIGHT))
    }

    pub fn refresh_home(&self) {
        let state = self.state.borrow();
        let dark = self.ui.global::<Tokens>().get_dark();
        let tab = self.home_tab.get();
        let bridge = self.ui.global::<HomeBridge>();
        bridge.set_tab(tab.index());
        bridge.set_subtitle(home::subtitle(tab, &state.profiles, &state.keys).into());
        let machines: Vec<MachineCard> = home::machine_cards(&state.profiles, &state.keys)
            .into_iter()
            .map(|c| MachineCard {
                id: c.id.to_string().into(),
                name: c.name.into(),
                address: c.address.into(),
                auth: c.auth.into(),
                key_missing: c.key_missing,
            })
            .collect();
        bridge.set_machines(ModelRc::new(VecModel::from(machines)));
        let keys: Vec<KeyCard> = home::key_cards(&state.keys, &state.profiles, home::local_date)
            .into_iter()
            .map(|c| KeyCard {
                art: Self::art_image(&c.public_line, dark),
                id: c.id.to_string().into(),
                name: c.name.into(),
                origin: c.origin.into(),
                meta: c.meta.into(),
                fingerprint: c.fingerprint.into(),
                usage: c.usage.into(),
            })
            .collect();
        bridge.set_keys(ModelRc::new(VecModel::from(keys)));
    }

    pub fn open_settings(&self) {
        self.router.go(Page::Settings);
        self.refresh_router();
    }

    pub fn open_server_form(&self, editing: Option<Uuid>) {
        self.router.go(Page::ServerForm { editing });
        self.refresh_router();
    }

    pub fn open_key_page(&self, page: Page) {
        self.router.go(page);
        self.refresh_router();
    }

    fn copy_public_key(&self, id: Uuid) {
        let Some(line) = self.state.borrow().keys.get(id).map(|k| k.public_line.clone()) else { return };
        if let Err(e) = arboard::Clipboard::new().and_then(|mut c| c.set_text(line)) {
            tracing::warn!("copy public key failed: {e}");
        }
    }

    fn confirm_dialog(&self) {
        let Some(dialog) = self.router.dialog() else { return };
        let result = {
            let mut state = self.state.borrow_mut();
            match dialog {
                Dialog::RemoveMachine(id) => state.remove_machine(id),
                Dialog::DeleteKey(id) => state.delete_key(id),
            }
        };
        if let Err(e) = result {
            tracing::warn!("{dialog:?} failed: {e}");
        }
        self.router.close_dialog();
        self.refresh_router();
        self.refresh_home();
    }
```

Replace `refresh_router` so the dialog strings come from the view-model:

```rust
    pub fn refresh_router(&self) {
        let bridge = self.ui.global::<AppBridge>();
        bridge.set_page(page_kind(&self.router.current()));
        let copy = self.router.dialog().and_then(|d| {
            let s = self.state.borrow();
            match d {
                Dialog::RemoveMachine(id) => s.profiles.get(id).map(home::remove_machine_copy),
                Dialog::DeleteKey(id) => s.keys.get(id).map(|k| home::delete_key_copy(k, &s.profiles)),
            }
        });
        bridge.set_dialog_open(copy.is_some());
        if let Some(c) = copy {
            bridge.set_dialog_title(c.title.into());
            bridge.set_dialog_body(c.body.into());
            bridge.set_dialog_extra(c.extra.unwrap_or_default().into());
            bridge.set_dialog_action(c.action.into());
        }
    }
```

Make `refresh` call `self.refresh_home()` after `refresh_scene()`, and add `self.refresh_home();` as the last line of `refresh_scene` (the randomart colors follow the scene).

Append to `install` (each closure upgrades `weak` first, exactly like the Task 3 ones; a helper keeps it short):

```rust
        fn on<F: Fn(&Rc<App>) + 'static>(app: &Rc<App>, f: F) -> impl Fn() + 'static {
            let weak = Rc::downgrade(app);
            move || {
                if let Some(app) = weak.upgrade() {
                    f(&app);
                }
            }
        }
        fn on_id<F: Fn(&Rc<App>, Uuid) + 'static>(app: &Rc<App>, f: F) -> impl Fn(SharedString) + 'static {
            let weak = Rc::downgrade(app);
            move |id| {
                if let (Some(app), Some(id)) = (weak.upgrade(), App::parse_id(&id)) {
                    f(&app, id);
                }
            }
        }

        bridge.on_dialog_confirmed(on(self, |app| app.confirm_dialog()));
        let home = self.ui.global::<HomeBridge>();
        let weak = Rc::downgrade(self);
        home.on_tab_changed(move |i| {
            if let Some(app) = weak.upgrade() {
                app.home_tab.set(HomeTab::from_index(i));
                app.refresh_home();
            }
        });
        home.on_add_machine(on(self, |app| app.open_server_form(None)));
        home.on_open_settings(on(self, |app| app.open_settings()));
        home.on_open_machine(on_id(self, |app, id| {
            let machine = app.state.borrow().profiles.get(id).cloned();
            if let Some(m) = machine {
                on_open_machine(app, m);
            }
        }));
        home.on_edit_machine(on_id(self, |app, id| app.open_server_form(Some(id))));
        home.on_remove_machine(on_id(self, |app, id| {
            app.router.open_dialog(Dialog::RemoveMachine(id));
            app.refresh_router();
        }));
        home.on_copy_public_key(on_id(self, |app, id| app.copy_public_key(id)));
        home.on_delete_key(on_id(self, |app, id| {
            app.router.open_dialog(Dialog::DeleteKey(id));
            app.refresh_router();
        }));
        home.on_generate_key(on(self, |app| app.open_key_page(Page::KeyGenerate)));
        home.on_import_key(on(self, |app| app.open_key_page(Page::KeyImport)));
        home.on_paste_key(on(self, |app| app.open_key_page(Page::KeyPaste)));
```

`install` takes `self: &Rc<Self>`; move the two helper `fn`s to module level if clippy flags `items_after_statements`. Remove the now-redundant `Model` import if unused.

- [ ] **Step 5: Check it**

Run: `cargo run -p tether-app`. With an empty `%LOCALAPPDATA%\Tether`:
1. Home reads "Home" over `no machines yet`; the aurora glows behind the header; the empty state shows the mark, "No machines tethered yet", the line under it, and **Add a server**.
2. Keys tab: subtitle `0 keys · on this PC`, "No keys yet. Generate one, or paste an existing key.", and the three actions with Generate in the accent. The selected tab is a raised segment.
3. Quit. Hand-write `profiles.json` with one agent machine (`{"machines":[{"id":"00000000-0000-0000-0000-000000000001","name":"devbox","host":"192.0.2.10","port":22,"user":"dev","auth":{"kind":"agent"}}]}`) and reopen: one card, `dev@192.0.2.10:22 · agent`, `saved` capsule, `Open ›` in the accent; the subtitle reads `1 machine`.
4. Tab to the card (focus ring), press the Menu key: Edit / Remove. Choose Remove: the dialog "Remove devbox?", the body line, **Cancel** focused and **Remove machine** in danger. Esc closes it; the card stays. Remove again → **Remove machine**: the card goes, the empty state returns, `hostkeys.json` is untouched.
5. Theme Light (temporarily set `"theme_mode": "light"` in `preferences.json`): cards on white, accent `#4353D0`.

- [ ] **Step 6: Lint and commit**

Run: `cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings && cargo test -p tether-app`

```bash
git add clients/windows/crates/tether-app
git commit -m "feat(windows): Home with machine and key cards and confirms

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Add a server / Edit server

**Files:**
- Create: `src/vm/server_form.rs`, `ui/forms.slint`
- Modify: `src/vm/mod.rs`, `ui/bridge.slint`, `ui/app.slint`, `src/app.rs`
- Test: `src/vm/server_form.rs` (colocated)

**Interfaces:**
- Consumes: `ServerForm::{new_add, from_machine, hint}`, `AuthChoice`, `hints::PASSWORD_PLACEHOLDER_EDIT`, `KeyRecords`, `Machine`, `AppState::{save_server, has_saved_password}`, `save_failed_hint`.
- Produces:
  - `pub struct ServerInput { pub name: String, pub host: String, pub port: String, pub user: String, pub segment: i32, pub key_index: i32, pub password: String }`
  - `pub struct ServerFormVm { pub editing: Option<Uuid>, pub form: ServerForm, pub error: Option<String> }` with `add() -> Self`, `edit(m: &Machine, has_saved_password: bool, keys: &KeyRecords) -> Self`, `title(&self) -> &'static str`, `save_label(&self) -> &'static str`, `password_placeholder(&self) -> &'static str`, `segment(&self) -> i32`, `key_index(&self, keys: &KeyRecords) -> i32`, `key_names(keys: &KeyRecords) -> Vec<String>`, `apply(&mut self, input: ServerInput, keys: &KeyRecords)`, `hint(&self) -> String`, `can_save(&self) -> bool`.
  - Slint global `ServerFormBridge`, component `ServerFormPage`.

- [ ] **Step 1: Write the failing tests**

Add `pub mod server_form;` to `src/vm/mod.rs`.

`src/vm/server_form.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use tether_core::{Auth, KeyOrigin, KeyRecord};

    fn keys() -> KeyRecords {
        let k = |id: u128, name: &str| KeyRecord {
            id: Uuid::from_u128(id),
            name: name.into(),
            algorithm: "ssh-ed25519".into(),
            public_line: "ssh-ed25519 AAAA x".into(),
            fingerprint: "SHA256:x".into(),
            origin: KeyOrigin::Generated,
            created: 0,
        };
        KeyRecords { keys: vec![k(9, "id_ed25519"), k(10, "work")] }
    }

    fn input(segment: i32, key_index: i32, password: &str) -> ServerInput {
        ServerInput {
            name: "devbox".into(),
            host: "192.0.2.10".into(),
            port: "22".into(),
            user: "dev".into(),
            segment,
            key_index,
            password: password.into(),
        }
    }

    #[test]
    fn add_starts_empty_and_asks_for_a_name() {
        let vm = ServerFormVm::add();
        assert_eq!(vm.title(), "Add a server");
        assert_eq!(vm.save_label(), "Save server");
        assert_eq!(vm.form.port, "22");
        assert_eq!(vm.segment(), 0);
        assert_eq!(vm.key_index(&keys()), -1);
        assert_eq!(vm.hint(), "Name this machine to save it");
        assert!(!vm.can_save());
        assert_eq!(vm.password_placeholder(), "");
    }

    #[test]
    fn choosing_a_key_completes_the_form() {
        let mut vm = ServerFormVm::add();
        vm.apply(input(0, -1, ""), &keys());
        assert_eq!(vm.hint(), "Choose a key to save it");
        vm.apply(input(0, 1, ""), &keys());
        assert_eq!(vm.form.auth, AuthChoice::Key(Some(Uuid::from_u128(10))));
        assert!(vm.can_save());
        assert_eq!(vm.hint(), "");
    }

    #[test]
    fn segments_map_to_agent_and_password() {
        let mut vm = ServerFormVm::add();
        vm.apply(input(1, -1, ""), &keys());
        assert_eq!(vm.form.auth, AuthChoice::Agent);
        assert!(vm.can_save());
        vm.apply(input(2, -1, ""), &keys());
        assert_eq!(vm.hint(), "Enter a password to save it");
        vm.apply(input(2, -1, "hunter2"), &keys());
        assert!(vm.can_save());
    }

    #[test]
    fn edit_has_its_own_labels_and_keeps_a_saved_password() {
        let m = Machine { id: Uuid::from_u128(1), name: "vps".into(), host: "h".into(), port: 2222, user: "root".into(), auth: Auth::Password };
        let vm = ServerFormVm::edit(&m, true, &keys());
        assert_eq!(vm.title(), "Edit server");
        assert_eq!(vm.save_label(), "Save changes");
        assert_eq!(vm.form.port, "2222");
        assert_eq!(vm.segment(), 2);
        assert_eq!(vm.password_placeholder(), "Leave empty to keep the saved password");
        assert!(vm.can_save());
    }

    #[test]
    fn missing_key_is_not_preselected() {
        let m = Machine {
            id: Uuid::from_u128(1),
            name: "old".into(),
            host: "h".into(),
            port: 22,
            user: "u".into(),
            auth: Auth::Key { id: Uuid::from_u128(77) },
        };
        let vm = ServerFormVm::edit(&m, false, &keys());
        assert_eq!(vm.form.auth, AuthChoice::Key(None));
        assert_eq!(vm.key_index(&keys()), -1);
        assert_eq!(vm.hint(), "Choose a key to save it");
    }

    #[test]
    fn a_save_error_shows_until_the_next_edit() {
        let mut vm = ServerFormVm::add();
        vm.apply(input(1, -1, ""), &keys());
        vm.error = Some("Couldn't save: Access is denied.".into());
        assert_eq!(vm.hint(), "Couldn't save: Access is denied.");
        vm.apply(input(1, -1, ""), &keys());
        assert_eq!(vm.hint(), "");
    }

    #[test]
    fn key_names_are_in_vault_order() {
        assert_eq!(ServerFormVm::key_names(&keys()), vec!["id_ed25519", "work"]);
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p tether-app server_form`
Expected: FAIL — `cannot find type ServerFormVm`.

- [ ] **Step 3: Implement**

Prepend to `src/vm/server_form.rs`:

```rust
use tether_core::{AuthChoice, KeyRecords, Machine, ServerForm, hints::PASSWORD_PLACEHOLDER_EDIT};
use uuid::Uuid;

pub struct ServerInput {
    pub name: String,
    pub host: String,
    pub port: String,
    pub user: String,
    pub segment: i32,
    pub key_index: i32,
    pub password: String,
}

pub struct ServerFormVm {
    pub editing: Option<Uuid>,
    pub form: ServerForm,
    pub error: Option<String>,
}

impl ServerFormVm {
    pub fn add() -> Self {
        Self { editing: None, form: ServerForm::new_add(), error: None }
    }

    pub fn edit(m: &Machine, has_saved_password: bool, keys: &KeyRecords) -> Self {
        let mut form = ServerForm::from_machine(m, has_saved_password);
        if let AuthChoice::Key(Some(id)) = form.auth {
            if keys.get(id).is_none() {
                form.auth = AuthChoice::Key(None);
            }
        }
        Self { editing: Some(m.id), form, error: None }
    }

    pub fn title(&self) -> &'static str {
        if self.editing.is_some() { "Edit server" } else { "Add a server" }
    }

    pub fn save_label(&self) -> &'static str {
        if self.editing.is_some() { "Save changes" } else { "Save server" }
    }

    pub fn password_placeholder(&self) -> &'static str {
        if self.editing.is_some() && self.form.has_saved_password { PASSWORD_PLACEHOLDER_EDIT } else { "" }
    }

    pub fn segment(&self) -> i32 {
        match self.form.auth {
            AuthChoice::Key(_) => 0,
            AuthChoice::Agent => 1,
            AuthChoice::Password => 2,
        }
    }

    pub fn key_index(&self, keys: &KeyRecords) -> i32 {
        match self.form.auth {
            AuthChoice::Key(Some(id)) => keys.keys.iter().position(|k| k.id == id).map_or(-1, |i| i as i32),
            _ => -1,
        }
    }

    pub fn key_names(keys: &KeyRecords) -> Vec<String> {
        keys.keys.iter().map(|k| k.name.clone()).collect()
    }

    pub fn apply(&mut self, input: ServerInput, keys: &KeyRecords) {
        self.form.name = input.name;
        self.form.host = input.host;
        self.form.port = input.port;
        self.form.user = input.user;
        self.form.password = input.password;
        self.form.auth = match input.segment {
            1 => AuthChoice::Agent,
            2 => AuthChoice::Password,
            _ => AuthChoice::Key(usize::try_from(input.key_index).ok().and_then(|i| keys.keys.get(i)).map(|k| k.id)),
        };
        self.error = None;
    }

    pub fn hint(&self) -> String {
        self.error.clone().or_else(|| self.form.hint().map(str::to_owned)).unwrap_or_default()
    }

    pub fn can_save(&self) -> bool {
        self.form.hint().is_none()
    }
}
```

If `PASSWORD_PLACEHOLDER_EDIT` is re-exported at the crate root instead of `hints::`, import it from there.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p tether-app server_form`
Expected: PASS (7 tests).

- [ ] **Step 5: Add the bridge and the page**

Append to `ui/bridge.slint`:

```slint
export global ServerFormBridge {
    in property <string> title;
    in property <string> save-label;
    in-out property <string> name;
    in-out property <string> host;
    in-out property <string> port;
    in-out property <string> user;
    in-out property <string> password;
    in-out property <int> auth;
    in-out property <int> key-index: -1;
    in property <[string]> key-names;
    in property <string> password-placeholder;
    in property <string> hint;
    in property <bool> can-save;
    callback edited();
    callback save();
}
```

`ui/forms.slint`:

```slint
import { ComboBox, ScrollView } from "std-widgets.slint";
import { Tokens } from "tokens.slint";
import { AppBridge, ServerFormBridge } from "bridge.slint";
import { Field, Hint, Note, PageChrome, PrimaryButton, Segment } from "components.slint";

component Label inherits Text {
    font-size: 12px;
    font-weight: 600;
    color: Tokens.text-secondary;
}

export component ServerFormPage inherits PageChrome {
    title: ServerFormBridge.title;
    back => { AppBridge.back(); }
    scroll := ScrollView {
        viewport-width: self.visible-width;
        viewport-height: col.preferred-height;
        col := VerticalLayout {
            width: scroll.visible-width;
            spacing: 12px;
            padding-bottom: 28px;
            Field { label: "Name"; text <=> ServerFormBridge.name; edited => { ServerFormBridge.edited(); } }
            HorizontalLayout {
                spacing: 9px;
                Field { label: "Host"; text <=> ServerFormBridge.host; edited => { ServerFormBridge.edited(); } }
                Field { label: "Port"; width: 84px; text <=> ServerFormBridge.port; edited => { ServerFormBridge.edited(); } }
            }
            Field { label: "User"; text <=> ServerFormBridge.user; edited => { ServerFormBridge.edited(); } }
            VerticalLayout {
                spacing: 5px;
                Label { text: "Authentication"; }
                Segment {
                    options: ["Private key", "SSH agent", "Password"];
                    selected <=> ServerFormBridge.auth;
                    changed => { ServerFormBridge.edited(); }
                }
            }
            if ServerFormBridge.auth == 0 && ServerFormBridge.key-names.length > 0: VerticalLayout {
                spacing: 5px;
                Label { text: "Key"; }
                ComboBox {
                    model: ServerFormBridge.key-names;
                    current-index <=> ServerFormBridge.key-index;
                    selected => { ServerFormBridge.edited(); }
                }
            }
            if ServerFormBridge.auth == 0 && ServerFormBridge.key-names.length == 0: Text {
                text: "No keys in the vault — generate or paste one first.";
                wrap: word-wrap;
                font-size: 13px;
                color: Tokens.text-secondary;
            }
            if ServerFormBridge.auth == 1: Text {
                text: "Uses the keys in the Windows OpenSSH agent, including 1Password's when it serves that agent.";
                wrap: word-wrap;
                font-size: 13px;
                color: Tokens.text-secondary;
            }
            if ServerFormBridge.auth == 2: Field {
                label: "Password";
                password: true;
                placeholder: ServerFormBridge.password-placeholder;
                text <=> ServerFormBridge.password;
                edited => { ServerFormBridge.edited(); }
            }
            Note { text: "First connect pins this host's key. A later change is refused."; }
            PrimaryButton {
                text: ServerFormBridge.save-label;
                enabled: ServerFormBridge.can-save;
                clicked => { ServerFormBridge.save(); }
            }
            if ServerFormBridge.hint != "": Hint { text: ServerFormBridge.hint; }
        }
    }
}
```

In `ui/app.slint`: `import { ServerFormPage } from "forms.slint";`, add `ServerFormBridge` to the bridge export list, and insert before the dialog:

```slint
        if AppBridge.page == PageKind.server-form: ServerFormPage { }
```

- [ ] **Step 6: Wire it**

In `src/app.rs` add imports `crate::ServerFormBridge`, `crate::vm::server_form::{ServerFormVm, ServerInput}`, `crate::vm::app_state::save_failed_hint`; add the field `server_form: RefCell<Option<ServerFormVm>>,` (init `RefCell::new(None)`). Replace `open_server_form` and add:

```rust
    pub fn open_server_form(&self, editing: Option<Uuid>) {
        let vm = {
            let s = self.state.borrow();
            match editing.and_then(|id| s.profiles.get(id)) {
                Some(m) => ServerFormVm::edit(m, s.has_saved_password(m.id), &s.keys),
                None => ServerFormVm::add(),
            }
        };
        self.push_server_form(&vm, true);
        *self.server_form.borrow_mut() = Some(vm);
        self.router.go(Page::ServerForm { editing });
        self.refresh_router();
    }

    fn push_server_form(&self, vm: &ServerFormVm, with_fields: bool) {
        let b = self.ui.global::<ServerFormBridge>();
        if with_fields {
            let keys = &self.state.borrow().keys;
            b.set_title(vm.title().into());
            b.set_save_label(vm.save_label().into());
            b.set_name(vm.form.name.as_str().into());
            b.set_host(vm.form.host.as_str().into());
            b.set_port(vm.form.port.as_str().into());
            b.set_user(vm.form.user.as_str().into());
            b.set_password(SharedString::new());
            b.set_auth(vm.segment());
            let names: Vec<SharedString> = ServerFormVm::key_names(keys).into_iter().map(Into::into).collect();
            b.set_key_names(ModelRc::new(VecModel::from(names)));
            b.set_key_index(vm.key_index(keys));
            b.set_password_placeholder(vm.password_placeholder().into());
        }
        b.set_hint(vm.hint().into());
        b.set_can_save(vm.can_save());
    }

    fn server_form_edited(&self) {
        let b = self.ui.global::<ServerFormBridge>();
        let input = ServerInput {
            name: b.get_name().into(),
            host: b.get_host().into(),
            port: b.get_port().into(),
            user: b.get_user().into(),
            segment: b.get_auth(),
            key_index: b.get_key_index(),
            password: b.get_password().into(),
        };
        let mut slot = self.server_form.borrow_mut();
        let Some(vm) = slot.as_mut() else { return };
        vm.apply(input, &self.state.borrow().keys);
        self.push_server_form(vm, false);
    }

    fn save_server_form(&self) {
        let mut slot = self.server_form.borrow_mut();
        let Some(vm) = slot.as_mut() else { return };
        if !vm.can_save() {
            return;
        }
        let result = self.state.borrow_mut().save_server(vm.editing, &vm.form);
        match result {
            Ok(_) => {
                *slot = None;
                drop(slot);
                self.forget_form_secrets();
                self.home_tab.set(HomeTab::Machines);
                self.router.back();
                self.refresh_router();
                self.refresh_home();
            }
            Err(e) => {
                vm.error = Some(save_failed_hint(&e));
                self.push_server_form(vm, false);
            }
        }
    }

    /// A typed password never outlives the form in a UI property.
    pub fn forget_form_secrets(&self) {
        self.ui.global::<ServerFormBridge>().set_password(SharedString::new());
        self.server_form.borrow_mut().take();
    }
```

Append to `install`:

```rust
        let form = self.ui.global::<ServerFormBridge>();
        form.on_edited(on(self, |app| app.server_form_edited()));
        form.on_save(on(self, |app| app.save_server_form()));
```

In the Task 3 `on_back` and `on_escape` closures, call `app.forget_form_secrets()` before `app.router.back()` / `app.router.on_escape()` when `matches!(app.router.current(), Page::ServerForm { .. })`.

- [ ] **Step 7: Check it**

Run: `cargo run -p tether-app`:
1. `+` (on either tab) opens "Add a server" with Back; Save server is quiet and the hint reads "Name this machine to save it". Filling Name → "Add a host to save it"; Host → "Add a user to save it"; User → "Choose a key to save it" (empty vault: the line "No keys in the vault — generate or paste one first." shows in place of the picker).
2. SSH agent: the agent line shows and Save server lights up. Password: a concealed field; hint "Enter a password to save it" until typed.
3. Port `70000` saves as 22; Host `  example.org ` saves trimmed (open Edit to see).
4. Esc returns to Home. Save → Home shows the card.
5. Right-click the card → Edit: title "Edit server", button **Save changes**, the password field empty with "Leave empty to keep the saved password" for a password machine.

- [ ] **Step 8: Lint and commit**

Run: `cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings && cargo test -p tether-app`

```bash
git add clients/windows/crates/tether-app
git commit -m "feat(windows): add and edit server form

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Generate, import, and paste keys

**Files:**
- Create: `src/vm/key_forms.rs`
- Modify: `src/vm/mod.rs`, `ui/bridge.slint`, `ui/forms.slint`, `ui/app.slint`, `src/app.rs`
- Test: `src/vm/key_forms.rs` (colocated)

**Interfaces:**
- Consumes: `KeyForm::hint`, `generate_hint`, `KeyOrigin`, `AppState::{generate_key, save_imported_key}`, `unix_now`, `save_failed_hint`.
- Produces:
  - `pub const MAX_KEY_FILE: u64 = 64 * 1024;`
  - `pub struct LoadedKeyFile { pub private: String, pub name: Option<String>, pub public: Option<String> }`, `pub fn load_key_file(path: &Path) -> Option<LoadedKeyFile>`, `pub fn apply_loaded(form: &mut KeyForm, loaded: LoadedKeyFile)`
  - `pub struct GenerateVm { pub name: String, pub error: Option<String> }` with `hint(&self) -> String`, `can_save(&self) -> bool`
  - `pub struct KeyMaterialVm { pub origin: KeyOrigin, pub form: KeyForm, pub error: Option<String> }` with `new(origin: KeyOrigin) -> Self`, `title(&self) -> &'static str`, `show_file_button(&self) -> bool`, `apply(&mut self, name: String, private: String, public: String)`, `hint(&self) -> String`, `can_save(&self) -> bool`
  - Slint global `KeyFormBridge`, components `KeyGeneratePage`, `KeyMaterialPage`.

- [ ] **Step 1: Write the failing tests**

Add `pub mod key_forms;` to `src/vm/mod.rs`.

`src/vm/key_forms.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn loading_fills_private_name_and_sibling_pub() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("id_ed25519");
        fs::write(&path, "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n").unwrap();
        fs::write(dir.path().join("id_ed25519.pub"), "ssh-ed25519 AAAA me@pc\n").unwrap();
        let loaded = load_key_file(&path).unwrap();
        assert!(loaded.private.contains("OPENSSH PRIVATE KEY"));
        assert_eq!(loaded.name.as_deref(), Some("id_ed25519"));
        assert_eq!(loaded.public.as_deref(), Some("ssh-ed25519 AAAA me@pc"));
    }

    #[test]
    fn base_name_drops_the_extension_and_pub_is_optional() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("work.pem");
        fs::write(&path, "-----BEGIN RSA PRIVATE KEY-----\n").unwrap();
        let loaded = load_key_file(&path).unwrap();
        assert_eq!(loaded.name.as_deref(), Some("work"));
        assert_eq!(loaded.public, None);
    }

    #[test]
    fn huge_or_binary_files_load_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let big = dir.path().join("disk.iso");
        fs::write(&big, vec![b'a'; MAX_KEY_FILE as usize + 1]).unwrap();
        assert!(load_key_file(&big).is_none());
        let binary = dir.path().join("key.ppk");
        fs::write(&binary, [0xFF, 0xFE, 0x00, 0x9F]).unwrap();
        assert!(load_key_file(&binary).is_none());
        assert!(load_key_file(dir.path()).is_none());
    }

    #[test]
    fn apply_loaded_keeps_a_typed_name() {
        let mut form = KeyForm { name: "laptop".into(), private: String::new(), public: "old".into() };
        apply_loaded(&mut form, LoadedKeyFile { private: "P".into(), name: Some("id_rsa".into()), public: Some("ssh-rsa X".into()) });
        assert_eq!((form.name.as_str(), form.private.as_str(), form.public.as_str()), ("laptop", "P", "ssh-rsa X"));
        let mut blank = KeyForm { name: "  ".into(), private: String::new(), public: "kept".into() };
        apply_loaded(&mut blank, LoadedKeyFile { private: "P".into(), name: Some("id_rsa".into()), public: None });
        assert_eq!((blank.name.as_str(), blank.public.as_str()), ("id_rsa", "kept"));
    }

    #[test]
    fn generate_needs_a_name() {
        let mut vm = GenerateVm::default();
        assert_eq!(vm.hint(), "Name this key to save it");
        assert!(!vm.can_save());
        vm.name = "desktop".into();
        assert!(vm.can_save());
        assert_eq!(vm.hint(), "");
    }

    #[test]
    fn import_and_paste_titles_and_file_button() {
        let import = KeyMaterialVm::new(KeyOrigin::Imported);
        assert_eq!(import.title(), "Import key");
        assert!(import.show_file_button());
        let paste = KeyMaterialVm::new(KeyOrigin::Pasted);
        assert_eq!(paste.title(), "Paste key");
        assert!(!paste.show_file_button());
        assert_eq!(paste.hint(), "Name this key to save it");
    }

    #[test]
    fn hints_walk_the_form_in_order() {
        let mut vm = KeyMaterialVm::new(KeyOrigin::Pasted);
        vm.apply("work".into(), String::new(), String::new());
        assert_eq!(vm.hint(), "Paste the private key to save it");
        vm.apply("work".into(), "-----BEGIN PRIVATE KEY-----".into(), "nope".into());
        assert_eq!(vm.hint(), "Paste the public key to save it");
        vm.error = Some("Couldn't save: x".into());
        assert_eq!(vm.hint(), "Couldn't save: x");
        vm.apply("work".into(), "-----BEGIN PRIVATE KEY-----".into(), "nope".into());
        assert_eq!(vm.hint(), "Paste the public key to save it");
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p tether-app key_forms`
Expected: FAIL — unresolved names.

- [ ] **Step 3: Implement**

Prepend to `src/vm/key_forms.rs`:

```rust
use std::{
    fs::File,
    io::Read,
    path::{Path, PathBuf},
};

use tether_core::{KeyForm, KeyOrigin, generate_hint};

/// A private key is a few KB; anything bigger is the wrong file and is never read whole.
pub const MAX_KEY_FILE: u64 = 64 * 1024;

pub struct LoadedKeyFile {
    pub private: String,
    pub name: Option<String>,
    pub public: Option<String>,
}

fn read_small_text(path: &Path) -> Option<String> {
    let file = File::open(path).ok()?;
    if !file.metadata().ok()?.is_file() {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(MAX_KEY_FILE + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() as u64 > MAX_KEY_FILE {
        return None;
    }
    String::from_utf8(bytes).ok()
}

pub fn load_key_file(path: &Path) -> Option<LoadedKeyFile> {
    let private = read_small_text(path)?;
    let mut pub_path = path.as_os_str().to_owned();
    pub_path.push(".pub");
    let public = read_small_text(&PathBuf::from(pub_path)).map(|s| s.trim().to_owned());
    let name = path.file_stem().map(|s| s.to_string_lossy().into_owned());
    Some(LoadedKeyFile { private, name, public })
}

pub fn apply_loaded(form: &mut KeyForm, loaded: LoadedKeyFile) {
    form.private = loaded.private;
    if form.name.trim().is_empty() {
        if let Some(name) = loaded.name {
            form.name = name;
        }
    }
    if let Some(public) = loaded.public {
        form.public = public;
    }
}

#[derive(Default)]
pub struct GenerateVm {
    pub name: String,
    pub error: Option<String>,
}

impl GenerateVm {
    pub fn hint(&self) -> String {
        self.error.clone().or_else(|| generate_hint(&self.name).map(str::to_owned)).unwrap_or_default()
    }

    pub fn can_save(&self) -> bool {
        generate_hint(&self.name).is_none()
    }
}

pub struct KeyMaterialVm {
    pub origin: KeyOrigin,
    pub form: KeyForm,
    pub error: Option<String>,
}

impl KeyMaterialVm {
    pub fn new(origin: KeyOrigin) -> Self {
        Self { origin, form: KeyForm { name: String::new(), private: String::new(), public: String::new() }, error: None }
    }

    pub fn title(&self) -> &'static str {
        if self.origin == KeyOrigin::Imported { "Import key" } else { "Paste key" }
    }

    pub fn show_file_button(&self) -> bool {
        self.origin == KeyOrigin::Imported
    }

    pub fn apply(&mut self, name: String, private: String, public: String) {
        self.form = KeyForm { name, private, public };
        self.error = None;
    }

    pub fn hint(&self) -> String {
        self.error.clone().or_else(|| self.form.hint().map(str::to_owned)).unwrap_or_default()
    }

    pub fn can_save(&self) -> bool {
        self.form.hint().is_none()
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p tether-app key_forms`
Expected: PASS (7 tests).

- [ ] **Step 5: Add the bridge and the pages**

Append to `ui/bridge.slint`:

```slint
export global KeyFormBridge {
    in property <string> title;
    in property <bool> show-file-button;
    in-out property <string> name;
    in-out property <string> private-key;
    in-out property <string> public-key;
    in property <string> hint;
    in property <bool> can-save;
    callback edited();
    callback load-file();
    callback save();
    in-out property <string> gen-name;
    in property <string> gen-hint;
    in property <bool> gen-can-save;
    callback gen-edited();
    callback generate();
}
```

Append to `ui/forms.slint` (and add `KeyFormBridge` to its bridge import, `AreaField, SecondaryButton` to its components import):

```slint
export component KeyGeneratePage inherits PageChrome {
    title: "Generate key";
    back => { AppBridge.back(); }
    VerticalLayout {
        alignment: start;
        spacing: 12px;
        Field {
            label: "Name";
            placeholder: "phone";
            text <=> KeyFormBridge.gen-name;
            edited => { KeyFormBridge.gen-edited(); }
        }
        Text {
            text: "A new ed25519 key is created on this PC. Only its public half is shown — paste that into the host's authorized_keys.";
            wrap: word-wrap;
            font-family: Tokens.mono-font;
            font-size: 12px;
            color: Tokens.text-faint;
        }
        PrimaryButton { text: "Generate key"; enabled: KeyFormBridge.gen-can-save; clicked => { KeyFormBridge.generate(); } }
        if KeyFormBridge.gen-hint != "": Hint { text: KeyFormBridge.gen-hint; }
    }
}

export component KeyMaterialPage inherits PageChrome {
    title: KeyFormBridge.title;
    back => { AppBridge.back(); }
    scroll := ScrollView {
        viewport-width: self.visible-width;
        viewport-height: col.preferred-height;
        col := VerticalLayout {
            width: scroll.visible-width;
            spacing: 12px;
            padding-bottom: 28px;
            Field { label: "Name"; text <=> KeyFormBridge.name; edited => { KeyFormBridge.edited(); } }
            if KeyFormBridge.show-file-button: SecondaryButton {
                text: "Load private key file…";
                clicked => { KeyFormBridge.load-file(); }
            }
            AreaField {
                label: "Private key (PEM)";
                placeholder: "-----BEGIN PRIVATE KEY-----";
                text <=> KeyFormBridge.private-key;
                edited => { KeyFormBridge.edited(); }
            }
            AreaField {
                label: "Public key (OpenSSH)";
                placeholder: "ssh-ed25519 AAAA…";
                text <=> KeyFormBridge.public-key;
                edited => { KeyFormBridge.edited(); }
            }
            PrimaryButton { text: "Save key"; enabled: KeyFormBridge.can-save; clicked => { KeyFormBridge.save(); } }
            if KeyFormBridge.hint != "": Hint { text: KeyFormBridge.hint; }
        }
    }
}
```

In `ui/app.slint`: import `KeyGeneratePage, KeyMaterialPage` from `forms.slint`, export `KeyFormBridge`, and insert before the dialog:

```slint
        if AppBridge.page == PageKind.key-generate: KeyGeneratePage { }
        if AppBridge.page == PageKind.key-import || AppBridge.page == PageKind.key-paste: KeyMaterialPage { }
```

- [ ] **Step 6: Wire it**

In `src/app.rs` add imports `crate::KeyFormBridge`, `crate::vm::key_forms::{self, GenerateVm, KeyMaterialVm}`, `crate::vm::app_state::unix_now`, `tether_core::KeyOrigin`; add fields `generate: RefCell<GenerateVm>,` and `key_material: RefCell<Option<KeyMaterialVm>>,` (init `RefCell::new(GenerateVm::default())`, `RefCell::new(None)`). Replace `open_key_page` and add:

```rust
    pub fn open_key_page(&self, page: Page) {
        let b = self.ui.global::<KeyFormBridge>();
        match page {
            Page::KeyGenerate => {
                *self.generate.borrow_mut() = GenerateVm::default();
                b.set_gen_name(SharedString::new());
                self.push_generate();
            }
            Page::KeyImport | Page::KeyPaste => {
                let origin = if page == Page::KeyImport { KeyOrigin::Imported } else { KeyOrigin::Pasted };
                let vm = KeyMaterialVm::new(origin);
                b.set_title(vm.title().into());
                b.set_show_file_button(vm.show_file_button());
                self.push_key_material(&vm, true);
                *self.key_material.borrow_mut() = Some(vm);
            }
            _ => {}
        }
        self.router.go(page);
        self.refresh_router();
    }

    fn push_generate(&self) {
        let vm = self.generate.borrow();
        let b = self.ui.global::<KeyFormBridge>();
        b.set_gen_hint(vm.hint().into());
        b.set_gen_can_save(vm.can_save());
    }

    fn push_key_material(&self, vm: &KeyMaterialVm, with_fields: bool) {
        let b = self.ui.global::<KeyFormBridge>();
        if with_fields {
            b.set_name(vm.form.name.as_str().into());
            b.set_private_key(vm.form.private.as_str().into());
            b.set_public_key(vm.form.public.as_str().into());
        }
        b.set_hint(vm.hint().into());
        b.set_can_save(vm.can_save());
    }

    fn key_material_edited(&self) {
        let b = self.ui.global::<KeyFormBridge>();
        let mut slot = self.key_material.borrow_mut();
        let Some(vm) = slot.as_mut() else { return };
        vm.apply(b.get_name().into(), b.get_private_key().into(), b.get_public_key().into());
        self.push_key_material(vm, false);
    }

    fn pick_key_file(self: &Rc<Self>) {
        let weak = Rc::downgrade(self);
        // The async dialog runs off the event loop, so winit is never re-entered.
        slint::spawn_local(async move {
            let Some(app) = weak.upgrade() else { return };
            let mut dialog = rfd::AsyncFileDialog::new().set_title("Load private key file");
            if let Ok(window) = app.ui.window().winit_window().await {
                dialog = dialog.set_parent(window.as_ref());
            }
            let Some(file) = dialog.pick_file().await else { return };
            let Some(loaded) = key_forms::load_key_file(file.path()) else { return };
            let mut slot = app.key_material.borrow_mut();
            let Some(vm) = slot.as_mut() else { return };
            key_forms::apply_loaded(&mut vm.form, loaded);
            vm.error = None;
            app.push_key_material(vm, true);
        })
        .ok();
    }

    fn finish_key_save(&self, result: Result<Uuid, crate::vm::app_state::AppError>) -> Option<String> {
        match result {
            Ok(_) => {
                self.ui.global::<KeyFormBridge>().set_private_key(SharedString::new());
                self.key_material.borrow_mut().take();
                self.home_tab.set(HomeTab::Keys);
                self.router.back();
                self.refresh_router();
                self.refresh_home();
                None
            }
            Err(e) => Some(save_failed_hint(&e)),
        }
    }

    fn generate_key(&self) {
        if !self.generate.borrow().can_save() {
            return;
        }
        let name = self.generate.borrow().name.clone();
        let result = self.state.borrow_mut().generate_key(&name, unix_now());
        if let Some(error) = self.finish_key_save(result) {
            self.generate.borrow_mut().error = Some(error);
            self.push_generate();
        }
    }

    fn save_key_material(&self) {
        let (form, origin) = {
            let slot = self.key_material.borrow();
            let Some(vm) = slot.as_ref().filter(|vm| vm.can_save()) else { return };
            (vm.form.clone(), vm.origin)
        };
        let result = self.state.borrow_mut().save_imported_key(&form, origin, unix_now());
        if let Some(error) = self.finish_key_save(result) {
            if let Some(vm) = self.key_material.borrow_mut().as_mut() {
                vm.error = Some(error);
                self.push_key_material(vm, false);
            }
        }
    }
```

Append to `install`:

```rust
        let keyform = self.ui.global::<KeyFormBridge>();
        let weak = Rc::downgrade(self);
        keyform.on_gen_edited(move || {
            if let Some(app) = weak.upgrade() {
                let name = app.ui.global::<KeyFormBridge>().get_gen_name().to_string();
                *app.generate.borrow_mut() = GenerateVm { name, error: None };
                app.push_generate();
            }
        });
        keyform.on_generate(on(self, |app| app.generate_key()));
        keyform.on_edited(on(self, |app| app.key_material_edited()));
        keyform.on_load_file(on(self, |app| app.pick_key_file()));
        keyform.on_save(on(self, |app| app.save_key_material()));
```

`KeyForm` derives `Clone` in M1; if it does not, build the copy field by field.

- [ ] **Step 7: Check it**

Run: `cargo run -p tether-app`, Keys tab:
1. **Generate** → "Generate key" page, hint "Name this key to save it"; type `desktop` → **Generate key** → back on Keys: a card with randomart, `generated`, `ssh-ed25519 · created <today>`, a shortened `SHA256:` fingerprint, `not used yet`. **Copy public key**, then paste into Notepad: one `ssh-ed25519 …` line.
2. **Import** → **Load private key file…** → pick `%USERPROFILE%\.ssh\id_ed25519` (or a fixture from `crates/tether-core/fixtures/keys/`): the PEM, the name `id_ed25519` and the public line fill in; **Save key** → card with `imported`.
3. Load an encrypted key (`fixtures/keys/ed25519_encrypted`): hint "This key needs a passphrase — Tether can't use it yet".
4. Pick a large non-key file (e.g. a 100 MB video): nothing changes, the UI stays responsive.
5. **Paste**: no file button; hints walk Name → private → public → mismatch ("The public key doesn't match the private key") as fields change.
6. Delete key: right-click a card → "Delete key …?" with the erase line; if a machine uses it, the second line names it. Confirm → card gone; that machine's card shows `· key missing`. Press Delete on a focused card → same dialog.

- [ ] **Step 8: Lint and commit**

Run: `cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings && cargo test -p tether-app`

```bash
git add clients/windows/crates/tether-app
git commit -m "feat(windows): generate, import, and paste keys

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Settings page

**Files:**
- Create: `src/vm/settings.rs`, `ui/settings.slint`
- Modify: `src/vm/mod.rs`, `ui/bridge.slint`, `ui/app.slint`, `src/app.rs`
- Test: `src/vm/settings.rs` (colocated)

**Interfaces:**
- Consumes: `ThemeMode`, `CursorShape`, `TerminalPrefs::{clamped, bigger, smaller}`, `theme_named`, `font_named`, `AppState::save_prefs`.
- Produces:
  - `vm::settings::{theme_index(ThemeMode) -> i32, theme_from_index(i32) -> ThemeMode, cursor_index(CursorShape) -> i32, cursor_from_index(i32) -> CursorShape, size_label(&TerminalPrefs) -> String, spacing_label(&TerminalPrefs) -> String, padding_label(&TerminalPrefs) -> String, scheme_label(&TerminalPrefs) -> String, font_label(&TerminalPrefs) -> &'static str, step_size(&mut TerminalPrefs, i32), set_spacing(&mut TerminalPrefs, f32), step_padding(&mut TerminalPrefs, i32)}`
  - Slint global `SettingsBridge`, component `SettingsPage`.
  - `App::{refresh_settings(&self), update_terminal_prefs(&self, f: impl FnOnce(&mut TerminalPrefs))}`; `on_prefs_changed` now also refreshes Settings.

- [ ] **Step 1: Write the failing tests**

Add `pub mod settings;` to `src/vm/mod.rs`.

`src/vm/settings.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use tether_core::Preferences;

    fn prefs() -> TerminalPrefs {
        Preferences::default().terminal
    }

    #[test]
    fn default_labels() {
        let p = prefs();
        assert_eq!(size_label(&p), "14 pt");
        assert_eq!(spacing_label(&p), "1.00×");
        assert_eq!(padding_label(&p), "8 pt");
        assert_eq!(scheme_label(&p), "Tether");
        assert_eq!(font_label(&p), "Cascadia Mono");
    }

    #[test]
    fn size_steps_by_one_and_stops_at_the_ends() {
        let mut p = prefs();
        step_size(&mut p, 1);
        assert_eq!(size_label(&p), "15 pt");
        p.size_pt = 24.0;
        step_size(&mut p, 1);
        assert_eq!(p.size_pt, 24.0);
        p.size_pt = 8.0;
        step_size(&mut p, -1);
        assert_eq!(p.size_pt, 8.0);
    }

    #[test]
    fn spacing_snaps_to_twentieths_and_clamps() {
        let mut p = prefs();
        set_spacing(&mut p, 1.234);
        assert_eq!(spacing_label(&p), "1.25×");
        set_spacing(&mut p, 1.7);
        assert_eq!(spacing_label(&p), "1.60×");
        set_spacing(&mut p, 0.9);
        assert_eq!(spacing_label(&p), "1.00×");
    }

    #[test]
    fn padding_steps_by_two_and_clamps() {
        let mut p = prefs();
        step_padding(&mut p, 1);
        assert_eq!(padding_label(&p), "10 pt");
        p.padding_pt = 24.0;
        step_padding(&mut p, 1);
        assert_eq!(p.padding_pt, 24.0);
        p.padding_pt = 0.0;
        step_padding(&mut p, -1);
        assert_eq!(p.padding_pt, 0.0);
    }

    #[test]
    fn unknown_ids_label_as_the_fallbacks() {
        let mut p = prefs();
        p.scheme = "gone".into();
        p.font = "menlo".into();
        assert_eq!(scheme_label(&p), "Tether");
        assert_eq!(font_label(&p), "Cascadia Mono");
    }

    #[test]
    fn segment_indices_round_trip() {
        for m in [ThemeMode::System, ThemeMode::Dark, ThemeMode::Light] {
            assert_eq!(theme_from_index(theme_index(m)), m);
        }
        for c in [CursorShape::Block, CursorShape::Bar, CursorShape::Underline] {
            assert_eq!(cursor_from_index(cursor_index(c)), c);
        }
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p tether-app vm::settings`
Expected: FAIL — unresolved names.

- [ ] **Step 3: Implement**

Prepend to `src/vm/settings.rs`:

```rust
use tether_core::{CursorShape, TerminalPrefs, ThemeMode, font_named, theme_named};

pub fn theme_index(mode: ThemeMode) -> i32 {
    match mode {
        ThemeMode::System => 0,
        ThemeMode::Dark => 1,
        ThemeMode::Light => 2,
    }
}

pub fn theme_from_index(i: i32) -> ThemeMode {
    match i {
        1 => ThemeMode::Dark,
        2 => ThemeMode::Light,
        _ => ThemeMode::System,
    }
}

pub fn cursor_index(shape: CursorShape) -> i32 {
    match shape {
        CursorShape::Block => 0,
        CursorShape::Bar => 1,
        CursorShape::Underline => 2,
    }
}

pub fn cursor_from_index(i: i32) -> CursorShape {
    match i {
        1 => CursorShape::Bar,
        2 => CursorShape::Underline,
        _ => CursorShape::Block,
    }
}

pub fn size_label(p: &TerminalPrefs) -> String {
    format!("{} pt", p.size_pt.round() as i32)
}

pub fn spacing_label(p: &TerminalPrefs) -> String {
    format!("{:.2}×", p.line_spacing)
}

pub fn padding_label(p: &TerminalPrefs) -> String {
    format!("{} pt", p.padding_pt.round() as i32)
}

pub fn scheme_label(p: &TerminalPrefs) -> String {
    theme_named(&p.scheme).name.clone()
}

pub fn font_label(p: &TerminalPrefs) -> &'static str {
    font_named(&p.font).name
}

pub fn step_size(p: &mut TerminalPrefs, delta: i32) {
    if delta > 0 {
        p.bigger();
    } else if delta < 0 {
        p.smaller();
    }
}

pub fn set_spacing(p: &mut TerminalPrefs, raw: f32) {
    p.line_spacing = (raw * 20.0).round() / 20.0;
    *p = p.clone().clamped();
}

pub fn step_padding(p: &mut TerminalPrefs, delta: i32) {
    p.padding_pt += 2.0 * delta as f32;
    *p = p.clone().clamped();
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p tether-app vm::settings`
Expected: PASS (6 tests).

- [ ] **Step 5: Add the bridge and the page**

Append to `ui/bridge.slint`:

```slint
export global SettingsBridge {
    in-out property <int> theme-mode;
    in property <string> scheme-name;
    in property <string> font-name;
    in property <string> size-label;
    in property <string> spacing-label;
    in property <string> padding-label;
    in-out property <float> spacing: 1.0;
    in-out property <int> cursor;
    in-out property <bool> blink;
    in property <image> preview;
    in property <color> preview-background: #1e1e2e;
    callback theme-mode-changed(int);
    callback size-step(int);
    callback spacing-changed(float);
    callback padding-step(int);
    callback cursor-changed(int);
    callback blink-changed(bool);
    callback open-schemes();
    callback open-fonts();
}
```

`ui/settings.slint`:

```slint
import { ScrollView, Slider, Switch } from "std-widgets.slint";
import { Tokens } from "tokens.slint";
import { AppBridge, SettingsBridge } from "bridge.slint";
import { PageChrome, Segment } from "components.slint";

component Section inherits Text {
    font-size: 12px;
    font-weight: 650;
    color: Tokens.text-faint;
}

component Label inherits Text {
    font-size: 12px;
    font-weight: 600;
    color: Tokens.text-secondary;
}

component Row inherits Rectangle {
    in property <string> label;
    height: 50px;
    Rectangle { y: parent.height - 1px; height: 1px; background: Tokens.border; }
    HorizontalLayout {
        spacing: 12px;
        Text { text: root.label; font-weight: 600; color: Tokens.text; vertical-alignment: center; }
        Rectangle { horizontal-stretch: 1; }
        @children
    }
}

component Value inherits Text {
    font-family: Tokens.mono-font;
    font-size: 13px;
    color: Tokens.text-secondary;
    vertical-alignment: center;
}

component SmallButton inherits Rectangle {
    in property <string> text;
    callback clicked();
    width: 28px;
    height: 28px;
    border-radius: 8px;
    border-width: focus.has-focus ? 2px : 1px;
    border-color: focus.has-focus ? Tokens.accent : Tokens.border;
    background: touch.has-hover ? Tokens.raised.brighter(0.15) : Tokens.raised;
    focus := FocusScope {
        key-pressed(event) => {
            if (event.text == Key.Return || event.text == " ") { root.clicked(); return accept; }
            reject
        }
    }
    touch := TouchArea { mouse-cursor: pointer; clicked => { focus.focus(); root.clicked(); } }
    Text { width: 100%; height: 100%; text: root.text; color: Tokens.text; horizontal-alignment: center; vertical-alignment: center; }
}

component LinkRow inherits Row {
    in property <string> value;
    callback clicked();
    TouchArea { mouse-cursor: pointer; clicked => { root.clicked(); } }
    Value { text: root.value; }
    Text { text: "›"; color: Tokens.text-faint; vertical-alignment: center; }
}

component StepperRow inherits Row {
    in property <string> value;
    callback step(int);
    Value { text: root.value; }
    VerticalLayout { alignment: center; SmallButton { text: "−"; clicked => { root.step(-1); } } }
    VerticalLayout { alignment: center; SmallButton { text: "+"; clicked => { root.step(1); } } }
}

component SettingsForm inherits VerticalLayout {
    Section { text: "Appearance"; }
    VerticalLayout {
        spacing: 5px;
        padding-top: 8px;
        padding-bottom: 16px;
        Label { text: "Theme"; }
        Segment {
            options: ["System", "Dark", "Light"];
            selected <=> SettingsBridge.theme-mode;
            changed(i) => { SettingsBridge.theme-mode-changed(i); }
        }
    }
    Section { text: "Terminal"; }
    LinkRow { label: "Color scheme"; value: SettingsBridge.scheme-name; clicked => { SettingsBridge.open-schemes(); } }
    LinkRow { label: "Font"; value: SettingsBridge.font-name; clicked => { SettingsBridge.open-fonts(); } }
    StepperRow { label: "Size"; value: SettingsBridge.size-label; step(d) => { SettingsBridge.size-step(d); } }
    Row {
        label: "Line spacing";
        Value { text: SettingsBridge.spacing-label; }
        Slider {
            width: 140px;
            minimum: 1.0;
            maximum: 1.6;
            value <=> SettingsBridge.spacing;
            changed(v) => { SettingsBridge.spacing-changed(v); }
        }
    }
    StepperRow { label: "Padding"; value: SettingsBridge.padding-label; step(d) => { SettingsBridge.padding-step(d); } }
    VerticalLayout {
        spacing: 5px;
        padding-top: 12px;
        padding-bottom: 4px;
        Label { text: "Cursor"; }
        Segment {
            options: ["Block", "Bar", "Underline"];
            selected <=> SettingsBridge.cursor;
            changed(i) => { SettingsBridge.cursor-changed(i); }
        }
    }
    Row {
        label: "Blink cursor";
        Switch { checked <=> SettingsBridge.blink; toggled => { SettingsBridge.blink-changed(self.checked); } }
    }
}

// The image is drawn at physical pixel size so the preview's glyphs are the terminal's glyphs.
component PreviewBox inherits Rectangle {
    width: img.width;
    height: img.height;
    background: SettingsBridge.preview-background;
    border-radius: 10px;
    clip: true;
    img := Image {
        source: SettingsBridge.preview;
        width: self.source.width * 1phx;
        height: self.source.height * 1phx;
        image-rendering: pixelated;
    }
}

export component SettingsPage inherits PageChrome {
    title: "Settings";
    column-width: 860px;
    back => { AppBridge.back(); }
    scroll := ScrollView {
        viewport-width: self.visible-width;
        viewport-height: col.preferred-height;
        col := VerticalLayout {
            width: scroll.visible-width;
            padding-bottom: 24px;
            if root.width >= 800px: HorizontalLayout {
                spacing: 28px;
                SettingsForm { horizontal-stretch: 1; }
                VerticalLayout { alignment: start; padding-top: 28px; PreviewBox { } }
            }
            if root.width < 800px: VerticalLayout {
                spacing: 8px;
                SettingsForm { }
                HorizontalLayout { alignment: start; PreviewBox { } }
            }
        }
    }
}
```

In `ui/app.slint`: import `SettingsPage` from `settings.slint`, export `SettingsBridge`, and insert before the dialog:

```slint
        if AppBridge.page == PageKind.settings: SettingsPage { }
```

- [ ] **Step 6: Wire it**

In `src/app.rs` add imports `crate::SettingsBridge`, `crate::vm::settings`, `tether_core::TerminalPrefs`. Add:

```rust
    pub fn refresh_settings(&self) {
        let prefs = self.state.borrow().prefs.clone();
        let t = &prefs.terminal;
        let b = self.ui.global::<SettingsBridge>();
        b.set_theme_mode(settings::theme_index(prefs.theme_mode));
        b.set_scheme_name(settings::scheme_label(t).into());
        b.set_font_name(settings::font_label(t).into());
        b.set_size_label(settings::size_label(t).into());
        b.set_spacing_label(settings::spacing_label(t).into());
        b.set_padding_label(settings::padding_label(t).into());
        b.set_spacing(t.line_spacing);
        b.set_cursor(settings::cursor_index(t.cursor));
        b.set_blink(t.blink);
    }

    pub fn update_terminal_prefs(&self, f: impl FnOnce(&mut TerminalPrefs)) {
        f(&mut self.state.borrow_mut().prefs.terminal);
        self.on_prefs_changed();
    }
```

Replace `open_settings` and `on_prefs_changed`:

```rust
    pub fn open_settings(&self) {
        self.refresh_settings();
        self.router.go(Page::Settings);
        self.refresh_router();
    }

    /// M6 extends this to restyle the live tabs.
    pub fn on_prefs_changed(&self) {
        self.state.borrow().save_prefs();
        self.refresh_scene();
        self.refresh_settings();
    }
```

Append to `install`:

```rust
        let s = self.ui.global::<SettingsBridge>();
        let weak = Rc::downgrade(self);
        s.on_theme_mode_changed(move |i| {
            if let Some(app) = weak.upgrade() {
                app.state.borrow_mut().prefs.theme_mode = settings::theme_from_index(i);
                app.on_prefs_changed();
            }
        });
        let weak = Rc::downgrade(self);
        s.on_size_step(move |d| {
            if let Some(app) = weak.upgrade() {
                app.update_terminal_prefs(|t| settings::step_size(t, d));
            }
        });
        let weak = Rc::downgrade(self);
        s.on_spacing_changed(move |v| {
            if let Some(app) = weak.upgrade() {
                app.update_terminal_prefs(|t| settings::set_spacing(t, v));
            }
        });
        let weak = Rc::downgrade(self);
        s.on_padding_step(move |d| {
            if let Some(app) = weak.upgrade() {
                app.update_terminal_prefs(|t| settings::step_padding(t, d));
            }
        });
        let weak = Rc::downgrade(self);
        s.on_cursor_changed(move |i| {
            if let Some(app) = weak.upgrade() {
                app.update_terminal_prefs(|t| t.cursor = settings::cursor_from_index(i));
            }
        });
        let weak = Rc::downgrade(self);
        s.on_blink_changed(move |on| {
            if let Some(app) = weak.upgrade() {
                app.update_terminal_prefs(|t| t.blink = on);
            }
        });
        s.on_open_schemes(on(self, |app| {
            app.router.go(Page::SchemePicker);
            app.refresh_router();
        }));
        s.on_open_fonts(on(self, |app| {
            app.router.go(Page::FontPicker);
            app.refresh_router();
        }));
```

`Preferences` and `TerminalPrefs` derive `Clone` in M1.

- [ ] **Step 7: Check it**

Run: `cargo run -p tether-app`, gear on Home:
1. "Settings" with Back; Appearance → Theme segment (System / Dark / Light); Terminal → Color scheme `Tether ›`, Font `Cascadia Mono ›`, Size `14 pt` − +, Line spacing `1.00×` slider, Padding `8 pt` − +, Cursor segment, Blink cursor switch.
2. Dark → Light → System switch the whole window and the caption at once; the choice survives a restart.
3. Size − to 8 stops; + to 24 stops. Padding moves by 2 between 0 and 24. The slider lands on 0.05 steps.
4. Esc returns to Home.

- [ ] **Step 8: Lint and commit**

Run: `cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings && cargo test -p tether-app`

```bash
git add clients/windows/crates/tether-app
git commit -m "feat(windows): settings page with appearance and terminal controls

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Live terminal preview

**Files:**
- Create: `src/preview.rs`
- Modify: `src/main.rs`, `src/app.rs`
- Test: `src/preview.rs` (colocated)

**Interfaces:**
- Consumes: `tether_term::{TabTerminal, Rasterizer, RenderStyle, RgbaImage, cell_metrics, pt_to_px}`, `tether_core::resize::GridSize`, `theme_named`, `font_named`, `TerminalPrefs`.
- Produces:
  - `preview::{SAMPLE: &[u8], COLS: u16, ROWS: u16, geometry(prefs: &TerminalPrefs, scale: f32) -> GridSize, Preview}`; `Preview::new() -> Self`, `Preview::render(&mut self, prefs: &TerminalPrefs, scale: f32, cursor_on: bool) -> RgbaImage`.
  - `App::refresh_preview(&self)`; a 530 ms blink timer; `ScaleFactorChanged` arm in `on_winit_event`.

- [ ] **Step 1: Write the failing tests**

`src/preview.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use tether_core::Preferences;

    fn prefs() -> TerminalPrefs {
        Preferences::default().terminal
    }

    #[test]
    fn image_matches_the_geometry() {
        let p = prefs();
        let g = geometry(&p, 1.0);
        let img = Preview::new().render(&p, 1.0, true);
        assert_eq!((img.width, img.height), (g.width_px, g.height_px));
        assert_eq!((g.cols, g.rows), (COLS, ROWS));
    }

    #[test]
    fn padding_shows_the_theme_background() {
        let img = Preview::new().render(&prefs(), 1.0, true);
        assert_eq!(img.pixel(0, 0), [0x1E, 0x1E, 0x2E, 255]);
        let mut latte = prefs();
        latte.scheme = "catppuccin-latte".into();
        assert_eq!(Preview::new().render(&latte, 1.0, true).pixel(0, 0), [0xEF, 0xF1, 0xF5, 255]);
    }

    #[test]
    fn the_sample_text_is_drawn() {
        let img = Preview::new().render(&prefs(), 1.0, false);
        let bg = img.pixel(0, 0);
        let drawn = (0..img.height).flat_map(|y| (0..img.width).map(move |x| (x, y))).any(|(x, y)| img.pixel(x, y) != bg);
        assert!(drawn);
    }

    #[test]
    fn twice_the_scale_is_twice_the_size() {
        let p = prefs();
        let (one, two) = (geometry(&p, 1.0), geometry(&p, 2.0));
        assert!((two.width_px as i64 - 2 * one.width_px as i64).abs() <= 2);
        assert!((two.height_px as i64 - 2 * one.height_px as i64).abs() <= 2);
    }

    #[test]
    fn a_bigger_font_makes_a_bigger_preview() {
        let mut big = prefs();
        big.size_pt = 24.0;
        assert!(geometry(&big, 1.0).width_px > geometry(&prefs(), 1.0).width_px);
    }

    #[test]
    fn an_unknown_font_renders_with_the_fallback() {
        let mut p = prefs();
        p.font = "menlo".into();
        let img = Preview::new().render(&p, 1.0, true);
        assert_eq!((img.width, img.height), {
            let g = geometry(&prefs(), 1.0);
            (g.width_px, g.height_px)
        });
    }
}
```

Add `mod preview;` to `src/main.rs`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p tether-app preview`
Expected: FAIL — `cannot find function geometry`.

- [ ] **Step 3: Implement**

Prepend to `src/preview.rs`:

```rust
use tether_core::{TerminalPrefs, font_named, resize::GridSize, theme_named};
use tether_term::{Rasterizer, RenderStyle, RgbaImage, TabTerminal, cell_metrics, pt_to_px};

pub const SAMPLE: &[u8] = b"\x1b[32mme@devbox\x1b[0m \x1b[34m~\x1b[0m $ ls\r\nsrc  README.md\r\n\x1b[32mme@devbox\x1b[0m \x1b[34m~\x1b[0m $ ";
pub const COLS: u16 = 22;
pub const ROWS: u16 = 3;

pub fn geometry(prefs: &TerminalPrefs, scale: f32) -> GridSize {
    let font = font_named(&prefs.font);
    let (cell_w, cell_h) = cell_metrics(font, pt_to_px(prefs.size_pt, scale), prefs.line_spacing);
    let pad = pt_to_px(prefs.padding_pt, scale).round() as u32;
    GridSize {
        cols: COLS,
        rows: ROWS,
        width_px: (cell_w * f32::from(COLS)).ceil() as u32 + 2 * pad,
        height_px: (cell_h * f32::from(ROWS)).ceil() as u32 + 2 * pad,
    }
}

/// Not a PTY: a fixed sample fed through the same engine and rasterizer as a live tab.
pub struct Preview {
    rasterizer: Rasterizer,
}

impl Default for Preview {
    fn default() -> Self {
        Self::new()
    }
}

impl Preview {
    pub fn new() -> Self {
        Self { rasterizer: Rasterizer::new() }
    }

    pub fn render(&mut self, prefs: &TerminalPrefs, scale: f32, cursor_on: bool) -> RgbaImage {
        let theme = theme_named(&prefs.scheme);
        let size = geometry(prefs, scale);
        let mut term = TabTerminal::new(size, theme);
        term.feed(SAMPLE);
        let style = RenderStyle {
            theme,
            font: font_named(&prefs.font),
            size_px: pt_to_px(prefs.size_pt, scale),
            line_spacing: prefs.line_spacing,
            padding_px: pt_to_px(prefs.padding_pt, scale).round() as u32,
            cursor: prefs.cursor,
            cursor_on,
            hover_link: None,
        };
        self.rasterizer.render(&term.snapshot(), &style, size.width_px, size.height_px)
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p tether-app preview`
Expected: PASS (6 tests).

- [ ] **Step 5: Show it and blink it**

In `src/app.rs` add imports `crate::preview::Preview`, `tether_core::theme_named`, and fields:

```rust
    preview: RefCell<Preview>,
    cursor_on: Cell<bool>,
    blink_timer: slint::Timer,
```

initialized `RefCell::new(Preview::new())`, `Cell::new(true)`, `slint::Timer::default()`. Add:

```rust
    fn rgb(rgb: u32) -> slint::Color {
        slint::Color::from_rgb_u8((rgb >> 16) as u8, (rgb >> 8) as u8, rgb as u8)
    }

    pub fn refresh_preview(&self) {
        let prefs = self.state.borrow().prefs.terminal.clone();
        let scale = self.ui.window().scale_factor();
        let img = self.preview.borrow_mut().render(&prefs, scale, self.cursor_on.get());
        let b = self.ui.global::<SettingsBridge>();
        b.set_preview(slint::Image::from_rgba8(SharedPixelBuffer::clone_from_slice(&img.pixels, img.width, img.height)));
        b.set_preview_background(Self::rgb(theme_named(&prefs.scheme).background));
    }
```

Call `self.refresh_preview();` at the end of `refresh_settings`. Add the arm to `on_winit_event`:

```rust
            WindowEvent::ScaleFactorChanged { .. } => self.refresh_preview(),
```

Append to `install`:

```rust
        let weak = Rc::downgrade(self);
        self.blink_timer.start(slint::TimerMode::Repeated, std::time::Duration::from_millis(530), move || {
            let Some(app) = weak.upgrade() else { return };
            let blinking = app.state.borrow().prefs.terminal.blink && app.router.current() == Page::Settings;
            let next = !blinking || !app.cursor_on.get();
            if next != app.cursor_on.get() {
                app.cursor_on.set(next);
                app.refresh_preview();
            }
        });
```

- [ ] **Step 6: Check it**

Run: `cargo run -p tether-app` → Settings:
1. The preview sits beside the form at ≥ 800 px wide: `me@devbox ~ $ ls`, `src  README.md`, a prompt and a block cursor on the Tether well `#1E1E2E`. Narrow the window under 800 px: the preview moves under the Blink cursor row.
2. Size, spacing, padding, cursor shape each redraw it at once; Blink cursor on makes it blink (530 ms), off stops it with the cursor shown.
3. Drag the window to a monitor with a different scale (or change Display → Scale while it runs): the preview keeps its physical size in points and stays crisp.

- [ ] **Step 7: Lint and commit**

Run: `cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings && cargo test -p tether-app`

```bash
git add clients/windows/crates/tether-app
git commit -m "feat(windows): live terminal preview in settings

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Color scheme and Font pages, acceptance pass

**Files:**
- Create: `src/vm/pickers.rs`, `ui/pickers.slint`
- Modify: `src/vm/mod.rs`, `ui/bridge.slint`, `ui/app.slint`, `src/app.rs`
- Test: `src/vm/pickers.rs` (colocated)

**Interfaces:**
- Consumes: `catalog`, `theme_named`, `TerminalTheme::is_light`, `FONTS`, `font_named`.
- Produces:
  - `pub struct SchemeRowVm { pub id: String, pub name: String, pub background: u32, pub foreground: u32, pub blue: u32, pub green: u32, pub dots: [u32; 6], pub meta: &'static str, pub active: bool }`, `pub fn scheme_rows(query: &str, active: &str) -> Vec<SchemeRowVm>`
  - `pub struct FontRowVm { pub id: &'static str, pub name: &'static str, pub active: bool }`, `pub fn font_rows(active: &str) -> Vec<FontRowVm>`
  - Slint structs `SchemeRow`, `FontRow`; global `PickerBridge`; components `SchemePickerPage`, `FontPickerPage`; `App::refresh_pickers(&self)`.

- [ ] **Step 1: Write the failing tests**

Add `pub mod pickers;` to `src/vm/mod.rs`.

`src/vm/pickers.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tether_comes_first_and_is_active_by_default() {
        let rows = scheme_rows("", "tether");
        assert_eq!(rows.len(), catalog().len());
        assert_eq!((rows[0].id.as_str(), rows[0].name.as_str(), rows[0].meta), ("tether", "Tether", "Dark"));
        assert!(rows[0].active);
        assert_eq!(rows.iter().filter(|r| r.active).count(), 1);
    }

    #[test]
    fn swatch_colors_come_from_the_theme() {
        let row = &scheme_rows("", "tether")[0];
        let t = theme_named("tether");
        assert_eq!((row.background, row.foreground), (t.background, t.foreground));
        assert_eq!((row.blue, row.green), (t.ansi[4], t.ansi[2]));
        assert_eq!(row.dots, [t.ansi[1], t.ansi[2], t.ansi[3], t.ansi[4], t.ansi[5], t.ansi[6]]);
    }

    #[test]
    fn search_ignores_case_and_whitespace() {
        let latte = scheme_rows("  LATTE ", "tether");
        assert_eq!(latte.len(), 1);
        assert_eq!((latte[0].name.as_str(), latte[0].meta), ("Catppuccin Latte", "Light"));
        assert!(!latte[0].active);
        assert_eq!(scheme_rows("   ", "tether").len(), catalog().len());
        assert!(scheme_rows("zzzz-no-such-theme", "tether").is_empty());
    }

    #[test]
    fn an_unknown_active_id_checks_tether() {
        let rows = scheme_rows("", "removed-theme");
        assert!(rows[0].active);
    }

    #[test]
    fn fonts_list_every_face_with_cascadia_mono_first() {
        let rows = font_rows("cascadia-mono");
        assert_eq!(rows.len(), 7);
        assert_eq!((rows[0].id, rows[0].name), ("cascadia-mono", "Cascadia Mono"));
        assert!(rows[0].active);
        let names: Vec<_> = rows.iter().map(|r| r.name).collect();
        assert_eq!(
            names,
            ["Cascadia Mono", "Cascadia Code", "JetBrains Mono", "Monaspace Neon", "Monaspace Radon", "Maple Mono", "Comic Mono"]
        );
        assert!(font_rows("menlo")[0].active);
        assert!(font_rows("comic-mono")[6].active);
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p tether-app pickers`
Expected: FAIL — unresolved names.

- [ ] **Step 3: Implement**

Prepend to `src/vm/pickers.rs`:

```rust
use tether_core::{FONTS, catalog, font_named, theme_named};

#[derive(Debug, Clone, PartialEq)]
pub struct SchemeRowVm {
    pub id: String,
    pub name: String,
    pub background: u32,
    pub foreground: u32,
    pub blue: u32,
    pub green: u32,
    pub dots: [u32; 6],
    pub meta: &'static str,
    pub active: bool,
}

pub fn scheme_rows(query: &str, active: &str) -> Vec<SchemeRowVm> {
    let needle = query.trim().to_lowercase();
    let active = &theme_named(active).id;
    catalog()
        .iter()
        .filter(|t| needle.is_empty() || t.name.to_lowercase().contains(&needle))
        .map(|t| SchemeRowVm {
            id: t.id.clone(),
            name: t.name.clone(),
            background: t.background,
            foreground: t.foreground,
            blue: t.ansi[4],
            green: t.ansi[2],
            dots: [t.ansi[1], t.ansi[2], t.ansi[3], t.ansi[4], t.ansi[5], t.ansi[6]],
            meta: if t.is_light() { "Light" } else { "Dark" },
            active: &t.id == active,
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq)]
pub struct FontRowVm {
    pub id: &'static str,
    pub name: &'static str,
    pub active: bool,
}

pub fn font_rows(active: &str) -> Vec<FontRowVm> {
    let active = font_named(active).id;
    FONTS.iter().map(|f| FontRowVm { id: f.id, name: f.name, active: f.id == active }).collect()
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p tether-app pickers`
Expected: PASS (5 tests).

- [ ] **Step 5: Add the bridge and the pages**

Append to `ui/bridge.slint`:

```slint
export struct SchemeRow {
    id: string,
    name: string,
    background: color,
    foreground: color,
    blue: color,
    green: color,
    dots: [color],
    meta: string,
    active: bool,
}

export struct FontRow {
    id: string,
    name: string,
    active: bool,
}

export global PickerBridge {
    in-out property <string> query;
    in property <[SchemeRow]> schemes;
    in property <[FontRow]> fonts;
    callback query-changed();
    callback choose-scheme(string);
    callback choose-font(string);
}
```

`ui/pickers.slint`:

```slint
import { ListView } from "std-widgets.slint";
import { Tokens } from "tokens.slint";
import { AppBridge, PickerBridge, SchemeRow, FontRow } from "bridge.slint";
import { Field, PageChrome } from "components.slint";

component PickRow inherits Rectangle {
    callback chosen();
    Rectangle { y: parent.height - 1px; height: 1px; background: Tokens.border; }
    focus := FocusScope {
        key-pressed(event) => {
            if (event.text == Key.Return || event.text == " ") { root.chosen(); return accept; }
            reject
        }
    }
    TouchArea { mouse-cursor: pointer; clicked => { focus.focus(); root.chosen(); } }
    Rectangle {
        border-width: focus.has-focus ? 2px : 0px;
        border-color: Tokens.accent;
        border-radius: 6px;
    }
}

component Check inherits Text {
    text: "✓";
    color: Tokens.accent;
    font-weight: 700;
    vertical-alignment: center;
}

component SchemeRowView inherits PickRow {
    in property <SchemeRow> row;
    height: 66px;
    HorizontalLayout {
        spacing: 12px;
        padding-top: 10px;
        padding-bottom: 10px;
        Rectangle {
            width: 108px;
            background: root.row.background;
            border-radius: 6px;
            border-width: 1px;
            border-color: Tokens.border;
            VerticalLayout {
                padding-left: 8px;
                padding-right: 8px;
                padding-top: 7px;
                padding-bottom: 6px;
                spacing: 4px;
                HorizontalLayout {
                    alignment: start;
                    Text { text: "~ "; color: root.row.blue; font-family: Tokens.mono-font; font-size: 11px; }
                    Text { text: "git "; color: root.row.foreground; font-family: Tokens.mono-font; font-size: 11px; }
                    Text { text: "main"; color: root.row.green; font-family: Tokens.mono-font; font-size: 11px; }
                }
                HorizontalLayout {
                    alignment: start;
                    spacing: 3px;
                    for dot in root.row.dots: Rectangle { width: 7px; height: 7px; border-radius: 3.5px; background: dot; }
                }
            }
        }
        VerticalLayout {
            alignment: center;
            Text { text: root.row.name; font-weight: 600; color: Tokens.text; }
            Text { text: root.row.meta; font-size: 12px; color: Tokens.text-secondary; }
        }
        Rectangle { horizontal-stretch: 1; }
        if root.row.active: Check { }
    }
}

component FontRowView inherits PickRow {
    in property <FontRow> row;
    height: 46px;
    HorizontalLayout {
        Text { text: root.row.name; font-family: root.row.name; font-size: 15px; color: Tokens.text; vertical-alignment: center; }
        Rectangle { horizontal-stretch: 1; }
        if root.row.active: Check { }
    }
}

export component SchemePickerPage inherits PageChrome {
    title: "Color scheme";
    column-width: 560px;
    back => { AppBridge.back(); }
    VerticalLayout {
        spacing: 8px;
        Field { placeholder: "Search"; text <=> PickerBridge.query; edited => { PickerBridge.query-changed(); } }
        ListView {
            vertical-stretch: 1;
            for row in PickerBridge.schemes: SchemeRowView {
                row: row;
                chosen => { PickerBridge.choose-scheme(row.id); }
            }
        }
    }
}

export component FontPickerPage inherits PageChrome {
    title: "Font";
    column-width: 520px;
    back => { AppBridge.back(); }
    ListView {
        vertical-stretch: 1;
        for row in PickerBridge.fonts: FontRowView {
            row: row;
            chosen => { PickerBridge.choose-font(row.id); }
        }
    }
}
```

The font row draws its name with `font-family: <name>`: each `FontFace.name` is the family name inside the bundled file (`Cascadia Mono`, `JetBrains Mono`, `Monaspace Neon`, …). If a row renders in Segoe UI instead, open the file in Windows Font Viewer, read its family name, and add a `family` field to `FontRow` carrying that string.

In `ui/app.slint`: import `SchemePickerPage, FontPickerPage` from `pickers.slint`, export `PickerBridge, SchemeRow, FontRow`, and insert before the dialog:

```slint
        if AppBridge.page == PageKind.scheme-picker: SchemePickerPage { }
        if AppBridge.page == PageKind.font-picker: FontPickerPage { }
```

- [ ] **Step 6: Wire it**

In `src/app.rs` add imports `crate::{FontRow, PickerBridge, SchemeRow}`, `crate::vm::pickers`. Add:

```rust
    pub fn refresh_pickers(&self) {
        let terminal = self.state.borrow().prefs.terminal.clone();
        let b = self.ui.global::<PickerBridge>();
        let schemes: Vec<SchemeRow> = pickers::scheme_rows(&b.get_query(), &terminal.scheme)
            .into_iter()
            .map(|r| SchemeRow {
                id: r.id.into(),
                name: r.name.into(),
                background: Self::rgb(r.background),
                foreground: Self::rgb(r.foreground),
                blue: Self::rgb(r.blue),
                green: Self::rgb(r.green),
                dots: ModelRc::new(VecModel::from(r.dots.iter().map(|&c| Self::rgb(c)).collect::<Vec<_>>())),
                meta: r.meta.into(),
                active: r.active,
            })
            .collect();
        b.set_schemes(ModelRc::new(VecModel::from(schemes)));
        let fonts: Vec<FontRow> = pickers::font_rows(&terminal.font)
            .into_iter()
            .map(|r| FontRow { id: r.id.into(), name: r.name.into(), active: r.active })
            .collect();
        b.set_fonts(ModelRc::new(VecModel::from(fonts)));
    }
```

Add `self.refresh_pickers();` to the end of `on_prefs_changed`. Replace the `on_open_schemes` / `on_open_fonts` handlers from Task 9 with ones that reset the search first:

```rust
        s.on_open_schemes(on(self, |app| {
            app.ui.global::<PickerBridge>().set_query(SharedString::new());
            app.refresh_pickers();
            app.router.go(Page::SchemePicker);
            app.refresh_router();
        }));
        s.on_open_fonts(on(self, |app| {
            app.refresh_pickers();
            app.router.go(Page::FontPicker);
            app.refresh_router();
        }));
```

Append to `install`:

```rust
        let picker = self.ui.global::<PickerBridge>();
        picker.on_query_changed(on(self, |app| app.refresh_pickers()));
        let weak = Rc::downgrade(self);
        picker.on_choose_scheme(move |id| {
            if let Some(app) = weak.upgrade() {
                app.update_terminal_prefs(|t| t.scheme = id.to_string());
            }
        });
        let weak = Rc::downgrade(self);
        picker.on_choose_font(move |id| {
            if let Some(app) = weak.upgrade() {
                app.update_terminal_prefs(|t| t.font = id.to_string());
            }
        });
```

- [ ] **Step 7: Lint and test everything**

Run: `cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace`
Expected: clean; every `tether-app` test from Tasks 1–11 passes (scene 2, app_state 8, router 5, placement 7, home 8, server_form 7, key_forms 7, settings 6, preview 6, pickers 5).

Run: `cargo build --release -p tether-app`
Expected: `target\release\tether.exe` and `target\release\licenses\` with three files.

- [ ] **Step 8: Acceptance pass on Windows 11 (and Windows 10 for step 1)**

Start from an empty `%LOCALAPPDATA%\Tether` and `cargo run --release -p tether-app`:
1. Title bar painted to the scene and captioned "Tether" (Win 11); dark system caption at night on Win 10. Window can't go under 640 × 420.
2. Home empty state → **Add a server** → fill with SSH agent → save → one card. Gear opens Settings from Home.
3. Keys → Generate → card; Import a file with a `.pub` beside it → card; Paste with a mismatched public line → "The public key doesn't match the private key".
4. Edit the machine → Private key → pick the generated key → **Save changes** → the card reads `· <key name>`; the key card reads `used by <machine>`.
5. Delete that key → the confirm's second line names the machine → confirm → the machine reads `key missing`; Edit it → no key preselected, hint "Choose a key to save it".
6. Remove the machine → confirm → gone; `hostkeys.json` (if any) unchanged; its password entry under `secrets\` gone.
7. Settings → Color scheme → search `latte` → choose it → check moves, the preview turns light at once; Back → the row reads `Catppuccin Latte`. Font → Cascadia Code → names are each drawn in their own face; the check moves.
8. Esc walks back from every page; on Home it does nothing. Dialogs: Esc cancels.
9. Quit and relaunch: theme mode, terminal settings, window size/position all restored.

- [ ] **Step 9: Commit**

```bash
git add clients/windows/crates/tether-app
git commit -m "feat(windows): color scheme and font pages

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Spec coverage (M5 scope)

| Spec | Task |
|---|---|
| Window: caption color / Win10 dark mode, caption "Tether", min 640 × 420, persisted size and position | 1, 4 |
| Gear on Home; Settings returns where it was opened | 3, 6, 9 |
| Destructive confirms are dialogs; forms are pages; Esc is Back | 3, 6 |
| Theme System / Dark / Light, System live | 4, 9 |
| Home header, mono subtitles, plus on either tab, raised Machines / Keys segment | 5, 6 |
| Machine cards, Enter opens, right-click / Menu key Edit and Remove, Remove copy, password deleted, pin kept, `key missing` | 2, 5, 6 |
| Add / Edit server form, segment, picker, empty-vault and agent lines, password placeholder, trust note, hints, trim, port fallback | 2, 7 (rules in M1) |
| Key cards: randomart, origin, algorithm · created date, short fingerprint, used by, Copy public key | 5, 6 |
| Generate / Import (file + sibling `.pub`) / Paste, hints, delete confirm with machines line | 2, 5, 8 |
| Settings controls, ranges, defaults; preview beside at ≥ 800 px, under the blink row otherwise | 9, 10 |
| Color scheme page (search, swatch, Light / Dark, check, immediate apply, Tether first, fallback) | 11 |
| Font page (drawn in its face, check, fallback), every face bundled | 1, 11 |
| `TerminalThemes-LICENSE.txt`, `LICENSES.md`, Cascadia license shipped | 1 |

Left to M6, by the roadmap: the terminal page, Couldn't connect (including "This machine's key was deleted…" on Open), Host key refused, Ctrl+= / Ctrl+- / Ctrl+0 (they call `TerminalPrefs::{bigger, smaller, reset_size}` and then `App::on_prefs_changed`), and the gear in the terminal header (it calls `App::open_settings`).

## Deviations

No Rust public name from a Produces block was renamed.

- Slint 1.18: `SchemeRowView` and `FontRowView` use property `entry` instead of `row` (`row` clashes with `ListView`). Scroll views use `content-width` / `content-height` instead of the deprecated `viewport-*` properties.
- `preview::geometry` rounds total padding as `(2.0 * pt_to_px(padding, scale)).round()` so a doubled scale still matches the test.
- `Router::home`, `App::runtime`, and `AppState::hostkeys` allow `dead_code`. They are part of the M6 surface.
- Startup failures go through `startup_message`: a data-file error names that file; other errors keep their text. Release builds install a panic hook that shows the panic payload in the same box. `add_key` stores the secret before `keys.json` and deletes it if the save fails. No public signature changes.


