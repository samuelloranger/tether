#!/usr/bin/env bash
# Waits for the CI run of a pushed commit and exits 0 only if it succeeded.
#
#   wait-for-ci.sh <sha>
#
# The edge lane builds in parallel with CI and calls this right before anything leaves the
# runner (a TestFlight upload, an update feed), so a commit whose CI fails never ships.
# A CI run that has not been created yet is waited for too. The latest attempt counts:
# re-running a failed CI later ships through the workflow_run trigger instead.
#
# Needs gh (with GH_REPO and GH_TOKEN, and actions: read).
# WAIT_INTERVAL (seconds between checks, default 20) and WAIT_TIMEOUT (default 3600).
set -euo pipefail

SHA=${1:?usage: wait-for-ci.sh <sha>}
INTERVAL=${WAIT_INTERVAL:-20}
DEADLINE=$((SECONDS + ${WAIT_TIMEOUT:-3600}))

while :; do
  run="$(gh run list --workflow ci.yml --commit "$SHA" --event push --limit 1 \
    --json status,conclusion,url --jq '.[0] // empty | "\(.status) \(.conclusion) \(.url)"')"
  read -r status conclusion url <<< "${run:-none none none}"
  if [ "$status" = completed ]; then
    if [ "$conclusion" = success ]; then
      echo "CI passed for ${SHA:0:7}: $url"
      exit 0
    fi
    echo "::error::CI for ${SHA:0:7} ended with '$conclusion'; nothing ships from this run. $url"
    exit 1
  fi
  if [ "$SECONDS" -ge "$DEADLINE" ]; then
    echo "::error::Gave up waiting for CI on ${SHA:0:7} (last status: $status)."
    exit 1
  fi
  echo "CI for ${SHA:0:7}: $status"
  sleep "$INTERVAL"
done
