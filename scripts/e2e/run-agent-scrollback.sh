#!/usr/bin/env bash
# Test #14: run REAL cursor-agent (Ink TUI) in a session via the app UI, print
# pages, switch tabs, switch back by identity, and export screenshots for
# human/vision review. Claude Code is the user's real login and is currently
# session-limited; cursor-agent is the same class of alt-screen TUI (and the
# #1066 freeze). Assertions are on the SCREENSHOTS, not the grid seam.
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

# Drop a leftover E2E server (previous ssh-started run, or a crashed GUI one)
# before wiping the dir — otherwise :8199 stays bound and the GUI start fails.
pkill -f "$E2E_DIR" 2>/dev/null || true
rm -rf "$E2E_DIR"
mkdir -p "$E2E_DIR"
bun scripts/build-ffi.ts >/dev/null

CJSON="$HOME/.claude.json"
cleanup() {
  if [ -f "$CJSON.e2ebak" ]; then mv -f "$CJSON.e2ebak" "$CJSON"; fi
  if [ -f "$E2E_DIR/server.pid" ]; then kill "$(cat "$E2E_DIR/server.pid")" 2>/dev/null || true; fi
  pkill -f "$E2E_DIR" 2>/dev/null || true
}
trap cleanup EXIT

# Claude's OAuth token lives in the login keychain. An ssh-started server
# cannot read it ("User interaction is not allowed") so `claude` prints
# "Not logged in · security unlock-keychain". Opening a .command file
# runs the server in Terminal.app's Aqua session, which already has the
# keychain unlocked. Holders inherit that security session.
START_CMD="$E2E_DIR/start-server.command"
cat > "$START_CMD" <<EOF
#!/bin/bash
export PATH="\$HOME/.local/bin:\$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:\$PATH"
cd "$ROOT"
export TETHER_DB_PATH="$DB"
export TETHER_PORT="$PORT"
export TETHER_TLS=off
export TETHER_TEST_LOG="$EVT"
echo \$\$ > "$E2E_DIR/server.pid"
exec caffeinate -d -i -s bun apps/server/src/main.ts serve >"$E2E_DIR/server.log" 2>&1
EOF
chmod +x "$START_CMD"
open "$START_CMD"
for _ in $(seq 1 40); do
  curl -sf "http://127.0.0.1:$PORT/api/status" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -sf "http://127.0.0.1:$PORT/api/status" >/dev/null 2>&1 || {
  echo "FAIL: GUI-started server never listened on :$PORT"
  tail -30 "$E2E_DIR/server.log" 2>/dev/null || true
  exit 1
}

# Pre-trust the session's working dir so Claude Code skips its "trust this
# folder?" prompt (backed up first).
if [ -f "$CJSON" ]; then
  cp "$CJSON" "$CJSON.e2ebak"
  python3 - "$CJSON" "$HOME" <<'PY' || true
import json, sys
path, home = sys.argv[1], sys.argv[2]
d = json.load(open(path))
d.setdefault("projects", {}).setdefault(home, {})["hasTrustDialogAccepted"] = True
tmp = path + ".tmp"
json.dump(d, open(tmp, "w"))
import os; os.replace(tmp, path)
print("pre-trusted", home)
PY
fi

# Slow printer the agent runs so we can switch away mid-stream (~48s).
cat > "$E2E_DIR/slowprint.py" <<'PY'
import time
for i in range(1, 121):
    print(f"SCROLL_LINE_{i:03d}", flush=True)
    time.sleep(0.4)
PY

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
