use std::sync::LazyLock;

use serde::Deserialize;

// One file for both clients, so the catalogs never drift.
const THEMES_JSON: &str =
    include_str!("../../../../apple/TetherKit/Sources/TetherKit/Resources/TerminalThemes.json");
pub const THEMES_LICENSE: &str = include_str!(
    "../../../../apple/TetherKit/Sources/TetherKit/Resources/TerminalThemes-LICENSE.txt"
);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalTheme {
    pub id: String,
    pub name: String,
    pub background: u32,
    pub foreground: u32,
    pub cursor: u32,
    pub selection: Option<u32>,
    pub ansi: [u32; 16],
}

#[derive(Deserialize)]
struct Entry {
    id: String,
    name: String,
    background: String,
    foreground: String,
    cursor: Option<String>,
    selection: Option<String>,
    ansi: Vec<String>,
}

fn hex(s: &str) -> Option<u32> {
    (s.len() == 6)
        .then(|| u32::from_str_radix(s, 16).ok())
        .flatten()
}

impl Entry {
    fn theme(self) -> Option<TerminalTheme> {
        let background = hex(&self.background)?;
        let foreground = hex(&self.foreground)?;
        let ansi: Vec<u32> = self.ansi.iter().filter_map(|a| hex(a)).collect();
        Some(TerminalTheme {
            id: self.id,
            name: self.name,
            background,
            foreground,
            cursor: self.cursor.as_deref().and_then(hex).unwrap_or(foreground),
            selection: self.selection.as_deref().and_then(hex),
            ansi: ansi.try_into().ok()?,
        })
    }
}

fn tether_theme() -> TerminalTheme {
    TerminalTheme {
        id: "tether".into(),
        name: "Tether".into(),
        background: 0x1E1E2E,
        foreground: 0xCCCCCC,
        cursor: 0xFFFFFF,
        selection: None,
        ansi: [
            0x1E1E2E, 0xF38BA8, 0xA6E3A1, 0xF9E2AF, 0x89B4FA, 0xCBA6F7, 0x94E2D5, 0xCDD6F4,
            0x585872, 0xF38BA8, 0xA6E3A1, 0xF9E2AF, 0x89B4FA, 0xCBA6F7, 0x94E2D5, 0xFFFFFF,
        ],
    }
}

static CATALOG: LazyLock<Vec<TerminalTheme>> = LazyLock::new(|| {
    let bundled: Vec<Entry> = serde_json::from_str(THEMES_JSON).unwrap_or_default();
    std::iter::once(tether_theme())
        .chain(bundled.into_iter().filter_map(Entry::theme))
        .collect()
});

pub fn catalog() -> &'static [TerminalTheme] {
    &CATALOG
}

pub fn theme_named(id: &str) -> &'static TerminalTheme {
    catalog()
        .iter()
        .find(|t| t.id == id)
        .unwrap_or(&catalog()[0])
}

impl TerminalTheme {
    pub fn tether() -> &'static TerminalTheme {
        &catalog()[0]
    }

    /// Same rule as iOS: relative luminance of the background above 0.5.
    pub fn is_light(&self) -> bool {
        let c = |shift: u32| ((self.background >> shift) & 0xFF) as f64 / 255.0;
        0.2126 * c(16) + 0.7152 * c(8) + 0.0722 * c(0) > 0.5
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tether_is_first_and_is_the_well_color() {
        let first = &catalog()[0];
        assert_eq!(
            (first.id.as_str(), first.name.as_str()),
            ("tether", "Tether")
        );
        assert_eq!(first.background, 0x1E1E2E);
        assert_eq!(first.foreground, 0xCCCCCC);
        assert_eq!(first.cursor, 0xFFFFFF);
        assert_eq!(first.ansi[15], 0xFFFFFF);
    }

    #[test]
    fn the_shared_catalog_follows_in_its_own_order() {
        assert_eq!(catalog().len(), 45);
        assert_eq!(catalog()[1].id, "catppuccin-mocha");
        let mut ids: Vec<&str> = catalog().iter().map(|t| t.id.as_str()).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), catalog().len());
    }

    #[test]
    fn lookup_falls_back_to_tether() {
        assert_eq!(theme_named("dracula").name, "Dracula");
        assert_eq!(theme_named("no-such-theme").id, "tether");
        assert_eq!(theme_named("").id, "tether");
    }

    #[test]
    fn light_or_dark_by_relative_luminance() {
        assert!(theme_named("catppuccin-latte").is_light());
        assert!(!theme_named("catppuccin-mocha").is_light());
        assert!(!TerminalTheme::tether().is_light());
    }

    #[test]
    fn license_ships_with_the_catalog() {
        assert!(!THEMES_LICENSE.trim().is_empty());
    }
}
