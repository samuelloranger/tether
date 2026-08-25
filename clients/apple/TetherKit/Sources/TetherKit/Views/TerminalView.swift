#if canImport(UIKit)
import SwiftUI
import UIKit

/// Full utility key row for touch input — horizontally scrollable instead of RN paging.
public struct TerminalAccessoryBar: View {
  public var ctrlArmed: Binding<Bool>
  public var onKey: (String) -> Void
  public var onPaste: () -> Void
  public var onHideKeyboard: () -> Void

  public init(
    ctrlArmed: Binding<Bool>,
    onKey: @escaping (String) -> Void,
    onPaste: @escaping () -> Void,
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
        accessoryButton("Paste", systemImage: "doc.on.clipboard", action: onPaste)
        accessoryButton("Hide", systemImage: "keyboard.chevron.compact.down", action: onHideKeyboard)
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 8)
    }
    .background(.ultraThinMaterial)
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
    if ctrlArmed.wrappedValue, let last = base.last {
      ctrlArmed.wrappedValue = false
      let value = last.asciiValue ?? 0
      let control = UnicodeScalar(Int(value) & 0x1F)!
      onKey(String(control))
      return
    }
    onKey(base)
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

public final class TerminalInputTextView: UITextView {
  let accessoryHosting = UIHostingController<AnyView>(rootView: AnyView(EmptyView()))

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

      TerminalInputBridge(
        text: $inputBuffer,
        accessory: AnyView(
          TerminalAccessoryBar(
            ctrlArmed: $ctrlArmed,
            onKey: { store.sendInput($0) },
            onPaste: pasteFromClipboard,
            onHideKeyboard: { keyboardFocused = false }
          )
        ),
        onSubmitBytes: { store.sendInput($0) },
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

  private func pasteFromClipboard() {
    #if canImport(UIKit)
    if let text = UIPasteboard.general.string {
      store.sendInput(text)
    }
    #endif
  }
}
#endif
