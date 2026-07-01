# Terminal shortcuts + selectable-text view — design

Date: 2026-07-01
Scope: `apps/mobile/App.tsx` only. No server or `terminal.ts` changes.

## 1. Ctrl+letter and Shift+Tab

**Problem:** The utility bar only has dedicated `Ctrl+C` and `Ctrl+D` buttons. Any
other control code (`^Z`, `^L`, `^A`, `^R`, ...) is unreachable from the on-screen
controls. The `Tab` button only sends `\t`, with no way to send Shift+Tab.

**Design:**

- Remove the `Ctrl+C` and `Ctrl+D` buttons (`App.tsx:723-734`). Replace with a
  single toggle button labeled `Ctrl`.
- New state: `const [ctrlArmed, setCtrlArmed] = useState(false);`
- Tapping `Ctrl` toggles `ctrlArmed`. While armed, the button renders in an
  "active" style (e.g. same highlight treatment already used elsewhere for
  active/danger states) so the user can see the modifier is pending.
- In `handleKeyPress` (`App.tsx:482-487`), where single printable characters are
  currently sent as-is:
  - If `ctrlArmed` and the key is a single letter (`/^[a-zA-Z]$/`), compute the
    control code as `key.toUpperCase().charCodeAt(0) - 64` (a→1 ... z→26), send
    `String.fromCharCode(code)` instead of the literal letter, and clear
    `ctrlArmed`.
  - If `ctrlArmed` and the key is anything else (digit, punctuation, space,
    Backspace), just clear `ctrlArmed` and process the key normally — no stuck
    state, no attempted mapping for non-letters.
  - If not armed, behavior is unchanged.
- `Tab` button (`App.tsx:729`):
  - `onPress` unchanged — sends `\t`.
  - Add `onLongPress` — sends `\x1b[Z` (Shift+Tab / CSI Z, standard terminal
    escape for backwards tab). Uses `TouchableOpacity`'s built-in
    `onLongPress` (default ~500ms), no extra gesture library.
- `Esc` and the arrow cluster are unchanged.

**Out of scope:** Ctrl combos with non-letter keys (`^[`, `^\`, `^]`, `^^`, `^_`)
are not mapped — letters cover the common cases (`^C ^D ^Z ^L ^A ^E ^K ^U ^R ^W`
etc.) and adding the rest is easy to bolt on later if needed.

## 2. Fullscreen selectable-text view

**Problem:** The only way to copy terminal output today is
`handleCopyScreen` (`App.tsx:460-467`, triggered by long-press on the terminal)
which copies the entire visible+scrollback text directly to the clipboard with
no way to select a subset.

**Design:**

- Long-press the terminal (`App.tsx:681`, `onLongPress={handleCopyScreen}`)
  now opens a fullscreen modal instead of copying directly. Rename/replace
  `handleCopyScreen` accordingly (e.g. `openSelectionView`).
- New state: `const [selectionViewOpen, setSelectionViewOpen] = useState(false);`
- Modal (RN `Modal`, full screen, dark theme matching the terminal's palette):
  - Header row: title (e.g. "Select Text"), a "Copy All" button (reuses the
    existing `Clipboard.setStringAsync` call as a one-tap fallback), and a
    close (X) button that sets `selectionViewOpen` back to `false`.
  - Body: a single read-only multiline `TextInput`
    (`editable={false}`, `multiline`, monospace font, `scrollEnabled`) — the
    standard cross-platform recipe for native OS text selection on long text
    (drag-to-select + system copy menu work for free on both iOS and Android;
    a bare `Text` component doesn't support this consistently across
    platforms).
  - `value` = the same plain-text extraction already used by the old
    `handleCopyScreen`: `screen.map((r) => r.runs.map((run) => run.text).join('')).join('\n')`
    (trailing blank lines trimmed as today). `screen` already holds the full
    rendered row list including scrollback, so this covers full history, not
    just the visible viewport.
  - On open, the view should be scrolled to the bottom (most recent output)
    rather than the top. Achieved by setting the `TextInput`'s `selection`
    prop to `{ start: text.length, end: text.length }` once on open, which
    forces the native view to scroll the cursor position into view — no
    custom scroll-position tracking needed.
- No custom touch/gesture/highlight code for selection — entirely delegated to
  the native `TextInput` selection UI.

**Out of scope:** Search-within-transcript, jump-to-line, and any custom
highlight/drag-handle UI are not part of this design.

## Testing

No existing test suite covers `App.tsx` (it's UI-only, no test runner wired
up for it per `CLAUDE.md`). Verification is manual: run the app, exercise
Ctrl+letter combos, Tab/Shift+Tab, and the fullscreen selection view against a
live session.
