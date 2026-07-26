# Full xterm.js Renderer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the React Native terminal-row paint path with xterm.js's damage-tracked WebGL/DOM renderer while preserving Tether's transport, replay, background sessions, links, input, and notifications.

**Architecture:** `TerminalEngine` remains the non-visual state owner and gains serialization. One active `TerminalView` renders with full xterm.js: a local WebView on native and a direct DOM mount on desktop/web. Live bytes are frame-batched into that renderer; inactive sessions remain headless and hydrate the active renderer from serialized VT state on tab switches.

**Tech Stack:** Bun, TypeScript 7, React 19, React Native 0.86, Expo 57.0.7, `react-native-webview` 13.16.1, `@xterm/xterm` 6.0.0, `@xterm/headless` 6.0.0, `@xterm/addon-webgl` 0.19.0, `@xterm/addon-fit` 0.11.0, `@xterm/addon-serialize` 0.14.0.

## Global Constraints

- Do not change the server WebSocket protocol or put the password/auth header inside the renderer.
- Keep `@xterm/headless` 6.0.0 and Expo 57.0.7 pinned.
- Only the active session owns a full renderer; never retain hidden WebViews/WebGL contexts for the other two cached sessions.
- WebGL is optional at runtime; failure/context loss must fall back to xterm's DOM renderer.
- Terminal bytes are data passed to `Terminal.write`, never executable JavaScript.
- Keep current background-tab OSC reply, clipboard guard, bell, title, cwd, notification, reconnect, and replay behavior.
- Run the physical-iPhone/desktop feasibility gate before deleting the old renderer.
- Formatting: existing TypeScript/Biome style—2 spaces, single quotes, semicolons, width 100.
- Preserve the user's unrelated untracked `tether-engine-test.sh`.

---

## File Structure

- `apps/mobile/src/terminalRendererProtocol.ts` — validated native bridge messages, ordered hydrate/write queue, and output batcher.
- `apps/mobile/src/terminalRendererProtocol.test.ts` — protocol, ordering, and batching checks.
- `apps/mobile/terminal-renderer/index.ts` — browser-only xterm bootstrap used by the native local WebView.
- `apps/mobile/src/terminalRendererLinks.ts` — shared xterm link provider backed by Tether's existing URL/file parser.
- `apps/mobile/scripts/build-terminal-renderer.ts` — bundles the browser bootstrap into a generated TypeScript string.
- `apps/mobile/src/terminalRenderer.generated.ts` — generated, committed renderer bundle consumed by Metro.
- `apps/mobile/src/terminalRendererHtml.ts` — minimal local HTML/CSS wrapper around the generated bundle.
- `apps/mobile/src/TerminalView.types.ts` — shared renderer props/ref contract.
- `apps/mobile/src/TerminalView.native.tsx` — `react-native-webview` bridge.
- `apps/mobile/src/TerminalView.web.tsx` — direct xterm DOM renderer for Tauri/web.
- `apps/mobile/src/terminalEngine.ts` — add serialize support; keep all existing parser behavior.
- `apps/mobile/src/terminalEngine.test.ts` — serialization round-trip regression.
- `apps/mobile/src/useTetherApp.tsx` — batch active output to the renderer and stop live snapshot generation.
- `apps/mobile/src/TerminalScreen.tsx` — mount `TerminalView` in place of `FlatList`.
- `apps/mobile/package.json`, `bun.lock` — exact xterm renderer/addon dependencies and bundle script.

---

### Task 1: Renderer protocol and ordered batching

**Files:**
- Create: `apps/mobile/src/terminalRendererProtocol.ts`
- Create: `apps/mobile/src/terminalRendererProtocol.test.ts`

**Interfaces:**
- Produces: `RendererCommand`, `RendererEvent`, `parseRendererEvent`, `RendererQueue`, and `OutputBatcher`.
- `RendererQueue` guarantees `hydrate → queued writes` ordering across WebView readiness/remounts.
- `OutputBatcher` accepts `(sessionId, chunk)` and flushes only the active session in one scheduled delivery.

- [ ] **Step 1: Write failing protocol and ordering tests**

```ts
import { describe, expect, test } from 'bun:test';
import {
  OutputBatcher,
  parseRendererEvent,
  RendererQueue,
  type RendererCommand,
} from './terminalRendererProtocol';

describe('parseRendererEvent', () => {
  test('accepts known versioned events and rejects malformed data', () => {
    expect(parseRendererEvent('{"v":1,"type":"input","text":"ls\\r"}')).toEqual({
      v: 1,
      type: 'input',
      text: 'ls\r',
    });
    expect(parseRendererEvent('{"v":2,"type":"input","text":"x"}')).toBeNull();
    expect(parseRendererEvent('{"v":1,"type":"resize","cols":0,"rows":24}')).toBeNull();
    expect(parseRendererEvent('not json')).toBeNull();
  });
});

test('RendererQueue hydrates before writes and survives a remount', () => {
  const sent: RendererCommand[] = [];
  const q = new RendererQueue((command) => sent.push(command));
  q.write('before');
  q.hydrate('state', 80, 24, { foreground: '#fff', background: '#000' });
  q.ready();
  q.write('after');
  expect(sent.map((x) => x.type)).toEqual(['hydrate', 'write', 'write']);
  q.notReady();
  q.write('remount');
  q.ready();
  expect(sent.at(-1)).toEqual({ v: 1, type: 'write', data: 'remount' });
});

test('OutputBatcher joins active-session chunks into one delivery', () => {
  const scheduled: (() => void)[] = [];
  const writes: string[] = [];
  const batcher = new OutputBatcher(
    () => 'term-1',
    (chunk) => writes.push(chunk),
    (flush) => scheduled.push(flush),
  );
  batcher.push('term-1', 'a');
  batcher.push('term-2', 'ignored');
  batcher.push('term-1', 'b');
  expect(writes).toEqual([]);
  scheduled[0]();
  expect(writes).toEqual(['ab']);
});
```

- [ ] **Step 2: Run the tests and confirm RED**

Run:

```bash
cd apps/mobile
bun test src/terminalRendererProtocol.test.ts
```

Expected: FAIL because `terminalRendererProtocol.ts` does not exist.

- [ ] **Step 3: Implement the protocol, validator, queue, and batcher**

Use this public shape:

```ts
export type RendererTheme = { foreground: string; background: string };

export type RendererCommand =
  | { v: 1; type: 'hydrate'; data: string; cols: number; rows: number; theme: RendererTheme }
  | { v: 1; type: 'write'; data: string }
  | { v: 1; type: 'resize'; cols: number; rows: number }
  | { v: 1; type: 'focus' }
  | { v: 1; type: 'dispose' };

export type RendererEvent =
  | { v: 1; type: 'ready' }
  | { v: 1; type: 'input'; text: string }
  | { v: 1; type: 'resize'; cols: number; rows: number }
  | { v: 1; type: 'openLink'; target: import('./links').LinkTarget }
  | { v: 1; type: 'selection'; text: string }
  | { v: 1; type: 'rendererFallback'; reason: string };
```

`parseRendererEvent` must catch JSON errors, require `v === 1`, validate strings, require positive
integer dimensions, and validate `LinkTarget` using the existing external/file union.

`RendererQueue` stores the latest hydrate command, queues writes while not ready, sends the
hydrate first on `ready()`, then flushes queued writes in order. A second hydrate replaces the
old hydrate because only current session state matters.

`OutputBatcher` stores one string array for the current active session, schedules once, joins on
flush, and drops stale-session chunks. Add `flushNow()` and `clear()` for session switches and
unmount.

- [ ] **Step 4: Run focused tests and typecheck**

```bash
cd apps/mobile
bun test src/terminalRendererProtocol.test.ts
bun run typecheck
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/terminalRendererProtocol.ts apps/mobile/src/terminalRendererProtocol.test.ts
git commit -m "feat(mobile): add xterm renderer bridge protocol"
```

---

### Task 2: Browser renderer bundle and feasibility harness

**Files:**
- Create: `apps/mobile/terminal-renderer/index.ts`
- Create: `apps/mobile/scripts/build-terminal-renderer.ts`
- Create: `apps/mobile/src/terminalRenderer.generated.ts`
- Create: `apps/mobile/src/terminalRendererHtml.ts`
- Create: `apps/mobile/src/terminalRendererLinks.ts`
- Modify: `apps/mobile/package.json`
- Modify: `bun.lock`

**Interfaces:**
- Consumes: `RendererCommand`/`RendererEvent` JSON shapes from Task 1.
- Produces: `terminalRendererHtml(): string`, a self-contained local page exposing
  `window.__tetherDispatch(command)`.

- [ ] **Step 1: Add exact compatible dependencies and the bundle command**

Run:

```bash
cd apps/mobile
bun add @xterm/xterm@6.0.0 @xterm/addon-webgl@0.19.0 @xterm/addon-fit@0.11.0 @xterm/addon-serialize@0.14.0
```

Add:

```json
"build:terminal-renderer": "bun scripts/build-terminal-renderer.ts"
```

- [ ] **Step 2: Implement the browser bootstrap**

`terminal-renderer/index.ts` must:

```ts
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

const post = (event: object) =>
  window.ReactNativeWebView?.postMessage(JSON.stringify({ v: 1, ...event }));

const terminal = new Terminal({
  allowProposedApi: true,
  convertEol: false,
  cursorBlink: true,
  scrollback: 1000,
});
const fit = new FitAddon();
terminal.loadAddon(fit);
terminal.open(document.getElementById('terminal')!);

try {
  const webgl = new WebglAddon();
  webgl.onContextLoss(() => {
    webgl.dispose();
    post({ type: 'rendererFallback', reason: 'webgl-context-lost' });
    terminal.refresh(0, terminal.rows - 1);
  });
  terminal.loadAddon(webgl);
} catch (error) {
  post({ type: 'rendererFallback', reason: String(error) });
}
```

Register `terminal.onData(text => post({type:'input', text}))`. Handle commands:

- `hydrate`: reset, set theme, resize, write serialized data, then fit.
- `write`: `terminal.write(command.data)`.
- `resize`: resize only when changed.
- `focus`: focus.
- `dispose`: dispose.

Use `ResizeObserver` to call `fit.fit()` immediately and post only changed positive dimensions.
Listen for commands through a single `window.__tetherDispatch` function. Do not use `eval`.

- [ ] **Step 3: Register Tether's existing links with xterm**

Create:

```ts
export function registerTetherLinks(
  terminal: Terminal,
  activate: (target: LinkTarget) => void,
): IDisposable
```

Its `registerLinkProvider` callback reads the active buffer's rows, converts each line with
`translateToString(false)`, derives the "wraps into next" flags from the following xterm line,
and calls the existing `computeLinkSpans`. Return links only for the requested 1-based row,
converting Tether's 0-based exclusive spans to xterm's 1-based inclusive `IBufferRange`.
Activation calls `activate(span.target)`. This preserves wrapped/hard-wrapped URLs and file
references without maintaining a second regex implementation. OSC 8 remains xterm-native.

The native bootstrap passes `target => post({type:'openLink', target})`; `TerminalView.web.tsx`
uses the same helper and its `onOpenLink` prop.

- [ ] **Step 4: Implement deterministic bundle generation**

`scripts/build-terminal-renderer.ts` uses `Bun.build` with `target: 'browser'`, `format: 'iife'`,
`minify: true`, and CSS inlining. It writes:

```ts
// Generated by bun run build:terminal-renderer. Do not edit.
export const TERMINAL_RENDERER_BUNDLE = ${JSON.stringify(js.replaceAll('</script', '<\\/script'))};
export const TERMINAL_RENDERER_CSS = ${JSON.stringify(css)};
```

to `src/terminalRenderer.generated.ts`. Fail when the build has logs or no JS output.

- [ ] **Step 5: Add the self-contained HTML wrapper**

`terminalRendererHtml.ts` returns a stable string containing viewport metadata, generated CSS,
`html/body/#terminal { width:100%; height:100%; margin:0; overflow:hidden; background:<theme>; }`,
the terminal div, and the generated script. It accepts no remote URL and loads no network assets.

- [ ] **Step 6: Generate and verify the page**

```bash
cd apps/mobile
bun run build:terminal-renderer
bun -e "import { terminalRendererHtml } from './src/terminalRendererHtml'; const h=terminalRendererHtml(); if (!h.includes('__tetherDispatch') || !h.includes('xterm')) process.exit(1)"
bun run typecheck
```

Expected: generated module exists; checks pass.

- [ ] **Step 7: Commit the feasibility bundle**

```bash
git add apps/mobile/package.json bun.lock apps/mobile/terminal-renderer apps/mobile/scripts apps/mobile/src/terminalRenderer.generated.ts apps/mobile/src/terminalRendererHtml.ts apps/mobile/src/terminalRendererLinks.ts
git commit -m "feat(mobile): bundle local xterm renderer"
```

---

### Task 3: Serialize headless session state

**Files:**
- Modify: `apps/mobile/src/terminalEngine.ts`
- Modify: `apps/mobile/src/terminalEngine.test.ts`

**Interfaces:**
- Produces: `TerminalEngine.serialize(): string`.
- The serialized output must restore visible content, scrollback, colors, cursor, and active buffer
  when written to a fresh full or headless xterm terminal.

- [ ] **Step 1: Write a failing round-trip test**

```ts
test('serialize restores scrollback, styles, cursor and active buffer', async () => {
  const source = new TerminalEngine(20, 5);
  source.write('\x1b[31mred\x1b[0m\r\none\r\ntwo\r\nthree\r\nfour\r\nfive');
  await source.drain();
  const restored = new TerminalEngine(20, 5);
  restored.write(source.serialize());
  await restored.drain();
  expect(restored.getSnapshot().map(rowText)).toEqual(source.getSnapshot().map(rowText));
  expect(restored.cols).toBe(source.cols);
  expect(restored.rows).toBe(source.rows);
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

```bash
cd apps/mobile
bun test src/terminalEngine.test.ts
```

Expected: FAIL because `serialize` does not exist.

- [ ] **Step 3: Load `SerializeAddon` inside `TerminalEngine`**

Add one private addon:

```ts
private readonly serializeAddon = new SerializeAddon();
```

Load it after constructing the headless terminal. Expose:

```ts
serialize(): string {
  return this.serializeAddon.serialize({ scrollback: this.term.buffer.active.baseY });
}
```

Use the addon's actual 0.14.0 option type; do not cast through `any`. If the addon rejects
`@xterm/headless`, stop the feasibility gate and record the incompatibility instead of inventing
a serializer.

- [ ] **Step 4: Run tests**

```bash
cd apps/mobile
bun test src/terminalEngine.test.ts
bun run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/terminalEngine.ts apps/mobile/src/terminalEngine.test.ts
git commit -m "feat(mobile): serialize headless terminal state"
```

---

### Task 4: Native and desktop `TerminalView`

**Files:**
- Create: `apps/mobile/src/TerminalView.types.ts`
- Create: `apps/mobile/src/TerminalView.native.tsx`
- Create: `apps/mobile/src/TerminalView.web.tsx`
- Test: `apps/mobile/src/terminalRendererProtocol.test.ts`

**Interfaces:**
- Produces:

```ts
export interface TerminalViewHandle {
  hydrate(data: string, cols: number, rows: number, theme: RendererTheme): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  focus(): void;
}

export interface TerminalViewProps {
  onInput(text: string): void;
  onResize(cols: number, rows: number): void;
  onOpenLink(target: LinkTarget): void;
  onFallback(reason: string): void;
}
```

- [ ] **Step 1: Extend queue tests for ready/remount behavior**

Add a test proving two pre-ready hydrates collapse to the newest state while writes after the
newest hydrate retain order.

- [ ] **Step 2: Implement `TerminalView.native.tsx`**

Use `forwardRef<TerminalViewHandle, TerminalViewProps>`, `WebView`, `terminalRendererHtml()`,
and `RendererQueue`.

- `source={{ html: terminalRendererHtml() }}` and `originWhitelist={['*']}`.
- Disable navigation and external network loads with `onShouldStartLoadWithRequest`.
- `onMessage` parses through `parseRendererEvent`; dispatch only valid events.
- Send commands with `webViewRef.current?.injectJavaScript` calling
  `window.__tetherDispatch(<JSON command>);true;`.
- JSON-encode the whole command object; never concatenate `command.data` separately.
- On `onContentProcessDidTerminate`/render-process loss: mark not ready, reload, then hydrate
  through the queue when `ready` arrives.
- Transparent bounce/overscroll must be disabled; xterm owns its viewport scrolling.

- [ ] **Step 3: Implement `TerminalView.web.tsx`**

Mount a real `<div>` through a React ref. Instantiate `Terminal`, `FitAddon`, and optional
`WebglAddon` directly. Implement the same imperative handle without JSON or a WebView.

Use `ResizeObserver`, dedupe dimensions, dispose terminal/addons/observer on unmount, and invoke
the same props for input/resize/link/fallback.

- [ ] **Step 4: Run tests and both builds**

```bash
cd apps/mobile
bun test src/terminalRendererProtocol.test.ts
bun run typecheck
bun run build:web
```

Expected: all pass and Metro resolves `.native`/`.web` correctly.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/TerminalView.types.ts apps/mobile/src/TerminalView.native.tsx apps/mobile/src/TerminalView.web.tsx apps/mobile/src/terminalRendererProtocol.test.ts
git commit -m "feat(mobile): add native and desktop xterm views"
```

---

### Task 5: Wire live output, hydration, input, links, and resize

**Files:**
- Modify: `apps/mobile/src/useTetherApp.tsx`
- Modify: `apps/mobile/src/TerminalScreen.tsx`
- Modify: `apps/mobile/src/sessionCache.ts`
- Test: `apps/mobile/src/terminalRendererProtocol.test.ts`

**Interfaces:**
- Consumes: `TerminalViewHandle`, `OutputBatcher`, and `TerminalEngine.serialize`.
- Removes live dependency on `screen`, `scheduleRender`, `renderScheduled`, `renderTimer`,
  `renderRow`, `terminalGrid`, `FlatList`, `TermRow`, and the measured character-ratio sizing path.

- [ ] **Step 1: Add a generation-order test**

Prove that switching `term-1 → term-2` clears an unflushed `term-1` output batch, hydrates
`term-2`, and sends only subsequent `term-2` live bytes.

- [ ] **Step 2: Add renderer ownership to `useTetherApp`**

Create:

```ts
const terminalViewRef = useRef<TerminalViewHandle | null>(null);
const outputBatcher = useRef(
  new OutputBatcher(
    () => activeIdRef.current,
    (data) => terminalViewRef.current?.write(data),
    (flush) => requestAnimationFrame(flush),
  ),
).current;
```

On active output, keep `ent.term.write` and notification handling, but replace
`scheduleRender()` with `outputBatcher.push(id, msg.chunk)`. Background output only reaches its
headless engine.

On reset, session switch, renderer remount, theme/font change, and reconnect gap recovery:

1. clear pending output;
2. serialize the active headless engine;
3. call `terminalViewRef.current?.hydrate(serialized, cols, rows, theme)`;
4. resume live batching.

- [ ] **Step 3: Make renderer dimensions authoritative**

Replace font-ratio/window-width column math with `onRendererResize(cols, rows)`:

- reject non-positive/non-integer sizes;
- resize the active headless engine immediately;
- update `dimsRef`;
- dedupe identical dimensions;
- trailing-debounce the remote `{type:'resize'}` by 120 ms on desktop and 60 ms native;
- always send the final settled dimensions;
- on reconnect, send `dimsRef.current` once.

The renderer's `ResizeObserver` handles immediate local repaint; React no longer holds stale
width for 200 ms.

- [ ] **Step 4: Route renderer input and links**

- `onInput(text)` sends the existing `{type:'input', text}` message.
- `onOpenLink({kind:'external'})` uses the existing platform opener.
- `onOpenLink({kind:'file'})` calls the existing authenticated `openFile`.
- Utility bar, snippets, paste, and saved commands keep their existing direct socket path.
- Remove only terminal-surface keyboard/pointer handlers that would double-send alongside
  xterm; keep surrounding app shortcuts that do not produce terminal bytes.

- [ ] **Step 5: Replace the terminal grid in `TerminalScreen`**

Mount:

```tsx
<TerminalView
  ref={terminalViewRef}
  onInput={onRendererInput}
  onResize={onRendererResize}
  onOpenLink={openLink}
  onFallback={recordRendererFallback}
/>
```

Keep the connection banner as an absolute overlay so it cannot change renderer size. Preserve
preview/file/diff takeovers; remount/hydrate when returning to the terminal.

- [ ] **Step 6: Stop snapshot rendering during streaming**

Delete the live `screen` state updates, `scheduleRender`, `terminalGrid`, caret blink interval,
FlatList scroll-follow state, measured char ratio, and `TermRow` render callback from the active
path. Keep `getSnapshot()` only for explicit selection/search/prompt operations until those are
migrated.

- [ ] **Step 7: Run automated verification**

```bash
cd apps/mobile
bun test
bun run typecheck
bun run build:web
```

- [ ] **Step 8: Commit**

```bash
git add apps/mobile/src/useTetherApp.tsx apps/mobile/src/TerminalScreen.tsx apps/mobile/src/sessionCache.ts apps/mobile/src/terminalRendererProtocol.test.ts
git commit -m "feat(mobile): render live terminals with xterm"
```

---

### Task 6: Feasibility gate, fallback removal, and final verification

**Files:**
- Modify: `apps/mobile/src/useTetherApp.tsx`
- Modify: `apps/mobile/src/TerminalScreen.tsx`
- Delete only after gate passes: `apps/mobile/src/TermRow.tsx`
- Modify: `docs/superpowers/specs/2026-07-25-xterm-renderer-design.md` (status/results)

**Interfaces:**
- Produces: one production terminal renderer with no permanent dual-render switch.

- [ ] **Step 1: Desktop live test**

Build the fresh bundle and desktop app:

```bash
cd apps/mobile
bun run build:terminal-renderer
bun run build:web
bun run tauri:dev
```

Against a real Tether server, verify:

- `yes "0123456789 abcdefghijklmnopqrstuvwxyz" | head -n 20000`;
- `vim`, `htop`, `less`, `tmux`, alternate screen enter/exit;
- continuous window dragging at small/large widths;
- reconnect replay and three-tab switching;
- URL, wrapped URL, OSC 8, and `path/file.ts:12:3` links;
- typing, dead keys/IME, paste, selection, mouse mode, prompt jump;
- no stale or corrupt intermediate resize paint.

Record the browser performance trace: live output must not call `TerminalEngine.getSnapshot()`
or reconcile terminal rows.

- [ ] **Step 2: Physical-iPhone gate**

Run the same fixed streaming workload for five minutes on the current v2.0.5 renderer and the
new renderer with the same brightness, font size, rows/columns, and network.

In Xcode Instruments/Energy Log record:

- average Energy Impact;
- CPU percentage;
- frame drops/hitches;
- renderer fallback events.

Pass only if the new renderer is visibly smoother and materially lowers energy/CPU. Verify
keyboard, IME, selection, links, touch scroll, rotation, background/foreground, and reconnect.

- [ ] **Step 3: Android smoke**

```bash
cd apps/mobile
bun run android
```

Verify startup, WebGL-or-DOM fallback, typing, streaming, rotation, and tab switching in the
emulator. Physical Android energy measurement is not required.

- [ ] **Step 4: Remove the old paint path after the gate passes**

Delete `TermRow.tsx` and remaining unused FlatList renderer imports/state. Do not delete
`terminal.ts` types or `getSnapshot()` while selection/search/prompt features still consume them.
Remove the temporary internal fallback switch so only one architecture ships.

- [ ] **Step 5: Run the full repository gate**

```bash
cd /home/samuelloranger/sites/tether
bun --cwd apps/mobile run build:terminal-renderer
bun --cwd apps/mobile test
bun --cwd apps/mobile run typecheck
bun --cwd apps/mobile run build:web
bun --cwd apps/server test
bun run lint
git diff --check
git status --short
```

Expected: all commands pass; only the user's pre-existing `tether-engine-test.sh` remains
untracked.

- [ ] **Step 6: Document results and commit**

Update the design status with measured desktop/iPhone results, then:

```bash
git add apps/mobile docs/superpowers/specs/2026-07-25-xterm-renderer-design.md bun.lock
git commit -m "feat: replace terminal rows with xterm renderer"
```

- [ ] **Step 7: Close board task**

Add a board note with benchmark, physical-iPhone energy result, fallback behavior, tests, and
commits; move #395 to `done`.
