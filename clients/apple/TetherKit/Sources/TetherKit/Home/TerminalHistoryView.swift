import SwiftUI
import UIKit

/// Full session transcript as read-only selectable text, opened scrolled to the newest output.
struct TerminalHistoryView: View {
  let controller: SSHTerminalController
  var preferences: AppPreferences
  var onClose: () -> Void

  @State private var text: String?
  @State private var showCopyConfirmation = false

  var body: some View {
    NavigationStack {
      Group {
        if let text, !text.isEmpty {
          SelectableTextView(
            text: text,
            fontName: preferences.terminalFont.postScriptName,
            fontSize: preferences.terminalFontSize,
            lineSpacing: preferences.terminalLineSpacing,
            theme: preferences.terminalTheme
          )
          .ignoresSafeArea(edges: .bottom)
        } else if text != nil {
          VStack(spacing: 10) {
            Image(systemName: "clock.arrow.circlepath").font(.largeTitle)
              .foregroundStyle(TetherColors.textFaint)
            Text("Nothing in this session's scrollback yet.")
              .font(.system(.footnote, design: .monospaced))
              .foregroundStyle(TetherColors.textSecondary).multilineTextAlignment(.center)
            Button("Reload") { Task { text = await controller.historyText() } }
              .font(.subheadline.weight(.semibold)).foregroundStyle(TetherColors.accent)
              .accessibilityIdentifier("historyReload")
          }
          .padding(24)
          .frame(maxWidth: .infinity, maxHeight: .infinity)
          .background(preferences.terminalTheme.backgroundColor)
        } else {
          VStack(spacing: 10) {
            ProgressView().tint(TetherColors.accent)
            Text("Loading history…").font(.system(.footnote, design: .monospaced))
              .foregroundStyle(TetherColors.textSecondary)
          }
          .frame(maxWidth: .infinity, maxHeight: .infinity)
          .background(preferences.terminalTheme.backgroundColor)
          .accessibilityLabel("Loading history")
        }
      }
      .navigationTitle("History")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Done") { onClose() } }
        ToolbarItem(placement: .primaryAction) {
          Button {
            guard let text, !text.isEmpty else { return }
            acknowledgeCopy(text, into: $showCopyConfirmation)
          } label: {
            Image(systemName: "doc.on.doc")
          }
          .disabled(text?.isEmpty ?? true)
          .accessibilityLabel("Copy all")
        }
      }
    }
    .copyConfirmation(isPresented: $showCopyConfirmation)
    .task { text = await controller.historyText() }
  }
}

/// Read-only selectable UITextView — native drag-select + Copy/Share, and it
/// scrolls well with a large transcript (SwiftUI Text selection does not).
private struct SelectableTextView: UIViewRepresentable {
  let text: String
  let fontName: String
  let fontSize: CGFloat
  let lineSpacing: CGFloat
  let theme: TerminalTheme

  func makeCoordinator() -> Coordinator { Coordinator() }

  func makeUIView(context: Context) -> UITextView {
    let view = UITextView()
    view.isEditable = false
    view.isSelectable = true
    view.alwaysBounceVertical = true
    view.textContainerInset = UIEdgeInsets(top: 12, left: 12, bottom: 12, right: 12)
    view.autocorrectionType = .no
    view.autocapitalizationType = .none
    return view
  }

  func updateUIView(_ view: UITextView, context: Context) {
    view.backgroundColor = theme.uiBackground
    let style = Style(fontName: fontName, fontSize: fontSize, lineSpacing: lineSpacing, theme: theme)
    let textChanged = context.coordinator.text != text
    if textChanged || context.coordinator.style != style {
      let paragraph = NSMutableParagraphStyle()
      paragraph.lineHeightMultiple = lineSpacing
      view.attributedText = NSAttributedString(string: text, attributes: [
        .font: TerminalFonts.font(postScriptName: fontName, size: fontSize, bold: false),
        .foregroundColor: TerminalTheme.uiColor(theme.foreground),
        .paragraphStyle: paragraph,
      ])
      context.coordinator.text = text
      context.coordinator.style = style
    }
    if textChanged { context.coordinator.didScrollToBottom = false }
    // Bottom-align on first paint of real content; never yank the view down
    // again once the user has started scrolling/selecting.
    guard !context.coordinator.didScrollToBottom, !text.isEmpty else { return }
    context.coordinator.didScrollToBottom = true
    DispatchQueue.main.async {
      let end = NSRange(location: (view.text as NSString).length, length: 0)
      view.scrollRangeToVisible(end)
    }
  }

  struct Style: Equatable {
    var fontName: String
    var fontSize: CGFloat
    var lineSpacing: CGFloat
    var theme: TerminalTheme
  }

  /// What the text view last showed: re-setting a large transcript on every update is slow.
  final class Coordinator {
    var didScrollToBottom = false
    var text: String?
    var style: Style?
  }
}
