#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

slint::include_modules!();

mod app;
mod open_machine;
mod platform;
mod preview;
mod router;
mod startup;
mod vm;

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
    app.run()?;
    Ok(())
}
