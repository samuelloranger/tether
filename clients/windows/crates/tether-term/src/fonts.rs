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
        include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../assets/fonts/",
            $file
        ))
    };
}

static CASCADIA_MONO: (&[u8], &[u8]) = (
    windows_font!("CascadiaMono-Regular.ttf"),
    windows_font!("CascadiaMono-Bold.ttf"),
);
static CASCADIA_CODE: (&[u8], &[u8]) = (
    windows_font!("CascadiaCode-Regular.ttf"),
    windows_font!("CascadiaCode-Bold.ttf"),
);
static JETBRAINS_MONO: (&[u8], &[u8]) = (
    apple_font!("JetBrainsMono-Regular.ttf"),
    apple_font!("JetBrainsMono-Bold.ttf"),
);
static MONASPACE_NEON: (&[u8], &[u8]) = (
    apple_font!("MonaspaceNeon-Regular.otf"),
    apple_font!("MonaspaceNeon-Bold.otf"),
);
static MONASPACE_RADON: (&[u8], &[u8]) = (
    apple_font!("MonaspaceRadon-Regular.otf"),
    apple_font!("MonaspaceRadon-Bold.otf"),
);
static MAPLE_MONO: (&[u8], &[u8]) = (
    apple_font!("MapleMono-Regular.ttf"),
    apple_font!("MapleMono-Bold.ttf"),
);
static COMIC_MONO: (&[u8], &[u8]) = (
    apple_font!("ComicMono.ttf"),
    apple_font!("ComicMono-Bold.ttf"),
);

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

pub fn system_fallbacks() -> &'static [&'static [u8]] {
    static LOADED: OnceLock<Vec<&'static [u8]>> = OnceLock::new();
    LOADED.get_or_init(load_system_fallbacks)
}

#[cfg(windows)]
fn load_system_fallbacks() -> Vec<&'static [u8]> {
    let dir = std::path::PathBuf::from(
        std::env::var_os("WINDIR").unwrap_or_else(|| "C:\\Windows".into()),
    )
    .join("Fonts");
    [
        "seguiemj.ttf",
        "seguisym.ttf",
        "msyh.ttc",
        "YuGothM.ttc",
        "malgun.ttf",
    ]
    .iter()
    .filter_map(|file| std::fs::read(dir.join(file)).ok())
    .map(|bytes| &*Box::leak(bytes.into_boxed_slice()))
    .collect()
}

#[cfg(not(windows))]
fn load_system_fallbacks() -> Vec<&'static [u8]> {
    Vec::new()
}

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
            assert_ne!(
                regular.as_ptr(),
                bold.as_ptr(),
                "{} bold is its own file",
                face.id
            );
        }
    }

    #[test]
    fn unknown_id_falls_back_to_cascadia_mono() {
        assert_eq!(
            face_bytes("menlo").0.as_ptr(),
            face_bytes("cascadia-mono").0.as_ptr()
        );
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
