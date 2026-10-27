//! Builds the pane from the chats' state.

use std::time::Duration;

use tether_core::acp::agent::{self, CLAUDE};
use tether_core::acp::diff::{self, DiffRowKind};
use tether_core::acp::format::{
    self, ComposerAction, ModeTint, Phase as LinkPhase, QuickCommand, StatusLine,
};
use tether_core::acp::host::{self, DrawerChatState};
use tether_core::acp::message::ToolKind;
use tether_core::acp::question::{FieldKind, QuestionDraft};
use tether_core::acp::reducer::Turn;

use super::newchat::Listing;
use super::rows::{self, RowCtx};
use super::session::{AttachmentState, OptionChange, Session};
use super::view::*;
use super::{ChatJob, Chats, Out};

fn phase(p: LinkPhase) -> (u8, &'static str) {
    match p {
        LinkPhase::Connecting => (0, "Connecting"),
        LinkPhase::CatchingUp => (1, "Catching up"),
        LinkPhase::Live => (2, "Live"),
        LinkPhase::Lost => (3, "Disconnected"),
        LinkPhase::Ended => (4, "Ended"),
    }
}

fn tab_state(state: DrawerChatState) -> i8 {
    match state {
        DrawerChatState::Working => 0,
        DrawerChatState::Waiting => 1,
        DrawerChatState::Idle => 2,
        DrawerChatState::Running => 3,
        DrawerChatState::Ended => 4,
        DrawerChatState::Tasks => 5,
    }
}

fn agent_index(agent: Option<&'static agent::AgentProfile>) -> i8 {
    agent::ALL
        .iter()
        .position(|p| Some(*p) == agent)
        .map_or(-1, |i| i as i8)
}

fn icon_of(kind: &ToolKind) -> Icon {
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

fn line(kind: DiffRowKind, old: Option<usize>, new: Option<usize>, text: &str) -> DiffLine {
    DiffLine {
        kind: match kind {
            DiffRowKind::Hunk => DiffKind::Hunk,
            DiffRowKind::Added => DiffKind::Added,
            DiffRowKind::Removed => DiffKind::Removed,
            DiffRowKind::Context => DiffKind::Context,
            DiffRowKind::Plain => DiffKind::Plain,
        },
        old: old.map(|n| n.to_string()).unwrap_or_default(),
        new: new.map(|n| n.to_string()).unwrap_or_default(),
        text: text.to_string(),
    }
}

fn char_to_byte(text: &str, chars: usize) -> usize {
    text.char_indices()
        .nth(chars)
        .map_or(text.len(), |(b, _)| b)
}

pub fn build(chats: &mut Chats, now: Duration, out: &mut Out) -> ChatScreen {
    let mut screen = ChatScreen {
        active: chats.active.is_some(),
        follow_seq: chats.follow_seq,
        focus_seq: chats.focus_seq,
        ..Default::default()
    };
    let ordered: Vec<_> = chats.ordered().into_iter().cloned().collect();
    let names: Vec<String> = ordered.iter().map(|c| c.name.clone()).collect();
    let titles = chats.stored_titles(&names);
    let local_agents = chats.local_agents(&names);
    for mut row in host::drawer_rows(&ordered, &titles, &local_agents) {
        // An open chat knows its own commands sooner than the host's next status read.
        if let Some(open) = chats.sessions.get(&row.name)
            && !open.has_ended()
            && matches!(
                row.state,
                DrawerChatState::Idle | DrawerChatState::Running | DrawerChatState::Tasks
            )
            && open.state().turn == Turn::Idle
        {
            row.tasks = open.state().background_commands().len() as u32;
            row.state = if row.tasks > 0 {
                DrawerChatState::Tasks
            } else {
                DrawerChatState::Idle
            };
        }
        screen.tabs.push(TabView {
            active: chats.active.as_deref() == Some(row.name.as_str()),
            title: row.title.clone(),
            state: tab_state(row.state),
            label: row.tag(),
            agent: agent_index(row.agent),
            name: row.name,
        });
    }
    if let Some(name) = &chats.delete_prompt {
        screen.delete_title = screen
            .tabs
            .iter()
            .find(|t| &t.name == name)
            .map_or_else(|| name.clone(), |t| t.title.clone());
    }
    if let Some(nc) = &chats.new_chat {
        screen.new_chat = Some(NewChatView {
            agent: agent_index(Some(nc.agent)),
            summary: nc.options.summary(),
            note: nc.options.note(),
            reset: nc.options.is_reset(),
            menus: nc
                .options
                .rows()
                .into_iter()
                .map(|r| OptionMenuView {
                    choices: r
                        .choices
                        .into_iter()
                        .map(|(value, name)| OptionChoiceView {
                            selected: value == r.value,
                            value,
                            name,
                        })
                        .collect(),
                    id: r.id,
                    name: r.name,
                    value_name: r.value_name,
                    changed: r.changed,
                })
                .collect(),
            mode: nc.mode,
            folder: nc.folder.clone(),
            busy: nc.busy,
            error: nc.error.clone().unwrap_or_default(),
            listing: match &nc.listing {
                Listing::Loading => ListingView::Loading,
                Listing::Failed(m) => ListingView::Failed(m.clone()),
                Listing::Loaded(sessions) => ListingView::Loaded(
                    sessions
                        .iter()
                        .map(|s| SavedView {
                            id: s.session_id.clone(),
                            title: s.display_title().to_string(),
                            when: host::continue_relative(s.updated_at, unix_now()),
                            recent: host::is_recent(s.updated_at, unix_now()),
                            busy: nc.continuing.as_deref() == Some(s.session_id.as_str()),
                        })
                        .collect(),
                ),
            },
            continuing: nc.continuing.is_some(),
        });
    }
    let Some(name) = chats.active.clone() else {
        return screen;
    };
    let Some(s) = chats.sessions.get(&name) else {
        return screen;
    };
    let state = s.state();

    let (phase_n, word) = phase(s.link.phase());
    let status = StatusLine::new(state);
    screen.header = HeaderView {
        title: s.title(),
        folder: s.cwd.clone(),
        folder_copied: chats.folder_copied_at.is_some(),
        phase: phase_n,
        phase_word: word.to_string(),
        model: status.model.clone().unwrap_or_default(),
        mode: status.mode.clone().unwrap_or_default(),
        mode_tint: match status.tint {
            ModeTint::Secondary => 0,
            ModeTint::Accent => 1,
            ModeTint::Success => 2,
            ModeTint::Danger => 3,
        },
        stats: status.stats().unwrap_or_default(),
        context: format::context_fraction(state.context_used, state.context_size).map(|f| f as f32),
        context_text: format::context_summary(state.context_used, state.context_size)
            .unwrap_or_default(),
        agent_label: if s.agent() == Some(&CLAUDE) {
            String::new()
        } else {
            agent::label(s.agent()).to_string()
        },
        agent: agent_index(s.agent()),
    };
    screen.notice = s.notice.clone().unwrap_or_default();

    let mut ctx = RowCtx {
        host: &chats.host,
        files: chats.files.as_ref(),
        thumbs: &chats.thumbs,
        verbs: &chats.verbs,
        need: Vec::new(),
    };
    screen.rows = rows::build(s, &mut ctx);
    screen.queued = rows::queued(s);
    if !s.has_ended() {
        screen.tasks = rows::tasks(s);
    }
    let need = std::mem::take(&mut ctx.need);

    composer(s, &mut screen);
    screen.draft = Some(s.draft.clone());
    screen.caret = Some((chats.draft_seq, char_to_byte(&s.draft, s.cursor)));

    let ended = s.has_ended();
    let question = state.pending_questions().first().cloned();
    if let Some(q) = question.as_ref().filter(|_| !s.read_only && !ended) {
        let key = q.request_id.describe();
        let draft = s.question_drafts.get(&key).cloned().unwrap_or_default();
        screen.question = Some(question_view(s, q, &draft, state.pending_questions().len()));
    } else if let Some(p) = state
        .pending_permissions()
        .first()
        .cloned()
        .filter(|_| !s.read_only && !ended)
    {
        let total = state.pending_permissions().len();
        let plan = p.kind == ToolKind::SwitchMode
            && p.text.as_deref().is_some_and(|t| !t.is_empty())
            && p.diff.is_none();
        let file = p.diff.as_ref().map(|d| diff::file_for(d, &s.cwd));
        let preview = file
            .as_ref()
            .map(|f| {
                let removed: Vec<_> = f
                    .rows
                    .iter()
                    .filter(|r| r.kind == DiffRowKind::Removed)
                    .take(2)
                    .collect();
                let added: Vec<_> = f
                    .rows
                    .iter()
                    .filter(|r| r.kind == DiffRowKind::Added)
                    .take(5 - removed.len())
                    .collect();
                removed
                    .into_iter()
                    .chain(added)
                    .map(|r| line(r.kind, r.old_line, r.new_line, &r.text))
                    .collect()
            })
            .unwrap_or_default();
        let layout = format::permission_layout(&p.options);
        let pair = |o: &Option<tether_core::acp::message::PermissionOption>| {
            o.as_ref().map(|o| (o.option_id.clone(), o.name.clone()))
        };
        screen.permission = Some(PermissionView {
            plan,
            icon: icon_of(&p.kind),
            title: p.title.clone(),
            position: if total > 1 {
                format!("1 of {total}")
            } else {
                String::new()
            },
            path: file.as_ref().map(|f| f.path.clone()).unwrap_or_default(),
            added: file.as_ref().map_or(0, |f| f.added),
            removed: file.as_ref().map_or(0, |f| f.removed),
            preview,
            plan_items: if plan {
                tether_core::markdown::items(p.text.as_deref().unwrap_or_default())
            } else {
                Vec::new()
            },
            text: p
                .text
                .as_deref()
                .map(|t| t.chars().take(300).collect())
                .unwrap_or_default(),
            primary: pair(&layout.primary),
            reject: pair(&layout.reject),
            more: layout
                .more
                .iter()
                .map(|o| (o.option_id.clone(), o.name.clone()))
                .collect(),
            collapsed: layout.collapsed,
            enabled: s.can_interact(),
            failure: if s.answer_failures.contains(&p.request_id) {
                "Couldn't send your answer. Choose again to retry.".into()
            } else {
                String::new()
            },
        });
        if chats.review {
            screen.review = Some(ReviewView {
                title: p.title.clone(),
                stat: file
                    .as_ref()
                    .map(|f| format!("+{} \u{2212}{}", f.added, f.removed))
                    .unwrap_or_default(),
                diff: file
                    .as_ref()
                    .map(|f| {
                        f.rows
                            .iter()
                            .map(|r| line(r.kind, r.old_line, r.new_line, &r.text))
                            .collect()
                    })
                    .unwrap_or_default(),
                markdown: if file.is_none() {
                    tether_core::markdown::items(p.text.as_deref().unwrap_or_default())
                } else {
                    Vec::new()
                },
            });
        }
    }

    if chats.controls_open {
        screen.controls = Some(ControlsView {
            read_only: s.read_only,
            options: state
                .config_options
                .iter()
                .map(|o| {
                    let change = s.option_changes.get(&o.id);
                    OptionView {
                        id: o.id.clone(),
                        name: o.name.clone(),
                        choices: o
                            .choices
                            .iter()
                            .map(|c| ChoiceRowView {
                                value: c.value.clone(),
                                name: c.name.clone(),
                                description: c.description.clone(),
                                selected: o.current_value == c.value,
                                pending: matches!(change, Some(OptionChange::Pending(v)) if *v == c.value),
                            })
                            .collect(),
                        failure: match change {
                            Some(OptionChange::Failed(_, m)) => m.clone(),
                            _ => String::new(),
                        },
                    }
                })
                .collect(),
            enabled: s.can_interact(),
            cost: state.cost.as_ref().map(format::cost).unwrap_or_default(),
            model_id: state.model_id.clone().unwrap_or_default(),
            commands: QuickCommand::ALL
                .iter()
                .filter(|c| c.is_offered(&state.commands))
                .map(|c| (c.title().to_string(), c.detail().to_string(), c.text()))
                .collect(),
            commands_enabled: s.can_send() && !s.is_working(),
            bypass_confirm: chats.bypass.is_some(),
        });
    }

    if let Some(id) = &chats.viewer {
        let full = format!("full:{id}");
        let picture = chats.thumbs.get(&full).map(|p| Picture {
            id: id.clone(),
            width: p.width,
            height: p.height,
            pixels: Some(p.clone()),
        });
        let path = chats
            .files
            .as_ref()
            .map(|f| f.images(&name).directory().join(id));
        match (&picture, path) {
            (Some(_), _) => screen.viewer = Some(picture),
            (None, Some(path)) if path.exists() => {
                if chats.thumbs_asked.insert(full.clone()) {
                    out.jobs.push(ChatJob::Thumb { id: full, path });
                }
                screen.viewer = Some(Some(Picture {
                    id: id.clone(),
                    width: 0,
                    height: 0,
                    pixels: None,
                }));
            }
            _ => screen.viewer = Some(None),
        }
    }

    for (id, path) in need {
        if chats.thumbs_asked.insert(id.clone()) {
            out.jobs.push(ChatJob::Thumb { id, path });
        }
    }
    let _ = now;
    if let Some(s) = chats.sessions.get_mut(&name) {
        s.mark_shown();
    }
    screen
}

fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64)
}

fn composer(s: &Session, screen: &mut ChatScreen) {
    let state = s.state();
    let c = &mut screen.composer;
    let permission = !state.pending_permissions().is_empty();
    let question = !state.pending_questions().is_empty();
    let working = state.turn == tether_core::acp::reducer::Turn::Working;
    if s.read_only {
        c.banner = "Started on another device. Read only.".into();
        c.banner_icon = Some(Icon::Eye);
    } else if s.has_ended() {
        c.banner = "This chat has ended. You can still read it.".into();
        c.banner_icon = Some(Icon::Moon);
    }
    c.shown = true;
    c.placeholder = if permission {
        "Answer the permission above"
    } else if question {
        "Answer the question above"
    } else if working {
        "Queue a message"
    } else {
        "Message the agent"
    }
    .into();
    c.dimmed = permission || question;
    c.catching_up = matches!(
        s.link.phase(),
        LinkPhase::Connecting | LinkPhase::CatchingUp
    );
    let has_content = !s.draft.trim().is_empty() || !s.attachments.is_empty();
    let action = format::composer_action(working, has_content);
    c.stopping = action == ComposerAction::Stop;
    c.can_send = s.can_send_now() && !c.dimmed;
    c.action_enabled = if c.stopping {
        s.can_interact()
    } else {
        c.can_send
    };
    c.action_label = if c.stopping {
        "Stop"
    } else if working {
        "Queue message"
    } else {
        "Send"
    }
    .into();
    c.can_attach = s.attachments.len() < format::MAX_IMAGES && !c.dimmed;
    c.attachments = s
        .attachments
        .iter()
        .map(|a| AttachmentView {
            key: a.key.clone(),
            thumb: match &a.state {
                AttachmentState::Ready(_, t) => Some(t.clone()),
                AttachmentState::Encoding => None,
            },
        })
        .collect();
    c.attach_error = s.attach_error.clone().unwrap_or_default();
    c.palette = s.palette().map(|(slash, rows)| {
        (
            if slash {
                PaletteKind::Slash
            } else {
                PaletteKind::Files
            },
            rows,
        )
    });
}

fn question_view(
    s: &Session,
    q: &tether_core::acp::question::Question,
    draft: &QuestionDraft,
    total: usize,
) -> QuestionView {
    let enabled = s.can_interact();
    let fields: Vec<FieldView> = q
        .fields
        .iter()
        .map(|f| {
            let (kind, multi) = match &f.kind {
                FieldKind::Single(_) => (0, false),
                FieldKind::Multi(_) => (1, true),
                FieldKind::Text => (2, false),
                FieldKind::Boolean => (3, false),
            };
            let _ = multi;
            let custom = f.custom.as_ref();
            FieldView {
                name: f.name.clone(),
                title: if f.required {
                    format!("{} *", f.title)
                } else {
                    f.title.clone()
                },
                show_title: q.fields.len() > 1 || f.required,
                kind,
                choices: f
                    .choices()
                    .iter()
                    .map(|c| ChoiceView {
                        value: c.value.clone(),
                        title: c.title.clone(),
                        description: if !c.description.is_empty()
                            && !c.description.eq_ignore_ascii_case(&c.title)
                        {
                            c.description.clone()
                        } else {
                            String::new()
                        },
                        picked: draft.is_picked(f, &c.value),
                    })
                    .collect(),
                custom_name: custom.map(|c| c.name.clone()).unwrap_or_default(),
                custom_open: custom.is_some_and(|c| draft.is_custom_open(&c.name)),
                custom_text: custom
                    .map(|c| draft.text(&c.name).to_string())
                    .unwrap_or_default(),
                text: draft.text(&f.name).to_string(),
                placeholder: if f.description.is_empty() {
                    f.title.clone()
                } else {
                    f.description.clone()
                },
                flag: draft.flag(&f.name),
            }
        })
        .collect();
    let any_custom_open = q
        .fields
        .iter()
        .filter_map(|f| f.custom.as_ref())
        .any(|c| draft.is_custom_open(&c.name));
    QuestionView {
        message: q.message.clone(),
        position: if total > 1 {
            format!("1 of {total}")
        } else {
            String::new()
        },
        fields,
        show_submit: !draft.submits_on_tap(&q.fields) || q.fields.is_empty() || any_custom_open,
        can_submit: enabled && draft.can_submit(&q.fields),
        enabled,
        failure: if s.answer_failures.contains(&q.request_id) {
            "Couldn't send your answer. Try again.".into()
        } else {
            String::new()
        },
    }
}
