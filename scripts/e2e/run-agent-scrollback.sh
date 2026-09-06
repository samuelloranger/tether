#!/usr/bin/env bash
# Test #14: run REAL Claude Code in a session via the app UI, print pages, switch
# tabs, switch back by identity, and export screenshots for human/vision review.
# Assertions are made on the SCREENSHOTS (ground truth), not the grid seam.
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
SHOTS="$E2E_DIR/shots"

rm -rf "$E2E_DIR"
mkdir -p "$E2E_DIR"
bun scripts/build-ffi.ts >/dev/null

SERVER_PID=""
cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  pkill -f "$E2E_DIR" 2>/dev/null || true
}
trap cleanup EXIT

# The spawned shell inherits this env, so claude is on PATH and uses ~/.claude auth.
TETHER_DB_PATH="$DB" TETHER_PORT="$PORT" TETHER_TLS=off TETHER_TEST_LOG="$EVT" \
  PATH="$PATH" \
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
  -only-testing:TetherIOSUITests/AgentScrollbackTests \
  CODE_SIGN_IDENTITY="-" CODE_SIGNING_REQUIRED=NO \
  CODE_SIGNING_ALLOWED=YES AD_HOC_CODE_SIGNING_ALLOWED=YES \
  >"$XLOG" 2>&1 || true

echo "=== ids ==="; grep -E "A_ID=|B_ID=|SWITCHBACK_ACTIVE=" "$XLOG" | head
echo "=== test verdict ==="; grep -E "\*\* TEST (SUCCEEDED|FAILED) \*\*|could not switch back" "$XLOG" | tail -3

# Export the screenshots for review.
rm -rf "$SHOTS"; mkdir -p "$SHOTS"
XCR=$(ls -dt ~/Library/Developer/Xcode/DerivedData/Tether-*/Logs/Test/*.xcresult 2>/dev/null | head -1)
xcrun xcresulttool export attachments --path "$XCR" --output-path "$SHOTS" >/dev/null 2>&1 || true
echo "=== screenshots (name -> file) ==="
python3 - "$SHOTS/manifest.json" <<'PY' 2>/dev/null || echo "(no manifest)"
import sys, json
data = json.load(open(sys.argv[1]))
for e in data:
    for a in e.get("attachments", []):
        n = a.get("suggestedHumanReadableName", "")
        if n.startswith("agent-"):
            print(n, a.get("exportedFileName"))
PY
echo "DONE"
