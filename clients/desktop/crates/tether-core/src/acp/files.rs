//! Per-chat files, one directory per host. Journals, snapshots and the outbox must survive the
//! app being killed mid-write, so every write goes through a temp file and a rename.

use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde::de::DeserializeOwned;

use super::format::PersistedFailed;
use super::images::{DEFAULT_BUDGET, DIRECTORY_SUFFIX, ImageStore};
use super::journal::{CURRENT_VERSION, Journal, Snapshot};
use crate::store::write_atomic;

const JOURNAL: &str = "journal";
const SNAPSHOT: &str = "snapshot";
const OUTBOX: &str = "outbox";
const TITLE: &str = "title";
const AGENT: &str = "agent";
const BRANCH_DRAFT: &str = "branch-draft";

/// Reversible percent-encoding, so two scopes or names never share a file.
pub fn component(text: &str) -> String {
    let mut out = String::new();
    for b in text.bytes() {
        if b.is_ascii_alphanumeric() || b == b'-' || b == b'_' {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    if out.is_empty() { "chat".into() } else { out }
}

#[derive(Debug, Clone)]
pub struct ChatFiles {
    root: PathBuf,
    directory: PathBuf,
}

impl ChatFiles {
    /// `scope` is the host, `host:port`; everything for that host lives in one directory under `root`.
    pub fn new(root: PathBuf, scope: &str) -> Self {
        let directory = root.join(component(scope));
        Self { root, directory }
    }

    pub fn branch(&self, name: &str) -> Option<super::organization::Branch> {
        let mut branch: super::organization::Branch = self.read(name, "branch")?;
        if let Some(draft) = self.read(name, BRANCH_DRAFT) {
            branch.draft = draft;
        }
        Some(branch)
    }
    pub fn save_branch(&self, name: &str, branch: &super::organization::Branch) -> io::Result<()> {
        self.write(name, "branch", branch)?;
        self.save_branch_draft(name, &branch.draft)
    }
    /// The draft changes per keystroke; the context, up to 128 KiB, is written once.
    pub fn save_branch_draft(&self, name: &str, draft: &str) -> io::Result<()> {
        self.write(name, BRANCH_DRAFT, draft)
    }

    pub fn directory(&self) -> &Path {
        &self.directory
    }

    fn path(&self, name: &str, kind: &str) -> PathBuf {
        self.directory
            .join(format!("{}.{kind}.json", component(name)))
    }

    fn read<T: DeserializeOwned>(&self, name: &str, kind: &str) -> Option<T> {
        serde_json::from_slice(&fs::read(self.path(name, kind)).ok()?).ok()
    }

    fn write<T: Serialize + ?Sized>(&self, name: &str, kind: &str, value: &T) -> io::Result<()> {
        self.prepare()?;
        let bytes = serde_json::to_vec(value).map_err(io::Error::other)?;
        write_atomic(&self.path(name, kind), &bytes)
    }

    fn remove(&self, name: &str, kind: &str) {
        let _ = fs::remove_file(self.path(name, kind));
    }

    /// The host's folder is for this user alone.
    fn prepare(&self) -> io::Result<()> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(&self.directory)
        }
        #[cfg(not(unix))]
        fs::create_dir_all(&self.directory)
    }

    /// An unreadable or missing journal is an empty one: the log on the host is the record.
    pub fn journal(&self, name: &str) -> Journal {
        self.read(name, JOURNAL).unwrap_or_default()
    }

    pub fn save_journal(&self, name: &str, journal: &Journal) -> io::Result<()> {
        self.write(name, JOURNAL, journal)
    }

    /// A file that cannot be read back, or is from another format version, is removed so the
    /// next connect replays from zero.
    pub fn snapshot(&self, name: &str) -> Option<Snapshot> {
        let bytes = fs::read(self.path(name, SNAPSHOT)).ok()?;
        match serde_json::from_slice::<Snapshot>(&bytes) {
            Ok(snapshot) if snapshot.version == CURRENT_VERSION => Some(snapshot),
            _ => {
                self.clear_snapshot(name);
                None
            }
        }
    }

    pub fn save_snapshot(&self, name: &str, snapshot: &Snapshot) -> io::Result<()> {
        self.write(name, SNAPSHOT, snapshot)
    }

    pub fn clear_snapshot(&self, name: &str) {
        self.remove(name, SNAPSHOT);
    }

    pub fn outbox(&self, name: &str) -> Vec<PersistedFailed> {
        self.read(name, OUTBOX).unwrap_or_default()
    }

    /// An empty outbox removes the file.
    pub fn save_outbox(&self, name: &str, messages: &[PersistedFailed]) -> io::Result<()> {
        if messages.is_empty() {
            self.remove(name, OUTBOX);
            return Ok(());
        }
        self.write(name, OUTBOX, messages)
    }

    /// The agent's title for a chat only exists in the live transcript; this keeps the latest
    /// one so a list can show it without attaching.
    pub fn title(&self, name: &str) -> Option<String> {
        self.read::<String>(name, TITLE).filter(|t| !t.is_empty())
    }

    pub fn set_title(&self, name: &str, title: &str) -> io::Result<()> {
        let trimmed = title.trim();
        if trimmed.is_empty() || self.title(name).as_deref() == Some(trimmed) {
            return Ok(());
        }
        self.write(name, TITLE, trimmed)
    }

    pub fn clear_title(&self, name: &str) {
        self.remove(name, TITLE);
    }

    pub fn titles(&self, names: &[String]) -> HashMap<String, String> {
        names
            .iter()
            .filter_map(|n| self.title(n).map(|t| (n.clone(), t)))
            .collect()
    }

    /// The agent key this device recorded when it started the chat; chats it did not start have none.
    pub fn agent(&self, name: &str) -> Option<String> {
        self.read::<String>(name, AGENT).filter(|a| !a.is_empty())
    }

    pub fn set_agent(&self, name: &str, key: &str) -> io::Result<()> {
        if key.is_empty() || self.agent(name).as_deref() == Some(key) {
            return Ok(());
        }
        self.write(name, AGENT, key)
    }

    pub fn agents(&self, names: &[String]) -> HashMap<String, String> {
        names
            .iter()
            .filter_map(|n| self.agent(n).map(|a| (n.clone(), a)))
            .collect()
    }

    fn images_directory(&self, name: &str) -> PathBuf {
        self.directory
            .join(format!("{}{DIRECTORY_SUFFIX}", component(name)))
    }

    /// A chat's image files; a folder of its own so deleting the chat removes them in one
    /// step. The size cap spans every chat of every host under the root.
    pub fn images(&self, name: &str) -> ImageStore {
        ImageStore::new(
            self.images_directory(name),
            self.root.clone(),
            DEFAULT_BUDGET,
        )
    }

    /// Removes everything kept for a chat: journal, snapshot, outbox, title and images.
    pub fn clear(&self, name: &str) {
        for kind in [
            JOURNAL,
            SNAPSHOT,
            OUTBOX,
            TITLE,
            AGENT,
            "branch",
            BRANCH_DRAFT,
        ] {
            self.remove(name, kind);
        }
        let _ = fs::remove_dir_all(self.images_directory(name));
    }
}

#[cfg(test)]
mod tests {
    use super::super::fixture;
    use super::super::journal::TranscriptBuilder;
    use super::*;
    use uuid::Uuid;

    fn files() -> (tempfile::TempDir, ChatFiles) {
        let root = tempfile::tempdir().unwrap();
        let files = ChatFiles::new(root.path().to_path_buf(), "host:22");
        (root, files)
    }

    fn snapshot() -> Snapshot {
        let journal = fixture::turn_journal();
        let mut builder = TranscriptBuilder::new(&journal, None);
        builder.feed(&fixture::TURN.log(Some(5))).unwrap();
        Snapshot::new(
            1,
            builder.consumed_offset(),
            &journal,
            builder.state().clone(),
        )
    }

    #[test]
    fn branch_context_and_draft_survive_reopen_and_clear_with_chat() {
        let (_dir, files) = files();
        let branch = super::super::organization::Branch {
            parent: super::super::organization::Parent {
                name: "parent".into(),
                title: "Parent".into(),
                method: "copy".into(),
            },
            context: "history".into(),
            draft: "edited prompt".into(),
        };
        files.save_branch("child", &branch).unwrap();
        assert_eq!(files.branch("child"), Some(branch.clone()));
        files.save_branch_draft("child", "retyped").unwrap();
        assert_eq!(files.branch("child").unwrap().draft, "retyped");
        assert_eq!(files.branch("child").unwrap().context, branch.context);
        files.clear("child");
        assert!(files.branch("child").is_none());
    }

    #[test]
    fn components_are_reversible_and_never_share_a_file() {
        assert_eq!(component("chat-ab_12"), "chat-ab_12");
        assert_eq!(component("a/b"), "a%2Fb");
        assert_eq!(component("host:22"), "host%3A22");
        assert_eq!(component("\u{e9}"), "%C3%A9");
        assert_eq!(component(""), "chat");
        assert_ne!(component("a%2Fb"), component("a/b"));
    }

    #[test]
    fn scopes_keep_hosts_apart() {
        let root = PathBuf::from("/x");
        assert_ne!(
            ChatFiles::new(root.clone(), "a:22").directory(),
            ChatFiles::new(root, "a_22").directory()
        );
    }

    #[test]
    fn the_journal_round_trips_and_a_missing_or_broken_one_is_empty() {
        let (_root, files) = files();
        assert_eq!(files.journal("c"), Journal::default());
        files.save_journal("c", &fixture::turn_journal()).unwrap();
        assert_eq!(files.journal("c"), fixture::turn_journal());
        assert_eq!(files.journal("c2"), Journal::default());
        fs::write(files.path("c", JOURNAL), b"{ not json").unwrap();
        assert_eq!(files.journal("c"), Journal::default());
    }

    #[test]
    fn the_snapshot_store_round_trips_atomically_and_discards_what_it_cannot_read() {
        let (_root, files) = files();
        assert_eq!(files.snapshot("chat-a/b"), None);
        let taken = snapshot();
        files.save_snapshot("chat-a/b", &taken).unwrap();
        assert_eq!(files.snapshot("chat-a/b"), Some(taken.clone()));
        assert_eq!(files.snapshot("chat-a"), None, "names never share a file");

        files.save_snapshot("chat-a/b", &taken).unwrap();
        assert_eq!(
            fs::read_dir(files.directory()).unwrap().count(),
            1,
            "no temp file is left behind"
        );

        let mut future = taken.clone();
        future.version = 99;
        files.save_snapshot("chat-a/b", &future).unwrap();
        assert_eq!(files.snapshot("chat-a/b"), None);
        assert!(
            !files.path("chat-a/b", SNAPSHOT).exists(),
            "a stale format is removed"
        );

        fs::write(files.path("chat-a/b", SNAPSHOT), b"{ not json").unwrap();
        assert_eq!(files.snapshot("chat-a/b"), None);
        assert!(!files.path("chat-a/b", SNAPSHOT).exists());

        files.save_snapshot("chat-a/b", &taken).unwrap();
        files.clear_snapshot("chat-a/b");
        assert_eq!(files.snapshot("chat-a/b"), None);
    }

    #[test]
    fn the_outbox_round_trips_and_an_empty_one_removes_the_file() {
        let (_root, files) = files();
        assert!(files.outbox("chat-a").is_empty());
        let message = PersistedFailed {
            id: Uuid::new_v4(),
            text: "again".into(),
            image_count: 3,
        };
        files
            .save_outbox("chat-a", std::slice::from_ref(&message))
            .unwrap();
        assert_eq!(files.outbox("chat-a"), std::slice::from_ref(&message));
        assert!(files.outbox("chat-b").is_empty());
        files.save_outbox("chat-a", &[]).unwrap();
        assert!(!files.path("chat-a", OUTBOX).exists());
        fs::create_dir_all(files.directory()).unwrap();
        fs::write(files.path("chat-a", OUTBOX), b"garbage").unwrap();
        assert!(files.outbox("chat-a").is_empty());
    }

    #[test]
    fn a_chats_agent_is_recorded_per_chat_and_cleared_with_it() {
        let (_dir, files) = files();
        assert_eq!(files.agent("chat-a"), None);
        files.set_agent("chat-a", "codex").unwrap();
        files.set_agent("chat-b", "opencode").unwrap();
        files.set_agent("chat-c", "").unwrap();
        let found = files.agents(&["chat-a".into(), "chat-b".into(), "chat-c".into()]);
        assert_eq!(found.len(), 2);
        assert_eq!(found["chat-a"], "codex");
        files.clear("chat-a");
        assert_eq!(files.agent("chat-a"), None);
        assert_eq!(files.agent("chat-b").as_deref(), Some("opencode"));
    }

    #[test]
    fn titles_are_trimmed_per_chat_and_blank_ones_are_ignored() {
        let (root, one) = files();
        let two = ChatFiles::new(root.path().to_path_buf(), "other:22");
        one.set_title("chat-a", "  Fix the build  ").unwrap();
        one.set_title("chat-b", "   ").unwrap();
        assert_eq!(one.title("chat-a").as_deref(), Some("Fix the build"));
        assert_eq!(one.title("chat-b"), None);
        assert_eq!(two.title("chat-a"), None, "hosts stay apart");
        let found = one.titles(&["chat-a".to_string(), "chat-b".to_string()]);
        assert_eq!(
            found,
            HashMap::from([("chat-a".to_string(), "Fix the build".to_string())])
        );
        one.clear_title("chat-a");
        assert_eq!(one.title("chat-a"), None);
    }

    #[test]
    fn clearing_a_chat_removes_all_of_its_files_and_only_its_own() {
        let (_root, files) = files();
        files.save_journal("one", &fixture::turn_journal()).unwrap();
        files.save_snapshot("one", &snapshot()).unwrap();
        files
            .save_outbox(
                "one",
                &[PersistedFailed {
                    id: Uuid::new_v4(),
                    text: "x".into(),
                    image_count: 0,
                }],
            )
            .unwrap();
        files.set_title("one", "T").unwrap();
        let image = super::super::images::ImageAttachment {
            mime_type: "image/png".into(),
            data: super::super::images::testimg::b64(&super::super::images::testimg::png(2, 2, 0)),
        };
        let a = files.images("one").put(&image).unwrap();
        files.save_journal("two", &fixture::turn_journal()).unwrap();
        let b = files.images("two").put(&image).unwrap();

        files.clear("one");
        assert_eq!(files.journal("one"), Journal::default());
        assert_eq!(files.snapshot("one"), None);
        assert!(files.outbox("one").is_empty());
        assert_eq!(files.title("one"), None);
        assert!(!files.images("one").exists(&a));
        assert_eq!(files.journal("two"), fixture::turn_journal());
        assert!(files.images("two").exists(&b));
    }

    #[cfg(unix)]
    #[test]
    fn the_host_folder_is_private_to_its_user() {
        use std::os::unix::fs::PermissionsExt;
        let (_root, files) = files();
        files.save_journal("c", &Journal::default()).unwrap();
        let mode = fs::metadata(files.directory())
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o077, 0, "{mode:o}");
    }
}
