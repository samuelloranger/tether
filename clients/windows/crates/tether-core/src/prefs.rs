use std::io;
use std::ops::RangeInclusive;

use serde::{Deserialize, Deserializer, Serialize};

use crate::DataDir;

pub const PREFERENCES_FILE: &str = "preferences.json";
pub const DEFAULT_SIZE_PT: f32 = 14.0;
pub const SIZE_RANGE: RangeInclusive<f32> = 8.0..=24.0;
pub const SPACING_RANGE: RangeInclusive<f32> = 1.0..=1.6;
pub const PADDING_RANGE: RangeInclusive<f32> = 0.0..=24.0;
pub const MIN_CLIENT_WIDTH: u32 = 640;
pub const MIN_CLIENT_HEIGHT: u32 = 420;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThemeMode {
    System,
    // Night is the default scene, as on iOS.
    #[default]
    Dark,
    Light,
}

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

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Preferences {
    pub theme_mode: ThemeMode,
    pub terminal: TerminalPrefs,
    pub window: Option<WindowPlacement>,
}

impl Preferences {
    pub fn load(dir: &DataDir) -> Self {
        let mut p: Preferences = dir.load(PREFERENCES_FILE);
        p.terminal = p.terminal.clamped();
        p
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
        assert_eq!(p.theme_mode, ThemeMode::Dark);
        let t = p.terminal;
        assert_eq!(
            (t.scheme.as_str(), t.font.as_str()),
            ("tether", "cascadia-mono")
        );
        assert_eq!((t.size_pt, t.line_spacing, t.padding_pt), (14.0, 1.0, 8.0));
        assert_eq!((t.cursor, t.blink), (CursorShape::Block, false));
        assert!(p.window.is_none());
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
        let p = Preferences::load(&data);
        assert_eq!(p.theme_mode, ThemeMode::Dark);
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
            theme_mode: ThemeMode::Light,
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
        };
        p.save(&data).unwrap();
        assert_eq!(Preferences::load(&data), p);
    }
}
