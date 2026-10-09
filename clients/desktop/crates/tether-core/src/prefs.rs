use std::io;
use std::ops::RangeInclusive;

use serde::{Deserialize, Deserializer, Serialize};

use crate::{DataDir, theme_named};

pub const PREFERENCES_FILE: &str = "preferences.json";
pub const DEFAULT_SIZE_PT: f32 = 14.0;
pub const SIZE_RANGE: RangeInclusive<f32> = 8.0..=24.0;
pub const SPACING_RANGE: RangeInclusive<f32> = 1.0..=1.6;
pub const PADDING_RANGE: RangeInclusive<f32> = 0.0..=24.0;
pub const MIN_CLIENT_WIDTH: u32 = 640;
pub const MIN_CLIENT_HEIGHT: u32 = 420;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CursorShape {
    #[default]
    Block,
    Bar,
    Underline,
}

/// `null` (how serde_json writes NaN) reads as NaN, which `clamped` then replaces.
fn lenient_f32<'de, D: Deserializer<'de>>(d: D) -> Result<f32, D::Error> {
    Ok(Option::<f32>::deserialize(d)?.unwrap_or(f32::NAN))
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct TerminalPrefs {
    pub scheme: String,
    pub font: String,
    #[serde(deserialize_with = "lenient_f32")]
    pub size_pt: f32,
    #[serde(deserialize_with = "lenient_f32")]
    pub line_spacing: f32,
    #[serde(deserialize_with = "lenient_f32")]
    pub padding_pt: f32,
    pub cursor: CursorShape,
    pub blink: bool,
}

impl Default for TerminalPrefs {
    fn default() -> Self {
        Self {
            scheme: "tether".into(),
            font: "cascadia-mono".into(),
            size_pt: DEFAULT_SIZE_PT,
            line_spacing: 1.0,
            padding_pt: 8.0,
            cursor: CursorShape::Block,
            blink: false,
        }
    }
}

fn snap(value: f32, step: f32, range: RangeInclusive<f32>, fallback: f32) -> f32 {
    if !value.is_finite() {
        return fallback;
    }
    let snapped = (value / step).round() * step;
    // Round off float noise from the step multiply (1.25 not 1.2500001).
    let snapped = (snapped * 100.0).round() / 100.0;
    snapped.clamp(*range.start(), *range.end())
}

impl TerminalPrefs {
    pub fn clamped(mut self) -> Self {
        self.size_pt = snap(self.size_pt, 1.0, SIZE_RANGE, DEFAULT_SIZE_PT);
        self.line_spacing = snap(self.line_spacing, 0.05, SPACING_RANGE, 1.0);
        self.padding_pt = snap(self.padding_pt, 2.0, PADDING_RANGE, 8.0);
        self
    }

    pub fn bigger(&mut self) {
        self.size_pt = snap(self.size_pt + 1.0, 1.0, SIZE_RANGE, DEFAULT_SIZE_PT);
    }

    pub fn smaller(&mut self) {
        self.size_pt = snap(self.size_pt - 1.0, 1.0, SIZE_RANGE, DEFAULT_SIZE_PT);
    }

    pub fn reset_size(&mut self) {
        self.size_pt = DEFAULT_SIZE_PT;
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct WindowPlacement {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub maximized: bool,
}

/// Which builds the updater installs: releases, or a build of every change on main.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum UpdateChannel {
    #[default]
    Stable,
    Edge,
}

/// A value this version does not know reads as stable rather than failing the whole file.
impl<'de> Deserialize<'de> for UpdateChannel {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Ok(match serde_json::Value::deserialize(d)?.as_str() {
            Some("edge") => Self::Edge,
            _ => Self::Stable,
        })
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Preferences {
    pub terminal: TerminalPrefs,
    pub window: Option<WindowPlacement>,
    pub update_channel: UpdateChannel,
}

/// What is read from disk: `Preferences` plus the `theme_mode` field it no longer has.
#[derive(Default, Deserialize)]
#[serde(default)]
struct Stored {
    theme_mode: Option<serde_json::Value>,
    #[serde(flatten)]
    prefs: Preferences,
}

impl Preferences {
    /// `system_is_light` only matters for a file that still carries the old `theme_mode`.
    pub fn load(dir: &DataDir, system_is_light: bool) -> io::Result<Self> {
        let stored: Stored = dir.load(PREFERENCES_FILE)?;
        let mut p = stored.prefs;
        p.terminal = p.terminal.clamped();
        if let Some(mode) = stored.theme_mode.as_ref().and_then(|v| v.as_str()) {
            p.migrate_theme_mode(mode, system_is_light);
            // Drop the old field from disk so a later change of the Windows theme cannot flip the result.
            // A failed save only means the migration runs again next launch.
            let _ = p.save(dir);
        }
        Ok(p)
    }

    fn migrate_theme_mode(&mut self, mode: &str, system_is_light: bool) {
        let light = mode == "light" || (mode == "system" && system_is_light);
        if light && theme_named(&self.terminal.scheme).id == "tether" {
            self.terminal.scheme = "tether-light".into();
        }
    }

    pub fn save(&self, dir: &DataDir) -> io::Result<()> {
        dir.save(PREFERENCES_FILE, self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_defaults() {
        let p = Preferences::default();
        let t = p.terminal;
        assert_eq!(
            (t.scheme.as_str(), t.font.as_str()),
            ("tether", "cascadia-mono")
        );
        assert_eq!((t.size_pt, t.line_spacing, t.padding_pt), (14.0, 1.0, 8.0));
        assert_eq!((t.cursor, t.blink), (CursorShape::Block, false));
        assert!(p.window.is_none());
        assert_eq!(p.update_channel, UpdateChannel::Stable);
    }

    #[test]
    fn update_channel_round_trips_and_unknown_values_read_as_stable() {
        let edge = Preferences {
            update_channel: UpdateChannel::Edge,
            ..Preferences::default()
        };
        let json = serde_json::to_string(&edge).unwrap();
        assert!(json.contains(r#""update_channel":"edge""#), "{json}");
        let back: Preferences = serde_json::from_str(&json).unwrap();
        assert_eq!(back.update_channel, UpdateChannel::Edge);
        for stored in [
            r#"{"update_channel":"beta"}"#,
            r#"{"update_channel":null}"#,
            r#"{"update_channel":3}"#,
            "{}",
        ] {
            let p: Preferences = serde_json::from_str(stored).unwrap();
            assert_eq!(p.update_channel, UpdateChannel::Stable, "{stored}");
        }
    }

    #[test]
    fn clamps_and_snaps_to_steps() {
        let t = TerminalPrefs {
            size_pt: 99.0,
            line_spacing: 0.2,
            padding_pt: 7.0,
            ..TerminalPrefs::default()
        }
        .clamped();
        assert_eq!((t.size_pt, t.line_spacing, t.padding_pt), (24.0, 1.0, 8.0));
        let t = TerminalPrefs {
            size_pt: 3.0,
            line_spacing: 1.234,
            padding_pt: 99.0,
            ..TerminalPrefs::default()
        }
        .clamped();
        assert_eq!((t.size_pt, t.padding_pt), (8.0, 24.0));
        assert!((t.line_spacing - 1.25).abs() < 1e-6);
        let t = TerminalPrefs {
            size_pt: 12.4,
            line_spacing: 9.0,
            padding_pt: -3.0,
            ..TerminalPrefs::default()
        }
        .clamped();
        assert_eq!((t.size_pt, t.line_spacing, t.padding_pt), (12.0, 1.6, 0.0));
    }

    #[test]
    fn non_finite_values_fall_back_to_defaults() {
        let t = TerminalPrefs {
            size_pt: f32::NAN,
            line_spacing: f32::INFINITY,
            padding_pt: f32::NAN,
            ..TerminalPrefs::default()
        }
        .clamped();
        assert_eq!((t.size_pt, t.line_spacing, t.padding_pt), (14.0, 1.0, 8.0));
    }

    #[test]
    fn font_size_shortcuts_step_by_one_and_stop_at_the_ends() {
        let mut t = TerminalPrefs::default();
        t.bigger();
        assert_eq!(t.size_pt, 15.0);
        t.smaller();
        t.smaller();
        assert_eq!(t.size_pt, 13.0);
        t.size_pt = 24.0;
        t.bigger();
        assert_eq!(t.size_pt, 24.0);
        t.size_pt = 8.0;
        t.smaller();
        assert_eq!(t.size_pt, 8.0);
        t.reset_size();
        assert_eq!(t.size_pt, 14.0);
    }

    #[test]
    fn partial_and_out_of_range_prefs_load_clamped() {
        let dir = tempfile::tempdir().unwrap();
        let data = DataDir::new(dir.path());
        std::fs::write(
            dir.path().join(PREFERENCES_FILE),
            r#"{"terminal":{"size_pt":99,"line_spacing":null,"cursor":"bar","future_field":1},"unknown":true}"#,
        )
        .unwrap();
        let p = Preferences::load(&data, false).unwrap();
        assert_eq!(p.terminal.size_pt, 24.0);
        assert_eq!(p.terminal.line_spacing, 1.0);
        assert_eq!(p.terminal.cursor, CursorShape::Bar);
        assert_eq!(p.terminal.font, "cascadia-mono");
    }

    #[test]
    fn round_trips_through_the_data_dir() {
        let dir = tempfile::tempdir().unwrap();
        let data = DataDir::new(dir.path());
        let p = Preferences {
            terminal: TerminalPrefs {
                scheme: "dracula".into(),
                ..TerminalPrefs::default()
            },
            window: Some(WindowPlacement {
                x: -1200,
                y: 40,
                width: 1280,
                height: 800,
                maximized: false,
            }),
            update_channel: UpdateChannel::Edge,
        };
        p.save(&data).unwrap();
        assert_eq!(Preferences::load(&data, false).unwrap(), p);
    }

    fn load_with(json: &str, system_is_light: bool) -> (Preferences, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(PREFERENCES_FILE), json).unwrap();
        let p = Preferences::load(&DataDir::new(dir.path()), system_is_light).unwrap();
        (p, dir)
    }

    fn scheme_after(json: &str, system_is_light: bool) -> String {
        load_with(json, system_is_light).0.terminal.scheme
    }

    #[test]
    fn an_old_light_mode_moves_tether_to_tether_light() {
        let json = r#"{"theme_mode":"light","terminal":{"scheme":"tether"}}"#;
        assert_eq!(scheme_after(json, false), "tether-light");
        assert_eq!(
            scheme_after(r#"{"theme_mode":"light"}"#, false),
            "tether-light"
        );
    }

    #[test]
    fn an_old_system_mode_follows_windows_once() {
        let json = r#"{"theme_mode":"system"}"#;
        assert_eq!(scheme_after(json, true), "tether-light");
        assert_eq!(scheme_after(json, false), "tether");
    }

    #[test]
    fn an_old_dark_mode_changes_nothing() {
        assert_eq!(scheme_after(r#"{"theme_mode":"dark"}"#, true), "tether");
    }

    #[test]
    fn another_scheme_is_kept() {
        let json = r#"{"theme_mode":"light","terminal":{"scheme":"dracula"}}"#;
        assert_eq!(scheme_after(json, true), "dracula");
    }

    #[test]
    fn the_old_field_is_never_written_back() {
        let (p, dir) = load_with(r#"{"theme_mode":"light"}"#, false);
        let on_disk = std::fs::read_to_string(dir.path().join(PREFERENCES_FILE)).unwrap();
        assert!(!on_disk.contains("theme_mode"));
        assert!(!serde_json::to_string(&p).unwrap().contains("theme_mode"));
        assert_eq!(
            Preferences::load(&DataDir::new(dir.path()), true)
                .unwrap()
                .terminal
                .scheme,
            "tether-light"
        );
    }

    #[test]
    fn a_full_old_format_file_survives_the_migration() {
        let json = r#"{
            "theme_mode": "light",
            "unknown_top_level": {"a": 1},
            "terminal": {
                "scheme": "tether", "font": "jetbrains-mono", "size_pt": 16,
                "line_spacing": 1.25, "padding_pt": 12, "cursor": "bar", "blink": true
            },
            "window": {"x": -10, "y": 20, "width": 1000, "height": 700, "maximized": true}
        }"#;
        let (p, dir) = load_with(json, false);
        let expected = Preferences {
            terminal: TerminalPrefs {
                scheme: "tether-light".into(),
                font: "jetbrains-mono".into(),
                size_pt: 16.0,
                line_spacing: 1.25,
                padding_pt: 12.0,
                cursor: CursorShape::Bar,
                blink: true,
            },
            window: Some(WindowPlacement {
                x: -10,
                y: 20,
                width: 1000,
                height: 700,
                maximized: true,
            }),
            update_channel: UpdateChannel::Stable,
        };
        assert_eq!(p, expected);
        assert_eq!(
            Preferences::load(&DataDir::new(dir.path()), true).unwrap(),
            expected
        );
    }

    #[test]
    fn a_non_string_theme_mode_still_loads_the_rest() {
        let json = r#"{"theme_mode":42,"terminal":{"scheme":"dracula","size_pt":18}}"#;
        let p = load_with(json, true).0;
        assert_eq!(
            (p.terminal.scheme.as_str(), p.terminal.size_pt),
            ("dracula", 18.0)
        );
    }
}
