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
            dots: [
                t.ansi[1], t.ansi[2], t.ansi[3], t.ansi[4], t.ansi[5], t.ansi[6],
            ],
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
    FONTS
        .iter()
        .map(|f| FontRowVm {
            id: f.id,
            name: f.name,
            active: f.id == active,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tether_comes_first_and_is_active_by_default() {
        let rows = scheme_rows("", "tether");
        assert_eq!(rows.len(), catalog().len());
        assert_eq!(
            (rows[0].id.as_str(), rows[0].name.as_str(), rows[0].meta),
            ("tether", "Tether", "Dark")
        );
        assert!(rows[0].active);
        assert_eq!(rows.iter().filter(|r| r.active).count(), 1);
    }

    #[test]
    fn swatch_colors_come_from_the_theme() {
        let row = &scheme_rows("", "tether")[0];
        let t = theme_named("tether");
        assert_eq!(
            (row.background, row.foreground),
            (t.background, t.foreground)
        );
        assert_eq!((row.blue, row.green), (t.ansi[4], t.ansi[2]));
        assert_eq!(
            row.dots,
            [
                t.ansi[1], t.ansi[2], t.ansi[3], t.ansi[4], t.ansi[5], t.ansi[6]
            ]
        );
    }

    #[test]
    fn search_ignores_case_and_whitespace() {
        let latte = scheme_rows("  LATTE ", "tether");
        assert_eq!(latte.len(), 1);
        assert_eq!(
            (latte[0].name.as_str(), latte[0].meta),
            ("Catppuccin Latte", "Light")
        );
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
        assert_eq!(
            (rows[0].id, rows[0].name),
            ("cascadia-mono", "Cascadia Mono")
        );
        assert!(rows[0].active);
        let names: Vec<_> = rows.iter().map(|r| r.name).collect();
        assert_eq!(
            names,
            [
                "Cascadia Mono",
                "Cascadia Code",
                "JetBrains Mono",
                "Monaspace Neon",
                "Monaspace Radon",
                "Maple Mono",
                "Comic Mono"
            ]
        );
        assert!(font_rows("menlo")[0].active);
        assert!(font_rows("comic-mono")[6].active);
    }
}
