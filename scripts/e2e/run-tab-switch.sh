#!/usr/bin/env bash
# Test #5 orchestration: switching back to a resident session must REUSE its live
# socket (no reconnect, no replay) and re-focus it — the client repaints from the
# retained grid. Drives TabSwitchTests and asserts the resident path: the suite
# passed, no switch-back reconnect (no noise_start wasLive:true), and the
# switched-back tab was re-focused (noise_focus focused:true).
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
  bun apps/server/src/main.ts serve >"$E2E_DIR/server.log" 2>&1 &
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
  -only-testing:TetherIOSUITests/TabSwitchTests \
  CODE_SIGN_IDENTITY="-" CODE_SIGNING_REQUIRED=NO \
  CODE_SIGNING_ALLOWED=YES AD_HOC_CODE_SIGNING_ALLOWED=YES \
  >"$E2E_DIR/xcodebuild.log" 2>&1 || true

# grep -c prints "0" AND exits 1 on zero matches, so `|| echo 0` would append a
# SECOND "0" and break the numeric guards. `|| true` keeps the single count.
XC_PASS=0; grep -q "Test Suite 'TabSwitchTests' passed" "$E2E_DIR/xcodebuild.log" 2>/dev/null && XC_PASS=1
WASLIVE="$(grep -c '"wasLive":true' "$EVT" 2>/dev/null || true)"
FOCUS_BACK="$(grep -cE '"ev":"noise_focus".*"focused":true' "$EVT" 2>/dev/null || true)"
STARTS="$(grep -c '"ev":"noise_start"' "$EVT" 2>/dev/null || true)"

echo "=== oracle events (tail) ==="
tail -20 "$EVT" 2>/dev/null || true
echo "=== counts ==="
echo "noise_start total: $STARTS   switch-back reconnect (wasLive:true): $WASLIVE   re-focus (focused:true): $FOCUS_BACK"
echo "xcodebuild suite passed: $XC_PASS"
echo "=== verdict ==="
# Resident model: both sessions stay live, so switch-back reuses the socket —
# it must NOT reconnect (wasLive:true stays 0) and must re-focus the tab. The
# repaint itself is client-side and is what the passing sim suite verifies.
if [ "$XC_PASS" -ne 1 ]; then
  echo "FAIL: the sim suite did not pass — incidental events do not count"
  echo "--- xcodebuild tail ---"; tail -30 "$E2E_DIR/xcodebuild.log"; exit 1
fi
if [ "$WASLIVE" -ne 0 ]; then
  echo "FAIL: switch-back reconnected a resident session (noise_start wasLive:true=$WASLIVE); socket was not reused"
  echo "--- xcodebuild tail ---"; tail -30 "$E2E_DIR/xcodebuild.log"; exit 1
fi
if [ "$FOCUS_BACK" -lt 1 ]; then
  echo "FAIL: switch-back never re-focused a live session (no noise_focus focused:true)"
  echo "--- xcodebuild tail ---"; tail -30 "$E2E_DIR/xcodebuild.log"; exit 1
fi
echo "PASS: switch-back reused the live socket (no reconnect) and re-focused the tab"
