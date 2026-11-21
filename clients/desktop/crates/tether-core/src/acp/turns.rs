//! A turn runs from one of the user's messages to the next; everything before the first is a
//! turn too. This is where the finished ones are told apart and their folded steps get their
//! sentence.

use std::collections::hash_map::DefaultHasher;
use std::collections::{BTreeMap, HashMap};
use std::hash::{Hash, Hasher};

use super::diff;
use super::message::{AcpDiff, ToolKind};
use super::reducer::{Item, ItemKind, ToolCall};

/// How many items, from the start, belong to turns that are over: all of them, or all but the
/// running turn. Items are counted by position, since a queued message that started sits after
/// items with higher ids.
pub fn finished_len(items: &[Item], working: bool) -> usize {
    if !working {
        return items.len();
    }
    items.iter().rposition(is_user).unwrap_or(0)
}

/// The last item id of the turns that are over; `None` when no turn is.
pub fn finished_through(items: &[Item], working: bool) -> Option<i64> {
    let n = finished_len(items, working);
    n.checked_sub(1).map(|i| items[i].id)
}

/// A diff's file: the path relative to the chat's folder and its line counts.
pub type DiffCount = (String, usize, usize);

/// Line counts per diff, kept by the view so a redraw never diffs the same edit twice: the
/// transcript is rebuilt on every streamed chunk.
#[derive(Debug, Default)]
pub struct DiffCounts(HashMap<u64, DiffCount>);

impl DiffCounts {
    pub fn count(&mut self, diff: &AcpDiff, cwd: &str) -> DiffCount {
        let mut hasher = DefaultHasher::new();
        (cwd, &diff.path, &diff.old_text, &diff.new_text).hash(&mut hasher);
        let key = hasher.finish();
        if let Some(known) = self.0.get(&key) {
            return known.clone();
        }
        // shortcut: a long session drops the whole cache, not the oldest entries; the next
        // redraw refills it.
        if self.0.len() > 512 {
            self.0.clear();
        }
        let file = diff::file_for(diff, cwd);
        let value = (file.path, file.added, file.removed);
        self.0.insert(key, value.clone());
        value
    }
}

/// A folded run of steps in one line: "Read 2 files, edited 1 file, ran 1 command".
pub fn fold_summary(calls: &[&ToolCall]) -> String {
    let mut counts: BTreeMap<u8, usize> = BTreeMap::new();
    let mut subagents = 0;
    for call in calls {
        if call.subagent.is_some() {
            subagents += 1;
        } else {
            *counts.entry(call.kind as u8).or_default() += 1;
        }
    }
    let of = |kind: ToolKind| counts.get(&(kind as u8)).copied();
    fn n(count: usize, one: &str, many: &str) -> String {
        format!("{count} {}", if count == 1 { one } else { many })
    }
    let times = |count: usize| match count {
        1 => "once".to_string(),
        2 => "twice".to_string(),
        _ => format!("{count} times"),
    };
    let mut parts = Vec::new();
    if let Some(c) = of(ToolKind::Read) {
        parts.push(format!("read {}", n(c, "file", "files")));
    }
    if let Some(c) = of(ToolKind::Search) {
        parts.push(format!("searched {}", times(c)));
    }
    if let Some(c) = of(ToolKind::Fetch) {
        parts.push(format!("fetched {}", n(c, "page", "pages")));
    }
    if let Some(c) = of(ToolKind::Edit) {
        parts.push(format!("edited {}", n(c, "file", "files")));
    }
    if let Some(c) = of(ToolKind::Delete) {
        parts.push(format!("deleted {}", n(c, "file", "files")));
    }
    if let Some(c) = of(ToolKind::Move) {
        parts.push(format!("moved {}", n(c, "file", "files")));
    }
    if let Some(c) = of(ToolKind::Execute) {
        parts.push(format!("ran {}", n(c, "command", "commands")));
    }
    if subagents > 0 {
        parts.push(format!("ran {}", n(subagents, "subagent", "subagents")));
    }
    let rest: usize = [ToolKind::Think, ToolKind::SwitchMode, ToolKind::Other]
        .into_iter()
        .filter_map(of)
        .sum();
    if rest > 0 {
        parts.push(n(rest, "other step", "other steps"));
    }
    let sentence = parts.join(", ");
    let mut chars = sentence.chars();
    chars
        .next()
        .map(|first| first.to_uppercase().chain(chars).collect())
        .unwrap_or_default()
}

fn is_user(item: &Item) -> bool {
    matches!(item.kind, ItemKind::User { .. })
}

#[cfg(test)]
mod tests {
    use super::super::message::{ToolFields, ToolStatus};
    use super::*;

    fn user(id: i64) -> Item {
        Item {
            id,
            kind: ItemKind::user("go", id as usize),
        }
    }

    fn text(id: i64) -> Item {
        Item {
            id,
            kind: ItemKind::Assistant {
                text: "ok".into(),
                message_id: None,
            },
        }
    }

    fn call(
        id: &str,
        kind: ToolKind,
        title: &str,
        status: ToolStatus,
        diff: Option<AcpDiff>,
    ) -> ToolCall {
        ToolCall::new(&ToolFields {
            kind: Some(kind),
            title: Some(title.into()),
            status: Some(status),
            diff,
            ..ToolFields::new(id)
        })
    }

    fn done(id: &str, kind: ToolKind) -> ToolCall {
        call(id, kind, "step", ToolStatus::Completed, None)
    }

    fn edit(path: &str, old: Option<&str>, new: &str) -> Option<AcpDiff> {
        Some(AcpDiff {
            path: path.into(),
            old_text: old.map(Into::into),
            new_text: new.into(),
        })
    }

    #[test]
    fn an_idle_chat_has_every_turn_finished_and_a_working_one_all_but_the_last() {
        let items = [user(0), text(1), user(2), text(3)];
        assert_eq!(finished_through(&items, false), Some(3));
        assert_eq!(finished_through(&items, true), Some(1));
        assert_eq!(finished_through(&[user(0), text(1)], true), None);
        assert_eq!(finished_through(&[], false), None);
    }

    #[test]
    fn the_fold_summary_counts_by_kind_in_reading_order() {
        let calls = [
            done("1", ToolKind::Read),
            done("2", ToolKind::Read),
            done("3", ToolKind::Search),
            done("4", ToolKind::Edit),
            done("5", ToolKind::Execute),
            done("6", ToolKind::Think),
        ];
        let refs: Vec<&ToolCall> = calls.iter().collect();
        assert_eq!(
            fold_summary(&refs),
            "Read 2 files, searched once, edited 1 file, ran 1 command, 1 other step"
        );
        let searches = [done("1", ToolKind::Search), done("2", ToolKind::Search)];
        let refs: Vec<&ToolCall> = searches.iter().collect();
        assert_eq!(fold_summary(&refs), "Searched twice");
    }

    #[test]
    fn line_counts_are_kept_per_diff() {
        let mut counts = DiffCounts::default();
        let d = edit("/w/a", Some("x\n"), "y\nz\n").unwrap();
        assert_eq!(counts.count(&d, "/w"), ("a".into(), 2, 1));
        assert_eq!(counts.0.len(), 1);
        counts.count(&d, "/w");
        assert_eq!(counts.0.len(), 1);
    }
}
