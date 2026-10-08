import UIKit
import UniformTypeIdentifiers
import XCTest
@testable import TetherKit

/// The paste key is the system paste control (clipboard access without a prompt), so it
/// can't use `TerminalKeyStyle`; these pin it to the same face the other keys wear.
@MainActor
final class TerminalPasteKeyTests: XCTestCase {
  private func rgb(_ color: UIColor?) -> UInt32? {
    var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
    guard let color, color.getRed(&r, green: &g, blue: &b, alpha: &a) else { return nil }
    return UInt32((r * 255).rounded()) << 16 | UInt32((g * 255).rounded()) << 8 | UInt32((b * 255).rounded())
  }

  /// In every theme: the control is rebuilt on a theme change and must take the new face.
  func test_the_paste_key_wears_the_other_keys_face() {
    defer { ChromeTheme.shared.apply(.tether) }
    for theme in [TerminalTheme.tether, .tetherLight, .named("dracula")] {
      ChromeTheme.shared.apply(theme)
      let config = TerminalPasteKey.configuration
      XCTAssertEqual(config.displayMode, .iconOnly)
      XCTAssertEqual(config.cornerStyle, .fixed)
      XCTAssertEqual(config.cornerRadius, TerminalKeyStyle.cornerRadius)
      XCTAssertEqual(rgb(config.baseBackgroundColor), theme.chrome.raised, theme.id)
      XCTAssertEqual(rgb(config.baseForegroundColor), theme.chrome.text, theme.id)
    }
  }

  func test_the_paste_key_accepts_plain_text() {
    let target = TerminalPasteKey.Target { _ in }
    let types = target.pasteConfiguration?.acceptableTypeIdentifiers ?? []
    XCTAssertTrue(types.contains(UTType.plainText.identifier) || types.contains(UTType.utf8PlainText.identifier))
  }

  func test_pasted_text_reaches_the_terminal() async {
    let pasted = expectation(description: "paste delivered")
    var received: String?
    let target = TerminalPasteKey.Target { received = $0; pasted.fulfill() }
    target.paste(itemProviders: [NSItemProvider(object: "echo hi" as NSString)])
    await fulfillment(of: [pasted], timeout: 2)
    XCTAssertEqual(received, "echo hi")
  }
}
