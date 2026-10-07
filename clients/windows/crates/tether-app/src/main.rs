#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

slint::include_modules!();

mod app;
mod extras;
mod logging;
mod open_machine;
mod platform;
mod preview;
mod router;
mod startup;
mod terminal;
mod updates;
mod vm;
mod win32;

fn main() {
    #[cfg(windows)]
    updates::startup();
    let log = logging::init();
    #[cfg(not(debug_assertions))]
    startup::install_panic_hook();
    if let Err(err) = start() {
        let message = startup::startup_message(err.as_ref());
        tracing::error!("startup failed: {message}");
        platform::show_error_box(&message);
        // exit skips destructors, and the guard's drop is what flushes the file.
        drop(log);
        std::process::exit(1);
    }
}

fn start() -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(windows)]
    unsafe {
        let _ = windows::Win32::System::Com::CoInitializeEx(
            None,
            windows::Win32::System::Com::COINIT_APARTMENTTHREADED,
        );
    }
    slint::BackendSelector::new()
        .backend_name("winit".into())
        .select()?;
    let app = app::App::new()?;
    #[cfg(windows)]
    terminal::files::set_codec(std::sync::Arc::new(win32::wic::WicCodec));
    #[cfg(windows)]
    let platform: std::sync::Arc<dyn win32::Platform> = {
        let p = std::sync::Arc::new(win32::platform::WindowsPlatform::new(app.ui.as_weak()));
        p.prepare_identity();
        p
    };
    #[cfg(not(windows))]
    let platform: std::sync::Arc<dyn win32::Platform> = std::sync::Arc::new(win32::NullPlatform);
    terminal::glue::init(&app, platform);
    watch_updates(&app);
    app.apply_dev_screen();
    app.run()?;
    Ok(())
}

fn watch_updates(app: &app::App) {
    use slint::ComponentHandle;
    let bridge = app.ui.global::<SettingsBridge>();
    bridge.set_version_label(updates::VERSION.into());
    bridge.set_update_label(updates::UpdateStatus::Unmanaged.label().into());
    #[cfg(windows)]
    {
        let updater = updates::Updater::default();
        let restart = updater.clone();
        let ui = app.ui.as_weak();
        bridge.on_restart_to_update(move || {
            let Some(w) = ui.upgrade() else { return };
            if restart.apply_on_exit() {
                w.window()
                    .dispatch_event(slint::platform::WindowEvent::CloseRequested);
            } else {
                let b = w.global::<SettingsBridge>();
                b.set_update_label(updates::UpdateStatus::InstallFailed.label().into());
                b.set_update_ready(false);
            }
        });
        let ui = app.ui.as_weak();
        updater.spawn(move |status| {
            let _ = ui.upgrade_in_event_loop(move |w| {
                let b = w.global::<SettingsBridge>();
                b.set_update_label(status.label().into());
                b.set_update_ready(status.is_ready());
            });
        });
    }
}
