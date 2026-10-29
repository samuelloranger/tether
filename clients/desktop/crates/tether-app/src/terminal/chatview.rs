//! The chat pane's Slint side: the model's `ChatScreen` in, callbacks back as messages.

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;

use slint::{ComponentHandle, Model, ModelRc, SharedPixelBuffer, SharedString, VecModel};
use tether_core::markdown::{Item as MdItem, ItemKind};

use crate::terminal::model::Msg;
use crate::terminal::model::chat::view::*;
use crate::terminal::model::chat::{ChatMsg, Pixels};
use crate::{
    AttachmentVm, ChatEntryVm, ChatImageVm, ChatRowVm, ChatTabVm, ChatTaskVm, ChatVm,
    ChatWorkflowVm, CtlChoiceVm, CtlCommandVm, CtlOptionVm, DiffLineVm, MdItemVm, MdLinkVm,
    NcChoiceVm, NcMenuVm, PaletteItemVm, PermOptionVm, QChoiceVm, QFieldVm, QueuedVm,
    SavedSessionVm, WfAgentVm, WfPhaseVm,
};

thread_local! {
    static IMAGES: RefCell<HashMap<usize, slint::Image>> = RefCell::new(HashMap::new());
    static ROWS: RefCell<Vec<Row>> = const { RefCell::new(Vec::new()) };
    static FIELDS: RefCell<Vec<FieldView>> = const { RefCell::new(Vec::new()) };
    static DRAFT_SEQ: RefCell<Option<u64>> = const { RefCell::new(None) };
    static DIALOG_SHOWN: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

fn model<T: Clone + 'static>(items: Vec<T>) -> ModelRc<T> {
    ModelRc::new(VecModel::from(items))
}

/// One Slint image per decoded picture: the pixels are copied once, not on every redraw.
fn image(p: &Arc<Pixels>) -> slint::Image {
    let key = Arc::as_ptr(p) as usize;
    IMAGES.with(|cache| {
        let mut cache = cache.borrow_mut();
        if let Some(img) = cache.get(&key) {
            return img.clone();
        }
        let img = slint::Image::from_rgba8(SharedPixelBuffer::clone_from_slice(
            &p.rgba, p.width, p.height,
        ));
        // Pictures leave with the chat; a bounded cache keeps a long session from holding them all.
        if cache.len() > 256 {
            cache.clear();
        }
        cache.insert(key, img.clone());
        img
    })
}

fn md_kind(k: ItemKind) -> i32 {
    match k {
        ItemKind::Heading => 0,
        ItemKind::Paragraph => 1,
        ItemKind::Bullet => 2,
        ItemKind::Numbered => 3,
        ItemKind::Code => 4,
        ItemKind::Quote => 5,
        ItemKind::Rule => 6,
        ItemKind::Table => 7,
    }
}

fn links(md: &MdItem) -> ModelRc<MdLinkVm> {
    model(
        md.links
            .iter()
            .map(|l| MdLinkVm {
                label: l.label.as_str().into(),
                url: l.url.as_str().into(),
            })
            .collect(),
    )
}

fn md_vm(md: &MdItem) -> MdItemVm {
    MdItemVm {
        kind: md_kind(md.kind),
        level: i32::from(md.level),
        text: md.text.as_str().into(),
        links: links(md),
    }
}

fn diff_kind(k: DiffKind) -> i32 {
    match k {
        DiffKind::Hunk => 1,
        DiffKind::Added => 2,
        DiffKind::Removed => 3,
        DiffKind::Context => 4,
        DiffKind::Plain => 5,
    }
}

fn diff_vm(l: &DiffLine) -> DiffLineVm {
    DiffLineVm {
        kind: diff_kind(l.kind),
        old_no: l.old.as_str().into(),
        new_no: l.new.as_str().into(),
        text: l.text.as_str().into(),
        stat: SharedString::new(),
    }
}

fn pictures(list: &[Picture]) -> ModelRc<ChatImageVm> {
    model(
        list.iter()
            .map(|p| ChatImageVm {
                id: p.id.as_str().into(),
                image: p.pixels.as_ref().map(image).unwrap_or_default(),
                width: p.width as i32,
                height: p.height as i32,
                loaded: p.pixels.is_some(),
            })
            .collect(),
    )
}

fn tool_state(s: ToolState) -> i32 {
    match s {
        ToolState::Running => 0,
        ToolState::Done => 1,
        ToolState::Failed => 2,
    }
}

fn entry_vm(e: &Entry) -> ChatEntryVm {
    let mut vm = ChatEntryVm {
        key: e.key.as_str().into(),
        depth: i32::from(e.depth),
        first: e.first,
        ..Default::default()
    };
    match &e.body {
        EntryBody::Tool {
            icon,
            title,
            subtitle,
            state,
            added,
            removed,
            expandable,
            open,
            background,
        } => {
            vm.kind = 0;
            vm.background = *background;
            vm.icon = *icon as i32;
            vm.title = title.as_str().into();
            vm.subtitle = subtitle.as_str().into();
            vm.state = tool_state(*state);
            vm.added = *added as i32;
            vm.removed = *removed as i32;
            vm.expandable = *expandable;
            vm.open = *open;
        }
        EntryBody::Resolved { allowed, title } => {
            vm.kind = 1;
            vm.icon = if *allowed {
                Icon::Allowed as i32
            } else {
                Icon::Refused as i32
            };
            vm.state = if *allowed { 1 } else { 3 };
            vm.title = title.as_str().into();
        }
        EntryBody::Markdown(md) => {
            vm.kind = 2;
            vm.md_kind = md_kind(md.kind);
            vm.level = i32::from(md.level);
            vm.text = md.text.as_str().into();
            vm.links = links(md);
        }
        EntryBody::Diff {
            kind,
            old,
            new,
            text,
        } => {
            vm.kind = 3;
            vm.diff_kind = diff_kind(*kind);
            vm.old_no = old.as_str().into();
            vm.new_no = new.as_str().into();
            vm.text = text.as_str().into();
        }
        EntryBody::Pictures(list) => {
            vm.kind = 4;
            vm.images = pictures(list);
        }
        EntryBody::BriefToggle { open } => {
            vm.kind = 5;
            vm.title = "Brief".into();
            vm.open = *open;
        }
        EntryBody::ReportLabel => {
            vm.kind = 6;
            vm.title = "Report".into();
        }
        EntryBody::PlanStep { state, text } => {
            vm.kind = 7;
            vm.state = i32::from(*state);
            vm.text = text.as_str().into();
        }
    }
    vm
}

fn row_vm(r: &Row) -> ChatRowVm {
    let mut vm = ChatRowVm {
        key: r.key.as_str().into(),
        ..Default::default()
    };
    match &r.body {
        RowBody::User {
            text,
            images,
            image_label,
        } => {
            vm.kind = 0;
            vm.text = text.as_str().into();
            vm.images = pictures(images);
            vm.meta = image_label.as_str().into();
        }
        RowBody::Markdown(md) => {
            vm.kind = 1;
            vm.md_kind = md_kind(md.kind);
            vm.level = i32::from(md.level);
            vm.text = md.text.as_str().into();
            vm.links = links(md);
        }
        RowBody::Pictures(list) => {
            vm.kind = 2;
            vm.images = pictures(list);
        }
        RowBody::Thought { text, open } => {
            vm.kind = 3;
            vm.text = text.as_str().into();
            vm.open = *open;
        }
        RowBody::Tools(entries) => {
            vm.kind = 4;
            vm.entries = model(entries.iter().map(entry_vm).collect());
        }
        RowBody::Plan {
            summary,
            current,
            open,
            steps,
        } => {
            vm.kind = 5;
            vm.text = summary.as_str().into();
            vm.detail = current.as_str().into();
            vm.open = *open;
            vm.entries = model(steps.iter().map(entry_vm).collect());
        }
        RowBody::Notice(text) => {
            vm.kind = 6;
            vm.text = text.as_str().into();
        }
        RowBody::AgentNotice {
            severity,
            title,
            description,
        } => {
            vm.kind = 15;
            vm.state = i32::from(*severity);
            vm.text = title.as_str().into();
            vm.detail = description.as_str().into();
        }
        RowBody::Compaction {
            state,
            label,
            summary,
            open,
        } => {
            vm.kind = 16;
            vm.state = i32::from(*state);
            vm.text = label.as_str().into();
            vm.detail = summary.as_str().into();
            vm.flag = !summary.is_empty();
            vm.open = *open;
        }
        RowBody::Error(text) => {
            vm.kind = 7;
            vm.text = text.as_str().into();
        }
        RowBody::Divider(text) => {
            vm.kind = 8;
            vm.text = text.as_str().into();
        }
        RowBody::SignedOut { message, retry } => {
            vm.kind = 9;
            vm.text = message.as_str().into();
            vm.state = retry.map_or(-1, i32::from);
        }
        RowBody::Answered {
            question,
            answer,
            answered,
        } => {
            vm.kind = 10;
            vm.text = question.as_str().into();
            vm.detail = answer.as_str().into();
            vm.flag = *answered;
        }
        RowBody::NotSent {
            text,
            note,
            can_retry,
        } => {
            vm.kind = 11;
            vm.text = text.as_str().into();
            vm.meta = note.as_str().into();
            vm.open = *can_retry;
        }
        RowBody::Working(text) => {
            vm.kind = 12;
            vm.text = text.as_str().into();
        }
        RowBody::Earlier => vm.kind = 13,
        RowBody::Empty { message, folder } => {
            vm.kind = 14;
            vm.text = message.as_str().into();
            vm.detail = folder.as_str().into();
        }
    }
    vm
}

/// Rows change in place: replacing the model would rebuild every row (and drop a selection)
/// on each streamed chunk.
fn sync<V: PartialEq + Clone, T: Clone + 'static>(
    current: ModelRc<T>,
    shown: &RefCell<Vec<V>>,
    next: &[V],
    convert: impl Fn(&V) -> T,
) -> Option<ModelRc<T>> {
    let mut shown = shown.borrow_mut();
    let Some(vec) = current.as_any().downcast_ref::<VecModel<T>>() else {
        *shown = next.to_vec();
        return Some(model(next.iter().map(convert).collect()));
    };
    if vec.row_count() != shown.len() {
        *shown = next.to_vec();
        return Some(model(next.iter().map(convert).collect()));
    }
    while vec.row_count() > next.len() {
        vec.remove(vec.row_count() - 1);
    }
    for (i, row) in next.iter().enumerate() {
        if i >= vec.row_count() {
            vec.push(convert(row));
        } else if shown.get(i) != Some(row) {
            vec.set_row_data(i, convert(row));
        }
    }
    *shown = next.to_vec();
    None
}

/// How the queued strip goes from the messages it shows to `next`: the first `leaving` start or
/// are removed, and `arriving` join at the back. Messages leave from the front and arrive at
/// the back, so the smallest such split is the one that happened.
fn queue_shift<'a>(shown: &[String], next: &'a [String]) -> (usize, &'a [String]) {
    (0..=shown.len())
        .find_map(|k| {
            let kept = &shown[k..];
            next.starts_with(kept).then(|| (k, &next[kept.len()..]))
        })
        .unwrap_or((shown.len(), next))
}

/// How long a leaving chip stays to fade out (`Motion.base` and a frame).
const QUEUED_FADE: std::time::Duration = std::time::Duration::from_millis(200);

fn sync_queued(vm: &ChatVm, next: &[String]) {
    let current = vm.get_queued();
    let Some(rows) = current.as_any().downcast_ref::<VecModel<QueuedVm>>() else {
        vm.set_queued(model(next.iter().map(|t| queued_vm(t, false)).collect()));
        return;
    };
    let staying: Vec<(usize, String)> = rows
        .iter()
        .enumerate()
        .filter(|(_, q)| !q.leaving)
        .map(|(i, q)| (i, q.text.to_string()))
        .collect();
    let shown: Vec<String> = staying.iter().map(|(_, t)| t.clone()).collect();
    let (leaving, arriving) = queue_shift(&shown, next);
    for (i, text) in staying.iter().take(leaving) {
        rows.set_row_data(*i, queued_vm(text, true));
    }
    for text in arriving {
        rows.push(queued_vm(text, false));
    }
    if leaving > 0 {
        let rows = current.clone();
        slint::Timer::single_shot(QUEUED_FADE, move || {
            if let Some(rows) = rows.as_any().downcast_ref::<VecModel<QueuedVm>>() {
                for i in (0..rows.row_count()).rev() {
                    if rows.row_data(i).is_some_and(|q| q.leaving) {
                        rows.remove(i);
                    }
                }
            }
        });
    }
}

fn queued_vm(text: &str, leaving: bool) -> QueuedVm {
    QueuedVm {
        text: text.into(),
        leaving,
    }
}

fn option(o: &Option<(String, String)>) -> PermOptionVm {
    o.as_ref()
        .map(|(id, label)| PermOptionVm {
            id: id.as_str().into(),
            label: label.as_str().into(),
        })
        .unwrap_or_default()
}

fn field_vm(f: &FieldView) -> QFieldVm {
    QFieldVm {
        name: f.name.as_str().into(),
        title: f.title.as_str().into(),
        show_title: f.show_title,
        kind: i32::from(f.kind),
        choices: model(
            f.choices
                .iter()
                .map(|c| QChoiceVm {
                    value: c.value.as_str().into(),
                    title: c.title.as_str().into(),
                    description: c.description.as_str().into(),
                    picked: c.picked,
                })
                .collect(),
        ),
        custom_name: f.custom_name.as_str().into(),
        custom_open: f.custom_open,
        custom_text: f.custom_text.as_str().into(),
        text: f.text.as_str().into(),
        placeholder: f.placeholder.as_str().into(),
        flag: f.flag,
    }
}

pub fn apply(w: &crate::AppWindow, s: ChatScreen) {
    let vm = w.global::<ChatVm>();
    vm.set_active(s.active);
    vm.set_has_chats(!s.tabs.is_empty());
    vm.set_tabs(model(
        s.tabs
            .iter()
            .map(|t| ChatTabVm {
                name: t.name.as_str().into(),
                title: t.title.as_str().into(),
                state: i32::from(t.state),
                label: t.label.as_str().into(),
                active: t.active,
                agent: i32::from(t.agent),
            })
            .collect(),
    ));
    vm.set_delete_title(s.delete_title.as_str().into());
    match &s.new_chat {
        Some(nc) => {
            vm.set_nc_open(true);
            // The field is the user's once the dialog is up: an echo of an older keystroke
            // arriving late would undo the newer ones.
            if !DIALOG_SHOWN.replace(true) {
                vm.set_nc_mode(i32::from(nc.mode));
                vm.set_nc_folder(nc.folder.as_str().into());
                // `TETHER_DEV_CHAT_OPTIONS` opens the Options row for a screenshot.
                vm.set_nc_opts_open(
                    cfg!(debug_assertions)
                        && crate::app::dev_env("TETHER_DEV_CHAT_OPTIONS").is_some(),
                );
            }
            vm.set_nc_agent(i32::from(nc.agent));
            vm.set_nc_unavailable(model(nc.unavailable.clone()));
            vm.set_nc_summary(nc.summary.as_str().into());
            vm.set_nc_note(nc.note.as_str().into());
            vm.set_nc_is_reset(nc.reset);
            vm.set_nc_menus(model(
                nc.menus
                    .iter()
                    .map(|m| NcMenuVm {
                        id: m.id.as_str().into(),
                        name: m.name.as_str().into(),
                        value_name: m.value_name.as_str().into(),
                        changed: m.changed,
                        choices: model(
                            m.choices
                                .iter()
                                .map(|c| NcChoiceVm {
                                    value: c.value.as_str().into(),
                                    name: c.name.as_str().into(),
                                    selected: c.selected,
                                })
                                .collect(),
                        ),
                    })
                    .collect(),
            ));
            vm.set_nc_busy(nc.busy);
            vm.set_nc_error(nc.error.as_str().into());
            vm.set_nc_continuing(nc.continuing);
            let (listing, error, sessions) = match &nc.listing {
                ListingView::Loading => (0, String::new(), Vec::new()),
                ListingView::Failed(m) => (1, m.clone(), Vec::new()),
                ListingView::Loaded(list) => (2, String::new(), list.clone()),
            };
            vm.set_nc_listing(listing);
            vm.set_nc_listing_error(error.into());
            vm.set_nc_sessions(model(
                sessions
                    .iter()
                    .map(|v| SavedSessionVm {
                        id: v.id.as_str().into(),
                        title: v.title.as_str().into(),
                        when: v.when.as_str().into(),
                        recent: v.recent,
                        busy: v.busy,
                    })
                    .collect(),
            ));
        }
        None => {
            DIALOG_SHOWN.set(false);
            vm.set_nc_open(false);
        }
    }
    if !s.active {
        vm.set_ctl_open(false);
        vm.set_review_open(false);
        vm.set_wf_open(false);
        vm.set_viewer_open(false);
        return;
    }

    let h = &s.header;
    vm.set_title(h.title.as_str().into());
    vm.set_folder(h.folder.as_str().into());
    vm.set_folder_copied(h.folder_copied);
    vm.set_phase(i32::from(h.phase));
    vm.set_phase_word(h.phase_word.as_str().into());
    vm.set_agent(i32::from(h.agent));
    vm.set_agent_label(h.agent_label.as_str().into());
    vm.set_has_status(!h.model.is_empty() || !h.mode.is_empty());
    vm.set_model_name(h.model.as_str().into());
    vm.set_mode_name(h.mode.as_str().into());
    vm.set_mode_tint(i32::from(h.mode_tint));
    vm.set_stats(h.stats.as_str().into());
    vm.set_context(h.context.unwrap_or(-1.0));
    vm.set_context_text(h.context_text.as_str().into());
    vm.set_follow_seq(s.follow_seq as i32);
    vm.set_focus_seq(s.focus_seq as i32);
    vm.set_notice(s.notice.as_str().into());

    ROWS.with(|shown| {
        if let Some(fresh) = sync(vm.get_rows(), shown, &s.rows, row_vm) {
            vm.set_rows(fresh);
        }
    });

    sync_queued(&vm, &s.queued);

    let tasks: Vec<ChatTaskVm> = s
        .tasks
        .iter()
        .map(|t| ChatTaskVm {
            key: t.key.as_str().into(),
            title: t.title.as_str().into(),
        })
        .collect();
    if vm.get_tasks().iter().ne(tasks.iter().cloned()) {
        vm.set_tasks(model(tasks));
    }
    let workflows: Vec<ChatWorkflowVm> = s
        .workflows
        .iter()
        .map(|w| ChatWorkflowVm {
            call_id: w.call_id.as_str().into(),
            text: w.text.as_str().into(),
        })
        .collect();
    if vm.get_workflows().iter().ne(workflows.iter().cloned()) {
        vm.set_workflows(model(workflows));
    }
    match &s.workflow {
        Some(w) => {
            vm.set_wf_open(true);
            vm.set_wf_missing(w.missing);
            vm.set_wf_title(w.title.as_str().into());
            vm.set_wf_status(w.status.as_str().into());
            vm.set_wf_state(i32::from(w.state));
            vm.set_wf_counts(w.counts.as_str().into());
            vm.set_wf_elapsed(w.elapsed.as_str().into());
            vm.set_wf_quiet(w.quiet.as_str().into());
            vm.set_wf_description(w.description.as_str().into());
            vm.set_wf_summary(w.summary.as_str().into());
            vm.set_wf_spoken(w.spoken.as_str().into());
            vm.set_wf_phases(model(
                w.phases
                    .iter()
                    .map(|p| WfPhaseVm {
                        title: p.title.as_str().into(),
                        agents: model(
                            p.agents
                                .iter()
                                .map(|a| WfAgentVm {
                                    label: a.label.as_str().into(),
                                    state: i32::from(a.state),
                                    elapsed: a.elapsed.as_str().into(),
                                    activity: a.activity.as_str().into(),
                                    spoken: a.spoken.as_str().into(),
                                })
                                .collect(),
                        ),
                    })
                    .collect(),
            ));
        }
        None => vm.set_wf_open(false),
    }

    let c = &s.composer;
    vm.set_composer_shown(c.shown);
    vm.set_banner(c.banner.as_str().into());
    vm.set_banner_icon(c.banner_icon.map_or(15, |i| i as i32));
    vm.set_placeholder(c.placeholder.as_str().into());
    vm.set_dimmed(c.dimmed);
    vm.set_catching_up(c.catching_up);
    vm.set_can_send(c.can_send);
    vm.set_stopping(c.stopping);
    vm.set_action_enabled(c.action_enabled);
    vm.set_action_label(c.action_label.as_str().into());
    vm.set_attachments(model(
        c.attachments
            .iter()
            .map(|a| AttachmentVm {
                key: a.key.as_str().into(),
                image: a.thumb.as_ref().map(image).unwrap_or_default(),
                ready: a.thumb.is_some(),
            })
            .collect(),
    ));
    vm.set_attach_error(c.attach_error.as_str().into());
    match &c.palette {
        Some((kind, rows)) => {
            let kind = match kind {
                PaletteKind::Slash => 1,
                PaletteKind::Files => 2,
            };
            if vm.get_palette_kind() != kind {
                vm.set_palette_index(0);
            }
            vm.set_palette_kind(kind);
            vm.set_palette(model(
                rows.iter()
                    .map(|(p, s)| PaletteItemVm {
                        primary: p.as_str().into(),
                        secondary: s.as_str().into(),
                    })
                    .collect(),
            ));
            if vm.get_palette_index() >= rows.len() as i32 {
                vm.set_palette_index(0);
            }
        }
        None => {
            vm.set_palette_kind(0);
            vm.set_palette(model(Vec::new()));
        }
    }
    if let (Some(draft), Some((seq, caret))) = (&s.draft, s.caret) {
        let changed = DRAFT_SEQ.with(|d| d.replace(Some(seq)) != Some(seq));
        if changed {
            vm.set_draft(draft.as_str().into());
            vm.set_caret(caret as i32);
            vm.set_caret_seq(vm.get_caret_seq() + 1);
        }
    }

    match &s.permission {
        Some(p) => {
            vm.set_perm_shown(true);
            vm.set_perm_plan(p.plan);
            vm.set_perm_icon(p.icon as i32);
            vm.set_perm_title(p.title.as_str().into());
            vm.set_perm_position(p.position.as_str().into());
            vm.set_perm_path(p.path.as_str().into());
            vm.set_perm_added(p.added as i32);
            vm.set_perm_removed(p.removed as i32);
            vm.set_perm_rows(model(p.preview.iter().map(diff_vm).collect()));
            vm.set_perm_md(model(p.plan_items.iter().map(md_vm).collect()));
            vm.set_perm_text(p.text.as_str().into());
            vm.set_perm_primary(option(&p.primary));
            vm.set_perm_reject(option(&p.reject));
            vm.set_perm_more(model(
                p.more
                    .iter()
                    .map(|(id, label)| PermOptionVm {
                        id: id.as_str().into(),
                        label: label.as_str().into(),
                    })
                    .collect(),
            ));
            vm.set_perm_collapsed(p.collapsed);
            vm.set_perm_enabled(p.enabled);
            vm.set_perm_failure(p.failure.as_str().into());
        }
        None => vm.set_perm_shown(false),
    }

    match &s.question {
        Some(q) => {
            vm.set_q_shown(true);
            vm.set_q_message(q.message.as_str().into());
            vm.set_q_position(q.position.as_str().into());
            FIELDS.with(|shown| {
                if let Some(fresh) = sync(vm.get_q_fields(), shown, &q.fields, field_vm) {
                    vm.set_q_fields(fresh);
                }
            });
            vm.set_q_show_submit(q.show_submit);
            vm.set_q_can_submit(q.can_submit);
            vm.set_q_enabled(q.enabled);
            vm.set_q_failure(q.failure.as_str().into());
        }
        None => {
            vm.set_q_shown(false);
            FIELDS.with(|shown| shown.borrow_mut().clear());
            vm.set_q_fields(model(Vec::new()));
        }
    }

    match &s.controls {
        Some(ctl) => {
            vm.set_ctl_open(true);
            vm.set_ctl_read_only(ctl.read_only);
            vm.set_ctl_enabled(ctl.enabled);
            vm.set_ctl_cost(ctl.cost.as_str().into());
            vm.set_ctl_model_id(ctl.model_id.as_str().into());
            vm.set_ctl_commands_enabled(ctl.commands_enabled);
            vm.set_bypass_confirm(ctl.bypass_confirm);
            vm.set_ctl_options(model(
                ctl.options
                    .iter()
                    .map(|o| CtlOptionVm {
                        id: o.id.as_str().into(),
                        name: o.name.as_str().into(),
                        failure: o.failure.as_str().into(),
                        choices: model(
                            o.choices
                                .iter()
                                .map(|c| CtlChoiceVm {
                                    value: c.value.as_str().into(),
                                    name: c.name.as_str().into(),
                                    description: c.description.as_str().into(),
                                    selected: c.selected,
                                    pending: c.pending,
                                })
                                .collect(),
                        ),
                    })
                    .collect(),
            ));
            vm.set_ctl_commands(model(
                ctl.commands
                    .iter()
                    .map(|(title, detail, text)| CtlCommandVm {
                        title: title.as_str().into(),
                        detail: detail.as_str().into(),
                        text: text.as_str().into(),
                    })
                    .collect(),
            ));
        }
        None => {
            vm.set_ctl_open(false);
            vm.set_bypass_confirm(false);
        }
    }

    match &s.review {
        Some(r) => {
            vm.set_review_open(true);
            vm.set_review_title(r.title.as_str().into());
            let mut lines: Vec<DiffLineVm> = r.diff.iter().map(diff_vm).collect();
            if !lines.is_empty() && !r.stat.is_empty() {
                lines.insert(
                    0,
                    DiffLineVm {
                        kind: 0,
                        text: r.title.as_str().into(),
                        stat: r.stat.as_str().into(),
                        ..Default::default()
                    },
                );
            }
            vm.set_review_diff(model(lines));
            vm.set_review_md(model(r.markdown.iter().map(md_vm).collect()));
        }
        None => vm.set_review_open(false),
    }

    match &s.viewer {
        Some(Some(p)) => {
            vm.set_viewer_open(true);
            vm.set_viewer_missing(false);
            vm.set_viewer_image(p.pixels.as_ref().map(image).unwrap_or_default());
        }
        Some(None) => {
            vm.set_viewer_open(true);
            vm.set_viewer_missing(true);
        }
        None => vm.set_viewer_open(false),
    }
}

fn send(m: ChatMsg) {
    if let Some(sink) = crate::terminal::glue::current() {
        sink(Msg::Chat(m));
    }
}

fn index(i: i32) -> usize {
    usize::try_from(i).unwrap_or(0)
}

/// Wired once per window, like the git panel: the callbacks route through the current sink.
pub fn wire(ui: &crate::AppWindow) {
    let vm = ui.global::<ChatVm>();
    vm.on_select(|n| send(ChatMsg::Select(n.into())));
    vm.on_delete(|n| send(ChatMsg::Delete(n.into())));
    vm.on_delete_confirmed(|| send(ChatMsg::DeleteConfirmed));
    vm.on_delete_cancelled(|| send(ChatMsg::DeleteCancelled));
    vm.on_new_chat(|mode| send(ChatMsg::NewChat(u8::try_from(mode).unwrap_or(0))));
    vm.on_toggle(|k| send(ChatMsg::Toggle(k.into())));
    vm.on_task_open(|k| send(ChatMsg::OpenTool(k.into())));
    vm.on_workflow_open(|id| send(ChatMsg::OpenWorkflow(id.into())));
    vm.on_close_workflow(|| send(ChatMsg::CloseWorkflow));
    vm.on_open_link(|url| send(ChatMsg::OpenLink(url.into())));
    vm.on_open_image(|id| send(ChatMsg::OpenImage(id.into())));
    vm.on_close_viewer(|| send(ChatMsg::CloseViewer));
    vm.on_copy_folder(|| send(ChatMsg::CopyFolder));
    vm.on_earlier(|| send(ChatMsg::Earlier));
    vm.on_following(|at_end| send(ChatMsg::Following(at_end)));
    vm.on_retry(|k| send(ChatMsg::Retry(k.into())));
    vm.on_discard(|k| send(ChatMsg::Discard(k.into())));
    vm.on_sign_in_retry(|| send(ChatMsg::SignInRetry));
    vm.on_dismiss_notice(|| send(ChatMsg::DismissNotice));
    vm.on_reconnect(|| send(ChatMsg::Reconnect));
    vm.on_draft_edited(|text, cursor| {
        send(ChatMsg::DraftEdited {
            text: text.into(),
            cursor_byte: index(cursor),
        })
    });
    vm.on_send(|| send(ChatMsg::Send));
    vm.on_stop(|| send(ChatMsg::Stop));
    vm.on_attach_files(|| send(ChatMsg::AttachRequested));
    // Ctrl+V with a picture on the clipboard attaches it; text pastes into the composer as usual.
    vm.on_paste_image(|| {
        use tether_core::paste::ClipboardSnapshot;
        match crate::terminal::glue::platform().read_clipboard() {
            ClipboardSnapshot::Image(png) => {
                send(ChatMsg::AttachBytes(png));
                true
            }
            ClipboardSnapshot::Files(files) => {
                send(ChatMsg::AttachFiles(files));
                true
            }
            ClipboardSnapshot::Text(_) | ClipboardSnapshot::Empty => false,
        }
    });
    vm.on_remove_attachment(|k| send(ChatMsg::RemoveAttachment(k.into())));
    vm.on_dismiss_attach_error(|| send(ChatMsg::DismissAttachError));
    vm.on_palette_pick(|i| send(ChatMsg::PalettePick(index(i))));
    vm.on_palette_close(|| send(ChatMsg::PaletteClose));
    vm.on_approve(|id| send(ChatMsg::Approve(id.into())));
    vm.on_review(|| send(ChatMsg::Review));
    vm.on_close_review(|| send(ChatMsg::CloseReview));
    vm.on_q_choose(|field, value| {
        send(ChatMsg::QuestionChoose {
            field: field.into(),
            value: value.into(),
        })
    });
    vm.on_q_text(|name, text| {
        send(ChatMsg::QuestionText {
            name: name.into(),
            text: text.into(),
        })
    });
    vm.on_q_flag(|name, value| {
        send(ChatMsg::QuestionFlag {
            name: name.into(),
            value,
        })
    });
    vm.on_q_open_custom(|n| send(ChatMsg::QuestionOpenCustom(n.into())));
    vm.on_q_submit(|| send(ChatMsg::QuestionSubmit));
    vm.on_q_decline(|| send(ChatMsg::QuestionDecline));
    vm.on_controls(|| send(ChatMsg::Controls));
    vm.on_ctl_close(|| send(ChatMsg::ControlsClose));
    vm.on_ctl_choose(|id, value| {
        send(ChatMsg::ControlsChoose {
            id: id.into(),
            value: value.into(),
        })
    });
    vm.on_ctl_dismiss(|id| send(ChatMsg::ControlsDismiss(id.into())));
    vm.on_ctl_command(|text| send(ChatMsg::ControlsCommand(text.into())));
    vm.on_bypass_confirmed(|| send(ChatMsg::BypassConfirmed));
    vm.on_bypass_cancelled(|| send(ChatMsg::BypassCancelled));
    vm.on_nc_start(|| send(ChatMsg::NewChatStart));
    vm.on_nc_cancel(|| send(ChatMsg::NewChatCancel));
    vm.on_nc_mode_changed(|m| send(ChatMsg::NewChatMode(u8::try_from(m).unwrap_or(0))));
    vm.on_nc_folder_edited(|f| send(ChatMsg::NewChatFolder(f.into())));
    vm.on_nc_continue(|id| send(ChatMsg::NewChatContinue(id.into())));
    vm.on_nc_retry(|| send(ChatMsg::NewChatRetry));
    vm.on_nc_agent_picked(|i| {
        if let Some(agent) = usize::try_from(i)
            .ok()
            .and_then(|i| tether_core::acp::agent::ALL.get(i))
        {
            send(ChatMsg::NewChatAgent(agent.key.to_string()));
        }
    });
    vm.on_nc_pick(|id, value| {
        send(ChatMsg::NewChatPick {
            id: id.into(),
            value: value.into(),
        })
    });
    vm.on_nc_reset(|| send(ChatMsg::NewChatReset));
}

/// A machine opens with no chat shown: whatever the last one left goes.
pub fn reset(ui: &crate::AppWindow) {
    ROWS.with(|r| r.borrow_mut().clear());
    FIELDS.with(|f| f.borrow_mut().clear());
    DRAFT_SEQ.with(|d| *d.borrow_mut() = None);
    DIALOG_SHOWN.set(false);
    IMAGES.with(|i| i.borrow_mut().clear());
    let vm = ui.global::<ChatVm>();
    vm.set_rows(model(Vec::new()));
    vm.set_draft(SharedString::new());
    apply(ui, ChatScreen::default());
}

/// Something of the chat's sits in front of the terminal: keys belong to it, not the PTY.
pub fn takes_keys(ui: &crate::AppWindow) -> bool {
    ui.global::<ChatVm>().get_active() || dialog_open(ui)
}

/// A chat dialog or menu is up: the window shortcuts would act behind it.
pub fn dialog_open(ui: &crate::AppWindow) -> bool {
    let vm = ui.global::<ChatVm>();
    vm.get_add_menu()
        || vm.get_nc_open()
        || !vm.get_delete_title().is_empty()
        || vm.get_viewer_open()
}

/// Esc on the "+" menu only closes it; the model never knew it was open.
pub fn close_add_menu(ui: &crate::AppWindow) -> bool {
    let vm = ui.global::<ChatVm>();
    let open = vm.get_add_menu();
    vm.set_add_menu(false);
    open
}

#[cfg(test)]
mod tests {
    use super::queue_shift;

    fn v(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_queued_message_arrives_at_the_back_and_starts_from_the_front() {
        let next = v(&["a", "b", "c"]);
        assert_eq!(queue_shift(&v(&["a", "b"]), &next), (0, &next[2..]));
        let next = v(&["b", "c"]);
        assert_eq!(queue_shift(&v(&["a", "b", "c"]), &next), (1, &next[2..]));
        let next = v(&["c", "d"]);
        assert_eq!(queue_shift(&v(&["a", "b", "c"]), &next), (2, &next[1..]));
    }

    #[test]
    fn an_unrelated_queue_replaces_every_chip_and_an_unchanged_one_moves_nothing() {
        let next = v(&["x", "y"]);
        assert_eq!(queue_shift(&v(&["a", "b"]), &next), (2, &next[..]));
        let next = v(&["a", "a"]);
        assert_eq!(queue_shift(&v(&["a", "a"]), &next), (0, &next[2..]));
        assert_eq!(queue_shift(&[], &[]), (0, &[][..]));
    }
}
