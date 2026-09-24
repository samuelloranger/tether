#!/usr/bin/env bash
# Regenerates TetherKit's bundled terminal themes from an iTerm2-Color-Schemes checkout.
#
#   bash scripts/generate-terminal-themes.sh <path/to/iTerm2-Color-Schemes>
#
# Reads the Ghostty-format files in ghostty/ for the names below and writes
# clients/apple/TetherKit/Sources/TetherKit/Resources/TerminalThemes.json.
set -euo pipefail

[ $# -eq 1 ] || { sed -n '2,7s/^# \{0,1\}//p' "$0"; exit 2; }
source_dir="$1/ghostty"
out="$(cd "$(dirname "$0")/.." && pwd)/clients/apple/TetherKit/Sources/TetherKit/Resources/TerminalThemes.json"

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

# "Rosé Pine Moon" -> "rose-pine-moon". Accents are mapped byte-wise: iconv's
# transliteration depends on the locale and fails in macOS's default one.
slug() {
  printf '%s' "$1" \
    | sed -e 's/[ÀÁÂÄàáâä]/a/g' -e 's/[ÈÉÊËèéêë]/e/g' -e 's/[ÌÍÎÏìíîï]/i/g' \
          -e 's/[ÒÓÔÖòóôö]/o/g' -e 's/[ÙÚÛÜùúûü]/u/g' -e 's/[Çç]/c/g' -e 's/[Ññ]/n/g' \
    | LC_ALL=C tr '[:upper:]' '[:lower:]' | LC_ALL=C tr -c 'a-z0-9' ' ' | tr -s ' ' \
    | sed 's/^ //; s/ $//; s/ /-/g'
}

# One JSON object per theme on one line, which keeps diffs readable.
theme_json() { # <id> <name> <file>
  awk -v id="$1" -v name="$2" -v file="$3" '
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
echo "wrote ${#themes[@]} themes to $out"
