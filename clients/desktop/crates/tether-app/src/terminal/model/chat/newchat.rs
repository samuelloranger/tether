//! The new-chat dialog: a working folder, and in Continue mode the agent's earlier conversations
//! there. Starting runs the host checks first, so a chat never fails later for a missing tool;
//! the same check runs as the dialog opens, so an agent the host can't run is dimmed up front.

use std::collections::HashMap;
use std::time::Duration;

use tether_core::acp::agent::{self, AgentProfile};
use tether_core::acp::folders::{self, Folder};
use tether_core::acp::host::{self, SavedSession};
use tether_core::acp::message::ConfigOption;
use tether_core::acp::options::{OptionsDraft, StartOptions};
use tether_core::acp::session_setup::{self, McpServer};
use tether_core::acp::versions::{self, Kind, ManagedState, Versions};
use tether_core::connect::ConnectError;

use super::{ChatJob, ExecTag, McpLibrary};

const LIST_LIMIT: usize = 20;
const RELOAD_AFTER: Duration = Duration::from_millis(500);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    Check,
    Home,
    ListHome,
    Sessions,
    Folder,
    FolderHome,
    BrowseFolder,
    CreateChild,
    CreateFolder,
    Validate,
    DeleteSession,
    Versions,
    Update,
    LiveOptions,
}

impl Step {
    /// Most commands answer in seconds; an update installs a package, an agent's options start it.
    pub fn deadline(self) -> Option<Duration> {
        let secs = match self {
            Self::Versions => versions::VERSIONS_DEADLINE_SECS,
            Self::Update => versions::UPDATE_DEADLINE_SECS,
            Self::LiveOptions => versions::OPTIONS_DEADLINE_SECS,
            _ => return None,
        };
        Some(Duration::from_secs(secs))
    }
}

/// One line under the agent picker: an update waiting, or what the last Update came to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoticeRow {
    pub kind: Kind,
    pub text: String,
    /// 0 plain, 1 done, 2 failed.
    pub tone: u8,
    pub busy: bool,
    pub update: bool,
    pub dismiss: bool,
    /// An update only the user can run: shown with a Copy button.
    pub copy: String,
}

/// What the dialog says under the agent picker about the host's versions for the picked agent.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct UpdateNotice {
    /// The host's tether predates managed versions.
    pub unsupported: bool,
    /// The adapter row, then the CLI row.
    pub rows: Vec<NoticeRow>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Listing {
    Loading,
    Failed(String),
    Loaded(Vec<SavedSession>),
}

pub enum Next {
    Nothing,
    Job(ChatJob),
    /// `multi`: the host's holders take several clients, so this one names itself.
    Open {
        cwd: String,
        load: Option<String>,
        multi: bool,
        agent: &'static AgentProfile,
        start: StartOptions,
        /// Extra folders, absolute on the host.
        dirs: Vec<String>,
        /// Names of the saved MCP servers to attach.
        mcp: Vec<String>,
    },
    /// The host's answer to whether it manages agent versions changed.
    Support(bool),
    /// The picked agent's options as a session on the host just offered them.
    Options(Vec<ConfigOption>),
}

#[derive(Debug, Clone)]
pub struct NewChat {
    pub mode: u8,
    pub folder: String,
    pub busy: bool,
    pub folder_info: Option<Folder>,
    pub folder_loading: bool,
    pub creating: bool,
    pub browsing: bool,
    pub home: Option<String>,
    edited: bool,
    pub browse_folder: String,
    pub browse_info: Option<Folder>,
    pub filter: String,
    pub new_name: Option<String>,
    browse_request: u64,
    folder_request: u64,
    folder_at: Option<Duration>,
    pub error: Option<String>,
    pub listing: Listing,
    pub continuing: Option<String>,
    /// A saved conversation the user asked to delete, until they confirm or cancel.
    pub delete_asked: Option<String>,
    /// Extra folders as typed (`~` allowed), expanded when the chat starts.
    pub extra_dirs: Vec<String>,
    pub saved_servers: Vec<McpServer>,
    /// Names of the saved servers switched on for this chat.
    pub chosen_servers: Vec<String>,
    /// The Add server form is open.
    pub adding_server: bool,
    pub server_error: Option<String>,
    /// The conversation whose deletion is running on the host.
    pub deleting: Option<String>,
    pub agent: &'static AgentProfile,
    pub options: OptionsDraft,
    request: u64,
    list_request: u64,
    reload_at: Option<Duration>,
    multi: bool,
    /// Agent key → why the host can't run it, from the probe the dialog sends as it opens.
    unavailable: HashMap<&'static str, String>,
    scope: String,
    managed_state: ManagedState,
    versions: Option<Versions>,
    /// The update running.
    updating: Option<(Kind, &'static str)>,
    update_outcome: Option<(Kind, &'static str, Result<String, String>)>,
    versions_request: u64,
    update_request: u64,
    live_request: u64,
    /// Options are to be read once the folder is ready.
    live_pending: bool,
}

pub fn probe_job() -> ChatJob {
    ChatJob::Exec {
        tag: ExecTag::AgentProbe,
        command: host::host_check_command(),
    }
}

fn next_request() -> u64 {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

fn exec(request: u64, step: Step, command: String) -> ChatJob {
    ChatJob::Exec {
        tag: ExecTag::NewChat { request, step },
        command,
    }
}

fn exec_failure(error: &ConnectError) -> String {
    match error {
        ConnectError::Timeout => "The host took too long to answer.".into(),
        other => format!("Couldn't reach the host: {}", other.sentence()),
    }
}

impl NewChat {
    pub fn open(
        mode: u8,
        folder: String,
        agent: &'static AgentProfile,
        options: OptionsDraft,
    ) -> Self {
        let generation = next_request();
        Self {
            mode,
            folder,
            busy: false,
            folder_info: None,
            folder_loading: true,
            creating: false,
            browsing: false,
            home: None,
            edited: false,
            browse_folder: String::new(),
            browse_info: None,
            filter: String::new(),
            new_name: None,
            browse_request: generation,
            folder_request: generation,
            folder_at: Some(Duration::ZERO),
            error: None,
            listing: Listing::Loading,
            continuing: None,
            delete_asked: None,
            extra_dirs: Vec::new(),
            saved_servers: Vec::new(),
            chosen_servers: Vec::new(),
            adding_server: false,
            server_error: None,
            deleting: None,
            agent,
            options,
            request: generation,
            list_request: generation,
            reload_at: None,
            multi: false,
            unavailable: HashMap::new(),
            scope: String::new(),
            managed_state: ManagedState::default(),
            versions: None,
            updating: None,
            update_outcome: None,
            versions_request: generation,
            update_request: generation,
            live_request: generation,
            live_pending: false,
        }
    }

    pub fn set_managed(&mut self, scope: &str, state: ManagedState) {
        self.scope = scope.to_string();
        self.managed_state = state;
    }

    /// The host manages versions: chats spawn `tether acp agent …`.
    pub fn managed(&self) -> bool {
        self.managed_state.supported(&self.scope) == Some(true)
    }

    pub fn versions_job(&mut self) -> ChatJob {
        self.versions_request = next_request();
        ChatJob::Exec {
            tag: ExecTag::Versions {
                request: self.versions_request,
            },
            command: versions::versions_command(),
        }
    }

    fn picked_version(&self, kind: Kind) -> Option<&versions::AgentVersion> {
        self.versions.as_ref()?.get(kind, self.agent.key)
    }

    fn notice_row(&self, kind: Kind) -> Option<NoticeRow> {
        let key = self.agent.key;
        let outcome = self
            .update_outcome
            .as_ref()
            .filter(|(k, a, _)| *k == kind && *a == key)
            .map(|(_, _, r)| r);
        let row = |text: String, tone: u8| NoticeRow {
            kind,
            text,
            tone,
            busy: false,
            update: false,
            dismiss: false,
            copy: String::new(),
        };
        if let Some(Ok(done)) = outcome {
            return Some(row(done.clone(), 1));
        }
        let v = self.picked_version(kind).filter(|v| v.update_available)?;
        let busy = self.updating == Some((kind, key));
        if !busy
            && self
                .managed_state
                .is_dismissed(&self.scope, kind, key, &v.latest)
        {
            return None;
        }
        let (text, tone) = match outcome {
            Some(Err(e)) => (e.clone(), 2),
            _ => (versions::update_line(self.agent, v), 0),
        };
        let runnable = kind == Kind::Adapter || v.runnable;
        Some(NoticeRow {
            busy,
            update: runnable,
            dismiss: !busy,
            copy: if runnable {
                String::new()
            } else {
                v.command.clone()
            },
            ..row(text, tone)
        })
    }

    pub fn notice(&self) -> UpdateNotice {
        UpdateNotice {
            unsupported: self.agent.host_managed()
                && self.managed_state.supported(&self.scope) == Some(false),
            rows: [Kind::Adapter, Kind::Cli]
                .into_iter()
                .filter(|k| *k == Kind::Cli || self.agent.host_managed())
                .filter_map(|k| self.notice_row(k))
                .collect(),
        }
    }

    /// The Update click; nothing else ever starts an update.
    pub fn start_update(&mut self, kind: Kind) -> Option<ChatJob> {
        let agent = self.agent;
        let runnable = self
            .picked_version(kind)
            .is_some_and(|v| v.update_available && (kind == Kind::Adapter || v.runnable));
        if self.updating.is_some() || !self.managed() || !runnable {
            return None;
        }
        self.updating = Some((kind, agent.key));
        self.update_outcome = None;
        self.update_request = next_request();
        Some(exec(
            self.update_request,
            Step::Update,
            versions::update_command(agent, kind),
        ))
    }

    /// Not now: the kind, agent and version dismissed, to be stored.
    pub fn dismiss_update(&mut self, kind: Kind) -> Option<(Kind, String, String)> {
        let latest = self
            .picked_version(kind)
            .filter(|v| v.update_available)?
            .latest
            .clone();
        self.managed_state
            .dismiss(&self.scope, kind, self.agent.key, &latest);
        Some((kind, self.agent.key.to_string(), latest))
    }

    fn live_ready(&self) -> bool {
        self.managed()
            && !self.browsing
            && !self.creating
            && !self.folder_loading
            && self.folder_info.as_ref().is_some_and(Folder::ready)
    }

    #[cfg(debug_assertions)]
    pub fn preview_folder(&mut self, state: &str) {
        let missing = state == "missing";
        self.folder = "/home/dev/projects/api-server".into();
        self.home = Some("/home/dev".into());
        self.browsing = state == "browse";
        self.browse_folder = self.folder.clone();
        self.folder_at = None;
        self.folder_loading = false;
        self.folder_info = Some(Folder {
            status: if missing { "missing" } else { "ready" }.into(),
            path: self.folder.clone(),
            children: ["Sources", "Tests", "docs", "scripts"]
                .iter()
                .map(|name| format!("{}/{name}", self.folder))
                .collect(),
        });
        self.browse_info = self.folder_info.clone();
    }

    /// Debug builds: `available` shows a waiting Codex adapter update, `done` the line after a
    /// successful one, `unsupported` a host whose tether is too old.
    #[cfg(debug_assertions)]
    pub fn preview_update(&mut self, kind: &str) {
        self.scope = "dev:22".into();
        let entry =
            |agent: &str, version: &str, engine: &str, latest: &str| versions::AgentVersion {
                kind: Kind::Adapter,
                agent: agent.into(),
                version: version.into(),
                engine: engine.into(),
                latest: latest.into(),
                update_available: version != latest,
                ..Default::default()
            };
        let done = kind == "done";
        self.managed_state
            .set_supported(&self.scope, kind != "unsupported");
        self.versions = Some(Versions {
            supported: Some(true),
            agents: vec![
                entry("claude", "0.95.0", "Claude Code 2.1.309", "0.95.0"),
                if done {
                    entry("codex", "2.8.0", "Codex 0.170.0", "2.8.0")
                } else {
                    entry("codex", "2.3.0", "Codex 0.164.0", "2.8.0")
                },
                versions::AgentVersion {
                    kind: Kind::Cli,
                    agent: "codex".into(),
                    version: "0.164.0".into(),
                    latest: "0.170.0".into(),
                    update_available: true,
                    command: "npm install -g @openai/codex@latest".into(),
                    runnable: false,
                    ..Default::default()
                },
            ],
        });
        if done {
            self.update_outcome = Some((Kind::Adapter, "codex", Ok("Updated to 2.8.0".into())));
        }
    }

    /// Debug builds: `extras` and `form` show an extra folder and a saved server switched on (`form`
    /// also opens the Add server form), `continue` the saved conversations, `continue-delete` with the
    /// delete confirmation open.
    #[cfg(debug_assertions)]
    pub fn preview_setup(&mut self, kind: &str) {
        let server = |name: &str, url: &str| McpServer {
            name: name.into(),
            url: url.into(),
            headers: Vec::new(),
        };
        self.saved_servers = vec![
            server("docs", "https://mcp.example.com/docs"),
            server("tracker", "https://mcp.example.com/tracker"),
        ];
        match kind {
            "extras" | "form" => {
                self.extra_dirs =
                    vec!["~/shared/design-system".into(), "/srv/data/fixtures".into()];
                self.chosen_servers = vec!["docs".into()];
                self.adding_server = kind == "form";
            }
            _ => {
                self.mode = 1;
                let saved = |id: &str, title: &str, ago: i64| SavedSession {
                    session_id: id.into(),
                    title: title.into(),
                    updated_at: Some(
                        std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map_or(0, |d| d.as_secs() as i64)
                            - ago,
                    ),
                    cwd: "/home/dev/projects/api-server".into(),
                };
                let list = vec![
                    saved("a", "Fix the pagination bug in the orders endpoint", 7200),
                    saved("b", "Move the job queue to a worker pool", 86_400 * 2),
                    saved("c", "Review the migration plan", 86_400 * 9),
                ];
                self.listing = Listing::Loaded(list);
                if kind == "continue-delete" {
                    self.delete_asked = Some("b".into());
                }
            }
        }
    }

    pub fn display_path(&self, path: &str) -> String {
        if let Some(home) = &self.home {
            if path == home {
                return "~".into();
            }
            if let Some(tail) = path.strip_prefix(&format!("{home}/")) {
                return format!("~/{tail}");
            }
        }
        path.into()
    }

    pub fn active_info(&self) -> Option<&Folder> {
        if self.browsing {
            self.browse_info.as_ref()
        } else {
            self.folder_info.as_ref()
        }
    }

    pub fn visible_children(&self) -> Vec<String> {
        let filter = self.filter.to_lowercase();
        self.active_info().map_or_else(Vec::new, |f| {
            f.children
                .iter()
                .filter(|p| {
                    p.rsplit('/')
                        .next()
                        .unwrap_or(p)
                        .to_lowercase()
                        .contains(&filter)
                })
                .cloned()
                .collect()
        })
    }

    /// Each breadcrumb as (label, absolute path); the home folder collapses to `~`.
    pub fn crumbs(&self) -> Vec<(String, String)> {
        let path = self.browse_folder.as_str();
        let (mut out, mut acc, rest) = match &self.home {
            Some(h) if path == h || path.starts_with(&format!("{h}/")) => (
                vec![("~".to_string(), h.clone())],
                h.clone(),
                &path[h.len()..],
            ),
            _ => (
                vec![("/".to_string(), "/".to_string())],
                String::new(),
                path,
            ),
        };
        for seg in rest.split('/').filter(|s| !s.is_empty()) {
            acc.push('/');
            acc.push_str(seg);
            out.push((seg.to_string(), acc.clone()));
        }
        out
    }

    pub fn navigate(&mut self, path: String) -> Option<ChatJob> {
        if !self.browsing || self.creating || self.new_name.is_some() || self.folder_loading {
            return None;
        }
        let info = self.browse_info.as_ref()?;
        let ancestor = path == "/"
            || info
                .path
                .starts_with(&format!("{}/", path.trim_end_matches('/')));
        if !ancestor && !info.children.contains(&path) {
            return None;
        }
        self.browse_folder = path;
        self.filter.clear();
        self.load_browser()
    }

    fn load_browser(&mut self) -> Option<ChatJob> {
        self.browse_request = next_request();
        self.folder_loading = true;
        self.error = None;
        Some(exec(
            self.browse_request,
            Step::BrowseFolder,
            folders::command(&self.browse_folder, false),
        ))
    }

    pub fn choose_folder(&mut self, now: Duration) {
        if !self.browsing || self.folder_loading || self.creating || self.new_name.is_some() {
            return;
        }
        if let Some(info) = self.browse_info.as_ref().filter(|f| f.ready()) {
            let path = self.display_path(&info.path);
            self.browsing = false;
            self.set_folder(path, now);
        }
    }

    pub fn back(&mut self) {
        if self.creating {
            return;
        }
        if self.new_name.take().is_some() {
            self.error = None;
            return;
        }
        self.browsing = false;
        self.browse_request = next_request();
        self.folder_loading = false;
        self.error = None;
    }

    pub fn set_new_name(&mut self, name: Option<String>) {
        if self.browsing && !self.creating && !self.folder_loading {
            self.new_name = name;
            self.error = None;
        }
    }

    pub fn create_child(&mut self) -> Option<ChatJob> {
        if !self.browsing || self.creating || self.folder_loading {
            return None;
        }
        let name = self.new_name.as_ref()?.trim();
        if name.is_empty()
            || matches!(name, "." | "..")
            || name.contains('/')
            || name.contains('\0')
        {
            self.error = Some("Enter a folder name without /, other than . or ...".into());
            return None;
        }
        let parent = self.browse_info.as_ref().filter(|f| f.ready())?;
        let path = format!("{}/{}", parent.path.trim_end_matches('/'), name);
        self.creating = true;
        self.browse_request = next_request();
        self.error = None;
        Some(exec(
            self.browse_request,
            Step::CreateChild,
            folders::command(&path, true),
        ))
    }

    pub fn unavailable(&self, agent: &AgentProfile) -> Option<&str> {
        self.unavailable.get(agent.key).map(String::as_str)
    }

    /// A host that could not be checked dims nothing; Start checks again either way.
    pub fn on_probe(&mut self, output: &str, host_name: &str) {
        self.unavailable = agent::ALL
            .iter()
            .filter_map(|a| host::agent_unavailable(output, a, host_name).map(|m| (a.key, m)))
            .collect();
    }

    /// The last failure, else why the picked agent can't run here; derived so a mode change keeps it.
    pub fn shown_error(&self) -> Option<&str> {
        self.error
            .as_deref()
            .or_else(|| self.unavailable(self.agent))
    }

    pub fn set_mode(&mut self, mode: u8, now: Duration) -> Option<ChatJob> {
        self.mode = mode;
        self.error = None;
        self.reload(now)
    }

    /// Another agent lists other conversations and has its own options.
    pub fn set_agent(
        &mut self,
        agent: &'static AgentProfile,
        options: OptionsDraft,
        now: Duration,
    ) -> Option<ChatJob> {
        if self.agent == agent || self.busy || self.continuing.is_some() {
            return None;
        }
        if let Some(reason) = self.unavailable(agent) {
            self.error = Some(reason.to_string());
            return None;
        }
        self.agent = agent;
        self.options = options;
        self.error = None;
        self.live_request = next_request();
        self.live_pending = true;
        self.reload(now)
    }

    pub fn set_folder(&mut self, folder: String, now: Duration) {
        if self.busy || self.continuing.is_some() || self.creating || self.browsing {
            return;
        }
        self.folder = folder;
        self.edited = true;
        self.error = None;
        self.folder_info = None;
        self.folder_loading = true;
        self.folder_request = next_request();
        self.folder_at = Some(now + RELOAD_AFTER);
        self.live_request = next_request();
        self.live_pending = false;
        if self.mode == 1 {
            self.list_request = next_request();
            self.listing = Listing::Loading;
            self.reload_at = Some(now + RELOAD_AFTER);
        }
    }

    pub fn tick(&mut self, now: Duration) -> Option<ChatJob> {
        if !self.busy && !self.creating && self.folder_at.is_some_and(|at| now >= at) {
            self.folder_at = None;
            if self.home.is_none() {
                return Some(exec(
                    self.folder_request,
                    Step::FolderHome,
                    host::HOME.to_string(),
                ));
            }
            return Some(exec(
                self.folder_request,
                Step::Folder,
                folders::command(&self.folder, false),
            ));
        }
        if self.live_pending && self.live_ready() {
            self.live_pending = false;
            self.live_request = next_request();
            let cwd = self.folder_info.as_ref().map(|f| f.path.clone())?;
            return Some(exec(
                self.live_request,
                Step::LiveOptions,
                versions::options_command(&cwd, self.agent, true),
            ));
        }
        let due = self.reload_at.is_some_and(|at| now >= at);
        if !due {
            return None;
        }
        self.reload_at = None;
        self.reload(now)
    }

    pub fn reload(&mut self, _now: Duration) -> Option<ChatJob> {
        if self.mode != 1 {
            return None;
        }
        self.reload_at = None;
        self.listing = Listing::Loading;
        self.list_request = next_request();
        if host::needs_home(&self.folder) {
            return Some(exec(
                self.list_request,
                Step::ListHome,
                host::HOME.to_string(),
            ));
        }
        Some(self.sessions_job(&host::expand_cwd(&self.folder, "")))
    }

    fn sessions_job(&self, cwd: &str) -> ChatJob {
        exec(
            self.list_request,
            Step::Sessions,
            format!(
                "{} || true",
                host::sessions_command(cwd, LIST_LIMIT, self.agent, self.managed())
            ),
        )
    }

    /// `~` and absolute paths only; a duplicate is ignored. False says nothing was added.
    pub fn add_folder(&mut self, text: &str) -> bool {
        let path = text.trim();
        if path.is_empty() {
            return false;
        }
        if !(path.starts_with('/') || path == "~" || path.starts_with("~/")) {
            self.error = Some("An extra folder is an absolute path, or starts with ~.".into());
            return false;
        }
        self.error = None;
        if !self.extra_dirs.iter().any(|d| d == path) {
            self.extra_dirs.push(path.to_string());
        }
        true
    }

    pub fn remove_folder(&mut self, index: usize) {
        if index < self.extra_dirs.len() {
            self.extra_dirs.remove(index);
        }
    }

    fn expanded_dirs(&self) -> Vec<String> {
        let home = self.home.as_deref().unwrap_or("");
        self.extra_dirs
            .iter()
            .map(|d| host::expand_cwd(d, home))
            .collect()
    }

    fn extras_need_home(&self) -> bool {
        self.home.is_none() && self.extra_dirs.iter().any(|d| host::needs_home(d))
    }

    pub fn toggle_server(&mut self, name: &str) {
        if let Some(i) = self.chosen_servers.iter().position(|n| n == name) {
            self.chosen_servers.remove(i);
        } else if self.saved_servers.iter().any(|s| s.name == name) {
            self.chosen_servers.push(name.to_string());
        }
    }

    pub fn set_adding_server(&mut self, adding: bool) {
        self.adding_server = adding;
        self.server_error = None;
    }

    /// Saves a new server to the machine's list (the secret store) and leaves it switched off.
    pub fn save_server(
        &mut self,
        name: &str,
        url: &str,
        headers: &str,
        library: Option<&McpLibrary>,
    ) -> bool {
        let result = (|| {
            let headers = session_setup::parse_header_lines(headers)?;
            let server = McpServer {
                name: name.trim().to_string(),
                url: url.trim().to_string(),
                headers,
            };
            server.validate(&self.saved_servers).map_err(String::from)?;
            let library = library.ok_or("Secret storage is unavailable.")?;
            let mut list = self.saved_servers.clone();
            list.push(server);
            library.save(&list)?;
            Ok(list)
        })();
        match result {
            Ok(list) => {
                self.saved_servers = list;
                self.adding_server = false;
                self.server_error = None;
                true
            }
            Err(message) => {
                self.server_error = Some(message);
                false
            }
        }
    }

    pub fn delete_server(&mut self, name: &str, library: Option<&McpLibrary>) {
        let list: Vec<McpServer> = self
            .saved_servers
            .iter()
            .filter(|s| s.name != name)
            .cloned()
            .collect();
        match library.map(|l| l.save(&list)) {
            Some(Ok(())) => {
                self.saved_servers = list;
                self.chosen_servers.retain(|n| n != name);
            }
            Some(Err(message)) => self.server_error = Some(message),
            None => self.server_error = Some("Secret storage is unavailable.".into()),
        }
    }

    pub fn ask_delete(&mut self, id: String) {
        if self.continuing.is_none() && self.deleting.is_none() && self.saved(&id).is_some() {
            self.delete_asked = Some(id);
            self.error = None;
        }
    }

    pub fn cancel_delete(&mut self) {
        self.delete_asked = None;
    }

    fn saved(&self, id: &str) -> Option<&SavedSession> {
        match &self.listing {
            Listing::Loaded(list) => list.iter().find(|s| s.session_id == id),
            _ => None,
        }
    }

    /// Runs the delete on the host; the row goes once the host confirms it.
    pub fn confirm_delete(&mut self) -> Option<ChatJob> {
        let id = self.delete_asked.take()?;
        if self.deleting.is_some() {
            return None;
        }
        let cwd = self
            .saved(&id)
            .map(|s| s.cwd.clone())
            .filter(|c| !c.is_empty())
            .unwrap_or_else(|| host::expand_cwd(&self.folder, self.home.as_deref().unwrap_or("")));
        let command = format!(
            "{} || true",
            host::delete_session_command(&cwd, &id, self.agent, self.managed())
        );
        self.deleting = Some(id);
        self.error = None;
        self.request = next_request();
        Some(exec(self.request, Step::DeleteSession, command))
    }

    pub fn browse(&mut self, _now: Duration) -> Option<ChatJob> {
        if self.busy || self.continuing.is_some() || self.creating || self.folder_loading {
            return None;
        }
        self.browsing = true;
        self.filter.clear();
        self.new_name = None;
        self.browse_folder = self.folder_info.as_ref().map_or_else(
            || self.folder.clone(),
            |f| {
                if f.ready() {
                    f.path.clone()
                } else {
                    f.parent()
                }
            },
        );
        self.load_browser()
    }

    pub fn create_folder(&mut self) -> Option<ChatJob> {
        if self.busy
            || self.creating
            || self.continuing.is_some()
            || !self.folder_info.as_ref().is_some_and(Folder::missing)
        {
            return None;
        }
        self.error = None;
        self.creating = true;
        self.folder_request = next_request();
        self.folder_at = None;
        Some(exec(
            self.folder_request,
            Step::CreateFolder,
            folders::command(&self.folder, true),
        ))
    }

    fn validate(&self, cwd: &str) -> Next {
        Next::Job(exec(
            self.request,
            Step::Validate,
            folders::command(cwd, false),
        ))
    }

    /// `load` continues that earlier conversation instead of starting one.
    pub fn start(&mut self, load: Option<String>) -> Option<ChatJob> {
        if self.busy
            || self.creating
            || self.continuing.is_some()
            || self.browsing
            || self.deleting.is_some()
        {
            return None;
        }
        self.folder_request = next_request();
        self.folder_at = None;
        self.busy = load.is_none();
        self.continuing = load;
        self.error = None;
        self.request = next_request();
        Some(exec(self.request, Step::Check, host::host_check_command()))
    }

    fn open_next(&self, cwd: String) -> Next {
        Next::Open {
            cwd,
            load: self.continuing.clone(),
            multi: self.multi,
            agent: self.agent,
            start: self.options.start_options(),
            dirs: self.expanded_dirs(),
            mcp: self.chosen_servers.clone(),
        }
    }

    fn stop(&mut self, error: String) -> Next {
        self.busy = false;
        self.continuing = None;
        // start() dropped any folder check still in flight; without a new one the form stays on "Checking folder…".
        if self.folder_loading && self.folder_at.is_none() {
            self.recheck(Duration::ZERO);
        }
        self.error = Some(error);
        Next::Nothing
    }

    /// Checks the same folder again, e.g. after a timeout, without touching what the user typed.
    pub fn recheck(&mut self, now: Duration) {
        if self.busy || self.continuing.is_some() || self.creating || self.browsing {
            return;
        }
        self.error = None;
        self.folder_info = None;
        self.folder_loading = true;
        self.folder_request = next_request();
        self.folder_at = Some(now);
    }

    pub fn on_exec(
        &mut self,
        request: u64,
        step: Step,
        result: Result<String, ConnectError>,
        host_name: &str,
    ) -> Next {
        match step {
            Step::Check | Step::Home | Step::Validate | Step::DeleteSession
                if request != self.request =>
            {
                Next::Nothing
            }
            Step::ListHome | Step::Sessions if request != self.list_request => Next::Nothing,
            Step::Versions if request != self.versions_request => Next::Nothing,
            Step::Update if request != self.update_request => Next::Nothing,
            Step::LiveOptions if request != self.live_request => Next::Nothing,
            Step::Folder | Step::FolderHome | Step::CreateFolder
                if request != self.folder_request =>
            {
                Next::Nothing
            }
            Step::BrowseFolder | Step::CreateChild
                if request != self.browse_request || !self.browsing =>
            {
                Next::Nothing
            }
            Step::FolderHome => {
                self.home = result
                    .ok()
                    .map(|h| h.trim().trim_end_matches('/').to_string())
                    .filter(|h| h.starts_with('/'));
                if !self.edited {
                    self.folder = self.display_path(&self.folder);
                }
                Next::Job(exec(
                    self.folder_request,
                    Step::Folder,
                    folders::command(&self.folder, false),
                ))
            }
            Step::BrowseFolder | Step::CreateChild => {
                self.folder_loading = false;
                self.creating = false;
                let info = result.as_deref().map(Folder::parse).unwrap_or_default();
                if step == Step::CreateChild && !info.ready() {
                    self.error = Some(info.message().into());
                } else {
                    if step == Step::CreateChild {
                        self.new_name = None;
                        self.filter.clear();
                    }
                    if !info.path.is_empty() {
                        self.browse_folder = info.path.clone();
                    }
                    self.browse_info = Some(info);
                }
                Next::Nothing
            }
            Step::Folder | Step::CreateFolder => {
                self.folder_loading = false;
                self.creating = false;
                self.folder_info = Some(result.as_deref().map(Folder::parse).unwrap_or_default());
                self.live_pending = self.folder_info.as_ref().is_some_and(Folder::ready);
                Next::Nothing
            }
            Step::Versions => {
                let Ok(output) = result else {
                    return Next::Nothing;
                };
                let read = versions::parse_versions(&output);
                let supported = read.supported;
                if !read.agents.is_empty() {
                    self.versions = Some(read);
                }
                match supported {
                    Some(supported) if self.managed_state.set_supported(&self.scope, supported) => {
                        self.live_pending = supported;
                        Next::Support(supported)
                    }
                    _ => Next::Nothing,
                }
            }
            Step::Update => {
                let Some((kind, key)) = self.updating.take() else {
                    return Next::Nothing;
                };
                let outcome = match result {
                    Ok(output) => versions::parse_update(&output).map(|u| u.sentence()),
                    Err(e) => Err(exec_failure(&e)),
                };
                let done = outcome.is_ok();
                self.update_outcome = Some((kind, key, outcome));
                if !done {
                    return Next::Nothing;
                }
                self.live_request = next_request();
                self.live_pending = true;
                Next::Job(self.versions_job())
            }
            Step::LiveOptions => match result.ok().and_then(|o| versions::parse_options(&o)) {
                Some(options) => Next::Options(options),
                None => Next::Nothing,
            },
            Step::Validate => {
                self.folder_loading = false;
                let info = result.as_deref().map(Folder::parse).unwrap_or_default();
                if info.ready() {
                    self.open_next(info.path)
                } else {
                    let message = info.message().to_string();
                    self.folder_info = Some(info);
                    self.stop(message)
                }
            }
            // A host that cannot be checked is left to the chat's own dial to report.
            Step::Check => {
                if let Ok(output) = &result
                    && let Some(message) = host::host_problem_message(
                        &host::host_problems_for(output, self.agent),
                        host_name,
                    )
                {
                    return self.stop(message);
                }
                self.multi = result.as_ref().is_ok_and(|o| host::host_multi_client(o));
                if host::needs_home(&self.folder) || self.extras_need_home() {
                    return Next::Job(exec(self.request, Step::Home, host::HOME.to_string()));
                }
                self.validate(&host::expand_cwd(&self.folder, ""))
            }
            Step::Home => match result {
                Ok(home) if home.trim().starts_with('/') => {
                    if self.home.is_none() {
                        self.home = Some(home.trim().trim_end_matches('/').to_string());
                    }
                    self.validate(&host::expand_cwd(&self.folder, home.trim()))
                }
                _ => self.stop("Couldn't read the host's home folder.".into()),
            },
            Step::ListHome => match result {
                Ok(home) if home.trim().starts_with('/') => {
                    Next::Job(self.sessions_job(&host::expand_cwd(&self.folder, home.trim())))
                }
                Ok(_) => {
                    self.listing = Listing::Failed("Couldn't read the host's home folder.".into());
                    Next::Nothing
                }
                Err(e) => {
                    self.listing = Listing::Failed(exec_failure(&e));
                    Next::Nothing
                }
            },
            Step::DeleteSession => {
                let Some(id) = self.deleting.take() else {
                    return Next::Nothing;
                };
                let outcome = match result {
                    Ok(output) => host::parse_delete_session(&output, &id),
                    Err(e) => Err(exec_failure(&e)),
                };
                match outcome {
                    Ok(()) => {
                        if let Listing::Loaded(list) = &mut self.listing {
                            list.retain(|s| s.session_id != id);
                        }
                    }
                    Err(message) => self.error = Some(message),
                }
                Next::Nothing
            }
            Step::Sessions => {
                self.listing = match result {
                    Ok(output) => {
                        let parsed = host::parse_saved_sessions(&output);
                        match parsed.failure {
                            Some(failure) => Listing::Failed(failure),
                            None => Listing::Loaded(parsed.sessions),
                        }
                    }
                    Err(e) => Listing::Failed(exec_failure(&e)),
                };
                Next::Nothing
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tether_core::acp::versions::{Kind, ManagedState};
    use tether_core::acp::{agent::CLAUDE, defaults::ChatDefaults};

    fn dialog(path: &str) -> NewChat {
        let mut nc = NewChat::open(
            0,
            path.into(),
            &CLAUDE,
            OptionsDraft::new(&CLAUDE, &ChatDefaults::default(), &[]),
        );
        nc.home = Some("/home/dev".into());
        nc
    }

    fn reply(nc: &mut NewChat, job: ChatJob, output: &str) -> Next {
        let (request, step) = match job {
            ChatJob::Exec {
                tag: ExecTag::NewChat { request, step },
                ..
            } => (request, step),
            ChatJob::Exec {
                tag: ExecTag::Versions { request },
                ..
            } => (request, Step::Versions),
            _ => panic!("expected exec"),
        };
        nc.on_exec(request, step, Ok(output.into()), "host")
    }

    const READY: &str = "__TETHER_FOLDER__\0ready\0/proj\0";
    const ADAPTER: &str = r#"{"kind":"adapter","agent":"codex","version":"2.3.0","engine":"Codex 0.164.0","latest":"2.8.0","updateAvailable":true}"#;
    const CLI: &str = r#"{"kind":"cli","agent":"codex","version":"0.164.0","latest":"0.170.0","updateAvailable":true,"command":"npm install -g @openai/codex@latest","runnable":false}"#;

    fn codex_dialog() -> NewChat {
        let mut nc = dialog("/proj");
        nc.set_managed("h:22", ManagedState::default());
        nc.agent = &agent::CODEX;
        nc
    }

    fn read_versions(nc: &mut NewChat, output: &str) -> Next {
        let job = nc.versions_job();
        reply(nc, job, output)
    }

    fn folder_ready(nc: &mut NewChat) {
        let job = nc.tick(Duration::ZERO).unwrap();
        reply(nc, job, READY);
    }

    fn command(job: &ChatJob) -> &str {
        match job {
            ChatJob::Exec { command, .. } => command,
            _ => panic!("expected exec"),
        }
    }

    #[test]
    fn a_versions_read_sets_support_and_chats_then_spawn_the_managed_agent() {
        let mut nc = codex_dialog();
        assert!(!nc.managed());
        assert!(command(&nc.sessions_job("/x")).contains("npx -y @agentclientprotocol/codex-acp"));
        assert!(matches!(
            read_versions(&mut nc, ADAPTER),
            Next::Support(true)
        ));
        assert!(nc.managed());
        assert!(command(&nc.sessions_job("/x")).contains("--agent-cmd 'tether acp agent codex'"));
        // Unchanged support is not reported again.
        assert!(matches!(read_versions(&mut nc, ADAPTER), Next::Nothing));
    }

    #[test]
    fn an_old_host_shows_the_update_tether_line_and_keeps_the_pinned_spawn() {
        let mut nc = codex_dialog();
        assert!(matches!(
            read_versions(&mut nc, "unknown acp command \"versions\"\n"),
            Next::Support(false)
        ));
        assert!(!nc.managed());
        assert!(nc.notice().unsupported);
        assert!(nc.notice().rows.is_empty());
        assert!(command(&nc.sessions_job("/x")).contains("codex-acp@"));
        nc.agent = &agent::OPENCODE;
        assert!(!nc.notice().unsupported);
    }

    #[test]
    fn a_failed_read_changes_nothing() {
        let mut nc = codex_dialog();
        read_versions(&mut nc, ADAPTER);
        assert!(matches!(read_versions(&mut nc, ""), Next::Nothing));
        assert!(nc.managed());
        assert_eq!(nc.notice().rows.len(), 1);
    }

    #[test]
    fn the_notice_lists_the_adapter_then_the_cli_and_dismissal_is_per_version() {
        let mut nc = codex_dialog();
        read_versions(&mut nc, &format!("{ADAPTER}\n{CLI}\n"));
        let rows = nc.notice().rows;
        assert_eq!(rows.len(), 2);
        assert_eq!(
            rows[0].text,
            "Codex adapter 2.8.0 available \u{b7} you have 2.3.0 (Codex 0.164.0)"
        );
        assert!(rows[0].update && rows[0].dismiss && rows[0].copy.is_empty());
        assert_eq!(
            rows[1].text,
            "Codex CLI 0.170.0 available \u{b7} you have 0.164.0"
        );
        assert!(!rows[1].update, "a CLI the host can't run has no Update");
        assert_eq!(rows[1].copy, "npm install -g @openai/codex@latest");
        assert!(nc.start_update(Kind::Cli).is_none());

        let dismissed = nc.dismiss_update(Kind::Adapter).unwrap();
        assert_eq!(dismissed, (Kind::Adapter, "codex".into(), "2.8.0".into()));
        assert_eq!(nc.notice().rows.len(), 1);
        let newer = ADAPTER.replace("2.8.0", "2.9.0");
        read_versions(&mut nc, &format!("{newer}\n{CLI}\n"));
        assert_eq!(nc.notice().rows.len(), 2);
        // Another agent has none of these.
        nc.agent = &agent::CLAUDE;
        assert!(nc.notice().rows.is_empty());
    }

    #[test]
    fn nothing_updates_without_the_click_and_the_click_runs_one_update() {
        let mut nc = codex_dialog();
        assert!(
            nc.start_update(Kind::Adapter).is_none(),
            "nothing is known yet"
        );
        read_versions(&mut nc, ADAPTER);
        let job = nc.start_update(Kind::Adapter).expect("update");
        assert!(command(&job).contains(" update codex 2>&1"));
        assert!(nc.start_update(Kind::Adapter).is_none());
        assert!(nc.notice().rows[0].busy);
        assert!(!nc.notice().rows[0].dismiss);

        let Next::Job(reread) = reply(
            &mut nc,
            job,
            "{\"agent\":\"codex\",\"from\":\"2.3.0\",\"to\":\"2.8.0\"}\n",
        ) else {
            panic!("a successful update reads the versions again")
        };
        assert_eq!(command(&reread), versions::versions_command());
        let row = nc.notice().rows.remove(0);
        assert_eq!((row.text.as_str(), row.tone), ("Updated to 2.8.0", 1));
        assert!(!row.update);
        let fresh = ADAPTER
            .replace("\"2.3.0\"", "\"2.8.0\"")
            .replace("true", "false");
        reply(&mut nc, reread, &fresh);
        assert_eq!(nc.notice().rows[0].text, "Updated to 2.8.0");
    }

    #[test]
    fn a_failed_update_shows_the_hosts_words_and_can_be_tried_again() {
        let mut nc = codex_dialog();
        read_versions(&mut nc, ADAPTER);
        let job = nc.start_update(Kind::Adapter).unwrap();
        assert!(matches!(
            reply(&mut nc, job, "tether: npm install failed\n"),
            Next::Nothing
        ));
        let row = nc.notice().rows.remove(0);
        assert_eq!((row.text.as_str(), row.tone), ("npm install failed", 2));
        assert!(row.update, "the retry stays");
        assert!(nc.start_update(Kind::Adapter).is_some());
    }

    #[test]
    fn options_are_read_once_the_folder_is_ready_on_a_managed_host() {
        let mut nc = dialog("/proj");
        nc.set_managed("h:22", ManagedState::default());
        folder_ready(&mut nc);
        assert!(
            nc.tick(Duration::ZERO).is_none(),
            "an unmanaged host reads nothing"
        );
        read_versions(&mut nc, ADAPTER);
        let job = nc.tick(Duration::ZERO).expect("options job");
        assert!(command(&job).contains("options '/proj' --agent-cmd 'tether acp agent claude'"));
        assert!(nc.tick(Duration::ZERO).is_none(), "one read per change");
        let line = r#"{"configOptions":[{"id":"model","name":"Model","type":"select","currentValue":"a","options":[{"value":"a","name":"A"}]}]}"#;
        let Next::Options(options) = reply(&mut nc, job, line) else {
            panic!("options")
        };
        assert_eq!(options[0].id, "model");
    }

    #[test]
    fn a_stale_options_answer_is_dropped_and_a_failure_keeps_the_cache() {
        let mut nc = dialog("/proj");
        nc.set_managed("h:22", ManagedState::default());
        read_versions(&mut nc, ADAPTER);
        folder_ready(&mut nc);
        let old = nc.tick(Duration::ZERO).unwrap();
        nc.set_folder("/other".into(), Duration::ZERO);
        let line = r#"{"configOptions":[]}"#;
        assert!(matches!(reply(&mut nc, old, line), Next::Nothing));

        let job = nc.tick(Duration::from_secs(1)).unwrap();
        reply(&mut nc, job, "__TETHER_FOLDER__\0ready\0/other\0");
        let job = nc.tick(Duration::from_secs(1)).unwrap();
        assert!(command(&job).contains("options '/other'"));
        assert!(matches!(
            reply(&mut nc, job, "agent exited before starting a session"),
            Next::Nothing
        ));

        // Another agent invalidates a read still in flight.
        nc.live_pending = true;
        let job = nc.tick(Duration::from_secs(2)).unwrap();
        nc.set_agent(
            &agent::CODEX,
            OptionsDraft::new(&agent::CODEX, &ChatDefaults::default(), &[]),
            Duration::ZERO,
        );
        assert!(matches!(reply(&mut nc, job, line), Next::Nothing));
        let job = nc.tick(Duration::from_secs(2)).unwrap();
        assert!(command(&job).contains("tether acp agent codex"));
    }

    #[test]
    fn missing_folder_stays_in_dialog_and_creation_never_starts_an_agent() {
        let mut nc = dialog("/projects/new");
        let job = nc.tick(Duration::ZERO).unwrap();
        assert!(matches!(
            reply(&mut nc, job, "__TETHER_FOLDER__\0missing\0/projects/new\0"),
            Next::Nothing
        ));
        assert!(nc.folder_info.as_ref().unwrap().missing());
        let job = nc.create_folder().expect("explicit creation");
        assert!(nc.creating);
        assert!(nc.create_folder().is_none());
        assert!(nc.start(None).is_none());
        nc.set_folder("/elsewhere".into(), Duration::ZERO);
        assert_eq!(nc.folder, "/projects/new");
        assert!(matches!(
            reply(&mut nc, job, "__TETHER_FOLDER__\0ready\0/projects/new\0"),
            Next::Nothing
        ));
        assert!(nc.folder_info.as_ref().unwrap().ready());
        assert!(!nc.creating);
    }

    #[test]
    fn a_failed_start_reschedules_the_folder_check_it_dropped() {
        let mut nc = dialog("~/api");
        assert!(nc.folder_loading);
        let check = nc.start(None).expect("host check");
        let next = reply(&mut nc, check, "");
        let next = match next {
            Next::Job(home) => reply(&mut nc, home, "not a path"),
            other => other,
        };
        assert!(matches!(next, Next::Nothing));
        assert!(nc.error.is_some() && !nc.busy);
        let (_, step) = exec_of(nc.tick(Duration::ZERO));
        assert_eq!(step, Step::Folder);
        assert!(nc.error.is_some());
    }

    fn saved(id: &str) -> SavedSession {
        SavedSession {
            session_id: id.into(),
            title: id.into(),
            updated_at: None,
            cwd: "/projects/api".into(),
        }
    }

    #[test]
    fn deleting_a_saved_conversation_asks_first_then_runs_the_host_command_and_drops_the_row() {
        let mut nc = dialog("/projects/api");
        nc.listing = Listing::Loaded(vec![saved("a"), saved("b")]);
        nc.ask_delete("missing".into());
        assert!(nc.delete_asked.is_none());
        nc.ask_delete("a".into());
        nc.cancel_delete();
        assert!(nc.confirm_delete().is_none());
        nc.ask_delete("a".into());
        let job = nc.confirm_delete().unwrap();
        let ChatJob::Exec { command, .. } = &job else {
            panic!()
        };
        assert!(
            command.contains("sessions '/projects/api' --delete 'a'")
                || command.contains("sessions /projects/api --delete a"),
            "{command}"
        );
        assert_eq!(nc.deleting.as_deref(), Some("a"));
        reply(&mut nc, job, "{\"deleted\":\"a\"}\n");
        let Listing::Loaded(list) = &nc.listing else {
            panic!()
        };
        assert_eq!(list.len(), 1);
        assert!(nc.deleting.is_none() && nc.error.is_none());
    }

    #[test]
    fn extra_folders_are_absolute_or_tilde_deduplicated_and_expanded_with_the_home() {
        let mut nc = dialog("/projects/api");
        assert!(!nc.add_folder("  "));
        assert!(!nc.add_folder("relative/dir"));
        assert!(nc.error.is_some());
        assert!(nc.add_folder("~/shared"));
        assert!(nc.add_folder("/data/lib"));
        assert!(nc.add_folder("/data/lib"));
        assert_eq!(nc.extra_dirs, ["~/shared", "/data/lib"]);
        assert_eq!(nc.expanded_dirs(), ["/home/dev/shared", "/data/lib"]);
        nc.remove_folder(0);
        assert_eq!(nc.extra_dirs, ["/data/lib"]);
        let Next::Open { dirs, .. } = nc.open_next("/projects/api".into()) else {
            panic!()
        };
        assert_eq!(dirs, ["/data/lib"]);
    }

    #[test]
    fn a_tilde_folder_makes_the_start_ask_for_the_home_first() {
        let mut nc = dialog("/projects/api");
        nc.home = None;
        nc.add_folder("~/shared");
        let check = nc.start(None).unwrap();
        let Next::Job(home) = reply(&mut nc, check, "") else {
            panic!("home read")
        };
        let ChatJob::Exec { command, .. } = &home else {
            panic!()
        };
        assert_eq!(command, host::HOME);
        let Next::Job(validate) = reply(&mut nc, home, "/home/dev\n") else {
            panic!()
        };
        let Next::Open { dirs, .. } = reply(
            &mut nc,
            validate,
            "__TETHER_FOLDER__\0ready\0/projects/api\0",
        ) else {
            panic!()
        };
        assert_eq!(dirs, ["/home/dev/shared"]);
    }

    fn server_form(nc: &mut NewChat, name: &str, url: &str, library: &McpLibrary) -> bool {
        nc.save_server(name, url, "Authorization: Bearer t", Some(library))
    }

    #[test]
    fn saved_servers_validate_persist_toggle_and_delete() {
        let library = McpLibrary::new(
            std::sync::Arc::new(tether_core::secrets::MemorySecretStore::default()),
            "devbox:22",
        );
        let mut nc = dialog("/projects/api");
        nc.set_adding_server(true);
        assert!(!server_form(&mut nc, "", "https://x.test", &library));
        assert!(nc.server_error.is_some() && nc.adding_server);
        assert!(!server_form(&mut nc, "docs", "ftp://x", &library));
        assert!(server_form(&mut nc, "docs", "https://x.test/mcp", &library));
        assert!(!nc.adding_server && nc.chosen_servers.is_empty());
        assert!(!server_form(&mut nc, "docs", "https://y.test", &library));
        assert_eq!(library.list().len(), 1);
        nc.toggle_server("docs");
        nc.toggle_server("nope");
        assert_eq!(nc.chosen_servers, ["docs"]);
        let Next::Open { mcp, .. } = nc.open_next("/p".into()) else {
            panic!()
        };
        assert_eq!(mcp, ["docs"]);
        nc.delete_server("docs", Some(&library));
        assert!(nc.saved_servers.is_empty() && nc.chosen_servers.is_empty());
        assert!(library.list().is_empty());
    }

    #[test]
    fn a_failed_delete_keeps_the_row_and_says_why() {
        let mut nc = dialog("/projects/api");
        nc.listing = Listing::Loaded(vec![saved("a")]);
        nc.ask_delete("a".into());
        let job = nc.confirm_delete().unwrap();
        reply(
            &mut nc,
            job,
            "tether: unknown acp command\nusage: tether acp ...",
        );
        assert_eq!(
            nc.error.as_deref(),
            Some("Update tether on the host to delete conversations.")
        );
        assert!(matches!(&nc.listing, Listing::Loaded(l) if l.len() == 1));
    }

    #[test]
    fn retry_checks_the_same_folder_again() {
        let mut nc = dialog("/projects/api");
        let job = nc.tick(Duration::ZERO).unwrap();
        reply(&mut nc, job, "");
        assert!(!nc.folder_loading && !nc.folder_info.as_ref().unwrap().ready());
        nc.recheck(Duration::ZERO);
        assert!(nc.folder_loading && nc.folder_info.is_none());
        let job = nc.tick(Duration::ZERO).unwrap();
        reply(&mut nc, job, "__TETHER_FOLDER__\0ready\0/projects/api\0");
        assert!(nc.folder_info.as_ref().unwrap().ready());
        assert_eq!(nc.folder, "/projects/api");
    }

    #[test]
    fn late_folder_results_do_not_validate_new_text_or_a_reopened_dialog() {
        let mut nc = dialog("/old");
        let job = nc.tick(Duration::ZERO).unwrap();
        let ChatJob::Exec {
            tag: ExecTag::NewChat { request, step },
            ..
        } = job
        else {
            panic!()
        };
        nc.set_folder("/new".into(), Duration::ZERO);
        nc.on_exec(
            request,
            step,
            Ok("__TETHER_FOLDER__\0ready\0/old\0".into()),
            "host",
        );
        assert!(nc.folder_info.is_none());
        let mut reopened = dialog("/old");
        reopened.on_exec(
            request,
            step,
            Ok("__TETHER_FOLDER__\0ready\0/old\0".into()),
            "host",
        );
        assert!(reopened.folder_info.is_none());
    }

    #[test]
    fn start_rechecks_folder_and_never_opens_a_missing_or_unchecked_path() {
        for output in [
            "",
            "__TETHER_FOLDER__\0missing\0/projects/new\0",
            "__TETHER_FOLDER__\0denied\0/projects/new\0",
        ] {
            let mut nc = dialog("/projects/new");
            let job = nc.start(None).unwrap();
            let Next::Job(check) = reply(&mut nc, job, "node=ok") else {
                panic!()
            };
            assert!(matches!(reply(&mut nc, check, output), Next::Nothing));
            assert!(!nc.busy);
            assert!(nc.error.is_some());
        }
        let mut nc = dialog("/projects/new");
        let job = nc.start(None).unwrap();
        let Next::Job(check) = reply(&mut nc, job, "node=ok") else {
            panic!()
        };
        assert!(
            matches!(reply(&mut nc, check, "__TETHER_FOLDER__\0ready\0/projects/new\0"), Next::Open { cwd, .. } if cwd == "/projects/new")
        );
    }

    fn listing(status: &str, path: &str, children: &[&str]) -> String {
        let mut out = format!("__TETHER_FOLDER__\0{status}\0{path}\0");
        for c in children {
            out.push_str(&format!("{path}/{c}\0"));
        }
        out
    }

    fn exec_of(job: Option<ChatJob>) -> (u64, Step) {
        let Some(ChatJob::Exec {
            tag: ExecTag::NewChat { request, step },
            ..
        }) = job
        else {
            panic!("expected exec")
        };
        (request, step)
    }

    fn browsing(path: &str, children: &[&str]) -> NewChat {
        let mut nc = dialog(path);
        nc.folder_info = Some(Folder::parse(&listing("ready", path, children)));
        nc.folder_loading = false;
        let (request, step) = exec_of(nc.browse(Duration::ZERO));
        nc.on_exec(request, step, Ok(listing("ready", path, children)), "host");
        nc
    }

    #[test]
    fn browse_opens_a_ready_folder() {
        let nc = browsing("/home/dev/api", &["a", "b"]);
        assert!(nc.browsing && !nc.folder_loading);
        assert_eq!(nc.browse_folder, "/home/dev/api");
        assert_eq!(nc.display_path(&nc.browse_folder), "~/api");
    }

    #[test]
    fn browse_of_a_missing_folder_opens_its_parent() {
        let mut nc = dialog("/home/dev/new");
        nc.folder_info = Some(Folder::parse(&listing("missing", "/home/dev/new", &[])));
        nc.folder_loading = false;
        let job = nc.browse(Duration::ZERO);
        assert_eq!(nc.browse_folder, "/home/dev");
        assert!(nc.folder_loading);
        assert!(job.is_some());
    }

    #[test]
    fn navigate_accepts_the_parent_ancestors_and_children_only() {
        let mut nc = browsing("/home/dev/api", &["a", "b"]);
        assert!(nc.navigate("/etc".into()).is_none());
        assert!(nc.navigate("/home/dev/api/zzz".into()).is_none());
        assert!(nc.navigate("/home/dev/ap".into()).is_none());
        assert!(nc.navigate("/home/dev/api/a".into()).is_some());
        assert!(nc.folder_loading);

        let mut nc = browsing("/home/dev/api", &["a"]);
        assert!(nc.navigate("/home/dev".into()).is_some());
        let mut nc = browsing("/home/dev/api", &["a"]);
        assert!(nc.navigate("/".into()).is_some());
    }

    #[test]
    fn stale_browse_replies_are_ignored_after_back_or_a_new_navigation() {
        let mut nc = browsing("/home/dev/api", &["a"]);
        let (first, step) = exec_of(nc.navigate("/home/dev/api/a".into()));
        let (second, _) = {
            nc.folder_loading = false;
            exec_of(nc.navigate("/home/dev".into()))
        };
        assert_ne!(first, second);
        nc.on_exec(
            first,
            step,
            Ok(listing("ready", "/home/dev/api/a", &[])),
            "host",
        );
        assert_eq!(nc.browse_info.as_ref().unwrap().path, "/home/dev/api");
        assert_eq!(nc.browse_folder, "/home/dev");
        nc.back();
        nc.on_exec(
            second,
            step,
            Ok(listing("ready", "/home/dev/api", &["x"])),
            "host",
        );
        assert!(!nc.browsing);
        assert!(!nc.folder_loading);
        assert!(
            nc.browse_info.as_ref().unwrap().children.len() == 1
                && nc.browse_info.as_ref().unwrap().children[0].ends_with("/a")
        );
    }

    #[test]
    fn choosing_a_folder_fills_the_field_abbreviated_and_leaves_browsing() {
        let mut nc = browsing("/home/dev/api", &["a"]);
        let (request, step) = exec_of(nc.navigate("/home/dev/api/a".into()));
        nc.on_exec(
            request,
            step,
            Ok(listing("ready", "/home/dev/api/a", &[])),
            "host",
        );
        nc.choose_folder(Duration::ZERO);
        assert!(!nc.browsing);
        assert_eq!(nc.folder, "~/api/a");
        assert!(nc.folder_loading);
    }

    #[test]
    fn choosing_waits_for_a_ready_loaded_folder() {
        let mut nc = browsing("/home/dev/api", &["a"]);
        nc.navigate("/home/dev/api/a".into());
        nc.choose_folder(Duration::ZERO);
        assert!(nc.browsing);
        assert_eq!(nc.folder, "/home/dev/api");
    }

    #[test]
    fn typing_is_ignored_only_while_the_chooser_covers_the_field() {
        let mut nc = browsing("/home/dev/api", &[]);
        nc.set_folder("/elsewhere".into(), Duration::ZERO);
        assert_eq!(nc.folder, "/home/dev/api");
        nc.back();
        nc.set_folder("/elsewhere".into(), Duration::ZERO);
        assert_eq!(nc.folder, "/elsewhere");
    }

    #[test]
    fn create_child_rejects_bad_names_and_enters_the_new_folder_without_a_chat() {
        let mut nc = browsing("/home/dev/api", &[]);
        nc.set_new_name(Some(String::new()));
        for bad in ["", "  ", ".", "..", "a/b", "/"] {
            nc.new_name = Some(bad.into());
            assert!(nc.create_child().is_none(), "{bad:?}");
            assert!(nc.error.is_some());
            assert!(!nc.creating);
        }
        nc.new_name = Some("fresh".into());
        let (request, step) = exec_of(nc.create_child());
        assert_eq!(step, Step::CreateChild);
        assert!(nc.creating && !nc.busy);
        nc.on_exec(
            request,
            step,
            Ok(listing("ready", "/home/dev/api/fresh", &[])),
            "host",
        );
        assert!(!nc.creating && nc.new_name.is_none());
        assert_eq!(nc.browse_folder, "/home/dev/api/fresh");
        assert!(nc.browsing && !nc.busy);
    }

    #[test]
    fn a_failed_child_creation_keeps_the_name_field_and_shows_why() {
        let mut nc = browsing("/home/dev/api", &[]);
        nc.new_name = Some("fresh".into());
        let (request, step) = exec_of(nc.create_child());
        nc.on_exec(
            request,
            step,
            Ok(listing("create_failed", "/home/dev/api/fresh", &[])),
            "host",
        );
        assert_eq!(nc.new_name.as_deref(), Some("fresh"));
        assert_eq!(nc.browse_folder, "/home/dev/api");
        assert!(nc.error.as_deref().unwrap().contains("create"));
    }

    #[test]
    fn home_is_read_once_then_the_folder_is_checked() {
        let mut nc = NewChat::open(
            0,
            "/home/dev/api".into(),
            &CLAUDE,
            OptionsDraft::new(&CLAUDE, &ChatDefaults::default(), &[]),
        );
        let job = nc.tick(Duration::ZERO).unwrap();
        let (_, step) = exec_of(Some(job.clone()));
        assert_eq!(step, Step::FolderHome);
        let Next::Job(check) = reply(&mut nc, job, "/home/dev\n") else {
            panic!("expected the folder check")
        };
        assert_eq!(nc.home.as_deref(), Some("/home/dev"));
        assert_eq!(nc.folder, "~/api");
        assert_eq!(exec_of(Some(check)).1, Step::Folder);
    }

    #[test]
    fn an_edited_folder_is_not_rewritten_when_home_arrives() {
        let mut nc = NewChat::open(
            0,
            "/start".into(),
            &CLAUDE,
            OptionsDraft::new(&CLAUDE, &ChatDefaults::default(), &[]),
        );
        nc.set_folder("/home/dev".into(), Duration::ZERO);
        let job = nc.tick(Duration::from_secs(5)).unwrap();
        reply(&mut nc, job, "/home/dev");
        assert_eq!(nc.folder, "/home/dev");
    }

    #[test]
    fn breadcrumbs_collapse_home_and_navigate_by_absolute_path() {
        let nc = browsing("/home/dev/api/src", &[]);
        let crumbs = nc.crumbs();
        assert_eq!(
            crumbs,
            vec![
                ("~".to_string(), "/home/dev".to_string()),
                ("api".to_string(), "/home/dev/api".to_string()),
                ("src".to_string(), "/home/dev/api/src".to_string()),
            ]
        );
        let mut outside = browsing("/srv/app", &[]);
        assert_eq!(outside.crumbs()[0], ("/".to_string(), "/".to_string()));
        assert_eq!(outside.crumbs()[2].1, "/srv/app");
        assert!(outside.navigate("/srv".into()).is_some());
    }

    #[test]
    fn the_filter_narrows_children_case_insensitively() {
        let mut nc = browsing("/home/dev/api", &["Sources", "Tests", "docs"]);
        nc.filter = "SO".into();
        assert_eq!(nc.visible_children(), vec!["/home/dev/api/Sources"]);
    }
}
