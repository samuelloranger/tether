//! Pure port of `apps/mobile/src/diffModel.ts`, with the structural `---`/`+++`
//! header fix already applied on the Swift side (and required here).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffFileStat {
    pub path: String,
    pub insertions: u32,
    pub deletions: u32,
    pub binary: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub staged: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub untracked: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct DiffSummary {
    pub files: Vec<DiffFileStat>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DiffLineKind {
    Add,
    Remove,
    Meta,
    Context,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub text: String,
    pub kind: DiffLineKind,
    pub content: String,
    pub old_line: Option<u32>,
    pub new_line: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SummaryGroups {
    pub staged: Vec<DiffFileStat>,
    pub unstaged: Vec<DiffFileStat>,
    pub untracked: Vec<DiffFileStat>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SideBySideRow {
    pub left: Option<DiffLine>,
    pub right: Option<DiffLine>,
    pub span: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileTreeNode {
    Dir {
        name: String,
        path: String,
        children: Vec<FileTreeNode>,
    },
    File {
        name: String,
        path: String,
        file: DiffFileStat,
    },
}

const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"];

pub fn is_image_path(path: &str) -> bool {
    let extension = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    IMAGE_EXTENSIONS.contains(&extension.as_str())
}

pub fn total_changes(summary: &DiffSummary) -> u32 {
    summary
        .files
        .iter()
        .map(|f| f.insertions + f.deletions)
        .sum()
}

pub fn change_label(summary: &DiffSummary) -> Option<String> {
    if summary.files.is_empty() {
        return None;
    }
    let insertions: u32 = summary.files.iter().map(|f| f.insertions).sum();
    let deletions: u32 = summary.files.iter().map(|f| f.deletions).sum();
    Some(format!("+{insertions} -{deletions}"))
}

pub fn change_banner_label(summary: &DiffSummary) -> Option<String> {
    change_label(summary).map(|label| format!("View changes, {label}"))
}

pub fn display_diff(diff: &str, truncated: bool) -> String {
    if truncated {
        format!("{diff}\n[Diff truncated at 1 MiB]")
    } else {
        diff.to_string()
    }
}

pub fn group_summary(summary: &DiffSummary) -> SummaryGroups {
    let mut staged = Vec::new();
    let mut unstaged = Vec::new();
    let mut untracked = Vec::new();
    for file in &summary.files {
        if file.staged == Some(true) {
            staged.push(file.clone());
        } else if file.untracked == Some(true) {
            untracked.push(file.clone());
        } else {
            unstaged.push(file.clone());
        }
    }
    SummaryGroups {
        staged,
        unstaged,
        untracked,
    }
}

fn ensure_dir(
    siblings: &mut Vec<FileTreeNode>,
    dir_index: &mut HashMap<String, Vec<usize>>,
    path: &str,
    name: &str,
    trail: &[usize],
) -> Vec<usize> {
    if let Some(existing) = dir_index.get(path) {
        return existing.clone();
    }
    siblings.push(FileTreeNode::Dir {
        name: name.to_string(),
        path: path.to_string(),
        children: Vec::new(),
    });
    let mut next = trail.to_vec();
    next.push(siblings.len() - 1);
    dir_index.insert(path.to_string(), next.clone());
    next
}

fn children_at<'a>(root: &'a mut Vec<FileTreeNode>, trail: &[usize]) -> &'a mut Vec<FileTreeNode> {
    let mut cur = root;
    for &idx in trail {
        cur = match &mut cur[idx] {
            FileTreeNode::Dir { children, .. } => children,
            FileTreeNode::File { .. } => unreachable!("dir trail points at a file"),
        };
    }
    cur
}

pub fn build_file_tree(files: &[DiffFileStat]) -> Vec<FileTreeNode> {
    let mut root: Vec<FileTreeNode> = Vec::new();
    let mut dir_index: HashMap<String, Vec<usize>> = HashMap::new();

    for file in files {
        let segments: Vec<&str> = file.path.split('/').collect();
        let mut trail: Vec<usize> = Vec::new();
        let mut current_path = String::new();
        for segment in segments.iter().take(segments.len().saturating_sub(1)) {
            current_path = if current_path.is_empty() {
                (*segment).to_string()
            } else {
                format!("{current_path}/{segment}")
            };
            let siblings = children_at(&mut root, &trail);
            trail = ensure_dir(siblings, &mut dir_index, &current_path, segment, &trail);
        }
        let name = segments.last().copied().unwrap_or("").to_string();
        children_at(&mut root, &trail).push(FileTreeNode::File {
            name,
            path: file.path.clone(),
            file: file.clone(),
        });
    }
    root
}

fn is_extended_header(line: &str) -> bool {
    line.starts_with("diff --git")
        || line.starts_with("index ")
        || line.starts_with("@@")
        || line.starts_with("new file mode")
        || line.starts_with("deleted file mode")
        || line.starts_with("old mode")
        || line.starts_with("new mode")
        || line.starts_with("similarity index")
        || line.starts_with("dissimilarity index")
        || line.starts_with("rename from")
        || line.starts_with("rename to")
        || line.starts_with("copy from")
        || line.starts_with("copy to")
        || line.starts_with("Binary files ")
}

/// File-level `---` / `+++` headers appear only between `diff --git` and the
/// first `@@` hunk. Elsewhere a leading `---` is a real removed line.
fn is_file_header_path_line(line: &str) -> bool {
    line.starts_with("--- a/")
        || line.starts_with("--- /dev/null")
        || line == "---"
        || line.starts_with("+++ b/")
        || line.starts_with("+++ /dev/null")
        || line == "+++"
}

#[derive(Clone, Copy)]
enum DiffPhase {
    Outside,
    FileHeader,
    HunkBody,
}

fn classify_line(line: &str, phase: DiffPhase) -> DiffLineKind {
    if is_extended_header(line) {
        return DiffLineKind::Meta;
    }
    if matches!(phase, DiffPhase::FileHeader) && is_file_header_path_line(line) {
        return DiffLineKind::Meta;
    }
    if line.starts_with('+') {
        return DiffLineKind::Add;
    }
    if line.starts_with('-') {
        return DiffLineKind::Remove;
    }
    DiffLineKind::Context
}

/// Standalone classifier used by tests that mirror the TS `diffLineKinds`
/// helper. Uses FileHeader phase so classic fixtures still classify `---`/`+++`
/// as meta; prefer `parse_diff_lines` for real diffs.
pub fn diff_line_kind(line: &str) -> DiffLineKind {
    classify_line(line, DiffPhase::FileHeader)
}

pub fn diff_line_kinds(diff: &str) -> Vec<DiffLineKind> {
    if diff.is_empty() {
        return Vec::new();
    }
    let mut phase = DiffPhase::Outside;
    let mut out = Vec::new();
    for line in diff.split('\n') {
        if line.starts_with("diff --git") {
            phase = DiffPhase::FileHeader;
        }
        let kind = classify_line(line, phase);
        if kind == DiffLineKind::Meta && line.starts_with("@@") {
            phase = DiffPhase::HunkBody;
        }
        out.push(kind);
    }
    out
}

/// Parse `@@ -old[,n] +new[,n] @@` start numbers. Returns None if not a hunk header.
fn parse_hunk_starts(text: &str) -> Option<(u32, u32)> {
    if !text.starts_with("@@ -") {
        return None;
    }
    let rest = text.strip_prefix("@@ -")?;
    let (old_part, after_old) = rest.split_once('+')?;
    let old = old_part.split(',').next()?.trim().parse::<u32>().ok()?;
    let new_part = after_old.split_whitespace().next()?;
    let new = new_part
        .trim_start_matches('+')
        .split(',')
        .next()?
        .parse::<u32>()
        .ok()?;
    Some((old, new))
}

pub fn is_hunk_header_line(text: &str) -> bool {
    parse_hunk_starts(text).is_some()
}

fn is_hunk_start_line(text: &str) -> bool {
    text.starts_with("@@ -") && text.as_bytes().get(4).is_some_and(|b| b.is_ascii_digit())
}

/// Empty input yields `[]` — an empty string's split is `[""]`, which would
/// otherwise become a degenerate context line rendering as "0 0".
pub fn parse_diff_lines(diff: &str) -> Vec<DiffLine> {
    if diff.trim().is_empty() {
        return Vec::new();
    }
    let mut old_line: u32 = 0;
    let mut new_line: u32 = 0;
    let mut phase = DiffPhase::Outside;
    let mut out = Vec::new();
    for text in diff.split('\n') {
        if text.starts_with("diff --git") {
            phase = DiffPhase::FileHeader;
        }
        let kind = classify_line(text, phase);
        if kind == DiffLineKind::Meta && text.starts_with("@@") {
            phase = DiffPhase::HunkBody;
        }
        if kind == DiffLineKind::Meta {
            if let Some((old, new)) = parse_hunk_starts(text) {
                old_line = old;
                new_line = new;
            }
            out.push(DiffLine {
                text: text.to_string(),
                kind,
                content: text.to_string(),
                old_line: None,
                new_line: None,
            });
            continue;
        }
        let content = text.chars().skip(1).collect::<String>();
        match kind {
            DiffLineKind::Remove => {
                let n = old_line;
                old_line = old_line.saturating_add(1);
                out.push(DiffLine {
                    text: text.to_string(),
                    kind,
                    content,
                    old_line: Some(n),
                    new_line: None,
                });
            }
            DiffLineKind::Add => {
                let n = new_line;
                new_line = new_line.saturating_add(1);
                out.push(DiffLine {
                    text: text.to_string(),
                    kind,
                    content,
                    old_line: None,
                    new_line: Some(n),
                });
            }
            DiffLineKind::Context => {
                let o = old_line;
                let n = new_line;
                old_line = old_line.saturating_add(1);
                new_line = new_line.saturating_add(1);
                out.push(DiffLine {
                    text: text.to_string(),
                    kind,
                    content,
                    old_line: Some(o),
                    new_line: Some(n),
                });
            }
            DiffLineKind::Meta => unreachable!(),
        }
    }
    out
}

pub fn annotate_hunk_indices(lines: &[DiffLine]) -> Vec<Option<u32>> {
    let mut hunk: i32 = -1;
    lines
        .iter()
        .map(|line| {
            if line.kind == DiffLineKind::Meta && is_hunk_start_line(&line.text) {
                hunk += 1;
                Some(hunk as u32)
            } else {
                None
            }
        })
        .collect()
}

/// Drops file-header meta (`diff --git`, `index`, `---`, `+++`, …); keeps hunk
/// headers and body lines so the UI never renders raw git headers.
pub fn visible_diff_lines(lines: &[DiffLine]) -> Vec<DiffLine> {
    lines
        .iter()
        .filter(|line| line.kind != DiffLineKind::Meta || is_hunk_header_line(&line.text))
        .cloned()
        .collect()
}

pub fn pair_diff_rows(lines: &[DiffLine]) -> Vec<SideBySideRow> {
    let mut rows = Vec::new();
    let mut removes: Vec<DiffLine> = Vec::new();
    let mut adds: Vec<DiffLine> = Vec::new();
    let flush =
        |removes: &mut Vec<DiffLine>, adds: &mut Vec<DiffLine>, rows: &mut Vec<SideBySideRow>| {
            let n = removes.len().max(adds.len());
            for i in 0..n {
                rows.push(SideBySideRow {
                    left: removes.get(i).cloned(),
                    right: adds.get(i).cloned(),
                    span: false,
                });
            }
            removes.clear();
            adds.clear();
        };
    for line in lines {
        match line.kind {
            DiffLineKind::Remove => removes.push(line.clone()),
            DiffLineKind::Add => adds.push(line.clone()),
            DiffLineKind::Meta => {
                flush(&mut removes, &mut adds, &mut rows);
                rows.push(SideBySideRow {
                    left: Some(line.clone()),
                    right: None,
                    span: true,
                });
            }
            DiffLineKind::Context => {
                flush(&mut removes, &mut adds, &mut rows);
                rows.push(SideBySideRow {
                    left: Some(line.clone()),
                    right: Some(line.clone()),
                    span: false,
                });
            }
        }
    }
    flush(&mut removes, &mut adds, &mut rows);
    rows
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn change_label_formats_nonempty_totals_and_hides_an_empty_summary() {
        assert_eq!(
            change_label(&DiffSummary {
                files: vec![DiffFileStat {
                    path: "a.ts".into(),
                    insertions: 3,
                    deletions: 2,
                    binary: false,
                    staged: None,
                    untracked: None,
                }],
            }),
            Some("+3 -2".into())
        );
        assert_eq!(
            change_label(&DiffSummary {
                files: vec![DiffFileStat {
                    path: "binary.png".into(),
                    insertions: 0,
                    deletions: 0,
                    binary: true,
                    staged: None,
                    untracked: None,
                }],
            }),
            Some("+0 -0".into())
        );
        assert_eq!(change_label(&DiffSummary { files: vec![] }), None);
    }

    #[test]
    fn total_changes_sums_insertions_and_deletions_across_files() {
        assert_eq!(total_changes(&DiffSummary { files: vec![] }), 0);
        assert_eq!(
            total_changes(&DiffSummary {
                files: vec![
                    DiffFileStat {
                        path: "a.ts".into(),
                        insertions: 3,
                        deletions: 1,
                        binary: false,
                        staged: None,
                        untracked: None,
                    },
                    DiffFileStat {
                        path: "b.ts".into(),
                        insertions: 0,
                        deletions: 2,
                        binary: false,
                        staged: None,
                        untracked: None,
                    },
                ],
            }),
            6
        );
    }

    #[test]
    fn display_diff_warns_when_the_server_truncates_a_diff() {
        assert_eq!(
            display_diff("line 1\n", true),
            "line 1\n\n[Diff truncated at 1 MiB]"
        );
    }

    #[test]
    fn diff_line_kinds_preserves_prefixes_while_classifying_unified_diff_rows() {
        let diff = "+const answer = 43;\n-old\n@@ -1 +1 @@";
        assert_eq!(
            diff_line_kinds(diff),
            vec![DiffLineKind::Add, DiffLineKind::Remove, DiffLineKind::Meta]
        );
    }

    #[test]
    fn diff_line_kinds_keeps_new_deleted_file_mode_headers_as_meta() {
        let diff = [
            "diff --git a/fresh.ts b/fresh.ts",
            "new file mode 100644",
            "index 0000000..abc1234",
            "--- /dev/null",
            "+++ b/fresh.ts",
            "@@ -0,0 +1 @@",
            "+hello",
        ]
        .join("\n");
        assert_eq!(
            diff_line_kinds(&diff),
            vec![
                DiffLineKind::Meta,
                DiffLineKind::Meta,
                DiffLineKind::Meta,
                DiffLineKind::Meta,
                DiffLineKind::Meta,
                DiffLineKind::Meta,
                DiffLineKind::Add,
            ]
        );
        let lines = parse_diff_lines(&diff);
        assert!(lines
            .iter()
            .any(|l| l.text.starts_with("new file") && l.content == "new file mode 100644"));
        assert!(lines.iter().all(|l| !l.content.starts_with("ew file")));
    }

    #[test]
    fn is_image_path_recognizes_common_image_extensions_case_insensitively() {
        assert!(is_image_path("logo.PNG"));
        assert!(is_image_path("assets/icon.svg"));
        assert!(!is_image_path("main.ts"));
    }

    #[test]
    fn build_file_tree_nests_folders_like_a_real_file_tree() {
        let files = vec![
            DiffFileStat {
                path: "src/a.ts".into(),
                insertions: 1,
                deletions: 0,
                binary: false,
                staged: None,
                untracked: None,
            },
            DiffFileStat {
                path: "README.md".into(),
                insertions: 1,
                deletions: 0,
                binary: false,
                staged: None,
                untracked: None,
            },
            DiffFileStat {
                path: "src/b.ts".into(),
                insertions: 0,
                deletions: 1,
                binary: false,
                staged: None,
                untracked: None,
            },
            DiffFileStat {
                path: "src/nested/c.ts".into(),
                insertions: 2,
                deletions: 0,
                binary: false,
                staged: None,
                untracked: None,
            },
        ];
        let tree = build_file_tree(&files);
        assert_eq!(tree.len(), 2);
        match &tree[0] {
            FileTreeNode::Dir { name, children, .. } => {
                assert_eq!(name, "src");
                assert_eq!(children.len(), 3);
                match &children[2] {
                    FileTreeNode::Dir {
                        name,
                        path,
                        children,
                        ..
                    } => {
                        assert_eq!(name, "nested");
                        assert_eq!(path, "src/nested");
                        assert_eq!(children.len(), 1);
                    }
                    _ => panic!("expected nested dir"),
                }
            }
            _ => panic!("expected src dir"),
        }
        match &tree[1] {
            FileTreeNode::File { name, .. } => assert_eq!(name, "README.md"),
            _ => panic!("expected README file"),
        }
    }

    #[test]
    fn build_file_tree_reuses_the_same_folder_node_across_sibling_files() {
        let files = vec![
            DiffFileStat {
                path: "src/a.ts".into(),
                insertions: 1,
                deletions: 0,
                binary: false,
                staged: None,
                untracked: None,
            },
            DiffFileStat {
                path: "src/nested/c.ts".into(),
                insertions: 2,
                deletions: 0,
                binary: false,
                staged: None,
                untracked: None,
            },
            DiffFileStat {
                path: "src/b.ts".into(),
                insertions: 0,
                deletions: 1,
                binary: false,
                staged: None,
                untracked: None,
            },
        ];
        let tree = build_file_tree(&files);
        assert_eq!(tree.len(), 1);
        match &tree[0] {
            FileTreeNode::Dir { children, .. } => assert_eq!(children.len(), 3),
            _ => panic!("expected dir"),
        }
    }

    #[test]
    fn parse_diff_lines_assigns_old_new_line_numbers_per_hunk() {
        let diff = [
            "diff --git a/main.ts b/main.ts",
            "@@ -1,3 +1,3 @@",
            " unchanged",
            "-old line",
            "+new line",
            " trailing",
        ]
        .join("\n");
        let lines = parse_diff_lines(&diff);
        assert_eq!(lines.len(), 6);
        assert_eq!(lines[2].kind, DiffLineKind::Context);
        assert_eq!(lines[2].content, "unchanged");
        assert_eq!(lines[2].old_line, Some(1));
        assert_eq!(lines[2].new_line, Some(1));
        assert_eq!(lines[3].kind, DiffLineKind::Remove);
        assert_eq!(lines[3].old_line, Some(2));
        assert_eq!(lines[4].kind, DiffLineKind::Add);
        assert_eq!(lines[4].new_line, Some(2));
        assert_eq!(lines[5].old_line, Some(3));
        assert_eq!(lines[5].new_line, Some(3));
    }

    #[test]
    fn parse_diff_lines_returns_empty_for_empty_diff() {
        assert!(parse_diff_lines("").is_empty());
        assert!(parse_diff_lines("   \n  ").is_empty());
    }

    #[test]
    fn parse_diff_lines_keeps_body_dashes_that_look_like_file_headers() {
        // A removed line whose content is itself `---` must stay a remove, not
        // meta. Naive `starts_with("---")` wrongly eats `----` (marker + `---`).
        let diff = [
            "diff --git a/x b/x",
            "--- a/x",
            "+++ b/x",
            "@@ -1,3 +1,3 @@",
            " keep",
            "----",
            "+---",
        ]
        .join("\n");
        let lines = parse_diff_lines(&diff);
        assert_eq!(lines[1].kind, DiffLineKind::Meta); // --- a/x
        assert_eq!(lines[2].kind, DiffLineKind::Meta); // +++ b/x
        assert_eq!(lines[4].kind, DiffLineKind::Context);
        assert_eq!(lines[5].kind, DiffLineKind::Remove);
        assert_eq!(lines[5].content, "---");
        assert_eq!(lines[6].kind, DiffLineKind::Add);
        assert_eq!(lines[6].content, "---");
    }

    #[test]
    fn group_summary_splits_staged_unstaged_and_untracked() {
        let summary = DiffSummary {
            files: vec![
                DiffFileStat {
                    path: "a.txt".into(),
                    insertions: 1,
                    deletions: 0,
                    binary: false,
                    staged: Some(true),
                    untracked: None,
                },
                DiffFileStat {
                    path: "a.txt".into(),
                    insertions: 2,
                    deletions: 0,
                    binary: false,
                    staged: Some(false),
                    untracked: None,
                },
                DiffFileStat {
                    path: "new.txt".into(),
                    insertions: 1,
                    deletions: 0,
                    binary: false,
                    staged: Some(false),
                    untracked: Some(true),
                },
                DiffFileStat {
                    path: "c.txt".into(),
                    insertions: 1,
                    deletions: 1,
                    binary: false,
                    staged: None,
                    untracked: None,
                },
            ],
        };
        let groups = group_summary(&summary);
        assert_eq!(
            groups
                .staged
                .iter()
                .map(|f| f.path.as_str())
                .collect::<Vec<_>>(),
            vec!["a.txt"]
        );
        assert_eq!(
            groups
                .unstaged
                .iter()
                .map(|f| f.path.as_str())
                .collect::<Vec<_>>(),
            vec!["a.txt", "c.txt"]
        );
        assert_eq!(
            groups
                .untracked
                .iter()
                .map(|f| f.path.as_str())
                .collect::<Vec<_>>(),
            vec!["new.txt"]
        );
    }

    #[test]
    fn annotate_hunk_indices_numbers_hunk_header_lines_in_order() {
        let diff = [
            "diff --git a/x b/x",
            "@@ -1,2 +1,2 @@",
            "-a",
            "+b",
            "@@ -10,2 +10,2 @@",
            "-c",
            "+d",
        ]
        .join("\n");
        let indices = annotate_hunk_indices(&parse_diff_lines(&diff));
        assert_eq!(
            indices,
            vec![None, Some(0), None, None, Some(1), None, None]
        );
    }

    #[test]
    fn pair_diff_rows_aligns_removes_with_adds_side_by_side() {
        let diff = [
            "@@ -1,4 +1,4 @@",
            " keep",
            "-old1",
            "-old2",
            "+new1",
            " tail",
        ]
        .join("\n");
        let rows = pair_diff_rows(&parse_diff_lines(&diff));
        assert!(rows[0].span);
        assert_eq!(rows[0].right, None);
        assert_eq!(rows[1].left.as_ref().unwrap().content, "keep");
        assert_eq!(rows[1].right.as_ref().unwrap().content, "keep");
        assert_eq!(rows[2].left.as_ref().unwrap().content, "old1");
        assert_eq!(rows[2].right.as_ref().unwrap().content, "new1");
        assert_eq!(rows[3].left.as_ref().unwrap().content, "old2");
        assert!(rows[3].right.is_none());
        assert_eq!(rows[4].left.as_ref().unwrap().content, "tail");
    }

    #[test]
    fn visible_diff_lines_hides_raw_git_file_headers() {
        let diff = [
            "diff --git a/x b/x",
            "index 123..456 100644",
            "--- a/x",
            "+++ b/x",
            "@@ -1 +1 @@",
            "-a",
            "+b",
        ]
        .join("\n");
        let visible = visible_diff_lines(&parse_diff_lines(&diff));
        assert!(visible.iter().all(|l| {
            !l.text.starts_with("diff --git")
                && !l.text.starts_with("index ")
                && !l.text.starts_with("--- ")
                && !l.text.starts_with("+++ ")
        }));
        assert_eq!(visible[0].text, "@@ -1 +1 @@");
        assert_eq!(visible.len(), 3);
    }
}
