# Code Highlighting + Word Deletion — Design

Date: 2026-07-21
Board tasks: #345 (Prism highlighting), #346 (mobile hold-backspace word delete), #347 (desktop Alt+Backspace)

## Goals

1. Syntax highlighting in all code views (today: git diff views), via a reusable component.
2. Hold-backspace on iOS/Android deletes whole words once the keyboard enters word-delete mode (currently degrades to char-by-char). Android has the same bug; same fix covers both.
3. Alt+Backspace on desktop deletes the previous word.

## 1. Reusable syntax highlighting (`CodeHighlight`)

**Library:** `prism-react-renderer`. It vendors the Prism tokenizer and ships themes as JS style objects — no CSS, no DOM — so it works in React Native and in the Tauri webview build.

**New component:** `apps/mobile/src/CodeHighlight.tsx`

- Props: `code: string`, `language: string` (a Prism language id), optional base text style.
- Renders tokens as nested RN `<Text>` spans with theme colors. Monospace font and sizing inherit from the caller's base style.
- Exports `languageForPath(path: string): string | null` — extension → Prism language map (ts, tsx, js, jsx, json, rs, go, py, sh/bash, css, html, md, yaml, toml, sql, c, cpp, java, swift, kt, rb, php…). Unknown extension → `null` → caller renders plain text (current behavior).
- Theme: one dark theme matching the app's terminal palette (diff views are dark). Chosen from prism-react-renderer's built-ins closest to the current UI, overridable later.

**Integration:** `DiffLines.tsx` and `SideBySideDiff.tsx` render each line's code content through `CodeHighlight` with the language derived from the file path (available in the diff model). Existing add/remove background tints stay; highlighting only changes foreground token colors.

**Known tradeoff:** lines are tokenized per line, so multi-line constructs (block comments, template literals) can mis-highlight across line boundaries. Accepted — standard for lightweight diff viewers.

## 2. Mobile hold-backspace word deletion

**Root cause:** the hidden capture field is pinned to a zero-width sentinel, so the native keyboard's accelerated word-delete mode has no words to delete — every repeat event degrades to a single-character delete (`\x7f`). The PTY line state lives server-side, so the client cannot know word boundaries; the fix is streak detection, not field content.

**Mechanism (in `apps/mobile/src/input.ts`, pure + testable):**

- New helper: a backspace-streak tracker fed `(isSingleDelete: boolean, now: number)` per input delta.
- A streak = consecutive single-delete deltas with inter-event gap < 150 ms.
- After 15 consecutive streak deletes (≈ where iOS itself switches from chars to words), each subsequent backspace emits `\x17` (Ctrl+W, tty werase — works in bash/zsh/fish and most raw-mode apps) instead of `\x7f`.
- Streak resets on: any non-delete delta, gap ≥ 150 ms, field reset, or send of any other input.

**Wiring:** `handleChangeText` in `useTetherApp.tsx` consults the tracker before forwarding bytes. Timestamps injected (no `Date.now()` inside pure logic) for testability.

**Tests:** extend `apps/mobile/src/input.test.ts` — streak below threshold sends `\x7f`; above threshold sends `\x17`; gap resets; interleaved typing resets.

## 3. Desktop Alt+Backspace (and Ctrl+Backspace)

In `apps/mobile/src/desktopKeys.ts` `keyToBytes`, before the plain Backspace case:

- `Alt+Backspace → '\x1b\x7f'` (readline backward-kill-word — same convention as the existing Alt+Arrow word-motion mappings).
- `Ctrl+Backspace → '\x17'` (common Linux/Windows habit).

**Tests:** extend the existing `desktopKeys` tests with both combos, plus plain Backspace unchanged.

## Error handling

- Unknown language / tokenizer failure in `CodeHighlight`: catch and fall back to plain text rendering.
- Streak tracker is stateless between sessions; no persistence.

## Out of scope

- Highlighting terminal output (TermRow) — VT emulator owns that.
- Server changes — none needed; all three are client-side.
