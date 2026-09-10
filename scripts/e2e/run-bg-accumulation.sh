#!/usr/bin/env bash
# Test #9 orchestration: an agent writing to a tabbed-away session for ~30s must
# render its current screen on switch-back. Drives BackgroundAccumulationRenderTests
# and asserts, against the server oracle, that both agents' sentinels landed in
# terminal_logs and that switching back replayed the missed tail (reset or bytes).
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
# The generator the typed command runs lives on the server host (the PTY runs
# here, not on the sim). The test invokes it as ~/.tether-e2e/agent-generator.sh.
cp scripts/e2e/agent-generator.sh "$E2E_DIR/agent-generator.sh"
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
ready=0
for _ in $(seq 1 40); do
  curl -sf "http://127.0.0.1:$PORT/api/status" >/dev/null 2>&1 && { ready=1; break; }
  sleep 0.5
done
[ "$ready" -eq 1 ] || { echo "FAIL: server never became ready on :$PORT"; tail -20 "$E2E_DIR/server.log" 2>/dev/null; exit 1; }

FIXTURE="$(TETHER_DB_PATH="$DB" FIX_PORT="$PORT" FIX_SCHEME=ws bun scripts/e2e/preseed-fixture.ts)"
/usr/bin/ruby scripts/add_uitest_target.rb clients/apple/Tether.xcodeproj >/dev/null
xcrun simctl terminate "$SIM_ID" "$BID" 2>/dev/null || true
xcrun simctl uninstall "$SIM_ID" "$BID" 2>/dev/null || true

: >"$EVT"
TEST_RUNNER_TETHER_UITEST_PRESEED="$FIXTURE" \
  xcodebuild test \
  -project clients/apple/Tether.xcodeproj -scheme TetherIOS \
  -destination "platform=iOS Simulator,id=$SIM_ID" \
  -only-testing:TetherIOSUITests/BackgroundAccumulationRenderTests \
  CODE_SIGN_IDENTITY="-" CODE_SIGNING_REQUIRED=NO \
  CODE_SIGNING_ALLOWED=YES AD_HOC_CODE_SIGNING_ALLOWED=YES \
  >"$E2E_DIR/xcodebuild.log" 2>&1 || true

# grep -c prints "0" AND exits 1 on zero matches, so `|| echo 0` would append a
# SECOND "0" and break the numeric guards. `|| true` keeps the single count.
XC_PASS=0; grep -q "Test Suite 'BackgroundAccumulationRenderTests' passed" "$E2E_DIR/xcodebuild.log" 2>/dev/null && XC_PASS=1
SENT_A="$(TETHER_DB_PATH="$DB" bun scripts/e2e/count-log-marker.ts AGENT_A_DONE_SENTINEL 2>/dev/null || echo 0)"
SENT_B="$(TETHER_DB_PATH="$DB" bun scripts/e2e/count-log-marker.ts AGENT_B_DONE_SENTINEL 2>/dev/null || echo 0)"
WASLIVE_BACK="$(grep -c '"wasLive":true' "$EVT" 2>/dev/null || true)"
FOCUS_BACK="$(grep -cE '"ev":"noise_focus".*"focused":true' "$EVT" 2>/dev/null || true)"

echo "=== oracle events (replay + noise_start + noise_focus) ==="
grep -E '"ev":"replay"|"ev":"noise_start"|"ev":"noise_focus"' "$EVT" 2>/dev/null | tail -20 || true
echo "=== counts ==="
echo "AGENT_A sentinel chunks: $SENT_A   AGENT_B sentinel chunks: $SENT_B"
echo "switch-back reconnect (wasLive:true): $WASLIVE_BACK   re-focus (focused:true): $FOCUS_BACK"
echo "xcodebuild suite passed: $XC_PASS"
echo "=== verdict ==="
# Two sessions stay RESIDENT, so a backgrounded tab streams live: its 30s of
# output persists (sentinels), switch-back reuses the socket rather than
# reconnecting (wasLive:true stays 0) and re-focuses the tab. The repaint of the
# current frame is client-side, from the retained grid — the passing sim suite
# is what verifies it rendered.
if [ "$XC_PASS" -ne 1 ]; then
  echo "FAIL: the sim suite did not pass — incidental events do not count"
  echo "--- xcodebuild tail ---"; tail -30 "$E2E_DIR/xcodebuild.log"; exit 1
fi
if [ "$SENT_A" -eq 0 ] || [ "$SENT_B" -eq 0 ]; then
  echo "FAIL: an agent's 30s run never reached its sentinel in terminal_logs (A=$SENT_A B=$SENT_B)"
  echo "--- xcodebuild tail ---"; tail -30 "$E2E_DIR/xcodebuild.log"; exit 1
fi
if [ "$WASLIVE_BACK" -ne 0 ]; then
  echo "FAIL: switch-back reconnected a resident session (noise_start wasLive:true=$WASLIVE_BACK); socket was not reused"
  echo "--- xcodebuild tail ---"; tail -30 "$E2E_DIR/xcodebuild.log"; exit 1
fi
if [ "$FOCUS_BACK" -lt 1 ]; then
  echo "FAIL: switch-back never re-focused a live session (no noise_focus focused:true)"
  echo "--- xcodebuild tail ---"; tail -30 "$E2E_DIR/xcodebuild.log"; exit 1
fi
echo "PASS: 30s of tabbed-away agent output persisted (both sentinels); switch-back reused the live socket (no reconnect) and re-focused the tab"
