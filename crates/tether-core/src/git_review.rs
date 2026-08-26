//! Pure port of `apps/mobile/src/gitReviewModel.ts` plus
//! `apps/mobile/src/gitDrawerLayout.ts`.

use std::collections::BTreeSet;
use std::future::Future;

use crate::diff_model::{group_summary, DiffFileStat, DiffSummary};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReviewMode {
    Staged,
    Unstaged,
}

impl ReviewMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Staged => "staged",
            Self::Unstaged => "unstaged",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewFileEntry {
    pub path: String,
    pub mode: ReviewMode,
    pub file: DiffFileStat,
}

pub fn review_file_entries(summary: &DiffSummary) -> Vec<ReviewFileEntry> {
    let groups = group_summary(summary);
    let mut out = Vec::new();
    for file in groups.staged {
        out.push(ReviewFileEntry {
            path: file.path.clone(),
            mode: ReviewMode::Staged,
            file,
        });
    }
    for file in groups.unstaged.into_iter().chain(groups.untracked) {
        out.push(ReviewFileEntry {
            path: file.path.clone(),
            mode: ReviewMode::Unstaged,
            file,
        });
    }
    out
}

pub fn review_diff_key(mode: ReviewMode, path: &str) -> String {
    format!("{}:{path}", mode.as_str())
}

pub fn toggle_set_member(set: &BTreeSet<String>, key: &str) -> BTreeSet<String> {
    let mut next = set.clone();
    if !next.remove(key) {
        next.insert(key.to_string());
    }
    next
}

pub fn can_commit(staged_count: usize, message: &str, committing: bool) -> bool {
    staged_count > 0 && !message.trim().is_empty() && !committing
}

/// Stable fingerprint of a summary for effect deps / change detection.
pub fn summary_fingerprint(summary: &DiffSummary) -> String {
    summary
        .files
        .iter()
        .map(|f| {
            let side = if f.staged == Some(true) { "S" } else { "U" };
            let binary = if f.binary { 1 } else { 0 };
            format!(
                "{side}:{}:{}:{}:{binary}",
                f.path, f.insertions, f.deletions
            )
        })
        .collect::<Vec<_>>()
        .join("|")
}

pub async fn map_with_concurrency<T, R, F, Fut>(items: &[T], limit: usize, worker: F) -> Vec<R>
where
    T: Clone + Send + Sync,
    R: Send,
    F: Fn(T) -> Fut + Sync,
    Fut: Future<Output = R> + Send,
{
    if items.is_empty() {
        return Vec::new();
    }
    let limit = limit.max(1).min(items.len());
    let mut owned: Vec<Option<R>> = (0..items.len()).map(|_| None).collect();
    let mut inflight = futures_util::stream::FuturesUnordered::new();
    let mut idx = 0;
    while idx < items.len() || !inflight.is_empty() {
        while inflight.len() < limit && idx < items.len() {
            let i = idx;
            idx += 1;
            let item = items[i].clone();
            let fut = worker(item);
            inflight.push(async move { (i, fut.await) });
        }
        if let Some((i, value)) = futures_util::StreamExt::next(&mut inflight).await {
            owned[i] = Some(value);
        }
    }
    owned
        .into_iter()
        .map(|slot| slot.expect("filled"))
        .collect()
}

// --- gitDrawerLayout.ts ---

pub const GIT_DRAWER_MIN_LEFT: i32 = 220;
pub const GIT_DRAWER_MIN_RIGHT: i32 = 320;
pub const GIT_DRAWER_DEFAULT_LEFT_RATIO: f64 = 1.0 / 3.0;

/// Clamp the Changes/History column width so both panes stay usable.
pub fn clamp_git_drawer_left_width(requested: f64, total: f64) -> i32 {
    if total <= 0.0 || !requested.is_finite() {
        return 0;
    }
    if total <= f64::from(GIT_DRAWER_MIN_LEFT + GIT_DRAWER_MIN_RIGHT) {
        return (total / 2.0).floor() as i32;
    }
    let min_left = GIT_DRAWER_MIN_LEFT;
    let max_left = (total as i32) - GIT_DRAWER_MIN_RIGHT;
    requested
        .round()
        .clamp(f64::from(min_left), f64::from(max_left)) as i32
}

pub fn default_git_drawer_left_width(total: f64) -> i32 {
    clamp_git_drawer_left_width(total * GIT_DRAWER_DEFAULT_LEFT_RATIO, total)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DrawerEscapeAction {
    BlurField,
    Dismiss,
    Ignore,
}

/// Escape handling for the desktop git drawer.
pub fn drawer_escape_action(
    in_drawer: bool,
    is_text_field: bool,
    is_document_root: bool,
) -> DrawerEscapeAction {
    if in_drawer && is_text_field {
        return DrawerEscapeAction::BlurField;
    }
    if in_drawer || is_document_root {
        return DrawerEscapeAction::Dismiss;
    }
    DrawerEscapeAction::Ignore
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diff_model::DiffFileStat;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    #[test]
    fn review_file_entries_lists_staged_then_unstaged_preserving_order() {
        let summary = DiffSummary {
            files: vec![
                DiffFileStat {
                    path: "b.ts".into(),
                    insertions: 1,
                    deletions: 0,
                    binary: false,
                    staged: Some(false),
                    untracked: None,
                },
                DiffFileStat {
                    path: "a.ts".into(),
                    insertions: 1,
                    deletions: 0,
                    binary: false,
                    staged: Some(true),
                    untracked: None,
                },
                DiffFileStat {
                    path: "c.ts".into(),
                    insertions: 0,
                    deletions: 1,
                    binary: false,
                    staged: Some(true),
                    untracked: None,
                },
            ],
        };
        let keys: Vec<_> = review_file_entries(&summary)
            .into_iter()
            .map(|e| format!("{}:{}", e.mode.as_str(), e.path))
            .collect();
        assert_eq!(keys, vec!["staged:a.ts", "staged:c.ts", "unstaged:b.ts"]);
    }

    #[test]
    fn review_diff_key_distinguishes_the_same_path_on_both_sides() {
        assert_eq!(review_diff_key(ReviewMode::Staged, "x.ts"), "staged:x.ts");
        assert_eq!(
            review_diff_key(ReviewMode::Unstaged, "x.ts"),
            "unstaged:x.ts"
        );
    }

    #[test]
    fn toggle_set_member_adds_then_removes() {
        let once = toggle_set_member(&BTreeSet::new(), "a");
        assert!(once.contains("a"));
        assert!(!toggle_set_member(&once, "a").contains("a"));
    }

    #[test]
    fn can_commit_requires_staged_files_non_empty_message_and_idle_commit() {
        assert!(can_commit(1, "msg", false));
        assert!(!can_commit(0, "msg", false));
        assert!(!can_commit(1, "  ", false));
        assert!(!can_commit(1, "msg", true));
    }

    #[test]
    fn summary_fingerprint_changes_when_staged_split_or_counts_change() {
        let a = DiffSummary {
            files: vec![DiffFileStat {
                path: "a.ts".into(),
                insertions: 1,
                deletions: 0,
                binary: false,
                staged: Some(false),
                untracked: None,
            }],
        };
        let b = DiffSummary {
            files: vec![DiffFileStat {
                path: "a.ts".into(),
                insertions: 1,
                deletions: 0,
                binary: false,
                staged: Some(true),
                untracked: None,
            }],
        };
        let c = DiffSummary {
            files: vec![DiffFileStat {
                path: "a.ts".into(),
                insertions: 2,
                deletions: 0,
                binary: false,
                staged: Some(false),
                untracked: None,
            }],
        };
        assert_ne!(summary_fingerprint(&a), summary_fingerprint(&b));
        assert_ne!(summary_fingerprint(&a), summary_fingerprint(&c));
        assert_eq!(
            summary_fingerprint(&a),
            summary_fingerprint(&DiffSummary {
                files: a.files.clone()
            })
        );
    }

    #[tokio::test]
    async fn map_with_concurrency_respects_the_limit_and_preserves_order() {
        let inflight = Arc::new(AtomicUsize::new(0));
        let max = Arc::new(AtomicUsize::new(0));
        let items = [1, 2, 3, 4, 5];
        let out = map_with_concurrency(&items, 2, |n| {
            let inflight = Arc::clone(&inflight);
            let max = Arc::clone(&max);
            async move {
                let cur = inflight.fetch_add(1, Ordering::SeqCst) + 1;
                max.fetch_max(cur, Ordering::SeqCst);
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                inflight.fetch_sub(1, Ordering::SeqCst);
                n * 10
            }
        })
        .await;
        assert_eq!(out, vec![10, 20, 30, 40, 50]);
        assert!(max.load(Ordering::SeqCst) <= 2);
    }

    #[test]
    fn clamp_git_drawer_left_width_enforces_min_left_and_min_right() {
        let total = 1200.0;
        assert_eq!(
            clamp_git_drawer_left_width(50.0, total),
            GIT_DRAWER_MIN_LEFT
        );
        assert_eq!(
            clamp_git_drawer_left_width(1100.0, total),
            (total as i32) - GIT_DRAWER_MIN_RIGHT
        );
        assert_eq!(clamp_git_drawer_left_width(400.0, total), 400);
    }

    #[test]
    fn clamp_git_drawer_left_width_splits_narrow_totals_in_half() {
        let total = f64::from(GIT_DRAWER_MIN_LEFT + GIT_DRAWER_MIN_RIGHT - 40);
        assert_eq!(
            clamp_git_drawer_left_width(300.0, total),
            (total / 2.0).floor() as i32
        );
    }

    #[test]
    fn default_git_drawer_left_width_uses_the_one_third_ratio() {
        let total = 900.0;
        assert_eq!(
            default_git_drawer_left_width(total),
            clamp_git_drawer_left_width(total * GIT_DRAWER_DEFAULT_LEFT_RATIO, total)
        );
    }

    #[test]
    fn drawer_escape_action_blurs_text_fields_then_dismisses_from_body() {
        assert_eq!(
            drawer_escape_action(true, true, false),
            DrawerEscapeAction::BlurField
        );
        assert_eq!(
            drawer_escape_action(true, false, false),
            DrawerEscapeAction::Dismiss
        );
        assert_eq!(
            drawer_escape_action(false, false, true),
            DrawerEscapeAction::Dismiss
        );
        assert_eq!(
            drawer_escape_action(false, false, false),
            DrawerEscapeAction::Ignore
        );
    }
}
