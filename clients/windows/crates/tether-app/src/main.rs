#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

slint::include_modules!();

mod app;
mod open_machine;
mod platform;
mod preview;
mod router;
mod startup;
mod terminal;
mod vm;
mod win32;

fn main() {
    #[cfg(not(debug_assertions))]
    startup::install_panic_hook();
    if let Err(err) = start() {
        platform::show_error_box(&startup::startup_message(err.as_ref()));
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
    tracing_subscriber::fmt::init();
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
    app.apply_dev_screen();
    app.run()?;
    Ok(())
}
