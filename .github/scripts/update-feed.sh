#!/usr/bin/env bash
# Points one desktop update feed at a freshly packed version.
#
#   update-feed.sh <feed> <os> <channel> <version> <dir> [<installer> <published name>]
#
#   feed       the rolling release installed apps read: windows-feed or linux-feed
#              (FEED_URL in clients/desktop/crates/tether-app/src/updates.rs)
#   os         win or linux, Velopack's default channel name for that OS
#   channel    stable or edge. Stable packages sit on the default channel (releases.<os>.json),
#              edge ones on <os>-edge (releases.<os>-edge.json); both share the feed release.
#   version    the version just packed
#   dir        holds the vpk output: releases.<channel>.json and the *-full.nupkg it lists
#   installer  optional file uploaded to the feed under <published name>, replacing the last one
#
# Rules, per channel: never move the feed backwards (runs can finish out of order), and
# keep the package the previous json named, so a client that read the old feed can still
# download it. Every other package no json refers to is deleted.
#
# Needs gh (with GH_REPO and GH_TOKEN) and jq.
set -euo pipefail

# 0 when $1 is a newer version than $2 on this channel. Stable versions are X.Y.Z; edge
# versions are X.Y.Z-main.N where N is the workflow's run number, which only ever grows, so
# it alone orders them even across a version bump.
is_newer() {
  local channel=$1 new=$2 old=$3
  [ "$new" != "$old" ] || return 1
  if [ "$channel" = edge ]; then
    [ "${new##*.}" -gt "${old##*.}" ]
  else
    [ "$(printf '%s\n%s\n' "$old" "$new" | sort -V | tail -1)" = "$new" ]
  fi
}

# Highest version a releases.*.json lists.
json_version() {
  jq -r '.Assets[].Version' "$1" | sort -V | tail -1
}

# Package file names a releases.*.json refers to.
json_files() {
  jq -r '.Assets[].FileName' "$1"
}

main() {
  local feed=$1 os=$2 channel=$3 version=$4 dir=$5 installer=${6:-} published=${7:-}
  local vchannel=$os
  [ "$channel" = edge ] && vchannel="$os-edge"
  local json="releases.$vchannel.json"
  [ -f "$dir/$json" ] || { echo "no $json in $dir" >&2; return 1; }

  local work
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' RETURN

  if ! gh release view "$feed" >/dev/null 2>&1; then
    gh release create "$feed" --prerelease --latest=false --target "${GITHUB_SHA:-main}" \
      --title "$feed" \
      --notes "Read by installed desktop apps to find updates. Download Tether from the latest release instead."
  fi

  local current="" old_files=""
  if gh release download "$feed" -p "$json" -O "$work/current.json" 2>/dev/null; then
    current="$(json_version "$work/current.json")"
    old_files="$(json_files "$work/current.json")"
  fi
  if [ -n "$current" ] && ! is_newer "$channel" "$version" "$current"; then
    echo "$feed already serves $current on $vchannel, not older than $version; leaving it."
    return 0
  fi

  local f
  while read -r f; do
    gh release upload "$feed" "$dir/$f" --clobber
  done < <(json_files "$dir/$json")
  if [ -n "$installer" ]; then
    cp "$installer" "$work/$published"
    gh release upload "$feed" "$work/$published" --clobber
  fi
  # Last: until the json moves, clients keep reading the previous version.
  gh release upload "$feed" "$dir/$json" --clobber
  echo "$feed now serves $version on $vchannel"

  # Keep what any channel's json refers to now, plus what this channel's json named before.
  local assets keep="$old_files"
  assets="$(gh release view "$feed" --json assets -q '.assets[].name')"
  while read -r f; do
    gh release download "$feed" -p "$f" -O "$work/$f" --clobber
    keep+=$'\n'"$(json_files "$work/$f")"
  done < <(grep -E '^releases\..+\.json$' <<< "$assets" || true)
  while read -r f; do
    [ -n "$f" ] || continue
    if ! grep -qxF -- "$f" <<< "$keep"; then
      gh release delete-asset "$feed" "$f" --yes
      echo "removed $f"
    fi
  done < <(grep -E -- '-full\.nupkg$' <<< "$assets" || true)
}

# Sourced by the tests for is_newer; run directly by release.yml.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
