use tether_core::ThemeMode;

pub const NIGHT_BACKGROUND: u32 = 0x08080E;
pub const LIGHT_BACKGROUND: u32 = 0xF1F1F6;

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
    colorref(if dark {
        NIGHT_BACKGROUND
    } else {
        LIGHT_BACKGROUND
    })
}

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
