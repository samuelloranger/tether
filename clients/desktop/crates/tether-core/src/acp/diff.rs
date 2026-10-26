//! Turns an agent's before/after text into rows a diff view can draw: a line diff with three
//! lines of context and a separator row where unchanged lines were skipped.

use similar::{Algorithm, DiffOp, capture_diff_slices};

use super::format::relative_path;
use super::message::AcpDiff;

pub const CONTEXT_LINES: usize = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiffRowKind {
    Context,
    Added,
    Removed,
    Hunk,
    Plain,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffRow {
    /// Position within its file.
    pub id: usize,
    pub kind: DiffRowKind,
    pub old_line: Option<usize>,
    pub new_line: Option<usize>,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffFile {
    pub path: String,
    pub added: usize,
    pub removed: usize,
    pub rows: Vec<DiffRow>,
}

impl DiffFile {
    /// Digits in the largest line number, so a gutter fits it at any size (at least two).
    pub fn line_digits(&self) -> usize {
        let largest = self
            .rows
            .iter()
            .map(|r| r.new_line.or(r.old_line).unwrap_or(0))
            .max()
            .unwrap_or(0);
        largest.to_string().len().max(2)
    }
}

fn lines(text: Option<&str>) -> Vec<&str> {
    let Some(text) = text else { return Vec::new() };
    let mut parts: Vec<&str> = text.split('\n').collect();
    if parts.last() == Some(&"") {
        parts.pop();
    }
    parts
}

struct Line<'a> {
    kind: DiffRowKind,
    old: Option<usize>,
    new: Option<usize>,
    text: &'a str,
}

pub fn file_for(diff: &AcpDiff, cwd: &str) -> DiffFile {
    let old = lines(diff.old_text.as_deref());
    let new = lines(Some(&diff.new_text));
    let path = relative_path(&diff.path, cwd);

    let mut all: Vec<Line> = Vec::new();
    for op in capture_diff_slices(Algorithm::Myers, &old, &new) {
        match op {
            DiffOp::Equal {
                old_index,
                new_index,
                len,
            } => {
                for k in 0..len {
                    all.push(Line {
                        kind: DiffRowKind::Context,
                        old: Some(old_index + k + 1),
                        new: Some(new_index + k + 1),
                        text: old[old_index + k],
                    });
                }
            }
            DiffOp::Delete {
                old_index, old_len, ..
            } => remove(&mut all, &old, old_index, old_len),
            DiffOp::Insert {
                new_index, new_len, ..
            } => add(&mut all, &new, new_index, new_len),
            DiffOp::Replace {
                old_index,
                old_len,
                new_index,
                new_len,
            } => {
                remove(&mut all, &old, old_index, old_len);
                add(&mut all, &new, new_index, new_len);
            }
        }
    }

    let added = all.iter().filter(|l| l.kind == DiffRowKind::Added).count();
    let removed = all
        .iter()
        .filter(|l| l.kind == DiffRowKind::Removed)
        .count();
    if added + removed == 0 {
        return DiffFile {
            path,
            added: 0,
            removed: 0,
            rows: vec![DiffRow {
                id: 0,
                kind: DiffRowKind::Plain,
                old_line: None,
                new_line: None,
                text: "No changes".into(),
            }],
        };
    }

    let mut keep = vec![false; all.len()];
    for (index, line) in all.iter().enumerate() {
        if line.kind == DiffRowKind::Context {
            continue;
        }
        let from = index.saturating_sub(CONTEXT_LINES);
        let to = (index + CONTEXT_LINES).min(all.len() - 1);
        for near in &mut keep[from..=to] {
            *near = true;
        }
    }

    let mut rows: Vec<DiffRow> = Vec::new();
    let mut skipping = false;
    for (index, line) in all.iter().enumerate() {
        if !keep[index] {
            skipping = true;
            continue;
        }
        if skipping {
            rows.push(DiffRow {
                id: rows.len(),
                kind: DiffRowKind::Hunk,
                old_line: None,
                new_line: None,
                text: String::new(),
            });
            skipping = false;
        }
        rows.push(DiffRow {
            id: rows.len(),
            kind: line.kind,
            old_line: line.old,
            new_line: line.new,
            text: line.text.to_string(),
        });
    }
    DiffFile {
        path,
        added,
        removed,
        rows,
    }
}

fn remove<'a>(all: &mut Vec<Line<'a>>, old: &[&'a str], at: usize, len: usize) {
    for k in 0..len {
        all.push(Line {
            kind: DiffRowKind::Removed,
            old: Some(at + k + 1),
            new: None,
            text: old[at + k],
        });
    }
}

fn add<'a>(all: &mut Vec<Line<'a>>, new: &[&'a str], at: usize, len: usize) {
    for k in 0..len {
        all.push(Line {
            kind: DiffRowKind::Added,
            old: None,
            new: Some(at + k + 1),
            text: new[at + k],
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn diff(path: &str, old: Option<&str>, new: &str) -> AcpDiff {
        AcpDiff {
            path: path.into(),
            old_text: old.map(String::from),
            new_text: new.into(),
        }
    }

    #[test]
    fn a_new_file_is_all_additions_numbered_from_one() {
        let file = file_for(&diff("/w/p/out.txt", None, "a\nb\n"), "/w/p");
        assert_eq!(file.path, "out.txt");
        assert_eq!((file.added, file.removed), (2, 0));
        let kinds: Vec<_> = file.rows.iter().map(|r| r.kind).collect();
        assert_eq!(kinds, [DiffRowKind::Added, DiffRowKind::Added]);
        let lines: Vec<_> = file.rows.iter().map(|r| r.new_line).collect();
        assert_eq!(lines, [Some(1), Some(2)]);
        let ids: Vec<_> = file.rows.iter().map(|r| r.id).collect();
        assert_eq!(ids, [0, 1]);
    }

    #[test]
    fn an_edit_keeps_three_lines_of_context_and_marks_the_gap() {
        let old: Vec<String> = (1..=20).map(|i| format!("line {i}")).collect();
        let mut new = old.clone();
        new[9] = "changed".into();
        let file = file_for(&diff("f.txt", Some(&old.join("\n")), &new.join("\n")), "/w");
        assert_eq!((file.added, file.removed), (1, 1));
        assert_eq!(file.rows[0].kind, DiffRowKind::Hunk);
        assert_eq!(
            file.rows
                .iter()
                .filter(|r| r.kind == DiffRowKind::Context)
                .count(),
            6
        );
        let removed = file
            .rows
            .iter()
            .find(|r| r.kind == DiffRowKind::Removed)
            .unwrap();
        let added = file
            .rows
            .iter()
            .find(|r| r.kind == DiffRowKind::Added)
            .unwrap();
        assert_eq!(
            (removed.text.as_str(), removed.old_line),
            ("line 10", Some(10))
        );
        assert_eq!((added.text.as_str(), added.new_line), ("changed", Some(10)));
        let ids: Vec<_> = file.rows.iter().map(|r| r.id).collect();
        assert_eq!(ids, (0..file.rows.len()).collect::<Vec<_>>());
        assert_eq!(
            file.rows.last().unwrap().kind,
            DiffRowKind::Context,
            "a skipped tail gets no separator"
        );
    }

    #[test]
    fn identical_text_says_so_instead_of_drawing_nothing() {
        let file = file_for(&diff("f", Some("x\n"), "x\n"), "/w");
        let texts: Vec<_> = file.rows.iter().map(|r| r.text.as_str()).collect();
        assert_eq!(texts, ["No changes"]);
        assert_eq!(file.added + file.removed, 0);
    }

    #[test]
    fn inserted_lines_in_the_middle_do_not_mark_the_rest_as_changed() {
        let file = file_for(&diff("f", Some("a\nb\nc\n"), "a\nb\nNEW\nc\n"), "/w");
        assert_eq!((file.added, file.removed), (1, 0));
        let kinds: Vec<_> = file.rows.iter().map(|r| r.kind).collect();
        assert_eq!(
            kinds,
            [
                DiffRowKind::Context,
                DiffRowKind::Context,
                DiffRowKind::Added,
                DiffRowKind::Context
            ]
        );
    }

    #[test]
    fn a_replaced_block_lists_its_removals_before_its_additions() {
        let file = file_for(&diff("f", Some("a\nb\nc\n"), "a\nX\nY\nc\n"), "/w");
        let kinds: Vec<_> = file.rows.iter().map(|r| r.kind).collect();
        assert_eq!(
            kinds,
            [
                DiffRowKind::Context,
                DiffRowKind::Removed,
                DiffRowKind::Added,
                DiffRowKind::Added,
                DiffRowKind::Context
            ]
        );
        assert_eq!(file.line_digits(), 2);
    }
}
