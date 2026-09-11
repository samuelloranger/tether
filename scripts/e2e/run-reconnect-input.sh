#!/usr/bin/env bash
# Test #8 orchestration: does input typed after a background+reopen reach the
# PTY? Drives ReconnectInputTests on the sim against a live server+oracle, then
# checks terminal_logs for the baseline and post-reopen markers and reports the
# oracle event sequence.
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

# Fresh install so the a11y ids + preseed apply cleanly.
xcrun simctl terminate "$SIM_ID" "$BID" 2>/dev/null || true
xcrun simctl uninstall "$SIM_ID" "$BID" 2>/dev/null || true

: >"$EVT"
TEST_RUNNER_TETHER_UITEST_PRESEED="$FIXTURE" \
  xcodebuild test \
  -project clients/apple/Tether.xcodeproj -scheme TetherIOS \
  -destination "platform=iOS Simulator,id=$SIM_ID" \
  -only-testing:TetherIOSUITests/ReconnectInputTests \
  CODE_SIGN_IDENTITY="-" CODE_SIGNING_REQUIRED=NO \
  CODE_SIGNING_ALLOWED=YES AD_HOC_CODE_SIGNING_ALLOWED=YES \
  >"$E2E_DIR/xcodebuild.log" 2>&1 || true

BEFORE="$(TETHER_DB_PATH="$DB" bun scripts/e2e/count-log-marker.ts BEFORE_BG_OK 2>/dev/null || echo 0)"
AFTER="$(TETHER_DB_PATH="$DB" bun scripts/e2e/count-log-marker.ts AFTER_REOPEN_OK 2>/dev/null || echo 0)"
STARTS="$(grep -c '"ev":"noise_start"' "$EVT" 2>/dev/null || echo 0)"
INPUTS="$(grep -c '"ev":"noise_input"' "$EVT" 2>/dev/null || echo 0)"

echo "=== oracle events ==="
cat "$EVT" 2>/dev/null || true
echo "=== markers in terminal_logs ==="
echo "BEFORE_BG_OK chunks:   $BEFORE"
echo "AFTER_REOPEN_OK chunks: $AFTER"
echo "noise_start events: $STARTS   noise_input events: $INPUTS"
echo "=== verdict ==="
if [ "$BEFORE" -eq 0 ]; then
  echo "FAIL: baseline input never reached the PTY — the harness could not drive typing"
  echo "--- xcodebuild tail ---"
  tail -30 "$E2E_DIR/xcodebuild.log"
  exit 1
fi
echo "PASS: harness drives real input (BEFORE_BG_OK reached the PTY)"
if [ "$AFTER" -gt 0 ]; then
  echo "FINDING: input AFTER background+reopen DID reach the PTY (reconnect input works)"
else
  echo "FINDING: input AFTER background+reopen did NOT reach the PTY — reconnect input is BROKEN"
fi
