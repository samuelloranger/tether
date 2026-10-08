use std::sync::RwLock;

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

/// Downloaded families, added at launch and when a download finishes. A `FontFace` is
/// `'static`, so each id leaks its two strings once; re-adding an id returns the first entry.
static DOWNLOADED: RwLock<Vec<&'static FontFace>> = RwLock::new(Vec::new());

pub fn add_downloaded(id: &str, name: &str) -> &'static FontFace {
    let mut list = DOWNLOADED.write().unwrap_or_else(|e| e.into_inner());
    if let Some(existing) = list.iter().find(|f| f.id == id) {
        return existing;
    }
    let face: &'static FontFace = Box::leak(Box::new(FontFace {
        id: Box::leak(id.to_string().into_boxed_str()),
        name: Box::leak(name.to_string().into_boxed_str()),
        ligatures: false,
    }));
    list.push(face);
    face
}

/// Stops offering the family. Its `FontFace` stays leaked and its id stays known to the
/// rasterizer, which is why a removed family cannot be re-added with different bytes.
pub fn remove_downloaded(id: &str) {
    DOWNLOADED
        .write()
        .unwrap_or_else(|e| e.into_inner())
        .retain(|f| f.id != id);
}

/// The bundled faces, then the downloaded ones in the order they were added.
pub fn all_fonts() -> Vec<&'static FontFace> {
    let downloaded = DOWNLOADED.read().unwrap_or_else(|e| e.into_inner());
    FONTS.iter().chain(downloaded.iter().copied()).collect()
}

pub fn font_named(id: &str) -> &'static FontFace {
    if let Some(f) = FONTS.iter().find(|f| f.id == id) {
        return f;
    }
    DOWNLOADED
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .find(|f| f.id == id)
        .copied()
        .unwrap_or(&FONTS[0])
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

    #[test]
    fn downloaded_faces_join_the_list_until_removed() {
        let face = add_downloaded("gf-test-mono", "Test Mono");
        assert_eq!(font_named("gf-test-mono").name, "Test Mono");
        assert!(!face.ligatures);
        assert!(std::ptr::eq(face, add_downloaded("gf-test-mono", "Other")));
        let ids: Vec<&str> = all_fonts().iter().map(|f| f.id).collect();
        assert_eq!(&ids[..7], FONTS.iter().map(|f| f.id).collect::<Vec<_>>());
        assert!(ids.contains(&"gf-test-mono"));
        remove_downloaded("gf-test-mono");
        assert_eq!(font_named("gf-test-mono").id, "cascadia-mono");
        assert!(!all_fonts().iter().any(|f| f.id == "gf-test-mono"));
    }
}
