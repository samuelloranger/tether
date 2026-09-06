#!/usr/bin/env bash
# Proves the iOS preseed path end to end on macbuild: start a server on an
# isolated DB + port with the event oracle on, enrol a device, launch the real
# app already paired via TETHER_UITEST_PRESEED, and assert the server logged a
# Noise session (noise_auth ok). UI driving is the XCUITest; the protocol
# assertion is here, against the oracle log on this host.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

SIM_ID="${SIM_ID:-301860DB-8242-4536-8648-C7FF262F8C34}" # iPhone 14 Pro Max iOS 18.5
PORT="${PORT:-8199}"
E2E_DIR="$HOME/.tether-e2e"
DB="$E2E_DIR/tether.db"
EVT="$E2E_DIR/events.log"

rm -rf "$E2E_DIR"
mkdir -p "$E2E_DIR"

# Build the host cdylib the server links at runtime.
bun scripts/build-ffi.ts >/dev/null

SERVER_PID=""
cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  # Only ever touch processes tied to the isolated e2e dir — never prod.
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
curl -sf "http://127.0.0.1:$PORT/api/status" >/dev/null 2>&1 || {
  echo "FAIL: server never listened on :$PORT"
  tail -30 "$E2E_DIR/server.log"
  exit 1
}

FIXTURE="$(TETHER_DB_PATH="$DB" FIX_PORT="$PORT" FIX_SCHEME=ws bun scripts/e2e/preseed-fixture.ts)"
echo "fixture: $FIXTURE"

ruby scripts/add_uitest_target.rb clients/apple/Tether.xcodeproj >/dev/null

: >"$EVT" # count only events produced by the app run below
xcodebuild test \
  -project clients/apple/Tether.xcodeproj -scheme TetherIOS \
  -destination "platform=iOS Simulator,id=$SIM_ID" \
  -only-testing:TetherIOSUITests/PreseedConnectTests \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO \
  TEST_RUNNER_TETHER_UITEST_PRESEED="$FIXTURE" \
  >"$E2E_DIR/xcodebuild.log" 2>&1 || true

echo "=== oracle events ==="
cat "$EVT" 2>/dev/null || true
echo "=== assertion ==="
if grep -q '"ev":"noise_auth"' "$EVT" && grep -q '"ok":true' "$EVT"; then
  echo "PASS: app launched paired and opened a Noise session (noise_auth ok)"
else
  echo "FAIL: no noise_auth ok in oracle"
  echo "--- server.log tail ---"
  tail -20 "$E2E_DIR/server.log"
  echo "--- xcodebuild tail ---"
  tail -30 "$E2E_DIR/xcodebuild.log"
  exit 1
fi
