const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// The Rust build directory churns constantly while `cargo`/`tauri` builds run
// alongside Metro (bun dev:mobile + bun tauri:dev at once) — Metro's watcher
// picking up transient files/dirs there races with cargo deleting them and
// crashes the whole process with ENOENT. Metro has no business watching Rust
// build output anyway.
config.resolver.blockList = [/apps\/mobile\/src-tauri\/target\/.*/];

// @xterm/headless ships a broken `module` field (`lib/xterm.mjs` — no such dir;
// the package only has `lib-headless/`). Metro-web prefers `module` and fails to
// bundle. Pin the import to the package's real `main` entry on every platform.
const xtermHeadlessMain = require.resolve('@xterm/headless', { paths: [__dirname] });
const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === '@xterm/headless') {
    return { type: 'sourceFile', filePath: xtermHeadlessMain };
  }
  return (defaultResolveRequest ?? context.resolveRequest)(context, moduleName, platform);
};

module.exports = config;
