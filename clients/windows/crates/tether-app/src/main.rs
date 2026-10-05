#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

slint::include_modules!();

mod app;
mod open_machine;
mod platform;
mod preview;
mod router;
mod vm;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();
    slint::BackendSelector::new()
        .backend_name("winit".into())
        .select()?;
    let app = app::App::new()?;
    app.run()?;
    Ok(())
}
