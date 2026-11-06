//! The new-chat dialog: a working folder, and in Continue mode the agent's earlier conversations
//! there. Starting runs the host checks first, so a chat never fails later for a missing tool;
//! the same check runs as the dialog opens, so an agent the host can't run is dimmed up front.

use std::collections::HashMap;
use std::time::Duration;

use tether_core::acp::agent::{self, AgentProfile};
use tether_core::acp::folders::{self, Folder};
use tether_core::acp::host::{self, SavedSession};
use tether_core::acp::options::{OptionsDraft, StartOptions};
use tether_core::connect::ConnectError;

use super::{ChatJob, ExecTag};

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
    },
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
    pub agent: &'static AgentProfile,
    pub options: OptionsDraft,
    request: u64,
    list_request: u64,
    reload_at: Option<Duration>,
    multi: bool,
    /// Agent key → why the host can't run it, from the probe the dialog sends as it opens.
    unavailable: HashMap<&'static str, String>,
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
            agent,
            options,
            request: generation,
            list_request: generation,
            reload_at: None,
            multi: false,
            unavailable: HashMap::new(),
        }
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
                host::sessions_command(cwd, LIST_LIMIT, self.agent)
            ),
        )
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
        if self.busy || self.creating || self.continuing.is_some() || self.browsing {
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
        }
    }

    fn stop(&mut self, error: String) -> Next {
        self.busy = false;
        self.continuing = None;
        self.error = Some(error);
        Next::Nothing
    }

    pub fn on_exec(
        &mut self,
        request: u64,
        step: Step,
        result: Result<String, ConnectError>,
        host_name: &str,
    ) -> Next {
        match step {
            Step::Check | Step::Home | Step::Validate if request != self.request => Next::Nothing,
            Step::ListHome | Step::Sessions if request != self.list_request => Next::Nothing,
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
                Next::Nothing
            }
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
                if host::needs_home(&self.folder) {
                    return Next::Job(exec(self.request, Step::Home, host::HOME.to_string()));
                }
                self.validate(&host::expand_cwd(&self.folder, ""))
            }
            Step::Home => match result {
                Ok(home) if home.trim().starts_with('/') => {
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
        let ChatJob::Exec {
            tag: ExecTag::NewChat { request, step },
            ..
        } = job
        else {
            panic!("expected exec")
        };
        nc.on_exec(request, step, Ok(output.into()), "host")
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
