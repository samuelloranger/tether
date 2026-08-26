#if canImport(UIKit)
import SwiftUI
import UIKit

/// Full utility key row for touch input — horizontally scrollable instead of RN paging.
public struct TerminalAccessoryBar: View {
  public var ctrlArmed: Binding<Bool>
  public var onKey: (String) -> Void
  public var onPaste: (String) -> Void
  public var onArrow: (DPadDirection) -> Void
  public var onHideKeyboard: () -> Void

  public init(
    ctrlArmed: Binding<Bool>,
    onKey: @escaping (String) -> Void,
    onPaste: @escaping (String) -> Void,
    onArrow: @escaping (DPadDirection) -> Void,
    onHideKeyboard: @escaping () -> Void
  ) {
    self.ctrlArmed = ctrlArmed
    self.onKey = onKey
    self.onPaste = onPaste
    self.onArrow = onArrow
    self.onHideKeyboard = onHideKeyboard
  }

  /// Every key in the bar is this tall, the D-pad included — a control that is
  /// taller than its neighbours reads as a different kind of thing.
  static let keySize: CGFloat = 40

  /// Key order matches `UTILITY_BAR_KEYS` in the RN client. There are no arrow
  /// keys: the D-pad is one square key in the row and covers all four
  /// directions, which is why four separate arrows would be redundant.
  public var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 8) {
        ctrlButton
        accessoryButton("Tab") { send(ctrlArmed, base: "\t") }
        accessoryButton("Esc") { onKey("\u{1B}") }
        accessoryButton("/") { onKey("/") }
        DpadView(size: Self.keySize, onArrow: onArrow)
        pasteButton
        accessoryButton("Hide", systemImage: "keyboard.chevron.compact.down", action: onHideKeyboard)
        accessoryButton("Del") { onKey("\u{1B}[3~") }
        accessoryButton("Home") { send(ctrlArmed, base: "\u{1B}[H") }
        accessoryButton("End") { send(ctrlArmed, base: "\u{1B}[F") }
        accessoryButton("PgUp") { onKey("\u{1B}[5~") }
        accessoryButton("PgDn") { onKey("\u{1B}[6~") }
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 8)
    }
    .background(.ultraThinMaterial)
  }


  /// The system paste control.
  ///
  /// Reading `UIPasteboard.general` directly is denied unless the user
  /// confirms, and the denial is silent — the button appeared to do nothing.
  /// `PasteButton` is granted access without a prompt.
  private var pasteButton: some View {
    PasteButton(payloadType: String.self) { strings in
      guard let text = strings.first else { return }
      onPaste(text)
    }
    .labelStyle(.iconOnly)
    .buttonBorderShape(.roundedRectangle(radius: 8))
    .tint(TetherColors.surface)
    .frame(minWidth: Self.keySize, minHeight: Self.keySize)
  }

  private var ctrlButton: some View {
    Button {
      ctrlArmed.wrappedValue.toggle()
    } label: {
      Text(ctrlArmed.wrappedValue ? "Ctrl ✓" : "Ctrl")
        .font(.callout.weight(.medium))
        .padding(.horizontal, 10)
        .frame(minWidth: Self.keySize, minHeight: Self.keySize)
        .background(ctrlArmed.wrappedValue ? TetherColors.accent : TetherColors.surface)
        .foregroundStyle(ctrlArmed.wrappedValue ? Color.black : TetherColors.textPrimary)
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }
    .buttonStyle(.plain)
    .accessibilityLabel("Control modifier")
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
      .font(.callout.weight(.medium))
      .padding(.horizontal, 10)
      .frame(minWidth: Self.keySize, minHeight: Self.keySize)
      .background(TetherColors.surface)
      .foregroundStyle(TetherColors.textPrimary)
      .clipShape(RoundedRectangle(cornerRadius: 8))
    }
    .buttonStyle(.plain)
  }

  private func send(_ ctrlArmed: Binding<Bool>, base: String) {
    guard ctrlArmed.wrappedValue else {
      onKey(base)
      return
    }
    ctrlArmed.wrappedValue = false
    onKey(TerminalKeyMap.ctrlModified(base))
  }
}

/// Bridges the system keyboard to PTY input with an accessory toolbar.
public struct TerminalInputBridge: UIViewRepresentable {
  @Binding public var text: String
  public var accessory: AnyView
  public var onSubmitBytes: (String) -> Void
  public var isFocused: Binding<Bool>

  public init(
    text: Binding<String>,
    accessory: AnyView,
    onSubmitBytes: @escaping (String) -> Void,
    isFocused: Binding<Bool>
  ) {
    _text = text
    self.accessory = accessory
    self.onSubmitBytes = onSubmitBytes
    self.isFocused = isFocused
  }

  public func makeCoordinator() -> Coordinator {
    Coordinator(onSubmitBytes: onSubmitBytes, isFocused: isFocused)
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
    // 0x7F (DEL) is what terminals and readline expect from backspace.
    view.onBackspace = { [onSubmitBytes] in onSubmitBytes("\u{7F}") }
    view.onKeyBytes = { [onSubmitBytes] bytes in onSubmitBytes(bytes) }
    return view
  }

  public func updateUIView(_ uiView: TerminalInputTextView, context: Context) {
    uiView.accessoryHosting.rootView = accessory
    if uiView.text != text {
      uiView.text = text
    }
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
      // An EMPTY replacement is a deletion. UIKit reports the software backspace
      // here rather than through `deleteBackward()`, so the previous code — which
      // only forwarded non-empty text — silently dropped every backspace.
      if text.isEmpty {
        onSubmitBytes("\u{7F}")
        return false
      }
      onSubmitBytes(text)
      return false
    }

    public func textViewDidEndEditing(_ textView: UITextView) {
      isFocused.wrappedValue = false
    }
  }
}

/// Translates hardware key presses into the bytes a PTY expects.
///
/// Keys that produce no text — backspace on an empty buffer, arrows, Ctrl
/// combos, Esc — never reach `UITextViewDelegate`, because there is no text
/// change for UIKit to report. `pressesBegan` sees them all, so the terminal
/// key handling lives here and the delegate is left to handle plain typing.
enum TerminalKeyMap {
  static func bytes(for key: UIKey) -> String? {
    let mods = key.modifierFlags
    let ctrl = mods.contains(.control)
    let alt = mods.contains(.alternate)
    let mod = modifierParam(mods)

    switch key.keyCode {
    case .keyboardUpArrow: return csi("A", mod)
    case .keyboardDownArrow: return csi("B", mod)
    case .keyboardRightArrow: return csi("C", mod)
    case .keyboardLeftArrow: return csi("D", mod)
    case .keyboardHome: return csi("H", mod)
    case .keyboardEnd: return csi("F", mod)
    case .keyboardPageUp: return "\u{1B}[5~"
    case .keyboardPageDown: return "\u{1B}[6~"
    case .keyboardDeleteForward: return "\u{1B}[3~"
    case .keyboardDeleteOrBackspace: return "\u{7F}"
    case .keyboardEscape: return "\u{1B}"
    default: break
    }

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

  /// Applies the Ctrl latch to an accessory-bar key.
  ///
  /// A CSI sequence carries its modifier as a parameter. Masking its final
  /// byte instead produced a control code from the wrong character entirely:
  /// Ctrl+Left became 0x04 (EOF) and killed the shell, and Ctrl+Up became
  /// 0x01 (start of line).
  static func ctrlModified(_ sequence: String) -> String {
    guard sequence.hasPrefix("\u{1B}["), let final = sequence.last else { return sequence }
    return "\u{1B}[1;5\(final)"
  }

  /// Folds a latched Ctrl into the next typed character.
  ///
  /// Only printable ASCII has a control form; applying the mask to Return or
  /// DEL would corrupt them.
  static func ctrlFolded(_ text: String) -> String? {
    guard text.count == 1, let ch = text.first, let ascii = ch.asciiValue,
          (0x20...0x7E).contains(ascii)
    else { return nil }
    let upper = (ascii >= 97 && ascii <= 122) ? ascii - 32 : ascii
    return String(UnicodeScalar(upper & 0x1F))
  }

  /// xterm's modifier parameter: 1 + shift(1) + alt(2) + ctrl(4).
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

  /// Software-keyboard backspace. The on-screen delete key routes here rather
  /// than through `pressesBegan`, and reports an empty replacement string to
  /// the delegate, so it needs its own hook.
  var onBackspace: (() -> Void)?

  /// UIKit only routes the software delete key to `deleteBackward()` while the
  /// input view reports that it has something to delete. This view's text is
  /// always empty — the delegate refuses every change and forwards bytes to the
  /// PTY instead — so `hasText` was always false and the on-screen backspace
  /// did nothing at all. Claiming text unconditionally restores the key.
  public override var hasText: Bool { true }

  public override func deleteBackward() {
    onBackspace?()
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

  /// Configured once rather than on every getter call — the previous version
  /// mutated the hosting view's frame and background each time UIKit asked for
  /// the accessory, which UIKit does often.
  private lazy var accessoryContainer: UIView = {
    let view = accessoryHosting.view!
    view.frame.size.height = 52
    view.backgroundColor = .clear
    return view
  }()


  private var assignedAccessoryView: UIView?

  /// UIKit declares `inputAccessoryView` as settable, so an override must
  /// supply a setter as well — a get-only override fails to compile with
  /// "cannot override mutable property with read-only property".
  ///
  /// The keyboard accessory is owned by this view; an explicit assignment from
  /// outside still wins, which keeps the property honest rather than silently
  /// ignoring the setter.
  public override var inputAccessoryView: UIView? {
    get { assignedAccessoryView ?? accessoryContainer }
    set { assignedAccessoryView = newValue }
  }

  public override var canBecomeFirstResponder: Bool { true }

  /// With a hardware keyboard attached (and on iPad generally) UIKit renders the
  /// system input-assistant shortcuts bar for the first responder. This view has
  /// no shortcuts to offer, so it showed up as an empty strip along the bottom.
  /// Emptying both groups removes the bar rather than leaving it blank.
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

public struct TerminalView: View {
  @Bindable public var store: SessionStore
  @Bindable public var preferences: AppPreferences
  @State private var ctrlArmed = false
  @State private var inputBuffer = ""
  @State private var scrollOffsetFromBottom = 0
  @State private var selectionText: String?
  @FocusState private var keyboardFocused: Bool

  public init(store: SessionStore, preferences: AppPreferences) {
    self.store = store
    self.preferences = preferences
  }

  public var body: some View {
    VStack(spacing: 0) {
      ZStack(alignment: .topTrailing) {
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
          onMouseBytes: { store.sendInput($0) }
        )
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.black)

        if scrollOffsetFromBottom > 0 {
          ScrollPositionIndicator(offset: scrollOffsetFromBottom)
            .padding(.trailing, 4)
            .padding(.top, 8)
        }

        if let selectionText, !selectionText.isEmpty {
          selectionChrome(text: selectionText)
        }

      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      // Without this the home-indicator inset is left as a dead near-black
      // strip below the grid.
      .ignoresSafeArea(.container, edges: .bottom)

      TerminalInputBridge(
        text: $inputBuffer,
        accessory: AnyView(
          TerminalAccessoryBar(
            ctrlArmed: $ctrlArmed,
            onKey: { store.sendInput($0) },
            onPaste: { store.sendInput($0) },
            onArrow: { store.sendInput($0.escapeSequence) },
            onHideKeyboard: { keyboardFocused = false }
          )
        ),
        onSubmitBytes: submit,
        isFocused: Binding(
          get: { keyboardFocused },
          set: { keyboardFocused = $0 }
        )
      )
      .frame(height: 1)
      .focused($keyboardFocused)
    }
    .background(TetherColors.background)
    .onAppear {
      keyboardFocused = true
    }
    .onChange(of: store.activeSessionId) { _, _ in
      scrollOffsetFromBottom = 0
      selectionText = nil
    }
  }

  @ViewBuilder
  private func selectionChrome(text: String) -> some View {
    VStack {
      Spacer()
      HStack {
        Spacer()
        Button {
          UIPasteboard.general.string = text
          selectionText = nil
        } label: {
          Label("Copy", systemImage: "doc.on.doc")
            .font(.callout.weight(.semibold))
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(TetherColors.accent)
            .foregroundStyle(Color.black)
            .clipShape(RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
        .padding(12)
      }
    }
  }

  /// Sends typed input, folding in a latched Ctrl.
  ///
  /// The Ctrl button used to affect only the five keys that routed through
  /// `send`, so the on-screen keyboard could not produce Ctrl+C at all.
  private func submit(_ text: String) {
    if ctrlArmed, let folded = TerminalKeyMap.ctrlFolded(text) {
      ctrlArmed = false
      store.sendInput(folded)
      return
    }
    store.sendInput(text)
  }
}

/// Thin thumb on the trailing edge while scrolled into history.
struct ScrollPositionIndicator: View {
  var offset: Int

  var body: some View {
    GeometryReader { geo in
      let track = max(geo.size.height - 24, 1)
      // Approximate: more offset → thumb closer to top. Cap visual travel.
      let progress = min(1, CGFloat(offset) / 200)
      let thumbH: CGFloat = 36
      let y = 12 + (1 - progress) * (track - thumbH)
      Capsule()
        .fill(TetherColors.textSecondary.opacity(0.55))
        .frame(width: 3, height: thumbH)
        .frame(maxWidth: .infinity, alignment: .trailing)
        .offset(y: y)
    }
    .allowsHitTesting(false)
    .accessibilityHidden(true)
  }
}
#endif
