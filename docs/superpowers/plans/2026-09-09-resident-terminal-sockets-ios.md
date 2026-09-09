# Resident Terminal Sockets — iOS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the native iOS client, switching terminal tabs while the app is foregrounded causes zero replay — non-visible sessions keep a live Noise socket and stream in the background, up to an LRU cap; the OS still suspends everything when the app is backgrounded.

**Architecture:** Replace `SessionStore`'s single `TerminalPipeline` with an LRU dictionary of pipelines (cap 8), keyed by host-qualified session key. The active session's pipeline feeds the visible surface (`terminalSnapshot`) and receives input/focus; background pipelines keep their channel open and feed their emulator (advancing the shared replay cursor) with snapshot rasterization gated off. A single shared `FfiReplayStore` is injected into every pipeline so N pipelines never write the cursor file concurrently.

**Tech Stack:** Swift 6 / SwiftUI, Swift concurrency (actors), UniFFI-generated `TetherFFIBindings`, `alacritty_terminal` via `tether-core`. Tests: XCTest via `xcodebuild test -scheme TetherKit` on a simulator (host `swift test` mis-links the FFI — always use the sim). Verified on the `macbuild` host.

**Spec:** `docs/superpowers/specs/2026-09-09-resident-terminal-sockets-design.md`

## Global Constraints

- Base this branch on `fix/terminal-replay-cursor-persistence` (PR #172) or on `main` after it merges — depends on `FfiReplayStore.withPath(path:)` and the persisted cursor.
- Resident cap: **8**, LRU. The active session is always resident and never evicted.
- Foreground-only: on `scenePhase` background, close every socket; on foreground, reconnect the resident set. Never assume background streaming.
- One shared `FfiReplayStore` across all pipelines. Never construct a per-pipeline path-backed store (N writers to one file corrupts it).
- Input, focus, paste stay gated to the active session (existing gate).
- iOS FFI-binding call sites: a uniffi named constructor `with_x` generates a Swift **static** `withX(...)`, not `init(x:)` (see repo memory). Build on `macbuild` — Linux cannot surface Swift-compile errors.
- Verification always regenerates the XCFramework first (`scripts/build-xcframework.sh`); a stale one hides core changes.

---

### Task 1: Share one replay cursor store across pipelines

**Files:**
- Modify: `clients/apple/TetherKit/Sources/TetherKit/Terminal/TerminalPipeline.swift` (the `private let replayStore = ...` at line ~61 and `init`)
- Modify: `clients/apple/TetherKit/Sources/TetherKit/SessionStore.swift` (owns the pipeline)

**Interfaces:**
- Consumes: `FfiReplayStore` (from `TetherFFIBindings`), `FfiReplayStore.withPath(path:)` (PR #172).
- Produces: `TerminalPipeline.init(replayStore: FfiReplayStore)` — the pipeline no longer builds its own store.

- [ ] **Step 1: Make the pipeline take an injected store**

In `TerminalPipeline.swift`, replace:

```swift
  private let replayStore = TerminalPipeline.makeReplayStore()
```

with:

```swift
  private let replayStore: FfiReplayStore
```

and change `init()` to:

```swift
  init(replayStore: FfiReplayStore) {
    self.replayStore = replayStore
    (snapshots, snapshotSink) = AsyncStream.makeStream(
      of: Optional<Data>.self,
      bufferingPolicy: .bufferingNewest(1)
    )
    (events, eventSink) = AsyncStream.makeStream(of: TerminalPipelineEvent.self)
    (outboundFrames, outbound) = AsyncStream.makeStream(of: OutboundFrame.self)
  }
```

Move the `makeReplayStore()` factory (App Support path + fail-open, added in PR #172) from `TerminalPipeline` to a `static func makeReplayStore() -> FfiReplayStore` on `SessionStore` (same body). It is now built once.

- [ ] **Step 2: Build the shared store once in SessionStore**

In `SessionStore.swift`, replace the single-pipeline field (line ~62):

```swift
  @ObservationIgnored private let pipeline = TerminalPipeline()
```

with the shared store plus (for now) a single pipeline built from it — the dict comes in Task 3:

```swift
  @ObservationIgnored private let replayStore = SessionStore.makeReplayStore()
  @ObservationIgnored private lazy var pipeline = TerminalPipeline(replayStore: replayStore)
```

- [ ] **Step 3: Regenerate bindings and build on macbuild**

Run (on `macbuild`, in the synced tree):
```bash
PROFILE=debug bash scripts/build-xcframework.sh
xcodebuild build -project clients/apple/Tether.xcodeproj -scheme TetherIOS \
  -destination 'generic/platform=iOS Simulator' -configuration Debug \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO
```
Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 4: Commit**

```bash
git add clients/apple/TetherKit/Sources/TetherKit/Terminal/TerminalPipeline.swift \
        clients/apple/TetherKit/Sources/TetherKit/SessionStore.swift
git commit -m "refactor(ios): inject a shared FfiReplayStore into TerminalPipeline"
```

---

### Task 2: Gate snapshot rasterization when a pipeline is not shown

**Files:**
- Modify: `clients/apple/TetherKit/Sources/TetherKit/Terminal/TerminalPipeline.swift` (`publishSnapshot` at line ~383, add a `rendering` flag + setter)
- Test: `clients/apple/TetherKit/Tests/TetherKitTests/TerminalPipelineRenderingTests.swift`

**Interfaces:**
- Produces: `func setRendering(_ on: Bool)` on `TerminalPipeline`. When `false`, `publishSnapshot()` returns early (emulator still fed, cursor still advanced), so a background pipeline does not rasterize grids.

- [ ] **Step 1: Add the flag and gate**

Add a stored property near the other pipeline state:

```swift
  /// When false, output is still fed to the emulator and the replay cursor
  /// still advances, but grid snapshots are not produced — a background
  /// (non-visible) session must stay current without paying to rasterize.
  private var rendering = true
```

Add the setter (in the actor's method area):

```swift
  func setRendering(_ on: Bool) {
    rendering = on
    if on { publishSnapshot() }
  }
```

At the top of `publishSnapshot()`, add:

```swift
    guard rendering else { return }
```

- [ ] **Step 2: Write the failing test**

```swift
import XCTest
@testable import TetherKit

final class TerminalPipelineRenderingTests: XCTestCase {
  func test_setRendering_false_suppresses_snapshots() async throws {
    let store = FfiReplayStore()
    let pipeline = TerminalPipeline(replayStore: store)
    await pipeline.setRendering(false)

    var received: [Data?] = []
    let collector = Task {
      for await snap in pipeline.snapshots { received.append(snap) }
    }
    // Feed output while rendering is off; no snapshot should be produced.
    await pipeline.feedForTest(Data("hello".utf8))
    try await Task.sleep(nanoseconds: 50_000_000)
    collector.cancel()
    XCTAssertTrue(received.isEmpty, "no snapshots while rendering is off")
  }
}
```

(If no test seam exists to feed the emulator directly, add a `#if DEBUG func feedForTest(_ bytes: Data) { applyOutput(bytes) }` to `TerminalPipeline`. `applyOutput` is the existing private feed at line ~362.)

- [ ] **Step 3: Run on the simulator (macbuild)**

```bash
cd clients/apple/TetherKit && xcodebuild test -scheme TetherKit \
  -destination 'platform=iOS Simulator,name=iPhone 16' \
  -only-testing:TetherKitTests/TerminalPipelineRenderingTests \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO
```
Expected: first without the gate → FAIL (snapshots arrive); with the gate → PASS.

- [ ] **Step 4: Commit**

```bash
git add clients/apple/TetherKit/Sources/TetherKit/Terminal/TerminalPipeline.swift \
        clients/apple/TetherKit/Tests/TetherKitTests/TerminalPipelineRenderingTests.swift
git commit -m "feat(ios): gate TerminalPipeline snapshot rasterization for background tabs"
```

---

### Task 3: A pure residency-LRU helper for SessionStore

**Files:**
- Create: `clients/apple/TetherKit/Sources/TetherKit/Terminal/TerminalResidency.swift`
- Test: `clients/apple/TetherKit/Tests/TetherKitTests/TerminalResidencyTests.swift`

**Interfaces:**
- Produces:
  ```swift
  enum TerminalResidency {
    /// New recency order, `touched` first, de-duplicated, capped to `max`.
    static func touch(_ order: [String], _ touched: String, max: Int = 64) -> [String]
    /// Keys to keep resident: `active` always first, then the recency order
    /// restricted to `live`, up to `cap` total.
    static func resident(active: String, order: [String], live: Set<String>, cap: Int) -> [String]
  }
  ```

- [ ] **Step 1: Write the failing test**

```swift
import XCTest
@testable import TetherKit

final class TerminalResidencyTests: XCTestCase {
  func test_touch_moves_key_to_front_deduped() {
    XCTAssertEqual(TerminalResidency.touch(["a", "b", "c"], "c"), ["c", "a", "b"])
    XCTAssertEqual(TerminalResidency.touch(["a", "b"], "a"), ["a", "b"])
  }

  func test_touch_caps_length() {
    XCTAssertEqual(TerminalResidency.touch(["a", "b", "c"], "d", max: 3), ["d", "a", "b"])
  }

  func test_resident_keeps_active_first_then_recency_within_cap() {
    let out = TerminalResidency.resident(
      active: "h:a", order: ["h:c", "h:b"],
      live: ["h:a", "h:b", "h:c"], cap: 2)
    XCTAssertEqual(out, ["h:a", "h:c"])
  }

  func test_resident_excludes_dead_sessions() {
    let out = TerminalResidency.resident(
      active: "h:a", order: ["h:ghost", "h:b"],
      live: ["h:a", "h:b"], cap: 8)
    XCTAssertFalse(out.contains("h:ghost"))
    XCTAssertTrue(out.contains("h:b"))
  }
}
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd clients/apple/TetherKit && xcodebuild test -scheme TetherKit \
  -destination 'platform=iOS Simulator,name=iPhone 16' \
  -only-testing:TetherKitTests/TerminalResidencyTests \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO
```
Expected: FAIL — `TerminalResidency` undefined.

- [ ] **Step 3: Implement**

```swift
enum TerminalResidency {
  static func touch(_ order: [String], _ touched: String, max: Int = 64) -> [String] {
    Array(([touched] + order.filter { $0 != touched }).prefix(max))
  }

  static func resident(active: String, order: [String], live: Set<String>, cap: Int) -> [String] {
    var out: [String] = live.contains(active) ? [active] : []
    var seen = Set(out)
    for key in order {
      if out.count >= cap { break }
      if live.contains(key), !seen.contains(key) {
        out.append(key)
        seen.insert(key)
      }
    }
    return out
  }
}
```

- [ ] **Step 4: Run to verify it passes** — same command as Step 2; expected PASS.

- [ ] **Step 5: Commit**

```bash
git add clients/apple/TetherKit/Sources/TetherKit/Terminal/TerminalResidency.swift \
        clients/apple/TetherKit/Tests/TetherKitTests/TerminalResidencyTests.swift
git commit -m "feat(ios): pure TerminalResidency LRU helper"
```

---

### Task 4: SessionStore owns a pipeline dictionary; switching reuses pipelines

**Files:**
- Modify: `clients/apple/TetherKit/Sources/TetherKit/SessionStore.swift`

**Interfaces:**
- Consumes: `TerminalResidency` (Task 3), `TerminalPipeline(replayStore:)` (Task 1), `setRendering` (Task 2).
- Produces: internal `pipelines: [String: TerminalPipeline]`, `lruOrder: [String]`, and an `activePipeline` computed from `activeSessionId`/`activeHostId`.

This is the crux. The single `pipeline` becomes a dict keyed by `terminalKey(id, hostId:)`. `observePipeline` follows the active pipeline; switching points the surface at an existing pipeline instead of reconnecting.

- [ ] **Step 1: Introduce the dictionary and recency, keep a compatibility accessor**

Replace the Task-1 `lazy var pipeline` with:

```swift
  @ObservationIgnored private var pipelines: [String: TerminalPipeline] = [:]
  @ObservationIgnored private var lruOrder: [String] = []
  private static let residentCap = 8

  /// The pipeline for a session key, created (and wired) on first use.
  private func pipeline(for key: String) -> TerminalPipeline {
    if let existing = pipelines[key] { return existing }
    let created = TerminalPipeline(replayStore: replayStore)
    pipelines[key] = created
    return created
  }

  private var activePipeline: TerminalPipeline? {
    guard let id = activeSessionId, let host = activeHostId else { return nil }
    return pipelines[terminalKey(id, hostId: host)]
  }
```

- [ ] **Step 2: Rebind the surface to the active pipeline on switch**

Change `observePipeline()` to observe a given pipeline and be re-callable. Cancel
the prior observers first:

```swift
  private func observe(_ pipeline: TerminalPipeline) {
    snapshotObserver?.cancel()
    eventObserver?.cancel()
    let snapshots = pipeline.snapshots
    let events = pipeline.events
    snapshotObserver = Task { [weak self] in
      for await snapshot in snapshots {
        guard let self else { return }
        self.terminalSnapshot = snapshot
      }
    }
    eventObserver = Task { [weak self] in
      for await event in events {
        guard let self else { return }
        self.apply(event)
      }
    }
  }
```

- [ ] **Step 3: Route `connectTerminal` through the keyed pipeline and reuse when live**

Find `connectTerminal(sessionId:)` (called from `selectSession`/`restore`, lines
~374/489/605). Make it:
1. compute `key = terminalKey(sessionId, hostId: activeHostId)`,
2. `let p = pipeline(for: key)`,
3. mark the previously-active pipeline (if different) `setRendering(false)` but do
   **not** disconnect it,
4. `observe(p)` and `await p.setRendering(true)`,
5. only call `p.connectNoise(...)` when `p` has no live channel (first use or after
   a background suspend) — reuse skips reconnect entirely,
6. `lruOrder = TerminalResidency.touch(lruOrder, key)` then enforce the cap (Task 6).

Add a way to ask a pipeline whether it is already connected — add to
`TerminalPipeline`: `var isConnected: Bool { noiseChannel != nil }` (nonisolated-safe
via the actor; call with `await`). Skip `connectNoise` when `await p.isConnected`.

- [ ] **Step 4: Update every remaining `self.pipeline` reference**

The old single `pipeline` is gone. Update call sites (grep `pipeline.` in
`SessionStore.swift`): input/focus/paste/agent go to `activePipeline` (the gated
active one); `killSession`'s `forget` + `release` target the specific session's
pipeline, then remove it from `pipelines`. Example for kill (line ~506):

```swift
      let key = terminalKey(id, hostId: targetHostId)
      if let p = pipelines[key] {
        await p.forget(key: key)
        await p.release()
        pipelines[key] = nil
        lruOrder.removeAll { $0 == key }
      }
```

- [ ] **Step 5: Build on macbuild**

```bash
PROFILE=debug bash scripts/build-xcframework.sh
xcodebuild build -project clients/apple/Tether.xcodeproj -scheme TetherIOS \
  -destination 'generic/platform=iOS Simulator' -configuration Debug \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO
```
Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 6: Commit**

```bash
git add clients/apple/TetherKit/Sources/TetherKit/SessionStore.swift \
        clients/apple/TetherKit/Sources/TetherKit/Terminal/TerminalPipeline.swift
git commit -m "feat(ios): SessionStore owns a pipeline dict; switching reuses live pipelines"
```

---

### Task 5: Foreground/background lifecycle for the resident set

**Files:**
- Modify: `clients/apple/TetherKit/Sources/TetherKit/SessionStore.swift` (`handleAppLifecycle` line ~525, `resumeFromForeground` line ~537)

**Interfaces:**
- Consumes: `pipelines`, `TerminalResidency.resident`, `connectTerminal`.

- [ ] **Step 1: On background, disconnect every pipeline (keep the objects + cursors)**

In `handleAppLifecycle(.inactive)` add, before `sendFocus(focused: false)`:

```swift
      Task {
        for p in pipelines.values { await p.disconnect() }
      }
```

`disconnect()` (existing, line ~228) closes the socket but keeps the emulator/grid;
the shared `replayStore` retains the cursor. The OS suspends anyway.

- [ ] **Step 2: On foreground, reconnect the resident set, staggered**

Replace the body of `resumeFromForeground()` so it reconnects the resident set
(active first), with a small stagger to avoid a reconnect storm:

```swift
  public func resumeFromForeground() async {
    guard let activeId = activeSessionId, let host = activeHostId else {
      await activePipeline?.sendFocus(focused: true)
      return
    }
    let activeKey = terminalKey(activeId, hostId: host)
    let live = Set(pipelines.keys)
    let resident = TerminalResidency.resident(
      active: activeKey, order: lruOrder, live: live, cap: SessionStore.residentCap)
    for (index, key) in resident.enumerated() {
      guard let parsed = parseTerminalKey(key) else { continue }
      await pipelines[key]?.setRendering(key == activeKey)
      await reconnect(key: key, sessionId: parsed.sessionId, hostId: parsed.hostId)
      if index < resident.count - 1 { try? await Task.sleep(nanoseconds: 120_000_000) }
    }
    await activePipeline?.sendFocus(focused: true)
  }
```

Add a small `reconnect(key:sessionId:hostId:)` that resolves the host client + URL
(mirror what `connectTerminal` already does) and calls `pipeline(for: key)
.connectNoise(...)`. If a `parseTerminalKey` helper does not exist, add one that
inverts `terminalKey` (host-qualified key → `(hostId, sessionId)`); test it beside
`TerminalResidencyTests`.

- [ ] **Step 3: Build on macbuild** (same commands as Task 4 Step 5). Expected: BUILD SUCCEEDED.

- [ ] **Step 4: Commit**

```bash
git add clients/apple/TetherKit/Sources/TetherKit/SessionStore.swift
git commit -m "feat(ios): reconnect the resident set on foreground, disconnect on background"
```

---

### Task 6: Enforce the LRU cap (evict beyond 8)

**Files:**
- Modify: `clients/apple/TetherKit/Sources/TetherKit/SessionStore.swift`

**Interfaces:**
- Consumes: `TerminalResidency.resident`, `pipelines`, `disconnect`/`release`.

- [ ] **Step 1: Add an eviction pass run after each switch**

Add and call this at the end of `connectTerminal` (after the `lruOrder` touch):

```swift
  private func evictBeyondCap() async {
    guard let activeId = activeSessionId, let host = activeHostId else { return }
    let activeKey = terminalKey(activeId, hostId: host)
    let keep = Set(TerminalResidency.resident(
      active: activeKey, order: lruOrder,
      live: Set(pipelines.keys), cap: SessionStore.residentCap))
    for (key, p) in pipelines where !keep.contains(key) {
      await p.disconnect()   // keep the cursor (shared store) for delta-replay
      await p.release()
      pipelines[key] = nil
    }
    lruOrder = lruOrder.filter { keep.contains($0) }
  }
```

Note: eviction only `disconnect`+`release`s (drops the socket + object); it does
**not** `forget` the cursor — the shared `replayStore` keeps it, so returning to an
evicted session replays only the delta.

- [ ] **Step 2: Build on macbuild** (Task 4 Step 5 commands). Expected: BUILD SUCCEEDED.

- [ ] **Step 3: Commit**

```bash
git add clients/apple/TetherKit/Sources/TetherKit/SessionStore.swift
git commit -m "feat(ios): evict terminal pipelines beyond the resident cap"
```

---

### Task 7: Full verification on macbuild

**Files:** none (verification).

- [ ] **Step 1: Regenerate + full TetherKit sim tests**

```bash
# on macbuild, in the synced tree
PROFILE=debug bash scripts/build-xcframework.sh
cd clients/apple/TetherKit && xcodebuild test -scheme TetherKit \
  -destination 'platform=iOS Simulator,name=iPhone 16' \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO
```
Expected: `** TEST SUCCEEDED **` — the prior suite plus the new
`TerminalPipelineRenderingTests` and `TerminalResidencyTests`.

- [ ] **Step 2: Assert the zero-replay oracle in a UI run**

Boot the app on a sim, pair a host with ≥2 terminals. In A run
`echo IOS_MARKER_A`, switch to B, switch back to A. Instrument
`TerminalPipeline.connectNoise` with an `#if DEBUG NSLog` and confirm it is **not**
called for A on switch-back (the pipeline was reused). Confirm A shows the live
tail with no re-scroll of the marker.

- [ ] **Step 3: Assert eviction is graceful**

Open 9 terminals, cycle, return to the oldest. Expected: it reconnects and replays
only the delta (shared cursor), not the full tail.

- [ ] **Step 4: Record the result** on board #1149 (or a new task).

---

## Self-Review

**Spec coverage:**
- LRU dict of pipelines, cap 8, active always resident → Tasks 3, 4, 6. ✓
- Active feeds surface; background keeps channel + feeds emulator, rendering gated → Task 2, Task 4 Step 3. ✓
- Switch reuses pipeline (no reconnect) → Task 4 Step 3 (`isConnected` skip). ✓
- Foreground reconnect (staggered) / background disconnect → Task 5. ✓
- Eviction disconnect+release, cursor kept → Task 6. ✓
- Shared cursor store (necessity uncovered from `TerminalPipeline.swift:61`) → Task 1. ✓
- Zero-replay oracle → Task 7. ✓

**Placeholder scan:** New pure units (`TerminalResidency`, rendering gate) carry full code + tests. SessionStore integration steps name exact methods/line anchors and give real Swift for each edit; an executor reads the surrounding method (grep anchors provided) rather than a placeholder.

**Type consistency:** `TerminalPipeline(replayStore:)`, `setRendering(_:)`, `isConnected`, `TerminalResidency.touch/​resident`, `terminalKey`/`parseTerminalKey`, `SessionStore.residentCap` used consistently across Tasks 1–6. The shared-store rule (Global Constraints) removes the per-pipeline `makeReplayStore`. ✓

**Risk note for the executor:** `SessionStore.swift` is a large actor; Task 4 Step 4 (updating every `pipeline.` reference) is the highest-blast-radius step — grep `\bpipeline\b` first and route each site to `activePipeline` or the keyed pipeline deliberately. Agent tabs (`agentStart`/`agentPrompt`/`agentInterrupt`) route to the active pipeline like input.
