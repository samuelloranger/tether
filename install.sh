#!/bin/sh
# Builds `tether` from this checkout into ~/.local/bin (or $TETHER_BIN_DIR). Requires Go:
# there is no release binary, so nothing to download or checksum.
set -eu

ROOT="$(cd "$(dirname "$0")" && pwd)"
SRC="${ROOT}/apps/tether"
BIN_DIR="${TETHER_BIN_DIR:-${HOME}/.local/bin}"
DEST="${BIN_DIR}/tether"

# Prints the binary's `version --json` output, empty when it does not answer in time.
probe_version_json() {
  if command -v timeout >/dev/null 2>&1; then
    timeout 5 "$1" version --json </dev/null 2>/dev/null || true
  else
    "$1" version --json </dev/null 2>/dev/null || true
  fi
}

is_ours() {
  out="$(probe_version_json "$1")"
  case "$out" in
    "{"*) printf '%s' "$out" | grep -Eq '"name"[[:space:]]*:[[:space:]]*"tether"' ;;
    *) return 1 ;;
  esac
}

# A file already at $1 that is not this tool is the retired v4 server: move it aside.
retire_foreign() {
  target="$1"
  [ -e "$target" ] || return 0
  if is_ours "$target"; then
    return 0
  fi
  aside="${target}.v4"
  [ -e "$aside" ] && aside="${target}.v4.$(date +%s)"
  mv "$target" "$aside"
  echo
  echo "Notice: ${target} was not this tool. It looks like the old Tether v4 server."
  echo "  Moved it to ${aside}."
  echo "  The v4 server no longer ships; v5 apps talk to the host over SSH and zmx."
}

note_legacy_names() {
  legacy=""
  [ -e "${BIN_DIR}/tether-notify" ] && legacy="${legacy} tether-notify"
  [ -e "${BIN_DIR}/tether-notify-hook" ] && legacy="${legacy} tether-notify-hook"
  [ -n "$legacy" ] || return 0
  echo
  echo "Notice: found${legacy} in ${BIN_DIR}. They are replaced by tether / tether-hook and can be removed."
  echo "  Agent hooks must be re-wired: bash ${ROOT}/scripts/install-agent-hooks.sh"
}

build_version() {
  v="$(cd "$ROOT" && git describe --tags --always --dirty 2>/dev/null || true)"
  echo "${v:-dev}"
}

main() {
  [ -f "${SRC}/go.mod" ] || {
    echo "Run this from a tether checkout — ${SRC} not found." >&2
    exit 1
  }
  command -v go >/dev/null 2>&1 || {
    echo "Go is required (the host tool builds from source). Install Go, then re-run." >&2
    exit 1
  }

  mkdir -p "$BIN_DIR"
  retire_foreign "$DEST"
  VERSION="$(build_version)"
  echo "Building tether ${VERSION}…"
  ( cd "$SRC" && go build -trimpath -ldflags "-X main.version=${VERSION}" -o "${DEST}.new" . )
  mv -f "${DEST}.new" "$DEST"
  echo "Installed to $DEST"
  note_legacy_names

  # If the bin dir isn't on PATH, print the next commands with the full path so
  # the flow works without a PATH edit first.
  case ":${PATH}:" in
    *":${BIN_DIR}:"*) cmd="tether" ;;
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
}

[ -n "${TETHER_INSTALL_SOURCE_ONLY:-}" ] || main "$@"
