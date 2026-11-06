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
    pub fn preview_folder(&mut self, missing: bool) {
        self.folder = "/home/dev/projects/api-server".into();
        self.browsing = !missing;
        self.folder_at = None;
        self.folder_loading = false;
        self.folder_info = Some(Folder {
            status: if missing { "missing" } else { "ready" }.into(),
            path: self.folder.clone(),
            children: ["Sources", "Tests"]
                .iter()
                .map(|name| format!("{}/{name}", self.folder))
                .collect(),
        });
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
        if self.busy || self.continuing.is_some() || self.creating {
            return;
        }
        self.folder = folder;
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

    pub fn browse(&mut self, now: Duration) {
        self.browsing = !self.browsing;
        self.folder_request = next_request();
        self.folder_loading = true;
        self.folder_at = Some(now);
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
        if self.busy || self.creating || self.continuing.is_some() {
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
            Step::Folder | Step::CreateFolder if request != self.folder_request => Next::Nothing,
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
        NewChat::open(
            0,
            path.into(),
            &CLAUDE,
            OptionsDraft::new(&CLAUDE, &ChatDefaults::default(), &[]),
        )
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
}
