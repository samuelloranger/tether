# Native Terminal Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add bell, real window title, cwd tracking, cursor shape, prompt-jump navigation, hyperlinks, file upload (mobile picker + iOS/iPadOS native drag-drop + desktop drag-drop), a theme picker, a desktop font/ligature picker, and a 2-pane desktop split-view to Tether's terminal.

**Architecture:** Six stream-parsed features extend the existing OSC/CSI state machine in `apps/mobile/src/terminal.ts` (no server changes). File upload is one new Hono endpoint (`POST /api/sessions/:id/upload`) fed by three client entry points. Theme/font are new AsyncStorage-backed settings read by the render layer. Split-panes generalizes `useTetherApp`'s singleton socket/generation refs into a small 2-slot keyed structure.

**Tech Stack:** Bun + Hono (server), Expo SDK 57 / React Native 0.86 / React 19 (mobile + desktop-via-Tauri-webview), Biome (server lint/format), `tsc --noEmit` (mobile lint), hand-rolled `bun run <file>.test.ts` style tests for `terminal.ts`/mobile logic modules, `bun:test` for server modules.

## Global Constraints

- Server code: Biome — 2-space indent, single quotes, semicolons, trailing commas, width 100. Run `bun --cwd apps/server run format` before committing server changes; `bun --cwd apps/server run lint` must pass.
- Mobile code: no Biome — lint is `bun --cwd apps/mobile run lint` (`tsc --noEmit`); must pass with zero errors.
- `apps/mobile/src/terminal.ts` tests run via `bun run src/terminal.test.ts` from `apps/mobile` (plain script, throws on first failing `eq(...)`, no test-framework import) — new assertions must follow this exact existing style, appended to the file.
- Server tests use `bun:test` (`import { expect, test } from 'bun:test'`) per `apps/server/src/server/auth.test.ts` — new server tests follow that style, run via `bun --cwd apps/server test`.
- OSC 7 cwd tracking is **bash-only** for this pass (emitted from the existing `tether.bashrc` PS1 hook in `apps/server/src/server/pty.ts`). Do not add zsh/fish hooks — out of scope.
- Desktop-only features: font/ligature picker, split-panes. Do not add them to the mobile (non-`isDesktop`) UI.
- iOS/iPadOS-only: native drag-drop via `expo-drag-drop-content-view`. Do not wire it into the Android or desktop builds.
- Split-panes is **layout-split of existing sessions only** — each pane is an existing session's already-live socket/PTY, laid out side by side. Do NOT spawn new PTYs per pane, and do not build true tmux-style multi-PTY-per-session — that is explicitly out of scope.
- File upload has exactly one server endpoint (`POST /api/sessions/:id/upload`) serving all three client entry points (mobile picker, iOS/iPadOS drag-drop, desktop drag-drop). Do not create per-entry-point endpoints.
- Desktop drag-drop uses the **plain DOM `dragover`/`drop` events** (the desktop build is a Tauri webview running `react-native-web`, confirmed via `apps/mobile/src/dragRegion.ts`'s use of `data-tauri-drag-region` DOM attributes) and reads bytes via `event.dataTransfer.files[i].arrayBuffer()`. Do NOT add `@tauri-apps/plugin-fs` or a native Tauri drag-drop event listener — that route needs a new Cargo dependency, a new `capabilities/default.json` permission, and a `tauri.conf.json` change for no added benefit here.
- Out of scope (do not implement): sixel/iTerm2 inline images, non-bash shell integration, true multi-PTY split panes.
- Every mobile-app-wide handler/state added to `useTetherApp.tsx`'s returned object (line ~1143) MUST also be added to `TerminalScreen.tsx`'s destructuring assignment (line ~69) — the two lists are currently identical; forgetting one side is a silent runtime `undefined`, not a type error, because the return type is inferred.

---

## Phase 1 — Stream-parsed additions (`apps/mobile/src/terminal.ts`)

### Task 1: Bell

**Files:**
- Modify: `apps/mobile/src/terminal.ts` (fields ~line 157, `ground()` ~line 289, `reset()` ~line 172)
- Test: `apps/mobile/src/terminal.test.ts` (append)
- Modify: `apps/mobile/src/useTetherApp.tsx` (expose bell state), `apps/mobile/src/TerminalScreen.tsx` (destructure it, flash on change)

**Interfaces:**
- Produces: `TerminalEmulator.bellCount: number` (public field, increments once per BEL byte, never resets itself).

- [ ] **Step 1: Write the failing test**

Append to `apps/mobile/src/terminal.test.ts`:

```ts
// N. Bell increments a counter instead of being dropped
{
  const t = new TerminalEmulator(80, 24);
  eq(t.bellCount, 0, 'bell starts at 0');
  t.write('\x07');
  eq(t.bellCount, 1, 'bell increments on BEL');
  t.write('a\x07b\x07');
  eq(t.bellCount, 3, 'bell increments once per BEL byte');
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mobile && bun run src/terminal.test.ts`
Expected: throws `FAIL bell starts at 0` (or a TS error — `bellCount` doesn't exist yet).

- [ ] **Step 3: Implement**

In `apps/mobile/src/terminal.ts`, add a public field next to `bracketedPaste` (~line 157):

```ts
  // Set by the app via ?2004h/l (bracketed paste). Read by the UI to decide
  // whether to wrap pasted text in \x1b[200~...\x1b[201~ before sending.
  bracketedPaste = false;

  // Monotonically increasing counter, incremented once per BEL (0x07) byte. A
  // counter (not a boolean) so the UI can detect a second bell even if it
  // hasn't re-rendered since the first.
  bellCount = 0;
```

In `reset()` (~line 172-193), add alongside `this.bracketedPaste = false;`:

```ts
    this.bellCount = 0;
```

In `ground()` (~line 289-310), replace:

```ts
    } else if (code === 0x07) {
      // bell, ignore
```

with:

```ts
    } else if (code === 0x07) {
      this.bellCount++;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mobile && bun run src/terminal.test.ts`
Expected: no output, exits 0 (matches existing convention — the script only prints on failure).

- [ ] **Step 5: Wire UI reaction (flash + haptic)**

In `apps/mobile/src/useTetherApp.tsx`, find the return object (~line 1143) and add `activeBellCount: entryFor(activeId).term.bellCount,` to it (reads live off the mutable emulator field — this re-derives every render since `entryFor`/`activeId` are already render-time values, no extra state needed). Add the same name to `TerminalScreen.tsx`'s destructuring list (~line 69).

In `apps/mobile/src/TerminalScreen.tsx`, add a `useEffect` near the other terminal-state effects (search for the existing `useEffect` that watches `activeId`/`connectionStatus` for a natural insertion point) that fires a haptic + brief flash on change:

```ts
  const prevBellCount = useRef(0);
  const [bellFlash, setBellFlash] = useState(false);
  useEffect(() => {
    if (activeBellCount > prevBellCount.current) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      setBellFlash(true);
      const t = setTimeout(() => setBellFlash(false), 150);
      return () => clearTimeout(t);
    }
    prevBellCount.current = activeBellCount;
  }, [activeBellCount]);
```

Render the flash as a thin absolutely-positioned overlay over `styles.terminalContainer` (`backgroundColor: '#ef4444', opacity: bellFlash ? 0.12 : 0`) — add it as the first child inside the `KeyboardAvoidingView` returned from `TerminalScreen`.

- [ ] **Step 6: Verify manually**

No automated test exists for RN component rendering in this repo (logic-only test infra). Run `bun --cwd apps/mobile run lint` (must pass), then `cd apps/mobile && npx expo run:ios --device`, connect to a session, run `printf '\a'` in the remote shell, confirm a brief red flash + haptic tick.

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/src/terminal.ts apps/mobile/src/terminal.test.ts apps/mobile/src/useTetherApp.tsx apps/mobile/src/TerminalScreen.tsx
git commit -m "feat(terminal): implement bell (BEL) as a visual+haptic flash"
```

---

### Task 2: OSC 0/2 window title

**Files:**
- Modify: `apps/mobile/src/terminal.ts` (OSC buffering infra + title, ~lines 158, 244-260, 319, 300s)
- Test: `apps/mobile/src/terminal.test.ts` (append)
- Modify: `apps/mobile/src/TerminalScreen.tsx` (TitleBar `title` prop, ~line 81)

**Interfaces:**
- Produces: `TerminalEmulator.title: string` (public field, empty until an OSC 0/2 is seen); `private dispatchOsc(buf: string): void` (new method — later tasks in this phase add more `else if` branches to it).
- Consumes (later tasks depend on this): the OSC-accumulation infrastructure added here (`oscBuf` field, buffering in the `'osc'`/`'oscEsc'` parser states).

This is the task that introduces OSC buffering — currently OSC bytes are discarded entirely (confirmed: the `'osc'` parser state only watches for the `0x07`/ESC terminator, never stores the bytes in between). Tasks 3, 5, 6 each add one more `else if` branch to `dispatchOsc`; do not duplicate the buffering infra.

- [ ] **Step 1: Write the failing test**

Append to `apps/mobile/src/terminal.test.ts` (note `E` is already defined at the top of the file as `'\x1b'`):

```ts
// N. OSC 0/2 sets the window title
{
  const t = new TerminalEmulator(80, 24);
  eq(t.title, '', 'title starts empty');
  t.write(`${E}]2;my-session${E}\\`);
  eq(t.title, 'my-session', 'OSC 2 sets title (ST terminator)');
  t.write(`${E}]0;another\x07`);
  eq(t.title, 'another', 'OSC 0 sets title (BEL terminator)');
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mobile && bun run src/terminal.test.ts`
Expected: TS error (`title` doesn't exist) or `FAIL title starts empty`.

- [ ] **Step 3: Implement OSC buffering + title**

In `apps/mobile/src/terminal.ts`, add fields next to `private intermediate = '';` (~line 164):

```ts
  private state: ParserState = 'ground';
  private params = '';
  private intermediate = '';
  private oscBuf = '';
```

Add a public field near `bellCount`:

```ts
  // Set by OSC 0 ("icon name + title") or OSC 2 ("title"). Empty until the
  // remote shell/app sends one.
  title = '';
```

In `esc(ch)` (~line 314-320), change:

```ts
      case ']':
        this.state = 'osc';
        return;
```

to:

```ts
      case ']':
        this.oscBuf = '';
        this.state = 'osc';
        return;
```

In `write()`'s switch (~lines 260-269), change:

```ts
        case 'osc':
          if (code === 0x07) this.state = 'ground';
          else if (code === 0x1b) this.state = 'oscEsc';
          break;
        case 'oscEsc':
          this.state = 'ground'; // drop ST terminator
          break;
```

to:

```ts
        case 'osc':
          if (code === 0x07) {
            this.dispatchOsc(this.oscBuf);
            this.oscBuf = '';
            this.state = 'ground';
          } else if (code === 0x1b) {
            this.state = 'oscEsc';
          } else {
            this.oscBuf += ch;
          }
          break;
        case 'oscEsc':
          // ESC \ (ST) properly terminates; any other byte here means a
          // malformed OSC (seen in the wild from a corrupted Warp
          // shell-integration string, same failure mode as the DCS parser
          // below) — dispatch what we buffered anyway rather than drop a
          // whole title/cwd/hyperlink update.
          this.dispatchOsc(this.oscBuf);
          this.oscBuf = '';
          this.state = 'ground';
          break;
```

Add the dispatcher as a new private method, placed after `setAltScreen` and before the "Grid operations" comment (~line 550):

```ts
  // --- OSC (title, cwd, hyperlinks, shell-integration) ---
  // buf is the content between "ESC ]" and the terminator, format "Ps;Pt...".
  private dispatchOsc(buf: string) {
    const sep = buf.indexOf(';');
    const ps = sep === -1 ? buf : buf.slice(0, sep);
    const pt = sep === -1 ? '' : buf.slice(sep + 1);
    if (ps === '0' || ps === '2') {
      this.title = pt;
    }
  }
```

In `reset()`, add alongside `this.bellCount = 0;`:

```ts
    this.title = '';
    this.oscBuf = '';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mobile && bun run src/terminal.test.ts` — expect clean exit.

- [ ] **Step 5: Wire TitleBar**

In `apps/mobile/src/TerminalScreen.tsx` (~line 81-84), change:

```tsx
            <TitleBar
              isMac={isMacDesktop}
              title={activeName}
              subtitle={`${serverIp}:${port}`}
```

to:

```tsx
            <TitleBar
              isMac={isMacDesktop}
              title={entryFor(activeId).term.title || activeName}
              subtitle={`${serverIp}:${port}`}
```

(`entryFor` is already destructured from `app` at line 69 — no new prop needed. `subtitle` is updated again in Task 3.)

- [ ] **Step 6: Verify manually**

`bun --cwd apps/mobile run lint`, then run the app, `printf '\033]2;hello world\007'` in the remote shell, confirm the desktop titlebar shows "hello world" instead of the session name.

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/src/terminal.ts apps/mobile/src/terminal.test.ts apps/mobile/src/TerminalScreen.tsx
git commit -m "feat(terminal): parse OSC 0/2 and show the real window title"
```

---

### Task 3: OSC 7 cwd tracking

**Files:**
- Modify: `apps/server/src/server/pty.ts` (BASHRC array, ~lines 16-35)
- Modify: `apps/mobile/src/terminal.ts` (`dispatchOsc`, ~new branch; field)
- Test: `apps/mobile/src/terminal.test.ts` (append)
- Modify: `apps/mobile/src/TerminalScreen.tsx` (TitleBar subtitle)

**Interfaces:**
- Consumes: `dispatchOsc` from Task 2.
- Produces: `TerminalEmulator.cwd: string` — read by the file-upload tasks (7-10) as the upload destination directory, and by the TitleBar subtitle.

- [ ] **Step 1: Write the failing test**

Append to `apps/mobile/src/terminal.test.ts`:

```ts
// N. OSC 7 sets cwd from a file:// URI, stripping host + decoding percent-escapes
{
  const t = new TerminalEmulator(80, 24);
  eq(t.cwd, '', 'cwd starts empty');
  t.write(`${E}]7;file://myhost/home/sam/My%20Project${E}\\`);
  eq(t.cwd, '/home/sam/My Project', 'OSC 7 parses path, strips host, decodes %20');
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mobile && bun run src/terminal.test.ts` — expect a TS error (`cwd` doesn't exist) or failure.

- [ ] **Step 3: Implement**

In `apps/mobile/src/terminal.ts`, add a public field next to `title`:

```ts
  // Set by OSC 7 (shell-integration cwd report, "file://host/path"). Empty
  // until the remote shell's prompt hook has fired at least once.
  cwd = '';
```

Extend `dispatchOsc`:

```ts
  private dispatchOsc(buf: string) {
    const sep = buf.indexOf(';');
    const ps = sep === -1 ? buf : buf.slice(0, sep);
    const pt = sep === -1 ? '' : buf.slice(sep + 1);
    if (ps === '0' || ps === '2') {
      this.title = pt;
    } else if (ps === '7') {
      const m = /^file:\/\/[^/]*(\/.*)$/.exec(pt);
      if (m) this.cwd = decodeURIComponent(m[1]);
    }
  }
```

In `reset()`, add `this.cwd = '';` alongside `this.title = '';`.

In `apps/server/src/server/pty.ts`, the `BASHRC` array (~lines 16-35) currently is:

```ts
const BASHRC = [
  '[ -f ~/.bashrc ] && source ~/.bashrc',
  '_tether_pwd() {',
  ...
  '}',
  '_tether_branch() { local b; b=$(git branch --show-current 2>/dev/null); [ -n "$b" ] && printf " (%s)" "$b"; }',
  "PS1='\\[\\e[36m\\]$(_tether_pwd)\\[\\e[0m\\]\\[\\e[33m\\]$(_tether_branch)\\[\\e[0m\\] \\[\\e[32m\\]❯\\[\\e[0m\\] '",
  '',
].join('\n');
```

Add a new function after `_tether_branch` and prepend its invocation to `PS1` (wrapped in `\[...\]` so bash's line-wrap-width tracking treats the invisible OSC 7 bytes as zero-width, same as the color codes already are):

```ts
const BASHRC = [
  '[ -f ~/.bashrc ] && source ~/.bashrc',
  '_tether_pwd() {',
  '  local tilde="~" p out="" seg i=0 n',
  '  p="${PWD/#$HOME/$tilde}"', // via var so ~ is not re-expanded back to $HOME
  '  local -a parts',
  '  IFS=/ read -ra parts <<< "$p"',
  '  n=${#parts[@]}',
  '  for seg in "${parts[@]}"; do',
  '    i=$((i+1))',
  '    if [ $i -lt $n ] && [ -n "$seg" ]; then',
  '      if [[ $seg == .* ]]; then out+="${seg:0:2}"; else out+="${seg:0:1}"; fi',
  '    else',
  '      out+="$seg"',
  '    fi',
  '    [ $i -lt $n ] && out+="/"',
  '  done',
  '  printf "%s" "$out"',
  '}',
  '_tether_branch() { local b; b=$(git branch --show-current 2>/dev/null); [ -n "$b" ] && printf " (%s)" "$b"; }',
  '_tether_osc7() { printf "\\e]7;file://%s%s\\a" "$(hostname)" "$PWD"; }',
  "PS1='\\[$(_tether_osc7)\\]\\[\\e[36m\\]$(_tether_pwd)\\[\\e[0m\\]\\[\\e[33m\\]$(_tether_branch)\\[\\e[0m\\] \\[\\e[32m\\]❯\\[\\e[0m\\] '",
  '',
].join('\n');
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mobile && bun run src/terminal.test.ts` — expect clean exit.

- [ ] **Step 5: Wire TitleBar subtitle**

In `apps/mobile/src/TerminalScreen.tsx`, the block edited in Task 2 becomes:

```tsx
            <TitleBar
              isMac={isMacDesktop}
              title={entryFor(activeId).term.title || activeName}
              subtitle={entryFor(activeId).term.cwd || `${serverIp}:${port}`}
```

- [ ] **Step 6: Verify manually**

Restart the dev server (`bun dev:server`) so the regenerated `tether.bashrc` takes effect, reconnect a session, `cd /tmp`, confirm the desktop titlebar subtitle updates to `/tmp` after the next prompt draw.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/server/pty.ts apps/mobile/src/terminal.ts apps/mobile/src/terminal.test.ts apps/mobile/src/TerminalScreen.tsx
git commit -m "feat(terminal): track live cwd via OSC 7 shell integration"
```

---

### Task 4: DECSCUSR cursor shape

**Files:**
- Modify: `apps/mobile/src/terminal.ts` (fields; `dispatchCsi`, ~line 386-391; `reset()`)
- Modify: `apps/mobile/src/TermRow.tsx` (`runToStyle`, cursor rendering)
- Modify: `apps/mobile/src/useTetherApp.tsx` (`renderRow`, ~line 1079-1089)
- Test: `apps/mobile/src/terminal.test.ts` (append)

**Interfaces:**
- Produces: `TerminalEmulator.cursorStyle: 'block' | 'bar' | 'underline'`, `TerminalEmulator.cursorBlink: boolean`.

- [ ] **Step 1: Write the failing test**

Append to `apps/mobile/src/terminal.test.ts`:

```ts
// N. DECSCUSR sets cursor shape/blink
{
  const t = new TerminalEmulator(80, 24);
  eq(t.cursorStyle, 'block', 'default cursor shape is block');
  eq(t.cursorBlink, true, 'default cursor blinks');
  t.write(`${E}[5 q`);
  eq(t.cursorStyle, 'bar', 'Ps=5 -> blinking bar');
  eq(t.cursorBlink, true, 'Ps=5 -> blink on');
  t.write(`${E}[4 q`);
  eq(t.cursorStyle, 'underline', 'Ps=4 -> steady underline');
  eq(t.cursorBlink, false, 'Ps=4 -> blink off (even Ps = steady)');
  t.write(`${E}[2 q`);
  eq(t.cursorStyle, 'block', 'Ps=2 -> steady block');
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mobile && bun run src/terminal.test.ts` — expect a TS error or failure.

- [ ] **Step 3: Implement parser**

Add public fields next to `cursorVisible` (~line 148):

```ts
  // DECSCUSR (CSI Ps SP q) cursor shape + blink. Read by TermRow to render the
  // caret; defaults match a real terminal's power-on default (blinking block).
  cursorStyle: 'block' | 'bar' | 'underline' = 'block';
  cursorBlink = true;
```

In `dispatchCsi` (~line 386-391), the method currently starts:

```ts
  private dispatchCsi(final: string) {
    // Sequences with intermediate bytes (CSI Ps SP q cursor style, CSI Ps SP A
    // scroll-right, CSI ! p soft reset, ...) share final bytes with plain ANSI
    // actions but mean something else entirely. None are implemented — ignore
    // them wholesale rather than misdispatch (SP A would run as cursor-up).
    if (this.intermediate) return;
```

Change to:

```ts
  private dispatchCsi(final: string) {
    // DECSCUSR: CSI Ps SP q — cursor shape/blink. Handled before the generic
    // intermediate-byte bail-out below (this is the one intermediate-byte
    // sequence we do implement).
    if (this.intermediate === ' ' && final === 'q') {
      const n = this.nums(0)[0] ?? 0;
      this.cursorStyle = n <= 2 ? 'block' : n <= 4 ? 'underline' : 'bar';
      this.cursorBlink = n === 0 || n % 2 === 1;
      return;
    }
    // Sequences with intermediate bytes (CSI Ps SP A scroll-right, CSI ! p
    // soft reset, ...) share final bytes with plain ANSI actions but mean
    // something else entirely. None of the rest are implemented — ignore
    // them wholesale rather than misdispatch (SP A would run as cursor-up).
    if (this.intermediate) return;
```

In `reset()`, add:

```ts
    this.cursorStyle = 'block';
    this.cursorBlink = true;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mobile && bun run src/terminal.test.ts` — expect clean exit.

- [ ] **Step 5: Render the shape**

In `apps/mobile/src/TermRow.tsx`, change `runToStyle`'s signature and caret branch:

```tsx
function runToStyle(
  s: CellStyle,
  caretOn: boolean,
  cursorStyle: 'block' | 'bar' | 'underline',
): TextStyle {
  const style: TextStyle = {};
  if (s.fg) style.color = s.fg;
  if (s.bg) style.backgroundColor = s.bg;
  if (s.bold) style.fontWeight = 'bold';
  if (s.dim) style.opacity = 0.55;
  if (s.italic) style.fontStyle = 'italic';
  if (s.underline && s.strike) style.textDecorationLine = 'underline line-through';
  else if (s.underline) style.textDecorationLine = 'underline';
  else if (s.strike) style.textDecorationLine = 'line-through';
  if (s.caret && caretOn) {
    if (cursorStyle === 'bar') {
      style.borderLeftWidth = 2;
      style.borderLeftColor = '#818cf8';
    } else if (cursorStyle === 'underline') {
      style.textDecorationLine = 'underline';
      style.textDecorationColor = '#818cf8';
    } else {
      // Block caret: accent background, dark glyph for contrast.
      style.backgroundColor = '#818cf8';
      style.color = '#0b0f19';
    }
  }
  return style;
}
```

Add a `cursorStyle` prop to the `TermRow` component (props destructure + type, right after `blinkOn`):

```tsx
    row,
    fontSize,
    lineHeight,
    width,
    blinkOn,
    cursorStyle,
  }: {
    row: RenderRow;
    fontSize: number;
    lineHeight: number;
    width: number;
    blinkOn: boolean;
    cursorStyle: 'block' | 'bar' | 'underline';
  }) {
```

and pass it through at the call site inside the component:

```tsx
            const st = runToStyle(run.style, blinkOn, cursorStyle);
```

Update the `React.memo` comparator at the bottom to also compare `cursorStyle`:

```tsx
  (prev, next) =>
    prev.row === next.row &&
    prev.fontSize === next.fontSize &&
    prev.lineHeight === next.lineHeight &&
    prev.width === next.width &&
    prev.cursorStyle === next.cursorStyle &&
    (prev.blinkOn === next.blinkOn || !rowHasCaret(next.row)),
```

- [ ] **Step 6: Thread the prop through `renderRow`**

In `apps/mobile/src/useTetherApp.tsx` (~line 1079-1089):

```ts
  const renderRow = useCallback(
    ({ item }: { item: RenderRow }) => (
      <TermRow
        row={item}
        fontSize={fontSize}
        lineHeight={lineHeight}
        width={gridWidth}
        blinkOn={blinkOn}
        cursorStyle={entryFor(activeId).term.cursorStyle}
      />
    ),
    [fontSize, lineHeight, gridWidth, blinkOn, activeId, entryFor],
  );
```

- [ ] **Step 7: Verify manually**

`bun --cwd apps/mobile run lint`, run the app, `printf '\033[3 q'` then move the cursor — confirm an underline caret instead of the default block; `printf '\033[0 q'` to restore.

- [ ] **Step 8: Commit**

```bash
git add apps/mobile/src/terminal.ts apps/mobile/src/terminal.test.ts apps/mobile/src/TermRow.tsx apps/mobile/src/useTetherApp.tsx
git commit -m "feat(terminal): support DECSCUSR cursor shape (block/bar/underline)"
```

---

### Task 5: OSC 133 prompt markers (jump to prev/next command)

**Files:**
- Modify: `apps/mobile/src/terminal.ts` (`RenderRow` type; `dispatchOsc`; `getSnapshot`; new field + method)
- Test: `apps/mobile/src/terminal.test.ts` (append)
- Modify: `apps/mobile/src/useTetherApp.tsx` (jump helper + expose to UI)
- Modify: `apps/mobile/src/OverflowMenu.tsx` (menu entries), `apps/mobile/src/TerminalScreen.tsx` (wire the new menu callbacks + destructure)

**Interfaces:**
- Consumes: `dispatchOsc` (Task 2), `RenderRow` (existing type, extended here).
- Produces: `RenderRow.promptStart: boolean`; `TerminalEmulator.jumpToPrompt(fromRow: number, dir: 1 | -1): number | null` (returns the row index of the next/prev prompt-start row, or `null` if none).

Semantics: OSC 133 subcommands — `A` = prompt start (mark the current cursor row), `B` = end of prompt / command starts, `C` = command output starts, `D[;exitcode]` = command finished. This task only needs `A` (for jump-to-prompt nav); it also records the exit code arriving via `D` so it can be attached to the *next* `A` row for a future "tint prompt by exit status" consumer — not otherwise used in this task, don't build a UI for it (YAGNI — a menu entry to jump is the concrete requirement).

- [ ] **Step 1: Write the failing test**

Append to `apps/mobile/src/terminal.test.ts`:

```ts
// N. OSC 133 marks prompt-start rows for jump navigation
{
  const t = new TerminalEmulator(80, 24);
  t.write(`${E}]133;A${E}\\$ `); // prompt row 0
  t.write('ls\r\n');            // row 1: command echo
  t.write('file.txt\r\n');      // row 2: output
  t.write(`${E}]133;A${E}\\$ `); // prompt row 3
  const rows = t.getSnapshot();
  eq(rows[0].promptStart, true, 'row 0 is a prompt row');
  eq(rows[1].promptStart, false, 'row 1 is not a prompt row');
  eq(rows[3].promptStart, true, 'row 3 is a prompt row');
  eq(t.jumpToPrompt(3, -1), 0, 'jump backward from row 3 finds row 0');
  eq(t.jumpToPrompt(0, 1), 3, 'jump forward from row 0 finds row 3');
  eq(t.jumpToPrompt(0, -1), null, 'jump backward from the first prompt finds nothing');
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mobile && bun run src/terminal.test.ts` — expect a TS error (`promptStart`/`jumpToPrompt` don't exist).

- [ ] **Step 3: Implement**

In `apps/mobile/src/terminal.ts`, extend the `RenderRow` interface (~line 35-42):

```ts
export interface RenderRow {
  runs: RenderRun[];
  // True when this row's logical line continues on the next row (soft-wrap, not
  // a real newline) — used to rejoin URLs split across the grid width.
  wrapped: boolean;
  // Link spans (column ranges → full URL) resolved across any soft-wrapped rows.
  links: LinkSpan[];
  // True when OSC 133;A (shell-integration prompt-start) marked this row.
  promptStart: boolean;
}
```

Add a field next to `wrappedLines` (~line 121-124), reusing the exact same WeakSet-keyed-on-the-line-array pattern (so prompt marks naturally follow their row through scrollback/splice, with no parallel index bookkeeping):

```ts
  private promptRows = new WeakSet<Cell[]>();
  private lastExitCode: number | null = null;
```

Extend `dispatchOsc`:

```ts
    } else if (ps === '133') {
      if (pt.startsWith('A')) {
        this.promptRows.add(this.screen[this.cy]);
      } else if (pt.startsWith('D')) {
        const codeStr = pt.split(';')[1];
        this.lastExitCode = codeStr !== undefined ? parseInt(codeStr, 10) : null;
      }
    }
```

In `getSnapshot()` (~lines 726-750), add a `promptFlags` array alongside the existing `wrapped` array, fold it into the reuse comparison, and include it in the constructed `RenderRow`:

```ts
  getSnapshot(): RenderRow[] {
    const lines = [...this.scrollback, ...this.screen];
    const caretRow = this.cursorVisible ? this.scrollback.length + this.cy : -1;
    const caretCol = Math.min(this.cx, this.cols - 1);
    const rowRuns = lines.map((l, i) => this.mergeRuns(l, i === caretRow ? caretCol : -1));
    const wrapped = lines.map((l) => this.wrappedLines.has(l));
    const promptFlags = lines.map((l) => this.promptRows.has(l));
    const texts = rowRuns.map((runs) => runs.map((r) => r.text).join(''));
    const links = computeLinkSpans(texts, wrapped);
    const out: RenderRow[] = new Array(lines.length);
    for (let i = 0; i < lines.length; i++) {
      const prev = this.prevRows[i];
      out[i] =
        prev &&
        prev.wrapped === wrapped[i] &&
        prev.promptStart === promptFlags[i] &&
        runsEqual(prev.runs, rowRuns[i]) &&
        linksEqual(prev.links, links[i])
          ? prev
          : { runs: rowRuns[i], wrapped: wrapped[i], links: links[i], promptStart: promptFlags[i] };
    }
    this.prevRows = out;
    return out;
  }
```

Add the jump helper as a public method (near `getSnapshot`):

```ts
  // Returns the row index (in getSnapshot()'s combined scrollback+screen
  // coordinate space) of the next prompt-start row searching from `fromRow` in
  // direction `dir` (1 = forward, -1 = backward), or null if there is none.
  jumpToPrompt(fromRow: number, dir: 1 | -1): number | null {
    const lines = [...this.scrollback, ...this.screen];
    for (let i = fromRow + dir; i >= 0 && i < lines.length; i += dir) {
      if (this.promptRows.has(lines[i])) return i;
    }
    return null;
  }
```

In `reset()`, add:

```ts
    this.promptRows = new WeakSet();
    this.lastExitCode = null;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mobile && bun run src/terminal.test.ts` — expect clean exit.

- [ ] **Step 5: Wire jump-to-prompt navigation**

In `apps/mobile/src/useTetherApp.tsx`, add near `openSearch`/`openSelectionView` (~line 720-760):

```ts
  // Scrolls the FlatList to the nearest prompt-start row in `dir`, using the
  // currently-scrolled-to row (falls back to the last row) as the search origin.
  const jumpPrompt = (dir: 1 | -1) => {
    const term = entryFor(activeIdRef.current).term;
    const snapshot = term.getSnapshot();
    const from = dir === 1 ? 0 : snapshot.length - 1;
    const target = term.jumpToPrompt(from, dir);
    if (target === null) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    listRef.current?.scrollToIndex({ index: target, animated: true });
  };
```

Add `jumpPrompt` to the returned object (~line 1143) and to `TerminalScreen.tsx`'s destructuring (~line 69).

- [ ] **Step 6: Add menu entries**

In `apps/mobile/src/OverflowMenu.tsx`, add two props (`onJumpPromptUp`, `onJumpPromptDown`) to the component's prop type and destructure, and two rows after the existing "Search displayed transcript" row (~line 63-66):

```tsx
          <TouchableOpacity style={styles.menuRow} onPress={onSearch}>
            <Feather name="search" size={16} color="#cbd5e1" />
            <Text style={styles.menuRowText}>Search displayed transcript</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.menuRow} onPress={onJumpPromptUp}>
            <Feather name="chevron-up" size={16} color="#cbd5e1" />
            <Text style={styles.menuRowText}>Jump to previous command</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.menuRow} onPress={onJumpPromptDown}>
            <Feather name="chevron-down" size={16} color="#cbd5e1" />
            <Text style={styles.menuRowText}>Jump to next command</Text>
          </TouchableOpacity>
```

In `apps/mobile/src/TerminalScreen.tsx`, wherever `<OverflowMenu ... />` is invoked, add:

```tsx
              onJumpPromptUp={() => jumpPrompt(-1)}
              onJumpPromptDown={() => jumpPrompt(1)}
```

- [ ] **Step 7: Verify manually**

`bun --cwd apps/mobile run lint`. Note: this feature's payoff depends on the remote shell actually emitting OSC 133 — plain bash via `tether.bashrc` does not yet (only OSC 7 was added in Task 3). Verify by hand-sending the sequences: `printf '\033]133;A\033\\$ '` then run a couple of commands, then trigger the overflow menu's jump actions and confirm the list scrolls to the marked row. (Wiring bash's own prompt to actually emit 133 automatically is a natural follow-up but not required by this task — the parser/nav must work correctly regardless of who emits the sequence.)

- [ ] **Step 8: Commit**

```bash
git add apps/mobile/src/terminal.ts apps/mobile/src/terminal.test.ts apps/mobile/src/useTetherApp.tsx apps/mobile/src/OverflowMenu.tsx apps/mobile/src/TerminalScreen.tsx
git commit -m "feat(terminal): parse OSC 133 prompt markers, add jump-to-command nav"
```

---

### Task 6: OSC 8 hyperlinks

**Files:**
- Modify: `apps/mobile/src/terminal.ts` (`Cell`/`CellStyle`... actually only `Cell`; `dispatchOsc`; `getSnapshot`)
- Test: `apps/mobile/src/terminal.test.ts` (append)

**Interfaces:**
- Consumes: `dispatchOsc` (Task 2), existing `computeLinkSpans`/`LinkSpan` from `links.ts` (unchanged).
- Produces: nothing new is exported — this task only changes `getSnapshot()`'s internal link resolution to prefer explicit OSC-8 spans over the existing regex fallback. `TermRow.tsx`/`links.ts` need NO changes: they already consume whatever `LinkSpan[]` the emulator produces, regardless of source.

Design: OSC 8 sets a "current hyperlink" on the pen (like `fg`/`bg`), which flows onto cells the same way color does (`putChar` already does `{ ch, ...this.pen }`). `getSnapshot()` then builds per-row explicit spans from contiguous same-URL cell runs, and uses those in place of the regex result for any row that has at least one URL-tagged cell.

- [ ] **Step 1: Write the failing test**

Append to `apps/mobile/src/terminal.test.ts`:

```ts
// N. OSC 8 hyperlinks: explicit spans win over regex reconstruction
{
  const t = new TerminalEmulator(80, 24);
  t.write(`click ${E}]8;;https://example.com${E}\\here${E}]8;;${E}\\ done`);
  const links = t.getSnapshot()[0].links;
  eq(links.length, 1, 'exactly one link span on the row');
  eq(links[0].url, 'https://example.com', 'link carries the OSC 8 URI');
  // "click " (0-5) is not part of the link; "here" (6-9) is (starts after "click ").
  eq(links[0].start, 6, 'link starts at "here"');
  eq(links[0].end, 10, 'link ends after "here"');
}

// N+1. Plain (non-OSC-8) URLs still fall back to regex detection
{
  const t = new TerminalEmulator(80, 24);
  t.write('see https://example.com/path for details');
  const links = t.getSnapshot()[0].links;
  eq(links.length, 1, 'regex still finds a plain URL');
  eq(links[0].url, 'https://example.com/path', 'regex-detected URL is correct');
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mobile && bun run src/terminal.test.ts` — expect the first block to fail (no OSC 8 handling yet — the whole line, no link, would be detected).

- [ ] **Step 3: Implement**

In `apps/mobile/src/terminal.ts`, add `url?: string` to `Cell` only (not `CellStyle` — it must not affect `sameStyle`/`runsEqual`/run-merging for text attributes, it's link metadata, not a visual style):

```ts
interface Cell extends CellStyle {
  ch: string;
  url?: string;
}
```

Extend `dispatchOsc`:

```ts
    } else if (ps === '8') {
      // "params;URI" — params (e.g. id=xxx) is ignored; empty URI closes the link.
      const uriSep = pt.indexOf(';');
      const uri = uriSep === -1 ? '' : pt.slice(uriSep + 1);
      (this.pen as Cell).url = uri || undefined;
    }
```

(`this.pen` is typed `CellStyle`, not `Cell` — the cast is needed since `url` lives on `Cell`, not `CellStyle`, by design per the "don't pollute visual style" comment above. `putChar`'s `{ ch, ...this.pen }` spread still copies it through structurally regardless of the pen's declared type.)

In `getSnapshot()`, after computing `texts`/`wrapped`/`links` (the existing regex-based `computeLinkSpans` call), add explicit-span extraction and merge, replacing the plain `const links = computeLinkSpans(texts, wrapped);` line:

```ts
    const regexLinks = computeLinkSpans(texts, wrapped);
    const links = lines.map((line, i) => {
      const explicit = explicitLinkSpans(line);
      return explicit.length ? explicit : regexLinks[i];
    });
```

Add the helper function near `runsEqual`/`linksEqual` at the bottom of the file:

```ts
// Contiguous same-URL cell runs on one row, as LinkSpans — explicit OSC-8
// links take priority over regex URL detection for any row that has them.
function explicitLinkSpans(line: Cell[]): LinkSpan[] {
  const out: LinkSpan[] = [];
  let i = 0;
  while (i < line.length) {
    const url = line[i].url;
    if (!url) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < line.length && line[j].url === url) j++;
    out.push({ start: i, end: j, url });
    i = j;
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mobile && bun run src/terminal.test.ts` — expect clean exit.

- [ ] **Step 5: Verify manually**

`bun --cwd apps/mobile run lint`. In a session, run:
```bash
printf '\033]8;;https://example.com\033\\click me\033]8;;\033\\\n'
```
and confirm "click me" is tappable and opens `https://example.com` (via the existing `TermRow.tsx` `Linking.openURL` — unchanged by this task).

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/src/terminal.ts apps/mobile/src/terminal.test.ts
git commit -m "feat(terminal): parse OSC 8 hyperlinks, prefer explicit spans over regex"
```

---

## Phase 2 — File-upload subsystem

### Task 7: Server upload endpoint

**Files:**
- Modify: `apps/server/src/server/app.ts` (new route)
- Test: `apps/server/src/server/upload.test.ts` (new)

**Interfaces:**
- Produces: `POST /api/sessions/:id/upload` — multipart form fields `file` (the blob), `cwd` (string, absolute directory), optional `filename` override (defaults to the uploaded file's own name). Password-gated automatically (`/api/*` already runs `authMiddleware`, confirmed at `app.ts:33`). Response: `{ok: true, path: string}` on success, `{ok: false, error: string}` with 400 on bad input.
- Consumes (later tasks 8-10 call this): nothing from earlier tasks — this is the first task in Phase 2.

Path-traversal note: `cwd` and `filename` are client-supplied — the server must resolve the final path and verify it stays inside `cwd` (reject `filename` containing `/` or `..`) before writing, since a hostile client could otherwise write anywhere the server process can.

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/server/upload.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveUploadPath } from './upload';

test('resolveUploadPath joins cwd + filename', () => {
  expect(resolveUploadPath('/home/sam/project', 'photo.jpg')).toBe(
    '/home/sam/project/photo.jpg',
  );
});

test('resolveUploadPath rejects a filename that escapes cwd', () => {
  expect(() => resolveUploadPath('/home/sam/project', '../../etc/passwd')).toThrow();
  expect(() => resolveUploadPath('/home/sam/project', 'sub/dir.txt')).toThrow();
});

test('resolveUploadPath collision-suffixes an existing file', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tether-upload-test-'));
  try {
    const first = resolveUploadPath(dir, 'shot.png');
    require('node:fs').writeFileSync(first, 'x');
    const second = resolveUploadPath(dir, 'shot.png');
    expect(second).not.toBe(first);
    expect(second).toBe(path.join(dir, 'shot-1.png'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && bun test upload.test.ts`
Expected: fails to resolve `./upload` (module doesn't exist yet).

- [ ] **Step 3: Implement**

Create `apps/server/src/server/upload.ts`:

```ts
import { existsSync } from 'node:fs';
import path from 'node:path';

// Resolves the on-disk path for an uploaded file inside `cwd`, rejecting any
// filename that would escape it (no path separators, no ..), and appending a
// numeric suffix ("-1", "-2", ...) before the extension if the name collides
// with an existing file.
export function resolveUploadPath(cwd: string, filename: string): string {
  if (filename.includes('/') || filename.includes('\\') || filename === '..' || filename === '.') {
    throw new Error(`invalid filename: ${filename}`);
  }
  const ext = path.extname(filename);
  const base = filename.slice(0, filename.length - ext.length);
  let candidate = path.join(cwd, filename);
  let n = 1;
  while (existsSync(candidate)) {
    candidate = path.join(cwd, `${base}-${n}${ext}`);
    n++;
  }
  return candidate;
}
```

In `apps/server/src/server/app.ts`, add the import and route. Import line (near the existing `pty` import, ~line 6):

```ts
import { resolveUploadPath } from './upload';
```

Add the route after `/api/sessions/:id/logs` (~line 92-97), following the existing `c.req.param('id')` pattern:

```ts
// Receive an uploaded file (mobile image-picker, iOS/iPadOS drag-drop, desktop
// drag-drop all funnel through here) and write it into the session's live cwd.
app.post('/api/sessions/:id/upload', async (c) => {
  const form = await c.req.formData().catch(() => null);
  if (!form) return c.json({ ok: false, error: 'invalid form data' }, 400);
  const file = form.get('file');
  const cwd = form.get('cwd');
  const filenameOverride = form.get('filename');
  if (!(file instanceof File) || typeof cwd !== 'string' || !cwd) {
    return c.json({ ok: false, error: 'missing file or cwd' }, 400);
  }
  const filename =
    typeof filenameOverride === 'string' && filenameOverride ? filenameOverride : file.name;
  let dest: string;
  try {
    dest = resolveUploadPath(cwd, filename);
  } catch (err) {
    return c.json({ ok: false, error: String(err) }, 400);
  }
  await Bun.write(dest, file);
  return c.json({ ok: true, path: dest });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/server && bun test upload.test.ts` — all 3 tests pass.

- [ ] **Step 5: Verify manually**

```bash
cd apps/server && bun run --watch src/server/index.ts
# in another shell:
curl -X POST http://localhost:8085/api/sessions/term-1/upload \
  -H "Authorization: Bearer $(tether ... )" \
  -F "cwd=/tmp" -F "file=@/etc/hostname;filename=hostname.txt"
```
Confirm `/tmp/hostname.txt` is created and the response is `{"ok":true,"path":"/tmp/hostname.txt"}`.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/server/upload.ts apps/server/src/server/upload.test.ts apps/server/src/server/app.ts
git commit -m "feat(server): add POST /api/sessions/:id/upload endpoint"
```

---

### Task 8: Mobile image-picker entry point

**Files:**
- Modify: `apps/mobile/package.json`, `apps/mobile/app.json` (new dependency + plugin)
- Modify: `apps/mobile/src/useTetherApp.tsx` (upload function)
- Modify: `apps/mobile/src/UtilityBar.tsx` (new button)
- Modify: `apps/mobile/src/TerminalScreen.tsx` (wire prop + destructure)

**Interfaces:**
- Consumes: `entryFor(id).term.cwd` (Task 3), `httpBase`/`authHeaders` (existing, used identically to `killActiveOr` at `useTetherApp.tsx:389-391`), `sendInput` (existing).
- Produces: `uploadAndInsertPath(uri: string, filename: string): Promise<void>` — shared by this task and Tasks 9-10.

- [ ] **Step 1: Add the dependency**

```bash
cd apps/mobile && npx expo install expo-image-picker
```

In `apps/mobile/app.json`, add a plugin entry with the iOS permission string (mirrors the `expo-secure-store` options-entry pattern already in the `plugins` array):

```json
    "plugins": [
      [
        "expo-splash-screen",
        {
          "image": "./assets/icon.png",
          "imageWidth": 220,
          "resizeMode": "contain",
          "backgroundColor": "#05070e"
        }
      ],
      "expo-font",
      [
        "expo-secure-store",
        {
          "faceIDPermission": false
        }
      ],
      [
        "expo-image-picker",
        {
          "photosPermission": "Tether uses your photo library to upload files to the connected server."
        }
      ]
    ],
```

- [ ] **Step 2: Implement the shared upload helper**

In `apps/mobile/src/useTetherApp.tsx`, add near `handlePaste` (~line 761-773):

```ts
  // Uploads bytes to the active session's live cwd (server writes
  // `${cwd}/${filename}`, collision-suffixed), then types the resulting path
  // into the terminal — shared by the image picker, iOS/iPadOS native
  // drag-drop, and desktop drag-drop.
  const uploadFile = async (blob: Blob, filename: string) => {
    const e = entryFor(activeIdRef.current);
    const cwd = e.term.cwd;
    if (!cwd) {
      void notify('Upload failed', 'No known working directory yet — wait for the next prompt.', 'error');
      return;
    }
    const form = new FormData();
    form.append('file', blob, filename);
    form.append('cwd', cwd);
    try {
      const res = await fetch(
        `${httpBase(serverIp, port)}/api/sessions/${activeIdRef.current}/upload`,
        { method: 'POST', headers: authHeaders(passwordRef.current), body: form },
      );
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'upload failed');
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      sendInput(data.path);
    } catch {
      void notify('Upload failed', 'Could not upload the file to the server.', 'error');
    }
  };

  const pickAndUploadImage = async () => {
    const ImagePicker = await import('expo-image-picker');
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return;
    const result = await ImagePicker.launchImageLibraryAsync({ quality: 1 });
    if (result.canceled || !result.assets[0]) return;
    const asset = result.assets[0];
    const res = await fetch(asset.uri);
    const blob = await res.blob();
    const filename = asset.fileName || `image-${Date.now()}.jpg`;
    await uploadFile(blob, filename);
  };
```

Add `uploadFile` and `pickAndUploadImage` to the returned object (~line 1143) and to `TerminalScreen.tsx`'s destructuring (~line 69). (`Date.now()` here is fine — this runs at request time in the live app, not inside a Workflow script.)

- [ ] **Step 3: Add the button**

In `apps/mobile/src/UtilityBar.tsx`, add a prop and a button next to the existing Paste button (~line 81-89):

```tsx
export function UtilityBar({
  ctrlArmed,
  setCtrlArmed,
  sendInput,
  cursorSeq,
  onPaste,
  onImagePick,
}: {
  ctrlArmed: boolean;
  setCtrlArmed: (updater: (prev: boolean) => boolean) => void;
  sendInput: (s: string) => void;
  cursorSeq: (final: string) => string;
  onPaste: () => void;
  onImagePick: () => void;
}) {
```

```tsx
        <TouchableOpacity
          style={styles.utilityIconBtn}
          activeOpacity={0.6}
          onPress={onPaste}
          accessibilityRole="button"
          accessibilityLabel="Paste"
        >
          <Feather name="clipboard" size={17} color="#cbd5e1" />
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.utilityIconBtn}
          activeOpacity={0.6}
          onPress={onImagePick}
          accessibilityRole="button"
          accessibilityLabel="Upload image"
        >
          <Feather name="image" size={17} color="#cbd5e1" />
        </TouchableOpacity>
```

In `apps/mobile/src/TerminalScreen.tsx`, wherever `<UtilityBar ... onPaste={handlePaste} ... />` is rendered, add `onImagePick={pickAndUploadImage}`.

- [ ] **Step 4: Verify manually**

`bun --cwd apps/mobile run lint`, then `npx expo run:ios --device` (new native dependency needs a rebuild — Expo Go can't load it, but this repo already doesn't use Expo Go). Tap the new image button, pick a photo, confirm it lands in the session's cwd and the path is typed into the shell.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/package.json apps/mobile/app.json apps/mobile/src/useTetherApp.tsx apps/mobile/src/UtilityBar.tsx apps/mobile/src/TerminalScreen.tsx
git commit -m "feat(mobile): upload a photo-library image into the session cwd"
```

---

### Task 9: iOS/iPadOS native drag-drop entry point

**Files:**
- Modify: `apps/mobile/package.json`, `apps/mobile/app.json`
- Modify: `apps/mobile/src/TerminalScreen.tsx` (wrap the terminal grid)

**Interfaces:**
- Consumes: `uploadFile` (Task 8).

- [ ] **Step 1: Add the dependency**

```bash
cd apps/mobile && yarn add expo-drag-drop-content-view
```

In `apps/mobile/app.json`, append the plugin (plain string entry — its docs list no required config options):

```json
      [
        "expo-image-picker",
        {
          "photosPermission": "Tether uses your photo library to upload files to the connected server."
        }
      ],
      "expo-drag-drop-content-view"
    ],
```

- [ ] **Step 2: Wrap the terminal grid**

In `apps/mobile/src/TerminalScreen.tsx`, import the component:

```ts
import { DragDropContentView } from 'expo-drag-drop-content-view';
```

Find where `terminalGrid` (from `useTetherApp`, destructured at line 69) is rendered inside the main JSX body, and wrap it — only on iOS/iPadOS, since this task is scoped to that platform (Android/desktop get no wrapper here):

```tsx
{Platform.OS === 'ios' ? (
  <DragDropContentView
    style={{ flex: 1 }}
    onDrop={(event) => {
      for (const item of event.items) {
        if (item.uri) {
          fetch(item.uri)
            .then((r) => r.blob())
            .then((blob) => uploadFile(blob, item.uri!.split('/').pop() || `drop-${Date.now()}`));
        }
      }
    }}
  >
    {terminalGrid}
  </DragDropContentView>
) : (
  terminalGrid
)}
```

(`Platform` is already imported in `TerminalScreen.tsx` per its existing import list.) Add `uploadFile` to the destructuring list if not already added by Task 8 in the same working tree (it was — this task depends on Task 8 being merged first).

- [ ] **Step 3: Verify manually**

`bun --cwd apps/mobile run lint`, `npx expo run:ios --device` on an iPad (or iPhone with another app split-screened, e.g. Files). Drag a file from Files/Photos onto the terminal view, confirm it uploads and the path is typed in.

- [ ] **Step 4: Commit**

```bash
git add apps/mobile/package.json apps/mobile/app.json apps/mobile/src/TerminalScreen.tsx
git commit -m "feat(mobile): support iOS/iPadOS native drag-drop file upload"
```

---

### Task 10: Desktop drag-drop entry point

**Files:**
- Modify: `apps/mobile/src/TerminalScreen.tsx` (DOM `dragover`/`drop` listeners)

**Interfaces:**
- Consumes: `uploadFile` (Task 8), `isDesktop` (existing, `apps/mobile/src/platform.ts`).

Per the global constraint above: this uses the plain DOM drop event (the desktop build already runs as a `react-native-web` Tauri webview — confirmed via `dragRegion.ts`'s `data-tauri-drag-region` DOM-attribute approach), not a native Tauri fs-plugin event. No new Tauri dependency or permission.

- [ ] **Step 1: Implement**

In `apps/mobile/src/TerminalScreen.tsx`, add a `useEffect` that attaches native DOM listeners only on desktop (mirrors how `injectDragRegionStyles()` is already called once for desktop-only DOM setup):

```ts
  useEffect(() => {
    if (!isDesktop) return;
    const el = document.getElementById('tether-terminal-dropzone');
    if (!el) return;
    const onDragOver = (e: DragEvent) => e.preventDefault();
    const onDrop = async (e: DragEvent) => {
      e.preventDefault();
      const files = e.dataTransfer?.files;
      if (!files || !files.length) return;
      for (const file of Array.from(files)) {
        await uploadFile(file, file.name);
      }
    };
    el.addEventListener('dragover', onDragOver);
    el.addEventListener('drop', onDrop);
    return () => {
      el.removeEventListener('dragover', onDragOver);
      el.removeEventListener('drop', onDrop);
    };
  }, [uploadFile]);
```

Give the terminal grid's wrapping `View` the DOM id this effect looks for. Find the `View` that wraps `terminalGrid` (the one styled `styles.terminalBody` or its direct child, per the JSX shown in Task 9) and add `nativeID="tether-terminal-dropzone"` to it — RN-web forwards `nativeID` to the DOM `id` attribute, which is how `document.getElementById` finds it.

- [ ] **Step 2: Verify manually**

`bun --cwd apps/mobile run tauri:dev`, drag a file from Finder/Explorer onto the terminal window, confirm it uploads to the session's cwd and the path is typed in.

- [ ] **Step 3: Commit**

```bash
git add apps/mobile/src/TerminalScreen.tsx
git commit -m "feat(desktop): support drag-and-drop file upload via DOM drop events"
```

---

## Phase 3 — Rendering/config

### Task 11: Theme/palette picker

**Files:**
- Modify: `apps/mobile/src/terminal.ts` (make palette/defaults settable)
- Test: `apps/mobile/src/terminal.test.ts` (append)
- Create: `apps/mobile/src/themes.ts`
- Modify: `apps/mobile/src/SessionModals.tsx` (new `AppearanceModal`)
- Modify: `apps/mobile/src/OverflowMenu.tsx`, `apps/mobile/src/TerminalScreen.tsx`, `apps/mobile/src/useTetherApp.tsx`

**Interfaces:**
- Produces: `setTheme(id: string): void` (module-level function in `terminal.ts`), `THEMES: Record<string, Theme>` (`themes.ts`), `TerminalEmulator`-module state becomes theme-aware (existing `PALETTE`/`DEFAULT_FG`/`DEFAULT_BG` module consts become mutable, reassigned by `setTheme`).

- [ ] **Step 1: Write the failing test**

Append to `apps/mobile/src/terminal.test.ts`:

```ts
// N. setTheme swaps the ANSI palette + default fg/bg used by new writes
{
  const t = new TerminalEmulator(80, 24);
  setTheme('default');
  t.write(`${E}[31mred${E}[0m`);
  const defaultRed = t.getSnapshot()[0].runs[0].style.fg;

  const t2 = new TerminalEmulator(80, 24);
  setTheme('dracula');
  t2.write(`${E}[31mred${E}[0m`);
  const draculaRed = t2.getSnapshot()[0].runs[0].style.fg;

  eq(defaultRed !== draculaRed, true, 'switching theme changes how SGR 31 resolves');
  setTheme('default'); // restore for any tests that run after this one in-process
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mobile && bun run src/terminal.test.ts` — expect a TS error (`setTheme` doesn't exist).

- [ ] **Step 3: Implement**

In `apps/mobile/src/terminal.ts`, change the module-level consts (~lines 44-69) from `const` to reassignable, and export a setter:

```ts
let DEFAULT_FG = '#cbd5e1';
let DEFAULT_BG = '#05070e';
const MAX_SCROLLBACK = 1000;

// Standard 16-color terminal palette (VS Code integrated-terminal values),
// extended to xterm-256. Using conventional colors so themed TUIs look correct.
// Mutable: setTheme() below replaces BASE_16/PALETTE/DEFAULT_FG/DEFAULT_BG at
// runtime so an active session re-colors on its next repaint without needing a
// fresh TerminalEmulator instance.
let BASE_16 = [
  '#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5',
  '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff',
];

function buildPalette(): string[] {
  const pal = [...BASE_16];
  const steps = [0, 95, 135, 175, 215, 255];
  const hex = (n: number) => n.toString(16).padStart(2, '0');
  for (let r = 0; r < 6; r++)
    for (let g = 0; g < 6; g++)
      for (let b = 0; b < 6; b++)
        pal.push(`#${hex(steps[r])}${hex(steps[g])}${hex(steps[b])}`);
  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10;
    pal.push(`#${hex(v)}${hex(v)}${hex(v)}`);
  }
  return pal; // length 256
}
let PALETTE = buildPalette();

export interface Theme {
  base16: string[]; // exactly 16 hex colors, same order as the old BASE_16
  fg: string;
  bg: string;
}

// Applies a theme by name (see themes.ts for the THEMES registry) — rebuilds
// the 256-color PALETTE from the theme's 16 base colors and swaps the default
// fg/bg used by cells with no explicit SGR color.
export function setTheme(theme: Theme) {
  BASE_16 = theme.base16;
  PALETTE = buildPalette();
  DEFAULT_FG = theme.fg;
  DEFAULT_BG = theme.bg;
}
```

`cellStyle()` (~line 692) already reads the module-level `DEFAULT_FG`/`DEFAULT_BG` by name, and `applySgr()` already reads `PALETTE` by name — since both are now `let` instead of `const`, no other line in the file needs to change; every read picks up the latest assignment automatically.

Create `apps/mobile/src/themes.ts`:

```ts
import type { Theme } from './terminal';

export const THEMES: Record<string, Theme> = {
  default: {
    base16: [
      '#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5',
      '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff',
    ],
    fg: '#cbd5e1',
    bg: '#05070e',
  },
  dracula: {
    base16: [
      '#21222c', '#ff5555', '#50fa7b', '#f1fa8c', '#bd93f9', '#ff79c6', '#8be9fd', '#f8f8f2',
      '#6272a4', '#ff6e6e', '#69ff94', '#ffffa5', '#d6acff', '#ff92df', '#a4ffff', '#ffffff',
    ],
    fg: '#f8f8f2',
    bg: '#282a36',
  },
  'solarized-dark': {
    base16: [
      '#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5',
      '#002b36', '#cb4b16', '#586e75', '#657b83', '#839496', '#6c71c4', '#93a1a1', '#fdf6e3',
    ],
    fg: '#839496',
    bg: '#002b36',
  },
};

export const THEME_IDS = Object.keys(THEMES) as (keyof typeof THEMES)[];
```

- [ ] **Step 4: Run test to verify it passes**

The test appended in Step 1 calls `setTheme('default')`/`setTheme('dracula')` (by id string) but the implementation's `setTheme` takes a `Theme` object — fix the test to match the real signature (theme lookup belongs to the app layer, not `terminal.ts`, which stays theme-registry-agnostic):

```ts
// N. setTheme swaps the ANSI palette + default fg/bg used by new writes
{
  const t = new TerminalEmulator(80, 24);
  setTheme({ base16: Array(16).fill('#111111'), fg: '#eeeeee', bg: '#000000' });
  t.write(`${E}[31mred${E}[0m`);
  eq(t.getSnapshot()[0].runs[0].style.fg, '#111111', 'SGR 31 resolves through the new base16');
  setTheme({
    base16: [
      '#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5',
      '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff',
    ],
    fg: '#cbd5e1',
    bg: '#05070e',
  }); // restore defaults so later tests in this same process see the original palette
}
```

Also add `setTheme` to the test file's import line: `import { TerminalEmulator, setTheme } from './terminal';`.

Run: `cd apps/mobile && bun run src/terminal.test.ts` — expect clean exit.

- [ ] **Step 5: Persist + surface the picker**

In `apps/mobile/src/useTetherApp.tsx`, add a new AsyncStorage key alongside `KEY_FONT` (`apps/mobile/src/TerminalScreen.tsx:59`, actually declared in `TerminalScreen.tsx` — move/add a matching one in `useTetherApp.tsx` where the other `KEY_*` constants for persisted state live) — add `const KEY_THEME = 'tether_theme';` and load/persist it the same way `fontSize` already is (search for the existing `AsyncStorage.getItem(KEY_FONT)`/`setItem` pair and mirror it 1:1 for theme, calling `setTheme(THEMES[id])` from `./themes` whenever the stored id changes). Add `themeId`/`setThemeId` to the returned object and `TerminalScreen.tsx`'s destructuring.

Add an `AppearanceModal` to `apps/mobile/src/SessionModals.tsx`, mirroring `RenameModal`'s exact structure (Modal + Pressable backdrop + Pressable panel):

```tsx
import { THEME_IDS, THEMES } from './themes';

// Theme picker (+ desktop font picker — added in Task 12).
export function AppearanceModal({
  visible,
  onClose,
  themeId,
  onThemeChange,
}: {
  visible: boolean;
  onClose: () => void;
  themeId: string;
  onThemeChange: (id: string) => void;
}) {
  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <Pressable style={styles.menuBackdrop} onPress={onClose}>
        <Pressable style={styles.renamePanel} onPress={() => {}}>
          <Text style={styles.renameTitle}>Appearance</Text>
          {THEME_IDS.map((id) => (
            <TouchableOpacity
              key={id}
              style={[styles.renameBtn, { justifyContent: 'space-between', width: '100%' }]}
              onPress={() => onThemeChange(id)}
            >
              <Text style={styles.renameBtnText}>{id}</Text>
              {id === themeId && <Feather name="check" size={16} color="#22d3ee" />}
            </TouchableOpacity>
          ))}
        </Pressable>
      </Pressable>
    </Modal>
  );
}
```

Wire an "Appearance" row into `apps/mobile/src/OverflowMenu.tsx` (new `onAppearance` prop, row placed next to the existing "Saved commands" row, same shape) and render `<AppearanceModal>` from `TerminalScreen.tsx` with its own `appearanceModalOpen` boolean state (mirrors `renameModalOpen`'s existing pattern) plus `onThemeChange={(id) => { setThemeId(id); setTheme(THEMES[id]); }}`.

- [ ] **Step 6: Verify manually**

`bun --cwd apps/mobile run lint`, run the app, open Appearance, switch to Dracula, confirm `ls --color` output re-colors on the next repaint (existing rows repaint lazily via the reuse-cache in `getSnapshot` — force one by resizing the window or running a new command).

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/src/terminal.ts apps/mobile/src/terminal.test.ts apps/mobile/src/themes.ts apps/mobile/src/SessionModals.tsx apps/mobile/src/OverflowMenu.tsx apps/mobile/src/TerminalScreen.tsx apps/mobile/src/useTetherApp.tsx
git commit -m "feat(mobile): add a theme/palette picker (default, Dracula, Solarized Dark)"
```

---

### Task 12: Font/ligature picker (desktop only)

**Files:**
- Modify: `apps/mobile/package.json` (bundle a ligature font)
- Modify: `apps/mobile/src/styles.ts` (font constant becomes a variable + setter)
- Modify: `apps/mobile/src/SessionModals.tsx` (extend `AppearanceModal`)
- Modify: `apps/mobile/src/useTetherApp.tsx`, `apps/mobile/src/TerminalScreen.tsx`

**Interfaces:**
- Consumes: `AppearanceModal` (Task 11).
- Produces: a desktop-only font selector persisted the same way as `themeId`.

- [ ] **Step 1: Add a ligature font**

```bash
cd apps/mobile && npx expo install @expo-google-fonts/jetbrains-mono
```

- [ ] **Step 2: Make the mono font swappable**

`apps/mobile/src/styles.ts` currently exports `export const MONO = 'FiraCode_400Regular';` — this is imported by name across many files (`TermRow.tsx`, `UtilityBar.tsx`, etc.) as a static string, so making it dynamically swappable without touching every consumer means keeping the name `MONO` but changing it to a mutable module-level binding with a setter, same pattern as Task 11's `PALETTE`:

```ts
export let MONO = 'FiraCode_400Regular';

export function setMonoFont(fontFamily: string) {
  MONO = fontFamily;
}
```

Every existing `import { MONO } from './styles'` continues to work unchanged (they read the live `let` binding each render, same reasoning as `terminal.ts`'s `PALETTE` in Task 11) — **desktop only**, so this task must not change what mobile shows: gate the setter's effect by only ever calling `setMonoFont` from the desktop-only picker UI added below.

In `apps/mobile/App.tsx` (or wherever `useFonts` currently loads `FiraCode_400Regular` — grep `useFonts` in `TerminalScreen.tsx`/`App.tsx`), add the JetBrains Mono font to the same `useFonts` call so both are available to pick between:

```ts
import { JetBrainsMono_400Regular } from '@expo-google-fonts/jetbrains-mono/400Regular';
// ...
const [fontsLoaded] = useFonts({ FiraCode_400Regular, JetBrainsMono_400Regular });
```

- [ ] **Step 3: Extend the picker (desktop only)**

In `apps/mobile/src/SessionModals.tsx`, add a font section to `AppearanceModal`, gated on `isDesktop`:

```tsx
import { isDesktop } from './platform';

const FONTS = ['FiraCode_400Regular', 'JetBrainsMono_400Regular'] as const;

export function AppearanceModal({
  visible,
  onClose,
  themeId,
  onThemeChange,
  fontFamily,
  onFontChange,
}: {
  visible: boolean;
  onClose: () => void;
  themeId: string;
  onThemeChange: (id: string) => void;
  fontFamily: string;
  onFontChange: (f: string) => void;
}) {
  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <Pressable style={styles.menuBackdrop} onPress={onClose}>
        <Pressable style={styles.renamePanel} onPress={() => {}}>
          <Text style={styles.renameTitle}>Appearance</Text>
          {THEME_IDS.map((id) => (
            <TouchableOpacity
              key={id}
              style={[styles.renameBtn, { justifyContent: 'space-between', width: '100%' }]}
              onPress={() => onThemeChange(id)}
            >
              <Text style={styles.renameBtnText}>{id}</Text>
              {id === themeId && <Feather name="check" size={16} color="#22d3ee" />}
            </TouchableOpacity>
          ))}
          {isDesktop && (
            <>
              <Text style={[styles.renameTitle, { marginTop: 12 }]}>Font</Text>
              {FONTS.map((f) => (
                <TouchableOpacity
                  key={f}
                  style={[styles.renameBtn, { justifyContent: 'space-between', width: '100%' }]}
                  onPress={() => onFontChange(f)}
                >
                  <Text style={[styles.renameBtnText, { fontFamily: f }]}>{f.split('_')[0]}</Text>
                  {f === fontFamily && <Feather name="check" size={16} color="#22d3ee" />}
                </TouchableOpacity>
              ))}
            </>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}
```

In `useTetherApp.tsx`, add `KEY_MONO_FONT = 'tether_mono_font'` persisted the same way as `KEY_THEME` (Task 11), with a `fontFamily`/`setFontFamily` pair calling `setMonoFont(f)` on change; add both to the returned object. In `TerminalScreen.tsx`, pass `fontFamily`/`onFontChange={(f) => { setFontFamily(f); setMonoFont(f); }}` into `<AppearanceModal>`.

- [ ] **Step 4: Verify manually**

`bun --cwd apps/mobile run lint`, `bun run tauri:dev`, open Appearance, switch to JetBrains Mono, confirm terminal text re-renders in the new font; confirm the font section does NOT appear when running on iOS/Android (`isDesktop` false).

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/package.json apps/mobile/src/styles.ts apps/mobile/src/SessionModals.tsx apps/mobile/src/useTetherApp.tsx apps/mobile/src/TerminalScreen.tsx apps/mobile/App.tsx
git commit -m "feat(desktop): add a ligature-font picker (FiraCode / JetBrains Mono)"
```

---

## Phase 4 — Split-panes (desktop only)

### Task 13: Generalize socket/attach state for 2 concurrent sessions

**Files:**
- Modify: `apps/mobile/src/useTetherApp.tsx` (`sock`/`gen`/`open` refs → keyed map; `connect`/`disconnect`/`applyWsMessage`/`wsSend`/`sendInput`)

**Interfaces:**
- Produces: `attachedIds: string[]` (1 or 2 session ids currently rendering live), `focusedId: string` (which attached pane receives keyboard input — replaces the old sole meaning of `activeId`), `connectPane(id: string): void`, `disconnectPane(id: string): void`.
- Consumes: nothing new — this is a refactor of existing `useTetherApp.tsx` internals from Phase 1-3 tasks' perspective; it does not change any public interface those tasks depend on (`entryFor`, `sendInput`, `activeIdRef` all keep working for the single-pane case, since `focusedId` replaces `activeId`'s attach-target meaning while `activeId` keeps meaning "the tab shown in the drawer/tab-strip").

This is the highest-risk task in the plan — flagged as such in the design spec. No automated test: `useTetherApp.tsx` has no existing test coverage (it's a stateful hook wired to a live WebSocket transport, consistent with this repo's "logic modules get hand-rolled tests, hooks/components get manual verification" pattern — see `apps/mobile/CLAUDE.md`'s note on RN component testing). Verification is manual, in Step 4.

- [ ] **Step 1: Replace the singleton refs**

In `apps/mobile/src/useTetherApp.tsx`, replace (~lines 151-153):

```ts
  const sock = useRef<TerminalSocket | null>(null);
  const gen = useRef(0);
  const open = useRef(false);
```

with:

```ts
  interface PaneSlot {
    sock: TerminalSocket | null;
    gen: number;
    open: boolean;
  }
  const panes = useRef(new Map<string, PaneSlot>());
  const paneSlot = (id: string): PaneSlot => {
    let slot = panes.current.get(id);
    if (!slot) {
      slot = { sock: null, gen: 0, open: false };
      panes.current.set(id, slot);
    }
    return slot;
  };
  const [attachedIds, setAttachedIds] = useState<string[]>(['term-1']);
```

- [ ] **Step 2: Parameterize connect/disconnect/applyWsMessage/wsSend/sendInput**

Replace `connect`/`disconnect` (~lines 314-365) with id-parameterized versions (default to `activeIdRef.current` so every existing call site — `connect()`, `disconnect()` — keeps compiling unchanged):

```ts
  const connectPane = (id: string = activeIdRef.current) => {
    disconnectPane(id);
    lastConnectedRef.current = { ip: serverIp, port };
    const e = entryFor(id);
    if (id === activeIdRef.current) setConnectionStatus('connecting');
    const url = wsUrl(serverIp, port, {
      sessionId: id,
      sinceId: e.sinceId,
      cols: numCols,
      rows: numRows,
    });
    const slot = paneSlot(id);
    const myGen = ++slot.gen;
    const fresh = () => myGen === slot.gen;

    slot.sock = openTerminalSocket(url, passwordRef.current, {
      onOpen: () => {
        if (!fresh()) return;
        hasConnectedRef.current = true;
        slot.open = true;
        if (id === activeIdRef.current) setConnectionStatus('connected');
      },
      onMessage: (data) => {
        if (fresh()) applyWsMessage(id, data);
      },
      onClose: () => {
        if (!fresh()) return;
        slot.open = false;
        if (id === activeIdRef.current) setConnectionStatus('disconnected');
        if (readyRef.current && attachedIds.includes(id)) {
          reconnectTimeout.current = setTimeout(() => connectPane(id), 3000);
        }
      },
    });
  };

  const disconnectPane = (id: string = activeIdRef.current) => {
    if (id === activeIdRef.current && reconnectTimeout.current) {
      clearTimeout(reconnectTimeout.current);
      reconnectTimeout.current = null;
    }
    const slot = paneSlot(id);
    slot.gen++;
    slot.open = false;
    const s = slot.sock;
    slot.sock = null;
    if (s) s.close();
    if (id === activeIdRef.current) setConnectionStatus('disconnected');
  };

  // Back-compat aliases — every existing single-pane call site (switchTo,
  // the reconnect effect, etc.) keeps working unchanged.
  const connect = () => connectPane(activeIdRef.current);
  const disconnect = () => disconnectPane(activeIdRef.current);
```

Update `applyWsMessage`'s render guard (~line 297, `if (id === activeIdRef.current) scheduleRender();`, appears 3 times in that function) to `if (attachedIds.includes(id)) scheduleRender();` in all three spots — with 2 panes attached, either one's output must trigger a re-render, not just the focused one.

Update `wsSend`/`sendInput` (~lines 223-225, 690-692) to take an explicit target, defaulting to the focused pane:

```ts
  const wsSend = (obj: unknown, targetId: string = activeIdRef.current) => {
    const slot = paneSlot(targetId);
    if (slot.open && slot.sock) slot.sock.send(JSON.stringify(obj));
  };

  const sendInput = (text: string, targetId: string = activeIdRef.current) => {
    wsSend({ type: 'input', text }, targetId);
  };
```

- [ ] **Step 3: Add `attachedIds` to the returned object**

Add `attachedIds`, `setAttachedIds`, `connectPane`, `disconnectPane` to the return object (~line 1143) and `TerminalScreen.tsx`'s destructuring (~line 69). Task 14 uses these to build the split layout; single-pane behavior is unaffected since `attachedIds` defaults to `['term-1']` and every existing call path still funnels through the id-defaulted `connect`/`disconnect`/`wsSend`/`sendInput` aliases.

- [ ] **Step 4: Verify manually (no automated test — see rationale above)**

`bun --cwd apps/mobile run lint` (must pass with zero type errors — this is the load-bearing check here, since the refactor is purely internal state-shape change with back-compat aliases). Run the full app end to end: connect, type, switch tabs, disconnect/reconnect network, confirm behavior is identical to before the refactor (this task intentionally changes nothing user-visible — Task 14 is what exposes split-panes).

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/useTetherApp.tsx
git commit -m "refactor(mobile): key session sock/gen/open state by pane id"
```

---

### Task 14: Split-pane UI layout + toggle

**Files:**
- Create: `apps/mobile/src/SplitPaneView.tsx`
- Modify: `apps/mobile/src/useTetherApp.tsx` (pane-aware resize, `SessionCache` cap bump)
- Modify: `apps/mobile/src/sessionCache.ts` (cap becomes settable)
- Modify: `apps/mobile/src/TerminalScreen.tsx`, `apps/mobile/src/OverflowMenu.tsx`

**Interfaces:**
- Consumes: `attachedIds`, `connectPane`, `disconnectPane` (Task 13).
- Produces: a 2-pane side-by-side layout, desktop only, toggled from the overflow menu, reversible back to the existing single-pane/tab view.

- [ ] **Step 1: Let the LRU cache grow to 4 while split**

`apps/mobile/src/sessionCache.ts`'s `cap` is currently a constructor-only `private cap = 3`. Add a setter so split mode can raise it without evicting the two now-attached panes (its "active session is never the eviction victim" invariant assumes exactly one active id — bumping the cap sidesteps needing to also generalize the eviction-protection logic, which stays out of scope per this task's "layout-split only" framing):

```ts
  setCap(cap: number) {
    this.cap = cap;
    while (this.order.length > this.cap) {
      const victim = this.order.pop()!;
      this.map.delete(victim);
    }
  }
```

In `useTetherApp.tsx`, wherever `attachedIds` changes (the split-toggle handler added in Step 3 below), call `cache.setCap(attachedIds.length > 1 ? 4 : 3)`.

- [ ] **Step 2: Create the split layout component**

Create `apps/mobile/src/SplitPaneView.tsx`:

```tsx
import { View, StyleSheet } from 'react-native';

// Desktop-only 2-pane side-by-side layout. Each pane renders the SAME
// FlatList-based terminal grid the single-pane view uses — just twice, at
// half width — via the render-prop `renderPane`, since the grid itself
// doesn't know about panes (it's keyed by whichever session id it's given).
export function SplitPaneView({
  ids,
  renderPane,
}: {
  ids: [string, string];
  renderPane: (id: string) => React.ReactNode;
}) {
  return (
    <View style={styles.row}>
      <View style={styles.pane}>{renderPane(ids[0])}</View>
      <View style={styles.divider} />
      <View style={styles.pane}>{renderPane(ids[1])}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flex: 1, flexDirection: 'row' },
  pane: { flex: 1 },
  divider: { width: 1, backgroundColor: 'rgba(255, 255, 255, 0.08)' },
});
```

- [ ] **Step 3: Wire the toggle + per-pane grid rendering**

In `apps/mobile/src/useTetherApp.tsx`, add a toggle function near `newTerminal`:

```ts
  // Enters split view with the currently-focused session + the next one in the
  // drawer list (or exits back to single-pane if already split, or there's no
  // second session to pair with).
  const toggleSplit = () => {
    if (attachedIds.length > 1) {
      const keep = activeIdRef.current;
      disconnectPane(attachedIds.find((id) => id !== keep)!);
      setAttachedIds([keep]);
      cache.setCap(3);
      return;
    }
    const other = drawerSessions.map((s) => s.id).find((id) => id !== activeIdRef.current);
    if (!other) return;
    cache.setCap(4);
    connectPane(other);
    setAttachedIds([activeIdRef.current, other]);
  };
```

Add `toggleSplit` to the returned object and `TerminalScreen.tsx`'s destructuring.

The existing single-pane `terminalGrid` (built from the `FlatList`/`renderRow` shown at `useTetherApp.tsx:1079-1104`) is keyed off module-level `screen`/`activeId` state, not parameterizable per-pane as-is. Since generalizing it to take an explicit pane id is a larger change than this task's scope justifies (it would mean threading `cols`/`rows`/`fontSize` per pane too, which split-panes at fixed 2-way half-width doesn't need — both panes share the same font size and column count derived from half the window width), scope this task's rendering to: **each pane independently gets its own `FlatList` bound to `entryFor(paneId).term.getSnapshot()`**, using the exact same `renderRow`/`TermRow` pieces, parameterized by the pane's own id instead of the closed-over `activeId`.

In `apps/mobile/src/TerminalScreen.tsx`, where `terminalGrid` is currently rendered directly, branch on `attachedIds.length`:

```tsx
{isDesktop && attachedIds.length > 1 ? (
  <SplitPaneView
    ids={attachedIds as [string, string]}
    renderPane={(id) => (
      <FlatList
        style={{ flex: 1 }}
        contentContainerStyle={styles.terminalContent}
        data={entryFor(id).term.getSnapshot()}
        renderItem={({ item }) => (
          <TermRow
            row={item}
            fontSize={fontSize}
            lineHeight={lineHeight}
            width={gridWidth / 2}
            blinkOn={blinkOn}
            cursorStyle={entryFor(id).term.cursorStyle}
          />
        )}
        keyExtractor={(_, i) => String(i)}
      />
    )}
  />
) : (
  terminalGrid
)}
```

Import `SplitPaneView` at the top of `TerminalScreen.tsx`.

- [ ] **Step 4: Add the menu toggle**

In `apps/mobile/src/OverflowMenu.tsx`, add an `onToggleSplit`/`isSplit` prop pair and a row, gated `isDesktop`-only (same guard already used for the navigation-mode section, ~line 69):

```tsx
          {isDesktop && (
            <TouchableOpacity style={styles.menuRow} onPress={onToggleSplit}>
              <Feather name="columns" size={16} color="#cbd5e1" />
              <Text style={styles.menuRowText}>{isSplit ? 'Exit split view' : 'Split view'}</Text>
            </TouchableOpacity>
          )}
```

Wire `onToggleSplit={toggleSplit}` and `isSplit={attachedIds.length > 1}` from `TerminalScreen.tsx`.

- [ ] **Step 5: Verify manually (no automated test — same rationale as Task 13)**

`bun --cwd apps/mobile run lint`, `bun run tauri:dev`, open 2+ sessions, toggle split, confirm both panes stream live output independently, type into the left pane (focus stays on `activeId`/keyboard input target — clicking a pane to focus it is a natural follow-up, not required by this task since input already routes to `activeIdRef.current` which the tab-switcher still controls), toggle back to single-pane, confirm the previously-second pane keeps running server-side (detach, not kill) and reattaches correctly if selected again from the drawer.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/src/SplitPaneView.tsx apps/mobile/src/useTetherApp.tsx apps/mobile/src/sessionCache.ts apps/mobile/src/TerminalScreen.tsx apps/mobile/src/OverflowMenu.tsx
git commit -m "feat(desktop): add 2-pane split view (layout-split of existing sessions)"
```

---

## Self-Review Notes

- **Spec coverage:** all 12 value-grid rows have a task — bell (1), title (2), cwd (3), cursor shape (4), prompt markers (5), hyperlinks (6), upload endpoint (7), mobile picker (8), iOS drag-drop (9), desktop drag-drop (10), theme (11), font (12), split-panes (13-14).
- **Placeholder scan:** no TBD/TODO markers; every step has real code. The one deliberately-deferred item (bash auto-emitting OSC 133) is called out explicitly in Task 5 Step 7 as a known follow-up, not a placeholder in this plan's own deliverable (the parser/nav logic is fully implemented and tested without it).
- **Type consistency:** `entryFor`, `sendInput`, `wsSend`, `activeIdRef`, `cache` are used with identical signatures across all tasks that touch them; Task 13's `sendInput`/`wsSend` signature change (added optional `targetId` param) is backward-compatible with every earlier task's zero-arg call sites.
- **Scope:** four independently-shippable phases; Phase 4 (split-panes) is the one task pair that depends on internal refactor risk — it's ordered last so Phases 1-3 ship value even if Phase 4 is deferred or reverted.
