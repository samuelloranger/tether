fn main() {
    // MSVC reserves 1 MB for the main thread; Linux and macOS give it 8 MB. The
    // command futures `block_on` runs there need far more than that — 32 frames
    // want ~800 KB and one wants 1.5 MB — so a stock Windows build dies with
    // STATUS_STACK_OVERFLOW as soon as a host profile exists.
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        println!("cargo:rustc-link-arg-bins=/STACK:16777216");
    }
    tauri_build::build();
}
