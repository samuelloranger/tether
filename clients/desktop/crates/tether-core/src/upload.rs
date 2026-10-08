use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::paste::paste_bytes;
use crate::zmx::shell_quote;

/// Lifting this means streaming the transfer instead of buffering it.
pub const BYTE_LIMIT: u64 = 200 * 1024 * 1024;
const UPLOADS_MARKER: &str = "__TETHER_UPLOADS_OK__";
/// Resolves `$HOME` on the host: the pasted path must be absolute for a TUI in any cwd.
pub const UPLOADS_COMMAND: &str = r#"mkdir -p "$HOME/.tether/uploads" && cd "$HOME/.tether/uploads" && pwd && echo __TETHER_UPLOADS_OK__"#;
pub const FOLDER_REFUSAL: &str = "Tether sends files, not folders.";
/// Formats a TUI like Claude Code attaches from a pasted path.
pub const ATTACHABLE_EXTENSIONS: [&str; 5] = ["png", "jpg", "jpeg", "gif", "webp"];
pub const REENCODE_EXTENSIONS: [&str; 7] = ["heic", "heif", "avif", "bmp", "tiff", "tif", "jxr"];

/// The marker proves `pwd` ran: a failed `cd` could leave a startup line that looks like a path.
pub fn uploads_directory(output: &str) -> Option<String> {
    let lines: Vec<&str> = output.lines().map(str::trim).collect();
    let marker = lines.iter().rposition(|l| *l == UPLOADS_MARKER)?;
    let path = lines.get(marker.checked_sub(1)?)?;
    path.starts_with('/').then(|| path.to_string())
}

pub fn remote_path(dir: Option<&str>, filename: &str) -> String {
    match dir {
        Some(d) if !d.is_empty() && d.ends_with('/') => format!("{d}{filename}"),
        Some(d) if !d.is_empty() => format!("{d}/{filename}"),
        _ => filename.to_owned(),
    }
}

fn trimmed(value: f64, decimals: usize) -> String {
    let s = format!("{value:.decimals$}");
    if s.contains('.') {
        s.trim_end_matches('0').trim_end_matches('.').to_owned()
    } else {
        s
    }
}

fn format_size(bytes: u64) -> String {
    let mib = bytes as f64 / (1024.0 * 1024.0);
    if mib < 1024.0 {
        format!("{} MB", trimmed(mib, 1))
    } else {
        format!("{} GB", trimmed(mib / 1024.0, 2))
    }
}

pub fn rejection_reason(bytes: u64) -> Option<String> {
    (bytes > BYTE_LIMIT).then(|| {
        format!(
            "That's {} — Tether sends up to 200 MB at a time.",
            format_size(bytes)
        )
    })
}

pub fn preflight(is_dir: bool, bytes: u64) -> Result<(), String> {
    if is_dir {
        return Err(FOLDER_REFUSAL.to_owned());
    }
    rejection_reason(bytes).map_or(Ok(()), Err)
}

fn extension(name: &str) -> Option<String> {
    Path::new(name)
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
}

/// The `.jpg` name an image is re-encoded under, or None when it is sent as it is.
pub fn jpeg_name(name: &str) -> Option<String> {
    let ext = extension(name)?;
    if !REENCODE_EXTENSIONS.contains(&ext.as_str()) {
        return None;
    }
    let stem = Path::new(name).file_stem()?.to_string_lossy();
    Some(format!("{stem}.jpg"))
}

pub fn display_remote(remote: &str) -> String {
    match remote.find("/.tether/uploads/") {
        Some(i) => format!("~{}", &remote[i..]),
        None => remote.to_owned(),
    }
}

pub const CAPSULE_LINGER: Duration = Duration::from_secs(4);

pub fn capsule_expired(shown_at: Duration, now: Duration) -> bool {
    now.saturating_sub(shown_at) >= CAPSULE_LINGER
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingFile {
    pub local: PathBuf,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum QueueState {
    Sending,
    Done,
    Failed { name: String, reason: String },
}

#[derive(Debug, Clone)]
pub struct SendQueue {
    files: Vec<PendingFile>,
    target_tab: String,
    index: usize,
    last_remote: Option<String>,
    state: QueueState,
}

impl SendQueue {
    pub fn new(files: Vec<PendingFile>, target_tab: String) -> Self {
        let state = if files.is_empty() {
            QueueState::Done
        } else {
            QueueState::Sending
        };
        SendQueue {
            files,
            target_tab,
            index: 0,
            last_remote: None,
            state,
        }
    }

    pub fn target_tab(&self) -> &str {
        &self.target_tab
    }

    pub fn current(&self) -> Option<&PendingFile> {
        (self.state == QueueState::Sending).then(|| &self.files[self.index])
    }

    /// Each file is its own paste: that is what makes Claude Code attach each image.
    pub fn on_sent(&mut self, remote: &str, bracketed: bool) -> Vec<u8> {
        debug_assert_eq!(self.state, QueueState::Sending);
        let quoted = shell_quote(remote);
        let text = if self.index == 0 {
            quoted
        } else {
            format!(" {quoted}")
        };
        self.last_remote = Some(remote.to_owned());
        self.index += 1;
        if self.index == self.files.len() {
            self.state = QueueState::Done;
        }
        paste_bytes(&text, bracketed)
    }

    pub fn on_failed(&mut self, reason: &str) {
        let Some(name) = self.current().map(|f| f.name.clone()) else {
            return;
        };
        self.state = QueueState::Failed {
            name,
            reason: reason.to_owned(),
        };
    }

    pub fn is_finished(&self) -> bool {
        self.state != QueueState::Sending
    }

    pub fn capsule(&self) -> Option<String> {
        match &self.state {
            QueueState::Sending => Some(format!(
                "Sending {} ({}/{})",
                self.files[self.index].name,
                self.index + 1,
                self.files.len()
            )),
            QueueState::Done => self
                .last_remote
                .as_deref()
                .map(|r| format!("Sent {}", display_remote(r))),
            QueueState::Failed { name, reason } => Some(format!("Couldn't send {name}: {reason}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_uploads_command_is_the_ios_one() {
        assert_eq!(
            UPLOADS_COMMAND,
            r#"mkdir -p "$HOME/.tether/uploads" && cd "$HOME/.tether/uploads" && pwd && echo __TETHER_UPLOADS_OK__"#
        );
    }

    #[test]
    fn the_line_before_the_last_marker_is_trusted_only_when_absolute() {
        assert_eq!(
            uploads_directory("motd\n/home/u/.tether/uploads\n__TETHER_UPLOADS_OK__\n").as_deref(),
            Some("/home/u/.tether/uploads")
        );
        assert_eq!(
            uploads_directory("  /x \r\n__TETHER_UPLOADS_OK__").as_deref(),
            Some("/x")
        );
        assert_eq!(
            uploads_directory("relative/dir\n__TETHER_UPLOADS_OK__"),
            None
        );
        assert_eq!(uploads_directory("/home/u/.tether/uploads\n"), None);
        assert_eq!(uploads_directory("__TETHER_UPLOADS_OK__"), None);
        assert_eq!(uploads_directory(""), None);
    }

    #[test]
    fn remote_path_joins_or_falls_back_to_the_bare_name() {
        assert_eq!(
            remote_path(Some("/h/.tether/uploads"), "a.png"),
            "/h/.tether/uploads/a.png"
        );
        assert_eq!(remote_path(Some("/h/"), "a.png"), "/h/a.png");
        assert_eq!(remote_path(Some(""), "a.png"), "a.png");
        assert_eq!(remote_path(None, "a.png"), "a.png");
    }

    #[test]
    fn the_limit_copy_matches_the_spec() {
        assert_eq!(rejection_reason(BYTE_LIMIT), None);
        assert_eq!(
            rejection_reason(214 * 1024 * 1024).as_deref(),
            Some("That's 214 MB — Tether sends up to 200 MB at a time.")
        );
        assert_eq!(
            rejection_reason(214 * 1024 * 1024 + 512 * 1024).as_deref(),
            Some("That's 214.5 MB — Tether sends up to 200 MB at a time.")
        );
        assert_eq!(
            rejection_reason(3 * 1024 * 1024 * 1024 / 2).as_deref(),
            Some("That's 1.5 GB — Tether sends up to 200 MB at a time.")
        );
    }

    #[test]
    fn folders_are_refused_and_size_is_checked() {
        assert_eq!(
            preflight(true, 0),
            Err("Tether sends files, not folders.".to_string())
        );
        assert_eq!(preflight(false, 10), Ok(()));
        assert!(
            preflight(false, BYTE_LIMIT + 1)
                .unwrap_err()
                .starts_with("That's 200 MB")
        );
    }

    #[test]
    fn attachable_images_pass_and_others_map_to_jpg() {
        for name in ["a.png", "b.JPG", "c.jpeg", "d.gif", "e.webp"] {
            assert_eq!(jpeg_name(name), None, "{name}");
        }
        assert_eq!(jpeg_name("IMG_0001.HEIC").as_deref(), Some("IMG_0001.jpg"));
        assert_eq!(jpeg_name("scan.tiff").as_deref(), Some("scan.jpg"));
        assert_eq!(jpeg_name("shot.bmp").as_deref(), Some("shot.jpg"));
        assert_eq!(jpeg_name("photo.avif").as_deref(), Some("photo.jpg"));
        assert_eq!(jpeg_name("notes.txt"), None);
        assert_eq!(jpeg_name("Makefile"), None);
        assert_eq!(jpeg_name("archive.tar.gz"), None);
    }

    #[test]
    fn capsule_paths_use_the_tilde_form() {
        assert_eq!(
            display_remote("/home/u/.tether/uploads/paste-1.png"),
            "~/.tether/uploads/paste-1.png"
        );
        assert_eq!(display_remote("/srv/x.png"), "/srv/x.png");
        assert_eq!(display_remote("x.png"), "x.png");
    }

    fn files(names: &[&str]) -> Vec<PendingFile> {
        names
            .iter()
            .map(|n| PendingFile {
                local: PathBuf::from(format!(r"C:\tmp\{n}")),
                name: n.to_string(),
            })
            .collect()
    }

    #[test]
    fn files_go_in_order_one_paste_each_with_a_leading_space_after_the_first() {
        let mut q = SendQueue::new(files(&["a.png", "b c.png", "d.png"]), "build".into());
        assert_eq!(q.target_tab(), "build");
        assert_eq!(q.capsule().as_deref(), Some("Sending a.png (1/3)"));
        assert_eq!(q.current().unwrap().name, "a.png");
        assert_eq!(
            q.on_sent("/h/.tether/uploads/a.png", true),
            b"\x1b[200~'/h/.tether/uploads/a.png'\x1b[201~"
        );
        assert_eq!(q.capsule().as_deref(), Some("Sending b c.png (2/3)"));
        assert_eq!(
            q.on_sent("/h/.tether/uploads/b c.png", true),
            b"\x1b[200~ '/h/.tether/uploads/b c.png'\x1b[201~"
        );
        assert_eq!(
            q.on_sent("/h/.tether/uploads/d.png", false),
            b" '/h/.tether/uploads/d.png'"
        );
        assert!(q.is_finished());
        assert_eq!(q.current(), None);
        assert_eq!(q.capsule().as_deref(), Some("Sent ~/.tether/uploads/d.png"));
    }

    #[test]
    fn a_failure_stops_the_queue_and_keeps_earlier_pastes() {
        let mut q = SendQueue::new(files(&["a.png", "big.mov", "c.png"]), "t".into());
        let first = q.on_sent("/h/.tether/uploads/a.png", false);
        assert_eq!(first, b"'/h/.tether/uploads/a.png'");
        q.on_failed("That's 214 MB — Tether sends up to 200 MB at a time.");
        assert!(q.is_finished());
        assert_eq!(q.current(), None);
        assert_eq!(
            q.capsule().as_deref(),
            Some("Couldn't send big.mov: That's 214 MB — Tether sends up to 200 MB at a time.")
        );
    }

    #[test]
    fn a_quote_in_a_filename_stays_one_path() {
        let mut q = SendQueue::new(files(&["it's.png"]), "t".into());
        assert_eq!(q.on_sent("/h/it's.png", false), br#"'/h/it'"'"'s.png'"#);
    }

    #[test]
    fn the_capsule_leaves_after_four_seconds() {
        let at = Duration::from_secs(10);
        assert!(!capsule_expired(at, Duration::from_millis(13_999)));
        assert!(capsule_expired(at, Duration::from_secs(14)));
    }
}
