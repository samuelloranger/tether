#!/usr/bin/env bash
# Synthetic coding-agent stand-in for the background-accumulation render test.
# Real `claude` / `cursor-agent` are interactive, need auth, and are absent on
# the build host, so this reproduces what matters for the render path instead:
# a full-screen TUI that clears and repaints continuously for N seconds, ending
# in a unique sentinel line. The volume is deliberately high enough to blow past
# the per-session replay byte budget, so the switch-back path exercises the
# reset + full-tail replay branch (board #731), not just the happy path.
#
#   bash agent-generator.sh <MARKER> <SECONDS>
marker="${1:-AGENT}"
secs="${2:-30}"
end=$(( $(date +%s) + secs ))
i=0
while [ "$(date +%s)" -lt "$end" ]; do
  i=$((i + 1))
  printf '\033[H\033[2J%s frame %d\n' "$marker" "$i"
  for j in $(seq 1 20); do
    printf '  %s line %02d  tok tok tok %d\n' "$marker" "$j" "$((i * j))"
  done
  sleep 0.25
done
printf '%s_DONE_SENTINEL\n' "$marker"
