#!/usr/bin/env bash
# Start or stop a throwaway tether server for manual/E2E testing.
#
# Scratch servers used to be started by hand as
#   TETHER_DB_PATH=/tmp/... TETHER_PORT=80xx bun apps/server/src/server/main.ts serve &
# and then never stopped. Three of them were found holding ports 8097-8099 hours
# after the work that spawned them finished, each still owning PTY holders. The
# cost is not the memory: a stale server *answering* on the port a test expects
# is far more confusing than nothing answering, because the test passes or fails
# against the wrong database.
#
#   scripts/scratch-server.sh start <name> [port] [cwd]
#   scripts/scratch-server.sh stop  <name>
#   scripts/scratch-server.sh list
#
# State lives in /tmp/tether-scratch/<name>/ — pid, log and db together, so
# `stop` kills exactly the process it started and nothing else. Never reach for
# `pkill -f bun`: it has killed the production daemon and the calling agent's own
# session before now.
#
# Names are [A-Za-z0-9_-]+ only (no dots, no path separators). A free-form name
# would be interpolated into $BASE/$name and could escape the scratch sandbox.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE=/tmp/tether-scratch

usage() { sed -n '4,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2; exit 2; }

# Reject anything that could be a path component escape or look like a hidden
# entry. Empty names hit "${2:?...}" before we get here on start/stop.
validate_name() {
  local name="$1"
  if [[ -z "$name" ]]; then
    echo "invalid name: empty (allowed: letters, digits, dash, underscore)" >&2
    exit 1
  fi
  # Separators before the leading-dot check so `../evil` is reported as a path
  # escape, not as a hidden name.
  if [[ "$name" == */* || "$name" == *\\* ]]; then
    echo "invalid name: path separators not allowed (allowed: letters, digits, dash, underscore)" >&2
    exit 1
  fi
  if [[ "$name" == .* ]]; then
    echo "invalid name: must not start with '.' (allowed: letters, digits, dash, underscore)" >&2
    exit 1
  fi
  if [[ ! "$name" =~ ^[A-Za-z0-9_-]+$ ]]; then
    echo "invalid name: '$name' (allowed: letters, digits, dash, underscore)" >&2
    exit 1
  fi
}

db_marker() {
  echo "TETHER_DB_PATH=$1/tether.db"
}

# True iff $1 is a live process whose cmdline/environ ties it to this scratch
# dir (the TETHER_DB_PATH we passed at launch). A recycled pid of an unrelated
# process must never look "running" or get killed.
is_scratch_server_pid() {
  local pid="$1"
  local dir="$2"
  local marker
  marker="$(db_marker "$dir")"
  local blob=""

  if [[ ! "$pid" =~ ^[0-9]+$ ]]; then
    return 1
  fi
  if ! kill -0 "$pid" 2>/dev/null; then
    return 1
  fi

  if [[ -r "/proc/$pid/cmdline" ]]; then
    # Linux: cmdline + environ both readable for our own processes. Environ is
    # the stronger signal — argv alone could theoretically collide.
    blob="$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null || true)"
    blob+=" $(tr '\0' ' ' <"/proc/$pid/environ" 2>/dev/null || true)"
  else
    # macOS: no /proc, and ps does not expose another process's environment, so
    # the check is weaker — we only see argv. Still better than killing blind.
    # start writes the marker into argv (via $dir/run) so it remains visible here.
    blob="$(ps -o command= -p "$pid" 2>/dev/null || true)"
  fi

  [[ "$blob" == *"$marker"* ]]
}

cmd="${1:-}"
case "$cmd" in
  start)
    name="${2:?name required}"
    validate_name "$name"
    port="${3:-8100}"
    cwd="${4:-$PWD}"
    dir="$BASE/$name"
    mkdir -p "$dir"
    if [[ -f "$dir/pid" ]]; then
      old_pid="$(cat "$dir/pid")"
      if is_scratch_server_pid "$old_pid" "$dir"; then
        echo "already running: $name (pid $old_pid)" >&2
        exit 1
      fi
      # Stale or recycled pid left behind — do not treat as live.
      rm -f "$dir/pid"
    fi
    # Launcher under $dir: exec -a puts the TETHER_DB_PATH marker in argv0 so
    # macOS ps can see it (environ is not readable there). Same pid survives exec.
    marker="$(db_marker "$dir")"
    cat >"$dir/run" <<EOF
#!/usr/bin/env bash
exec -a "$marker" bun "$ROOT/apps/server/src/server/main.ts" serve
EOF
    chmod +x "$dir/run"
    # `cd` on its own line, NOT joined with && to the backgrounded command:
    # `cd X && cmd &` backgrounds the whole list, so $! is a subshell's pid and
    # `stop` would kill the wrapper while the server carried on serving. Found
    # by this script's own self-test — the port kept answering after stop.
    (
      cd "$cwd" || exit 1
      TETHER_PORT="$port" TETHER_TLS=off \
        TETHER_DB_PATH="$dir/tether.db" \
        TETHER_PRESENT_CONTROL_TOKEN_FILE="$dir/present-token" \
        nohup "$dir/run" >"$dir/log" 2>&1 &
      echo $! >"$dir/pid"
    )
    sleep 2
    pid="$(cat "$dir/pid")"
    if ! is_scratch_server_pid "$pid" "$dir"; then
      echo "failed to start — see $dir/log" >&2
      tail -5 "$dir/log" >&2
      exit 1
    fi
    echo "$name on :$port (pid $pid, cwd $cwd)"
    echo "  db  $dir/tether.db"
    echo "  log $dir/log"
    ;;
  stop)
    name="${2:?name required}"
    validate_name "$name"
    dir="$BASE/$name"
    [[ -f "$dir/pid" ]] || { echo "no such scratch server: $name" >&2; exit 1; }
    pid="$(cat "$dir/pid")"
    if ! is_scratch_server_pid "$pid" "$dir"; then
      # Pid file is stale or points at something we did not start — never kill it.
      rm -f "$dir/pid"
      if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
        echo "refusing to kill pid $pid: not a scratch server for $dir (stale pid file removed)" >&2
      else
        echo "stale pid file for $name (pid $pid no longer a live scratch server); cleaned up" >&2
      fi
      exit 1
    fi
    # By pid, never by pattern — and only after is_scratch_server_pid confirmed
    # the process is ours for this directory.
    kill "$pid" 2>/dev/null || true
    rm -f "$dir/pid"
    echo "stopped $name (pid $pid)"
    ;;
  list)
    shopt -s nullglob
    for dir in "$BASE"/*/; do
      name="$(basename "$dir")"
      # Skip leftovers that would not pass validate_name (pre-hardening dirs).
      if [[ ! "$name" =~ ^[A-Za-z0-9_-]+$ ]]; then
        continue
      fi
      dir="${dir%/}"
      if [[ -f "$dir/pid" ]]; then
        pid="$(cat "$dir/pid")"
        if is_scratch_server_pid "$pid" "$dir"; then
          echo "running  $name  pid $pid"
          continue
        fi
      fi
      echo "stopped  $name"
    done
    ;;
  *) usage ;;
esac
