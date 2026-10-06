#!/bin/sh
# Wire Claude Code, Codex, Gemini CLI and Cursor notifications to tether-notify via one hook wrapper.
# Usage: install-agent-hooks.sh [host-label]  (label shown in notifications and deep links)
set -eu

HOST_LABEL="${1:-$(hostname -s 2>/dev/null || hostname)}"
BIN_DIR="${HOME}/.local/bin"
WRAPPER="${BIN_DIR}/tether-notify-hook"

command -v jq >/dev/null 2>&1 || {
  echo "jq is required to merge the agent hook configs. Install jq and re-run." >&2
  exit 1
}
mkdir -p "$BIN_DIR"

# --- the wrapper: tether-notify-hook <agent> <waiting|done>, hook JSON on stdin ----------
# Host label is baked into the expanded heredoc; the body heredoc is quoted to stay literal.
cat > "$WRAPPER" <<EOF
#!/bin/sh
TETHER_HOOK_HOST_DEFAULT='${HOST_LABEL}'
EOF
cat >> "$WRAPPER" <<'EOF'
set -eu
agent="${1:-claude}"
state="${2:-done}"
host="${TETHER_NOTIFY_HOST:-$TETHER_HOOK_HOST_DEFAULT}"
sess="${ZMX_SESSION:-}"
case "$state" in working|waiting|done|failed|clear) ;; *) state=done ;; esac

# Codex and Gemini parse stdout as a decision ({} = accept); Cursor's beforeSubmitPrompt
# needs an explicit continue. Claude ignores stdout on these events.
reply() {
  case "$agent:$state" in
    codex:*|gemini:*) echo '{}' ;;
    cursor:working)
      case "$input" in
        *'"hook_event_name":"postToolUse"'*) echo '{}' ;;
        *) echo '{"continue": true}' ;;
      esac
      ;;
    cursor:*) echo '{}' ;;
  esac
}

notify_bin="$(dirname "$0")/tether-notify"
[ -x "$notify_bin" ] || notify_bin="tether-notify"

input="$(cat 2>/dev/null || true)"
field() { printf '%s' "$input" | jq -r "$1" 2>/dev/null || true; }

# Cursor also runs the Claude hooks from ~/.claude/settings.json; its own entries report it.
# An escaped "cursor_version" inside a prompt string carries a backslash, so it doesn't match.
if [ "$agent" = claude ]; then
  case "$input" in *'"cursor_version"'*) exit 0 ;; esac
fi

# Hot path (every tool call): no jq, no push.
if [ "$state" = working ] || [ "$state" = clear ]; then
  [ -n "$sess" ] && "$notify_bin" state --session "$sess" --agent "$agent" --state "$state" >/dev/null 2>&1 || true
  reply
  exit 0
fi

# Claude's idle reminder fires a minute after Stop; only real asks are "waiting".
if [ "$agent:$state" = claude:waiting ]; then
  case "$(field '.notification_type // empty')" in
    ""|permission_prompt|elicitation_dialog|agent_needs_input) ;;
    *) reply; exit 0 ;;
  esac
fi

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
        # Per-line fromjson? so one bad line doesn't blank the read; whole file, not a tail,
        # since a turn can end with a long run of tool calls after the final prose.
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
if [ "$state" = failed ]; then
  body="Stopped with an error"
  state_out=done
else
  state_out="$state"
fi
[ -n "$body" ] || { [ "$state_out" = waiting ] && body="Waiting for input" || body="Agent finished"; }

# One clean line: drop markdown noise, collapse whitespace, cap length.
body="$(printf '%s' "$body" | tr '\n\t' '  ' | sed 's/[`*#>_]//g' | tr -s ' ' | sed 's/^ //; s/ $//')"
if [ "${#body}" -gt 120 ]; then
  body="$(printf '%s' "$body" | cut -c1-117)…"
fi

link="tether://session/${sess:-default}?host=${host}"
if [ -n "$sess" ]; then
  "$notify_bin" state --session "$sess" --agent "$agent" --state "$state_out" \
    --title "$project · $verb" --body "$body" --link "$link" >/dev/null 2>&1 || true
else
  "$notify_bin" notify --title "$project · $verb" --body "$body" --link "$link" \
    --collapse "agent-default" >/dev/null 2>&1 || true
fi

reply
exit 0
EOF
chmod +x "$WRAPPER"
echo "Installed hook wrapper: $WRAPPER"

# `tether-notify hold` builds the phone's link from this; the mod can't learn the label.
NOTIFY_HOME="${TETHER_NOTIFY_HOME:-${HOME}/.tether-notify}"
mkdir -p "$NOTIFY_HOME"
printf '%s\n' "$HOST_LABEL" > "${NOTIFY_HOME}/host-label"

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

# Claude Code — always (create if missing). Working hooks stay synchronous: an async
# PreToolUse write could land after the permission prompt's "waiting".
merge_nested "${HOME}/.claude/settings.json" UserPromptSubmit "'${WRAPPER}' claude working"
merge_nested "${HOME}/.claude/settings.json" PreToolUse       "'${WRAPPER}' claude working"
merge_nested "${HOME}/.claude/settings.json" PostToolUse      "'${WRAPPER}' claude working"
merge_nested "${HOME}/.claude/settings.json" Notification     "'${WRAPPER}' claude waiting"
merge_nested "${HOME}/.claude/settings.json" Stop             "'${WRAPPER}' claude done"
merge_nested "${HOME}/.claude/settings.json" StopFailure      "'${WRAPPER}' claude failed"
merge_nested "${HOME}/.claude/settings.json" SessionEnd       "'${WRAPPER}' claude clear"
echo "Registered Claude Code hooks."

version_at_least() { # <have> <want>, dotted numbers
  awk -v a="$1" -v b="$2" 'BEGIN {
    split(a, x, "."); split(b, y, ".")
    for (i = 1; i <= 3; i++) { if (x[i] + 0 > y[i] + 0) exit 0; if (x[i] + 0 < y[i] + 0) exit 1 }
    exit 0 }'
}

# The mod answers permission prompts from the phone with a decision instead of keys.
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
claude_version="$(claude --version 2>/dev/null | awk '{print $1}')"
if [ -n "$claude_version" ] && [ -f "${REPO_ROOT}/.claude-plugin/marketplace.json" ] \
  && version_at_least "$claude_version" 2.1.287; then
  claude plugin marketplace add "$REPO_ROOT" >/dev/null 2>&1 \
    || claude plugin marketplace update tether >/dev/null 2>&1 || true
  if claude plugin install tether@tether >/dev/null 2>&1; then
    echo "Installed the Tether mod for Claude Code."
  else
    echo "Couldn't install the Tether mod; run: claude plugin install tether@tether" >&2
  fi
elif [ -n "$claude_version" ]; then
  echo "Claude Code ${claude_version} predates mods (2.1.287); phone answers type keys instead."
fi

# Codex — only if it's set up on this host.
if [ -d "${HOME}/.codex" ]; then
  merge_nested "${HOME}/.codex/hooks.json" UserPromptSubmit  "'${WRAPPER}' codex working"
  merge_nested "${HOME}/.codex/hooks.json" PreToolUse        "'${WRAPPER}' codex working"
  merge_nested "${HOME}/.codex/hooks.json" PostToolUse       "'${WRAPPER}' codex working"
  merge_nested "${HOME}/.codex/hooks.json" PermissionRequest "'${WRAPPER}' codex waiting"
  merge_nested "${HOME}/.codex/hooks.json" Stop              "'${WRAPPER}' codex done"
  merge_nested "${HOME}/.codex/hooks.json" SessionEnd        "'${WRAPPER}' codex clear"
  echo "Registered Codex hooks — Codex will ask you to TRUST the new hooks on its next run."
fi

# Cursor — only if it's set up on this host.
if [ -d "${HOME}/.cursor" ]; then
  merge_cursor "${HOME}/.cursor/hooks.json" beforeSubmitPrompt "'${WRAPPER}' cursor working"
  merge_cursor "${HOME}/.cursor/hooks.json" stop               "'${WRAPPER}' cursor done"
  echo "Registered Cursor hooks."
fi

echo
echo "Host label: ${HOST_LABEL}.  Test: printf '{}' | tether-notify-hook claude done"
