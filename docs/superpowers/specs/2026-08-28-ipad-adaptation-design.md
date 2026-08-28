# iPad adaptation — design

Date: 2026-08-28
Branch: `feat/ipad-adaptation`
Board: task #887

## Problem

`Tether.xcodeproj` has shipped `TARGETED_DEVICE_FAMILY = "1,2"` since the start,
and `Info.plist` allows all four orientations on iPad. The app installs and runs
there. Nothing in the code branches on width.

The result is a phone app stretched to 1024pt or more:

- The session drawer is a 264pt slide-over with a dimming scrim and a
  screen-edge pan gesture, on a screen with room to show it permanently.
- The key bar is one left-packed horizontal scroller, so the D-pad — the control
  a right thumb reaches for — sits near the left edge with several hundred
  points of empty bar to its right.
- Every secondary surface is a sheet: settings, git, pairing, password, file
  viewer.
- The terminal renders at the phone's font metrics.
- A paired Smart Keyboard gets no shortcuts, and the on-screen key bar keeps
  occupying 52pt duplicating keys the hardware already has.

## Thesis

The iPad version is the phone app with a sidebar that can stay open. It is not a
desktop workstation and not a multi-terminal canvas. Sheets stay sheets. The
scope is deliberately the layout, the input surfaces, and the metrics — not the
information architecture.

## 1. Layout core

One pure type, so the rule is unit-testable without a simulator:

```swift
public enum SidebarMode: Sendable { case pinned, overlay }

public enum TetherLayout {
  /// `.pinned` only when the user asked for it AND the window is wide enough to
  /// give up 264pt without squeezing the terminal.
  public static func sidebarMode(regularWidth: Bool, pinned: Bool) -> SidebarMode
}
```

`AppPreferences` gains `sidebarPinned: Bool`, stored in `UserDefaults` alongside
`terminalFont` and `terminalFontSize`, following the same
computed-property-with-`didSet` shape already in that file. First-launch default
is `true` on the iPad idiom and `false` on iPhone.

`RootView` reads `@Environment(\.horizontalSizeClass)` and derives the mode.
Narrowing the window — portrait Split View, Slide Over, an iPhone — resolves to
`.overlay` **without writing the preference**. Widening restores the pin. The
preference records intent; the size class decides whether intent is affordable.

## 2. RootView splits

The single `ZStack` gains an `HStack` for the pinned case:

```
HStack(spacing: 0) {
  if mode == .pinned {
    SessionDrawerView(pinned: true, …).frame(width: 264)
    Divider()
  }
  VStack(spacing: 0) {
    TerminalTitleBar
    PresentationBannerSlot
    TerminalView
  }
}
```

`SessionDrawerOverlay` is mounted **only** in `.overlay` mode. A pinned iPad has
no scrim to tap and no screen-edge pan recogniser sitting over the terminal.

Three knock-on changes:

- `SessionDrawerView` takes a `pinned: Bool`. When pinned, selecting a session
  does not call `dismiss()` — the panel is furniture, not a menu — and the ✕
  in its header becomes a pin toggle (`sidebar.left`).
- `TerminalTitleBar`'s ☰ becomes that same toggle when pinned, rather than a
  button that opens something already open.
- `TerminalView(overlayPresented:)` drops `drawerOpen` from its condition in
  pinned mode. That flag exists to pull the `inputAccessoryView` key bar down
  when something covers the terminal; a pinned sidebar covers nothing.

The drawer's `.dynamicTypeSize(...DynamicTypeSize.large)` cap stays. It is there
because 264pt truncates session names at large text sizes, and pinned is still
264pt.

## 3. Key bar: keys left, D-pad right

`TerminalAccessoryBar` already measures itself through `report(_ proxy:)`. Add a
pure helper:

```swift
enum AccessoryLayout {
  static func fitsWithoutScrolling(
    width: CGFloat, keyCount: Int, keySize: CGFloat, spacing: CGFloat
  ) -> Bool
}
```

When the row fits, drop the `ScrollView` and lay out
`HStack { leftCluster; Spacer(); DpadView }` — modifiers, navigation keys, Paste
and Hide pack against the leading edge; the D-pad pins to the trailing edge
under the right thumb. When it does not fit — every iPhone — the current
horizontal scroller is unchanged.

## 4. Hardware keyboard

### Shortcuts

Zero-opacity `Button`s carrying `.keyboardShortcut`, hosted in a `.background {}`
on `RootView`:

| Shortcut | Action |
|---|---|
| ⌘B | pin / unpin the sidebar |
| ⌘T | new terminal on the active host |
| ⌘1…9 | jump to the nth session in drawer order |
| ⌘⇧[ / ⌘⇧] | previous / next session |
| ⌘, | settings |

Index → `(hostId, sessionId)` resolution is a pure function in TetherKit,
flattening `store.hosts` and `store.sessionsByHost` in the same order the drawer
renders them, and returning `nil` past the end. Tested directly.

The conflict risk is resolved by reading `TerminalKeyMap.bytes(for:)`: after the
named-key switch it runs `guard ctrl || alt else { return nil }`, so a
⌘-modified letter or digit is never claimed, `pressesBegan` forwards it to
`super`, and it travels the responder chain to SwiftUI. None of the shortcuts
above collide with a key the switch claims. No exclusion is needed.

### Adaptive bar

Detect a physical keyboard with `GCKeyboard.coalescedKeyboard != nil` plus the
`GCKeyboardDidConnect` / `GCKeyboardDidDisconnect` notifications, and set
`showsAccessory = false` while one is attached. Esc, Tab and the arrows are on
the hardware; the on-screen row duplicates them and costs 52pt of terminal.

`TerminalInputBridge.updateUIView` already calls `reloadInputViews()` when
`showsAccessory` changes, so the bar leaves and returns correctly on connect and
disconnect.

## 5. Wide-aware views and metrics

- `GitReviewView.sideBySide` initialises from `horizontalSizeClass == .regular`
  instead of a hardcoded `false`. The Unified / Side by side toggle stays.
- `ConfigSettingsView` content gets a `maxWidth` so form rows do not run the
  full width of a 13" screen.
- First-launch default `terminalFontSize` becomes 14 on the iPad idiom. The
  iPhone default stays at its current 11. **Only the default.** An existing
  stored value is never overwritten — a user who set 12 keeps 12.

## 6. Drag & drop, pointer

- `.dropDestination(for: URL.self)` on the terminal area, handing the file to
  `workspace.upload(store:data:filename:mimeType:)`. That path already exists
  and already carries the progress cover and the failure alert in
  `WorkspaceChromeView`. Gated on an active session; a drop with no session open
  is ignored rather than erroring.
- `.hoverEffect(.highlight)` on session rows, title-bar buttons, and key-bar
  keys. A `UIPointerInteraction` over the grid for an I-beam cursor.
- Out of scope: trackpad drag-selection semantics inside the grid. That is
  `TetherSurfaceView` plus `TerminalSelection` and needs its own pass.

## 7. Ctrl key loses its checkmark

`ctrlButton` renders `Text(model.ctrlArmed ? "Ctrl ✓" : "Ctrl")`. The armed state
is already carried by `TerminalKeyStyle(armed:)` — the key takes the accent fill
and the `onAccent` foreground — so the glyph says a second time what the colour
already says, and it widens the key when armed, shifting every key to its right.
The label becomes a constant `"Ctrl"`. The `accessibilityValue` of
`"Armed"` / `"Off"` stays: colour is not available to VoiceOver.

This applies on iPhone too.

## Separate track: iPad 6 / iOS 17 system dismiss key

On an iPad (6th generation) running iOS 17, the software keyboard's built-in
dismiss key (bottom-right) does not put the keyboard away.

This gets its own systematic-debugging pass and **no speculative fix in this
spec**. Reproduce on that simulator, then instrument each boundary —
`textViewDidEndEditing`, `keyboardWillHideNotification`, and
`uiView.isFirstResponder` at the top of `updateUIView` — and find where focus
actually returns before changing anything.

A lead, not a diagnosis: `TerminalInputBridge.updateUIView` re-focuses whenever
SwiftUI believes focus is on and UIKit's responder is off.

```swift
if isFocused.wrappedValue, !uiView.isFirstResponder {
  uiView.becomeFirstResponder()
}
```

`textViewDidEndEditing` exists to keep the two in sync, but it returns early when
`isFocused.wrappedValue` is already false, and it defers its write by one runloop
turn. If the iPad dismiss key drops the responder without firing that delegate
callback, the next SwiftUI update pulls the keyboard straight back up.

## Testing

New `TetherKitTests` cases for every pure rule introduced here:

- `TetherLayout.sidebarMode` across the four combinations of width and pin
- `AccessoryLayout.fitsWithoutScrolling` at the boundary width
- shortcut index → session resolution, including past the end and across hosts
- accessory visibility with and without a hardware keyboard
- the side-by-side default per size class
- the per-idiom default font size, and that a stored value wins over it

View behaviour is verified by building and running the iPad simulator on
`macbuild`. No snapshot-testing infrastructure exists in this repo and this work
does not add one.

## Delivery

Five independently mergeable slices:

1. Layout core plus the pinned sidebar
2. Key bar split, hardware-keyboard shortcuts, adaptive bar
3. Wide-aware views and metrics
4. Drag & drop and pointer
5. The Ctrl checkmark removal (trivial; can ride with any slice)

The iPad-6 dismiss-key investigation is independent of all five and can go
first if it is the more annoying problem day to day.
