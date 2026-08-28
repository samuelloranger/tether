# iPad Adaptation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Tether iOS app native on iPad — a sidebar that can stay pinned, a key bar that puts the D-pad under the right thumb, hardware-keyboard shortcuts, wide-aware detail views, drag-and-drop upload, and pointer support.

**Architecture:** Every layout decision is a pure function in TetherKit (`TetherLayout`, `PreferenceDefaults`, `AccessoryLayout`, `SessionJump`, `AccessoryVisibility`) with XCTest coverage, and the SwiftUI views read those functions. Nothing branches on `UIDevice` inside a view body. The pinned sidebar is an `HStack` in `RootView`; the existing `SessionDrawerOverlay` is mounted only at compact width.

**Tech Stack:** Swift 5.10 / Swift 6 concurrency, SwiftUI, UIKit interop (`UIViewRepresentable`), GameController (`GCKeyboard`), XCTest, `xcodebuild` on a remote macOS host.

**Spec:** `docs/superpowers/specs/2026-08-28-ipad-adaptation-design.md`

## Global Constraints

- Work in the worktree `~/sites/tether-wt/ipad`, branch `feat/ipad-adaptation`. All paths below are relative to that worktree root.
- **There is no Swift toolchain on this Linux machine.** Every build and every test runs on the remote macOS host `macbuild` (already in `~/.ssh/config`; macOS 26.5.1, Xcode 26.3). See "Remote build loop" below. Never claim a test passed without running it there.
- Formatting is Biome for JS/TS only; Swift follows the surrounding file — 2-space indent, no trailing whitespace. Match the comment density of the file you are editing: this codebase explains *why*, at length, and a change with no explanation will read as out of place.
- Tests are XCTest with `@testable import TetherKit`, named `test_lowercase_with_underscores`, colocated in `clients/apple/TetherKit/Tests/TetherKitTests/`.
- New pure logic goes in its own file under `Sources/TetherKit/`, never inside a view.
- `SessionStore` and `AppPreferences` are `@MainActor @Observable`. New pure types must be `Sendable` and free of actor isolation so tests can call them directly.
- Existing stored user preferences are never overwritten by a new default.
- Public API additions must carry default values where existing call sites would otherwise break.
- Commit after every task. Do not add `Co-Authored-By` trailers.

## Remote build loop

The generated FFI artifacts are gitignored and are **not** present in the Linux worktree, so rsync must exclude them or `--delete` will wipe the copies on the Mac.

**One-time setup (run before Task 1):**

```bash
ssh macbuild 'mkdir -p ~/build/tether-ipad'
rsync -az --delete \
  --exclude '.git' \
  --exclude 'clients/apple/TetherKit/Frameworks' \
  --exclude 'clients/apple/TetherKit/Sources/TetherFFIBindings' \
  --exclude 'node_modules' --exclude 'target' --exclude 'dist' \
  ~/sites/tether-wt/ipad/ macbuild:~/build/tether-ipad/
ssh macbuild 'cd ~/build/tether-ipad && PROFILE=debug ./scripts/build-xcframework.sh'
ssh macbuild 'xcrun simctl list devices available | grep -i "iPad"'
```

Note the udid of an available iPad simulator from that last command; call it `$IPAD_UDID` below. Also note an iPhone simulator udid as `$IPHONE_UDID`.

**The two commands every test step uses.** `SYNC` first, then one of the two runs:

```bash
# SYNC
rsync -az --delete \
  --exclude '.git' \
  --exclude 'clients/apple/TetherKit/Frameworks' \
  --exclude 'clients/apple/TetherKit/Sources/TetherFFIBindings' \
  --exclude 'node_modules' --exclude 'target' --exclude 'dist' \
  ~/sites/tether-wt/ipad/ macbuild:~/build/tether-ipad/

# UNIT TESTS (TetherKit)
ssh macbuild 'cd ~/build/tether-ipad/clients/apple && xcodebuild test \
  -scheme TetherKit \
  -destination "id=<IPHONE_UDID>" \
  -derivedDataPath /tmp/tether-ipad-dd \
  CODE_SIGNING_ALLOWED=NO 2>&1 | tail -40'

# APP BUILD (TetherIOS)
ssh macbuild 'cd ~/build/tether-ipad/clients/apple && xcodebuild build \
  -project Tether.xcodeproj -scheme TetherIOS -configuration Debug \
  -destination "generic/platform=iOS Simulator" \
  -derivedDataPath /tmp/tether-ipad-dd \
  CODE_SIGNING_ALLOWED=NO 2>&1 | tail -40'
```

`xcodebuild test` cannot filter to a single test method reliably across schemes here, so "run the test" means running the whole `TetherKit` suite and reading the named case in the output. The suite is 59 cases and runs in under a second; the cost is the build, not the tests.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `clients/apple/TetherKit/Sources/TetherKit/Layout/TetherLayout.swift` | `SidebarMode` and the width-vs-preference rule |
| `clients/apple/TetherKit/Sources/TetherKit/Preferences/PreferenceDefaults.swift` | Per-idiom first-launch defaults |
| `clients/apple/TetherKit/Sources/TetherKit/Layout/AccessoryLayout.swift` | Whether the key bar fits without scrolling |
| `clients/apple/TetherKit/Sources/TetherKit/Layout/SessionJump.swift` | ⌘1…9 and prev/next → `(hostId, sessionId)` |
| `clients/apple/TetherKit/Sources/TetherKit/Layout/AccessoryVisibility.swift` | Whether the on-screen key bar should show |
| `clients/apple/TetherKit/Sources/TetherKit/Input/HardwareKeyboard.swift` | Observable `GCKeyboard` presence |
| `clients/apple/TetherIOS/KeyboardShortcutsLayer.swift` | The invisible ⌘-shortcut buttons |
| `clients/apple/TetherKit/Tests/TetherKitTests/TetherLayoutTests.swift` | Task 1 tests |
| `clients/apple/TetherKit/Tests/TetherKitTests/PreferenceDefaultsTests.swift` | Task 1 tests |
| `clients/apple/TetherKit/Tests/TetherKitTests/AccessoryLayoutTests.swift` | Task 3 tests |
| `clients/apple/TetherKit/Tests/TetherKitTests/SessionJumpTests.swift` | Task 4 tests |
| `clients/apple/TetherKit/Tests/TetherKitTests/AccessoryVisibilityTests.swift` | Task 5 tests |

**Modified:**

| File | Change |
|---|---|
| `clients/apple/TetherKit/Sources/TetherKit/Preferences/AppPreferences.swift` | `sidebarPinned`, per-idiom defaults |
| `clients/apple/TetherIOS/RootView.swift` | `HStack` split, mode routing, shortcuts, drop target |
| `clients/apple/TetherKit/Sources/TetherKit/Views/SessionDrawerView.swift` | `pinned` flag, pin toggle, hover |
| `clients/apple/TetherKit/Sources/TetherKit/Views/TerminalTitleBar.swift` | Drawer button becomes a pin toggle when pinned |
| `clients/apple/TetherKit/Sources/TetherKit/Views/TerminalView.swift` | Key bar split, Ctrl label, accessory visibility |
| `clients/apple/TetherKit/Sources/TetherKit/Views/GitReviewView.swift` | Side-by-side default at regular width |
| `clients/apple/TetherKit/Sources/TetherKit/Views/ConfigSettingsView.swift` | Content `maxWidth` |
| `clients/apple/TetherKit/Sources/TetherKit/Views/TerminalKeyStyle.swift` | Hover effect on keys |
| `clients/apple/TetherKit/Sources/TetherKit/Terminal/TetherSurfaceView.swift` | I-beam pointer interaction |
| `clients/apple/Tether.xcodeproj/project.pbxproj` | Add `KeyboardShortcutsLayer.swift` to the TetherIOS target |

---

## Task 1: Layout core and per-idiom preference defaults

**Files:**
- Create: `clients/apple/TetherKit/Sources/TetherKit/Layout/TetherLayout.swift`
- Create: `clients/apple/TetherKit/Sources/TetherKit/Preferences/PreferenceDefaults.swift`
- Create: `clients/apple/TetherKit/Tests/TetherKitTests/TetherLayoutTests.swift`
- Create: `clients/apple/TetherKit/Tests/TetherKitTests/PreferenceDefaultsTests.swift`
- Modify: `clients/apple/TetherKit/Sources/TetherKit/Preferences/AppPreferences.swift`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `public enum SidebarMode: Sendable, Equatable { case pinned, overlay }`
  - `public enum TetherLayout { public static func sidebarMode(regularWidth: Bool, pinned: Bool) -> SidebarMode }`
  - `public enum PreferenceDefaults { public static func sidebarPinned(isPad: Bool) -> Bool; public static func terminalFontSize(isPad: Bool) -> Double }`
  - `AppPreferences.sidebarPinned: Bool` (settable, persisted)

- [ ] **Step 1: Write the failing tests**

Create `clients/apple/TetherKit/Tests/TetherKitTests/TetherLayoutTests.swift`:

```swift
import XCTest
@testable import TetherKit

final class TetherLayoutTests: XCTestCase {
  func test_pinned_needs_both_the_preference_and_the_width() {
    XCTAssertEqual(TetherLayout.sidebarMode(regularWidth: true, pinned: true), .pinned)
    XCTAssertEqual(TetherLayout.sidebarMode(regularWidth: true, pinned: false), .overlay)
    XCTAssertEqual(TetherLayout.sidebarMode(regularWidth: false, pinned: true), .overlay)
    XCTAssertEqual(TetherLayout.sidebarMode(regularWidth: false, pinned: false), .overlay)
  }

  func test_narrowing_does_not_change_what_the_preference_says() {
    // The rule is a read, not a write: the same preference resolves differently
    // at two widths, which is exactly how Slide Over gets the overlay back
    // without the user losing their pin.
    let pinned = true
    XCTAssertEqual(TetherLayout.sidebarMode(regularWidth: false, pinned: pinned), .overlay)
    XCTAssertEqual(TetherLayout.sidebarMode(regularWidth: true, pinned: pinned), .pinned)
  }
}
```

Create `clients/apple/TetherKit/Tests/TetherKitTests/PreferenceDefaultsTests.swift`:

```swift
import XCTest
@testable import TetherKit

final class PreferenceDefaultsTests: XCTestCase {
  func test_ipad_starts_pinned_and_iphone_does_not() {
    XCTAssertTrue(PreferenceDefaults.sidebarPinned(isPad: true))
    XCTAssertFalse(PreferenceDefaults.sidebarPinned(isPad: false))
  }

  func test_ipad_starts_at_a_larger_font_than_the_phone() {
    XCTAssertEqual(PreferenceDefaults.terminalFontSize(isPad: true), 14)
    // The phone's existing default, unchanged — raising it would resize the
    // grid under every current user on their next launch.
    XCTAssertEqual(PreferenceDefaults.terminalFontSize(isPad: false), 11)
  }
}
```

- [ ] **Step 2: Run the tests and verify they fail**

Run SYNC, then UNIT TESTS (see "Remote build loop").
Expected: build failure — `cannot find 'TetherLayout' in scope`, `cannot find 'PreferenceDefaults' in scope`.

- [ ] **Step 3: Write the implementation**

Create `clients/apple/TetherKit/Sources/TetherKit/Layout/TetherLayout.swift`:

```swift
import Foundation

/// Where the session list lives right now.
public enum SidebarMode: Sendable, Equatable {
  /// A column beside the terminal, permanently on screen.
  case pinned
  /// The slide-over panel with its scrim and edge-pan gesture.
  case overlay
}

/// Layout decisions that depend on the window, kept out of the view bodies so
/// they can be tested without a simulator.
public enum TetherLayout {
  /// The sidebar is pinned only when the reader asked for it AND the window can
  /// spare 264pt.
  ///
  /// The preference records intent; the width decides whether intent is
  /// affordable. Split View, Slide Over, and every iPhone resolve to `.overlay`
  /// without the stored preference being touched, so widening the window brings
  /// the pin back rather than making the reader set it again.
  public static func sidebarMode(regularWidth: Bool, pinned: Bool) -> SidebarMode {
    regularWidth && pinned ? .pinned : .overlay
  }
}
```

Create `clients/apple/TetherKit/Sources/TetherKit/Preferences/PreferenceDefaults.swift`:

```swift
import Foundation

/// First-launch values for preferences whose sensible starting point differs by
/// device.
///
/// These are defaults ONLY. `AppPreferences.init` consults them when nothing is
/// stored yet; a value the reader has already chosen always wins, so nothing
/// here can resize a grid or move a panel under an existing user.
public enum PreferenceDefaults {
  /// An iPad has room to keep the session list on screen, and hiding it there
  /// buys nothing. A phone does not.
  public static func sidebarPinned(isPad: Bool) -> Bool { isPad }

  /// 11pt is the phone's long-standing default and stays exactly that. On a
  /// 10.2" or larger screen it renders a grid far wider than anything a shell
  /// wraps to, so the iPad starts two points up.
  public static func terminalFontSize(isPad: Bool) -> Double { isPad ? 14 : 11 }
}
```

Modify `clients/apple/TetherKit/Sources/TetherKit/Preferences/AppPreferences.swift`. Add `sidebarPinned` to the `Key` enum:

```swift
  private enum Key {
    static let colorScheme = "tether.colorScheme"
    static let terminalFont = "tether.terminalFont"
    static let terminalFontSize = "tether.terminalFontSize"
    static let sidebarPinned = "tether.sidebarPinned"
  }
```

Add the property after `terminalFontSize`, following the same `didSet` shape as its neighbours:

```swift
  /// Whether the session list should be a column beside the terminal rather
  /// than a slide-over. Only consulted at regular width — see
  /// `TetherLayout.sidebarMode`.
  public var sidebarPinned: Bool {
    didSet {
      UserDefaults.standard.set(sidebarPinned, forKey: Key.sidebarPinned)
    }
  }
```

Replace `init()` entirely:

```swift
  public init() {
    let defaults = UserDefaults.standard
    #if canImport(UIKit)
    let isPad = UIDevice.current.userInterfaceIdiom == .pad
    #else
    let isPad = false
    #endif
    colorSchemePreference = ColorSchemePreference(
      rawValue: defaults.string(forKey: Key.colorScheme) ?? ""
    ) ?? .dark
    terminalFont = TerminalFont(rawValue: defaults.string(forKey: Key.terminalFont) ?? "") ?? .menlo
    let size = defaults.double(forKey: Key.terminalFontSize)
    terminalFontSize = size > 0 ? size : PreferenceDefaults.terminalFontSize(isPad: isPad)
    // `bool(forKey:)` cannot tell "false" from "never set", so the presence of
    // the key is what decides whether the per-idiom default applies. Reading it
    // the lazy way would flip every iPad back to unpinned on second launch.
    sidebarPinned = defaults.object(forKey: Key.sidebarPinned) as? Bool
      ?? PreferenceDefaults.sidebarPinned(isPad: isPad)
  }
```

`AppPreferences.swift` already begins with `import SwiftUI`, which brings in `UIKit` on iOS; add nothing.

- [ ] **Step 4: Run the tests and verify they pass**

Run SYNC, then UNIT TESTS.
Expected: `** TEST SUCCEEDED **`, `TetherLayoutTests` 2 passed, `PreferenceDefaultsTests` 2 passed, total 63.

- [ ] **Step 5: Commit**

```bash
cd ~/sites/tether-wt/ipad
git add clients/apple/TetherKit/Sources/TetherKit/Layout/TetherLayout.swift \
        clients/apple/TetherKit/Sources/TetherKit/Preferences/PreferenceDefaults.swift \
        clients/apple/TetherKit/Sources/TetherKit/Preferences/AppPreferences.swift \
        clients/apple/TetherKit/Tests/TetherKitTests/TetherLayoutTests.swift \
        clients/apple/TetherKit/Tests/TetherKitTests/PreferenceDefaultsTests.swift
git commit -m "feat(ios): add sidebar layout rule and per-idiom preference defaults"
```

---

## Task 2: Pin the sidebar beside the terminal

**Files:**
- Modify: `clients/apple/TetherKit/Sources/TetherKit/Views/SessionDrawerView.swift`
- Modify: `clients/apple/TetherKit/Sources/TetherKit/Views/TerminalTitleBar.swift:1-70`
- Modify: `clients/apple/TetherIOS/RootView.swift`

**Interfaces:**
- Consumes: `SidebarMode`, `TetherLayout.sidebarMode(regularWidth:pinned:)`, `AppPreferences.sidebarPinned` (Task 1).
- Produces:
  - `SessionDrawerView.init(store:pinned:onSelectSession:onReenterPassword:onHostSettings:onClose:)` — `pinned` defaults to `false`.
  - `TerminalTitleBar.init(store:sidebarPinned:onOpenDrawer:onNewSession:onGit:onSettings:overflow:)` — `sidebarPinned` defaults to `false`.

There are no unit tests in this task: the deliverable is view composition, and the rule it depends on is already tested in Task 1. It is verified by the app build plus a manual pass on the iPad simulator.

- [ ] **Step 1: Give the drawer a pinned mode**

In `clients/apple/TetherKit/Sources/TetherKit/Views/SessionDrawerView.swift`, add the property and init parameter:

```swift
public struct SessionDrawerView: View {
  @Bindable public var store: SessionStore
  /// Whether this is a permanent column rather than a slide-over.
  ///
  /// A pinned drawer is furniture: picking a session does not put it away, and
  /// its header button unpins instead of closing, because there is nothing to
  /// close to.
  public var pinned: Bool
  public var onSelectSession: (String, String) -> Void
  public var onReenterPassword: (String) -> Void
  public var onHostSettings: (String) -> Void
  public var onClose: () -> Void

  public init(
    store: SessionStore,
    pinned: Bool = false,
    onSelectSession: @escaping (String, String) -> Void,
    onReenterPassword: @escaping (String) -> Void,
    onHostSettings: @escaping (String) -> Void,
    onClose: @escaping () -> Void
  ) {
    self.store = store
    self.pinned = pinned
    self.onSelectSession = onSelectSession
    self.onReenterPassword = onReenterPassword
    self.onHostSettings = onHostSettings
    self.onClose = onClose
  }
```

Replace the header's close button (currently the `Button(action: onClose)` with `Image(systemName: "xmark")`) with:

```swift
        Button(action: onClose) {
          Image(systemName: pinned ? "sidebar.left" : "xmark")
            .tapTarget()
        }
        .accessibilityLabel(pinned ? "Unpin session list" : "Close session list")
```

- [ ] **Step 2: Let the title bar's button unpin**

In `clients/apple/TetherKit/Sources/TetherKit/Views/TerminalTitleBar.swift`, add the property after `store` and the matching init parameter after `store:`:

```swift
  /// Whether the session list is already a column on screen. When it is, the
  /// leading button has nothing to open — it puts the column away instead, and
  /// says so.
  public var sidebarPinned: Bool = false
```

```swift
  public init(
    store: SessionStore,
    sidebarPinned: Bool = false,
    onOpenDrawer: @escaping () -> Void,
    onNewSession: @escaping () -> Void,
    onGit: @escaping () -> Void,
    onSettings: @escaping () -> Void,
    @ViewBuilder overflow: @escaping () -> Overflow
  ) {
    self.store = store
    self.sidebarPinned = sidebarPinned
    self.onOpenDrawer = onOpenDrawer
    self.onNewSession = onNewSession
    self.onGit = onGit
    self.onSettings = onSettings
    self.overflow = overflow
  }
```

Replace the first line of the body's `HStack`:

```swift
      iconButton(
        sidebarPinned ? "sidebar.left" : "line.3.horizontal",
        label: sidebarPinned ? "Hide session list" : "Open session list",
        action: onOpenDrawer
      )
```

- [ ] **Step 3: Split RootView**

In `clients/apple/TetherIOS/RootView.swift`, add the size-class read and the derived mode next to `litChrome`:

```swift
  @Environment(\.horizontalSizeClass) private var horizontalSizeClass

  private var sidebarMode: SidebarMode {
    TetherLayout.sidebarMode(
      regularWidth: horizontalSizeClass == .regular,
      pinned: preferences.sidebarPinned
    )
  }
```

Replace the `VStack(spacing: 0) { TerminalTitleBar … TerminalView … }` block inside the ZStack with:

```swift
      HStack(spacing: 0) {
        if sidebarMode == .pinned {
          SessionDrawerView(
            store: store,
            pinned: true,
            onSelectSession: { hostId, sessionId in
              selectSession(hostId: hostId, sessionId: sessionId)
            },
            onReenterPassword: { hostId in
              passwordPromptHostId = hostId
            },
            onHostSettings: { hostId in
              settingsHostId = hostId
              showSettings = true
            },
            // The header button unpins rather than closing: a pinned column has
            // nowhere to close to, and leaving it as a dead ✕ was the version
            // that read as broken.
            onClose: { preferences.sidebarPinned = false }
          )
          .frame(width: 264)
          Divider()
        }

        VStack(spacing: 0) {
          TerminalTitleBar(
            store: store,
            sidebarPinned: sidebarMode == .pinned,
            onOpenDrawer: toggleSidebar,
            onNewSession: {
              Task {
                await store.newTerminal()
              }
            },
            onGit: { showGit = true },
            onSettings: { showSettings = true },
            overflow: { overflowItems }
          )

          PresentationBannerSlot(store: store, workspace: workspace)

          TerminalView(
            store: store,
            preferences: preferences,
            onAddHost: { showPairing = true },
            // Anything that covers the terminal has to take the key bar with
            // it. The bar is an inputAccessoryView, so it lives in the keyboard
            // window ABOVE the app: an in-app overlay cannot hide it, and it
            // sat over the presentation, file viewer, and the viewer's
            // loading/error states, clipping their last lines.
            //
            // A PINNED sidebar is not one of those overlays — it sits beside
            // the terminal, covers nothing, and must not pull the keys down.
            overlayPresented: (sidebarMode == .overlay && drawerOpen)
              || workspace.activePresentation != nil
              || workspace.fileView != nil
              || workspace.fileError != nil
              || workspace.fileLoading,
            onOpenFile: { path, line, column in
              Task { await workspace.openFile(store: store, path: path, line: line, column: column) }
            }
          )
          .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
      }
```

Guard the overlay so it is not mounted at all when pinned. Replace the `SessionDrawerOverlay(…)` call inside the `#if canImport(UIKit)` block with:

```swift
      // Mounted only when the drawer is actually a slide-over. Left in place
      // while pinned it would put a screen-edge pan recogniser and a scrim over
      // a terminal that has a session list beside it already.
      if sidebarMode == .overlay {
        SessionDrawerOverlay(
          isPresented: $drawerOpen,
          store: store,
          onSelectSession: { hostId, sessionId in
            selectSession(hostId: hostId, sessionId: sessionId)
          },
          onReenterPassword: { hostId in
            passwordPromptHostId = hostId
          },
          onHostSettings: { hostId in
            settingsHostId = hostId
            showSettings = true
          }
        )
      }
```

Add the two helpers next to `openDrawer()`, and pull the selection body out of the two call sites so it exists once:

```swift
  private func selectSession(hostId: String, sessionId: String) {
    if !store.hasPassword(hostId: hostId) {
      passwordPromptHostId = hostId
      return
    }
    Task {
      await store.selectSession(hostId: hostId, sessionId: sessionId)
    }
  }

  /// The leading title-bar button. Pinned, it puts the column away; unpinned, it
  /// opens the slide-over — and at regular width it pins instead, because the
  /// reader asking for the session list on a wide screen wants it to stay.
  private func toggleSidebar() {
    if sidebarMode == .pinned {
      preferences.sidebarPinned = false
      return
    }
    if horizontalSizeClass == .regular {
      preferences.sidebarPinned = true
      store.refreshDrawerInBackground()
      return
    }
    openDrawer()
  }
```

- [ ] **Step 4: Build the app and verify**

Run SYNC, then APP BUILD.
Expected: `** BUILD SUCCEEDED **` with no warnings about the changed files.

Then boot the iPad simulator and confirm by eye:

```bash
ssh macbuild 'xcrun simctl boot <IPAD_UDID>; open -a Simulator'
```

Install the built app and check: the sidebar is a column on first launch; tapping the header `sidebar.left` collapses it to the title-bar button; tapping that button pins it again; picking a session leaves the column open; rotating to portrait keeps it pinned (an 11" iPad is regular width in both orientations); dragging the app into Slide Over swaps to the slide-over drawer and back.

- [ ] **Step 5: Commit**

```bash
cd ~/sites/tether-wt/ipad
git add clients/apple/TetherKit/Sources/TetherKit/Views/SessionDrawerView.swift \
        clients/apple/TetherKit/Sources/TetherKit/Views/TerminalTitleBar.swift \
        clients/apple/TetherIOS/RootView.swift
git commit -m "feat(ios): pin the session list beside the terminal at regular width"
```

---

## Task 3: Key bar — keys left, D-pad right, and no Ctrl checkmark

**Files:**
- Create: `clients/apple/TetherKit/Sources/TetherKit/Layout/AccessoryLayout.swift`
- Create: `clients/apple/TetherKit/Tests/TetherKitTests/AccessoryLayoutTests.swift`
- Modify: `clients/apple/TetherKit/Sources/TetherKit/Views/TerminalView.swift:74-90` (the bar body) and `:174-185` (`ctrlButton`)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `public enum AccessoryLayout { public static func fitsWithoutScrolling(width: CGFloat, keyCount: Int, keySize: CGFloat, spacing: CGFloat, horizontalPadding: CGFloat) -> Bool }`

- [ ] **Step 1: Write the failing test**

Create `clients/apple/TetherKit/Tests/TetherKitTests/AccessoryLayoutTests.swift`:

```swift
import XCTest
@testable import TetherKit

final class AccessoryLayoutTests: XCTestCase {
  // The bar's real numbers, read off the row itself: 11 keys at
  // `TerminalAccessoryBar.keySize`, `HStack(spacing: 8)`, and the
  // `.padding(.horizontal, 12)` the row already carries.
  private let keyCount = 11
  private let keySize: CGFloat = 40
  private let spacing: CGFloat = 8
  private let padding: CGFloat = 12

  private func fits(_ width: CGFloat) -> Bool {
    AccessoryLayout.fitsWithoutScrolling(
      width: width,
      keyCount: keyCount,
      keySize: keySize,
      spacing: spacing,
      horizontalPadding: padding
    )
  }

  func test_a_phone_width_does_not_fit_the_row() {
    XCTAssertFalse(fits(390))
    XCTAssertFalse(fits(430))
  }

  func test_an_ipad_width_fits_the_row() {
    XCTAssertTrue(fits(1024))
  }

  func test_the_boundary_is_exact() {
    // 11 * 40 + 10 * 8 + 2 * 12 = 544
    XCTAssertTrue(fits(544))
    XCTAssertFalse(fits(543))
  }

  func test_a_single_key_needs_no_spacing_between_keys() {
    // 40 + 2 * 12 = 64, with no gap to add.
    XCTAssertTrue(
      AccessoryLayout.fitsWithoutScrolling(
        width: 64, keyCount: 1, keySize: 40, spacing: 8, horizontalPadding: 12
      )
    )
    XCTAssertFalse(
      AccessoryLayout.fitsWithoutScrolling(
        width: 63, keyCount: 1, keySize: 40, spacing: 8, horizontalPadding: 12
      )
    )
  }

  func test_an_empty_row_always_fits() {
    XCTAssertTrue(
      AccessoryLayout.fitsWithoutScrolling(
        width: 0, keyCount: 0, keySize: 40, spacing: 8, horizontalPadding: 12
      )
    )
  }

  func test_a_width_that_has_not_been_measured_yet_does_not_claim_to_fit() {
    // The bar publishes its width from a background reader, so the first frame
    // asks with 0. Answering "fits" there would lay the row out flat and then
    // snap it to a scroller one frame later.
    XCTAssertFalse(fits(0))
  }
}
```

- [ ] **Step 2: Run the tests and verify they fail**

Run SYNC, then UNIT TESTS.
Expected: build failure — `cannot find 'AccessoryLayout' in scope`.

- [ ] **Step 3: Write the implementation**

Create `clients/apple/TetherKit/Sources/TetherKit/Layout/AccessoryLayout.swift`:

```swift
import CoreGraphics

/// Whether the utility key row can be laid out flat instead of scrolled.
///
/// On a phone the row is wider than the screen and has to scroll, which puts the
/// D-pad wherever the reader last left the scroll offset. On a wide screen it
/// fits with room to spare, and scrolling it there means the one control a right
/// thumb reaches for sits near the left edge with 500pt of empty bar beside it.
public enum AccessoryLayout {
  /// `keySize` is a MINIMUM width — text keys ("Home", "PgDn") are wider — so a
  /// true answer means the row fits with the narrowest possible keys. The bar
  /// keeps a `Spacer` between the two clusters, which absorbs the difference,
  /// and a row that overflows despite this simply clips the spacer to zero
  /// rather than truncating a key.
  public static func fitsWithoutScrolling(
    width: CGFloat,
    keyCount: Int,
    keySize: CGFloat,
    spacing: CGFloat,
    horizontalPadding: CGFloat
  ) -> Bool {
    guard keyCount > 0 else { return true }
    let gaps = CGFloat(keyCount - 1) * spacing
    let keys = CGFloat(keyCount) * keySize
    return keys + gaps + horizontalPadding * 2 <= width
  }
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run SYNC, then UNIT TESTS.
Expected: `** TEST SUCCEEDED **`, `AccessoryLayoutTests` 6 passed, total 69.

- [ ] **Step 5: Lay the bar out flat when it fits**

In `clients/apple/TetherKit/Sources/TetherKit/Views/TerminalView.swift`, `TerminalAccessoryBar.body` currently reads (lines 74–90 for the row, then the modifiers through the `.animation` at the end):

```swift
  public var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 8) {
        ctrlButton
        …eleven keys…
      }
      .padding(.horizontal, 12)
      .padding(.vertical, Self.barVerticalPadding)
    }
    .background(.ultraThinMaterial, ignoresSafeAreaEdges: [])
    .background(
      GeometryReader { proxy in
        Color.clear
          .onAppear { report(proxy) }
          .onChange(of: proxy.frame(in: .global)) { _, _ in report(proxy) }
      }
    )
    .offset(y: …)
    .opacity(…)
    .animation(…)
  }
```

**Do not wrap the body in a `GeometryReader`.** A `GeometryReader` fills its parent rather than sizing to its content, and this view is the root of a `UIHostingController` that UIKit asks for a fitted height — wrapping it makes `sizeThatFits` report the whole screen and the accessory bar becomes full-height. Width comes from the reader that is already in the `.background`, published into `@State`.

Add the state and the key count next to the other stored properties of `TerminalAccessoryBar`, after `onHideKeyboard`:

```swift
  /// The row's own width, published by the background reader below.
  ///
  /// Starts at 0, which `AccessoryLayout` answers as "does not fit", so the
  /// first frame is the scrolling row and a wide screen switches to the flat
  /// row once the reader reports. The other direction — guessing "fits" and
  /// correcting — would put a visible snap in the bar on every phone.
  @State private var barWidth: CGFloat = 0

  /// Eleven keys: Ctrl, Tab, Esc, /, the D-pad, Paste, Hide, Del, Home, End,
  /// PgUp, PgDn — the D-pad counting as the single square key it is.
  static let keyCount = 11
```

Replace the `body` down to and including the closing `}` of the `ScrollView` (that is, everything from `public var body: some View {` through the line `    }` that closes the `ScrollView`, leaving `.background(.ultraThinMaterial…)` and every modifier after it untouched) with:

```swift
  /// Key order matches `UTILITY_BAR_KEYS` in the RN client. There are no arrow
  /// keys: the D-pad is one square key in the row and covers all four
  /// directions, which is why four separate arrows would be redundant.
  ///
  /// The D-pad is fifth in the scrolling row and last in the flat one. That is
  /// deliberate rather than inconsistent: a scrolling row puts the D-pad
  /// wherever the reader last left the offset, so it sits early where it is
  /// reachable without scrolling at all. A row that fits does not scroll, so the
  /// D-pad can take the trailing edge and stay under the thumb that reaches for
  /// it.
  public var body: some View {
    Group {
      if AccessoryLayout.fitsWithoutScrolling(
        width: barWidth,
        keyCount: Self.keyCount,
        keySize: Self.keySize,
        spacing: 8,
        horizontalPadding: 12
      ) {
        HStack(spacing: 8) {
          leadingKeys
          Spacer(minLength: 8)
          DpadView(size: Self.keySize, onArrow: onArrow)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, Self.barVerticalPadding)
      } else {
        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: 8) {
            ctrlButton
            accessoryButton("Tab") { send(base: "\t") }
            accessoryButton("Esc") { onKey("\u{1B}") }
            accessoryButton("/") { onKey("/") }
            DpadView(size: Self.keySize, onArrow: onArrow)
            pasteButton
            accessoryButton("Hide", systemImage: "keyboard.chevron.compact.down", action: onHideKeyboard)
            accessoryButton("Del") { onKey("\u{1B}[3~") }
            accessoryButton("Home") { send(base: "\u{1B}[H") }
            accessoryButton("End") { send(base: "\u{1B}[F") }
            accessoryButton("PgUp") { onKey("\u{1B}[5~") }
            accessoryButton("PgDn") { onKey("\u{1B}[6~") }
          }
          .padding(.horizontal, 12)
          .padding(.vertical, Self.barVerticalPadding)
        }
      }
    }
```

Then, in the `.background(GeometryReader { proxy in … })` that follows — the one that already calls `report(proxy)` — add the width publish to both callbacks, so it is measured on first layout and on every rotation:

```swift
    .background(
      GeometryReader { proxy in
        Color.clear
          .onAppear {
            report(proxy)
            barWidth = proxy.size.width
          }
          .onChange(of: proxy.frame(in: .global)) { _, _ in
            report(proxy)
            barWidth = proxy.size.width
          }
      }
    )
```

Add the leading cluster next to `ctrlButton`:

```swift
  /// Everything except the D-pad, in the scrolling row's order, with Paste and
  /// Hide closing the gap the D-pad leaves.
  @ViewBuilder
  private var leadingKeys: some View {
    ctrlButton
    accessoryButton("Tab") { send(base: "\t") }
    accessoryButton("Esc") { onKey("\u{1B}") }
    accessoryButton("/") { onKey("/") }
    pasteButton
    accessoryButton("Hide", systemImage: "keyboard.chevron.compact.down", action: onHideKeyboard)
    accessoryButton("Del") { onKey("\u{1B}[3~") }
    accessoryButton("Home") { send(base: "\u{1B}[H") }
    accessoryButton("End") { send(base: "\u{1B}[F") }
    accessoryButton("PgUp") { onKey("\u{1B}[5~") }
    accessoryButton("PgDn") { onKey("\u{1B}[6~") }
  }
```

- [ ] **Step 6: Drop the Ctrl checkmark**

In the same file, replace the label of `ctrlButton`:

```swift
    } label: {
      // No "✓" glyph. `TerminalKeyStyle(armed:)` already gives the key the
      // accent fill and the onAccent foreground, so the mark said the same
      // thing twice — and it widened the key when armed, which shifted every
      // key to its right by the width of a checkmark each time Ctrl was
      // tapped.
      Text("Ctrl")
    }
```

Delete the now-unused `.contentTransition(.opacity)` on that `Text`. Leave `.buttonStyle(TerminalKeyStyle(armed: model.ctrlArmed))`, `.accessibilityLabel`, and `.accessibilityValue` untouched — the accessibility value is the only thing that reports the latch to VoiceOver now that the visible cue is colour alone.

- [ ] **Step 7: Build and verify**

Run SYNC, then UNIT TESTS, then APP BUILD.
Expected: both succeed.

On the iPad simulator: the key bar shows a single flat row, modifiers packed left, D-pad against the right edge, no horizontal scroll. Tapping Ctrl turns the key accent-coloured and nothing in the row moves. On the iPhone simulator: the row still scrolls and still opens on Ctrl.

- [ ] **Step 8: Commit**

```bash
cd ~/sites/tether-wt/ipad
git add clients/apple/TetherKit/Sources/TetherKit/Layout/AccessoryLayout.swift \
        clients/apple/TetherKit/Tests/TetherKitTests/AccessoryLayoutTests.swift \
        clients/apple/TetherKit/Sources/TetherKit/Views/TerminalView.swift
git commit -m "feat(ios): put the D-pad on the trailing edge when the key bar fits"
```

---

## Task 4: Hardware-keyboard shortcuts

**Files:**
- Create: `clients/apple/TetherKit/Sources/TetherKit/Layout/SessionJump.swift`
- Create: `clients/apple/TetherKit/Tests/TetherKitTests/SessionJumpTests.swift`
- Create: `clients/apple/TetherIOS/KeyboardShortcutsLayer.swift`
- Modify: `clients/apple/TetherIOS/RootView.swift`
- Modify: `clients/apple/Tether.xcodeproj/project.pbxproj`

**Interfaces:**
- Consumes: `AppPreferences.sidebarPinned` (Task 1), `RootView.selectSession(hostId:sessionId:)` and `toggleSidebar()` (Task 2).
- Produces:
  - `public struct SessionRef: Sendable, Equatable { public let hostId: String; public let sessionId: String }`
  - `public enum SessionJump { public static func ordered(hosts: [HostProfileModel], sessionsByHost: [String: [RemoteSession]]) -> [SessionRef]; public static func at(index: Int, in ordered: [SessionRef]) -> SessionRef?; public static func step(from current: SessionRef?, by offset: Int, in ordered: [SessionRef]) -> SessionRef? }`

- [ ] **Step 1: Write the failing test**

Create `clients/apple/TetherKit/Tests/TetherKitTests/SessionJumpTests.swift`:

```swift
import XCTest
@testable import TetherKit
import TetherFFIBindings

final class SessionJumpTests: XCTestCase {
  private func host(_ id: String, order: UInt32) -> HostProfileModel {
    HostProfileModel(
      FfiHostProfile(
        id: id,
        name: id,
        color: "#ffffff",
        host: "127.0.0.1",
        port: "8085",
        identityName: id,
        order: order
      )
    )
  }

  private func session(_ id: String) -> RemoteSession {
    RemoteSession(
      id: id,
      status: "running",
      lastOutputAt: nil,
      name: nil,
      autoTitle: nil,
      activity: nil
    )
  }

  private var hosts: [HostProfileModel] { [host("a", order: 0), host("b", order: 1)] }

  private var sessionsByHost: [String: [RemoteSession]] {
    [
      "a": [session("term-1"), session("term-2")],
      "b": [session("term-1")],
    ]
  }

  func test_order_walks_hosts_then_their_sessions() {
    let ordered = SessionJump.ordered(hosts: hosts, sessionsByHost: sessionsByHost)
    XCTAssertEqual(
      ordered,
      [
        SessionRef(hostId: "a", sessionId: "term-1"),
        SessionRef(hostId: "a", sessionId: "term-2"),
        SessionRef(hostId: "b", sessionId: "term-1"),
      ]
    )
  }

  func test_a_host_with_no_sessions_contributes_nothing() {
    let ordered = SessionJump.ordered(
      hosts: hosts,
      sessionsByHost: ["b": [session("term-1")]]
    )
    XCTAssertEqual(ordered, [SessionRef(hostId: "b", sessionId: "term-1")])
  }

  func test_index_is_zero_based_and_bounded() {
    let ordered = SessionJump.ordered(hosts: hosts, sessionsByHost: sessionsByHost)
    XCTAssertEqual(SessionJump.at(index: 0, in: ordered), SessionRef(hostId: "a", sessionId: "term-1"))
    XCTAssertEqual(SessionJump.at(index: 2, in: ordered), SessionRef(hostId: "b", sessionId: "term-1"))
    XCTAssertNil(SessionJump.at(index: 3, in: ordered))
    XCTAssertNil(SessionJump.at(index: -1, in: ordered))
  }

  func test_stepping_wraps_at_both_ends() {
    let ordered = SessionJump.ordered(hosts: hosts, sessionsByHost: sessionsByHost)
    let first = SessionRef(hostId: "a", sessionId: "term-1")
    let last = SessionRef(hostId: "b", sessionId: "term-1")
    XCTAssertEqual(SessionJump.step(from: last, by: 1, in: ordered), first)
    XCTAssertEqual(SessionJump.step(from: first, by: -1, in: ordered), last)
  }

  func test_stepping_from_nothing_lands_on_the_first_session() {
    let ordered = SessionJump.ordered(hosts: hosts, sessionsByHost: sessionsByHost)
    XCTAssertEqual(
      SessionJump.step(from: nil, by: 1, in: ordered),
      SessionRef(hostId: "a", sessionId: "term-1")
    )
  }

  func test_stepping_with_nothing_open_anywhere_returns_nil() {
    XCTAssertNil(SessionJump.step(from: nil, by: 1, in: []))
  }

  func test_stepping_from_a_session_that_has_since_been_killed_lands_on_the_first() {
    let ordered = SessionJump.ordered(hosts: hosts, sessionsByHost: sessionsByHost)
    let gone = SessionRef(hostId: "a", sessionId: "term-99")
    XCTAssertEqual(
      SessionJump.step(from: gone, by: 1, in: ordered),
      SessionRef(hostId: "a", sessionId: "term-1")
    )
  }
}
```

- [ ] **Step 2: Run the tests and verify they fail**

Run SYNC, then UNIT TESTS.
Expected: build failure — `cannot find 'SessionJump' in scope`.

- [ ] **Step 3: Write the implementation**

Create `clients/apple/TetherKit/Sources/TetherKit/Layout/SessionJump.swift`:

```swift
import Foundation

/// One session, qualified by the host it belongs to.
///
/// Session ids are only unique per host — every server has a `term-1` — so a
/// bare id cannot address a session across a multi-host drawer.
public struct SessionRef: Sendable, Equatable {
  public let hostId: String
  public let sessionId: String

  public init(hostId: String, sessionId: String) {
    self.hostId = hostId
    self.sessionId = sessionId
  }
}

/// Keyboard navigation over the session list.
///
/// The order here must match what the drawer renders, or ⌘3 lands somewhere
/// other than the third row the reader is looking at. `hosts` is already in
/// drawer order when it comes off `SessionStore`, so this walks it as given
/// rather than re-sorting.
public enum SessionJump {
  public static func ordered(
    hosts: [HostProfileModel],
    sessionsByHost: [String: [RemoteSession]]
  ) -> [SessionRef] {
    hosts.flatMap { host in
      (sessionsByHost[host.id] ?? []).map {
        SessionRef(hostId: host.id, sessionId: $0.id)
      }
    }
  }

  /// Zero-based, so ⌘1 passes 0. Out of range returns nil rather than clamping:
  /// ⌘7 in a four-session drawer should do nothing, not jump to the last one.
  public static func at(index: Int, in ordered: [SessionRef]) -> SessionRef? {
    guard ordered.indices.contains(index) else { return nil }
    return ordered[index]
  }

  /// Previous/next, wrapping at both ends.
  ///
  /// A `current` that is not in the list — nothing open yet, or a session killed
  /// out from under the shortcut — starts from the beginning rather than
  /// refusing to move.
  public static func step(from current: SessionRef?, by offset: Int, in ordered: [SessionRef]) -> SessionRef? {
    guard !ordered.isEmpty else { return nil }
    guard let current, let index = ordered.firstIndex(of: current) else {
      return ordered.first
    }
    let count = ordered.count
    let next = ((index + offset) % count + count) % count
    return ordered[next]
  }
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run SYNC, then UNIT TESTS.
Expected: `** TEST SUCCEEDED **`, `SessionJumpTests` 7 passed, total 76.

- [ ] **Step 5: Add the shortcut layer**

Create `clients/apple/TetherIOS/KeyboardShortcutsLayer.swift`:

```swift
import SwiftUI
import TetherKit

/// The app's ⌘-shortcuts, as invisible buttons.
///
/// SwiftUI on iOS has no `.commands` menu to hang shortcuts from, so a shortcut
/// has to belong to a control in the hierarchy. These carry no label and no
/// hit area — they exist only so `.keyboardShortcut` has somewhere to live —
/// and are hosted in a `.background` on the root so they are always in the
/// responder chain regardless of what is on screen.
///
/// They do not collide with the terminal. `TerminalKeyMap.bytes(for:)` claims
/// named keys (arrows, Home, PgUp, Esc, Delete) and then bails with
/// `guard ctrl || alt else { return nil }`, so a ⌘-modified letter or digit is
/// never claimed; `pressesBegan` hands it to `super` and it reaches SwiftUI.
struct KeyboardShortcutsLayer: View {
  let store: SessionStore
  let onToggleSidebar: () -> Void
  let onNewTerminal: () -> Void
  let onSettings: () -> Void
  let onJump: (SessionRef) -> Void

  private var ordered: [SessionRef] {
    SessionJump.ordered(hosts: store.hosts, sessionsByHost: store.sessionsByHost)
  }

  private var current: SessionRef? {
    guard let hostId = store.activeHostId, let sessionId = store.activeSessionId else {
      return nil
    }
    return SessionRef(hostId: hostId, sessionId: sessionId)
  }

  var body: some View {
    ZStack {
      shortcut("b", modifiers: .command, action: onToggleSidebar)
      shortcut("t", modifiers: .command, action: onNewTerminal)
      shortcut(",", modifiers: .command, action: onSettings)
      shortcut("[", modifiers: [.command, .shift]) {
        if let ref = SessionJump.step(from: current, by: -1, in: ordered) { onJump(ref) }
      }
      shortcut("]", modifiers: [.command, .shift]) {
        if let ref = SessionJump.step(from: current, by: 1, in: ordered) { onJump(ref) }
      }
      ForEach(1...9, id: \.self) { number in
        shortcut(Character("\(number)"), modifiers: .command) {
          if let ref = SessionJump.at(index: number - 1, in: ordered) { onJump(ref) }
        }
      }
    }
    // Zero-size and non-interactive: this layer is a shortcut table, and any
    // hit area it claimed would sit over the terminal.
    .frame(width: 0, height: 0)
    .allowsHitTesting(false)
    .accessibilityHidden(true)
  }

  private func shortcut(
    _ key: Character,
    modifiers: EventModifiers,
    action: @escaping () -> Void
  ) -> some View {
    Button(action: action) { EmptyView() }
      .keyboardShortcut(KeyEquivalent(key), modifiers: modifiers)
      .buttonStyle(.plain)
      .opacity(0)
  }
}
```

- [ ] **Step 6: Wire it into RootView**

In `clients/apple/TetherIOS/RootView.swift`, add to the modifier chain on the root `ZStack`, immediately above `.ignoresSafeArea(.keyboard, edges: .bottom)`:

```swift
    .background {
      KeyboardShortcutsLayer(
        store: store,
        onToggleSidebar: toggleSidebar,
        onNewTerminal: { Task { await store.newTerminal() } },
        onSettings: { showSettings = true },
        onJump: { ref in
          selectSession(hostId: ref.hostId, sessionId: ref.sessionId)
        }
      )
    }
```

`selectSession(hostId:sessionId:)` and `toggleSidebar()` were added in Task 2.

- [ ] **Step 7: Add the new file to the Xcode target**

`KeyboardShortcutsLayer.swift` lives in `clients/apple/TetherIOS/`, which is a folder reference or a group in `Tether.xcodeproj`. Check first:

```bash
grep -n "RootView.swift" clients/apple/Tether.xcodeproj/project.pbxproj
```

If `RootView.swift` appears only inside a `PBXFileSystemSynchronizedRootGroup` (Xcode 16+ synchronized folders), the new file is picked up automatically and no project edit is needed. If it appears in `PBXBuildFile` and `PBXFileReference` entries, add matching entries for `KeyboardShortcutsLayer.swift` — copy the `RootView.swift` lines, generate two fresh 24-character hex ids not already in the file, and add the build file to the `Sources` build phase and the file reference to the same group.

- [ ] **Step 8: Build and verify**

Run SYNC, then UNIT TESTS, then APP BUILD.
Expected: both succeed.

On the iPad simulator with **I/O → Input → Send Keyboard Shortcuts to Device** enabled: ⌘B pins and unpins, ⌘T opens a terminal, ⌘1 and ⌘2 jump between sessions, ⌘⇧] advances and wraps, ⌘, opens settings. Then confirm the terminal is unaffected: type into a shell, press ⌃C and the arrow keys, and check both still reach the PTY.

- [ ] **Step 9: Commit**

```bash
cd ~/sites/tether-wt/ipad
git add clients/apple/TetherKit/Sources/TetherKit/Layout/SessionJump.swift \
        clients/apple/TetherKit/Tests/TetherKitTests/SessionJumpTests.swift \
        clients/apple/TetherIOS/KeyboardShortcutsLayer.swift \
        clients/apple/TetherIOS/RootView.swift \
        clients/apple/Tether.xcodeproj/project.pbxproj
git commit -m "feat(ios): add command-key shortcuts for sidebar, sessions, and settings"
```

---

## Task 5: Hide the key bar when a hardware keyboard is attached

**Files:**
- Create: `clients/apple/TetherKit/Sources/TetherKit/Layout/AccessoryVisibility.swift`
- Create: `clients/apple/TetherKit/Sources/TetherKit/Input/HardwareKeyboard.swift`
- Create: `clients/apple/TetherKit/Tests/TetherKitTests/AccessoryVisibilityTests.swift`
- Modify: `clients/apple/TetherKit/Sources/TetherKit/Views/TerminalView.swift` (the `accessoryVisible` computed property, around line 793)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `public enum AccessoryVisibility { public static func shouldShow(hasSession: Bool, overlayPresented: Bool, hardwareKeyboard: Bool) -> Bool }`
  - `@MainActor @Observable public final class HardwareKeyboard { public var isConnected: Bool; public init() }`

- [ ] **Step 1: Write the failing test**

Create `clients/apple/TetherKit/Tests/TetherKitTests/AccessoryVisibilityTests.swift`:

```swift
import XCTest
@testable import TetherKit

final class AccessoryVisibilityTests: XCTestCase {
  func test_the_bar_shows_for_a_live_session_with_nothing_over_it() {
    XCTAssertTrue(
      AccessoryVisibility.shouldShow(
        hasSession: true, overlayPresented: false, hardwareKeyboard: false
      )
    )
  }

  func test_no_session_means_no_bar() {
    // A row of keys with nothing to send them to.
    XCTAssertFalse(
      AccessoryVisibility.shouldShow(
        hasSession: false, overlayPresented: false, hardwareKeyboard: false
      )
    )
  }

  func test_an_overlay_takes_the_bar_with_it() {
    XCTAssertFalse(
      AccessoryVisibility.shouldShow(
        hasSession: true, overlayPresented: true, hardwareKeyboard: false
      )
    )
  }

  func test_a_physical_keyboard_replaces_the_bar() {
    XCTAssertFalse(
      AccessoryVisibility.shouldShow(
        hasSession: true, overlayPresented: false, hardwareKeyboard: true
      )
    )
  }
}
```

- [ ] **Step 2: Run the tests and verify they fail**

Run SYNC, then UNIT TESTS.
Expected: build failure — `cannot find 'AccessoryVisibility' in scope`.

- [ ] **Step 3: Write the implementation**

Create `clients/apple/TetherKit/Sources/TetherKit/Layout/AccessoryVisibility.swift`:

```swift
import Foundation

/// Whether the on-screen utility key row belongs on screen.
public enum AccessoryVisibility {
  /// A physical keyboard already carries Esc, Tab, and the arrows, and
  /// `TerminalKeyMap` maps all of them straight to the PTY. Keeping the
  /// on-screen row in that case duplicates keys the reader's hands are already
  /// on and costs the terminal ~52pt of rows.
  public static func shouldShow(
    hasSession: Bool,
    overlayPresented: Bool,
    hardwareKeyboard: Bool
  ) -> Bool {
    hasSession && !overlayPresented && !hardwareKeyboard
  }
}
```

Create `clients/apple/TetherKit/Sources/TetherKit/Input/HardwareKeyboard.swift`:

```swift
#if canImport(UIKit)
import Foundation
import GameController
import Observation

/// Whether a physical keyboard is attached right now.
///
/// `GCKeyboard` is the only API that answers this directly. The alternative —
/// inferring it from the height of the keyboard frame in
/// `keyboardWillChangeFrame` — is a guess that a floating or split software
/// keyboard gets wrong.
@MainActor
@Observable
public final class HardwareKeyboard {
  public private(set) var isConnected: Bool

  @ObservationIgnored private var observers: [NSObjectProtocol] = []

  public init() {
    isConnected = GCKeyboard.coalesced != nil
    let center = NotificationCenter.default
    observers = [
      center.addObserver(forName: .GCKeyboardDidConnect, object: nil, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated { self?.isConnected = true }
      },
      center.addObserver(forName: .GCKeyboardDidDisconnect, object: nil, queue: .main) { [weak self] _ in
        // `coalesced` rather than a flat false: unplugging one of two keyboards
        // still leaves a physical keyboard attached.
        MainActor.assumeIsolated { self?.isConnected = GCKeyboard.coalesced != nil }
      },
    ]
  }

  deinit {
    let center = NotificationCenter.default
    for observer in observers { center.removeObserver(observer) }
  }
}
#endif
```

- [ ] **Step 4: Run the tests and verify they pass**

Run SYNC, then UNIT TESTS.
Expected: `** TEST SUCCEEDED **`, `AccessoryVisibilityTests` 4 passed, total 80.

- [ ] **Step 5: Wire it into TerminalView**

In `clients/apple/TetherKit/Sources/TetherKit/Views/TerminalView.swift`, add the state next to `@State private var accessory = TerminalAccessoryModel()`:

```swift
  @State private var hardwareKeyboard = HardwareKeyboard()
```

Replace the `accessoryVisible` computed property:

```swift
  private var accessoryVisible: Bool {
    AccessoryVisibility.shouldShow(
      hasSession: placeholderReason == nil,
      overlayPresented: overlayPresented,
      hardwareKeyboard: hardwareKeyboard.isConnected
    )
  }
```

Nothing else changes: `TerminalInputBridge.updateUIView` already calls `reloadInputViews()` when `showsAccessory` flips, and `.onChange(of: accessoryVisible, initial: true)` already animates the bar out before UIKit removes it.

- [ ] **Step 6: Build and verify**

Run SYNC, then UNIT TESTS, then APP BUILD.
Expected: both succeed.

On the iPad simulator, toggle **I/O → Input → Connect Hardware Keyboard**: the key bar leaves when it connects and returns when it disconnects, and the terminal reclaims and gives back the space each time without the grid flickering through an intermediate size.

- [ ] **Step 7: Commit**

```bash
cd ~/sites/tether-wt/ipad
git add clients/apple/TetherKit/Sources/TetherKit/Layout/AccessoryVisibility.swift \
        clients/apple/TetherKit/Sources/TetherKit/Input/HardwareKeyboard.swift \
        clients/apple/TetherKit/Tests/TetherKitTests/AccessoryVisibilityTests.swift \
        clients/apple/TetherKit/Sources/TetherKit/Views/TerminalView.swift
git commit -m "feat(ios): drop the on-screen key bar while a hardware keyboard is attached"
```

---

## Task 6: Wide-aware detail views

**Files:**
- Modify: `clients/apple/TetherKit/Sources/TetherKit/Views/GitReviewView.swift:17` and its `body`
- Modify: `clients/apple/TetherKit/Sources/TetherKit/Views/ConfigSettingsView.swift`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: nothing later tasks depend on.

No unit tests: both changes are a size-class read feeding an existing, already-working view. Verified by the app build and a look at the simulator.

- [ ] **Step 1: Default the diff to side-by-side on a wide screen**

In `clients/apple/TetherKit/Sources/TetherKit/Views/GitReviewView.swift`, add the environment read next to the other `@Environment` line and change the state to an optional so "the reader has not chosen" is distinguishable from "the reader chose unified":

```swift
  @Environment(\.horizontalSizeClass) private var horizontalSizeClass

  /// nil until the reader touches the toggle, so the default can follow the
  /// window. A plain `false` meant a 13" screen opened every diff in the
  /// single-column layout the phone needs.
  @State private var sideBySideOverride: Bool?

  private var sideBySide: Bool {
    sideBySideOverride ?? (horizontalSizeClass == .regular)
  }
```

Delete the old `@State private var sideBySide = false`.

Change the toggle button (currently at line 83) to write the override:

```swift
          Button(sideBySide ? "Unified" : "Side by side") {
            sideBySideOverride = !sideBySide
          }
```

Everything reading `sideBySide` below — including the `if sideBySide` at line 143 — is unchanged.

- [ ] **Step 2: Stop settings rows running the full width of the screen**

`clients/apple/TetherKit/Sources/TetherKit/Views/ConfigSettingsView.swift` opens `NavigationStack(path: $path)` at line 33 and `List {` at line 34, with `.navigationTitle("Settings")` on the `List` at line 90. Add the two frames to the `List`, immediately above that `navigationTitle`:

```swift
      // A 13" sheet ran every row edge to edge, which puts the label and its
      // control a hand's width apart and makes a short form look like a table.
      // Capped and centred, it reads as the same form the phone shows.
      .frame(maxWidth: 640)
      .frame(maxWidth: .infinity)
      .navigationTitle("Settings")
```

The order matters and both calls are needed: the first caps the content, the second centres that capped block in whatever width the sheet gets. They go on the `List`, never on the `NavigationStack` — capping the stack would take the navigation bar and the toolbar with it.

- [ ] **Step 3: Build and verify**

Run SYNC, then UNIT TESTS, then APP BUILD.
Expected: both succeed.

On the iPad simulator: open a file diff from the git sheet and confirm it opens side-by-side with a "Unified" button; tap it and it switches, and stays switched for that file. Open settings and confirm the rows are a readable column rather than full-bleed. On the iPhone simulator: diffs still open unified.

- [ ] **Step 4: Commit**

```bash
cd ~/sites/tether-wt/ipad
git add clients/apple/TetherKit/Sources/TetherKit/Views/GitReviewView.swift \
        clients/apple/TetherKit/Sources/TetherKit/Views/ConfigSettingsView.swift
git commit -m "feat(ios): default diffs to side-by-side and cap settings width at regular size"
```

---

## Task 7: Drag and drop a file onto the terminal to upload it

**Files:**
- Modify: `clients/apple/TetherIOS/RootView.swift`

**Interfaces:**
- Consumes: `WorkspaceController.upload(store:data:filename:mimeType:)` (existing, `SessionStore+Workspace.swift:236`), `WorkspaceController.uploadError` (existing).
- Produces: nothing later tasks depend on.

No unit tests: the drop handler is a thin adapter onto an upload path that already exists and already reports progress and failure through `WorkspaceChromeView`.

- [ ] **Step 1: Add the drop target**

In `clients/apple/TetherIOS/RootView.swift`, add to the `TerminalView(...)` call's modifiers, after `.frame(maxWidth: .infinity, maxHeight: .infinity)`:

```swift
          // Dropping a file on the terminal uploads it into that session's cwd
          // — the same path the "Upload file…" menu item takes, reached the way
          // an iPad reader expects to reach it. `isTargeted` is not bound: the
          // upload cover in WorkspaceChromeView is the feedback, and a second
          // highlight over the terminal would be one cue too many for an action
          // that completes in under a second.
          .dropDestination(for: URL.self) { urls, _ in
            guard store.activeSessionId != nil, let url = urls.first else { return false }
            Task { await upload(from: url) }
            return true
          }
```

Add the handler next to `selectSession`:

```swift
  /// Reads a dropped file and hands it to the existing upload path.
  ///
  /// A drop delivers a security-scoped URL that is only readable between
  /// `startAccessingSecurityScopedResource` and its stop, and only on this
  /// runloop turn — reading it inside the upload task instead would find the
  /// scope already closed and fail with a permission error that names no file.
  private func upload(from url: URL) async {
    let scoped = url.startAccessingSecurityScopedResource()
    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
    do {
      let data = try Data(contentsOf: url)
      await workspace.upload(
        store: store,
        data: data,
        filename: url.lastPathComponent,
        mimeType: "application/octet-stream"
      )
    } catch {
      workspace.uploadError = error.localizedDescription
    }
  }
```

- [ ] **Step 2: Build and verify**

Run SYNC, then UNIT TESTS, then APP BUILD.
Expected: both succeed.

On the iPad simulator: open a session, then drag a file from the Files app (split the screen with Files, or drag from macOS onto the simulator window) onto the terminal. The upload cover appears, the file lands in the session's cwd — check with `ls` in the shell. Repeat with no session open and confirm nothing happens and no error appears.

- [ ] **Step 3: Commit**

```bash
cd ~/sites/tether-wt/ipad
git add clients/apple/TetherIOS/RootView.swift
git commit -m "feat(ios): upload a file dropped onto the terminal"
```

---

## Task 8: Pointer support

**Files:**
- Modify: `clients/apple/TetherKit/Sources/TetherKit/Views/TerminalKeyStyle.swift`
- Modify: `clients/apple/TetherKit/Sources/TetherKit/Views/SessionDrawerView.swift`
- Modify: `clients/apple/TetherKit/Sources/TetherKit/Terminal/TetherSurfaceView.swift`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: nothing later tasks depend on.

No unit tests: hover effects and a pointer shape have no logic to assert. Verified by the app build and a trackpad pass on the simulator.

- [ ] **Step 1: Hover on the key bar**

In `clients/apple/TetherKit/Sources/TetherKit/Views/TerminalKeyStyle.swift`, add to `KeyFace`'s `body`, immediately after `.clipShape(shape)`:

```swift
        // A pointer over a key should say the key is a key before it is
        // clicked. The style already owns pressed and armed; hover is the third
        // state the same face can carry.
        .hoverEffect(.highlight)
```

- [ ] **Step 2: Hover on the session rows**

In `clients/apple/TetherKit/Sources/TetherKit/Views/SessionDrawerView.swift`, in `SessionDrawerRow`, add to the select `Button` after `.buttonStyle(.plain)`:

```swift
      .hoverEffect(.highlight)
```

Add the same line after the `NewTerminalRow`'s `.buttonStyle(.plain)`.

- [ ] **Step 3: An I-beam over the grid**

`clients/apple/TetherKit/Sources/TetherKit/Terminal/TetherSurfaceView.swift` has a `commonInit()` at line 77 that both initialisers call, ending with `installGestures()`. Add the interaction as its last line:

```swift
  private func commonInit() {
    isOpaque = true
    // Same constant the SwiftUI chrome uses, so the grid and everything around
    // it are one colour rather than two that nearly match.
    backgroundColor = UIColor(TetherColors.terminalBackground)
    contentMode = .redraw
    isMultipleTouchEnabled = false
    invalidateMetrics()
    installGestures()
    // The grid is text, so the pointer should say so rather than staying the
    // round dot iPadOS uses for anything it does not recognise.
    addInteraction(UIPointerInteraction(delegate: self))
  }
```

Add the delegate conformance as an extension at the bottom of the file, **above** the closing `#endif` — the whole file is inside `#if canImport(UIKit)` and an extension after the `#endif` would not compile:

```swift
extension TetherSurfaceView: UIPointerInteractionDelegate {
  /// A vertical beam one line tall, which is what UIKit uses over a single line
  /// of text. `font` is the regular face the grid is currently drawing with —
  /// the same one `invalidateMetrics()` sizes cells from — so the beam tracks a
  /// font-size change without anything extra.
  public func pointerInteraction(
    _ interaction: UIPointerInteraction,
    styleFor region: UIPointerRegion
  ) -> UIPointerStyle? {
    UIPointerStyle(shape: .verticalBeam(length: font.lineHeight))
  }
}
```

`font` is `private var font: UIFont` at line 60. A private property is visible to an extension **in the same file**, which is why this extension goes here rather than in a new one.

- [ ] **Step 4: Build and verify**

Run SYNC, then UNIT TESTS, then APP BUILD.
Expected: both succeed.

On the iPad simulator with **I/O → Input → Send Pointer to Device**: moving the pointer over key-bar keys and session rows lights them; moving it over the terminal grid turns it into a text beam.

- [ ] **Step 5: Commit**

```bash
cd ~/sites/tether-wt/ipad
git add clients/apple/TetherKit/Sources/TetherKit/Views/TerminalKeyStyle.swift \
        clients/apple/TetherKit/Sources/TetherKit/Views/SessionDrawerView.swift \
        clients/apple/TetherKit/Sources/TetherKit/Terminal/TetherSurfaceView.swift
git commit -m "feat(ios): add pointer hover effects and a text beam over the grid"
```

---

## Task 9: Full verification pass

**Files:** none changed unless a failure is found.

- [ ] **Step 1: Run the whole suite from a clean build**

```bash
ssh macbuild 'rm -rf /tmp/tether-ipad-dd'
```

Run SYNC, then UNIT TESTS, then APP BUILD.
Expected: `** TEST SUCCEEDED **` with 80 tests and 0 failures, then `** BUILD SUCCEEDED **`.

- [ ] **Step 2: Check the iPhone did not regress**

Install on the iPhone simulator and confirm: the drawer is still a slide-over with its edge-pan; the key bar still scrolls with the D-pad in its old position; Ctrl still arms and now shows colour only; diffs still open unified; the terminal font is unchanged for an existing install.

- [ ] **Step 3: Record the result**

Add a board note to task #887 stating which tests ran, on which host, and what the iPad and iPhone passes showed. Include anything that only got a compile-level check rather than a runtime one.

- [ ] **Step 4: Open the PR**

```bash
cd ~/sites/tether-wt/ipad
git push -u origin feat/ipad-adaptation
gh pr create --title "iPad adaptation: pinnable sidebar, split key bar, hardware keyboard, drag-drop, pointer" \
  --body "Implements docs/superpowers/specs/2026-08-28-ipad-adaptation-design.md. See the spec for the rationale behind each part. Verified on macbuild: TetherKit suite green, TetherIOS builds, manual passes on both an iPad and an iPhone simulator."
```

---

## Out of scope

Deliberately not in this plan, per the spec:

- **The iPad 6 / iOS 17 system dismiss key.** Tracked separately on board task #887. It needs a systematic-debugging pass — reproduce, then instrument `textViewDidEndEditing`, `keyboardWillHideNotification`, and `isFirstResponder` at the top of `updateUIView` — before any code changes. Do not attempt a fix from inside this plan.
- Trackpad drag-selection semantics inside the terminal grid.
- Stage Manager, external display, and multi-window.
