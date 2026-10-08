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
mod uifont;
mod updates;
mod vm;

fn main() {
    #[cfg(any(windows, target_os = "linux"))]
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
    // The Wayland app_id and X11 WM_CLASS, which a desktop entry named `tether` is matched against.
    slint::set_xdg_app_id(platform::APP_ID)?;
    let app = app::App::new()?;
    #[cfg(windows)]
    terminal::files::set_codec(std::sync::Arc::new(platform::windows::wic::WicCodec));
    #[cfg(windows)]
    let platform: std::sync::Arc<dyn platform::Platform> = {
        let p = std::sync::Arc::new(platform::windows::platform::WindowsPlatform::new(
            app.ui.as_weak(),
        ));
        p.prepare_identity();
        p
    };
    #[cfg(target_os = "linux")]
    terminal::files::set_codec(std::sync::Arc::new(platform::linux::codec::ImageCrateCodec));
    #[cfg(target_os = "linux")]
    let platform: std::sync::Arc<dyn platform::Platform> = std::sync::Arc::new(
        platform::linux::platform::LinuxPlatform::new(app.ui.as_weak()),
    );
    #[cfg(not(any(windows, target_os = "linux")))]
    let platform: std::sync::Arc<dyn platform::Platform> =
        std::sync::Arc::new(platform::NullPlatform);
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
    #[cfg(any(windows, target_os = "linux"))]
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
