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
curl -fsSL "$url" -o "$DEST"
chmod +x "$DEST"

echo "Installed to $DEST"
case ":${PATH}:" in
  *":${BIN_DIR}:"*) ;;
  *) echo "Add to PATH:  export PATH=\"${BIN_DIR}:\$PATH\"" ;;
esac
if [ -d "${HOME}/.tether/app" ]; then
  echo "Note: old ~/.tether/app detected. Your database migrates automatically on first run; you can delete ~/.tether/app afterward."
fi
echo "Next: tether set-password && tether start"
echo "SECURITY: a password gates access, but traffic is unencrypted — run tether behind a tunnel (Tailscale / WireGuard / SSH)."
