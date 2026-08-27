//! PTY input helpers: mouse reports, Ctrl/backspace rewriting, and the
//! control-sequence tables the shell observes (OSC 52, OSC 7, OSC 777, OSC 99,
//! DECSCUSR, colour-query replies).
//!
//! Mechanical port of `apps/mobile/src/{mouseSeq,mouseInput,input,ptyInput,terminalControls}.ts`.

use std::collections::HashMap;
use std::sync::LazyLock;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use regex::Regex;
use serde::{Deserialize, Serialize};

static OSC7_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^file://[^/]*(/.*)$").expect("OSC7_RE"));

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MouseMode {
    Off,
    X10,
    Normal,
    Button,
    Any,
}

impl MouseMode {
    pub fn parse(value: &str) -> Self {
        match value {
            "x10" => Self::X10,
            "normal" => Self::Normal,
            "button" => Self::Button,
            "any" => Self::Any,
            _ => Self::Off,
        }
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct MouseSeqOpts {
    pub release: bool,
    pub motion: bool,
}

#[derive(Debug, Clone, Copy)]
pub struct PixelRect {
    pub left: f64,
    pub top: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct CellPos {
    pub col: u32,
    pub row: u32,
}

/// Encode a mouse event as SGR (`?1006h`) or legacy X10 bytes.
pub fn mouse_seq(btn: u32, col: u32, row: u32, sgr: bool, opts: MouseSeqOpts) -> String {
    let motion = if opts.motion { 32 } else { 0 };
    if sgr {
        let cb = btn + motion;
        let final_byte = if opts.release { 'm' } else { 'M' };
        return format!("\x1b[<{cb};{col};{row}{final_byte}");
    }
    let cb = if opts.release {
        (btn & !0b11) | 0b11
    } else {
        btn
    } + motion;
    let enc = |n: u32| char::from_u32((n + 32).min(127)).unwrap_or('\u{7f}');
    format!("\x1b[M{}{}{}", enc(cb), enc(col), enc(row))
}

pub fn cell_from_point(x: f64, y: f64, rect: PixelRect, cols: u32, rows: u32) -> CellPos {
    let col = map_axis(x, rect.left, rect.width, cols);
    let row = map_axis(y, rect.top, rect.height, rows);
    CellPos { col, row }
}

fn map_axis(pos: f64, origin: f64, span: f64, max: u32) -> u32 {
    if max == 0 {
        return 1;
    }
    let cell = span / f64::from(max);
    if cell == 0.0 || !cell.is_finite() {
        return 1;
    }
    let raw = ((pos - origin) / cell).floor() + 1.0;
    if !raw.is_finite() {
        return 1;
    }
    raw.clamp(1.0, f64::from(max)) as u32
}

pub fn press_seq(col: u32, row: u32, sgr: bool, btn: u32, mods: u32) -> String {
    mouse_seq(btn + mods, col, row, sgr, MouseSeqOpts::default())
}

pub fn release_seq(
    col: u32,
    row: u32,
    mode: MouseMode,
    sgr: bool,
    btn: u32,
    mods: u32,
) -> Option<String> {
    if mode == MouseMode::X10 {
        return None;
    }
    Some(mouse_seq(
        btn + mods,
        col,
        row,
        sgr,
        MouseSeqOpts {
            release: true,
            motion: false,
        },
    ))
}

pub fn motion_seq(
    col: u32,
    row: u32,
    mode: MouseMode,
    sgr: bool,
    btn: u32,
    mods: u32,
) -> Option<String> {
    if mode != MouseMode::Button && mode != MouseMode::Any {
        return None;
    }
    Some(mouse_seq(
        btn + mods,
        col,
        row,
        sgr,
        MouseSeqOpts {
            release: false,
            motion: true,
        },
    ))
}

pub fn click_seqs(
    col: u32,
    row: u32,
    mode: MouseMode,
    sgr: bool,
    btn: u32,
    mods: u32,
) -> Vec<String> {
    let mut seqs = vec![press_seq(col, row, sgr, btn, mods)];
    if let Some(rel) = release_seq(col, row, mode, sgr, btn, mods) {
        seqs.push(rel);
    }
    seqs
}

/// Encode one mouse action for the shell. `kind` is `press`, `release`, `motion`,
/// `click`, or `wheel` (wheel is a press with `btn` 64/65).
pub fn encode_mouse_kind(
    kind: &str,
    col: u32,
    row: u32,
    mode: MouseMode,
    sgr: bool,
    btn: u32,
    mods: u32,
) -> Vec<String> {
    match kind {
        "release" => release_seq(col, row, mode, sgr, btn, mods)
            .into_iter()
            .collect(),
        "motion" => motion_seq(col, row, mode, sgr, btn, mods)
            .into_iter()
            .collect(),
        "click" => click_seqs(col, row, mode, sgr, btn, mods),
        "press" | "wheel" => vec![press_seq(col, row, sgr, btn, mods)],
        _ => Vec::new(),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PtyInputSource {
    Typed,
    Key,
    Paste,
    Program,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CtrlRewrite {
    pub bytes: String,
    pub consumed: bool,
}

/// The `ESC[200~` / `ESC[201~` pair that fences a bracketed paste.
pub const PASTE_START: &str = "\u{1B}[200~";
pub const PASTE_END: &str = "\u{1B}[201~";

/// Bytes to send for a paste, fenced when the program has bracketed paste on.
///
/// The clipboard is untrusted. Text carrying its own `ESC[201~` would close the
/// fence early, and everything after it would arrive as typing — the next
/// newline then runs as Enter, so a copied snippet could execute the rest of
/// itself. xterm strips the markers out of pasted data for exactly this reason;
/// do the same, and strip them whether or not the fence goes on, since outside
/// a paste they mean nothing to the program either.
pub fn paste_payload(text: &str, bracketed: bool) -> String {
    let clean = text.replace(PASTE_START, "").replace(PASTE_END, "");
    if bracketed {
        format!("{PASTE_START}{clean}{PASTE_END}")
    } else {
        clean
    }
}

pub fn apply_ctrl_modifier(armed: bool, bytes: &str) -> CtrlRewrite {
    if !armed || bytes.is_empty() {
        return CtrlRewrite {
            bytes: bytes.to_string(),
            consumed: false,
        };
    }
    let mut chars = bytes.chars();
    if let (Some(ch), None) = (chars.next(), chars.next()) {
        if ch.is_ascii_alphabetic() {
            let ctrl = char::from(ch.to_ascii_uppercase() as u8 - 64);
            return CtrlRewrite {
                bytes: ctrl.to_string(),
                consumed: true,
            };
        }
    }
    CtrlRewrite {
        bytes: bytes.to_string(),
        consumed: true,
    }
}

const ESC: char = '\x1b';
const CURSOR_FINALS: &str = "ABCDHF";

pub fn apply_ctrl_to_key(armed: bool, bytes: &str) -> CtrlRewrite {
    if !armed || bytes.is_empty() {
        return CtrlRewrite {
            bytes: bytes.to_string(),
            consumed: false,
        };
    }
    let buf = bytes.as_bytes();
    if buf.len() == 3
        && buf[0] == 0x1b
        && (buf[1] == b'[' || buf[1] == b'O')
        && CURSOR_FINALS.contains(buf[2] as char)
    {
        return CtrlRewrite {
            bytes: format!("{ESC}[1;5{}", buf[2] as char),
            consumed: true,
        };
    }
    if buf.len() > 3 && buf[0] == 0x1b && buf[1] == b'[' && bytes.ends_with('~') {
        let params = &bytes[2..bytes.len() - 1];
        if params.bytes().all(|b| b.is_ascii_digit()) {
            return CtrlRewrite {
                bytes: format!("{ESC}[{params};5~"),
                consumed: true,
            };
        }
    }
    apply_ctrl_modifier(armed, bytes)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BackspaceStreak {
    pub count: u32,
    pub last_at: u64,
}

pub const EMPTY_STREAK: BackspaceStreak = BackspaceStreak {
    count: 0,
    last_at: 0,
};
pub const STREAK_GAP_MS: u64 = 150;
pub const STREAK_THRESHOLD: u32 = 15;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackspaceRewrite {
    pub streak: BackspaceStreak,
    pub bytes: String,
}

pub fn apply_backspace_streak(streak: BackspaceStreak, bytes: &str, now: u64) -> BackspaceRewrite {
    if bytes != "\x7f" {
        return BackspaceRewrite {
            streak: EMPTY_STREAK,
            bytes: bytes.to_string(),
        };
    }
    let count = if now.saturating_sub(streak.last_at) < STREAK_GAP_MS {
        streak.count + 1
    } else {
        1
    };
    BackspaceRewrite {
        streak: BackspaceStreak {
            count,
            last_at: now,
        },
        bytes: if count > STREAK_THRESHOLD {
            "\x17".to_string()
        } else {
            "\x7f".to_string()
        },
    }
}

pub fn base64_to_utf8(b64: &str) -> Option<String> {
    let mut padded = b64.to_string();
    while !padded.len().is_multiple_of(4) {
        padded.push('=');
    }
    let bytes = STANDARD.decode(padded.as_bytes()).ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

pub fn hex_to_osc_color(hex: &str) -> String {
    let h = hex.trim_start_matches('#');
    let r = h.get(0..2).unwrap_or("00");
    let g = h.get(2..4).unwrap_or("00");
    let b = h.get(4..6).unwrap_or("00");
    format!("rgb:{r}{r}/{g}{g}/{b}{b}")
}

/// OSC 52 payload after the `52;` identifier: `"<selectors>;<base64|empty|?>"`.
pub fn parse_osc52(data: &str) -> Option<String> {
    let sep = data.find(';')?;
    let payload = &data[sep + 1..];
    if payload == "?" {
        return None;
    }
    base64_to_utf8(payload)
}

pub fn parse_osc7_cwd(data: &str) -> Option<String> {
    let caps = OSC7_RE.captures(data)?;
    let path = caps.get(1)?.as_str();
    Some(percent_decode(path).unwrap_or_else(|| path.to_string()))
}

fn percent_decode(input: &str) -> Option<String> {
    let mut out = Vec::new();
    let bytes = input.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

pub fn parse_osc777(data: &str) -> Option<(String, String)> {
    let mut parts = data.split(';');
    if parts.next() != Some("notify") {
        return None;
    }
    Some((
        parts.next().unwrap_or("").to_string(),
        parts.next().unwrap_or("").to_string(),
    ))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CursorStyle {
    Block,
    Bar,
    Underline,
}

pub fn cursor_style_from_decscusr(ps: u32) -> CursorStyle {
    match ps {
        5 | 6 => CursorStyle::Bar,
        3 | 4 => CursorStyle::Underline,
        _ => CursorStyle::Block,
    }
}

#[derive(Debug, Default)]
pub struct KittyNotifications {
    pending: HashMap<String, (String, String)>,
}

impl KittyNotifications {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn clear(&mut self) {
        self.pending.clear();
    }

    pub fn dispatch(&mut self, data: &str) -> Option<(String, String)> {
        let body_sep = data.find(';')?;
        let mut meta = HashMap::new();
        for kv in data[..body_sep].split(':') {
            if let Some((k, v)) = kv.split_once('=') {
                meta.insert(k.to_string(), v.to_string());
            }
        }
        let mut payload = data[body_sep + 1..].to_string();
        if meta.get("e").map(String::as_str) == Some("1") {
            payload = base64_to_utf8(&payload)?;
        }
        let id = meta.get("i").cloned().unwrap_or_default();
        let kind = meta
            .get("p")
            .cloned()
            .unwrap_or_else(|| "title".to_string());
        let buf = self.pending.entry(id.clone()).or_default();
        if kind == "title" {
            buf.0.push_str(&payload);
        } else if kind == "body" {
            buf.1.push_str(&payload);
        }
        if meta.get("d").map(String::as_str) == Some("0") {
            return None;
        }
        let finished = self.pending.remove(&id).unwrap_or_default();
        if finished.0.is_empty() && finished.1.is_empty() {
            None
        } else {
            Some(finished)
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn paste_payload_fences_only_when_the_program_asked() {
        assert_eq!(
            paste_payload("ls -la", true),
            "\u{1B}[200~ls -la\u{1B}[201~"
        );
        assert_eq!(paste_payload("ls -la", false), "ls -la");
    }

    #[test]
    fn paste_payload_strips_embedded_markers() {
        let hostile = "echo safe\u{1B}[201~\nrm -rf /\n";
        assert_eq!(
            paste_payload(hostile, true),
            "\u{1B}[200~echo safe\nrm -rf /\n\u{1B}[201~"
        );
        // ...and outside a fence they are still meaningless noise.
        assert_eq!(paste_payload(hostile, false), "echo safe\nrm -rf /\n");
    }

    use super::*;

    #[test]
    fn mouse_seq_sgr_encodes_wheel_up_down() {
        assert_eq!(
            mouse_seq(64, 40, 12, true, MouseSeqOpts::default()),
            "\x1b[<64;40;12M"
        );
        assert_eq!(
            mouse_seq(65, 1, 1, true, MouseSeqOpts::default()),
            "\x1b[<65;1;1M"
        );
    }

    #[test]
    fn mouse_seq_legacy_offsets_by_32() {
        assert_eq!(
            mouse_seq(64, 1, 1, false, MouseSeqOpts::default()),
            "\x1b[M`!!"
        );
        assert_eq!(
            mouse_seq(65, 1, 1, false, MouseSeqOpts::default()),
            "\x1b[Ma!!"
        );
    }

    #[test]
    fn mouse_seq_legacy_clamps_to_single_utf8_byte() {
        let seq = mouse_seq(65, 300, 300, false, MouseSeqOpts::default());
        for ch in seq.chars() {
            assert!(ch as u32 <= 127);
        }
        assert_eq!(seq, format!("\x1b[Ma{}{}", '\u{7f}', '\u{7f}'));
    }

    #[test]
    fn mouse_seq_press_release_motion() {
        assert_eq!(
            mouse_seq(
                0,
                5,
                3,
                true,
                MouseSeqOpts {
                    release: true,
                    motion: false
                }
            ),
            "\x1b[<0;5;3m"
        );
        assert_eq!(
            mouse_seq(
                0,
                5,
                3,
                true,
                MouseSeqOpts {
                    release: false,
                    motion: true
                }
            ),
            "\x1b[<32;5;3M"
        );
        assert_eq!(
            mouse_seq(
                0,
                1,
                1,
                false,
                MouseSeqOpts {
                    release: true,
                    motion: false
                }
            ),
            "\x1b[M#!!"
        );
        assert_eq!(
            mouse_seq(
                0,
                1,
                1,
                false,
                MouseSeqOpts {
                    release: false,
                    motion: true
                }
            ),
            "\x1b[M@!!"
        );
    }

    #[test]
    fn cell_from_point_maps_to_1_based_clamped_cell() {
        let rect = PixelRect {
            left: 0.0,
            top: 0.0,
            width: 800.0,
            height: 480.0,
        };
        assert_eq!(
            cell_from_point(0.0, 0.0, rect, 80, 24),
            CellPos { col: 1, row: 1 }
        );
        assert_eq!(
            cell_from_point(15.0, 45.0, rect, 80, 24),
            CellPos { col: 2, row: 3 }
        );
        assert_eq!(
            cell_from_point(10000.0, 10000.0, rect, 80, 24),
            CellPos { col: 80, row: 24 }
        );
        assert_eq!(
            cell_from_point(-50.0, -50.0, rect, 80, 24),
            CellPos { col: 1, row: 1 }
        );
    }

    #[test]
    fn click_seqs_press_and_release_by_mode() {
        assert_eq!(
            click_seqs(5, 3, MouseMode::Normal, true, 0, 0),
            vec!["\x1b[<0;5;3M".to_string(), "\x1b[<0;5;3m".to_string()]
        );
        assert_eq!(
            click_seqs(5, 3, MouseMode::X10, true, 0, 0),
            vec!["\x1b[<0;5;3M".to_string()]
        );
    }

    #[test]
    fn drag_builders_honour_mode() {
        assert_eq!(motion_seq(5, 3, MouseMode::Normal, true, 0, 0), None);
        assert_eq!(motion_seq(5, 3, MouseMode::X10, true, 0, 0), None);
        assert_eq!(
            motion_seq(5, 3, MouseMode::Button, true, 0, 0),
            Some("\x1b[<32;5;3M".into())
        );
        assert_eq!(
            motion_seq(5, 3, MouseMode::Any, true, 0, 0),
            Some("\x1b[<32;5;3M".into())
        );
        assert_eq!(release_seq(5, 3, MouseMode::X10, true, 0, 0), None);
        assert_eq!(
            release_seq(5, 3, MouseMode::Button, true, 0, 0),
            Some("\x1b[<0;5;3m".into())
        );
        assert_eq!(press_seq(5, 3, true, 0, 0), "\x1b[<0;5;3M");
        assert_eq!(
            encode_mouse_kind("click", 5, 3, MouseMode::Normal, true, 0, 0),
            vec!["\x1b[<0;5;3M".to_string(), "\x1b[<0;5;3m".to_string()]
        );
        assert_eq!(
            encode_mouse_kind("wheel", 1, 1, MouseMode::Normal, true, 64, 0),
            vec!["\x1b[<64;1;1M".to_string()]
        );
    }

    #[test]
    fn apply_ctrl_modifier_rewrites_letters() {
        assert_eq!(
            apply_ctrl_modifier(true, "c"),
            CtrlRewrite {
                bytes: "\u{3}".into(),
                consumed: true
            }
        );
        assert_eq!(
            apply_ctrl_modifier(true, "V"),
            CtrlRewrite {
                bytes: "\u{16}".into(),
                consumed: true
            }
        );
        assert_eq!(
            apply_ctrl_modifier(true, "hello"),
            CtrlRewrite {
                bytes: "hello".into(),
                consumed: true
            }
        );
        assert_eq!(
            apply_ctrl_modifier(false, "c"),
            CtrlRewrite {
                bytes: "c".into(),
                consumed: false
            }
        );
    }

    #[test]
    fn apply_ctrl_to_key_injects_csi_parameter_5() {
        assert_eq!(
            apply_ctrl_to_key(true, "\x1b[C"),
            CtrlRewrite {
                bytes: "\x1b[1;5C".into(),
                consumed: true
            }
        );
        assert_eq!(
            apply_ctrl_to_key(true, "\x1bOC"),
            CtrlRewrite {
                bytes: "\x1b[1;5C".into(),
                consumed: true
            }
        );
        assert_eq!(
            apply_ctrl_to_key(true, "\x1b[H"),
            CtrlRewrite {
                bytes: "\x1b[1;5H".into(),
                consumed: true
            }
        );
        assert_eq!(
            apply_ctrl_to_key(true, "\x1b[3~"),
            CtrlRewrite {
                bytes: "\x1b[3;5~".into(),
                consumed: true
            }
        );
        assert_eq!(
            apply_ctrl_to_key(true, "\x1b[6~"),
            CtrlRewrite {
                bytes: "\x1b[6;5~".into(),
                consumed: true
            }
        );
        assert_eq!(
            apply_ctrl_to_key(true, "\t"),
            CtrlRewrite {
                bytes: "\t".into(),
                consumed: true
            }
        );
        assert_eq!(
            apply_ctrl_to_key(true, "c"),
            CtrlRewrite {
                bytes: "\u{3}".into(),
                consumed: true
            }
        );
        assert_eq!(
            apply_ctrl_to_key(false, "\x1b[C"),
            CtrlRewrite {
                bytes: "\x1b[C".into(),
                consumed: false
            }
        );
    }

    #[test]
    fn backspace_streak_passes_through_until_threshold() {
        let mut s = EMPTY_STREAK;
        for i in 0..STREAK_THRESHOLD {
            let r = apply_backspace_streak(s, "\x7f", 1000 + u64::from(i) * 100);
            assert_eq!(r.bytes, "\x7f");
            s = r.streak;
        }
    }

    #[test]
    fn backspace_streak_upgrades_to_word_delete_past_threshold() {
        let mut last = BackspaceRewrite {
            streak: EMPTY_STREAK,
            bytes: String::new(),
        };
        for i in 0..=STREAK_THRESHOLD {
            last = apply_backspace_streak(last.streak, "\x7f", 1000 + u64::from(i) * 100);
        }
        assert_eq!(last.bytes, "\x17");
    }

    #[test]
    fn backspace_streak_gap_resets_to_char_delete() {
        let mut s = EMPTY_STREAK;
        for i in 0..=STREAK_THRESHOLD {
            s = apply_backspace_streak(s, "\x7f", 1000 + u64::from(i) * 100).streak;
        }
        let r = apply_backspace_streak(s, "\x7f", 100_000);
        assert_eq!(r.bytes, "\x7f");
    }

    #[test]
    fn backspace_streak_breaks_on_other_bytes() {
        let mut s = EMPTY_STREAK;
        for i in 0..=STREAK_THRESHOLD {
            s = apply_backspace_streak(s, "\x7f", 1000 + u64::from(i) * 100).streak;
        }
        let typed = apply_backspace_streak(s, "a", 2600);
        assert_eq!(typed.bytes, "a");
        let after = apply_backspace_streak(typed.streak, "\x7f", 2700);
        assert_eq!(after.bytes, "\x7f");
    }

    #[test]
    fn hex_to_osc_color_doubles_each_byte() {
        assert_eq!(hex_to_osc_color("#1e1e2e"), "rgb:1e1e/1e1e/2e2e");
    }

    #[test]
    fn osc52_decodes_base64_and_ignores_query() {
        assert_eq!(parse_osc52("c;Y29waWVk"), Some("copied".into()));
        assert_eq!(parse_osc52("c;?"), None);
        assert_eq!(parse_osc52("no-sep"), None);
    }

    #[test]
    fn osc7_extracts_path() {
        assert_eq!(
            parse_osc7_cwd("file://host/home/sam"),
            Some("/home/sam".into())
        );
    }

    #[test]
    fn osc777_splits_title_and_body() {
        assert_eq!(
            parse_osc777("notify;Build done;All green"),
            Some(("Build done".into(), "All green".into()))
        );
        assert_eq!(parse_osc777("other;x;y"), None);
    }

    #[test]
    fn kitty_waits_for_final_chunk() {
        let mut kitty = KittyNotifications::new();
        assert_eq!(kitty.dispatch("i=1:d=0:p=title;Hello"), None);
        assert_eq!(
            kitty.dispatch("i=1:p=body;World"),
            Some(("Hello".into(), "World".into()))
        );
    }

    #[test]
    fn decscusr_maps_cursor_style() {
        assert_eq!(cursor_style_from_decscusr(6), CursorStyle::Bar);
        assert_eq!(cursor_style_from_decscusr(2), CursorStyle::Block);
        assert_eq!(cursor_style_from_decscusr(4), CursorStyle::Underline);
    }
}
