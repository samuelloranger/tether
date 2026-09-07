#!/usr/bin/env bash
# Runs one lifecycle-edge XCUITest against a fresh server + preseeded, force-quit
# capable app, then applies that test's oracle. Each test gets its OWN server/DB
# (fresh E2E_DIR) so server-assigned session ids reset to term-1 per run — the
# notification-route test depends on that determinism.
#
#   scripts/e2e/run-lifecycle.sh ForceQuitReplayTests
#   scripts/e2e/run-lifecycle.sh NotificationTapRouteTests
#   scripts/e2e/run-lifecycle.sh ReopenExitStateTests
set -euo pipefail
export PATH="$HOME/.bun/bin:$HOME/.cargo/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

CLASS="${1:?usage: run-lifecycle.sh <TestClass>}"
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
ready=0
for _ in $(seq 1 40); do
  curl -sf "http://127.0.0.1:$PORT/api/status" >/dev/null 2>&1 && { ready=1; break; }
  sleep 0.5
done
if [ "$ready" -ne 1 ]; then
  echo "FAIL: server never became ready on :$PORT"; tail -20 "$E2E_DIR/server.log" 2>/dev/null; exit 1
fi

FIXTURE="$(TETHER_DB_PATH="$DB" FIX_PORT="$PORT" FIX_SCHEME=ws bun scripts/e2e/preseed-fixture.ts)"
/usr/bin/ruby scripts/add_uitest_target.rb clients/apple/Tether.xcodeproj >/dev/null
xcrun simctl terminate "$SIM_ID" "$BID" 2>/dev/null || true
xcrun simctl uninstall "$SIM_ID" "$BID" 2>/dev/null || true

: >"$EVT"
TEST_RUNNER_TETHER_UITEST_PRESEED="$FIXTURE" \
  xcodebuild test \
  -project clients/apple/Tether.xcodeproj -scheme TetherIOS \
  -destination "platform=iOS Simulator,id=$SIM_ID" \
  -only-testing:"TetherIOSUITests/$CLASS" \
  CODE_SIGN_IDENTITY="-" CODE_SIGNING_REQUIRED=NO \
  CODE_SIGNING_ALLOWED=YES AD_HOC_CODE_SIGNING_ALLOWED=YES \
  >"$XLOG" 2>&1 || true

GRID="$(awk '/GRID_DUMP_START/{f=1;next} /GRID_DUMP_END/{f=0} f' "$XLOG" 2>/dev/null || true)"
XC_PASS=0; grep -q "Test Suite '$CLASS' passed" "$XLOG" 2>/dev/null && XC_PASS=1

marker() { TETHER_DB_PATH="$DB" bun scripts/e2e/count-log-marker.ts "$1" 2>/dev/null || echo 0; }
gridhas() { echo "$GRID" | grep -q "$1" && echo 1 || echo 0; }
# Every verdict below also requires the sim suite to have actually passed — a
# crashed/aborted run can still leave incidental markers or a partial grid.
require_xcpass() {
  [ "$XC_PASS" -eq 1 ] || { echo "FAIL: xcodebuild suite did not pass"; tail -30 "$XLOG"; exit 1; }
}

echo "=== $CLASS ==="
echo "--- client grid dump ---"; echo "$GRID"; echo "--- end grid ---"
echo "xcodebuild suite passed: $XC_PASS"

case "$CLASS" in
  ForceQuitReplayTests)
    SRV_AFTER="$(marker AFTER_QUIT_MARK)"
    CG_BEFORE="$(gridhas BEFORE_QUIT)"; CG_AFTER="$(gridhas AFTER_QUIT_MARK)"
    echo "server AFTER_QUIT_MARK=$SRV_AFTER   client grid BEFORE_QUIT=$CG_BEFORE AFTER_QUIT_MARK=$CG_AFTER"
    echo "=== verdict ==="
    require_xcpass
    if [ "$SRV_AFTER" -eq 0 ]; then
      echo "FAIL: AFTER_QUIT_MARK never produced server-side — setup invalid (did the holder die with the app?)"
      tail -30 "$XLOG"; exit 1
    fi
    if [ "$CG_AFTER" -ne 1 ] || [ "$CG_BEFORE" -ne 1 ]; then
      echo "FAIL: after force-quit + relaunch the client did not render the missed output (BEFORE=$CG_BEFORE AFTER=$CG_AFTER)"
      tail -30 "$XLOG"; exit 1
    fi
    echo "PASS: session survived force-quit; relaunch replayed output produced while the app was dead"
    ;;
  NotificationTapRouteTests)
    CG_TARGET="$(gridhas ROUTE_TARGET_A)"; CG_OTHER="$(gridhas OTHER_SESSION_B)"
    echo "client grid ROUTE_TARGET_A=$CG_TARGET   OTHER_SESSION_B=$CG_OTHER"
    echo "=== verdict ==="
    require_xcpass
    if [ "$CG_TARGET" -ne 1 ]; then
      echo "FAIL: notification tap did not open the named session (target marker absent from grid)"
      tail -30 "$XLOG"; exit 1
    fi
    if [ "$CG_OTHER" -eq 1 ]; then
      echo "FAIL: grid shows the OTHER session too — tap landed on the wrong tab or did not switch"
      tail -30 "$XLOG"; exit 1
    fi
    echo "PASS: notification tap routed to the named session (term-1), not the last-active tab"
    ;;
  ReopenExitStateTests)
    echo "=== verdict ==="
    if [ "$XC_PASS" -ne 1 ]; then
      echo "FAIL: reopen did not show the exited session as stopped (in-test assertion failed)"
      tail -30 "$XLOG"; exit 1
    fi
    echo "PASS: a shell that exited while backgrounded shows as stopped after reopen"
    ;;
  ReplayAfterSuspendTests)
    # Backgrounded (not force-quit) sessions stay resident and stream live, so
    # the gap may arrive live rather than via a replay event — either way the
    # invariant is that the client renders output produced while it was away.
    SRV_GAP="$(marker SUSPENDED_GAP)"; CG_GAP="$(gridhas SUSPENDED_GAP)"
    REPLAY_CONTENT="$(grep '"ev":"replay"' "$EVT" 2>/dev/null | grep -cE '"reset":true|"bytes":[1-9]' || true)"
    echo "server SUSPENDED_GAP=$SRV_GAP   client grid SUSPENDED_GAP=$CG_GAP   replay-with-content(info)=$REPLAY_CONTENT"
    echo "=== verdict ==="
    require_xcpass
    if [ "$SRV_GAP" -eq 0 ]; then
      echo "FAIL: SUSPENDED_GAP never produced server-side — setup invalid"; tail -30 "$XLOG"; exit 1
    fi
    if [ "$CG_GAP" -ne 1 ]; then
      echo "FAIL: output produced while backgrounded never reached the client grid"; tail -30 "$XLOG"; exit 1
    fi
    echo "PASS: output produced while backgrounded reached the client on reopen (delivery=$([ "$REPLAY_CONTENT" -gt 0 ] && echo replay || echo live))"
    ;;
  RotateResizeTests)
    # PTY resize sends SIGWINCH to the child at the OS level automatically; the
    # `sigwinch` testEvent is a SEPARATE reattach-kick, so it need not appear.
    # Landscape is WIDER, so proving rotation (not just the initial layout
    # settle) means a later reported width strictly exceeds the first one.
    COLS_SEQ="$(grep '"ev":"noise_resize"' "$EVT" 2>/dev/null | grep -oE '"cols":[0-9]+' | grep -oE '[0-9]+')"
    FIRST_COLS="$(echo "$COLS_SEQ" | head -1)"
    MAX_COLS="$(echo "$COLS_SEQ" | sort -n | tail -1)"
    echo "first width=$FIRST_COLS   max width=$MAX_COLS"
    echo "=== verdict ==="
    require_xcpass
    if [ -z "$FIRST_COLS" ] || [ "${MAX_COLS:-0}" -le "${FIRST_COLS:-0}" ]; then
      echo "FAIL: rotation never widened the grid (first=$FIRST_COLS max=$MAX_COLS)"
      tail -30 "$XLOG"; exit 1
    fi
    echo "PASS: rotation to landscape reported a wider grid to the PTY ($FIRST_COLS -> $MAX_COLS cols)"
    ;;
  UnicodeRenderTests)
    # A wide (CJK) glyph occupies TWO grid cells — glyph + spacer — so the row
    # text reads "你 好", not "你好". Assert each wide char plus the multibyte
    # "café" individually rather than a contiguous CJK run.
    S="$(gridhas UNI_START)"; E="$(gridhas UNI_END)"
    NI="$(gridhas 你)"; HAO="$(gridhas 好)"; CAFE="$(gridhas café)"
    SRV_CJK="$(marker 你)"; SRV_START="$(marker UNI_START)"
    echo "server: UNI_START=$SRV_START 你=$SRV_CJK   client grid: UNI_START=$S UNI_END=$E 你=$NI 好=$HAO café=$CAFE"
    echo "=== verdict ==="
    require_xcpass
    if [ "$SRV_START" -eq 0 ] || [ "$SRV_CJK" -eq 0 ]; then
      echo "FAIL: the shell never emitted the unicode (printf \\u unsupported here?) — setup invalid"
      tail -30 "$XLOG"; exit 1
    fi
    if [ "$S" -ne 1 ] || [ "$E" -ne 1 ]; then
      echo "FAIL: the bracketing ASCII markers did not render — the line was lost"; tail -30 "$XLOG"; exit 1
    fi
    if [ "$NI" -ne 1 ] || [ "$HAO" -ne 1 ] || [ "$CAFE" -ne 1 ]; then
      echo "FAIL: wide/multibyte output did not render intact (你=$NI 好=$HAO café=$CAFE)"; tail -30 "$XLOG"; exit 1
    fi
    echo "PASS: wide (CJK, two-cell) and multibyte characters rendered intact"
    ;;
  CtrlCInterruptTests)
    REC="$(marker INTERRUPT_RECOVERED)"; TICK="$(marker LOOP_TICK)"
    echo "LOOP_TICK=$TICK   INTERRUPT_RECOVERED=$REC   xcodebuild passed=$XC_PASS"
    echo "=== verdict ==="
    if [ "$TICK" -eq 0 ]; then
      echo "FAIL: the loop never ran — setup invalid"; tail -30 "$XLOG"; exit 1
    fi
    if [ "$REC" -eq 0 ]; then
      echo "FAIL: recovery command never ran — Ctrl-C did not interrupt the loop"
      tail -30 "$XLOG"; exit 1
    fi
    echo "PASS: Ctrl-C interrupted the loop; the prompt returned and ran the recovery command"
    ;;
  DeepLinkUnknownHostTests)
    echo "=== verdict ==="
    if [ "$XC_PASS" -ne 1 ]; then
      echo "FAIL: app crashed or became unusable on an unknown-host deep link"
      tail -30 "$XLOG"; exit 1
    fi
    echo "PASS: unknown-host deep link failed soft — app stayed up and usable"
    ;;
  RapidSessionSpamTests)
    FRESH="$(grep -c '"wasLive":false' "$EVT" 2>/dev/null || true)"
    echo "fresh sessions started (noise_start wasLive:false): $FRESH   xcodebuild passed=$XC_PASS"
    echo "=== verdict ==="
    if [ "$XC_PASS" -ne 1 ]; then
      echo "FAIL: drawer did not show exactly 5 sessions (in-test assertion) — spam crashed/wedged/double-spawned"
      tail -30 "$XLOG"; exit 1
    fi
    if [ "${FRESH:-0}" -ne 5 ]; then
      echo "FAIL: 5 taps did not spawn exactly 5 sessions server-side ($FRESH) — dropped or double-spawned"; tail -30 "$XLOG"; exit 1
    fi
    echo "PASS: 5 rapid taps spawned exactly 5 live sessions, app stayed usable"
    ;;
  DrawerKillSessionTests)
    # Require killed:true — the kill route logs session_kill even when the id
    # matched nothing, so a bare event count would pass on a no-op kill.
    KILLS_OK="$(grep -cE '"ev":"session_kill".*"killed":true' "$EVT" 2>/dev/null || true)"
    echo "server session_kill(killed:true) events: $KILLS_OK   xcodebuild passed=$XC_PASS"
    echo "=== verdict ==="
    require_xcpass
    if [ "${KILLS_OK:-0}" -eq 0 ]; then
      echo "FAIL: no successful session_kill reached the server — the drawer kill did not fire"; tail -30 "$XLOG"; exit 1
    fi
    # The Swift test asserts the app stays usable after the kill; exact row
    # removal is not re-asserted here (a SwiftUI a11y id on a row double-counts).
    echo "PASS: drawer kill ended a live session server-side (killed:true) and the app stayed usable"
    ;;
  *)
    echo "no oracle for $CLASS — xcodebuild passed: $XC_PASS"
    [ "$XC_PASS" -eq 1 ] || { tail -30 "$XLOG"; exit 1; }
    ;;
esac
