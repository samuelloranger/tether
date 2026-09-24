#!/usr/bin/env python3
"""Regenerates TetherKit's bundled terminal themes from an iTerm2-Color-Schemes checkout.

    python3 scripts/generate-terminal-themes.py <path/to/iTerm2-Color-Schemes>

Reads the Ghostty-format files in `ghostty/` for the names below and writes
clients/apple/TetherKit/Sources/TetherKit/Resources/TerminalThemes.json.
"""
import json
import pathlib
import sys
import unicodedata

# Shown in this order; (display name, file name in ghostty/).
THEMES = [
    ("Catppuccin Mocha", "Catppuccin Mocha"),
    ("Catppuccin Macchiato", "Catppuccin Macchiato"),
    ("Catppuccin Frappé", "Catppuccin Frappe"),
    ("Catppuccin Latte", "Catppuccin Latte"),
    ("Dracula", "Dracula"),
    ("Tokyo Night", "TokyoNight"),
    ("Tokyo Night Storm", "TokyoNight Storm"),
    ("Tokyo Night Day", "TokyoNight Day"),
    ("Rosé Pine", "Rose Pine"),
    ("Rosé Pine Moon", "Rose Pine Moon"),
    ("Rosé Pine Dawn", "Rose Pine Dawn"),
    ("Gruvbox Dark", "Gruvbox Dark"),
    ("Gruvbox Light", "Gruvbox Light"),
    ("Nord", "Nord"),
    ("Nord Light", "Nord Light"),
    ("Kanagawa Wave", "Kanagawa Wave"),
    ("Kanagawa Dragon", "Kanagawa Dragon"),
    ("Everforest Dark", "Everforest Dark Med"),
    ("Everforest Light", "Everforest Light Med"),
    ("Solarized Dark", "iTerm2 Solarized Dark"),
    ("Solarized Light", "iTerm2 Solarized Light"),
    ("One Dark", "Atom One Dark"),
    ("One Light", "Atom One Light"),
    ("GitHub Dark", "GitHub Dark Default"),
    ("GitHub Light", "GitHub Light Default"),
    ("Monokai Pro", "Monokai Pro"),
    ("Night Owl", "Night Owl"),
    ("Ayu", "Ayu"),
    ("Ayu Mirage", "Ayu Mirage"),
    ("Ayu Light", "Ayu Light"),
    ("Flexoki Dark", "Flexoki Dark"),
    ("Flexoki Light", "Flexoki Light"),
    ("Oxocarbon", "Oxocarbon"),
    ("Poimandres", "Poimandres"),
    ("Vesper", "Vesper"),
    ("Horizon", "Horizon"),
    ("Iceberg", "Iceberg Dark"),
    ("Material Ocean", "Material Ocean"),
    ("Melange", "Melange Dark"),
    ("Tomorrow Night", "Tomorrow Night"),
    ("Snazzy", "Snazzy"),
    ("Zenburn", "Zenburn"),
    ("Synthwave", "Synthwave"),
    ("Cyberpunk", "Cyberpunk"),
]


def slug(name: str) -> str:
    ascii_name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    return "-".join("".join(c if c.isalnum() else " " for c in ascii_name.lower()).split())


def parse(path: pathlib.Path) -> dict:
    ansi = [None] * 16
    theme = {}
    for line in path.read_text().splitlines():
        if "=" not in line:
            continue
        key, value = (part.strip() for part in line.split("=", 1))
        if key == "palette":
            index, color = value.split("=", 1)
            if int(index) < 16:
                ansi[int(index)] = color.strip().lstrip("#").upper()
        elif key in ("background", "foreground", "cursor-color", "selection-background"):
            theme[key] = value.lstrip("#").upper()
    missing = [i for i, c in enumerate(ansi) if c is None]
    if missing or "background" not in theme or "foreground" not in theme:
        raise SystemExit(f"{path.name}: incomplete theme (missing {missing or 'fg/bg'})")
    return {
        "background": theme["background"],
        "foreground": theme["foreground"],
        "cursor": theme.get("cursor-color", theme["foreground"]),
        "selection": theme.get("selection-background"),
        "ansi": ansi,
    }


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    source = pathlib.Path(sys.argv[1]) / "ghostty"
    out = pathlib.Path(__file__).resolve().parent.parent / "clients/apple/TetherKit/Sources/TetherKit/Resources/TerminalThemes.json"
    themes = [{"id": slug(name), "name": name, **parse(source / file)} for name, file in THEMES]
    out.parent.mkdir(parents=True, exist_ok=True)
    # One theme per line keeps diffs readable.
    lines = ",\n".join(" " + json.dumps(theme, ensure_ascii=False) for theme in themes)
    out.write_text("[\n" + lines + "\n]\n")
    print(f"wrote {len(themes)} themes to {out}")


if __name__ == "__main__":
    main()
