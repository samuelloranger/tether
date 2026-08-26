#if canImport(UIKit)
import SwiftUI
import UIKit

/// Full utility key row for touch input — horizontally scrollable instead of RN paging.
public struct TerminalAccessoryBar: View {
  public var ctrlArmed: Binding<Bool>
  public var onKey: (String) -> Void
  public var onPaste: (String) -> Void
  public var onHideKeyboard: () -> Void

  public init(
    ctrlArmed: Binding<Bool>,
    onKey: @escaping (String) -> Void,
    onPaste: @escaping (String) -> Void,
    onHideKeyboard: @escaping () -> Void
  ) {
    self.ctrlArmed = ctrlArmed
    self.onKey = onKey
    self.onPaste = onPaste
    self.onHideKeyboard = onHideKeyboard
  }

  public var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 8) {
        ctrlButton
        accessoryButton("Esc") { onKey("\u{1B}") }
        accessoryButton("Tab") { send(ctrlArmed, base: "\t") }
        accessoryButton("↑") { send(ctrlArmed, base: "\u{1B}[A") }
        accessoryButton("↓") { send(ctrlArmed, base: "\u{1B}[B") }
        accessoryButton("←") { send(ctrlArmed, base: "\u{1B}[D") }
        accessoryButton("→") { send(ctrlArmed, base: "\u{1B}[C") }
        accessoryButton("/") { onKey("/") }
        accessoryButton("Del") { onKey("\u{1B}[3~") }
        accessoryButton("Home") { send(ctrlArmed, base: "\u{1B}[H") }
        accessoryButton("End") { send(ctrlArmed, base: "\u{1B}[F") }
        accessoryButton("PgUp") { onKey("\u{1B}[5~") }
        accessoryButton("PgDn") { onKey("\u{1B}[6~") }
        pasteButton
        accessoryButton("Hide", systemImage: "keyboard.chevron.compact.down", action: onHideKeyboard)
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
  }

  private var ctrlButton: some View {
    Button {
      ctrlArmed.wrappedValue.toggle()
    } label: {
      Text(ctrlArmed.wrappedValue ? "Ctrl ✓" : "Ctrl")
        .font(.callout.weight(.medium))
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
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
      .padding(.vertical, 8)
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
      if !text.isEmpty {
        onSubmitBytes(text)
      }
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
}

public struct TerminalView: View {
  @Bindable public var store: SessionStore
  @State private var ctrlArmed = false
  @State private var inputBuffer = ""
  @FocusState private var keyboardFocused: Bool

  public init(store: SessionStore) {
    self.store = store
  }

  public var body: some View {
    VStack(spacing: 0) {
      TetherSurfaceRepresentable(snapshot: $store.terminalSnapshot)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.black)
        // Without this the Hide button is a one-way door: nothing else in the
        // terminal view takes focus, so the session becomes uninputtable.
        .contentShape(Rectangle())
        .onTapGesture { keyboardFocused = true }

      TerminalInputBridge(
        text: $inputBuffer,
        accessory: AnyView(
          TerminalAccessoryBar(
            ctrlArmed: $ctrlArmed,
            onKey: { store.sendInput($0) },
            onPaste: { store.sendInput($0) },
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
#endif
