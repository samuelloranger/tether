use std::{
    cell::{Cell, RefCell},
    error::Error,
    rc::Rc,
    sync::Arc,
};

use slint::winit_030::{
    EventResult, WinitWindowAccessor,
    winit::{self, event::WindowEvent},
};
use slint::{ComponentHandle, ModelRc, SharedPixelBuffer, SharedString, VecModel};
use tether_core::{
    DataDir, JsonHostKeys, KeyOrigin, SecretStore, TerminalPrefs, WindowPlacement,
    chrome::ChromePalette, theme_named,
};
use uuid::Uuid;

use crate::{
    AppBridge, AppWindow, FontRow, HomeBridge, ImportRow as ImportRowItem, KeyCard, KeyFormBridge,
    MachineCard, PageKind, PickerBridge, SchemeRow, ServerFormBridge, SettingsBridge,
    SshImportBridge, Tokens,
    open_machine::on_open_machine,
    platform,
    preview::Preview,
    router::{Dialog, Page, Router},
    vm::{
        app_state::{AppState, save_failed_hint, unix_now},
        home::{self, HomeTab},
        key_forms::{self, GenerateVm, KeyMaterialVm},
        pickers, placement,
        server_form::{ServerFormVm, ServerInput},
        settings,
        ssh_import::{self, SshImportVm},
    },
};

pub struct App {
    pub ui: AppWindow,
    pub state: Rc<RefCell<AppState>>,
    pub router: Router,
    #[allow(dead_code)]
    pub runtime: tokio::runtime::Runtime,
    last_normal: RefCell<Option<WindowPlacement>>,
    home_tab: Cell<HomeTab>,
    server_form: RefCell<Option<ServerFormVm>>,
    generate: RefCell<GenerateVm>,
    key_material: RefCell<Option<KeyMaterialVm>>,
    ssh_import: RefCell<Option<SshImportVm>>,
    preview: RefCell<Preview>,
    cursor_on: Cell<bool>,
    blink_timer: slint::Timer,
}

fn page_kind(page: &Page) -> PageKind {
    match page {
        Page::Home => PageKind::Home,
        Page::SshImport => PageKind::SshImport,
        Page::ServerForm { .. } => PageKind::ServerForm,
        Page::KeyGenerate => PageKind::KeyGenerate,
        Page::KeyImport => PageKind::KeyImport,
        Page::KeyPaste => PageKind::KeyPaste,
        Page::Settings => PageKind::Settings,
        Page::SchemePicker => PageKind::SchemePicker,
        Page::FontPicker => PageKind::FontPicker,
        Page::Terminal => PageKind::Terminal,
        Page::HostKeyRefused => PageKind::HostKeyRefused,
        Page::CouldntConnect => PageKind::CouldntConnect,
        Page::Snippets => PageKind::Snippets,
    }
}

/// Debug builds only: lets `packaging/screenshots.ps1` open any page against sample data.
fn dev_env(name: &str) -> Option<String> {
    if cfg!(debug_assertions) {
        std::env::var(name).ok().filter(|v| !v.is_empty())
    } else {
        None
    }
}

fn secret_store(data: &DataDir) -> Arc<dyn SecretStore> {
    #[cfg(windows)]
    {
        Arc::new(tether_core::DpapiSecretStore::new(data))
    }
    #[cfg(not(windows))]
    {
        let _ = data;
        Arc::new(tether_core::MemorySecretStore::default())
    }
}

fn on<F: Fn(&Rc<App>) + 'static>(app: &Rc<App>, f: F) -> impl Fn() + 'static {
    let weak = Rc::downgrade(app);
    move || {
        if let Some(app) = weak.upgrade() {
            f(&app);
        }
    }
}

fn on_id<F: Fn(&Rc<App>, Uuid) + 'static>(app: &Rc<App>, f: F) -> impl Fn(SharedString) + 'static {
    let weak = Rc::downgrade(app);
    move |id| {
        if let (Some(app), Some(id)) = (weak.upgrade(), App::parse_id(&id)) {
            f(&app, id);
        }
    }
}

impl App {
    pub fn new() -> Result<Rc<Self>, Box<dyn Error>> {
        let data = match dev_env("TETHER_DEV_DATA") {
            Some(dir) => DataDir::new(dir),
            None => DataDir::default_windows()?,
        };
        let secrets = secret_store(&data);
        let hostkeys = Arc::new(JsonHostKeys::new(DataDir::new(data.root()))?);
        let state = AppState::load(data, secrets, hostkeys, platform::system_uses_light())?;
        crate::extras::init(state.data.root());
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()?;
        let app = Rc::new(Self {
            ui: AppWindow::new()?,
            state: Rc::new(RefCell::new(state)),
            router: Router::new(),
            runtime,
            last_normal: RefCell::new(None),
            home_tab: Cell::new(HomeTab::Machines),
            server_form: RefCell::new(None),
            generate: RefCell::new(GenerateVm::default()),
            key_material: RefCell::new(None),
            ssh_import: RefCell::new(None),
            preview: RefCell::new(Preview::new()),
            cursor_on: Cell::new(true),
            blink_timer: slint::Timer::default(),
        });
        app.restore_placement();
        app.install();
        app.refresh();
        Ok(app)
    }

    fn install(self: &Rc<Self>) {
        let bridge = self.ui.global::<AppBridge>();
        let weak = Rc::downgrade(self);
        bridge.on_escape(move || {
            let Some(app) = weak.upgrade() else {
                return false;
            };
            if matches!(app.router.current(), Page::ServerForm { .. }) {
                app.forget_form_secrets();
            }
            let handled = app.router.on_escape();
            app.refresh_router();
            handled
        });
        let weak = Rc::downgrade(self);
        bridge.on_back(move || {
            if let Some(app) = weak.upgrade() {
                if matches!(app.router.current(), Page::ServerForm { .. }) {
                    app.forget_form_secrets();
                }
                app.router.back();
                app.refresh_router();
            }
        });
        let weak = Rc::downgrade(self);
        bridge.on_dialog_cancelled(move || {
            if let Some(app) = weak.upgrade() {
                app.router.close_dialog();
                app.refresh_router();
            }
        });

        bridge.on_dialog_confirmed(on(self, |app| app.confirm_dialog()));

        let home = self.ui.global::<HomeBridge>();
        let weak = Rc::downgrade(self);
        home.on_tab_changed(move |i| {
            if let Some(app) = weak.upgrade() {
                app.home_tab.set(HomeTab::from_index(i));
                app.refresh_home();
            }
        });
        home.on_add_machine(on(self, |app| app.open_server_form(None)));
        home.on_import_ssh_config(on(self, |app| app.open_ssh_import()));
        let import = self.ui.global::<SshImportBridge>();
        let weak = Rc::downgrade(self);
        import.on_toggle(move |i| {
            if let Some(app) = weak.upgrade() {
                if let (Some(vm), Ok(i)) =
                    (app.ssh_import.borrow_mut().as_mut(), usize::try_from(i))
                {
                    vm.toggle(i);
                }
                app.push_ssh_import();
            }
        });
        import.on_import(on(self, |app| app.commit_ssh_import()));
        home.on_open_settings(on(self, |app| app.open_settings()));
        home.on_open_machine(on_id(self, |app, id| {
            let machine = app.state.borrow().profiles.get(id).cloned();
            if let Some(m) = machine {
                on_open_machine(app, m);
            }
        }));
        home.on_edit_machine(on_id(self, |app, id| app.open_server_form(Some(id))));
        home.on_remove_machine(on_id(self, |app, id| {
            app.router.open_dialog(Dialog::RemoveMachine(id));
            app.refresh_router();
        }));
        home.on_copy_public_key(on_id(self, |app, id| app.copy_public_key(id)));
        home.on_delete_key(on_id(self, |app, id| {
            app.router.open_dialog(Dialog::DeleteKey(id));
            app.refresh_router();
        }));
        home.on_generate_key(on(self, |app| app.open_key_page(Page::KeyGenerate)));
        home.on_import_key(on(self, |app| app.open_key_page(Page::KeyImport)));
        home.on_paste_key(on(self, |app| app.open_key_page(Page::KeyPaste)));

        let form = self.ui.global::<ServerFormBridge>();
        form.on_edited(on(self, |app| app.server_form_edited()));
        form.on_save(on(self, |app| app.save_server_form()));

        let keyform = self.ui.global::<KeyFormBridge>();
        let weak = Rc::downgrade(self);
        keyform.on_gen_edited(move || {
            if let Some(app) = weak.upgrade() {
                let name = app.ui.global::<KeyFormBridge>().get_gen_name().to_string();
                *app.generate.borrow_mut() = GenerateVm { name, error: None };
                app.push_generate();
            }
        });
        keyform.on_generate(on(self, |app| app.generate_key()));
        keyform.on_edited(on(self, |app| app.key_material_edited()));
        keyform.on_load_file(on(self, |app| app.pick_key_file()));
        keyform.on_save(on(self, |app| app.save_key_material()));

        let s = self.ui.global::<SettingsBridge>();
        let weak = Rc::downgrade(self);
        s.on_size_step(move |d| {
            if let Some(app) = weak.upgrade() {
                app.update_terminal_prefs(|t| settings::step_size(t, d));
            }
        });
        let weak = Rc::downgrade(self);
        s.on_spacing_changed(move |v| {
            if let Some(app) = weak.upgrade() {
                app.update_terminal_prefs(|t| settings::set_spacing(t, v));
            }
        });
        let weak = Rc::downgrade(self);
        s.on_padding_step(move |d| {
            if let Some(app) = weak.upgrade() {
                app.update_terminal_prefs(|t| settings::step_padding(t, d));
            }
        });
        let weak = Rc::downgrade(self);
        s.on_cursor_changed(move |i| {
            if let Some(app) = weak.upgrade() {
                app.update_terminal_prefs(|t| t.cursor = settings::cursor_from_index(i));
            }
        });
        let weak = Rc::downgrade(self);
        s.on_blink_changed(move |on| {
            if let Some(app) = weak.upgrade() {
                app.update_terminal_prefs(|t| t.blink = on);
            }
        });
        s.on_open_schemes(on(self, |app| {
            app.ui
                .global::<PickerBridge>()
                .set_query(SharedString::new());
            app.refresh_pickers();
            app.router.go(Page::SchemePicker);
            app.refresh_router();
        }));
        s.on_open_fonts(on(self, |app| {
            app.refresh_pickers();
            app.router.go(Page::FontPicker);
            app.refresh_router();
        }));

        let picker = self.ui.global::<PickerBridge>();
        picker.on_query_changed(on(self, |app| app.refresh_pickers()));
        let weak = Rc::downgrade(self);
        picker.on_choose_scheme(move |id| {
            if let Some(app) = weak.upgrade() {
                app.state.borrow_mut().dev_real_scheme = None;
                app.update_terminal_prefs(|t| t.scheme = id.to_string());
            }
        });
        let weak = Rc::downgrade(self);
        picker.on_choose_font(move |id| {
            if let Some(app) = weak.upgrade() {
                app.update_terminal_prefs(|t| t.font = id.to_string());
            }
        });

        let weak = Rc::downgrade(self);
        self.blink_timer.start(
            slint::TimerMode::Repeated,
            std::time::Duration::from_millis(530),
            move || {
                let Some(app) = weak.upgrade() else {
                    return;
                };
                let blinking = app.state.borrow().prefs.terminal.blink
                    && app.router.current() == Page::Settings;
                let next = !blinking || !app.cursor_on.get();
                if next != app.cursor_on.get() {
                    app.cursor_on.set(next);
                    app.refresh_preview();
                }
            },
        );
        crate::extras::install(self);
    }

    pub fn run(self: &Rc<Self>) -> Result<(), slint::PlatformError> {
        let weak = Rc::downgrade(self);
        self.ui.window().on_winit_window_event(move |_, event| {
            if let Some(app) = weak.upgrade() {
                return app.on_winit_event(event);
            }
            EventResult::Propagate
        });
        let weak = Rc::downgrade(self);
        self.ui.window().on_close_requested(move || {
            if let Some(app) = weak.upgrade() {
                app.capture_placement();
            }
            if let Some(s) = crate::terminal::glue::current() {
                s(crate::terminal::model::Msg::Back);
            }
            slint::CloseRequestResponse::HideWindow
        });
        let weak = Rc::downgrade(self);
        slint::spawn_local(async move {
            let Some(app) = weak.upgrade() else {
                return;
            };
            if app.ui.window().winit_window().await.is_ok() {
                app.refresh_scene();
            }
        })
        .ok();
        self.ui.run()
    }

    pub fn refresh(&self) {
        self.refresh_scene();
        self.refresh_router();
    }

    pub fn refresh_scene(&self) {
        let theme = theme_named(&self.state.borrow().prefs.terminal.scheme);
        let c = theme.chrome();
        let dark = !theme.is_light();
        let t = self.ui.global::<Tokens>();
        t.set_dark(dark);
        t.set_background(Self::rgb(c.background));
        t.set_surface(Self::rgb(c.surface));
        t.set_surface_hover(Self::rgb(c.surface_hover));
        t.set_raised(Self::rgb(c.raised));
        t.set_input(Self::rgb(c.input));
        t.set_border(Self::rgb(c.border));
        t.set_text(Self::rgb(c.text));
        t.set_text_secondary(Self::rgb(c.text_secondary));
        t.set_text_faint(Self::rgb(c.text_faint));
        t.set_placeholder(Self::rgb(c.placeholder));
        t.set_accent(Self::rgb(c.accent));
        t.set_on_accent(Self::rgb(c.on_accent));
        t.set_success(Self::rgb(c.success));
        t.set_warning(Self::rgb(c.warning));
        t.set_danger(Self::rgb(c.danger));
        t.set_on_danger(Self::rgb(c.on_danger));
        t.set_well(Self::rgb(c.well));
        if let Some(hwnd) = platform::hwnd_of(self.ui.window()) {
            platform::apply_caption(hwnd, c.background, dark);
        }
        // Slint never sets a winit theme, so winit would follow Windows and reset the caption's dark flag.
        self.ui.window().with_winit_window(|w| {
            w.set_theme(Some(if dark {
                winit::window::Theme::Dark
            } else {
                winit::window::Theme::Light
            }));
        });
        self.refresh_home();
    }

    /// `TETHER_DEV_THEME` (a theme id; dark and light mean tether and tether-light), `TETHER_DEV_SIZE` (WxH logical px) and `TETHER_DEV_PAGE`
    /// put a debug build on one screen for a screenshot. Nothing here is saved.
    pub fn apply_dev_screen(self: &Rc<Self>) {
        if let Some(theme) = dev_env("TETHER_DEV_THEME") {
            let mut state = self.state.borrow_mut();
            state.dev_real_scheme = Some(state.prefs.terminal.scheme.clone());
            state.prefs.terminal.scheme = match theme.as_str() {
                "dark" => "tether".into(),
                "light" => "tether-light".into(),
                id => id.to_string(),
            };
            drop(state);
            self.refresh_scene();
        }
        if let Some((w, h)) = dev_env("TETHER_DEV_SIZE").and_then(|s| {
            let (w, h) = s.split_once('x')?;
            Some((w.parse::<f32>().ok()?, h.parse::<f32>().ok()?))
        }) {
            self.ui.window().set_size(slint::LogicalSize::new(w, h));
        }
        let Some(page) = dev_env("TETHER_DEV_PAGE") else {
            return;
        };
        let (first_machine, first_key) = {
            let s = self.state.borrow();
            (
                s.profiles.machines.first().cloned(),
                s.keys.keys.first().map(|k| k.id),
            )
        };
        match page.as_str() {
            "keys" => {
                self.home_tab.set(HomeTab::Keys);
                self.refresh_home();
            }
            "add-server" => self.open_server_form(None),
            "edit-server" => self.open_server_form(first_machine.as_ref().map(|m| m.id)),
            "key-generate" => self.open_key_page(Page::KeyGenerate),
            "key-import" => self.open_key_page(Page::KeyImport),
            "key-paste" => self.open_key_page(Page::KeyPaste),
            "settings" => self.open_settings(),
            "schemes" => {
                self.open_settings();
                self.refresh_pickers();
                self.router.go(Page::SchemePicker);
                self.refresh_router();
            }
            "fonts" => {
                self.open_settings();
                self.refresh_pickers();
                self.router.go(Page::FontPicker);
                self.refresh_router();
            }
            "remove-machine" => {
                if let Some(m) = &first_machine {
                    self.router.open_dialog(Dialog::RemoveMachine(m.id));
                    self.refresh_router();
                }
            }
            "delete-key" => {
                self.home_tab.set(HomeTab::Keys);
                self.refresh_home();
                if let Some(id) = first_key {
                    self.router.open_dialog(Dialog::DeleteKey(id));
                    self.refresh_router();
                }
            }
            "open" => {
                let name = dev_env("TETHER_DEV_MACHINE");
                let machine = {
                    let s = self.state.borrow();
                    s.profiles
                        .machines
                        .iter()
                        .find(|m| Some(&m.name) == name.as_ref())
                        .cloned()
                        .or(first_machine)
                };
                if let Some(m) = machine {
                    on_open_machine(self, m);
                }
            }
            _ => {}
        }
    }

    pub fn refresh_router(&self) {
        let bridge = self.ui.global::<AppBridge>();
        bridge.set_page(page_kind(&self.router.current()));
        let copy = self.router.dialog().and_then(|d| {
            let s = self.state.borrow();
            match d {
                Dialog::RemoveMachine(id) => s.profiles.get(id).map(home::remove_machine_copy),
                Dialog::DeleteKey(id) => s
                    .keys
                    .get(id)
                    .map(|k| home::delete_key_copy(k, &s.profiles)),
                Dialog::DeleteSnippet(id) => crate::extras::delete_copy(id),
            }
        });
        bridge.set_dialog_open(copy.is_some());
        if let Some(c) = copy {
            bridge.set_dialog_title(c.title.into());
            bridge.set_dialog_body(c.body.into());
            bridge.set_dialog_extra(c.extra.unwrap_or_default().into());
            bridge.set_dialog_action(c.action.into());
        }
    }

    pub fn on_prefs_changed(&self) {
        self.state.borrow().save_prefs();
        crate::terminal::glue::prefs_changed(&self.state.borrow().prefs.terminal);
        self.refresh_scene();
        self.refresh_settings();
        self.refresh_pickers();
        crate::extras::refresh_fonts(self);
    }

    pub fn on_winit_event(self: &Rc<Self>, event: &WindowEvent) -> EventResult {
        if crate::terminal::glue::on_winit_event(self, event) == EventResult::PreventDefault {
            return EventResult::PreventDefault;
        }
        match event {
            WindowEvent::Moved(_) | WindowEvent::Resized(_) => self.remember_normal_bounds(),
            WindowEvent::ScaleFactorChanged { .. } => self.refresh_preview(),
            WindowEvent::ThemeChanged(_) => self.refresh_scene(),
            _ => {}
        }
        EventResult::Propagate
    }

    fn parse_id(id: &SharedString) -> Option<Uuid> {
        Uuid::parse_str(id).ok()
    }

    fn rgb(rgb: u32) -> slint::Color {
        slint::Color::from_rgb_u8((rgb >> 16) as u8, (rgb >> 8) as u8, rgb as u8)
    }

    fn art_image(public_line: &str, chrome: &ChromePalette) -> slint::Image {
        let px = home::randomart_rgba(public_line, chrome);
        slint::Image::from_rgba8(SharedPixelBuffer::clone_from_slice(
            &px,
            home::ART_WIDTH,
            home::ART_HEIGHT,
        ))
    }

    pub fn refresh_home(&self) {
        let state = self.state.borrow();
        let chrome = theme_named(&state.prefs.terminal.scheme).chrome();
        let tab = self.home_tab.get();
        let bridge = self.ui.global::<HomeBridge>();
        bridge.set_tab(tab.index());
        bridge.set_subtitle(home::subtitle(tab, &state.profiles, &state.keys).into());
        let machines: Vec<MachineCard> = home::machine_cards(&state.profiles, &state.keys)
            .into_iter()
            .map(|c| MachineCard {
                id: c.id.to_string().into(),
                name: c.name.into(),
                address: c.address.into(),
                auth: c.auth.into(),
                key_missing: c.key_missing,
            })
            .collect();
        bridge.set_machines(ModelRc::new(VecModel::from(machines)));
        let keys: Vec<KeyCard> = home::key_cards(&state.keys, &state.profiles, home::local_date)
            .into_iter()
            .map(|c| KeyCard {
                art: Self::art_image(&c.public_line, &chrome),
                id: c.id.to_string().into(),
                name: c.name.into(),
                origin: c.origin.into(),
                meta: c.meta.into(),
                fingerprint: c.fingerprint.into(),
                usage: c.usage.into(),
            })
            .collect();
        bridge.set_keys(ModelRc::new(VecModel::from(keys)));
    }

    pub fn open_settings(&self) {
        self.refresh_settings();
        self.router.go(Page::Settings);
        self.refresh_router();
    }

    pub fn open_server_form(&self, editing: Option<Uuid>) {
        let vm = {
            let s = self.state.borrow();
            match editing.and_then(|id| s.profiles.get(id)) {
                Some(m) => ServerFormVm::edit(m, s.has_saved_password(m.id), &s.keys),
                None => ServerFormVm::add(),
            }
        };
        self.push_server_form(&vm, true);
        *self.server_form.borrow_mut() = Some(vm);
        self.router.go(Page::ServerForm { editing });
        self.refresh_router();
    }

    pub fn open_key_page(&self, page: Page) {
        let b = self.ui.global::<KeyFormBridge>();
        match page {
            Page::KeyGenerate => {
                *self.generate.borrow_mut() = GenerateVm::default();
                b.set_gen_name(SharedString::new());
                self.push_generate();
            }
            Page::KeyImport | Page::KeyPaste => {
                let origin = if page == Page::KeyImport {
                    KeyOrigin::Imported
                } else {
                    KeyOrigin::Pasted
                };
                let vm = KeyMaterialVm::new(origin);
                b.set_title(vm.title().into());
                b.set_show_file_button(vm.show_file_button());
                self.push_key_material(&vm, true);
                *self.key_material.borrow_mut() = Some(vm);
            }
            _ => {}
        }
        self.router.go(page);
        self.refresh_router();
    }

    pub fn open_ssh_import(&self) {
        let rows = {
            let s = self.state.borrow();
            let hosts = ssh_import::home_dir()
                .map(|home| {
                    tether_core::sshconfig::read_config(&home, &tether_core::sshconfig::DiskFiles)
                })
                .unwrap_or_default();
            tether_core::sshimport::plan(
                &hosts,
                &s.profiles.machines,
                &s.keys,
                &ssh_import::default_user(),
                &|p| std::fs::read_to_string(p).ok(),
            )
        };
        *self.ssh_import.borrow_mut() = Some(SshImportVm::new(rows));
        self.push_ssh_import();
        self.router.go(Page::SshImport);
        self.refresh_router();
    }

    fn push_ssh_import(&self) {
        let slot = self.ssh_import.borrow();
        let Some(vm) = slot.as_ref() else {
            return;
        };
        let b = self.ui.global::<SshImportBridge>();
        let rows: Vec<ImportRowItem> = vm
            .views()
            .into_iter()
            .map(|r| ImportRowItem {
                label: r.label.into(),
                detail: r.detail.into(),
                auth: r.auth.into(),
                via: r.via.into(),
                existing: r.existing,
                checked: r.checked,
            })
            .collect();
        b.set_rows(ModelRc::new(VecModel::from(rows)));
        b.set_import_label(vm.import_label().into());
        b.set_can_import(vm.can_import());
        b.set_hint(vm.hint().into());
    }

    fn commit_ssh_import(&self) {
        let result = {
            let slot = self.ssh_import.borrow();
            let Some(vm) = slot.as_ref() else {
                return;
            };
            self.state
                .borrow_mut()
                .import_hosts(&vm.rows, &vm.picked(), unix_now())
        };
        match result {
            Ok(_) => {
                *self.ssh_import.borrow_mut() = None;
                self.router.home();
                self.refresh_home();
                self.refresh_router();
            }
            Err(e) => {
                if let Some(vm) = self.ssh_import.borrow_mut().as_mut() {
                    vm.error = Some(save_failed_hint(&e));
                }
                self.push_ssh_import();
            }
        }
    }

    fn copy_public_key(&self, id: Uuid) {
        let Some(line) = self
            .state
            .borrow()
            .keys
            .get(id)
            .map(|k| k.public_line.clone())
        else {
            return;
        };
        if let Err(e) = arboard::Clipboard::new().and_then(|mut c| c.set_text(line)) {
            tracing::warn!("copy public key failed: {e}");
        }
    }

    fn confirm_dialog(&self) {
        let Some(dialog) = self.router.dialog() else {
            return;
        };
        let result = {
            let mut state = self.state.borrow_mut();
            match dialog {
                Dialog::RemoveMachine(id) => state.remove_machine(id),
                Dialog::DeleteKey(id) => state.delete_key(id),
                Dialog::DeleteSnippet(id) => {
                    crate::extras::delete_snippet(id);
                    Ok(())
                }
            }
        };
        if let Err(e) = result {
            tracing::warn!("{dialog:?} failed: {e}");
        }
        self.router.close_dialog();
        self.refresh_router();
        self.refresh_home();
    }

    fn push_server_form(&self, vm: &ServerFormVm, with_fields: bool) {
        let b = self.ui.global::<ServerFormBridge>();
        if with_fields {
            let keys = &self.state.borrow().keys;
            b.set_title(vm.title().into());
            b.set_save_label(vm.save_label().into());
            b.set_name(vm.form.name.as_str().into());
            b.set_host(vm.form.host.as_str().into());
            b.set_port(vm.form.port.as_str().into());
            b.set_user(vm.form.user.as_str().into());
            b.set_password(SharedString::new());
            b.set_auth(vm.segment());
            let names: Vec<SharedString> = ServerFormVm::key_names(keys)
                .into_iter()
                .map(Into::into)
                .collect();
            b.set_key_names(ModelRc::new(VecModel::from(names)));
            b.set_key_index(vm.key_index(keys));
            let machines = &self.state.borrow().profiles.machines;
            let jumps: Vec<SharedString> = vm
                .jump_options(machines)
                .into_iter()
                .map(|(_, name)| name.into())
                .collect();
            b.set_jump_names(ModelRc::new(VecModel::from(jumps)));
            b.set_jump_index(vm.jump_index(machines));
            b.set_password_placeholder(vm.password_placeholder().into());
        }
        b.set_hint(vm.hint().into());
        b.set_can_save(vm.can_save());
    }

    fn server_form_edited(&self) {
        let b = self.ui.global::<ServerFormBridge>();
        let input = ServerInput {
            name: b.get_name().into(),
            host: b.get_host().into(),
            port: b.get_port().into(),
            user: b.get_user().into(),
            segment: b.get_auth(),
            key_index: b.get_key_index(),
            password: b.get_password().into(),
            jump_index: b.get_jump_index(),
        };
        let mut slot = self.server_form.borrow_mut();
        let Some(vm) = slot.as_mut() else {
            return;
        };
        let state = self.state.borrow();
        vm.apply(input, &state.keys, &state.profiles.machines);
        drop(state);
        self.push_server_form(vm, false);
    }

    fn save_server_form(&self) {
        let mut slot = self.server_form.borrow_mut();
        let Some(vm) = slot.as_mut() else {
            return;
        };
        if !vm.can_save() {
            return;
        }
        let result = self.state.borrow_mut().save_server(vm.editing, &vm.form);
        match result {
            Ok(_) => {
                *slot = None;
                drop(slot);
                self.forget_form_secrets();
                self.home_tab.set(HomeTab::Machines);
                self.router.back();
                self.refresh_router();
                self.refresh_home();
            }
            Err(e) => {
                vm.error = Some(save_failed_hint(&e));
                self.push_server_form(vm, false);
            }
        }
    }

    pub fn forget_form_secrets(&self) {
        self.ui
            .global::<ServerFormBridge>()
            .set_password(SharedString::new());
        self.server_form.borrow_mut().take();
    }

    fn push_generate(&self) {
        let vm = self.generate.borrow();
        let b = self.ui.global::<KeyFormBridge>();
        b.set_gen_hint(vm.hint().into());
        b.set_gen_can_save(vm.can_save());
    }

    fn push_key_material(&self, vm: &KeyMaterialVm, with_fields: bool) {
        let b = self.ui.global::<KeyFormBridge>();
        if with_fields {
            b.set_name(vm.form.name.as_str().into());
            b.set_private_key(vm.form.private.as_str().into());
            b.set_public_key(vm.form.public.as_str().into());
        }
        b.set_hint(vm.hint().into());
        b.set_can_save(vm.can_save());
    }

    fn key_material_edited(&self) {
        let b = self.ui.global::<KeyFormBridge>();
        let mut slot = self.key_material.borrow_mut();
        let Some(vm) = slot.as_mut() else {
            return;
        };
        vm.apply(
            b.get_name().into(),
            b.get_private_key().into(),
            b.get_public_key().into(),
        );
        self.push_key_material(vm, false);
    }

    fn pick_key_file(self: &Rc<Self>) {
        let weak = Rc::downgrade(self);
        slint::spawn_local(async move {
            let Some(app) = weak.upgrade() else {
                return;
            };
            let mut dialog = rfd::AsyncFileDialog::new().set_title("Load private key file");
            if let Ok(window) = app.ui.window().winit_window().await {
                dialog = dialog.set_parent(window.as_ref());
            }
            let Some(file) = dialog.pick_file().await else {
                return;
            };
            let Some(loaded) = key_forms::load_key_file(file.path()) else {
                return;
            };
            let mut slot = app.key_material.borrow_mut();
            let Some(vm) = slot.as_mut() else {
                return;
            };
            key_forms::apply_loaded(&mut vm.form, loaded);
            vm.error = None;
            app.push_key_material(vm, true);
        })
        .ok();
    }

    fn finish_key_save(
        &self,
        result: Result<Uuid, crate::vm::app_state::AppError>,
    ) -> Option<String> {
        match result {
            Ok(_) => {
                self.ui
                    .global::<KeyFormBridge>()
                    .set_private_key(SharedString::new());
                self.key_material.borrow_mut().take();
                self.home_tab.set(HomeTab::Keys);
                self.router.back();
                self.refresh_router();
                self.refresh_home();
                None
            }
            Err(e) => Some(save_failed_hint(&e)),
        }
    }

    fn generate_key(&self) {
        if !self.generate.borrow().can_save() {
            return;
        }
        let name = self.generate.borrow().name.clone();
        let result = self.state.borrow_mut().generate_key(&name, unix_now());
        if let Some(error) = self.finish_key_save(result) {
            self.generate.borrow_mut().error = Some(error);
            self.push_generate();
        }
    }

    fn save_key_material(&self) {
        let (form, origin) = {
            let slot = self.key_material.borrow();
            let Some(vm) = slot.as_ref().filter(|vm| vm.can_save()) else {
                return;
            };
            (vm.form.clone(), vm.origin)
        };
        let result = self
            .state
            .borrow_mut()
            .save_imported_key(&form, origin, unix_now());
        if let Some(error) = self.finish_key_save(result)
            && let Some(vm) = self.key_material.borrow_mut().as_mut()
        {
            vm.error = Some(error);
            self.push_key_material(vm, false);
        }
    }

    pub fn refresh_settings(&self) {
        let prefs = self.state.borrow().prefs.clone();
        let t = &prefs.terminal;
        let b = self.ui.global::<SettingsBridge>();
        b.set_scheme_name(settings::scheme_label(t).into());
        b.set_font_name(settings::font_label(t).into());
        b.set_size_label(settings::size_label(t).into());
        b.set_spacing_label(settings::spacing_label(t).into());
        b.set_padding_label(settings::padding_label(t).into());
        b.set_spacing(t.line_spacing);
        b.set_cursor(settings::cursor_index(t.cursor));
        b.set_blink(t.blink);
        self.refresh_preview();
    }

    pub fn update_terminal_prefs(&self, f: impl FnOnce(&mut TerminalPrefs)) {
        f(&mut self.state.borrow_mut().prefs.terminal);
        self.on_prefs_changed();
    }

    pub fn refresh_preview(&self) {
        let prefs = self.state.borrow().prefs.terminal.clone();
        let scale = self.ui.window().scale_factor();
        let img = self
            .preview
            .borrow_mut()
            .render(&prefs, scale, self.cursor_on.get());
        let b = self.ui.global::<SettingsBridge>();
        b.set_preview(slint::Image::from_rgba8(
            SharedPixelBuffer::clone_from_slice(&img.pixels, img.width, img.height),
        ));
        b.set_preview_background(Self::rgb(theme_named(&prefs.scheme).background));
    }

    pub fn refresh_pickers(&self) {
        let terminal = self.state.borrow().prefs.terminal.clone();
        let b = self.ui.global::<PickerBridge>();
        let schemes: Vec<SchemeRow> = pickers::scheme_rows(&b.get_query(), &terminal.scheme)
            .into_iter()
            .map(|r| SchemeRow {
                id: r.id.into(),
                name: r.name.into(),
                background: Self::rgb(r.background),
                foreground: Self::rgb(r.foreground),
                blue: Self::rgb(r.blue),
                green: Self::rgb(r.green),
                dots: ModelRc::new(VecModel::from(
                    r.dots.iter().map(|&c| Self::rgb(c)).collect::<Vec<_>>(),
                )),
                meta: r.meta.into(),
                active: r.active,
            })
            .collect();
        b.set_schemes(ModelRc::new(VecModel::from(schemes)));
        let fonts: Vec<FontRow> = pickers::font_rows(&terminal.font)
            .into_iter()
            .map(|r| FontRow {
                id: r.id.into(),
                name: r.name.into(),
                active: r.active,
            })
            .collect();
        b.set_fonts(ModelRc::new(VecModel::from(fonts)));
    }

    fn current_bounds(&self) -> WindowPlacement {
        let w = self.ui.window();
        let (pos, size) = (w.position(), w.size());
        WindowPlacement {
            x: pos.x,
            y: pos.y,
            width: size.width,
            height: size.height,
            maximized: w.is_maximized(),
        }
    }

    fn remember_normal_bounds(&self) {
        let w = self.ui.window();
        if !w.is_maximized() && !w.is_minimized() {
            *self.last_normal.borrow_mut() = Some(self.current_bounds());
        }
    }

    fn restore_placement(&self) {
        let saved = self.state.borrow().prefs.window;
        let Some(p) = placement::restore(saved.as_ref(), platform::placement_visible) else {
            return;
        };
        let w = self.ui.window();
        w.set_size(slint::PhysicalSize::new(p.width, p.height));
        w.set_position(slint::PhysicalPosition::new(p.x, p.y));
        w.set_maximized(p.maximized);
        *self.last_normal.borrow_mut() = Some(WindowPlacement {
            maximized: false,
            ..p
        });
    }

    fn capture_placement(&self) {
        let previous = {
            let last = *self.last_normal.borrow();
            let from_prefs = self.state.borrow().prefs.window;
            last.or(from_prefs)
        };
        let next = placement::capture(
            self.current_bounds(),
            self.ui.window().is_minimized(),
            previous.as_ref(),
        );
        let mut state = self.state.borrow_mut();
        state.prefs.window = next;
        state.save_prefs();
    }
}
