#!/usr/bin/env bash
# Tether server installer — no git clone needed.
#
#   curl -fsSL https://raw.githubusercontent.com/samuelloranger/tether/main/install.sh | bash
#
# While the repo is private, pass a token (classic PAT or `gh auth token`):
#   curl -fsSL -H "Authorization: Bearer $GITHUB_TOKEN" .../install.sh | GITHUB_TOKEN=... bash
#
# Env overrides:
#   TETHER_REF    git ref to install (default: main)
#   TETHER_HOME   install dir (default: ~/.tether/app)
#   TETHER_BIN    symlink dir for the CLI (default: ~/.local/bin)
#   GITHUB_TOKEN  auth for private repo download
set -euo pipefail

REPO="samuelloranger/tether"
REF="${TETHER_REF:-main}"
APP_DIR="${TETHER_HOME:-$HOME/.tether/app}"
BIN_DIR="${TETHER_BIN:-$HOME/.local/bin}"
MIN_BUN="1.3.14" # Bun.spawn PTY support — older bun silently breaks sessions

say() { printf '\033[36m[tether]\033[0m %s\n' "$*"; }
die() {
  printf '\033[31m[tether]\033[0m %s\n' "$*" >&2
  exit 1
}

# --- 1. Bun ------------------------------------------------------------------
if ! command -v bun >/dev/null 2>&1; then
  say "bun not found — installing via bun.sh"
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi
BUN_V="$(bun --version)"
if [ "$(printf '%s\n%s\n' "$MIN_BUN" "$BUN_V" | sort -V | head -1)" != "$MIN_BUN" ]; then
  say "bun $BUN_V too old (need >= $MIN_BUN) — upgrading"
  bun upgrade || die "bun upgrade failed; install bun >= $MIN_BUN manually"
fi
say "bun $(bun --version) ok"

# --- 2. Download the server workspace ---------------------------------------
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
AUTH=()
[ -n "${GITHUB_TOKEN:-}" ] && AUTH=(-H "Authorization: Bearer $GITHUB_TOKEN")
say "downloading $REPO@$REF"
curl -fL "${AUTH[@]}" "https://api.github.com/repos/$REPO/tarball/$REF" -o "$TMP/src.tgz" ||
  die "download failed — private repo? set GITHUB_TOKEN"
tar -xzf "$TMP/src.tgz" -C "$TMP"
SRC="$(find "$TMP" -maxdepth 4 -type d -path '*/apps/server' | head -1)"
[ -n "$SRC" ] || die "tarball layout unexpected: apps/server not found"

# --- 3. Install (preserve config/: DB, holders, bashrc) ----------------------
if [ -x "$APP_DIR/cli.ts" ]; then
  say "stopping existing server for upgrade (sessions survive in their holders)"
  bun "$APP_DIR/cli.ts" stop >/dev/null 2>&1 || true
fi
mkdir -p "$APP_DIR"
if [ -d "$APP_DIR/config" ]; then
  mv "$APP_DIR/config" "$TMP/config.keep"
fi
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR"
cp -R "$SRC/." "$APP_DIR/"
if [ -d "$TMP/config.keep" ]; then
  rm -rf "$APP_DIR/config"
  mv "$TMP/config.keep" "$APP_DIR/config"
fi
chmod +x "$APP_DIR/cli.ts"

say "installing dependencies"
(cd "$APP_DIR" && bun install --production)

# --- 4. CLI on PATH -----------------------------------------------------------
mkdir -p "$BIN_DIR"
ln -sf "$APP_DIR/cli.ts" "$BIN_DIR/tether"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) say "NOTE: add $BIN_DIR to your PATH to use 'tether' directly" ;;
esac

# --- 5. Start ------------------------------------------------------------------
say "starting server"
"$BIN_DIR/tether" start
"$BIN_DIR/tether" status
say "done — server data lives in $APP_DIR/config, logs in ~/.tether/server.log"
say "SECURITY: the server is unauthenticated on 0.0.0.0 — keep it LAN/VPN-only"
