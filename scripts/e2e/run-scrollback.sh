#!/usr/bin/env bash
# Test #13 orchestration: does scrollback survive a tab that produced pages of
# output while inactive? Drives ScrollbackTests, then compares the client's
# rendered grid (at switch-back and after scrolling up) against the server's
# terminal_logs.
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
  -only-testing:TetherIOSUITests/ScrollbackTests \
  CODE_SIGN_IDENTITY="-" CODE_SIGNING_REQUIRED=NO \
  CODE_SIGNING_ALLOWED=YES AD_HOC_CODE_SIGNING_ALLOWED=YES \
  >"$XLOG" 2>&1 || true

dump() { awk "/GRID_$1_START/{f=1;next} /GRID_$1_END/{f=0} f" "$XLOG" 2>/dev/null || true; }
SWITCHBACK="$(dump SWITCHBACK)"
SCROLLUP="$(dump SCROLLUP)"

SERVER_LATE="$(TETHER_DB_PATH="$DB" bun scripts/e2e/count-log-marker.ts SCROLL_LINE_118 2>/dev/null || echo 0)"
SERVER_EARLY="$(TETHER_DB_PATH="$DB" bun scripts/e2e/count-log-marker.ts SCROLL_LINE_005 2>/dev/null || echo 0)"
CB_LATE=0; echo "$SWITCHBACK" | grep -q "SCROLL_LINE_118" && CB_LATE=1
CB_EARLY=0; echo "$SCROLLUP" | grep -q "SCROLL_LINE_005" && CB_EARLY=1

echo "=== grid at switch-back ==="
echo "$SWITCHBACK"
echo "=== grid after scroll-up ==="
echo "$SCROLLUP"
echo "=== markers ==="
echo "server terminal_logs: SCROLL_LINE_118=$SERVER_LATE  SCROLL_LINE_005=$SERVER_EARLY"
echo "client switch-back has LINE_118 (latest): $CB_LATE"
echo "client scroll-up has LINE_005 (scrollback): $CB_EARLY"
echo "=== verdict ==="
if [ "$SERVER_LATE" -eq 0 ]; then
  echo "FAIL: server never produced the lines (setup broken)"
  tail -30 "$XLOG"
  exit 1
fi
if [ "$CB_LATE" -eq 0 ]; then
  echo "FINDING: after switch-back the client is MISSING even the latest output produced while inactive (SCROLL_LINE_118 absent) — inactive-tab streaming is broken"
elif [ "$CB_EARLY" -eq 0 ]; then
  echo "FINDING: latest output present but SCROLLBACK is LOST — cannot scroll up to earlier lines produced while inactive (matches the real-device symptom)"
else
  echo "FINDING: scrollback intact — early lines reachable after scroll-up (symptom NOT reproduced here)"
fi
