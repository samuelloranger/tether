#!/usr/bin/env bash
# Renders the alternate app icons from clients/apple/icons/<id>.svg.
#
#   bash scripts/generate-app-icons.sh
#
# Writes TetherIOS/Assets.xcassets/AppIcon-<id>.appiconset (1024px) for each SVG, and a
# 180px AppIconPreview-<id>.png per icon (the default one included) into TetherKit's
# resources for the in-app picker. Needs Chrome or Chromium; set CHROME to pick one.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
apple="$root/clients/apple"
assets="$apple/TetherIOS/Assets.xcassets"
previews="$apple/TetherKit/Sources/TetherKit/Resources/AppIcons"

chrome="${CHROME:-}"
if [ -z "$chrome" ]; then
  for candidate in google-chrome chromium chromium-browser "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; do
    if command -v "$candidate" >/dev/null 2>&1 || [ -x "$candidate" ]; then chrome="$candidate"; break; fi
  done
fi
[ -n "$chrome" ] || { echo "Chrome or Chromium not found; set CHROME" >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# render <source file> <size> <output png>
# The source is copied next to the page so its path never needs URL-escaping.
render() {
  local source="$work/source.${1##*.}"
  cp "$1" "$source"
  printf '<html><body style="margin:0;background:#000"><img src="%s" width="%s" height="%s" style="display:block"></body></html>' \
    "$(basename "$source")" "$2" "$2" > "$work/page.html"
  "$chrome" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --window-size="$2,$2" --screenshot="$3" "file://$work/page.html" >/dev/null 2>&1
  [ -s "$3" ] || { echo "render failed: $1" >&2; exit 1; }
}

contents='{
  "images" : [
    {
      "filename" : "icon-1024.png",
      "idiom" : "universal",
      "platform" : "ios",
      "size" : "1024x1024"
    }
  ],
  "info" : {
    "author" : "xcode",
    "version" : 1
  }
}'

mkdir -p "$previews"
render "$assets/AppIcon.appiconset/icon-1024.png" 180 "$previews/AppIconPreview-default.png"

for svg in "$apple"/icons/*.svg; do
  id="$(basename "$svg" .svg)"
  set_dir="$assets/AppIcon-$id.appiconset"
  mkdir -p "$set_dir"
  printf '%s\n' "$contents" > "$set_dir/Contents.json"
  render "$svg" 1024 "$set_dir/icon-1024.png"
  render "$svg" 180 "$previews/AppIconPreview-$id.png"
  echo "AppIcon-$id"
done
