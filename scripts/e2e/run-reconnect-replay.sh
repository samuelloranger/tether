#!/usr/bin/env bash
# Test #1 orchestration: does output produced while the app is backgrounded reach
# the client after reopen? Compares the client's rendered grid (dumped by the
# test) against the server's terminal_logs. The Noise path does no replay, so the
# expected finding is that the server has GAP_AFTER but the client grid does not.
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

rm -rf "$E2E_DIR"
mkdir -p "$E2E_DIR"
bun scripts/build-ffi.ts >/dev/null

SERVER_PID=""
cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  pkill -f "$E2E_DIR" 2>/dev/null || true
}
trap cleanup EXIT

TETHER_DB_PATH="$DB" TETHER_PORT="$PORT" TETHER_TLS=off TETHER_TEST_LOG="$EVT" \
  bun apps/server/src/server/main.ts serve >"$E2E_DIR/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 40); do
  curl -sf "http://127.0.0.1:$PORT/api/status" >/dev/null 2>&1 && break
  sleep 0.5
done

FIXTURE="$(TETHER_DB_PATH="$DB" FIX_PORT="$PORT" FIX_SCHEME=ws bun scripts/e2e/preseed-fixture.ts)"
/usr/bin/ruby scripts/add_uitest_target.rb clients/apple/Tether.xcodeproj >/dev/null
xcrun simctl terminate "$SIM_ID" "$BID" 2>/dev/null || true
xcrun simctl uninstall "$SIM_ID" "$BID" 2>/dev/null || true

: >"$EVT"
TEST_RUNNER_TETHER_UITEST_PRESEED="$FIXTURE" \
  xcodebuild test \
  -project clients/apple/Tether.xcodeproj -scheme TetherIOS \
  -destination "platform=iOS Simulator,id=$SIM_ID" \
  -only-testing:TetherIOSUITests/ReconnectReplayTests \
  CODE_SIGN_IDENTITY="-" CODE_SIGNING_REQUIRED=NO \
  CODE_SIGNING_ALLOWED=YES AD_HOC_CODE_SIGNING_ALLOWED=YES \
  >"$XLOG" 2>&1 || true

SERVER_GAP="$(TETHER_DB_PATH="$DB" bun scripts/e2e/count-log-marker.ts GAP_AFTER 2>/dev/null || echo 0)"
SERVER_CTRL="$(TETHER_DB_PATH="$DB" bun scripts/e2e/count-log-marker.ts VISIBLE_BEFORE 2>/dev/null || echo 0)"
GRID="$(awk '/GRID_DUMP_START/{f=1;next} /GRID_DUMP_END/{f=0} f' "$XLOG" 2>/dev/null || true)"
CLIENT_CTRL=0; echo "$GRID" | grep -q "VISIBLE_BEFORE" && CLIENT_CTRL=1
CLIENT_GAP=0; echo "$GRID" | grep -q "GAP_AFTER" && CLIENT_GAP=1

echo "=== client grid dump ==="
echo "$GRID"
echo "=== markers ==="
echo "server terminal_logs: VISIBLE_BEFORE=$SERVER_CTRL  GAP_AFTER=$SERVER_GAP"
echo "client grid:          VISIBLE_BEFORE=$CLIENT_CTRL   GAP_AFTER=$CLIENT_GAP"
echo "=== verdict ==="
if [ "$SERVER_GAP" -eq 0 ] || [ "$CLIENT_CTRL" -eq 0 ]; then
  echo "FAIL: setup did not hold (server GAP_AFTER=$SERVER_GAP, client control=$CLIENT_CTRL)"
  echo "--- xcodebuild tail ---"
  tail -30 "$XLOG"
  exit 1
fi
echo "PASS: setup valid — server produced GAP_AFTER while backgrounded, client control line present"
if [ "$CLIENT_GAP" -eq 1 ]; then
  echo "FINDING: client DID render output produced while backgrounded (no replay gap here)"
else
  echo "FINDING: client did NOT render GAP_AFTER — output produced while backgrounded was LOST to the client (replay gap confirmed)"
fi
