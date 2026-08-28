# iPad work — handoff

Written 2026-08-28. Branch `feat/ipad-adaptation`, worktree `~/sites/tether-wt/ipad`.
Board tasks: **#887** (iPad adaptation, planned, not started), **#888** (keyboard
layout bug, half fixed), **#889** (pairing sheet, done).

Read this before touching anything. The rig section at the bottom is not
optional — there is no Swift toolchain on the Linux box, and two of the traps
listed there produced hours of wrong results in the session that wrote this.

---

## 1. What is committed

Five commits ahead of `main`, none pushed:

| Commit | What |
|---|---|
| `820305f` | Design spec for the iPad adaptation |
| `48f960c` | Implementation plan for the iPad adaptation (9 tasks) |
| `f3551b9` | **fix:** Add-host sheet stays open after a successful pairing |
| `1df2e2f` | **fix:** `report()` accepted the key bar's unpositioned frame |
| `8fef173` | **fix:** keyboard opt-out kept outside the presentation wrappers |

`bun`-side and TetherKit tests: 59/59 green. `TetherIOS` builds clean.

### `f3551b9` — pairing sheet (task #889, closed)

`PairingView` awaited `store.completePairing(...)` and then did nothing: it had
no dismiss path, and `completePairing` returned `Void`, reporting failure only
by leaving `errorMessage` set. A successful pairing created the host and left
the sheet sitting over it. `completePairing` is now `@discardableResult -> Bool`
and clears a stale `errorMessage` before returning true; `PairingView` takes an
`onDone` and calls it only on success. The dismissal is a caller callback and
deliberately **not** `@Environment(\.dismiss)` — dismiss would close the sheet
without `RootView.showPairing` going false, leaving the flag lying about what is
on screen.

### `1df2e2f` — unpositioned bar frame

`TerminalAccessoryBar.report(_:)` derives the bar's docked height from
`screen.maxY - frame.minY`. The bar's first geometry frame is
`{{0, 0}, {0, 56}}` — at the origin, no width — so that expression returned the
whole screen (measured: `dockedHeight` 820 on an 820pt screen), and it slipped
past the existing `height <= screen.height` guard by being exactly equal to it.
The old guard catches the opposite artefact (a frame above the screen during
dismissal). Now both are required: `frame.minY > 0, frame.width > 0`.

Real defect, verified. **Not** the cause of #888.

### `8fef173` — the sizing half of #888

`RootView` applied `.ignoresSafeArea(.keyboard, edges: .bottom)` to its `ZStack`,
but the five `.sheet` modifiers and the `.alert` are chained **after** it — so
those wrappers enclose the view that opted out and stayed free to resize
themselves for the keyboard. The container was shortened, and `TerminalView`
then subtracted its own (correct) 403pt on top.

Fix: chain the same modifier **last**, so every wrapper is inside it. The inner
one stays — it is what makes the iPhone layout correct.

Measured on iPad, landscape, keyboard up:

| | before | after |
|---|---|---|
| container height | 820 → **722.5** | not shrunk |
| grid rows | **18** (25 fit) | **26** |
| key bar | dead band above it | last row sits on it |

---

## 2. What is still open

### 2a. Task #888 residual — title bar under the status bar

**Symptom.** With the software keyboard up, the title bar is drawn underneath
the status bar. Keyboard-down layout is correct. The terminal itself is correct
and fully usable; this is chrome overlap.

**Measured, on iPad 10th gen / iOS 17.2, landscape, window 1180×820, window safe
area top 24 / bottom 20, keyboard top y=397:**

```
keyboard DOWN:  titlebar global = {{0,  24}, {1180, 52}}   ← correct
keyboard UP:    titlebar global = {{0, -29.5}, {1180, 76}}
root VStack:                      {{0, -41.5}, {1180, 841.5}}
```

The bar grows by exactly 24 (the status bar height) and moves up 53.5 = 24 +
29.5. The VStack wants 841.5pt inside an 820pt window, does not fit, is anchored
by its bottom, and the overflow comes off the top.

**The mechanism, from the documentation and not from guessing.** SwiftUI
keyboard avoidance has exactly two behaviours: it grows the safe area so
flexible content **compresses**, and when content cannot compress it **shifts
the whole view up**. `.ignoresSafeArea(.keyboard)` cancels the first only; it has
no effect on the shift, by design. See
<https://www.fivestars.blog/articles/swiftui-keyboard/> — "no components will
actually be compressed — the only difference is whether the view is shifted up
or not", and the modifier "fails when content height cannot reduce". Corroborated
by <https://fatbobman.com/en/posts/safearea/> and
<https://swiftwithmajid.com/2021/11/03/managing-safe-area-in-swiftui/>.

So the two halves of #888 are two different mechanisms: the sizing half was the
INSET applied twice (fixed); this half is the SHIFT.

**UIKit is clean — this kills the popular explanation.** A probe that walked the
responder chain to the hosting controller logged, with the keyboard up:

```
window = {{0,0},{1180,820}}  winSafe = (t24.0 b20.0)
UIHostingController<ModifiedContent<AnyView, RootModifier>>
   frame = {{0,0},{1180,820}}  addl = (t0.0 b0.0)  safe = (t24.0 b20.0)
```

Hosting view exactly matches the window, `additionalSafeAreaInsets` are zero,
and nothing moves when the keyboard appears. `cursor-agent` was consulted twice;
its second answer predicted the host frame/insets would shift by ~53.5 and
proposed setting host `safeAreaRegions`. That prediction is contradicted by the
log above and its `24 - 53.5 = -29.5` was arithmetic fitted after the fact. Do
not spend time there. (Its *first* answer — the modifier-ordering point — was
correct and became `8fef173`.)

**The −29.5 is invariant.** Identical in every one of these. Do not retry them:

1. Outer `.ignoresSafeArea(.keyboard, edges: .bottom)` present / absent
2. Inner one present / absent
3. `TerminalInputBridge` as the first vs the last child of `TerminalView`'s VStack
4. The ZStack's two bare `.ignoresSafeArea()` children (the backdrop and
   `LitBloomLayer`) restricted to `.ignoresSafeArea(.container)`
5. Those children's `ignoresSafeArea` removed entirely
6. `ZStack(alignment: .top)`
7. An explicit UIKit-sourced top inset
   (`.padding(.top, windowTopInset()) + .ignoresSafeArea(.container, edges: .top)`)
   — moved the top by only *half* the padding, which is itself proof the content
   is overflowing and being centred rather than mis-inset
8. `.safeAreaInset(edge: .bottom)` instead of `.padding(.bottom,)` for the
   keyboard reservation, so it cannot inflate the subtree
9. `TetherSurfaceView.intrinsicContentSize` returning `noIntrinsicMetric`
   instead of the current grid size (it currently returns `rows * cellHeight`,
   which is circular — the grid is chosen from the size, and the size is
   reported from the grid)
10. Removing **all** keyboard handling so SwiftUI owns avoidance outright

Every one: `titlebar {{0, -29.5}, {1180, 76}}`.

**Number 10 is a dead end with a cost.** Dropping the manual keyboard padding so
SwiftUI could compress naturally left the terminal **blank** — the grid never
resized, `onGridSizeChange` never fired — and the title bar still overlapped.
Reverted. It is not a three-line change.

**Where a real fix has to go.** The literature's cure for the shift is to make
the content compressible, canonically by wrapping it in a `ScrollView`, which
does not apply to a fixed terminal grid. A genuine fix means restructuring so
the terminal subtree compresses under a keyboard-expanded safe area *with the
grid-resize path still working while it does*. That is a design change to the
terminal's layout and sizing and deserves its own spec, not another modifier
tweak. Note item 9 above is still a real (if insufficient) correctness
improvement and may be a prerequisite: a view whose ideal size is derived from
its current size cannot compress predictably.

### 2b. Task #887 — the iPad adaptation itself, not started

Spec: `docs/superpowers/specs/2026-08-28-ipad-adaptation-design.md`
Plan: `docs/superpowers/plans/2026-08-28-ipad-adaptation.md` — 9 tasks, TDD,
one commit each, suite goes 59 → 80 cases.

Pinnable sidebar, key bar split (keys left / D-pad right), ⌘-shortcuts plus an
adaptive key bar when a hardware keyboard is attached, wide-aware detail views
and metrics, drag-and-drop upload, pointer support, and removing the Ctrl
checkmark. The plan's "Remote build loop" section duplicates the rig below; the
rig below is newer, trust this file where they differ.

One correction the plan already carries but is worth repeating: the key bar's
horizontal padding is **12**, not 8, so the fit boundary is 544pt.

### 2c. iPad 6 / iOS 17 — system keyboard dismiss key does nothing

Reported by the user, never investigated. The iPad software keyboard's
bottom-right dismiss key does not put the keyboard away. Needs its own
systematic-debugging pass: reproduce, then instrument `textViewDidEndEditing`,
`keyboardWillHideNotification`, and `uiView.isFirstResponder` at the top of
`TerminalInputBridge.updateUIView`, and find where focus actually returns before
changing anything.

A lead, not a diagnosis: `updateUIView` re-focuses whenever SwiftUI believes
focus is on and UIKit's responder is off —

```swift
if isFocused.wrappedValue, !uiView.isFirstResponder {
  uiView.becomeFirstResponder()
}
```

`textViewDidEndEditing` exists to keep the two in sync but returns early when
`isFocused.wrappedValue` is already false, and defers its write by a runloop
turn. If the dismiss key drops the responder without firing that callback, the
next SwiftUI update pulls the keyboard straight back up.

---

## 3. The rig

### 3.1 There is no Swift toolchain on this machine

Everything builds and runs on the Mac `macbuild` (already in `~/.ssh/config`;
192.168.50.125, macOS 26.5.1, Xcode 26.3). Never claim a build or a test passed
without having run it there.

### 3.2 Sync

The generated FFI artifacts are gitignored and are **not** in the Linux
worktree, so rsync must exclude them or `--delete` wipes the Mac's copies.

```bash
cd ~/sites/tether-wt/ipad
rsync -az --delete \
  --exclude '.git' \
  --exclude 'clients/apple/TetherKit/Frameworks' \
  --exclude 'clients/apple/TetherKit/Sources/TetherFFIBindings' \
  --exclude 'node_modules' --exclude 'target' --exclude 'dist' \
  ./ macbuild:~/build/tether-ipad/
```

One-time, and again after any change under `crates/`:

```bash
ssh macbuild 'cd ~/build/tether-ipad && PROFILE=debug ./scripts/build-xcframework.sh'
```

### 3.3 Build — check the real exit status

**Trap that cost hours.** Do not write `xcodebuild ... | grep ... && install`.
`grep`'s exit status gates the `&&`, not `xcodebuild`'s, so a **failed build
silently installs the previous binary** and you measure stale code. Redirect to
a file and echo `$?`:

```bash
ssh macbuild 'cd ~/build/tether-ipad/clients/apple && \
  xcodebuild build -project Tether.xcodeproj -scheme TetherIOS -configuration Debug \
    -destination "id=DC0327DE-5015-4A6B-83E4-ED147ADF5DC8" \
    -derivedDataPath /tmp/tether-ipad-dd \
    CODE_SIGN_ENTITLEMENTS=/tmp/sim.entitlements > /tmp/build.log 2>&1
  echo "EXIT=$?"
  grep -E "error:" /tmp/build.log | head -5'
```

`CODE_SIGN_ENTITLEMENTS=/tmp/sim.entitlements` (an empty plist dict) is
**required**. Building with `CODE_SIGNING_ALLOWED=NO` instead makes
`keychain-access-groups` resolve to a bogus group and every password write fails
`-34018`, so pairing cannot store a password. Recreate it if missing:

```bash
ssh macbuild 'printf "%s" "<?xml version=\"1.0\" encoding=\"UTF-8\"?><!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\"><plist version=\"1.0\"><dict/></plist>" > /tmp/sim.entitlements && plutil -lint /tmp/sim.entitlements'
```

### 3.4 Adding a new source file

`Tether.xcodeproj` uses explicit `PBXFileReference` entries, **not** Xcode 16
synchronized folders. A new `.swift` file dropped into `clients/apple/TetherIOS/`
is **not compiled** — and because of the `grep` trap above, the failure can pass
unnoticed. Either add proper `PBXBuildFile` + `PBXFileReference` entries and put
the build file in the `Sources` phase, or (for throwaway diagnostics) append the
type to an already-referenced file such as `RootView.swift`.

### 3.5 Tests

`xcodebuild test -scheme TetherKit` from `clients/apple` fails with "Scheme
TetherKit is not currently configured for the test action". Run it from the
package directory:

```bash
ssh macbuild 'cd ~/build/tether-ipad/clients/apple/TetherKit && \
  xcodebuild test -scheme TetherKit \
    -destination "id=DC0327DE-5015-4A6B-83E4-ED147ADF5DC8" \
    -derivedDataPath /tmp/tether-kit-dd CODE_SIGNING_ALLOWED=NO 2>&1 \
  | grep -E "Executed [0-9]+ tests|\*\* TEST"'
```

Expect `Executed 59 tests, with 0 failures` and `** TEST SUCCEEDED **`.

### 3.6 Simulator

iPad (10th gen) / iOS 17.2, created for this work:

```
DC0327DE-5015-4A6B-83E4-ED147ADF5DC8   ("iPad17")
```

```bash
ssh macbuild 'xcrun simctl boot DC0327DE-5015-4A6B-83E4-ED147ADF5DC8; open -a Simulator'

# install + relaunch (bundle id is com.samuelloranger.tether-mobile)
ssh macbuild 'xcrun simctl install DC0327DE-5015-4A6B-83E4-ED147ADF5DC8 \
    /tmp/tether-ipad-dd/Build/Products/Debug-iphonesimulator/TetherIOS.app
  xcrun simctl terminate DC0327DE-5015-4A6B-83E4-ED147ADF5DC8 com.samuelloranger.tether-mobile 2>/dev/null
  xcrun simctl launch DC0327DE-5015-4A6B-83E4-ED147ADF5DC8 com.samuelloranger.tether-mobile'
```

`xcrun simctl uninstall` first if you need to clear the paired host and the
Keychain entry.

### 3.7 Screenshots

```bash
# capture on the Mac, rotate for landscape, copy back
ssh macbuild 'xcrun simctl io DC0327DE-5015-4A6B-83E4-ED147ADF5DC8 screenshot /tmp/shot.png
              sips -r 90 /tmp/shot.png --out /tmp/shot-rot.png >/dev/null'
scp macbuild:/tmp/shot-rot.png ./shot.png
```

`simctl io screenshot` captures in the **device's native orientation**, so a
landscape run comes back rotated 90°; `sips -r 90` fixes it (use `-r -90` if it
comes out upside down). It also **races the UI** — take the screenshot a second
or more after the action, or you will photograph the previous state and
misread it as "the tap did nothing".

To see the Mac's own screen (useful for deriving tap coordinates):

```bash
ssh macbuild 'screencapture -x -o /tmp/mac.png'      # whole screen
ssh macbuild 'screencapture -x -o -R 55,92,948,744 /tmp/mac.png'  # one window
```

### 3.8 Driving the simulator (taps)

Synthetic taps need `ssh -tt` — plain `ssh` fails the TCC assistive-access check.
A compiled CGEvent clicker lives at `/tmp/tapclick <x> <y>` (screen points).

```bash
ssh -tt macbuild 'osascript -e "tell application \"Simulator\" to activate"; sleep 2
                  /tmp/tapclick 529 482; sleep 3; echo TAPPED'
```

**Coordinate mapping.** The Simulator window draws a device bezel, so the window
rect is *not* the screen rect. Get the window rect with

```bash
ssh -tt macbuild 'osascript -e "tell application \"System Events\" to tell process \"Simulator\" to get {position, size} of window 1"'
```

then map `screen = (originX + 0.719 * deviceX, originY + 0.719 * deviceY)`.
As of writing, the window sat at `(55, 92)` size `948x744` and the mapping was

```
screen = (105 + 0.719 * deviceX, 194.5 + 0.719 * deviceY)
```

**Trap that cost several wasted runs:** the window MOVED mid-session
(`518,38` → `55,92`) and every tap silently landed outside it, which read as
"the keyboard never appears". **Re-derive the mapping after any window move**,
by screen-capturing the window and locating a known control.

Other gotchas:

- The Mac **auto-locks** and then every synthetic tap dies silently. Check with
  `ioreg -n Root -d1 -a | grep -A1 CGSSessionScreenIsLocked` — a `<true/>` means
  locked and a human has to unlock it. Then `nohup caffeinate -d -i -s &` to
  hold it awake.
- `System Events` keystrokes reach the simulator **only while the hardware
  keyboard is connected**. With it disconnected (which you need for the software
  keyboard) typing must go through on-screen taps.
- Hardware keyboard toggle, and its current state:

```bash
# state: "✓" = connected, "missing value" = disconnected
ssh -tt macbuild 'osascript -e "tell application \"System Events\" to tell process \"Simulator\" to get value of attribute \"AXMenuItemMarkChar\" of menu item \"Connect Hardware Keyboard\" of menu 1 of menu item \"Keyboard\" of menu 1 of menu bar item \"I/O\" of menu bar 1"'
# toggle
ssh -tt macbuild 'osascript -e "tell application \"System Events\" to tell process \"Simulator\" to click menu item \"Connect Hardware Keyboard\" of menu 1 of menu item \"Keyboard\" of menu 1 of menu bar item \"I/O\" of menu bar 1"'
```

To reproduce #888 you need the **software** keyboard, so disconnect the hardware
one, then tap inside the terminal to focus it.

### 3.9 A server to pair against

There is a throwaway server on `macbuild:8099` with its own database:

```bash
ssh macbuild 'cd ~/build/tether-ipad && \
  TETHER_DB_PATH=/tmp/ipaddiag.db TETHER_PORT=8099 TETHER_TLS=off \
  nohup ~/.bun/bin/bun apps/server/src/server/index.ts > /tmp/ipaddiag-server.log 2>&1 &'
```

Pair the app to `127.0.0.1` port `8099`, password `diagpass123` (throwaway,
local to that Mac). If the DB is fresh the app's pairing screen creates the
password itself.

**Leave port 8085 on that Mac alone** — something else already owns it.

Tear the throwaway down when the work is finished:

```bash
ssh macbuild 'pkill -f "bun apps/server/src/server/index.ts"; rm -f /tmp/ipaddiag.db*'
```

Do **not** `pkill` broader patterns like `bun run` — on the Linux host that
kills the production tether daemon and the agent's own session.

### 3.10 Reading diagnostics out of the app

`NSLog` from the app, streamed off the simulator:

```bash
ssh macbuild 'nohup xcrun simctl spawn DC0327DE-5015-4A6B-83E4-ED147ADF5DC8 \
  log stream --style compact --predicate "eventMessage CONTAINS \"TETHERDIAG\"" \
  > /tmp/tetherdiag.log 2>&1 &'

ssh macbuild 'grep TETHERDIAG /tmp/tetherdiag.log | tail -20'
```

Prefix every temporary log with `TETHERDIAG` so it can be grepped and, more
importantly, so a stray one is easy to find and delete before committing.

`onChange` does **not** fire for the initial layout, so a `GeometryReader` probe
needs an `onAppear` as well or you get no keyboard-down baseline — the absence
of that baseline is what made an early reading look like a bug when it was just
an animation frame.

---

## 4. Suggested order

1. **#887 task 1** (layout core + preference defaults) — self-contained, pure
   logic, tested, unblocks the rest of the plan.
2. **#888 residual** — but only after writing a spec for a compressible terminal
   subtree. Do not open the file and start trying modifiers; ten of them are
   already ruled out above by measurement.
3. **iPad 6 dismiss key (2c)** — independent of both, and the user hits it daily.
