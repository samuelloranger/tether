#!/usr/bin/env bash
# Test #5 orchestration: switching back to a live session must trigger a SIGWINCH
# so a full-screen TUI repaints (the Noise reattach does not replay). Drives
# TabSwitchTests and asserts the oracle logged sigwinch + noise_start wasLive.
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
  -only-testing:TetherIOSUITests/TabSwitchTests \
  CODE_SIGN_IDENTITY="-" CODE_SIGNING_REQUIRED=NO \
  CODE_SIGNING_ALLOWED=YES AD_HOC_CODE_SIGNING_ALLOWED=YES \
  >"$E2E_DIR/xcodebuild.log" 2>&1 || true

SIGWINCH="$(grep -c '"ev":"sigwinch"' "$EVT" 2>/dev/null || echo 0)"
WASLIVE="$(grep -c '"wasLive":true' "$EVT" 2>/dev/null || echo 0)"
STARTS="$(grep -c '"ev":"noise_start"' "$EVT" 2>/dev/null || echo 0)"

echo "=== oracle events (tail) ==="
tail -20 "$EVT" 2>/dev/null || true
echo "=== counts ==="
echo "sigwinch: $SIGWINCH   noise_start(wasLive:true): $WASLIVE   noise_start total: $STARTS"
echo "=== verdict ==="
if [ "$SIGWINCH" -gt 0 ] && [ "$WASLIVE" -gt 0 ]; then
  echo "PASS: switch-back to a live session kicked SIGWINCH (repaint path fires)"
else
  echo "FAIL: no SIGWINCH on switch-back (sigwinch=$SIGWINCH wasLive=$WASLIVE)"
  echo "--- xcodebuild tail ---"
  tail -30 "$E2E_DIR/xcodebuild.log"
  exit 1
fi
