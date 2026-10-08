//! Remote git and `gh` commands and the rules that read their output (iOS `GitRepositoryModel`,
//! `GitDiffModel`, `DiffFile`). Everything here is pure: commands are built as strings and
//! output is parsed from strings.

use serde::Deserialize;
use serde_json::Value;

use crate::zmx::shell_quote;

pub const NOT_A_REPO: &str = "__TETHER_NOTREPO__";
/// Emitted when `gh` is absent, so that is distinguishable from gh running and refusing.
pub const GH_MISSING: &str = "__TETHER_NO_GH__";
const RC_MARKER: &str = "\n__TETHER_RC__";
/// Larger patches are cut on the host: the list below is rendered row by row.
pub const PATCH_BYTE_CAP: usize = 2_000_000;

/// An absolute directory that is safe to put inside a quoted command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoDir(String);

impl RepoDir {
    pub fn new(path: &str) -> Option<Self> {
        let path = path.trim();
        (path.starts_with('/') && path.len() < 4096 && !path.chars().any(char::is_control))
            .then(|| Self(path.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    fn q(&self) -> String {
        shell_quote(&self.0)
    }
}

/// A short or full commit hash. Anything else never reaches a command line.
pub fn valid_commit_id(id: &str) -> bool {
    (4..=64).contains(&id.len()) && id.chars().all(|c| c.is_ascii_hexdigit())
}

/// A path inside the repository: no way out of it, no control characters.
pub fn valid_repo_relative(path: &str) -> bool {
    !path.is_empty()
        && path.len() < 4096
        && !path.starts_with('/')
        && !path.chars().any(char::is_control)
        && !path.split('/').any(|part| part == "..")
}

pub fn join_repo_path(top: &str, relative: &str) -> Option<String> {
    let top = RepoDir::new(top)?;
    valid_repo_relative(relative)
        .then(|| format!("{}/{relative}", top.as_str().trim_end_matches('/')))
}

/// The exec channel reports a non-zero exit as a failure and drops stdout with it. Running the
/// script in `sh -c` also keeps it independent of the login shell (fish rejects `{ }`).
pub fn wrap(script: &str) -> String {
    let inner = format!("{{ {script}\n}}; printf '\\n__TETHER_RC__%s' \"$?\"");
    format!("sh -c {}", shell_quote(&inner))
}

/// Splits the output of a `wrap`ped command into its text and exit status.
pub fn unwrap_output(output: &str) -> (String, Option<i32>) {
    match output.rfind(RC_MARKER) {
        Some(at) => {
            let rc = output[at + RC_MARKER.len()..].trim().parse().ok();
            (output[..at].to_owned(), rc)
        }
        None => (output.to_owned(), None),
    }
}

pub fn readlink_cwd_command(pid: i64) -> Option<String> {
    (pid > 0).then(|| format!("readlink /proc/{pid}/cwd 2>/dev/null"))
}

const PR_LIST_FIELDS: &str =
    "number,title,headRefName,baseRefName,url,isDraft,changedFiles,reviewDecision,state";

pub fn workspace_command(dir: &RepoDir) -> String {
    let q = dir.q();
    let missing = shell_quote(GH_MISSING);
    wrap(&format!(
        "if git -C {q} rev-parse --is-inside-work-tree >/dev/null 2>&1; then \
         if git -C {q} rev-parse --verify -q HEAD >/dev/null 2>&1; then base=HEAD; else base=; fi; \
         git -C {q} -c core.quotepath=off --no-pager diff --no-color --no-ext-diff $base 2>&1; printf '\\035'; \
         git -C {q} rev-parse --show-toplevel 2>/dev/null; git -C {q} branch --show-current 2>/dev/null; printf '\\035'; \
         git -C {q} --no-pager log -n 50 --format='%h%x1f%s%x1f%an%x1f%ct%x1e' 2>/dev/null; printf '\\035'; \
         git -C {q} -c core.quotepath=off ls-files --others --exclude-standard 2>/dev/null | head -n 200; printf '\\035'; \
         if command -v gh >/dev/null 2>&1; then (cd {q} && gh pr list --state all --limit 50 --json {PR_LIST_FIELDS} 2>&1); else printf '%s' {missing}; fi; \
         else printf '%s\\035\\035\\035\\035' {nr}; fi",
        nr = shell_quote(NOT_A_REPO),
    ))
}

pub fn docs_command(top: &RepoDir) -> String {
    wrap(&format!(
        "git -C {} -c core.quotepath=off ls-files --cached --others --exclude-standard -- '*.md' '*.markdown' 2>/dev/null | head -n 300",
        top.q()
    ))
}

pub fn commit_command(dir: &RepoDir, id: &str) -> Option<String> {
    valid_commit_id(id).then(|| {
        wrap(&format!(
            "git -C {} --no-pager show {} --patch --no-color --format=%b%x1e 2>&1 | head -c {PATCH_BYTE_CAP}",
            dir.q(),
            shell_quote(id)
        ))
    })
}

pub fn pr_detail_command(dir: &RepoDir, number: u64) -> String {
    wrap(&format!(
        "cd {} && {{ gh pr view {number} --json statusCheckRollup,body,mergeable,mergeStateStatus,isDraft,state 2>/dev/null; \
         printf '\\036'; gh repo view --json mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed 2>/dev/null; }}",
        dir.q()
    ))
}

pub fn pr_diff_command(dir: &RepoDir, number: u64) -> String {
    wrap(&format!(
        "cd {} && gh pr diff {number} --color never 2>&1 | head -c {PATCH_BYTE_CAP}",
        dir.q()
    ))
}

pub fn merge_command(dir: &RepoDir, number: u64, method: MergeMethod) -> String {
    wrap(&format!(
        "cd {} && gh pr merge {number} {} 2>&1",
        dir.q(),
        method.flag()
    ))
}

/// One byte past the cap tells the viewer the file was cut.
pub fn read_file_command(absolute: &str, cap: usize) -> Option<String> {
    let path = RepoDir::new(absolute)?;
    Some(wrap(&format!("head -c {} -- {}", cap + 1, path.q())))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitCommit {
    pub id: String,
    pub subject: String,
    pub author: String,
    pub timestamp: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrState {
    Open,
    Merged,
    Closed,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct PullRequest {
    pub number: u64,
    pub title: String,
    #[serde(rename = "headRefName")]
    pub head: String,
    #[serde(rename = "baseRefName")]
    pub base: String,
    pub url: String,
    #[serde(rename = "isDraft", default)]
    pub is_draft: bool,
    #[serde(rename = "changedFiles", default)]
    pub changed_files: u32,
    #[serde(rename = "reviewDecision", default)]
    pub review_decision: Option<String>,
    /// Absent from detail JSON and older list output; missing reads as open.
    #[serde(rename = "state", default)]
    pub raw_state: Option<String>,
}

impl PullRequest {
    pub fn state(&self) -> PrState {
        pr_state(self.raw_state.as_deref().unwrap_or(""))
    }
}

fn pr_state(raw: &str) -> PrState {
    match raw.to_ascii_uppercase().as_str() {
        "MERGED" => PrState::Merged,
        "CLOSED" => PrState::Closed,
        _ => PrState::Open,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PrList {
    List(Vec<PullRequest>),
    ToolMissing,
    Failed(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckState {
    Passed,
    Failed,
    Running,
    Skipped,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitCheck {
    pub name: String,
    pub state: CheckState,
    pub url: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MergeGate {
    Ready,
    Blocked,
    Behind,
    Conflicted,
    Draft,
    Computing,
}

impl MergeGate {
    pub fn can_merge(self) -> bool {
        self == Self::Ready
    }

    pub fn reason(self) -> &'static str {
        match self {
            Self::Ready => "Ready to merge",
            Self::Blocked => "A required review or check is missing",
            Self::Behind => "Out of date with the base branch",
            Self::Conflicted => "Conflicts with the base branch",
            Self::Draft => "Still a draft",
            Self::Computing => "Checking mergeability\u{2026}",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MergeMethod {
    Merge,
    Squash,
    Rebase,
}

impl MergeMethod {
    pub fn flag(self) -> &'static str {
        match self {
            Self::Merge => "--merge",
            Self::Squash => "--squash",
            Self::Rebase => "--rebase",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Merge => "Create a merge commit",
            Self::Squash => "Squash and merge",
            Self::Rebase => "Rebase and merge",
        }
    }
}

/// Squash is the common answer; otherwise whatever the repository allows.
pub fn default_method(methods: &[MergeMethod]) -> Option<MergeMethod> {
    methods
        .contains(&MergeMethod::Squash)
        .then_some(MergeMethod::Squash)
        .or_else(|| methods.first().copied())
}

/// The sections of the workspace command; `None` when the output is not five sections.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceSections<'a> {
    pub diff: &'a str,
    pub location: &'a str,
    pub commits: &'a str,
    pub untracked: &'a str,
    pub pull_requests: &'a str,
}

/// The outer separator is 0x1d, not 0x1e: commit records already end in 0x1e.
pub fn workspace_sections(output: &str) -> Option<WorkspaceSections<'_>> {
    let parts: Vec<&str> = output.split('\u{1D}').collect();
    let [diff, location, commits, untracked, pull_requests] = parts.as_slice() else {
        return None;
    };
    Some(WorkspaceSections {
        diff,
        location,
        commits,
        untracked,
        pull_requests,
    })
}

/// First line: the repository root. Second: the branch, empty when HEAD is detached.
pub fn parse_location(section: &str) -> (String, String) {
    let mut lines = section.lines().map(str::trim);
    let top = lines.next().unwrap_or("").to_owned();
    let branch = lines.next().unwrap_or("").to_owned();
    (top, branch)
}

pub fn parse_commits(output: &str) -> Vec<GitCommit> {
    output
        .split('\u{1E}')
        .filter_map(|record| {
            let fields: Vec<&str> = record.split('\u{1F}').collect();
            let [id, subject, author, timestamp] = fields.as_slice() else {
                return None;
            };
            Some(GitCommit {
                id: id.trim_start_matches('\n').to_owned(),
                subject: (*subject).to_owned(),
                author: (*author).to_owned(),
                timestamp: timestamp.trim().parse().ok()?,
            })
        })
        .collect()
}

pub fn parse_untracked(section: &str) -> Vec<String> {
    section
        .lines()
        .map(str::trim_end)
        .filter(|l| !l.is_empty())
        .map(str::to_owned)
        .collect()
}

pub fn parse_pull_requests(output: &str) -> Result<Vec<PullRequest>, serde_json::Error> {
    serde_json::from_str(output)
}

/// "None open" and "could not ask" are different answers; never collapse both into an empty list.
pub fn pull_request_result(output: &str) -> PrList {
    let trimmed = output.trim();
    if trimmed == GH_MISSING {
        return PrList::ToolMissing;
    }
    // The list fetches every state so merged ones show; closed-without-merge is noise.
    if let Ok(pulls) = parse_pull_requests(trimmed) {
        return PrList::List(
            pulls
                .into_iter()
                .filter(|p| p.state() != PrState::Closed)
                .collect(),
        );
    }
    // gh puts its reason on the first line.
    PrList::Failed(trimmed.lines().next().unwrap_or(trimmed).to_owned())
}

pub fn parse_checks(json: &str) -> Vec<GitCheck> {
    let Ok(Value::Array(entries)) = serde_json::from_str::<Value>(json) else {
        return Vec::new();
    };
    checks_from(&entries)
}

fn checks_from(entries: &[Value]) -> Vec<GitCheck> {
    let text = |entry: &Value, key: &str| entry.get(key).and_then(Value::as_str).map(str::to_owned);
    entries
        .iter()
        .filter_map(|entry| {
            let name = text(entry, "name")
                .or_else(|| text(entry, "context"))
                .filter(|n| !n.is_empty())?;
            let url = text(entry, "detailsUrl")
                .or_else(|| text(entry, "targetUrl"))
                .unwrap_or_default();
            Some(GitCheck {
                name,
                state: check_state(entry),
                url,
            })
        })
        .collect()
}

fn check_state(entry: &Value) -> CheckState {
    let text = |key: &str| entry.get(key).and_then(Value::as_str);
    // A StatusContext carries only `state`; a CheckRun is running until its `status`
    // completes, and only then does `conclusion` mean anything.
    let verdict = text("conclusion")
        .or_else(|| text("state"))
        .unwrap_or("")
        .to_ascii_uppercase();
    if text("status").is_some_and(|s| !s.eq_ignore_ascii_case("COMPLETED")) {
        return CheckState::Running;
    }
    match verdict.as_str() {
        "" | "PENDING" | "QUEUED" | "IN_PROGRESS" | "EXPECTED" => CheckState::Running,
        "SUCCESS" => CheckState::Passed,
        "SKIPPED" | "NEUTRAL" => CheckState::Skipped,
        _ => CheckState::Failed,
    }
}

pub fn is_running(checks: &[GitCheck]) -> bool {
    checks.iter().any(|c| c.state == CheckState::Running)
}

pub fn rollup(checks: &[GitCheck]) -> Option<CheckState> {
    if checks.is_empty() {
        return None;
    }
    let any = |s| checks.iter().any(|c| c.state == s);
    Some(if any(CheckState::Failed) {
        CheckState::Failed
    } else if any(CheckState::Running) {
        CheckState::Running
    } else {
        CheckState::Passed
    })
}

pub fn check_headline(checks: &[GitCheck]) -> String {
    let count = |s| checks.iter().filter(|c| c.state == s).count();
    match rollup(checks) {
        None => "No checks".into(),
        Some(CheckState::Failed) => format!("{} failing", count(CheckState::Failed)),
        Some(CheckState::Running) => {
            format!("{} of {} running", count(CheckState::Running), checks.len())
        }
        Some(_) => format!(
            "{} check{} passed",
            checks.len(),
            if checks.len() == 1 { "" } else { "s" }
        ),
    }
}

pub fn merge_gate(output: &str) -> MergeGate {
    let Ok(object) = serde_json::from_str::<Value>(output) else {
        return MergeGate::Computing;
    };
    let upper = |key: &str| {
        object
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_ascii_uppercase()
    };
    let (mergeable, status) = (upper("mergeable"), upper("mergeStateStatus"));
    let is_draft = object
        .get("isDraft")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    // GitHub folds drafts and conflicts into BLOCKED under branch protection.
    if is_draft || status == "DRAFT" {
        MergeGate::Draft
    } else if mergeable == "CONFLICTING" || status == "DIRTY" {
        MergeGate::Conflicted
    } else if mergeable == "UNKNOWN" || status == "UNKNOWN" || status.is_empty() {
        MergeGate::Computing
    } else if status == "BEHIND" {
        MergeGate::Behind
    } else if status == "BLOCKED" {
        MergeGate::Blocked
    } else {
        MergeGate::Ready
    }
}

pub fn allowed_merge_methods(output: &str) -> Vec<MergeMethod> {
    let Ok(object) = serde_json::from_str::<Value>(output) else {
        return Vec::new();
    };
    [
        ("mergeCommitAllowed", MergeMethod::Merge),
        ("squashMergeAllowed", MergeMethod::Squash),
        ("rebaseMergeAllowed", MergeMethod::Rebase),
    ]
    .into_iter()
    .filter(|(key, _)| object.get(*key).and_then(Value::as_bool) == Some(true))
    .map(|(_, method)| method)
    .collect()
}

/// Checks, mergeability and allowed methods of one pull request, from `pr_detail_command`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrDetail {
    pub checks: Vec<GitCheck>,
    pub gate: MergeGate,
    pub methods: Vec<MergeMethod>,
    pub state: PrState,
}

impl PrDetail {
    pub fn merged(&self) -> bool {
        self.state == PrState::Merged
    }

    pub fn can_merge(&self) -> bool {
        self.state == PrState::Open && self.gate.can_merge() && !self.methods.is_empty()
    }

    pub fn settled(&self) -> bool {
        !is_running(&self.checks) && self.gate != MergeGate::Computing
    }

    pub fn marked_merged(&self) -> Self {
        Self {
            state: PrState::Merged,
            ..self.clone()
        }
    }
}

pub fn parse_pr_detail(output: &str) -> Option<PrDetail> {
    let (pr, repo) = output.split_once('\u{1E}').unwrap_or((output, ""));
    let object: Value = serde_json::from_str(pr).ok()?;
    let checks = object
        .get("statusCheckRollup")
        .and_then(Value::as_array)
        .map(|entries| checks_from(entries))
        .unwrap_or_default();
    Some(PrDetail {
        checks,
        gate: merge_gate(pr),
        methods: allowed_merge_methods(repo),
        state: pr_state(object.get("state").and_then(Value::as_str).unwrap_or("")),
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineKind {
    FileHeader,
    Hunk,
    Added,
    Removed,
    Context,
}

pub fn classify(diff: &str) -> Vec<(LineKind, &str)> {
    if diff.is_empty() {
        return Vec::new();
    }
    diff.split('\n').map(|raw| (line_kind(raw), raw)).collect()
}

fn line_kind(line: &str) -> LineKind {
    const HEADERS: [&str; 10] = [
        "diff ",
        "index ",
        "--- ",
        "+++ ",
        "new file",
        "deleted file",
        "rename ",
        "similarity ",
        "old mode ",
        "new mode ",
    ];
    if HEADERS.iter().any(|h| line.starts_with(h)) {
        LineKind::FileHeader
    } else if line.starts_with("@@") {
        LineKind::Hunk
    } else if line.starts_with('+') {
        LineKind::Added
    } else if line.starts_with('-') {
        LineKind::Removed
    } else {
        LineKind::Context
    }
}

/// Splits `git show --format=%b%x1e` into message and patch. Without the marker git separates
/// them with a bare `---`, which the classifier would read as a deletion.
pub fn commit_show(output: &str) -> (String, String) {
    let Some(marker) = output.find('\u{1E}') else {
        return (String::new(), output.to_owned());
    };
    let patch = output[marker + 1..].trim_start_matches('\n');
    (output[..marker].trim().to_owned(), patch.to_owned())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RowKind {
    Context,
    Added,
    Removed,
    Hunk,
    Plain,
}

/// One line of a patch, with the numbers git only states once per hunk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffRow {
    pub kind: RowKind,
    /// The whole `@@ -a,b +c,d @@ context` line, for hunk rows only.
    pub header: String,
    pub old_line: Option<u32>,
    pub new_line: Option<u32>,
    /// The marker is dropped: the gutter carries it instead of a character.
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffFile {
    pub path: String,
    pub added: u32,
    pub removed: u32,
    pub rows: Vec<DiffRow>,
}

impl DiffFile {
    /// `git show` prints a message and a stat block before the first file.
    pub fn is_preamble(&self) -> bool {
        self.path.is_empty()
    }
}

fn drop_first(s: &str) -> &str {
    s.chars().next().map_or("", |c| &s[c.len_utf8()..])
}

pub fn group_diff(patch: &str) -> Vec<DiffFile> {
    let mut files = Vec::new();
    let mut path = String::new();
    let mut rows: Vec<DiffRow> = Vec::new();
    let (mut added, mut removed) = (0u32, 0u32);
    let (mut old_line, mut new_line) = (0u32, 0u32);

    let flush = |files: &mut Vec<DiffFile>,
                 path: &str,
                 rows: &mut Vec<DiffRow>,
                 added: &mut u32,
                 removed: &mut u32| {
        if !rows.is_empty() || !path.is_empty() {
            files.push(DiffFile {
                path: path.to_owned(),
                added: *added,
                removed: *removed,
                rows: std::mem::take(rows),
            });
        }
        *added = 0;
        *removed = 0;
    };

    for (kind, text) in classify(patch) {
        if text.starts_with("diff --git ") {
            flush(&mut files, &path, &mut rows, &mut added, &mut removed);
            path = new_path(text);
            continue;
        }
        if kind == LineKind::FileHeader {
            continue;
        }
        let row = |kind, old_line, new_line, text: &str| DiffRow {
            kind,
            header: String::new(),
            old_line,
            new_line,
            text: text.to_owned(),
        };
        // Neither is a line of either file: they take no number and keep their words.
        if !path.is_empty() && (text.starts_with("Binary files ") || text.starts_with('\\')) {
            rows.push(row(RowKind::Plain, None, None, text));
            continue;
        }
        match kind {
            LineKind::Hunk => {
                (old_line, new_line) = hunk_start(text);
                let mut hunk = row(RowKind::Hunk, None, None, &hunk_context(text));
                hunk.header = text.trim_end().to_owned();
                rows.push(hunk);
            }
            LineKind::Added => {
                added += 1;
                rows.push(row(RowKind::Added, None, Some(new_line), drop_first(text)));
                new_line += 1;
            }
            LineKind::Removed => {
                removed += 1;
                rows.push(row(
                    RowKind::Removed,
                    Some(old_line),
                    None,
                    drop_first(text),
                ));
                old_line += 1;
            }
            LineKind::Context if !path.is_empty() => {
                rows.push(row(
                    RowKind::Context,
                    Some(old_line),
                    Some(new_line),
                    drop_first(text),
                ));
                old_line += 1;
                new_line += 1;
            }
            _ => rows.push(row(RowKind::Plain, None, None, text)),
        }
    }
    flush(&mut files, &path, &mut rows, &mut added, &mut removed);
    files.retain(|f| !f.rows.is_empty());
    files
}

pub fn diff_stat(files: &[DiffFile]) -> (u32, u32) {
    files
        .iter()
        .fold((0, 0), |(a, r), f| (a + f.added, r + f.removed))
}

fn new_path(header: &str) -> String {
    header
        .find(" b/")
        .map_or(header, |at| &header[at + 3..])
        .to_owned()
}

fn hunk_start(header: &str) -> (u32, u32) {
    let parts: Vec<&str> = header.split(' ').filter(|p| !p.is_empty()).collect();
    let number = |prefix: char| {
        parts
            .iter()
            .find(|p| p.starts_with(prefix))
            .map(|token| {
                token[1..]
                    .chars()
                    .take_while(char::is_ascii_digit)
                    .collect::<String>()
                    .parse()
                    .unwrap_or(1)
            })
            .unwrap_or(1)
    };
    (number('-'), number('+'))
}

fn hunk_context(header: &str) -> String {
    header
        .split("@@")
        .nth(2)
        .map(|c| c.trim().to_owned())
        .unwrap_or_default()
}

/// The first line of a failed command's output, for a one-line notice.
pub fn first_line(output: &str) -> String {
    output
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("")
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    const PATCH: &str = "diff --git a/Sources/App.swift b/Sources/App.swift\n\
index 8de5128..bae5af6 100644\n\
--- a/Sources/App.swift\n\
+++ b/Sources/App.swift\n\
@@ -12,6 +12,7 @@ struct App {\n\
\x20  let a = 1\n\
-  let b = 2\n\
+  let b = 3\n\
+  let c = 4\n\
\x20  let d = 5\n\
diff --git a/README.md b/README.md\n\
--- a/README.md\n\
+++ b/README.md\n\
@@ -1,2 +1,1 @@\n\
-old\n\
\x20kept";

    fn code(file: &DiffFile) -> Vec<&DiffRow> {
        file.rows
            .iter()
            .filter(|r| r.kind != RowKind::Hunk)
            .collect()
    }

    #[test]
    fn splits_the_patch_into_files_named_by_their_new_path() {
        let files = group_diff(PATCH);
        let paths: Vec<_> = files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, ["Sources/App.swift", "README.md"]);
    }

    #[test]
    fn counts_additions_and_removals_per_file() {
        let files = group_diff(PATCH);
        assert_eq!((files[0].added, files[0].removed), (2, 1));
        assert_eq!((files[1].added, files[1].removed), (0, 1));
        assert_eq!(diff_stat(&files), (2, 2));
    }

    #[test]
    fn numbers_lines_from_the_hunk_header() {
        let files = group_diff(PATCH);
        let rows = code(&files[0]);
        let old: Vec<_> = rows.iter().map(|r| r.old_line).collect();
        let new: Vec<_> = rows.iter().map(|r| r.new_line).collect();
        assert_eq!(old, [Some(12), Some(13), None, None, Some(14)]);
        assert_eq!(new, [Some(12), None, Some(13), Some(14), Some(15)]);
    }

    #[test]
    fn strips_the_marker_and_keeps_only_the_hunk_context() {
        let files = group_diff(PATCH);
        let find = |k| files[0].rows.iter().find(|r| r.kind == k).unwrap();
        assert_eq!(find(RowKind::Added).text, "  let b = 3");
        assert_eq!(find(RowKind::Removed).text, "  let b = 2");
        assert_eq!(find(RowKind::Hunk).text, "struct App {");
        assert_eq!(find(RowKind::Hunk).header, "@@ -12,6 +12,7 @@ struct App {");
    }

    #[test]
    fn index_and_path_headers_are_not_rows() {
        let files = group_diff(PATCH);
        for row in &files[0].rows {
            assert!(!row.text.starts_with("index "));
            assert!(!row.text.starts_with("+++ "));
            assert!(!row.text.starts_with("--- "));
        }
    }

    #[test]
    fn anything_before_the_first_file_is_kept_as_a_preamble() {
        let out = "Fix the thing\n\n Sources/App.swift | 2 +-\n 1 file changed\n\n\
diff --git a/Sources/App.swift b/Sources/App.swift\n@@ -1,1 +1,1 @@\n-a\n+b";
        let files = group_diff(out);
        assert_eq!(files.len(), 2);
        assert!(files[0].is_preamble());
        assert!(
            files[0]
                .rows
                .iter()
                .any(|r| r.text.contains("Fix the thing"))
        );
        assert_eq!(files[1].path, "Sources/App.swift");
    }

    #[test]
    fn empty_input_has_no_files() {
        assert!(group_diff("").is_empty());
    }

    #[test]
    fn a_mode_change_header_is_classified_not_matched_by_name() {
        let files =
            group_diff("diff --git a/x b/x\nold mode 100644\nnew mode 100755\n@@ -1 +1 @@\n-a\n+b");
        assert_eq!(files.len(), 1);
        assert!(files[0].rows.iter().all(|r| !r.text.contains("mode 100")));
        let removed: Vec<_> = files[0]
            .rows
            .iter()
            .filter(|r| r.kind == RowKind::Removed)
            .map(|r| r.text.as_str())
            .collect();
        assert_eq!(removed, ["a"]);
    }

    #[test]
    fn plus_minus_file_headers_are_not_added_or_removed() {
        let kinds: Vec<_> = classify("--- a/x\n+++ b/x").iter().map(|l| l.0).collect();
        assert_eq!(kinds, [LineKind::FileHeader, LineKind::FileHeader]);
    }

    #[test]
    fn classifies_each_line_of_a_unified_diff() {
        let diff = "diff --git a/foo.txt b/foo.txt\nindex 1234567..89abcde 100644\n--- a/foo.txt\n+++ b/foo.txt\n@@ -1,3 +1,3 @@ context header\n unchanged line\n-removed line\n+added line";
        let kinds: Vec<_> = classify(diff).iter().map(|l| l.0).collect();
        use LineKind::*;
        assert_eq!(
            kinds,
            [
                FileHeader, FileHeader, FileHeader, FileHeader, Hunk, Context, Removed, Added
            ]
        );
    }

    #[test]
    fn a_binary_change_and_a_missing_newline_note_are_plain_rows() {
        let files = group_diff(
            "diff --git a/i.png b/i.png\nBinary files a/i.png and b/i.png differ\ndiff --git a/t b/t\n@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b",
        );
        assert_eq!(files[0].path, "i.png");
        assert_eq!(files[0].rows[0].kind, RowKind::Plain);
        assert!(files[0].rows[0].text.starts_with("Binary files"));
        let rows = &files[1].rows;
        assert_eq!(rows[2].kind, RowKind::Plain);
        assert_eq!(rows[3].new_line, Some(1));
    }

    #[test]
    fn a_commit_show_is_split_into_its_message_and_its_patch() {
        let out = "Rework the thing.\n\nA second paragraph.\n\u{1E}diff --git a/foo.txt b/foo.txt\n--- a/foo.txt\n+++ b/foo.txt\n@@ -1 +1 @@\n-old\n+new";
        let (body, patch) = commit_show(out);
        assert_eq!(body, "Rework the thing.\n\nA second paragraph.");
        assert!(patch.starts_with("diff --git "));
        assert!(!patch.contains("Rework"));
    }

    #[test]
    fn an_empty_commit_message_leaves_no_stray_lines() {
        let (body, patch) = commit_show("\u{1E}diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b");
        assert_eq!(body, "");
        let kinds: Vec<_> = classify(&patch).iter().map(|l| l.0).collect();
        assert_eq!(
            kinds,
            [
                LineKind::FileHeader,
                LineKind::Hunk,
                LineKind::Removed,
                LineKind::Added
            ]
        );
    }

    #[test]
    fn output_without_the_marker_is_all_patch() {
        let (body, patch) = commit_show("diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b");
        assert_eq!(body, "");
        assert!(patch.starts_with("diff --git "));
    }

    #[test]
    fn parses_branch_location_and_commits() {
        assert_eq!(
            parse_location("/repo\nfeat/x\n"),
            ("/repo".into(), "feat/x".into())
        );
        assert_eq!(parse_location("/repo\n"), ("/repo".into(), String::new()));
        let commits = parse_commits("abc123\u{1F}Add workspace\u{1F}Sam\u{1F}1727000000\u{1E}");
        assert_eq!(
            commits,
            [GitCommit {
                id: "abc123".into(),
                subject: "Add workspace".into(),
                author: "Sam".into(),
                timestamp: 1_727_000_000
            }]
        );
    }

    #[test]
    fn one_command_carries_all_five_sections() {
        let out =
            "PATCH\u{1D}/r\nfeat/x\n\u{1D}abc\u{1F}s\u{1F}a\u{1F}1\u{1E}\u{1D}new.txt\n\u{1D}[]";
        let s = workspace_sections(out).unwrap();
        assert_eq!(s.diff, "PATCH");
        assert_eq!(s.location, "/r\nfeat/x\n");
        assert_eq!(s.commits, "abc\u{1F}s\u{1F}a\u{1F}1\u{1E}");
        assert_eq!(parse_untracked(s.untracked), ["new.txt"]);
        assert_eq!(s.pull_requests, "[]");
        assert!(workspace_sections("only\u{1D}two").is_none());
    }

    #[test]
    fn a_record_separator_inside_a_section_does_not_split_it() {
        let commits = "a\u{1F}s\u{1F}n\u{1F}1\u{1E}b\u{1F}t\u{1F}n\u{1F}2\u{1E}";
        let out = format!("+a\u{1E}b\u{1D}/r\nmain\n\u{1D}{commits}\u{1D}\u{1D}[]");
        let s = workspace_sections(&out).unwrap();
        assert_eq!(s.diff, "+a\u{1E}b");
        assert_eq!(s.commits, commits);
        assert_eq!(parse_commits(s.commits).len(), 2);
    }

    #[test]
    fn the_not_a_repo_branch_still_yields_five_sections() {
        let out = format!("{NOT_A_REPO}\u{1D}\u{1D}\u{1D}\u{1D}");
        assert_eq!(workspace_sections(&out).unwrap().diff, NOT_A_REPO);
    }

    fn pr_json(number: u32, state: Option<&str>, draft: bool) -> String {
        let state = state.map_or(String::new(), |s| format!(",\"state\":\"{s}\""));
        format!(
            "{{\"number\":{number},\"title\":\"t\",\"headRefName\":\"h\",\"baseRefName\":\"main\",\"url\":\"u\",\"isDraft\":{draft},\"changedFiles\":1,\"reviewDecision\":null{state}}}"
        )
    }

    #[test]
    fn parses_pull_requests_from_gh_json() {
        let json = "[{\"number\":196,\"title\":\"Native interactions\",\"headRefName\":\"feat/native\",\"baseRefName\":\"main\",\"url\":\"https://example.test/pr/196\",\"isDraft\":false,\"changedFiles\":12,\"reviewDecision\":\"REVIEW_REQUIRED\"}]";
        let pulls = parse_pull_requests(json).unwrap();
        assert_eq!(
            pulls,
            [PullRequest {
                number: 196,
                title: "Native interactions".into(),
                head: "feat/native".into(),
                base: "main".into(),
                url: "https://example.test/pr/196".into(),
                is_draft: false,
                changed_files: 12,
                review_decision: Some("REVIEW_REQUIRED".into()),
                raw_state: None,
            }]
        );
        assert_eq!(pulls[0].state(), PrState::Open);
    }

    #[test]
    fn an_empty_list_means_there_are_no_pull_requests() {
        assert_eq!(pull_request_result("[]"), PrList::List(vec![]));
        assert_eq!(pull_request_result("  []\n"), PrList::List(vec![]));
    }

    #[test]
    fn a_missing_github_cli_is_reported_as_such() {
        assert_eq!(pull_request_result(GH_MISSING), PrList::ToolMissing);
    }

    #[test]
    fn anything_else_is_carried_back_as_the_reason_it_failed() {
        assert_eq!(
            pull_request_result("gh: set the GH_TOKEN environment variable.\n"),
            PrList::Failed("gh: set the GH_TOKEN environment variable.".into())
        );
        assert_eq!(
            pull_request_result("failed to run git: fatal: not a git repository\nsecond\n"),
            PrList::Failed("failed to run git: fatal: not a git repository".into())
        );
    }

    #[test]
    fn the_list_keeps_open_and_merged_and_drops_closed() {
        let json = format!(
            "[{},{},{}]",
            pr_json(1, Some("OPEN"), false),
            pr_json(2, Some("MERGED"), false),
            pr_json(3, Some("CLOSED"), false)
        );
        let PrList::List(pulls) = pull_request_result(&json) else {
            panic!("expected a list");
        };
        let numbers: Vec<_> = pulls.iter().map(|p| p.number).collect();
        assert_eq!(numbers, [1, 2]);
        assert_eq!(pulls[1].state(), PrState::Merged);
    }

    #[test]
    fn a_pull_request_without_a_state_field_is_open() {
        let pulls = parse_pull_requests(&format!("[{}]", pr_json(1, None, true))).unwrap();
        assert_eq!(pulls[0].state(), PrState::Open);
        assert!(pulls[0].is_draft);
    }

    #[test]
    fn parses_check_runs_with_their_state_and_link() {
        let json = r#"[{"__typename":"CheckRun","name":"lint","status":"COMPLETED","conclusion":"SUCCESS","detailsUrl":"https://example.test/lint"},
 {"__typename":"CheckRun","name":"ios-build","status":"IN_PROGRESS","conclusion":"","detailsUrl":"https://example.test/ios"},
 {"__typename":"CheckRun","name":"flaky","status":"COMPLETED","conclusion":"FAILURE","detailsUrl":"https://example.test/flaky"}]"#;
        let checks = parse_checks(json);
        let names: Vec<_> = checks.iter().map(|c| c.name.as_str()).collect();
        let states: Vec<_> = checks.iter().map(|c| c.state).collect();
        assert_eq!(names, ["lint", "ios-build", "flaky"]);
        assert_eq!(
            states,
            [CheckState::Passed, CheckState::Running, CheckState::Failed]
        );
        assert_eq!(checks[0].url, "https://example.test/lint");
    }

    #[test]
    fn parses_the_older_status_context_shape_too() {
        let json = r#"[{"__typename":"StatusContext","context":"ci/external","state":"SUCCESS","targetUrl":"https://example.test/ext"}]"#;
        let checks = parse_checks(json);
        assert_eq!(checks[0].name, "ci/external");
        assert_eq!(checks[0].state, CheckState::Passed);
        assert_eq!(checks[0].url, "https://example.test/ext");
    }

    #[test]
    fn skipped_and_neutral_runs_are_not_failures() {
        let json = r#"[{"name":"optional","status":"COMPLETED","conclusion":"SKIPPED","detailsUrl":""},
 {"name":"advisory","status":"COMPLETED","conclusion":"NEUTRAL","detailsUrl":""}]"#;
        let states: Vec<_> = parse_checks(json).iter().map(|c| c.state).collect();
        assert_eq!(states, [CheckState::Skipped, CheckState::Skipped]);
    }

    #[test]
    fn unreadable_output_yields_no_checks() {
        assert!(parse_checks("not json").is_empty());
        assert!(parse_checks("[]").is_empty());
    }

    fn check(state: CheckState) -> GitCheck {
        GitCheck {
            name: "c".into(),
            state,
            url: String::new(),
        }
    }

    #[test]
    fn a_pipeline_is_running_until_every_check_settles() {
        assert!(is_running(&[
            check(CheckState::Running),
            check(CheckState::Passed)
        ]));
        assert!(!is_running(&[check(CheckState::Failed)]));
        assert!(!is_running(&[]));
    }

    #[test]
    fn the_headline_names_what_matters_first() {
        use CheckState::*;
        assert_eq!(check_headline(&[]), "No checks");
        assert_eq!(
            check_headline(&[check(Passed), check(Passed)]),
            "2 checks passed"
        );
        assert_eq!(check_headline(&[check(Passed)]), "1 check passed");
        assert_eq!(check_headline(&[check(Failed), check(Passed)]), "1 failing");
        assert_eq!(
            check_headline(&[check(Failed), check(Running)]),
            "1 failing"
        );
        assert_eq!(
            check_headline(&[check(Running), check(Passed)]),
            "1 of 2 running"
        );
    }

    #[test]
    fn the_rollup_is_the_worst_state() {
        use CheckState::*;
        assert_eq!(
            rollup(&[check(Passed), check(Running), check(Failed)]),
            Some(Failed)
        );
        assert_eq!(rollup(&[check(Passed), check(Running)]), Some(Running));
        assert_eq!(rollup(&[check(Passed)]), Some(Passed));
        assert_eq!(rollup(&[]), None);
    }

    fn gate(status: &str, mergeable: &str, draft: bool) -> MergeGate {
        merge_gate(&format!(
            "{{\"mergeable\":\"{mergeable}\",\"mergeStateStatus\":\"{status}\",\"isDraft\":{draft}}}"
        ))
    }

    #[test]
    fn github_says_the_pull_request_can_merge() {
        for status in ["CLEAN", "UNSTABLE", "HAS_HOOKS"] {
            assert_eq!(
                gate(status, "MERGEABLE", false),
                MergeGate::Ready,
                "{status}"
            );
        }
        assert!(MergeGate::Ready.can_merge());
    }

    #[test]
    fn each_refusal_keeps_the_reason_github_gave() {
        assert_eq!(gate("BLOCKED", "MERGEABLE", false), MergeGate::Blocked);
        assert_eq!(gate("BEHIND", "MERGEABLE", false), MergeGate::Behind);
        assert_eq!(gate("DIRTY", "MERGEABLE", false), MergeGate::Conflicted);
        assert_eq!(gate("DRAFT", "MERGEABLE", false), MergeGate::Draft);
        for g in [
            MergeGate::Blocked,
            MergeGate::Behind,
            MergeGate::Conflicted,
            MergeGate::Draft,
            MergeGate::Computing,
        ] {
            assert!(!g.can_merge());
            assert!(!g.reason().is_empty());
        }
    }

    #[test]
    fn a_conflict_outranks_blocked_and_a_draft_outranks_everything() {
        assert_eq!(gate("BLOCKED", "CONFLICTING", false), MergeGate::Conflicted);
        assert_eq!(gate("BLOCKED", "MERGEABLE", true), MergeGate::Draft);
        assert_eq!(gate("BEHIND", "MERGEABLE", true), MergeGate::Draft);
    }

    #[test]
    fn an_undecided_github_never_allows_a_merge() {
        assert_eq!(gate("UNKNOWN", "MERGEABLE", false), MergeGate::Computing);
        assert_eq!(gate("CLEAN", "UNKNOWN", false), MergeGate::Computing);
        assert_eq!(merge_gate("not json"), MergeGate::Computing);
        assert_eq!(merge_gate("{}"), MergeGate::Computing);
        assert_eq!(MergeGate::Ready.reason(), "Ready to merge");
    }

    #[test]
    fn only_the_methods_the_repository_allows_are_offered() {
        let json =
            r#"{"mergeCommitAllowed":false,"squashMergeAllowed":true,"rebaseMergeAllowed":true}"#;
        assert_eq!(
            allowed_merge_methods(json),
            [MergeMethod::Squash, MergeMethod::Rebase]
        );
        let all =
            r#"{"mergeCommitAllowed":true,"squashMergeAllowed":true,"rebaseMergeAllowed":true}"#;
        assert_eq!(
            allowed_merge_methods(all),
            [MergeMethod::Merge, MergeMethod::Squash, MergeMethod::Rebase]
        );
        assert!(allowed_merge_methods("gh: not found").is_empty());
        assert!(
            allowed_merge_methods(
                r#"{"mergeCommitAllowed":false,"squashMergeAllowed":false,"rebaseMergeAllowed":false}"#
            )
            .is_empty()
        );
    }

    #[test]
    fn each_method_carries_its_flag_and_a_label() {
        assert_eq!(MergeMethod::Merge.flag(), "--merge");
        assert_eq!(MergeMethod::Squash.flag(), "--squash");
        assert_eq!(MergeMethod::Rebase.flag(), "--rebase");
        assert_eq!(MergeMethod::Squash.label(), "Squash and merge");
        assert_eq!(
            default_method(&[MergeMethod::Merge, MergeMethod::Squash]),
            Some(MergeMethod::Squash)
        );
        assert_eq!(
            default_method(&[MergeMethod::Rebase]),
            Some(MergeMethod::Rebase)
        );
        assert_eq!(default_method(&[]), None);
    }

    #[test]
    fn the_detail_reads_checks_gate_methods_and_state() {
        let pr = r#"{"statusCheckRollup":[{"name":"lint","status":"COMPLETED","conclusion":"SUCCESS","detailsUrl":"u"}],"mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","isDraft":false,"state":"OPEN","body":"x"}"#;
        let repo =
            r#"{"mergeCommitAllowed":false,"squashMergeAllowed":true,"rebaseMergeAllowed":false}"#;
        let detail = parse_pr_detail(&format!("{pr}\u{1E}{repo}")).unwrap();
        assert_eq!(detail.checks.len(), 1);
        assert_eq!(detail.gate, MergeGate::Ready);
        assert_eq!(detail.methods, [MergeMethod::Squash]);
        assert!(detail.can_merge());
        assert!(detail.settled());
        assert!(detail.marked_merged().merged());
        assert!(!detail.marked_merged().can_merge());
    }

    #[test]
    fn a_detail_without_repository_settings_offers_no_merge() {
        let pr = r#"{"statusCheckRollup":[],"mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","isDraft":false,"state":"OPEN"}"#;
        let detail = parse_pr_detail(pr).unwrap();
        assert!(detail.methods.is_empty());
        assert!(!detail.can_merge());
        assert!(parse_pr_detail("gh: nope").is_none());
    }

    #[test]
    fn a_merged_or_closed_pull_request_cannot_merge_again() {
        let pr = r#"{"statusCheckRollup":[],"mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","isDraft":false,"state":"MERGED"}"#;
        let repo = r#"{"squashMergeAllowed":true}"#;
        let detail = parse_pr_detail(&format!("{pr}\u{1E}{repo}")).unwrap();
        assert!(detail.merged());
        assert!(!detail.can_merge());
    }

    #[test]
    fn directories_and_paths_are_validated_before_they_reach_a_command() {
        assert!(RepoDir::new("/home/u/src").is_some());
        assert!(RepoDir::new("relative").is_none());
        assert!(RepoDir::new("/a\nb").is_none());
        assert!(RepoDir::new("").is_none());
        assert!(valid_commit_id("abc1234"));
        assert!(!valid_commit_id("abc; rm -rf /"));
        assert!(!valid_commit_id("ab"));
        assert!(valid_repo_relative("docs/guide.md"));
        assert!(!valid_repo_relative("../etc/passwd"));
        assert!(!valid_repo_relative("a/../../b"));
        assert!(!valid_repo_relative("/etc/passwd"));
        assert!(!valid_repo_relative("a\nb"));
        assert_eq!(
            join_repo_path("/repo/", "docs/a.md").as_deref(),
            Some("/repo/docs/a.md")
        );
        assert_eq!(join_repo_path("/repo", "../x"), None);
    }

    #[test]
    fn every_command_quotes_what_it_interpolates() {
        let dir = RepoDir::new("/home/u/it's here").unwrap();
        for command in [
            workspace_command(&dir),
            pr_detail_command(&dir, 7),
            pr_diff_command(&dir, 7),
            merge_command(&dir, 7, MergeMethod::Squash),
            commit_command(&dir, "abc1234").unwrap(),
            docs_command(&dir),
        ] {
            assert!(command.starts_with("sh -c "), "{command}");
            assert!(!command.contains("it's here"), "{command}");
        }
        assert!(commit_command(&dir, "abc; touch x").is_none());
        assert!(merge_command(&dir, 7, MergeMethod::Squash).contains("--squash"));
    }

    #[test]
    fn a_wrapped_command_reports_its_exit_status_even_when_it_fails() {
        let command = wrap("echo hi; exit 3");
        assert!(command.starts_with("sh -c '"));
        assert_eq!(
            unwrap_output("hi\n\n__TETHER_RC__3"),
            ("hi\n".to_owned(), Some(3))
        );
        assert_eq!(unwrap_output("plain"), ("plain".to_owned(), None));
    }

    #[test]
    fn the_file_command_asks_for_one_byte_past_the_cap() {
        let command = read_file_command("/r/docs/a b.md", 1000).unwrap();
        assert!(command.contains("head -c 1001"));
        assert!(read_file_command("relative.md", 10).is_none());
        assert_eq!(
            readlink_cwd_command(42).unwrap(),
            "readlink /proc/42/cwd 2>/dev/null"
        );
        assert!(readlink_cwd_command(0).is_none());
    }

    #[test]
    fn the_first_line_skips_blank_lines() {
        assert_eq!(first_line("\n\n  boom \nmore"), "boom");
        assert_eq!(first_line(""), "");
    }
}
