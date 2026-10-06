//! The state of the repository side panel: which list or page is showing, what is loading,
//! and what the merge dialog allows. Pure: remote work leaves as `GitJob`s and returns as
//! `GitDone`s, so the whole panel is testable without a host.

use std::time::Duration;

use crate::git::{
    self, DiffFile, GitCheck, GitCommit, MergeMethod, PrDetail, PrList, PrState, PullRequest,
};
use crate::links::is_openable;
use crate::markdown;

pub const REFRESH_LIST: Duration = Duration::from_secs(15);
pub const REFRESH_PULL_REQUESTS: Duration = Duration::from_secs(60);
pub const REFRESH_PULL_REQUEST_PAGE: Duration = Duration::from_secs(10);
pub const MARKDOWN_CAP: usize = 512 * 1024;
/// A longer diff is cut: every row is a widget.
pub const DIFF_ROW_CAP: usize = 20_000;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum GitTab {
    #[default]
    Changes,
    Commits,
    PullRequests,
    Docs,
}

/// Where a session's shell is, as far as the model knows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitTarget {
    pub pid: i64,
    pub fallback: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GitJob {
    Workspace {
        req: u64,
    },
    Docs {
        req: u64,
        top: String,
    },
    Commit {
        req: u64,
        id: String,
    },
    PrDetail {
        req: u64,
        number: u64,
    },
    PrDiff {
        req: u64,
        number: u64,
    },
    Merge {
        req: u64,
        number: u64,
        method: MergeMethod,
    },
    Markdown {
        req: u64,
        path: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Workspace {
    pub top: String,
    pub branch: String,
    pub files: Vec<DiffFile>,
    pub untracked: Vec<String>,
    pub commits: Vec<GitCommit>,
    pub prs: PrList,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GitDone {
    Workspace {
        req: u64,
        result: Result<Workspace, String>,
    },
    Docs {
        req: u64,
        result: Result<Vec<String>, String>,
    },
    Commit {
        req: u64,
        result: Result<(String, Vec<DiffFile>), String>,
    },
    PrDetail {
        req: u64,
        detail: Option<PrDetail>,
    },
    PrDiff {
        req: u64,
        result: Result<Vec<DiffFile>, String>,
    },
    Merge {
        req: u64,
        result: Result<(), String>,
    },
    Markdown {
        req: u64,
        result: Result<(String, bool), String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GitMsg {
    Toggle,
    Close,
    Refresh,
    Tick,
    SetTab(GitTab),
    Back,
    Row(usize),
    RowAlt(usize),
    ReviewPr,
    OpenPr,
    OpenCheck(usize),
    MergeAsk,
    MergeMethod(MergeMethod),
    MergeConfirm,
    MergeCancel,
    CloseMarkdown,
    OpenLink(String),
    Done(GitDone),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GitFx {
    Run(GitJob),
    OpenUrl(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Merge {
    Idle,
    Confirm(MergeMethod),
    Running { req: u64 },
    Failed(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DiffPage {
    title: String,
    note: String,
    files: Vec<DiffFile>,
    loading: Option<u64>,
    error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PrPage {
    pr: PullRequest,
    detail: Option<PrDetail>,
    loading: Option<u64>,
    missing: bool,
    merge: Merge,
    fetched: Duration,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Page {
    Diff(DiffPage),
    Pr(Box<PrPage>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Doc {
    title: String,
    req: u64,
    state: Result<(Vec<markdown::Item>, bool), Option<String>>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GitPanel {
    open: bool,
    tab: GitTab,
    stack: Vec<Page>,
    session: Option<String>,
    next_req: u64,
    workspace_req: Option<u64>,
    workspace: Option<Workspace>,
    error: Option<String>,
    docs: Option<Vec<String>>,
    docs_req: Option<u64>,
    // Set by a refresh: the list stays shown until its replacement arrives.
    docs_stale: bool,
    docs_error: Option<String>,
    doc: Option<Doc>,
    toast: Option<String>,
    last_refresh: Option<Duration>,
}

impl GitPanel {
    pub fn is_open(&self) -> bool {
        self.open
    }

    /// A text field or a modal is up: keys must not reach the terminal.
    pub fn modal(&self) -> bool {
        self.open && self.doc.is_some()
    }

    fn req(&mut self) -> u64 {
        self.next_req += 1;
        self.next_req
    }

    fn reset(&mut self) {
        let next = self.next_req;
        *self = Self {
            open: self.open,
            tab: self.tab,
            next_req: next,
            ..Self::default()
        };
    }

    pub fn handle(
        &mut self,
        msg: GitMsg,
        now: Duration,
        session: Option<&str>,
        has_target: bool,
    ) -> Vec<GitFx> {
        let mut fx = Vec::new();
        match msg {
            GitMsg::Toggle if self.open => self.open = false,
            GitMsg::Toggle => {
                self.open = true;
                self.reset();
                self.session = session.map(str::to_owned);
                self.refresh_workspace(now, has_target, &mut fx);
            }
            GitMsg::Close => self.open = false,
            GitMsg::Refresh => self.refresh_current(now, has_target, &mut fx),
            GitMsg::Tick => self.on_tick(now, session, has_target, &mut fx),
            GitMsg::SetTab(tab) => {
                self.tab = tab;
                self.stack.clear();
                self.toast = None;
                self.ensure_docs(&mut fx);
            }
            GitMsg::Back => self.back(),
            GitMsg::Row(i) => self.row(i, false, now, &mut fx),
            GitMsg::RowAlt(i) => self.row(i, true, now, &mut fx),
            GitMsg::ReviewPr => self.review_pr(&mut fx),
            GitMsg::OpenPr => {
                if let Some(Page::Pr(page)) = self.stack.last()
                    && is_openable(&page.pr.url)
                {
                    fx.push(GitFx::OpenUrl(page.pr.url.clone()));
                }
            }
            GitMsg::OpenCheck(i) => {
                if let Some(Page::Pr(page)) = self.stack.last()
                    && let Some(check) = page.detail.as_ref().and_then(|d| d.checks.get(i))
                    && is_openable(&check.url)
                {
                    fx.push(GitFx::OpenUrl(check.url.clone()));
                }
            }
            GitMsg::MergeAsk => self.merge_ask(),
            GitMsg::MergeMethod(method) => self.merge_method(method),
            GitMsg::MergeConfirm => self.merge_confirm(&mut fx),
            GitMsg::MergeCancel => {
                if let Some(page) = self.pr_page() {
                    page.merge = Merge::Idle;
                }
            }
            GitMsg::CloseMarkdown => self.doc = None,
            GitMsg::OpenLink(url) => {
                if is_openable(&url) {
                    fx.push(GitFx::OpenUrl(url));
                }
            }
            GitMsg::Done(done) => self.done(done, now, &mut fx),
        }
        fx
    }

    fn pr_page(&mut self) -> Option<&mut PrPage> {
        match self.stack.last_mut() {
            Some(Page::Pr(page)) => Some(page),
            _ => None,
        }
    }

    fn back(&mut self) {
        if self.doc.take().is_some() {
            return;
        }
        if let Some(page) = self.pr_page()
            && matches!(page.merge, Merge::Confirm(_))
        {
            page.merge = Merge::Idle;
            return;
        }
        self.stack.pop();
    }

    fn refresh_current(&mut self, now: Duration, has_target: bool, fx: &mut Vec<GitFx>) {
        if let Some(Page::Pr(_)) = self.stack.last() {
            self.fetch_pr_detail(now, fx);
        } else if self.stack.is_empty() {
            self.refresh_workspace(now, has_target, fx);
        }
    }

    fn refresh_workspace(&mut self, now: Duration, has_target: bool, fx: &mut Vec<GitFx>) {
        self.last_refresh = Some(now);
        if !has_target {
            self.workspace = None;
            self.workspace_req = None;
            self.error = Some("No working directory for this session.".into());
            return;
        }
        let req = self.req();
        self.workspace_req = Some(req);
        fx.push(GitFx::Run(GitJob::Workspace { req }));
        if self.tab == GitTab::Docs {
            self.docs_stale = true;
            self.docs_req = None;
        }
    }

    fn ensure_docs(&mut self, fx: &mut Vec<GitFx>) {
        if self.tab != GitTab::Docs
            || self.docs_req.is_some()
            || (self.docs.is_some() && !self.docs_stale)
        {
            return;
        }
        let Some(top) = self.workspace.as_ref().map(|w| w.top.clone()) else {
            return;
        };
        let req = self.req();
        self.docs_req = Some(req);
        self.docs_stale = false;
        self.docs_error = None;
        fx.push(GitFx::Run(GitJob::Docs { req, top }));
    }

    fn on_tick(
        &mut self,
        now: Duration,
        session: Option<&str>,
        has_target: bool,
        fx: &mut Vec<GitFx>,
    ) {
        if !self.open {
            return;
        }
        if self.session.as_deref() != session {
            self.reset();
            self.session = session.map(str::to_owned);
            self.refresh_workspace(now, has_target, fx);
            return;
        }
        let due = |since: Option<Duration>, every: Duration| {
            since.is_none_or(|s| now.saturating_sub(s) >= every)
        };
        match self.stack.last() {
            Some(Page::Pr(page)) => {
                let busy = page.loading.is_some() || matches!(page.merge, Merge::Running { .. });
                let pending = page.detail.as_ref().is_none_or(|d| !d.settled());
                if !busy && pending && now.saturating_sub(page.fetched) >= REFRESH_PULL_REQUEST_PAGE
                {
                    self.fetch_pr_detail(now, fx);
                }
            }
            Some(Page::Diff(_)) => {}
            None => {
                if self.workspace_req.is_some() {
                    return;
                }
                let every = if self.tab == GitTab::PullRequests {
                    REFRESH_PULL_REQUESTS
                } else {
                    REFRESH_LIST
                };
                if due(self.last_refresh, every) {
                    self.refresh_workspace(now, has_target, fx);
                }
            }
        }
    }

    fn row(&mut self, index: usize, alt: bool, now: Duration, fx: &mut Vec<GitFx>) {
        if !self.stack.is_empty() {
            return;
        }
        match self.tab {
            GitTab::Changes => {
                let Some(ws) = self.workspace.as_ref() else {
                    return;
                };
                if let Some(file) = ws.files.get(index).cloned() {
                    if !alt {
                        self.stack.push(Page::Diff(DiffPage {
                            title: file.path.clone(),
                            note: String::new(),
                            files: vec![file],
                            loading: None,
                            error: None,
                        }));
                    } else if is_markdown(&file.path) {
                        self.open_markdown(&file.path, fx);
                    }
                } else if let Some(path) = ws.untracked.get(index - ws.files.len()).cloned()
                    && is_markdown(&path)
                {
                    self.open_markdown(&path, fx);
                }
            }
            GitTab::Commits => {
                let Some(commit) = self
                    .workspace
                    .as_ref()
                    .and_then(|w| w.commits.get(index))
                    .cloned()
                else {
                    return;
                };
                let req = self.req();
                self.stack.push(Page::Diff(DiffPage {
                    title: commit.subject.clone(),
                    note: String::new(),
                    files: Vec::new(),
                    loading: Some(req),
                    error: None,
                }));
                fx.push(GitFx::Run(GitJob::Commit { req, id: commit.id }));
            }
            GitTab::PullRequests => {
                let Some(PrList::List(pulls)) = self.workspace.as_ref().map(|w| &w.prs) else {
                    return;
                };
                let Some(pr) = pulls.get(index).cloned() else {
                    return;
                };
                self.stack.push(Page::Pr(Box::new(PrPage {
                    pr,
                    detail: None,
                    loading: None,
                    missing: false,
                    merge: Merge::Idle,
                    fetched: now,
                })));
                self.fetch_pr_detail(now, fx);
            }
            GitTab::Docs => {
                if let Some(path) = self.docs.as_ref().and_then(|d| d.get(index)).cloned() {
                    self.open_markdown(&path, fx);
                }
            }
        }
    }

    fn open_markdown(&mut self, relative: &str, fx: &mut Vec<GitFx>) {
        let top = self.workspace.as_ref().map_or("", |w| w.top.as_str());
        let Some(path) = git::join_repo_path(top, relative) else {
            self.toast = Some("That path can't be opened.".into());
            return;
        };
        let req = self.req();
        self.doc = Some(Doc {
            title: relative.to_owned(),
            req,
            state: Err(None),
        });
        fx.push(GitFx::Run(GitJob::Markdown { req, path }));
    }

    fn fetch_pr_detail(&mut self, now: Duration, fx: &mut Vec<GitFx>) {
        let req = self.req();
        let Some(page) = self.pr_page() else { return };
        page.loading = Some(req);
        page.fetched = now;
        page.missing = false;
        let number = page.pr.number;
        fx.push(GitFx::Run(GitJob::PrDetail { req, number }));
    }

    fn review_pr(&mut self, fx: &mut Vec<GitFx>) {
        let req = self.req();
        let Some(page) = self.pr_page() else { return };
        let (number, title) = (
            page.pr.number,
            format!("#{} {}", page.pr.number, page.pr.title),
        );
        self.stack.push(Page::Diff(DiffPage {
            title,
            note: String::new(),
            files: Vec::new(),
            loading: Some(req),
            error: None,
        }));
        fx.push(GitFx::Run(GitJob::PrDiff { req, number }));
    }

    fn merge_ask(&mut self) {
        let Some(page) = self.pr_page() else { return };
        let method = page
            .detail
            .as_ref()
            .filter(|d| d.can_merge())
            .and_then(|d| git::default_method(&d.methods));
        if let Some(method) = method {
            page.merge = Merge::Confirm(method);
        }
    }

    fn merge_method(&mut self, method: MergeMethod) {
        let Some(page) = self.pr_page() else { return };
        let allowed = page
            .detail
            .as_ref()
            .is_some_and(|d| d.methods.contains(&method));
        if allowed && matches!(page.merge, Merge::Confirm(_)) {
            page.merge = Merge::Confirm(method);
        }
    }

    /// The same gate as the dialog's button: a pull request that stopped being mergeable while
    /// the dialog was open is refused here too.
    fn merge_confirm(&mut self, fx: &mut Vec<GitFx>) {
        let req = self.req();
        let Some(page) = self.pr_page() else { return };
        let Merge::Confirm(method) = page.merge else {
            return;
        };
        let allowed = page
            .detail
            .as_ref()
            .is_some_and(|d| d.can_merge() && d.methods.contains(&method));
        if !allowed {
            page.merge = Merge::Idle;
            return;
        }
        page.merge = Merge::Running { req };
        fx.push(GitFx::Run(GitJob::Merge {
            req,
            number: page.pr.number,
            method,
        }));
    }

    fn done(&mut self, done: GitDone, now: Duration, fx: &mut Vec<GitFx>) {
        match done {
            GitDone::Workspace { req, result } => {
                if self.workspace_req != Some(req) {
                    return;
                }
                self.workspace_req = None;
                match result {
                    Ok(ws) => {
                        self.workspace = Some(ws);
                        self.error = None;
                        self.ensure_docs(fx);
                    }
                    Err(message) => self.error = Some(message),
                }
            }
            GitDone::Docs { req, result } => {
                if self.docs_req != Some(req) {
                    return;
                }
                self.docs_req = None;
                match result {
                    Ok(list) => self.docs = Some(list),
                    Err(message) => self.docs_error = Some(message),
                }
            }
            GitDone::Commit { req, result } => {
                let Some(Page::Diff(page)) = self.stack.last_mut() else {
                    return;
                };
                if page.loading != Some(req) {
                    return;
                }
                page.loading = None;
                match result {
                    Ok((body, files)) => {
                        page.note = body;
                        page.files = files;
                    }
                    Err(message) => page.error = Some(message),
                }
            }
            GitDone::PrDiff { req, result } => {
                let Some(Page::Diff(page)) = self.stack.last_mut() else {
                    return;
                };
                if page.loading != Some(req) {
                    return;
                }
                page.loading = None;
                match result {
                    Ok(files) => page.files = files,
                    Err(message) => page.error = Some(message),
                }
            }
            GitDone::PrDetail { req, detail } => {
                let Some(page) = self.pr_page() else { return };
                if page.loading != Some(req) {
                    return;
                }
                page.loading = None;
                page.fetched = now;
                match detail {
                    Some(detail) => {
                        page.detail = Some(detail);
                        page.missing = false;
                    }
                    None => page.missing = page.detail.is_none(),
                }
            }
            GitDone::Merge { req, result } => {
                let Some(page) = self.pr_page() else { return };
                if page.merge != (Merge::Running { req }) {
                    return;
                }
                let merged = result.is_ok();
                match result {
                    // The merge call already said it worked; flip in place rather than race
                    // GitHub's propagation on a re-fetch.
                    Ok(()) => {
                        page.merge = Merge::Idle;
                        page.detail = page.detail.as_ref().map(PrDetail::marked_merged);
                    }
                    Err(message) => page.merge = Merge::Failed(message),
                }
                if merged {
                    self.last_refresh = None;
                } else {
                    self.fetch_pr_detail(now, fx);
                }
            }
            GitDone::Markdown { req, result } => {
                let Some(doc) = self.doc.as_mut() else { return };
                if doc.req != req {
                    return;
                }
                doc.state = match result {
                    Ok((text, truncated)) => {
                        Ok((markdown::items(&markdown::parse(&text)), truncated))
                    }
                    Err(message) => Err(Some(message)),
                };
            }
        }
    }

    pub fn view(&self) -> GitView {
        if !self.open {
            return GitView::default();
        }
        let mut view = GitView {
            open: true,
            tab: self.tab,
            toast: self.toast.clone().unwrap_or_default(),
            markdown: self.doc.as_ref().map(doc_view),
            ..GitView::default()
        };
        let branch = self.workspace.as_ref().map(|w| w.branch.as_str());
        view.title = match branch {
            Some("") => "(detached HEAD)".into(),
            Some(b) => b.to_owned(),
            None => "Git".into(),
        };
        match self.stack.last() {
            Some(Page::Diff(page)) => self.diff_page_view(page, &mut view),
            Some(Page::Pr(page)) => {
                view.can_back = true;
                view.title = format!("#{}", page.pr.number);
                view.pr = Some(pr_view(page));
                view.loading = page.loading.is_some();
            }
            None => self.list_view(&mut view),
        }
        view
    }

    fn diff_page_view(&self, page: &DiffPage, view: &mut GitView) {
        view.can_back = true;
        view.title.clone_from(&page.title);
        view.loading = page.loading.is_some();
        let (added, removed) = git::diff_stat(&page.files);
        if !page.files.is_empty() {
            view.subtitle = format!("+{added}  \u{2212}{removed}");
            view.stat = Some((added, removed));
        }
        for line in page.note.lines() {
            view.diff.push(DiffLine::plain(line));
        }
        if !page.note.is_empty() {
            view.diff.push(DiffLine::plain(""));
        }
        for file in &page.files {
            if !file.is_preamble() && (page.files.len() > 1 || file.path != page.title) {
                view.diff.push(DiffLine {
                    kind: DiffLineKind::File,
                    old: String::new(),
                    new: String::new(),
                    text: file.path.clone(),
                    stat: format!("+{}  \u{2212}{}", file.added, file.removed),
                });
            }
            for row in &file.rows {
                if view.diff.len() >= DIFF_ROW_CAP {
                    view.diff.push(DiffLine::plain(
                        "\u{2026} the diff continues; it was cut here",
                    ));
                    return;
                }
                view.diff.push(DiffLine::from_row(row));
            }
        }
        if let Some(message) = &page.error {
            view.notice.clone_from(message);
        } else if page.files.is_empty() && page.loading.is_none() {
            view.notice = "No changes to show.".into();
        }
    }

    fn list_view(&self, view: &mut GitView) {
        view.show_tabs = true;
        let Some(ws) = self.workspace.as_ref() else {
            view.loading = self.workspace_req.is_some();
            view.notice = self
                .error
                .clone()
                .unwrap_or_else(|| "Loading repository\u{2026}".into());
            return;
        };
        view.loading = self.workspace_req.is_some();
        if let Some(error) = &self.error {
            view.toast.clone_from(error);
        }
        match self.tab {
            GitTab::Changes => {
                let (added, removed) = git::diff_stat(&ws.files);
                if !ws.files.is_empty() {
                    view.subtitle = format!("+{added}  \u{2212}{removed}");
                    view.stat = Some((added, removed));
                }
                for file in &ws.files {
                    view.rows.push(GitRow {
                        primary: file.path.clone(),
                        added: file.added,
                        removed: file.removed,
                        previewable: is_markdown(&file.path),
                        ..GitRow::default()
                    });
                }
                for path in &ws.untracked {
                    view.rows.push(GitRow {
                        primary: path.clone(),
                        badge: "new".into(),
                        tone: Tone::Good,
                        previewable: is_markdown(path),
                        ..GitRow::default()
                    });
                }
                if view.rows.is_empty() {
                    view.notice = "No uncommitted changes.".into();
                }
            }
            GitTab::Commits => {
                view.rows = ws
                    .commits
                    .iter()
                    .map(|c| GitRow {
                        primary: c.subject.clone(),
                        secondary: format!("{} \u{b7} {}", c.id, c.author),
                        ..GitRow::default()
                    })
                    .collect();
                if view.rows.is_empty() {
                    view.notice = "No commits yet.".into();
                }
            }
            GitTab::PullRequests => match &ws.prs {
                PrList::List(pulls) => {
                    let open = pulls.iter().filter(|p| p.state() == PrState::Open).count();
                    view.subtitle = format!("{open} open");
                    view.rows = pulls
                        .iter()
                        .map(|p| {
                            let (badge, tone) = pr_badge(p);
                            GitRow {
                                primary: format!("#{} {}", p.number, p.title),
                                secondary: format!("{} \u{2192} {}", p.head, p.base),
                                badge: badge.into(),
                                tone,
                                ..GitRow::default()
                            }
                        })
                        .collect();
                    if view.rows.is_empty() {
                        view.notice = "No pull requests.".into();
                    }
                }
                PrList::ToolMissing => {
                    view.notice = "GitHub CLI isn't installed on this host.".into();
                }
                PrList::Failed(reason) => {
                    view.notice = format!("Couldn't load pull requests: {reason}");
                }
            },
            GitTab::Docs => {
                if let Some(list) = &self.docs {
                    view.rows = list
                        .iter()
                        .map(|p| GitRow {
                            primary: p.clone(),
                            previewable: true,
                            ..GitRow::default()
                        })
                        .collect();
                    if list.is_empty() {
                        view.notice = "No markdown files in this repository.".into();
                    }
                } else if let Some(error) = &self.docs_error {
                    view.notice.clone_from(error);
                } else {
                    view.loading = true;
                }
            }
        }
    }
}

fn is_markdown(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.ends_with(".md") || lower.ends_with(".markdown")
}

fn pr_badge(pr: &PullRequest) -> (&'static str, Tone) {
    match pr.state() {
        PrState::Merged => ("Merged", Tone::Accent),
        PrState::Closed => ("Closed", Tone::Neutral),
        PrState::Open if pr.is_draft => ("Draft", Tone::Neutral),
        PrState::Open => ("Open", Tone::Good),
    }
}

fn check_tone(state: git::CheckState) -> Tone {
    match state {
        git::CheckState::Passed => Tone::Good,
        git::CheckState::Failed => Tone::Bad,
        git::CheckState::Running => Tone::Warn,
        git::CheckState::Skipped => Tone::Neutral,
    }
}

fn gate_tone(gate: git::MergeGate) -> Tone {
    match gate {
        git::MergeGate::Ready => Tone::Good,
        git::MergeGate::Conflicted => Tone::Bad,
        git::MergeGate::Behind | git::MergeGate::Blocked | git::MergeGate::Draft => Tone::Warn,
        git::MergeGate::Computing => Tone::Neutral,
    }
}

fn pr_view(page: &PrPage) -> PrView {
    let pr = &page.pr;
    // The list row's state stands in while the detail loads, so a merged pull request never
    // flashes "Open".
    let state = page.detail.as_ref().map_or_else(|| pr.state(), |d| d.state);
    let (state_chip, state_tone) = match state {
        PrState::Merged => ("Merged", Tone::Accent),
        PrState::Closed => ("Closed", Tone::Neutral),
        PrState::Open if pr.is_draft => ("Draft", Tone::Neutral),
        PrState::Open => ("Open", Tone::Good),
    };
    let mut chips = vec![format!("{} files", pr.changed_files)];
    if let Some(decision) = pr.review_decision.as_deref().filter(|d| !d.is_empty()) {
        chips.push(decision.replace('_', " ").to_ascii_lowercase());
    }
    let mut view = PrView {
        title: format!("#{} {}", pr.number, pr.title),
        branches: format!("{} \u{2192} {}", pr.head, pr.base),
        state_chip: state_chip.into(),
        state_tone,
        chips,
        loading: page.loading.is_some() && page.detail.is_none(),
        ..PrView::default()
    };
    let Some(detail) = &page.detail else {
        if page.missing {
            view.status = "Couldn't read this pull request from the host.".into();
        }
        return view;
    };
    view.checks_headline = git::check_headline(&detail.checks);
    view.checks_tone = git::rollup(&detail.checks).map_or(Tone::Neutral, check_tone);
    view.checks = detail
        .checks
        .iter()
        .map(|c: &GitCheck| CheckRow {
            name: c.name.clone(),
            tone: check_tone(c.state),
            linked: is_openable(&c.url),
        })
        .collect();
    if detail.merged() {
        view.status = "Merged".into();
        view.status_tone = Tone::Good;
        return view;
    }
    if state == PrState::Closed {
        view.status = "Closed without merging".into();
        return view;
    }
    match &page.merge {
        Merge::Running { .. } => {
            view.status = "Merging\u{2026}".into();
            view.status_tone = Tone::Neutral;
            return view;
        }
        Merge::Failed(message) => view.note = format!("Merge failed: {message}"),
        Merge::Idle | Merge::Confirm(_) => {}
    }
    view.gate_text = detail.gate.reason().into();
    view.gate_tone = gate_tone(detail.gate);
    view.can_merge = detail.can_merge();
    view.merge_label = git::default_method(&detail.methods)
        .map_or("Merge pull request", MergeMethod::label)
        .into();
    if detail.gate == git::MergeGate::Behind {
        view.note = "Update the branch on GitHub to merge.".into();
    }
    if detail.gate.can_merge() && detail.methods.is_empty() {
        view.note = "This repository allows no merge method.".into();
    }
    if let Merge::Confirm(selected) = page.merge {
        view.dialog = Some(MergeDialog {
            title: format!("Merge #{}?", pr.number),
            body: format!("{} \u{2192} {}", pr.head, pr.base),
            methods: detail
                .methods
                .iter()
                .map(|m| (*m, m.label().to_owned(), *m == selected))
                .collect(),
        });
    }
    view
}

fn doc_view(doc: &Doc) -> MarkdownView {
    match &doc.state {
        Ok((items, truncated)) => MarkdownView {
            title: doc.title.clone(),
            items: items.clone(),
            truncated: *truncated,
            ..MarkdownView::default()
        },
        Err(None) => MarkdownView {
            title: doc.title.clone(),
            loading: true,
            ..MarkdownView::default()
        },
        Err(Some(message)) => MarkdownView {
            title: doc.title.clone(),
            error: message.clone(),
            ..MarkdownView::default()
        },
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Tone {
    #[default]
    Neutral,
    Good,
    Bad,
    Warn,
    Accent,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GitRow {
    pub primary: String,
    pub secondary: String,
    pub badge: String,
    pub tone: Tone,
    pub added: u32,
    pub removed: u32,
    pub previewable: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiffLineKind {
    File,
    Hunk,
    Added,
    Removed,
    Context,
    Plain,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffLine {
    pub kind: DiffLineKind,
    pub old: String,
    pub new: String,
    pub text: String,
    pub stat: String,
}

impl DiffLine {
    fn plain(text: &str) -> Self {
        Self {
            kind: DiffLineKind::Plain,
            old: String::new(),
            new: String::new(),
            text: text.to_owned(),
            stat: String::new(),
        }
    }

    fn from_row(row: &git::DiffRow) -> Self {
        let number = |n: Option<u32>| n.map(|n| n.to_string()).unwrap_or_default();
        let (kind, text) = match row.kind {
            git::RowKind::Hunk => (DiffLineKind::Hunk, row.header.clone()),
            git::RowKind::Added => (DiffLineKind::Added, row.text.clone()),
            git::RowKind::Removed => (DiffLineKind::Removed, row.text.clone()),
            git::RowKind::Context => (DiffLineKind::Context, row.text.clone()),
            git::RowKind::Plain => (DiffLineKind::Plain, row.text.clone()),
        };
        Self {
            kind,
            old: number(row.old_line),
            new: number(row.new_line),
            text,
            stat: String::new(),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CheckRow {
    pub name: String,
    pub tone: Tone,
    pub linked: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MergeDialog {
    pub title: String,
    pub body: String,
    pub methods: Vec<(MergeMethod, String, bool)>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PrView {
    pub title: String,
    pub branches: String,
    pub state_chip: String,
    pub state_tone: Tone,
    pub chips: Vec<String>,
    pub loading: bool,
    pub checks_headline: String,
    pub checks_tone: Tone,
    pub checks: Vec<CheckRow>,
    pub gate_text: String,
    pub gate_tone: Tone,
    pub can_merge: bool,
    pub merge_label: String,
    /// Replaces the merge card: merged, merging, closed, or unreadable.
    pub status: String,
    pub status_tone: Tone,
    pub note: String,
    pub dialog: Option<MergeDialog>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MarkdownView {
    pub title: String,
    pub loading: bool,
    pub error: String,
    pub truncated: bool,
    pub items: Vec<markdown::Item>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GitView {
    pub open: bool,
    pub title: String,
    pub subtitle: String,
    /// Lines added and removed, drawn in the heat colors instead of `subtitle`.
    pub stat: Option<(u32, u32)>,
    pub tab: GitTab,
    pub show_tabs: bool,
    pub can_back: bool,
    pub loading: bool,
    pub notice: String,
    pub toast: String,
    pub rows: Vec<GitRow>,
    pub diff: Vec<DiffLine>,
    pub pr: Option<PrView>,
    pub markdown: Option<MarkdownView>,
}

/// The first line of whatever a failed command printed, or the transport's sentence.
fn failure(raw: Result<String, String>) -> Result<String, String> {
    let output = raw?;
    let (text, rc) = git::unwrap_output(&output);
    match rc {
        Some(0) | None => Ok(text),
        Some(code) => Err(match git::first_line(&text) {
            line if line.is_empty() => format!("The command exited with status {code}."),
            line => line,
        }),
    }
}

/// `raw` is the exec outcome of `git::workspace_command`: the output, or the transport's sentence.
pub fn workspace_result(raw: Result<String, String>) -> Result<Workspace, String> {
    let output = raw?;
    let (text, _) = git::unwrap_output(&output);
    let sections = git::workspace_sections(&text)
        .ok_or_else(|| "Could not read the repository.".to_owned())?;
    if sections.diff.trim() == git::NOT_A_REPO {
        return Err("This session's directory is not a git repository.".into());
    }
    let (top, branch) = git::parse_location(sections.location);
    Ok(Workspace {
        top,
        branch,
        files: git::group_diff(sections.diff),
        untracked: git::parse_untracked(sections.untracked),
        commits: git::parse_commits(sections.commits),
        prs: git::pull_request_result(sections.pull_requests),
    })
}

pub fn docs_result(raw: Result<String, String>) -> Result<Vec<String>, String> {
    Ok(git::parse_untracked(&failure(raw)?))
}

pub fn commit_result(raw: Result<String, String>) -> Result<(String, Vec<DiffFile>), String> {
    let text = failure(raw)?;
    let (body, patch) = git::commit_show(&text);
    Ok((body, git::group_diff(&patch)))
}

pub fn pr_diff_result(raw: Result<String, String>) -> Result<Vec<DiffFile>, String> {
    Ok(git::group_diff(&failure(raw)?))
}

pub fn pr_detail_result(raw: Result<String, String>) -> Option<PrDetail> {
    let output = raw.ok()?;
    git::parse_pr_detail(&git::unwrap_output(&output).0)
}

pub fn merge_result(raw: Result<String, String>) -> Result<(), String> {
    failure(raw).map(|_| ())
}

pub fn markdown_result(raw: Result<String, String>) -> Result<(String, bool), String> {
    let text = failure(raw)?;
    if text.len() <= MARKDOWN_CAP {
        return Ok((text, false));
    }
    let mut end = MARKDOWN_CAP;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    Ok((text[..end].to_owned(), true))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::{CheckState, MergeGate};

    const T0: Duration = Duration::ZERO;

    fn sec(s: u64) -> Duration {
        Duration::from_secs(s)
    }

    fn pr(number: u64, draft: bool, state: &str) -> PullRequest {
        PullRequest {
            number,
            title: format!("title {number}"),
            head: "feat".into(),
            base: "main".into(),
            url: format!("https://example.test/pr/{number}"),
            is_draft: draft,
            changed_files: 3,
            review_decision: Some("REVIEW_REQUIRED".into()),
            raw_state: Some(state.into()),
        }
    }

    fn file(path: &str) -> DiffFile {
        git::group_diff(&format!(
            "diff --git a/{path} b/{path}\n@@ -1 +1 @@\n-a\n+b"
        ))
        .remove(0)
    }

    fn workspace() -> Workspace {
        Workspace {
            top: "/repo".into(),
            branch: "feat/x".into(),
            files: vec![file("src/a.rs"), file("README.md")],
            untracked: vec!["notes.md".into(), "scratch.txt".into()],
            commits: vec![GitCommit {
                id: "abc1234".into(),
                subject: "Fix it".into(),
                author: "Sam".into(),
                timestamp: 1,
            }],
            prs: PrList::List(vec![pr(7, false, "OPEN"), pr(8, false, "MERGED")]),
        }
    }

    fn detail(gate: MergeGate, methods: &[MergeMethod]) -> PrDetail {
        PrDetail {
            checks: vec![GitCheck {
                name: "lint".into(),
                state: CheckState::Passed,
                url: "https://example.test/lint".into(),
            }],
            gate,
            methods: methods.to_vec(),
            state: PrState::Open,
        }
    }

    fn run(p: &mut GitPanel, msg: GitMsg, now: Duration) -> Vec<GitFx> {
        p.handle(msg, now, Some("main"), true)
    }

    fn opened() -> GitPanel {
        let mut p = GitPanel::default();
        let fx = run(&mut p, GitMsg::Toggle, T0);
        let GitFx::Run(GitJob::Workspace { req }) = fx[0].clone() else {
            panic!("{fx:?}");
        };
        run(
            &mut p,
            GitMsg::Done(GitDone::Workspace {
                req,
                result: Ok(workspace()),
            }),
            T0,
        );
        p
    }

    fn open_pr(p: &mut GitPanel, d: PrDetail) {
        run(p, GitMsg::SetTab(GitTab::PullRequests), T0);
        let fx = run(p, GitMsg::Row(0), T0);
        let GitFx::Run(GitJob::PrDetail { req, number }) = fx[0].clone() else {
            panic!("{fx:?}");
        };
        assert_eq!(number, 7);
        run(
            p,
            GitMsg::Done(GitDone::PrDetail {
                req,
                detail: Some(d),
            }),
            T0,
        );
    }

    #[test]
    fn opening_the_panel_loads_the_workspace_once() {
        let mut p = GitPanel::default();
        let fx = run(&mut p, GitMsg::Toggle, T0);
        assert_eq!(fx, [GitFx::Run(GitJob::Workspace { req: 1 })]);
        assert!(p.view().loading);
        assert_eq!(p.view().notice, "Loading repository\u{2026}");
        // A stale answer from a refresh that was superseded is ignored.
        run(&mut p, GitMsg::Refresh, T0);
        run(
            &mut p,
            GitMsg::Done(GitDone::Workspace {
                req: 1,
                result: Ok(workspace()),
            }),
            T0,
        );
        assert!(p.view().rows.is_empty());
        assert!(p.view().loading);
    }

    #[test]
    fn a_session_with_no_directory_says_so() {
        let mut p = GitPanel::default();
        let fx = p.handle(GitMsg::Toggle, T0, None, false);
        assert!(fx.is_empty());
        assert_eq!(p.view().notice, "No working directory for this session.");
    }

    #[test]
    fn the_changes_tab_lists_changed_then_new_files() {
        let p = opened();
        let v = p.view();
        assert_eq!(v.title, "feat/x");
        assert_eq!(v.subtitle, "+2  \u{2212}2");
        let names: Vec<_> = v.rows.iter().map(|r| r.primary.as_str()).collect();
        assert_eq!(names, ["src/a.rs", "README.md", "notes.md", "scratch.txt"]);
        let previewable: Vec<_> = v.rows.iter().map(|r| r.previewable).collect();
        assert_eq!(previewable, [false, true, true, false]);
        assert_eq!(v.rows[2].badge, "new");
    }

    #[test]
    fn a_clean_tree_says_so() {
        let mut p = opened();
        p.workspace.as_mut().unwrap().files.clear();
        p.workspace.as_mut().unwrap().untracked.clear();
        assert_eq!(p.view().notice, "No uncommitted changes.");
    }

    #[test]
    fn a_file_row_opens_its_diff_and_back_returns() {
        let mut p = opened();
        run(&mut p, GitMsg::Row(0), T0);
        let v = p.view();
        assert!(v.can_back);
        assert_eq!(v.title, "src/a.rs");
        let kinds: Vec<_> = v.diff.iter().map(|l| l.kind).collect();
        assert_eq!(
            kinds,
            [
                DiffLineKind::Hunk,
                DiffLineKind::Removed,
                DiffLineKind::Added
            ]
        );
        assert_eq!(v.diff[0].text, "@@ -1 +1 @@");
        assert_eq!((v.diff[1].old.as_str(), v.diff[2].new.as_str()), ("1", "1"));
        run(&mut p, GitMsg::Back, T0);
        assert!(!p.view().can_back);
    }

    #[test]
    fn a_markdown_file_previews_from_the_alt_action_or_when_new() {
        let mut p = opened();
        let fx = run(&mut p, GitMsg::RowAlt(1), T0);
        assert_eq!(
            fx,
            [GitFx::Run(GitJob::Markdown {
                req: p.next_req,
                path: "/repo/README.md".into()
            })]
        );
        assert!(p.modal());
        run(&mut p, GitMsg::CloseMarkdown, T0);
        let fx = run(&mut p, GitMsg::Row(2), T0);
        assert!(matches!(
            &fx[0],
            GitFx::Run(GitJob::Markdown { path, .. }) if path == "/repo/notes.md"
        ));
        // A new file that is not markdown has nothing to preview.
        run(&mut p, GitMsg::CloseMarkdown, T0);
        assert!(run(&mut p, GitMsg::Row(3), T0).is_empty());
    }

    #[test]
    fn the_markdown_viewer_shows_loading_then_blocks_then_closes() {
        let mut p = opened();
        let fx = run(&mut p, GitMsg::RowAlt(1), T0);
        let GitFx::Run(GitJob::Markdown { req, .. }) = fx[0].clone() else {
            panic!();
        };
        assert!(p.view().markdown.unwrap().loading);
        run(
            &mut p,
            GitMsg::Done(GitDone::Markdown {
                req: req + 9,
                result: Ok(("ignored".into(), false)),
            }),
            T0,
        );
        assert!(p.view().markdown.unwrap().loading);
        run(
            &mut p,
            GitMsg::Done(GitDone::Markdown {
                req,
                result: Ok(("# Title\n\ntext [x](https://example.test/)".into(), true)),
            }),
            T0,
        );
        let md = p.view().markdown.unwrap();
        assert_eq!(md.title, "README.md");
        assert_eq!(md.items.len(), 2);
        assert!(md.truncated);
        run(&mut p, GitMsg::Back, T0);
        assert!(p.view().markdown.is_none());
    }

    #[test]
    fn a_failed_markdown_read_shows_its_reason() {
        let mut p = opened();
        let fx = run(&mut p, GitMsg::RowAlt(1), T0);
        let GitFx::Run(GitJob::Markdown { req, .. }) = fx[0].clone() else {
            panic!();
        };
        run(
            &mut p,
            GitMsg::Done(GitDone::Markdown {
                req,
                result: Err("No such file".into()),
            }),
            T0,
        );
        assert_eq!(p.view().markdown.unwrap().error, "No such file");
    }

    #[test]
    fn the_docs_tab_loads_once_and_lists_markdown_files() {
        let mut p = opened();
        let fx = run(&mut p, GitMsg::SetTab(GitTab::Docs), T0);
        let GitFx::Run(GitJob::Docs { req, top }) = fx[0].clone() else {
            panic!("{fx:?}");
        };
        assert_eq!(top, "/repo");
        assert!(p.view().loading);
        assert!(run(&mut p, GitMsg::SetTab(GitTab::Docs), T0).is_empty());
        run(
            &mut p,
            GitMsg::Done(GitDone::Docs {
                req,
                result: Ok(vec!["docs/a.md".into()]),
            }),
            T0,
        );
        assert_eq!(p.view().rows[0].primary, "docs/a.md");
        let fx = run(&mut p, GitMsg::Row(0), T0);
        assert!(matches!(
            &fx[0],
            GitFx::Run(GitJob::Markdown { path, .. }) if path == "/repo/docs/a.md"
        ));
    }

    #[test]
    fn a_refresh_keeps_the_docs_listed_until_the_new_list_arrives() {
        let mut p = opened();
        let fx = run(&mut p, GitMsg::SetTab(GitTab::Docs), T0);
        let GitFx::Run(GitJob::Docs { req, .. }) = fx[0].clone() else {
            panic!("{fx:?}");
        };
        let docs = |req, list: &[&str]| {
            GitMsg::Done(GitDone::Docs {
                req,
                result: Ok(list.iter().map(|s| (*s).into()).collect()),
            })
        };
        run(&mut p, docs(req, &["a.md"]), T0);
        let fx = run(&mut p, GitMsg::Tick, sec(15));
        let GitFx::Run(GitJob::Workspace { req }) = fx[0].clone() else {
            panic!("{fx:?}");
        };
        assert_eq!(p.view().rows[0].primary, "a.md");
        let fx = run(
            &mut p,
            GitMsg::Done(GitDone::Workspace {
                req,
                result: Ok(workspace()),
            }),
            sec(15),
        );
        let GitFx::Run(GitJob::Docs { req, .. }) = fx[0].clone() else {
            panic!("{fx:?}");
        };
        assert!(!p.view().loading);
        assert_eq!(p.view().rows[0].primary, "a.md");
        run(&mut p, docs(req, &["a.md", "b.md"]), sec(15));
        assert_eq!(p.view().rows.len(), 2);
    }

    #[test]
    fn a_path_that_escapes_the_repository_is_never_opened() {
        let mut p = opened();
        p.docs = Some(vec!["../../etc/passwd".into()]);
        p.tab = GitTab::Docs;
        assert!(run(&mut p, GitMsg::Row(0), T0).is_empty());
        assert_eq!(p.view().toast, "That path can't be opened.");
        assert!(p.view().markdown.is_none());
    }

    #[test]
    fn a_commit_opens_a_diff_that_fills_in() {
        let mut p = opened();
        run(&mut p, GitMsg::SetTab(GitTab::Commits), T0);
        let fx = run(&mut p, GitMsg::Row(0), T0);
        let GitFx::Run(GitJob::Commit { req, id }) = fx[0].clone() else {
            panic!();
        };
        assert_eq!(id, "abc1234");
        assert!(p.view().loading);
        run(
            &mut p,
            GitMsg::Done(GitDone::Commit {
                req,
                result: Ok(("Why it changed.".into(), vec![file("src/a.rs")])),
            }),
            T0,
        );
        let v = p.view();
        assert!(!v.loading);
        assert_eq!(v.title, "Fix it");
        assert_eq!(v.diff[0].text, "Why it changed.");
        assert!(v.diff.iter().any(|l| l.kind == DiffLineKind::Added));
    }

    #[test]
    fn the_pull_request_tab_distinguishes_missing_failed_and_empty() {
        let mut p = opened();
        run(&mut p, GitMsg::SetTab(GitTab::PullRequests), T0);
        let v = p.view();
        assert_eq!(v.subtitle, "1 open");
        assert_eq!(v.rows[0].badge, "Open");
        assert_eq!(v.rows[1].badge, "Merged");
        p.workspace.as_mut().unwrap().prs = PrList::ToolMissing;
        assert_eq!(p.view().notice, "GitHub CLI isn't installed on this host.");
        p.workspace.as_mut().unwrap().prs = PrList::Failed("auth".into());
        assert_eq!(p.view().notice, "Couldn't load pull requests: auth");
        p.workspace.as_mut().unwrap().prs = PrList::List(vec![]);
        assert_eq!(p.view().notice, "No pull requests.");
    }

    #[test]
    fn a_ready_pull_request_merges_only_after_the_dialog_confirms() {
        let mut p = opened();
        open_pr(
            &mut p,
            detail(MergeGate::Ready, &[MergeMethod::Merge, MergeMethod::Squash]),
        );
        let v = p.view().pr.unwrap();
        assert!(v.can_merge);
        assert_eq!(v.merge_label, "Squash and merge");
        assert!(v.dialog.is_none());
        run(&mut p, GitMsg::MergeAsk, T0);
        let dialog = p.view().pr.unwrap().dialog.unwrap();
        assert_eq!(dialog.title, "Merge #7?");
        assert_eq!(
            dialog.methods.iter().map(|m| m.2).collect::<Vec<_>>(),
            [false, true]
        );
        run(&mut p, GitMsg::MergeMethod(MergeMethod::Merge), T0);
        // Rebase is not allowed here, so choosing it changes nothing.
        run(&mut p, GitMsg::MergeMethod(MergeMethod::Rebase), T0);
        let fx = run(&mut p, GitMsg::MergeConfirm, T0);
        let GitFx::Run(GitJob::Merge {
            req,
            number,
            method,
        }) = fx[0].clone()
        else {
            panic!("{fx:?}");
        };
        assert_eq!((number, method), (7, MergeMethod::Merge));
        assert_eq!(p.view().pr.unwrap().status, "Merging\u{2026}");
        run(
            &mut p,
            GitMsg::Done(GitDone::Merge {
                req,
                result: Ok(()),
            }),
            T0,
        );
        let v = p.view().pr.unwrap();
        assert_eq!(v.status, "Merged");
        assert_eq!(v.state_chip, "Merged");
        assert!(!v.can_merge);
    }

    #[test]
    fn every_refusal_keeps_the_merge_button_dead() {
        for gate in [
            MergeGate::Blocked,
            MergeGate::Behind,
            MergeGate::Conflicted,
            MergeGate::Draft,
            MergeGate::Computing,
        ] {
            let mut p = opened();
            open_pr(&mut p, detail(gate, &[MergeMethod::Squash]));
            let v = p.view().pr.unwrap();
            assert!(!v.can_merge, "{gate:?}");
            assert_eq!(v.gate_text, gate.reason());
            assert!(run(&mut p, GitMsg::MergeAsk, T0).is_empty());
            assert!(run(&mut p, GitMsg::MergeConfirm, T0).is_empty());
            assert!(p.view().pr.unwrap().dialog.is_none(), "{gate:?}");
        }
    }

    #[test]
    fn a_repository_with_no_allowed_method_cannot_merge() {
        let mut p = opened();
        open_pr(&mut p, detail(MergeGate::Ready, &[]));
        let v = p.view().pr.unwrap();
        assert!(!v.can_merge);
        assert_eq!(v.note, "This repository allows no merge method.");
        run(&mut p, GitMsg::MergeAsk, T0);
        assert!(p.view().pr.unwrap().dialog.is_none());
    }

    #[test]
    fn a_pull_request_that_turns_unmergeable_mid_dialog_is_refused_on_confirm() {
        let mut p = opened();
        open_pr(&mut p, detail(MergeGate::Ready, &[MergeMethod::Squash]));
        run(&mut p, GitMsg::MergeAsk, T0);
        // A refresh lands while the dialog is open.
        let fx = run(&mut p, GitMsg::Refresh, sec(1));
        let GitFx::Run(GitJob::PrDetail { req, .. }) = fx[0].clone() else {
            panic!();
        };
        run(
            &mut p,
            GitMsg::Done(GitDone::PrDetail {
                req,
                detail: Some(detail(MergeGate::Behind, &[MergeMethod::Squash])),
            }),
            sec(1),
        );
        assert!(run(&mut p, GitMsg::MergeConfirm, sec(1)).is_empty());
        assert!(p.view().pr.unwrap().dialog.is_none());
    }

    #[test]
    fn a_failed_merge_keeps_the_reason_and_refetches() {
        let mut p = opened();
        open_pr(&mut p, detail(MergeGate::Ready, &[MergeMethod::Squash]));
        run(&mut p, GitMsg::MergeAsk, T0);
        let fx = run(&mut p, GitMsg::MergeConfirm, T0);
        let GitFx::Run(GitJob::Merge { req, .. }) = fx[0].clone() else {
            panic!();
        };
        let fx = run(
            &mut p,
            GitMsg::Done(GitDone::Merge {
                req,
                result: Err("branch protection".into()),
            }),
            sec(2),
        );
        assert!(matches!(fx[0], GitFx::Run(GitJob::PrDetail { .. })));
        assert_eq!(p.view().pr.unwrap().note, "Merge failed: branch protection");
    }

    #[test]
    fn cancelling_or_going_back_closes_the_dialog_before_leaving_the_page() {
        let mut p = opened();
        open_pr(&mut p, detail(MergeGate::Ready, &[MergeMethod::Squash]));
        run(&mut p, GitMsg::MergeAsk, T0);
        run(&mut p, GitMsg::Back, T0);
        assert!(p.view().pr.unwrap().dialog.is_none());
        assert!(p.view().can_back);
        run(&mut p, GitMsg::MergeAsk, T0);
        run(&mut p, GitMsg::MergeCancel, T0);
        assert!(p.view().pr.unwrap().dialog.is_none());
        run(&mut p, GitMsg::Back, T0);
        assert!(!p.view().can_back);
    }

    #[test]
    fn review_changes_pushes_the_pull_request_diff() {
        let mut p = opened();
        open_pr(&mut p, detail(MergeGate::Ready, &[MergeMethod::Squash]));
        let fx = run(&mut p, GitMsg::ReviewPr, T0);
        let GitFx::Run(GitJob::PrDiff { req, number }) = fx[0].clone() else {
            panic!();
        };
        assert_eq!(number, 7);
        run(
            &mut p,
            GitMsg::Done(GitDone::PrDiff {
                req,
                result: Ok(vec![file("a.rs"), file("b.rs")]),
            }),
            T0,
        );
        let v = p.view();
        assert_eq!(v.title, "#7 title 7");
        assert_eq!(
            v.diff
                .iter()
                .filter(|l| l.kind == DiffLineKind::File)
                .count(),
            2
        );
        run(&mut p, GitMsg::Back, T0);
        assert!(p.view().pr.is_some());
    }

    #[test]
    fn only_openable_links_leave_the_panel() {
        let mut p = opened();
        assert!(run(&mut p, GitMsg::OpenLink("javascript:x".into()), T0).is_empty());
        assert_eq!(
            run(&mut p, GitMsg::OpenLink("https://example.test/".into()), T0),
            [GitFx::OpenUrl("https://example.test/".into())]
        );
        open_pr(&mut p, detail(MergeGate::Ready, &[MergeMethod::Squash]));
        assert_eq!(
            run(&mut p, GitMsg::OpenPr, T0),
            [GitFx::OpenUrl("https://example.test/pr/7".into())]
        );
        assert_eq!(
            run(&mut p, GitMsg::OpenCheck(0), T0),
            [GitFx::OpenUrl("https://example.test/lint".into())]
        );
        assert!(run(&mut p, GitMsg::OpenCheck(9), T0).is_empty());
    }

    #[test]
    fn the_list_refreshes_on_its_own_clock_and_never_while_a_diff_is_open() {
        let mut p = opened();
        assert!(run(&mut p, GitMsg::Tick, sec(14)).is_empty());
        assert!(matches!(
            run(&mut p, GitMsg::Tick, sec(15))[0],
            GitFx::Run(GitJob::Workspace { .. })
        ));
        // Not again while that one is in flight.
        assert!(run(&mut p, GitMsg::Tick, sec(40)).is_empty());
        let mut p = opened();
        run(&mut p, GitMsg::Row(0), T0);
        assert!(run(&mut p, GitMsg::Tick, sec(100)).is_empty());
    }

    #[test]
    fn the_pull_request_list_refreshes_every_minute() {
        let mut p = opened();
        run(&mut p, GitMsg::SetTab(GitTab::PullRequests), T0);
        assert!(run(&mut p, GitMsg::Tick, sec(30)).is_empty());
        assert!(!run(&mut p, GitMsg::Tick, sec(60)).is_empty());
    }

    #[test]
    fn a_pull_request_page_polls_only_while_something_is_pending() {
        let mut p = opened();
        let mut pending = detail(MergeGate::Ready, &[MergeMethod::Squash]);
        pending.checks[0].state = CheckState::Running;
        open_pr(&mut p, pending);
        assert!(run(&mut p, GitMsg::Tick, sec(5)).is_empty());
        assert!(matches!(
            run(&mut p, GitMsg::Tick, sec(10))[0],
            GitFx::Run(GitJob::PrDetail { .. })
        ));
        let mut p = opened();
        open_pr(&mut p, detail(MergeGate::Ready, &[MergeMethod::Squash]));
        assert!(run(&mut p, GitMsg::Tick, sec(100)).is_empty());
    }

    #[test]
    fn switching_session_resets_and_reloads() {
        let mut p = opened();
        let fx = p.handle(GitMsg::Tick, sec(1), Some("other"), true);
        assert!(matches!(fx[0], GitFx::Run(GitJob::Workspace { .. })));
        assert_eq!(p.view().rows.len(), 0);
        assert!(p.view().loading);
    }

    #[test]
    fn closing_hides_everything_and_ticks_do_nothing() {
        let mut p = opened();
        run(&mut p, GitMsg::Toggle, T0);
        assert_eq!(p.view(), GitView::default());
        assert!(run(&mut p, GitMsg::Tick, sec(100)).is_empty());
    }

    #[test]
    fn the_workspace_command_output_becomes_a_workspace() {
        let output = "diff --git a/a.rs b/a.rs\n@@ -1 +1 @@\n-a\n+b\n\u{1D}/repo\nmain\n\u{1D}abc\u{1F}s\u{1F}n\u{1F}5\u{1E}\u{1D}new.md\n\u{1D}[]\n__TETHER_RC__0";
        let ws = workspace_result(Ok(output.to_string())).unwrap();
        assert_eq!(ws.top, "/repo");
        assert_eq!(ws.branch, "main");
        assert_eq!(ws.files.len(), 1);
        assert_eq!(ws.untracked, ["new.md"]);
        assert_eq!(ws.commits.len(), 1);
        assert_eq!(ws.prs, PrList::List(vec![]));
    }

    #[test]
    fn a_directory_that_is_not_a_repository_is_an_error() {
        let out = format!(
            "{}\u{1D}\u{1D}\u{1D}\u{1D}\n__TETHER_RC__0",
            git::NOT_A_REPO
        );
        assert!(
            workspace_result(Ok(out))
                .unwrap_err()
                .contains("not a git repository")
        );
        assert_eq!(
            workspace_result(Err("timed out".into())),
            Err("timed out".into())
        );
        assert!(workspace_result(Ok("garbage".into())).is_err());
    }

    #[test]
    fn a_failed_command_surfaces_its_first_line() {
        assert_eq!(
            merge_result(Ok("GraphQL: not mergeable\nmore\n__TETHER_RC__1".into())),
            Err("GraphQL: not mergeable".into())
        );
        assert_eq!(merge_result(Ok("Merged\n__TETHER_RC__0".into())), Ok(()));
        assert_eq!(
            merge_result(Ok("\n__TETHER_RC__2".into())),
            Err("The command exited with status 2.".into())
        );
    }

    #[test]
    fn a_big_file_is_cut_on_a_character_boundary() {
        let text = format!("{}\u{e9}\n__TETHER_RC__0", "a".repeat(MARKDOWN_CAP - 1));
        let (cut, truncated) = markdown_result(Ok(text)).unwrap();
        assert!(truncated);
        assert_eq!(cut.len(), MARKDOWN_CAP - 1);
        assert_eq!(
            markdown_result(Ok("short\n__TETHER_RC__0".into())),
            Ok(("short".into(), false))
        );
    }

    #[test]
    fn commit_output_splits_into_message_and_files() {
        let out = "Body\n\u{1E}diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n__TETHER_RC__0";
        let (body, files) = commit_result(Ok(out.into())).unwrap();
        assert_eq!(body, "Body");
        assert_eq!(files[0].path, "x");
    }

    #[test]
    fn a_detail_the_host_could_not_produce_marks_the_page_unreadable() {
        let mut p = opened();
        run(&mut p, GitMsg::SetTab(GitTab::PullRequests), T0);
        let fx = run(&mut p, GitMsg::Row(0), T0);
        let GitFx::Run(GitJob::PrDetail { req, .. }) = fx[0].clone() else {
            panic!();
        };
        run(
            &mut p,
            GitMsg::Done(GitDone::PrDetail { req, detail: None }),
            T0,
        );
        assert_eq!(
            p.view().pr.unwrap().status,
            "Couldn't read this pull request from the host."
        );
        assert!(pr_detail_result(Ok("nope\n__TETHER_RC__1".into())).is_none());
    }
}
