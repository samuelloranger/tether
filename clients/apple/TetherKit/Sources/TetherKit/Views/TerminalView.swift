#if canImport(UIKit)
import SwiftUI
import UIKit

/// Mutable state of the key bar. An @Observable class, not a Binding: the bar is
/// hosted in a UIHostingController accessory, and reassigning rootView to refresh it spun the main thread.
@Observable
public final class TerminalAccessoryModel {
  public var ctrlArmed = false
  /// Drives the bar's own slide-out — UIKit's dismissal only travels the bar's
  /// height (a short hop); this carries it fully off the bottom first.
  public var visible = true
  /// Window-bottom to the TOP of the docked bar, measured. UIKit docks ~15pt above
  /// the edge, not above the 34pt indicator, so a fixed constant left dead space.
  public var dockedHeight: CGFloat = 0
  public init() {}
}

public struct TerminalAccessoryBar: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  public var model: TerminalAccessoryModel
  public var onKey: (String) -> Void
  public var onPaste: (String) -> Void
  public var onArrow: (DPadDirection) -> Void
  public var onHideKeyboard: () -> Void

  public init(
    model: TerminalAccessoryModel,
    onKey: @escaping (String) -> Void,
    onPaste: @escaping (String) -> Void,
    onArrow: @escaping (DPadDirection) -> Void,
    onHideKeyboard: @escaping () -> Void
  ) {
    self.model = model
    self.onKey = onKey
    self.onPaste = onPaste
    self.onArrow = onArrow
    self.onHideKeyboard = onHideKeyboard
  }

  /// Every key in the bar is this tall, the D-pad included — a control that is
  /// taller than its neighbours reads as a different kind of thing.
  static let keySize: CGFloat = 40
  static let barVerticalPadding: CGFloat = 8
  /// How far above the bottom edge UIKit docks the bar. Not the 34pt indicator
  /// inset — UIKit uses a smaller gap, and the terminal reserves the difference.
  static let dockedGap: CGFloat = 15
  /// First-frame fallback before GeometryReader reports the real docked height.
  /// Derived from key + padding so it cannot drift from the row's layout again.
  public static let barHeight: CGFloat = keySize + barVerticalPadding * 2

  /// No arrow keys: the D-pad is one square key covering all four directions.
  public var body: some View {
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
    // Confine the material to its bounds: the default .all bled into the indicator
    // strip and the bar read half again as tall.
    .background(.ultraThinMaterial, ignoresSafeAreaEdges: [])
    // The bar lives in the keyboard window, so `.global` is that window's space
    // (screen geometry). Reporting its top edge lets the terminal reserve the real height.
    .background(
      GeometryReader { proxy in
        Color.clear
          .onAppear { report(proxy) }
          .onChange(of: proxy.frame(in: .global)) { _, _ in report(proxy) }
      }
    )
    // Slide the whole row clear of the bottom edge, not just UIKit's own-height
    // nudge. Reduce Motion keeps the fade and drops the travel.
    .offset(y: model.visible || reduceMotion ? 0 : Self.keySize * 2.4)
    .opacity(model.visible ? 1 : 0)
    .animation(
      TetherMotion.ui(TetherMotion.overlay, reduceMotion: reduceMotion),
      value: model.visible
    )
  }


  /// Publishes the bar's docked height, skipping slide-out frames — mid-animation
  /// its top edge is off-screen and would report the bar as taller than it is.
  private func report(_ proxy: GeometryProxy) {
    guard model.visible else { return }
    let frame = proxy.frame(in: .global)
    guard let screen = UIApplication.shared.connectedScenes
      .compactMap({ ($0 as? UIWindowScene)?.screen })
      .first
    else { return }
    // A tearing-down keyboard window hands out frames starting above the screen
    // (minY < 0), reading as taller than the display — reject those dismissal artefacts.
    guard frame.minY >= 0 else { return }
    let height = max(0, screen.bounds.maxY - frame.minY)
    guard height <= screen.bounds.height else { return }
    guard abs(height - model.dockedHeight) > 0.5 else { return }
    // Deferred one runloop turn: the terminal's padding reads this and changes the
    // layout this GeometryReader measures, so an inline write is a dependency cycle.
    DispatchQueue.main.async { model.dockedHeight = height }
  }

  /// Matches the D-pad's feedback: the clipboard's contents are invisible until
  /// the shell echoes them, so the tap needs its own confirmation.
  private static let pasteFeedback = UIImpactFeedbackGenerator(style: .light)

  /// The system paste control. Reading `UIPasteboard.general` directly is denied
  /// silently; `PasteButton` is granted access without a prompt.
  private var pasteButton: some View {
    PasteButton(payloadType: String.self) { strings in
      guard let text = strings.first else { return }
      Self.pasteFeedback.impactOccurred()
      onPaste(text)
    }
    .labelStyle(.iconOnly)
    .buttonBorderShape(.roundedRectangle(radius: 8))
    .tint(TetherColors.surface)
    .frame(minWidth: Self.keySize, minHeight: Self.keySize)
  }

  /// Arming Ctrl changes what the next key does with nothing else moving on screen,
  /// so it gets its own haptic confirmation.
  private static let armFeedback = UISelectionFeedbackGenerator()

  private var ctrlButton: some View {
    Button {
      Self.armFeedback.selectionChanged()
      model.ctrlArmed.toggle()
    } label: {
      Text(model.ctrlArmed ? "Ctrl ✓" : "Ctrl")
        .contentTransition(.opacity)
    }
    .buttonStyle(TerminalKeyStyle(armed: model.ctrlArmed))
    .accessibilityLabel("Control modifier")
    .accessibilityValue(model.ctrlArmed ? "Armed" : "Off")
  }

  private func accessoryButton(_ title: String, systemImage: String? = nil, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Group {
        if let systemImage {
          Label(title, systemImage: systemImage)
            .labelStyle(.iconOnly)
            .accessibilityLabel(title)
        } else {
          Text(title)
        }
      }
    }
    .buttonStyle(TerminalKeyStyle())
  }

  private func send(base: String) {
    guard model.ctrlArmed else {
      onKey(base)
      return
    }
    model.ctrlArmed = false
    onKey(TerminalKeyMap.ctrlModified(base))
  }
}

/// Bridges the system keyboard to PTY input with an accessory toolbar.
public struct TerminalInputBridge: UIViewRepresentable {
  @Binding public var text: String
  public var accessory: AnyView
  /// Gate the ACCESSORY, never the bridge's existence: a `.focused()` view that
  /// appears and disappears makes SwiftUI and UIKit focus machinery loop at 100% CPU.
  public var showsAccessory: Bool = true
  public var onSubmitBytes: (String) -> Void
  public var isFocused: Binding<Bool>

  public init(
    text: Binding<String>,
    accessory: AnyView,
    showsAccessory: Bool = true,
    onSubmitBytes: @escaping (String) -> Void,
    isFocused: Binding<Bool>
  ) {
    _text = text
    self.accessory = accessory
    self.showsAccessory = showsAccessory
    self.onSubmitBytes = onSubmitBytes
    self.isFocused = isFocused
  }

  public func makeCoordinator() -> Coordinator {
    Coordinator(onSubmitBytes: onSubmitBytes, isFocused: isFocused)
  }

  /// Connects a view's byte hooks to the PTY. Shared with tests on purpose: inline in
  /// `makeUIView`, a test could wire it differently from the app and silently pass.
  static func wire(_ view: TerminalInputTextView, onSubmitBytes: @escaping (String) -> Void) {
    // 0x7F (DEL) is what terminals and readline expect from backspace.
    view.onBackspace = { onSubmitBytes("\u{7F}") }
    view.onKeyBytes = { bytes in onSubmitBytes(bytes) }
  }

  public func makeUIView(context: Context) -> TerminalInputTextView {
    let view = TerminalInputTextView()
    view.delegate = context.coordinator
    view.autocorrectionType = .no
    view.autocapitalizationType = .none
    view.spellCheckingType = .no
    view.keyboardType = .asciiCapable
    view.backgroundColor = .clear
    view.textColor = .clear
    view.tintColor = .clear
    view.accessoryHosting.rootView = accessory
    view.showsAccessory = showsAccessory
    Self.wire(view, onSubmitBytes: onSubmitBytes)
    view.refillFiller()
    return view
  }

  public func updateUIView(_ uiView: TerminalInputTextView, context: Context) {
    // rootView is set once in makeUIView. Reassigning it here is what made
    // reloadInputViews() rebuild SwiftUI inside a SwiftUI update.
    if uiView.showsAccessory != showsAccessory {
      uiView.showsAccessory = showsAccessory
      uiView.reloadInputViews()
    }
    // The document is invisible filler that keeps the delete key repeating (see
    // `refillFiller`); syncing the binding here would wipe it on every update.
    uiView.refillFiller()
    if isFocused.wrappedValue, !uiView.isFirstResponder {
      uiView.becomeFirstResponder()
    } else if !isFocused.wrappedValue, uiView.isFirstResponder {
      uiView.resignFirstResponder()
    }
  }

  public final class Coordinator: NSObject, UITextViewDelegate {
    let onSubmitBytes: (String) -> Void
    let isFocused: Binding<Bool>

    init(onSubmitBytes: @escaping (String) -> Void, isFocused: Binding<Bool>) {
      self.onSubmitBytes = onSubmitBytes
      self.isFocused = isFocused
    }

    public func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
      if text == "\n" {
        onSubmitBytes("\r")
        return false
      }
      // An EMPTY replacement is a deletion (UIKit reports backspace here, not via
      // `deleteBackward()`). Allowed through so the document shrinks; the flush coalesces DELs.
      if text.isEmpty {
        (textView as? TerminalInputTextView)?.requestDeletionFlush()
        return true
      }
      onSubmitBytes(text)
      return false
    }

    public func textViewDidEndEditing(_ textView: UITextView) {
      // This can arrive synchronously from `resignFirstResponder()` mid-update;
      // defer the UIKit-initiated focus loss so it doesn't re-enter SwiftUI.
      guard isFocused.wrappedValue else { return }
      DispatchQueue.main.async { [weak textView, isFocused] in
        guard
          let textView,
          !textView.isFirstResponder,
          isFocused.wrappedValue
        else { return }
        isFocused.wrappedValue = false
      }
    }
  }
}

/// Translates hardware key presses into PTY bytes. Text-less keys (arrows, Ctrl combos,
/// Esc, empty-buffer backspace) never reach `UITextViewDelegate`, so `pressesBegan` handles them here.
enum TerminalKeyMap {
  static func bytes(for key: UIKey) -> String? {
    let mods = key.modifierFlags
    let ctrl = mods.contains(.control)
    let alt = mods.contains(.alternate)
    let mod = modifierParam(mods)

    if let special = specialKeyBytes(keyCode: key.keyCode, mod: mod) { return special }

    // Plain text is the delegate's job; only modified keys are claimed here,
    // otherwise every character would be sent twice.
    guard ctrl || alt else { return nil }
    guard let ch = key.charactersIgnoringModifiers.first, let ascii = ch.asciiValue else {
      return nil
    }
    if ctrl {
      // Ctrl-@ through Ctrl-_ map onto 0x00-0x1F; lowercase folds to uppercase first.
      let upper = (ascii >= 97 && ascii <= 122) ? ascii - 32 : ascii
      let control = String(UnicodeScalar(upper & 0x1F))
      return alt ? "\u{1B}" + control : control
    }
    return "\u{1B}" + String(ch)
  }

  /// Applies the Ctrl latch to an accessory-bar key. A CSI sequence carries its modifier
  /// as a parameter — masking the final byte instead made Ctrl+Left 0x04 (EOF) and killed the shell.
  static func ctrlModified(_ sequence: String) -> String {
    guard sequence.hasPrefix("\u{1B}["), let final = sequence.last else { return sequence }
    return "\u{1B}[1;5\(final)"
  }

  /// Folds a latched Ctrl into the next typed character. Only printable ASCII has
  /// a control form — masking Return or DEL would corrupt them.
  static func ctrlFolded(_ text: String) -> String? {
    guard text.count == 1, let ch = text.first, let ascii = ch.asciiValue,
          (0x20...0x7E).contains(ascii)
    else { return nil }
    let upper = (ascii >= 97 && ascii <= 122) ? ascii - 32 : ascii
    return String(UnicodeScalar(upper & 0x1F))
  }

  /// Keys whose bytes depend only on the key and its modifier parameter. Split out
  /// so it is reachable from a test: `UIKey` cannot be constructed.
  static func specialKeyBytes(keyCode: UIKeyboardHIDUsage, mod: Int) -> String? {
    switch keyCode {
    case .keyboardUpArrow: return csi("A", mod)
    case .keyboardDownArrow: return csi("B", mod)
    case .keyboardRightArrow: return csi("C", mod)
    case .keyboardLeftArrow: return csi("D", mod)
    case .keyboardHome: return csi("H", mod)
    case .keyboardEnd: return csi("F", mod)
    case .keyboardPageUp: return "\u{1B}[5~"
    case .keyboardPageDown: return "\u{1B}[6~"
    case .keyboardDeleteForward: return "\u{1B}[3~"
    // Backspace deliberately absent: left to UIKit it reaches `deleteBackward()`,
    // the one deletion signal the view trusts. Claimed here it double-emitted.
    case .keyboardEscape: return "\u{1B}"
    default: return nil
    }
  }

  private static func modifierParam(_ m: UIKeyModifierFlags) -> Int {
    var value = 1
    if m.contains(.shift) { value += 1 }
    if m.contains(.alternate) { value += 2 }
    if m.contains(.control) { value += 4 }
    return value
  }

  private static func csi(_ final: String, _ mod: Int) -> String {
    mod == 1 ? "\u{1B}[" + final : "\u{1B}[1;\(mod)" + final
  }
}

public final class TerminalInputTextView: UITextView {
  let accessoryHosting = UIHostingController<AnyView>(rootView: AnyView(EmptyView()))

  /// Receives the bytes for any hardware key the terminal claims.
  var onKeyBytes: ((String) -> Void)?

  /// Emits one DEL. Called only from the coalesced deletion flush.
  var onBackspace: (() -> Void)?

  /// UIKit routes the software delete key to `deleteBackward()` only while the view
  /// `hasText`; this view's text is always empty, so claim text unconditionally.
  public override var hasText: Bool { true }

  /// Invisible filler so the delete key always has something to consume: holding it
  /// auto-repeats only while each press shortens the document.
  private static let filler = "\u{00A0}"
  private static let fillerCount = 64

  /// Tops the document back up, prepending so the caret stays at the end — a
  /// selection change mid-repeat cancels the repeat.
  func refillFiller() {
    let missing = Self.fillerCount - (text as NSString).length
    if missing > 0 {
      text = String(repeating: Self.filler, count: missing) + text
      selectedRange = NSRange(location: (text as NSString).length, length: 0)
    }
    documentLength = (text as NSString).length
  }

  public override func deleteBackward() {
    super.deleteBackward()
    // The edit has happened; the flush measures it — see `requestDeletionFlush`.
    requestDeletionFlush()
  }

  /// Length of the hidden document as of the last refill — the baseline a
  /// deletion is measured against.
  private var documentLength = 0
  private var deletionFlushScheduled = false

  /// Schedules a measurement instead of emitting: UIKit reports one delete through
  /// several unguaranteed paths, so the flush sends one DEL per character actually lost.
  func requestDeletionFlush() {
    guard !deletionFlushScheduled else { return }
    deletionFlushScheduled = true
    DispatchQueue.main.async { [weak self] in
      self?.flushDeletion()
    }
  }

  /// Exposed for tests, which drive the flush rather than waiting on a runloop.
  func flushDeletion() {
    deletionFlushScheduled = false
    let current = (text as NSString).length
    let removed = max(0, documentLength - current)
    guard removed > 0 else {
      // Changed nothing — a duplicate for an already-measured press, or a declined
      // edit — so nothing goes on the wire.
      documentLength = current
      return
    }
    for _ in 0..<removed { onBackspace?() }
    refillFiller()
  }

  public override func becomeFirstResponder() -> Bool {
    refillFiller()
    return super.becomeFirstResponder()
  }

  public override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
    var unhandled: Set<UIPress> = []
    for press in presses {
      if let key = press.key, let bytes = TerminalKeyMap.bytes(for: key) {
        onKeyBytes?(bytes)
      } else {
        unhandled.insert(press)
      }
    }
    if !unhandled.isEmpty {
      super.pressesBegan(unhandled, with: event)
    }
  }

  /// Configured once, not on every getter call — UIKit asks for the accessory often.
  private lazy var accessoryContainer: UIView = {
    let view = accessoryHosting.view!
    // Ask the bar its height rather than asserting 52pt: a fixed assertion clipped
    // 4pt off the row and reserved the wrong amount of terminal.
    let width = view.window?.bounds.width
      ?? (UIApplication.shared.connectedScenes.first as? UIWindowScene)?.screen.bounds.width
      ?? 390
    let fitted = accessoryHosting.sizeThatFits(
      in: CGSize(width: width, height: .greatestFiniteMagnitude))
    view.frame.size.height = fitted.height > 0 ? fitted.height : TerminalAccessoryBar.barHeight
    view.backgroundColor = .clear
    return view
  }()


  private var assignedAccessoryView: UIView?

  /// Set false when there is no session, so the key bar does not sit on screen
  /// with nothing to act on.
  var showsAccessory = true

  public override var inputAccessoryView: UIView? {
    get {
      guard showsAccessory else { return assignedAccessoryView }
      return assignedAccessoryView ?? accessoryContainer
    }
    set { assignedAccessoryView = newValue }
  }

  public override var canBecomeFirstResponder: Bool { true }

  /// Empty both input-assistant groups: with a hardware keyboard UIKit renders a
  /// shortcuts bar this view has nothing to offer, leaving an empty strip.
  public override init(frame: CGRect, textContainer: NSTextContainer?) {
    super.init(frame: frame, textContainer: textContainer)
    inputAssistantItem.leadingBarButtonGroups = []
    inputAssistantItem.trailingBarButtonGroups = []
  }

  public required init?(coder: NSCoder) {
    super.init(coder: coder)
    inputAssistantItem.leadingBarButtonGroups = []
    inputAssistantItem.trailingBarButtonGroups = []
  }
}

/// What the terminal area shows when there is nothing to stream: each case names
/// what is absent and offers the one action that resolves it.
struct TerminalPlaceholder: View {
  enum Reason {
    case noHost
    case noSession
  }

  let reason: Reason
  let onAddHost: () -> Void
  let onNewTerminal: () -> Void

  var body: some View {
    VStack(spacing: 14) {
      Image(systemName: reason == .noHost ? "server.rack" : "terminal")
        .font(.system(size: 34, weight: .light))
        .foregroundStyle(TetherColors.textSecondary)
      VStack(spacing: 5) {
        Text(reason == .noHost ? "No server yet" : "No session open")
          .font(.headline)
          .foregroundStyle(TetherColors.textPrimary)
        Text(
          reason == .noHost
            ? "Add the machine you want a shell on. Tether pairs with it once and remembers."
            : "Start a terminal to pick up where the shell left off."
        )
        .font(.footnote)
        .foregroundStyle(TetherColors.textSecondary)
        .multilineTextAlignment(.center)
        .frame(maxWidth: 280)
      }
      Button(reason == .noHost ? "Add a server" : "New terminal") {
        reason == .noHost ? onAddHost() : onNewTerminal()
      }
      .font(.subheadline.weight(.semibold))
      .padding(.horizontal, 18)
      .padding(.vertical, 10)
      .background(TetherColors.accent)
      .foregroundStyle(TetherColors.onAccent)
      .clipShape(Capsule())
      .padding(.top, 2)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(TetherColors.terminalBackground)
  }
}

public struct TerminalView: View {
  @Bindable public var store: SessionStore
  @Bindable public var preferences: AppPreferences
  /// Routed from RootView so the empty state can open pairing.
  public var onAddHost: () -> Void = {}
  /// True while an in-app overlay (the drawer) covers the terminal. The key bar is
  /// an inputAccessoryView in the keyboard window, above it, so it must be hidden.
  public var overlayPresented: Bool = false
  /// Opens a workspace file path detected in the terminal grid.
  public var onOpenFile: (String, Int?, Int?) -> Void = { _, _, _ in }
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var accessory = TerminalAccessoryModel()
  @State private var inputBuffer = ""
  @State private var scrollOffsetFromBottom = 0
  /// Held while the scrollback thumb is under a finger — see ScrollPositionIndicator.
  @State private var isScrubbingScroll = false
  @State private var selectionText: String?
  /// Keyboard+accessory overlap, measured: SwiftUI's automatic avoidance doesn't
  /// engage for a UIKit UITextView, and shrinking fires reportGridSize for the PTY.
  @State private var keyboardInset: CGFloat = 0
  // UIKit is the single owner of first-responder changes via TerminalInputBridge;
  // adding SwiftUI's `.focused` made two controllers fight over the text view.
  @State private var keyboardFocused = false

  public init(
    store: SessionStore,
    preferences: AppPreferences,
    onAddHost: @escaping () -> Void = {},
    overlayPresented: Bool = false,
    onOpenFile: @escaping (String, Int?, Int?) -> Void = { _, _, _ in }
  ) {
    self.store = store
    self.preferences = preferences
    self.onAddHost = onAddHost
    self.overlayPresented = overlayPresented
    self.onOpenFile = onOpenFile
  }

  public var body: some View {
    VStack(spacing: 0) {
      ZStack(alignment: .topTrailing) {
        if let placeholder = placeholderReason {
          TerminalPlaceholder(
            reason: placeholder,
            onAddHost: onAddHost,
            onNewTerminal: { Task { await store.newTerminal() } }
          )
          // Crossfade with the grid rather than cut: the first session of the
          // day replaces this view, and a hard swap there reads as a reload.
          .transition(.opacity)
        } else {
        TetherSurfaceRepresentable(
          snapshot: $store.terminalSnapshot,
          fontName: preferences.terminalFont.postScriptName,
          fontSize: preferences.terminalFontSize,
          onGridSizeChange: { cols, rows in store.updateGrid(cols: cols, rows: rows) },
          onScrollLines: { lines in
            store.scrollViewport(lines: lines)
            scrollOffsetFromBottom = max(0, scrollOffsetFromBottom + Int(lines))
          },
          onTap: { keyboardFocused = true },
          onSelectionText: { text in selectionText = text },
          onOpenURL: { url in UIApplication.shared.open(url) },
          onOpenFile: onOpenFile,
          onMouseBytes: { store.sendInput($0) },
          mouseMode: store.terminalMouseMode,
          mouseSgr: store.terminalMouseSgr
        )
        // No inset: the old gutter cost two columns and, a different colour from
        // the grid, was itself half the frame the terminal appeared to sit inside.
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        // Must match TetherSurfaceView's backgroundColor: any area the grid doesn't
        // cover shows this through, and Color.black read as a dead strip.
        .background(TetherColors.terminalBackground)

        }

        // Stays mounted while scrubbing: a drag that reaches the live bottom
        // would otherwise unmount the thumb under the finger and cancel itself.
        if scrollOffsetFromBottom > 0 || isScrubbingScroll {
          ScrollPositionIndicator(
            offset: scrollOffsetFromBottom,
            isScrubbing: $isScrubbingScroll,
            onScrub: { target in
              let delta = target - scrollOffsetFromBottom
              guard delta != 0 else { return }
              // Positive lines move into history, which is also the direction
              // the offset counts in.
              store.scrollViewport(lines: Int32(delta))
              scrollOffsetFromBottom = target
            }
          )
          .padding(.trailing, 4)
          .padding(.top, 8)
          // Fades in when you leave the live tail and out when you catch up; a hard
          // appear/vanish mid-scroll read as a rendering artefact.
          .transition(.opacity)
        }

        if let selectionText, !selectionText.isEmpty {
          selectionChrome(text: selectionText)
        }

      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      // Scoped to these three values so nothing here can animate the grid: the
      // terminal surface must never be walked through intermediate sizes.
      .animation(
        TetherMotion.ui(TetherMotion.state, reduceMotion: reduceMotion),
        value: scrollOffsetFromBottom > 0
      )
      .animation(
        TetherMotion.ui(TetherMotion.state, reduceMotion: reduceMotion),
        value: selectionText == nil
      )
      .animation(
        TetherMotion.ui(TetherMotion.overlay, reduceMotion: reduceMotion),
        value: placeholderReason
      )

      TerminalInputBridge(
        text: $inputBuffer,
        accessory: AnyView(
          TerminalAccessoryBar(
            model: accessory,
            onKey: { store.sendInput($0) },
            onPaste: { store.sendPaste($0) },
            onArrow: { store.sendInput($0.escapeSequence) },
            // Deferred one runloop turn: this button lives in the accessory bar's own
            // hosting view; dropping focus synchronously deallocs it mid-touch and crashes.
            onHideKeyboard: { DispatchQueue.main.async { keyboardFocused = false } }
          )
        ),
        showsAccessory: accessoryVisible,
        onSubmitBytes: submit,
        isFocused: Binding(
          get: { keyboardFocused },
          set: { keyboardFocused = $0 }
        )
      )
      .frame(height: 1)
    }
    // Terminal colour, not chrome: .background() bleeds into the safe area, and this
    // band shows on the startup screen and with the sidebar open, where the bar can't cover it.
    .background(TetherColors.terminalBackground)
    // Reserve whichever is taller: keyboardWillHide zeroes the inset while the docked
    // bar is still on screen. `accessoryReserve` subtracts the container's own inset.
    .padding(.bottom, max(keyboardInset, accessoryVisible ? accessoryReserve : 0))
    // Go straight to the END frame keyboardWillChangeFrame carries: animating this
    // padding walks the view through intermediate grid sizes the surface would report.
    .animation(nil, value: keyboardInset)
    .onReceive(
      NotificationCenter.default.publisher(for: UIResponder.keyboardWillChangeFrameNotification)
    ) { note in
      keyboardInset = Self.keyboardOverlap(note)
    }
    .onReceive(
      NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)
    ) { _ in
      keyboardInset = 0
    }
    // Animate the bar out BEFORE UIKit removes it, so it leaves downward not blinking.
    // Only the model is written here, so this cannot re-enter the update.
    .onChange(of: accessoryVisible, initial: true) { _, shown in
      accessory.visible = shown
    }
    .onAppear {
      // Only claim the keyboard when there is a session to type into. Focusing
      // with nothing open put the key bar on screen with nothing to act on.
      keyboardFocused = placeholderReason == nil
    }
    .onChange(of: store.activeSessionId) { _, _ in
      scrollOffsetFromBottom = 0
      selectionText = nil
    }
    // An overlay hides the accessory bar but doesn't resign first responder, so the
    // raw keyboard stayed up behind it. Drop focus on appear, reclaim it on dismiss.
    .onChange(of: overlayPresented) { _, presented in
      if presented {
        keyboardFocused = false
      } else if placeholderReason == nil {
        keyboardFocused = true
      }
    }
  }

  @ViewBuilder
  private func selectionChrome(text: String) -> some View {
    VStack {
      Spacer()
      HStack {
        Spacer()
        Button {
          Self.copyFeedback.impactOccurred()
          UIPasteboard.general.string = text
          selectionText = nil
        } label: {
          Label("Copy", systemImage: "doc.on.doc")
            .font(.callout.weight(.semibold))
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(TetherColors.accent)
            .foregroundStyle(TetherColors.onAccent)
            .clipShape(RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
        .padding(12)
      }
    }
    // Rises from the corner it sits in, and leaves the same way. Reduce Motion
    // keeps the fade only.
    .transition(
      reduceMotion
        ? .opacity
        : .opacity.combined(with: .move(edge: .bottom))
    )
  }

  /// Copying is a silent success — the selection disappears and nothing else
  /// changes — so it gets the same light tap the D-pad and paste key give.
  private static let copyFeedback = UIImpactFeedbackGenerator(style: .light)

  /// Height of the window the keyboard's end frame covers. Uses the window
  /// rather than UIScreen so it stays correct in a resized or split window.
  private static func keyboardOverlap(_ note: Notification) -> CGFloat {
    guard
      let end = note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect,
      let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
      let window = scene.windows.first(where: { $0.isKeyWindow }) ?? scene.windows.first
    else { return 0 }
    // Subtract the bottom inset the layout already reserves; otherwise the two stack
    // and leave a home-indicator-sized dead band above the key bar.
    return max(0, window.bounds.maxY - end.minY - window.safeAreaInsets.bottom)
  }

  private var accessoryVisible: Bool { placeholderReason == nil && !overlayPresented }

  /// Padding that puts the last terminal row on the bar's top edge; falls back to
  /// the constant only for the first frame, before the bar has measured itself.
  private var accessoryReserve: CGFloat {
    let inset = Self.bottomSafeInset()
    // Clamp to [floor, ceiling]: the keyboard window reports garbage while tearing
    // down, and one believed outlier (949pt on a 932pt screen) once padded the VStack off-screen.
    let floor = TerminalAccessoryBar.barHeight + TerminalAccessoryBar.dockedGap
    let ceiling = keyboardInset + floor
    let measured = accessory.dockedHeight
    guard measured > 0 else { return max(0, floor - inset) }
    return max(0, max(floor, min(measured, ceiling)) - inset)
  }

  private static func bottomSafeInset() -> CGFloat {
    guard
      let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
      let window = scene.windows.first(where: { $0.isKeyWindow }) ?? scene.windows.first
    else { return 0 }
    return window.safeAreaInsets.bottom
  }

  /// Nothing to stream: either no server is paired, or none is open.
  private var placeholderReason: TerminalPlaceholder.Reason? {
    if store.hosts.isEmpty { return .noHost }
    if store.activeSessionId == nil { return .noSession }
    return nil
  }

  /// Sends typed input, folding in a latched Ctrl — previously Ctrl only affected
  /// the five keys routed through `send`, so the keyboard couldn't produce Ctrl+C.
  private func submit(_ text: String) {
    if accessory.ctrlArmed, let folded = TerminalKeyMap.ctrlFolded(text) {
      accessory.ctrlArmed = false
      store.sendInput(folded)
      return
    }
    store.sendInput(text)
  }
}

/// Scrollback position and its drag handle: the 3pt thumb carries a 28pt hit area.
/// Only the thumb takes touches, not the full-height track — that would cost the terminal its pan.
struct ScrollPositionIndicator: View {
  /// Lines from the live bottom that put the thumb at the top of its travel. Capped,
  /// not proportional, because the emulator doesn't report how much scrollback it holds.
  static let maxOffset = 200

  private static let thumbHeight: CGFloat = 36
  private static let inset: CGFloat = 12
  private static let hitWidth: CGFloat = 28

  var offset: Int
  @Binding var isScrubbing: Bool
  var onScrub: (Int) -> Void

  /// Offset the drag started from. The thumb's travel only spans `maxOffset` lines,
  /// so the drag moves RELATIVE to where it began rather than teleporting deeper scrolls.
  @State private var scrubOrigin: Int?

  var body: some View {
    GeometryReader { geo in
      let track = max(geo.size.height - Self.inset * 2, 1)
      let travel = max(track - Self.thumbHeight, 1)
      // More offset → thumb closer to top.
      let progress = min(1, CGFloat(offset) / CGFloat(Self.maxOffset))
      let y = Self.inset + (1 - progress) * travel
      Capsule()
        .fill(TetherColors.textSecondary.opacity(isScrubbing ? 0.9 : 0.55))
        .frame(width: isScrubbing ? 5 : 3, height: Self.thumbHeight)
        .frame(width: Self.hitWidth, alignment: .trailing)
        .contentShape(Rectangle())
        .gesture(
          DragGesture(minimumDistance: 0, coordinateSpace: .named(Self.space))
            .onChanged { value in
              if scrubOrigin == nil { scrubOrigin = offset }
              isScrubbing = true
              onScrub(target(for: value, travel: travel))
            }
            .onEnded { value in
              onScrub(target(for: value, travel: travel))
              scrubOrigin = nil
              isScrubbing = false
            }
        )
        .frame(maxWidth: .infinity, alignment: .trailing)
        .offset(y: y)
    }
    .coordinateSpace(name: Self.space)
    .animation(.easeOut(duration: 0.12), value: isScrubbing)
    .accessibilityLabel("Scrollback position")
    .accessibilityValue("\(offset) lines from the bottom")
  }

  private static let space = "tether.scroll-track"

  /// Maps the drag's travel onto a scrollback offset. Full travel covers `maxOffset`
  /// lines, or the deeper start offset, so a deep drag can reach the bottom in one sweep.
  private func target(for value: DragGesture.Value, travel: CGFloat) -> Int {
    let origin = scrubOrigin ?? offset
    let span = CGFloat(max(Self.maxOffset, origin))
    let movedDown = value.location.y - value.startLocation.y
    // Down the track is toward the live bottom, which is a smaller offset.
    let delta = movedDown / travel * span
    return max(0, Int((CGFloat(origin) - delta).rounded()))
  }
}
#endif
