#!/usr/bin/env bash
# Sync altstore.json with a published GitHub release.
#
#   scripts/altstore-release.sh              # latest release, changelog = release notes
#   scripts/altstore-release.sh v1.2.0       # specific tag, changelog = release notes
#   scripts/altstore-release.sh v1.2.0 "..."  # specific tag, changelog override
#
# Run AFTER publishing a release with a tether-vX.Y.Z.ipa asset: fills in the real
# IPA size/URL and prepends the version entry, then commit + push altstore.json.
set -euo pipefail

REPO="samuelloranger/tether"
TAG="${1:-}"

if [ -n "$TAG" ]; then
  REL_JSON="$(gh api "repos/$REPO/releases/tags/$TAG")"
else
  REL_JSON="$(gh api "repos/$REPO/releases/latest")"
  TAG="$(jq -r .tag_name <<<"$REL_JSON")"
  echo "latest release: $TAG"
fi
VERSION="${TAG#v}"

NOTES="${2:-$(jq -r '.body // ""' <<<"$REL_JSON")}"
[ -n "${NOTES// /}" ] || NOTES="See the release notes on GitHub."

# Asset is named tether-vX.Y.Z.ipa; fall back to any .ipa on the release.
ASSET_JSON="$(jq --arg name "tether-$TAG.ipa" '
  (.assets[] | select(.name == $name)) // (.assets[] | select(.name | endswith(".ipa")))
  | {size, url: .browser_download_url}' <<<"$REL_JSON")"
[ -n "$ASSET_JSON" ] || {
  echo "no .ipa asset on release $TAG" >&2
  exit 1
}
SIZE="$(jq -r .size <<<"$ASSET_JSON")"
URL="$(jq -r .url <<<"$ASSET_JSON")"
DATE="$(jq -r '.published_at[:10]' <<<"$REL_JSON")"

jq --arg v "$VERSION" --arg d "$DATE" --arg url "$URL" \
  --argjson size "$SIZE" --arg notes "$NOTES" '
  .apps[0].versions |= ([{
    version: $v, date: $d, localizedDescription: $notes,
    downloadURL: $url, size: $size, minOSVersion: "15.1"
  }] + map(select(.version != $v)))
' altstore.json >altstore.json.tmp && mv altstore.json.tmp altstore.json

echo "altstore.json updated: $VERSION ($SIZE bytes) -> $URL"
echo "now: git add altstore.json && git commit -m 'altstore: $TAG' && git push"
