# Full xterm.js Renderer

**Date:** 2026-07-25
**Board:** #395
**Status:** Approved direction; implementation gated by the feasibility test below

## Problem

Tether uses `@xterm/headless` only as a parser. During streaming, every render batch then:

1. scans up to ~1,045 rows across every column;
2. rebuilds styled run and link objects;
3. stores the full snapshot in React state; and
4. reconciles a `FlatList` of nested React Native `<Text>` elements.

A local benchmark at 1,045 rows × 160 columns measured `getSnapshot()` at 11.81 ms per
call—71% of a 16.67 ms desktop frame before React paints. Mobile performs this work up to
30 times per second, matching the reported streaming stutter and iOS battery drain.

The WebSocket and server are not the bottleneck. The server already combines holder frames
received in one socket read, and the client coalesces paints. The expensive step is converting
xterm's buffer into a second React rendering model.

Desktop resize currently debounces the dimensions that drive both terminal geometry and row
width. The window therefore changes immediately while the terminal keeps painting stale
geometry for 200 ms, which explains the visibly broken intermediate repaint.

## Decision

Use the full xterm.js renderer:

- **iOS/Android:** full xterm.js in a local `react-native-webview` page.
- **Desktop/web:** full xterm.js mounted directly in the existing browser/webview DOM.
- Prefer xterm's WebGL addon when it initializes successfully; fall back to its supported DOM
  renderer when WebGL is unavailable or loses its context.

This follows WebSSH's proven model: xterm owns terminal parsing, damage tracking, viewport
painting, selection, cursor, and resize rendering instead of turning terminal cells into React
components.

## Feasibility Gate

Before replacing the current renderer, build a disposable one-session spike and test it on a
physical iPhone and the desktop app.

The spike must demonstrate:

- sustained real PTY streaming without missing or reordered bytes;
- WebGL initialization, plus automatic DOM fallback;
- terminal resize and remote PTY resize without intermediate corruption;
- typing, IME composition, paste, links, selection, and touch scrolling;
- no regression in OSC replies, bell/title/cwd/notification handling;
- materially lower Xcode Energy Impact and smoother frame pacing than the current renderer.

If the spike does not clearly improve both streaming energy use and resize behavior, stop. Do
not ship a WebView rewrite on architectural faith.

## Architecture

### Keep the existing transport and session model

React Native continues to own authenticated WebSockets, reconnect/replay IDs, the three-session
LRU cache, server configuration, previews, files, diffs, and native notifications. Passwords and
authentication headers never enter the renderer page.

PTY output remains ordered by the existing log ID. Output destined for the active renderer is
joined into one bridge delivery per render frame rather than evaluating JavaScript for each
small server frame.

### Keep headless parsing temporarily; remove snapshot painting

`TerminalEngine` remains the authoritative non-visual session state in the first release. It
continues parsing every session for replies, modes, bell/title/cwd/OSC notifications, prompt
markers, and background-tab behavior.

The active output is also written to the full xterm renderer. This duplicates inexpensive
parsing but deletes the expensive path: streaming no longer calls `getSnapshot()`, stores a
full screen in React state, or paints `TermRow`/`FlatList`.

Keeping the headless engine avoids rewriting Tether-specific session behavior in the renderer
bridge. It can be removed later only if profiling shows duplicate parsing matters and all
headless responsibilities have first moved behind tested renderer events.

### One active renderer, serialized handoff

Only the active terminal owns a visible full-xterm renderer. Background sessions keep their
headless engines and WebSockets but no hidden WebViews or WebGL contexts.

Use xterm's compatible serialize addon with the headless terminal to produce terminal state
when:

- the renderer first mounts;
- the active session changes; or
- the renderer recovers after a crash/context loss.

The renderer resets, consumes that serialized state once, then receives live output batches.
Serialization is an infrequent tab-switch/recovery cost, not a streaming cost. This avoids
keeping three hidden WebViews alive and protects the battery improvement.

### Renderer bridge

The native renderer page exposes a deliberately small interface:

```ts
hydrate(serializedState, cols, rows, theme)
write(outputBatch)
resize(cols, rows)
focus()
dispose()
```

It sends these events back to React Native:

```ts
ready
input(text)
resize(cols, rows)
openLink(target)
selection(text)
rendererFallback(reason)
```

Bridge messages are versioned and validated. Terminal output is treated as data passed to
`terminal.write`, never interpolated as executable JavaScript.

Desktop implements the same interface in-process without the React Native/WebView message hop.

### Input and links

xterm owns terminal focus, keyboard composition, selection, scrolling, and mouse reporting.
Its `onData` output is forwarded through the existing authenticated socket. Tether's utility
bar and snippets still send through the same socket and appear via normal PTY echo.

Register a custom xterm link provider that preserves both existing link behaviors:

- external URLs open through the platform opener;
- absolute/relative file references call Tether's authenticated file viewer.

OSC 8 links remain handled by xterm.

### Resize

The renderer fits its visible container immediately via `ResizeObserver`/xterm fitting, so
painting always matches the current viewport.

Renderer resize events are deduplicated. The local headless terminal updates immediately;
the remote PTY resize is sent on the settled trailing edge, with a final guaranteed send. This
keeps live repaint fluid without repeatedly reflowing the shared server PTY during a drag.

## Failure Handling

- WebGL initialization/context loss switches that renderer to xterm's DOM renderer and reports
  the fallback for diagnostics.
- A native WebView crash remounts and hydrates from the headless engine's serialized state.
- Invalid renderer messages are ignored.
- Until the feasibility gate passes, the existing `FlatList` renderer remains available behind
  a temporary internal switch. Remove it once physical-device and desktop verification pass;
  do not keep two permanent renderer architectures.

## Verification

- Unit tests: bridge message validation, ordered batching, resize deduplication, and active-tab
  hydrate/live-write ordering.
- Existing `terminalEngine` conformance suite remains unchanged.
- Desktop: sustained-output frame profile, continuous window resize, links, selection, IME,
  alt-screen TUIs, and reconnect replay.
- Physical iPhone: the same terminal smoke test plus Xcode Energy Log comparison during a fixed
  streaming workload.
- Android: build and emulator smoke before release; physical energy testing is not required for
  the initial gate because the reported battery regression is iOS.

## Success Criteria

- No full-buffer snapshot generation or React terminal-row reconciliation during live output.
- Streaming remains visibly responsive at 80, 120, and 160 columns.
- Resize has no stale-width/corrupt intermediate paint.
- Physical-iPhone streaming energy usage is materially lower under the same workload.
- Existing replay, multi-session, links, input, selection, notifications, and TUI behavior pass.

## Non-goals

- Changing the WebSocket protocol or server PTY persistence.
- Adding another custom GPU renderer.
- Replacing the headless engine in the same release.
- Keeping the old React renderer as a permanent fallback.
