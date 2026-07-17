# Multi-Tab Live Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep a live WebSocket open for every tab resident in the mobile/desktop app's session cache (cap 3), not just the active one, so switching tabs is instant and shows already-current output instead of waiting on a replay.

**Architecture:** Replace the app's single global WebSocket connection (torn down and reopened on every tab switch) with a `Map<sessionId, connection>` keyed per cached session. A session's socket opens on first visit and stays open while resident in the LRU cache; it closes on eviction or explicit kill. The desktop (Tauri) Rust bridge currently assumes one global connection and must become connection-id-keyed to allow more than one live socket at a time. Mobile (React Native) sockets are already independent per instance and need no transport-level change. Server and wire protocol are untouched.

**Tech Stack:** Bun + TypeScript (Expo RN mobile app), Rust (Tauri desktop bridge), no test runner beyond the repo's existing `bun run <file>.test.ts` convention.

## Global Constraints

- Live-tab cap stays at 3 (existing `SessionCache` LRU cap) — do not raise or remove it.
- No server (`apps/server`) changes — `/api/ws` already broadcasts per-session to any number of concurrent subscribers.
- No server-side socket multiplexing (one WS carrying multiple sessionIds) — rejected in design as unnecessary complexity at cap 3.
- Formatting is Biome (2-space indent, single quotes, semicolons, trailing commas, width 100) — run `bun format` before committing mobile TS changes.
- Only the active tab ever sends input (`onReply` guard) — this plan must not change that.

---

### Task 1: `SessionCache` eviction hook

**Files:**
- Modify: `apps/mobile/src/sessionCache.ts`
- Test: `apps/mobile/src/sessionCache.test.ts`

**Interfaces:**
- Produces: `new SessionCache(cap?: number, onEvict?: (id: string, entry: SessionEntry) => void)` — `onEvict` is called synchronously inside `touch()`, once per evicted id, right before it's removed from the internal map. Later tasks (Task 4) construct the cache with this second argument.

- [ ] **Step 1: Write the failing test**

Append to `apps/mobile/src/sessionCache.test.ts` (before the final `console.log` line):

```typescript
// onEvict fires with the victim id when the LRU pushes it out
{
  const evicted: string[] = [];
  const c = new SessionCache(2, (id) => evicted.push(id));
  c.touch('a', mk('a'));
  c.touch('b', mk('b'));
  c.touch('c', mk('c')); // evicts 'a' (least recent)
  ok(evicted.length === 1 && evicted[0] === 'a', 'onEvict fires once with victim id');
}

// onEvict does NOT fire for a plain touch of a still-resident entry
{
  const evicted: string[] = [];
  const c = new SessionCache(3, (id) => evicted.push(id));
  c.touch('x', mk('x'));
  c.touch('x', mk('x2')); // re-touch, already present, no eviction
  ok(evicted.length === 0, 'onEvict does not fire when nothing is evicted');
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mobile && bun run src/sessionCache.test.ts`
Expected: FAIL — `SessionCache` constructor doesn't accept a second argument, so `evicted` stays empty and the first new assertion throws `FAIL onEvict fires once with victim id`.

- [ ] **Step 3: Implement the eviction hook**

In `apps/mobile/src/sessionCache.ts`, change the constructor and `touch()`:

```typescript
export class SessionCache {
  private map = new Map<string, SessionEntry>();
  private order: string[] = []; // most-recent first
  constructor(
    private cap = 3,
    private onEvict?: (id: string, entry: SessionEntry) => void,
  ) {}

  get(id: string): SessionEntry | undefined {
    return this.map.get(id);
  }
  has(id: string): boolean {
    return this.map.has(id);
  }

  // Get-or-create `id`, mark it most-recently-used, evict beyond cap.
  touch(id: string, make: () => SessionEntry): SessionEntry {
    let e = this.map.get(id);
    if (!e) {
      e = make();
      this.map.set(id, e);
    }
    this.order = [id, ...this.order.filter((x) => x !== id)];
    while (this.order.length > this.cap) {
      const victim = this.order.pop()!;
      const victimEntry = this.map.get(victim);
      this.map.delete(victim);
      if (victimEntry) this.onEvict?.(victim, victimEntry);
    }
    return e;
  }

  delete(id: string): void {
    this.map.delete(id);
    this.order = this.order.filter((x) => x !== id);
  }

  ids(): string[] {
    return [...this.order];
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mobile && bun run src/sessionCache.test.ts`
Expected: PASS — output ends with `N assertions passed` where N is the previous count + 2, no `FAIL` thrown.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/sessionCache.ts apps/mobile/src/sessionCache.test.ts
git commit -m "feat(mobile): add onEvict hook to SessionCache"
```

---

### Task 2: Tauri Rust bridge — multi-connection `Bridge`

**Files:**
- Modify: `apps/mobile/src-tauri/src/main.rs`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `ws_send` and `ws_close` Tauri commands now require a `conn_id: String` argument matching the `conn_id` passed to `ws_connect`. Task 3 updates the JS invoke call sites to pass it.

- [ ] **Step 1: Add the `HashMap` import**

In `apps/mobile/src-tauri/src/main.rs`, change line 4:

```rust
use std::sync::Mutex;
```
to:
```rust
use std::collections::HashMap;
use std::sync::Mutex;
```

- [ ] **Step 2: Replace the single-slot `Bridge` with a connection-id-keyed map**

Replace lines 13-33 (the doc comment through the `impl Bridge` block):

```rust
// The desktop client's WebSockets live on the Rust side so they can send the
// `Authorization` header (a browser WebSocket can't). The webview talks to them
// via `invoke` (ws_connect/ws_send/ws_close, all keyed by `conn_id`) and receives
// frames as `ws-message-<conn_id>` / `ws-closed-<conn_id>` events. Multiple
// connections can be live at once — one per tab the mobile/desktop app keeps
// synced in the background.
enum Outgoing {
    Text(String),
    Close,
}

#[derive(Default)]
struct Bridge(Mutex<HashMap<String, mpsc::UnboundedSender<Outgoing>>>);

impl Bridge {
    fn get(&self, conn_id: &str) -> Option<mpsc::UnboundedSender<Outgoing>> {
        self.0.lock().unwrap().get(conn_id).cloned()
    }
    fn insert(&self, conn_id: String, tx: mpsc::UnboundedSender<Outgoing>) {
        self.0.lock().unwrap().insert(conn_id, tx);
    }
    fn remove(&self, conn_id: &str) -> Option<mpsc::UnboundedSender<Outgoing>> {
        self.0.lock().unwrap().remove(conn_id)
    }
}
```

- [ ] **Step 3: Update `ws_connect` to insert by `conn_id` instead of closing the one global slot**

Replace the `ws_connect` function body (originally lines 35-96):

```rust
#[tauri::command]
async fn ws_connect(
    app: AppHandle,
    conn_id: String,
    url: String,
    password: String,
) -> Result<(), String> {
    let mut req = url.into_client_request().map_err(|e| e.to_string())?;
    req.headers_mut().insert(
        "Authorization",
        format!("Bearer {password}")
            .parse()
            .map_err(|_| "invalid authorization header".to_string())?,
    );

    let (ws, _resp) = connect_async(req).await.map_err(|e| e.to_string())?;
    let (mut write, mut read) = ws.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Outgoing>();
    app.state::<Bridge>().insert(conn_id.clone(), tx);

    // Reader: forward server frames to the webview. Events are scoped by conn_id
    // so a superseded connection's late frames/close can't hit a newer socket.
    // Also drops this conn_id's entry from the Bridge map once the socket ends,
    // so a naturally-closed (server-side) connection doesn't linger.
    let app_read = app.clone();
    let msg_evt = format!("ws-message-{conn_id}");
    let close_evt = format!("ws-closed-{conn_id}");
    let close_conn_id = conn_id.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(msg) = read.next().await {
            match msg {
                Ok(Message::Text(t)) => {
                    let _ = app_read.emit(&msg_evt, t);
                }
                Ok(Message::Close(_)) | Err(_) => break,
                _ => {}
            }
        }
        app_read.state::<Bridge>().remove(&close_conn_id);
        let _ = app_read.emit(&close_evt, ());
    });

    // Writer: drain the channel into the socket.
    tauri::async_runtime::spawn(async move {
        while let Some(out) = rx.recv().await {
            match out {
                Outgoing::Text(t) => {
                    if write.send(Message::Text(t)).await.is_err() {
                        break;
                    }
                }
                Outgoing::Close => {
                    let _ = write.close().await;
                    break;
                }
            }
        }
    });

    Ok(())
}
```

- [ ] **Step 4: Update `ws_send` and `ws_close` to take `conn_id`**

Replace lines 98-111 (the original `ws_send`/`ws_close` functions):

```rust
#[tauri::command]
fn ws_send(state: State<'_, Bridge>, conn_id: String, text: String) -> Result<(), String> {
    match state.get(&conn_id) {
        Some(tx) => tx.send(Outgoing::Text(text)).map_err(|e| e.to_string()),
        None => Err("not connected".into()),
    }
}

#[tauri::command]
fn ws_close(state: State<'_, Bridge>, conn_id: String) {
    if let Some(tx) = state.remove(&conn_id) {
        let _ = tx.send(Outgoing::Close);
    }
}
```

- [ ] **Step 5: Build to verify it compiles**

Run: `cd apps/mobile/src-tauri && cargo build`
Expected: `Compiling tether-mobile v...` then `Finished` with no errors. (Ignore pre-existing warnings unrelated to this change.)

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/src-tauri/src/main.rs
git commit -m "feat(desktop): key Tauri WS bridge by conn_id, allow multiple live connections"
```

---

### Task 3: `wsTransport.ts` — thread `connId` through send/close

**Files:**
- Modify: `apps/mobile/src/wsTransport.ts`

**Interfaces:**
- Consumes: Task 2's `ws_send`/`ws_close` Tauri commands now requiring `conn_id`.
- Produces: no change to `TerminalSocket` / `openTerminalSocket`'s public shape — `useTetherApp.tsx` (Task 4) is unaffected by this task and needs no changes to consume it.

- [ ] **Step 1: Update the two `invoke` calls inside `openTauriSocket`**

In `apps/mobile/src/wsTransport.ts`, inside `openTauriSocket` (around lines 71-79), change:

```typescript
  return {
    send: (t) => {
      // A send after the Rust side has dropped the socket rejects; treat that as
      // a close so the app can reflect the state and reconnect, instead of
      // silently losing the keystroke.
      invoke('ws_send', { text: t }).catch(() => {
        cleanup();
        h.onClose();
      });
    },
    close: () => {
      cleanup();
      void invoke('ws_close');
    },
  };
```

to:

```typescript
  return {
    send: (t) => {
      // A send after the Rust side has dropped the socket rejects; treat that as
      // a close so the app can reflect the state and reconnect, instead of
      // silently losing the keystroke.
      invoke('ws_send', { connId, text: t }).catch(() => {
        cleanup();
        h.onClose();
      });
    },
    close: () => {
      cleanup();
      void invoke('ws_close', { connId });
    },
  };
```

(`connId` is already the function's first parameter — no signature change needed, just the two `invoke()` call sites.)

- [ ] **Step 2: Typecheck**

Run: `cd apps/mobile && npx tsc --noEmit`
Expected: no new errors (this file has no dedicated test; the existing typecheck script is the verification gate for a pure signature-preserving edit).

- [ ] **Step 3: Commit**

```bash
git add apps/mobile/src/wsTransport.ts
git commit -m "fix(mobile): pass connId to Tauri ws_send/ws_close invoke calls"
```

---

### Task 4: `useTetherApp.tsx` — per-session connections, drop disconnect-on-switch, fix clipboard guard

**Files:**
- Modify: `apps/mobile/src/useTetherApp.tsx`

**Interfaces:**
- Consumes: `SessionCache`'s `onEvict` constructor param (Task 1).
- Produces: `connect(id: string)` / `disconnect(id: string)` replace the old zero-arg `connect()` / `disconnect()` used elsewhere in this same file (all call sites updated in this task, no external consumers).

- [ ] **Step 1: Wire the cache's `onEvict` to close a session's connection**

Find (around line 154):

```typescript
  const cache = useRef(new SessionCache(3)).current;
```

This must become a two-step construction so `onEvict` can call `disconnect`, which is defined later in the file — use a forward-reference ref:

```typescript
  const disconnectRef = useRef<(id: string) => void>(() => {});
  const cache = useRef(new SessionCache(3, (id) => disconnectRef.current(id))).current;
```

- [ ] **Step 2: Add the `connections` map and its `ConnState` type**

In `apps/mobile/src/useTetherApp.tsx`, find (around line 176):

```typescript
  const sock = useRef<TerminalSocket | null>(null);
  const gen = useRef(0);
  const open = useRef(false);
```

Replace with:

```typescript
  type ConnState = {
    sock: TerminalSocket | null;
    gen: number;
    open: boolean;
    reconnectTimeout: any;
  };
  const connections = useRef(new Map<string, ConnState>()).current;
  const connState = (id: string): ConnState => {
    let s = connections.get(id);
    if (!s) {
      s = { sock: null, gen: 0, open: false, reconnectTimeout: null };
      connections.set(id, s);
    }
    return s;
  };
```

Note: this removes `sock`, `gen`, `open` as standalone refs — they're superseded by per-id entries in `connections`. The bare `reconnectTimeout` ref (declared a few lines below, around line 179) is also superseded — remove its standalone declaration entirely (grep confirms it's only referenced inside `connect`/`disconnect`, both rewritten in this task). Delete the line:

```typescript
  const reconnectTimeout = useRef<any>(null);
```

- [ ] **Step 3: Rewrite `wsSend` to route through the active tab's connection**

Find (around line 244):

```typescript
  const wsSend = (obj: unknown) => {
    if (open.current && sock.current) sock.current.send(JSON.stringify(obj));
  };
```

Replace with:

```typescript
  const wsSend = (obj: unknown) => {
    const st = connections.get(activeIdRef.current);
    if (st?.open && st.sock) st.sock.send(JSON.stringify(obj));
  };
```

- [ ] **Step 4: Rewrite `connect`/`disconnect` to be per-id**

Find the existing `connect` and `disconnect` functions (originally around lines 344-393):

```typescript
  const connect = () => {
    disconnect();
    lastConnectedRef.current = { ip: serverIp, port };
    const id = activeIdRef.current;
    const e = entryFor(id);
    setConnectionStatus('connecting');
    const url = wsUrl(serverIp, port, {
      sessionId: id,
      sinceId: e.sinceId,
      cols: numCols,
      rows: numRows,
    });

    // Each connect bumps the generation; a superseded socket's late callbacks are
    // ignored (replaces the old `ws.current !== socket` staleness check).
    const myGen = ++gen.current;
    const fresh = () => myGen === gen.current;

    sock.current = openTerminalSocket(url, passwordRef.current, {
      onOpen: () => {
        if (!fresh()) return;
        hasConnectedRef.current = true;
        open.current = true;
        setConnectionStatus('connected');
      },
      onMessage: (data) => {
        if (fresh()) applyWsMessage(id, data);
      },
      onClose: () => {
        if (!fresh()) return;
        open.current = false;
        setConnectionStatus('disconnected');
        if (readyRef.current && activeIdRef.current === id) {
          reconnectTimeout.current = setTimeout(connect, 3000);
        }
      },
    });
  };

  const disconnect = () => {
    if (reconnectTimeout.current) {
      clearTimeout(reconnectTimeout.current);
      reconnectTimeout.current = null;
    }
    gen.current++; // invalidate any in-flight handlers
    open.current = false;
    const s = sock.current;
    sock.current = null;
    if (s) s.close();
    setConnectionStatus('disconnected');
  };
```

Replace with:

```typescript
  // Each cached session (cap 3, LRU) keeps its own live socket instead of the
  // app owning one global connection torn down on every tab switch. Only the
  // active tab's connectionStatus surfaces in the titlebar; background tabs
  // reconnect on their own (gated on still being cache-resident, not on being
  // active) so they keep receiving output while backgrounded.
  const connect = (id: string) => {
    disconnect(id); // clean slate: tear down any stale entry for this id first
    lastConnectedRef.current = { ip: serverIp, port };
    const e = entryFor(id);
    const st = connState(id);
    if (id === activeIdRef.current) setConnectionStatus('connecting');
    const url = wsUrl(serverIp, port, {
      sessionId: id,
      sinceId: e.sinceId,
      cols: numCols,
      rows: numRows,
    });

    // Each connect bumps this id's generation; a superseded socket's late
    // callbacks are ignored (replaces the old `ws.current !== socket` check).
    const myGen = ++st.gen;
    const fresh = () => myGen === st.gen;

    st.sock = openTerminalSocket(url, passwordRef.current, {
      onOpen: () => {
        if (!fresh()) return;
        st.open = true;
        if (id === activeIdRef.current) {
          hasConnectedRef.current = true;
          setConnectionStatus('connected');
        }
      },
      onMessage: (data) => {
        if (fresh()) applyWsMessage(id, data);
      },
      onClose: () => {
        if (!fresh()) return;
        st.open = false;
        if (id === activeIdRef.current) setConnectionStatus('disconnected');
        if (readyRef.current && cache.has(id)) {
          st.reconnectTimeout = setTimeout(() => connect(id), 3000);
        }
      },
    });
  };

  const disconnect = (id: string) => {
    const st = connections.get(id);
    if (!st) return;
    if (st.reconnectTimeout) {
      clearTimeout(st.reconnectTimeout);
      st.reconnectTimeout = null;
    }
    st.gen++; // invalidate any in-flight handlers
    st.open = false;
    st.sock?.close();
    connections.delete(id);
    if (id === activeIdRef.current) setConnectionStatus('disconnected');
  };

  const disconnectAll = () => {
    for (const id of Array.from(connections.keys())) disconnect(id);
  };

  disconnectRef.current = disconnect;
```

- [ ] **Step 5: Simplify `switchTo` to stop tearing down other tabs**

Find (around line 397):

```typescript
  // Switch to a different session
  const switchTo = (id: string) => {
    setDrawerOpen(false);
    if (id === activeIdRef.current && sock.current) return;
    disconnect();
    activeIdRef.current = id;
    setActiveId(id);
    AsyncStorage.setItem(KEY_SESSION_ID, id);
    const e = entryFor(id); // creates fresh if uncached; resizes handled by effect
    setScreen(e.term.getSnapshot()); // instant paint of last-known screen
    autoScroll.current = true;
    lastContentHeight.current = 0;
    connect();
  };
```

Replace with:

```typescript
  // Switch to a different session. Does NOT disconnect the tab being left —
  // it keeps streaming in the background as long as it's cache-resident.
  const switchTo = (id: string) => {
    setDrawerOpen(false);
    if (id === activeIdRef.current) return;
    activeIdRef.current = id;
    setActiveId(id);
    AsyncStorage.setItem(KEY_SESSION_ID, id);
    const e = entryFor(id); // creates fresh if uncached; resizes handled by effect
    setScreen(e.term.getSnapshot()); // instant paint of last-known screen
    autoScroll.current = true;
    lastContentHeight.current = 0;
    const st = connections.get(id);
    if (st?.open) {
      setConnectionStatus('connected'); // already live — no reconnect flicker
    } else {
      connect(id);
    }
  };
```

- [ ] **Step 6: Update the config-load effect's unmount cleanup**

Find (around line 654, inside the `loadConfig` effect):

```typescript
    loadConfig();
    return () => disconnect();
  }, []);
```

Replace with:

```typescript
    loadConfig();
    return () => disconnectAll();
  }, []);
```

- [ ] **Step 7: Update the WebSocket-management effect to stop reconnecting on every tab switch**

Find (around line 671):

```typescript
  // 2. Manage WebSocket connection — reconnects on session switch. Opening
  // Settings does NOT tear this down; only an address/port change (saveConfig)
  // or an actual session switch touches the socket.
  useEffect(() => {
    if (!ready) return;
    connect();
    return () => disconnect();
  }, [ready, activeId]);
```

Replace with:

```typescript
  // 2. Open the initial connection once the app becomes ready. Tab switches no
  // longer touch this effect — switchTo() connects the newly-active tab itself
  // if it isn't already live, and leaves every other resident tab's socket
  // alone. Only unmount or an address/port change (saveConfig) tears sockets
  // down wholesale.
  useEffect(() => {
    if (!ready) return;
    connect(activeIdRef.current);
    return () => disconnectAll();
  }, [ready]);
```

- [ ] **Step 8: Update `saveConfig`'s address-change branch**

Find (around line 785, inside `saveConfig`):

```typescript
      if (addressChanged) hasConnectedRef.current = false;
      setIsConfiguring(false);
      if (!readyRef.current) {
        readyRef.current = true;
        setReady(true);
      } else if (addressChanged) {
        resetTerminal();
        connect();
      }
```

Replace with:

```typescript
      if (addressChanged) hasConnectedRef.current = false;
      setIsConfiguring(false);
      if (!readyRef.current) {
        readyRef.current = true;
        setReady(true);
      } else if (addressChanged) {
        // The server address changed — every resident tab's socket points at
        // the old host. Drop them all; only the active tab reconnects
        // immediately, the rest reconnect lazily on next visit (switchTo's
        // connect-if-not-open fallback).
        disconnectAll();
        resetTerminal();
        connect(activeIdRef.current);
      }
```

- [ ] **Step 9: Update `killActiveOr` to close that specific session's connection**

Find (around line 417, inside `killActiveOr`):

```typescript
    cache.delete(id);
    const remaining = drawerSessions.filter((s) => s.id !== id).map((s) => s.id);
```

Replace with:

```typescript
    cache.delete(id);
    disconnect(id);
    const remaining = drawerSessions.filter((s) => s.id !== id).map((s) => s.id);
```

- [ ] **Step 10: Update `hardResetSession`'s reconnect call**

Find (around line 1316, inside `hardResetSession`):

```typescript
      connect();
    } catch (e) {
      void notify('Error', 'Failed to kill session on the server', 'error');
    }
```

Replace with:

```typescript
      connect(activeIdRef.current);
    } catch (e) {
      void notify('Error', 'Failed to kill session on the server', 'error');
    }
```

- [ ] **Step 11: Fix the clipboard-write background-tab guard**

Find (inside `entryFor`, around line 237):

```typescript
      term.onReply = (text) => {
        if (id === activeIdRef.current) wsSend({ type: 'input', text });
      };
      term.onClipboardWrite = (text) => {
        void Clipboard.setStringAsync(text).catch(() => {});
      };
```

Replace with:

```typescript
      term.onReply = (text) => {
        if (id === activeIdRef.current) wsSend({ type: 'input', text });
      };
      term.onClipboardWrite = (text) => {
        // Guard like onReply: now that background tabs stay live, an OSC 52
        // sequence arriving in a backgrounded tab must not silently overwrite
        // the device clipboard while the user is looking at a different tab.
        if (id === activeIdRef.current) void Clipboard.setStringAsync(text).catch(() => {});
      };
```

- [ ] **Step 12: Update the entryFor doc comment (now stale)**

Find (just above `entryFor`, around line 232):

```typescript
  // Helper to get/create the cache entry for a given id, sized to the current grid.
  const entryFor = (id: string): SessionEntry =>
    cache.touch(id, () => {
      const term = new TerminalEmulator(numCols || 80, numRows || 24);
      // Only the active session holds a live socket, so replies from a
      // backgrounded session's emulator have nowhere to go — drop them.
```

Replace the comment lines with:

```typescript
  // Helper to get/create the cache entry for a given id, sized to the current grid.
  const entryFor = (id: string): SessionEntry =>
    cache.touch(id, () => {
      const term = new TerminalEmulator(numCols || 80, numRows || 24);
      // Backgrounded sessions do hold a live socket now, but only the active
      // tab is allowed to send input — route everyone else's replies nowhere.
```

- [ ] **Step 13: Typecheck**

Run: `cd apps/mobile && npx tsc --noEmit`
Expected: no errors. If any remain, they are leftover references to the removed `sock`/`gen`/`open`/`reconnectTimeout` refs or to the old zero-arg `connect()`/`disconnect()` — grep for `sock.current`, `gen.current`, `open.current`, `reconnectTimeout.current`, `connect()`, `disconnect()` in this file and fix each remaining call site the same way Steps 6-10 did.

- [ ] **Step 14: Lint**

Run: `cd apps/mobile && bun run lint` (or `bun format` from repo root, per `CLAUDE.md`)
Expected: no errors.

- [ ] **Step 15: Manual smoke test — basic connectivity unaffected**

Run: `bun dev:mobile` (or the desktop dev flow), connect to a running `tether` server, open the default terminal, type a command, confirm output appears. This is the pre-existing single-tab path exercised through the new per-id code — confirms no regression before testing the new multi-tab behavior in Task 5.

- [ ] **Step 16: Commit**

```bash
git add apps/mobile/src/useTetherApp.tsx
git commit -m "feat(mobile): keep every cached tab's socket live instead of disconnecting on switch"
```

---

### Task 5: End-to-end multi-tab verification

**Files:** none (manual verification only — no test harness exists for `useTetherApp.tsx` or the Tauri bridge, matching this repo's existing convention).

**Interfaces:**
- Consumes: Tasks 1-4, complete.

- [ ] **Step 1: Verify background tabs stay live (desktop)**

Run the desktop app (`cd apps/mobile && npx expo run:ios --device` is iOS-only — for desktop use the Tauri dev flow already used by this repo, e.g. `bun --cwd apps/mobile tauri dev` or the project's existing documented desktop dev command). Open 3 tabs. In tab 1, run a command that produces continuous output every second, e.g.:

```bash
while true; do date; sleep 1; done
```

Switch to tab 2, wait 5 seconds, switch back to tab 1.
Expected: tab 1 shows output for the seconds that elapsed while backgrounded (not a blank pause then a burst-replay) — confirms the socket kept streaming while tab 1 was not on screen.

- [ ] **Step 2: Verify the 4th tab evicts the 1st and closes its connection**

With 3 tabs open and live (per Step 1), open a 4th tab (`newTerminal`).
Expected: the least-recently-used of the original 3 tabs is evicted from the drawer's session cache. Revisiting that evicted tab afterward shows a fresh full replay (cold reattach), not an instant paint — confirming its socket was actually closed on eviction, not leaked.

- [ ] **Step 3: Verify instant switch between two already-live tabs**

With 2+ tabs live and both having received output while backgrounded, switch between them repeatedly.
Expected: each switch paints instantly with no `'connecting'` flash in the titlebar — confirms `switchTo` is reusing the existing open socket instead of reconnecting.

- [ ] **Step 4: Verify the clipboard guard fix**

In a backgrounded (non-active) tab, run a command that emits an OSC 52 clipboard-write sequence, e.g. (from a shell, using `printf` with base64):

```bash
printf '\033]52;c;%s\a' "$(printf 'background-tab-test' | base64)"
```

while that tab is NOT the active one.
Expected: the device/OS clipboard is unchanged. Switch to that tab and re-run the same command while it IS active — now the clipboard should contain `background-tab-test`.

- [ ] **Step 5: Verify explicit kill closes the connection**

With a background tab live and producing output, kill it via the drawer's kill action (not by switching away).
Expected: no console/log errors about sending on a closed socket; the tab disappears from the drawer as before.

- [ ] **Step 6: Verify mobile (RN, no Tauri) path is unaffected**

Run on iOS/Android (`npx expo run:ios --device` or Android equivalent). Repeat Step 1 (background output continues) and Step 3 (instant switch).
Expected: same behavior as desktop — RN's `openRnSocket` already supports independent concurrent sockets with no code change in this plan, so this step is a regression check, not new functionality.

- [ ] **Step 7: Record results and close out**

No commit for this task (verification only). If any expectation fails, file it as a new task on the board rather than patching ad hoc — the fix likely belongs in Task 4's step that owns the relevant behavior.
