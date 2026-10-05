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
    tracing_subscriber::fmt::init();
    slint::BackendSelector::new()
        .backend_name("winit".into())
        .select()?;
    let app = app::App::new()?;
    let platform: std::sync::Arc<dyn win32::Platform> = std::sync::Arc::new(win32::NullPlatform);
    terminal::glue::init(&app, platform);
    app.ui.window().on_close_requested({
        move || {
            if let Some(s) = terminal::glue::current() {
                s(terminal::model::Msg::Back);
            }
            slint::CloseRequestResponse::HideWindow
        }
    });
    app.run()?;
    Ok(())
}
