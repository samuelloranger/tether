# M4 — `tether-term` (VT engine + rasterizer) Implementation Plan

> **For the implementer:** Work through the tasks in order. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `tether-term`: one `alacritty_terminal` grid per tab that answers the program's queries, reports OSC notifications/progress/cwd/clipboard, exposes modes and selection, and a `swash` rasterizer that full-repaints the visible grid into an RGBA buffer in the chosen face, theme, spacing, padding and cursor.

**Architecture:** `TabTerminal` owns an `alacritty_terminal::Term` driven by a `vte::ansi::Processor`, plus tether-core's `OscScanner` + `TabReports` run over the same bytes (alacritty ignores OSC 7, 9, 777, 133 and its own OSC 52 path is disabled so core's iOS-parity clipboard rules are the only source). Alacritty's events are collected by a listener and turned into `TermEvent`s after each `advance`. `snapshot()` resolves every visible cell to RGB (theme + OSC 4/10/11/12 overrides kept in alacritty's `Colors`). `Rasterizer` turns a `Snapshot` into `RgbaImage` through a glyph atlas keyed by face, glyph and size, cleared whenever the pixel size changes.

**Tech Stack:** Rust 2024, `alacritty_terminal = "=0.26.0"` (re-exports `vte 0.15.0`), `swash = "=0.2.10"`, `tether-core` (M1/M2).

**Spec:** `clients/windows/SPEC.md` (sections Terminal, Replies to the program, Font, Tests → Rasterizer / Replies). **Roadmap and contract:** `docs/superpowers/plans/2026-10-05-windows-00-roadmap.md` — read its `tether-term` and `tether-core` blocks first.

## Global Constraints

Everything in the roadmap's Global Constraints applies. The ones this milestone touches:

- Crate lives at `clients/windows/crates/tether-term/`; builds and tests on Linux. Win32-only code (system font paths) is `#[cfg(windows)]`.
- Scrollback is alacritty's own buffer, **10 000 lines**.
- Points are converted at the monitor's scale: `px = pt × 96/72 × scale`.
- Fonts: the six non-Cascadia faces and `SymbolsNerdFontMono-Regular.ttf` are embedded with `include_bytes!` **from their iOS path** `clients/apple/TetherKit/Sources/TetherKit/Resources/Fonts/`. Cascadia Mono and Cascadia Code (regular + bold, `v2407.24`, SIL OFL) are added to `clients/windows/assets/fonts/`. Font ids: `cascadia-mono`, `cascadia-code`, `jetbrains-mono`, `monaspace-neon`, `monaspace-radon`, `maple-mono`, `comic-mono`; unknown id → Cascadia Mono.
- Fallback order for a missing glyph: chosen face → bundled Symbols Nerd Font Mono → Segoe UI Emoji and the system chain (Windows only, loaded at runtime from `%WINDIR%\Fonts`; absent on Linux, so Linux tests never depend on it).
- Ligatures are drawn for Cascadia Code only.
- The grid is bottom-anchored, full repaint (not a row diff), padding around it from the setting. The well color is the active theme background (`#1E1E2E` for Tether).
- OSC 10/11/12 and OSC 4 queries answer `rgb:rrrr/gggg/bbbb` with the current theme and overrides; a theme change answers with the new color and keeps overrides. DA1, DA2, DSR 6, CSI 14t/18t answered; CSI 21t ignored; title push/pop supported.
- Comments: minimal, only a non-obvious why. Tests colocated in `#[cfg(test)] mod tests`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

All commands run from `clients/windows/`.

## Review Focus

1. **PTY bytes split anywhere** — a UTF-8 character, an `OSC 11 ;?` query, an OSC 9 notification or an OSC 52 payload cut across two `feed` calls must behave exactly like one call. Pinned in Task 3 (split query), Task 4 (split OSC 9 / OSC 52) and Task 6 (split `é`).
2. **The window moves to a monitor with a different scale factor** — the pixel size changes, the atlas must not serve glyphs rasterized at the old size, and a 2× render after a 1× render must equal a fresh 2× render. Pinned in Task 8 (atlas clears) and Task 9 (stale-atlas regression).
3. **A synchronized update (`CSI ?2026h`) that never ends** — Claude Code wraps every frame in one; alacritty buffers bytes until the end mark or a timeout it cannot fire by itself. The caller must be able to see the deadline and flush, or the screen freezes. Pinned in Task 4.
4. **A hostile title** — control and bidi characters in OSC 0/2 must not reach the window title, and length caps at 128. Pinned in Task 3.
5. **A window narrower or shorter than twice the padding** (drag-resize to the minimum, or padding 24 at a tiny size) — grid size is at least 1×1 and nothing underflows or panics. Pinned in Task 7 and Task 9.

## File structure

```
clients/windows/assets/fonts/
  CascadiaMono-Regular.ttf  CascadiaMono-Bold.ttf
  CascadiaCode-Regular.ttf  CascadiaCode-Bold.ttf
  CascadiaCode-LICENSE.txt
clients/windows/crates/tether-term/
  Cargo.toml
  src/lib.rs        re-exports
  src/fonts.rs      embedded face bytes, symbols font, system fallbacks
  src/palette.rs    alacritty color index → 0xRRGGBB with theme + overrides
  src/terminal.rs   TabTerminal, TermEvent, Cell, SelectKind, MouseMode
  src/snapshot.rs   Snapshot, RenderCell, extraction from Term
  src/metrics.rs    pt_to_px, cell_metrics, grid_size, FaceMetrics
  src/glyphs.rs     FaceSlot, Faces (fallback resolution), GlyphAtlas, rasterize
  src/raster.rs     RgbaImage, RenderStyle, Rasterizer (+ ligature shaping)
```

---

### Task 1: Crate scaffold and bundled fonts

**Files:**
- Create: `clients/windows/assets/fonts/` (4 TTFs + `CascadiaCode-LICENSE.txt`)
- Create: `clients/windows/crates/tether-term/Cargo.toml`
- Create: `clients/windows/crates/tether-term/src/lib.rs`
- Create: `clients/windows/crates/tether-term/src/fonts.rs`
- Modify: `clients/windows/Cargo.toml` (workspace members, only if M1 did not use `crates/*`)

**Interfaces:**
- Consumes: `tether_core::fonts::{FONTS, font_named, FontFace}` (M1).
- Produces: `pub fn face_bytes(id: &str) -> (&'static [u8], &'static [u8])` (regular, bold); `pub static SYMBOLS: &[u8]`; `pub fn system_fallbacks() -> &'static [&'static [u8]]` (empty off Windows).

- [ ] **Step 1: Fetch Cascadia v2407.24 and its license**

```bash
tmp=$(mktemp -d)
curl -sL -o "$tmp/cc.zip" https://github.com/microsoft/cascadia-code/releases/download/v2407.24/CascadiaCode-2407.24.zip
mkdir -p assets/fonts
unzip -j -o "$tmp/cc.zip" \
  ttf/static/CascadiaMono-Regular.ttf ttf/static/CascadiaMono-Bold.ttf \
  ttf/static/CascadiaCode-Regular.ttf ttf/static/CascadiaCode-Bold.ttf -d assets/fonts
curl -sL -o assets/fonts/CascadiaCode-LICENSE.txt \
  https://raw.githubusercontent.com/microsoft/cascadia-code/v2407.24/LICENSE
ls -la assets/fonts
```

Expected: four `.ttf` files (~575–605 KB each) and a license whose first line is `Copyright (c) 2019 - Present, Microsoft Corporation,`.

- [ ] **Step 2: Create the crate manifest**

`clients/windows/crates/tether-term/Cargo.toml`:

```toml
[package]
name = "tether-term"
version = "0.1.0"
edition = "2024"
publish = false

[dependencies]
tether-core = { path = "../tether-core" }
alacritty_terminal = { version = "=0.26.0", default-features = false }
swash = "=0.2.10"
```

If `clients/windows/Cargo.toml` lists members explicitly instead of `members = ["crates/*"]`, add `"crates/tether-term"`.

- [ ] **Step 3: Write the failing tests**

`clients/windows/crates/tether-term/src/lib.rs`:

```rust
pub mod fonts;

pub use fonts::face_bytes;
```

`clients/windows/crates/tether-term/src/fonts.rs` (tests only for now, plus empty signatures so it compiles to a failing state):

```rust
pub fn face_bytes(_id: &str) -> (&'static [u8], &'static [u8]) {
    (&[], &[])
}

pub static SYMBOLS: &[u8] = &[];

#[cfg(test)]
mod tests {
    use super::*;
    use swash::FontRef;
    use tether_core::fonts::FONTS;

    fn maps(data: &[u8], ch: char) -> bool {
        FontRef::from_index(data, 0).is_some_and(|f| f.charmap().map(ch) != 0)
    }

    #[test]
    fn every_offered_face_has_regular_and_bold() {
        for face in FONTS.iter() {
            let (regular, bold) = face_bytes(face.id);
            assert!(maps(regular, 'A'), "{} regular", face.id);
            assert!(maps(bold, 'A'), "{} bold", face.id);
            assert_ne!(regular.as_ptr(), bold.as_ptr(), "{} bold is its own file", face.id);
        }
    }

    #[test]
    fn unknown_id_falls_back_to_cascadia_mono() {
        assert_eq!(face_bytes("menlo").0.as_ptr(), face_bytes("cascadia-mono").0.as_ptr());
    }

    #[test]
    fn symbols_font_covers_powerline_and_nerd_icons() {
        assert!(maps(SYMBOLS, '\u{e0b0}'));
        assert!(maps(SYMBOLS, '\u{f121}'));
    }

    #[test]
    fn cascadia_mono_lacks_nerd_icons_so_fallback_matters() {
        assert!(!maps(face_bytes("cascadia-mono").0, '\u{f121}'));
    }

    #[cfg(not(windows))]
    #[test]
    fn no_system_fallbacks_off_windows() {
        assert!(system_fallbacks().is_empty());
    }
}
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `cargo test -p tether-term fonts`
Expected: FAIL (`system_fallbacks` not found; once stubbed, `every_offered_face_has_regular_and_bold` fails on empty bytes).

- [ ] **Step 5: Implement `fonts.rs`**

```rust
use std::sync::OnceLock;

use tether_core::fonts::font_named;

macro_rules! apple_font {
    ($file:literal) => {
        include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../apple/TetherKit/Sources/TetherKit/Resources/Fonts/",
            $file
        ))
    };
}

macro_rules! windows_font {
    ($file:literal) => {
        include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../assets/fonts/", $file))
    };
}

static CASCADIA_MONO: (&[u8], &[u8]) =
    (windows_font!("CascadiaMono-Regular.ttf"), windows_font!("CascadiaMono-Bold.ttf"));
static CASCADIA_CODE: (&[u8], &[u8]) =
    (windows_font!("CascadiaCode-Regular.ttf"), windows_font!("CascadiaCode-Bold.ttf"));
static JETBRAINS_MONO: (&[u8], &[u8]) =
    (apple_font!("JetBrainsMono-Regular.ttf"), apple_font!("JetBrainsMono-Bold.ttf"));
static MONASPACE_NEON: (&[u8], &[u8]) =
    (apple_font!("MonaspaceNeon-Regular.otf"), apple_font!("MonaspaceNeon-Bold.otf"));
static MONASPACE_RADON: (&[u8], &[u8]) =
    (apple_font!("MonaspaceRadon-Regular.otf"), apple_font!("MonaspaceRadon-Bold.otf"));
static MAPLE_MONO: (&[u8], &[u8]) =
    (apple_font!("MapleMono-Regular.ttf"), apple_font!("MapleMono-Bold.ttf"));
static COMIC_MONO: (&[u8], &[u8]) = (apple_font!("ComicMono.ttf"), apple_font!("ComicMono-Bold.ttf"));

pub static SYMBOLS: &[u8] = apple_font!("SymbolsNerdFontMono-Regular.ttf");

pub fn face_bytes(id: &str) -> (&'static [u8], &'static [u8]) {
    match font_named(id).id {
        "cascadia-code" => CASCADIA_CODE,
        "jetbrains-mono" => JETBRAINS_MONO,
        "monaspace-neon" => MONASPACE_NEON,
        "monaspace-radon" => MONASPACE_RADON,
        "maple-mono" => MAPLE_MONO,
        "comic-mono" => COMIC_MONO,
        _ => CASCADIA_MONO,
    }
}

/// Read once and leaked: the rasterizer holds `FontRef<'static>` into these for the process lifetime.
pub fn system_fallbacks() -> &'static [&'static [u8]] {
    static LOADED: OnceLock<Vec<&'static [u8]>> = OnceLock::new();
    LOADED.get_or_init(load_system_fallbacks)
}

#[cfg(windows)]
fn load_system_fallbacks() -> Vec<&'static [u8]> {
    let dir = std::path::PathBuf::from(std::env::var_os("WINDIR").unwrap_or_else(|| "C:\\Windows".into()))
        .join("Fonts");
    ["seguiemj.ttf", "seguisym.ttf", "msyh.ttc", "YuGothM.ttc", "malgun.ttf"]
        .iter()
        .filter_map(|file| std::fs::read(dir.join(file)).ok())
        .map(|bytes| &*Box::leak(bytes.into_boxed_slice()))
        .collect()
}

#[cfg(not(windows))]
fn load_system_fallbacks() -> Vec<&'static [u8]> {
    Vec::new()
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cargo test -p tether-term fonts`
Expected: PASS (5 tests on Linux, 4 on Windows).

- [ ] **Step 7: Commit**

```bash
git add clients/windows/assets/fonts clients/windows/crates/tether-term clients/windows/Cargo.toml
git commit -m "feat(windows): add tether-term crate with bundled fonts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Palette resolution

**Files:**
- Create: `clients/windows/crates/tether-term/src/palette.rs`
- Modify: `clients/windows/crates/tether-term/src/lib.rs` (add `mod palette;`)

**Interfaces:**
- Consumes: `tether_core::theme::TerminalTheme` (`ansi: [u32; 16]`, `background`, `foreground`, `cursor`, 0xRRGGBB).
- Produces (crate-internal): `theme_color(&TerminalTheme, usize) -> u32`, `indexed(&TerminalTheme, &Colors, usize) -> u32`, `resolve(&TerminalTheme, &Colors, Color) -> u32`, `dim(u32) -> u32`, `rgb_u32(Rgb) -> u32`, `to_rgb(u32) -> Rgb`.

Alacritty's color index space: 0–15 ANSI, 16–231 cube, 232–255 gray, 256 foreground, 257 background, 258 cursor, 259–266 dim ANSI, 267 bright foreground, 268 dim foreground. `Colors[i]` is `Some` only where a program overrode it (OSC 4/10/11/12).

- [ ] **Step 1: Write the failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use alacritty_terminal::term::color::Colors;
    use alacritty_terminal::vte::ansi::{Color, NamedColor, Rgb};
    use tether_core::theme::theme_named;

    #[test]
    fn ansi_and_dynamic_entries_come_from_the_theme() {
        let t = theme_named("tether");
        assert_eq!(theme_color(t, 1), 0xF38BA8);
        assert_eq!(theme_color(t, 256), 0xCCCCCC);
        assert_eq!(theme_color(t, 257), 0x1E1E2E);
        assert_eq!(theme_color(t, 258), 0xFFFFFF);
    }

    #[test]
    fn cube_and_gray_ramp_follow_xterm() {
        let t = theme_named("tether");
        assert_eq!(theme_color(t, 16), 0x000000);
        assert_eq!(theme_color(t, 196), 0xFF0000);
        assert_eq!(theme_color(t, 231), 0xFFFFFF);
        assert_eq!(theme_color(t, 232), 0x080808);
        assert_eq!(theme_color(t, 244), 0x808080);
    }

    #[test]
    fn dim_is_two_thirds() {
        assert_eq!(dim(0x96_96_96), 0x64_64_64);
        let t = theme_named("tether");
        assert_eq!(theme_color(t, NamedColor::DimRed as usize), dim(0xF38BA8));
    }

    #[test]
    fn a_program_override_wins_over_the_theme() {
        let t = theme_named("tether");
        let mut colors = Colors::default();
        colors[1] = Some(Rgb { r: 0xff, g: 0, b: 0 });
        assert_eq!(indexed(t, &colors, 1), 0xFF0000);
        assert_eq!(resolve(t, &colors, Color::Named(NamedColor::Red)), 0xFF0000);
        assert_eq!(resolve(t, &colors, Color::Indexed(2)), 0xA6E3A1);
    }

    #[test]
    fn truecolor_passes_through() {
        let t = theme_named("tether");
        let rgb = Rgb { r: 1, g: 2, b: 3 };
        assert_eq!(resolve(t, &Colors::default(), Color::Spec(rgb)), 0x010203);
        assert_eq!(to_rgb(0x010203), rgb);
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p tether-term palette`
Expected: FAIL — `cannot find function theme_color`.

- [ ] **Step 3: Implement**

```rust
use alacritty_terminal::term::color::{COUNT, Colors};
use alacritty_terminal::vte::ansi::{Color, Rgb};
use tether_core::theme::TerminalTheme;

pub(crate) fn rgb_u32(c: Rgb) -> u32 {
    (c.r as u32) << 16 | (c.g as u32) << 8 | c.b as u32
}

pub(crate) fn to_rgb(v: u32) -> Rgb {
    Rgb { r: (v >> 16) as u8, g: (v >> 8) as u8, b: v as u8 }
}

pub(crate) fn dim(v: u32) -> u32 {
    let f = |shift: u32| ((v >> shift & 0xFF) * 2 / 3) << shift;
    f(16) | f(8) | f(0)
}

pub(crate) fn theme_color(theme: &TerminalTheme, index: usize) -> u32 {
    match index {
        0..16 => theme.ansi[index],
        16..232 => {
            let i = index - 16;
            let level = |n: usize| if n == 0 { 0 } else { (n * 40 + 55) as u32 };
            level(i / 36) << 16 | level(i / 6 % 6) << 8 | level(i % 6)
        }
        232..256 => {
            let g = (8 + 10 * (index - 232)) as u32;
            g << 16 | g << 8 | g
        }
        256 | 267 => theme.foreground,
        257 => theme.background,
        258 => theme.cursor,
        259..267 => dim(theme.ansi[index - 259]),
        _ => dim(theme.foreground),
    }
}

pub(crate) fn indexed(theme: &TerminalTheme, colors: &Colors, index: usize) -> u32 {
    if index >= COUNT {
        return theme.foreground;
    }
    colors[index].map(rgb_u32).unwrap_or_else(|| theme_color(theme, index))
}

pub(crate) fn resolve(theme: &TerminalTheme, colors: &Colors, color: Color) -> u32 {
    match color {
        Color::Spec(rgb) => rgb_u32(rgb),
        Color::Indexed(i) => indexed(theme, colors, i as usize),
        Color::Named(name) => indexed(theme, colors, name as usize),
    }
}
```

Add `mod palette;` to `lib.rs`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p tether-term palette`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add clients/windows/crates/tether-term/src
git commit -m "feat(windows): resolve terminal colors from theme and overrides

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `TabTerminal` — feed, replies, titles, bell

**Files:**
- Create: `clients/windows/crates/tether-term/src/terminal.rs`
- Modify: `clients/windows/crates/tether-term/src/lib.rs`

**Interfaces:**
- Consumes: `tether_core::resize::GridSize { cols: u16, rows: u16, width_px: u32, height_px: u32 }`, `tether_core::theme::{TerminalTheme, theme_named}`, `tether_core::osc::{OscScanner, TabReports, Notification}` (M2; this task constructs them but Task 4 uses them; `TabReports` must be `Default`, `Notification` must derive `Debug, Clone, PartialEq`).
- Produces:
  ```rust
  pub const SCROLLBACK: usize = 10_000;
  #[derive(Debug, Clone, PartialEq)]
  pub enum TermEvent { Reply(Vec<u8>), Title(Option<String>), Bell, Clipboard(String), Notify(Notification), ProgressChanged, CwdChanged }
  pub struct TabTerminal;
  impl TabTerminal {
      pub fn new(size: GridSize, theme: &TerminalTheme) -> Self;
      pub fn feed(&mut self, bytes: &[u8]) -> Vec<TermEvent>;
      pub fn set_theme(&mut self, theme: &TerminalTheme);
  }
  ```

Gotchas the implementation encodes:
- A `ColorRequest` formatter is answered **after** `advance` returns (the listener cannot borrow the `Term`), so a query and a set in the same chunk see the post-chunk overrides. Acceptable: programs query before they set.
- `Osc52::Disabled`: OSC 52 goes through core's `TabReports` only (Task 4), so it is never reported twice and never readable.
- Title events come from alacritty (it implements the push/pop stack, CSI 22t/23t); `TabReports.title` is not used for the window title.

- [ ] **Step 1: Write the failing tests**

```rust
#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use tether_core::theme::theme_named;

    pub(crate) fn size(cols: u16, rows: u16) -> GridSize {
        GridSize { cols, rows, width_px: cols as u32 * 9, height_px: rows as u32 * 18 }
    }

    pub(crate) fn term() -> TabTerminal {
        TabTerminal::new(size(80, 24), theme_named("tether"))
    }

    pub(crate) fn replies(events: &[TermEvent]) -> Vec<String> {
        events
            .iter()
            .filter_map(|e| match e {
                TermEvent::Reply(b) => Some(String::from_utf8(b.clone()).unwrap()),
                _ => None,
            })
            .collect()
    }

    fn titles(events: &[TermEvent]) -> Vec<Option<String>> {
        events
            .iter()
            .filter_map(|e| match e {
                TermEvent::Title(t) => Some(t.clone()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn osc_10_11_12_answer_the_theme() {
        let mut t = term();
        assert_eq!(replies(&t.feed(b"\x1b]11;?\x07")), ["\x1b]11;rgb:1e1e/1e1e/2e2e\x07"]);
        assert_eq!(replies(&t.feed(b"\x1b]10;?\x07")), ["\x1b]10;rgb:cccc/cccc/cccc\x07"]);
        assert_eq!(replies(&t.feed(b"\x1b]12;?\x1b\\")), ["\x1b]12;rgb:ffff/ffff/ffff\x1b\\"]);
    }

    #[test]
    fn osc_4_answers_the_palette_entry() {
        let mut t = term();
        assert_eq!(replies(&t.feed(b"\x1b]4;1;?\x07")), ["\x1b]4;1;rgb:f3f3/8b8b/a8a8\x07"]);
    }

    #[test]
    fn a_theme_change_answers_with_the_new_background() {
        let mut t = term();
        t.set_theme(theme_named("dracula"));
        assert_eq!(replies(&t.feed(b"\x1b]11;?\x07")), ["\x1b]11;rgb:2828/2a2a/3636\x07"]);
    }

    #[test]
    fn device_attributes_and_cursor_position_are_answered() {
        let mut t = term();
        assert_eq!(replies(&t.feed(b"\x1b[c")), ["\x1b[?6c"]);
        let da2 = replies(&t.feed(b"\x1b[>c"));
        assert!(da2[0].starts_with("\x1b[>0;") && da2[0].ends_with(";1c"), "{da2:?}");
        assert_eq!(replies(&t.feed(b"ab\x1b[6n")), ["\x1b[1;3R"]);
    }

    #[test]
    fn window_size_reports_are_answered_and_21t_is_not() {
        let mut t = term();
        assert_eq!(replies(&t.feed(b"\x1b[18t")), ["\x1b[8;24;80t"]);
        assert_eq!(replies(&t.feed(b"\x1b[14t")), ["\x1b[4;432;720t"]);
        assert!(replies(&t.feed(b"\x1b]2;secret\x07\x1b[21t")).is_empty());
    }

    #[test]
    fn a_query_split_across_reads_is_answered_once() {
        let mut t = term();
        assert!(replies(&t.feed(b"\x1b]11")).is_empty());
        assert_eq!(replies(&t.feed(b";?\x07")), ["\x1b]11;rgb:1e1e/1e1e/2e2e\x07"]);
    }

    #[test]
    fn title_push_and_pop() {
        let mut t = term();
        let events = t.feed(b"\x1b]2;one\x07\x1b[22t\x1b]2;two\x07\x1b[23t");
        assert_eq!(titles(&events), [Some("one".into()), Some("two".into()), Some("one".into())]);
    }

    #[test]
    fn titles_lose_control_and_bidi_characters_and_cap_at_128() {
        let mut t = term();
        let events = t.feed("\x1b]2;a\u{202E}b\u{200B}c\x07".as_bytes());
        assert_eq!(titles(&events), [Some("abc".into())]);
        let long = format!("\x1b]2;{}\x07", "x".repeat(300));
        assert_eq!(titles(&t.feed(long.as_bytes()))[0].as_ref().unwrap().chars().count(), 128);
        assert_eq!(titles(&t.feed(b"\x1b]2;   \x07")), [None]);
    }

    #[test]
    fn bel_is_reported() {
        let mut t = term();
        assert!(t.feed(b"\x07").contains(&TermEvent::Bell));
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p tether-term terminal`
Expected: FAIL — `cannot find type TabTerminal`.

- [ ] **Step 3: Implement**

```rust
use std::sync::{Arc, Mutex};

use alacritty_terminal::event::{Event, EventListener, WindowSize};
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::term::{Config, Osc52, Term};
use alacritty_terminal::vte::ansi::{Processor, StdSyncHandler};
use tether_core::osc::{Notification, OscScanner, TabReports};
use tether_core::resize::GridSize;
use tether_core::theme::TerminalTheme;

use crate::palette;

pub const SCROLLBACK: usize = 10_000;
const TITLE_LIMIT: usize = 128;

#[derive(Debug, Clone, PartialEq)]
pub enum TermEvent {
    Reply(Vec<u8>),
    Title(Option<String>),
    Bell,
    Clipboard(String),
    Notify(Notification),
    ProgressChanged,
    CwdChanged,
}

#[derive(Clone, Default)]
pub(crate) struct Collector(Arc<Mutex<Vec<Event>>>);

impl EventListener for Collector {
    fn send_event(&self, event: Event) {
        self.0.lock().unwrap().push(event);
    }
}

pub(crate) struct Dims {
    cols: usize,
    rows: usize,
}

impl From<GridSize> for Dims {
    fn from(s: GridSize) -> Self {
        Dims { cols: s.cols.max(1) as usize, rows: s.rows.max(1) as usize }
    }
}

impl Dimensions for Dims {
    fn total_lines(&self) -> usize {
        self.rows
    }
    fn screen_lines(&self) -> usize {
        self.rows
    }
    fn columns(&self) -> usize {
        self.cols
    }
}

pub struct TabTerminal {
    pub(crate) term: Term<Collector>,
    parser: Processor<StdSyncHandler>,
    events: Collector,
    pub(crate) theme: TerminalTheme,
    size: GridSize,
    scanner: OscScanner,
    reports: TabReports,
}

impl TabTerminal {
    pub fn new(size: GridSize, theme: &TerminalTheme) -> Self {
        let events = Collector::default();
        let config = Config { scrolling_history: SCROLLBACK, osc52: Osc52::Disabled, ..Config::default() };
        let term = Term::new(config, &Dims::from(size), events.clone());
        TabTerminal {
            term,
            parser: Processor::new(),
            events,
            theme: theme.clone(),
            size,
            scanner: OscScanner::new(),
            reports: TabReports::default(),
        }
    }

    pub fn feed(&mut self, bytes: &[u8]) -> Vec<TermEvent> {
        let _osc = self.scanner.feed(bytes);
        self.parser.advance(&mut self.term, bytes);
        self.drain()
    }

    pub fn set_theme(&mut self, theme: &TerminalTheme) {
        self.theme = theme.clone();
    }

    pub(crate) fn drain(&mut self) -> Vec<TermEvent> {
        let events = std::mem::take(&mut *self.events.0.lock().unwrap());
        events
            .into_iter()
            .filter_map(|event| match event {
                Event::PtyWrite(text) => Some(TermEvent::Reply(text.into_bytes())),
                Event::ColorRequest(index, format) => {
                    let rgb = palette::indexed(&self.theme, self.term.colors(), index);
                    Some(TermEvent::Reply(format(palette::to_rgb(rgb)).into_bytes()))
                }
                Event::TextAreaSizeRequest(format) => Some(TermEvent::Reply(format(self.window_size()).into_bytes())),
                Event::Title(title) => Some(TermEvent::Title(clean_title(&title))),
                Event::ResetTitle => Some(TermEvent::Title(None)),
                Event::Bell => Some(TermEvent::Bell),
                _ => None,
            })
            .collect()
    }

    fn window_size(&self) -> WindowSize {
        let cols = self.size.cols.max(1);
        let rows = self.size.rows.max(1);
        WindowSize {
            num_lines: rows,
            num_cols: cols,
            cell_width: (self.size.width_px / cols as u32) as u16,
            cell_height: (self.size.height_px / rows as u32) as u16,
        }
    }
}

fn clean_title(raw: &str) -> Option<String> {
    let kept: String = raw.chars().filter(|c| !c.is_control() && !is_format(*c)).collect();
    let text = kept.trim();
    (!text.is_empty()).then(|| text.chars().take(TITLE_LIMIT).collect())
}

fn is_format(c: char) -> bool {
    matches!(c, '\u{00AD}' | '\u{061C}' | '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2069}' | '\u{FEFF}')
}
```

`lib.rs`:

```rust
pub mod fonts;
mod palette;
pub mod terminal;

pub use fonts::face_bytes;
pub use terminal::{SCROLLBACK, TabTerminal, TermEvent};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p tether-term terminal`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add clients/windows/crates/tether-term/src
git commit -m "feat(windows): answer terminal queries from the tab's grid

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: OSC reports, palette overrides across theme changes, synchronized updates

**Files:**
- Modify: `clients/windows/crates/tether-term/src/terminal.rs`

**Interfaces:**
- Consumes: `OscScanner::feed(&mut self, &[u8]) -> Vec<OscEvent>`, `TabReports::apply(&mut self, &OscEvent) -> Option<ReportEvent>`, `ReportEvent::{Notify(Notification), Clipboard(String), ProgressChanged}`, `TabReports { title, cwd: Option<String>, progress: Option<Progress> }` (M2).
- Produces:
  ```rust
  impl TabTerminal {
      pub fn reports(&self) -> &TabReports;
      pub fn sync_deadline(&self) -> Option<std::time::Instant>;  // addition to the contract
      pub fn flush_sync(&mut self) -> Vec<TermEvent>;              // addition to the contract
  }
  ```
  The app (M6) calls `flush_sync` when `Instant::now() >= sync_deadline()`, from the same timer that coalesces frames.

- [ ] **Step 1: Write the failing tests** (append to `terminal.rs` tests)

```rust
    fn notifications(events: &[TermEvent]) -> Vec<Notification> {
        events
            .iter()
            .filter_map(|e| match e {
                TermEvent::Notify(n) => Some(n.clone()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn osc_9_and_777_become_notifications() {
        let mut t = term();
        let n = notifications(&t.feed(b"\x1b]9;Build done\x07"));
        assert_eq!(n.len(), 1);
        assert_eq!(n[0].body, "Build done");
        let n = notifications(&t.feed(b"\x1b]777;notify;Claude;Needs you\x07"));
        assert_eq!(n[0].title.as_deref(), Some("Claude"));
        assert_eq!(n[0].body, "Needs you");
    }

    #[test]
    fn osc_9_4_is_progress_never_a_notification() {
        let mut t = term();
        let events = t.feed(b"\x1b]9;4;1;50\x07");
        assert!(notifications(&events).is_empty());
        assert!(events.contains(&TermEvent::ProgressChanged));
        assert_eq!(t.reports().progress.as_ref().unwrap().percent, 50);
    }

    #[test]
    fn a_notification_split_across_reads_arrives_once() {
        let mut t = term();
        assert!(notifications(&t.feed(b"\x1b]9;hel")).is_empty());
        assert_eq!(notifications(&t.feed(b"lo\x07"))[0].body, "hello");
    }

    #[test]
    fn osc_52_copies_once_even_split() {
        let mut t = term();
        let mut events = t.feed(b"\x1b]52;c;aGVs");
        events.extend(t.feed(b"bG8=\x07"));
        let copies: Vec<_> = events.iter().filter(|e| matches!(e, TermEvent::Clipboard(_))).collect();
        assert_eq!(copies, [&TermEvent::Clipboard("hello".into())]);
    }

    #[test]
    fn osc_7_reports_the_directory() {
        let mut t = term();
        assert!(t.feed(b"\x1b]7;file://box/home/sam/src\x07").contains(&TermEvent::CwdChanged));
        assert_eq!(t.reports().cwd.as_deref(), Some("/home/sam/src"));
        assert!(!t.feed(b"\x1b]7;file://box/home/sam/src\x07").contains(&TermEvent::CwdChanged));
    }

    #[test]
    fn palette_overrides_survive_a_theme_change_until_reset() {
        let mut t = term();
        t.feed(b"\x1b]4;1;rgb:ff/00/00\x07");
        t.set_theme(theme_named("dracula"));
        assert_eq!(replies(&t.feed(b"\x1b]4;1;?\x07")), ["\x1b]4;1;rgb:ffff/0000/0000\x07"]);
        t.feed(b"\x1b]104;1\x07");
        assert_eq!(replies(&t.feed(b"\x1b]4;1;?\x07")), ["\x1b]4;1;rgb:ffff/5555/5555\x07"]);
    }

    #[test]
    fn osc_110_resets_a_dynamic_foreground() {
        let mut t = term();
        t.feed(b"\x1b]10;rgb:12/34/56\x07");
        assert_eq!(replies(&t.feed(b"\x1b]10;?\x07")), ["\x1b]10;rgb:1212/3434/5656\x07"]);
        t.feed(b"\x1b]110\x07");
        assert_eq!(replies(&t.feed(b"\x1b]10;?\x07")), ["\x1b]10;rgb:cccc/cccc/cccc\x07"]);
    }

    #[test]
    fn an_unfinished_synchronized_update_can_be_flushed() {
        let mut t = term();
        assert!(replies(&t.feed(b"\x1b[?2026h\x1b]11;?\x07")).is_empty());
        assert!(t.sync_deadline().is_some());
        assert_eq!(replies(&t.flush_sync()), ["\x1b]11;rgb:1e1e/1e1e/2e2e\x07"]);
        assert!(t.sync_deadline().is_none());
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p tether-term terminal`
Expected: FAIL — `no method named reports`.

- [ ] **Step 3: Implement**

Replace `feed` and add the new methods in `impl TabTerminal`:

```rust
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<TermEvent> {
        let osc = self.scanner.feed(bytes);
        self.parser.advance(&mut self.term, bytes);
        let mut out = self.drain();
        for event in &osc {
            out.extend(self.apply_report(event));
        }
        out
    }

    pub fn reports(&self) -> &TabReports {
        &self.reports
    }

    pub fn sync_deadline(&self) -> Option<std::time::Instant> {
        self.parser.sync_timeout().sync_timeout()
    }

    pub fn flush_sync(&mut self) -> Vec<TermEvent> {
        self.parser.stop_sync(&mut self.term);
        self.drain()
    }

    fn apply_report(&mut self, event: &OscEvent) -> Vec<TermEvent> {
        let cwd_before = self.reports.cwd.clone();
        let mut out = Vec::new();
        match self.reports.apply(event) {
            Some(ReportEvent::Notify(n)) => out.push(TermEvent::Notify(n)),
            Some(ReportEvent::Clipboard(text)) => out.push(TermEvent::Clipboard(text)),
            Some(ReportEvent::ProgressChanged) => out.push(TermEvent::ProgressChanged),
            None => {}
        }
        if self.reports.cwd != cwd_before {
            out.push(TermEvent::CwdChanged);
        }
        out
    }
```

Update the import: `use tether_core::osc::{Notification, OscEvent, OscScanner, ReportEvent, TabReports};`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p tether-term terminal`
Expected: PASS (17 tests).

- [ ] **Step 5: Commit**

```bash
git add clients/windows/crates/tether-term/src/terminal.rs
git commit -m "feat(windows): report OSC notifications, progress, cwd and clipboard per tab

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Modes, mouse mode, resize, scrollback, selection

**Files:**
- Modify: `clients/windows/crates/tether-term/src/terminal.rs`
- Modify: `clients/windows/crates/tether-term/src/lib.rs` (re-export new types)

**Interfaces:**
- Consumes: `tether_core::keymap::KeyContext { app_cursor, app_keypad, alt_screen, mouse_reporting, has_selection }` (M2).
- Produces:
  ```rust
  #[derive(Debug, Clone, Copy, PartialEq, Eq)] pub struct Cell { pub row: usize, pub col: usize } // viewport cell, row 0 = top visible row
  #[derive(Debug, Clone, Copy, PartialEq, Eq)] pub enum SelectKind { Simple, Word, Line }
  #[derive(Debug, Clone, Copy, PartialEq, Eq)] pub enum MouseTracking { None, Click, Drag, Motion }
  #[derive(Debug, Clone, Copy, PartialEq, Eq)] pub struct MouseMode { pub tracking: MouseTracking, pub sgr: bool }
  impl TabTerminal {
      pub fn context(&self) -> KeyContext;
      pub fn bracketed_paste(&self) -> bool;
      pub fn mouse_mode(&self) -> MouseMode;
      pub fn resize(&mut self, size: GridSize);
      pub fn scroll(&mut self, lines: i32);           // positive = back into history
      pub fn scroll_to_bottom(&mut self);              // addition: the app snaps back on input
      pub fn display_offset(&self) -> usize;           // addition
      pub fn selection_start(&mut self, cell: Cell, kind: SelectKind);
      pub fn selection_update(&mut self, cell: Cell);
      pub fn selection_text(&self) -> Option<String>;
      pub fn clear_selection(&mut self);
  }
  ```

- [ ] **Step 1: Write the failing tests** (append)

```rust
    #[test]
    fn modes_feed_the_key_context() {
        let mut t = term();
        let c = t.context();
        assert!(!c.app_cursor && !c.app_keypad && !c.alt_screen && !c.mouse_reporting && !c.has_selection);
        t.feed(b"\x1b[?1h\x1b=\x1b[?1049h\x1b[?1000h");
        let c = t.context();
        assert!(c.app_cursor && c.app_keypad && c.alt_screen && c.mouse_reporting);
    }

    #[test]
    fn mouse_tracking_levels_and_sgr() {
        let mut t = term();
        assert_eq!(t.mouse_mode(), MouseMode { tracking: MouseTracking::None, sgr: false });
        t.feed(b"\x1b[?1000h");
        assert_eq!(t.mouse_mode().tracking, MouseTracking::Click);
        t.feed(b"\x1b[?1002h");
        assert_eq!(t.mouse_mode().tracking, MouseTracking::Drag);
        t.feed(b"\x1b[?1003h\x1b[?1006h");
        assert_eq!(t.mouse_mode(), MouseMode { tracking: MouseTracking::Motion, sgr: true });
    }

    #[test]
    fn bracketed_paste_follows_2004() {
        let mut t = term();
        assert!(!t.bracketed_paste());
        t.feed(b"\x1b[?2004h");
        assert!(t.bracketed_paste());
    }

    #[test]
    fn resize_changes_the_reported_size() {
        let mut t = term();
        t.resize(size(40, 10));
        assert_eq!(replies(&t.feed(b"\x1b[18t")), ["\x1b[8;10;40t"]);
    }

    #[test]
    fn scrollback_is_capped_at_ten_thousand_lines() {
        let mut t = term();
        t.feed("x\r\n".repeat(SCROLLBACK + 500).as_bytes());
        t.scroll(5);
        assert_eq!(t.display_offset(), 5);
        t.scroll(i32::MAX / 2);
        assert_eq!(t.display_offset(), SCROLLBACK);
        t.scroll_to_bottom();
        assert_eq!(t.display_offset(), 0);
    }

    #[test]
    fn drag_word_and_line_selection() {
        let mut t = term();
        t.feed(b"hello world");
        t.selection_start(Cell { row: 0, col: 0 }, SelectKind::Simple);
        assert!(t.selection_text().is_none(), "a click alone selects nothing");
        t.selection_update(Cell { row: 0, col: 4 });
        assert_eq!(t.selection_text().as_deref(), Some("hello"));
        assert!(t.context().has_selection);
        t.selection_start(Cell { row: 0, col: 7 }, SelectKind::Word);
        assert_eq!(t.selection_text().as_deref(), Some("world"));
        t.selection_start(Cell { row: 0, col: 3 }, SelectKind::Line);
        assert_eq!(t.selection_text().unwrap().trim_end(), "hello world");
        t.clear_selection();
        assert!(!t.context().has_selection);
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p tether-term terminal`
Expected: FAIL — `no method named context`.

- [ ] **Step 3: Implement** (types at the top of `terminal.rs`, methods in `impl TabTerminal`)

```rust
use alacritty_terminal::grid::Scroll;
use alacritty_terminal::index::{Column, Line, Point, Side};
use alacritty_terminal::selection::{Selection, SelectionType};
use alacritty_terminal::term::TermMode;
use tether_core::keymap::KeyContext;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cell {
    pub row: usize,
    pub col: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SelectKind {
    Simple,
    Word,
    Line,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseTracking {
    None,
    Click,
    Drag,
    Motion,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MouseMode {
    pub tracking: MouseTracking,
    pub sgr: bool,
}
```

```rust
    pub fn context(&self) -> KeyContext {
        let mode = *self.term.mode();
        KeyContext {
            app_cursor: mode.contains(TermMode::APP_CURSOR),
            app_keypad: mode.contains(TermMode::APP_KEYPAD),
            alt_screen: mode.contains(TermMode::ALT_SCREEN),
            mouse_reporting: mode.intersects(TermMode::MOUSE_MODE),
            has_selection: self.selection_text().is_some(),
        }
    }

    pub fn bracketed_paste(&self) -> bool {
        self.term.mode().contains(TermMode::BRACKETED_PASTE)
    }

    pub fn mouse_mode(&self) -> MouseMode {
        let mode = *self.term.mode();
        let tracking = if mode.contains(TermMode::MOUSE_MOTION) {
            MouseTracking::Motion
        } else if mode.contains(TermMode::MOUSE_DRAG) {
            MouseTracking::Drag
        } else if mode.contains(TermMode::MOUSE_REPORT_CLICK) {
            MouseTracking::Click
        } else {
            MouseTracking::None
        };
        MouseMode { tracking, sgr: mode.contains(TermMode::SGR_MOUSE) }
    }

    pub fn resize(&mut self, size: GridSize) {
        self.size = size;
        self.term.resize(Dims::from(size));
    }

    pub fn scroll(&mut self, lines: i32) {
        self.term.scroll_display(Scroll::Delta(lines));
    }

    pub fn scroll_to_bottom(&mut self) {
        self.term.scroll_display(Scroll::Bottom);
    }

    pub fn display_offset(&self) -> usize {
        self.term.grid().display_offset()
    }

    pub fn selection_start(&mut self, cell: Cell, kind: SelectKind) {
        let ty = match kind {
            SelectKind::Simple => SelectionType::Simple,
            SelectKind::Word => SelectionType::Semantic,
            SelectKind::Line => SelectionType::Lines,
        };
        self.term.selection = Some(Selection::new(ty, self.point(cell), Side::Left));
    }

    pub fn selection_update(&mut self, cell: Cell) {
        let point = self.point(cell);
        if let Some(selection) = self.term.selection.as_mut() {
            selection.update(point, Side::Right);
        }
    }

    pub fn selection_text(&self) -> Option<String> {
        self.term.selection_to_string().filter(|s| !s.is_empty())
    }

    pub fn clear_selection(&mut self) {
        self.term.selection = None;
    }

    pub(crate) fn point(&self, cell: Cell) -> Point {
        let offset = self.display_offset() as i32;
        Point::new(Line(cell.row as i32 - offset), Column(cell.col))
    }
```

Re-export in `lib.rs`: `pub use terminal::{Cell, MouseMode, MouseTracking, SCROLLBACK, SelectKind, TabTerminal, TermEvent};`

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p tether-term terminal`
Expected: PASS (23 tests).

- [ ] **Step 5: Commit**

```bash
git add clients/windows/crates/tether-term/src
git commit -m "feat(windows): expose terminal modes, scrollback and selection

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Snapshot extraction

**Files:**
- Create: `clients/windows/crates/tether-term/src/snapshot.rs`
- Modify: `clients/windows/crates/tether-term/src/lib.rs`

**Interfaces:**
- Consumes: `TabTerminal` internals (`term`, `theme`), `palette::{resolve, dim}`, `tether_core::links::LinkSpan { start: usize, end: usize, url: String }` (M2).
- Produces:
  ```rust
  #[derive(Debug, Clone, PartialEq)]
  pub struct RenderCell { pub ch: char, pub zerowidth: Vec<char>, pub fg: u32, pub bg: u32, pub bold: bool, pub italic: bool, pub underline: bool, pub strikeout: bool, pub wide: bool, pub spacer: bool, pub selected: bool }
  #[derive(Debug, Clone)]
  pub struct Snapshot {
      pub cols: usize, pub rows: usize,
      pub cells: Vec<RenderCell>,          // rows × cols, row-major, viewport
      pub cursor: Option<Cell>,            // None when hidden (?25l) or scrolled out of view
      pub row_texts: Vec<String>,          // one char per column; wide-char spacers are ' '
      pub wrapped: Vec<bool>,              // row i soft-wraps into row i+1
      pub osc8: Vec<Vec<LinkSpan>>,        // explicit hyperlinks per row
      pub display_offset: usize,
      pub background: u32,
  }
  impl Snapshot { pub fn cell(&self, row: usize, col: usize) -> &RenderCell; }
  impl TabTerminal { pub fn snapshot(&self) -> Snapshot; }
  ```
  `row_texts`/`wrapped` feed `tether_core::links::detect_links`; the app merges with `osc8` via `merge_links`.

Color rules: dim → ⅔; inverse swaps fg/bg; hidden draws fg = bg; a selected cell uses the theme's `selection` as background when it has one, else swaps to foreground-on-background.

- [ ] **Step 1: Write the failing tests**

```rust
#[cfg(test)]
mod tests {
    use crate::terminal::tests::{size, term};
    use crate::terminal::{Cell, SelectKind, TabTerminal};
    use tether_core::theme::theme_named;

    #[test]
    fn plain_text_uses_the_theme_defaults() {
        let mut t = term();
        t.feed(b"hello");
        let s = t.snapshot();
        assert_eq!((s.cols, s.rows, s.cells.len()), (80, 24, 80 * 24));
        assert!(s.row_texts[0].starts_with("hello"));
        assert_eq!(s.cell(0, 0).ch, 'h');
        assert_eq!((s.cell(0, 0).fg, s.cell(0, 0).bg), (0xCCCCCC, 0x1E1E2E));
        assert_eq!(s.background, 0x1E1E2E);
    }

    #[test]
    fn sgr_colors_resolve() {
        let mut t = term();
        t.feed(b"\x1b[31mR\x1b[38;2;1;2;3mT\x1b[0;7mI\x1b[0;8mH\x1b[0;1mB");
        let s = t.snapshot();
        assert_eq!(s.cell(0, 0).fg, 0xF38BA8);
        assert_eq!(s.cell(0, 1).fg, 0x010203);
        assert_eq!((s.cell(0, 2).fg, s.cell(0, 2).bg), (0x1E1E2E, 0xCCCCCC));
        assert_eq!(s.cell(0, 3).fg, s.cell(0, 3).bg);
        assert!(s.cell(0, 4).bold);
    }

    #[test]
    fn an_osc_4_override_colors_the_cells() {
        let mut t = term();
        t.feed(b"\x1b]4;1;rgb:ff/00/00\x07\x1b[31mX");
        assert_eq!(t.snapshot().cell(0, 0).fg, 0xFF0000);
    }

    #[test]
    fn utf8_split_across_reads_is_one_character() {
        let mut t = term();
        t.feed(&[0xC3]);
        t.feed(&[0xA9]);
        assert_eq!(t.snapshot().cell(0, 0).ch, 'é');
    }

    #[test]
    fn wide_characters_take_two_cells() {
        let mut t = term();
        t.feed("界x".as_bytes());
        let s = t.snapshot();
        assert!(s.cell(0, 0).wide);
        assert!(s.cell(0, 1).spacer);
        assert!(s.row_texts[0].starts_with("界 x"));
    }

    #[test]
    fn soft_wraps_are_flagged() {
        let mut t = TabTerminal::new(size(10, 4), theme_named("tether"));
        t.feed(&[b'a'; 15]);
        let s = t.snapshot();
        assert!(s.wrapped[0]);
        assert!(!s.wrapped[1]);
    }

    #[test]
    fn osc_8_links_become_spans() {
        let mut t = term();
        t.feed(b"\x1b]8;;https://example.com\x07link\x1b]8;;\x07 x");
        let s = t.snapshot();
        assert_eq!(s.osc8[0].len(), 1);
        let span = &s.osc8[0][0];
        assert_eq!((span.start, span.end, span.url.as_str()), (0, 4, "https://example.com"));
        assert!(s.osc8[1].is_empty());
    }

    #[test]
    fn cursor_hides_with_25l_and_when_scrolled_away() {
        let mut t = term();
        t.feed(b"ab");
        assert_eq!(t.snapshot().cursor, Some(Cell { row: 0, col: 2 }));
        t.feed(b"\x1b[?25l");
        assert_eq!(t.snapshot().cursor, None);
        t.feed(b"\x1b[?25h");
        t.feed("x\r\n".repeat(40).as_bytes());
        t.scroll(10);
        assert_eq!(t.snapshot().cursor, None);
    }

    #[test]
    fn selected_cells_swap_when_the_theme_has_no_selection_color() {
        let mut t = term();
        t.feed(b"hello");
        t.selection_start(Cell { row: 0, col: 0 }, SelectKind::Simple);
        t.selection_update(Cell { row: 0, col: 1 });
        let s = t.snapshot();
        assert!(s.cell(0, 0).selected && !s.cell(0, 2).selected);
        assert_eq!((s.cell(0, 0).fg, s.cell(0, 0).bg), (0x1E1E2E, 0xCCCCCC));
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p tether-term snapshot`
Expected: FAIL — `no method named snapshot`.

- [ ] **Step 3: Implement `snapshot.rs`**

```rust
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Line, Point};
use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::vte::ansi::CursorShape as TermCursorShape;
use tether_core::links::LinkSpan;

use crate::palette;
use crate::terminal::{Cell, TabTerminal};

#[derive(Debug, Clone, PartialEq)]
pub struct RenderCell {
    pub ch: char,
    pub zerowidth: Vec<char>,
    pub fg: u32,
    pub bg: u32,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub strikeout: bool,
    pub wide: bool,
    pub spacer: bool,
    pub selected: bool,
}

#[derive(Debug, Clone)]
pub struct Snapshot {
    pub cols: usize,
    pub rows: usize,
    pub cells: Vec<RenderCell>,
    pub cursor: Option<Cell>,
    pub row_texts: Vec<String>,
    pub wrapped: Vec<bool>,
    pub osc8: Vec<Vec<LinkSpan>>,
    pub display_offset: usize,
    pub background: u32,
}

impl Snapshot {
    pub fn cell(&self, row: usize, col: usize) -> &RenderCell {
        &self.cells[row * self.cols + col]
    }
}

impl TabTerminal {
    pub fn snapshot(&self) -> Snapshot {
        let grid = self.term.grid();
        let (cols, rows) = (grid.columns(), grid.screen_lines());
        let offset = grid.display_offset();
        let colors = self.term.colors();
        let theme = &self.theme;
        let selection = self.term.selection.as_ref().and_then(|s| s.to_range(&self.term));

        let mut cells = Vec::with_capacity(cols * rows);
        let mut row_texts = Vec::with_capacity(rows);
        let mut wrapped = Vec::with_capacity(rows);
        let mut osc8 = Vec::with_capacity(rows);

        for r in 0..rows {
            let line = Line(r as i32 - offset as i32);
            let row = &grid[line];
            let mut text = String::with_capacity(cols);
            let mut spans: Vec<LinkSpan> = Vec::new();
            for c in 0..cols {
                let cell = &row[Column(c)];
                let flags = cell.flags;
                let spacer = flags.intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER);
                let mut fg = palette::resolve(theme, colors, cell.fg);
                let mut bg = palette::resolve(theme, colors, cell.bg);
                if flags.contains(Flags::DIM) {
                    fg = palette::dim(fg);
                }
                if flags.contains(Flags::INVERSE) {
                    std::mem::swap(&mut fg, &mut bg);
                }
                if flags.contains(Flags::HIDDEN) {
                    fg = bg;
                }
                let selected = selection.as_ref().is_some_and(|s| s.contains(Point::new(line, Column(c))));
                if selected {
                    match theme.selection {
                        Some(sel) => bg = sel,
                        None => (fg, bg) = (theme.background, theme.foreground),
                    }
                }
                let ch = if spacer || cell.c == '\0' { ' ' } else { cell.c };
                text.push(ch);
                if let Some(link) = cell.hyperlink() {
                    match spans.last_mut() {
                        Some(last) if last.end == c && last.url == link.uri() => last.end = c + 1,
                        _ => spans.push(LinkSpan { start: c, end: c + 1, url: link.uri().to_owned() }),
                    }
                }
                cells.push(RenderCell {
                    ch,
                    zerowidth: cell.zerowidth().map(<[char]>::to_vec).unwrap_or_default(),
                    fg,
                    bg,
                    bold: flags.contains(Flags::BOLD),
                    italic: flags.contains(Flags::ITALIC),
                    underline: flags.intersects(Flags::ALL_UNDERLINES),
                    strikeout: flags.contains(Flags::STRIKEOUT),
                    wide: flags.contains(Flags::WIDE_CHAR),
                    spacer,
                    selected,
                });
            }
            wrapped.push(row[Column(cols - 1)].flags.contains(Flags::WRAPLINE));
            row_texts.push(text);
            osc8.push(spans);
        }

        let cursor = {
            let rc = self.term.renderable_content().cursor;
            let row = rc.point.line.0 + offset as i32;
            (rc.shape != TermCursorShape::Hidden && (0..rows as i32).contains(&row))
                .then(|| Cell { row: row as usize, col: rc.point.column.0 })
        };

        Snapshot { cols, rows, cells, cursor, row_texts, wrapped, osc8, display_offset: offset, background: theme.background }
    }
}
```

`lib.rs`: add `pub mod snapshot;` and `pub use snapshot::{RenderCell, Snapshot};`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p tether-term snapshot`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add clients/windows/crates/tether-term/src
git commit -m "feat(windows): snapshot the visible grid with resolved colors and links

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Metrics and grid size

**Files:**
- Create: `clients/windows/crates/tether-term/src/metrics.rs`
- Modify: `clients/windows/crates/tether-term/src/lib.rs`

**Interfaces:**
- Consumes: `face_bytes`, `tether_core::fonts::{FontFace, font_named}`, `GridSize`.
- Produces:
  ```rust
  pub fn pt_to_px(pt: f32, scale: f32) -> f32;
  pub fn cell_metrics(font: &FontFace, size_px: f32, line_spacing: f32) -> (f32, f32);
  pub fn grid_size(width: u32, height: u32, padding_px: u32, metrics: (f32, f32)) -> GridSize;
  pub(crate) struct FaceMetrics { pub cell_w: f32, pub cell_h: f32, pub baseline: f32, pub ascent: f32, pub stroke: f32 }
  pub(crate) fn face_metrics(font: &FontFace, size_px: f32, line_spacing: f32) -> FaceMetrics;
  ```
  The app computes `padding_px = pt_to_px(prefs.padding_pt, scale).round() as u32` and `size_px = pt_to_px(prefs.size_pt, scale)`.

- [ ] **Step 1: Write the failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use tether_core::fonts::font_named;

    #[test]
    fn points_scale_with_the_monitor() {
        assert!((pt_to_px(14.0, 1.0) - 18.666_666).abs() < 1e-4);
        assert!((pt_to_px(14.0, 2.0) - 37.333_332).abs() < 1e-4);
    }

    #[test]
    fn cells_double_at_twice_the_size() {
        let font = font_named("cascadia-mono");
        let (w1, h1) = cell_metrics(font, pt_to_px(14.0, 1.0), 1.0);
        let (w2, h2) = cell_metrics(font, pt_to_px(14.0, 2.0), 1.0);
        assert!(w1 >= 8.0 && h1 >= 16.0, "{w1}x{h1}");
        assert!((w2 - 2.0 * w1).abs() <= 1.0 && (h2 - 2.0 * h1).abs() <= 1.0);
    }

    #[test]
    fn line_spacing_stretches_only_the_height() {
        let font = font_named("jetbrains-mono");
        let (w1, h1) = cell_metrics(font, 18.0, 1.0);
        let (w2, h2) = cell_metrics(font, 18.0, 1.5);
        assert_eq!(w1, w2);
        assert!((h2 - 1.5 * h1).abs() <= 1.5);
    }

    #[test]
    fn grid_fits_inside_the_padding() {
        let g = grid_size(800, 600, 8, (9.0, 18.0));
        assert_eq!((g.cols, g.rows, g.width_px, g.height_px), (87, 32, 783, 576));
    }

    #[test]
    fn a_window_smaller_than_the_padding_is_still_one_cell() {
        let g = grid_size(10, 10, 24, (9.0, 18.0));
        assert_eq!((g.cols, g.rows), (1, 1));
    }

    #[test]
    fn baseline_sits_inside_the_cell() {
        let m = face_metrics(font_named("cascadia-mono"), 18.0, 1.4);
        assert!(m.baseline > 0.0 && m.baseline < m.cell_h);
        assert!(m.stroke >= 1.0);
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p tether-term metrics`
Expected: FAIL — `cannot find function pt_to_px`.

- [ ] **Step 3: Implement**

```rust
use swash::FontRef;
use tether_core::fonts::FontFace;
use tether_core::resize::GridSize;

use crate::fonts::face_bytes;

pub fn pt_to_px(pt: f32, scale: f32) -> f32 {
    pt * 96.0 / 72.0 * scale
}

pub(crate) struct FaceMetrics {
    pub cell_w: f32,
    pub cell_h: f32,
    pub baseline: f32,
    pub ascent: f32,
    pub stroke: f32,
}

pub(crate) fn face_metrics(font: &FontFace, size_px: f32, line_spacing: f32) -> FaceMetrics {
    let face = FontRef::from_index(face_bytes(font.id).0, 0).expect("bundled font parses");
    let m = face.metrics(&[]).scale(size_px);
    let advance = face.glyph_metrics(&[]).scale(size_px).advance_width(face.charmap().map('M'));
    let ascent = m.ascent.abs();
    let natural = ascent + m.descent.abs() + m.leading.max(0.0);
    let cell_h = (natural * line_spacing).round().max(1.0);
    FaceMetrics {
        cell_w: advance.round().max(1.0),
        cell_h,
        baseline: ((cell_h - (ascent + m.descent.abs())) / 2.0 + ascent).round(),
        ascent,
        stroke: (size_px / 14.0).round().max(1.0),
    }
}

pub fn cell_metrics(font: &FontFace, size_px: f32, line_spacing: f32) -> (f32, f32) {
    let m = face_metrics(font, size_px, line_spacing);
    (m.cell_w, m.cell_h)
}

pub fn grid_size(width: u32, height: u32, padding_px: u32, (cell_w, cell_h): (f32, f32)) -> GridSize {
    let fit = |avail: u32, cell: f32| ((avail as f32 / cell).floor() as u32).clamp(1, u16::MAX as u32) as u16;
    let cols = fit(width.saturating_sub(2 * padding_px), cell_w);
    let rows = fit(height.saturating_sub(2 * padding_px), cell_h);
    GridSize { cols, rows, width_px: (cols as f32 * cell_w) as u32, height_px: (rows as f32 * cell_h) as u32 }
}
```

`lib.rs`: `pub mod metrics;` and `pub use metrics::{cell_metrics, grid_size, pt_to_px};`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p tether-term metrics`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add clients/windows/crates/tether-term/src
git commit -m "feat(windows): compute cell metrics and grid size per monitor scale

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Face fallback and glyph atlas

**Files:**
- Create: `clients/windows/crates/tether-term/src/glyphs.rs`
- Modify: `clients/windows/crates/tether-term/src/lib.rs` (`mod glyphs;`)

**Interfaces:**
- Consumes: `face_bytes`, `SYMBOLS`, `system_fallbacks()`.
- Produces (crate-internal):
  ```rust
  pub(crate) enum FaceSlot { Primary { bold: bool }, Symbols, System(usize) }   // Copy, Eq, Hash
  pub(crate) fn face_data(font: &FontFace, slot: FaceSlot) -> &'static [u8];
  pub(crate) fn resolve(font: &FontFace, bold: bool, ch: char) -> (FaceSlot, u16);  // glyph 0 = .notdef in the primary face
  pub(crate) struct GlyphKey { pub font: &'static str, pub slot: FaceSlot, pub glyph: u16 }
  pub(crate) struct RasterGlyph { pub left: i32, pub top: i32, pub width: u32, pub height: u32, pub color: bool, pub data: Vec<u8> }
  pub(crate) struct GlyphAtlas;  // new(); prepare(size_px) clears on any size change; get(&mut ScaleContext, GlyphKey) -> Option<&RasterGlyph>; len()
  ```
  The atlas holds glyphs for exactly one pixel size; a scale change (monitor move, Ctrl+=) re-keys it by clearing.

- [ ] **Step 1: Write the failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use swash::scale::ScaleContext;
    use tether_core::fonts::font_named;

    #[test]
    fn letters_come_from_the_chosen_face() {
        let font = font_named("cascadia-mono");
        assert!(matches!(resolve(font, false, 'A'), (FaceSlot::Primary { bold: false }, g) if g != 0));
        assert!(matches!(resolve(font, true, 'A'), (FaceSlot::Primary { bold: true }, g) if g != 0));
    }

    #[test]
    fn a_missing_glyph_falls_back_to_the_symbols_font() {
        let font = font_named("cascadia-mono");
        assert!(matches!(resolve(font, false, '\u{f121}'), (FaceSlot::Symbols, g) if g != 0));
    }

    #[test]
    fn a_glyph_no_font_has_is_notdef_in_the_primary_face() {
        let font = font_named("cascadia-mono");
        assert_eq!(resolve(font, false, '\u{10FFFD}'), (FaceSlot::Primary { bold: false }, 0));
    }

    #[test]
    fn the_atlas_rasterizes_once_per_size_and_clears_on_a_new_size() {
        let font = font_named("cascadia-mono");
        let mut ctx = ScaleContext::new();
        let mut atlas = GlyphAtlas::new();
        let (slot, glyph) = resolve(font, false, 'M');
        let key = GlyphKey { font: font.id, slot, glyph };

        atlas.prepare(18.0);
        let w18 = atlas.get(&mut ctx, key).unwrap().width;
        atlas.prepare(18.0);
        assert_eq!(atlas.len(), 1);

        atlas.prepare(37.0);
        assert_eq!(atlas.len(), 0);
        let w37 = atlas.get(&mut ctx, key).unwrap().width;
        assert!(w37 > w18 * 3 / 2, "{w18} → {w37}");
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p tether-term glyphs`
Expected: FAIL — `cannot find function resolve`.

- [ ] **Step 3: Implement**

```rust
use std::collections::HashMap;

use swash::FontRef;
use swash::scale::image::Content;
use swash::scale::{Render, ScaleContext, Source, StrikeWith};
use swash::zeno::Format;
use tether_core::fonts::FontFace;

use crate::fonts::{SYMBOLS, face_bytes, system_fallbacks};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum FaceSlot {
    Primary { bold: bool },
    Symbols,
    System(usize),
}

pub(crate) fn face_data(font: &FontFace, slot: FaceSlot) -> &'static [u8] {
    match slot {
        FaceSlot::Primary { bold: false } => face_bytes(font.id).0,
        FaceSlot::Primary { bold: true } => face_bytes(font.id).1,
        FaceSlot::Symbols => SYMBOLS,
        FaceSlot::System(i) => system_fallbacks()[i],
    }
}

fn glyph_in(data: &[u8], ch: char) -> u16 {
    FontRef::from_index(data, 0).map_or(0, |f| f.charmap().map(ch))
}

pub(crate) fn resolve(font: &FontFace, bold: bool, ch: char) -> (FaceSlot, u16) {
    let primary = FaceSlot::Primary { bold };
    let slots = [primary, FaceSlot::Symbols]
        .into_iter()
        .chain((0..system_fallbacks().len()).map(FaceSlot::System));
    for slot in slots {
        let glyph = glyph_in(face_data(font, slot), ch);
        if glyph != 0 {
            return (slot, glyph);
        }
    }
    (primary, 0)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) struct GlyphKey {
    pub font: &'static str,
    pub slot: FaceSlot,
    pub glyph: u16,
}

pub(crate) struct RasterGlyph {
    pub left: i32,
    pub top: i32,
    pub width: u32,
    pub height: u32,
    pub color: bool,
    pub data: Vec<u8>,
}

pub(crate) struct GlyphAtlas {
    size_px: f32,
    glyphs: HashMap<GlyphKey, Option<RasterGlyph>>,
}

impl GlyphAtlas {
    pub fn new() -> Self {
        GlyphAtlas { size_px: 0.0, glyphs: HashMap::new() }
    }

    pub fn prepare(&mut self, size_px: f32) {
        if size_px.to_bits() != self.size_px.to_bits() {
            self.glyphs.clear();
            self.size_px = size_px;
        }
    }

    pub fn len(&self) -> usize {
        self.glyphs.len()
    }

    pub fn get(&mut self, ctx: &mut ScaleContext, key: GlyphKey) -> Option<&RasterGlyph> {
        let size_px = self.size_px;
        self.glyphs.entry(key).or_insert_with(|| rasterize(ctx, key, size_px)).as_ref()
    }
}

fn rasterize(ctx: &mut ScaleContext, key: GlyphKey, size_px: f32) -> Option<RasterGlyph> {
    let font = tether_core::fonts::font_named(key.font);
    let face = FontRef::from_index(face_data(font, key.slot), 0)?;
    let mut scaler = ctx.builder(face).size(size_px).hint(true).build();
    let image = Render::new(&[Source::ColorOutline(0), Source::ColorBitmap(StrikeWith::BestFit), Source::Outline])
        .format(Format::Alpha)
        .render(&mut scaler, key.glyph)?;
    Some(RasterGlyph {
        left: image.placement.left,
        top: image.placement.top,
        width: image.placement.width,
        height: image.placement.height,
        color: matches!(image.content, Content::Color),
        data: image.data,
    })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p tether-term glyphs`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add clients/windows/crates/tether-term/src
git commit -m "feat(windows): resolve glyph fallbacks and cache them per pixel size

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Rasterizer — full repaint to RGBA

**Files:**
- Create: `clients/windows/crates/tether-term/src/raster.rs`
- Modify: `clients/windows/crates/tether-term/src/lib.rs`

**Interfaces:**
- Consumes: `Snapshot`, `face_metrics`, `GlyphAtlas`, `resolve`, `tether_core::prefs::CursorShape { Block, Bar, Underline }`, `TerminalTheme`, `FontFace`.
- Produces:
  ```rust
  #[derive(Debug, Clone, PartialEq, Eq)]
  pub struct RgbaImage { pub width: u32, pub height: u32, pub pixels: Vec<u8> }   // RGBA8, row-major, alpha 255
  impl RgbaImage { pub fn pixel(&self, x: u32, y: u32) -> [u8; 4]; }
  pub struct RenderStyle<'a> {
      pub theme: &'a TerminalTheme, pub font: &'static FontFace, pub size_px: f32, pub line_spacing: f32,
      pub padding_px: u32, pub cursor: CursorShape, pub cursor_on: bool,
      pub hover_link: Option<(usize, usize, usize)>,   // (row, start col, end col exclusive)
  }
  pub struct Rasterizer;
  impl Rasterizer { pub fn new() -> Self; pub fn render(&mut self, snap: &Snapshot, style: &RenderStyle, width: u32, height: u32) -> RgbaImage; }
  ```
  `width`/`height` are the well's physical pixels; the grid's bottom sits at `height − padding`, left at `padding`. Grid taller than the well (local redraw before the PTY resize lands) is clipped at the top. `cursor_on` is the app's blink phase and focus; the cursor's shape is the user's setting.

- [ ] **Step 1: Write the failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::metrics::{cell_metrics, pt_to_px};
    use crate::terminal::TabTerminal;
    use crate::terminal::tests::size;
    use tether_core::fonts::font_named;
    use tether_core::prefs::CursorShape;
    use tether_core::theme::{TerminalTheme, theme_named};

    fn style<'a>(theme: &'a TerminalTheme, scale: f32) -> RenderStyle<'a> {
        RenderStyle {
            theme,
            font: font_named("cascadia-mono"),
            size_px: pt_to_px(14.0, scale),
            line_spacing: 1.0,
            padding_px: (8.0 * scale) as u32,
            cursor: CursorShape::Block,
            cursor_on: false,
            hover_link: None,
        }
    }

    fn snap(text: &[u8]) -> Snapshot {
        let mut t = TabTerminal::new(size(20, 4), theme_named("tether"));
        t.feed(text);
        t.snapshot()
    }

    fn rgba(rgb: u32) -> [u8; 4] {
        [(rgb >> 16) as u8, (rgb >> 8) as u8, rgb as u8, 255]
    }

    fn cell_has_ink(img: &RgbaImage, x0: u32, y0: u32, w: u32, h: u32, bg: u32) -> bool {
        (y0..y0 + h).any(|y| (x0..x0 + w).any(|x| img.pixel(x, y) != rgba(bg)))
    }

    #[test]
    fn buffer_matches_the_requested_size_at_1x_and_2x() {
        let theme = theme_named("tether");
        let mut r = Rasterizer::new();
        let one = r.render(&snap(b"hi"), &style(theme, 1.0), 300, 120);
        assert_eq!((one.width, one.height, one.pixels.len()), (300, 120, 300 * 120 * 4));
        let two = r.render(&snap(b"hi"), &style(theme, 2.0), 600, 240);
        assert_eq!(two.pixels.len(), 600 * 240 * 4);
    }

    #[test]
    fn the_well_is_the_theme_background() {
        let mut r = Rasterizer::new();
        let img = r.render(&snap(b""), &style(theme_named("tether"), 1.0), 300, 120);
        assert_eq!(img.pixel(0, 0), [0x1E, 0x1E, 0x2E, 255]);
        let img = r.render(&snap(b""), &style(theme_named("dracula"), 1.0), 300, 120);
        assert_eq!(img.pixel(299, 119), [0x28, 0x2A, 0x36, 255]);
    }

    #[test]
    fn the_grid_is_bottom_anchored_inside_the_padding() {
        let theme = theme_named("tether");
        let st = RenderStyle { cursor_on: true, ..style(theme, 1.0) };
        let (cw, ch) = cell_metrics(st.font, st.size_px, 1.0);
        let height = (4.0 * ch) as u32 + 2 * st.padding_px + 7;
        let img = Rasterizer::new().render(&snap(b""), &st, 300, height);
        let top = height - st.padding_px - (4.0 * ch) as u32;
        assert_eq!(img.pixel(st.padding_px + 1, top + 1), rgba(theme.cursor), "block cursor at row 0, col 0");
        assert_eq!(img.pixel(st.padding_px + 1, top - 1), rgba(theme.background));
        assert_eq!(img.pixel(st.padding_px - 1, top + 1), rgba(theme.background));
        assert!(cw > 0.0);
    }

    #[test]
    fn bar_and_underline_cursors_do_not_fill_the_cell() {
        let theme = theme_named("tether");
        for shape in [CursorShape::Bar, CursorShape::Underline] {
            let st = RenderStyle { cursor_on: true, cursor: shape, padding_px: 0, ..style(theme, 1.0) };
            let (cw, ch) = cell_metrics(st.font, st.size_px, 1.0);
            let img = Rasterizer::new().render(&snap(b""), &st, (20.0 * cw) as u32, (4.0 * ch) as u32);
            let centre = img.pixel((cw / 2.0) as u32 + 1, (ch / 3.0) as u32);
            assert_eq!(centre, rgba(theme.background), "{shape:?}");
        }
    }

    #[test]
    fn glyphs_are_drawn_and_missing_ones_fall_back() {
        let theme = theme_named("tether");
        let st = RenderStyle { padding_px: 0, ..style(theme, 1.0) };
        let (cw, ch) = cell_metrics(st.font, st.size_px, 1.0);
        let (w, h) = ((20.0 * cw) as u32, (4.0 * ch) as u32);
        let img = Rasterizer::new().render(&snap("M\u{f121}".as_bytes()), &st, w, h);
        assert!(cell_has_ink(&img, 0, 0, cw as u32, ch as u32, theme.background), "M");
        assert!(cell_has_ink(&img, cw as u32, 0, cw as u32, ch as u32, theme.background), "nerd icon from symbols font");
    }

    #[test]
    fn a_hovered_link_is_underlined() {
        let theme = theme_named("tether");
        let plain = style(theme, 1.0);
        let hovered = RenderStyle { hover_link: Some((0, 0, 4)), ..style(theme, 1.0) };
        let s = snap(b"link");
        let mut r = Rasterizer::new();
        assert_ne!(r.render(&s, &plain, 300, 120), r.render(&s, &hovered, 300, 120));
    }

    #[test]
    fn a_scale_change_never_reuses_glyphs_of_the_old_size() {
        let theme = theme_named("tether");
        let s = snap(b"scale");
        let mut reused = Rasterizer::new();
        reused.render(&s, &style(theme, 1.0), 300, 120);
        let after = reused.render(&s, &style(theme, 2.0), 600, 240);
        let fresh = Rasterizer::new().render(&s, &style(theme, 2.0), 600, 240);
        assert_eq!(after, fresh);
    }

    #[test]
    fn a_well_smaller_than_the_padding_does_not_panic() {
        let theme = theme_named("tether");
        let st = RenderStyle { padding_px: 24, ..style(theme, 1.0) };
        let img = Rasterizer::new().render(&snap(b"x"), &st, 10, 10);
        assert_eq!(img.pixels.len(), 10 * 10 * 4);
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p tether-term raster`
Expected: FAIL — `cannot find struct Rasterizer`.

- [ ] **Step 3: Implement `raster.rs`**

```rust
use std::collections::HashMap;

use swash::scale::ScaleContext;
use swash::shape::ShapeContext;
use tether_core::fonts::FontFace;
use tether_core::prefs::CursorShape;
use tether_core::theme::TerminalTheme;

use crate::glyphs::{FaceSlot, GlyphAtlas, GlyphKey, RasterGlyph, resolve};
use crate::metrics::{FaceMetrics, face_metrics};
use crate::snapshot::Snapshot;
use crate::terminal::Cell;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RgbaImage {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
}

impl RgbaImage {
    fn filled(width: u32, height: u32, rgb: u32) -> Self {
        let px = [(rgb >> 16) as u8, (rgb >> 8) as u8, rgb as u8, 255];
        RgbaImage { width, height, pixels: px.repeat((width * height) as usize) }
    }

    pub fn pixel(&self, x: u32, y: u32) -> [u8; 4] {
        let i = ((y * self.width + x) * 4) as usize;
        self.pixels[i..i + 4].try_into().unwrap()
    }

    fn fill_rect(&mut self, x: i32, y: i32, w: i32, h: i32, rgb: u32) {
        let (x0, y0) = (x.max(0), y.max(0));
        let (x1, y1) = ((x + w).min(self.width as i32), (y + h).min(self.height as i32));
        let px = [(rgb >> 16) as u8, (rgb >> 8) as u8, rgb as u8, 255];
        for yy in y0..y1 {
            for xx in x0..x1 {
                let i = ((yy as u32 * self.width + xx as u32) * 4) as usize;
                self.pixels[i..i + 4].copy_from_slice(&px);
            }
        }
    }

    fn draw_glyph(&mut self, glyph: &RasterGlyph, x: i32, y: i32, rgb: u32) {
        let fg = [(rgb >> 16) as u8, (rgb >> 8) as u8, rgb as u8];
        for gy in 0..glyph.height as i32 {
            for gx in 0..glyph.width as i32 {
                let (px, py) = (x + gx, y + gy);
                if px < 0 || py < 0 || px >= self.width as i32 || py >= self.height as i32 {
                    continue;
                }
                let i = ((py as u32 * self.width + px as u32) * 4) as usize;
                let g = (gy as u32 * glyph.width + gx as u32) as usize;
                let (src, alpha) = if glyph.color {
                    let s = &glyph.data[g * 4..g * 4 + 4];
                    ([s[0], s[1], s[2]], s[3] as u32)
                } else {
                    (fg, glyph.data[g] as u32)
                };
                for c in 0..3 {
                    let dst = self.pixels[i + c] as u32;
                    self.pixels[i + c] = ((src[c] as u32 * alpha + dst * (255 - alpha)) / 255) as u8;
                }
            }
        }
    }
}

pub struct RenderStyle<'a> {
    pub theme: &'a TerminalTheme,
    pub font: &'static FontFace,
    pub size_px: f32,
    pub line_spacing: f32,
    pub padding_px: u32,
    pub cursor: CursorShape,
    pub cursor_on: bool,
    pub hover_link: Option<(usize, usize, usize)>,
}

pub struct Rasterizer {
    scale: ScaleContext,
    shape: ShapeContext,
    atlas: GlyphAtlas,
    // Parsing a face's charmap per cell per frame is measurable at 60 Hz; the answer never changes.
    resolved: HashMap<(&'static str, bool, char), (FaceSlot, u16)>,
}

impl Default for Rasterizer {
    fn default() -> Self {
        Self::new()
    }
}

impl Rasterizer {
    pub fn new() -> Self {
        Rasterizer {
            scale: ScaleContext::new(),
            shape: ShapeContext::new(),
            atlas: GlyphAtlas::new(),
            resolved: HashMap::new(),
        }
    }

    fn lookup(&mut self, font: &'static FontFace, bold: bool, ch: char) -> (FaceSlot, u16) {
        *self.resolved.entry((font.id, bold, ch)).or_insert_with(|| resolve(font, bold, ch))
    }

    pub fn render(&mut self, snap: &Snapshot, style: &RenderStyle, width: u32, height: u32) -> RgbaImage {
        self.render_with(snap, style, width, height, style.font.ligatures)
    }

    pub(crate) fn render_with(
        &mut self,
        snap: &Snapshot,
        style: &RenderStyle,
        width: u32,
        height: u32,
        ligatures: bool,
    ) -> RgbaImage {
        self.atlas.prepare(style.size_px);
        let m = face_metrics(style.font, style.size_px, style.line_spacing);
        let mut img = RgbaImage::filled(width, height, style.theme.background);
        let pad = style.padding_px as i32;
        let origin_y = height as i32 - pad - (snap.rows as f32 * m.cell_h) as i32;
        let cell_x = |col: usize| pad + (col as f32 * m.cell_w) as i32;
        let cell_y = |row: usize| origin_y + (row as f32 * m.cell_h) as i32;
        let (cw, chh) = (m.cell_w as i32, m.cell_h as i32);

        for row in 0..snap.rows {
            let y = cell_y(row);
            if y + chh <= 0 {
                continue;
            }
            for col in 0..snap.cols {
                let cell = snap.cell(row, col);
                let (mut fg, mut bg) = (cell.fg, cell.bg);
                if self.block_cursor_at(snap, style, row, col) {
                    (fg, bg) = (style.theme.background, style.theme.cursor);
                }
                let span = if cell.wide { 2 } else { 1 };
                if bg != style.theme.background {
                    img.fill_rect(cell_x(col), y, cw * span, chh, bg);
                }
                if !ligatures && !cell.spacer && cell.ch != ' ' {
                    self.draw_char(&mut img, style.font, cell.bold, cell.ch, cell_x(col), y + m.baseline as i32, fg);
                    for &mark in &cell.zerowidth {
                        self.draw_char(&mut img, style.font, cell.bold, mark, cell_x(col), y + m.baseline as i32, fg);
                    }
                }
                let hovered = style.hover_link.is_some_and(|(r, s, e)| r == row && (s..e).contains(&col));
                if cell.underline || hovered {
                    img.fill_rect(cell_x(col), y + m.baseline as i32 + m.stroke as i32, cw * span, m.stroke as i32, fg);
                }
                if cell.strikeout {
                    let sy = y + m.baseline as i32 - (m.ascent / 3.0) as i32;
                    img.fill_rect(cell_x(col), sy, cw * span, m.stroke as i32, fg);
                }
            }
            if ligatures {
                self.draw_shaped_row(&mut img, snap, style, &m, row, cell_x(0), y);
            }
        }
        self.draw_thin_cursor(&mut img, snap, style, &m, cell_x, cell_y);
        img
    }

    fn block_cursor_at(&self, snap: &Snapshot, style: &RenderStyle, row: usize, col: usize) -> bool {
        style.cursor_on && style.cursor == CursorShape::Block && snap.cursor == Some(Cell { row, col })
    }

    fn draw_thin_cursor(
        &self,
        img: &mut RgbaImage,
        snap: &Snapshot,
        style: &RenderStyle,
        m: &FaceMetrics,
        cell_x: impl Fn(usize) -> i32,
        cell_y: impl Fn(usize) -> i32,
    ) {
        let Some(Cell { row, col }) = snap.cursor.filter(|_| style.cursor_on) else { return };
        let (x, y, cw, ch) = (cell_x(col), cell_y(row), m.cell_w as i32, m.cell_h as i32);
        let thick = (m.stroke as i32 * 2).max(1);
        match style.cursor {
            CursorShape::Block => {}
            CursorShape::Bar => img.fill_rect(x, y, thick, ch, style.theme.cursor),
            CursorShape::Underline => img.fill_rect(x, y + ch - thick, cw, thick, style.theme.cursor),
        }
    }

    fn draw_char(&mut self, img: &mut RgbaImage, font: &'static FontFace, bold: bool, ch: char, x: i32, baseline: i32, rgb: u32) {
        let (slot, glyph) = self.lookup(font, bold, ch);
        let key = GlyphKey { font: font.id, slot, glyph };
        if let Some(g) = self.atlas.get(&mut self.scale, key) {
            img.draw_glyph(g, x + g.left, baseline - g.top, rgb);
        }
    }
}
```

`draw_shaped_row` gets its real body in Task 10; for this task add a per-character version so `ligatures == true` (Cascadia Code) still renders text:

```rust
impl Rasterizer {
    fn draw_shaped_row(&mut self, img: &mut RgbaImage, snap: &Snapshot, style: &RenderStyle, m: &FaceMetrics, row: usize, x0: i32, y: i32) {
        for col in 0..snap.cols {
            let cell = snap.cell(row, col);
            if cell.spacer || cell.ch == ' ' {
                continue;
            }
            let fg = self.cell_fg(snap, style, row, col);
            self.draw_char(img, style.font, cell.bold, cell.ch, x0 + (col as f32 * m.cell_w) as i32, y + m.baseline as i32, fg);
        }
    }

    fn cell_fg(&self, snap: &Snapshot, style: &RenderStyle, row: usize, col: usize) -> u32 {
        if self.block_cursor_at(snap, style, row, col) { style.theme.background } else { snap.cell(row, col).fg }
    }
}
```

`lib.rs`: `mod glyphs; pub mod raster;` and `pub use raster::{Rasterizer, RenderStyle, RgbaImage};`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p tether-term raster`
Expected: PASS (8 tests).

- [ ] **Step 5: Run the whole crate, fmt and clippy**

Run: `cargo test -p tether-term && cargo fmt --check -p tether-term && cargo clippy -p tether-term --all-targets -- -D warnings`
Expected: all PASS, no warnings.

- [ ] **Step 6: Commit**

```bash
git add clients/windows/crates/tether-term/src
git commit -m "feat(windows): rasterize the terminal grid into an RGBA buffer

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Cascadia Code ligatures

**Files:**
- Modify: `clients/windows/crates/tether-term/src/raster.rs`

**Interfaces:**
- Consumes: `ShapeContext` (swash `shape`), `FontFace::ligatures` (true only for `cascadia-code`, M1).
- Produces (crate-internal): `Rasterizer::shape_run(&mut self, font: &'static FontFace, bold: bool, text: &str, size_px: f32, cell_w: f32) -> Vec<(usize, u16, f32)>` — (char index of the cluster, glyph id, x in px from the run start). `draw_shaped_row` keeps its Task 9 signature; only its body changes.

Runs are maximal stretches of a row whose cells are non-spacer, non-wide, same `bold` and resolve to the primary face. Each glyph is placed at its cluster's **cell** (`index × cell_w`) plus its offset inside the cluster, never at the shaper's accumulated pen: the font's advance is fractional (10.55 px for Cascadia at 18 px) while cells are rounded, so a free-running pen drifts off the grid by a pixel every few columns. Cells outside runs (fallback glyphs, wide chars) draw per character.

- [ ] **Step 1: Write the failing tests** (append to `raster.rs` tests)

```rust
    #[test]
    fn cascadia_code_substitutes_glyphs_for_arrows() {
        let font = font_named("cascadia-code");
        let mut r = Rasterizer::new();
        let (cw, _) = cell_metrics(font, 18.0, 1.0);
        let shaped = r.shape_run(font, false, "=>", 18.0, cw);
        let (_, plain_eq) = crate::glyphs::resolve(font, false, '=');
        let (_, plain_gt) = crate::glyphs::resolve(font, false, '>');
        let ids: Vec<u16> = shaped.iter().map(|g| g.1).collect();
        assert_ne!(ids, [plain_eq, plain_gt]);
    }

    #[test]
    fn only_cascadia_code_draws_ligatures() {
        let theme = theme_named("tether");
        let code = RenderStyle { font: font_named("cascadia-code"), ..style(theme, 1.0) };
        let s = snap(b"a => b");
        let mut r = Rasterizer::new();
        let ligated = r.render(&s, &code, 300, 120);
        let unligated = r.render_with(&s, &code, 300, 120, false);
        assert_ne!(ligated, unligated);
        assert!(!font_named("cascadia-mono").ligatures);
    }

    #[test]
    fn shaped_text_stays_on_the_cell_grid() {
        let font = font_named("cascadia-code");
        let mut r = Rasterizer::new();
        let (cw, _) = cell_metrics(font, 18.0, 1.0);
        let shaped = r.shape_run(font, false, "a=>b-x", 18.0, cw);
        let last = shaped.last().unwrap();
        assert_eq!(last.0, 5);
        assert_eq!(last.2, 5.0 * cw, "the last glyph sits exactly on its cell");
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p tether-term raster`
Expected: FAIL — `no method named shape_run`.

- [ ] **Step 3: Implement** — replace the Task 9 body of `draw_shaped_row` and add `shape_run`:

```rust
use swash::FontRef;

use crate::glyphs::face_data;
use crate::snapshot::RenderCell;

impl Rasterizer {
    pub(crate) fn shape_run(
        &mut self,
        font: &'static FontFace,
        bold: bool,
        text: &str,
        size_px: f32,
        cell_w: f32,
    ) -> Vec<(usize, u16, f32)> {
        let Some(face) = FontRef::from_index(face_data(font, FaceSlot::Primary { bold }), 0) else {
            return Vec::new();
        };
        let byte_of_char: Vec<usize> = text.char_indices().map(|(byte, _)| byte).collect();
        let mut shaper = self.shape.builder(face).size(size_px).build();
        shaper.add_str(text);
        let mut out = Vec::new();
        shaper.shape_with(|cluster| {
            let index = byte_of_char.partition_point(|&b| b < cluster.source.start as usize);
            let mut inside = 0.0;
            for glyph in cluster.glyphs {
                out.push((index, glyph.id, index as f32 * cell_w + inside + glyph.x));
                inside += glyph.advance;
            }
        });
        out
    }

    fn draw_shaped_row(&mut self, img: &mut RgbaImage, snap: &Snapshot, style: &RenderStyle, m: &FaceMetrics, row: usize, x0: i32, y: i32) {
        let baseline = y + m.baseline as i32;
        let primary: Vec<bool> = (0..snap.cols)
            .map(|col| {
                let c: &RenderCell = snap.cell(row, col);
                !c.spacer && !c.wide && matches!(self.lookup(style.font, c.bold, c.ch).0, FaceSlot::Primary { .. })
            })
            .collect();
        let mut col = 0;
        while col < snap.cols {
            let cell = snap.cell(row, col);
            if !primary[col] {
                if !cell.spacer && cell.ch != ' ' {
                    let fg = self.cell_fg(snap, style, row, col);
                    self.draw_char(img, style.font, cell.bold, cell.ch, x0 + (col as f32 * m.cell_w) as i32, baseline, fg);
                }
                col += 1;
                continue;
            }
            let (start, bold) = (col, cell.bold);
            let mut text = String::new();
            while col < snap.cols && primary[col] && snap.cell(row, col).bold == bold {
                text.push(snap.cell(row, col).ch);
                col += 1;
            }
            let run_x = x0 + (start as f32 * m.cell_w) as i32;
            for (index, glyph, x) in self.shape_run(style.font, bold, &text, style.size_px, m.cell_w) {
                let c = start + index;
                if snap.cell(row, c).ch == ' ' {
                    continue;
                }
                let fg = self.cell_fg(snap, style, row, c);
                let key = GlyphKey { font: style.font.id, slot: FaceSlot::Primary { bold }, glyph };
                if let Some(g) = self.atlas.get(&mut self.scale, key) {
                    img.draw_glyph(g, run_x + x.round() as i32 + g.left, baseline - g.top, fg);
                }
            }
        }
    }
}
```

`cell_fg` and the call site in `render_with` stay as Task 9 wrote them. The tests reach the private `atlas`/`shape` fields because they live in `raster.rs`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p tether-term raster`
Expected: PASS (11 tests).

- [ ] **Step 5: Run the whole crate, fmt and clippy**

Run: `cargo test -p tether-term && cargo fmt --check -p tether-term && cargo clippy -p tether-term --all-targets -- -D warnings`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add clients/windows/crates/tether-term/src
git commit -m "feat(windows): draw Cascadia Code ligatures on the cell grid

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Self-review notes (for the implementer)

- **Spec → task map:** Font faces/ids/fallback/bundling → T1, T8. Scrollback 10 000 → T5. Bottom-anchored full repaint, padding, theme well → T9. pt at monitor scale → T7. Cascadia ligatures only → T10. Replies (OSC 10/11/12/4, DA, DSR, 14t/18t, 21t ignored, title push/pop) → T3. OSC 4 set / 104 reset / 110–112, overrides kept on theme change → T4. OSC 9 / 777 / 9;4 / 7 / 52 reports → T4. Modes for keys, mouse reporting, bracketed paste → T5. Selection (drag/word/line) → T5. Links input (row texts, wrapped, OSC 8) → T6. Spec Tests → Rasterizer line (size at 1×/2×, well color, symbols fallback) → T9.
- **Out of this milestone:** OSC 52 focus gating, bell throttle, toast throttle, link opening, mouse-report encoding, wheel → arrows on the alternate screen, blink timer, frame coalescing and the 150 ms resize settle live in M2 (rules) and M6 (wiring). Shipping `CascadiaCode-LICENSE.txt` and the iOS `LICENSES.md` with the app is M6 packaging.

## Deviations

No public name from the roadmap contract or a task's Produces block was renamed.

- `ReportEvent::CwdChanged` (added in M2) is matched with an empty arm in `apply_report`. Cwd `TermEvent`s still come from the plan's before/after cwd check, so a report does not emit the event twice.
- `GlyphAtlas::len` is allowed `dead_code` outside tests. `draw_char` and `draw_shaped_row` allow `clippy::too_many_arguments`.
- `tether-term/Cargo.toml` pins `alacritty_terminal` and `swash` on the crate instead of the workspace dependency table, so M3 could edit that table at the same time.

