#!/usr/bin/env bash
# Build altstore.json from altstore.base.json + published GitHub Releases.
#
#   scripts/altstore-release.sh                 # write ./altstore.json
#   scripts/altstore-release.sh -o /path/out.json
#
# Versions are generated from every non-draft, non-prerelease release that has
# an .ipa asset — nothing is committed back to the tether repo. CI publishes the
# result to https://samlo.cloud/tether/altstore.json after each release.
set -euo pipefail

REPO="${TETHER_REPO_SLUG:-samuelloranger/tether}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE="$ROOT/altstore.base.json"
OUT="$ROOT/altstore.json"

while [[ $# -gt 0 ]]; do
  case $1 in
    -o|--output)
      OUT="$2"
      shift 2
      ;;
    -*)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
    *)
      echo "Unexpected argument: $1 (tag args removed — versions come from the API)" >&2
      exit 1
      ;;
  esac
done

[ -f "$BASE" ] || {
  echo "missing base manifest: $BASE" >&2
  exit 1
}

# One merged array across pages. Public repo; GH_TOKEN optional but preferred in CI.
# Write releases to a temp file so we never blow ARG_MAX with --argjson.
RELEASES_FILE="$(mktemp)"
trap 'rm -f "$RELEASES_FILE"' EXIT
gh api "repos/$REPO/releases" --paginate >"$RELEASES_FILE"

mkdir -p "$(dirname "$OUT")"
jq --slurpfile releases "$RELEASES_FILE" '
  ($releases[0]
    | map(select(.draft == false and .prerelease == false))
    | map(. as $rel
      | ($rel.assets | map(select(.name | endswith(".ipa")))) as $ipas
      | select(($ipas | length) > 0)
      | (
          ($ipas | map(select(.name == "tether.ipa")) | .[0])
          // ($ipas | map(select(.name == ("tether-" + $rel.tag_name + ".ipa"))) | .[0])
          // $ipas[0]
        ) as $asset
      | {
          version: ($rel.tag_name | ltrimstr("v")),
          date: $rel.published_at[0:10],
          localizedDescription: (
            (($rel.body // "") | gsub("^\\s+|\\s+$"; "")) as $notes
            | if $notes == "" then "See the release notes on GitHub." else $notes end
          ),
          downloadURL: $asset.browser_download_url,
          size: $asset.size,
          minOSVersion: "15.1"
        }
    )
  ) as $versions
  | .apps[0].versions = $versions
' "$BASE" >"$OUT"

COUNT="$(jq '.apps[0].versions | length' "$OUT")"
LATEST="$(jq -r '.apps[0].versions[0].version // "none"' "$OUT")"
echo "wrote $OUT ($COUNT versions, latest $LATEST)"
