#if canImport(UIKit)
import SwiftUI
import UIKit

/// Full session transcript on its own screen: read-only, selectable text so you
/// can drag-select and copy exactly what you want. Opens scrolled to the bottom
/// (the newest output).
struct TerminalHistoryView: View {
  let controller: SSHTerminalController
  var preferences: AppPreferences
  var onClose: () -> Void

  @State private var text: String?

  var body: some View {
    NavigationStack {
      Group {
        if let text {
          SelectableTextView(
            text: text,
            fontName: preferences.terminalFont.postScriptName,
            fontSize: preferences.terminalFontSize
          )
          .ignoresSafeArea(edges: .bottom)
        } else {
          VStack(spacing: 10) {
            ProgressView().tint(TetherColors.accent)
            Text("Loading history…").font(.system(size: 13, design: .monospaced))
              .foregroundStyle(TetherColors.textSecondary)
          }
          .frame(maxWidth: .infinity, maxHeight: .infinity)
          .background(TetherColors.terminalBackground)
        }
      }
      .navigationTitle("History")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Done") { onClose() } }
        ToolbarItem(placement: .primaryAction) {
          Button {
            if let text, !text.isEmpty { UIPasteboard.general.string = text }
          } label: {
            Image(systemName: "doc.on.doc")
          }
          .disabled(text?.isEmpty ?? true)
          .accessibilityLabel("Copy all")
        }
      }
    }
    .task { text = await controller.historyText() }
  }
}

/// Read-only selectable UITextView — native drag-select + Copy/Share, and it
/// scrolls well with a large transcript (SwiftUI Text selection does not).
private struct SelectableTextView: UIViewRepresentable {
  let text: String
  let fontName: String
  let fontSize: CGFloat

  func makeCoordinator() -> Coordinator { Coordinator() }

  func makeUIView(context: Context) -> UITextView {
    let view = UITextView()
    view.isEditable = false
    view.isSelectable = true
    view.alwaysBounceVertical = true
    view.backgroundColor = UIColor(TetherColors.terminalBackground)
    view.textContainerInset = UIEdgeInsets(top: 12, left: 12, bottom: 12, right: 12)
    view.autocorrectionType = .no
    view.autocapitalizationType = .none
    return view
  }

  func updateUIView(_ view: UITextView, context: Context) {
    view.font = UIFont(name: fontName, size: fontSize) ?? .monospacedSystemFont(ofSize: fontSize, weight: .regular)
    view.textColor = UIColor(TetherColors.textPrimary)
    if view.text != text {
      view.text = text
      context.coordinator.didScrollToBottom = false
    }
    // Bottom-align on first paint of real content; never yank the view down
    // again once the user has started scrolling/selecting.
    guard !context.coordinator.didScrollToBottom, !text.isEmpty else { return }
    context.coordinator.didScrollToBottom = true
    DispatchQueue.main.async {
      let end = NSRange(location: (view.text as NSString).length, length: 0)
      view.scrollRangeToVisible(end)
    }
  }

  final class Coordinator {
    var didScrollToBottom = false
  }
}
#endif
