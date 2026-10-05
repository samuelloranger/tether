use std::path::PathBuf;

const START: &str = "\x1b[200~";
const END: &str = "\x1b[201~";

/// Markers in the text are stripped so a paste cannot close the bracket and type commands.
pub fn paste_bytes(text: &str, bracketed: bool) -> Vec<u8> {
    let body = text
        .replace(START, "")
        .replace(END, "")
        .replace("\r\n", "\r")
        .replace('\n', "\r");
    if bracketed {
        format!("{START}{body}{END}").into_bytes()
    } else {
        body.into_bytes()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClipboardSnapshot {
    Text(String),
    Image(Vec<u8>),
    Files(Vec<PathBuf>),
    Empty,
}

impl ClipboardSnapshot {
    pub fn from_formats(
        text: Option<String>,
        files: Option<Vec<PathBuf>>,
        png: Option<Vec<u8>>,
    ) -> Self {
        if let Some(text) = text.filter(|t| !t.is_empty()) {
            return ClipboardSnapshot::Text(text);
        }
        if let Some(files) = files.filter(|f| !f.is_empty()) {
            return ClipboardSnapshot::Files(files);
        }
        match png {
            Some(png) => ClipboardSnapshot::Image(png),
            None => ClipboardSnapshot::Empty,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PasteAction {
    PasteText(String),
    UploadImage { name: String, png: Vec<u8> },
    SendFiles(Vec<PathBuf>),
    Nothing,
}

pub fn clipboard_image_name(now_unix: i64) -> String {
    format!("paste-{now_unix}.png")
}

pub fn paste_action(clip: ClipboardSnapshot, now_unix: i64) -> PasteAction {
    match clip {
        ClipboardSnapshot::Text(t) if !t.is_empty() => PasteAction::PasteText(t),
        ClipboardSnapshot::Image(png) => PasteAction::UploadImage {
            name: clipboard_image_name(now_unix),
            png,
        },
        ClipboardSnapshot::Files(f) if !f.is_empty() => PasteAction::SendFiles(f),
        _ => PasteAction::Nothing,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newlines_become_cr() {
        assert_eq!(paste_bytes("a\nb\r\nc\rd", false), b"a\rb\rc\rd");
    }

    #[test]
    fn bracketed_paste_wraps_the_text() {
        assert_eq!(paste_bytes("ls\n", true), b"\x1b[200~ls\r\x1b[201~");
    }

    #[test]
    fn markers_inside_text_are_stripped() {
        let evil = "safe\x1b[201~rm -rf ~\n\x1b[200~";
        assert_eq!(
            paste_bytes(evil, true),
            b"\x1b[200~saferm -rf ~\r\x1b[201~"
        );
        assert_eq!(paste_bytes(evil, false), b"saferm -rf ~\r");
    }

    #[test]
    fn text_wins_over_an_image() {
        let snap = ClipboardSnapshot::from_formats(Some("hi".into()), None, Some(vec![1, 2]));
        assert_eq!(paste_action(snap, 1), PasteAction::PasteText("hi".into()));
    }

    #[test]
    fn image_only_becomes_a_timestamped_png_upload() {
        let snap = ClipboardSnapshot::from_formats(None, None, Some(vec![9]));
        assert_eq!(
            paste_action(snap, 1791082819),
            PasteAction::UploadImage {
                name: "paste-1791082819.png".into(),
                png: vec![9]
            }
        );
        let snap = ClipboardSnapshot::from_formats(Some(String::new()), None, Some(vec![9]));
        assert!(matches!(paste_action(snap, 1), PasteAction::UploadImage { .. }));
    }

    #[test]
    fn copied_files_are_sent_like_a_drop() {
        let files = vec![PathBuf::from(r"C:\a.png"), PathBuf::from(r"C:\b.txt")];
        let snap = ClipboardSnapshot::from_formats(None, Some(files.clone()), Some(vec![1]));
        assert_eq!(paste_action(snap, 1), PasteAction::SendFiles(files));
    }

    #[test]
    fn an_empty_clipboard_pastes_nothing() {
        assert_eq!(
            paste_action(ClipboardSnapshot::from_formats(None, Some(vec![]), None), 1),
            PasteAction::Nothing
        );
        assert_eq!(paste_action(ClipboardSnapshot::Empty, 1), PasteAction::Nothing);
    }
}
