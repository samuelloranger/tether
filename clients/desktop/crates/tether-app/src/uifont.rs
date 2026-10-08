/// The family name for the window chrome. Slint needs a concrete family, and the desktop's
/// own choice lives in fontconfig.
#[cfg(not(windows))]
pub fn system_ui_family() -> Option<String> {
    let out = std::process::Command::new("fc-match")
        .args(["-f", "%{family[0]}", "system-ui"])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    family_from(&String::from_utf8(out.stdout).ok()?, out.status.success())
}

#[cfg(not(windows))]
fn family_from(stdout: &str, ok: bool) -> Option<String> {
    let name = stdout.trim();
    (ok && !name.is_empty()).then(|| name.to_string())
}

#[cfg(all(test, not(windows)))]
mod tests {
    use super::*;

    #[test]
    fn a_failed_or_empty_match_keeps_the_built_in_family() {
        assert_eq!(family_from("Noto Sans\n", true), Some("Noto Sans".into()));
        assert_eq!(family_from("", true), None);
        assert_eq!(family_from("Noto Sans", false), None);
    }
}
