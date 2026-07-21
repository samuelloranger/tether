# OSC 52 Clipboard + OSC 10/11 Color Query Reply Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close two silent-failure gaps in the mobile VT emulator: OSC 52 (clipboard write + query) and OSC 10/11 (fg/bg color query reply).

**Architecture:** All parsing lives in `TerminalEmulator.dispatchOsc()` (`apps/mobile/src/terminal.ts`). Two new optional instance hooks (`onClipboardWrite`, `onClipboardRead`), same pattern as the existing `onReply` hook, keep the emulator platform-agnostic — `terminal.ts` never imports `expo-clipboard` directly. `useTetherApp.tsx` wires the hooks to the real device clipboard, same place it already wires `onReply`.

**Tech Stack:** TypeScript, Bun test runner (plain-script `eq()` assertions, existing `terminal.test.ts` convention), `expo-clipboard` (already a dependency).

## Global Constraints

- Base64 encode/decode uses global `atob`/`btoa` plus `encodeURIComponent`/`decodeURIComponent` for UTF-8 safety (see Task 2) — no new npm dependency.
- No toast/notification on clipboard success or failure — matches existing silent `copySelection()` behavior in `useTetherApp.tsx`.
- Malformed payloads (bad base64, rejected clipboard promise) fail silently — no throw, no console spam — matching how other malformed OSC payloads are already handled in `dispatchOsc`.
- OSC 10/11 is query-only (`pt === '?'`); the "set fg/bg" direction is explicitly out of scope.
- OSC 52 buffer letter (`c`/`p`/`s`/`0`-`7`) is ignored — all map to the one device clipboard.

---

### Task 1: OSC 10/11 color query reply

**Files:**
- Modify: `apps/mobile/src/terminal.ts:665` (insert new `else if` branch in `dispatchOsc`, right after the existing `ps === '8'` branch and before the method's closing brace at line 666), plus a new module-level helper placed directly after `buildPalette()`'s closing brace (currently line 76, right before `let PALETTE = buildPalette();` at line 77 — insert the helper before that line).
- Test: `apps/mobile/src/terminal.test.ts` (append after test 54, before the final `console.log` summary line)

**Interfaces:**
- Produces: `hexToOscColor(hex: string): string` — module-level helper in `terminal.ts`, converts `"#rrggbb"` to xterm's `"rgb:rrrr/gggg/bbbb"` reply format (each hex byte pair doubled).
- Consumes: existing module-level `DEFAULT_FG` / `DEFAULT_BG` (`terminal.ts:52-53`, updated by `setTheme()`), existing `onReply: ((data: string) => void) | null` hook (`terminal.ts:210`).

- [ ] **Step 1: Write the failing tests**

Append to `apps/mobile/src/terminal.test.ts`, right before the final `console.log(\`\n  ${pass} assertions passed\n\`);` line:

```typescript
// 55. OSC 10 query replies with the current theme foreground as an xterm rgb: color.
{
  const t = new TerminalEmulator(80, 24);
  const replies: string[] = [];
  t.onReply = (data) => replies.push(data);
  t.write(`${E}]10;?${E}\\`);
  eq(replies.length, 1, 'OSC 10 query produced exactly one reply');
  eq(replies[0], `${E}]10;rgb:cdcd/d6d6/f4f4${E}\\`, 'OSC 10 reply carries Mocha fg as rgb:');
}

// 56. OSC 11 query replies with the current theme background; non-query OSC 10/11 is a no-op.
{
  const t = new TerminalEmulator(80, 24);
  const replies: string[] = [];
  t.onReply = (data) => replies.push(data);
  t.write(`${E}]11;?${E}\\`);
  eq(replies.length, 1, 'OSC 11 query produced exactly one reply');
  eq(replies[0], `${E}]11;rgb:1e1e/1e1e/2e2e${E}\\`, 'OSC 11 reply carries Mocha bg as rgb:');
  t.write(`${E}]10;rgb:ffff/ffff/ffff${E}\\`); // "set" form — must NOT trigger a reply
  eq(replies.length, 1, 'OSC 10 set-form (non-"?") produces no reply');
}
```

`#cdd6f4` is `APP_THEMES.mocha.terminal.fg` and `#1e1e2e` is `APP_THEMES.mocha.terminal.bg` (from `apps/mobile/src/appTheme.ts:77`) — the test file already calls `setTheme(APP_THEMES.mocha.terminal)` at the top, so these are the active defaults.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun --cwd apps/mobile test`
Expected: FAIL — assertion 55/56 throw because `dispatchOsc` doesn't yet handle `ps === '10'`/`'11'`, so `onReply` is never called (`replies.length` is `0`, not `1`).

- [ ] **Step 3: Implement `hexToOscColor` and the OSC 10/11 branch**

In `apps/mobile/src/terminal.ts`, insert this helper immediately before `let PALETTE = buildPalette();` (currently line 77):

```typescript
// xterm OSC 10/11 reply color format: each "#rrggbb" hex byte doubled, e.g.
// "#1e1e2e" -> "rgb:1e1e/1e1e/2e2e".
function hexToOscColor(hex: string): string {
  const h = hex.replace('#', '');
  const r = h.slice(0, 2);
  const g = h.slice(2, 4);
  const b = h.slice(4, 6);
  return `rgb:${r}${r}/${g}${g}/${b}${b}`;
}
```

In `dispatchOsc` (`terminal.ts:638-666`), add a new branch right after the existing `} else if (ps === '8') { ... }` block and before the method's closing `}`:

```typescript
    } else if (ps === '10' || ps === '11') {
      // Query-only (xterm's "set fg/bg" direction is intentionally unsupported —
      // our themes are fixed, a remote app should not override them).
      if (pt === '?') {
        const color = ps === '10' ? DEFAULT_FG : DEFAULT_BG;
        this.onReply?.(`\x1b]${ps};${hexToOscColor(color)}\x1b\\`);
      }
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun --cwd apps/mobile test`
Expected: PASS, assertion count includes the 2 new checks (test 55 has 2 `eq` calls, test 56 has 3).

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/terminal.ts apps/mobile/src/terminal.test.ts
git commit -m "feat(mobile): reply to OSC 10/11 fg/bg color queries"
```

---

### Task 2: OSC 52 clipboard hooks and dispatch

**Files:**
- Modify: `apps/mobile/src/terminal.ts:210` (add two new hook properties right after `onReply`), and `terminal.ts:660-666`-area `dispatchOsc` (add the `ps === '52'` branch), plus a helpers block near `hexToOscColor` from Task 1 for base64 UTF-8 encode/decode.
- Test: `apps/mobile/src/terminal.test.ts` (append after Task 1's tests)

**Interfaces:**
- Produces: `onClipboardWrite: ((text: string) => void) | null` and `onClipboardRead: (() => Promise<string>) | null` — new public instance properties on `TerminalEmulator`, defaulting to `null` (mirrors `onReply` at `terminal.ts:210`). Also produces module-level `utf8ToBase64(text: string): string` and `base64ToUtf8(b64: string): string` helpers.
- Consumes: `onReply` (Task 1's OSC 10/11 code and this task's OSC 52 query reply both call it); nothing from Task 1's `hexToOscColor` (independent helper).

- [ ] **Step 1: Write the failing tests**

Append to `apps/mobile/src/terminal.test.ts`, before the final `console.log` line (after Task 1's tests 55-56):

```typescript
// 57. OSC 52 write: base64 payload is decoded and handed to onClipboardWrite.
{
  const t = new TerminalEmulator(80, 24);
  const written: string[] = [];
  t.onClipboardWrite = (text) => written.push(text);
  t.write(`${E}]52;c;aGVsbG8gd29ybGQ=${E}\\`); // base64("hello world")
  eq(written, ['hello world'], 'OSC 52 write decodes base64 to onClipboardWrite');
}

// 58. OSC 52 write: non-ASCII text round-trips correctly (UTF-8 safe base64).
{
  const t = new TerminalEmulator(80, 24);
  const written: string[] = [];
  t.onClipboardWrite = (text) => written.push(text);
  t.write(`${E}]52;c;44GT44KT44Gr44Gh44Gv${E}\\`); // base64("こんにちは")
  eq(written, ['こんにちは'], 'OSC 52 write decodes multi-byte UTF-8 base64 correctly');
}

// 59. OSC 52 query: onClipboardRead result is base64-encoded and sent via onReply.
{
  const t = new TerminalEmulator(80, 24);
  const replies: string[] = [];
  t.onReply = (data) => replies.push(data);
  t.onClipboardRead = () => Promise.resolve('hello world');
  t.write(`${E}]52;c;?${E}\\`);
  await Promise.resolve(); // let the onClipboardRead().then(...) microtask run
  eq(replies, [`${E}]52;c;aGVsbG8gd29ybGQ=${E}\\`], 'OSC 52 query replies with base64-encoded clipboard text');
}

// 60. OSC 52 write: malformed base64 fails silently — no throw, no onClipboardWrite call.
{
  const t = new TerminalEmulator(80, 24);
  const written: string[] = [];
  t.onClipboardWrite = (text) => written.push(text);
  t.write(`${E}]52;c;not-valid-base64!!!${E}\\`);
  eq(written, [], 'malformed OSC 52 base64 does not call onClipboardWrite');
}
```

Test 59 needs the enclosing script to support top-level `await` — confirm by checking the existing file has no top-level `await` yet; if `bun run`/`bun test` rejects it, wrap that block's body in an immediately-invoked async function instead:

```typescript
// 59. OSC 52 query: onClipboardRead result is base64-encoded and sent via onReply.
await (async () => {
  const t = new TerminalEmulator(80, 24);
  const replies: string[] = [];
  t.onReply = (data) => replies.push(data);
  t.onClipboardRead = () => Promise.resolve('hello world');
  t.write(`${E}]52;c;?${E}\\`);
  await Promise.resolve();
  eq(replies, [`${E}]52;c;aGVsbG8gd29ybGQ=${E}\\`], 'OSC 52 query replies with base64-encoded clipboard text');
})();
```

Bun supports top-level `await` in both ESM scripts and `bun test`, so the plain form should work — but try it first and fall back to the IIFE form only if step 2 shows a syntax error rather than a normal assertion failure.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun --cwd apps/mobile test`
Expected: FAIL — tests 57-59 fail because `dispatchOsc` doesn't handle `ps === '52'` yet (`written`/`replies` stay empty). Test 60 currently passes vacuously (nothing calls `onClipboardWrite` either way) — that's fine, it starts asserting real behavior once Step 3 lands and must still pass after.

- [ ] **Step 3: Implement clipboard hooks, base64 helpers, and the OSC 52 branch**

In `apps/mobile/src/terminal.ts`, add the two hook properties right after `onReply` (currently `terminal.ts:210`):

```typescript
  onReply: ((data: string) => void) | null = null;

  // Wired by the UI to the device clipboard (OSC 52). Write: decoded OSC 52
  // payload text. Read: returns a Promise resolving to the current clipboard
  // text, used to answer an OSC 52 query via onReply.
  onClipboardWrite: ((text: string) => void) | null = null;
  onClipboardRead: (() => Promise<string>) | null = null;
```

Add these two module-level helpers next to `hexToOscColor` (from Task 1), before `let PALETTE = buildPalette();`:

```typescript
// btoa/atob are Latin1-only; round-tripping arbitrary clipboard text (which
// may contain multi-byte UTF-8) needs the encodeURIComponent/decodeURIComponent
// trick below rather than TextEncoder/TextDecoder, whose Hermes support is less
// consistently available across RN versions than atob/btoa/encodeURIComponent.
function utf8ToBase64(text: string): string {
  const latin1 = encodeURIComponent(text).replace(/%([0-9A-F]{2})/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
  return btoa(latin1);
}

function base64ToUtf8(b64: string): string {
  const latin1 = atob(b64);
  const percentEncoded = latin1
    .split('')
    .map((c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'))
    .join('');
  return decodeURIComponent(percentEncoded);
}
```

In `dispatchOsc`, add a new branch after the OSC 10/11 branch from Task 1 and before the method's closing `}`:

```typescript
    } else if (ps === '52') {
      // pt is "<buffer-letters>;<base64-or-?>" — buffer letter (c/p/s/0-7) is
      // ignored, mobile has no separate primary-selection concept.
      const dataSep = pt.indexOf(';');
      const payload = dataSep === -1 ? '' : pt.slice(dataSep + 1);
      if (payload === '?') {
        this.onClipboardRead
          ?.()
          .then((text) => this.onReply?.(`\x1b]52;c;${utf8ToBase64(text)}\x1b\\`))
          .catch(() => {});
      } else if (payload) {
        try {
          this.onClipboardWrite?.(base64ToUtf8(payload));
        } catch {
          // Malformed base64 — drop silently, same as other malformed OSC payloads.
        }
      }
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun --cwd apps/mobile test`
Expected: PASS, assertion count includes all of tests 57-60.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/terminal.ts apps/mobile/src/terminal.test.ts
git commit -m "feat(mobile): decode/reply OSC 52 clipboard read and write"
```

---

### Task 3: Wire clipboard hooks to the device clipboard

**Files:**
- Modify: `apps/mobile/src/useTetherApp.tsx:240` (inside `entryFor()`, right after the existing `term.onReply = ...` assignment)

**Interfaces:**
- Consumes: `TerminalEmulator.onClipboardWrite`/`onClipboardRead` (Task 2), `Clipboard.setStringAsync`/`Clipboard.getStringAsync` from `expo-clipboard` (already imported at `useTetherApp.tsx:23`).
- Produces: nothing new consumed by later tasks — this is the final integration point.

- [ ] **Step 1: Wire the hooks**

In `apps/mobile/src/useTetherApp.tsx`, inside `entryFor()`, right after the existing:

```typescript
      term.onReply = (text) => {
        if (id === activeIdRef.current) wsSend({ type: 'input', text });
      };
```

add:

```typescript
      term.onClipboardWrite = (text) => {
        void Clipboard.setStringAsync(text).catch(() => {});
      };
      term.onClipboardRead = () => Clipboard.getStringAsync();
```

- [ ] **Step 2: Typecheck**

Run: `bun --cwd apps/mobile run lint`
Expected: no new errors (this project's `lint` script is `tsc --noEmit`).

- [ ] **Step 3: Manual on-device verification**

The design's flagged risk: `atob`/`btoa` must exist natively on the actual RN/Hermes runtime, not just in Bun (the test runner). Verify on a running dev build (`npx expo run:ios --device` per this repo's mobile run instructions, or the Android/simulator equivalent already used in this project):

1. Connect to a Tether session running a real shell.
2. Run `printf '\033]52;c;%s\007' "$(echo -n 'osc52 test' | base64)"` in the remote shell — confirms OSC 52 write reaches the phone clipboard (paste anywhere on the phone afterward and confirm it reads "osc52 test").
3. Run `printf '\033]10;?\033\\'` and `printf '\033]11;?\033\\'` in the remote shell followed by `read -t 1 reply; echo "$reply" | cat -v` — confirms a reply comes back (a real shell won't decode it meaningfully, but `cat -v` should show the `^[]10;rgb:.../...` / `^[]11;rgb:.../...` escape sequence, proving `onReply` fired).

If step 3.2 shows no reply, or clipboard paste in step 3.1 doesn't match, `atob`/`btoa` (or the OSC parsing) is broken on-device despite passing the `bun test` suite — stop and re-check the Hermes version before proceeding, per the risk noted in the design spec.

- [ ] **Step 4: Commit**

```bash
git add apps/mobile/src/useTetherApp.tsx
git commit -m "feat(mobile): wire OSC 52 clipboard hooks to expo-clipboard"
```
