use std::{env, fs, path::PathBuf};

fn main() {
    let config = slint_build::CompilerConfiguration::new().with_style("fluent".into());
    slint_build::compile_with_config("ui/app.slint", config).expect("compile ui/app.slint");
    copy_licenses();
    embed_icon();
}

/// The .exe icon is what Explorer, the Start menu, and the taskbar pin show.
fn embed_icon() {
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let icon = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap())
        .join("../../assets/icons/tether.ico");
    println!("cargo:rerun-if-changed={}", icon.display());
    winresource::WindowsResource::new()
        .set_icon(icon.to_str().unwrap())
        .set("ProductName", "Tether")
        .set("FileDescription", "Tether")
        .compile()
        .expect("embed the app icon");
}

fn copy_licenses() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let windows = manifest.join("../..");
    let apple = windows.join("../apple/TetherKit/Sources/TetherKit/Resources");
    let sources = [
        (
            apple.join("TerminalThemes-LICENSE.txt"),
            "TerminalThemes-LICENSE.txt",
        ),
        (apple.join("Fonts/LICENSES.md"), "Fonts-LICENSES.md"),
        (
            windows.join("assets/fonts/CascadiaCode-LICENSE.txt"),
            "CascadiaCode-LICENSE.txt",
        ),
    ];
    let out = PathBuf::from(env::var("OUT_DIR").unwrap());
    let licenses = out.ancestors().nth(3).unwrap().join("licenses");
    fs::create_dir_all(&licenses).unwrap();
    for (from, name) in sources {
        println!("cargo:rerun-if-changed={}", from.display());
        fs::copy(&from, licenses.join(name)).unwrap_or_else(|e| panic!("{}: {e}", from.display()));
    }
}
