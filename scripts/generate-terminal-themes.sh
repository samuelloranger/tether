#!/usr/bin/env bash
# Regenerates TetherKit's bundled terminal themes from an iTerm2-Color-Schemes checkout.
#
#   bash scripts/generate-terminal-themes.sh <path/to/iTerm2-Color-Schemes>
#
# Reads the Ghostty-format files in ghostty/ for the names below and writes
# clients/apple/TetherKit/Sources/TetherKit/Resources/TerminalThemes.json, plus the
# collection's LICENSE beside it.
#
# The bundled file was last generated from mbadolato/iTerm2-Color-Schemes at
# 9775766ab21973c7c0896587eacefe55f0f6906b (2026-09-23).
set -euo pipefail

[ $# -eq 1 ] || { sed -n '2,8s/^# \{0,1\}//p' "$0"; exit 2; }
source_dir="$1/ghostty"
out="$(cd "$(dirname "$0")/.." && pwd)/clients/apple/TetherKit/Sources/TetherKit/Resources/TerminalThemes.json"
license="${out%.json}-LICENSE.txt"

# Shown in this order: display name|file name in ghostty/.
themes=(
  "Catppuccin Mocha|Catppuccin Mocha"
  "Catppuccin Macchiato|Catppuccin Macchiato"
  "Catppuccin Frappé|Catppuccin Frappe"
  "Catppuccin Latte|Catppuccin Latte"
  "Dracula|Dracula"
  "Tokyo Night|TokyoNight"
  "Tokyo Night Storm|TokyoNight Storm"
  "Tokyo Night Day|TokyoNight Day"
  "Rosé Pine|Rose Pine"
  "Rosé Pine Moon|Rose Pine Moon"
  "Rosé Pine Dawn|Rose Pine Dawn"
  "Gruvbox Dark|Gruvbox Dark"
  "Gruvbox Light|Gruvbox Light"
  "Nord|Nord"
  "Nord Light|Nord Light"
  "Kanagawa Wave|Kanagawa Wave"
  "Kanagawa Dragon|Kanagawa Dragon"
  "Everforest Dark|Everforest Dark Med"
  "Everforest Light|Everforest Light Med"
  "Solarized Dark|iTerm2 Solarized Dark"
  "Solarized Light|iTerm2 Solarized Light"
  "One Dark|Atom One Dark"
  "One Light|Atom One Light"
  "GitHub Dark|GitHub Dark Default"
  "GitHub Light|GitHub Light Default"
  "Monokai Pro|Monokai Pro"
  "Night Owl|Night Owl"
  "Ayu|Ayu"
  "Ayu Mirage|Ayu Mirage"
  "Ayu Light|Ayu Light"
  "Flexoki Dark|Flexoki Dark"
  "Flexoki Light|Flexoki Light"
  "Oxocarbon|Oxocarbon"
  "Poimandres|Poimandres"
  "Vesper|Vesper"
  "Horizon|Horizon"
  "Iceberg|Iceberg Dark"
  "Material Ocean|Material Ocean"
  "Melange|Melange Dark"
  "Tomorrow Night|Tomorrow Night"
  "Snazzy|Snazzy"
  "Zenburn|Zenburn"
  "Synthwave|Synthwave"
  "Cyberpunk|Cyberpunk"
)

# "Rosé Pine Moon" -> "rose-pine-moon". Each accented letter is replaced as a whole byte
# sequence: bracket expressions and iconv both depend on the locale, and under LC_ALL=C a
# bracket matches each byte of "é" separately.
accents='s/à/a/g;s/á/a/g;s/â/a/g;s/ä/a/g;s/ã/a/g;s/å/a/g;s/À/a/g;s/Á/a/g;s/Â/a/g;s/Ä/a/g;s/Ã/a/g;s/Å/a/g;s/è/e/g;s/é/e/g;s/ê/e/g;s/ë/e/g;s/È/e/g;s/É/e/g;s/Ê/e/g;s/Ë/e/g;s/ì/i/g;s/í/i/g;s/î/i/g;s/ï/i/g;s/Ì/i/g;s/Í/i/g;s/Î/i/g;s/Ï/i/g;s/ò/o/g;s/ó/o/g;s/ô/o/g;s/ö/o/g;s/õ/o/g;s/ø/o/g;s/Ò/o/g;s/Ó/o/g;s/Ô/o/g;s/Ö/o/g;s/Õ/o/g;s/Ø/o/g;s/ù/u/g;s/ú/u/g;s/û/u/g;s/ü/u/g;s/Ù/u/g;s/Ú/u/g;s/Û/u/g;s/Ü/u/g;s/ç/c/g;s/Ç/c/g;s/ñ/n/g;s/Ñ/n/g'
slug() {
  printf '%s' "$1" | sed -e "$accents" \
    | LC_ALL=C tr '[:upper:]' '[:lower:]' | LC_ALL=C tr -c 'a-z0-9' ' ' | tr -s ' ' \
    | sed 's/^ //; s/ $//; s/ /-/g'
}

# One JSON object per theme on one line, which keeps diffs readable.
theme_json() { # <id> <name> <file>
  # Through the environment: `awk -v` would interpret backslashes in the values itself.
  THEME_ID="$1" THEME_NAME="$2" THEME_FILE="$3" awk '
    function json(s) { gsub(/\\/, "\\\\", s); gsub(/"/, "\\\"", s); return s }
    BEGIN { id = json(ENVIRON["THEME_ID"]); name = json(ENVIRON["THEME_NAME"]); file = ENVIRON["THEME_FILE"] }
    function hex(v) { sub(/^#/, "", v); return toupper(v) }
    {
      split($0, kv, "=")
      key = kv[1]; gsub(/ /, "", key)
      value = substr($0, index($0, "=") + 1); gsub(/ /, "", value)
      if (key == "palette") {
        split(value, entry, "=")
        if (entry[1] + 0 < 16) ansi[entry[1] + 0] = hex(entry[2])
      } else if (key == "background" || key == "foreground" || key == "cursor-color" || key == "selection-background") {
        color[key] = hex(value)
      }
    }
    END {
      for (i = 0; i < 16; i++) if (!(i in ansi)) { print file ": incomplete theme (missing palette " i ")" > "/dev/stderr"; exit 1 }
      if (!("background" in color) || !("foreground" in color)) { print file ": incomplete theme (missing fg/bg)" > "/dev/stderr"; exit 1 }
      cursor = ("cursor-color" in color) ? color["cursor-color"] : color["foreground"]
      selection = ("selection-background" in color) ? "\"" color["selection-background"] "\"" : "null"
      list = ""
      for (i = 0; i < 16; i++) list = list (i ? ", " : "") "\"" ansi[i] "\""
      printf "{\"id\": \"%s\", \"name\": \"%s\", \"background\": \"%s\", \"foreground\": \"%s\", \"cursor\": \"%s\", \"selection\": %s, \"ansi\": [%s]}", \
        id, name, color["background"], color["foreground"], cursor, selection, list
    }
  ' "$source_dir/$3"
}

mkdir -p "$(dirname "$out")"
trap 'rm -f "$out.tmp"' EXIT
{
  echo "["
  for i in "${!themes[@]}"; do
    name="${themes[$i]%%|*}"
    file="${themes[$i]#*|}"
    json="$(theme_json "$(slug "$name")" "$name" "$file")"
    printf ' %s' "$json"
    [ "$i" -lt $((${#themes[@]} - 1)) ] && echo "," || echo
  done
  echo "]"
} > "$out.tmp"
mv "$out.tmp" "$out"
cp "$1/LICENSE" "$license"
echo "wrote ${#themes[@]} themes to $out"
