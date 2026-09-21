#!/bin/sh
# Wire agent notifications to tether-notify across Claude Code, Codex, and Cursor.
# Installs one wrapper (~/.local/bin/tether-notify-hook) and registers it in each
# agent's hook config that exists, preserving any hooks already there.
#
#   bash scripts/install-agent-hooks.sh [host-label]
#
# host-label is shown in the notification and used in the deep link
# (tether://session/<zmx session>?host=<label>). Defaults to this host's name.
set -eu

HOST_LABEL="${1:-$(hostname -s 2>/dev/null || hostname)}"
BIN_DIR="${HOME}/.local/bin"
WRAPPER="${BIN_DIR}/tether-notify-hook"

command -v jq >/dev/null 2>&1 || {
  echo "jq is required to merge the agent hook configs. Install jq and re-run." >&2
  exit 1
}
mkdir -p "$BIN_DIR"

# --- the wrapper ---------------------------------------------------------------
# Invoked as: tether-notify-hook <agent> <waiting|done>. It reads the agent's
# hook JSON on stdin, fills a notification from the right fields, swallows
# tether-notify's own output, and emits whatever terminator the agent expects
# (Codex parses hook stdout as a decision; the others ignore it). Host label is
# baked in the expanded heredoc; the body is a quoted heredoc so $ / backticks
# stay literal.
cat > "$WRAPPER" <<EOF
#!/bin/sh
TETHER_HOOK_HOST_DEFAULT='${HOST_LABEL}'
EOF
cat >> "$WRAPPER" <<'EOF'
set -eu
agent="${1:-claude}"
state="${2:-done}"
host="${TETHER_NOTIFY_HOST:-$TETHER_HOOK_HOST_DEFAULT}"
sess="${ZMX_SESSION:-default}"

input="$(cat 2>/dev/null || true)"
field() { printf '%s' "$input" | jq -r "$1" 2>/dev/null || true; }

# Project name: cwd (Claude/Codex) or the first workspace root (Cursor).
project="$host"
if [ -n "$input" ]; then
  cwd="$(field '.cwd // (.workspace_roots[0]?) // empty')"
  [ -n "$cwd" ] && project="$(basename "$cwd")"
fi

verb="done"
[ "$state" = waiting ] && verb="needs you"

body=""
if [ -n "$input" ]; then
  case "$agent:$state" in
    claude:waiting) body="$(field '.message // empty')" ;;
    claude:done)
      tp="$(field '.transcript_path // empty')"
      if [ -n "$tp" ] && [ -f "$tp" ]; then
        # Last assistant text turn. Per-line with fromjson? so one unparseable
        # line doesn't blank the whole read (jq -s would); scan the file rather
        # than a tail window, since a turn can end with a long run of tool calls
        # after the final prose.
        body="$(jq -R -r '
          fromjson? | select(.type=="assistant")
          | (.message.content? // []) | map(select(.type=="text") | .text) | join(" ")
          | select(length > 0)' "$tp" 2>/dev/null | tail -1 || true)"
      fi
      ;;
    codex:done)    body="$(field '.last_assistant_message // empty')" ;;
    codex:waiting) body="$(field '.tool_name // .command // .reason // empty')" ;;
    cursor:done)   body="$(field '.Text // .text // .last_assistant_message // .status // empty')" ;;
    cursor:waiting) body="$(field '.command // .message // empty')" ;;
  esac
fi
[ -n "$body" ] || { [ "$state" = waiting ] && body="Waiting for input" || body="Agent finished"; }

# One clean line: drop markdown noise, collapse whitespace, cap length.
body="$(printf '%s' "$body" | tr '\n\t' '  ' | sed 's/[`*#>_]//g' | tr -s ' ' | sed 's/^ //; s/ $//')"
if [ "${#body}" -gt 120 ]; then
  body="$(printf '%s' "$body" | cut -c1-117)…"
fi

# tether-notify sits next to this wrapper; call it by path so a hook env without
# ~/.local/bin on PATH still finds it.
notify_bin="$(dirname "$0")/tether-notify"
[ -x "$notify_bin" ] || notify_bin="tether-notify"
"$notify_bin" notify \
  --title "$project · $verb" --body "$body" \
  --link "tether://session/${sess}?host=${host}" \
  --collapse "agent-${sess}" >/dev/null 2>&1 || true

# Codex parses the hook's stdout as a JSON decision; empty {} = accept. The
# other agents ignore stdout on these observe events.
[ "$agent" = codex ] && echo '{}'
exit 0
EOF
chmod +x "$WRAPPER"
echo "Installed hook wrapper: $WRAPPER"

# --- config merges (idempotent; preserve existing hooks) -----------------------

# Claude / Codex share a nested shape: hooks.<Event>[].hooks[].command.
# Strip any prior tether-notify-hook entry for that event, then add ours.
merge_nested() { # <file> <Event> <command>
  file="$1"; event="$2"; cmd="$3"
  mkdir -p "$(dirname "$file")"
  [ -f "$file" ] || echo '{}' > "$file"
  tmp="$(mktemp)"
  jq --arg ev "$event" --arg cmd "$cmd" '
    def clean(a): (a // []) | map(select(any(.hooks[]?; .command | test("tether-notify-hook")) | not));
    .hooks = ((.hooks // {}) | .[$ev] = (clean(.[$ev]) + [{hooks: [{type: "command", command: $cmd}]}]))
  ' "$file" > "$tmp" && mv "$tmp" "$file"
}

# Cursor v1: hooks.<event>[].command (flat), lowercase events.
merge_cursor() { # <file> <event> <command>
  file="$1"; event="$2"; cmd="$3"
  mkdir -p "$(dirname "$file")"
  [ -f "$file" ] || echo '{"version":1,"hooks":{}}' > "$file"
  tmp="$(mktemp)"
  jq --arg ev "$event" --arg cmd "$cmd" '
    def clean(a): (a // []) | map(select((.command // "") | test("tether-notify-hook") | not));
    .version = (.version // 1)
    | .hooks = ((.hooks // {}) | .[$ev] = (clean(.[$ev]) + [{command: $cmd}]))
  ' "$file" > "$tmp" && mv "$tmp" "$file"
}

# Claude Code — always (create if missing).
merge_nested "${HOME}/.claude/settings.json" Notification "'${WRAPPER}' claude waiting"
merge_nested "${HOME}/.claude/settings.json" Stop        "'${WRAPPER}' claude done"
echo "Registered Claude Code hooks (Notification + Stop)."

# Codex — only if it's set up on this host.
if [ -d "${HOME}/.codex" ]; then
  merge_nested "${HOME}/.codex/hooks.json" Stop              "'${WRAPPER}' codex done"
  merge_nested "${HOME}/.codex/hooks.json" PermissionRequest "'${WRAPPER}' codex waiting"
  echo "Registered Codex hooks (Stop + PermissionRequest) — Codex will ask you to TRUST the new hook on its next run."
fi

# Cursor — only if it's set up on this host.
if [ -d "${HOME}/.cursor" ]; then
  merge_cursor "${HOME}/.cursor/hooks.json" stop "'${WRAPPER}' cursor done"
  echo "Registered Cursor hook (stop)."
fi

echo
echo "Host label: ${HOST_LABEL}.  Test: printf '{}' | tether-notify-hook claude done"
