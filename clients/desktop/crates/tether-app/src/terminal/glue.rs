use std::cell::{Cell, RefCell};
use std::rc::{Rc, Weak};
use std::sync::Arc;

use slint::ComponentHandle;
use slint::winit_030::{EventResult, WinitWindowAccessor, winit};
use tether_core::profiles::Machine;
use tether_core::resize::GridSize;
use winit::event::{ElementState, Ime, WindowEvent};
use winit::platform::modifier_supplement::KeyEventExtModifierSupplement;

use crate::app::App;
use crate::platform::Platform;
use crate::router::Page;
use crate::terminal::driver::{Driver, MsgSink, msg_sink, presented_sink};
use crate::terminal::geometry::TermStyle;
use crate::terminal::model::{
    FontStep, MenuRequest, Msg, PointerShape, Screen, TerminalModel, UiEffect,
};
use crate::terminal::remote::SshRemote;
use crate::terminal::ui_port::SlintUi;
use crate::{AgentVm, AppWindow, ConnectVm, TerminalVm};

thread_local! {
    static CURRENT: RefCell<Option<MsgSink>> = const { RefCell::new(None) };
    static APP: RefCell<Weak<App>> = const { RefCell::new(Weak::new()) };
    static PLATFORM: RefCell<Option<Arc<dyn Platform>>> = const { RefCell::new(None) };
    static WIRED: Cell<bool> = const { Cell::new(false) };
    static MODS: Cell<tether_core::keymap::Mods> = Cell::new(tether_core::keymap::Mods::default());
    static WELL_LOGICAL: Cell<(f32, f32)> = const { Cell::new((0.0, 0.0)) };
    static DROPS: RefCell<Vec<std::path::PathBuf>> = const { RefCell::new(Vec::new()) };
}

pub fn current() -> Option<MsgSink> {
    CURRENT.with(|c| c.borrow().clone())
}

fn send(m: Msg) {
    if let Some(s) = current() {
        s(m);
    }
}

fn app() -> Option<Rc<App>> {
    APP.with(|a| a.borrow().upgrade())
}

/// Called once from `main.rs`, before `app.run()`.
pub fn init(app: &Rc<App>, platform: Arc<dyn Platform>) {
    APP.with(|a| *a.borrow_mut() = Rc::downgrade(app));
    PLATFORM.with(|p| *p.borrow_mut() = Some(platform));
}

fn platform() -> Arc<dyn Platform> {
    PLATFORM
        .with(|p| p.borrow().clone())
        .unwrap_or_else(|| Arc::new(crate::platform::NullPlatform))
}

/// The body of M5's `open_machine::on_open_machine`.
pub fn open_machine(app: &Rc<App>, machine: Machine) {
    let (style, hostkeys, secrets, jumps) = {
        let s = app.state.borrow();
        (
            TermStyle::from_prefs(&s.prefs.terminal),
            s.hostkeys.clone(),
            s.secrets.clone(),
            tether_core::connect::jump_chain(&s.profiles.machines, &machine),
        )
    };
    let rt = app.runtime.handle().clone();
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let sink = msg_sink(tx.clone());
    let ui = SlintUi {
        window: app.ui.as_weak(),
        platform: platform(),
        send: sink.clone(),
    };
    let transport = tether_ssh::RusshTransport::new(rt.clone());
    let remote = Arc::new(SshRemote::new(
        transport,
        machine.clone(),
        jumps,
        hostkeys,
        secrets,
    ));
    // The real size arrives with the first well-resized message. 80×24 covers an attach that races ahead of it.
    let size = GridSize {
        cols: 80,
        rows: 24,
        width_px: 640,
        height_px: 384,
    };
    #[cfg(any(windows, target_os = "linux"))]
    let network_target = (machine.host.clone(), machine.port);
    set_well_color(&app.ui, style.theme.background);
    crate::extras::set_foreground(&app.ui, style.theme.foreground);
    app.ui.global::<ConnectVm>().set_who(
        format!(
            "{} · {}@{}:{}",
            machine.name, machine.user, machine.host, machine.port
        )
        .into(),
    );
    let (model, initial) = TerminalModel::new(machine, style, size);
    crate::terminal::frame::attach_window(&app.ui, presented_sink(tx.clone()));
    rt.spawn(Driver::new(remote, ui, tx).run(model, initial, rx));
    #[cfg(windows)]
    crate::platform::windows::network::watch(network_target.0, network_target.1);
    #[cfg(target_os = "linux")]
    crate::platform::linux::network::watch(network_target.0, network_target.1);
    CURRENT.with(|c| *c.borrow_mut() = Some(sink));
    crate::extras::send_snippets();
    if !WIRED.replace(true) {
        wire_callbacks(&app.ui);
    }
    app.router.go(Page::Terminal);
    app.refresh_router();
    let _ = app
        .ui
        .window()
        .with_winit_window(|w| w.set_ime_allowed(true));
}

/// Callbacks route through `current()`, so wiring them once per window is enough:
/// opening another machine only swaps the sink behind them.
fn wire_callbacks(ui: &AppWindow) {
    let vm = ui.global::<TerminalVm>();
    vm.on_back(|| send(Msg::Back));
    vm.on_home(|| send(Msg::Back));
    vm.on_reconnect(|| send(Msg::Reconnect));
    vm.on_select_tab(|n| send(Msg::SelectTab(n.into())));
    vm.on_kill_tab(|n| send(Msg::KillRequested(n.into())));
    vm.on_new_session(|| send(Msg::NewSessionBegin));
    vm.on_commit_name(|n| send(Msg::NewSessionCommit(n.into())));
    vm.on_cancel_name(|| send(Msg::NewSessionCancel));
    vm.on_find(|| send(Msg::SearchOpen));
    vm.on_search_edited(|q| send(Msg::SearchQuery(q.into())));
    vm.on_search_step(|older| send(Msg::SearchStep { older }));
    vm.on_search_close(|| send(Msg::SearchClose));
    vm.on_kill_confirmed(|| send(Msg::KillConfirmed));
    vm.on_kill_cancelled(|| send(Msg::KillCancelled));
    let weak = ui.as_weak();
    vm.on_tab_menu(move |name, x, y| {
        let Some(w) = weak.upgrade() else { return };
        let vm = w.global::<TerminalVm>();
        vm.set_menu_x(x);
        vm.set_menu_y(y);
        vm.set_menu_tab(name);
    });
    let weak = ui.as_weak();
    vm.on_kill_from_menu(move || {
        let Some(w) = weak.upgrade() else { return };
        let vm = w.global::<TerminalVm>();
        let name = vm.get_menu_tab().to_string();
        vm.set_menu_tab("".into());
        send(Msg::KillRequested(name));
    });
    let weak = ui.as_weak();
    vm.on_close_menu(move || {
        let Some(w) = weak.upgrade() else { return };
        let vm = w.global::<TerminalVm>();
        vm.set_menu_tab("".into());
        vm.set_menu_link("".into());
    });
    vm.on_send_file(|| {
        platform().pick_files(Box::new(|files| {
            if !files.is_empty() {
                send(Msg::SendFiles(files));
            }
        }));
    });
    // The same path as Home's gear: it fills the page before showing it.
    vm.on_settings(|| {
        if let Some(app) = app() {
            app.open_settings();
        }
    });
    let weak = ui.as_weak();
    vm.on_well_resized(move |w, h| {
        WELL_LOGICAL.set((w, h));
        let Some(win) = weak.upgrade() else { return };
        let scale = win.window().scale_factor();
        send(Msg::WellResized {
            width_px: (w * scale).round() as u32,
            height_px: (h * scale).round() as u32,
            scale,
        });
    });
    let agents = ui.global::<AgentVm>();
    agents.on_show(|| send(Msg::AgentOpen));
    agents.on_dismiss(|| send(Msg::AgentDismiss));
    agents.on_toggle(|question, option| {
        if let (Ok(question), Ok(option)) = (usize::try_from(question), usize::try_from(option)) {
            send(Msg::AgentToggle { question, option });
        }
    });
    agents.on_other(|question, text| {
        if let Ok(question) = usize::try_from(question) {
            send(Msg::AgentOther {
                question,
                text: text.into(),
            });
        }
    });
    agents.on_submit(|| send(Msg::AgentSubmit));
    agents.on_approve(|| send(Msg::AgentApprove));
    agents.on_deny(|| send(Msg::AgentDeny));
    agents.on_reply(|text| send(Msg::AgentReply(text.into())));
    let cv = ui.global::<ConnectVm>();
    cv.on_retry(|| send(Msg::Retry));
    cv.on_back_home(|| send(Msg::Back));
    vm.on_retry_session(|| send(Msg::RetrySession));
    crate::terminal::gitview::wire(ui);

    use crate::terminal::mouse::{Button, MouseKind, MouseMsg};
    let started = std::time::Instant::now();
    let weak = ui.as_weak();
    vm.on_pointer(move |kind, button, shift, ctrl, alt, x, y| {
        let Some(w) = weak.upgrade() else {
            return;
        };
        let scale = w.window().scale_factor();
        let vm = w.global::<TerminalVm>();
        vm.set_pointer_x(x);
        vm.set_pointer_y(y);
        let kind = match kind {
            0 => MouseKind::Down,
            1 => MouseKind::Up,
            _ => MouseKind::Move,
        };
        let button = match button {
            0 => Button::Left,
            1 => Button::Right,
            2 => Button::Middle,
            _ => Button::None,
        };
        if kind == MouseKind::Down && button == Button::Right {
            vm.set_menu_x(x);
            vm.set_menu_y(y + 52.0 + 34.0);
        }
        let mods = tether_core::keymap::Mods { shift, alt, ctrl };
        send(Msg::Mouse(MouseMsg {
            kind,
            button,
            mods,
            x_px: x * scale,
            y_px: y * scale,
            at_ms: started.elapsed().as_millis() as u64,
        }));
    });
    let weak = ui.as_weak();
    vm.on_wheel(move |delta, shift, ctrl, alt, x, y| {
        let Some(w) = weak.upgrade() else {
            return;
        };
        let scale = w.window().scale_factor();
        send(Msg::Wheel {
            delta_px: delta * scale,
            mods: tether_core::keymap::Mods { shift, alt, ctrl },
            x_px: x * scale,
            y_px: y * scale,
        });
    });
    let (weak, p) = (ui.as_weak(), platform());
    vm.on_copy_link(move || {
        let Some(w) = weak.upgrade() else {
            return;
        };
        let vm = w.global::<TerminalVm>();
        p.set_clipboard(vm.get_menu_link().as_str());
        vm.set_menu_link("".into());
    });
    let weak = ui.as_weak();
    vm.on_menu_primary(move || {
        let Some(w) = weak.upgrade() else {
            return;
        };
        let vm = w.global::<TerminalVm>();
        send(if vm.get_menu_copy() {
            Msg::CopySelection
        } else {
            Msg::PasteClipboard
        });
        vm.set_menu_link("".into());
    });
}

/// Keys go to the PTY only on the terminal page, with no name field, dialog, or menu open.
fn keys_to_pty(app: &App) -> bool {
    let vm = app.ui.global::<TerminalVm>();
    current().is_some()
        && app.router.current() == Page::Terminal
        && !vm.get_naming()
        && !vm.get_search_focused()
        && vm.get_kill_name().is_empty()
        && vm.get_menu_tab().is_empty()
        && vm.get_menu_link().is_empty()
        && !crate::extras::overlay_open(&app.ui)
        && !app.ui.global::<AgentVm>().get_open()
        && !app.ui.global::<crate::GitVm>().get_modal()
}

pub fn on_winit_event(app: &Rc<App>, event: &WindowEvent) -> EventResult {
    match event {
        WindowEvent::ModifiersChanged(m) => {
            let mods = crate::terminal::keys::mods_of(m.state());
            MODS.set(mods);
            send(Msg::Modifiers(mods));
            EventResult::Propagate
        }
        WindowEvent::KeyboardInput { event, .. } if keys_to_pty(app) => {
            if event.state == ElementState::Pressed {
                let input = crate::terminal::keys::translate(
                    &event.logical_key,
                    &event.key_without_modifiers(),
                    event.text_with_all_modifiers(),
                    event.physical_key,
                    event.location,
                    MODS.get(),
                    crate::terminal::keys::app_keypad(),
                );
                if let Some(input) = input {
                    send(Msg::Key {
                        input,
                        mods: MODS.get(),
                    });
                }
            }
            EventResult::PreventDefault
        }
        WindowEvent::Ime(Ime::Commit(text)) if keys_to_pty(app) => {
            send(Msg::Ime(text.clone()));
            EventResult::PreventDefault
        }
        WindowEvent::Focused(focused) => {
            send(Msg::Focus(*focused));
            #[cfg(windows)]
            if *focused {
                static ONCE: std::sync::Once = std::sync::Once::new();
                ONCE.call_once(|| {
                    if let Some(h) = crate::platform::hwnd_of(app.ui.window()) {
                        crate::platform::windows::wndproc::install(h);
                    }
                });
            }
            if *focused && keys_to_pty(app) {
                let _ = app
                    .ui
                    .window()
                    .with_winit_window(|w| w.set_ime_allowed(true));
            }
            EventResult::Propagate
        }
        WindowEvent::DroppedFile(path) => {
            let first = DROPS.with(|d| {
                let mut d = d.borrow_mut();
                d.push(path.clone());
                d.len() == 1
            });
            if first {
                slint::Timer::single_shot(std::time::Duration::from_millis(50), || {
                    let paths = DROPS.with(|d| std::mem::take(&mut *d.borrow_mut()));
                    send(Msg::DroppedFiles(paths));
                });
            }
            EventResult::Propagate
        }
        WindowEvent::ScaleFactorChanged { .. } => {
            let (w, h) = WELL_LOGICAL.get();
            let weak = app.ui.as_weak();
            slint::Timer::single_shot(std::time::Duration::ZERO, move || {
                if let Some(ui) = weak.upgrade() {
                    ui.global::<TerminalVm>().invoke_well_resized(w, h);
                }
            });
            EventResult::Propagate
        }
        _ => EventResult::Propagate,
    }
}

/// The UI-thread half of the `UiEffect`s that touch Slint or app state.
pub fn apply_on_ui(w: &AppWindow, fx: UiEffect) {
    let vm = w.global::<TerminalVm>();
    let Some(app) = app() else { return };
    match fx {
        // Couldn't connect → Retry: the terminal page comes back on top of Home.
        UiEffect::Navigate(Screen::Terminal) => {
            if app.router.current() != Page::Terminal {
                app.router.home();
                app.router.go(Page::Terminal);
            }
            app.refresh_router();
        }
        // The two connect pages replace the terminal page, so leaving them lands on Home.
        UiEffect::Navigate(Screen::Refused { expected, got }) => {
            let cv = w.global::<ConnectVm>();
            cv.set_expected(expected.into());
            cv.set_got(got.into());
            app.router.home();
            app.router.go(Page::HostKeyRefused);
            app.refresh_router();
        }
        UiEffect::Navigate(Screen::Failed { sentence }) => {
            w.global::<ConnectVm>().set_sentence(sentence.into());
            app.router.home();
            app.router.go(Page::CouldntConnect);
            app.refresh_router();
        }
        UiEffect::Home => {
            CURRENT.with(|c| *c.borrow_mut() = None);
            w.set_window_title("Tether".into());
            app.router.home();
            app.refresh_router();
        }
        UiEffect::LampFlash => vm.set_lamp_flash_seq(vm.get_lamp_flash_seq() + 1),
        UiEffect::SetTitle(t) => w.set_window_title(t.into()),
        UiEffect::FontStep(step) => {
            {
                let mut s = app.state.borrow_mut();
                match step {
                    FontStep::Bigger => s.prefs.terminal.bigger(),
                    FontStep::Smaller => s.prefs.terminal.smaller(),
                    FontStep::Reset => s.prefs.terminal.reset_size(),
                }
            }
            // Saves, re-skins, and (through `prefs_changed`) restyles every tab.
            app.on_prefs_changed();
        }
        UiEffect::Pointer(shape) => vm.set_hand_cursor(shape == PointerShape::Hand),
        UiEffect::Tooltip(tip) => vm.set_tooltip(tip.unwrap_or_default().into()),
        UiEffect::Menu(MenuRequest::Tab { name }) => vm.set_menu_tab(name.into()),
        UiEffect::Menu(MenuRequest::Link {
            url,
            copy_selection,
        }) => {
            vm.set_menu_copy(copy_selection);
            vm.set_menu_link(url.into());
        }
        // SlintUi::apply handles these before they get here.
        UiEffect::ReadClipboard
        | UiEffect::FlashTaskbar
        | UiEffect::Taskbar(_)
        | UiEffect::Toast { .. }
        | UiEffect::OpenUrl(_)
        | UiEffect::SetClipboard(_)
        | UiEffect::BringToFront
        | UiEffect::PickFiles => {}
        UiEffect::FocusSearch => vm.set_search_focus_seq(vm.get_search_focus_seq() + 1),
        UiEffect::Git(view) => crate::terminal::gitview::apply(w, *view),
        UiEffect::AllowIme => {
            app.ui
                .window()
                .with_winit_window(|w| w.set_ime_allowed(true));
        }
    }
}

/// M6's line in `App::on_prefs_changed`: settings and font shortcuts restyle the open terminal.
pub fn prefs_changed(prefs: &tether_core::prefs::TerminalPrefs) {
    let style = TermStyle::from_prefs(prefs);
    if let Some(app) = app() {
        set_well_color(&app.ui, style.theme.background);
        crate::extras::set_foreground(&app.ui, style.theme.foreground);
    }
    send(Msg::StyleChanged(style));
}

/// The active tab is painted in the theme background so it reads as part of the grid below.
fn set_well_color(ui: &AppWindow, rgb: u32) {
    ui.global::<TerminalVm>()
        .set_well_color(slint::Color::from_rgb_u8(
            (rgb >> 16) as u8,
            (rgb >> 8) as u8,
            rgb as u8,
        ));
}
