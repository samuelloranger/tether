//! The new-chat dialog: a working folder, and in Continue mode the agent's earlier conversations
//! there. Starting runs the host checks first, so a chat never fails later for a missing tool.

use std::time::Duration;

use tether_core::acp::agent::AgentProfile;
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
    pub error: Option<String>,
    pub listing: Listing,
    pub continuing: Option<String>,
    pub agent: &'static AgentProfile,
    pub options: OptionsDraft,
    request: u64,
    list_request: u64,
    reload_at: Option<Duration>,
    multi: bool,
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
        Self {
            mode,
            folder,
            busy: false,
            error: None,
            listing: Listing::Loading,
            continuing: None,
            agent,
            options,
            request: 0,
            list_request: 0,
            reload_at: None,
            multi: false,
        }
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
        self.agent = agent;
        self.options = options;
        self.error = None;
        self.reload(now)
    }

    pub fn set_folder(&mut self, folder: String, now: Duration) {
        self.folder = folder;
        if self.mode == 1 {
            self.listing = Listing::Loading;
            self.reload_at = Some(now + RELOAD_AFTER);
        }
    }

    pub fn tick(&mut self, now: Duration) -> Option<ChatJob> {
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
        self.list_request += 1;
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

    /// `load` continues that earlier conversation instead of starting one.
    pub fn start(&mut self, load: Option<String>) -> Option<ChatJob> {
        if self.busy || self.continuing.is_some() {
            return None;
        }
        self.busy = load.is_none();
        self.continuing = load;
        self.error = None;
        self.request += 1;
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
            Step::Check | Step::Home if request != self.request => Next::Nothing,
            Step::ListHome | Step::Sessions if request != self.list_request => Next::Nothing,
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
                self.open_next(host::expand_cwd(&self.folder, ""))
            }
            Step::Home => match result {
                Ok(home) if home.trim().starts_with('/') => {
                    self.open_next(host::expand_cwd(&self.folder, home.trim()))
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
