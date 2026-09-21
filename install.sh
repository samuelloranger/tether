#!/bin/sh
# Tether host CLI installer. Builds `tether-notify` (v5 encrypted push) from the
# repo checkout and installs it to ~/.local/bin. Run from a clone:
#   bash install.sh
# Requires Go — the host tool is tiny and builds from source, so there is no
# release binary to download and no checksum to verify.
set -eu

ROOT="$(cd "$(dirname "$0")" && pwd)"
SRC="${ROOT}/apps/tether-notify"
BIN_DIR="${HOME}/.local/bin"
DEST="${BIN_DIR}/tether-notify"

[ -f "${SRC}/go.mod" ] || {
  echo "Run this from a tether checkout — ${SRC} not found." >&2
  exit 1
}
command -v go >/dev/null 2>&1 || {
  echo "Go is required (the host tool builds from source). Install Go, then re-run." >&2
  exit 1
}

mkdir -p "$BIN_DIR"
echo "Building tether-notify…"
( cd "$SRC" && go build -trimpath -o "$DEST" . )
echo "Installed to $DEST"

# If ~/.local/bin isn't on PATH, print the next commands with the full path so
# the flow works without a PATH edit first.
case ":${PATH}:" in
  *":${BIN_DIR}:"*) cmd="tether-notify" ;;
  *)
    echo "Add to PATH:  export PATH=\"${BIN_DIR}:\$PATH\""
    cmd="$DEST"
    ;;
esac

echo
echo "Next:"
echo "  # your phone registers itself over SSH the next time the app connects."
echo "  $cmd list                                  # registered phones"
echo "  bash ${ROOT}/scripts/install-agent-hooks.sh  # notify from agent hooks"
