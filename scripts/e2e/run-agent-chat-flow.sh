#!/usr/bin/env bash
# Agent-chat UI flow: type in the composer with the SOFTWARE keyboard, watch the
# scripted host stream frames back, and check the transcript's scroll behaviour
# against arriving data.
#
# Unlike the other e2e runners this one needs NO tether server, no PTY and no
# preseed: `-agentDemo live|liveLong` boots the app straight into the chat with
# AgentChatLiveScript standing in for the host. So it is safe to run any time and
# never touches ~/.tether.
set -euo pipefail
export PATH="$HOME/.bun/bin:$HOME/.cargo/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

SIM_ID="${SIM_ID:-301860DB-8242-4536-8648-C7FF262F8C34}"
BID=com.samuelloranger.tether-mobile
OUT="${OUT:-$HOME/.tether-e2e-chat}"
XLOG="$OUT/xcodebuild.log"
SHOTS="$OUT/shots"
mkdir -p "$OUT"

# The whole point of the suite is the on-screen keyboard. With a hardware
# keyboard connected the simulator never shows it, XCUITest types through the
# host keyboard instead, and every typing test passes for the wrong reason — so
# force it off globally AND for this device, then restart the prefs daemon so
# Simulator.app reads the new value.
PLIST="$HOME/Library/Preferences/com.apple.iphonesimulator.plist"
defaults write com.apple.iphonesimulator ConnectHardwareKeyboard -bool false
/usr/libexec/PlistBuddy -c "Add :DevicePreferences:$SIM_ID:ConnectHardwareKeyboard bool false" \
  "$PLIST" 2>/dev/null ||
  /usr/libexec/PlistBuddy -c "Set :DevicePreferences:$SIM_ID:ConnectHardwareKeyboard false" \
    "$PLIST" 2>/dev/null || true
killall -u "$USER" cfprefsd 2>/dev/null || true

xcrun simctl boot "$SIM_ID" 2>/dev/null || true
xcrun simctl bootstatus "$SIM_ID" -b >/dev/null 2>&1 || true
xcrun simctl terminate "$SIM_ID" "$BID" 2>/dev/null || true
xcrun simctl uninstall "$SIM_ID" "$BID" 2>/dev/null || true

# Re-globs TetherIOSUITests/*.swift, so new test files are picked up.
/usr/bin/ruby scripts/add_uitest_target.rb clients/apple/Tether.xcodeproj >/dev/null

ONLY=(
  -only-testing:TetherIOSUITests/AgentChatSendTests
  -only-testing:TetherIOSUITests/AgentChatScrollTests
)
if [ "${TEST:-}" != "" ]; then ONLY=(-only-testing:"TetherIOSUITests/$TEST"); fi

xcodebuild test \
  -project clients/apple/Tether.xcodeproj -scheme TetherIOS \
  -destination "platform=iOS Simulator,id=$SIM_ID" \
  "${ONLY[@]}" \
  CODE_SIGN_IDENTITY="-" CODE_SIGNING_REQUIRED=NO \
  CODE_SIGNING_ALLOWED=YES AD_HOC_CODE_SIGNING_ALLOWED=YES \
  >"$XLOG" 2>&1 || true

echo "=== per-test results ==="
grep -E "Test case '-\[.*\]' (passed|failed)" "$XLOG" | sed 's/ on .*//' || true
echo "=== failures ==="
grep -E "error:|XCTAssert.* failed" "$XLOG" | head -20 || true
echo "=== verdict ==="
grep -E "\*\* TEST (SUCCEEDED|FAILED) \*\*" "$XLOG" | tail -1 || echo "(no verdict — see $XLOG)"

rm -rf "$SHOTS"
mkdir -p "$SHOTS"
XCR=$(ls -dt ~/Library/Developer/Xcode/DerivedData/Tether-*/Logs/Test/*.xcresult 2>/dev/null | head -1)
xcrun xcresulttool export attachments --path "$XCR" --output-path "$SHOTS" >/dev/null 2>&1 || true
echo "=== screenshots (name -> file) ==="
python3 - "$SHOTS/manifest.json" <<'PY' 2>/dev/null || echo "(no manifest)"
import sys, json
for entry in json.load(open(sys.argv[1])):
    for a in entry.get("attachments", []):
        name = a.get("suggestedHumanReadableName", "")
        if name.startswith(("chat-", "scroll-", "arrival-")):
            print(name, a.get("exportedFileName"))
PY
echo "log: $XLOG"
echo "DONE"
