#!/usr/bin/env bash
# Sync altstore.json with a published GitHub release.
#
#   scripts/altstore-release.sh v1.0.0 ["What changed"]
#
# Run AFTER publishing a release with a tether.ipa asset: fills in the real
# IPA size and prepends the version entry, then commit + push altstore.json.
set -euo pipefail

TAG="${1:?usage: altstore-release.sh <tag> [changelog]}"
NOTES="${2:-See the release notes on GitHub.}"
REPO="samuelloranger/tether"
VERSION="${TAG#v}"

ASSET_JSON="$(gh api "repos/$REPO/releases/tags/$TAG" \
  --jq '.assets[] | select(.name == "tether.ipa") | {size, url: .browser_download_url}')"
[ -n "$ASSET_JSON" ] || {
  echo "no tether.ipa asset on release $TAG" >&2
  exit 1
}
SIZE="$(jq -r .size <<<"$ASSET_JSON")"
URL="$(jq -r .url <<<"$ASSET_JSON")"

jq --arg v "$VERSION" --arg d "$(date +%Y-%m-%d)" --arg url "$URL" \
  --argjson size "$SIZE" --arg notes "$NOTES" '
  .apps[0].versions |= ([{
    version: $v, date: $d, localizedDescription: $notes,
    downloadURL: $url, size: $size, minOSVersion: "15.1"
  }] + map(select(.version != $v)))
' altstore.json >altstore.json.tmp && mv altstore.json.tmp altstore.json

echo "altstore.json updated: $VERSION ($SIZE bytes) -> $URL"
echo "now: git add altstore.json && git commit -m 'altstore: $TAG' && git push"
