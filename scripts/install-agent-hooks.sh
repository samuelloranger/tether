#!/bin/sh
# Wire agent notifications to tether-notify. Installs a small hook wrapper to
# ~/.local/bin/tether-notify-hook and registers it with Claude Code (Notification
# + Stop events). Other agents can call the same wrapper from their own hooks.
#
#   bash scripts/install-agent-hooks.sh [host-label]
#
# host-label is the name shown in the notification and used in the deep link
# (tether://session/<zmx session>?host=<label>). Defaults to this host's name.
set -eu

HOST_LABEL="${1:-$(hostname -s 2>/dev/null || hostname)}"
BIN_DIR="${HOME}/.local/bin"
WRAPPER="${BIN_DIR}/tether-notify-hook"
SETTINGS="${HOME}/.claude/settings.json"

mkdir -p "$BIN_DIR"

# The wrapper resolves the live zmx session and state at fire time. `waiting`
# means the agent is blocked on you — the only state worth pulling attention.
cat > "$WRAPPER" <<EOF
#!/bin/sh
# tether-notify agent hook. Usage: tether-notify-hook <waiting|done|MESSAGE>
set -eu
state="\${1:-done}"
host="\${TETHER_NOTIFY_HOST:-${HOST_LABEL}}"
sess="\${ZMX_SESSION:-default}"
case "\$state" in
  waiting) body="Waiting for input" ;;
  done)    body="Task finished" ;;
  *)       body="\$state" ;;
esac
exec tether-notify notify \\
  --title "\${host} · agent" --body "\$body" \\
  --link "tether://session/\${sess}?host=\${host}" \\
  --collapse "agent-\${sess}"
EOF
chmod +x "$WRAPPER"
echo "Installed hook wrapper: $WRAPPER"

# Register with Claude Code. Merge with jq when available; otherwise print the
# snippet for the user to add themselves (never clobber an existing config).
HOOKS_JSON='{
  "hooks": {
    "Notification": [{ "hooks": [{ "type": "command", "command": "tether-notify-hook waiting" }] }],
    "Stop":         [{ "hooks": [{ "type": "command", "command": "tether-notify-hook done" }] }]
  }
}'

if command -v jq >/dev/null 2>&1; then
  mkdir -p "$(dirname "$SETTINGS")"
  [ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"
  tmp="$(mktemp)"
  # Append our command entries without dropping any hooks already configured.
  printf '%s' "$HOOKS_JSON" | jq -s '
    .[0] as $cur | .[1] as $add
    | $cur * { hooks: (($cur.hooks // {}) + (
        $add.hooks | to_entries | map({
          key: .key,
          value: (($cur.hooks[.key] // []) + .value)
        }) | from_entries)) }
  ' "$SETTINGS" - > "$tmp" && mv "$tmp" "$SETTINGS"
  echo "Registered Notification + Stop hooks in $SETTINGS (host: ${HOST_LABEL})."
else
  echo
  echo "jq not found — add these hooks to ${SETTINGS} yourself:"
  echo "$HOOKS_JSON"
fi

echo
echo "Test it:  tether-notify-hook waiting"
