const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// The Rust build directory churns constantly while `cargo`/`tauri` builds run
// alongside Metro (bun dev:mobile + bun tauri:dev at once) — Metro's watcher
// picking up transient files/dirs there races with cargo deleting them and
// crashes the whole process with ENOENT. Metro has no business watching Rust
// build output anyway.
config.resolver.blockList = [/apps\/mobile\/src-tauri\/target\/.*/];

module.exports = config;
