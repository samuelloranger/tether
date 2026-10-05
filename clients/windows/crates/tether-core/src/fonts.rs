#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FontFace {
    pub id: &'static str,
    pub name: &'static str,
    pub ligatures: bool,
}

const fn face(id: &'static str, name: &'static str, ligatures: bool) -> FontFace {
    FontFace {
        id,
        name,
        ligatures,
    }
}

pub const FONTS: [FontFace; 7] = [
    face("cascadia-mono", "Cascadia Mono", false),
    face("cascadia-code", "Cascadia Code", true),
    face("jetbrains-mono", "JetBrains Mono", false),
    face("monaspace-neon", "Monaspace Neon", false),
    face("monaspace-radon", "Monaspace Radon", false),
    face("maple-mono", "Maple Mono", false),
    face("comic-mono", "Comic Mono", false),
];

pub fn font_named(id: &str) -> &'static FontFace {
    FONTS.iter().find(|f| f.id == id).unwrap_or(&FONTS[0])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_follow_the_ios_form_in_menu_order() {
        let ids: Vec<&str> = FONTS.iter().map(|f| f.id).collect();
        assert_eq!(
            ids,
            [
                "cascadia-mono",
                "cascadia-code",
                "jetbrains-mono",
                "monaspace-neon",
                "monaspace-radon",
                "maple-mono",
                "comic-mono"
            ]
        );
        assert_eq!(FONTS[0].name, "Cascadia Mono");
    }

    #[test]
    fn only_cascadia_code_draws_ligatures() {
        let with: Vec<&str> = FONTS.iter().filter(|f| f.ligatures).map(|f| f.id).collect();
        assert_eq!(with, ["cascadia-code"]);
    }

    #[test]
    fn unknown_ids_fall_back_to_cascadia_mono() {
        assert_eq!(font_named("jetbrains-mono").name, "JetBrains Mono");
        assert_eq!(font_named("menlo").id, "cascadia-mono");
        assert_eq!(font_named("sf-mono").id, "cascadia-mono");
    }
}
