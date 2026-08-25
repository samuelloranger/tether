#if canImport(UIKit)
import SwiftUI
import UIKit

/// Compact modifier keys for touch-only use. Replaces the RN utility bar / floating d-pad.
public struct TerminalAccessoryBar: View {
  public var ctrlArmed: Binding<Bool>
  public var onKey: (String) -> Void
  public var onPaste: () -> Void

  public init(ctrlArmed: Binding<Bool>, onKey: @escaping (String) -> Void, onPaste: @escaping () -> Void) {
    self.ctrlArmed = ctrlArmed
    self.onKey = onKey
    self.onPaste = onPaste
  }

  public var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 8) {
        accessoryButton(ctrlArmed.wrappedValue ? "Ctrl ✓" : "Ctrl") {
          ctrlArmed.wrappedValue.toggle()
        }
        accessoryButton("Esc") { onKey("\u{1B}") }
        accessoryButton("Tab") { send(ctrlArmed, base: "\t") }
        accessoryButton("↑") { send(ctrlArmed, base: "\u{1B}[A") }
        accessoryButton("↓") { send(ctrlArmed, base: "\u{1B}[B") }
        accessoryButton("←") { send(ctrlArmed, base: "\u{1B}[D") }
        accessoryButton("→") { send(ctrlArmed, base: "\u{1B}[C") }
        accessoryButton("Paste", systemImage: "doc.on.clipboard", action: onPaste)
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 8)
    }
    .background(.ultraThinMaterial)
  }

  private func accessoryButton(_ title: String, systemImage: String? = nil, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Group {
        if let systemImage {
          Label(title, systemImage: systemImage)
        } else {
          Text(title)
        }
      }
      .font(.callout.weight(.medium))
      .padding(.horizontal, 10)
      .padding(.vertical, 8)
      .background(TetherColors.surface)
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

  public init(text: Binding<String>, accessory: AnyView, onSubmitBytes: @escaping (String) -> Void) {
    _text = text
    self.accessory = accessory
    self.onSubmitBytes = onSubmitBytes
  }

  public func makeCoordinator() -> Coordinator {
    Coordinator(onSubmitBytes: onSubmitBytes)
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
  }

  public final class Coordinator: NSObject, UITextViewDelegate {
    let onSubmitBytes: (String) -> Void

    init(onSubmitBytes: @escaping (String) -> Void) {
      self.onSubmitBytes = onSubmitBytes
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
  }
}

public final class TerminalInputTextView: UITextView {
  let accessoryHosting = UIHostingController<AnyView>(rootView: AnyView(EmptyView()))

  public override var inputAccessoryView: UIView? {
    accessoryHosting.view.frame.size.height = 52
    accessoryHosting.view.backgroundColor = .clear
    return accessoryHosting.view
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
            onPaste: pasteFromClipboard
          )
        ),
        onSubmitBytes: { store.sendInput($0) }
      )
      .frame(height: 1)
      .focused($keyboardFocused)
    }
    .background(TetherColors.background)
    .onAppear {
      keyboardFocused = true
    }
    .toolbar {
      ToolbarItemGroup(placement: .keyboard) {
        Spacer()
        Button("Done") { keyboardFocused = false }
      }
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
