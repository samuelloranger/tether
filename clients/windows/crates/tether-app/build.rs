use std::{env, fs, path::PathBuf};

fn main() {
    let config = slint_build::CompilerConfiguration::new().with_style("fluent".into());
    slint_build::compile_with_config("ui/app.slint", config).expect("compile ui/app.slint");
    copy_licenses();
}

fn copy_licenses() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let windows = manifest.join("../..");
    let apple = windows.join("../apple/TetherKit/Sources/TetherKit/Resources");
    let sources = [
        (apple.join("TerminalThemes-LICENSE.txt"), "TerminalThemes-LICENSE.txt"),
        (apple.join("Fonts/LICENSES.md"), "Fonts-LICENSES.md"),
        (windows.join("assets/fonts/CascadiaCode-LICENSE.txt"), "CascadiaCode-LICENSE.txt"),
    ];
    let out = PathBuf::from(env::var("OUT_DIR").unwrap());
    let licenses = out.ancestors().nth(3).unwrap().join("licenses");
    fs::create_dir_all(&licenses).unwrap();
    for (from, name) in sources {
        println!("cargo:rerun-if-changed={}", from.display());
        fs::copy(&from, licenses.join(name)).unwrap_or_else(|e| panic!("{}: {e}", from.display()));
    }
}
