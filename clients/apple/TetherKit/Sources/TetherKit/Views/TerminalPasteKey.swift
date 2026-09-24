import SwiftUI
import UIKit

/// The key bar's paste key. It has to be the system paste control: reading
/// `UIPasteboard.general` directly is denied silently, and only the system control reads
/// the clipboard without a prompt. SwiftUI's `PasteButton` draws itself at its own size and
/// ignores `TerminalKeyStyle`, so this configures UIKit's control with the keys' face
/// instead. The system forbids covering it, so the face can't simply be drawn on top.
struct TerminalPasteKey: UIViewRepresentable {
  var onPaste: (String) -> Void

  static var configuration: UIPasteControl.Configuration {
    let config = UIPasteControl.Configuration()
    config.displayMode = .iconOnly
    config.cornerStyle = .fixed
    config.cornerRadius = TerminalKeyStyle.cornerRadius
    config.baseBackgroundColor = UIColor(TetherColors.surfaceRaised)
    config.baseForegroundColor = UIColor(TetherColors.textPrimary)
    return config
  }

  func makeCoordinator() -> Target { Target(onPaste: onPaste) }

  func makeUIView(context: Context) -> UIPasteControl {
    let control = UIPasteControl(configuration: Self.configuration)
    control.target = context.coordinator
    control.accessibilityLabel = "Paste"
    return control
  }

  func updateUIView(_ control: UIPasteControl, context: Context) {
    context.coordinator.onPaste = onPaste
  }

  final class Target: UIResponder {
    var onPaste: (String) -> Void
    /// The clipboard's contents are invisible until the shell echoes them, so the
    /// tap gets its own confirmation, as the D-pad's does.
    private static let feedback = UIImpactFeedbackGenerator(style: .light)

    init(onPaste: @escaping (String) -> Void) {
      self.onPaste = onPaste
      super.init()
      pasteConfiguration = UIPasteConfiguration(forAccepting: NSString.self)
    }

    override func paste(itemProviders: [NSItemProvider]) {
      guard let provider = itemProviders.first(where: { $0.canLoadObject(ofClass: NSString.self) }) else { return }
      _ = provider.loadObject(ofClass: NSString.self) { [weak self] object, _ in
        guard let text = object as? String else { return }
        DispatchQueue.main.async {
          Self.feedback.impactOccurred()
          self?.onPaste(text)
        }
      }
    }
  }
}
