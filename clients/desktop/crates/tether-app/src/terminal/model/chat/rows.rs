//! The transcript as rows: the agent's prose at full width, runs of tool calls as one surface,
//! everything else quiet. Only the recent window is laid out; "Earlier messages" grows it.

use std::collections::HashMap;
use std::sync::Arc;

use tether_core::acp::agent;
use tether_core::acp::diff::{self, DiffRowKind};
use tether_core::acp::files::ChatFiles;
use tether_core::acp::format;
use tether_core::acp::grouping::{self, Block};
use tether_core::acp::images::ImageRef;
use tether_core::acp::message::{ToolKind, ToolStatus};
use tether_core::acp::question::QuestionState;
use tether_core::acp::reducer::{ChatState, CompactionStatus, Item, ItemKind, ToolCall, Turn};
use tether_core::acp::tooldetail;
use tether_core::acp::verbs;

use super::session::{Session, SignIn};
use super::view::{
    DiffKind, Entry, EntryBody, Icon, Picture, Pixels, Row, RowBody, TaskView, ToolState,
};

pub struct RowCtx<'a> {
    pub host: &'a str,
    pub files: Option<&'a ChatFiles>,
    pub thumbs: &'a HashMap<String, Arc<Pixels>>,
    /// What a running turn may show instead of "Working…".
    pub verbs: &'a [String],
    /// Pictures the rows show that have no thumbnail yet, with the file to make one from.
    pub need: Vec<(String, std::path::PathBuf)>,
}

fn icon(kind: &ToolKind) -> Icon {
    match kind {
        ToolKind::Read => Icon::Read,
        ToolKind::Edit => Icon::Edit,
        ToolKind::Delete => Icon::Delete,
        ToolKind::Move => Icon::Move,
        ToolKind::Search => Icon::Search,
        ToolKind::Execute => Icon::Execute,
        ToolKind::Think => Icon::Think,
        ToolKind::Fetch => Icon::Fetch,
        ToolKind::SwitchMode => Icon::SwitchMode,
        ToolKind::Other => Icon::Other,
    }
}

fn diff_kind(kind: DiffRowKind) -> DiffKind {
    match kind {
        DiffRowKind::Hunk => DiffKind::Hunk,
        DiffRowKind::Added => DiffKind::Added,
        DiffRowKind::Removed => DiffKind::Removed,
        DiffRowKind::Context => DiffKind::Context,
        DiffRowKind::Plain => DiffKind::Plain,
    }
}

fn number(n: Option<usize>) -> String {
    n.map(|n| n.to_string()).unwrap_or_default()
}

/// Items that stay in the scroll: an unanswered permission or question lives in its card.
/// The transcript's items: pending asks live in their cards and queued messages above the
/// composer until they start.
pub fn visible(state: &ChatState) -> Vec<Item> {
    state
        .items
        .iter()
        .filter(|i| match &i.kind {
            ItemKind::Permission(p) => p.resolved_option_id.is_some(),
            ItemKind::Question(q) => !q.is_pending(),
            ItemKind::User { .. } => !state.is_queued(i.id),
            _ => true,
        })
        .cloned()
        .collect()
}

/// The block the laid-out window begins at now, when it does not begin at the first one.
pub fn current_start(s: &Session) -> Option<i64> {
    let blocks = grouping::blocks(&visible(s.state()));
    let last: Vec<i64> = blocks.iter().map(Block::last_id).collect();
    let range = grouping::window_range(&last, s.window_start);
    (range.start > 0).then(|| last[range.start])
}

pub fn earlier_start(s: &Session) -> Option<i64> {
    let blocks = grouping::blocks(&visible(s.state()));
    let last: Vec<i64> = blocks.iter().map(Block::last_id).collect();
    let range = grouping::window_range(&last, s.window_start);
    grouping::earlier_start(&last, range)
}

fn pictures(s: &Session, refs: &[ImageRef], ctx: &mut RowCtx<'_>) -> Vec<Picture> {
    refs.iter()
        .map(|r| {
            let pixels = ctx.thumbs.get(&r.id).cloned();
            if pixels.is_none()
                && let Some(files) = ctx.files
            {
                let path = files.images(&s.name).path(r);
                ctx.need.push((r.id.clone(), path));
            }
            Picture {
                id: r.id.clone(),
                width: r.pixel_width.unwrap_or(4),
                height: r.pixel_height.unwrap_or(3),
                pixels,
            }
        })
        .collect()
}

/// Messages waiting for the running turn, oldest first, as one line each.
pub fn queued(s: &Session) -> Vec<String> {
    let state = s.state();
    state
        .queued_item_ids
        .iter()
        .filter_map(|id| state.items.iter().find(|i| i.id == *id))
        .filter_map(|item| match &item.kind {
            ItemKind::User {
                text, image_count, ..
            } => Some(match (text.trim(), *image_count) {
                ("", n) => format::image_label(n),
                (t, 0) => t.to_string(),
                (t, n) => format!("{} \u{00B7} {t}", format::image_label(n)),
            }),
            _ => None,
        })
        .collect()
}

/// The background commands still running, each with the key of the row that opens it.
pub fn tasks(s: &Session) -> Vec<TaskView> {
    let mut out = Vec::new();
    for item in &s.state().items {
        let ItemKind::Tool(call) = &item.kind else {
            continue;
        };
        let key = format!("item:{}", item.id);
        if call.is_background_running() {
            out.push(TaskView {
                key: key.clone(),
                title: call.title.clone(),
            });
        }
        for child in call.children.iter().filter(|c| c.is_background_running()) {
            out.push(TaskView {
                key: format!("child:{key}:{}", child.id),
                title: child.title.clone(),
            });
        }
    }
    out
}

/// Changes when a new prompt starts a turn, so a turn keeps one word.
fn turn_seed(state: &ChatState) -> i64 {
    state
        .items
        .iter()
        .rev()
        .find(|i| matches!(i.kind, ItemKind::User { .. }) && !state.is_queued(i.id))
        .map_or(0, |i| i.id)
}

pub fn build(s: &Session, ctx: &mut RowCtx<'_>) -> Vec<Row> {
    let state = s.state();
    let mut rows = Vec::new();
    if state.items.is_empty() {
        rows.push(Row {
            key: "empty".into(),
            body: RowBody::Empty {
                message: if s.read_only {
                    "Nothing here yet".into()
                } else {
                    "Ask the agent anything".into()
                },
                folder: s.cwd.clone(),
            },
        });
    }
    let blocks = grouping::blocks(&visible(state));
    let last: Vec<i64> = blocks.iter().map(Block::last_id).collect();
    let range = grouping::window_range(&last, s.window_start);
    if range.start > 0 {
        rows.push(Row {
            key: "earlier".into(),
            body: RowBody::Earlier,
        });
    }
    let last_item = state.items.last().map(|i| i.id);
    for block in &blocks[range] {
        match block {
            Block::Item(item) => item_rows(s, item, last_item, ctx, &mut rows),
            Block::Tools(items) => rows.push(Row {
                key: format!("tools:{}", items[0].id),
                body: RowBody::Tools(tool_entries(s, items, ctx)),
            }),
        }
    }
    for failed in s.outbox.failed() {
        let note = if failed.images_not_kept() {
            "Images not kept".to_string()
        } else if failed.image_count() > 0 {
            format::image_label(failed.image_count())
        } else {
            String::new()
        };
        rows.push(Row {
            key: failed.id.to_string(),
            body: RowBody::NotSent {
                text: failed.text.clone(),
                note,
                can_retry: s.can_send() && failed.can_retry(),
            },
        });
    }
    if state.turn == Turn::Working && !s.answer_pending() {
        rows.push(Row {
            key: "working".into(),
            body: RowBody::Working(state.subagent_activity().unwrap_or_else(|| {
                verbs::pick(agent::spinner_verbs(s.agent(), ctx.verbs), turn_seed(state))
            })),
        });
    }
    rows
}

fn item_rows(
    s: &Session,
    item: &Item,
    last_item: Option<i64>,
    ctx: &mut RowCtx<'_>,
    rows: &mut Vec<Row>,
) {
    let key = format!("item:{}", item.id);
    let body = match &item.kind {
        ItemKind::User {
            text,
            image_count,
            images,
            ..
        } => RowBody::User {
            text: text.clone(),
            images: pictures(s, images, ctx),
            image_label: if images.is_empty() && *image_count > 0 {
                format::image_label(*image_count)
            } else {
                String::new()
            },
        },
        ItemKind::Assistant { text, .. } => {
            for (n, md) in tether_core::markdown::items(text).into_iter().enumerate() {
                rows.push(Row {
                    key: format!("{key}:{n}"),
                    body: RowBody::Markdown(md),
                });
            }
            return;
        }
        ItemKind::Images { refs, .. } => RowBody::Pictures(pictures(s, refs, ctx)),
        ItemKind::Thought { text } => RowBody::Thought {
            text: text.clone(),
            open: s.expanded.contains(&key),
        },
        ItemKind::Tool(_) | ItemKind::Permission(_) => {
            RowBody::Tools(tool_entries(s, std::slice::from_ref(item), ctx))
        }
        ItemKind::Question(q) => {
            let (answer, answered) = match &q.state {
                QuestionState::Pending => return,
                QuestionState::Answered(_) => (
                    q.answer_summary().unwrap_or_else(|| "Answered".into()),
                    true,
                ),
                QuestionState::Declined => ("Declined".into(), false),
                QuestionState::Cancelled => ("No answer".into(), false),
            };
            RowBody::Answered {
                question: q.message.clone(),
                answer,
                answered,
            }
        }
        ItemKind::Plan(entries) => {
            let open = s.expanded.contains(&key);
            let done = entries.iter().filter(|e| e.status == "completed").count();
            let current = entries
                .iter()
                .find(|e| e.status == "in_progress")
                .map(|e| e.content.clone())
                .unwrap_or_default();
            let steps = if open {
                entries
                    .iter()
                    .enumerate()
                    .map(|(n, e)| Entry {
                        key: format!("{key}:step:{n}"),
                        depth: 0,
                        first: n == 0,
                        body: EntryBody::PlanStep {
                            state: match e.status.as_str() {
                                "completed" => 2,
                                "in_progress" => 1,
                                _ => 0,
                            },
                            text: e.content.clone(),
                        },
                    })
                    .collect()
            } else {
                Vec::new()
            };
            RowBody::Plan {
                summary: format!("Plan \u{00B7} {done} of {}", entries.len()),
                current,
                open,
                steps,
            }
        }
        ItemKind::Notice(text) => RowBody::Notice(text.clone()),
        ItemKind::AgentNotice {
            severity,
            title,
            description,
        } => RowBody::AgentNotice {
            severity: match severity.as_deref() {
                Some("info") => 1,
                Some("warning") => 2,
                Some("error") => 3,
                _ => 0,
            },
            title: title.clone(),
            description: description.clone().unwrap_or_default(),
        },
        ItemKind::Compaction {
            status, summary, ..
        } => RowBody::Compaction {
            state: match status {
                CompactionStatus::InProgress => 0,
                CompactionStatus::Completed => 1,
                CompactionStatus::Failed => 2,
                CompactionStatus::Cancelled => 3,
            },
            label: match status {
                CompactionStatus::InProgress => "Compacting context\u{2026}",
                CompactionStatus::Completed => "Context compacted",
                CompactionStatus::Failed => "Compaction failed",
                CompactionStatus::Cancelled => "Compaction cancelled",
            }
            .into(),
            summary: summary.trim().to_string(),
            open: s.expanded.contains(&key) && !summary.trim().is_empty(),
        },
        ItemKind::Error(text) => RowBody::Error(text.clone()),
        ItemKind::Divider(text) => RowBody::Divider(text.clone()),
        ItemKind::SignedOut => RowBody::SignedOut {
            message: agent::sign_in_message(s.agent(), ctx.host),
            retry: (s.needs_sign_in() && Some(item.id) == last_item).then_some(match s.sign_in {
                SignIn::Idle => 0,
                SignIn::Checking => 1,
                SignIn::StillSignedOut => 2,
            }),
        },
    };
    rows.push(Row { key, body });
}

fn status(shown: ToolStatus, active: bool) -> ToolState {
    if active {
        ToolState::Running
    } else if shown == ToolStatus::Failed {
        ToolState::Failed
    } else {
        ToolState::Done
    }
}

fn tool_entries(s: &Session, items: &[Item], ctx: &mut RowCtx<'_>) -> Vec<Entry> {
    let mut out = Vec::new();
    for item in items {
        let key = format!("item:{}", item.id);
        let first = out.is_empty();
        match &item.kind {
            ItemKind::Tool(call) if call.subagent.is_some() => {
                subagent(s, call, &key, first, ctx, &mut out);
            }
            ItemKind::Tool(call) => tool(s, call, &key, 0, first, ctx, &mut out),
            ItemKind::Permission(p) => {
                let Some(resolved) = &p.resolved_option_id else {
                    continue;
                };
                let option = p.options.iter().find(|o| &o.option_id == resolved);
                let allowed = option.is_some_and(|o| {
                    format::PermissionRole::from_kind(&o.kind)
                        != format::PermissionRole::Destructive
                });
                out.push(Entry {
                    key,
                    depth: 0,
                    first,
                    body: EntryBody::Resolved {
                        allowed,
                        title: format!(
                            "{} \u{00B7} {}",
                            option.map_or("Cancelled", |o| o.name.as_str()),
                            p.title
                        ),
                    },
                });
            }
            _ => {}
        }
    }
    out
}

/// A closed tool row shows at most two lines of its title (a heredoc command can run to hundreds).
fn two_lines(title: &str) -> Option<String> {
    let mut lines = title.trim_end().lines();
    let kept: Vec<&str> = lines.by_ref().take(2).collect();
    lines.next()?;
    Some(kept.join("\n") + " \u{2026}")
}

fn tool(
    s: &Session,
    call: &ToolCall,
    key: &str,
    depth: u8,
    first: bool,
    ctx: &mut RowCtx<'_>,
    out: &mut Vec<Entry>,
) {
    let file = call.diff.as_ref().map(|d| diff::file_for(d, &s.cwd));
    let short = two_lines(&call.title);
    // A Workflow row the host lists opens the run's sheet instead of unfolding.
    let sheet = s.workflow_listed(call);
    let shown = s.tool_status(call);
    let expandable = sheet
        || call.diff.is_some()
        || !call.images.is_empty()
        || short.is_some()
        || tooldetail::has_content(call.text.as_deref(), call.raw_output.as_deref());
    let open = expandable && !sheet && s.expanded.contains(key);
    let running = matches!(shown, ToolStatus::Pending | ToolStatus::InProgress);
    out.push(Entry {
        key: key.to_string(),
        depth,
        first,
        body: EntryBody::Tool {
            icon: if call.images.is_empty() {
                icon(&call.kind)
            } else {
                Icon::Image
            },
            title: short
                .filter(|_| !open)
                .unwrap_or_else(|| call.title.clone()),
            subtitle: String::new(),
            state: status(shown, running || call.is_background_running()),
            added: file.as_ref().map_or(0, |f| f.added),
            removed: file.as_ref().map_or(0, |f| f.removed),
            expandable,
            open,
            background: call.is_background_running(),
        },
    });
    if !open {
        return;
    }
    if let Some(file) = file {
        for (n, row) in file.rows.iter().enumerate() {
            out.push(Entry {
                key: format!("{key}:diff:{n}"),
                depth,
                first: false,
                body: EntryBody::Diff {
                    kind: diff_kind(row.kind),
                    old: number(row.old_line),
                    new: number(row.new_line),
                    text: row.text.clone(),
                },
            });
        }
        return;
    }
    if !call.images.is_empty() {
        out.push(Entry {
            key: format!("{key}:images"),
            depth,
            first: false,
            body: EntryBody::Pictures(pictures(s, &call.images, ctx)),
        });
    }
    for (n, md) in tooldetail::blocks(call.text.as_deref(), call.raw_output.as_deref())
        .into_iter()
        .enumerate()
    {
        out.push(Entry {
            key: format!("{key}:md:{n}"),
            depth,
            first: false,
            body: EntryBody::Markdown(md),
        });
    }
}

fn subagent(
    s: &Session,
    call: &ToolCall,
    key: &str,
    first: bool,
    ctx: &mut RowCtx<'_>,
    out: &mut Vec<Entry>,
) {
    let info = call.subagent.as_ref();
    let background = info.is_some_and(|i| i.background);
    let report = (!background && tooldetail::has_content(call.text.as_deref(), None))
        .then(|| call.text.clone())
        .flatten();
    let brief = info
        .and_then(|i| i.prompt.clone())
        .filter(|p| !p.trim().is_empty());
    let expandable = !call.children.is_empty() || brief.is_some() || report.is_some();
    let open = expandable && s.expanded.contains(key);
    let mut parts = Vec::new();
    if let Some(model) = info.and_then(|i| i.model.clone()) {
        parts.push(model);
    }
    if background {
        parts.push("background".to_string());
    }
    match call.children.len() {
        0 => {}
        1 => parts.push("1 tool call".into()),
        n => parts.push(format!("{n} tool calls")),
    }
    out.push(Entry {
        key: key.to_string(),
        depth: 0,
        first,
        body: EntryBody::Tool {
            icon: Icon::Subagent,
            title: call.subagent_title(),
            subtitle: parts.join(" \u{00B7} "),
            state: status(call.status, call.is_active()),
            added: 0,
            removed: 0,
            expandable,
            open,
            background: false,
        },
    });
    if !open {
        return;
    }
    for child in &call.children {
        let child_key = format!("child:{key}:{}", child.id);
        tool(s, child, &child_key, 1, false, ctx, out);
    }
    if let Some(brief) = brief {
        let brief_key = format!("brief:{key}");
        let brief_open = s.expanded.contains(&brief_key);
        out.push(Entry {
            key: brief_key.clone(),
            depth: 0,
            first: false,
            body: EntryBody::BriefToggle { open: brief_open },
        });
        if brief_open {
            for (n, md) in tooldetail::blocks(Some(&brief), None)
                .into_iter()
                .enumerate()
            {
                out.push(Entry {
                    key: format!("{brief_key}:{n}"),
                    depth: 0,
                    first: false,
                    body: EntryBody::Markdown(md),
                });
            }
        }
    }
    if let Some(report) = report {
        out.push(Entry {
            key: format!("report:{key}"),
            depth: 0,
            first: false,
            body: EntryBody::ReportLabel,
        });
        for (n, md) in tooldetail::blocks(Some(&report), None)
            .into_iter()
            .enumerate()
        {
            out.push(Entry {
                key: format!("report:{key}:{n}"),
                depth: 0,
                first: false,
                body: EntryBody::Markdown(md),
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::two_lines;

    #[test]
    fn a_long_title_keeps_two_lines_and_a_short_one_is_left_alone() {
        assert_eq!(
            two_lines("cat <<EOF\na\nb\nEOF"),
            Some("cat <<EOF\na \u{2026}".into())
        );
        assert_eq!(two_lines("git status\nls\n"), None);
        assert_eq!(two_lines("Read file"), None);
    }
}
