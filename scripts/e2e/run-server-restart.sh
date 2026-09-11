#!/usr/bin/env bash
# Test #14 orchestration: restart the daemon under a live session. A background
# watcher waits for the trigger file the session touches on the host, then kills
# and relaunches the server — so the restart lands at an exact point in the test,
# no wall-clock guessing. Oracle: the post-restart marker reached both the server
# (holder survived) and the client grid (it reconnected and replayed).
set -euo pipefail
export PATH="$HOME/.bun/bin:$HOME/.cargo/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

SIM_ID="${SIM_ID:-301860DB-8242-4536-8648-C7FF262F8C34}"
PORT="${PORT:-8199}"
BID=com.samuelloranger.tether-mobile
E2E_DIR="$HOME/.tether-e2e"
DB="$E2E_DIR/tether.db"
EVT="$E2E_DIR/events.log"
XLOG="$E2E_DIR/xcodebuild.log"
TRIGGER="$E2E_DIR/RESTART_NOW"

rm -rf "$E2E_DIR"
mkdir -p "$E2E_DIR"
bun scripts/build-ffi.ts >/dev/null

start_server() {
  TETHER_DB_PATH="$DB" TETHER_PORT="$PORT" TETHER_TLS=off TETHER_TEST_LOG="$EVT" \
    bun apps/server/src/main.ts serve >>"$E2E_DIR/server.log" 2>&1 &
  echo $! >"$E2E_DIR/server.pid"
}

cleanup() {
  [ -f "$E2E_DIR/server.pid" ] && kill "$(cat "$E2E_DIR/server.pid")" 2>/dev/null || true
  [ -f "$E2E_DIR/watcher.pid" ] && kill "$(cat "$E2E_DIR/watcher.pid")" 2>/dev/null || true
  pkill -f "$E2E_DIR" 2>/dev/null || true
}
trap cleanup EXIT

start_server
ready=0
for _ in $(seq 1 40); do
  curl -sf "http://127.0.0.1:$PORT/api/status" >/dev/null 2>&1 && { ready=1; break; }
  sleep 0.5
done
[ "$ready" -eq 1 ] || { echo "FAIL: server never became ready on :$PORT"; tail -20 "$E2E_DIR/server.log" 2>/dev/null; exit 1; }

# Background watcher: on the trigger, restart the daemon once.
(
  while [ ! -f "$TRIGGER" ]; do sleep 0.3; done
  sleep 1
  echo "[watcher] restarting daemon" >>"$E2E_DIR/server.log"
  kill "$(cat "$E2E_DIR/server.pid")" 2>/dev/null || true
  sleep 2
  start_server
) &
echo $! >"$E2E_DIR/watcher.pid"

FIXTURE="$(TETHER_DB_PATH="$DB" FIX_PORT="$PORT" FIX_SCHEME=ws bun scripts/e2e/preseed-fixture.ts)"
/usr/bin/ruby scripts/add_uitest_target.rb clients/apple/Tether.xcodeproj >/dev/null
xcrun simctl terminate "$SIM_ID" "$BID" 2>/dev/null || true
xcrun simctl uninstall "$SIM_ID" "$BID" 2>/dev/null || true

: >"$EVT"
TEST_RUNNER_TETHER_UITEST_PRESEED="$FIXTURE" \
  xcodebuild test \
  -project clients/apple/Tether.xcodeproj -scheme TetherIOS \
  -destination "platform=iOS Simulator,id=$SIM_ID" \
  -only-testing:TetherIOSUITests/ServerRestartTests \
  CODE_SIGN_IDENTITY="-" CODE_SIGNING_REQUIRED=NO \
  CODE_SIGNING_ALLOWED=YES AD_HOC_CODE_SIGNING_ALLOWED=YES \
  >"$XLOG" 2>&1 || true

GRID="$(awk '/GRID_DUMP_START/{f=1;next} /GRID_DUMP_END/{f=0} f' "$XLOG" 2>/dev/null || true)"
SRV_AFTER="$(TETHER_DB_PATH="$DB" bun scripts/e2e/count-log-marker.ts AFTER_RESTART_MARK 2>/dev/null || echo 0)"
CG_AFTER=0; echo "$GRID" | grep -q "AFTER_RESTART_MARK" && CG_AFTER=1
AUTHS="$(grep -c '"ev":"noise_auth","ok":true' "$EVT" 2>/dev/null || true)"
RESTARTED=0; grep -q "\[watcher\] restarting daemon" "$E2E_DIR/server.log" 2>/dev/null && RESTARTED=1

echo "=== ServerRestartTests ==="
echo "--- client grid dump ---"; echo "$GRID"; echo "--- end grid ---"
echo "watcher restarted daemon: $RESTARTED   noise_auth(ok) count: $AUTHS"
echo "server AFTER_RESTART_MARK=$SRV_AFTER   client grid AFTER_RESTART_MARK=$CG_AFTER"
echo "=== verdict ==="
if [ "$RESTARTED" -ne 1 ]; then
  echo "FAIL: the daemon was never restarted (trigger not seen) — setup invalid"; tail -30 "$XLOG"; exit 1
fi
if [ "$SRV_AFTER" -eq 0 ]; then
  echo "FAIL: AFTER_RESTART_MARK never logged — the holder did not survive the restart"; tail -30 "$XLOG"; exit 1
fi
if [ "$CG_AFTER" -ne 1 ]; then
  echo "FAIL: client never rendered AFTER_RESTART_MARK — it did not reconnect/replay after the restart"; tail -30 "$XLOG"; exit 1
fi
echo "PASS: session survived a daemon restart — holder reattached and the client reconnected + replayed (noise_auth×$AUTHS)"
