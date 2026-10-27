//! What the chat pane shows, as plain data: the model builds it, `chatview` turns it into Slint.

use std::sync::Arc;

use tether_core::markdown::Item as MdItem;

/// Decoded pixels of a picture, shared between views without copying.
#[derive(Debug)]
pub struct Pixels {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

/// Pictures are decoded once and shared: the same allocation is the same picture.
impl PartialEq for Pixels {
    fn eq(&self, other: &Self) -> bool {
        std::ptr::eq(self, other)
    }
}

#[derive(Debug, Clone)]
pub struct Picture {
    pub id: String,
    pub width: u32,
    pub height: u32,
    pub pixels: Option<Arc<Pixels>>,
}

impl PartialEq for Picture {
    fn eq(&self, other: &Self) -> bool {
        self.id == other.id
            && self.width == other.width
            && self.height == other.height
            && match (&self.pixels, &other.pixels) {
                (Some(a), Some(b)) => Arc::ptr_eq(a, b),
                (None, None) => true,
                _ => false,
            }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolState {
    Running,
    Done,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiffKind {
    Hunk,
    Added,
    Removed,
    Context,
    Plain,
}

#[derive(Debug, Clone, PartialEq)]
pub enum EntryBody {
    Tool {
        icon: Icon,
        title: String,
        subtitle: String,
        state: ToolState,
        added: usize,
        removed: usize,
        expandable: bool,
        open: bool,
        /// A command the agent sent to the background that is still running.
        background: bool,
    },
    Resolved {
        allowed: bool,
        title: String,
    },
    Markdown(MdItem),
    Diff {
        kind: DiffKind,
        old: String,
        new: String,
        text: String,
    },
    Pictures(Vec<Picture>),
    /// "Brief" on a subagent: a toggle over the instructions it was given.
    BriefToggle {
        open: bool,
    },
    ReportLabel,
    PlanStep {
        state: u8,
        text: String,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    pub key: String,
    pub depth: u8,
    pub first: bool,
    pub body: EntryBody,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Icon {
    Read = 0,
    Edit = 1,
    Delete = 2,
    Move = 3,
    Search = 4,
    Execute = 5,
    Think = 6,
    Fetch = 7,
    SwitchMode = 8,
    Other = 9,
    Subagent = 10,
    Image = 11,
    Allowed = 12,
    Refused = 13,
    Moon = 20,
    Eye = 21,
}

#[derive(Debug, Clone, PartialEq)]
pub enum RowBody {
    User {
        text: String,
        images: Vec<Picture>,
        image_label: String,
    },
    Markdown(MdItem),
    Pictures(Vec<Picture>),
    Thought {
        text: String,
        open: bool,
    },
    Tools(Vec<Entry>),
    Plan {
        summary: String,
        current: String,
        open: bool,
        steps: Vec<Entry>,
    },
    Notice(String),
    /// `severity`: 0 unsaid, 1 info, 2 warning, 3 error.
    AgentNotice {
        severity: u8,
        title: String,
        description: String,
    },
    /// `state`: 0 compacting, 1 done, 2 failed, 3 cancelled; a summary makes the rule open.
    Compaction {
        state: u8,
        label: String,
        summary: String,
        open: bool,
    },
    Error(String),
    Divider(String),
    /// `retry`: none while there is a session; 0 idle, 1 checking, 2 still signed out.
    SignedOut {
        message: String,
        retry: Option<u8>,
    },
    Answered {
        question: String,
        answer: String,
        answered: bool,
    },
    NotSent {
        text: String,
        note: String,
        can_retry: bool,
    },
    Working(String),
    Earlier,
    Empty {
        message: String,
        folder: String,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    pub key: String,
    pub body: RowBody,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TabView {
    pub name: String,
    pub title: String,
    /// -1 nothing, 0 working, 1 needs you, 2 idle, 3 running, 4 ended, 5 idle with background commands.
    pub state: i8,
    pub label: String,
    pub active: bool,
    /// The agent's mark: its place in `agent::ALL`, -1 for an agent this build does not know.
    pub agent: i8,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct HeaderView {
    pub title: String,
    pub folder: String,
    pub folder_copied: bool,
    /// 0 connecting, 1 catching up, 2 live, 3 lost, 4 ended.
    pub phase: u8,
    pub phase_word: String,
    pub model: String,
    pub mode: String,
    /// 0 secondary, 1 accent, 2 success, 3 danger.
    pub mode_tint: u8,
    pub stats: String,
    pub context: Option<f32>,
    pub context_text: String,
    /// The agent's name for a chat that is not Claude's; empty for Claude.
    pub agent_label: String,
    pub agent: i8,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AttachmentView {
    pub key: String,
    pub thumb: Option<Arc<Pixels>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PaletteKind {
    Slash,
    Files,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ComposerView {
    pub shown: bool,
    pub banner: String,
    pub banner_icon: Option<Icon>,
    pub placeholder: String,
    pub dimmed: bool,
    pub catching_up: bool,
    pub can_send: bool,
    pub stopping: bool,
    pub action_enabled: bool,
    pub action_label: String,
    pub attachments: Vec<AttachmentView>,
    pub attach_error: String,
    pub palette: Option<(PaletteKind, Vec<(String, String)>)>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DiffLine {
    pub kind: DiffKind,
    pub old: String,
    pub new: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PermissionView {
    pub plan: bool,
    pub icon: Icon,
    pub title: String,
    pub position: String,
    pub path: String,
    pub added: usize,
    pub removed: usize,
    pub preview: Vec<DiffLine>,
    pub plan_items: Vec<MdItem>,
    pub text: String,
    /// (option id, label)
    pub primary: Option<(String, String)>,
    pub reject: Option<(String, String)>,
    pub more: Vec<(String, String)>,
    pub collapsed: bool,
    pub enabled: bool,
    pub failure: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ChoiceView {
    pub value: String,
    pub title: String,
    pub description: String,
    pub picked: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FieldView {
    pub name: String,
    pub title: String,
    pub show_title: bool,
    /// 0 single, 1 multi, 2 text, 3 yes or no.
    pub kind: u8,
    pub choices: Vec<ChoiceView>,
    pub custom_name: String,
    pub custom_open: bool,
    pub custom_text: String,
    pub text: String,
    pub placeholder: String,
    pub flag: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct QuestionView {
    pub message: String,
    pub position: String,
    pub fields: Vec<FieldView>,
    pub show_submit: bool,
    pub can_submit: bool,
    pub enabled: bool,
    pub failure: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ChoiceRowView {
    pub value: String,
    pub name: String,
    pub description: String,
    pub selected: bool,
    pub pending: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct OptionView {
    pub id: String,
    pub name: String,
    pub choices: Vec<ChoiceRowView>,
    pub failure: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ControlsView {
    pub read_only: bool,
    pub options: Vec<OptionView>,
    pub enabled: bool,
    pub cost: String,
    pub model_id: String,
    /// (title, detail, text sent)
    pub commands: Vec<(String, String, String)>,
    pub commands_enabled: bool,
    pub bypass_confirm: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ReviewView {
    pub title: String,
    pub diff: Vec<DiffLine>,
    /// The file row's `+n −m`, shown at the top of a diff.
    pub stat: String,
    pub markdown: Vec<MdItem>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SavedView {
    pub id: String,
    pub title: String,
    pub when: String,
    pub recent: bool,
    pub busy: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ListingView {
    Loading,
    Failed(String),
    Loaded(Vec<SavedView>),
}

#[derive(Debug, Clone, PartialEq)]
pub struct OptionChoiceView {
    pub value: String,
    pub name: String,
    pub selected: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct OptionMenuView {
    pub id: String,
    pub name: String,
    pub value_name: String,
    pub changed: bool,
    pub choices: Vec<OptionChoiceView>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct NewChatView {
    pub agent: i8,
    /// In `agent::ALL` order: the host can't run that agent, so the picker dims it.
    pub unavailable: Vec<bool>,
    pub summary: String,
    pub note: String,
    pub menus: Vec<OptionMenuView>,
    pub reset: bool,
    pub mode: u8,
    pub folder: String,
    pub busy: bool,
    pub error: String,
    pub listing: ListingView,
    pub continuing: bool,
}

/// A background command still running, as the strip above the composer lists it.
#[derive(Debug, Clone, PartialEq)]
pub struct TaskView {
    /// The key of the tool row it belongs to.
    pub key: String,
    pub title: String,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ChatScreen {
    pub active: bool,
    pub tabs: Vec<TabView>,
    pub header: HeaderView,
    pub rows: Vec<Row>,
    /// Sent while a turn runs and not started yet; shown above the composer, not in the transcript.
    pub queued: Vec<String>,
    pub tasks: Vec<TaskView>,
    pub follow_seq: u64,
    pub notice: String,
    pub draft: Option<String>,
    pub caret: Option<(u64, usize)>,
    pub focus_seq: u64,
    pub composer: ComposerView,
    pub permission: Option<PermissionView>,
    pub question: Option<QuestionView>,
    pub controls: Option<ControlsView>,
    pub review: Option<ReviewView>,
    /// The picture the viewer shows; `None` inside means the file is gone.
    pub viewer: Option<Option<Picture>>,
    pub new_chat: Option<NewChatView>,
    pub delete_title: String,
}
