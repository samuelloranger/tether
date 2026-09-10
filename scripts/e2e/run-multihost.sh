#!/usr/bin/env bash
# Test #21 orchestration: two paired hosts at once. Runs TWO daemons on separate
# ports, DBs, and HOMEs (so their holder dirs don't collide — client session ids
# like term-1 repeat per host), preseeds both, and drives MultiHostTests. Oracle:
# each server independently logged its own Noise auth + session start.
set -euo pipefail
export PATH="$HOME/.bun/bin:$HOME/.cargo/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

SIM_ID="${SIM_ID:-301860DB-8242-4536-8648-C7FF262F8C34}"
BID=com.samuelloranger.tether-mobile
E2E_DIR="$HOME/.tether-e2e"
DB1="$E2E_DIR/h1.db"; PORT1=8199; EVT1="$E2E_DIR/events1.log"
DB2="$E2E_DIR/h2.db"; PORT2=8200; EVT2="$E2E_DIR/events2.log"
HOME2="$E2E_DIR/home2"
XLOG="$E2E_DIR/xcodebuild.log"

rm -rf "$E2E_DIR"; mkdir -p "$E2E_DIR" "$HOME2"
bun scripts/build-ffi.ts >/dev/null

PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; pkill -f "$E2E_DIR" 2>/dev/null || true; }
trap cleanup EXIT

TETHER_DB_PATH="$DB1" TETHER_PORT="$PORT1" TETHER_TLS=off TETHER_TEST_LOG="$EVT1" \
  bun apps/server/src/server/main.ts serve >"$E2E_DIR/server1.log" 2>&1 &
PIDS+=($!)
HOME="$HOME2" TETHER_DB_PATH="$DB2" TETHER_PORT="$PORT2" TETHER_TLS=off TETHER_TEST_LOG="$EVT2" \
  bun apps/server/src/server/main.ts serve >"$E2E_DIR/server2.log" 2>&1 &
PIDS+=($!)

for port in "$PORT1" "$PORT2"; do
  ready=0
  for _ in $(seq 1 40); do
    curl -sf "http://127.0.0.1:$port/api/status" >/dev/null 2>&1 && { ready=1; break; }
    sleep 0.5
  done
  [ "$ready" -eq 1 ] || { echo "FAIL: server never became ready on :$port"; tail -20 "$E2E_DIR/server1.log" "$E2E_DIR/server2.log" 2>/dev/null; exit 1; }
done

FIXTURE="$(TETHER_DB_PATH="$DB1" FIX_PORT="$PORT1" FIX_NAME=e2e FIX_SCHEME=ws bun scripts/e2e/preseed-fixture.ts)"
FIXTURE2="$(HOME="$HOME2" TETHER_DB_PATH="$DB2" FIX_PORT="$PORT2" FIX_NAME=e2e2 FIX_SCHEME=ws bun scripts/e2e/preseed-fixture.ts)"
/usr/bin/ruby scripts/add_uitest_target.rb clients/apple/Tether.xcodeproj >/dev/null
xcrun simctl terminate "$SIM_ID" "$BID" 2>/dev/null || true
xcrun simctl uninstall "$SIM_ID" "$BID" 2>/dev/null || true

: >"$EVT1"; : >"$EVT2"
TEST_RUNNER_TETHER_UITEST_PRESEED="$FIXTURE" \
TEST_RUNNER_TETHER_UITEST_PRESEED2="$FIXTURE2" \
  xcodebuild test \
  -project clients/apple/Tether.xcodeproj -scheme TetherIOS \
  -destination "platform=iOS Simulator,id=$SIM_ID" \
  -only-testing:TetherIOSUITests/MultiHostTests \
  CODE_SIGN_IDENTITY="-" CODE_SIGNING_REQUIRED=NO \
  CODE_SIGNING_ALLOWED=YES AD_HOC_CODE_SIGNING_ALLOWED=YES \
  >"$XLOG" 2>&1 || true

XC_PASS=0; grep -q "Test Suite 'MultiHostTests' passed" "$XLOG" 2>/dev/null && XC_PASS=1
AUTH1="$(grep -c '"ev":"noise_auth","ok":true' "$EVT1" 2>/dev/null || true)"
AUTH2="$(grep -c '"ev":"noise_auth","ok":true' "$EVT2" 2>/dev/null || true)"
START1="$(grep -c '"ev":"noise_start"' "$EVT1" 2>/dev/null || true)"
START2="$(grep -c '"ev":"noise_start"' "$EVT2" 2>/dev/null || true)"

echo "=== MultiHostTests ==="
echo "host1: noise_auth=$AUTH1 noise_start=$START1   host2: noise_auth=$AUTH2 noise_start=$START2   xcodebuild passed=$XC_PASS"
echo "=== verdict ==="
if [ "$XC_PASS" -ne 1 ]; then
  echo "FAIL: drawer did not show/drive both hosts (in-test assertion)"; tail -30 "$XLOG"; exit 1
fi
if [ "${AUTH1:-0}" -eq 0 ] || [ "${AUTH2:-0}" -eq 0 ]; then
  echo "FAIL: a host never completed Noise auth (host1 auth=$AUTH1 host2 auth=$AUTH2)"; tail -30 "$XLOG"; exit 1
fi
if [ "${START1:-0}" -eq 0 ] || [ "${START2:-0}" -eq 0 ]; then
  echo "FAIL: a host never got its own session (host1 starts=$START1 host2 starts=$START2)"; tail -30 "$XLOG"; exit 1
fi
echo "PASS: two hosts coexist — each server independently authed and started its own session"
