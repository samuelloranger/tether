import UIKit
import XCTest

@testable import TetherKit

/// The hidden input's document is filler, so there is nothing to undo; shaking the
/// phone must not offer to.
@MainActor
final class TerminalUndoTests: XCTestCase {
  /// Held per test: a windowed view is the on-device case, where the window supplies
  /// an undo manager through the responder chain.
  private var window: UIWindow?

  override func tearDown() {
    window = nil
    super.tearDown()
  }

  func test_terminal_input_offers_no_undo_manager() {
    let view = TerminalInputTextView()
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
    window.addSubview(view)
    window.makeKeyAndVisible()
    self.window = window
    _ = view.becomeFirstResponder()

    XCTAssertNil(view.undoManager, "shake-to-undo reads the first responder's undo manager")
  }
}
