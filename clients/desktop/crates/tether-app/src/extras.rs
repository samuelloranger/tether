//! Snippets, session history, and Google Fonts: the Slint side of the three iOS-parity extras.
//! The rules live in `tether-core`; the terminal-side state in `terminal::model::extras`.

use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::rc::{Rc, Weak};
use std::sync::Arc;
use std::time::Duration;

use slint::{ComponentHandle, ModelRc, SharedString, VecModel};
use tether_core::DataDir;
use tether_core::googlefonts::{self, DownloadedFont, DownloadedFonts, Fetch, Response};
use tether_core::snippets::{self, Snippets};
use uuid::Uuid;

use crate::app::App;
use crate::router::{Dialog, Page};
use crate::terminal::model::{HistoryBody, Msg, TerminalView};
use crate::vm::home::DialogCopy;
use crate::{
    AppWindow, GoogleFontRow, GoogleFontsBridge, HistoryVm, PaletteRowData, PaletteVm, SnippetRow,
    SnippetsBridge, TerminalVm,
};

const DEFAULT_FONT: &str = "cascadia-mono";

/// What the snippet form shows. Pure, so the rules around it are testable without a window.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct SnippetForm {
    pub editing: Option<Uuid>,
    pub name: String,
    pub text: String,
    pub error: Option<String>,
}

impl SnippetForm {
    pub fn can_save(&self) -> bool {
        snippets::check(&self.name, &self.text).is_ok()
    }

    pub fn hint(&self) -> String {
        if let Some(e) = &self.error {
            return e.clone();
        }
        if self.name.is_empty() && self.text.is_empty() {
            return String::new();
        }
        snippets::check(&self.name, &self.text)
            .err()
            .map(|e| e.to_string())
            .unwrap_or_default()
    }

    pub fn save_label(&self) -> &'static str {
        if self.editing.is_some() {
            "Save changes"
        } else {
            "Add snippet"
        }
    }
}

pub fn count_label(count: usize) -> String {
    match count {
        0 => "None yet".into(),
        n => format!("{n} saved"),
    }
}

struct State {
    root: PathBuf,
    snippets: Snippets,
    /// The snippets file exists but could not be read: saving would replace it.
    snippets_locked: bool,
    form: SnippetForm,
    fonts: DownloadedFonts,
    fonts_locked: bool,
    status: Option<(String, bool)>,
    busy: bool,
    app: Weak<App>,
}

thread_local! {
    static STATE: RefCell<Option<State>> = const { RefCell::new(None) };
    static SHOWN: RefCell<Shown> = RefCell::new(Shown::default());
}

#[derive(Default)]
struct Shown {
    palette: Option<crate::terminal::model::PaletteView>,
    history_text: Option<Arc<str>>,
    seq: i32,
}

fn with<R>(f: impl FnOnce(&mut State) -> R) -> Option<R> {
    STATE.with(|s| s.borrow_mut().as_mut().map(f))
}

fn fonts_dir(root: &Path) -> PathBuf {
    root.join("fonts")
}

/// Before any window exists: loads snippets, then registers every stored font so the first
/// frame already knows a saved `gf-` font id.
pub fn init(root: &Path) {
    let data = DataDir::new(root);
    let (snippets, snippets_locked) = match Snippets::load(&data) {
        Ok(s) => (s, false),
        Err(e) => {
            tracing::warn!("reading snippets failed: {e}");
            (Snippets::default(), true)
        }
    };
    let dir = fonts_dir(root);
    let fonts_data = DataDir::new(&dir);
    let (mut fonts, fonts_locked) = match DownloadedFonts::load(&fonts_data) {
        Ok(f) => (f, false),
        Err(e) => {
            tracing::warn!("reading downloaded fonts failed: {e}");
            (DownloadedFonts::default(), true)
        }
    };
    if !fonts_locked {
        googlefonts::clean_up(&dir, &fonts.items);
        let before = fonts.items.len();
        fonts.items.retain(|font| register(&dir, font));
        if fonts.items.len() != before
            && let Err(e) = fonts.save(&fonts_data)
        {
            tracing::warn!("saving downloaded fonts failed: {e}");
        }
    }
    STATE.with(|s| {
        *s.borrow_mut() = Some(State {
            root: root.to_path_buf(),
            snippets,
            snippets_locked,
            form: SnippetForm::default(),
            fonts,
            fonts_locked,
            status: None,
            busy: false,
            app: Weak::new(),
        });
    });
}

/// False when the files are gone or no longer a usable font: the caller stops offering it.
fn register(dir: &Path, font: &DownloadedFont) -> bool {
    let Ok((regular, bold)) = googlefonts::read_files(dir, font) else {
        return false;
    };
    match tether_term::fonts::register_downloaded(font, regular, bold) {
        Ok(()) => true,
        Err(e) => {
            tracing::warn!("font {} not usable: {e}", font.family);
            false
        }
    }
}

fn send(m: Msg) {
    if let Some(s) = crate::terminal::glue::current() {
        s(m);
    }
}

/// The open terminal learns the list when it opens and whenever it changes.
pub fn send_snippets() {
    if let Some(items) = with(|s| s.snippets.items.clone()) {
        send(Msg::SnippetsChanged(items));
    }
}

pub fn overlay_open(ui: &AppWindow) -> bool {
    ui.global::<HistoryVm>().get_open() || ui.global::<PaletteVm>().get_open()
}

pub fn set_foreground(ui: &AppWindow, rgb: u32) {
    ui.global::<HistoryVm>()
        .set_foreground(slint::Color::from_rgb_u8(
            (rgb >> 16) as u8,
            (rgb >> 8) as u8,
            rgb as u8,
        ));
}

pub fn delete_copy(id: Uuid) -> Option<DialogCopy> {
    let name = with(|s| s.snippets.get(id).map(|x| x.name.clone()))??;
    Some(DialogCopy {
        title: format!("Delete snippet “{name}”?"),
        body: "It is removed from this PC. This can't be undone.",
        extra: None,
        action: "Delete",
    })
}

pub fn delete_snippet(id: Uuid) {
    let saved = with(|s| {
        s.snippets.remove(id);
        save_snippets(s)
    });
    if let Some(Err(e)) = saved {
        tracing::warn!("saving snippets failed: {e}");
    }
    send_snippets();
}

fn save_snippets(s: &State) -> Result<(), String> {
    if s.snippets_locked {
        return Err("the snippets file could not be read".into());
    }
    s.snippets
        .save(&DataDir::new(&s.root))
        .map_err(|e| e.to_string())
}

fn app() -> Option<Rc<App>> {
    with(|s| s.app.upgrade()).flatten()
}

pub fn install(app: &Rc<App>) {
    with(|s| s.app = Rc::downgrade(app));
    let ui = &app.ui;

    let terminal = ui.global::<TerminalVm>();
    terminal.on_history(|| send(Msg::HistoryOpen));
    terminal.on_snippets(|| send(Msg::PaletteOpen));

    let history = ui.global::<HistoryVm>();
    history.on_close(|| send(Msg::HistoryClose));
    history.on_copy(|| send(Msg::HistoryCopy));
    history.on_reload(|| send(Msg::HistoryOpen));

    let palette = ui.global::<PaletteVm>();
    palette.on_query_changed(|q| send(Msg::PaletteQuery(q.into())));
    palette.on_move(|d| send(Msg::PaletteMove(d)));
    palette.on_choose(|i| send(Msg::PaletteChoose(usize::try_from(i).ok())));
    palette.on_choose_selected(|| send(Msg::PaletteChoose(None)));
    palette.on_close(|| send(Msg::PaletteClose));
    let weak = Rc::downgrade(app);
    palette.on_open_settings(move || {
        send(Msg::PaletteClose);
        if let Some(app) = weak.upgrade() {
            open_snippets(&app);
        }
    });

    let bridge = ui.global::<SnippetsBridge>();
    let weak = Rc::downgrade(app);
    bridge.on_open(move || {
        if let Some(app) = weak.upgrade() {
            open_snippets(&app);
        }
    });
    let weak = Rc::downgrade(app);
    bridge.on_edited(move || {
        if let Some(app) = weak.upgrade() {
            let b = app.ui.global::<SnippetsBridge>();
            with(|s| {
                s.form.name = b.get_name().to_string();
                s.form.text = b.get_text().to_string();
                s.form.error = None;
            });
            push_snippets(&app, false);
        }
    });
    let weak = Rc::downgrade(app);
    bridge.on_save(move || {
        if let Some(app) = weak.upgrade() {
            save_form(&app);
        }
    });
    let weak = Rc::downgrade(app);
    bridge.on_cancel_edit(move || {
        if let Some(app) = weak.upgrade() {
            with(|s| s.form = SnippetForm::default());
            push_snippets(&app, true);
        }
    });
    let weak = Rc::downgrade(app);
    bridge.on_edit(move |id| {
        let (Some(app), Ok(id)) = (weak.upgrade(), Uuid::parse_str(&id)) else {
            return;
        };
        with(|s| {
            if let Some(item) = s.snippets.get(id) {
                s.form = SnippetForm {
                    editing: Some(id),
                    name: item.name.clone(),
                    text: item.text.clone(),
                    error: None,
                };
            }
        });
        push_snippets(&app, true);
    });
    let weak = Rc::downgrade(app);
    bridge.on_remove(move |id| {
        let (Some(app), Ok(id)) = (weak.upgrade(), Uuid::parse_str(&id)) else {
            return;
        };
        app.router.open_dialog(Dialog::DeleteSnippet(id));
        app.refresh_router();
    });
    let weak = Rc::downgrade(app);
    bridge.on_move(move |id, delta| {
        let (Some(app), Ok(id)) = (weak.upgrade(), Uuid::parse_str(&id)) else {
            return;
        };
        let saved = with(|s| {
            s.snippets.move_by(id, delta);
            save_snippets(s)
        });
        if let Some(Err(e)) = saved {
            tracing::warn!("saving snippets failed: {e}");
        }
        push_snippets(&app, false);
        send_snippets();
    });

    let fonts = ui.global::<GoogleFontsBridge>();
    let rows: Vec<crate::ChipRow> = chip_rows(&googlefonts::SUGGESTIONS, SUGGESTION_WIDTH)
        .into_iter()
        .map(|names| crate::ChipRow {
            names: ModelRc::new(VecModel::from(
                names
                    .into_iter()
                    .map(SharedString::from)
                    .collect::<Vec<_>>(),
            )),
        })
        .collect();
    fonts.set_suggestion_rows(ModelRc::new(VecModel::from(rows)));
    let weak = Rc::downgrade(app);
    fonts.on_download(move |input| {
        if let Some(app) = weak.upgrade() {
            start_download(&app, input.to_string());
        }
    });
    let weak = Rc::downgrade(app);
    fonts.on_remove(move |id| {
        if let Some(app) = weak.upgrade() {
            remove_font(&app, &id);
        }
    });
    let weak = Rc::downgrade(app);
    fonts.on_choose(move |id| {
        if let Some(app) = weak.upgrade() {
            app.update_terminal_prefs(|t| t.font = id.to_string());
        }
    });

    push_snippets(app, true);
    refresh_fonts(app);
}

fn open_snippets(app: &Rc<App>) {
    with(|s| s.form = SnippetForm::default());
    push_snippets(app, true);
    app.router.go(Page::Snippets);
    app.refresh_router();
}

fn save_form(app: &Rc<App>) {
    let outcome = with(|s| {
        if s.snippets_locked {
            s.form.error = Some("Couldn't read the saved snippets, so nothing is saved.".into());
            return false;
        }
        let (editing, name, text) = (s.form.editing, s.form.name.clone(), s.form.text.clone());
        match s.snippets.upsert(editing, &name, &text) {
            Ok(_) => match save_snippets(s) {
                Ok(()) => {
                    s.form = SnippetForm::default();
                    true
                }
                Err(e) => {
                    s.form.error = Some(format!("Couldn't save: {e}"));
                    false
                }
            },
            Err(e) => {
                s.form.error = Some(e.to_string());
                false
            }
        }
    });
    push_snippets(app, outcome == Some(true));
    if outcome == Some(true) {
        send_snippets();
    }
}

fn push_snippets(app: &App, with_fields: bool) {
    let Some((items, form)) = with(|s| (s.snippets.items.clone(), s.form.clone())) else {
        return;
    };
    let b = app.ui.global::<SnippetsBridge>();
    let last = items.len().saturating_sub(1);
    let rows: Vec<SnippetRow> = items
        .iter()
        .enumerate()
        .map(|(i, s)| SnippetRow {
            id: s.id.to_string().into(),
            name: s.name.as_str().into(),
            preview: s.preview().into(),
            first: i == 0,
            last: i == last,
        })
        .collect();
    b.set_rows(ModelRc::new(VecModel::from(rows)));
    b.set_count_label(count_label(items.len()).into());
    if with_fields {
        b.set_name(form.name.as_str().into());
        b.set_text(form.text.as_str().into());
    }
    b.set_hint(form.hint().into());
    b.set_editing(form.editing.is_some());
    b.set_can_save(form.can_save());
    b.set_save_label(form.save_label().into());
}

/// The terminal view's overlays, mirrored into Slint. The history text can be large, so it is
/// copied only when it is a different transcript.
pub fn push_view(w: &AppWindow, view: &TerminalView) {
    let h = w.global::<HistoryVm>();
    match &view.history {
        None => {
            h.set_open(false);
            SHOWN.with(|s| s.borrow_mut().history_text = None);
        }
        Some(history) => {
            h.set_session(history.session.as_str().into());
            let (state, note, text) = match &history.body {
                HistoryBody::Loading => (0, String::new(), None),
                HistoryBody::Empty => (1, String::new(), None),
                HistoryBody::Text {
                    text,
                    truncated,
                    local,
                } => {
                    let note = match (*local, *truncated) {
                        (true, true) => "From this window's scrollback, newest part only.",
                        (true, false) => "From this window's scrollback; the host had no history.",
                        (false, true) => "Newest part only.",
                        (false, false) => "",
                    };
                    (2, note.to_string(), Some(text.clone()))
                }
            };
            h.set_state(state);
            h.set_note(note.into());
            if let Some(text) = text {
                let changed = SHOWN.with(|s| {
                    let mut s = s.borrow_mut();
                    let same = s
                        .history_text
                        .as_ref()
                        .is_some_and(|t| Arc::ptr_eq(t, &text));
                    if !same {
                        s.history_text = Some(text.clone());
                        s.seq += 1;
                    }
                    !same
                });
                if changed {
                    h.set_text(text.as_ref().into());
                    h.set_text_seq(SHOWN.with(|s| s.borrow().seq));
                }
            } else {
                SHOWN.with(|s| s.borrow_mut().history_text = None);
                h.set_text(SharedString::new());
            }
            h.set_open(true);
        }
    }

    let p = w.global::<PaletteVm>();
    match &view.palette {
        None => {
            p.set_open(false);
            SHOWN.with(|s| s.borrow_mut().palette = None);
        }
        Some(palette) => {
            let same_rows = SHOWN.with(|s| {
                s.borrow()
                    .palette
                    .as_ref()
                    .is_some_and(|last| last.rows == palette.rows)
            });
            if !same_rows {
                let rows: Vec<PaletteRowData> = palette
                    .rows
                    .iter()
                    .map(|r| PaletteRowData {
                        name: r.name.as_str().into(),
                        preview: r.preview.as_str().into(),
                    })
                    .collect();
                p.set_rows(ModelRc::new(VecModel::from(rows)));
            }
            p.set_selected(palette.selected as i32);
            p.set_has_snippets(palette.has_snippets);
            p.set_open(true);
            SHOWN.with(|s| s.borrow_mut().palette = Some(palette.clone()));
        }
    }
}

/// Active marks follow the saved font, so this runs on every preference change too.
pub fn refresh_fonts(app: &App) {
    let Some((items, status, busy)) = with(|s| (s.fonts.items.clone(), s.status.clone(), s.busy))
    else {
        return;
    };
    let active = app.state.borrow().prefs.terminal.font.clone();
    let b = app.ui.global::<GoogleFontsBridge>();
    let rows: Vec<GoogleFontRow> = items
        .iter()
        .map(|f| GoogleFontRow {
            id: f.id().into(),
            name: f.family.as_str().into(),
            active: f.id() == active,
        })
        .collect();
    b.set_installed(ModelRc::new(VecModel::from(rows)));
    b.set_busy(busy);
    let (text, error) = status.unwrap_or_default();
    b.set_status(text.into());
    b.set_status_error(error);
}

fn set_status(app: &App, text: &str, error: bool, busy: bool) {
    with(|s| {
        s.status = Some((text.to_string(), error));
        s.busy = busy;
    });
    refresh_fonts(app);
}

/// One blocking GET per call, never leaving the host it was asked for.
struct UreqFetch(ureq::Agent);

impl UreqFetch {
    fn new() -> Self {
        let config = ureq::Agent::config_builder()
            .max_redirects(0)
            .http_status_as_error(false)
            .timeout_global(Some(Duration::from_secs(30)))
            // Anything but a browser agent gets TrueType instead of WOFF2.
            .user_agent("Tether")
            .build();
        Self(config.into())
    }
}

impl Fetch for UreqFetch {
    fn get(&self, url: &str, max_bytes: usize) -> Result<Response, String> {
        let mut response = self.0.get(url).call().map_err(|e| e.to_string())?;
        let status = response.status().as_u16();
        if status != 200 {
            return Ok(Response {
                status,
                body: Vec::new(),
            });
        }
        let body = response
            .body_mut()
            .with_config()
            .limit(max_bytes as u64)
            .read_to_vec()
            .map_err(|e| e.to_string())?;
        Ok(Response { status, body })
    }
}

fn start_download(app: &Rc<App>, input: String) {
    let Some((root, installed, locked, busy)) = with(|s| {
        (
            s.root.clone(),
            s.fonts.items.clone(),
            s.fonts_locked,
            s.busy,
        )
    }) else {
        return;
    };
    if busy {
        return;
    }
    if locked {
        set_status(
            app,
            "Couldn't read the saved fonts list, so nothing can be added.",
            true,
            false,
        );
        return;
    }
    set_status(app, "Downloading…", false, true);
    let dir = fonts_dir(&root);
    std::thread::spawn(move || {
        let result = download(&dir, &input, &installed);
        let _ = slint::invoke_from_event_loop(move || finish_download(result));
    });
}

fn download(
    dir: &Path,
    input: &str,
    installed: &[DownloadedFont],
) -> Result<DownloadedFont, String> {
    let fetch = UreqFetch::new();
    let got = googlefonts::install(&fetch, dir, input, installed).map_err(|e| e.to_string())?;
    match tether_term::fonts::register_downloaded(&got.font, got.regular, got.bold) {
        Ok(()) => Ok(got.font),
        Err(e) => {
            googlefonts::remove_files(dir, &got.font);
            Err(match e {
                tether_term::fonts::FontError::NeedsRestart => e.to_string(),
                other => format!("{} {other}", got.font.family),
            })
        }
    }
}

fn finish_download(result: Result<DownloadedFont, String>) {
    let Some(app) = app() else { return };
    match result {
        Ok(font) => {
            let saved = with(|s| {
                s.fonts.items.push(font.clone());
                s.fonts
                    .save(&DataDir::new(fonts_dir(&s.root)))
                    .map_err(|e| e.to_string())
            });
            let message = match saved {
                Some(Err(e)) => {
                    format!("Installed {}, but couldn't save the list: {e}", font.family)
                }
                _ => format!("Installed {}.", font.family),
            };
            set_status(&app, &message, false, false);
            app.ui
                .global::<GoogleFontsBridge>()
                .set_input(SharedString::new());
            app.update_terminal_prefs(|t| t.font = font.id());
        }
        Err(message) => set_status(&app, &message, true, false),
    }
}

fn remove_font(app: &Rc<App>, id: &str) {
    let Some(font) = with(|s| s.fonts.by_id(id).cloned()).flatten() else {
        return;
    };
    if app.state.borrow().prefs.terminal.font == id {
        app.update_terminal_prefs(|t| t.font = DEFAULT_FONT.to_string());
    }
    tether_term::fonts::unregister_downloaded(id);
    with(|s| {
        googlefonts::remove_files(&fonts_dir(&s.root), &font);
        s.fonts.items.retain(|f| f.slug != font.slug);
        if let Err(e) = s.fonts.save(&DataDir::new(fonts_dir(&s.root))) {
            tracing::warn!("saving downloaded fonts failed: {e}");
        }
        s.status = Some((format!("Removed {}.", font.family), false));
    });
    app.ui
        .global::<GoogleFontsBridge>()
        .set_status(SharedString::new());
    refresh_fonts(app);
    // The picker's bundled rows are untouched; the settings label may name the old font.
    app.on_prefs_changed();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn form(name: &str, text: &str) -> SnippetForm {
        SnippetForm {
            name: name.into(),
            text: text.into(),
            ..Default::default()
        }
    }

    #[test]
    fn an_untouched_form_is_quiet_and_not_savable() {
        let f = SnippetForm::default();
        assert_eq!(f.hint(), "");
        assert!(!f.can_save());
        assert_eq!(f.save_label(), "Add snippet");
    }

    #[test]
    fn the_hint_names_the_first_problem_once_something_is_typed() {
        assert_eq!(form("", "ls").hint(), "Give the snippet a name.");
        assert_eq!(form("List", "").hint(), "Type the text the snippet sends.");
        assert_eq!(form("List", "ls\\n").hint(), "");
        assert!(form("List", "ls\\n").can_save());
    }

    #[test]
    fn a_save_error_wins_until_the_next_edit_and_editing_relabels_the_button() {
        let mut f = form("List", "ls");
        f.error = Some("Couldn't save: disk full".into());
        assert_eq!(f.hint(), "Couldn't save: disk full");
        f.editing = Some(Uuid::nil());
        assert_eq!(f.save_label(), "Save changes");
    }

    #[test]
    fn the_settings_row_counts_snippets() {
        assert_eq!(count_label(0), "None yet");
        assert_eq!(count_label(1), "1 saved");
        assert_eq!(count_label(12), "12 saved");
    }

    #[test]
    fn stored_fonts_register_and_a_missing_file_drops_the_family() {
        let dir = tempfile::tempdir().unwrap();
        let font = DownloadedFont {
            family: "Probe Mono".into(),
            slug: "probe-mono-app".into(),
            regular: "regular.ttf".into(),
            bold: None,
        };
        assert!(!register(dir.path(), &font));
        let folder = googlefonts::folder(dir.path(), &font);
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("regular.ttf"), b"nope").unwrap();
        assert!(!register(dir.path(), &font));
        std::fs::write(
            folder.join("regular.ttf"),
            tether_term::face_bytes("jetbrains-mono").0,
        )
        .unwrap();
        assert!(register(dir.path(), &font));
        assert_eq!(
            tether_core::fonts::font_named("gf-probe-mono-app").name,
            "Probe Mono"
        );
        tether_term::fonts::unregister_downloaded("gf-probe-mono-app");
    }

    #[test]
    fn init_restores_snippets_and_prunes_unusable_fonts() {
        let dir = tempfile::tempdir().unwrap();
        let data = DataDir::new(dir.path());
        let mut list = Snippets::default();
        list.upsert(None, "Hello", "echo hi\\n").unwrap();
        list.save(&data).unwrap();
        let fonts_root = fonts_dir(dir.path());
        std::fs::create_dir_all(&fonts_root).unwrap();
        DownloadedFonts {
            items: vec![DownloadedFont {
                family: "Gone Mono".into(),
                slug: "gone-mono".into(),
                regular: "regular.ttf".into(),
                bold: None,
            }],
        }
        .save(&DataDir::new(&fonts_root))
        .unwrap();
        init(dir.path());
        let (names, fonts) = with(|s| (s.snippets.items.len(), s.fonts.items.len())).unwrap();
        assert_eq!((names, fonts), (1, 0));
        let on_disk = DownloadedFonts::load(&DataDir::new(&fonts_root)).unwrap();
        assert!(on_disk.items.is_empty());
    }
}

/// The font page's column, less nothing: chips fill it edge to edge.
const SUGGESTION_WIDTH: f32 = 520.0;

/// Slint has no wrapping layout, so suggestions are packed into rows here. A chip is its
/// label (about 6.7 px a character at 12 px) plus 20 px of padding, 6 px apart.
pub fn chip_rows<'a>(names: &[&'a str], width: f32) -> Vec<Vec<&'a str>> {
    let mut rows: Vec<Vec<&str>> = Vec::new();
    let mut used = 0.0;
    for &name in names {
        let chip = name.chars().count() as f32 * 6.7 + 20.0;
        match rows.last_mut() {
            Some(row) if used + 6.0 + chip <= width => {
                row.push(name);
                used += 6.0 + chip;
            }
            _ => {
                rows.push(vec![name]);
                used = chip;
            }
        }
    }
    rows
}

#[cfg(test)]
mod chip_tests {
    use super::chip_rows;

    #[test]
    fn chips_wrap_to_the_column_and_keep_their_order() {
        let names = [
            "Fira Code",
            "IBM Plex Mono",
            "Source Code Pro",
            "Victor Mono",
            "Geist Mono",
        ];
        let rows = chip_rows(&names, 300.0);
        assert!(rows.len() > 1);
        assert_eq!(rows.concat(), names);
        for row in &rows {
            let w: f32 = row.iter().map(|n| n.len() as f32 * 6.7 + 20.0).sum::<f32>()
                + 6.0 * (row.len() as f32 - 1.0);
            assert!(w <= 300.0 || row.len() == 1);
        }
    }
}
