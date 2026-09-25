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

  /// Every key in the bar is this size, the D-pad included — a key that is larger
  /// than its neighbours reads as a different kind of thing. Width fits "Home"/"PgDn".
  static let keySize: CGFloat = 40
  static let keyWidth: CGFloat = 52
  static let barVerticalPadding: CGFloat = 8
  /// First-frame fallback before GeometryReader reports the real docked height.
  /// Derived from key + padding so it cannot drift from the row's layout again.
  public static let barHeight: CGFloat = keySize + barVerticalPadding * 2

  /// No arrow keys: the D-pad is one key covering all four directions.
  public var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 8) {
        ctrlButton
        accessoryButton("Tab") { send(base: "\t") }
        accessoryButton("Esc") { onKey("\u{1B}") }
        slashKey
        DpadView(size: CGSize(width: Self.keyWidth, height: Self.keySize), onArrow: onArrow)
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

  private var pasteButton: some View {
    TerminalPasteKey(onPaste: onPaste)
      .frame(width: Self.keyWidth, height: Self.keySize)
  }

  /// Arming Ctrl changes what the next key does with nothing else moving on screen,
  /// so it gets its own haptic confirmation.
  private static let armFeedback = UISelectionFeedbackGenerator()

  private var ctrlButton: some View {
    Button {
      Self.armFeedback.selectionChanged()
      model.ctrlArmed.toggle()
    } label: {
      Text("Ctrl")
    }
    .buttonStyle(TerminalKeyStyle(armed: model.ctrlArmed))
    .accessibilityLabel("Control modifier")
    .accessibilityValue(model.ctrlArmed ? "Armed" : "Off")
  }

  /// Hold for `\`, like the system keyboard's long-press alternates — its own
  /// backslash sits two layers deep.
  private var slashKey: some View {
    Menu {
      Button("\\") { onKey("\\") }
    } label: {
      Text("/")
    } primaryAction: {
      onKey("/")
    }
    .menuStyle(.button)
    .buttonStyle(TerminalKeyStyle())
    .menuIndicator(.hidden)
    .accessibilityLabel("Slash")
    .accessibilityHint("Hold for backslash")
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
  public var accessory: AnyView
  /// Gate the ACCESSORY, never the bridge's existence: a `.focused()` view that
  /// appears and disappears makes SwiftUI and UIKit focus machinery loop at 100% CPU.
  public var showsAccessory: Bool = true
  public var onSubmitBytes: (String) -> Void
  public var isFocused: Binding<Bool>

  public init(
    accessory: AnyView,
    showsAccessory: Bool = true,
    onSubmitBytes: @escaping (String) -> Void,
    isFocused: Binding<Bool>
  ) {
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
    // Lets an XCUITest target the input to type into a session. Harmless in prod.
    view.accessibilityIdentifier = "terminalInput"
    view.isAccessibilityElement = true
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
    // `refillFiller`); syncing a text binding here would wipe it on every update.
    uiView.refillFiller()
    if isFocused.wrappedValue, !uiView.isFirstResponder {
      uiView.becomeFirstResponder()
    } else if !isFocused.wrappedValue, uiView.isFirstResponder {
      uiView.resignFirstResponder()
    }
  }

  // SwiftUI doesn't resign a removed host view's first responder, and the key bar lives in
  // the keyboard window: a lingering responder keeps the bar docked and doubles input.
  public static func dismantleUIView(_ uiView: TerminalInputTextView, coordinator: Coordinator) {
    uiView.resignFirstResponder()
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

    /// UIKit hands focus back on its own after an alert (e.g. shake-to-undo). Unsynced, the
    /// next update resigns it mid-keyboard-show, leaving a keyboard that feeds nothing.
    public func textViewDidBeginEditing(_ textView: UITextView) {
      guard !isFocused.wrappedValue else { return }
      DispatchQueue.main.async { [weak textView, isFocused] in
        guard
          let textView,
          textView.isFirstResponder,
          !isFocused.wrappedValue
        else { return }
        isFocused.wrappedValue = true
      }
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
