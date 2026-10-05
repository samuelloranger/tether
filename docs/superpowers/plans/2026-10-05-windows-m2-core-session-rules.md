# Windows M2 — Core Session Rules Implementation Plan

> **For the implementer:** Work through the tasks in order. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every session, terminal-input, notification, upload, and connection rule of the Windows client, as pure host-free logic in `tether-core`, each pinned by tests.

**Architecture:** Fourteen new modules in `clients/windows/crates/tether-core/src/`, one rule family each, no I/O and no runtime. Time is always passed in as a `Duration` since an arbitrary monotonic origin, so every throttle and timer is tested without sleeping. The connection sequence is generic over the `Transport` / `Connection` traits and is tested against a scripted fake that records every call.

**Tech Stack:** Rust stable (edition 2024), `regex` (links), `base64` 0.22 (OSC 52), `zeroize`, `uuid`; dev-only `futures` (`futures::executor::block_on`).

**Spec:** `clients/windows/SPEC.md` — sections Terminal › Input, Keyboard, Sessions, Links, Notifications and progress, Connect, Reconnect, Couldn't connect, Files and images.

**Roadmap / contract:** `docs/superpowers/plans/2026-10-05-windows-00-roadmap.md`. Every name below matches the contract's `tether-core (M2)` block; additions are listed in each task's **Produces**.

**iOS sources ported (read them before the task that ports them):**
- `clients/apple/TetherKit/Sources/TetherKit/SSH/ZmxSession.swift` (`parse`, `shellQuote`)
- `clients/apple/TetherKit/Sources/TetherKit/SSH/ZmxSwitch.swift` (`attachCommand`)
- `clients/apple/TetherKit/Sources/TetherKit/Home/SSHTerminalController.swift:271` (first session choice)
- `clients/apple/TetherKit/Sources/TetherKit/Home/SSHTerminalView.swift:507` (`nextSessionName`)
- `clients/apple/TetherKit/Sources/TetherKit/Terminal/OSCScanner.swift`, `OSCReports.swift`, `BellThrottle.swift`
- `clients/apple/TetherKit/Sources/TetherKit/Terminal/LinkSpans.swift` (URL half only)
- `clients/apple/TetherKit/Sources/TetherKit/Views/TerminalView.swift:363` (`TerminalKeyMap`)
- `clients/apple/TetherKit/Sources/TetherKit/Home/MediaTransfer.swift`

## Global Constraints

The roadmap's Global Constraints apply to every task. M2-specific values, verbatim from the spec:

- `zmx` path `~/.local/bin/zmx`. Attach: `~/.local/bin/zmx attach '<name>'` + `\n`, typed into the login shell. Kill: `~/.local/bin/zmx kill '<name>' --force`. Quoting: POSIX single quotes, `'` → `'"'"'`.
- First tab: `default` if it exists, else newest by `created`, else none. `zmx ls` failure opens one `default` tab.
- New session name: `default` on an empty host, else the first free `session-N` counting from the number of sessions plus one.
- At most 12 tabs attached; the 13th detaches the least recently viewed.
- Active tab vanishes → neighbor to the left, else right, else empty state.
- Bell: at most once per 200 ms per session. Toast: at most one per session per 5 s; later ones in the window replace the pending one; nothing when the window is focused on that very tab.
- OSC 9;4: 1 normal (with percent), 2 error, 3 indeterminate, 4 paused, 0 clears; OSC 133;A clears. OSC 9 with first field `4` is never a toast.
- Links: only `http`, `https`, `mailto` open. OSC 8 wins over detected text. Box characters `│ ┃ ⎿`.
- Key modifier parameter: 1 + Shift 1 + Alt 2 + Ctrl 4.
- Uploads: `mkdir -p "$HOME/.tether/uploads" && cd "$HOME/.tether/uploads" && pwd && echo __TETHER_UPLOADS_OK__`; 200 MB limit (`200 * 1024 * 1024`); copy `That's 214 MB — Tether sends up to 200 MB at a time.` and `Tether sends files, not folders.`; attachable `png jpg jpeg gif webp`; re-encode `heic heif avif bmp tiff tif jxr` to `.jpg`. Clipboard image name `paste-<unix seconds>.png`.
- Capsule: `Sending <name> (i/n)`, `Sent <path>`; leaves after 4 s.
- Resize settle 150 ms. Lock grace 15 s.
- Connect: 10 s connect timeout; keepalive every 15 s, started after auth; transport failures retry up to three attempts, 500 ms apart; auth failures and host-key mismatch never retry. Reconnect backoff 1 s, 2 s, 4 s.
- Couldn't-connect sentences, verbatim:
  - `Authentication failed. Check the key or password.`
  - `This machine's key was deleted. Edit the machine and choose another key.`
  - `The Windows SSH agent isn't running. Start the OpenSSH Authentication Agent service, or choose a key.`
  - `The SSH agent has no key this host accepts.`
  - `The host stopped answering.`
  - `Could not connect: <detail>`

**Assumed from M1** (do not re-create): crate at `clients/windows/crates/tether-core` with `src/lib.rs` declaring `pub mod` per module; `profiles::{Machine, Auth}` (Machine derives `Clone, Debug, PartialEq`); `secrets::{SecretStore, SecretError, key_account, password_account}` (`SecretError: Debug`); `hostkey::{HostKeyStore, HostKeyDecision, hex_fingerprint, verify_host_key}` where `verify_host_key` pins on first sight and returns `Pinned`. Deps `uuid` (feature `v4`), `zeroize`, `serde`. All commands below run from `clients/windows/`.

## Review Focus

1. **PTY output split anywhere** — an `ESC ]` OSC, its `ESC \` terminator, or a multi-byte UTF-8 title cut across two reads must produce the same events as one read. Pinned by `osc::tests::every_split_point_gives_the_same_events` and `osc::tests::utf8_title_split_mid_character` (Tasks 4–5).
2. **Session names that need quoting** — `it's`, `my session`, `$(rm -rf ~)`, `日本` must attach and kill exactly that name and never run anything; a name with a newline or other control character is refused before it is typed (a newline would submit the attach line early). Pinned by `zmx::tests::hostile_names_stay_one_argument` and `zmx::tests::control_characters_are_not_valid_names` (Task 1).
3. **A session created from this PC that `zmx ls` has not reported yet** — the next refresh must not remove its tab (iOS hit this race: a just-attached session can miss the first `ls`). Pinned by `tabs::tests::refresh_keeps_a_tab_created_here_until_the_host_reports_it` (Task 3).
4. **AltGr on a non-US layout** — Canadian French AltGr+2 must send `@`, never `ESC NUL`; a Ctrl+Alt chord that produces nothing still folds. Pinned by `keymap::tests::altgr_text_wins_on_canadian_french` (Task 9).
5. **Pasted text that contains the bracketed-paste end marker** — `ESC[201~` inside clipboard text must be stripped so the paste cannot break out and type commands. Pinned by `paste::tests::markers_inside_text_are_stripped` (Task 10).

---

### Task 1: `zmx` sessions, quoting, and commands

**Files:**
- Create: `clients/windows/crates/tether-core/src/zmx.rs`
- Modify: `clients/windows/crates/tether-core/src/lib.rs` (add `pub mod zmx;`)

**Interfaces:**
- Consumes: nothing.
- Produces: `pub const ZMX: &str`; `#[derive(Debug, Clone, Default, PartialEq, Eq)] pub struct ZmxSession { pub name: String, pub pid: i64, pub clients: i64, pub created: i64, pub cwd: String }`; `pub fn parse_ls(output: &str) -> Vec<ZmxSession>`; `pub fn shell_quote(s: &str) -> String`; `pub fn ls_command() -> String`; `pub fn attach_command(name: &str) -> String`; `pub fn kill_command(name: &str) -> String`; `ZmxSession::display_cwd(&self) -> &str`; `ZmxSession::cwd_leaf(&self) -> Option<&str>`. **Addition:** `pub fn valid_session_name(name: &str) -> bool`.

- [ ] **Step 1: Write the failing tests**

Create `src/zmx.rs` with only the test module, and add `pub mod zmx;` to `src/lib.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_tab_separated_pairs() {
        let out = "name=default\tpid=41\tclients=1\tcreated=1700000000\tcwd=/home/u/src\n\
                   name=build\tpid=42\tclients=0\tcreated=1700000100\tcwd=file://box/home/u/build\n";
        let s = parse_ls(out);
        assert_eq!(s.len(), 2);
        assert_eq!(
            s[0],
            ZmxSession { name: "default".into(), pid: 41, clients: 1, created: 1_700_000_000, cwd: "/home/u/src".into() }
        );
        assert_eq!(s[1].display_cwd(), "/home/u/build");
        assert_eq!(s[1].cwd_leaf(), Some("build"));
    }

    #[test]
    fn lines_without_a_name_are_skipped_and_numbers_default_to_zero() {
        let s = parse_ls("garbage line\n name=x \tpid=nope\n\nname=\tpid=3\n");
        assert_eq!(s, vec![ZmxSession { name: "x".into(), ..Default::default() }]);
    }

    #[test]
    fn cwd_leaf_handles_root_trailing_slash_and_empty() {
        let mut s = ZmxSession { name: "a".into(), ..Default::default() };
        assert_eq!(s.cwd_leaf(), None);
        s.cwd = "/".into();
        assert_eq!(s.cwd_leaf(), Some("/"));
        s.cwd = "/home/u/".into();
        assert_eq!(s.cwd_leaf(), Some("u"));
        s.cwd = "file://host".into();
        assert_eq!(s.display_cwd(), "host");
    }

    #[test]
    fn commands_use_the_ios_binary_path() {
        assert_eq!(ls_command(), "~/.local/bin/zmx ls");
        assert_eq!(attach_command("default"), "~/.local/bin/zmx attach 'default'\n");
        assert_eq!(kill_command("build"), "~/.local/bin/zmx kill 'build' --force");
    }

    #[test]
    fn hostile_names_stay_one_argument() {
        assert_eq!(shell_quote("it's"), r#"'it'"'"'s'"#);
        assert_eq!(attach_command("my session"), "~/.local/bin/zmx attach 'my session'\n");
        assert_eq!(kill_command("$(rm -rf ~)"), "~/.local/bin/zmx kill '$(rm -rf ~)' --force");
        assert_eq!(shell_quote("日本"), "'日本'");
        assert_eq!(shell_quote(""), "''");
    }

    #[test]
    fn control_characters_are_not_valid_names() {
        assert!(valid_session_name("build"));
        assert!(valid_session_name("it's mine"));
        assert!(!valid_session_name(""));
        assert!(!valid_session_name("   "));
        assert!(!valid_session_name("a\nb"));
        assert!(!valid_session_name("a\rb"));
        assert!(!valid_session_name("a\u{1b}b"));
        assert!(!valid_session_name("a\u{7f}"));
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p tether-core zmx`
Expected: FAIL to compile — `cannot find function parse_ls in this scope`.

- [ ] **Step 3: Write the implementation**

Prepend to `src/zmx.rs`:

```rust
pub const ZMX: &str = "~/.local/bin/zmx";

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ZmxSession {
    pub name: String,
    pub pid: i64,
    pub clients: i64,
    pub created: i64,
    pub cwd: String,
}

impl ZmxSession {
    /// The cwd as a path: zmx may report an OSC 7 style `file://host/path`.
    pub fn display_cwd(&self) -> &str {
        let Some(rest) = self.cwd.strip_prefix("file://") else { return &self.cwd };
        match rest.find('/') {
            Some(slash) => &rest[slash..],
            None => rest,
        }
    }

    pub fn cwd_leaf(&self) -> Option<&str> {
        let path = self.display_cwd();
        if path.is_empty() {
            return None;
        }
        if path.trim_end_matches('/').is_empty() {
            return Some("/");
        }
        path.trim_end_matches('/').rsplit('/').next()
    }
}

pub fn parse_ls(output: &str) -> Vec<ZmxSession> {
    output
        .split('\n')
        .filter_map(|line| {
            let mut s = ZmxSession::default();
            let mut name = None;
            for pair in line.split('\t') {
                let Some((key, value)) = pair.trim().split_once('=') else { continue };
                match key {
                    "name" => name = Some(value.to_owned()),
                    "pid" => s.pid = value.parse().unwrap_or(0),
                    "clients" => s.clients = value.parse().unwrap_or(0),
                    "created" => s.created = value.parse().unwrap_or(0),
                    "cwd" => s.cwd = value.to_owned(),
                    _ => {}
                }
            }
            s.name = name.filter(|n| !n.is_empty())?;
            Some(s)
        })
        .collect()
}

pub fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r#"'"'"'"#))
}

/// The attach line is typed into a shell, so a control character (a newline above all)
/// would end or alter the command line before the quote closes.
pub fn valid_session_name(name: &str) -> bool {
    !name.trim().is_empty() && !name.chars().any(char::is_control)
}

pub fn ls_command() -> String {
    format!("{ZMX} ls")
}

pub fn attach_command(name: &str) -> String {
    format!("{ZMX} attach {}\n", shell_quote(name))
}

pub fn kill_command(name: &str) -> String {
    format!("{ZMX} kill {} --force", shell_quote(name))
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p tether-core zmx`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add clients/windows/crates/tether-core/src/zmx.rs clients/windows/crates/tether-core/src/lib.rs
git commit -m "feat(windows): parse zmx ls and build quoted zmx commands

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Tab strip — order, first tab, naming, creation, navigation

**Files:**
- Create: `clients/windows/crates/tether-core/src/tabs.rs`
- Modify: `clients/windows/crates/tether-core/src/lib.rs` (add `pub mod tabs;`)
- Create (stub, filled in Task 5): `clients/windows/crates/tether-core/src/osc.rs` containing only the `Progress` / `ProgressState` types below; add `pub mod osc;`

**Interfaces:**
- Consumes: `zmx::ZmxSession` (Task 1).
- Produces: `pub const ATTACH_CAP: usize = 12`; `pub const DEFAULT_SESSION: &str = "default"`; `Tab`, `TabStrip`, `first_tab`, `TabStrip::{from_sessions, from_ls_failure, next, prev, at_position, last, new_session_name, select, mark_attention}`. **Additions:** `Tab.on_host: bool` (false for a tab created here that `zmx ls` has not reported yet); `TabStrip::create(&mut self, name: &str, view_tick: u64) -> CreateOutcome`; `pub enum CreateOutcome { Existing { evicted: Option<String> }, Created { evicted: Option<String> } }`; `TabStrip::tab(&self, name) -> Option<&Tab>`; `TabStrip::tab_mut(&mut self, name) -> Option<&mut Tab>`. `osc::{Progress, ProgressState}` (types only).

`from_sessions` chooses `active` but attaches nothing: the app calls `select(active, tick)` to attach it. `view_tick` is any increasing counter the app owns.

- [ ] **Step 1: Create the `Progress` stub in `src/osc.rs`**

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProgressState {
    Normal,
    Error,
    Indeterminate,
    Paused,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Progress {
    pub state: ProgressState,
    pub percent: u8,
}
```

- [ ] **Step 2: Write the failing tests** in `src/tabs.rs`

```rust
#[cfg(test)]
mod tests {
    use super::*;

    pub(super) fn s(name: &str, created: i64) -> ZmxSession {
        ZmxSession { name: name.into(), created, cwd: format!("/home/u/{name}"), ..Default::default() }
    }

    pub(super) fn names(strip: &TabStrip) -> Vec<&str> {
        strip.tabs.iter().map(|t| t.name.as_str()).collect()
    }

    #[test]
    fn strip_is_ordered_by_created_oldest_left() {
        let strip = TabStrip::from_sessions(&[s("c", 30), s("a", 10), s("b", 20)]);
        assert_eq!(names(&strip), ["a", "b", "c"]);
        assert_eq!(strip.tabs[0].cwd_leaf.as_deref(), Some("a"));
        assert!(strip.tabs.iter().all(|t| !t.attached && t.on_host));
    }

    #[test]
    fn first_tab_prefers_default_then_newest_then_none() {
        assert_eq!(first_tab(&[s("old", 1), s("default", 2), s("new", 3)]).as_deref(), Some("default"));
        assert_eq!(first_tab(&[s("old", 1), s("new", 3), s("mid", 2)]).as_deref(), Some("new"));
        assert_eq!(first_tab(&[]), None);
        assert_eq!(TabStrip::from_sessions(&[s("old", 1), s("new", 3)]).active.as_deref(), Some("new"));
        assert_eq!(TabStrip::from_sessions(&[]).active, None);
    }

    #[test]
    fn ls_failure_opens_one_default_tab() {
        let strip = TabStrip::from_ls_failure();
        assert_eq!(names(&strip), ["default"]);
        assert_eq!(strip.active.as_deref(), Some("default"));
        assert!(!strip.tabs[0].on_host);
    }

    #[test]
    fn new_session_name_is_default_then_first_free_session_n() {
        assert_eq!(TabStrip::from_sessions(&[]).new_session_name(), "default");
        let two = TabStrip::from_sessions(&[s("default", 1), s("x", 2)]);
        assert_eq!(two.new_session_name(), "session-3");
        let taken = TabStrip::from_sessions(&[s("default", 1), s("session-3", 2), s("session-4", 3)]);
        assert_eq!(taken.new_session_name(), "session-5");
    }

    #[test]
    fn creating_an_existing_name_selects_that_tab() {
        let mut strip = TabStrip::from_sessions(&[s("a", 1), s("b", 2)]);
        assert_eq!(strip.create("a", 7), CreateOutcome::Existing { evicted: None });
        assert_eq!(strip.tabs.len(), 2);
        assert_eq!(strip.active.as_deref(), Some("a"));
        assert!(strip.tab("a").unwrap().attached);
    }

    #[test]
    fn creating_a_new_name_appends_an_attached_local_tab() {
        let mut strip = TabStrip::from_sessions(&[s("a", 1)]);
        assert_eq!(strip.create("fresh", 3), CreateOutcome::Created { evicted: None });
        assert_eq!(names(&strip), ["a", "fresh"]);
        let t = strip.tab("fresh").unwrap();
        assert!(t.attached && !t.on_host);
        assert_eq!(strip.active.as_deref(), Some("fresh"));
    }

    #[test]
    fn next_and_prev_wrap() {
        let mut strip = TabStrip::from_sessions(&[s("a", 1), s("b", 2), s("c", 3)]);
        strip.select("c", 1);
        assert_eq!(strip.next(), Some("a"));
        assert_eq!(strip.prev(), Some("b"));
        strip.select("a", 2);
        assert_eq!(strip.prev(), Some("c"));
        assert_eq!(TabStrip::from_sessions(&[]).next(), None);
    }

    #[test]
    fn positions_are_one_based_and_last_is_the_last_tab() {
        let strip = TabStrip::from_sessions(&[s("a", 1), s("b", 2), s("c", 3)]);
        assert_eq!(strip.at_position(1), Some("a"));
        assert_eq!(strip.at_position(3), Some("c"));
        assert_eq!(strip.at_position(4), None);
        assert_eq!(strip.at_position(0), None);
        assert_eq!(strip.last(), Some("c"));
    }

    #[test]
    fn attention_marks_only_background_tabs_and_clears_on_view() {
        let mut strip = TabStrip::from_sessions(&[s("a", 1), s("b", 2)]);
        strip.select("a", 1);
        strip.mark_attention("a");
        strip.mark_attention("b");
        assert!(!strip.tab("a").unwrap().attention);
        assert!(strip.tab("b").unwrap().attention);
        strip.select("b", 2);
        assert!(!strip.tab("b").unwrap().attention);
    }
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cargo test -p tether-core tabs`
Expected: FAIL to compile — `cannot find type TabStrip`.

- [ ] **Step 4: Write the implementation** — prepend to `src/tabs.rs`:

```rust
use crate::osc::Progress;
use crate::zmx::ZmxSession;

pub const ATTACH_CAP: usize = 12;
pub const DEFAULT_SESSION: &str = "default";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tab {
    pub name: String,
    pub created: i64,
    pub cwd_leaf: Option<String>,
    pub attached: bool,
    pub attention: bool,
    pub last_viewed: u64,
    pub progress: Option<Progress>,
    /// False for a tab created here that `zmx ls` has not reported yet.
    pub on_host: bool,
}

impl Tab {
    fn from_session(s: &ZmxSession) -> Self {
        Tab {
            name: s.name.clone(),
            created: s.created,
            cwd_leaf: s.cwd_leaf().map(str::to_owned),
            attached: false,
            attention: false,
            last_viewed: 0,
            progress: None,
            on_host: true,
        }
    }

    fn local(name: &str) -> Self {
        // Sorts after every reported session until the host reports its real time.
        Tab { on_host: false, ..Tab::from_session(&ZmxSession { name: name.into(), created: i64::MAX, ..Default::default() }) }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TabStrip {
    pub tabs: Vec<Tab>,
    pub active: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CreateOutcome {
    Existing { evicted: Option<String> },
    Created { evicted: Option<String> },
}

pub fn first_tab(sessions: &[ZmxSession]) -> Option<String> {
    if sessions.iter().any(|s| s.name == DEFAULT_SESSION) {
        return Some(DEFAULT_SESSION.to_owned());
    }
    sessions.iter().max_by_key(|s| s.created).map(|s| s.name.clone())
}

impl TabStrip {
    pub fn from_sessions(sessions: &[ZmxSession]) -> Self {
        let mut tabs: Vec<Tab> = sessions.iter().map(Tab::from_session).collect();
        tabs.sort_by_key(|t| t.created);
        TabStrip { tabs, active: first_tab(sessions) }
    }

    pub fn from_ls_failure() -> Self {
        TabStrip { tabs: vec![Tab::local(DEFAULT_SESSION)], active: Some(DEFAULT_SESSION.to_owned()) }
    }

    pub fn tab(&self, name: &str) -> Option<&Tab> {
        self.tabs.iter().find(|t| t.name == name)
    }

    pub fn tab_mut(&mut self, name: &str) -> Option<&mut Tab> {
        self.tabs.iter_mut().find(|t| t.name == name)
    }

    fn index(&self, name: &str) -> Option<usize> {
        self.tabs.iter().position(|t| t.name == name)
    }

    fn active_index(&self) -> Option<usize> {
        self.active.as_deref().and_then(|a| self.index(a))
    }

    /// Makes `name` active and attached. Returns the tab to detach when that goes past the cap.
    pub fn select(&mut self, name: &str, view_tick: u64) -> Option<String> {
        let tab = self.tab_mut(name)?;
        tab.attached = true;
        tab.attention = false;
        tab.last_viewed = view_tick;
        self.active = Some(name.to_owned());
        if self.tabs.iter().filter(|t| t.attached).count() <= ATTACH_CAP {
            return None;
        }
        let victim = self.tabs.iter_mut().filter(|t| t.attached && t.name != name).min_by_key(|t| t.last_viewed)?;
        victim.attached = false;
        Some(victim.name.clone())
    }

    pub fn create(&mut self, name: &str, view_tick: u64) -> CreateOutcome {
        if self.index(name).is_some() {
            return CreateOutcome::Existing { evicted: self.select(name, view_tick) };
        }
        self.tabs.push(Tab::local(name));
        CreateOutcome::Created { evicted: self.select(name, view_tick) }
    }

    pub fn next(&self) -> Option<&str> {
        let len = self.tabs.len();
        if len == 0 {
            return None;
        }
        let i = self.active_index().map_or(0, |i| (i + 1) % len);
        Some(&self.tabs[i].name)
    }

    pub fn prev(&self) -> Option<&str> {
        let len = self.tabs.len();
        if len == 0 {
            return None;
        }
        let i = self.active_index().map_or(len - 1, |i| (i + len - 1) % len);
        Some(&self.tabs[i].name)
    }

    pub fn at_position(&self, one_based: usize) -> Option<&str> {
        one_based.checked_sub(1).and_then(|i| self.tabs.get(i)).map(|t| t.name.as_str())
    }

    pub fn last(&self) -> Option<&str> {
        self.tabs.last().map(|t| t.name.as_str())
    }

    pub fn new_session_name(&self) -> String {
        if self.tabs.is_empty() {
            return DEFAULT_SESSION.to_owned();
        }
        let mut n = self.tabs.len() + 1;
        while self.index(&format!("session-{n}")).is_some() {
            n += 1;
        }
        format!("session-{n}")
    }

    pub fn mark_attention(&mut self, name: &str) {
        if self.active.as_deref() == Some(name) {
            return;
        }
        if let Some(t) = self.tab_mut(name) {
            t.attention = true;
        }
    }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test -p tether-core tabs`
Expected: PASS (9 tests).

- [ ] **Step 6: Commit**

```bash
git add clients/windows/crates/tether-core/src/tabs.rs clients/windows/crates/tether-core/src/osc.rs clients/windows/crates/tether-core/src/lib.rs
git commit -m "feat(windows): tab strip order, first tab, naming and navigation

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Tab strip — attach cap, refresh merge, kill, reattach order

**Files:**
- Modify: `clients/windows/crates/tether-core/src/tabs.rs`

**Interfaces:**
- Consumes: Task 2's `TabStrip`, `Tab`, `first_tab`.
- Produces: `pub struct MergeOutcome { pub added: Vec<String>, pub removed: Vec<String>, pub active_changed: bool }`; `TabStrip::merge(&mut self, sessions: &[ZmxSession]) -> MergeOutcome`; `TabStrip::reattach_order(&self) -> Vec<String>`. **Deviation:** `TabStrip::begin_kill(&mut self, name: &str) -> KillStep` with `pub struct KillStep { pub new_active: Option<String>, pub active_changed: bool }` instead of `Option<String>` — the contract's return could not tell "the strip is now empty" from "the killed tab was not active".

Merge rules: removed tabs are those absent from `sessions` and `on_host`; a tab not yet `on_host` survives until reported; surviving tabs keep their state (attached, attention, last_viewed, progress) and take the reported `created` / cwd. If the active tab is removed, the neighbor to its left in the old order (that survives) becomes active, else the right, else none. If nothing was active and tabs now exist, `first_tab` picks one. A neighbor that becomes active is not attached until the app calls `select`.

- [ ] **Step 1: Write the failing tests** — append inside `mod tests` in `src/tabs.rs`:

```rust
    #[test]
    fn the_thirteenth_attach_detaches_the_least_recently_viewed() {
        let sessions: Vec<_> = (0..13).map(|i| s(&format!("t{i}"), i)).collect();
        let mut strip = TabStrip::from_sessions(&sessions);
        for i in 0..12 {
            assert_eq!(strip.select(&format!("t{i}"), 100 + i as u64), None);
        }
        strip.select("t0", 200);
        assert_eq!(strip.select("t12", 201).as_deref(), Some("t1"));
        assert!(!strip.tab("t1").unwrap().attached);
        assert_eq!(strip.tabs.iter().filter(|t| t.attached).count(), ATTACH_CAP);
        assert_eq!(strip.select("t1", 202).as_deref(), Some("t2"));
    }

    #[test]
    fn refresh_adds_new_sessions_in_created_order() {
        let mut strip = TabStrip::from_sessions(&[s("a", 10), s("c", 30)]);
        strip.select("a", 1);
        let out = strip.merge(&[s("a", 10), s("b", 20), s("c", 30)]);
        assert_eq!(names(&strip), ["a", "b", "c"]);
        assert_eq!(out.added, ["b"]);
        assert!(out.removed.is_empty() && !out.active_changed);
        assert!(strip.tab("a").unwrap().attached);
    }

    #[test]
    fn active_tab_vanishing_picks_left_then_right_then_none() {
        let mut strip = TabStrip::from_sessions(&[s("a", 1), s("b", 2), s("c", 3)]);
        strip.select("b", 1);
        let out = strip.merge(&[s("a", 1), s("c", 3)]);
        assert_eq!(out.removed, ["b"]);
        assert!(out.active_changed);
        assert_eq!(strip.active.as_deref(), Some("a"));

        let mut strip = TabStrip::from_sessions(&[s("a", 1), s("b", 2)]);
        strip.select("a", 1);
        strip.merge(&[s("b", 2)]);
        assert_eq!(strip.active.as_deref(), Some("b"));

        strip.merge(&[]);
        assert_eq!(strip.active, None);
        assert!(strip.tabs.is_empty());
    }

    #[test]
    fn refresh_keeps_a_tab_created_here_until_the_host_reports_it() {
        let mut strip = TabStrip::from_sessions(&[s("a", 1)]);
        strip.create("fresh", 1);
        let out = strip.merge(&[s("a", 1)]);
        assert!(out.removed.is_empty());
        assert_eq!(names(&strip), ["a", "fresh"]);
        assert_eq!(strip.active.as_deref(), Some("fresh"));
        strip.merge(&[s("a", 1), s("fresh", 50)]);
        let t = strip.tab("fresh").unwrap();
        assert!(t.on_host && t.attached);
        assert_eq!(t.created, 50);
        strip.merge(&[s("a", 1)]);
        assert!(strip.tab("fresh").is_none());
    }

    #[test]
    fn sessions_appearing_on_an_empty_strip_get_an_active_tab() {
        let mut strip = TabStrip::from_sessions(&[]);
        let out = strip.merge(&[s("phone", 5)]);
        assert!(out.active_changed);
        assert_eq!(strip.active.as_deref(), Some("phone"));
    }

    #[test]
    fn kill_switches_away_first_and_the_last_kill_leaves_empty() {
        let mut strip = TabStrip::from_sessions(&[s("a", 1), s("b", 2)]);
        strip.select("a", 1);
        assert_eq!(strip.begin_kill("b"), KillStep { new_active: Some("a".into()), active_changed: false });
        assert_eq!(names(&strip), ["a"]);
        assert_eq!(strip.begin_kill("a"), KillStep { new_active: None, active_changed: true });
        assert!(strip.tabs.is_empty());
        assert_eq!(strip.new_session_name(), "default");
    }

    #[test]
    fn killing_the_active_middle_tab_activates_its_left_neighbor() {
        let mut strip = TabStrip::from_sessions(&[s("a", 1), s("b", 2), s("c", 3)]);
        strip.select("b", 1);
        assert_eq!(strip.begin_kill("b"), KillStep { new_active: Some("a".into()), active_changed: true });
        let mut strip = TabStrip::from_sessions(&[s("a", 1), s("b", 2)]);
        strip.select("a", 1);
        assert_eq!(strip.begin_kill("a").new_active.as_deref(), Some("b"));
    }

    #[test]
    fn reattach_order_is_active_first_then_strip_order() {
        let mut strip = TabStrip::from_sessions(&[s("a", 1), s("b", 2), s("c", 3), s("d", 4)]);
        strip.select("a", 1);
        strip.select("d", 2);
        strip.select("c", 3);
        assert_eq!(strip.reattach_order(), ["c", "a", "d"]);
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p tether-core tabs`
Expected: FAIL to compile — `no method named merge`.

- [ ] **Step 3: Write the implementation** — add to `src/tabs.rs` (types next to `CreateOutcome`, methods inside `impl TabStrip`):

```rust
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MergeOutcome {
    pub added: Vec<String>,
    pub removed: Vec<String>,
    pub active_changed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KillStep {
    pub new_active: Option<String>,
    pub active_changed: bool,
}
```

```rust
    pub fn merge(&mut self, sessions: &[ZmxSession]) -> MergeOutcome {
        let mut out = MergeOutcome::default();
        let reported = |name: &str| sessions.iter().any(|s| s.name == name);
        let survives = |t: &Tab| !t.on_host || reported(&t.name);
        let old = std::mem::take(&mut self.tabs);

        let neighbor = self
            .active
            .as_deref()
            .and_then(|a| old.iter().position(|t| t.name == a))
            .filter(|&i| !survives(&old[i]))
            .map(|i| {
                old[..i]
                    .iter()
                    .rev()
                    .find(|t| survives(t))
                    .or_else(|| old[i + 1..].iter().find(|t| survives(t)))
                    .map(|t| t.name.clone())
            });

        for tab in old {
            if survives(&tab) {
                self.tabs.push(tab);
            } else {
                out.removed.push(tab.name);
            }
        }
        for s in sessions {
            match self.tab_mut(&s.name) {
                Some(t) => {
                    t.created = s.created;
                    t.cwd_leaf = s.cwd_leaf().map(str::to_owned);
                    t.on_host = true;
                }
                None => {
                    self.tabs.push(Tab::from_session(s));
                    out.added.push(s.name.clone());
                }
            }
        }
        self.tabs.sort_by_key(|t| t.created);

        if let Some(next) = neighbor {
            self.active = next;
            out.active_changed = true;
        } else if self.active.is_none() && !self.tabs.is_empty() {
            self.active = first_tab(sessions).or_else(|| self.tabs.first().map(|t| t.name.clone()));
            out.active_changed = true;
        }
        out
    }

    /// Removes the tab before `zmx kill` runs, so the client has already switched away.
    pub fn begin_kill(&mut self, name: &str) -> KillStep {
        let unchanged = |strip: &Self| KillStep { new_active: strip.active.clone(), active_changed: false };
        let Some(i) = self.index(name) else { return unchanged(self) };
        let was_active = self.active.as_deref() == Some(name);
        self.tabs.remove(i);
        if !was_active {
            return unchanged(self);
        }
        let next = if i > 0 { Some(i - 1) } else if i < self.tabs.len() { Some(i) } else { None };
        self.active = next.map(|j| self.tabs[j].name.clone());
        KillStep { new_active: self.active.clone(), active_changed: true }
    }

    pub fn reattach_order(&self) -> Vec<String> {
        let active = self.active.as_deref();
        let mut order: Vec<String> =
            self.tabs.iter().filter(|t| t.attached && Some(t.name.as_str()) == active).map(|t| t.name.clone()).collect();
        order.extend(self.tabs.iter().filter(|t| t.attached && Some(t.name.as_str()) != active).map(|t| t.name.clone()));
        order
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p tether-core tabs`
Expected: PASS (17 tests).

- [ ] **Step 5: Commit**

```bash
git add clients/windows/crates/tether-core/src/tabs.rs
git commit -m "feat(windows): tab refresh merge, attach cap, kill order, reattach order

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: OSC scanner

**Files:**
- Modify: `clients/windows/crates/tether-core/src/osc.rs`

**Interfaces:**
- Consumes: nothing.
- Produces: `#[derive(Debug, Clone, PartialEq, Eq)] pub enum OscEvent { Osc { code: String, body: Vec<u8> }, Reset }`; `#[derive(Debug, Default)] pub struct OscScanner`; `OscScanner::new() -> Self`; `OscScanner::feed(&mut self, bytes: &[u8]) -> Vec<OscEvent>`. **Additions:** `pub const BODY_LIMIT: usize = 4096`, `pub const CLIPBOARD_BODY_LIMIT: usize = 101_000`.

M4 runs this scanner over the same bytes it feeds `alacritty_terminal`, because alacritty does not surface OSC 9, 777, 9;4, 133, or 7.

- [ ] **Step 1: Write the failing tests** — append to `src/osc.rs`:

```rust
#[cfg(test)]
mod scanner_tests {
    use super::*;

    fn osc(code: &str, body: &str) -> OscEvent {
        OscEvent::Osc { code: code.into(), body: body.as_bytes().to_vec() }
    }

    #[test]
    fn bel_and_st_both_terminate() {
        let mut sc = OscScanner::new();
        let ev = sc.feed(b"hi\x1b]0;title\x07mid\x1b]9;done\x1b\\end");
        assert_eq!(ev, vec![osc("0", "title"), osc("9", "done")]);
    }

    #[test]
    fn every_split_point_gives_the_same_events() {
        let stream: &[u8] = b"a\x1b]777;notify;T;B\x1b\\b\x1b]9;4;1;50\x07\x1bc\x1b]133;A\x07";
        let whole = OscScanner::new().feed(stream);
        assert_eq!(whole.len(), 4);
        for cut in 0..=stream.len() {
            let mut sc = OscScanner::new();
            let mut ev = sc.feed(&stream[..cut]);
            ev.extend(sc.feed(&stream[cut..]));
            assert_eq!(ev, whole, "split at {cut}");
        }
    }

    #[test]
    fn ris_is_a_reset() {
        assert_eq!(OscScanner::new().feed(b"x\x1bcy"), vec![OscEvent::Reset]);
    }

    #[test]
    fn dcs_apc_pm_sos_payloads_are_skipped_whole() {
        for intro in [b'P', b'_', b'^', b'X'] {
            let mut bytes = vec![0x1b, intro];
            bytes.extend_from_slice(b"Gf=100;\x1b]9;fake\x07\x1b\\");
            bytes.extend_from_slice(b"\x1b]2;real\x07");
            assert_eq!(OscScanner::new().feed(&bytes), vec![osc("2", "real")], "intro {intro}");
        }
    }

    #[test]
    fn an_escape_inside_an_osc_cuts_it_and_starts_the_next_sequence() {
        assert_eq!(OscScanner::new().feed(b"\x1b]2;cut\x1b]2;next\x07"), vec![osc("2", "next")]);
    }

    #[test]
    fn overlong_bodies_and_codes_are_dropped() {
        let mut long = b"\x1b]2;".to_vec();
        long.extend(std::iter::repeat_n(b'x', BODY_LIMIT + 1));
        long.push(0x07);
        assert!(OscScanner::new().feed(&long).is_empty());
        assert!(OscScanner::new().feed(b"\x1b]123456;x\x07").is_empty());
        assert!(OscScanner::new().feed(b"\x1b];x\x07").is_empty());

        let mut clip = b"\x1b]52;c;".to_vec();
        clip.extend(std::iter::repeat_n(b'A', 100_000));
        clip.push(0x07);
        assert_eq!(OscScanner::new().feed(&clip).len(), 1);
    }

    #[test]
    fn code_without_body() {
        assert_eq!(OscScanner::new().feed(b"\x1b]104\x07"), vec![osc("104", "")]);
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p tether-core scanner_tests`
Expected: FAIL to compile — `cannot find type OscScanner`.

- [ ] **Step 3: Write the implementation** — add above the test module in `src/osc.rs`:

```rust
/// Commands Tether reads are short; a longer body is dropped rather than buffered.
pub const BODY_LIMIT: usize = 4096;
/// OSC 52 carries base64: room for `CLIPBOARD_LIMIT` bytes of decoded text.
pub const CLIPBOARD_BODY_LIMIT: usize = 101_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OscEvent {
    Osc { code: String, body: Vec<u8> },
    Reset,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
enum State {
    #[default]
    Ground,
    Escape,
    Code,
    Body,
    BodyEscape,
    Str,
    StrEscape,
}

/// Finds OSC sequences and RIS across read boundaries. DCS, APC, PM and SOS payloads
/// (kitty graphics among them) are skipped whole, so an `ESC ]` inside one is never a command.
#[derive(Debug, Default)]
pub struct OscScanner {
    state: State,
    code: String,
    body: Vec<u8>,
    overflowed: bool,
}

impl OscScanner {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn feed(&mut self, bytes: &[u8]) -> Vec<OscEvent> {
        bytes.iter().filter_map(|&b| self.step(b)).collect()
    }

    fn limit(&self) -> usize {
        if self.code == "52" { CLIPBOARD_BODY_LIMIT } else { BODY_LIMIT }
    }

    fn step(&mut self, b: u8) -> Option<OscEvent> {
        match self.state {
            State::Ground => {
                if b == 0x1b {
                    self.state = State::Escape;
                }
            }
            State::Escape => match b {
                b']' => {
                    self.state = State::Code;
                    self.code.clear();
                    self.body.clear();
                    self.overflowed = false;
                }
                b'P' | b'_' | b'^' | b'X' => self.state = State::Str,
                b'c' => {
                    self.state = State::Ground;
                    return Some(OscEvent::Reset);
                }
                0x1b => {}
                _ => self.state = State::Ground,
            },
            State::Code => match b {
                b'0'..=b'9' if self.code.len() < 5 => self.code.push(b as char),
                b';' => self.state = State::Body,
                0x07 => return self.finish(),
                0x1b => self.state = State::BodyEscape,
                _ => self.state = State::Ground,
            },
            State::Body => match b {
                0x07 => return self.finish(),
                0x1b => self.state = State::BodyEscape,
                _ if self.body.len() < self.limit() => self.body.push(b),
                _ => self.overflowed = true,
            },
            State::BodyEscape => {
                if b == b'\\' {
                    return self.finish();
                }
                // ESC began a new sequence; this OSC was cut short.
                self.state = State::Escape;
                return self.step(b);
            }
            State::Str => {
                if b == 0x1b {
                    self.state = State::StrEscape;
                }
            }
            State::StrEscape => self.state = if b == b'\\' { State::Ground } else { State::Str },
        }
        None
    }

    fn finish(&mut self) -> Option<OscEvent> {
        self.state = State::Ground;
        if self.overflowed || self.code.is_empty() {
            return None;
        }
        Some(OscEvent::Osc { code: std::mem::take(&mut self.code), body: std::mem::take(&mut self.body) })
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p tether-core scanner_tests`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add clients/windows/crates/tether-core/src/osc.rs
git commit -m "feat(windows): OSC scanner that survives split reads

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Tab reports — title, cwd, notifications, progress, clipboard

**Files:**
- Modify: `clients/windows/crates/tether-core/src/osc.rs`
- Modify: `clients/windows/crates/tether-core/Cargo.toml` (via `cargo add`)

**Interfaces:**
- Consumes: Task 4's `OscEvent`, Task 2's `Progress`/`ProgressState`.
- Produces: `#[derive(Debug, Clone, PartialEq, Eq)] pub struct Notification { pub title: Option<String>, pub body: String }`; `pub enum ReportEvent { Notify(Notification), Clipboard(String), ProgressChanged }` **plus addition `CwdChanged`**; `#[derive(Debug, Clone, Default, PartialEq, Eq)] pub struct TabReports { pub title, pub cwd, pub progress }`; `TabReports::apply(&mut self, ev: &OscEvent) -> Option<ReportEvent>`. **Additions:** `pub const TITLE_LIMIT: usize = 128`, `PATH_LIMIT = 4096`, `CLIPBOARD_LIMIT = 75_000`, `NOTIFY_LIMIT = 256`; `pub fn sanitize(bytes: &[u8], limit: usize) -> Option<String>`.

Note for M4: the window title should come from alacritty's own `Title`/`ResetTitle` events (they honor title push/pop); `TabReports.title` is a fallback only.

- [ ] **Step 1: Add the dependency**

Run: `cargo add -p tether-core base64@0.22`
Expected: `Adding base64 v0.22.x to dependencies` (or "already present").

- [ ] **Step 2: Write the failing tests** — append to `src/osc.rs`:

```rust
#[cfg(test)]
mod report_tests {
    use super::*;

    fn apply_all(r: &mut TabReports, bytes: &[u8]) -> Vec<ReportEvent> {
        OscScanner::new().feed(bytes).iter().filter_map(|e| r.apply(e)).collect()
    }

    fn note(title: Option<&str>, body: &str) -> ReportEvent {
        ReportEvent::Notify(Notification { title: title.map(Into::into), body: body.into() })
    }

    #[test]
    fn titles_lose_control_and_bidi_characters_and_are_capped() {
        let mut r = TabReports::default();
        apply_all(&mut r, "\x1b]2; ok\u{202e}\u{200b}\u{1}\x07".as_bytes());
        assert_eq!(r.title.as_deref(), Some("ok"));
        apply_all(&mut r, format!("\x1b]0;{}\x07", "x".repeat(300)).as_bytes());
        assert_eq!(r.title.as_ref().map(|t| t.chars().count()), Some(TITLE_LIMIT));
        apply_all(&mut r, b"\x1b]2;   \x07");
        assert_eq!(r.title, None);
    }

    #[test]
    fn utf8_title_split_mid_character() {
        let bytes = "\x1b]2;café ✓\x07".as_bytes();
        let cut = bytes.iter().position(|&b| b == 0xC3).unwrap() + 1;
        let mut sc = OscScanner::new();
        let mut r = TabReports::default();
        for e in sc.feed(&bytes[..cut]).iter().chain(sc.feed(&bytes[cut..]).iter()) {
            r.apply(e);
        }
        assert_eq!(r.title.as_deref(), Some("café ✓"));
    }

    #[test]
    fn osc7_sets_the_cwd_from_a_file_url() {
        let mut r = TabReports::default();
        assert_eq!(apply_all(&mut r, b"\x1b]7;file://box/home/u/my%20dir\x07"), vec![ReportEvent::CwdChanged]);
        assert_eq!(r.cwd.as_deref(), Some("/home/u/my dir"));
        assert!(apply_all(&mut r, b"\x1b]7;file://box/home/u/my%20dir\x07").is_empty());
        apply_all(&mut r, b"\x1b]7;http://x/y\x07");
        apply_all(&mut r, b"\x1b]7;file://box/a%0Ab\x07");
        assert_eq!(r.cwd.as_deref(), Some("/home/u/my dir"));
    }

    #[test]
    fn osc9_and_777_are_notifications() {
        let mut r = TabReports::default();
        assert_eq!(apply_all(&mut r, b"\x1b]9;Build done\x07"), vec![note(None, "Build done")]);
        assert_eq!(
            apply_all(&mut r, b"\x1b]777;notify;Claude;Needs; you\x07"),
            vec![note(Some("Claude"), "Needs; you")]
        );
        assert_eq!(apply_all(&mut r, b"\x1b]777;notify;Only title;\x07"), vec![note(None, "Only title")]);
        assert!(apply_all(&mut r, b"\x1b]777;notify;;\x07").is_empty());
        assert!(apply_all(&mut r, b"\x1b]777;other;a;b\x07").is_empty());
        assert!(apply_all(&mut r, b"\x1b]9;\x07").is_empty());
    }

    #[test]
    fn osc9_4_is_progress_and_never_a_toast() {
        let mut r = TabReports::default();
        assert_eq!(apply_all(&mut r, b"\x1b]9;4;1;40\x07"), vec![ReportEvent::ProgressChanged]);
        assert_eq!(r.progress, Some(Progress { state: ProgressState::Normal, percent: 40 }));
        apply_all(&mut r, b"\x1b]9;4;2\x07");
        assert_eq!(r.progress, Some(Progress { state: ProgressState::Error, percent: 40 }));
        apply_all(&mut r, b"\x1b]9;4;3\x07");
        assert_eq!(r.progress.unwrap().state, ProgressState::Indeterminate);
        apply_all(&mut r, b"\x1b]9;4;4;250\x07");
        assert_eq!(r.progress, Some(Progress { state: ProgressState::Paused, percent: 100 }));
        apply_all(&mut r, b"\x1b]9;4;0\x07");
        assert_eq!(r.progress, None);
        for body in [&b"\x1b]9;4;9;5\x07"[..], b"\x1b]9;4;x\x07", b"\x1b]9;4\x07"] {
            assert!(apply_all(&mut r, body).is_empty());
        }
    }

    #[test]
    fn prompt_mark_and_reset_clear_progress() {
        let mut r = TabReports::default();
        apply_all(&mut r, b"\x1b]9;4;1;10\x07");
        assert_eq!(apply_all(&mut r, b"\x1b]133;A\x07"), vec![ReportEvent::ProgressChanged]);
        assert_eq!(r.progress, None);
        assert!(apply_all(&mut r, b"\x1b]133;B\x07").is_empty());
        apply_all(&mut r, b"\x1b]9;4;3\x07");
        assert_eq!(apply_all(&mut r, b"\x1bc"), vec![ReportEvent::ProgressChanged]);
    }

    #[test]
    fn osc52_copies_text_but_never_answers_a_query() {
        let mut r = TabReports::default();
        assert_eq!(apply_all(&mut r, b"\x1b]52;c;aGVsbG8\x07"), vec![ReportEvent::Clipboard("hello".into())]);
        assert!(apply_all(&mut r, b"\x1b]52;c;?\x07").is_empty());
        assert!(apply_all(&mut r, b"\x1b]52;c;\x07").is_empty());
        assert!(apply_all(&mut r, b"\x1b]52;c;!!!\x07").is_empty());
    }
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cargo test -p tether-core report_tests`
Expected: FAIL to compile — `cannot find type TabReports`.

- [ ] **Step 4: Write the implementation** — add to `src/osc.rs` above the test modules:

```rust
use base64::Engine;
use base64::engine::general_purpose::STANDARD;

pub const TITLE_LIMIT: usize = 128;
pub const PATH_LIMIT: usize = 4096;
pub const CLIPBOARD_LIMIT: usize = 75_000;
pub const NOTIFY_LIMIT: usize = 256;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Notification {
    pub title: Option<String>,
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReportEvent {
    Notify(Notification),
    Clipboard(String),
    ProgressChanged,
    CwdChanged,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TabReports {
    pub title: Option<String>,
    /// A hint: the host part of the OSC 7 URL is not checked.
    pub cwd: Option<String>,
    pub progress: Option<Progress>,
}

impl TabReports {
    pub fn apply(&mut self, ev: &OscEvent) -> Option<ReportEvent> {
        let (code, body) = match ev {
            OscEvent::Reset => return self.set_progress(None),
            OscEvent::Osc { code, body } => (code.as_str(), body.as_slice()),
        };
        match code {
            "0" | "2" => {
                self.title = sanitize(body, TITLE_LIMIT);
                None
            }
            "7" => {
                let path = path_from_url(body)?;
                if self.cwd.as_deref() == Some(path.as_str()) {
                    return None;
                }
                self.cwd = Some(path);
                Some(ReportEvent::CwdChanged)
            }
            "9" => self.osc9(body),
            "777" => notify_777(body).map(ReportEvent::Notify),
            "52" => clipboard_text(body).map(ReportEvent::Clipboard),
            // The prompt is back: whatever reported progress has finished or died.
            "133" if body.first() == Some(&b'A') => self.set_progress(None),
            _ => None,
        }
    }

    fn set_progress(&mut self, p: Option<Progress>) -> Option<ReportEvent> {
        if self.progress == p {
            return None;
        }
        self.progress = p;
        Some(ReportEvent::ProgressChanged)
    }

    fn osc9(&mut self, body: &[u8]) -> Option<ReportEvent> {
        let text = String::from_utf8_lossy(body);
        let fields: Vec<&str> = text.split(';').collect();
        if fields[0] != "4" {
            return sanitize(body, NOTIFY_LIMIT).map(|body| ReportEvent::Notify(Notification { title: None, body }));
        }
        let raw: i64 = fields.get(1)?.parse().ok()?;
        let percent = fields.get(2).and_then(|f| f.parse::<i64>().ok()).map(|p| p.clamp(0, 100) as u8);
        let state = match raw {
            0 => return self.set_progress(None),
            1 => ProgressState::Normal,
            2 => ProgressState::Error,
            3 => ProgressState::Indeterminate,
            4 => ProgressState::Paused,
            _ => return None,
        };
        let percent = percent.or(self.progress.map(|p| p.percent)).unwrap_or(0);
        self.set_progress(Some(Progress { state, percent }))
    }
}

/// Unicode format characters (Cf) that can hide or reorder text: bidi controls, zero-width marks.
fn is_format(c: char) -> bool {
    matches!(c as u32,
        0xAD | 0x600..=0x605 | 0x61C | 0x6DD | 0x70F | 0x180E | 0x200B..=0x200F
        | 0x202A..=0x202E | 0x2060..=0x2064 | 0x2066..=0x206F | 0xFEFF | 0xFFF9..=0xFFFB)
}

/// Program output is untrusted: control and format characters go, whitespace is trimmed.
pub fn sanitize(bytes: &[u8], limit: usize) -> Option<String> {
    let cleaned: String = String::from_utf8_lossy(bytes).chars().filter(|&c| !c.is_control() && !is_format(c)).collect();
    let trimmed = cleaned.trim();
    (!trimmed.is_empty()).then(|| trimmed.chars().take(limit).collect())
}

fn notify_777(body: &[u8]) -> Option<Notification> {
    let text = String::from_utf8_lossy(body);
    let mut parts = text.splitn(3, ';');
    if parts.next()? != "notify" {
        return None;
    }
    let title = parts.next().and_then(|t| sanitize(t.as_bytes(), TITLE_LIMIT));
    let body = parts.next().and_then(|b| sanitize(b.as_bytes(), NOTIFY_LIMIT));
    match (title, body) {
        (title, Some(body)) => Some(Notification { title, body }),
        (Some(title), None) => Some(Notification { title: None, body: title }),
        (None, None) => None,
    }
}

fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = s.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn path_from_url(body: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(body);
    let rest = text.strip_prefix("file://")?;
    let path = percent_decode(&rest[rest.find('/')?..])?;
    (path.chars().count() <= PATH_LIMIT && !path.chars().any(char::is_control)).then_some(path)
}

fn clipboard_text(body: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(body);
    let (_, payload) = text.split_once(';')?;
    let mut payload: String = payload.chars().filter(|c| !c.is_whitespace()).collect();
    // "?" asks for the clipboard; an empty payload would clear it. Neither is honored.
    if payload.is_empty() || payload == "?" {
        return None;
    }
    while payload.len() % 4 != 0 {
        payload.push('=');
    }
    let data = STANDARD.decode(payload).ok()?;
    if data.len() > CLIPBOARD_LIMIT {
        return None;
    }
    String::from_utf8(data).ok().filter(|s| !s.is_empty())
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test -p tether-core osc`
Expected: PASS (14 tests across `scanner_tests` and `report_tests`).

- [ ] **Step 6: Commit**

```bash
git add clients/windows/crates/tether-core/src/osc.rs clients/windows/crates/tether-core/Cargo.toml clients/windows/Cargo.lock
git commit -m "feat(windows): read titles, cwd, notifications, progress and OSC 52 from output

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Bell and toast throttles

**Files:**
- Create: `clients/windows/crates/tether-core/src/throttle.rs`
- Modify: `clients/windows/crates/tether-core/src/lib.rs` (add `pub mod throttle;`)

**Interfaces:**
- Consumes: `osc::Notification` (Task 5).
- Produces: `pub const BELL_WINDOW: Duration` (200 ms); `#[derive(Debug, Default)] pub struct BellThrottle` with `should_ring(&mut self, now: Duration) -> bool` (one per session — the app holds one per tab); `pub const TOAST_WINDOW: Duration` (5 s); `pub fn wants_toast(window_focused: bool, is_active_tab: bool) -> bool`. **Deviation:** `ToastThrottle` carries the notification so a later one can replace the pending one: `offer(&mut self, session: &str, n: Notification, now: Duration) -> ToastDecision` with `pub enum ToastDecision { Show(Notification), Pending }`; `poll(&mut self, now: Duration) -> Vec<(String, Notification)>` returns pending toasts whose window has passed; `forget(&mut self, session: &str)` drops a pending toast when the user views that tab.

- [ ] **Step 1: Write the failing tests** in `src/throttle.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn ms(v: u64) -> Duration {
        Duration::from_millis(v)
    }

    fn n(body: &str) -> Notification {
        Notification { title: None, body: body.into() }
    }

    #[test]
    fn a_bell_burst_rings_once_per_200ms() {
        let mut b = BellThrottle::default();
        assert!(b.should_ring(ms(1000)));
        assert!(!b.should_ring(ms(1100)));
        assert!(!b.should_ring(ms(1199)));
        assert!(b.should_ring(ms(1200)));
    }

    #[test]
    fn no_toast_only_for_the_focused_active_tab() {
        assert!(!wants_toast(true, true));
        assert!(wants_toast(true, false));
        assert!(wants_toast(false, true));
        assert!(wants_toast(false, false));
    }

    #[test]
    fn one_toast_per_session_per_five_seconds_latest_pending_wins() {
        let mut t = ToastThrottle::default();
        assert_eq!(t.offer("a", n("1"), ms(0)), ToastDecision::Show(n("1")));
        assert_eq!(t.offer("b", n("other"), ms(10)), ToastDecision::Show(n("other")));
        assert_eq!(t.offer("a", n("2"), ms(1000)), ToastDecision::Pending);
        assert_eq!(t.offer("a", n("3"), ms(2000)), ToastDecision::Pending);
        assert!(t.poll(ms(4999)).is_empty());
        assert_eq!(t.poll(ms(5000)), vec![("a".to_string(), n("3"))]);
        assert!(t.poll(ms(6000)).is_empty());
        assert_eq!(t.offer("a", n("4"), ms(6000)), ToastDecision::Pending);
        assert_eq!(t.offer("a", n("5"), ms(10_000)), ToastDecision::Show(n("5")));
    }

    #[test]
    fn viewing_the_tab_drops_its_pending_toast() {
        let mut t = ToastThrottle::default();
        t.offer("a", n("1"), ms(0));
        t.offer("a", n("2"), ms(100));
        t.forget("a");
        assert!(t.poll(ms(9000)).is_empty());
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p tether-core throttle`
Expected: FAIL to compile — `cannot find type BellThrottle`.

- [ ] **Step 3: Write the implementation** — prepend to `src/throttle.rs`:

```rust
use std::collections::{BTreeMap, HashMap};
use std::time::Duration;

use crate::osc::Notification;

/// The iOS `BellThrottle` window: `yes $'\a'` must not flash without end.
pub const BELL_WINDOW: Duration = Duration::from_millis(200);
pub const TOAST_WINDOW: Duration = Duration::from_secs(5);

#[derive(Debug, Default)]
pub struct BellThrottle {
    last: Option<Duration>,
}

impl BellThrottle {
    pub fn should_ring(&mut self, now: Duration) -> bool {
        if self.last.is_some_and(|last| now.saturating_sub(last) < BELL_WINDOW) {
            return false;
        }
        self.last = Some(now);
        true
    }
}

pub fn wants_toast(window_focused: bool, is_active_tab: bool) -> bool {
    !(window_focused && is_active_tab)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToastDecision {
    Show(Notification),
    Pending,
}

#[derive(Debug, Default)]
pub struct ToastThrottle {
    last_shown: HashMap<String, Duration>,
    pending: BTreeMap<String, Notification>,
}

impl ToastThrottle {
    pub fn offer(&mut self, session: &str, n: Notification, now: Duration) -> ToastDecision {
        if self.last_shown.get(session).is_some_and(|&t| now.saturating_sub(t) < TOAST_WINDOW) {
            self.pending.insert(session.to_owned(), n);
            return ToastDecision::Pending;
        }
        self.last_shown.insert(session.to_owned(), now);
        self.pending.remove(session);
        ToastDecision::Show(n)
    }

    pub fn poll(&mut self, now: Duration) -> Vec<(String, Notification)> {
        let due: Vec<String> = self
            .pending
            .keys()
            .filter(|s| self.last_shown.get(*s).is_none_or(|&t| now.saturating_sub(t) >= TOAST_WINDOW))
            .cloned()
            .collect();
        due.into_iter()
            .filter_map(|s| {
                let n = self.pending.remove(&s)?;
                self.last_shown.insert(s.clone(), now);
                Some((s, n))
            })
            .collect()
    }

    pub fn forget(&mut self, session: &str) {
        self.pending.remove(session);
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p tether-core throttle`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add clients/windows/crates/tether-core/src/throttle.rs clients/windows/crates/tether-core/src/lib.rs
git commit -m "feat(windows): bell and per-session toast throttles

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Link detection

**Files:**
- Create: `clients/windows/crates/tether-core/src/links.rs`
- Modify: `clients/windows/crates/tether-core/src/lib.rs` (add `pub mod links;`), `Cargo.toml` (via `cargo add`)

**Interfaces:**
- Consumes: nothing.
- Produces: `#[derive(Debug, Clone, PartialEq, Eq)] pub struct LinkSpan { pub start: usize, pub end: usize, pub url: String }` (columns, `end` exclusive); `pub fn detect_links(texts: &[String], wrapped: &[bool], cols: Option<usize>) -> Vec<Vec<LinkSpan>>`; `pub fn merge_links(explicit: Vec<Vec<LinkSpan>>, detected: Vec<Vec<LinkSpan>>) -> Vec<Vec<LinkSpan>>`; `pub fn link_at(spans: &[Vec<LinkSpan>], row: usize, col: usize) -> Option<&LinkSpan>`; `pub fn is_openable(url: &str) -> bool`.

**Requirement on M4:** `texts[i]` must hold exactly one `char` per grid column (M4 writes a wide character's spacer cell as `' '`, so char index equals column; a wide character inside a URL therefore ends the detected link, which is accepted), and `wrapped[i]` is true when row `i` soft-wraps into `i + 1`.

This ports the URL half of iOS `LinkSpans.compute` only; file-path links are out of scope for Windows v1.

- [ ] **Step 1: Add the dependency**

Run: `cargo add -p tether-core regex@1`

- [ ] **Step 2: Write the failing tests** in `src/links.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn rows(lines: &[&str]) -> Vec<String> {
        lines.iter().map(|s| s.to_string()).collect()
    }

    fn urls(spans: &[Vec<LinkSpan>]) -> Vec<Vec<(usize, usize, &str)>> {
        spans.iter().map(|r| r.iter().map(|s| (s.start, s.end, s.url.as_str())).collect()).collect()
    }

    #[test]
    fn finds_a_url_and_trims_trailing_punctuation() {
        let t = rows(&["see https://example.com/a?b=1)."]);
        assert_eq!(urls(&detect_links(&t, &[false], None)), vec![vec![(4, 29, "https://example.com/a?b=1")]]);
        let t = rows(&["(https://en.wikipedia.org/wiki/Rust_(language))"]);
        assert_eq!(detect_links(&t, &[false], None)[0][0].url, "https://en.wikipedia.org/wiki/Rust_(language)");
    }

    #[test]
    fn a_soft_wrapped_url_spans_both_rows() {
        let t = rows(&["go https://example.com/aaaa", "bbbb/cc next"]);
        let spans = detect_links(&t, &[true, false], Some(27));
        let full = "https://example.com/aaaabbbb/cc";
        assert_eq!(urls(&spans), vec![vec![(3, 27, full)], vec![(0, 7, full)]]);
    }

    #[test]
    fn a_url_cut_by_claude_code_box_borders_resolves_whole() {
        let t = rows(&["│ see https://example.com/very/long/pa │", "│ th/to/file                           │"]);
        let spans = detect_links(&t, &[false, false], Some(40));
        let full = "https://example.com/very/long/path/to/file";
        assert_eq!(spans[0], vec![LinkSpan { start: 6, end: 38, url: full.into() }]);
        assert_eq!(spans[1], vec![LinkSpan { start: 2, end: 12, url: full.into() }]);
    }

    #[test]
    fn a_url_after_the_tool_output_marker_continues_on_the_next_row() {
        let first = "  ⎿  https://example.com/aaaaaaaaaaaa";
        let t = rows(&[first, "     bbbb/cc"]);
        let spans = detect_links(&t, &[false, false], Some(first.chars().count()));
        assert_eq!(spans[1][0].url, "https://example.com/aaaaaaaaaaaabbbb/cc");
    }

    #[test]
    fn prose_on_the_next_row_does_not_join() {
        let t = rows(&["read https://example.com/docs", "and then more"]);
        let spans = detect_links(&t, &[false, false], Some(29));
        assert_eq!(spans[0][0].url, "https://example.com/docs");
        assert!(spans[1].is_empty());
    }

    #[test]
    fn osc8_wins_over_detected_text() {
        let detected = detect_links(&rows(&["https://shown.example"]), &[false], None);
        let explicit = vec![vec![LinkSpan { start: 0, end: 21, url: "https://real.example".into() }]];
        let merged = merge_links(explicit, detected);
        assert_eq!(link_at(&merged, 0, 5).unwrap().url, "https://real.example");
        assert!(link_at(&merged, 0, 21).is_none());
        assert!(link_at(&merged, 3, 0).is_none());
    }

    #[test]
    fn only_http_https_and_mailto_open() {
        assert!(is_openable("https://x.y"));
        assert!(is_openable("HTTP://x.y"));
        assert!(is_openable("mailto:a@b.c"));
        assert!(!is_openable("file:///C:/Windows/system32/calc.exe"));
        assert!(!is_openable("javascript:alert(1)"));
        assert!(!is_openable("ms-settings:"));
    }
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cargo test -p tether-core links`
Expected: FAIL to compile — `cannot find function detect_links`.

- [ ] **Step 4: Write the implementation** — prepend to `src/links.rs`:

```rust
use std::sync::LazyLock;

use regex::Regex;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkSpan {
    pub start: usize,
    pub end: usize,
    pub url: String,
}

static URL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"https?://[^\s│┃⎿]+").unwrap());
static URL_AT_EOL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?:^|[\s│┃])https?://(\S*)$").unwrap());
static URL_CONT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9\-._~%+:@]*[/?#&=][^\s]*").unwrap());

/// Box drawing a TUI frames output with (`│ … │`, Claude Code's `⎿`): a URL it wraps
/// continues past these, not through them.
const BORDERS: [char; 3] = ['│', '┃', '⎿'];

/// Chars to drop from the end of a row closing on a box border: the border and one gutter
/// space. Wider padding means the text stopped short of the edge, so nothing wrapped.
fn trailing_border(row: &[char]) -> usize {
    let mut end = row.len();
    while end > 0 && row[end - 1].is_whitespace() {
        end -= 1;
    }
    if end == 0 || !BORDERS.contains(&row[end - 1]) || row[end - 1] == '⎿' {
        return 0;
    }
    end -= 1;
    if end > 0 && row[end - 1] == ' ' {
        end -= 1;
    }
    row.len() - end
}

fn hard_wrap_skip(row: &[char], next: &[char], continued: Option<(usize, usize)>, cols: Option<usize>) -> Option<usize> {
    let body = &row[..row.len() - trailing_border(row)];
    match continued {
        Some((lead, edge)) => {
            let rest = body.get(lead..).unwrap_or(&[]);
            if rest.is_empty() || rest.iter().any(|c| c.is_whitespace()) || body.len() + 1 < edge {
                return None;
            }
        }
        None => {
            let text: String = body.iter().collect();
            let caps = URL_AT_EOL.captures(&text)?;
            let tail = caps.get(1).map_or(0, |m| m.as_str().chars().count());
            // A URL cut at the edge wraps however little of it fits; one that stops short of
            // the edge needs some length to read as cut rather than done.
            let reaches_edge = trailing_border(row) > 0 || cols.is_some_and(|c| row.len() >= c);
            if !reaches_edge && tail < 8 {
                return None;
            }
        }
    }
    let lead = next.iter().take_while(|c| c.is_whitespace() || BORDERS.contains(c)).count();
    let rest: String = next[lead..].iter().collect();
    (!rest.is_empty() && URL_CONT.is_match(&rest)).then_some(lead)
}

fn trim_url_end(url: &str) -> String {
    let mut u: Vec<char> = url.chars().collect();
    while let Some(&ch) = u.last() {
        if ch == ')' {
            let opens = u.iter().filter(|&&c| c == '(').count();
            let closes = u.iter().filter(|&&c| c == ')').count();
            if closes <= opens {
                break;
            }
        } else if !".,;:!?'\"]}>".contains(ch) {
            break;
        }
        u.pop();
    }
    u.into_iter().collect()
}

pub fn detect_links(texts: &[String], wrapped: &[bool], cols: Option<usize>) -> Vec<Vec<LinkSpan>> {
    let rows: Vec<Vec<char>> = texts.iter().map(|t| t.chars().collect()).collect();
    let mut out = vec![Vec::new(); rows.len()];
    let mut i = 0;
    while i < rows.len() {
        let mut j = i;
        let mut skips = vec![0usize];
        let mut tails = Vec::new();
        while j + 1 < rows.len() {
            if wrapped.get(j).copied().unwrap_or(false) {
                skips.push(0);
                tails.push(0);
                j += 1;
                continue;
            }
            // Past the first row, a URL keeps going only through rows as wide as its first.
            let continued = (j > i).then(|| (*skips.last().unwrap(), rows[i].len() - trailing_border(&rows[i])));
            let Some(skip) = hard_wrap_skip(&rows[j], &rows[j + 1], continued, cols) else { break };
            skips.push(skip);
            tails.push(trailing_border(&rows[j]));
            j += 1;
        }
        tails.push(0);

        let mut parts: Vec<&[char]> = Vec::new();
        let mut offs = Vec::new();
        let mut acc = 0;
        for k in i..=j {
            let (skip, tail) = (skips[k - i], tails[k - i]);
            let mut part = &rows[k][..];
            if skip > 0 && skip <= part.len() {
                part = &part[skip..];
            }
            if tail > 0 && tail <= part.len() {
                part = &part[..part.len() - tail];
            }
            parts.push(part);
            offs.push(acc);
            acc += part.len();
        }
        let joined: String = parts.iter().flat_map(|p| p.iter()).collect();

        for m in URL.find_iter(&joined) {
            let url = trim_url_end(m.as_str());
            if url.is_empty() {
                continue;
            }
            let s = joined[..m.start()].chars().count();
            let e = s + url.chars().count();
            for k in i..=j {
                let row_start = offs[k - i];
                let row_end = row_start + parts[k - i].len();
                let (a, b) = (s.max(row_start), e.min(row_end));
                if a < b {
                    let skip = skips[k - i];
                    out[k].push(LinkSpan { start: a - row_start + skip, end: b - row_start + skip, url: url.clone() });
                }
            }
        }
        i = j + 1;
    }
    out
}

/// OSC 8 links come first in each row, so `link_at` finds them before detected text.
pub fn merge_links(explicit: Vec<Vec<LinkSpan>>, detected: Vec<Vec<LinkSpan>>) -> Vec<Vec<LinkSpan>> {
    let rows = explicit.len().max(detected.len());
    let mut explicit = explicit.into_iter();
    let mut detected = detected.into_iter();
    (0..rows)
        .map(|_| {
            let mut row = explicit.next().unwrap_or_default();
            row.extend(detected.next().unwrap_or_default());
            row
        })
        .collect()
}

pub fn link_at(spans: &[Vec<LinkSpan>], row: usize, col: usize) -> Option<&LinkSpan> {
    spans.get(row)?.iter().find(|s| col >= s.start && col < s.end)
}

pub fn is_openable(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("mailto:")
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test -p tether-core links`
Expected: PASS (7 tests). If `a_url_cut_by_claude_code_box_borders_resolves_whole` reports different columns, recount against the literal rows — `│ see ` is 6 chars and the URL fragment `https://example.com/very/long/pa` is 32 — and fix the test's numbers, never the rule.

- [ ] **Step 6: Commit**

```bash
git add clients/windows/crates/tether-core/src/links.rs clients/windows/crates/tether-core/src/lib.rs clients/windows/crates/tether-core/Cargo.toml clients/windows/Cargo.lock
git commit -m "feat(windows): detect URLs across wrapped and box-cut rows

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Key table — named keys

**Files:**
- Create: `clients/windows/crates/tether-core/src/keymap.rs`
- Modify: `clients/windows/crates/tether-core/src/lib.rs` (add `pub mod keymap;`)

**Interfaces:**
- Consumes: nothing.
- Produces: `#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)] pub struct Mods { pub shift: bool, pub alt: bool, pub ctrl: bool }` with `Mods::param(self) -> u8`; `pub enum NumpadKey { Digit(u8), Decimal, Add, Subtract, Multiply, Divide, Enter }`; `pub enum NamedKey { Up, Down, Left, Right, Home, End, Insert, Delete, PageUp, PageDown, F(u8), Tab, Enter, Backspace, Escape, Space, Numpad(NumpadKey) }`; `#[derive(Debug, Clone, Copy, Default)] pub struct KeyContext { pub app_cursor, pub app_keypad, pub alt_screen, pub mouse_reporting, pub has_selection: bool }`; `pub enum TetherCommand { Paste, Copy, FontBigger, FontSmaller, FontReset, NextTab, PrevTab, TabAt(u8), LastTab, NewTab, ScrollPageUp, ScrollPageDown }`; `pub enum KeyAction { Send(Vec<u8>), Tether(TetherCommand), Ignore }`; `pub fn encode_key(input: &KeyInput, mods: Mods, ctx: &KeyContext) -> KeyAction`. **Deviation:** `KeyInput::Char { unmodified: char, produced: Option<String>, digit: Option<u8> }` — `digit` is the top-row digit key (VK_0..VK_9) when that is the key pressed, because Ctrl+Shift+1…9 and Ctrl+0 are physical shortcuts and the unmodified char of that key is `&`, `é`, … on AZERTY.

`produced` is what the layout produced with the current modifiers (`ToUnicode` with the real key state); `unmodified` is the layout's char with no modifiers. Dead keys and IME never reach `encode_key`.

- [ ] **Step 1: Write the failing tests** in `src/keymap.rs`:

```rust
#[cfg(test)]
mod named_tests {
    use super::*;

    const NONE: Mods = Mods { shift: false, alt: false, ctrl: false };
    const SHIFT: Mods = Mods { shift: true, alt: false, ctrl: false };
    const ALT: Mods = Mods { shift: false, alt: true, ctrl: false };
    const CTRL: Mods = Mods { shift: false, alt: false, ctrl: true };
    const CTRL_SHIFT: Mods = Mods { shift: true, alt: false, ctrl: true };

    fn send(k: NamedKey, m: Mods, ctx: &KeyContext) -> Vec<u8> {
        match encode_key(&KeyInput::Named(k), m, ctx) {
            KeyAction::Send(b) => b,
            other => panic!("{k:?} {m:?} gave {other:?}"),
        }
    }

    fn normal() -> KeyContext {
        KeyContext::default()
    }

    fn app() -> KeyContext {
        KeyContext { app_cursor: true, app_keypad: true, ..Default::default() }
    }

    #[test]
    fn modifier_parameter() {
        assert_eq!(NONE.param(), 1);
        assert_eq!(SHIFT.param(), 2);
        assert_eq!(ALT.param(), 3);
        assert_eq!(CTRL.param(), 5);
        assert_eq!(Mods { shift: true, alt: true, ctrl: true }.param(), 8);
    }

    #[test]
    fn cursor_keys_in_normal_and_application_mode() {
        for (k, f) in [(NamedKey::Up, 'A'), (NamedKey::Down, 'B'), (NamedKey::Right, 'C'), (NamedKey::Left, 'D'), (NamedKey::Home, 'H'), (NamedKey::End, 'F')] {
            assert_eq!(send(k, NONE, &normal()), format!("\x1b[{f}").into_bytes());
            assert_eq!(send(k, NONE, &app()), format!("\x1bO{f}").into_bytes());
            assert_eq!(send(k, CTRL, &normal()), format!("\x1b[1;5{f}").into_bytes());
            assert_eq!(send(k, CTRL, &app()), format!("\x1b[1;5{f}").into_bytes());
            assert_eq!(send(k, SHIFT, &normal()), format!("\x1b[1;2{f}").into_bytes());
        }
    }

    #[test]
    fn tilde_keys_take_the_modifier_as_a_second_parameter() {
        assert_eq!(send(NamedKey::Insert, NONE, &normal()), b"\x1b[2~");
        assert_eq!(send(NamedKey::Delete, NONE, &normal()), b"\x1b[3~");
        assert_eq!(send(NamedKey::Delete, CTRL, &normal()), b"\x1b[3;5~");
        assert_eq!(send(NamedKey::PageUp, NONE, &normal()), b"\x1b[5~");
        assert_eq!(send(NamedKey::PageDown, ALT, &normal()), b"\x1b[6;3~");
        assert_eq!(send(NamedKey::PageUp, CTRL, &normal()), b"\x1b[5;5~");
    }

    #[test]
    fn function_keys() {
        assert_eq!(send(NamedKey::F(1), NONE, &normal()), b"\x1bOP");
        assert_eq!(send(NamedKey::F(4), NONE, &normal()), b"\x1bOS");
        assert_eq!(send(NamedKey::F(2), SHIFT, &normal()), b"\x1b[1;2Q");
        let codes = [15, 17, 18, 19, 20, 21, 23, 24];
        for (i, code) in codes.iter().enumerate() {
            let f = 5 + i as u8;
            assert_eq!(send(NamedKey::F(f), NONE, &normal()), format!("\x1b[{code}~").into_bytes());
            assert_eq!(send(NamedKey::F(f), CTRL, &normal()), format!("\x1b[{code};5~").into_bytes());
        }
        assert_eq!(send(NamedKey::F(10), NONE, &normal()), b"\x1b[21~");
        assert_eq!(encode_key(&KeyInput::Named(NamedKey::F(13)), NONE, &normal()), KeyAction::Ignore);
    }

    #[test]
    fn tab_enter_backspace_escape_space() {
        assert_eq!(send(NamedKey::Tab, NONE, &normal()), b"\x09");
        assert_eq!(send(NamedKey::Tab, SHIFT, &normal()), b"\x1b[Z");
        assert_eq!(send(NamedKey::Enter, NONE, &normal()), b"\r");
        assert_eq!(send(NamedKey::Enter, SHIFT, &normal()), b"\x1b\r");
        assert_eq!(send(NamedKey::Enter, ALT, &normal()), b"\x1b\r");
        assert_eq!(send(NamedKey::Backspace, NONE, &normal()), b"\x7f");
        assert_eq!(send(NamedKey::Backspace, CTRL, &normal()), b"\x08");
        assert_eq!(send(NamedKey::Backspace, ALT, &normal()), b"\x1b\x7f");
        assert_eq!(send(NamedKey::Escape, NONE, &normal()), b"\x1b");
        assert_eq!(send(NamedKey::Space, NONE, &normal()), b" ");
        assert_eq!(send(NamedKey::Space, CTRL, &normal()), b"\x00");
        assert_eq!(send(NamedKey::Space, ALT, &normal()), b"\x1b ");
    }

    #[test]
    fn numpad_in_normal_and_application_keypad_mode() {
        use NumpadKey::*;
        let cases = [(Digit(0), "0", "p"), (Digit(9), "9", "y"), (Decimal, ".", "n"), (Add, "+", "k"), (Subtract, "-", "m"), (Multiply, "*", "j"), (Divide, "/", "o")];
        for (k, plain, ss3) in cases {
            assert_eq!(send(NamedKey::Numpad(k), NONE, &normal()), plain.as_bytes());
            assert_eq!(send(NamedKey::Numpad(k), NONE, &app()), format!("\x1bO{ss3}").into_bytes());
        }
        assert_eq!(send(NamedKey::Numpad(Enter), NONE, &normal()), b"\r");
        assert_eq!(send(NamedKey::Numpad(Enter), NONE, &app()), b"\x1bOM");
    }

    #[test]
    fn tether_keeps_tab_switching_paste_and_scrollback_keys() {
        let k = |key, m, ctx: &KeyContext| encode_key(&KeyInput::Named(key), m, ctx);
        assert_eq!(k(NamedKey::Tab, CTRL, &normal()), KeyAction::Tether(TetherCommand::NextTab));
        assert_eq!(k(NamedKey::Tab, CTRL_SHIFT, &normal()), KeyAction::Tether(TetherCommand::PrevTab));
        assert_eq!(k(NamedKey::Insert, SHIFT, &normal()), KeyAction::Tether(TetherCommand::Paste));
        assert_eq!(k(NamedKey::PageUp, SHIFT, &normal()), KeyAction::Tether(TetherCommand::ScrollPageUp));
        assert_eq!(k(NamedKey::PageDown, SHIFT, &normal()), KeyAction::Tether(TetherCommand::ScrollPageDown));
        let alt_screen = KeyContext { alt_screen: true, ..Default::default() };
        assert_eq!(k(NamedKey::PageUp, SHIFT, &alt_screen), KeyAction::Send(b"\x1b[5;2~".to_vec()));
        let mouse = KeyContext { mouse_reporting: true, ..Default::default() };
        assert_eq!(k(NamedKey::PageDown, SHIFT, &mouse), KeyAction::Send(b"\x1b[6;2~".to_vec()));
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p tether-core named_tests`
Expected: FAIL to compile — `cannot find type Mods`.

- [ ] **Step 3: Write the implementation** — prepend to `src/keymap.rs` (the `encode_char` body is completed in Task 9; here it ignores every char so this task compiles on its own):

```rust
const ESC: u8 = 0x1b;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Mods {
    pub shift: bool,
    pub alt: bool,
    pub ctrl: bool,
}

impl Mods {
    /// The xterm modifier parameter: 1 + Shift 1 + Alt 2 + Ctrl 4.
    pub fn param(self) -> u8 {
        1 + self.shift as u8 + 2 * self.alt as u8 + 4 * self.ctrl as u8
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NumpadKey {
    Digit(u8),
    Decimal,
    Add,
    Subtract,
    Multiply,
    Divide,
    Enter,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NamedKey {
    Up,
    Down,
    Left,
    Right,
    Home,
    End,
    Insert,
    Delete,
    PageUp,
    PageDown,
    F(u8),
    Tab,
    Enter,
    Backspace,
    Escape,
    Space,
    Numpad(NumpadKey),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyInput {
    Named(NamedKey),
    Char { unmodified: char, produced: Option<String>, digit: Option<u8> },
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct KeyContext {
    pub app_cursor: bool,
    pub app_keypad: bool,
    pub alt_screen: bool,
    pub mouse_reporting: bool,
    pub has_selection: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TetherCommand {
    Paste,
    Copy,
    FontBigger,
    FontSmaller,
    FontReset,
    NextTab,
    PrevTab,
    TabAt(u8),
    LastTab,
    NewTab,
    ScrollPageUp,
    ScrollPageDown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyAction {
    Send(Vec<u8>),
    Tether(TetherCommand),
    Ignore,
}

pub fn encode_key(input: &KeyInput, mods: Mods, ctx: &KeyContext) -> KeyAction {
    match input {
        KeyInput::Named(key) => encode_named(*key, mods, ctx),
        KeyInput::Char { unmodified, produced, digit } => encode_char(*unmodified, produced.as_deref(), *digit, mods, ctx),
    }
}

fn csi_final(f: char, m: u8) -> Vec<u8> {
    if m == 1 { format!("\x1b[{f}") } else { format!("\x1b[1;{m}{f}") }.into_bytes()
}

fn cursor(f: char, m: u8, application: bool) -> Vec<u8> {
    if m == 1 && application { format!("\x1bO{f}").into_bytes() } else { csi_final(f, m) }
}

fn tilde(n: u8, m: u8) -> Vec<u8> {
    if m == 1 { format!("\x1b[{n}~") } else { format!("\x1b[{n};{m}~") }.into_bytes()
}

fn with_alt(alt: bool, byte: u8) -> Vec<u8> {
    if alt { vec![ESC, byte] } else { vec![byte] }
}

fn encode_named(key: NamedKey, mods: Mods, ctx: &KeyContext) -> KeyAction {
    let m = mods.param();
    let only_shift = mods == Mods { shift: true, ..Mods::default() };
    let bytes = match key {
        NamedKey::Up => cursor('A', m, ctx.app_cursor),
        NamedKey::Down => cursor('B', m, ctx.app_cursor),
        NamedKey::Right => cursor('C', m, ctx.app_cursor),
        NamedKey::Left => cursor('D', m, ctx.app_cursor),
        NamedKey::Home => cursor('H', m, ctx.app_cursor),
        NamedKey::End => cursor('F', m, ctx.app_cursor),
        NamedKey::Insert if only_shift => return KeyAction::Tether(TetherCommand::Paste),
        NamedKey::Insert => tilde(2, m),
        NamedKey::Delete => tilde(3, m),
        NamedKey::PageUp | NamedKey::PageDown if only_shift && !ctx.alt_screen && !ctx.mouse_reporting => {
            let cmd = if key == NamedKey::PageUp { TetherCommand::ScrollPageUp } else { TetherCommand::ScrollPageDown };
            return KeyAction::Tether(cmd);
        }
        NamedKey::PageUp => tilde(5, m),
        NamedKey::PageDown => tilde(6, m),
        NamedKey::F(n @ 1..=4) => {
            let f = ['P', 'Q', 'R', 'S'][n as usize - 1];
            if m == 1 { format!("\x1bO{f}").into_bytes() } else { csi_final(f, m) }
        }
        NamedKey::F(n @ 5..=12) => tilde([15, 17, 18, 19, 20, 21, 23, 24][n as usize - 5], m),
        NamedKey::F(_) => return KeyAction::Ignore,
        NamedKey::Tab => match (mods.ctrl, mods.shift) {
            (true, false) => return KeyAction::Tether(TetherCommand::NextTab),
            (true, true) => return KeyAction::Tether(TetherCommand::PrevTab),
            (false, true) => b"\x1b[Z".to_vec(),
            (false, false) => vec![0x09],
        },
        // Claude Code and readline-style prompts take ESC CR as a newline without submitting.
        NamedKey::Enter if mods.alt || mods.shift => vec![ESC, b'\r'],
        NamedKey::Enter => vec![b'\r'],
        NamedKey::Backspace => with_alt(mods.alt, if mods.ctrl { 0x08 } else { 0x7f }),
        NamedKey::Escape => vec![ESC],
        NamedKey::Space => with_alt(mods.alt, if mods.ctrl { 0x00 } else { b' ' }),
        NamedKey::Numpad(k) => numpad(k, ctx.app_keypad),
    };
    KeyAction::Send(bytes)
}

fn numpad(key: NumpadKey, application: bool) -> Vec<u8> {
    let (plain, ss3) = match key {
        NumpadKey::Digit(d) => ((b'0' + d.min(9)) as char, (b'p' + d.min(9)) as char),
        NumpadKey::Decimal => ('.', 'n'),
        NumpadKey::Add => ('+', 'k'),
        NumpadKey::Subtract => ('-', 'm'),
        NumpadKey::Multiply => ('*', 'j'),
        NumpadKey::Divide => ('/', 'o'),
        NumpadKey::Enter => ('\r', 'M'),
    };
    if application { format!("\x1bO{ss3}").into_bytes() } else { plain.to_string().into_bytes() }
}

fn encode_char(_unmodified: char, _produced: Option<&str>, _digit: Option<u8>, _mods: Mods, _ctx: &KeyContext) -> KeyAction {
    KeyAction::Ignore
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p tether-core named_tests`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add clients/windows/crates/tether-core/src/keymap.rs clients/windows/crates/tether-core/src/lib.rs
git commit -m "feat(windows): xterm key table for named keys

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Key table — characters, Ctrl/Alt folding, AltGr, Tether shortcuts

**Files:**
- Modify: `clients/windows/crates/tether-core/src/keymap.rs`

**Interfaces:**
- Consumes: Task 8's types.
- Produces: the finished `encode_key` for `KeyInput::Char`.

Rules, in order (each returns):
1. Ctrl+Alt and `produced` is printable text (no control chars) → send `produced` (AltGr; no Ctrl/Alt rule applies).
2. Ctrl without Alt → Tether shortcuts: `v` (± Shift) Paste; Shift+`c` Copy; `c` with a selection Copy; Shift+`t` NewTab; Shift+digit 1–8 `TabAt(d)`, Shift+9 `LastTab`; no Shift: `=` or `+` FontBigger, `-` FontSmaller, digit 0 (or `0`) FontReset.
3. Ctrl (± Alt) → fold: `unmodified` uppercased in `@`…`_` → `& 0x1F`; `/` → `0x1F`; else `produced` if it is one C0 char; else `produced` folded by the same rule. Alt prefixes `ESC`. Nothing foldable: Ctrl alone sends printable `produced` if any; otherwise Ignore.
4. Alt alone → `ESC` + (`produced`, else `unmodified`).
5. No modifier (or Shift) → `produced`; no `produced` → Ignore.

- [ ] **Step 1: Write the failing tests** — append to `src/keymap.rs`:

```rust
#[cfg(test)]
mod char_tests {
    use super::*;

    fn ch(unmodified: char, produced: Option<&str>) -> KeyInput {
        KeyInput::Char { unmodified, produced: produced.map(Into::into), digit: None }
    }

    fn digit(d: u8, unmodified: char, produced: Option<&str>) -> KeyInput {
        KeyInput::Char { unmodified, produced: produced.map(Into::into), digit: Some(d) }
    }

    fn m(shift: bool, alt: bool, ctrl: bool) -> Mods {
        Mods { shift, alt, ctrl }
    }

    fn enc(input: KeyInput, mods: Mods) -> KeyAction {
        encode_key(&input, mods, &KeyContext::default())
    }

    fn sent(bytes: &[u8]) -> KeyAction {
        KeyAction::Send(bytes.to_vec())
    }

    #[test]
    fn plain_and_shifted_text_is_what_the_layout_produced() {
        assert_eq!(enc(ch('a', Some("a")), m(false, false, false)), sent(b"a"));
        assert_eq!(enc(ch('a', Some("A")), m(true, false, false)), sent(b"A"));
        assert_eq!(enc(ch('e', Some("é")), m(false, false, false)), sent("é".as_bytes()));
        assert_eq!(enc(ch('a', None), m(false, false, false)), KeyAction::Ignore);
    }

    #[test]
    fn ctrl_folds_letters_and_at_through_underscore() {
        let ctrl = m(false, false, true);
        assert_eq!(enc(ch('a', None), ctrl), sent(b"\x01"));
        assert_eq!(enc(ch('z', None), ctrl), sent(b"\x1a"));
        assert_eq!(enc(ch('q', None), ctrl), sent(b"\x11"));
        assert_eq!(enc(ch('w', None), ctrl), sent(b"\x17"));
        assert_eq!(enc(ch('t', None), ctrl), sent(b"\x14"));
        assert_eq!(enc(ch('[', None), ctrl), sent(b"\x1b"));
        assert_eq!(enc(ch('\\', None), ctrl), sent(b"\x1c"));
        assert_eq!(enc(ch(']', None), ctrl), sent(b"\x1d"));
        assert_eq!(enc(ch('/', None), ctrl), sent(b"\x1f"));
        assert_eq!(enc(ch('6', Some("\u{1e}")), m(true, false, true)), sent(b"\x1e"));
        assert_eq!(enc(ch('-', Some("\u{1f}")), m(true, false, true)), sent(b"\x1f"));
        assert_eq!(enc(ch('1', None), ctrl), KeyAction::Ignore);
    }

    #[test]
    fn alt_is_an_escape_prefix_and_ctrl_alt_does_both() {
        assert_eq!(enc(ch('b', Some("b")), m(false, true, false)), sent(b"\x1bb"));
        assert_eq!(enc(ch('b', Some("B")), m(true, true, false)), sent(b"\x1bB"));
        assert_eq!(enc(ch('.', None), m(false, true, false)), sent(b"\x1b."));
        assert_eq!(enc(ch('a', None), m(false, true, true)), sent(b"\x1b\x01"));
    }

    #[test]
    fn altgr_text_wins_on_canadian_french() {
        let altgr = m(false, true, true);
        assert_eq!(enc(digit(2, '2', Some("@")), altgr), sent(b"@"));
        assert_eq!(enc(digit(7, '7', Some("|")), altgr), sent(b"|"));
        assert_eq!(enc(ch('^', Some("[")), altgr), sent(b"["));
        assert_eq!(enc(ch('e', Some("€")), altgr), sent("€".as_bytes()));
        assert_eq!(enc(ch('v', Some("v")), altgr), sent(b"v"));
    }

    #[test]
    fn folding_uses_the_unmodified_layout_char_not_the_physical_key() {
        // AZERTY: the key at QWERTY's A produces 'q'.
        assert_eq!(enc(ch('q', None), m(false, false, true)), sent(b"\x11"));
    }

    #[test]
    fn paste_and_copy_shortcuts() {
        let ctrl = m(false, false, true);
        let ctrl_shift = m(true, false, true);
        assert_eq!(enc(ch('v', None), ctrl), KeyAction::Tether(TetherCommand::Paste));
        assert_eq!(enc(ch('v', None), ctrl_shift), KeyAction::Tether(TetherCommand::Paste));
        assert_eq!(enc(ch('c', None), ctrl_shift), KeyAction::Tether(TetherCommand::Copy));
        assert_eq!(enc(ch('c', None), ctrl), sent(b"\x03"));
        let selected = KeyContext { has_selection: true, ..Default::default() };
        assert_eq!(encode_key(&ch('c', None), ctrl, &selected), KeyAction::Tether(TetherCommand::Copy));
    }

    #[test]
    fn font_size_and_tab_shortcuts() {
        let ctrl = m(false, false, true);
        let ctrl_shift = m(true, false, true);
        assert_eq!(enc(ch('=', None), ctrl), KeyAction::Tether(TetherCommand::FontBigger));
        assert_eq!(enc(ch('+', None), ctrl), KeyAction::Tether(TetherCommand::FontBigger));
        assert_eq!(enc(ch('-', None), ctrl), KeyAction::Tether(TetherCommand::FontSmaller));
        assert_eq!(enc(digit(0, 'à', None), ctrl), KeyAction::Tether(TetherCommand::FontReset));
        assert_eq!(enc(ch('t', None), ctrl_shift), KeyAction::Tether(TetherCommand::NewTab));
        assert_eq!(enc(digit(1, '&', None), ctrl_shift), KeyAction::Tether(TetherCommand::TabAt(1)));
        assert_eq!(enc(digit(8, '8', None), ctrl_shift), KeyAction::Tether(TetherCommand::TabAt(8)));
        assert_eq!(enc(digit(9, '9', None), ctrl_shift), KeyAction::Tether(TetherCommand::LastTab));
    }

    #[test]
    fn keys_tether_keeps_never_reach_the_pty() {
        let ctrl = m(false, false, true);
        for input in [ch('v', None), ch('=', None), ch('-', None), digit(0, '0', None)] {
            assert!(matches!(enc(input, ctrl), KeyAction::Tether(_)));
        }
        assert_ne!(enc(ch('v', None), ctrl), sent(b"\x16"));
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p tether-core char_tests`
Expected: FAIL — assertions fail because `encode_char` returns `Ignore` (e.g. `left: Ignore, right: Send([97])`).

- [ ] **Step 3: Write the implementation** — replace the stub `encode_char` in `src/keymap.rs` with:

```rust
fn is_printable(text: &str) -> bool {
    !text.is_empty() && !text.chars().any(char::is_control)
}

fn ctrl_fold(c: char) -> Option<u8> {
    match c.to_ascii_uppercase() {
        u @ '@'..='_' => Some(u as u8 & 0x1f),
        '/' => Some(0x1f),
        _ => None,
    }
}

fn single_char(text: &str) -> Option<char> {
    let mut chars = text.chars();
    let c = chars.next()?;
    chars.next().is_none().then_some(c)
}

fn shortcut(unmodified: char, digit: Option<u8>, shift: bool, ctx: &KeyContext) -> Option<TetherCommand> {
    let c = unmodified.to_ascii_lowercase();
    match (c, digit, shift) {
        ('v', _, _) => Some(TetherCommand::Paste),
        ('c', _, true) => Some(TetherCommand::Copy),
        ('c', _, false) if ctx.has_selection => Some(TetherCommand::Copy),
        ('t', _, true) => Some(TetherCommand::NewTab),
        (_, Some(d @ 1..=8), true) => Some(TetherCommand::TabAt(d)),
        (_, Some(9), true) => Some(TetherCommand::LastTab),
        ('=' | '+', _, false) => Some(TetherCommand::FontBigger),
        ('-', _, false) => Some(TetherCommand::FontSmaller),
        (_, Some(0), false) | ('0', _, false) => Some(TetherCommand::FontReset),
        _ => None,
    }
}

fn encode_char(unmodified: char, produced: Option<&str>, digit: Option<u8>, mods: Mods, ctx: &KeyContext) -> KeyAction {
    // AltGr arrives as Ctrl+Alt: a character the layout made from it is text.
    if mods.ctrl && mods.alt {
        if let Some(text) = produced.filter(|t| is_printable(t)) {
            return KeyAction::Send(text.as_bytes().to_vec());
        }
    }
    if mods.ctrl && !mods.alt {
        if let Some(cmd) = shortcut(unmodified, digit, mods.shift, ctx) {
            return KeyAction::Tether(cmd);
        }
    }
    if mods.ctrl {
        let folded = ctrl_fold(unmodified)
            .or_else(|| produced.and_then(single_char).filter(|c| (*c as u32) < 0x20).map(|c| c as u8))
            .or_else(|| produced.and_then(single_char).and_then(ctrl_fold));
        return match folded {
            Some(byte) => KeyAction::Send(with_alt(mods.alt, byte)),
            None if !mods.alt => produced
                .filter(|t| is_printable(t))
                .map_or(KeyAction::Ignore, |t| KeyAction::Send(t.as_bytes().to_vec())),
            None => KeyAction::Ignore,
        };
    }
    if mods.alt {
        let text = produced.filter(|t| is_printable(t)).map_or_else(|| unmodified.to_string(), str::to_owned);
        let mut bytes = vec![ESC];
        bytes.extend_from_slice(text.as_bytes());
        return KeyAction::Send(bytes);
    }
    produced.filter(|t| is_printable(t)).map_or(KeyAction::Ignore, |t| KeyAction::Send(t.as_bytes().to_vec()))
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p tether-core keymap`
Expected: PASS (15 tests across `named_tests` and `char_tests`).

- [ ] **Step 5: Commit**

```bash
git add clients/windows/crates/tether-core/src/keymap.rs
git commit -m "feat(windows): Ctrl/Alt folding, AltGr text and Tether shortcuts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Paste encoding and clipboard decision

**Files:**
- Create: `clients/windows/crates/tether-core/src/paste.rs`
- Modify: `clients/windows/crates/tether-core/src/lib.rs` (add `pub mod paste;`)

**Interfaces:**
- Consumes: nothing.
- Produces: `pub fn paste_bytes(text: &str, bracketed: bool) -> Vec<u8>`; `#[derive(Debug, Clone, PartialEq, Eq)] pub enum ClipboardSnapshot { Text(String), Image(Vec<u8>), Files(Vec<PathBuf>), Empty }`; `pub enum PasteAction { PasteText(String), UploadImage { name: String, png: Vec<u8> }, SendFiles(Vec<PathBuf>), Nothing }`; `pub fn paste_action(clip: ClipboardSnapshot, now_unix: i64) -> PasteAction`. **Additions:** `ClipboardSnapshot::from_formats(text: Option<String>, files: Option<Vec<PathBuf>>, png: Option<Vec<u8>>) -> ClipboardSnapshot` (the precedence rule, so the Win32 reader in M6 only gathers formats); `pub fn clipboard_image_name(now_unix: i64) -> String`.

Precedence: non-empty text, then files (`CF_HDROP`), then image, else empty. All four paste keys (Ctrl+V, Ctrl+Shift+V, Shift+Insert, right-click) produce `TetherCommand::Paste` (Tasks 8–9), so they share this one path.

- [ ] **Step 1: Write the failing tests** in `src/paste.rs`:

```rust
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
        assert_eq!(paste_bytes(evil, true), b"\x1b[200~saferm -rf ~\r\x1b[201~");
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
        assert_eq!(paste_action(snap, 1791082819), PasteAction::UploadImage { name: "paste-1791082819.png".into(), png: vec![9] });
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
        assert_eq!(paste_action(ClipboardSnapshot::from_formats(None, Some(vec![]), None), 1), PasteAction::Nothing);
        assert_eq!(paste_action(ClipboardSnapshot::Empty, 1), PasteAction::Nothing);
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p tether-core paste`
Expected: FAIL to compile — `cannot find function paste_bytes`.

- [ ] **Step 3: Write the implementation** — prepend to `src/paste.rs`:

```rust
use std::path::PathBuf;

const START: &str = "\x1b[200~";
const END: &str = "\x1b[201~";

/// Markers in the text are stripped so a paste cannot close the bracket and type commands.
pub fn paste_bytes(text: &str, bracketed: bool) -> Vec<u8> {
    let body = text.replace(START, "").replace(END, "").replace("\r\n", "\r").replace('\n', "\r");
    if bracketed { format!("{START}{body}{END}").into_bytes() } else { body.into_bytes() }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClipboardSnapshot {
    Text(String),
    Image(Vec<u8>),
    Files(Vec<PathBuf>),
    Empty,
}

impl ClipboardSnapshot {
    pub fn from_formats(text: Option<String>, files: Option<Vec<PathBuf>>, png: Option<Vec<u8>>) -> Self {
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
        ClipboardSnapshot::Image(png) => PasteAction::UploadImage { name: clipboard_image_name(now_unix), png },
        ClipboardSnapshot::Files(f) if !f.is_empty() => PasteAction::SendFiles(f),
        _ => PasteAction::Nothing,
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p tether-core paste`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add clients/windows/crates/tether-core/src/paste.rs clients/windows/crates/tether-core/src/lib.rs
git commit -m "feat(windows): bracketed paste encoding and clipboard paste decision

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Upload rules — uploads directory, remote path, limits, image names

**Files:**
- Create: `clients/windows/crates/tether-core/src/upload.rs`
- Modify: `clients/windows/crates/tether-core/src/lib.rs` (add `pub mod upload;`)

**Interfaces:**
- Consumes: nothing.
- Produces: `pub const BYTE_LIMIT: u64`; `pub const UPLOADS_COMMAND: &str`; `pub fn uploads_directory(output: &str) -> Option<String>`; `pub fn remote_path(dir: Option<&str>, filename: &str) -> String`; `pub fn rejection_reason(bytes: u64) -> Option<String>`; `pub const FOLDER_REFUSAL: &str`; `pub fn jpeg_name(name: &str) -> Option<String>`. **Additions:** `pub const ATTACHABLE_EXTENSIONS: [&str; 5]`, `pub const REENCODE_EXTENSIONS: [&str; 7]`; `pub fn preflight(is_dir: bool, bytes: u64) -> Result<(), String>`; `pub fn display_remote(remote: &str) -> String` (`~/.tether/uploads/<name>` form for the capsule).

Size formatting matches iOS `ByteCountFormatter` (binary) for the spec's example: MiB with one decimal, a trailing `.0` dropped; 1024 MiB and over as GB with up to two decimals, trailing zeros dropped. `jpeg_name` returns `Some` only for the re-encode set, so non-image files are never touched. The app calls `preflight(false, len)` with the file size for files sent as they are (before reading them), and with the encoded size after a re-encode.

- [ ] **Step 1: Write the failing tests** in `src/upload.rs`:

```rust
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
        assert_eq!(uploads_directory("motd\n/home/u/.tether/uploads\n__TETHER_UPLOADS_OK__\n").as_deref(), Some("/home/u/.tether/uploads"));
        assert_eq!(uploads_directory("  /x \r\n__TETHER_UPLOADS_OK__").as_deref(), Some("/x"));
        assert_eq!(uploads_directory("relative/dir\n__TETHER_UPLOADS_OK__"), None);
        assert_eq!(uploads_directory("/home/u/.tether/uploads\n"), None);
        assert_eq!(uploads_directory("__TETHER_UPLOADS_OK__"), None);
        assert_eq!(uploads_directory(""), None);
    }

    #[test]
    fn remote_path_joins_or_falls_back_to_the_bare_name() {
        assert_eq!(remote_path(Some("/h/.tether/uploads"), "a.png"), "/h/.tether/uploads/a.png");
        assert_eq!(remote_path(Some("/h/"), "a.png"), "/h/a.png");
        assert_eq!(remote_path(Some(""), "a.png"), "a.png");
        assert_eq!(remote_path(None, "a.png"), "a.png");
    }

    #[test]
    fn the_limit_copy_matches_the_spec() {
        assert_eq!(rejection_reason(BYTE_LIMIT), None);
        assert_eq!(rejection_reason(214 * 1024 * 1024).as_deref(), Some("That's 214 MB — Tether sends up to 200 MB at a time."));
        assert_eq!(rejection_reason(214 * 1024 * 1024 + 512 * 1024).as_deref(), Some("That's 214.5 MB — Tether sends up to 200 MB at a time."));
        assert_eq!(rejection_reason(3 * 1024 * 1024 * 1024 / 2).as_deref(), Some("That's 1.5 GB — Tether sends up to 200 MB at a time."));
    }

    #[test]
    fn folders_are_refused_and_size_is_checked() {
        assert_eq!(preflight(true, 0), Err("Tether sends files, not folders.".to_string()));
        assert_eq!(preflight(false, 10), Ok(()));
        assert!(preflight(false, BYTE_LIMIT + 1).unwrap_err().starts_with("That's 200 MB"));
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
        assert_eq!(display_remote("/home/u/.tether/uploads/paste-1.png"), "~/.tether/uploads/paste-1.png");
        assert_eq!(display_remote("/srv/x.png"), "/srv/x.png");
        assert_eq!(display_remote("x.png"), "x.png");
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p tether-core upload`
Expected: FAIL to compile — `cannot find value UPLOADS_COMMAND`.

- [ ] **Step 3: Write the implementation** — prepend to `src/upload.rs`:

```rust
use std::path::Path;

/// Lifting this means streaming the transfer instead of buffering it.
pub const BYTE_LIMIT: u64 = 200 * 1024 * 1024;
const UPLOADS_MARKER: &str = "__TETHER_UPLOADS_OK__";
/// Resolves `$HOME` on the host: the pasted path must be absolute for a TUI in any cwd.
pub const UPLOADS_COMMAND: &str =
    r#"mkdir -p "$HOME/.tether/uploads" && cd "$HOME/.tether/uploads" && pwd && echo __TETHER_UPLOADS_OK__"#;
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
    if s.contains('.') { s.trim_end_matches('0').trim_end_matches('.').to_owned() } else { s }
}

fn format_size(bytes: u64) -> String {
    let mib = bytes as f64 / (1024.0 * 1024.0);
    if mib < 1024.0 { format!("{} MB", trimmed(mib, 1)) } else { format!("{} GB", trimmed(mib / 1024.0, 2)) }
}

pub fn rejection_reason(bytes: u64) -> Option<String> {
    (bytes > BYTE_LIMIT).then(|| format!("That's {} — Tether sends up to 200 MB at a time.", format_size(bytes)))
}

pub fn preflight(is_dir: bool, bytes: u64) -> Result<(), String> {
    if is_dir {
        return Err(FOLDER_REFUSAL.to_owned());
    }
    rejection_reason(bytes).map_or(Ok(()), Err)
}

fn extension(name: &str) -> Option<String> {
    Path::new(name).extension().map(|e| e.to_string_lossy().to_ascii_lowercase())
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p tether-core upload`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add clients/windows/crates/tether-core/src/upload.rs clients/windows/crates/tether-core/src/lib.rs
git commit -m "feat(windows): upload directory, path, size limit and image-name rules

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Send queue and capsule

**Files:**
- Modify: `clients/windows/crates/tether-core/src/upload.rs`

**Interfaces:**
- Consumes: `zmx::shell_quote` (Task 1), `paste::paste_bytes` (Task 10), `display_remote` (Task 11).
- Produces: `#[derive(Debug, Clone, PartialEq, Eq)] pub struct PendingFile { pub local: PathBuf, pub name: String }` (`name` is the outgoing name after any `.jpg` rename); `pub struct SendQueue` with `new(files: Vec<PendingFile>, target_tab: String) -> Self`, `target_tab(&self) -> &str`, `current(&self) -> Option<&PendingFile>`, `on_sent(&mut self, remote: &str, bracketed: bool) -> Vec<u8>` (the paste to write into `target_tab`), `on_failed(&mut self, reason: &str)`, `is_finished(&self) -> bool`, `capsule(&self) -> Option<String>`; `pub const CAPSULE_LINGER: Duration` (4 s); `pub fn capsule_expired(shown_at: Duration, now: Duration) -> bool`.

Failure capsule text (the spec names the file and why, without fixing the words): `Couldn't send <name>: <reason>`.

- [ ] **Step 1: Write the failing tests** — append to `mod tests` in `src/upload.rs`:

```rust
    fn files(names: &[&str]) -> Vec<PendingFile> {
        names.iter().map(|n| PendingFile { local: PathBuf::from(format!(r"C:\tmp\{n}")), name: n.to_string() }).collect()
    }

    #[test]
    fn files_go_in_order_one_paste_each_with_a_leading_space_after_the_first() {
        let mut q = SendQueue::new(files(&["a.png", "b c.png", "d.png"]), "build".into());
        assert_eq!(q.target_tab(), "build");
        assert_eq!(q.capsule().as_deref(), Some("Sending a.png (1/3)"));
        assert_eq!(q.current().unwrap().name, "a.png");
        assert_eq!(q.on_sent("/h/.tether/uploads/a.png", true), b"\x1b[200~'/h/.tether/uploads/a.png'\x1b[201~");
        assert_eq!(q.capsule().as_deref(), Some("Sending b c.png (2/3)"));
        assert_eq!(q.on_sent("/h/.tether/uploads/b c.png", true), b"\x1b[200~ '/h/.tether/uploads/b c.png'\x1b[201~");
        assert_eq!(q.on_sent("/h/.tether/uploads/d.png", false), b" '/h/.tether/uploads/d.png'");
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
        assert_eq!(q.capsule().as_deref(), Some("Couldn't send big.mov: That's 214 MB — Tether sends up to 200 MB at a time."));
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p tether-core upload`
Expected: FAIL to compile — `cannot find type PendingFile`.

- [ ] **Step 3: Write the implementation** — add to `src/upload.rs` above `mod tests` (and change the top `use std::path::Path;` to `use std::path::{Path, PathBuf};` plus `use std::time::Duration;`):

```rust
use crate::paste::paste_bytes;
use crate::zmx::shell_quote;

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
        let state = if files.is_empty() { QueueState::Done } else { QueueState::Sending };
        SendQueue { files, target_tab, index: 0, last_remote: None, state }
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
        let text = if self.index == 0 { quoted } else { format!(" {quoted}") };
        self.last_remote = Some(remote.to_owned());
        self.index += 1;
        if self.index == self.files.len() {
            self.state = QueueState::Done;
        }
        paste_bytes(&text, bracketed)
    }

    pub fn on_failed(&mut self, reason: &str) {
        let Some(name) = self.current().map(|f| f.name.clone()) else { return };
        self.state = QueueState::Failed { name, reason: reason.to_owned() };
    }

    pub fn is_finished(&self) -> bool {
        self.state != QueueState::Sending
    }

    pub fn capsule(&self) -> Option<String> {
        match &self.state {
            QueueState::Sending => {
                Some(format!("Sending {} ({}/{})", self.files[self.index].name, self.index + 1, self.files.len()))
            }
            QueueState::Done => self.last_remote.as_deref().map(|r| format!("Sent {}", display_remote(r))),
            QueueState::Failed { name, reason } => Some(format!("Couldn't send {name}: {reason}")),
        }
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p tether-core upload`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add clients/windows/crates/tether-core/src/upload.rs
git commit -m "feat(windows): send queue with one paste per file and capsule text

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Resize debounce and lock grace

**Files:**
- Create: `clients/windows/crates/tether-core/src/resize.rs`, `clients/windows/crates/tether-core/src/lock.rs`
- Modify: `clients/windows/crates/tether-core/src/lib.rs` (add `pub mod resize; pub mod lock;`)

**Interfaces:**
- Consumes: nothing.
- Produces: `#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)] pub struct GridSize { pub cols: u16, pub rows: u16, pub width_px: u32, pub height_px: u32 }`; `pub const RESIZE_SETTLE: Duration` (150 ms); `#[derive(Debug, Default)] pub struct ResizeDebouncer` with `on_size(&mut self, size: GridSize, now: Duration)`, `poll(&mut self, now: Duration) -> Option<GridSize>`, **addition** `mark_sent(&mut self, size: GridSize)` (the size a channel was opened at). `pub const LOCK_GRACE: Duration` (15 s); `#[derive(Debug, Clone, Copy, PartialEq, Eq)] pub enum LockAction { None, DetachAll, ReattachAll }`; `#[derive(Debug, Default)] pub struct LockGrace` with `on_lock(&mut self, now: Duration)`, `on_unlock(&mut self) -> LockAction`, `poll(&mut self, now: Duration) -> LockAction`.

The app redraws locally on every `on_size`; only `poll` results reach the PTY. Minimize is not a lock and never reaches `LockGrace`.

- [ ] **Step 1: Write the failing tests**

`src/resize.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn g(cols: u16, rows: u16) -> GridSize {
        GridSize { cols, rows, width_px: cols as u32 * 9, height_px: rows as u32 * 18 }
    }

    fn ms(v: u64) -> Duration {
        Duration::from_millis(v)
    }

    #[test]
    fn a_drag_sends_one_resize_after_the_settle_window() {
        let mut d = ResizeDebouncer::default();
        d.mark_sent(g(80, 24));
        for (i, cols) in (81..=120).enumerate() {
            d.on_size(g(cols, 30), ms(i as u64 * 16));
            assert_eq!(d.poll(ms(i as u64 * 16 + 1)), None);
        }
        let last = 39 * 16;
        assert_eq!(d.poll(ms(last + 149)), None);
        assert_eq!(d.poll(ms(last + 150)), Some(g(120, 30)));
        assert_eq!(d.poll(ms(last + 500)), None);
    }

    #[test]
    fn settling_back_on_the_sent_size_sends_nothing() {
        let mut d = ResizeDebouncer::default();
        d.mark_sent(g(80, 24));
        d.on_size(g(90, 24), ms(0));
        d.on_size(g(80, 24), ms(50));
        assert_eq!(d.poll(ms(300)), None);
    }
}
```

`src/lock.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: u64) -> Duration {
        Duration::from_secs(v)
    }

    #[test]
    fn detach_after_the_grace_not_before() {
        let mut l = LockGrace::default();
        l.on_lock(s(100));
        assert_eq!(l.poll(s(114)), LockAction::None);
        assert_eq!(l.poll(s(115)), LockAction::DetachAll);
        assert_eq!(l.poll(s(200)), LockAction::None);
        assert_eq!(l.on_unlock(), LockAction::ReattachAll);
        assert_eq!(l.poll(s(300)), LockAction::None);
    }

    #[test]
    fn unlock_inside_the_grace_changes_nothing() {
        let mut l = LockGrace::default();
        l.on_lock(s(0));
        assert_eq!(l.on_unlock(), LockAction::None);
        assert_eq!(l.poll(s(60)), LockAction::None);
    }

    #[test]
    fn a_second_lock_event_does_not_restart_the_grace() {
        let mut l = LockGrace::default();
        l.on_lock(s(0));
        l.on_lock(s(10));
        assert_eq!(l.poll(s(15)), LockAction::DetachAll);
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p tether-core resize lock`
Expected: FAIL to compile — `cannot find type ResizeDebouncer` / `LockGrace`.

(`cargo test` takes one filter; run `cargo test -p tether-core resize` and `cargo test -p tether-core lock` separately if your cargo rejects two.)

- [ ] **Step 3: Write the implementation**

Prepend to `src/resize.rs`:

```rust
use std::time::Duration;

/// A resizing grid would report sizes the PTY then has to honor: one SIGWINCH per settle.
pub const RESIZE_SETTLE: Duration = Duration::from_millis(150);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct GridSize {
    pub cols: u16,
    pub rows: u16,
    pub width_px: u32,
    pub height_px: u32,
}

#[derive(Debug, Default)]
pub struct ResizeDebouncer {
    pending: Option<(GridSize, Duration)>,
    sent: Option<GridSize>,
}

impl ResizeDebouncer {
    pub fn mark_sent(&mut self, size: GridSize) {
        self.sent = Some(size);
    }

    pub fn on_size(&mut self, size: GridSize, now: Duration) {
        self.pending = Some((size, now));
    }

    pub fn poll(&mut self, now: Duration) -> Option<GridSize> {
        let (size, at) = self.pending?;
        if now.saturating_sub(at) < RESIZE_SETTLE {
            return None;
        }
        self.pending = None;
        if self.sent == Some(size) {
            return None;
        }
        self.sent = Some(size);
        Some(size)
    }
}
```

Prepend to `src/lock.rs`:

```rust
use std::time::Duration;

/// iOS `backgroundGrace`: a short lock keeps the attach; a long one tells the
/// Claude Code mod nobody is watching.
pub const LOCK_GRACE: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LockAction {
    None,
    DetachAll,
    ReattachAll,
}

#[derive(Debug, Default)]
pub struct LockGrace {
    locked_at: Option<Duration>,
    detached: bool,
}

impl LockGrace {
    pub fn on_lock(&mut self, now: Duration) {
        self.locked_at.get_or_insert(now);
    }

    pub fn poll(&mut self, now: Duration) -> LockAction {
        match self.locked_at {
            Some(at) if !self.detached && now.saturating_sub(at) >= LOCK_GRACE => {
                self.detached = true;
                LockAction::DetachAll
            }
            _ => LockAction::None,
        }
    }

    pub fn on_unlock(&mut self) -> LockAction {
        let action = if self.detached { LockAction::ReattachAll } else { LockAction::None };
        *self = Self::default();
        action
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p tether-core resize` then `cargo test -p tether-core lock`
Expected: PASS (2 + 3 tests).

- [ ] **Step 5: Commit**

```bash
git add clients/windows/crates/tether-core/src/resize.rs clients/windows/crates/tether-core/src/lock.rs clients/windows/crates/tether-core/src/lib.rs
git commit -m "feat(windows): resize settle debounce and lock grace

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Connection sequence over the `Transport` trait

**Files:**
- Create: `clients/windows/crates/tether-core/src/connect.rs`
- Modify: `clients/windows/crates/tether-core/src/lib.rs` (add `pub mod connect;`), `Cargo.toml` (dev-dependency via `cargo add`)

**Interfaces:**
- Consumes: M1's `profiles::{Machine, Auth}`, `secrets::{SecretStore, SecretError, key_account, password_account}`, `hostkey::{HostKeyStore, HostKeyDecision, hex_fingerprint, verify_host_key}`.
- Produces: `pub enum Credential { Key(Zeroizing<String>), Password(Zeroizing<String>), Agent }` (redacting `Debug`, plus **addition** `Credential::kind(&self) -> &'static str` → `"key"`, `"password"`, `"agent"`); `#[derive(Debug, Clone, PartialEq, Eq)] pub enum ConnectError { HostKeyChanged { expected: String, got: String }, AuthRejected, KeyMissing, AgentNotRunning, AgentNoKey, Timeout, Transport(String) }` with `sentence(&self) -> String` and `retryable(&self) -> bool`; `pub trait Transport`, `pub trait Connection` exactly as the contract; `pub struct ConnectRequest { pub machine: Machine }`; `pub async fn connect<T: Transport>(t: &T, req: &ConnectRequest, hostkeys: &dyn HostKeyStore, secrets: &dyn SecretStore) -> Result<T::Conn, ConnectError>`; `pub const RECONNECT_BACKOFF: [Duration; 3]`. **Additions:** `pub const CONNECT_TIMEOUT` (10 s), `KEEPALIVE_EVERY` (15 s), `TRANSPORT_ATTEMPTS: usize = 3`, `RETRY_DELAY` (500 ms); `pub fn load_credential(machine: &Machine, secrets: &dyn SecretStore) -> Result<Credential, ConnectError>`.

Sequence per attempt: load the credential (a missing key secret is `KeyMissing`, no dial; a missing password is `AuthRejected`); dial with `CONNECT_TIMEOUT`; verify the host key (first sight pins before auth; mismatch → `HostKeyChanged`, nothing written); authenticate; `start_keepalive(KEEPALIVE_EVERY)` — after auth, never before (before the handshake it breaks strict KEX on modern OpenSSH). Only `Transport` and `Timeout` are retried, up to three attempts total, `RETRY_DELAY` apart via `Transport::sleep`. M3's transport maps "agent pipe absent" to `AgentNotRunning`, "agent offered keys, all rejected" to `AgentNoKey`, and "no reply after the handshake" to `Timeout`.

- [ ] **Step 1: Add the dev-dependency**

Run: `cargo add -p tether-core --dev futures@0.3`

- [ ] **Step 2: Write the failing tests** in `src/connect.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::SecretError;
    use futures::executor::block_on;
    use std::collections::{HashMap, VecDeque};
    use std::sync::{Arc, Mutex};
    use uuid::Uuid;

    type Log = Arc<Mutex<Vec<String>>>;

    struct FakeTransport {
        log: Log,
        dials: Mutex<VecDeque<Result<[u8; 32], ConnectError>>>,
        auths: Mutex<VecDeque<Result<(), ConnectError>>>,
    }

    struct FakeConn {
        log: Log,
        key: [u8; 32],
        auth: Result<(), ConnectError>,
    }

    impl Transport for FakeTransport {
        type Conn = FakeConn;

        fn dial(&self, host: &str, port: u16, timeout: Duration) -> impl Future<Output = Result<FakeConn, ConnectError>> + Send {
            self.log.lock().unwrap().push(format!("dial {host}:{port} {}s", timeout.as_secs()));
            let next = self.dials.lock().unwrap().pop_front().expect("unexpected dial");
            let auth = self.auths.lock().unwrap().pop_front().unwrap_or(Ok(()));
            let log = self.log.clone();
            async move { next.map(|key| FakeConn { log, key, auth }) }
        }

        fn sleep(&self, d: Duration) -> impl Future<Output = ()> + Send {
            self.log.lock().unwrap().push(format!("sleep {}ms", d.as_millis()));
            async {}
        }
    }

    impl Connection for FakeConn {
        fn host_key_sha256(&self) -> [u8; 32] {
            self.key
        }

        fn authenticate(&mut self, user: &str, cred: Credential) -> impl Future<Output = Result<(), ConnectError>> + Send {
            self.log.lock().unwrap().push(format!("auth {user} {}", cred.kind()));
            let result = self.auth.clone();
            async move { result }
        }

        fn start_keepalive(&mut self, every: Duration) {
            self.log.lock().unwrap().push(format!("keepalive {}s", every.as_secs()));
        }

        fn exec(&self, command: &str) -> impl Future<Output = Result<String, ConnectError>> + Send {
            self.log.lock().unwrap().push(format!("exec {command}"));
            async { Ok(String::new()) }
        }
    }

    struct Pins {
        log: Log,
        map: Mutex<HashMap<String, String>>,
    }

    impl HostKeyStore for Pins {
        fn pinned(&self, host: &str, port: u16) -> Option<String> {
            self.map.lock().unwrap().get(&format!("{host}:{port}")).cloned()
        }
        fn pin(&self, host: &str, port: u16, fingerprint: &str) {
            self.log.lock().unwrap().push("pin".into());
            self.map.lock().unwrap().insert(format!("{host}:{port}"), fingerprint.into());
        }
    }

    struct Secrets(Mutex<HashMap<String, Vec<u8>>>);

    impl SecretStore for Secrets {
        fn get(&self, account: &str) -> Result<Option<Zeroizing<Vec<u8>>>, SecretError> {
            Ok(self.0.lock().unwrap().get(account).cloned().map(Zeroizing::new))
        }
        fn set(&self, account: &str, secret: &[u8]) -> Result<(), SecretError> {
            self.0.lock().unwrap().insert(account.into(), secret.to_vec());
            Ok(())
        }
        fn delete(&self, account: &str) -> Result<(), SecretError> {
            self.0.lock().unwrap().remove(account);
            Ok(())
        }
    }

    struct World {
        log: Log,
        transport: FakeTransport,
        pins: Pins,
        secrets: Secrets,
        key_id: Uuid,
    }

    fn world(dials: Vec<Result<[u8; 32], ConnectError>>, auths: Vec<Result<(), ConnectError>>) -> World {
        let log: Log = Arc::default();
        let key_id = Uuid::new_v4();
        let secrets = Secrets(Mutex::new(HashMap::from([(key_account(key_id), b"-----BEGIN OPENSSH PRIVATE KEY-----".to_vec())])));
        World {
            transport: FakeTransport { log: log.clone(), dials: Mutex::new(dials.into()), auths: Mutex::new(auths.into()) },
            pins: Pins { log: log.clone(), map: Mutex::default() },
            secrets,
            log,
            key_id,
        }
    }

    fn machine(auth: Auth) -> ConnectRequest {
        ConnectRequest {
            machine: Machine { id: Uuid::new_v4(), name: "devbox".into(), host: "h".into(), port: 22, user: "u".into(), auth },
        }
    }

    fn run(w: &World, req: &ConnectRequest) -> Result<FakeConn, ConnectError> {
        block_on(connect(&w.transport, req, &w.pins, &w.secrets))
    }

    fn log(w: &World) -> Vec<String> {
        w.log.lock().unwrap().clone()
    }

    const KEY_A: [u8; 32] = [0xaa; 32];
    const KEY_B: [u8; 32] = [0xbb; 32];

    #[test]
    fn first_connect_pins_before_auth_and_keepalive_starts_after_auth() {
        let w = world(vec![Ok(KEY_A)], vec![]);
        let req = machine(Auth::Key { id: w.key_id });
        assert!(run(&w, &req).is_ok());
        assert_eq!(log(&w), ["dial h:22 10s", "pin", "auth u key", "keepalive 15s"]);
        assert_eq!(w.pins.pinned("h", 22), Some(hex_fingerprint(&KEY_A)));
    }

    #[test]
    fn a_matching_pin_continues_without_writing() {
        let w = world(vec![Ok(KEY_A)], vec![]);
        w.pins.map.lock().unwrap().insert("h:22".into(), hex_fingerprint(&KEY_A));
        assert!(run(&w, &machine(Auth::Agent)).is_ok());
        assert_eq!(log(&w), ["dial h:22 10s", "auth u agent", "keepalive 15s"]);
    }

    #[test]
    fn a_mismatch_is_refused_not_written_and_never_retried() {
        let w = world(vec![Ok(KEY_B), Ok(KEY_B)], vec![]);
        w.pins.map.lock().unwrap().insert("h:22".into(), hex_fingerprint(&KEY_A));
        let err = run(&w, &machine(Auth::Agent)).err().unwrap();
        assert_eq!(err, ConnectError::HostKeyChanged { expected: hex_fingerprint(&KEY_A), got: hex_fingerprint(&KEY_B) });
        assert_eq!(log(&w), ["dial h:22 10s"]);
        assert_eq!(w.pins.pinned("h", 22), Some(hex_fingerprint(&KEY_A)));
        assert!(!err.retryable());
    }

    #[test]
    fn an_auth_failure_is_not_retried() {
        let w = world(vec![Ok(KEY_A), Ok(KEY_A)], vec![Err(ConnectError::AuthRejected)]);
        let mut req = machine(Auth::Password);
        w.secrets.set(&password_account(req.machine.id), b"hunter2").unwrap();
        req.machine.port = 2222;
        assert_eq!(run(&w, &req).err(), Some(ConnectError::AuthRejected));
        assert_eq!(log(&w), ["dial h:2222 10s", "pin", "auth u password"]);
    }

    #[test]
    fn transport_failures_retry_three_attempts_500ms_apart() {
        let refused = || Err(ConnectError::Transport("connection refused".into()));
        let w = world(vec![refused(), refused(), refused()], vec![]);
        assert_eq!(run(&w, &machine(Auth::Agent)).err(), Some(ConnectError::Transport("connection refused".into())));
        assert_eq!(log(&w), ["dial h:22 10s", "sleep 500ms", "dial h:22 10s", "sleep 500ms", "dial h:22 10s"]);
    }

    #[test]
    fn a_timeout_retries_and_a_later_attempt_can_succeed() {
        let w = world(vec![Err(ConnectError::Timeout), Ok(KEY_A)], vec![]);
        assert!(run(&w, &machine(Auth::Agent)).is_ok());
        assert_eq!(log(&w), ["dial h:22 10s", "sleep 500ms", "dial h:22 10s", "pin", "auth u agent", "keepalive 15s"]);
    }

    #[test]
    fn agent_errors_are_not_retried() {
        let w = world(vec![Ok(KEY_A), Ok(KEY_A)], vec![Err(ConnectError::AgentNotRunning)]);
        assert_eq!(run(&w, &machine(Auth::Agent)).err(), Some(ConnectError::AgentNotRunning));
        assert_eq!(log(&w).iter().filter(|l| l.starts_with("dial")).count(), 1);
    }

    #[test]
    fn a_deleted_key_fails_before_dialing() {
        let w = world(vec![], vec![]);
        let req = machine(Auth::Key { id: Uuid::new_v4() });
        assert_eq!(run(&w, &req).err(), Some(ConnectError::KeyMissing));
        assert!(log(&w).is_empty());
    }

    #[test]
    fn a_missing_saved_password_is_an_auth_failure() {
        let w = world(vec![], vec![]);
        assert_eq!(run(&w, &machine(Auth::Password)).err(), Some(ConnectError::AuthRejected));
    }

    #[test]
    fn sentences_are_verbatim() {
        assert_eq!(ConnectError::AuthRejected.sentence(), "Authentication failed. Check the key or password.");
        assert_eq!(ConnectError::KeyMissing.sentence(), "This machine's key was deleted. Edit the machine and choose another key.");
        assert_eq!(
            ConnectError::AgentNotRunning.sentence(),
            "The Windows SSH agent isn't running. Start the OpenSSH Authentication Agent service, or choose a key."
        );
        assert_eq!(ConnectError::AgentNoKey.sentence(), "The SSH agent has no key this host accepts.");
        assert_eq!(ConnectError::Timeout.sentence(), "The host stopped answering.");
        assert_eq!(ConnectError::Transport("no route".into()).sentence(), "Could not connect: no route");
    }

    #[test]
    fn credentials_never_print_their_secret() {
        let c = Credential::Password(Zeroizing::new("hunter2".into()));
        assert!(!format!("{c:?}").contains("hunter2"));
    }

    #[test]
    fn reconnect_backs_off_one_two_four_seconds() {
        assert_eq!(RECONNECT_BACKOFF, [Duration::from_secs(1), Duration::from_secs(2), Duration::from_secs(4)]);
    }
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cargo test -p tether-core connect`
Expected: FAIL to compile — `cannot find trait Transport`.

- [ ] **Step 4: Write the implementation** — prepend to `src/connect.rs`:

```rust
use std::fmt;
use std::future::Future;
use std::time::Duration;

use zeroize::Zeroizing;

use crate::hostkey::{HostKeyDecision, HostKeyStore, hex_fingerprint, verify_host_key};
use crate::profiles::{Auth, Machine};
use crate::secrets::{SecretStore, key_account, password_account};

pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
pub const KEEPALIVE_EVERY: Duration = Duration::from_secs(15);
pub const TRANSPORT_ATTEMPTS: usize = 3;
pub const RETRY_DELAY: Duration = Duration::from_millis(500);
pub const RECONNECT_BACKOFF: [Duration; 3] = [Duration::from_secs(1), Duration::from_secs(2), Duration::from_secs(4)];

pub enum Credential {
    Key(Zeroizing<String>),
    Password(Zeroizing<String>),
    Agent,
}

impl Credential {
    pub fn kind(&self) -> &'static str {
        match self {
            Credential::Key(_) => "key",
            Credential::Password(_) => "password",
            Credential::Agent => "agent",
        }
    }
}

impl fmt::Debug for Credential {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Credential::{}", self.kind())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnectError {
    HostKeyChanged { expected: String, got: String },
    AuthRejected,
    KeyMissing,
    AgentNotRunning,
    AgentNoKey,
    Timeout,
    Transport(String),
}

impl ConnectError {
    pub fn sentence(&self) -> String {
        match self {
            ConnectError::HostKeyChanged { .. } => "Host key changed — refused.".into(),
            ConnectError::AuthRejected => "Authentication failed. Check the key or password.".into(),
            ConnectError::KeyMissing => "This machine's key was deleted. Edit the machine and choose another key.".into(),
            ConnectError::AgentNotRunning => {
                "The Windows SSH agent isn't running. Start the OpenSSH Authentication Agent service, or choose a key.".into()
            }
            ConnectError::AgentNoKey => "The SSH agent has no key this host accepts.".into(),
            ConnectError::Timeout => "The host stopped answering.".into(),
            ConnectError::Transport(detail) => format!("Could not connect: {detail}"),
        }
    }

    pub fn retryable(&self) -> bool {
        matches!(self, ConnectError::Transport(_) | ConnectError::Timeout)
    }
}

pub trait Transport: Send + Sync {
    type Conn: Connection;
    fn dial(&self, host: &str, port: u16, timeout: Duration) -> impl Future<Output = Result<Self::Conn, ConnectError>> + Send;
    fn sleep(&self, d: Duration) -> impl Future<Output = ()> + Send;
}

pub trait Connection: Send {
    fn host_key_sha256(&self) -> [u8; 32];
    fn authenticate(&mut self, user: &str, cred: Credential) -> impl Future<Output = Result<(), ConnectError>> + Send;
    fn start_keepalive(&mut self, every: Duration);
    fn exec(&self, command: &str) -> impl Future<Output = Result<String, ConnectError>> + Send;
}

#[derive(Debug, Clone)]
pub struct ConnectRequest {
    pub machine: Machine,
}

fn secret_text(bytes: Zeroizing<Vec<u8>>) -> Option<Zeroizing<String>> {
    std::str::from_utf8(&bytes).ok().map(|s| Zeroizing::new(s.to_owned()))
}

/// Loaded per attempt and dropped (zeroized) with it; never kept in the profile.
pub fn load_credential(machine: &Machine, secrets: &dyn SecretStore) -> Result<Credential, ConnectError> {
    let read = |account: String| secrets.get(&account).map_err(|e| ConnectError::Transport(format!("{e:?}")));
    match &machine.auth {
        Auth::Agent => Ok(Credential::Agent),
        Auth::Key { id } => read(key_account(*id))?.and_then(secret_text).map(Credential::Key).ok_or(ConnectError::KeyMissing),
        Auth::Password => {
            read(password_account(machine.id))?.and_then(secret_text).map(Credential::Password).ok_or(ConnectError::AuthRejected)
        }
    }
}

async fn attempt<T: Transport>(
    t: &T,
    m: &Machine,
    hostkeys: &dyn HostKeyStore,
    secrets: &dyn SecretStore,
) -> Result<T::Conn, ConnectError> {
    let cred = load_credential(m, secrets)?;
    let mut conn = t.dial(&m.host, m.port, CONNECT_TIMEOUT).await?;
    let fingerprint = hex_fingerprint(&conn.host_key_sha256());
    if let HostKeyDecision::Mismatch { expected, got } = verify_host_key(&fingerprint, &m.host, m.port, hostkeys) {
        return Err(ConnectError::HostKeyChanged { expected, got });
    }
    conn.authenticate(&m.user, cred).await?;
    // Set before the handshake, keepalive breaks strict KEX on modern OpenSSH.
    conn.start_keepalive(KEEPALIVE_EVERY);
    Ok(conn)
}

pub async fn connect<T: Transport>(
    t: &T,
    req: &ConnectRequest,
    hostkeys: &dyn HostKeyStore,
    secrets: &dyn SecretStore,
) -> Result<T::Conn, ConnectError> {
    let mut tries = 1;
    loop {
        match attempt(t, &req.machine, hostkeys, secrets).await {
            Err(e) if e.retryable() && tries < TRANSPORT_ATTEMPTS => {
                tries += 1;
                t.sleep(RETRY_DELAY).await;
            }
            result => return result,
        }
    }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test -p tether-core connect`
Expected: PASS (12 tests). If `Machine` in M1 has extra fields, add them to `machine()` in the test with their defaults; do not change the sequence.

- [ ] **Step 6: Run the whole crate, fmt and clippy**

Run: `cargo fmt --all --check && cargo clippy -p tether-core --all-targets -- -D warnings && cargo test -p tether-core`
Expected: no fmt diff, no clippy warnings, every M1 and M2 test passes.

- [ ] **Step 7: Commit**

```bash
git add clients/windows/crates/tether-core/src/connect.rs clients/windows/crates/tether-core/src/lib.rs clients/windows/crates/tether-core/Cargo.toml clients/windows/Cargo.lock
git commit -m "feat(windows): connection sequence with pin-before-auth and bounded retries

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Self-review against the spec

| Spec requirement | Task |
|---|---|
| `zmx ls` parse, attach typed with quoted name, kill `--force` | 1 |
| Strip order by `created`, cwd leaf, first tab rule, `zmx ls` failure → `default` | 2 |
| New-session name, existing name selects | 2 |
| Ctrl+Tab / Ctrl+Shift+Tab wrap, Ctrl+Shift+1…8, Ctrl+Shift+9 last | 2 (strip), 8–9 (keys) |
| Refresh adds/removes, neighbor left-then-right, empty state | 3 |
| 12-attach cap, LRU detach | 3 |
| Kill switches away first; last kill → empty, nothing recreated | 3 |
| Reconnect re-attaches every attached tab, active first | 3 (`reattach_order`) |
| Attention dot for background bell/notification only | 2 (`mark_attention`) |
| OSC 9 / 777 notifications, `9;4` never a toast, progress states, 133;A clears | 4–5 |
| OSC 52 copy, never read | 5 |
| Bell 200 ms per session; toast 5 s per session, replace pending; none for focused active tab | 6 |
| Links: OSC 8 wins, wrapped rows, `│ ┃ ⎿`, only http/https/mailto | 7 |
| Full key table, modifiers, app cursor/keypad, folding, Alt, AltGr, kept keys | 8–9 |
| Paste keys share one path; bracketed paste; CR; image/text/files decision | 8–10 |
| Uploads dir command/marker, absolute path, join, 200 MB copy, folders, image rule | 11 |
| Send queue order, one paste per file, leading space, stop on failure, capsule, 4 s | 12 |
| 150 ms resize settle | 13 |
| 15 s lock grace, unlock re-attaches | 13 |
| Connect: 10 s timeout, pin before auth, mismatch refused, auth, keepalive after auth, 3 × 500 ms retry, sentences | 14 |
| Reconnect backoff 1/2/4 s | 14 (constant; redial triggers are M6) |

Left to other milestones by design: OSC 4/104 palette overrides and OSC 10/11/12 / DA / DSR replies (M4, inside `alacritty_terminal`), Ctrl+click never reported to the program (M6 mouse routing), WIC decode fallback "undecodable image sent unchanged" (M6 — `jpeg_name` only names the target), network/resume redial triggers (M6).

## Deviations

No public name from the roadmap contract or a task's Produces block was renamed. Plan-over-roadmap names stand: `KeyInput::Char.digit`, `ToastThrottle::offer(session, Notification, now)` / `ToastDecision::Pending`, `KillStep`, `CreateOutcome`, `Tab.on_host`.

- `Auth::Unknown` (added in the M1 review) is not in the Task 14 match. `load_credential` returns `ConnectError::AuthRejected` and does not dial. The failure is not retryable.
- `osc.rs` writes the APC/PM/SOS introducers as `*b"P_^X"` so `clippy::byte_char_slices` stays denied. Same four bytes.

