#!/bin/sh
# Exercises install.sh against a temp bin dir: no binary, our binary, a legacy v4 binary.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail=0
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: got [$2] want [$3]"; fail=1; fi; }

export GOCACHE="${GOCACHE:-$(go env GOCACHE)}" GOMODCACHE="${GOMODCACHE:-$(go env GOMODCACHE)}"
export TETHER_INSTALL_SOURCE_ONLY=1
export TETHER_BIN_DIR="$TMP/bin"
mkdir -p "$TETHER_BIN_DIR"
# shellcheck disable=SC1091
. "$ROOT/install.sh"
ROOT="$(cd "$(dirname "$0")/.." && pwd)" # install.sh derived its own from $0

fake_v4() { printf '#!/bin/sh\necho "tether — persistent remote-shell server (v4.9)"\n' > "$1"; chmod +x "$1"; }
fake_ours() { printf '#!/bin/sh\necho '"'"'{"name":"tether","version":"x","protocol":1}'"'"'\n' > "$1"; chmod +x "$1"; }

# no binary
out="$(retire_foreign "$DEST")"
check "no binary: no notice" "$out" ""

# ours
fake_ours "$DEST"
out="$(retire_foreign "$DEST")"
check "ours: no notice" "$out" ""
check "ours: left in place" "$(test -x "$DEST" && echo yes)" "yes"
check "ours: no .v4" "$(test -e "$DEST.v4" && echo yes || echo no)" "no"

# legacy v4
fake_v4 "$DEST"
out="$(retire_foreign "$DEST")"
check "legacy: moved aside" "$(test -e "$DEST.v4" && echo yes)" "yes"
check "legacy: target freed" "$(test -e "$DEST" && echo yes || echo no)" "no"
case "$out" in *"old Tether v4 server"*"$DEST.v4"*"no longer ships"*) r=ok ;; *) r=bad ;; esac
check "legacy: notice" "$r" "ok"

# legacy again with .v4 taken
fake_v4 "$DEST"
retire_foreign "$DEST" >/dev/null
check "legacy twice: timestamped" "$(ls "$TETHER_BIN_DIR" | grep -c '^tether\.v4\.[0-9]*$')" "1"

# a binary that hangs or fails is foreign too
printf '#!/bin/sh\nexit 1\n' > "$DEST"; chmod +x "$DEST"
retire_foreign "$DEST" >/dev/null
check "failing binary: moved" "$(test -e "$DEST" && echo yes || echo no)" "no"

# legacy names notice keeps the files
: > "$TETHER_BIN_DIR/tether-notify"; : > "$TETHER_BIN_DIR/tether-notify-hook"
out="$(note_legacy_names)"
case "$out" in *"tether-notify tether-notify-hook"*"can be removed"*"install-agent-hooks.sh"*) r=ok ;; *) r=bad ;; esac
check "legacy names: notice" "$r" "ok"
check "legacy names: kept" "$(test -e "$TETHER_BIN_DIR/tether-notify" && echo yes)" "yes"

# full run: builds, sets the version, replaces a legacy binary
rm -f "$DEST" "$DEST".v4*
fake_v4 "$DEST"
( unset TETHER_INSTALL_SOURCE_ONLY; sh "$ROOT/install.sh" >"$TMP/run.log" 2>&1 ) || { cat "$TMP/run.log"; fail=1; }
check "full run: real binary is ours" "$("$DEST" version --json | grep -c '"name":"tether"')" "1"
check "full run: first line" "$("$DEST" version | sed -n 1p | cut -d' ' -f1)" "tether"
check "full run: legacy kept" "$(test -e "$DEST.v4" && echo yes)" "yes"

exit "$fail"
