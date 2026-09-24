import UIKit
import UniformTypeIdentifiers
import XCTest
@testable import TetherKit

/// The paste key is the system paste control (clipboard access without a prompt), so it
/// can't use `TerminalKeyStyle`; these pin it to the same face the other keys wear.
@MainActor
final class TerminalPasteKeyTests: XCTestCase {
  private func resolved(_ color: UIColor?, _ style: UIUserInterfaceStyle) -> UIColor? {
    color?.resolvedColor(with: UITraitCollection(userInterfaceStyle: style))
  }

  func test_the_paste_key_wears_the_other_keys_face() {
    let config = TerminalPasteKey.configuration
    XCTAssertEqual(config.displayMode, .iconOnly)
    XCTAssertEqual(config.cornerStyle, .fixed)
    XCTAssertEqual(config.cornerRadius, TerminalKeyStyle.cornerRadius)
    for style in [UIUserInterfaceStyle.dark, .light] {
      XCTAssertEqual(resolved(config.baseBackgroundColor, style), resolved(UIColor(TetherColors.surfaceRaised), style))
      XCTAssertEqual(resolved(config.baseForegroundColor, style), resolved(UIColor(TetherColors.textPrimary), style))
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
