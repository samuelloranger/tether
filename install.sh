#!/bin/sh
# Tether server installer. Detects OS/arch, downloads the matching binary from
# the latest GitHub release, installs to ~/.local/bin/tether. No bun/git needed.
#   curl -fsSL https://raw.githubusercontent.com/samuelloranger/tether/main/install.sh | sh
# Env: TETHER_VERSION=vX.Y.Z pins a version; DRY_RUN=1 prints the plan only.
set -eu

REPO="${TETHER_REPO_SLUG:-samuelloranger/tether}"
BIN_DIR="${HOME}/.local/bin"
DEST="${BIN_DIR}/tether"

os="$(uname -s)"
case "$os" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) echo "Unsupported OS: $os" >&2; exit 1 ;;
esac

arch="$(uname -m)"
case "$arch" in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) echo "Unsupported arch: $arch" >&2; exit 1 ;;
esac

asset="tether-${os}-${arch}"

if [ -n "${TETHER_VERSION:-}" ]; then
  tag="$TETHER_VERSION"
else
  tag="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
    | grep '"tag_name"' | head -1 | cut -d '"' -f 4)"
fi
[ -n "$tag" ] || { echo "Could not resolve latest release tag" >&2; exit 1; }

url="https://github.com/${REPO}/releases/download/${tag}/${asset}"

if [ "${DRY_RUN:-0}" = "1" ]; then
  echo "would download: $url"
  echo "would install to: $DEST"
  exit 0
fi

echo "Installing tether ${tag} (${asset})…"
mkdir -p "$BIN_DIR"
# Download to a temp file then move over $DEST. If $DEST is the old installer's
# symlink (-> ~/.tether/app/cli.ts), `curl -o` would follow it and write into the
# old tree; `mv -f` replaces the symlink itself with the real binary.
tmp="$(mktemp "${BIN_DIR}/.tether.XXXXXX")"
curl -fsSL "$url" -o "$tmp"
chmod +x "$tmp"
mv -f "$tmp" "$DEST"

echo "Installed to $DEST"

# Upgrading from the old source-copy installer? Stop its daemon so (a) the new
# binary can take over on `tether start`, and (b) the DB migration on first run
# copies a quiesced database, not one a live writer still holds in WAL. Killed by
# pid here in plain shell — invoking the binary would trigger the migration while
# the old daemon is still running.
PID_FILE="${HOME}/.tether/server.pid"
if [ -f "$PID_FILE" ]; then
  oldpid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "${oldpid:-}" ] && kill -0 "$oldpid" 2>/dev/null; then
    echo "Stopping previous tether daemon (pid $oldpid)…"
    kill "$oldpid" 2>/dev/null || true
    # SIGTERM returns immediately; wait for the process to actually exit so it has
    # released the SQLite DB before the first-run migration copies it (else the
    # copy can be torn / lose the password or sessions). Escalate after ~5s.
    i=0
    while kill -0 "$oldpid" 2>/dev/null; do
      i=$((i + 1))
      if [ "$i" -ge 50 ]; then
        kill -9 "$oldpid" 2>/dev/null || true
        break
      fi
      sleep 0.1
    done
    rm -f "$PID_FILE"
  fi
fi

# If ~/.local/bin isn't on PATH, `tether ...` won't resolve in the current shell,
# so print the next-step commands with the full path (and the export hint) — the
# advertised first-run flow must work without a PATH edit.
case ":${PATH}:" in
  *":${BIN_DIR}:"*) cmd="tether" ;;
  *)
    echo "Add to PATH:  export PATH=\"${BIN_DIR}:\$PATH\""
    cmd="$DEST"
    ;;
esac
if [ -d "${HOME}/.tether/app" ]; then
  echo "Note: old ~/.tether/app detected. Your database (password + sessions) migrates automatically on first run; delete ~/.tether/app afterward. Live PTY sessions from the old server won't reattach across the upgrade."
fi
echo "Next: $cmd set-password && $cmd start"
echo "SECURITY: a password gates access, but traffic is unencrypted — run tether behind a tunnel (Tailscale / WireGuard / SSH)."
