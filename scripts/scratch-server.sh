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
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE=/tmp/tether-scratch

usage() { sed -n '4,18p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2; exit 2; }

cmd="${1:-}"
case "$cmd" in
  start)
    name="${2:?name required}"
    port="${3:-8100}"
    cwd="${4:-$PWD}"
    dir="$BASE/$name"
    mkdir -p "$dir"
    if [[ -f "$dir/pid" ]] && kill -0 "$(cat "$dir/pid")" 2>/dev/null; then
      echo "already running: $name (pid $(cat "$dir/pid"))" >&2
      exit 1
    fi
    # `cd` on its own line, NOT joined with && to the backgrounded command:
    # `cd X && cmd &` backgrounds the whole list, so $! is a subshell's pid and
    # `stop` would kill the wrapper while the server carried on serving. Found
    # by this script's own self-test — the port kept answering after stop.
    (
      cd "$cwd" || exit 1
      TETHER_PORT="$port" TETHER_TLS=off \
        TETHER_DB_PATH="$dir/tether.db" \
        TETHER_PRESENT_CONTROL_TOKEN_FILE="$dir/present-token" \
        nohup bun "$ROOT/apps/server/src/server/main.ts" serve >"$dir/log" 2>&1 &
      echo $! >"$dir/pid"
    )
    sleep 2
    if ! kill -0 "$(cat "$dir/pid")" 2>/dev/null; then
      echo "failed to start — see $dir/log" >&2
      tail -5 "$dir/log" >&2
      exit 1
    fi
    echo "$name on :$port (pid $(cat "$dir/pid"), cwd $cwd)"
    echo "  db  $dir/tether.db"
    echo "  log $dir/log"
    ;;
  stop)
    name="${2:?name required}"
    dir="$BASE/$name"
    [[ -f "$dir/pid" ]] || { echo "no such scratch server: $name" >&2; exit 1; }
    pid="$(cat "$dir/pid")"
    # By pid, never by pattern.
    kill "$pid" 2>/dev/null || true
    rm -f "$dir/pid"
    echo "stopped $name (pid $pid)"
    ;;
  list)
    shopt -s nullglob
    for dir in "$BASE"/*/; do
      name="$(basename "$dir")"
      if [[ -f "$dir/pid" ]] && kill -0 "$(cat "$dir/pid")" 2>/dev/null; then
        echo "running  $name  pid $(cat "$dir/pid")"
      else
        echo "stopped  $name"
      fi
    done
    ;;
  *) usage ;;
esac
